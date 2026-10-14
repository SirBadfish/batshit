import { render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import HeldMessageReceipt from './HeldMessageReceipt.svelte'
import { HELD_STOPPED_SENTENCE, WAITS_FOR_APPROVAL_SENTENCE } from '$lib/utils/heldForApproval'

/**
 * BL-455 — the receipt under a message held for an approval card: its line, and Send now, which
 * hands back the held message's own id (the kept send's path, so nothing is saved twice).
 */
describe('HeldMessageReceipt (BL-455)', () => {
  it('says the message waits for the card, with Send now visible at rest', () => {
    render(HeldMessageReceipt, {
      props: {
        receipt: { messageId: 'msg-held', state: 'waiting', label: WAITS_FOR_APPROVAL_SENTENCE },
        onSendNow: () => {}
      }
    })
    expect(screen.getByTestId('held-message-receipt').getAttribute('data-held-state')).toBe('waiting')
    expect(screen.getByText(WAITS_FOR_APPROVAL_SENTENCE)).toBeTruthy()
    expect(screen.getByTestId('held-send-now').textContent?.trim()).toBe('Send now')
  })

  it('hands the held message id back when Send now is clicked', () => {
    const onSendNow = vi.fn()
    render(HeldMessageReceipt, {
      props: {
        receipt: { messageId: 'msg-held', state: 'stopped', label: HELD_STOPPED_SENTENCE },
        onSendNow
      }
    })
    expect(screen.getByText(HELD_STOPPED_SENTENCE)).toBeTruthy()
    screen.getByTestId('held-send-now').click()
    expect(onSendNow).toHaveBeenCalledWith('msg-held')
  })

  it('offers no Send now when the page gives it nothing to send with', () => {
    render(HeldMessageReceipt, {
      props: { receipt: { messageId: 'msg-held', state: 'waiting', label: WAITS_FOR_APPROVAL_SENTENCE } }
    })
    expect(screen.queryByTestId('held-send-now')).toBeNull()
  })
})
