import { afterEach, describe, expect, it } from 'vitest'

import {
  applyQueuedSendHold,
  applySteerDelivered,
  applySteerDropped,
  applySteerPromoted,
  applySteerQueued,
  clearDeliveredSteersForMessage,
  clearDroppedSteer,
  clearSteerInboxForTest,
  clearDroppedSteersForSession,
  getPendingSteersForSession,
  getSteer,
  getSteersAwaitingServerForMessage,
  getSteersForMessage,
  markSteerDropped,
  noteLocalSteer,
  steerBubbleStatusLabel
} from './steerInbox.svelte'
import { QUEUED_AFTER_REPLY_SENTENCE } from '$lib/utils/steerControl'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'
import { HELD_CARD_EXPIRED_SENTENCE, WAITS_FOR_APPROVAL_SENTENCE } from '$lib/utils/heldForApproval'

/**
 * SA-114 P3 (DL-114-14) — the browser's view of a steer.
 *
 * Two facts from P1/P2 drive almost every test here: `steer_delivered` carries no text
 * (AMD-114-04) and it can arrive BEFORE `steer_queued` (the route publishes `queued` after
 * enqueueing, and the API lane can deliver inside that window). A store that assumed the
 * happy order would lose the words exactly when a steer landed fast.
 */

const queued = (overrides: Record<string, any> = {}) => ({
  sessionId: 's1',
  messageId: 'm1',
  steerId: 'steer_a',
  text: 'also run the tests',
  ...overrides
})

describe('steerInbox', () => {
  afterEach(() => {
    clearSteerInboxForTest()
  })

  it('keeps the words when delivery arrives before the queue event', () => {
    applySteerDelivered({ sessionId: 's1', messageId: 'm1', steerId: 'steer_a', lane: 'api' })
    expect(getSteer('steer_a')?.state).toBe('delivered')
    expect(getSteer('steer_a')?.text).toBe('')

    applySteerQueued(queued())

    // The later `queued` fills the text WITHOUT undoing the delivery it already saw.
    expect(getSteer('steer_a')?.text).toBe('also run the tests')
    expect(getSteer('steer_a')?.state).toBe('delivered')
  })

  it('does not blank text a previous event already supplied', () => {
    applySteerQueued(queued())
    applySteerDelivered({ sessionId: 's1', messageId: 'm1', steerId: 'steer_a', lane: 'codex' })
    expect(getSteer('steer_a')?.text).toBe('also run the tests')
    expect(getSteer('steer_a')?.lane).toBe('codex')
  })

  it('starts a local send in the queued state, which is normal for seconds on a CLI lane', () => {
    noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'hello' })
    expect(getSteer('steer_a')?.state).toBe('queued')
    expect(getPendingSteersForSession('s1')).toHaveLength(1)
  })

  it('drops delivered bubbles when the reply finalises, because the inset shows them now', () => {
    noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a' })
    noteLocalSteer({ steerId: 'steer_b', sessionId: 's1', messageId: 'm1', text: 'b' })
    applySteerDelivered({ sessionId: 's1', messageId: 'm1', steerId: 'steer_a' })

    clearDeliveredSteersForMessage('s1', 'm1')

    expect(getSteer('steer_a')).toBeNull()
    // Still waiting: the server may yet promote it, so its bubble stays.
    expect(getSteer('steer_b')?.state).toBe('queued')
  })

  it('only drops a steer that is still waiting, so a late timer cannot undo a promotion', () => {
    noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a' })
    applySteerPromoted({ steerIds: ['steer_a'], messageId: 'steer_a' })
    expect(getSteer('steer_a')?.state).toBe('promoted')

    markSteerDropped('steer_a')
    expect(getSteer('steer_a')?.state).toBe('promoted')
  })

  it('marks a waiting steer dropped when its turn was stopped', () => {
    noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a' })
    markSteerDropped('steer_a')
    expect(getSteer('steer_a')?.state).toBe('dropped')
  })

  /**
   * F-P3-4 (Faye's review): "you stopped the reply" was the only drop label, and the
   * backstop timer used it for a reply the user never stopped — a promotion that was still
   * on its way behind an auto-continue chain, or one the server failed to write.
   */
  it('says why a steer was dropped, and only says "you stopped" for a Stop', () => {
    noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a' })
    noteLocalSteer({ steerId: 'steer_b', sessionId: 's1', messageId: 'm1', text: 'b' })
    markSteerDropped('steer_a')
    markSteerDropped('steer_b', 'unanswered')

    expect(getSteer('steer_a')?.dropReason).toBe('stopped')
    expect(steerBubbleStatusLabel(getSteer('steer_a')!)).toContain('you stopped the reply')
    expect(getSteer('steer_b')?.dropReason).toBe('unanswered')
    expect(steerBubbleStatusLabel(getSteer('steer_b')!)).not.toContain('you stopped')
    expect(steerBubbleStatusLabel(getSteer('steer_b')!)).toContain('Send it again')
  })

  it('PR #106 F-19b: keeps the drop reason through a later event for the same steer', () => {
    noteLocalSteer({ steerId: 'steer_late', sessionId: 's1', messageId: 'm1', text: 'late' })
    markSteerDropped('steer_late', 'unanswered')
    // A replayed queue event arriving after the drop used to rebuild the entry without its
    // reason, and the label then blamed the user for a Stop they never pressed.
    applySteerQueued({ steerId: 'steer_late', sessionId: 's1', messageId: 'm1', text: 'late' })

    expect(getSteer('steer_late')?.dropReason).toBe('unanswered')
    expect(steerBubbleStatusLabel(getSteer('steer_late')!)).toContain('Send it again')
  })

  it('labels the queued state', () => {
    noteLocalSteer({ steerId: 'steer_q', sessionId: 's1', messageId: 'm1', text: 'q' })
    expect(steerBubbleStatusLabel(getSteer('steer_q')!)).toContain('Queued')
  })

  /**
   * SA-119 P2 (DL-119-05) — a steer and a queued message are the same OBJECT on the wire and
   * two different promises to the user.
   *
   * `deliver` is the only thing that tells them apart: `now` lands inside this reply at the
   * next tool boundary, `end` is held by the server and becomes the next turn's message.
   * The bubble has to say which, because "Queued for the agent's next step" under a message
   * that will never enter this reply is the same hidden-state problem the badges exist to
   * remove.
   */
  describe('the queued bubble says which queue it is in (DL-119-05, DL-119-06)', () => {
    it('says "sends after this reply" for a message the SERVER is holding', () => {
      noteLocalSteer({
        steerId: 'steer_end',
        sessionId: 's1',
        messageId: 'm1',
        text: 'after you finish',
        deliver: 'end'
      })
      expect(steerBubbleStatusLabel(getSteer('steer_end')!)).toBe(QUEUED_AFTER_REPLY_SENTENCE)
    })

    it('still says "the agent’s next step" for a real steer', () => {
      noteLocalSteer({
        steerId: 'steer_now',
        sessionId: 's1',
        messageId: 'm1',
        text: 'also run the tests',
        deliver: 'now'
      })
      expect(steerBubbleStatusLabel(getSteer('steer_now')!)).toBe('Queued for the agent’s next step')
    })

    it('treats an unsaid deliver as a steer, which is what every pre-SA-119 event is', () => {
      noteLocalSteer({ steerId: 'steer_old', sessionId: 's1', messageId: 'm1', text: 'x' })
      expect(getSteer('steer_old')?.deliver ?? 'now').toBe('now')
      expect(steerBubbleStatusLabel(getSteer('steer_old')!)).toBe('Queued for the agent’s next step')
    })

    it('learns `deliver` from the event, so a tab that did not send still says the right thing', () => {
      // The replay buffer re-sends `steer_queued` to any tab that (re)subscribes, and the
      // route has carried `deliver` on it since P1. A spectator must not be told a held
      // message is about to land inside the reply.
      applySteerQueued({
        sessionId: 's1',
        messageId: 'm1',
        steerId: 'steer_spec',
        text: 'held',
        deliver: 'end'
      })
      expect(steerBubbleStatusLabel(getSteer('steer_spec')!)).toBe(QUEUED_AFTER_REPLY_SENTENCE)
    })

    it('never blanks a deliver a previous event already supplied', () => {
      // Same merge rule as `text`: `steer_delivered` carries no deliver, and arriving first
      // must not turn a held message back into a steer.
      noteLocalSteer({
        steerId: 'steer_merge',
        sessionId: 's1',
        messageId: 'm1',
        text: 'held',
        deliver: 'end'
      })
      applySteerDelivered({ sessionId: 's1', messageId: 'm1', steerId: 'steer_merge' })
      expect(getSteer('steer_merge')?.deliver).toBe('end')
    })

    it('drops a held message with the same receipt a steer gets (DL-119-05)', () => {
      noteLocalSteer({
        steerId: 'steer_stop',
        sessionId: 's1',
        messageId: 'm1',
        text: 'held',
        deliver: 'end'
      })
      markSteerDropped('steer_stop')
      expect(steerBubbleStatusLabel(getSteer('steer_stop')!)).toBe('Not sent — you stopped the reply')
    })
  })

  /**
   * SA-119 P2 (F-P2-6, Josh's review of the live screenshots) — the bubble shows the words,
   * not the wire.
   *
   * A send that carries a Clip has the clip's `{{batshit-clip:id:::name}}` placeholder
   * appended to its text by the composer, and the browser-held queue drew that text raw —
   * so a queued message with a file showed the user a line of machinery under their own
   * sentence. Every real message strips or renders it; this bubble is not a message, so it
   * had nothing doing that for it.
   */
  describe('the bubble shows what was typed, not the wire text (F-P2-6)', () => {
    it('drops a clip placeholder and the blank line it rode on', () => {
      noteLocalSteer({
        steerId: 'steer_clip',
        sessionId: 's1',
        messageId: 'm1',
        text: 'this one carries a file.\n\n{{batshit-clip:clip_1789301213116_83c88e87_0:::sample.txt}}',
        deliver: 'end'
      })
      expect(getSteer('steer_clip')?.text).toBe('this one carries a file.')
    })

    it('drops several, and leaves the words between them alone', () => {
      noteLocalSteer({
        steerId: 'steer_clips',
        sessionId: 's1',
        messageId: 'm1',
        text: 'read these\n\n{{batshit-clip:clip_1789301213116_83c88e87_0:::a.txt}}\n{{batshit-clip:clip_1789301213117_83c88e88_0:::b.txt}}',
        deliver: 'end'
      })
      expect(getSteer('steer_clips')?.text).toBe('read these')
    })

    it('falls back to the file names when the clip was the whole message', () => {
      // An empty bubble under a paperclip would say less than the filename does.
      noteLocalSteer({
        steerId: 'steer_only',
        sessionId: 's1',
        messageId: 'm1',
        text: '{{batshit-clip:clip_1789301213116_83c88e87_0:::sample.txt}}',
        deliver: 'end'
      })
      expect(getSteer('steer_only')?.text).toBe('sample.txt')
    })

    it('leaves text with no clip syntax byte-identical', () => {
      const typed = 'also run the tests, and check @src/app.ts while you are there'
      noteLocalSteer({ steerId: 'steer_plain', sessionId: 's1', messageId: 'm1', text: typed })
      expect(getSteer('steer_plain')?.text).toBe(typed)
    })

    it('keeps a reference it cannot recognise, rather than hiding it', () => {
      // A placeholder that is not a concrete clip id is not Batshit's own machinery, and
      // silently deleting it would hide something the user should see.
      noteLocalSteer({
        steerId: 'steer_odd',
        sessionId: 's1',
        messageId: 'm1',
        text: 'look at {{batshit-clip:...}} please'
      })
      expect(getSteer('steer_odd')?.text).toContain('{{batshit-clip:...}}')
    })

    it('reads 1 MB of 20,000 clip openers that never close in well under 200 ms', () => {
      // The clip pattern the reference scan replaced cost (openers) x (text length) here.
      for (const [shape, text] of Object.entries(unclosedReferenceReplies('clip'))) {
        const started = performance.now()
        noteLocalSteer({ steerId: 'steer_long', sessionId: 's1', messageId: 'm1', text })
        expect(performance.now() - started, shape).toBeLessThan(200)
        expect(getSteer('steer_long')?.text, shape).toBe(text.trim())
      }
    })

    it('cleans the text the SSE event brings too, not only this tab’s own send', () => {
      applySteerQueued({
        sessionId: 's1',
        messageId: 'm1',
        steerId: 'steer_event',
        text: 'from another tab\n\n{{batshit-clip:clip_1789301213116_83c88e87_0:::sample.txt}}'
      })
      expect(getSteer('steer_event')?.text).toBe('from another tab')
    })
  })

  it('ignores a promotion for a steer this tab never saw', () => {
    applySteerPromoted({ steerIds: ['steer_unknown'], messageId: 'steer_unknown' })
    expect(getSteer('steer_unknown')).toBeNull()
  })

  it('scopes bubbles to their own chat and their own reply', () => {
    noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a' })
    noteLocalSteer({ steerId: 'steer_b', sessionId: 's2', messageId: 'm2', text: 'b' })

    expect(getSteersForMessage('s1', 'm1').map((entry) => entry.steerId)).toEqual(['steer_a'])
    expect(getSteersForMessage('s1', 'm2')).toEqual([])
    expect(getPendingSteersForSession('s2').map((entry) => entry.steerId)).toEqual(['steer_b'])

    markSteerDropped('steer_a')
    clearDroppedSteersForSession('s1')
    expect(getSteer('steer_a')).toBeNull()
    expect(getSteer('steer_b')?.steerId).toBe('steer_b')
  })

  /**
   * SA-118 (DL-118-08) — PR #106 review F-24.
   *
   * A `dropped` bubble ("Not sent — you stopped the reply") had no caller in production at
   * all: it sat under every later exchange in that chat and came back each time the chat
   * was reopened. What must NOT go with it is a `queued` or `waiting` bubble — those belong
   * to a reply that is still running, and they are the only sign the user has that a steer
   * is pending. So the test worth having is the exclusion, not the deletion.
   */
  describe('clearDroppedSteersForSession (DL-118-08)', () => {
    it('clears only dropped bubbles, and only in the session named', () => {
      noteLocalSteer({ steerId: 'steer_dropped', sessionId: 's1', messageId: 'm1', text: 'd' })
      noteLocalSteer({ steerId: 'steer_queued', sessionId: 's1', messageId: 'm1', text: 'q' })
      noteLocalSteer({ steerId: 'steer_delivered', sessionId: 's1', messageId: 'm1', text: 'v' })
      noteLocalSteer({ steerId: 'steer_other', sessionId: 's2', messageId: 'm2', text: 'o' })

      applySteerDelivered({ sessionId: 's1', messageId: 'm1', steerId: 'steer_delivered' })
      markSteerDropped('steer_dropped')
      markSteerDropped('steer_other')

      clearDroppedSteersForSession('s1')

      expect(getSteer('steer_dropped')).toBeNull()
      expect(getSteer('steer_queued')?.state).toBe('queued')
      expect(getSteer('steer_delivered')?.state).toBe('delivered')
      // Another chat's receipt is not this send's business.
      expect(getSteer('steer_other')?.state).toBe('dropped')
    })

    /**
     * F-P2-1 — measured live on BSMS, and the reason this test exists at all.
     *
     * The session replay buffer re-sends a turn's `steer_queued` whenever a tab
     * resubscribes, which is what leaving a chat and coming back does. Clearing the
     * `dropped` entry alone therefore did not remove the bubble: the replay rebuilt it from
     * scratch, with no earlier state to merge into, and it came back as **queued** — worse
     * than the stale receipt it replaced, because it claimed a stopped reply was still
     * going to read it.
     */
    it('stays cleared when the session replay sends the same steer again', () => {
      noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a' })
      markSteerDropped('steer_a')
      clearDroppedSteersForSession('s1')
      expect(getSteer('steer_a')).toBeNull()

      // Exactly what `/api/sse`'s replay hands the page on the way back into the chat.
      applySteerQueued({ sessionId: 's1', messageId: 'm1', steerId: 'steer_a', text: 'a' })
      expect(getSteer('steer_a')).toBeNull()
    })

    it('goes on updating a bubble that is still on screen', () => {
      // The refusal is only of a REBUILD. A live reply's own bubble must still take every
      // event it is sent, or a steer would freeze at `queued` and never show as delivered.
      noteLocalSteer({ steerId: 'steer_live', sessionId: 's1', messageId: 'm1', text: 'live' })
      applySteerDelivered({ sessionId: 's1', messageId: 'm1', steerId: 'steer_live' })
      expect(getSteer('steer_live')?.state).toBe('delivered')
    })

    it('does nothing for an empty session id, rather than filing under ""', () => {
      noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a' })
      markSteerDropped('steer_a')
      clearDroppedSteersForSession('')
      clearDroppedSteersForSession(null)
      expect(getSteer('steer_a')?.state).toBe('dropped')
    })
  })

  it('refuses an event with no session or message rather than filing it under ""', () => {
    applySteerQueued(queued({ sessionId: '' }))
    applySteerDelivered({ sessionId: 's1', messageId: '', steerId: 'steer_b' })
    expect(getSteer('steer_a')).toBeNull()
    expect(getSteer('steer_b')).toBeNull()
  })
})

/**
 * SA-119 P3b review (Faye, F-P3b-3) — one receipt, its own button.
 *
 * P3b's Send now and Dismiss retired the bubble with `forgetSteer`, which does not remember
 * the id — so the session replay could rebuild the very bubble the user had just acted on,
 * as a `queued` promise about a reply that is over (the AMD-118-08 lie, back through a new
 * door). This is the single-receipt twin of `clearDroppedSteersForSession`.
 */
describe('clearDroppedSteer (SA-119 P3b review, F-P3b-3)', () => {
  afterEach(() => {
    clearSteerInboxForTest()
  })

  it('removes a dropped bubble and refuses the session replay that would rebuild it', () => {
    noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a', deliver: 'end' })
    markSteerDropped('steer_a')
    clearDroppedSteer('steer_a')
    expect(getSteer('steer_a')).toBeNull()

    // Exactly what `/api/sse`'s replay hands the page on the next resubscribe.
    applySteerQueued({ sessionId: 's1', messageId: 'm1', steerId: 'steer_a', text: 'a', deliver: 'end' })
    expect(getSteer('steer_a')).toBeNull()
  })

  it("leaves the chat's OTHER receipts where they are (F-P3b-1)", () => {
    noteLocalSteer({ steerId: 'steer_a', sessionId: 's1', messageId: 'm1', text: 'a' })
    noteLocalSteer({ steerId: 'steer_b', sessionId: 's1', messageId: 'm1', text: 'b' })
    markSteerDropped('steer_a')
    markSteerDropped('steer_b')
    clearDroppedSteer('steer_a')
    expect(getSteer('steer_a')).toBeNull()
    expect(getSteer('steer_b')?.state).toBe('dropped')
    expect(getSteer('steer_b')?.text).toBe('b')
  })

  it('touches nothing that is not a dropped bubble', () => {
    noteLocalSteer({ steerId: 'steer_q', sessionId: 's1', messageId: 'm1', text: 'q' })
    clearDroppedSteer('steer_q')
    clearDroppedSteer('')
    clearDroppedSteer('steer_missing')
    expect(getSteer('steer_q')?.state).toBe('queued')
  })
})

/**
 * BL-4 — a send that met another turn waits in the chat's line, and every tab shows it as the
 * Queue bubble. Its bubble id is the id of the message the page saved, and that same message can
 * be queued again (Send now on its receipt), so a cleared id may come back for a NEWER queueing,
 * never for a replay of the old one.
 */
describe('a queued send (BL-4)', () => {
  afterEach(() => clearSteerInboxForTest())

  const queuedSend = (overrides: Record<string, any> = {}) => ({
    sessionId: 's1',
    messageId: 'reply-a',
    steerId: 'msg-b',
    text: 'SECOND',
    deliver: 'end' as const,
    at: '2026-09-22T12:00:00.000Z',
    queuedSend: true,
    ...overrides
  })

  it('shows as the Queue bubble, filed under the reply it waits for', () => {
    applySteerQueued(queuedSend())
    const bubble = getSteer('msg-b')
    expect(bubble).toMatchObject({ state: 'queued', deliver: 'end', messageId: 'reply-a', text: 'SECOND' })
    expect(steerBubbleStatusLabel(bubble!)).toBe(QUEUED_AFTER_REPLY_SENTENCE)
  })

  it('is filed under its own id when the reply it waits for has none yet (a group turn setting up)', () => {
    applySteerQueued(queuedSend({ messageId: '' }))
    expect(getSteer('msg-b')).toMatchObject({ state: 'queued', messageId: 'msg-b' })
  })

  it('becomes a receipt when the server says it will not be sent', () => {
    applySteerQueued(queuedSend())
    applySteerDropped({ steerIds: ['msg-b'], reason: 'stopped' })
    expect(steerBubbleStatusLabel(getSteer('msg-b')!)).toBe('Not sent — you stopped the reply')

    applySteerQueued(queuedSend({ steerId: 'msg-c' }))
    applySteerDropped({ steerIds: ['msg-c'], reason: 'shutdown' })
    expect(getSteer('msg-c')).toMatchObject({ state: 'dropped', dropReason: 'unanswered' })
  })

  it('comes back whenever the same message is queued again, whatever the two clocks say (review finding 4)', () => {
    // A queued send's bubble never comes from the replay buffer (a joining tab gets it from the
    // chat's line, only while it waits), so its event always means "waiting now". Send now can
    // queue it again after its receipt was cleared, in this tab or another; a browser clock
    // ahead of the server's must not hide it.
    applySteerQueued(queuedSend({ at: '2020-01-01T00:00:00.000Z' }))
    applySteerDropped({ steerIds: ['msg-b'], reason: 'stopped' })
    clearDroppedSteer('msg-b')
    applySteerQueued(queuedSend({ at: '2020-01-01T00:00:01.000Z' }))
    expect(getSteer('msg-b')).toMatchObject({ state: 'queued' })
  })

  it('an ordinary steer id stays cleared whatever its timestamp says', () => {
    applySteerQueued(queued())
    markSteerDropped('steer_a')
    clearDroppedSteer('steer_a')
    applySteerQueued(queued({ at: new Date(Date.now() + 1000).toISOString() }))
    expect(getSteer('steer_a')).toBeNull()
  })

  it('ignores a drop for a bubble this tab never saw', () => {
    applySteerDropped({ steerIds: ['msg-unknown'], reason: 'stopped' })
    expect(getSteer('msg-unknown')).toBeNull()
  })
})

describe('the end-of-reply backstop settles only what the server holds (BL-455)', () => {
  afterEach(() => clearSteerInboxForTest())

  it('a server-held steer awaits the server; a send waiting in the chat\u2019s line does not (BL-713)', () => {
    noteLocalSteer({ steerId: 'steer_server', sessionId: 's1', messageId: 'm1', text: 'held by the server', deliver: 'end' })
    applySteerQueued({ steerId: 'steer_page', sessionId: 's1', messageId: 'm1', text: 'waits in the line', deliver: 'end', queuedSend: true })
    noteLocalSteer({ steerId: 'steer_other', sessionId: 's1', messageId: 'm2', text: 'another reply' })
    expect(getSteersAwaitingServerForMessage('s1', 'm1').map((entry) => entry.steerId)).toEqual(['steer_server'])
  })

  it('delivered, promoted, and dropped steers await nothing', () => {
    noteLocalSteer({ steerId: 'steer_d', sessionId: 's1', messageId: 'm1', text: 'x' })
    applySteerDelivered({ sessionId: 's1', messageId: 'm1', steerId: 'steer_d' })
    noteLocalSteer({ steerId: 'steer_p', sessionId: 's1', messageId: 'm1', text: 'y' })
    applySteerPromoted({ steerIds: ['steer_p'] })
    noteLocalSteer({ steerId: 'steer_x', sessionId: 's1', messageId: 'm1', text: 'z' })
    markSteerDropped('steer_x')
    expect(getSteersAwaitingServerForMessage('s1', 'm1')).toEqual([])
  })
})


/**
 * BL-713 — a message that waits in the chat's line while the line holds for an approval card.
 *
 * The page keeps no queue of its own any more: a message with a Clip or an `@file` waits in the
 * chat's line on the server, and every tab draws it as a queued send's bubble. When the reply it
 * waits behind stops at an approval card, the line holds, and the bubble says so, with Send now,
 * in BL-455's words. The server tells the tabs when a hold starts and ends (`queued_send_hold`),
 * and a joining tab's replay carries it.
 */
describe('a queued send at an approval card (BL-713)', () => {
  afterEach(() => clearSteerInboxForTest())

  const queuedSend = (overrides: Record<string, any> = {}) => ({
    sessionId: 's1',
    messageId: 'reply-a',
    steerId: 'msg-b',
    text: 'summarise the file',
    deliver: 'end' as const,
    queuedSend: true,
    ...overrides
  })

  it('a joining tab draws it as waiting for the card, from the replay', () => {
    applySteerQueued(queuedSend({ messageId: '', heldForApprovalCard: 'reply-a' }))
    const bubble = getSteer('msg-b')
    expect(bubble).toMatchObject({ state: 'queued', queuedSend: true, heldForApprovalCard: 'reply-a' })
    expect(steerBubbleStatusLabel(bubble!)).toBe(WAITS_FOR_APPROVAL_SENTENCE)
  })

  it('the hold starts and ends for every queued send of that chat, and nothing else', () => {
    applySteerQueued(queuedSend())
    applySteerQueued(queuedSend({ steerId: 'msg-c' }))
    applySteerQueued(queuedSend({ steerId: 'msg-other', sessionId: 's2' }))
    noteLocalSteer({ steerId: 'steer_text', sessionId: 's1', messageId: 'reply-a', text: 'held text', deliver: 'end' })

    applyQueuedSendHold({ sessionId: 's1', heldForApprovalCard: 'reply-a' })
    expect(steerBubbleStatusLabel(getSteer('msg-b')!)).toBe(WAITS_FOR_APPROVAL_SENTENCE)
    expect(steerBubbleStatusLabel(getSteer('msg-c')!)).toBe(WAITS_FOR_APPROVAL_SENTENCE)
    expect(steerBubbleStatusLabel(getSteer('msg-other')!)).toBe(QUEUED_AFTER_REPLY_SENTENCE)
    // A server-held text Queue is BL-455's held message at a card, not this bubble.
    expect(getSteer('steer_text')?.heldForApprovalCard ?? null).toBeNull()

    applyQueuedSendHold({ sessionId: 's1', heldForApprovalCard: null })
    expect(steerBubbleStatusLabel(getSteer('msg-b')!)).toBe(QUEUED_AFTER_REPLY_SENTENCE)
    expect(getSteer('msg-b')?.heldForApprovalCard ?? null).toBeNull()
  })

  it('the page’s end-of-reply backstop never marks a queued send: the server settles it', () => {
    // The line holds at a card for up to fifteen minutes with no reply running; the backstop
    // would call it "Not sent — the reply ended before it could land" (BL-455's live find).
    applySteerQueued(queuedSend())
    noteLocalSteer({ steerId: 'steer_server', sessionId: 's1', messageId: 'reply-a', text: 'held text', deliver: 'end' })
    expect(getSteersAwaitingServerForMessage('s1', 'reply-a').map((entry) => entry.steerId)).toEqual([
      'steer_server'
    ])
  })

  it('a kept send says why, in BL-455’s words', () => {
    applySteerQueued(queuedSend())
    applySteerQueued(queuedSend({ steerId: 'msg-c' }))
    applyQueuedSendHold({ sessionId: 's1', heldForApprovalCard: 'reply-a' })
    applySteerDropped({ steerIds: ['msg-b'], reason: 'approval_wait' })
    applySteerDropped({ steerIds: ['msg-c'], reason: 'approval_expired' })
    expect(getSteer('msg-b')).toMatchObject({ state: 'dropped', dropReason: 'approval_wait' })
    expect(steerBubbleStatusLabel(getSteer('msg-b')!)).toBe(
      'Not sent — the approval card is still waiting for your answer. Send it when you are ready.'
    )
    expect(getSteer('msg-c')).toMatchObject({ state: 'dropped', dropReason: 'approval_expired' })
    expect(steerBubbleStatusLabel(getSteer('msg-c')!)).toBe(HELD_CARD_EXPIRED_SENTENCE)
  })
})
