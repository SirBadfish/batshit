import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  installUserSettingsRoutes,
  loadUserSettingsRoute,
  storedUserSettings
} from '$lib/test-utils/userSettingsRoute'
import AdminSettingsPanel from './AdminSettingsPanel.svelte'

/**
 * BL-939: when `GET /api/user/settings` failed, the Admin panel showed the page's copy of the
 * settings (or the defaults) in editable fields and ended its load. The next edit posted the
 * whole `admin_settings` block built from that copy, and the route replaces the whole block, so
 * every saved admin value the copy did not hold was erased (BL-487's class). Now only a
 * successful read counts as a loaded copy: until then the four cards that hold Admin values are
 * not offered at all, the panel says so in a plain sentence with a Retry, and a Retry that works
 * shows the saved values and saves as before.
 *
 * Renders the REAL panel. `/api/user/settings` goes to the REAL route handlers on the default
 * lane's Redis fake, so every assertion below reads what is STORED, not what the panel sent.
 * The other loads the panel starts on open answer 404 (each shows its own error and touches
 * nothing here).
 */

useRedisTestServer()

const USER = 'ss939_user'
const SAVE_DEBOUNCE_PAST = 1500

/** Saved admin values: every one differs from its default, so an erasure is visible. */
const SAVED: Record<string, unknown> = {
  dcm_schema_hint_required_limit: 9,
  dcm_schema_hint_optional_limit: 4,
  dcm_schema_hint_max_chars: 400,
  dcm_tool_name_threshold: 33,
  goon_lip_sync_lab_enabled: true,
  agent_wakeups_enabled: false,
  web_search_default_provider: 'exa',
  web_search_exa_type: 'deep',
  web_search_perplexity_max_tokens_per_page: 2048
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

let route: Awaited<ReturnType<typeof loadUserSettingsRoute>>

beforeAll(async () => {
  route = await loadUserSettingsRoute()
}, 60_000)

let posts: Array<{ body: Record<string, any> }> = []
let counts: { reads: number } = { reads: 0 }
/** While set, a settings GET answers this status (a failed load). */
let failGetsWith: number | null = null
/** While set, a settings GET waits for it (a slow load). */
let holdGets: Promise<void> | null = null

async function seedStored(admin: Record<string, unknown>) {
  await redis.updateUserSettings(USER, { displayName: 'Probe', admin_settings: { ...admin } })
}

async function storedAdmin() {
  return (await storedUserSettings(USER))?.admin_settings
}

function installRoutes() {
  failGetsWith = null
  holdGets = null
  const installed = installUserSettingsRoutes({
    userId: USER,
    route,
    failGetsWith: () => failGetsWith,
    holdGets: () => holdGets
  })
  posts = installed.posts
  counts = installed.counts
}

function renderPanel(userSettings: unknown = null) {
  return render(AdminSettingsPanel, {
    props: { data: { user: { id: USER }, userSettings } as any }
  })
}

const labSwitch = () => document.getElementById('goon-lip-sync-lab-enabled')
const wakeupsSwitch = () => document.getElementById('agent-wakeups-enabled')

/** The user tries to change a setting on the Admin cards: whatever the panel offers, click it. */
async function tryToChangeALabSetting() {
  const control = labSwitch()
  if (control) await fireEvent.click(control)
  await pause(SAVE_DEBOUNCE_PAST)
}

describe('Admin Settings never turns a failed load into a save (BL-939)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('the load fails and the user tries an edit: no write leaves and the stored settings are unchanged', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    expect((await screen.findAllByText('Redis unavailable')).length).toBeGreaterThan(0)

    await tryToChangeALabSetting()

    expect(posts).toEqual([])
    expect(await storedAdmin()).toEqual(SAVED)
    // The panel says so in a plain sentence, with a Retry, and offers no field that looks saved.
    const notice = screen.getByTestId('admin-settings-load-error')
    expect(within(notice).getByText(/Admin settings could not load/)).toBeTruthy()
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(labSwitch()).toBeNull()
    expect(wakeupsSwitch()).toBeNull()
    expect(document.getElementById('web-search-default-provider')).toBeNull()
  }, 60_000)

  it('the load fails while the page carries an older copy: the copy is never written over the stored settings', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    // The page opened before the settings were last saved: a real copy, but not the saved one.
    renderPanel({
      admin_settings: { ...SAVED, web_search_default_provider: 'perplexity', dcm_tool_name_threshold: 12 }
    })
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    expect((await screen.findAllByText('Redis unavailable')).length).toBeGreaterThan(0)

    await tryToChangeALabSetting()

    expect(posts).toEqual([])
    expect(await storedAdmin()).toEqual(SAVED)
    expect(screen.getByTestId('admin-settings-load-error')).toBeTruthy()
    expect(labSwitch()).toBeNull()
  }, 60_000)

  it('a slow load: an edit before it landed writes nothing, and after it landed the form shows the saved values', async () => {
    await seedStored(SAVED)
    installRoutes()
    let release: () => void = () => {}
    holdGets = new Promise<void>((resolve) => {
      release = resolve
    })
    renderPanel()
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await pause(300)

    await tryToChangeALabSetting()
    expect(posts).toEqual([])
    expect(await storedAdmin()).toEqual(SAVED)
    // Not editable until the load landed: the fields are not there, a plain line stands in.
    expect(screen.getByText('Loading Admin settings...')).toBeTruthy()
    expect(labSwitch()).toBeNull()

    holdGets = null
    release()
    await waitFor(() => expect(labSwitch()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByText('Loading Admin settings...')).toBeNull()
    expect(labSwitch()?.getAttribute('aria-checked')).toBe('true')
    expect(wakeupsSwitch()?.getAttribute('aria-checked')).toBe('false')
    await pause(SAVE_DEBOUNCE_PAST)

    expect(posts).toEqual([])
    expect(await storedAdmin()).toEqual(SAVED)
  }, 60_000)

  it('the load fails and Retry works: the form shows the saved values, one edit saves, and the other saved values stay', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    const notice = await screen.findByTestId('admin-settings-load-error')
    // The failure also shows in the panel's status line at the top.
    expect(document.querySelector('.batshit-settings-save-status.is-error')?.textContent).toContain(
      'Redis unavailable'
    )

    // A Retry that fails again changes nothing: the notice stays, and nothing is written.
    const readsBefore = counts.reads
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(counts.reads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    await pause(300)
    expect(screen.getByTestId('admin-settings-load-error')).toBeTruthy()
    expect(labSwitch()).toBeNull()
    expect(posts).toEqual([])

    // A Retry that works clears the notice and shows what is saved.
    failGetsWith = null
    await fireEvent.click(
      within(screen.getByTestId('admin-settings-load-error')).getByRole('button', { name: /Retry/ })
    )
    await waitFor(() => expect(labSwitch()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId('admin-settings-load-error')).toBeNull()
    // The failure is gone from the status line too (the panel's own; Auto Compact keeps its own).
    expect(document.querySelector('.batshit-settings-save-status.is-error')).toBeNull()
    expect(labSwitch()?.getAttribute('aria-checked')).toBe('true')
    expect(wakeupsSwitch()?.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Exa')).toBeTruthy()
    expect(screen.getByText('Deep')).toBeTruthy()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedAdmin()).toEqual(SAVED)

    // One edit saves that one change; every other saved value stays.
    await fireEvent.click(labSwitch() as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(await storedAdmin()).toEqual({ ...SAVED, goon_lip_sync_lab_enabled: false })
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a normal open writes nothing and a normal edit saves as before', async () => {
    await seedStored(SAVED)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(labSwitch()?.getAttribute('aria-checked')).toBe('true'), { timeout: 10_000 })
    expect(screen.queryByTestId('admin-settings-load-error')).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedAdmin()).toEqual(SAVED)

    await fireEvent.click(labSwitch() as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(await storedAdmin()).toEqual({ ...SAVED, goon_lip_sync_lab_enabled: false })
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a user with no saved settings yet opens Admin, and the first edit saves the defaults plus that edit', async () => {
    installRoutes()
    renderPanel()
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    // The load answered (no record yet): the switch is offered and enabled.
    await waitFor(() => expect(labSwitch()?.hasAttribute('disabled')).toBe(false), { timeout: 10_000 })
    expect(screen.queryByTestId('admin-settings-load-error')).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    await fireEvent.click(labSwitch() as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect((await storedAdmin())?.goon_lip_sync_lab_enabled).toBe(true)
    expect((await storedAdmin())?.web_search_default_provider).toBe('duckduckgo-html')
  }, 60_000)
})
