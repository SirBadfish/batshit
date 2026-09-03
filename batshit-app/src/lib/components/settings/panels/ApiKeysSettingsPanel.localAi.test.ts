/**
 * SA-102 P6 (DL-102-09, revised 2026-09-03) — local AI program keys live in the
 * API Keys panel, and ONLY there.
 *
 * The original decision put the field in two places, this panel and Settings ->
 * Local AI. Josh's call: one secret, one place. This suite pins the half that
 * has to exist here, because the earlier work reported it as done when the
 * panel's hardcoded SERVICES list had never gained the programs at all — a
 * claim nobody could disprove without opening the page.
 *
 * The generated-from-definitions rule is the point: adding a program to
 * `LOCAL_AI_SERVER_DEFINITIONS` must surface it here with no edit to this panel.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ApiKeysSettingsPanel from './ApiKeysSettingsPanel.svelte'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import { LOCAL_AI_KEY_SERVICES } from '$lib/data/localAiKeyServices'

const originalFetch = globalThis.fetch
const originalResizeObserver = globalThis.ResizeObserver

/** `keys` is a map of service id -> record; an absent id means "no key saved". */
function mockFetch(keys: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url.includes('/api/settings/api-keys') && method === 'GET') {
      return new Response(JSON.stringify({ keys }), { status: 200 })
    }
    if (url.includes('/api/mcp/gateway/token')) {
      return new Response(JSON.stringify({ token: null }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
}

/**
 * Groups render as collapsed accordions, so their rows are not in the DOM until
 * the header is clicked. Every content assertion has to open the group first —
 * which is itself worth pinning: a user finds this by clicking "Local AI".
 */
async function openLocalAiGroup(container: HTMLElement): Promise<void> {
  // Not `findByRole('button', {name: /Local AI/i})`: each group header nests an
  // info button whose label is "About Local AI", so the accessible-name match is
  // ambiguous and lands on the wrong control. The group trigger carries its own
  // class, so query for it directly.
  const trigger = await waitFor(() => {
    const found = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.batshit-api-key-group-trigger')
    ).find((button) =>
      button.querySelector('.batshit-settings-accordion-card-title')?.textContent?.trim() ===
      'Local AI'
    )
    expect(found, 'no Local AI group trigger rendered').toBeTruthy()
    return found as HTMLButtonElement
  })

  await fireEvent.click(trigger)
  await waitFor(() => {
    expect(container.innerHTML).toContain('LM Studio')
  })
}

/**
 * Bits UI's collapsible drives the group open/closed with the Web Animations
 * API, which jsdom does not implement. Same stub VoiceSettingsPanel.test.ts uses.
 */
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

describe('SA-102 P6: local AI programs in the API Keys panel', () => {
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

  it('renders a Local AI group', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch
    render(ApiKeysSettingsPanel)

    await waitFor(() => {
      expect(screen.getByText('Local AI')).toBeInTheDocument()
    })
  })

  it('offers every defined program, so adding one to the definitions cannot be forgotten here', async () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch
    const { container } = render(ApiKeysSettingsPanel)
    await openLocalAiGroup(container)

    // Seven programs today. The assertion is derived, not hardcoded, so an
    // eighth program added to LOCAL_AI_SERVER_DEFINITIONS is covered for free.
    expect(LOCAL_AI_SERVER_DEFINITIONS.length).toBeGreaterThanOrEqual(7)

    const markup = container.innerHTML
    for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
      expect(
        markup.includes(definition.label),
        `${definition.label} (${definition.id}) is not offered in the API Keys panel`
      ).toBe(true)
    }
  })

  it('shows a program row once its key is saved', async () => {
    globalThis.fetch = mockFetch({
      omlx: { masked: '****3a2b', status: 'ready', updatedAt: '2026-09-03T00:00:00.000Z' }
    }) as unknown as typeof fetch

    const { container } = render(ApiKeysSettingsPanel)
    await openLocalAiGroup(container)

    // Rendered as "Stored as ****3a2b" across two nodes, so match the markup
    // rather than a single text node.
    await waitFor(() => {
      expect(container.innerHTML).toContain('****3a2b')
    })
  })

  it('describes the key as optional, because most local programs never ask for one', async () => {
    // Asserted on the DATA, not the DOM: descriptions render inside a closed
    // info popover, so a DOM assertion would only prove the popover is shut.
    expect(LOCAL_AI_KEY_SERVICES).toHaveLength(LOCAL_AI_SERVER_DEFINITIONS.length)

    for (const service of LOCAL_AI_KEY_SERVICES) {
      expect(service.description).toMatch(/^Only if /)
      expect(service.description).toMatch(/Most local programs ignore the key entirely/)
      expect(service.description).toMatch(/chat and for memory search/)
      expect(service.scope).toBe('provider')
    }
  })

  it('keeps one key per program — no id is offered twice', () => {
    const ids = LOCAL_AI_KEY_SERVICES.map((service) => service.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(LOCAL_AI_SERVER_DEFINITIONS.map((definition) => definition.id))
  })
})
