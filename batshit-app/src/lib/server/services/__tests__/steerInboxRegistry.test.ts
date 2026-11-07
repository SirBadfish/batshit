import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSteerInbox,
  clearSteerRun,
  countPendingSteers,
  drainDeliveredSteers,
  enqueueSteer,
  getSteerRun,
  listPendingSteers,
  refileUndeliveredSteers,
  registerSteerRun,
  takeMissedDmSteers,
  takeMissedUserSteers,
  takePendingSteersForDelivery,
  takeUndeliveredSteers,
  __resetSteerInboxRegistryForTests
} from '$lib/server/services/steerInboxRegistry'
import { MAX_PENDING_STEERS, type SteerEntry } from '$lib/utils/steerControl'
import * as streamAbortRegistry from '$lib/server/services/streamAbortRegistry'

/**
 * SA-114 P1 (DL-114-02) — the steer inbox.
 *
 * The behavioural tests are ordinary. The two that matter most are at the bottom: this
 * module must never touch the session-turn lock, and a delivered steer must leave the
 * once-per-accepted-send boundary (clips, `active_clips`, the memory linger commit)
 * untouched — those are the SA-109/SA-110 invariants a steer rides INSIDE.
 */

const SESSION = 'session-steer'
const MESSAGE = 'msg_assistant_1'

const entry = (steerId: string, overrides: Partial<SteerEntry> = {}): SteerEntry => ({
  steerId,
  messageId: MESSAGE,
  text: `steer ${steerId}`,
  at: '2026-09-10T12:00:00.000Z',
  source: 'user',
  ...overrides
})

beforeEach(() => {
  __resetSteerInboxRegistryForTests()
})

afterEach(() => {
  __resetSteerInboxRegistryForTests()
  vi.restoreAllMocks()
})

describe('steer inbox', () => {
  it('accepts steers and reports what is waiting', () => {
    expect(enqueueSteer(SESSION, entry('a'))).toEqual({ ok: true, pending: 1 })
    expect(enqueueSteer(SESSION, entry('b'))).toEqual({ ok: true, pending: 2 })
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['a', 'b'])
    expect(countPendingSteers(SESSION, MESSAGE)).toBe(2)
    expect(countPendingSteers(SESSION, 'some-other-message')).toBe(0)
  })

  it(`refuses a ${MAX_PENDING_STEERS + 1}th waiting steer with a reason`, () => {
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) {
      expect(enqueueSteer(SESSION, entry(`s${i}`)).ok).toBe(true)
    }
    const refused = enqueueSteer(SESSION, entry('overflow'))
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected a refusal')
    expect(refused.code).toBe('steer_inbox_full')
    expect(refused.reason).toContain('Wait for the reply')
    expect(listPendingSteers(SESSION)).toHaveLength(MAX_PENDING_STEERS)
  })

  it('frees a slot once a steer has reached the model, so a long reply is not locked out', () => {
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) {
      enqueueSteer(SESSION, entry(`s${i}`))
    }
    expect(enqueueSteer(SESSION, entry('blocked')).ok).toBe(false)

    takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })
    expect(enqueueSteer(SESSION, entry('after-delivery')).ok).toBe(true)
  })

  it('takes and marks delivered in one step, in acceptance order', () => {
    enqueueSteer(SESSION, entry('first'))
    enqueueSteer(SESSION, entry('second'))

    const delivered = takePendingSteersForDelivery(SESSION, MESSAGE, {
      step: 2,
      lane: 'api'
    })
    expect(delivered.map((row) => row.steerId)).toEqual(['first', 'second'])
    expect(delivered.every((row) => row.step === 2 && row.lane === 'api')).toBe(true)
    // Nothing is left pending, and nothing is in two lists at once.
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  it('drains delivered steers exactly once', () => {
    enqueueSteer(SESSION, entry('a'))
    takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })

    expect(drainDeliveredSteers(SESSION, MESSAGE).map((row) => row.steerId)).toEqual(['a'])
    expect(drainDeliveredSteers(SESSION, MESSAGE)).toEqual([])
  })

  it('never hands a steer to a different turn, including a promoted follow-up', () => {
    enqueueSteer(SESSION, entry('for-first-turn'))

    expect(
      takePendingSteersForDelivery(SESSION, 'msg_assistant_2', { step: 1, lane: 'api' })
    ).toEqual([])
    expect(takeUndeliveredSteers(SESSION, 'msg_assistant_2')).toEqual([])
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['for-first-turn'])

    expect(takeUndeliveredSteers(SESSION, MESSAGE).map((row) => row.steerId)).toEqual([
      'for-first-turn'
    ])
  })

  it('keeps sessions apart', () => {
    enqueueSteer(SESSION, entry('mine'))
    enqueueSteer('other-session', entry('theirs'))

    clearSteerInbox(SESSION)
    expect(listPendingSteers(SESSION)).toEqual([])
    expect(listPendingSteers('other-session').map((row) => row.steerId)).toEqual(['theirs'])
  })

  it('prunes an inbox left behind by a turn that never unwound', () => {
    const sixHoursAgo = Date.now() - 7 * 60 * 60 * 1000
    enqueueSteer(SESSION, entry('stale'), sixHoursAgo)
    expect(listPendingSteers(SESSION)).toHaveLength(1)

    // The prune runs on the next accept, which is the only path that can grow the map.
    enqueueSteer('another-session', entry('fresh'))
    expect(listPendingSteers(SESSION)).toEqual([])
  })

  /**
   * DL-114-02, the load-bearing one: this module is a SEPARATE map, and a steer must not be
   * able to reach the 409 interlock. `streamAbortRegistry` has no per-turn payload slot,
   * which is exactly why the inbox is its own module rather than a fourth map inside it.
   */
  it('never touches the session-turn lock or the stream abort registry', () => {
    const spies = [
      'registerSessionTurn',
      'clearSessionTurn',
      'registerStreamAbort',
      'clearStreamAbort',
      'abortStream',
      'registerGroupAbort',
      'abortGroupChat'
    ].map((name) =>
      vi.spyOn(streamAbortRegistry, name as keyof typeof streamAbortRegistry)
    )

    enqueueSteer(SESSION, entry('a'))
    takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })
    drainDeliveredSteers(SESSION, MESSAGE)
    enqueueSteer(SESSION, entry('b'))
    refileUndeliveredSteers(SESSION, MESSAGE, 'msg_assistant_2')
    takeMissedUserSteers(SESSION, { keepMessageId: MESSAGE })
    enqueueSteer(SESSION, entry('dm', { source: 'dm' }))
    takeMissedDmSteers(SESSION)
    registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'api' })
    clearSteerRun(SESSION, MESSAGE)
    enqueueSteer(SESSION, entry('c'))
    takeUndeliveredSteers(SESSION, MESSAGE)
    clearSteerInbox(SESSION)

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  /**
   * F-P1-3 (Faye's review): the marker must land after the WHOLE step the model read the
   * steer at, and the loop can lag the SDK by more than that step's tool chunks. So the
   * drain is gated on the number of `finish-step` chunks the loop has consumed, not on
   * the type of the chunk in hand; the finish path forces everything out.
   */
  it('drains only the steers whose step the loop has consumed, unless forced', () => {
    enqueueSteer(SESSION, entry('early'))
    takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })
    enqueueSteer(SESSION, entry('late'))
    takePendingSteersForDelivery(SESSION, MESSAGE, { step: 3, lane: 'api' })

    expect(drainDeliveredSteers(SESSION, MESSAGE, { upToStep: 0 })).toEqual([])
    expect(
      drainDeliveredSteers(SESSION, MESSAGE, { upToStep: 1 }).map((row) => row.steerId)
    ).toEqual(['early'])
    expect(drainDeliveredSteers(SESSION, MESSAGE, { upToStep: 2 })).toEqual([])
    // No bound: the finish path takes whatever is left.
    expect(drainDeliveredSteers(SESSION, MESSAGE).map((row) => row.steerId)).toEqual(['late'])
    expect(drainDeliveredSteers(SESSION, MESSAGE)).toEqual([])
  })

  /**
   * F-P1-1 (Faye's review): the same window SA-113 F-P1-1 closed for the session-turn
   * lock. A turn stopped during setup unwinds its `finally` AFTER a retry has started a
   * new turn and accepted steers for it; an unscoped clear would wipe that live turn's
   * mail and the 202 the route already answered would be a lie.
   */
  it('keeps a live turn’s steers when a finished request clears the inbox', () => {
    enqueueSteer(SESSION, entry('stopped-turn', { messageId: 'msg_stopped' }))
    // The live turn has one steer already handed to the model and one still waiting.
    enqueueSteer(SESSION, entry('live-delivered', { messageId: 'msg_live' }))
    takePendingSteersForDelivery(SESSION, 'msg_live', { step: 1, lane: 'api' })
    enqueueSteer(SESSION, entry('live-waiting', { messageId: 'msg_live' }))

    clearSteerInbox(SESSION, { keepMessageId: 'msg_live' })

    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['live-waiting'])
    expect(drainDeliveredSteers(SESSION, 'msg_live').map((row) => row.steerId)).toEqual([
      'live-delivered'
    ])
    expect(takeUndeliveredSteers(SESSION, 'msg_stopped')).toEqual([])

    // With nothing to keep, everything goes.
    enqueueSteer(SESSION, entry('gone', { messageId: 'msg_live' }))
    clearSteerInbox(SESSION)
    expect(listPendingSteers(SESSION)).toEqual([])
  })

  /**
   * The other half of DL-114-02: the whole module imports nothing that could reach clip
   * consumption or the memory linger commit. A static check is the honest one here — a
   * behavioural test would only prove that the functions this suite happened to call did
   * not, while the import list proves it for every path.
   */
  it('imports nothing that could consume clips or commit memory linger', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/server/services/steerInboxRegistry.ts'),
      'utf8'
    )
    const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map(
      (match) => match[1]
    )
    expect(imports).toEqual(['$lib/utils/steerControl'])

    // Comments name these on purpose — it is the CODE that must not reach them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('consumePostCompileSessionClips')
    expect(code).not.toContain('commitMemoryTurnState')
    expect(code).not.toContain('active_clips')
    expect(code).not.toContain('registerSessionTurn')
  })

  it('PR #106 F-10: the cap counts the messages waiting for THIS reply, not the whole chat', () => {
    for (let index = 0; index < MAX_PENDING_STEERS; index += 1) {
      expect(enqueueSteer(SESSION, entry(`dead_${index}`, { messageId: 'msg_stopped' })).ok).toBe(true)
    }
    // A stopped turn's entries are still in the inbox in the overlap window; the live turn's
    // first steer must not be refused on their account.
    const live = enqueueSteer(SESSION, entry('live', { messageId: 'msg_live' }))
    expect(live.ok).toBe(true)
  })
})

/**
 * SA-139 R4: the run PULLS at its next step (`prepareStep`); the managed CLI Primary, the one
 * run the route pushed to, is gone, so a registration carries the verdict and nothing else.
 */
describe('the steer run registration (P2, DL-114-09)', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    messageId: MESSAGE,
    steerable: true,
    reason: null,
    lane: 'api' as const,
    ...overrides
  })

  it('records the verdict', () => {
    registerSteerRun(SESSION, run())
    expect(getSteerRun(SESSION)).toEqual(run())
  })

  it('clears only its own registration', () => {
    registerSteerRun(SESSION, run())
    clearSteerRun(SESSION, 'msg_other')
    expect(getSteerRun(SESSION)).not.toBeNull()
    clearSteerRun(SESSION, MESSAGE)
    expect(getSteerRun(SESSION)).toBeNull()
  })
})

/**
 * SA-114 P4 (DL-114-13) — the DM half.
 *
 * Two rules, both about the fact that the words are another agent's and not the user's:
 * one may wait for a reply at a time, and it is never promoted into a message from the
 * user — so it has to survive the promotion loop and be readable at the end of the request.
 */
describe('DM-sourced steers (DL-114-13)', () => {
  const dmEntry = (steerId: string, overrides: Partial<SteerEntry> = {}): SteerEntry =>
    entry(steerId, { source: 'dm', dmId: steerId, label: 'Faye', ...overrides })

  it('holds one waiting DM steer per reply and refuses the second with its own code', () => {
    expect(enqueueSteer(SESSION, dmEntry('dm_1')).ok).toBe(true)

    const second = enqueueSteer(SESSION, dmEntry('dm_2'))
    expect(second).toMatchObject({ ok: false, code: 'steer_dm_pending' })
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['dm_1'])
  })

  it('a waiting user steer does not block a DM steer', () => {
    // The rule counts waiting DM entries, not waiting entries. Dropping the `source` check
    // inside it reads as "one message per reply" and would refuse an agent's note purely
    // because the person had typed one first — which is the opposite of what it is for.
    expect(enqueueSteer(SESSION, entry('user_1')).ok).toBe(true)
    expect(enqueueSteer(SESSION, dmEntry('dm_1')).ok).toBe(true)
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['user_1', 'dm_1'])
  })

  it('lets a user steer in beside a waiting DM steer', () => {
    // The rule is about AGENT notes crowding a reply, not about the inbox being full. The
    // person typing keeps every one of the five slots.
    expect(enqueueSteer(SESSION, dmEntry('dm_1')).ok).toBe(true)
    expect(enqueueSteer(SESSION, entry('user_1')).ok).toBe(true)
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['dm_1', 'user_1'])
  })

  it('frees the slot once the waiting DM steer has reached the model', () => {
    enqueueSteer(SESSION, dmEntry('dm_1'))
    takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })

    // Delivered is not waiting: a long tool-heavy reply is not limited to one DM for its
    // whole length, the same reasoning `MAX_PENDING_STEERS` uses.
    expect(enqueueSteer(SESSION, dmEntry('dm_2')).ok).toBe(true)
  })

  it('a DM steer on another reply does not block this one', () => {
    enqueueSteer(SESSION, dmEntry('dm_old', { messageId: 'msg_assistant_0' }))
    expect(enqueueSteer(SESSION, dmEntry('dm_new')).ok).toBe(true)
  })

  it('leaves DM steers behind when the promotion loop takes the user\'s', () => {
    enqueueSteer(SESSION, dmEntry('dm_1'))
    enqueueSteer(SESSION, entry('user_1'))

    const promotable = takeUndeliveredSteers(SESSION, MESSAGE, { source: 'user' })
    expect(promotable.map((row) => row.steerId)).toEqual(['user_1'])
    // P1 took everything and filtered afterwards, which removed the DM entry from the only
    // place the end-of-request degrade could have found it.
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['dm_1'])
  })

  it('hands the end of the request every DM steer the clear is about to delete', () => {
    enqueueSteer(SESSION, dmEntry('dm_live', { messageId: 'msg_live' }))
    enqueueSteer(SESSION, dmEntry('dm_done'))
    enqueueSteer(SESSION, entry('user_done'))

    // Same `keepMessageId` the clear beside it uses, so it degrades exactly what that clear
    // is about to remove and never a live turn's mail.
    const missed = takeMissedDmSteers(SESSION, { keepMessageId: 'msg_live' })
    expect(missed.map((row) => row.steerId)).toEqual(['dm_done'])
    expect(missed[0].dmId).toBe('dm_done')
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual([
      'dm_live',
      'user_done'
    ])
  })

  it('never takes a user steer, whatever the clear is about to do', () => {
    enqueueSteer(SESSION, entry('user_1'))
    expect(takeMissedDmSteers(SESSION)).toEqual([])
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['user_1'])
  })
})

/**
 * SA-119 P1 (DL-119-05) — Queue, held by the server.
 *
 * A queued message is an ordinary steer with one extra field: `deliver: 'end'`. It rides
 * every path a steer rides — the cap, the Stop drop, the end-of-turn promotion — and is
 * refused exactly one of them: **it is never handed to a transport at a tool boundary.**
 * That single skip is what makes "send it when you finish" different from "steer", and it
 * has to hold on all three lanes, because a held entry injected mid-reply is the user's
 * next message arriving inside the answer it was meant to follow.
 */
describe('a queued steer (deliver: end) — DL-119-05', () => {
  const queued = (steerId: string, overrides: Partial<SteerEntry> = {}): SteerEntry =>
    entry(steerId, { deliver: 'end', ...overrides })

  it('is accepted and waits like any other steer', () => {
    expect(enqueueSteer(SESSION, queued('q1'))).toEqual({ ok: true, pending: 1 })
    expect(listPendingSteers(SESSION).map((row) => [row.steerId, row.deliver])).toEqual([
      ['q1', 'end']
    ])
  })

  it('is never taken by the API lane’s boundary hook (DL-119-05)', () => {
    enqueueSteer(SESSION, queued('q1'))
    enqueueSteer(SESSION, entry('now1'))

    const delivered = takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })
    expect(delivered.map((row) => row.steerId)).toEqual(['now1'])
    // Still waiting, untouched, for the end of the turn to promote.
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['q1'])
  })

  it('is not handed over when it is the only message waiting', () => {
    enqueueSteer(SESSION, queued('q1'))

    // Nothing is handed over, so nothing can reach the model mid-reply.
    expect(takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })).toEqual([])
    expect(drainDeliveredSteers(SESSION, MESSAGE)).toEqual([])
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['q1'])
  })

  it('counts against the cap like any other waiting message (DL-119-05)', () => {
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) {
      expect(enqueueSteer(SESSION, queued(`q${i}`)).ok).toBe(true)
    }
    const refused = enqueueSteer(SESSION, entry('overflow'))
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected a refusal')
    expect(refused.code).toBe('steer_inbox_full')
    expect(countPendingSteers(SESSION, MESSAGE)).toBe(MAX_PENDING_STEERS)
  })

  /**
   * The order the user typed in, not the order the transport happened to leave things in.
   * Two queued messages and one steer that never found a boundary become ONE next message,
   * and the user has to be able to read it back as the conversation they had.
   */
  it('is promoted with everything else still pending, in acceptance order', () => {
    enqueueSteer(SESSION, queued('q1', { at: '2026-09-13T10:00:00.000Z' }))
    enqueueSteer(SESSION, queued('q2', { at: '2026-09-13T10:00:01.000Z' }))
    enqueueSteer(SESSION, entry('late_steer', { at: '2026-09-13T10:00:02.000Z' }))

    const promotable = takeUndeliveredSteers(SESSION, MESSAGE, { source: 'user' })
    expect(promotable.map((row) => row.steerId)).toEqual(['q1', 'q2', 'late_steer'])
    expect(listPendingSteers(SESSION)).toEqual([])
  })

  it('is promoted alone after a boundary delivered the steer accepted before it', () => {
    enqueueSteer(SESSION, entry('now1', { at: '2026-09-13T10:00:00.000Z' }))
    takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })
    enqueueSteer(SESSION, queued('q1', { at: '2026-09-13T10:00:01.000Z' }))

    // The delivered steer is part of this reply, never a second time the next message.
    expect(
      takeUndeliveredSteers(SESSION, MESSAGE, { source: 'user' }).map((row) => row.steerId)
    ).toEqual(['q1'])
    expect(drainDeliveredSteers(SESSION, MESSAGE).map((row) => row.steerId)).toEqual(['now1'])
  })

  /**
   * Stop means stop, for a queued message exactly as for a steer. There is no server code
   * that drops one: the promotion loop breaks on an interrupted turn and the request's
   * `finally` clears the inbox, which is the same drop a steer gets — pinned here so a
   * later change to the clear cannot start sparing them.
   */
  it('is dropped by the clear that a stopped turn runs (DL-119-05)', () => {
    enqueueSteer(SESSION, queued('q1'))
    enqueueSteer(SESSION, entry('now1'))

    clearSteerInbox(SESSION)
    expect(listPendingSteers(SESSION)).toEqual([])
  })

  it('is kept by a scoped clear when the live turn is still its own', () => {
    enqueueSteer(SESSION, queued('q1'))
    enqueueSteer(SESSION, queued('other_turn', { messageId: 'msg_assistant_2' }))

    clearSteerInbox(SESSION, { keepMessageId: MESSAGE })
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['q1'])
  })

  it('never reaches a different turn, including the promoted follow-up', () => {
    enqueueSteer(SESSION, queued('q1'))
    expect(takePendingSteersForDelivery(SESSION, 'msg_assistant_2', { step: 1, lane: 'api' })).toEqual([])
    expect(takeUndeliveredSteers(SESSION, 'msg_assistant_2')).toEqual([])
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['q1'])
  })
})

/**
 * BL-137 — a steer the user sent into a reply that then ran out of context.
 *
 * Entries are filed under the assistant message id they belong inside. A context-exhaustion
 * continuation carries the same reply on under a NEW message id, so a steer accepted during the
 * run that ran out of room (still waiting, or written to a CLI's wire and never read) was filed
 * under the old id: the continuation's boundaries never handed it over, the promotion took the
 * last run's id, and the request's `finally` cleared it. The user was left with an unanswered
 * receipt.
 */
describe('steers carried into a context-exhaustion continuation (BL-137)', () => {
  const RUN_ONE = 'msg_run_one'
  const RUN_TWO = 'msg_run_two'

  it('re-files what the run that ran out of room never delivered, in acceptance order', () => {
    enqueueSteer(SESSION, entry('a', { messageId: RUN_ONE, at: '2026-09-25T10:00:01.000Z' }))
    enqueueSteer(SESSION, entry('b', { messageId: RUN_ONE, at: '2026-09-25T10:00:02.000Z', deliver: 'end' }))
    enqueueSteer(SESSION, entry('c', { messageId: RUN_ONE, at: '2026-09-25T10:00:03.000Z' }))
    enqueueSteer(SESSION, entry('dm', { messageId: RUN_ONE, at: '2026-09-25T10:00:04.000Z', source: 'dm' }))
    enqueueSteer(SESSION, entry('other', { messageId: 'msg_someone_else', at: '2026-09-25T10:00:00.500Z' }))

    expect(refileUndeliveredSteers(SESSION, RUN_ONE, RUN_TWO)).toBe(4)

    expect(
      listPendingSteers(SESSION)
        .filter((row) => row.messageId === RUN_TWO)
        .map((row) => row.steerId)
    ).toEqual(['a', 'b', 'c', 'dm'])
    expect(listPendingSteers(SESSION).find((row) => row.steerId === 'other')?.messageId).toBe('msg_someone_else')
    // The continuation's boundary hands over the steers (never the queued one), and its end
    // promotes what is left.
    expect(takePendingSteersForDelivery(SESSION, RUN_TWO, { step: 1, lane: 'api' }).map((row) => row.steerId)).toEqual([
      'a',
      'c',
      'dm'
    ])
    expect(takeUndeliveredSteers(SESSION, RUN_TWO, { source: 'user' }).map((row) => row.steerId)).toEqual(['b'])
  })

  it('leaves a steer the run that ran out of room already delivered in that run', () => {
    enqueueSteer(SESSION, entry('a', { messageId: RUN_ONE }))
    takePendingSteersForDelivery(SESSION, RUN_ONE, { step: 1, lane: 'api' })
    expect(refileUndeliveredSteers(SESSION, RUN_ONE, RUN_TWO)).toBe(0)

    // Delivered and not yet written into its transcript, beside one that still waits.
    enqueueSteer(SESSION, entry('b', { messageId: RUN_ONE }))
    expect(refileUndeliveredSteers(SESSION, RUN_ONE, RUN_TWO)).toBe(1)
    expect(drainDeliveredSteers(SESSION, RUN_ONE).map((row) => row.steerId)).toEqual(['a'])
    expect(drainDeliveredSteers(SESSION, RUN_TWO)).toEqual([])
  })

  it('does nothing for a chat with no inbox, or for the same id', () => {
    expect(refileUndeliveredSteers('no-inbox', RUN_ONE, RUN_TWO)).toBe(0)
    enqueueSteer(SESSION, entry('a', { messageId: RUN_ONE }))
    expect(refileUndeliveredSteers(SESSION, RUN_ONE, RUN_ONE)).toBe(0)
    expect(listPendingSteers(SESSION)[0].messageId).toBe(RUN_ONE)
  })
})


it('takes only undelivered user ids at cleanup, preserving another live run, DMs and delivered entries (BL-1291)', () => {
  enqueueSteer(SESSION, entry('delivered'))
  takePendingSteersForDelivery(SESSION, MESSAGE, { step: 1, lane: 'api' })
  enqueueSteer(SESSION, entry('undelivered'))
  enqueueSteer(SESSION, entry('dm', { source: 'dm' }))
  enqueueSteer(SESSION, entry('new-live', { messageId: 'new-reply' }))
  expect(takeMissedUserSteers(SESSION, { keepMessageId: 'new-reply' }).map(item => item.steerId)).toEqual(['undelivered'])
  expect(listPendingSteers(SESSION).map(item => item.steerId)).toEqual(['dm', 'new-live'])
  expect(drainDeliveredSteers(SESSION, MESSAGE).map(item => item.steerId)).toEqual(['delivered'])
})
