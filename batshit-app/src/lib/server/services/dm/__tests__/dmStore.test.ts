import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  DM_DUPLICATE_WINDOW_MS,
  DM_RETENTION_DAYS,
  DM_SUBJECT_MAX_CHARS,
  MAX_DM_EXPIRES_IN_HOURS,
  MAX_OPEN_DMS_PER_INBOX
} from '$lib/utils/dmControl'
import {
  __resetDmLocksForTests,
  acknowledgeInfoDm,
  claimDm,
  clearDmNeedsUser,
  clearNeedsUserForHumanReply,
  closeDm,
  createDm,
  deleteDmForUser,
  DmStoreError,
  getDm,
  linkResultDm,
  listAllDms,
  listInbox,
  listSent,
  reapExpired,
  reopenDm,
  selectExpiredAssignmentsNeedingResult,
  stampDmDelivery,
  stampDmNeedsUser,
  sweepAgentDms,
  userCloseDm
} from '../dmStore'
import { dmInboxKey, dmSentKey, dmUserIndexKey } from '../dmKeys'
import type { DmRecord } from '$lib/types/dm'

/**
 * SA-113 P2 (DL-113-02) — the DM store.
 *
 * The two rules the team mailbox gets wrong are the ones asserted hardest here: it has no
 * expiry at all, and its "one assignment at a time" lives in a README rather than in code.
 * Both are enforced, and both are tested against the real store rather than a stub.
 */

// F-SEC-1b asserts what the header envelope is told, and that arrives on the user channel.
const publishUserEvent = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent }))

useRedisTestServer()

const USER = 'user-dm-store'
const COOPER = 'agent-cooper'
const FAYE = 'agent-faye'

function sender(agentId = FAYE, name = 'Faye') {
  return { kind: 'agent' as const, agentId, name }
}

async function seedInfo(overrides: Record<string, any> = {}): Promise<DmRecord> {
  return createDm({
    userId: USER,
    from: sender(),
    to: COOPER,
    kind: 'info',
    subject: 'A note',
    body: 'Something you might want to know.',
    deliver: 'wait',
    ...overrides
  })
}

async function seedAssignment(overrides: Record<string, any> = {}): Promise<DmRecord> {
  return createDm({
    userId: USER,
    from: sender(),
    to: COOPER,
    kind: 'assignment',
    subject: 'Verify the package',
    body: 'Run the audit and report what it says.',
    requestedOutcome: 'A pass/fail with the audit output.',
    scope: 'The packaged Mac app only.',
    reportBackTo: FAYE,
    deliver: 'wait',
    ...overrides
  })
}

beforeEach(() => {
  __resetDmLocksForTests()
  publishUserEvent.mockClear()
})

/** The last `dm_inbox_changed` the store published, which is what the badge reads. */
function lastInboxEvent(): Record<string, any> | undefined {
  const calls = publishUserEvent.mock.calls as unknown as Array<[string, Record<string, any>]>
  return calls.filter(([, event]) => event?.type === 'dm_inbox_changed').at(-1)?.[1]
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('creating a DM', () => {
  it('writes the record and all three indexes', async () => {
    const record = await seedInfo()

    expect(await getDm(record.id)).toMatchObject({
      id: record.id,
      to: COOPER,
      kind: 'info',
      status: 'new',
      delivery: { requested: 'wait', actual: 'wait' }
    })
    // The message id equals the record id for a single send; a broadcast shares one.
    expect(record.messageId).toBe(record.id)

    const inbox = await redis.execute(async (client) =>
      client.zRange(dmInboxKey(COOPER), 0, -1)
    )
    const sent = await redis.execute(async (client) => client.zRange(dmSentKey(FAYE), 0, -1))
    const all = await redis.execute(async (client) =>
      client.zRange(dmUserIndexKey(USER), 0, -1)
    )
    expect(inbox).toEqual([record.id])
    expect(sent).toEqual([record.id])
    expect(all).toEqual([record.id])
  })

  it('sorts urgent items ahead of older normal ones', async () => {
    // `dmInboxScore` is `offset + createdTs`, so two normal items written in the SAME
    // millisecond score identically and Redis falls back to ordering by member — a random
    // id. Seeded back to back these three landed in one tick and the assertion below
    // decided the run about half the time. A millisecond apart is what the test means by
    // "older", so say it rather than race for it.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

    const first = await seedInfo({ subject: 'Old and normal' })
    await tick()
    const second = await seedInfo({ subject: 'Newer and urgent', priority: 'urgent' })
    await tick()
    const third = await seedInfo({ subject: 'Newest and normal' })

    const inbox = await listInbox(COOPER)
    expect(inbox.map((record) => record.id)).toEqual([second.id, first.id, third.id])
  })

  it('refuses an agent DMing itself', async () => {
    await expect(seedInfo({ from: sender(COOPER, 'Cooper') })).rejects.toMatchObject({
      code: 'self_send'
    })
  })

  it('refuses an identical DM inside the duplicate window, and allows it after', async () => {
    const first = await seedInfo()
    await expect(seedInfo()).rejects.toMatchObject({ code: 'duplicate' })

    // Age the first one past the window rather than waiting ten real minutes.
    const aged = await getDm(first.id)
    await redis.json.set(`dm:${first.id}`, '$', {
      ...(aged as DmRecord),
      createdTs: Date.now() - DM_DUPLICATE_WINDOW_MS - 1000
    } as never)

    const second = await seedInfo()
    expect(second.id).not.toBe(first.id)
  })

  /**
   * SA-115 F-P1-1 — a schedule is exempt, and it is the one sender kind that has to be.
   *
   * Loop guard 2 catches an agent or a program repeating itself. Repeating itself is
   * exactly what a schedule is FOR: every fire of "every 5 minutes, check the queue"
   * carries the same kind, subject, body, and sender by construction. With the guard
   * applied, any interval under the ten-minute window whose previous DM was still open
   * had its next fire refused — and the floor is five minutes, so a schedule at the
   * lock's own minimum failed every other fire. The P1 live run fired four differently
   * named schedules once each, which is why it could not see this.
   */
  it('SA-115 F-P1-1: a schedule may send the same DM again inside the window', async () => {
    function scheduled(overrides: Record<string, any> = {}) {
      return createDm({
        userId: USER,
        from: { kind: 'schedule' as const, scheduleId: 'sch_abc', name: 'Queue check' },
        to: COOPER,
        kind: 'info',
        subject: 'Queue check',
        body: 'Check the queue and say what is in it.',
        deliver: 'wake',
        ...overrides
      })
    }

    const first = await scheduled()
    // Five minutes later — the lock's minimum interval, well inside the ten-minute window —
    // and the first note is still OPEN because nothing has read it yet.
    const second = await scheduled()
    const third = await scheduled()

    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    expect(await listInbox(COOPER)).toHaveLength(3)
  })

  it('SA-115 F-P1-1: the guard still holds for agents and webhooks', async () => {
    // The exemption is per sender kind, not a hole in the guard. Both other kinds are
    // asserted here so a future "just skip the duplicate check" edit cannot pass.
    await seedInfo()
    await expect(seedInfo()).rejects.toMatchObject({ code: 'duplicate' })

    function fromWebhook() {
      return createDm({
        userId: USER,
        from: { kind: 'webhook' as const, hookId: 'whk_abc', name: 'n8n nightly' },
        to: COOPER,
        kind: 'info',
        subject: 'Nightly',
        body: 'The nightly job finished.',
        deliver: 'wait'
      })
    }
    await fromWebhook()
    await expect(fromWebhook()).rejects.toMatchObject({ code: 'duplicate' })
  })

  it('refuses when the inbox is full', async () => {
    for (let index = 0; index < MAX_OPEN_DMS_PER_INBOX; index += 1) {
      await seedInfo({ subject: `Note ${index}` })
    }
    await expect(seedInfo({ subject: 'One too many' })).rejects.toMatchObject({
      code: 'inbox_full'
    })
  })

  it('requires the assignment fields, and the result fields', async () => {
    await expect(
      createDm({
        userId: USER,
        from: sender(),
        to: COOPER,
        kind: 'assignment',
        subject: 'Missing the rest',
        body: 'No outcome, no scope, nobody to report to.',
        deliver: 'wait'
      })
    ).rejects.toBeInstanceOf(DmStoreError)

    await expect(
      createDm({
        userId: USER,
        from: sender(),
        to: COOPER,
        kind: 'result',
        subject: 'An answer to nothing',
        body: 'Done.',
        deliver: 'wait'
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('refuses an over-long subject rather than truncating it', async () => {
    await expect(
      seedInfo({ subject: 'x'.repeat(DM_SUBJECT_MAX_CHARS + 1) })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('refuses an out-of-range expiry override instead of clamping it', async () => {
    await expect(seedInfo({ expiresInHours: 0 })).rejects.toMatchObject({
      code: 'invalid_expiry'
    })
    await expect(
      seedInfo({ expiresInHours: MAX_DM_EXPIRES_IN_HOURS + 1 })
    ).rejects.toMatchObject({ code: 'invalid_expiry' })
    await expect(seedInfo({ expiresInHours: 2.5 })).rejects.toMatchObject({
      code: 'invalid_expiry'
    })
  })
})

describe('claiming (one assignment at a time — the rule the mailbox only describes)', () => {
  it('claims a new item and records the session', async () => {
    const record = await seedAssignment()
    const claimed = await claimDm({
      dmId: record.id,
      agentId: COOPER,
      sessionId: 'sess-1'
    })
    expect(claimed.status).toBe('working')
    expect(claimed.claimedBy).toEqual({ agentId: COOPER, sessionId: 'sess-1' })
  })

  it('refuses a second assignment while one is in progress', async () => {
    const first = await seedAssignment({ subject: 'First job' })
    const second = await seedAssignment({ subject: 'Second job' })
    await claimDm({ dmId: first.id, agentId: COOPER, sessionId: 'sess-1' })

    await expect(
      claimDm({ dmId: second.id, agentId: COOPER, sessionId: 'sess-2' })
    ).rejects.toMatchObject({ code: 'assignment_in_progress' })
  })

  it('still allows an info item while an assignment is in progress', async () => {
    const assignment = await seedAssignment()
    const note = await seedInfo()
    await claimDm({ dmId: assignment.id, agentId: COOPER, sessionId: 'sess-1' })

    const claimedNote = await claimDm({
      dmId: note.id,
      agentId: COOPER,
      sessionId: 'sess-1'
    })
    expect(claimedNote.status).toBe('working')
  })

  it('lets only ONE of two same-instant claims win', async () => {
    const first = await seedAssignment({ subject: 'First job' })
    const second = await seedAssignment({ subject: 'Second job' })

    const results = await Promise.allSettled([
      claimDm({ dmId: first.id, agentId: COOPER, sessionId: 'sess-1' }),
      claimDm({ dmId: second.id, agentId: COOPER, sessionId: 'sess-2' })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('refuses a claim from anyone but the recipient', async () => {
    const record = await seedAssignment()
    await expect(
      claimDm({ dmId: record.id, agentId: FAYE, sessionId: 'sess-1' })
    ).rejects.toMatchObject({ code: 'not_recipient' })
  })

  it('refuses to re-claim a claimed item', async () => {
    const record = await seedAssignment()
    await claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'sess-1' })
    await expect(
      claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'sess-1' })
    ).rejects.toMatchObject({ code: 'not_claimable' })
  })
})

describe('closing', () => {
  it('requires a real result', async () => {
    const record = await seedAssignment()
    await claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'sess-1' })
    await expect(
      closeDm({ dmId: record.id, agentId: COOPER, status: 'done', result: '   ' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('lets a LATER session finish a claim its own session abandoned', async () => {
    // The team mailbox's real bug: a crashed agent's claim is stuck in `working` forever
    // because only the claiming session may close it. The owner here is the AGENT.
    const record = await seedAssignment()
    await claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'dead-session' })

    const closed = await closeDm({
      dmId: record.id,
      agentId: COOPER,
      status: 'done',
      result: 'Picked this up in a new session and finished it.'
    })
    expect(closed.status).toBe('done')
    expect(closed.completedAt).toBeTruthy()
  })

  it('sets the retention TTL and keeps the item out of the open list', async () => {
    const record = await seedAssignment()
    await claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'sess-1' })
    await closeDm({
      dmId: record.id,
      agentId: COOPER,
      status: 'done',
      result: 'The audit passed.'
    })

    expect(await listInbox(COOPER)).toHaveLength(0)
    expect(await listInbox(COOPER, { includeClosed: true })).toHaveLength(1)
    const ttl = await redis.ttl(`dm:${record.id}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(DM_RETENTION_DAYS * 24 * 60 * 60)
  })

  it('refuses to close a terminal item twice', async () => {
    const record = await seedInfo()
    await acknowledgeInfoDm(record.id, COOPER)
    await expect(
      closeDm({ dmId: record.id, agentId: COOPER, status: 'done', result: 'again' })
    ).rejects.toMatchObject({ code: 'already_closed' })
  })

  it('acknowledges an info item on read, and leaves other kinds alone', async () => {
    const note = await seedInfo()
    const acked = await acknowledgeInfoDm(note.id, COOPER)
    expect(acked.status).toBe('done')

    const assignment = await seedAssignment()
    const untouched = await acknowledgeInfoDm(assignment.id, COOPER)
    expect(untouched.status).toBe('new')
  })
})

describe('expiry — the thing the team mailbox has none of', () => {
  it('marks an overdue open item expired on the next read', async () => {
    const record = await seedInfo()
    await redis.json.set(`dm:${record.id}`, '$', {
      ...((await getDm(record.id)) as DmRecord),
      expiresAt: new Date(Date.now() - 1000).toISOString()
    } as never)

    const open = await listInbox(COOPER)
    expect(open).toHaveLength(0)
    expect((await getDm(record.id))?.status).toBe('expired')
  })

  it('flags an assignment that expired unclaimed as owing its sender a result', async () => {
    const record = await seedAssignment()
    const expired = await reapExpired(
      [{ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }],
      Date.now()
    )
    expect(expired[0].status).toBe('expired')
    expect(selectExpiredAssignmentsNeedingResult(expired)).toHaveLength(1)
  })

  it('does not flag an expired assignment that was claimed, or one already reported', async () => {
    const base = await seedAssignment()
    const claimed = await getDm(base.id)
    const expiredClaimed = {
      ...(claimed as DmRecord),
      status: 'expired' as const,
      claimedBy: { agentId: COOPER, sessionId: 'sess-1' }
    }
    const expiredReported = {
      ...(claimed as DmRecord),
      status: 'expired' as const,
      resultDmId: 'dm_already'
    }
    expect(
      selectExpiredAssignmentsNeedingResult([expiredClaimed, expiredReported])
    ).toHaveLength(0)
  })
})

describe('delivery stamping', () => {
  it('records what actually happened to a wake request', async () => {
    const record = await seedInfo({ deliver: 'wake' })
    await stampDmDelivery(record.id, {
      actual: 'wait',
      reason: 'That agent is mid-task.'
    })
    expect((await getDm(record.id))?.delivery).toMatchObject({
      requested: 'wake',
      actual: 'wait',
      reason: 'That agent is mid-task.'
    })
  })

  it('is a no-op for a DM that no longer exists', async () => {
    await expect(stampDmDelivery('dm_gone', { actual: 'wait' })).resolves.toBeUndefined()
  })
})

describe('F-SEC-1b — telling the user a woken chat is stuck on them', () => {
  it('stamps the DM and puts the count on the inbox event', async () => {
    const record = await seedAssignment({ deliver: 'wake' })
    await claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'sess-woken' })

    await stampDmNeedsUser(record.id, 'This chat is waiting for you to approve a tool.')

    expect((await getDm(record.id))?.delivery.needsUser).toMatchObject({
      reason: 'This chat is waiting for you to approve a tool.'
    })
    // The envelope turns orange on this number, so it has to ride the event the badge reads.
    expect(lastInboxEvent()).toMatchObject({
      type: 'dm_inbox_changed',
      agentId: COOPER,
      needsUserCount: 1
    })
  })

  it('keeps the FIRST holdup rather than restamping a newer time over it', async () => {
    const record = await seedAssignment({ deliver: 'wake' })
    await stampDmNeedsUser(record.id, 'Waiting on a risky control.')
    const first = (await getDm(record.id))?.delivery.needsUser

    await stampDmNeedsUser(record.id, 'Waiting on something else.')

    // The moment the chat stopped needing the agent is the fact worth keeping; a second
    // refusal in the same stuck turn must not move it.
    expect((await getDm(record.id))?.delivery.needsUser).toEqual(first)
  })

  it('clears on a human reply, and the count goes back to zero', async () => {
    const record = await seedAssignment({ deliver: 'wake' })
    await stampDmNeedsUser(record.id, 'Waiting on you.')
    expect(lastInboxEvent()?.needsUserCount).toBe(1)

    await clearDmNeedsUser(record.id)

    expect((await getDm(record.id))?.delivery.needsUser).toBeUndefined()
    expect(lastInboxEvent()?.needsUserCount).toBe(0)
  })

  it('a human reply clears every stamped DM whose woken turn landed in THAT chat, origin or not (F-P5b-1)', async () => {
    // Two stuck DMs for the same agent, woken into two different chats. Neither chat has a
    // session origin: this is the "One at a time" case, where a wake lands in a chat the
    // user started, so a clear keyed on the origin would never fire.
    const stuckHere = await seedAssignment({ deliver: 'wake' })
    await stampDmDelivery(stuckHere.id, { actual: 'wake', sessionId: 'sess-current-chat' })
    await stampDmNeedsUser(stuckHere.id, 'Waiting on you here.')
    const stuckElsewhere = await seedAssignment({ deliver: 'wake', subject: 'Verify the other package' })
    await stampDmDelivery(stuckElsewhere.id, { actual: 'wake', sessionId: 'sess-other-chat' })
    await stampDmNeedsUser(stuckElsewhere.id, 'Waiting on you there.')
    expect(lastInboxEvent()?.needsUserCount).toBe(2)

    const cleared = await clearNeedsUserForHumanReply(COOPER, 'sess-current-chat')

    expect(cleared).toEqual([stuckHere.id])
    expect((await getDm(stuckHere.id))?.delivery.needsUser).toBeUndefined()
    // The other chat's holdup is still real and still shows.
    expect((await getDm(stuckElsewhere.id))?.delivery.needsUser).toBeDefined()
    expect(lastInboxEvent()?.needsUserCount).toBe(1)
    // And an agent with nothing stuck in that chat is a no-op.
    expect(await clearNeedsUserForHumanReply(COOPER, 'sess-current-chat')).toEqual([])
  })

  it('a human reply also ACKNOWLEDGES a wake-delivered info note, instead of leaving it new (F-P2-1)', async () => {
    // The other half of F-P2-1. `finishWokenTurn` now deliberately skips F-P1-2's
    // acknowledge while a DM carries `needsUser`, so the note has to close somewhere else
    // or it goes back to leaking: the holdup ends when the human replies in that chat, and
    // at that moment the note is BOTH delivered (the wake handed it over as the turn's
    // first message) and seen (the human is reading that chat right now).
    //
    // Only for an `info` item whose delivery actually WOKE someone. An assignment is work
    // and still closes by being claimed and closed; a `wait` delivery was never handed to
    // anyone, so the agent still has to read it.
    const note = await seedInfo({ deliver: 'wake' })
    await stampDmDelivery(note.id, { actual: 'wake', sessionId: 'sess-woken-chat' })
    await stampDmNeedsUser(note.id, 'That action needs you.')

    const cleared = await clearNeedsUserForHumanReply(COOPER, 'sess-woken-chat')

    expect(cleared).toEqual([note.id])
    const closed = await getDm(note.id)
    expect(closed?.delivery.needsUser).toBeUndefined()
    expect(closed?.status).toBe('done')
    expect(closed?.result).toBe('Delivered as the first message of a woken turn.')
    expect(lastInboxEvent()?.needsUserCount).toBe(0)
  })

  it('keeps going when a stamped note vanishes MID-loop (F-P2-1)', async () => {
    // The acknowledge THROWS on a missing record where the old `clearDmNeedsUser` was
    // silent, so a DM deleted between the inbox read and this write would otherwise
    // abandon the rest of the loop — one reply silently failing to clear the other
    // holdups it answered.
    //
    // Staging that race needs the record present when `listInbox` reads it and gone by
    // the time the loop reaches it: deleting it up front proves nothing, because
    // `listInbox` prunes a dangling index entry before the loop ever sees it. So the
    // FIRST acknowledge deletes the second record — `acknowledgeInfoDm` announces, and
    // the announce is mocked here.
    const first = await seedInfo({ deliver: 'wake', subject: 'First note' })
    await stampDmDelivery(first.id, { actual: 'wake', sessionId: 'sess-woken-chat' })
    await stampDmNeedsUser(first.id, 'That action needs you.')
    const doomed = await seedInfo({ deliver: 'wake', subject: 'Second note' })
    await stampDmDelivery(doomed.id, { actual: 'wake', sessionId: 'sess-woken-chat' })
    await stampDmNeedsUser(doomed.id, 'That action needs you too.')

    // Inbox order is urgent-first then oldest-first, so rather than guessing which one the
    // loop reaches first, the first announce deletes whichever is still open.
    let deleted: string | null = null
    publishUserEvent.mockImplementation(async () => {
      if (!deleted) {
        for (const id of [first.id, doomed.id]) {
          const record = (await redis.json.get(`dm:${id}`)) as Record<string, any> | null
          if (record?.status === 'new') {
            deleted = id
            await redis.del(`dm:${id}`)
            break
          }
        }
      }
      return undefined
    })

    const cleared = await clearNeedsUserForHumanReply(COOPER, 'sess-woken-chat')

    // Exactly one was cleared: the loop kept going past the vanished record instead of
    // throwing out of it, and the vanished one is not reported as cleared.
    expect(deleted).toBeTruthy()
    expect(cleared).toHaveLength(1)
    expect(cleared).not.toContain(deleted)
    expect((await getDm(cleared[0]))?.status).toBe('done')
  })

  it('a human reply leaves an ASSIGNMENT open — only its stamp is cleared (F-P2-1)', async () => {
    const work = await seedAssignment({ deliver: 'wake' })
    await stampDmDelivery(work.id, { actual: 'wake', sessionId: 'sess-woken-chat' })
    await stampDmNeedsUser(work.id, 'That action needs you.')

    await clearNeedsUserForHumanReply(COOPER, 'sess-woken-chat')

    const still = await getDm(work.id)
    expect(still?.delivery.needsUser).toBeUndefined()
    // Work is claimed and closed by the agent; a reply does not finish it.
    expect(still?.status).toBe('new')
    expect(still?.result).toBeUndefined()
  })

  it('a human reply leaves a WAIT-delivered info note open — nothing delivered it (F-P2-1)', async () => {
    const note = await seedInfo({ deliver: 'wait' })
    await stampDmDelivery(note.id, { actual: 'wait', sessionId: 'sess-woken-chat' })
    await stampDmNeedsUser(note.id, 'That action needs you.')

    await clearNeedsUserForHumanReply(COOPER, 'sess-woken-chat')

    const still = await getDm(note.id)
    expect(still?.delivery.needsUser).toBeUndefined()
    // It is still sitting in the inbox waiting to be read, which is what `wait` means.
    expect(still?.status).toBe('new')
  })

  it('is silent when there is nothing stamped, so every send can call it', async () => {
    const record = await seedInfo()
    publishUserEvent.mockClear()
    await expect(clearDmNeedsUser(record.id)).resolves.toBeUndefined()
    await expect(clearDmNeedsUser('dm_gone')).resolves.toBeUndefined()
    // No stamp means no change, so nothing is announced — this runs on ordinary sends.
    expect(lastInboxEvent()).toBeUndefined()
  })

  it('closing an item drops the stamp with it', async () => {
    const record = await seedAssignment({ deliver: 'wake' })
    await claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'sess-woken' })
    await stampDmNeedsUser(record.id, 'Waiting on you.')

    await closeDm({
      dmId: record.id,
      agentId: COOPER,
      status: 'done',
      result: 'The user approved and the build passed.'
    })

    expect((await getDm(record.id))?.delivery.needsUser).toBeUndefined()
    expect(lastInboxEvent()?.needsUserCount).toBe(0)
  })

  it('reopening starts clean, because the holdup belonged to the previous run', async () => {
    const record = await seedAssignment({ deliver: 'wake' })
    await claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'sess-woken' })
    await stampDmNeedsUser(record.id, 'Waiting on you.')
    await closeDm({ dmId: record.id, agentId: COOPER, status: 'blocked', result: 'Stuck.' })

    const reopened = await reopenDm(USER, record.id)

    expect(reopened.status).toBe('new')
    expect(reopened.delivery.needsUser).toBeUndefined()
  })

  it('an acknowledged info item drops the stamp too', async () => {
    const record = await seedInfo({ deliver: 'wake' })
    await stampDmNeedsUser(record.id, 'Waiting on you.')

    await acknowledgeInfoDm(record.id, COOPER)

    expect((await getDm(record.id))?.delivery.needsUser).toBeUndefined()
  })
})

describe('reads', () => {
  it('drops a dangling index entry left behind by retention', async () => {
    const record = await seedInfo()
    await redis.del(`dm:${record.id}`)

    expect(await listInbox(COOPER)).toHaveLength(0)
    const inbox = await redis.execute(async (client) =>
      client.zRange(dmInboxKey(COOPER), 0, -1)
    )
    expect(inbox).toEqual([])
  })

  it('lists sent items and the all-agents view newest-first', async () => {
    const first = await seedInfo({ subject: 'One' })
    // Two sends can land in the same millisecond, and then neither is "newer". Age the
    // first one so the assertion is about ordering rather than about clock resolution.
    await redis.json.set(`dm:${first.id}`, '$', {
      ...((await getDm(first.id)) as DmRecord),
      createdTs: Date.now() - 60_000
    } as never)
    const second = await seedInfo({ subject: 'Two' })

    expect((await listSent(FAYE)).map((record) => record.id)).toContain(first.id)
    expect((await listAllDms(USER)).map((record) => record.id)).toEqual([
      second.id,
      first.id
    ])
  })

  it('orders two same-millisecond DMs the same way on every read', async () => {
    const a = await seedInfo({ subject: 'Same instant A' })
    const b = await seedInfo({ subject: 'Same instant B' })
    const sameTs = Date.now()
    for (const record of [a, b]) {
      await redis.json.set(`dm:${record.id}`, '$', {
        ...((await getDm(record.id)) as DmRecord),
        createdTs: sameTs
      } as never)
    }

    const first = (await listAllDms(USER)).map((record) => record.id)
    const second = (await listAllDms(USER)).map((record) => record.id)
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
  })
})

describe("the user's own actions (DL-113-10a, the inbox drawer)", () => {
  it('closes an open item and says the user did it', async () => {
    const record = await seedAssignment()
    const closed = await userCloseDm(USER, record.id)
    expect(closed.status).toBe('done')
    expect(closed.result).toBe('Closed by user')
    expect(await listInbox(COOPER)).toHaveLength(0)
  })

  it('refuses to act on another user\'s DM', async () => {
    const record = await seedInfo()
    await expect(userCloseDm('somebody-else', record.id)).rejects.toThrow(DmStoreError)
    await expect(reopenDm('somebody-else', record.id)).rejects.toThrow(DmStoreError)
    await expect(deleteDmForUser('somebody-else', record.id)).rejects.toThrow(DmStoreError)
    expect(await getDm(record.id)).not.toBeNull()
  })

  it('reopens a closed item AND clears the retention TTL that closing set', async () => {
    const record = await seedAssignment()
    await closeDm({ dmId: record.id, agentId: COOPER, status: 'done', result: 'Passed.' })

    // Closing sets a 30-day retention expiry. Reopening without clearing it would leave a
    // "new" DM that silently disappears while the roster still lists it.
    const ttlAfterClose = await redis.ttl(`dm:${record.id}`)
    expect(ttlAfterClose).toBeGreaterThan(0)

    const reopened = await reopenDm(USER, record.id)
    expect(reopened.status).toBe('new')
    expect(reopened.result).toBeUndefined()
    expect(reopened.completedAt).toBeUndefined()
    expect(reopened.claimedBy).toBeUndefined()
    expect(await redis.ttl(`dm:${record.id}`)).toBe(-1)
    expect((await listInbox(COOPER)).map((entry) => entry.id)).toEqual([record.id])
  })

  it('gives a reopened item a fresh window when its old one had already passed', async () => {
    const record = await seedInfo()
    // Age the record rather than the clock: fake timers would stall the real Redis client
    // on the curated lane, and this suite runs on both.
    await redis.json.set(
      `dm:${record.id}`,
      '$.expiresAt',
      new Date(Date.now() - 60_000).toISOString() as never
    )
    const [expired] = await reapExpired([(await getDm(record.id)) as DmRecord])
    expect(expired.status).toBe('expired')

    const reopened = await reopenDm(USER, record.id)
    expect(reopened.status).toBe('new')
    // Otherwise the very next read would expire it again and Reopen would look broken.
    expect(Date.parse(reopened.expiresAt)).toBeGreaterThan(Date.now())
    expect((await listInbox(COOPER)).map((entry) => entry.id)).toEqual([record.id])
  })

  it('deletes the record and every index entry pointing at it', async () => {
    const record = await seedAssignment()
    await deleteDmForUser(USER, record.id)

    expect(await getDm(record.id)).toBeNull()
    expect(await listInbox(COOPER)).toHaveLength(0)
    expect(await listSent(FAYE)).toHaveLength(0)
    expect(await listAllDms(USER)).toHaveLength(0)
    const ids = await redis.execute(async (client) => ({
      inbox: await client.zRange(dmInboxKey(COOPER), 0, -1),
      sent: await client.zRange(dmSentKey(FAYE), 0, -1),
      user: await client.zRange(dmUserIndexKey(USER), 0, -1)
    }))
    expect(ids).toEqual({ inbox: [], sent: [], user: [] })
  })
})

describe('agent deletion (DL-113-02)', () => {
  it('deletes DMs addressed to the agent and both of its indexes', async () => {
    const received = await seedInfo()
    await sweepAgentDms(COOPER)

    expect(await getDm(received.id)).toBeNull()
    expect(await redis.get(dmInboxKey(COOPER))).toBeFalsy()
    expect(await redis.get(dmSentKey(COOPER))).toBeFalsy()
    const all = await redis.execute(async (client) =>
      client.zRange(dmUserIndexKey(USER), 0, -1)
    )
    expect(all).toEqual([])
  })

  it('leaves DMs the deleted agent SENT with their recipients, name frozen', async () => {
    const sent = await createDm({
      userId: USER,
      from: sender(COOPER, 'Cooper'),
      to: FAYE,
      kind: 'info',
      subject: 'From Cooper',
      body: 'Cooper wrote this before being deleted.',
      deliver: 'wait'
    })

    await sweepAgentDms(COOPER)

    const survivor = await getDm(sent.id)
    expect(survivor).not.toBeNull()
    expect(survivor?.from).toMatchObject({ agentId: COOPER, name: 'Cooper' })
    expect((await listInbox(FAYE)).map((record) => record.id)).toEqual([sent.id])
  })
})

/* ------------------------------------------------------------------ *
 * F-P2-3 — the whole-record writers share the recipient's lock
 * ------------------------------------------------------------------ */

describe('F-P2-3 — a late delivery stamp cannot undo a claim', () => {
  it('keeps the claim when a stamp lands in the same tick', async () => {
    const record = await seedAssignment({ deliver: 'wake' })

    // Both of these read the record, wait, and write it back whole. Before F-P2-3 only the
    // claim held the lock, so whichever finished last wrote its stale copy over the other:
    // a wake stamp arriving here reverted `working` to `new`.
    const [claimed] = await Promise.all([
      claimDm({ dmId: record.id, agentId: COOPER, sessionId: 'sess-woken' }),
      stampDmDelivery(record.id, { actual: 'wake', sessionId: 'wake-123' })
    ])

    expect(claimed.status).toBe('working')
    const stored = await getDm(record.id)
    expect(stored?.status).toBe('working')
    expect(stored?.claimedBy).toMatchObject({ agentId: COOPER, sessionId: 'sess-woken' })
    // And the stamp is not lost either — the loser re-reads inside the lock.
    expect(stored?.delivery).toMatchObject({ actual: 'wake', sessionId: 'wake-123' })
  })

  it('keeps the result link when a stamp lands in the same tick', async () => {
    // The real pairing: the agent closes its assignment (which links the result DM) at the
    // same moment the woken turn ends (which stamps the delivery outcome).
    const record = await seedAssignment({ deliver: 'wake' })

    await Promise.all([
      linkResultDm(record.id, 'dm_result_1'),
      stampDmDelivery(record.id, { outcome: 'completed' })
    ])

    const stored = await getDm(record.id)
    expect(stored?.resultDmId).toBe('dm_result_1')
    expect(stored?.delivery).toMatchObject({ outcome: 'completed' })
  })
})

describe('SA-115 — the third sender kind is answered explicitly', () => {
  /**
   * `sameSender`'s trailing `return false` is for an unknown FUTURE kind. It must never be
   * how an existing kind gets its answer — which is what it was doing for `schedule`,
   * making loop guard 2's exemption look like dead code while it was the only thing
   * keeping a five-minute schedule alive. This pins the predicate so the exemption above
   * stays load-bearing.
   */
  it('treats two fires of ONE schedule as the same sender', async () => {
    // Proved through the guard, because that is the only thing `sameSender` feeds: with
    // the exemption removed these would collide, and with it they do not.
    const one = await createDm({
      userId: USER,
      from: { kind: 'schedule' as const, scheduleId: 'sch_same', name: 'Queue check' },
      to: COOPER,
      kind: 'info',
      subject: 'Queue check',
      body: 'Same body.',
      deliver: 'wait'
    })
    const two = await createDm({
      userId: USER,
      from: { kind: 'schedule' as const, scheduleId: 'sch_same', name: 'Queue check' },
      to: COOPER,
      kind: 'info',
      subject: 'Queue check',
      body: 'Same body.',
      deliver: 'wait'
    })
    expect(two.id).not.toBe(one.id)
    const inbox = await listInbox(COOPER)
    expect(inbox.map((record) => record.from.kind)).toEqual(['schedule', 'schedule'])
  })
})
