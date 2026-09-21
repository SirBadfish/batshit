import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetStreamAbortRegistryForTests,
  abortStream,
  beginSessionDelete,
  clearGroupAbort,
  clearSessionTurn,
  clearStreamAbort,
  endSessionDelete,
  getActiveSessionTurn,
  getActiveStream,
  hasRunningRequest,
  isSessionDeleting,
  isSessionTurnFinishing,
  isSessionTurnHeldByAnother,
  registerGroupAbort,
  registerSessionTurn,
  registerStreamAbort,
  releaseSessionTurn,
  stopRunningRequests,
  stopSessionTurn
} from '../services/streamAbortRegistry'

describe('streamAbortRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
    // A hard reset, not `clearSessionTurn`: an id-less release no longer deletes a live
    // owned lock, so teardown cannot rely on it.
    __resetStreamAbortRegistryForTests()
  })

  it('allows only one active session turn per session', () => {
    const first = registerSessionTurn('session-1', 'single', 'msg-1')
    const duplicate = registerSessionTurn('session-1', 'group')

    expect(first.ok).toBe(true)
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok || duplicate.reason !== 'turn_in_progress') {
      throw new Error('expected a turn in progress')
    }
    expect(duplicate.existing.kind).toBe('single')
    expect(duplicate.existing.messageId).toBe('msg-1')

    clearSessionTurn('session-1', 'msg-1')

    const retry = registerSessionTurn('session-1', 'group')
    expect(retry.ok).toBe(true)
    expect(getActiveSessionTurn('session-1')?.kind).toBe('group')
  })

  it('tracks session turns separately from stream abort controllers', () => {
    const controller = new AbortController()

    registerStreamAbort('session-1', 'msg-1', controller)
    registerSessionTurn('session-1', 'single', 'msg-1')

    expect(getActiveStream('session-1')?.messageId).toBe('msg-1')
    expect(getActiveSessionTurn('session-1')?.kind).toBe('single')

    clearSessionTurn('session-1', 'msg-1')

    expect(getActiveSessionTurn('session-1')).toBeNull()
    expect(getActiveStream('session-1')?.messageId).toBe('msg-1')
  })

  it('does not let an unowned release cancel a turn that is still starting', () => {
    // SA-113 F-P1-1. The DM drawer's Stop, the artifact auto-followup and the interrupt
    // route's stale-turn branch all release without a message id. Deleting on their word
    // wiped the lock of a live turn during its setup window, after which the 409 interlock
    // in send-routed is blind and a second turn can start in the same chat.
    registerSessionTurn('session-1', 'single', 'msg-1')

    clearSessionTurn('session-1')

    expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')
  })

  it('still lets the group lane release its own id-less turn', () => {
    // A group turn deliberately registers with no message id, so an id-less release IS its
    // owned release and must keep working.
    registerSessionTurn('session-1', 'group')

    clearSessionTurn('session-1')

    expect(getActiveSessionTurn('session-1')).toBeNull()
  })

  it('does not clear a session turn for a different message id', () => {
    registerSessionTurn('session-1', 'single', 'msg-1')

    clearSessionTurn('session-1', 'msg-2')

    expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')
  })

  it('releases aborted stream turns after the interrupt grace period', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'))
    const controller = new AbortController()

    registerStreamAbort('session-1', 'msg-1', controller)
    registerSessionTurn('session-1', 'single', 'msg-1')
    expect(abortStream('session-1', 'user')).toEqual({ ok: true, messageId: 'msg-1' })

    vi.advanceTimersByTime(4_999)
    expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')

    vi.advanceTimersByTime(2)
    expect(getActiveSessionTurn('session-1')).toBeNull()
    expect(getActiveStream('session-1')).toBeNull()
  })

  it('keeps setup-only turns briefly before treating them as orphaned', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T12:00:00.000Z'))

    registerSessionTurn('session-1', 'single', 'msg-1')

    vi.advanceTimersByTime(119_999)
    expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')

    vi.advanceTimersByTime(2)
    expect(getActiveSessionTurn('session-1')).toBeNull()
  })

  it('allows different sessions to hold independent normal turns', () => {
    const first = registerSessionTurn('session-1', 'single')
    const second = registerSessionTurn('session-2', 'single')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(getActiveSessionTurn('session-1')?.kind).toBe('single')
    expect(getActiveSessionTurn('session-2')?.kind).toBe('single')
  })

  /**
   * A reply that ran longer than two minutes lost its lock the moment its stream ended
   * (2026-09-18, measured live in `_local/lock-prune-proof/before-real.json`): the orphan
   * prune measured a lock's age from its REGISTRATION, and send-routed clears its stream
   * before its after-reply work and its `finally`. An Approve click 277 ms after the stream
   * ended found the lock gone and started while the old request was still cleaning up.
   *
   * A lock is an orphan only once nothing has run under it for two minutes: counted from its
   * registration, or from the end of the last stream or group run registered under it.
   */
  describe('the orphan clock counts quiet time, not age', () => {
    it('keeps the lock through the after-reply work of a reply that ran past two minutes', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))

      registerSessionTurn('session-1', 'single', 'msg-1')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      vi.advanceTimersByTime(139_000)
      clearStreamAbort('session-1', 'msg-1')

      expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')
      vi.advanceTimersByTime(119_999)
      expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')

      // SA-113's recovery is kept: a request that goes quiet for two minutes after its reply
      // (a hung cleanup) still frees the chat.
      vi.advanceTimersByTime(2)
      expect(getActiveSessionTurn('session-1')).toBeNull()
    })

    it('restarts the clock at the end of each stream the request runs', () => {
      // A context-exhaustion continuation and a promoted steer run their next reply under the
      // same lock, with a setup window between the streams.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))

      registerSessionTurn('session-1', 'single', 'msg-1')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      vi.advanceTimersByTime(90_000)
      clearStreamAbort('session-1', 'msg-1')
      vi.advanceTimersByTime(100_000)
      registerStreamAbort('session-1', 'msg-2', new AbortController())
      vi.advanceTimersByTime(90_000)
      clearStreamAbort('session-1', 'msg-2')
      vi.advanceTimersByTime(119_000)

      expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')
    })

    it('does not count a clear that found no stream as a sign of life', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))

      registerSessionTurn('session-1', 'single', 'msg-1')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      vi.advanceTimersByTime(10_000)
      clearStreamAbort('session-1', 'msg-1')
      vi.advanceTimersByTime(119_000)
      // Nothing is left to clear, so nothing ran: the lock has been quiet since the real end.
      clearStreamAbort('session-1', 'msg-1')
      clearStreamAbort('session-1')
      vi.advanceTimersByTime(2_000)

      expect(getActiveSessionTurn('session-1')).toBeNull()
    })

    it('keeps a group turn’s lock after its group run ends, until the same quiet bound', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))

      registerSessionTurn('session-1', 'group')
      registerGroupAbort('session-1', new AbortController())
      vi.advanceTimersByTime(300_000)
      clearGroupAbort('session-1')

      expect(getActiveSessionTurn('session-1')?.kind).toBe('group')
      vi.advanceTimersByTime(120_001)
      expect(getActiveSessionTurn('session-1')).toBeNull()
    })

    it('lets an unowned release take the lock only once it is an orphan by the same clock', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))

      registerSessionTurn('session-1', 'single', 'msg-1')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      vi.advanceTimersByTime(139_000)
      clearStreamAbort('session-1', 'msg-1')

      clearSessionTurn('session-1')
      expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')
    })

    it('still releases an aborted stream’s lock after the interrupt grace, however young', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))

      registerSessionTurn('session-1', 'single', 'msg-1')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      abortStream('session-1', 'user')
      vi.advanceTimersByTime(5_001)

      expect(getActiveSessionTurn('session-1')).toBeNull()
    })
  })

  /**
   * A turn is FINISHING once a stream or group run under its lock has ended and nothing runs
   * under it now: its reply is over (the browser already has `end`) and its request is doing
   * its after-reply work. Measured on the smoke stack (`_local/queued-send-proof/`): a
   * browser-held queued message goes out at `end` and reached send-routed 0.8-1.6 s before
   * that work was done, so it was refused `session_turn_in_progress` 9 times out of 9.
   */
  describe('a finishing turn', () => {
    it('is not finishing while it sets up or streams, and is once its stream has ended', () => {
      registerSessionTurn('session-1', 'single', 'msg-1')
      expect(isSessionTurnFinishing('session-1')).toBe(false)

      registerStreamAbort('session-1', 'msg-1', new AbortController())
      expect(isSessionTurnFinishing('session-1')).toBe(false)

      clearStreamAbort('session-1', 'msg-1')
      expect(isSessionTurnFinishing('session-1')).toBe(true)
    })

    it('stops finishing when a continuation or a promoted steer starts its next stream', () => {
      registerSessionTurn('session-1', 'single', 'msg-1')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      clearStreamAbort('session-1', 'msg-1')
      registerStreamAbort('session-1', 'msg-2', new AbortController())

      expect(isSessionTurnFinishing('session-1')).toBe(false)
    })

    it('counts a group turn as running until its group run ends, whatever its members do', () => {
      registerSessionTurn('session-1', 'group')
      registerGroupAbort('session-1', new AbortController())
      registerStreamAbort('session-1', 'msg-speaker-1', new AbortController())
      clearStreamAbort('session-1', 'msg-speaker-1')
      // Between two speakers nothing streams, but the group run is still going.
      expect(isSessionTurnFinishing('session-1')).toBe(false)

      clearGroupAbort('session-1')
      expect(isSessionTurnFinishing('session-1')).toBe(true)
    })

    it('is not finishing once the lock is released, or with no lock at all', () => {
      const turn = registerSessionTurn('session-1', 'single', 'msg-1')
      if (!turn.ok) throw new Error('registration refused')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      clearStreamAbort('session-1', 'msg-1')
      releaseSessionTurn('session-1', turn.entry.turnId)

      expect(isSessionTurnFinishing('session-1')).toBe(false)
      expect(isSessionTurnFinishing('session-never-used')).toBe(false)
    })

    it('is not finishing once it has been quiet long enough to be an orphan', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))
      registerSessionTurn('session-1', 'single', 'msg-1')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      clearStreamAbort('session-1', 'msg-1')
      vi.advanceTimersByTime(120_001)

      expect(isSessionTurnFinishing('session-1')).toBe(false)
      expect(getActiveSessionTurn('session-1')).toBeNull()
    })
  })

  /**
   * A request releases the lock IT registered, by that registration, never by message id.
   *
   * An Approve click resumes in place, into the card's own message id, so a click that took
   * the lock while the reply that raised the card was still finishing carried the very id
   * that reply registered under. Released by message id, the old request's `finally`
   * deleted the click's lock, and a second tab's click on the same card then ran the approved
   * command a second time (measured live, `_local/lock-prune-proof/before-sim.json`).
   */
  describe('a request releases only its own registration', () => {
    it('cannot release a later lock on the same message', () => {
      const reply = registerSessionTurn('session-1', 'single', 'msg-card')
      if (!reply.ok) throw new Error('first registration refused')
      // The reply's lock goes (a Stop on it, or the orphan prune) and a click takes the chat.
      clearSessionTurn('session-1', 'msg-card')
      const click = registerSessionTurn('session-1', 'single', 'msg-card', { answersApproval: true })
      if (!click.ok) throw new Error('click registration refused')
      expect(click.entry.turnId).not.toBe(reply.entry.turnId)

      expect(releaseSessionTurn('session-1', reply.entry.turnId)).toBe(false)
      expect(getActiveSessionTurn('session-1')).toMatchObject({
        messageId: 'msg-card',
        answersApproval: true
      })

      expect(releaseSessionTurn('session-1', click.entry.turnId)).toBe(true)
      expect(getActiveSessionTurn('session-1')).toBeNull()
    })

    it('releases its own lock whatever its kind or message id', () => {
      const group = registerSessionTurn('session-1', 'group')
      if (!group.ok) throw new Error('registration refused')
      expect(releaseSessionTurn('session-1', group.entry.turnId)).toBe(true)
      expect(getActiveSessionTurn('session-1')).toBeNull()

      const woken = registerSessionTurn('session-1', 'single', null)
      if (!woken.ok) throw new Error('registration refused')
      expect(releaseSessionTurn('session-1', woken.entry.turnId)).toBe(true)
      expect(getActiveSessionTurn('session-1')).toBeNull()
    })

    it('is a no-op when there is no lock, and for another session', () => {
      const turn = registerSessionTurn('session-1', 'single', 'msg-1')
      if (!turn.ok) throw new Error('registration refused')
      expect(releaseSessionTurn('session-2', turn.entry.turnId)).toBe(false)
      expect(getActiveSessionTurn('session-1')?.messageId).toBe('msg-1')
      expect(releaseSessionTurn('session-1', turn.entry.turnId)).toBe(true)
      expect(releaseSessionTurn('session-1', turn.entry.turnId)).toBe(false)
    })

    it('says when another registration holds the chat, so run-end cleanup can stand aside', () => {
      const reply = registerSessionTurn('session-1', 'single', 'msg-card')
      if (!reply.ok) throw new Error('registration refused')
      expect(isSessionTurnHeldByAnother('session-1', reply.entry.turnId)).toBe(false)

      clearSessionTurn('session-1', 'msg-card')
      // Nobody holds it: the old request's own cleanup is still its to run.
      expect(isSessionTurnHeldByAnother('session-1', reply.entry.turnId)).toBe(false)

      const click = registerSessionTurn('session-1', 'single', 'msg-card', { answersApproval: true })
      if (!click.ok) throw new Error('registration refused')
      expect(isSessionTurnHeldByAnother('session-1', reply.entry.turnId)).toBe(true)
      expect(isSessionTurnHeldByAnother('session-1', click.entry.turnId)).toBe(false)
    })
  })

  /**
   * A chat is deleted only once no request of it is running (2026-09-18).
   *
   * Measured before (`_local/deletemid-proof/before-*.json`): a chat deleted while its reply ran
   * was swept at once, the reply's request kept writing for another 20 seconds, and its
   * message, message list, zip, zip set, and Execution Viewer log stayed behind with nothing
   * left to sweep them. The delete now stops the chat's requests and waits for them
   * (`sessionDeleteTurnStop.ts`). These are the registry's two facts for it: a chat being
   * deleted takes no new turn, and a request is running until IT releases its registration,
   * whatever became of the chat's lock.
   */
  describe('a chat being deleted', () => {
    it('takes no new turn while it is being deleted, and takes turns again once it is not', () => {
      expect(beginSessionDelete('session-1')).toBe(true)
      expect(isSessionDeleting('session-1')).toBe(true)

      expect(registerSessionTurn('session-1', 'single', 'msg-1')).toEqual({
        ok: false,
        reason: 'session_deleting'
      })
      expect(getActiveSessionTurn('session-1')).toBeNull()
      expect(hasRunningRequest('session-1')).toBe(false)
      // Another chat is not affected.
      expect(registerSessionTurn('session-2', 'single', 'msg-2').ok).toBe(true)

      endSessionDelete('session-1')
      expect(isSessionDeleting('session-1')).toBe(false)
      expect(registerSessionTurn('session-1', 'single', 'msg-3').ok).toBe(true)
    })

    it('refuses a second delete of the same chat, and a turn in it as a deletion', () => {
      registerSessionTurn('session-1', 'single', 'msg-1')

      expect(beginSessionDelete('session-1')).toBe(true)
      expect(beginSessionDelete('session-1')).toBe(false)
      // Refused as a deletion, not as a turn in progress, though a turn holds the lock.
      expect(registerSessionTurn('session-1', 'single', 'msg-2')).toEqual({
        ok: false,
        reason: 'session_deleting'
      })
    })

    it('counts a request as running until it releases its own registration', () => {
      const reply = registerSessionTurn('session-1', 'single', 'msg-1')
      if (!reply.ok) throw new Error('registration refused')
      expect(hasRunningRequest('session-1')).toBe(true)

      // A release by another registration's id is not this request finishing.
      expect(releaseSessionTurn('session-1', reply.entry.turnId + 1000)).toBe(false)
      expect(hasRunningRequest('session-1')).toBe(true)
      expect(hasRunningRequest('session-2')).toBe(false)

      expect(releaseSessionTurn('session-1', reply.entry.turnId)).toBe(true)
      expect(hasRunningRequest('session-1')).toBe(false)
    })

    it('keeps a request running after its LOCK is gone, until the request itself lets go', () => {
      // A Stop on the API lane: the stream aborts, the aborted-stream grace takes the lock after
      // five seconds, and the request runs on behind its command (22 s measured,
      // `_local/deletemid-proof/stoptime-api-1.json`), still writing.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))
      const reply = registerSessionTurn('session-1', 'single', 'msg-1')
      if (!reply.ok) throw new Error('registration refused')
      registerStreamAbort('session-1', 'msg-1', new AbortController())
      abortStream('session-1', 'user')
      vi.advanceTimersByTime(5_001)
      expect(getActiveSessionTurn('session-1')).toBeNull()
      expect(hasRunningRequest('session-1')).toBe(true)

      // The interrupt route's stale-turn release, and a new turn taking the chat meanwhile.
      const next = registerSessionTurn('session-1', 'single', 'msg-2')
      if (!next.ok) throw new Error('registration refused')
      clearSessionTurn('session-1', 'msg-2')
      expect(getActiveSessionTurn('session-1')).toBeNull()

      // The quiet orphan clock takes nothing from the running set either.
      vi.advanceTimersByTime(2 * 60 * 1000 + 1)
      expect(hasRunningRequest('session-1')).toBe(true)

      // Each request's own release is what ends it; the first one's finds no lock to release.
      expect(releaseSessionTurn('session-1', reply.entry.turnId)).toBe(false)
      expect(hasRunningRequest('session-1')).toBe(true)
      expect(releaseSessionTurn('session-1', next.entry.turnId)).toBe(false)
      expect(hasRunningRequest('session-1')).toBe(false)
    })
  })

  /**
   * A Stop that lands while a turn is still SETTING UP (2026-09-18).
   *
   * Setup (the compile, the snapshot, the bridge) runs before any stream is registered, so there
   * was nothing for a Stop to abort. Measured in a real page (`_local/stopfix-proof/`): Stop
   * 150 ms after the send answered `stale_turn_cleared`, deleted the LIVE lock, and the reply ran
   * `sleep 20` to a full answer anyway; the same on the API and Codex lanes from outside the page.
   * On a long chat setup takes seconds. Each registration now carries its own stop signal, which
   * send-routed forwards into every run it starts, so the setup checkpoint ends the run.
   */
  describe('stopping a turn that has nothing registered to abort yet', () => {
    it('stops the chat’s current turn with the reason given, and only that turn', () => {
      const reply = registerSessionTurn('session-1', 'single', 'msg-1')
      const other = registerSessionTurn('session-2', 'single', 'msg-2')
      if (!reply.ok || !other.ok) throw new Error('registration refused')
      expect(reply.entry.stop.signal.aborted).toBe(false)

      expect(stopSessionTurn('session-1', 'user')).toBe(true)

      expect(reply.entry.stop.signal.aborted).toBe(true)
      expect(reply.entry.stop.signal.reason).toBe('user')
      expect(other.entry.stop.signal.aborted).toBe(false)
      // Stopping is not releasing: the request lets go of its own lock when it is done.
      expect(getActiveSessionTurn('session-1')).toBe(reply.entry)
      expect(hasRunningRequest('session-1')).toBe(true)

      expect(stopSessionTurn('session-3', 'user')).toBe(false)
    })

    it('lets go of a stopped turn’s lock once its request has not for 5 s, and not before', () => {
      // Its request is stuck: nothing it awaits listens to the stop. Stop used to delete the lock
      // at once, which freed a stuck chat but also let a LIVE setup run on to a full answer.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))
      const reply = registerSessionTurn('session-1', 'single', 'msg-1')
      if (!reply.ok) throw new Error('registration refused')

      stopSessionTurn('session-1', 'user')
      vi.advanceTimersByTime(3_000)
      // A second Stop does not restart the grace.
      stopSessionTurn('session-1', 'user')
      vi.advanceTimersByTime(1_900)
      expect(getActiveSessionTurn('session-1')).toBe(reply.entry)

      vi.advanceTimersByTime(200)
      expect(getActiveSessionTurn('session-1')).toBeNull()
      // The request itself runs until it lets go, and a delete still waits for it.
      expect(hasRunningRequest('session-1')).toBe(true)
      expect(releaseSessionTurn('session-1', reply.entry.turnId)).toBe(false)
      expect(hasRunningRequest('session-1')).toBe(false)
    })

    it('leaves a stopped turn that has a stream to its stream’s own grace', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))
      const reply = registerSessionTurn('session-1', 'single', 'msg-1')
      if (!reply.ok) throw new Error('registration refused')
      stopSessionTurn('session-1', 'user')
      // The run got past its setup checkpoint and registered its stream before the stop landed.
      registerStreamAbort('session-1', 'msg-1', new AbortController())

      vi.advanceTimersByTime(60_000)

      expect(getActiveSessionTurn('session-1')).toBe(reply.entry)
    })

    it('reaches every running request of a chat for a delete, even one whose lock is gone', () => {
      const first = registerSessionTurn('session-1', 'single', 'msg-1')
      if (!first.ok) throw new Error('registration refused')
      clearSessionTurn('session-1', 'msg-1')
      const second = registerSessionTurn('session-1', 'single', 'msg-2')
      const elsewhere = registerSessionTurn('session-2', 'single', 'msg-3')
      if (!second.ok || !elsewhere.ok) throw new Error('registration refused')

      expect(stopRunningRequests('session-1', 'session_deleted')).toBe(2)

      expect(first.entry.stop.signal.reason).toBe('session_deleted')
      expect(second.entry.stop.signal.reason).toBe('session_deleted')
      expect(elsewhere.entry.stop.signal.aborted).toBe(false)
      expect(stopRunningRequests('session-9', 'session_deleted')).toBe(0)
    })
  })
})
