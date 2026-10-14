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
      expect.objectContaining({ sessionId: 'session-1', messageId: 'msg_1', processOwner: undefined }),
      // The service lane has no bound chat, so no Stop (`stop-signal.test.ts`).
      { abortSignal: undefined }
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

  it('pins the card to the credential reply even when the body names another saved reply', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({ ...agentLaneAuth, messageId: 'bound-reply' })
    // The credential's reply is running, as it is for every live call (BL-1321: a primary run's
    // call hears that reply's Stop; with its reply gone it would be refused before the tool).
    const reply = new AbortController()
    registerStreamAbort('session-1', 'bound-reply', reply)
    await POST({ request: request({
      toolId: 'repo_snapshot', sessionId: 'session-1', messageId: 'other-saved-reply'
    }), locals: {} } as any)
    expect(mocks.executeCliTool).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'bound-reply' }), expect.objectContaining({ abortSignal: reply.signal }))
  })

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
        projectPath: '/tmp/example-project'
      }),
      locals: {}
    } as any)

    const params = mocks.executeCliTool.mock.calls[0][0]
    expect(params.agentId).toBe('agent-cooper')
    expect(params.projectPath).toBe('/tmp/example-project')
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

  it('passes the credential owner and ignores a forged body owner', async () => {
    const owner = { userId: 'user-1', kind: 'subagent', id: 'stored-subagent' }
    mocks.resolveNativeToolUser.mockResolvedValue({ ...agentLaneAuth,
      agentId: 'subagent_cli_runtime', delegated: true, processOwner: owner })
    await POST({ request: request({ toolId: 'repo_snapshot',
      processOwner: { userId: 'user-1', kind: 'agent', id: 'agent-victim' } }), locals: {} } as any)
    expect(mocks.executeCliTool).toHaveBeenCalledWith(
      expect.objectContaining({ processOwner: owner }), expect.anything())
  })

  it('refuses a delegated command without a minted physical owner', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({ ...agentLaneAuth,
      agentId: 'subagent_cli_runtime', delegated: true })
    const response = await POST({ request: request({ toolId: 'repo_snapshot' }), locals: {} } as any)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('OWNER_UNAVAILABLE')
    expect(mocks.executeCliTool).not.toHaveBeenCalled()
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

  it("bounds an agent credential by its own list, whatever list the body names", async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      auth: 'agent', userId: 'user-1', agentId: 'agent_a', sessionId: 'session-1',
      cliToolScope: ['a_tool']
    })
    await run({ toolId: 'b_tool', selectedToolIds: ['b_tool'], cliToolScope: ['b_tool'] })

    const params = mocks.executeCliTool.mock.calls[0][0]
    expect(params.agentId).toBe('agent_a')
    expect(params.cliToolScope).toEqual(['a_tool'])
    expect(params.selectedToolIds).toEqual(['b_tool'])
  })

  it('gives an older agent credential with no list an empty one', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      auth: 'agent', userId: 'user-1', agentId: 'agent_a', sessionId: 'session-1'
    })
    await run({ toolId: 'a_tool' })
    expect(mocks.executeCliTool.mock.calls[0][0].cliToolScope).toEqual([])
  })

  it('bounds a delegated run by its credential list too', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      auth: 'agent', userId: 'user-1', agentId: 'subagent_cli_helper', sessionId: 'session-1',
      delegated: true, delegatedAllowedControlIds: [], cliToolScope: ['sub_tool'],
      processOwner: { userId: 'user-1', kind: 'subagent', id: 'stored-subagent' }
    })
    await run({ toolId: 'global_tool' })
    expect(mocks.executeCliTool.mock.calls[0][0].cliToolScope).toEqual(['sub_tool'])
  })

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
