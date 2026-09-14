import { afterEach, describe, expect, it } from 'vitest'

import {
  applySteerDelivered,
  applySteerPromoted,
  applySteerQueued,
  clearDeliveredSteersForMessage,
  clearSteerInboxForTest,
  clearDroppedSteersForSession,
  getPendingSteersForSession,
  getSteer,
  getSteersForMessage,
  markSteerDropped,
  noteLocalSteer,
  steerBubbleStatusLabel
} from './steerInbox.svelte'
import {
  QUEUED_AFTER_REPLY_SENTENCE,
  QUEUED_WITH_FILES_SENTENCE
} from '$lib/utils/steerControl'

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

  it('labels the waiting and queued states', () => {
    noteLocalSteer({
      steerId: 'steer_w',
      sessionId: 's1',
      messageId: 'm1',
      text: 'w',
      state: 'waiting',
      withFiles: true
    })
    noteLocalSteer({ steerId: 'steer_q', sessionId: 's1', messageId: 'm1', text: 'q' })
    expect(steerBubbleStatusLabel(getSteer('steer_w')!)).toBe(QUEUED_WITH_FILES_SENTENCE)
    expect(steerBubbleStatusLabel(getSteer('steer_q')!)).toContain('Queued')
  })

  it('never says "with files" about a text-only message the browser is holding (F-P2-2)', () => {
    // A group chat, an unmanaged profile or a Codex exec lane cannot take a steer at all,
    // so a plain typed message waits in the browser too (DL-119-06). Telling that user
    // "(with files)" would describe a message they did not send.
    noteLocalSteer({
      steerId: 'steer_text_wait',
      sessionId: 's1',
      messageId: 'm1',
      text: 'plain words',
      state: 'waiting'
    })
    expect(steerBubbleStatusLabel(getSteer('steer_text_wait')!)).toBe(QUEUED_AFTER_REPLY_SENTENCE)
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
        state: 'waiting',
        withFiles: true
      })
      expect(getSteer('steer_clip')?.text).toBe('this one carries a file.')
    })

    it('drops several, and leaves the words between them alone', () => {
      noteLocalSteer({
        steerId: 'steer_clips',
        sessionId: 's1',
        messageId: 'm1',
        text: 'read these\n\n{{batshit-clip:clip_1789301213116_83c88e87_0:::a.txt}}\n{{batshit-clip:clip_1789301213117_83c88e88_0:::b.txt}}',
        state: 'waiting',
        withFiles: true
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
        state: 'waiting',
        withFiles: true
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
      noteLocalSteer({
        steerId: 'steer_waiting',
        sessionId: 's1',
        messageId: 'm1',
        text: 'w',
        state: 'waiting'
      })
      noteLocalSteer({ steerId: 'steer_delivered', sessionId: 's1', messageId: 'm1', text: 'v' })
      noteLocalSteer({ steerId: 'steer_other', sessionId: 's2', messageId: 'm2', text: 'o' })

      applySteerDelivered({ sessionId: 's1', messageId: 'm1', steerId: 'steer_delivered' })
      markSteerDropped('steer_dropped')
      markSteerDropped('steer_other')

      clearDroppedSteersForSession('s1')

      expect(getSteer('steer_dropped')).toBeNull()
      expect(getSteer('steer_queued')?.state).toBe('queued')
      expect(getSteer('steer_waiting')?.state).toBe('waiting')
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
