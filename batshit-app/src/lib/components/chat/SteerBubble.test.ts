import { render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import SteerBubble from './SteerBubble.svelte'
import type { SteerBubbleEntry } from '$lib/stores/steerInbox.svelte'

/**
 * SA-119 P3b (AMD-119-05) — the dropped bubble's two ways out.
 *
 * Josh, 2026-09-13: after a Stop drops a queued message the user must not have to retype
 * it, and the composer must not be refilled behind their back — they may have spent the
 * wait typing something else. The receipt carries the actions instead.
 *
 * Mounted for real rather than pinned as source text: this component is ~170 lines with
 * three props, and SA-119 P2b already learned the hard way that a substring assertion
 * cannot tell live code from disabled code (F-P2b-3).
 */
const entry = (over: Partial<SteerBubbleEntry> = {}): SteerBubbleEntry =>
  ({
    steerId: 'steer_abc',
    sessionId: 'session_1',
    messageId: 'msg_1',
    text: 'the words that never went',
    state: 'dropped',
    dropReason: 'stopped',
    deliver: 'end',
    withFiles: false,
    ...over
  }) as SteerBubbleEntry

describe('SteerBubble — the dropped receipt (SA-119 P3b)', () => {
  it('offers Send now and Dismiss on a dropped bubble', () => {
    render(SteerBubble, {
      props: { steer: entry(), onSendNow: () => {}, onDismiss: () => {}, canSendNow: true }
    })
    expect(screen.getByTestId('steer-send-now')).toBeTruthy()
    expect(screen.getByTestId('steer-dismiss')).toBeTruthy()
    // Visible at rest, not behind a hover — DL-119-03.
    expect(screen.getByTestId('steer-dropped-actions')).toBeTruthy()
  })

  it('hands the steer id back when Send now is clicked', async () => {
    const onSendNow = vi.fn()
    render(SteerBubble, {
      props: { steer: entry(), onSendNow, onDismiss: () => {}, canSendNow: true }
    })
    screen.getByTestId('steer-send-now').click()
    expect(onSendNow).toHaveBeenCalledWith('steer_abc')
  })

  it('hands the steer id back when Dismiss is clicked', async () => {
    const onDismiss = vi.fn()
    render(SteerBubble, {
      props: { steer: entry(), onSendNow: () => {}, onDismiss, canSendNow: true }
    })
    screen.getByTestId('steer-dismiss').click()
    expect(onDismiss).toHaveBeenCalledWith('steer_abc')
  })

  it('hides Send now when the exact message can no longer be sent', () => {
    // A bubble rebuilt from the replay buffer after a reload has no payload behind it.
    // Dismiss still works; an APPROXIMATE resend would drop the clip ids and file
    // references that live in the send's metadata rather than in these words.
    render(SteerBubble, {
      props: { steer: entry(), onSendNow: () => {}, onDismiss: () => {}, canSendNow: false }
    })
    expect(screen.queryByTestId('steer-send-now')).toBeNull()
    expect(screen.getByTestId('steer-dismiss')).toBeTruthy()
  })

  it('shows no actions at all on a bubble that is still going somewhere', () => {
    for (const state of ['queued', 'waiting'] as const) {
      const { unmount } = render(SteerBubble, {
        props: {
          steer: entry({ state, dropReason: undefined }),
          onSendNow: () => {},
          onDismiss: () => {},
          canSendNow: true
        }
      })
      expect(screen.queryByTestId('steer-dropped-actions')).toBeNull()
      unmount()
    }
  })

  it('shows no actions when the page wired none (a spectator surface)', () => {
    render(SteerBubble, { props: { steer: entry() } })
    expect(screen.queryByTestId('steer-dropped-actions')).toBeNull()
  })

  it('still reads the drop sentence from the store, not from itself (F-P3-4)', () => {
    render(SteerBubble, { props: { steer: entry() } })
    expect(screen.getByTestId('steer-bubble').textContent).toContain(
      'Not sent — you stopped the reply'
    )
    expect(screen.getByTestId('steer-bubble').textContent).toContain('the words that never went')
  })
})
