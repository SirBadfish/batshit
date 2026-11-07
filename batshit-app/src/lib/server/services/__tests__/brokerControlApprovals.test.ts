import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { controlApprovalsIndexKey, getControlApproval } from '../controlApprovals'
import {
  attachControlApprovalRecords,
  deriveControlApprovalId,
  resolveApprovalResumeGrants, observeP5ApiResumeGrant
} from '../brokerControlApprovals'
import { decideApproval } from '../controlApprovals'

/**
 * SA-116 P2 (AMD-116-01, F-P1-4) — the two ends of an API-lane approval.
 *
 * The claims here are about WHO decides which consent record gets spent, so the mutations
 * behind them are in the story's private evidence.
 */

useRedisTestServer()

const USER = 'user-approvals'
const AGENT = 'agent-1'
const SESSION = 'session-api'
const MESSAGE = 'msg_assistant_1'

const riskProfile = vi.fn()
/**
 * The store stays REAL; only the call is watched. The claim these tests make is about what
 * `resolveApprovalResumeGrants` decides to ASK the approval store, which a spy can see and
 * an outcome assertion cannot: `decideApproval` refuses a malformed id on its own, so a test
 * that only checks the result proves the store's guard, not this function's.
 */
vi.mock('../controlApprovals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../controlApprovals')>()
  return {
    ...actual,
    decideApproval: vi.fn((...args: any[]) => (actual.decideApproval as any)(...args))
  }
})

vi.mock('../nativeTools', () => ({
  nativeToolService: {
    resolveBrokerRiskApprovalTarget: (...args: any[]) => riskProfile(...args)
  }
}))

/**
 * The card entry the AI SDK produces, in the shape P0 measured on BSMS:
 * `toolName: 'native_batshit_tool_use'`, the SDK's own `aitxt-…` approval id, and the
 * model's raw broker input under `toolCall.input` (Part 2.10 (a)).
 */
const sdkEntry = (overrides: Record<string, any> = {}) => ({
  approvalId: 'aitxt-3f2a',
  status: 'pending' as const,
  requestedAt: '2026-09-10T04:00:00.000Z',
  expiresAt: '2026-09-10T04:03:00.000Z',
  toolName: 'native_batshit_tool_use',
  toolCall: {
    type: 'tool-call',
    toolCallId: 'toolu_013Y',
    toolName: 'native_batshit_tool_use',
    input: { ref: 'fabric:sys.memory.delete', input: { memory_id: 'mem_1' } }
  },
  input: { ref: 'fabric:sys.memory.delete', input: { memory_id: 'mem_1' } },
  source: 'vercel' as const,
  ...overrides
})

const memoryDeleteTarget = {
  ref: 'fabric:sys.memory.delete',
  family: 'fabric' as const,
  controlId: 'sys.memory.delete',
  controlTitle: 'Delete Memory',
  riskLevel: 'confirm' as const,
  scopeKey: null,
  input: { memory_id: 'mem_1' },
  lane: 'api' as const
}

beforeEach(() => {
  vi.mocked(decideApproval).mockClear()
  riskProfile.mockReset()
  riskProfile.mockResolvedValue(memoryDeleteTarget)
})

async function seedAssistantMessage(approvals: any[], earlierTurns = 0) {
  await redis.createSession({
    id: SESSION,
    user_id: USER,
    name: SESSION,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    metadata: {}
  } as any)
  if (earlierTurns > 0) {
    // Older turns ahead of the card in the session's message list. Their records need not
    // exist: `getMessages` skips a missing record, which is exactly how the oldest-first
    // window hid the card (F-P2-1).
    await redis.execute(async (client) =>
      client.rPush(
        `messages:${SESSION}`,
        Array.from({ length: earlierTurns }, (_, index) => `msg_earlier_${index}`)
      )
    )
  }
  await redis.saveMessage({
    id: MESSAGE,
    session_id: SESSION,
    user_id: USER,
    agent_id: AGENT,
    role: 'assistant',
    content: 'I need your approval first.',
    created_at: new Date().toISOString(),
    metadata: { toolApprovals: { mode: 'off', approvals, source: 'vercel' } }
  } as any)
}

describe('attachControlApprovalRecords', () => {
  it('creates one pending record per SDK approval and hands the card its control block', async () => {
    const [entry] = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })

    expect(entry.control).toEqual({
      approvalId: deriveControlApprovalId(SESSION, 'aitxt-3f2a'),
      controlId: 'sys.memory.delete',
      controlTitle: 'Delete Memory',
      riskLevel: 'confirm',
      // F-P2-2: the exact payload the hash covers rides the entry, so the card can show it.
      input: { memory_id: 'mem_1' },
      inputSummary: { memory_id: 'mem_1' },
      lane: 'api'
    })

    const record = await getControlApproval(entry.control!.approvalId)
    expect(record?.status).toBe('pending')
    // F-P1-4: the mapping the resume reads back, kept on the server.
    expect(record?.sdkApprovalId).toBe('aitxt-3f2a')
    expect(record?.toolCallId).toBe('toolu_013Y')
    expect(record?.messageId).toBe(MESSAGE)
  })

  it('AMD-116-01: called twice for one approval id, it creates exactly one record', async () => {
    await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })

    const ids = await redis.execute(async (client) =>
      client.zRange(controlApprovalsIndexKey(SESSION), 0, -1)
    )
    expect(ids).toEqual([deriveControlApprovalId(SESSION, 'aitxt-3f2a')])
  })

  it('leaves a Bash approval exactly as it was — it has no consent record', async () => {
    const bash = {
      approvalId: 'aitxt-bash',
      status: 'pending' as const,
      toolName: 'native_bash_execute',
      input: { command: 'ls -la' }
    }
    const [entry] = await attachControlApprovalRecords({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [bash as any]
    })
    expect(entry).toBe(bash)
    expect(riskProfile).not.toHaveBeenCalled()
  })

  it('keeps the card when the record cannot be created, rather than losing a paused turn', async () => {
    riskProfile.mockRejectedValue(new Error('registry unavailable'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const [entry] = await attachControlApprovalRecords({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })

    expect(entry.control).toBeUndefined()
    expect(entry.approvalId).toBe('aitxt-3f2a')
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('resolveApprovalResumeGrants', () => {
  it.each(['cli', 'service', undefined])('does not decide a saved non-API control card (lane %s)', async lane => {
    const [entry] = await attachControlApprovalRecords({ userId: USER, agentId: AGENT, sessionId: SESSION,
      messageId: MESSAGE, approvals: [sdkEntry()] })
    await seedAssistantMessage([{ ...entry, control: { ...entry.control, lane } }])
    const result = await resolveApprovalResumeGrants({ userId: USER, sessionId: SESSION, messageId: MESSAGE,
      responses: [{ type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }] })
    expect(result).toEqual({ approved: {}, denied: {} })
    expect(decideApproval).not.toHaveBeenCalled()
    expect((await getControlApproval(entry.control!.approvalId))?.status).toBe('pending')
  })

  it('cannot decide a retired record even if a card is labeled API', async () => {
    const [entry] = await attachControlApprovalRecords({ userId: USER, agentId: AGENT, sessionId: SESSION,
      messageId: MESSAGE, approvals: [sdkEntry()] })
    await redis.json.set(`control_approval:${entry.control!.approvalId}`, '$.lane', 'cli')
    await seedAssistantMessage([entry])
    const result = await resolveApprovalResumeGrants({ userId: USER, sessionId: SESSION, messageId: MESSAGE,
      responses: [{ type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }] })
    expect(result).toEqual({ approved: {}, denied: {} })
    expect((await getControlApproval(entry.control!.approvalId))?.status).toBe('pending')
  })
  it('resolves the click from the persisted message and marks the record approved', async () => {
    const approvals = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await seedAssistantMessage(approvals)

    const grants = await resolveApprovalResumeGrants({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [
        { type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }
      ]
    })

    const recordId = deriveControlApprovalId(SESSION, 'aitxt-3f2a')
    expect(grants.approved).toEqual({
      toolu_013Y: { kind: 'sdk', approvalId: recordId, toolCallId: 'toolu_013Y' }
    })
    expect(grants.denied).toEqual({})
    expect((await getControlApproval(recordId))?.status).toBe('approved')
  })

  it('F-P2-1: resolves the click in a chat longer than the oldest-first history window', async () => {
    // `redis.getMessages(sessionId, 300)` returns the OLDEST 300 messages (rPush + lRange
    // 0..299). Three hundred earlier turns push the assistant message carrying the card out
    // of that read entirely; the click then resolved no grant, and the resumed call paused
    // again with nothing left to click. The resume must read the message it names.
    const approvals = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await seedAssistantMessage(approvals, 300)

    const grants = await resolveApprovalResumeGrants({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [
        { type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }
      ]
    })

    expect(Object.keys(grants.approved)).toEqual(['toolu_013Y'])
    expect(
      (await getControlApproval(deriveControlApprovalId(SESSION, 'aitxt-3f2a')))?.status
    ).toBe('approved')
  })

  it('F-P2-1: without a message id it reads from the newest end of the chat', async () => {
    const approvals = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await seedAssistantMessage(approvals, 300)

    const grants = await resolveApprovalResumeGrants({
      userId: USER,
      sessionId: SESSION,
      responses: [
        { type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }
      ]
    })

    expect(Object.keys(grants.approved)).toEqual(['toolu_013Y'])
  })

  it('F-P1-4: an apr_ id the client posts back cannot name the record to spend', async () => {
    // Two paused controls in one turn. The browser answers the FIRST one, but posts the
    // SECOND one's record id alongside it. The record that gets approved must be the one
    // the persisted message maps the SDK id to — never the one the POST names.
    riskProfile
      .mockResolvedValueOnce(memoryDeleteTarget)
      .mockResolvedValueOnce({
        ...memoryDeleteTarget,
        ref: 'fabric:sys.skill.import',
        controlId: 'sys.skill.import',
        controlTitle: 'Import Skill',
        riskLevel: 'restricted',
        input: { source: 'https://example.test/skill' }
      })

    const approvals = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [
        sdkEntry(),
        sdkEntry({
          approvalId: 'aitxt-second',
          toolCall: {
            type: 'tool-call',
            toolCallId: 'toolu_second',
            toolName: 'native_batshit_tool_use',
            input: { ref: 'fabric:sys.skill.import', input: { source: 'https://example.test/skill' } }
          }
        })
      ]
    })
    await seedAssistantMessage(approvals)

    const dangerousId = deriveControlApprovalId(SESSION, 'aitxt-second')
    const grants = await resolveApprovalResumeGrants({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [
        {
          type: 'tool-approval-response',
          approvalId: 'aitxt-3f2a',
          approved: true,
          // Not a field the resume reads. It is here because a browser could send it.
          control: { approvalId: dangerousId }
        } as any
      ]
    })

    expect(grants.approved).toEqual({
      toolu_013Y: {
        kind: 'sdk',
        approvalId: deriveControlApprovalId(SESSION, 'aitxt-3f2a'),
        toolCallId: 'toolu_013Y'
      }
    })
    // The restricted skill import the user never answered is still pending.
    expect((await getControlApproval(dangerousId))?.status).toBe('pending')
  })

  it('records a denial and hands the run the title, so the model is told what was refused', async () => {
    const approvals = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await seedAssistantMessage(approvals)

    const grants = await resolveApprovalResumeGrants({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [
        { type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: false }
      ]
    })

    expect(grants.approved).toEqual({})
    expect(grants.denied).toEqual({ toolu_013Y: { controlTitle: 'Delete Memory' } })
    expect(
      (await getControlApproval(deriveControlApprovalId(SESSION, 'aitxt-3f2a')))?.status
    ).toBe('denied')
  })

  it('grants nothing for an approval another user owns', async () => {
    const approvals = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await seedAssistantMessage(approvals)

    const grants = await resolveApprovalResumeGrants({
      userId: 'someone-else',
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [
        { type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }
      ]
    })

    expect(grants.approved).toEqual({})
    expect(
      (await getControlApproval(deriveControlApprovalId(SESSION, 'aitxt-3f2a')))?.status
    ).toBe('pending')
  })

  it('grants nothing when the record behind the click is gone', async () => {
    const approvals = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await seedAssistantMessage(approvals)
    // The session was deleted, or the 24 hours ran out.
    await redis.del(`control_approval:${deriveControlApprovalId(SESSION, 'aitxt-3f2a')}`)

    const grants = await resolveApprovalResumeGrants({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [
        { type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }
      ]
    })

    expect(grants.approved).toEqual({})
  })

  it('creates no record for a control the actor cannot use (AMD-116-02)', async () => {
    riskProfile.mockResolvedValue(null)
    const [entry] = await attachControlApprovalRecords({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    expect(entry.control).toBeUndefined()
    const ids = await redis.execute(async (client) =>
      client.zRange(controlApprovalsIndexKey(SESSION), 0, -1)
    )
    expect(ids).toEqual([])
  })
})
