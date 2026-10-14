import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-601 — a Stop reaches a gateway MCP call a managed CLI reply makes through this route.
 *
 * The managed CLI helper (`mode4-controls-mcp.cjs`) sends every `mcp:` ref of
 * `batshit_tool_use`, and `batshit_server_dynamic_mcp_use`, here as `sys.mcp.dynamic.use`
 * (`callDynamicUse`). BL-454 made that control end its gateway call on
 * `ControlUseOptions.abortSignal`, but this route passed none, so a stopped Codex or Claude
 * reply left the MCP call (and a STDIO server's process) running to its own limit. The request
 * cannot carry a Stop, so the route hands `useControl` the Stop of the reply running in the chat
 * the run credential is bound to (`getRunningReplyStopSignal`), never a chat the body names.
 *
 * The registry is real; `useControl` is mocked (its signal handling has its own suites).
 */

const mocks = vi.hoisted(() => ({
  resolveNativeToolUser: vi.fn(),
  useControl: vi.fn(),
  getSession: vi.fn(),
  exists: vi.fn()
}))

// BL-704: keep the real portable policy constants the route passes; only the resolver is faked.
vi.mock('$lib/server/services/nativeToolAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/nativeToolAuth')>()),
  resolveNativeToolUser: mocks.resolveNativeToolUser
}))

vi.mock('$lib/server/services/fabricRegistry', () => ({
  useControl: mocks.useControl
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
  getOriginatingReplyStopSignal,
  RETIRED_REPLY_STOP_REASON,
  registerStreamAbort
} from '$lib/server/services/streamAbortRegistry'
import { POST } from './+server'
import { settingsControlAdmission } from '$lib/server/services/appActions/settingsAdmission'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/controls/use', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

const dynamicUse = {
  controlId: 'sys.mcp.dynamic.use',
  input: { toolName: 'slow_tool', params: {} }
}

describe('/api/controls/use — the running reply Stop (BL-601)', () => {
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
    mocks.useControl.mockResolvedValue({ success: true, controlId: 'sys.mcp.dynamic.use', result: {} })
    mocks.getSession.mockImplementation(async (id: string) => ({ id, user_id: 'user-1' }))
    mocks.exists.mockResolvedValue(1)
  })

  it('hands useControl the Stop of the reply running in the chat the credential is bound to', async () => {
    registerStreamAbort('session-bound', 'message-1', new AbortController())
    registerStreamAbort('session-claimed', 'message-2', new AbortController())

    const response = await POST({
      request: request({ ...dynamicUse, sessionId: 'session-claimed' }),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    const signal = mocks.useControl.mock.calls[0]?.[0]?.abortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    // The chat the body names is not the credential's: its Stop does not count.
    abortStream('session-claimed', 'user')
    expect(signal.aborted).toBe(false)
    abortStream('session-bound', 'user')
    expect(signal.aborted).toBe(true)
  })

  it('hands no Stop when no reply runs in the bound chat', async () => {
    registerStreamAbort('another-session', 'message-9', new AbortController())

    await POST({ request: request(dynamicUse), locals: {} } as any)

    expect(mocks.useControl).toHaveBeenCalledTimes(1)
    expect(mocks.useControl.mock.calls[0]?.[0]?.abortSignal).toBeUndefined()
  })

  // A copy of `useControl`'s rule for a Settings write on a REQUEST lane only (BL-1314): the
  // Stop of the exact reply the route's `originatingReply` names, read with the real registry,
  // never the chat's running reply in `abortSignal`. The in-process API lane is not modelled
  // here; `fabricRegistry.test.ts` calls the real `useControl` for the lane rule itself.
  const settingsAdmissionAsUseControl = async (options: any) => {
    const error = settingsControlAdmission({ ...options, abortSignal: getOriginatingReplyStopSignal(
      options.originatingReply?.sessionId, options.originatingReply?.messageId) })
    return error
      ? { success: false, controlId: options.controlId, error }
      : { success: true, controlId: options.controlId, result: {} }
  }
  const settingsWrite = {
    controlId: 'sys.ui.settings_agent_memory_update',
    input: { subjectAgentId: 'agent-1', expectedRevision: `sha256:${'a'.repeat(64)}`, changes: { onMyMind: 20 } }
  }

  for (const retired of [false, true]) it(`maps the fixed Settings Stop refusal to policy HTTP 403 with ${retired ? 'a retired' : 'no'} active reply`, async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1', auth: 'agent', agentId: 'agent-1', sessionId: 'session-bound',
      messageId: 'message-1', credentialId: 'arc_test'
    })
    if (retired) {
      registerStreamAbort('session-bound', 'message-1', new AbortController())
      abortStream('session-bound', 'user')
    }
    // The shared production admission supplies the result; this case proves the
    // actual route/real Stop registry/mapping, not whole Fabric mutation behavior.
    mocks.useControl.mockImplementation(settingsAdmissionAsUseControl)
    const response = await POST({ request: request(settingsWrite), locals: {} } as any)
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('CONTROL_CANCELLATION_REQUIRED')
    expect(mocks.useControl).toHaveBeenCalledTimes(1)
    expect(mocks.useControl.mock.calls[0][0].abortSignal?.aborted ?? true).toBe(true)
    expect(mocks.useControl.mock.calls[0][0].originatingReply).toEqual({ sessionId: 'session-bound', messageId: 'message-1' })
  })

  it('BL-1314: names the credential\'s own chat and reply as the originating reply, and that reply admits the write', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1', auth: 'agent', agentId: 'agent-1', sessionId: 'session-bound',
      messageId: 'message-1', credentialId: 'arc_test'
    })
    registerStreamAbort('session-bound', 'message-1', new AbortController())
    mocks.useControl.mockImplementation(settingsAdmissionAsUseControl)

    // A body that names another chat and reply changes nothing: only the credential's ids count.
    const response = await POST({ request: request({ ...settingsWrite, sessionId: 'session-claimed',
      messageId: 'message-forged' }), locals: {} } as any)

    expect(response.status).toBe(200)
    const options = mocks.useControl.mock.calls[0][0]
    expect(options.originatingReply).toEqual({ sessionId: 'session-bound', messageId: 'message-1' })
    expect(getOriginatingReplyStopSignal('session-bound', 'message-1')).toBe(options.abortSignal)
  })

  it('BL-1314: a still-valid credential of an earlier reply is refused while a newer reply runs', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1', auth: 'agent', agentId: 'agent-1', sessionId: 'session-bound',
      messageId: 'message-earlier', credentialId: 'arc_earlier'
    })
    registerStreamAbort('session-bound', 'message-newer', new AbortController())
    mocks.useControl.mockImplementation(settingsAdmissionAsUseControl)

    // The body naming the newer reply changes nothing: only the credential's message counts.
    const response = await POST({ request: request({ ...settingsWrite, messageId: 'message-newer' }), locals: {} } as any)

    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('CONTROL_CANCELLATION_REQUIRED')
    const options = mocks.useControl.mock.calls[0][0]
    // BL-1321: the call's Stop is its own retired reply's, already aborted, never the newer
    // reply's live one.
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(options.abortSignal.aborted).toBe(true)
    expect(options.abortSignal.reason).toBe(RETIRED_REPLY_STOP_REASON)
    expect(options.originatingReply).toEqual({ sessionId: 'session-bound', messageId: 'message-earlier' })
  })

  it('BL-1321: a primary run hears only its own reply: retired is aborted, the newer reply untouched', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1', auth: 'agent', agentId: 'agent-1', sessionId: 'session-bound',
      messageId: 'message-earlier', credentialId: 'arc_earlier'
    })
    const newer = new AbortController()
    registerStreamAbort('session-bound', 'message-newer', newer)

    await POST({ request: request(dynamicUse), locals: {} } as any)

    const signal = mocks.useControl.mock.calls[0][0].abortSignal
    expect(signal).not.toBe(newer.signal)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(RETIRED_REPLY_STOP_REASON)
    expect(newer.signal.aborted).toBe(false)
  })

  it('BL-1321: a live primary run gets exactly its own reply’s Stop', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1', auth: 'agent', agentId: 'agent-1', sessionId: 'session-bound',
      messageId: 'message-1', credentialId: 'arc_test'
    })
    const own = new AbortController()
    registerStreamAbort('session-bound', 'message-1', own)

    await POST({ request: request(dynamicUse), locals: {} } as any)

    expect(mocks.useControl.mock.calls[0][0].abortSignal).toBe(own.signal)
  })

  it('BL-1321: a Subagent or Worker run keeps its chat’s running reply (its parent’s)', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1', auth: 'agent', agentId: 'subagent_cli_helper', sessionId: 'session-bound',
      messageId: 'subagent-helper-run', credentialId: 'arc_delegated', delegated: true
    })
    const parent = new AbortController()
    registerStreamAbort('session-bound', 'message-parent', parent)

    await POST({ request: request(dynamicUse), locals: {} } as any)

    expect(mocks.useControl.mock.calls[0][0].abortSignal).toBe(parent.signal)
    expect(parent.signal.aborted).toBe(false)
  })

  it('BL-1314: a credential that names no message is refused', async () => {
    registerStreamAbort('session-bound', 'message-1', new AbortController())
    mocks.useControl.mockImplementation(settingsAdmissionAsUseControl)

    const response = await POST({ request: request({ ...settingsWrite, messageId: 'message-1' }), locals: {} } as any)

    expect(response.status).toBe(403)
    expect(mocks.useControl.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal)
    expect(mocks.useControl.mock.calls[0][0].originatingReply).toEqual({ sessionId: 'session-bound', messageId: null })
  })

  it('never takes the Stop from a chat the body names on a lane with no bound chat', async () => {
    // The service lane (batshit-server's MCP proxy, n8n) names nobody and no chat.
    registerStreamAbort('session-claimed', 'message-2', new AbortController())
    mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1', auth: 'service' })

    await POST({ request: request({ ...dynamicUse, sessionId: 'session-claimed' }), locals: {} } as any)

    expect(mocks.useControl).toHaveBeenCalledTimes(1)
    expect(mocks.useControl.mock.calls[0]?.[0]?.abortSignal).toBeUndefined()
    expect(mocks.useControl.mock.calls[0]?.[0]?.originatingReply).toBeUndefined()
  })
})
