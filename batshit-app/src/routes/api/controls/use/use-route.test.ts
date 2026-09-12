import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-116 P1 (DL-116-01, DL-116-07, DL-116-09, DL-116-10) — `/api/controls/use`.
 *
 * This route is the door every non-API lane comes through: the managed CLI helper
 * (`mode4-controls-mcp.cjs`), batshit-server's MCP proxy, n8n, and Portable Skill Tokens.
 * `useControl` is mocked here on purpose — its own gate has its own suites — so what these
 * tests pin is what the ROUTE decides: which flag it forwards, which message id it trusts,
 * and what the 403 body carries.
 */

const mocks = vi.hoisted(() => ({
  resolveNativeToolUser: vi.fn(),
  useControl: vi.fn(),
  recordPortableSkillTokenControlExecution: vi.fn(),
  getSession: vi.fn(),
  exists: vi.fn(),
  getActiveStream: vi.fn()
}))

vi.mock('$lib/server/services/streamAbortRegistry', () => ({
  getActiveStream: (...args: any[]) => mocks.getActiveStream(...args)
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
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

vi.mock('$lib/server/services/portableSkillTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/portableSkillTokens')>()
  return {
    ...actual,
    recordPortableSkillTokenControlExecution: mocks.recordPortableSkillTokenControlExecution
  }
})

import { POST } from './+server'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/controls/use', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

const OK_RESULT = {
  success: true,
  controlId: 'sys.memory.delete',
  dryRun: false,
  riskLevel: 'confirm',
  status: 'published',
  result: { ok: true }
}

describe('/api/controls/use — the click is the approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1', auth: 'service' })
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'user-1' })
    mocks.exists.mockResolvedValue(1)
    mocks.getActiveStream.mockReturnValue(null)
    mocks.useControl.mockResolvedValue(OK_RESULT)
  })

  it('DL-116-07: keeps the id of the turn that is running RIGHT NOW, which is not written yet', async () => {
    // The managed CLI helper calls this from inside the turn the card belongs to, so the
    // assistant message does not exist yet — measured live on BSMS, where every CLI pause
    // came back `lane: 'service'` with no card. `getActiveStream` is the server's own note
    // of which assistant message this session's turn is writing.
    mocks.exists.mockResolvedValue(0)
    mocks.getActiveStream.mockReturnValue({ messageId: 'msg_in_flight' })

    await POST({
      request: request({
        controlId: 'sys.memory.delete',
        sessionId: 'session-1',
        messageId: 'msg_in_flight'
      }),
      locals: {}
    } as any)

    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: 'msg_in_flight' })
    )
    // Not persisted, so the fallback was never consulted for this one.
    expect(mocks.exists).not.toHaveBeenCalled()
  })

  it('DL-116-07: does not accept an id that is neither in flight nor written', async () => {
    mocks.exists.mockResolvedValue(0)
    mocks.getActiveStream.mockReturnValue({ messageId: 'msg_in_flight' })

    await POST({
      request: request({
        controlId: 'sys.memory.delete',
        sessionId: 'session-1',
        messageId: 'msg_someone_elses'
      }),
      locals: {}
    } as any)

    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: undefined })
    )
  })

  it('DL-116-01: never forwards the caller’s allowRisky on the service lane', async () => {
    // The managed CLI helper, the MCP proxy, and n8n all pass this straight from their
    // payload, which is model-adjacent text. Before SA-116 it ran the control outright.
    await POST({
      request: request({
        controlId: 'sys.memory.delete',
        input: { memory_id: 'mem_1' },
        sessionId: 'session-1',
        allowRisky: true
      }),
      locals: {}
    } as any)

    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ allowRisky: false, actorType: 'service' })
    )
  })

  it('DL-116-09: a Portable Skill Token still gets its forced approval', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1',
      auth: 'portable-skill',
      portableSkillToken: {
        id: 'pst_1',
        userId: 'user-1',
        label: 'Voice setup',
        families: ['voice-engines'],
        tokenPrefix: 'bspt_test',
        tokenSuffix: 'secret',
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null
      },
      portableSkillAllowedControlIds: ['sys.voice.engine.complete_local_setup']
    })

    await POST({
      request: request({
        controlId: 'sys.voice.engine.complete_local_setup',
        input: { engineId: 'demo' },
        // Even a token call that says false: the token's family scope is the consent, and
        // there is no chat for the person who minted it to click in.
        allowRisky: false
      }),
      locals: {}
    } as any)

    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ allowRisky: true, actorType: 'portable-skill' })
    )
  })

  it('DL-116-07: keeps a messageId only when it really is in the owned session', async () => {
    await POST({
      request: request({
        controlId: 'sys.memory.delete',
        sessionId: 'session-1',
        messageId: 'msg_1'
      }),
      locals: {}
    } as any)
    expect(mocks.exists).toHaveBeenCalledWith('message:session-1:msg_1')
    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', messageId: 'msg_1' })
    )

    // A message that is not in this session cannot pin a card onto it.
    mocks.useControl.mockClear()
    mocks.exists.mockResolvedValue(0)
    await POST({
      request: request({
        controlId: 'sys.memory.delete',
        sessionId: 'session-1',
        messageId: 'msg_from_another_chat'
      }),
      locals: {}
    } as any)
    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: undefined })
    )
  })

  it('DL-116-07: drops the messageId when the session is not the caller’s', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', user_id: 'somebody-else' })
    await POST({
      request: request({
        controlId: 'sys.memory.delete',
        sessionId: 'session-1',
        messageId: 'msg_1'
      }),
      locals: {}
    } as any)
    // With no owned session there is nothing to check the id against, so it is not trusted.
    expect(mocks.exists).not.toHaveBeenCalled()
    expect(mocks.useControl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: undefined, messageId: undefined })
    )
  })

  it('DL-116-07: a pause answers 403 with the card block at the top level', async () => {
    const approvalRequest = {
      approvalId: 'apr_abc',
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      inputSummary: { memory_id: 'mem_1' },
      lane: 'cli',
      requestedAt: '2026-09-09T10:00:00.000Z'
    }
    mocks.useControl.mockResolvedValue({
      success: false,
      controlId: 'sys.memory.delete',
      error: {
        code: 'CONTROL_RISK_REQUIRES_APPROVAL',
        message: 'Batshit paused "Delete Memory" and asked the user to approve it.',
        details: { approvalId: 'apr_abc', approvalRequest }
      }
    })

    const response = await POST({
      request: request({
        controlId: 'sys.memory.delete',
        sessionId: 'session-1',
        messageId: 'msg_1'
      }),
      locals: {}
    } as any)

    // 403, not 500: a pause is a policy answer, and a retryable status is the loop the
    // guidance exists to stop.
    expect(response.status).toBe(403)
    const payload = await response.json()
    // send-routed's one `case 'tool-result'` loop reads it here, on every lane.
    expect(payload.approvalRequest).toEqual(approvalRequest)
    expect(payload.error.details.approvalId).toBe('apr_abc')
  })

  it('DL-116-10: a group refusal is 403, not a 500 the caller will retry', async () => {
    mocks.useControl.mockResolvedValue({
      success: false,
      controlId: 'sys.memory.delete',
      error: {
        code: 'CONTROL_RISK_UNAVAILABLE_IN_GROUP',
        message:
          'Risky controls are not available in group chats. Ask the user in a direct chat with this agent.'
      }
    })

    const response = await POST({
      request: request({ controlId: 'sys.memory.delete', sessionId: 'session-1' }),
      locals: {}
    } as any)

    expect(response.status).toBe(403)
    const payload = await response.json()
    expect(payload.error.message).toContain('direct chat')
    expect(payload.approvalRequest).toBeUndefined()
  })
})
