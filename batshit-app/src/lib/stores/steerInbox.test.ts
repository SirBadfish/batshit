import { afterEach, describe, expect, it } from 'vitest'

import {
  applySteerDelivered,
  applySteerPromoted,
  applySteerQueued,
  clearDeliveredSteersForMessage,
  clearSteerInboxForTest,
  clearSteersForSession,
  getPendingSteersForSession,
  getSteer,
  getSteersForMessage,
  markSteerDropped,
  noteLocalSteer,
  steerBubbleStatusLabel
} from './steerInbox.svelte'

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

  it('labels the waiting and queued states', () => {
    noteLocalSteer({ steerId: 'steer_w', sessionId: 's1', messageId: 'm1', text: 'w', state: 'waiting' })
    noteLocalSteer({ steerId: 'steer_q', sessionId: 's1', messageId: 'm1', text: 'q' })
    expect(steerBubbleStatusLabel(getSteer('steer_w')!)).toContain('waits for the reply to finish')
    expect(steerBubbleStatusLabel(getSteer('steer_q')!)).toContain('Queued')
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

    clearSteersForSession('s1')
    expect(getSteer('steer_a')).toBeNull()
    expect(getSteer('steer_b')?.steerId).toBe('steer_b')
  })

  it('refuses an event with no session or message rather than filing it under ""', () => {
    applySteerQueued(queued({ sessionId: '' }))
    applySteerDelivered({ sessionId: 's1', messageId: '', steerId: 'steer_b' })
    expect(getSteer('steer_a')).toBeNull()
    expect(getSteer('steer_b')).toBeNull()
  })
})
