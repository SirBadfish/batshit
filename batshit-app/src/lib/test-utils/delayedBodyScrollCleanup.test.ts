import { describe, expect, it } from 'vitest'

import { waitForDelayedBodyScrollCleanup } from './delayedBodyScrollCleanup'

describe('waitForDelayedBodyScrollCleanup', () => {
  it('keeps jsdom alive until a delayed body-scroll unlock finishes', async () => {
    document.body.style.overflow = 'hidden'
    document.body.style.pointerEvents = 'none'

    window.setTimeout(() => {
      document.body.style.removeProperty('overflow')
      document.body.style.removeProperty('pointer-events')
    }, 24)

    await waitForDelayedBodyScrollCleanup()

    expect(document.body.style.overflow).toBe('')
    expect(document.body.style.pointerEvents).toBe('')
  })
})
