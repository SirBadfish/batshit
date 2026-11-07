import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ card: null as any, updates: [] as any[] }))
vi.mock('$lib/server/redis', () => ({ redis: {
  execute: vi.fn(async (run: any) => run({ json: { get: async () => store.card } })),
  updateMessage: vi.fn(async (id: string, sessionId: string, patch: any) => { store.updates.push({ id, sessionId, patch }) })
} }))
vi.mock('$lib/server/services/internalRequestAuth', () => ({ internalServiceHeaders: () => ({}) }))

import { CLAUDE_PLAN_OTHER_CONNECTION_REASON, CLAUDE_PLAN_RUN_ENDED_REASON, CLAUDE_PLAN_SWITCHED_AWAY_REASON, claudePlanGoneReason, markClaudePlanCardRunEnded, planClaudePlanClick } from '../claudePlanApprovalClick'
import { claimHeldClaudePlanRun, holdClaudePlanRun, isClaudePlanRunHeld, resetClaudePlanRunRegistryForTests } from '../claudePlanRunRegistry'

/** SA-139 P3 Part 3 review (B M1, S1): what an approval click on a Claude plan card meets. */
const KEY = { sessionId: 's1', replyId: 'r1', version: '0' }
const OWNER = { userId: 'u1', agentId: 'a1' }
const fakeRun = () => {
  const run = { isEnded: false, owner: { userId: 'u1', sessionId: 's1', agentId: 'a1' }, stopped: 0, stop() { this.stopped += 1; this.isEnded = true } }
  return run as any
}
// A Claude plan reply's card (send-routed marks its record, Faye's read S1).
const record = (extra: Record<string, unknown> = {}) => ({
  metadata: { claudePlanReply: true, toolApprovals: { mode: 'ask', approvals: [
    { approvalId: 'ap-1', status: 'pending', toolCall: { toolCallId: 'call-1' } },
    { approvalId: 'ap-2', status: 'pending', toolCall: { toolCallId: 'call-2' } }
  ] }, ...extra }
})
const plan = (rec: unknown, ids: string[], messageId = 'r1', current = true) => planClaudePlanClick({ record: rec, responses: ids.map(approvalId => ({ approvalId })), sessionId: 's1', messageId, current })

afterEach(() => resetClaudePlanRunRegistryForTests())

describe('planClaudePlanClick', () => {
  it('a saved card that spells its call id another way still matches (review A delta neighbour)', () => {
    holdClaudePlanRun(fakeRun(), KEY, Date.now() + 60_000, {}, ['call-9'])
    const rec = { metadata: { claudePlanReply: true, toolApprovals: { approvals: [{ approvalId: 'ap-9', toolCallId: 'call-9' }] } } }
    expect(plan(rec, ['ap-9'])).toEqual({ kind: 'live', key: KEY, toolCallIds: ['call-9'] })
  })

  it('a held run whose card\'s clock ran out (a late timer) is gone, and a claim ends it (review B delta N2)', () => {
    const run = fakeRun()
    holdClaudePlanRun(run, KEY, Date.now() - 1, {}, ['call-1'])
    expect(plan(record(), ['ap-1'])).toEqual({ kind: 'gone', why: 'run_ended' })
    expect(claimHeldClaudePlanRun(KEY, OWNER, ['call-1'])).toBeNull()
    expect(run.stopped).toBe(1)
  })

  it('review B delta M1: a gone run\'s card reads "Expired: the reply ended" (run_ended), and every tab is told', async () => {
    store.card = { id: 'r1', role: 'assistant', session_id: 's1', user_id: 'u1', metadata: { toolApprovals: { mode: 'ask', approvals: [
      { approvalId: 'ap-1', status: 'denied', toolCall: { toolCallId: 'call-1' } }, { approvalId: 'ap-2', status: 'pending' }] }, answeredApprovalIds: ['ap-1'] } }
    store.updates = []
    const posted: any[] = []
    const eventFetch = vi.fn(async (_url: any, init: any) => { posted.push(JSON.parse(init.body)); return new Response('{}') }) as any
    await markClaudePlanCardRunEnded({ sessionId: 's1', userId: 'u1', messageId: 'r1', approvalIds: ['ap-1'], eventFetch, request: new Request('http://localhost/api/messages/send-routed') })
    const approvals = store.updates[0].patch.metadata.toolApprovals.approvals
    expect(approvals[0]).toMatchObject({ approvalId: 'ap-1', status: 'expired', expiryReason: 'run_ended', expiredAt: expect.any(String) })
    expect(approvals[1]).toMatchObject({ approvalId: 'ap-2', status: 'pending' })
    expect(store.updates[0].patch.metadata.answeredApprovalIds).toEqual(['ap-1'])
    expect(posted[0]).toMatchObject({ type: 'complete_message', sessionId: 's1' })
    expect(posted[0].message.metadata.toolApprovals.approvals[0].expiryReason).toBe('run_ended')
  })

  it('a click whose cards the held run waits for is live, and claims that run once', () => {
    const run = fakeRun()
    holdClaudePlanRun(run, KEY, Date.now() + 60_000, {}, ['call-1'])
    const click = plan(record(), ['ap-1'], ' r1 ')
    expect(click).toEqual({ kind: 'live', key: KEY, toolCallIds: ['call-1'] })
    expect(claimHeldClaudePlanRun(KEY, OWNER, ['call-1'])?.run).toBe(run)
    expect(claimHeldClaudePlanRun(KEY, OWNER, ['call-1'])).toBeNull()
  })

  it('a duplicate or stale click for an answered approval claims nothing and leaves the held run (review B M1)', () => {
    const run = fakeRun()
    holdClaudePlanRun(run, { ...KEY, version: '7' }, Date.now() + 60_000, {}, ['call-2'])
    expect(plan(record({ approvalResumeVersion: 7, answeredApprovalIds: ['ap-1'] }), ['ap-1'])).toEqual({ kind: 'already_answered' })
    expect(isClaudePlanRunHeld({ ...KEY, version: '7' })).toBe(true)
    expect(run.stopped).toBe(0)
  })

  it('a click for a card the held run does not wait for finds no run, and the held run stays (review B M1)', () => {
    const run = fakeRun()
    holdClaudePlanRun(run, KEY, Date.now() + 60_000, {}, ['call-2'])
    expect(plan(record(), ['ap-1'])).toEqual({ kind: 'gone', why: 'run_ended' })
    expect(claimHeldClaudePlanRun(KEY, OWNER, ['call-1'])).toBeNull()
    expect(isClaudePlanRunHeld(KEY)).toBe(true)
    expect(run.stopped).toBe(0)
  })

  it('Faye S1: the card\'s own reply decides: an API reply\'s card with the agent elsewhere is not planned (the API lane as before)', () => {
    const apiCard = record({ claudePlanReply: undefined })
    expect(plan(apiCard, ['ap-1'], 'r1', false)).toBeNull()
    expect(plan({ metadata: { claudePlanReply: 'yes', toolApprovals: record().metadata.toolApprovals } }, ['ap-1'], 'r1', false)).toBeNull()
  })

  it('Faye S1: another connection\'s card, clicked with the agent now on the Claude plan, cannot be carried on: gone, with its own reason', () => {
    const apiCard = record({ claudePlanReply: undefined })
    holdClaudePlanRun(fakeRun(), KEY, Date.now() + 60_000, {}, ['call-1'])
    expect(plan(apiCard, ['ap-1'])).toEqual({ kind: 'gone', why: 'other_connection' })
    expect(claudePlanGoneReason('other_connection')).toBe(CLAUDE_PLAN_OTHER_CONNECTION_REASON)
    expect(claudePlanGoneReason('run_ended')).toBe(CLAUDE_PLAN_RUN_ENDED_REASON)
    // A duplicate stays the answer record's refusal, whatever the card's connection.
    expect(plan(record({ claudePlanReply: undefined, answeredApprovalIds: ['ap-1'] }), ['ap-1'])).toEqual({ kind: 'already_answered' })
  })

  it('review A M1: a Claude plan reply\'s card, clicked with the agent now on another connection, cannot resume there: gone, by its own reason (the caller ends the held run)', () => {
    const run = fakeRun()
    holdClaudePlanRun(run, KEY, Date.now() + 60_000, {}, ['call-1'])
    expect(plan(record(), ['ap-1'], 'r1', false)).toEqual({ kind: 'gone', why: 'switched_away' })
    expect(claudePlanGoneReason('switched_away')).toBe(CLAUDE_PLAN_SWITCHED_AWAY_REASON)
    // Planning claims nothing: the held run is the caller's to end.
    expect(isClaudePlanRunHeld(KEY)).toBe(true)
    expect(plan(record({ answeredApprovalIds: ['ap-1'] }), ['ap-1'], 'r1', false)).toEqual({ kind: 'already_answered' })
  })

  it('Faye N1 (review A N1): an entry the page already expired stays as it was, reason or none; the others read "the reply ended"', async () => {
    store.card = { id: 'r1', role: 'assistant', session_id: 's1', user_id: 'u1', metadata: { toolApprovals: { mode: 'ask', approvals: [
      { approvalId: 'ap-1', status: 'expired', expiryReason: 'unanswered', expiredAt: 't0' }, { approvalId: 'ap-2', status: 'approved' },
      { approvalId: 'ap-3', status: 'expired', expiredAt: 't1' }] } } }
    store.updates = []
    const eventFetch = vi.fn(async () => new Response('{}')) as any
    await markClaudePlanCardRunEnded({ sessionId: 's1', userId: 'u1', messageId: 'r1', approvalIds: ['ap-1', 'ap-2', 'ap-3'], eventFetch, request: new Request('http://localhost/api/messages/send-routed') })
    const approvals = store.updates[0].patch.metadata.toolApprovals.approvals
    expect(approvals[0]).toMatchObject({ status: 'expired', expiryReason: 'unanswered', expiredAt: 't0' })
    expect(approvals[1]).toMatchObject({ status: 'expired', expiryReason: 'run_ended' })
    // An API-lane card the page expired names no reason ("Expired (3m)"), and keeps none.
    expect(approvals[2]).toMatchObject({ status: 'expired', expiredAt: 't1' })
    expect(approvals[2].expiryReason).toBeUndefined()
  })

  it('no held run, another version, or a card with no tool call id: gone (answered as not run, nothing runs)', () => {
    expect(plan(record(), ['ap-1'])).toEqual({ kind: 'gone', why: 'run_ended' })
    holdClaudePlanRun(fakeRun(), { ...KEY, version: '3' }, Date.now() + 60_000, {}, ['call-1'])
    expect(plan(record(), ['ap-1'])).toEqual({ kind: 'gone', why: 'run_ended' })
    expect(plan(record(), ['ap-unknown'])).toEqual({ kind: 'gone', why: 'run_ended' })
    expect(CLAUDE_PLAN_RUN_ENDED_REASON).toMatch(/nothing ran/)
  })
})
