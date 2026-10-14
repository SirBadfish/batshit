import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A Stop reaches a saved CLI tool a managed CLI reply runs through this route.
 *
 * The managed CLI helper (`mode4-controls-mcp.cjs`, `callCliUse`) runs every `cli:` ref of
 * `batshit_tool_use`, and `batshit_server_cli_tool_use`, here. `executeCliTool` ends its
 * process group on `options.abortSignal` (the dispatch already hands it one), but this route
 * passed none, so a stopped Codex or Claude reply left the tool running to its own time limit.
 * The route now hands it the run credential's Stop (`getRunCredentialStopSignal`), never a chat
 * the body names: a primary run's own reply (BL-1321), a Subagent or Worker run its chat's
 * running reply. A primary run whose Stop is already aborted is refused first (BL-1322).
 */

const mocks = vi.hoisted(() => ({
  resolveNativeToolUser: vi.fn(),
  executeCliTool: vi.fn(),
  getSession: vi.fn(),
  exists: vi.fn()
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: mocks.resolveNativeToolUser
}))

vi.mock('$lib/server/services/cliToolRegistry', () => ({
  executeCliTool: mocks.executeCliTool
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getSession: (...args: any[]) => mocks.getSession(...args),
    execute: async (operation: any) => operation({ exists: mocks.exists })
  }
}))

import {
  __resetStreamAbortRegistryForTests,
  abortStream,
  registerStreamAbort
} from '$lib/server/services/streamAbortRegistry'
import { POST } from './+server'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/cli-tools/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('/api/cli-tools/execute — the running reply Stop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetStreamAbortRegistryForTests()
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1',
      auth: 'agent',
      agentId: 'agent-1',
      sessionId: 'session-bound',
      credentialId: 'arc_test'
    })
    mocks.executeCliTool.mockResolvedValue({ success: true, toolId: 'long_job' })
    mocks.getSession.mockImplementation(async (id: string) => ({ id, user_id: 'user-1' }))
    mocks.exists.mockResolvedValue(1)
  })

  it('hands the tool the Stop of the reply running in the chat the credential is bound to', async () => {
    registerStreamAbort('session-bound', 'message-1', new AbortController())
    registerStreamAbort('session-claimed', 'message-2', new AbortController())

    await POST({
      request: request({ toolId: 'long_job', input: {}, sessionId: 'session-claimed' }),
      locals: {}
    } as any)

    const signal = mocks.executeCliTool.mock.calls[0]?.[1]?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    // The chat the body names is not the credential's: its Stop does not count.
    abortStream('session-claimed', 'user')
    expect(signal.aborted).toBe(false)
    abortStream('session-bound', 'user')
    expect(signal.aborted).toBe(true)
  })

  it('hands no Stop when no reply runs in the bound chat', async () => {
    registerStreamAbort('another-session', 'message-9', new AbortController())

    await POST({ request: request({ toolId: 'long_job' }), locals: {} } as any)

    expect(mocks.executeCliTool).toHaveBeenCalledTimes(1)
    expect(mocks.executeCliTool.mock.calls[0]?.[1]).toEqual({ abortSignal: undefined })
  })

  it('never takes the Stop from a chat the body names on a lane with no bound chat', async () => {
    registerStreamAbort('session-claimed', 'message-2', new AbortController())
    mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1', auth: 'service' })

    await POST({ request: request({ toolId: 'long_job', sessionId: 'session-claimed' }), locals: {} } as any)

    expect(mocks.executeCliTool).toHaveBeenCalledTimes(1)
    expect(mocks.executeCliTool.mock.calls[0]?.[1]).toEqual({ abortSignal: undefined })
  })

  const primary = (messageId: string) => ({
    userId: 'user-1', auth: 'agent', agentId: 'agent-1', sessionId: 'session-bound', messageId, credentialId: 'arc_test'
  })

  it('BL-1321: a live primary run hands the tool exactly its own reply’s Stop', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue(primary('message-1'))
    const own = new AbortController()
    registerStreamAbort('session-bound', 'message-1', own)

    await POST({ request: request({ toolId: 'long_job' }), locals: {} } as any)

    expect(mocks.executeCliTool).toHaveBeenCalledTimes(1)
    expect(mocks.executeCliTool.mock.calls[0]?.[1]?.abortSignal).toBe(own.signal)
  })

  for (const state of ['replaced by a newer reply', 'stopped', 'ended'] as const) {
    it(`BL-1322: a primary run whose own reply was ${state} runs nothing: refused before the card target and the tool`, async () => {
      mocks.resolveNativeToolUser.mockResolvedValue(primary('message-1'))
      registerStreamAbort('session-bound', 'message-1', new AbortController())
      if (state === 'replaced by a newer reply') registerStreamAbort('session-bound', 'message-2', new AbortController())
      if (state === 'stopped') abortStream('session-bound', 'user')
      if (state === 'ended') __resetStreamAbortRegistryForTests()

      const response = await POST({ request: request({ toolId: 'long_job', input: {} }), locals: {} } as any)

      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ success: false, stopped: true, code: 'CONTROL_CANCELLATION_REQUIRED' })
      expect(mocks.executeCliTool).not.toHaveBeenCalled()
      // Refused before the card target is resolved, so no session read either.
      expect(mocks.getSession).not.toHaveBeenCalled()
    })
  }

  it('BL-1322: a Subagent or Worker run is not refused here; it hears its parent’s Stop', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1', auth: 'agent', agentId: 'subagent_cli_helper', sessionId: 'session-bound',
      messageId: 'subagent-helper-run', credentialId: 'arc_delegated', delegated: true,
      processOwner: { userId: 'user-1', kind: 'subagent', id: 'helper' }
    })
    const parent = new AbortController()
    registerStreamAbort('session-bound', 'message-parent', parent)
    parent.abort()

    await POST({ request: request({ toolId: 'long_job' }), locals: {} } as any)

    expect(mocks.executeCliTool).toHaveBeenCalledTimes(1)
    expect(mocks.executeCliTool.mock.calls[0]?.[1]?.abortSignal).toBe(parent.signal)
  })
})
