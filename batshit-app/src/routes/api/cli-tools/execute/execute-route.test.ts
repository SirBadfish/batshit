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
import { __resetStreamAbortRegistryForTests, registerStreamAbort } from '$lib/server/services/streamAbortRegistry'

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
    __resetStreamAbortRegistryForTests()
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
        processOwner: { userId: 'user-1', kind: 'agent', id: 'agent-victim' },
        sessionId: 'session-1',
        messageId: 'msg_1'
      }),
      locals: {}
    } as any)

    expect(mocks.executeCliTool).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: 'msg_1' })
    )
    expect(mocks.executeCliTool.mock.calls[0][0]).not.toHaveProperty('processOwner')
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

})

/* ------------------------------------------------------------------------ *
 * BL-686 — a managed run reaches only the saved CLI tools its credential names.
 * The body's `selectedToolIds` is handed on only as a filter on that list.
 * ------------------------------------------------------------------------ */
describe('/api/cli-tools/execute — the saved CLI tools a caller may reach (BL-686)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeCliTool.mockResolvedValue({ success: true, toolId: 'a_tool' })
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    mocks.exists.mockResolvedValue(1)
  })

  const run = (body: Record<string, unknown>) =>
    POST({ request: request(body), locals: {} } as any)

  it("leaves the signed-in and service lanes on the named agent's saved list", async () => {
    for (const auth of [
      { auth: 'session', userId: 'user-1' },
      { auth: 'service', userId: 'user-1' }
    ]) {
      mocks.executeCliTool.mockClear()
      mocks.resolveNativeToolUser.mockResolvedValue(auth)
      await run({ toolId: 'a_tool', agentId: 'agent_a', selectedToolIds: ['a_tool'], cliToolScope: ['b_tool'] })
      const params = mocks.executeCliTool.mock.calls[0][0]
      expect(params).not.toHaveProperty('cliToolScope')
      expect(params.agentId).toBe('agent_a')
      expect(params.selectedToolIds).toEqual(['a_tool'])
    }
  })
})
