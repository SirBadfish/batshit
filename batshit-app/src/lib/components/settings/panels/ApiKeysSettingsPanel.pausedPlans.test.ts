/** Plan pause: a paused plan's row reads the server's plain words. */
import { fireEvent, render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ApiKeysSettingsPanel from './ApiKeysSettingsPanel.svelte'

const originalFetch = globalThis.fetch
const originalResizeObserver = globalThis.ResizeObserver
const SENTENCE =
  'Z.ai Coding Plan is paused: Z.ai does not list Batshit as an allowed tool yet. ' +
  "Z.ai's normal pay-as-you-go connection (Z.ai) works."

function ensureAnimateStub() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({
        cancel: () => {},
        finish: () => {},
        play: () => {},
        pause: () => {},
        onfinish: null
      })
    })
  }
}

describe('API Keys panel and paused plans', () => {
  beforeEach(() => {
    ensureAnimateStub()
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.ResizeObserver = originalResizeObserver
    vi.restoreAllMocks()
  })

  it('a saved paused plan row keeps its key and says why it is paused', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/settings/api-keys')) {
        return new Response(
          JSON.stringify({
            keys: { zai_coding: { masked: '****zc01', status: 'ready', updatedAt: '' } },
            pausedPlans: { zai_coding: { paused: true, message: SENTENCE } }
          }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const { container } = render(ApiKeysSettingsPanel)
    const trigger = await waitFor(() => {
      const found = Array.from(
        container.querySelectorAll<HTMLButtonElement>('.batshit-api-key-group-trigger')
      ).find(
        (button) =>
          button.querySelector('.batshit-settings-accordion-card-title')?.textContent?.trim() ===
          'Providers'
      )
      expect(found).toBeTruthy()
      return found as HTMLButtonElement
    })
    await fireEvent.click(trigger)
    await waitFor(() => expect(container.innerHTML).toContain('****zc01'))
    expect(container.textContent).toContain(SENTENCE)
  })
})
