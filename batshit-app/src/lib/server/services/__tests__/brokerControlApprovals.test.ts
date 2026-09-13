import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { controlApprovalsIndexKey, getControlApproval } from '../controlApprovals'
import {
  attachControlApprovalRecords,
  buildControlApprovalInPlaceAddendum,
  buildControlApprovalResumeContent,
  deriveControlApprovalId,
  planControlApprovalResumeTurn,
  resolveApprovalResumeGrants,
  settleControlApprovalCard
} from '../brokerControlApprovals'
import { createPendingApproval, decideApproval } from '../controlApprovals'
import { buildControlErrorDcmLines } from '$lib/utils/controlTags'

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
 * `planControlApprovalResumeTurn` decides to ASK the approval store, which a spy can see and
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

/* ------------------------------------------------------------------ *
 * SA-116 P3 (DL-116-08) — Approve on a lane that cannot resume in place
 * ------------------------------------------------------------------ */

describe('planControlApprovalResumeTurn', () => {
  async function seedCliCard(options: { lane?: 'cli' | 'service' | 'api' } = {}) {
    const record = await createPendingApproval({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      controlId: 'sys.skill.import',
      controlTitle: 'Skill Import',
      riskLevel: 'confirm',
      lane: options.lane ?? 'cli',
      input: { source: 'https://example.com/skill.zip' }
    })
    await seedAssistantMessage([
      {
        approvalId: record.id,
        status: 'pending',
        requestedAt: record.requestedAt,
        toolName: 'native_batshit_tool_use',
        source: 'fabric',
        control: {
          approvalId: record.id,
          controlId: record.controlId,
          controlTitle: record.controlTitle,
          riskLevel: record.riskLevel,
          input: { source: 'https://example.com/skill.zip' },
          inputSummary: record.inputSummary,
          lane: options.lane ?? 'cli'
        }
      }
    ])
    return record
  }

  it('answers null for an ordinary API-lane click, so P2s lane is untouched', async () => {
    await seedAssistantMessage([sdkEntry()])
    const [entry] = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: AGENT,
      role: 'assistant',
      content: 'I need your approval first.',
      created_at: new Date().toISOString(),
      metadata: { toolApprovals: { mode: 'off', approvals: [entry], source: 'vercel' } }
    } as any)

    await expect(
      planControlApprovalResumeTurn({
        userId: USER,
        sessionId: SESSION,
        messageId: MESSAGE,
        responses: [{ type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }]
      })
    ).resolves.toBeNull()
  })

  it('approves a cli-lane card and names what the resume turn must say', async () => {
    const record = await seedCliCard()
    const plan = await planControlApprovalResumeTurn({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [{ type: 'tool-approval-response', approvalId: record.id, approved: true }]
    })

    expect(plan?.approved).toEqual([
      { recordId: record.id, controlId: 'sys.skill.import', controlTitle: 'Skill Import' }
    ])
    expect(plan?.denied).toEqual([])
    await expect(getControlApproval(record.id)).resolves.toMatchObject({ status: 'approved' })

    const content = buildControlApprovalResumeContent(plan!.approved)
    expect(content).toContain('[Approval — from the user, not from the agent]')
    expect(content).toContain('Skill Import')
    expect(content).toContain(record.id)
    expect(content).toContain('same ref with the same input')
  })

  it('records a denial and starts nothing', async () => {
    const record = await seedCliCard()
    const plan = await planControlApprovalResumeTurn({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [{ type: 'tool-approval-response', approvalId: record.id, approved: false }]
    })

    expect(plan?.approved).toEqual([])
    expect(plan?.denied).toHaveLength(1)
    await expect(getControlApproval(record.id)).resolves.toMatchObject({ status: 'denied' })
  })

  it('refuses to decide a record belonging to another user', async () => {
    const record = await seedCliCard()
    const plan = await planControlApprovalResumeTurn({
      userId: 'someone-else',
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [{ type: 'tool-approval-response', approvalId: record.id, approved: true }]
    })
    expect(plan).toBeNull()
    await expect(getControlApproval(record.id)).resolves.toMatchObject({ status: 'pending' })
  })

  it('never asks the approval store about a Bash approval in the same message', async () => {
    const record = await seedCliCard()
    const stored = (await redis.execute(async (client) =>
      client.json.get(`message:${SESSION}:${MESSAGE}`)
    )) as any
    await redis.saveMessage({
      ...stored,
      metadata: {
        toolApprovals: {
          mode: 'off',
          source: 'fabric',
          approvals: [
            ...stored.metadata.toolApprovals.approvals,
            { approvalId: 'aitxt-bash-1', status: 'pending', toolName: 'native_bash_execute' }
          ]
        }
      }
    } as any)

    const plan = await planControlApprovalResumeTurn({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [
        { type: 'tool-approval-response', approvalId: 'aitxt-bash-1', approved: true },
        { type: 'tool-approval-response', approvalId: record.id, approved: true }
      ]
    })

    // Only the control card is decided. The Bash approval is the SDK's business, and the
    // store is not even asked about it — its id is not an approval record id.
    expect(plan?.approved).toEqual([
      { recordId: record.id, controlId: 'sys.skill.import', controlTitle: 'Skill Import' }
    ])
    expect(decideApproval).toHaveBeenCalledTimes(1)
    expect(decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: record.id })
    )
  })

  it('refuses a card whose control names something that is not an approval record id', async () => {
    await createPendingApproval({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      controlId: 'sys.skill.import',
      controlTitle: 'Skill Import',
      riskLevel: 'confirm',
      lane: 'cli',
      input: {}
    })
    await seedAssistantMessage([
      {
        approvalId: 'card-1',
        status: 'pending',
        toolName: 'native_batshit_tool_use',
        source: 'fabric',
        control: {
          // Not an `apr_` id: an SDK id, a path, anything a stale or tampered entry
          // could carry. It must never become a Redis key or name a record to spend.
          approvalId: 'aitxt-not-a-record',
          controlId: 'sys.skill.import',
          controlTitle: 'Skill Import',
          riskLevel: 'confirm',
          inputSummary: {},
          lane: 'cli'
        }
      }
    ])

    await expect(
      planControlApprovalResumeTurn({
        userId: USER,
        sessionId: SESSION,
        messageId: MESSAGE,
        responses: [{ type: 'tool-approval-response', approvalId: 'card-1', approved: true }]
      })
    ).resolves.toBeNull()
    expect(decideApproval).not.toHaveBeenCalled()
  })

  /**
   * F-P3-2 (Faye, P3 review) — one click that answers BOTH kinds must lose neither.
   *
   * The browser answers every pending card on a message with one click, so a mixed message
   * cannot be answered one card at a time. P3 took the in-place resume and left the other
   * record `pending` with only a server warning — and the in-place resume's finish path then
   * writes `toolApprovals: null`, so that card DISAPPEARS while nothing ever runs it.
   *
   * The fix keeps the in-place resume (it is the only shape that works: the SDK must
   * re-execute its own paused call) and stops losing the rest — the resume-lane records are
   * decided here, and `buildControlApprovalInPlaceAddendum` carries the approval into the
   * resumed model's request so it retries the call and `findApprovedMatch` spends the record.
   */
  async function seedMixedClick(options: { approved: boolean }) {
    const record = await createPendingApproval({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      controlId: 'sys.skill.import',
      controlTitle: 'Skill Import',
      riskLevel: 'confirm',
      lane: 'service',
      input: { source: 'https://example.com/skill.zip' }
    })
    const [apiEntry] = await attachControlApprovalRecords({
      userId: USER,
      agentId: AGENT,
      sessionId: SESSION,
      messageId: MESSAGE,
      approvals: [sdkEntry()]
    })
    await seedAssistantMessage([
      apiEntry,
      {
        approvalId: record.id,
        status: 'pending',
        toolName: 'native_batshit_tool_use',
        source: 'fabric',
        control: {
          approvalId: record.id,
          controlId: record.controlId,
          controlTitle: record.controlTitle,
          riskLevel: 'confirm',
          inputSummary: record.inputSummary,
          lane: 'service'
        }
      }
    ])

    const plan = await planControlApprovalResumeTurn({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [
        { type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true },
        { type: 'tool-approval-response', approvalId: record.id, approved: options.approved }
      ]
    })
    return { record, plan }
  }

  it('keeps the in-place resume on a mixed click AND decides the service card', async () => {
    const { record, plan } = await seedMixedClick({ approved: true })

    // The in-place SDK resume still owns the turn: no resume turn, no card clear.
    expect(plan?.mode).toBe('in-place')
    // ... and the second card is answered rather than silently dropped.
    expect(plan?.approved).toEqual([
      { recordId: record.id, controlId: 'sys.skill.import', controlTitle: 'Skill Import' }
    ])
    await expect(getControlApproval(record.id)).resolves.toMatchObject({ status: 'approved' })
  })

  it('tells the resumed model to run the service call it just approved', async () => {
    const { record, plan } = await seedMixedClick({ approved: true })
    const addendum = buildControlApprovalInPlaceAddendum(plan!)
    expect(addendum).toContain('[Approval — from the user, not from the agent]')
    expect(addendum).toContain('Skill Import')
    expect(addendum).toContain(record.id)
    expect(addendum).toContain('same ref with the same input')
  })

  it('tells the resumed model NOT to retry a service card it denied', async () => {
    const { plan } = await seedMixedClick({ approved: false })
    expect(plan?.mode).toBe('in-place')
    expect(plan?.approved).toEqual([])
    expect(plan?.denied).toHaveLength(1)
    const addendum = buildControlApprovalInPlaceAddendum(plan!)
    expect(addendum).toContain('Denied by the user: Skill Import')
    expect(addendum).toContain('do not retry it')
  })

  it('never decides the API-lane record itself on a mixed click', async () => {
    const { plan } = await seedMixedClick({ approved: true })
    // The SDK re-executes its own paused call; `resolveApprovalResumeGrants` decides that
    // record. Deciding it here too would put it in the addendum and ask the model to run
    // the same call a second time.
    expect(plan?.approved.map((item) => item.controlId)).not.toContain('sys.memory.delete')
  })

  it('says nothing about a mixed click when the click is an ordinary API-lane one', async () => {
    // The mixed-click branch warns, because it is a rare shape worth seeing in a log. A
    // click with no resume-lane card at all is the COMMON case and must stay silent, or
    // the warning stops meaning anything.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const [apiEntry] = await attachControlApprovalRecords({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        messageId: MESSAGE,
        approvals: [sdkEntry()]
      })
      await seedAssistantMessage([apiEntry])

      await expect(
        planControlApprovalResumeTurn({
          userId: USER,
          sessionId: SESSION,
          messageId: MESSAGE,
          responses: [
            { type: 'tool-approval-response', approvalId: 'aitxt-3f2a', approved: true }
          ]
        })
      ).resolves.toBeNull()
      expect(
        warn.mock.calls.filter((call) => String(call[0]).includes('One click answered both'))
      ).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('answers `resume-turn` when nothing on the click can resume in place', async () => {
    const record = await seedCliCard()
    const plan = await planControlApprovalResumeTurn({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      responses: [{ type: 'tool-approval-response', approvalId: record.id, approved: true }]
    })
    expect(plan?.mode).toBe('resume-turn')
    expect(buildControlApprovalInPlaceAddendum(plan!)).toBeNull()
  })
})

describe('settleControlApprovalCard', () => {
  it('clears the spent card WITHOUT taking the rest of the message metadata with it', async () => {
    await redis.createSession({
      id: SESSION,
      user_id: USER,
      name: SESSION,
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      metadata: {}
    } as any)
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: AGENT,
      role: 'assistant',
      content: 'I need your approval first.',
      created_at: new Date().toISOString(),
      metadata: {
        toolApprovals: { mode: 'off', approvals: [{ approvalId: 'apr_x' }], source: 'fabric' },
        zipIds: ['zip_a', 'zip_b'],
        agentType: 'cli'
      }
    } as any)

    await settleControlApprovalCard({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      denied: []
    })

    const stored = (await redis.execute(async (client) =>
      client.json.get(`message:${SESSION}:${MESSAGE}`)
    )) as any
    expect(stored.metadata.toolApprovals).toBeNull()
    // `redis.updateMessage` REPLACES metadata; writing only `toolApprovals: null` would
    // have taken every tool card in that turn with it.
    expect(stored.metadata.zipIds).toEqual(['zip_a', 'zip_b'])
    expect(stored.metadata.agentType).toBe('cli')
  })

  it('leaves the card alone on a mixed click, and still writes the denial line', async () => {
    // F-P3-2: the in-place SDK resume has not read this message yet. Clearing the card
    // here would take the SDK's own pending approval with it, and the resume would find
    // nothing to spend.
    await redis.createSession({
      id: SESSION,
      user_id: USER,
      name: SESSION,
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      metadata: {}
    } as any)
    const summary = {
      mode: 'off',
      approvals: [{ approvalId: 'aitxt-still-pending' }],
      source: 'vercel'
    }
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: AGENT,
      role: 'assistant',
      content: 'I need your approval first.',
      created_at: new Date().toISOString(),
      metadata: { toolApprovals: summary }
    } as any)

    await settleControlApprovalCard({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      clearCard: false,
      denied: [
        {
          recordId: 'apr_denied_mixed',
          controlId: 'sys.skill.import',
          controlTitle: 'Skill Import',
          decidedAt: '2026-09-10T14:35:00.000Z'
        }
      ]
    })

    const stored = (await redis.execute(async (client) =>
      client.json.get(`message:${SESSION}:${MESSAGE}`)
    )) as any
    expect(stored.metadata.toolApprovals).toMatchObject(summary)
    expect(buildControlErrorDcmLines([stored])).toEqual([
      'control_errors (the user answered a pending approval):',
      '- Denied by the user: Skill Import — do not retry it.'
    ])
  })

  it('leaves the denial line the agent reads on its next turn', async () => {
    await redis.createSession({
      id: SESSION,
      user_id: USER,
      name: SESSION,
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      metadata: {}
    } as any)
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: AGENT,
      role: 'assistant',
      content: 'I need your approval first.',
      created_at: new Date().toISOString(),
      metadata: { toolApprovals: { mode: 'off', approvals: [], source: 'fabric' } }
    } as any)

    await settleControlApprovalCard({
      userId: USER,
      sessionId: SESSION,
      messageId: MESSAGE,
      denied: [
        {
          recordId: 'apr_denied_1',
          controlId: 'sys.skill.import',
          controlTitle: 'Skill Import',
          decidedAt: '2026-09-10T14:35:00.000Z'
        }
      ]
    })

    const stored = (await redis.execute(async (client) =>
      client.json.get(`message:${SESSION}:${MESSAGE}`)
    )) as any
    const lines = buildControlErrorDcmLines([{ role: 'assistant', metadata: stored.metadata }])
    expect(lines).toEqual([
      'control_errors (the user answered a pending approval):',
      '- Denied by the user: Skill Import — do not retry it.'
    ])
  })
})
