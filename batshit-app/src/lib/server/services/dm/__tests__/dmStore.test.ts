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
