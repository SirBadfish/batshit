import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  composeInPlaceResumeMessage,
  hasUserTurnContent,
  isInPlaceApprovalResume,
  joinResumedContent,
  mergeResumedMetadata,
  mergeResumedSteps,
  readStoredAssistantRecord,
  resolveFailedTurnContent
} from '../approvalResumeMessage'

/**
 * An API-lane approval resume writes into the message the card was ON, and its stream starts
 * empty. Measured live on 2026-09-18 (`_local/approval-resume-proof/words-before-card*.json`):
 * "Checking with the shell now." before the card became
 * `{{batshit-zip:…bash: expr 8675309 + 1…}}**8675310**` after the click — the words were gone,
 * on the old code as well as the new. These pin the rule that fixes it: what a resume writes
 * is APPENDED to what the message held.
 *
 * Real RedisJSON under `npm run test:redis`, the in-memory fake under plain `npm test`.
 */

useRedisTestServer()

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'user-approval-resume'
const SESSION = 'session-approval-resume'
const MESSAGE = 'msg_card'
const EARLIER_ZIP = 'cool_tool_1789712000000_early'
const RESUMED_ZIP = 'cool_tool_1789712566257_rp4al'
const earlierRef = `{{batshit-zip:${EARLIER_ZIP}:::bash: ls - exit 0 - 3 lines}}`
const resumedRef = `{{batshit-zip:${RESUMED_ZIP}:::bash: expr 8675309 + 1 - exit 0 - 1 line}}`

describe('joinResumedContent', () => {
  it('keeps the words before the card and puts the resumed reply after a blank line', () => {
    expect(joinResumedContent('Checking with the shell now.', `${resumedRef}**8675310**`)).toBe(
      `Checking with the shell now.\n\n${resumedRef}**8675310**`
    )
  })

  it('keeps an earlier tool card too', () => {
    expect(joinResumedContent(`Looking first.\n\n${earlierRef}\n\nNow the sum.`, `${resumedRef}8675310`)).toBe(
      `Looking first.\n\n${earlierRef}\n\nNow the sum.\n\n${resumedRef}8675310`
    )
  })

  it('changes nothing when the card had no words before it', () => {
    expect(joinResumedContent('', `${resumedRef}8675310`)).toBe(`${resumedRef}8675310`)
    expect(joinResumedContent(undefined, `${resumedRef}8675310`)).toBe(`${resumedRef}8675310`)
  })

  it('keeps the words when the resume produced nothing', () => {
    expect(joinResumedContent('Checking with the shell now.', '')).toBe('Checking with the shell now.')
    expect(joinResumedContent('Checking with the shell now.', '  \n')).toBe('Checking with the shell now.')
  })

  it('does not double words a resume replays', () => {
    const replayed = `Checking with the shell now.\n\n${resumedRef}8675310`
    expect(joinResumedContent('Checking with the shell now.', replayed)).toBe(replayed)
  })
})

describe('mergeResumedMetadata', () => {
  it('unions the zip allow-list, zip references, image zips, and steers, earlier first', () => {
    const merged = mergeResumedMetadata(
      {
        zipIds: [EARLIER_ZIP],
        zipReferences: [{ zipId: EARLIER_ZIP, reference: earlierRef }],
        imageZipIds: ['img_early', 'img_shared'],
        steers: [
          { steerId: 'steer_1', text: 'use ls first' },
          { steerId: 'steer_shared', text: 'keep it short' }
        ],
        toolApprovals: { approvals: [{ approvalId: 'aitxt-1', status: 'pending' }] }
      },
      {
        zipIds: [RESUMED_ZIP],
        zipReferences: [{ zipId: RESUMED_ZIP, reference: resumedRef }],
        imageZipIds: ['img_shared', 'img_late'],
        steers: [
          { steerId: 'steer_shared', text: 'keep it short' },
          { steerId: 'steer_2', text: 'then add' }
        ],
        toolApprovals: null,
        model: 'claude-sonnet-4-6'
      }
    )

    expect(merged.zipIds).toEqual([EARLIER_ZIP, RESUMED_ZIP])
    expect(merged.zipReferences).toEqual([
      { zipId: EARLIER_ZIP, reference: earlierRef },
      { zipId: RESUMED_ZIP, reference: resumedRef }
    ])
    // Each list keeps what came earlier, adds what is new, and holds a shared entry once.
    expect(merged.imageZipIds).toEqual(['img_early', 'img_shared', 'img_late'])
    expect(merged.steers.map((steer: any) => steer.steerId)).toEqual(['steer_1', 'steer_shared', 'steer_2'])
    // Everything else is the resume's, exactly as before: the spent card is cleared.
    expect(merged.toolApprovals).toBeNull()
    expect(merged.model).toBe('claude-sonnet-4-6')
  })

  it('adds no empty lists and keeps the resume\'s own when nothing came earlier', () => {
    const merged = mergeResumedMetadata(undefined, { zipIds: [RESUMED_ZIP], toolApprovals: null })
    expect(merged).toEqual({ zipIds: [RESUMED_ZIP], toolApprovals: null })
    expect(mergeResumedMetadata({}, { toolApprovals: null })).toEqual({ toolApprovals: null })
  })
})

describe('mergeResumedSteps', () => {
  it('keeps the earlier steps before the resumed ones, and stays undefined when there are none', () => {
    expect(mergeResumedSteps([{ tool: 'ls' }], [{ tool: 'expr' }])).toEqual([{ tool: 'ls' }, { tool: 'expr' }])
    expect(mergeResumedSteps(undefined, [{ tool: 'expr' }])).toEqual([{ tool: 'expr' }])
    expect(mergeResumedSteps([{ tool: 'ls' }], undefined)).toEqual([{ tool: 'ls' }])
    expect(mergeResumedSteps(undefined, [])).toBeUndefined()
  })
})

describe('resolveFailedTurnContent', () => {
  it('stores the error line for an ordinary failed turn', () => {
    expect(
      resolveFailedTurnContent({ inPlaceResume: false, errorText: 'Provider down', prior: { content: 'Earlier words' } })
    ).toBe('Provider down')
  })

  it('keeps the words a resumed message already held; the failure rides the metadata', () => {
    expect(
      resolveFailedTurnContent({
        inPlaceResume: true,
        errorText: 'Provider down',
        prior: { role: 'assistant', content: 'Checking with the shell now.' }
      })
    ).toBe('Checking with the shell now.')
  })

  it('falls back to the error line when a resumed message held nothing', () => {
    expect(resolveFailedTurnContent({ inPlaceResume: true, errorText: 'Provider down', prior: null })).toBe(
      'Provider down'
    )
    expect(
      resolveFailedTurnContent({ inPlaceResume: true, errorText: 'Provider down', prior: { content: '   ' } })
    ).toBe('Provider down')
  })
})

describe('isInPlaceApprovalResume', () => {
  it('is the stream handler\'s rule: approval responses and no user turn', () => {
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: '', controlResumeContent: null })).toBe(true)
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: '   ', controlResumeContent: null })).toBe(true)
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: null, controlResumeContent: null })).toBe(true)
  })

  it('is not a resume without responses, with a user turn, or for a CLI control resume', () => {
    expect(isInPlaceApprovalResume({ approvalResponseCount: 0, content: '', controlResumeContent: null })).toBe(false)
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: 'next question', controlResumeContent: null })).toBe(false)
    expect(isInPlaceApprovalResume({ approvalResponseCount: 1, content: [{ type: 'text' }], controlResumeContent: null })).toBe(false)
    expect(
      isInPlaceApprovalResume({ approvalResponseCount: 1, content: '', controlResumeContent: '[Approval — from the user]' })
    ).toBe(false)
  })

  it('reads a user turn the way the stream handler does', () => {
    expect(hasUserTurnContent('')).toBe(false)
    expect(hasUserTurnContent('  ')).toBe(false)
    expect(hasUserTurnContent(null)).toBe(false)
    expect(hasUserTurnContent([])).toBe(false)
    expect(hasUserTurnContent('hi')).toBe(true)
    expect(hasUserTurnContent([{ type: 'text', text: 'hi' }])).toBe(true)
    expect(hasUserTurnContent({ type: 'text' })).toBe(true)
  })
})

describe('the resumed message as Redis stores it', () => {
  async function storeCardMessage() {
    await redis.createSession({ id: SESSION, user_id: USER, name: SESSION, agent_id: 'agent-1' } as any)
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: 'agent-1',
      role: 'assistant',
      content: `Checking with the shell now.\n\n${earlierRef}`,
      created_at: '2026-09-18T06:22:00.000Z',
      intermediateSteps: [{ tool: 'native_bash_execute', toolArgs: { command: 'ls' } }],
      metadata: {
        zipIds: [EARLIER_ZIP],
        zipReferences: [{ zipId: EARLIER_ZIP, reference: earlierRef }],
        toolApprovals: { mode: 'all', approvals: [{ approvalId: 'aitxt-1', status: 'pending' }], source: 'vercel' },
        agentType: 'api'
      }
    } as any)
  }

  const resumedWrite = {
    content: `${resumedRef}**8675310**`,
    metadata: {
      zipIds: [RESUMED_ZIP],
      zipReferences: [{ zipId: RESUMED_ZIP, reference: resumedRef }],
      toolApprovals: null,
      model: 'claude-sonnet-4-6'
    },
    intermediateSteps: [{ tool: 'native_bash_execute', toolArgs: { command: 'expr 8675309 + 1' } }]
  }

  async function stored() {
    return (await redis.execute(async (client) => client.json.get(`message:${SESSION}:${MESSAGE}`))) as any
  }

  it('is WHY the rule exists: saving the resume alone replaces the words and the allow-list', async () => {
    await storeCardMessage()
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: 'agent-1',
      role: 'assistant',
      created_at: '2026-09-18T06:22:05.000Z',
      ...resumedWrite
    } as any)

    const record = await stored()
    expect(record.content).not.toContain('Checking with the shell now.')
    expect(record.metadata.zipIds).toEqual([RESUMED_ZIP])
  })

  it('keeps the words, the earlier tool card, its allow-list entry, and its step once composed', async () => {
    await storeCardMessage()
    const prior = await readStoredAssistantRecord(SESSION, MESSAGE)
    expect(prior?.content).toBe(`Checking with the shell now.\n\n${earlierRef}`)

    const continued = composeInPlaceResumeMessage(prior!, resumedWrite)
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: 'agent-1',
      role: 'assistant',
      created_at: '2026-09-18T06:22:05.000Z',
      ...continued
    } as any)

    const record = await stored()
    expect(record.content).toBe(`Checking with the shell now.\n\n${earlierRef}\n\n${resumedRef}**8675310**`)
    expect(record.metadata.zipIds).toEqual([EARLIER_ZIP, RESUMED_ZIP])
    expect(record.metadata.zipReferences.map((ref: any) => ref.zipId)).toEqual([EARLIER_ZIP, RESUMED_ZIP])
    expect(record.intermediateSteps.map((step: any) => step.toolArgs.command)).toEqual(['ls', 'expr 8675309 + 1'])
    // The spent card is still cleared.
    expect(record.metadata.toolApprovals).toBeNull()
  })

  // Real `saveMessage` merges metadata shallowly, so what the resume does not mention stays.
  // The default lane's fake REPLACES the whole record, so this claim is real-Redis only.
  it.runIf(REAL_REDIS_LANE)('leaves the rest of the stored metadata alone (real RedisJSON merge)', async () => {
    await storeCardMessage()
    const prior = await readStoredAssistantRecord(SESSION, MESSAGE)
    await redis.saveMessage({
      id: MESSAGE,
      session_id: SESSION,
      user_id: USER,
      agent_id: 'agent-1',
      role: 'assistant',
      created_at: '2026-09-18T06:22:05.000Z',
      ...composeInPlaceResumeMessage(prior!, resumedWrite)
    } as any)

    const record = await stored()
    expect(record.metadata.agentType).toBe('api')
    expect(record.metadata.model).toBe('claude-sonnet-4-6')
  })

  it('reads only an assistant record', async () => {
    await storeCardMessage()
    expect(await readStoredAssistantRecord(SESSION, 'msg_missing')).toBeNull()
    await redis.saveMessage({
      id: 'msg_user',
      session_id: SESSION,
      user_id: USER,
      role: 'user',
      content: 'Run it',
      created_at: '2026-09-18T06:21:00.000Z',
      metadata: {}
    } as any)
    expect(await readStoredAssistantRecord(SESSION, 'msg_user')).toBeNull()
  })
})
