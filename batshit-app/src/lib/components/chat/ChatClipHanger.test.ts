import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import ChatClipHanger from './ChatClipHanger.svelte'

const baseClip = {
  id: 'clip_1',
  filename: 'screenshot.png',
  mimeType: 'image/png',
}

describe('ChatClipHanger', () => {
  it('exposes a next-message-only toggle for clipped items', async () => {
    const onToggleUseOnce = vi.fn()

    render(ChatClipHanger, {
      clips: [baseClip],
      onDetachClip: vi.fn(),
      onToggleUseOnce,
    })

    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Use screenshot.png for next message only',
      }),
    )

    expect(onToggleUseOnce).toHaveBeenCalledWith(baseClip)
  })

  it('shows the one-time toggle as active when the clip is next-message-only', () => {
    render(ChatClipHanger, {
      clips: [{ ...baseClip, messagesUntilUnclip: 1 }],
      onDetachClip: vi.fn(),
      onToggleUseOnce: vi.fn(),
    })

    const button = screen.getByRole('button', {
      name: 'Keep screenshot.png clipped after sends',
    })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button.closest('.chatbar-clip-item')).toHaveClass('one-time')
  })
})
