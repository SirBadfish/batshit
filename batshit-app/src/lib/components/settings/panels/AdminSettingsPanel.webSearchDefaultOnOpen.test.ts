import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSettingsPanel from './AdminSettingsPanel.svelte'

/**
 * BL-909: opening Admin Settings erased a saved Exa or Perplexity default web search provider
 * when its key was not ready. `onMount` awaits `loadSettings` (which ends the load guard), and the
 * key-status load that follows rewrote `webSearchDefaultProvider` to DuckDuckGo
 * (`normalizeWebSearchProviderForAvailability`), so the autosave posted the change: a load
 * changed what was saved (BL-835 and BL-517's class). Now the panel never rewrites the choice on
 * open: the picker shows it as unavailable in the words of the Agent picker ("Exa (Missing API
 * key)"), the form keeps it, and the choice changes only when the user changes it.
 *
 * Renders the REAL panel. `/api/user/settings` is a recording stub; the other loads the panel
 * starts on open answer 404 (each shows its own error and touches nothing here).
 */

const SAVE_DEBOUNCE_PAST = 1500

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function ensureBrowserStubs() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.hasPointerCapture !== 'function') {
    Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
    Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: () => {} })
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: () => {} })
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What `/api/settings/api-keys` answers. */
let apiKeysAnswer: () => Response | Promise<Response>
/** Every write to `/api/user/settings` the panel sent, in order. */
let posts: Array<{ body: Record<string, any> }> = []
let apiKeyReads = 0
let settingsReads = 0
let savedAdminSettings: Record<string, unknown> = {}

function installRoutes(admin: Record<string, unknown>) {
  posts = []
  apiKeyReads = 0
  settingsReads = 0
  savedAdminSettings = { ...admin }
  apiKeysAnswer = () => jsonResponse({ keys: {} })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]

    if (path === '/api/user/settings' && method === 'GET') {
      settingsReads += 1
      return jsonResponse({ settings: { admin_settings: savedAdminSettings } })
    }
    if (path === '/api/user/settings' && method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'))
      posts.push({ body })
      if (body.admin_settings) savedAdminSettings = body.admin_settings
      return jsonResponse({ settings: { admin_settings: savedAdminSettings } })
    }
    if (path === '/api/settings/api-keys') {
      apiKeyReads += 1
      return apiKeysAnswer()
    }
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

/** Renders the panel and waits until the settings and the key status are in, past the autosave debounce. */
async function openPanel() {
  render(AdminSettingsPanel, { props: { data: { user: { id: 'ss909_user' } } as any } })
  await waitFor(() => expect(settingsReads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
  await waitFor(() => expect(apiKeyReads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
  await pause(SAVE_DEBOUNCE_PAST)
}

describe('Admin Settings keeps a saved default web search provider whose key is not ready (BL-909)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('a saved Exa default with no Exa key: opening writes nothing, the picker shows it unavailable, the form keeps it', async () => {
    installRoutes({ web_search_default_provider: 'exa', web_search_exa_type: 'fast' })
    await openPanel()

    expect(posts).toEqual([])
    expect(savedAdminSettings).toEqual({ web_search_default_provider: 'exa', web_search_exa_type: 'fast' })
    expect(await screen.findByText('Exa (Missing API key)')).toBeTruthy()
    // The old wording is gone: one word per concept.
    expect(screen.queryByText(/key missing/i)).toBeNull()
  }, 60_000)

  it('the form keeps the saved value: a later edit of another field posts it unchanged', async () => {
    installRoutes({ web_search_default_provider: 'exa', web_search_exa_type: 'fast' })
    await openPanel()
    expect(posts).toEqual([])

    await fireEvent.click(document.getElementById('goon-lip-sync-lab-enabled') as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })

    expect(posts[0].body.admin_settings.web_search_default_provider).toBe('exa')
    expect(posts[0].body.admin_settings.goon_lip_sync_lab_enabled).toBe(true)
  }, 60_000)

  it('the key status arrives after the settings loaded: the saved default is still kept and opening writes nothing', async () => {
    let answer: (response: Response) => void = () => {}
    const late = new Promise<Response>((resolve) => {
      answer = resolve
    })
    installRoutes({ web_search_default_provider: 'exa' })
    apiKeysAnswer = () => late
    render(AdminSettingsPanel, { props: { data: { user: { id: 'ss909_user' } } as any } })
    await waitFor(() => expect(apiKeyReads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await pause(1000)
    // While the status is unknown the picker does not call the choice unavailable.
    expect(screen.queryByText('Exa (Missing API key)')).toBeNull()
    answer(jsonResponse({ keys: {} }))
    await pause(SAVE_DEBOUNCE_PAST)

    expect(posts).toEqual([])
    expect(savedAdminSettings).toEqual({ web_search_default_provider: 'exa' })
    expect(await screen.findByText('Exa (Missing API key)')).toBeTruthy()
  }, 60_000)

  it('a saved Perplexity default with no Perplexity key: opening writes nothing and the default stays saved', async () => {
    installRoutes({ web_search_default_provider: 'perplexity' })
    apiKeysAnswer = () => jsonResponse({ keys: { exa: { status: 'ready' } } })
    await openPanel()

    expect(posts).toEqual([])
    expect(savedAdminSettings).toEqual({ web_search_default_provider: 'perplexity' })
    expect(await screen.findByText('Perplexity (Missing API key)')).toBeTruthy()
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): the key status cannot be loaded: opening writes nothing, the plain name shows and the panel names the failure', async () => {
    installRoutes({ web_search_default_provider: 'exa' })
    apiKeysAnswer = () => jsonResponse({ error: 'Failed to fetch API keys' }, 500)
    await openPanel()

    expect(posts).toEqual([])
    expect(savedAdminSettings).toEqual({ web_search_default_provider: 'exa' })
    // Not known to be unavailable: the panel shows the load failure instead of guessing.
    expect(await screen.findByText('Exa')).toBeTruthy()
    expect(screen.queryByText('Exa (Missing API key)')).toBeNull()
    expect(await screen.findByText(/Failed to fetch API keys/)).toBeTruthy()
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): with the Exa key saved the default shows plainly and opening writes nothing', async () => {
    installRoutes({ web_search_default_provider: 'exa' })
    apiKeysAnswer = () => jsonResponse({ keys: { exa: { status: 'ready' } } })
    await openPanel()

    expect(posts).toEqual([])
    expect(await screen.findByText('Exa')).toBeTruthy()
    expect(screen.queryByText('Exa (Missing API key)')).toBeNull()
  }, 60_000)

  it('the default changes only when the user changes it: picking DuckDuckGo saves that one choice', async () => {
    installRoutes({ web_search_default_provider: 'exa', web_search_exa_type: 'fast' })
    await openPanel()
    expect(posts).toEqual([])

    const trigger = (await screen.findByText('Exa (Missing API key)')).closest('button') as HTMLElement
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    // The popper stays `visibility: hidden` in jsdom (no layout), so an option has no accessible
    // name here: find the hidden options and pick by their text.
    await waitFor(() => expect(screen.queryAllByRole('option', { hidden: true }).length).toBeGreaterThan(0))
    const options = screen.getAllByRole('option', { hidden: true })
    // The saved choice is listed, as unavailable, so the open list shows what is selected.
    expect(options.some((element) => element.textContent?.trim() === 'Exa (Missing API key)')).toBe(true)
    const option = options.find((element) => /^DuckDuckGo/.test(element.textContent?.trim() ?? ''))
    expect(option).toBeTruthy()
    await fireEvent.pointerUp(option as HTMLElement, { pointerType: 'mouse' })

    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    expect(posts[0].body.admin_settings.web_search_default_provider).toBe('duckduckgo-html')
    expect(savedAdminSettings.web_search_default_provider).toBe('duckduckgo-html')
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
  }, 60_000)
})
