import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachSteerTransport,
  clearSteerInbox,
  clearSteerRun,
  confirmSteerDelivery,
  countPendingSteers,
  drainDeliveredSteers,
  enqueueSteer,
  flushPendingSteersToTransport,
  getSteerRun,
  listInFlightSteers,
  listPendingSteers,
  registerSteerRun,
  returnSteersToPending,
  takeMissedDmSteers,
  takePendingSteersForDelivery,
  takePendingSteersForTransport,
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
    takePendingSteersForTransport(SESSION, MESSAGE)
    confirmSteerDelivery(SESSION, MESSAGE, { steerIds: ['b'], step: 0, lane: 'codex' })
    drainDeliveredSteers(SESSION, MESSAGE)
    registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'codex' })
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
})

/**
 * SA-114 P2 — the managed CLI half.
 *
 * A CLI steer has a third state the API lane does not: written to the transport's wire and
 * not yet echoed back. "Written" is not "read", and the whole packet turns on that
 * difference — an unechoed steer must be promoted, never marked delivered.
 */
describe('the in-flight lane (P2)', () => {
  it('moves a steer to in flight when a transport takes it', () => {
    enqueueSteer(SESSION, entry('a'))
    expect(takePendingSteersForTransport(SESSION, MESSAGE).map((row) => row.steerId)).toEqual(['a'])
    expect(listPendingSteers(SESSION)).toEqual([])
    expect(listInFlightSteers(SESSION).map((row) => row.steerId)).toEqual(['a'])
  })

  it('counts an in-flight steer against the waiting cap', () => {
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) enqueueSteer(SESSION, entry(`s${i}`))
    takePendingSteersForTransport(SESSION, MESSAGE)
    expect(listPendingSteers(SESSION)).toEqual([])

    // The CLI holds them; the model has read none of them. The user is still waiting on
    // five messages, so the sixth is refused exactly as it was before they were written.
    const refused = enqueueSteer(SESSION, entry('overflow'))
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected a refusal')
    expect(refused.reason).toContain('Wait for the reply')
    expect(countPendingSteers(SESSION, MESSAGE)).toBe(MAX_PENDING_STEERS)
  })

  it('marks delivered only the ids the transport actually echoed', () => {
    enqueueSteer(SESSION, entry('a'))
    enqueueSteer(SESSION, entry('b'))
    takePendingSteersForTransport(SESSION, MESSAGE)

    const delivered = confirmSteerDelivery(SESSION, MESSAGE, {
      steerIds: ['a'],
      step: 0,
      lane: 'claude'
    })
    expect(delivered.map((row) => [row.steerId, row.lane, row.step])).toEqual([['a', 'claude', 0]])
    expect(listInFlightSteers(SESSION).map((row) => row.steerId)).toEqual(['b'])
    expect(drainDeliveredSteers(SESSION, MESSAGE).map((row) => row.steerId)).toEqual(['a'])
  })

  it('confirms nothing for an id belonging to another turn', () => {
    enqueueSteer(SESSION, entry('a', { messageId: 'msg_other' }))
    takePendingSteersForTransport(SESSION, 'msg_other')
    expect(
      confirmSteerDelivery(SESSION, MESSAGE, { steerIds: ['a'], step: 0, lane: 'codex' })
    ).toEqual([])
  })

  /**
   * AMD-114-01: every unechoed steer is promoted. On Claude it is the exact line that
   * would otherwise start a second turn in the same process, which is why the bridge kills
   * the child instead of letting it run — and why the words have to come back here.
   */
  it('promotes an unechoed in-flight steer when the turn ends', () => {
    enqueueSteer(SESSION, entry('echoed'))
    enqueueSteer(SESSION, entry('written'))
    takePendingSteersForTransport(SESSION, MESSAGE)
    confirmSteerDelivery(SESSION, MESSAGE, { steerIds: ['echoed'], step: 0, lane: 'claude' })
    enqueueSteer(SESSION, entry('never-sent', { at: '2026-09-10T12:00:01.000Z' }))

    // Acceptance order, whichever list an entry sat in.
    expect(takeUndeliveredSteers(SESSION, MESSAGE).map((row) => row.steerId)).toEqual([
      'written',
      'never-sent'
    ])
    expect(listInFlightSteers(SESSION)).toEqual([])
    expect(listPendingSteers(SESSION)).toEqual([])
  })

  it('returns a refused write to the front of the waiting list', () => {
    enqueueSteer(SESSION, entry('first'))
    const taken = takePendingSteersForTransport(SESSION, MESSAGE)
    enqueueSteer(SESSION, entry('second'))

    returnSteersToPending(SESSION, taken)
    expect(listInFlightSteers(SESSION)).toEqual([])
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['first', 'second'])
  })

  it('keeps a live turn’s in-flight steers when a finished request clears the inbox', () => {
    enqueueSteer(SESSION, entry('stopped', { messageId: 'msg_stopped' }))
    takePendingSteersForTransport(SESSION, 'msg_stopped')
    enqueueSteer(SESSION, entry('live', { messageId: 'msg_live' }))
    takePendingSteersForTransport(SESSION, 'msg_live')

    clearSteerInbox(SESSION, { keepMessageId: 'msg_live' })
    expect(listInFlightSteers(SESSION).map((row) => row.steerId)).toEqual(['live'])
  })
})

describe('the steer run registration (P2, DL-114-09)', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    messageId: MESSAGE,
    steerable: true,
    reason: null,
    lane: 'codex' as const,
    ...overrides
  })

  it('records the verdict and starts with no transport', () => {
    registerSteerRun(SESSION, run())
    expect(getSteerRun(SESSION)).toEqual({ ...run(), send: null })
  })

  it('attaches a transport only to the run that is still live', () => {
    registerSteerRun(SESSION, run())
    expect(attachSteerTransport(SESSION, 'msg_other', 'codex', async () => true)).toBe(false)
    expect(getSteerRun(SESSION)?.send).toBeNull()
    expect(attachSteerTransport(SESSION, MESSAGE, 'codex', async () => true)).toBe(true)
    expect(typeof getSteerRun(SESSION)?.send).toBe('function')
  })

  it('clears only its own registration', () => {
    registerSteerRun(SESSION, run())
    clearSteerRun(SESSION, 'msg_other')
    expect(getSteerRun(SESSION)).not.toBeNull()
    clearSteerRun(SESSION, MESSAGE)
    expect(getSteerRun(SESSION)).toBeNull()
  })
})

describe('flushing to a managed CLI transport (P2)', () => {
  it('leaves an API steer alone: its hook pulls instead', async () => {
    registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'api' })
    enqueueSteer(SESSION, entry('a'))

    expect(await flushPendingSteersToTransport(SESSION, MESSAGE)).toEqual({
      flushed: 0,
      reason: 'no_transport'
    })
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['a'])
  })

  it('sends every waiting steer as one joined delivery', async () => {
    const sent: Array<{ steerIds: string[]; text: string }> = []
    registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'codex' })
    attachSteerTransport(SESSION, MESSAGE, 'codex', async (payload) => {
      sent.push(payload)
      return true
    })
    enqueueSteer(SESSION, entry('a'))
    enqueueSteer(SESSION, entry('b'))

    expect(await flushPendingSteersToTransport(SESSION, MESSAGE)).toEqual({
      flushed: 2,
      reason: 'sent'
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].steerIds).toEqual(['a', 'b'])
    expect(sent[0].text).toContain('steer a')
    expect(sent[0].text).toContain('steer b')
    expect(listInFlightSteers(SESSION).map((row) => row.steerId)).toEqual(['a', 'b'])
  })

  /**
   * F-P2-1 (Faye's review): a steer accepted BEFORE the CLI child existed sat in `pending`
   * with nothing to push it — the route's flush had found no transport, and nothing ran a
   * second flush once one was attached — so it was promoted at the end of the turn instead
   * of landing at the first boundary. Attaching the transport now pushes what is waiting.
   */
  it('pushes a steer that was accepted before the transport was attached', async () => {
    const sent: Array<{ steerIds: string[]; text: string }> = []
    registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'codex' })
    enqueueSteer(SESSION, entry('early'))
    expect(await flushPendingSteersToTransport(SESSION, MESSAGE)).toEqual({
      flushed: 0,
      reason: 'no_transport'
    })

    attachSteerTransport(SESSION, MESSAGE, 'codex', async (payload) => {
      sent.push(payload)
      return true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sent.map((row) => row.steerIds)).toEqual([['early']])
    expect(listPendingSteers(SESSION)).toEqual([])
    expect(listInFlightSteers(SESSION).map((row) => row.steerId)).toEqual(['early'])
  })

  it('returns the words to the inbox when the transport refuses', async () => {
    registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'codex' })
    attachSteerTransport(SESSION, MESSAGE, 'codex', async () => false)
    enqueueSteer(SESSION, entry('a'))

    expect(await flushPendingSteersToTransport(SESSION, MESSAGE)).toEqual({
      flushed: 0,
      reason: 'refused'
    })
    expect(listInFlightSteers(SESSION)).toEqual([])
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['a'])
  })

  it('returns the words to the inbox when the transport throws', async () => {
    registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'claude' })
    attachSteerTransport(SESSION, MESSAGE, 'claude', async () => {
      throw new Error('no active turn to steer')
    })
    enqueueSteer(SESSION, entry('a'))

    const result = await flushPendingSteersToTransport(SESSION, MESSAGE)
    expect(result.reason).toBe('refused')
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['a'])
  })

  it('will not push a steer into a turn that has moved on', async () => {
    const sent: unknown[] = []
    registerSteerRun(SESSION, {
      messageId: 'msg_newer',
      steerable: true,
      reason: null,
      lane: 'codex'
    })
    attachSteerTransport(SESSION, 'msg_newer', 'codex', async (payload) => {
      sent.push(payload)
      return true
    })
    enqueueSteer(SESSION, entry('a'))

    expect(await flushPendingSteersToTransport(SESSION, MESSAGE)).toEqual({
      flushed: 0,
      reason: 'stale_transport'
    })
    expect(sent).toEqual([])
  })

  it('sends nothing twice when two flushes race', async () => {
    let resolveSend: (() => void) | null = null
    const sent: Array<{ steerIds: string[] }> = []
    registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'codex' })
    attachSteerTransport(SESSION, MESSAGE, 'codex', async (payload) => {
      sent.push(payload)
      await new Promise<void>((resolve) => {
        resolveSend = resolve
      })
      return true
    })
    enqueueSteer(SESSION, entry('a'))

    const first = flushPendingSteersToTransport(SESSION, MESSAGE)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The second flush finds nothing waiting: the first took the entry BEFORE its write.
    expect(await flushPendingSteersToTransport(SESSION, MESSAGE)).toEqual({
      flushed: 0,
      reason: 'nothing_pending'
    })
    resolveSend?.()
    await first
    expect(sent.map((row) => row.steerIds)).toEqual([['a']])
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

  it('takes an in-flight DM steer too — written is not read', () => {
    enqueueSteer(SESSION, dmEntry('dm_written'))
    takePendingSteersForTransport(SESSION, MESSAGE)
    expect(listInFlightSteers(SESSION).map((row) => row.steerId)).toEqual(['dm_written'])

    expect(takeMissedDmSteers(SESSION).map((row) => row.steerId)).toEqual(['dm_written'])
    expect(listInFlightSteers(SESSION)).toEqual([])
  })

  it('never takes a user steer, whatever the clear is about to do', () => {
    enqueueSteer(SESSION, entry('user_1'))
    expect(takeMissedDmSteers(SESSION)).toEqual([])
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['user_1'])
  })
})
