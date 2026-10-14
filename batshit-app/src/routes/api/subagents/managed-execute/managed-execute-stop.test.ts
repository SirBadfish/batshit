/**
 * BL-578 — a Stop of a managed CLI Primary reaches the Subagent or Workers it delegated to.
 *
 * The CLI bridge (`codex-subagent-mcp.cjs`) calls this route over HTTP, and that request cannot
 * carry a Stop: SvelteKit aborts `request.signal` only when the caller leaves before the body is
 * read. Before BL-578 the route passed no signal at all, so a stopped Codex or Claude reply left
 * its Subagent run going until the Subagent's time limit. The route now hands the runner the run
 * credential's Stop (`getRunCredentialStopSignal`): this route takes primary runs only, so it is
 * that run's own reply, already aborted once the reply has ended or been replaced (BL-1321).
 * Never a chat the body names: stricter than `/api/native-tools/dispatch`, which takes the chat
 * from the body on lanes with no credential. Here such a caller gets no Stop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveNativeToolUser: vi.fn(),
  executeManagedSubagent: vi.fn(),
  spawnWorkers: vi.fn(),
  redisGetSession: vi.fn(),
  redisGet: vi.fn(),
  redisSMembers: vi.fn(),
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: mocks.resolveNativeToolUser,
}))

vi.mock('$lib/server/services/subagentRunner', () => ({
  executeManagedSubagent: mocks.executeManagedSubagent,
}))

vi.mock('$lib/server/services/workerRunner', () => ({
  spawnWorkers: mocks.spawnWorkers,
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getSession: mocks.redisGetSession,
    get: mocks.redisGet,
    sMembers: mocks.redisSMembers,
  },
}))

import {
  __resetStreamAbortRegistryForTests,
  abortStream,
  registerStreamAbort,
  RETIRED_REPLY_STOP_REASON,
} from '$lib/server/services/streamAbortRegistry'
import { POST } from './+server'

const agentLaneAuth = {
  userId: 'user-1',
  auth: 'agent',
  agentId: 'agent-1',
  sessionId: 'session-bound',
  messageId: 'message-1',
  credentialId: 'arc_test',
}

function buildRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/subagents/managed-execute', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-batshit-agent-token': 'arc_test.bsac_secret',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/subagents/managed-execute — the parent reply Stop (BL-578)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetStreamAbortRegistryForTests()
    mocks.resolveNativeToolUser.mockResolvedValue(agentLaneAuth)
    mocks.redisGetSession.mockImplementation(async (id: string) => ({
      id,
      user_id: 'user-1',
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
    }))
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-1') {
        return {
          id: 'agent-1',
          user_id: 'user-1',
          displayName: 'CLI Primary',
          agentType: 'cli',
          primary_model_provider: 'codex',
          primary_model_name: 'gpt-5.6',
          assignedSubagents: ['api-subagent'],
        }
      }
      if (key === 'subagent:api-subagent') {
        return {
          id: 'api-subagent',
          user_id: 'user-1',
          displayName: 'API Helper',
          subagentType: 'api',
        }
      }
      return null
    })
    mocks.redisSMembers.mockResolvedValue([])
    mocks.executeManagedSubagent.mockResolvedValue({
      output: 'done',
      intermediateSteps: [],
      subagentType: 'api',
      usage: null,
      modelId: 'm',
      provider: 'p',
      durationMs: 1,
      status: 'completed',
      thread: 'fresh',
    })
    mocks.spawnWorkers.mockResolvedValue({ kind: 'workers', success: true, workers: [] })
  })

  it('hands the Subagent run the Stop of the reply running in the chat the credential is bound to', async () => {
    registerStreamAbort('session-bound', 'message-1', new AbortController())
    registerStreamAbort('session-claimed', 'message-2', new AbortController())

    const response = await POST({
      request: buildRequest({
        subagentId: 'api-subagent',
        sessionId: 'session-bound',
        chatInput: 'Run the long job',
      }),
      locals: {},
    } as any)

    expect(response.status).toBe(200)
    const signal = mocks.executeManagedSubagent.mock.calls[0]?.[0]?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    abortStream('session-claimed', 'user')
    expect(signal.aborted).toBe(false)
    abortStream('session-bound', 'user')
    expect(signal.aborted).toBe(true)
  })

  it('refuses another body chat before a Subagent can start or borrow its Stop', async () => {
    registerStreamAbort('session-bound', 'message-1', new AbortController())
    registerStreamAbort('session-claimed', 'message-2', new AbortController())
    const response = await POST({
      request: buildRequest({
        subagentId: 'api-subagent', sessionId: 'session-claimed', chatInput: 'Run the long job'
      }),
      locals: {},
    } as any)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('session_mismatch')
    expect(mocks.executeManagedSubagent).not.toHaveBeenCalled()
  })

  it('hands a Workers batch the same Stop', async () => {
    registerStreamAbort('session-bound', 'message-1', new AbortController())

    const response = await POST({
      request: buildRequest({
        sessionId: 'session-bound',
        messageId: 'message-1',
        workers: [{ task: 'Run the long job' }],
      }),
      locals: {},
    } as any)

    expect(response.status).toBe(200)
    const signal = mocks.spawnWorkers.mock.calls[0]?.[0]?.parent?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    abortStream('session-bound', 'user')
    expect(signal.aborted).toBe(true)
  })

  it('BL-1321: hands an already-aborted Stop when the credential’s reply no longer runs, so the Subagent never starts', async () => {
    // Before BL-1321 the run got no Stop here and kept its own time limit: the credential's
    // reply had ended, so nothing should start for it (BL-287: a stopped call never starts).
    registerStreamAbort('another-session', 'message-9', new AbortController())

    await POST({
      request: buildRequest({ subagentId: 'api-subagent', sessionId: 'session-bound', chatInput: 'hi' }),
      locals: {},
    } as any)

    expect(mocks.executeManagedSubagent).toHaveBeenCalledTimes(1)
    const signal = mocks.executeManagedSubagent.mock.calls[0]?.[0]?.abortSignal
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBe(RETIRED_REPLY_STOP_REASON)
  })

  it('BL-1321: a credential of an earlier reply gets its own aborted Stop, never the newer reply’s', async () => {
    const newer = new AbortController()
    registerStreamAbort('session-bound', 'message-2', newer)

    await POST({
      request: buildRequest({ sessionId: 'session-bound', messageId: 'message-1', workers: [{ task: 'Run the long job' }] }),
      locals: {},
    } as any)

    const signal = mocks.spawnWorkers.mock.calls[0]?.[0]?.parent?.abortSignal
    expect(signal).not.toBe(newer.signal)
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBe(RETIRED_REPLY_STOP_REASON)
    expect(newer.signal.aborted).toBe(false)
  })

  it('never takes the Stop from a chat the body names on a lane with no bound chat', async () => {
    // A signed-in browser call names its chat in the body; that is a claim, not a binding.
    registerStreamAbort('session-claimed', 'message-2', new AbortController())
    mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1', auth: 'session' })

    const response = await POST({
      request: buildRequest({
        agentId: 'agent-1',
        subagentId: 'api-subagent',
        sessionId: 'session-claimed',
        chatInput: 'hi',
      }),
      locals: { user: { id: 'user-1' } },
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.executeManagedSubagent.mock.calls[0]?.[0]?.abortSignal).toBeUndefined()
  })
})
