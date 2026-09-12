import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-116 P3 (DL-116-07, DL-116-14) — `/api/cli-tools/execute`.
 *
 * A risky user-authored CLI tool must earn the same Approve button a risky Fabric control
 * does. That needs the chat and the assistant message the card renders on, and this route
 * had neither: it never read `sessionId` or `messageId` at all, so a `cli:` pause on the
 * managed CLI lane created a record with nowhere to show itself.
 *
 * `executeCliTool` is mocked — its own gate has its own suites — so what these pin is what
 * the ROUTE decides: which ids it trusts, and that it refuses ones this user does not own.
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

import { POST } from './+server'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/cli-tools/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('/api/cli-tools/execute — where a cli: pause pins its card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveNativeToolUser.mockResolvedValue({ auth: 'service', userId: 'user-1' })
    mocks.executeCliTool.mockResolvedValue({ success: true, toolId: 'repo_snapshot' })
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    mocks.exists.mockResolvedValue(1)
  })

  it('forwards a session and a message this user owns', async () => {
    await POST({
      request: request({
        toolId: 'repo_snapshot',
        input: { query: 'x' },
        sessionId: 'session-1',
        messageId: 'msg_1'
      }),
      locals: {}
    } as any)

    expect(mocks.executeCliTool).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: 'msg_1' })
    )
  })

  it('drops both when the session belongs to somebody else', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'another-user' })

    await POST({
      request: request({
        toolId: 'repo_snapshot',
        sessionId: 'session-1',
        messageId: 'msg_1'
      }),
      locals: {}
    } as any)

    const params = mocks.executeCliTool.mock.calls[0][0]
    expect(params.sessionId).toBeUndefined()
    expect(params.messageId).toBeUndefined()
  })

  it('keeps the session but drops a message id that is not in it', async () => {
    mocks.exists.mockResolvedValue(0)

    await POST({
      request: request({
        toolId: 'repo_snapshot',
        sessionId: 'session-1',
        messageId: 'msg_from_another_chat'
      }),
      locals: {}
    } as any)

    const params = mocks.executeCliTool.mock.calls[0][0]
    expect(params.sessionId).toBe('session-1')
    expect(params.messageId).toBeUndefined()
  })
  /* ---------------------------------------------------------------------- *
   * SA-117 P2 (DL-117-04) — the managed CLI helper moved to the `agent` lane.
   * ---------------------------------------------------------------------- */

  const agentLaneAuth = {
    auth: 'agent',
    userId: 'user-1',
    agentId: 'agent-cooper',
    sessionId: 'session-1',
    credentialId: 'arc_test'
  }

  it('uses the bound agent and still reads the run project path', async () => {
    // The project path check used to be `auth.auth === 'service'` only. The helper that
    // sends it is on the agent lane now, so a route that forgot to widen the check would
    // have silently run every user CLI tool outside its project.
    mocks.resolveNativeToolUser.mockResolvedValue(agentLaneAuth)

    await POST({
      request: request({
        toolId: 'repo_snapshot',
        input: { query: 'x' },
        sessionId: 'session-1',
        projectPath: '/Users/josh/batshit'
      }),
      locals: {}
    } as any)

    const params = mocks.executeCliTool.mock.calls[0][0]
    expect(params.agentId).toBe('agent-cooper')
    expect(params.projectPath).toBe('/Users/josh/batshit')
  })

  it('refuses a body agentId that differs from the bound one', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue(agentLaneAuth)

    const response = await POST({
      request: request({
        toolId: 'repo_snapshot',
        input: { query: 'x' },
        agentId: 'agent-faye'
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('AGENT_MISMATCH')
    expect(mocks.executeCliTool).not.toHaveBeenCalled()
  })
})
