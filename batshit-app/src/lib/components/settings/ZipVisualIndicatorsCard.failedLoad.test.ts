import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  installUserSettingsRoutes,
  loadUserSettingsRoute,
  storedUserSettings
} from '$lib/test-utils/userSettingsRoute'
import ZipVisualIndicatorsCard from './ZipVisualIndicatorsCard.svelte'

/**
 * BL-962 (the class of BL-939 and BL-487): when `GET /api/user/settings` failed, the Visual
 * Indicators card showed the page's copy of the settings (or the defaults) in editable switches
 * and ended its load. The next edit posted all eight visual indicator keys built from that copy,
 * and the route stores each key it is sent, so every saved switch the copy did not hold was
 * erased. Now only a successful read counts as a loaded copy: until then the switches are not
 * offered at all, the card says so in a plain sentence with a Retry, and a Retry that works
 * shows the saved values and saves as before.
 *
 * Renders the REAL card. `/api/user/settings` goes to the REAL route handlers on the default
 * lane's Redis fake, so every assertion below reads what is STORED, not what the card sent.
 */

useRedisTestServer()

const USER = 'zip962_user'
const SAVE_DEBOUNCE_PAST = 1500

/** Saved switches: every one differs from its default, so an erasure is visible. */
const SAVED: Record<string, boolean> = {
  show_zipped_badges: false,
  zipped_badges_hover_only: true,
  show_zipped_borders: false,
  zipped_borders_hover_only: false,
  show_unzipped_badges: false,
  unzipped_badges_hover_only: true,
  show_unzipped_borders: false,
  unzipped_borders_hover_only: false
}
/** The switches in the order the card draws them, as the eight keys they save. */
const SWITCH_KEYS = Object.keys(SAVED)
/** What the card holds when it has no saved record at all. */
const DEFAULTS: Record<string, boolean> = {
  show_zipped_badges: true,
  zipped_badges_hover_only: false,
  show_zipped_borders: true,
  zipped_borders_hover_only: true,
  show_unzipped_badges: true,
  unzipped_badges_hover_only: false,
  show_unzipped_borders: true,
  unzipped_borders_hover_only: true
}
/** Saved values that are NOT the card's: an edit on the card must never touch them. */
const OTHER = { displayName: 'Probe', global_custom_system_prompt: 'Keep me', upload_provider: 'local' }

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

async function seedStored(visual: Record<string, unknown>) {
  await redis.updateUserSettings(USER, { ...OTHER, ...visual })
}

/** The eight keys the card saves, as the store holds them. */
async function storedVisual() {
  const stored = (await storedUserSettings(USER)) ?? {}
  return Object.fromEntries(SWITCH_KEYS.map((key) => [key, stored[key]]))
}

/** Every stored value the card does not own. */
async function storedOther() {
  const stored = (await storedUserSettings(USER)) ?? {}
  return Object.fromEntries(Object.keys(OTHER).map((key) => [key, stored[key]]))
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

function renderCard(userSettings: unknown = null) {
  return render(ZipVisualIndicatorsCard, {
    props: { data: { user: { id: USER }, userSettings } as any }
  })
}

const switches = () => screen.queryAllByRole('switch')
const switchStates = () => switches().map((control) => control.getAttribute('aria-checked') === 'true')
const expectedStates = (values: Record<string, boolean>) => SWITCH_KEYS.map((key) => values[key])

/** The user tries to change a switch: whatever the card offers, click the first one. */
async function tryToChangeASwitch() {
  const control = switches()[0]
  if (control) await fireEvent.click(control)
  await pause(SAVE_DEBOUNCE_PAST)
}

describe('Visual Indicators never turns a failed load into a save (BL-962)', () => {
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
    renderCard()
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await waitFor(() => expect(screen.queryByText(/Loading zip visual indicator settings/)).toBeNull(), {
      timeout: 10_000
    })

    await tryToChangeASwitch()

    expect(posts).toEqual([])
    expect(await storedVisual()).toEqual(SAVED)
    expect(await storedOther()).toEqual(OTHER)
  }, 60_000)

  it('the load fails while the page carries an older copy: the copy is never written over the stored settings', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    // The page opened before the switches were last saved: a real copy, but not the saved one.
    renderCard({ ...SAVED, show_zipped_badges: true, show_unzipped_borders: true })
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await waitFor(() => expect(screen.queryByText(/Loading zip visual indicator settings/)).toBeNull(), {
      timeout: 10_000
    })

    await tryToChangeASwitch()

    expect(posts).toEqual([])
    expect(await storedVisual()).toEqual(SAVED)
    expect(await storedOther()).toEqual(OTHER)
  }, 60_000)

  it('the load fails: the card says so in plain words with a Retry, and offers no switch that looks saved', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    renderCard()
    const notice = await screen.findByTestId('zip-visual-indicators-load-error', undefined, {
      timeout: 10_000
    })

    expect(
      within(notice).getByText(
        /Visual Indicators settings could not load, so the Zipped Content and Unzipped Content switches are hidden\. Press Retry to load them\./
      )
    ).toBeTruthy()
    // The route's own message follows the plain sentence.
    expect(notice.textContent).toContain('Redis unavailable')
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(switches()).toEqual([])
    expect(screen.queryByText('Visual Indicators')).toBeNull()
    expect(screen.queryByText('Show Token Badges')).toBeNull()
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a slow load: an edit before it landed writes nothing, and after it landed the switches show the saved values', async () => {
    await seedStored(SAVED)
    installRoutes()
    let release: () => void = () => {}
    holdGets = new Promise<void>((resolve) => {
      release = resolve
    })
    renderCard()
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await pause(300)

    await tryToChangeASwitch()
    expect(posts).toEqual([])
    expect(await storedVisual()).toEqual(SAVED)
    // Not editable until the load landed: the switches are not there, a plain line stands in.
    expect(screen.getByText(/Loading zip visual indicator settings/)).toBeTruthy()
    expect(switches()).toEqual([])

    holdGets = null
    release()
    await waitFor(() => expect(switches().length).toBe(8), { timeout: 10_000 })
    expect(screen.queryByText(/Loading zip visual indicator settings/)).toBeNull()
    expect(switchStates()).toEqual(expectedStates(SAVED))
    await pause(SAVE_DEBOUNCE_PAST)

    expect(posts).toEqual([])
    expect(await storedVisual()).toEqual(SAVED)
  }, 60_000)

  it('the load fails and Retry works: the switches show the saved values, one edit saves, and the other saved values stay', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    renderCard()
    const notice = await screen.findByTestId('zip-visual-indicators-load-error', undefined, {
      timeout: 10_000
    })

    // A Retry that fails again changes nothing: the notice stays, and nothing is written.
    const readsBefore = counts.reads
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(counts.reads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    await pause(300)
    expect(screen.getByTestId('zip-visual-indicators-load-error')).toBeTruthy()
    expect(switches()).toEqual([])
    expect(posts).toEqual([])
    // The failed Retry is over, so the button is free for the next press.
    expect(
      within(screen.getByTestId('zip-visual-indicators-load-error'))
        .getByRole('button', { name: /Retry/ })
        .hasAttribute('disabled')
    ).toBe(false)

    // A Retry that works clears the notice and shows what is saved.
    failGetsWith = null
    await fireEvent.click(
      within(screen.getByTestId('zip-visual-indicators-load-error')).getByRole('button', {
        name: /Retry/
      })
    )
    await waitFor(() => expect(switches().length).toBe(8), { timeout: 10_000 })
    expect(screen.queryByTestId('zip-visual-indicators-load-error')).toBeNull()
    // The failure is gone from the card's status line too.
    expect(document.querySelector('.batshit-settings-save-status.is-error')).toBeNull()
    expect(switchStates()).toEqual(expectedStates(SAVED))
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedVisual()).toEqual(SAVED)

    // One edit saves that one change; every other saved value stays.
    await fireEvent.click(switches()[0])
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    // What the card sends for one edit is what it sent before: its eight keys and a stamp.
    expect(Object.keys(posts[0].body).sort()).toEqual([...SWITCH_KEYS, 'updated_at'].sort())
    expect(await storedVisual()).toEqual({ ...SAVED, show_zipped_badges: true })
    expect(await storedOther()).toEqual(OTHER)
  }, 60_000)

  it('a read that succeeds and says there is no record opens with the defaults, never with the page copy', async () => {
    installRoutes()
    // The page holds a copy, but the read answered: no record. The read is the only source.
    renderCard({ ...SAVED })
    await waitFor(() => expect(switches().length).toBe(8), { timeout: 10_000 })

    expect(screen.queryByTestId('zip-visual-indicators-load-error')).toBeNull()
    expect(switchStates()).toEqual(expectedStates(DEFAULTS))
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedUserSettings(USER)).toBeNull()
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a normal open writes nothing and a normal edit saves as before', async () => {
    await seedStored(SAVED)
    installRoutes()
    renderCard()
    await waitFor(() => expect(switches().length).toBe(8), { timeout: 10_000 })
    await waitFor(() => expect(switchStates()).toEqual(expectedStates(SAVED)), { timeout: 10_000 })
    expect(screen.queryByTestId('zip-visual-indicators-load-error')).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedVisual()).toEqual(SAVED)

    await fireEvent.click(switches()[0])
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(await storedVisual()).toEqual({ ...SAVED, show_zipped_badges: true })
    expect(await storedOther()).toEqual(OTHER)
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a user with no saved settings yet opens the card, and the first edit saves the defaults plus that edit', async () => {
    installRoutes()
    renderCard()
    await waitFor(() => expect(switches().length).toBe(8), { timeout: 10_000 })
    expect(screen.queryByTestId('zip-visual-indicators-load-error')).toBeNull()
    expect(switchStates()).toEqual(expectedStates(DEFAULTS))
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    await fireEvent.click(switches()[0])
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(await storedVisual()).toEqual({ ...DEFAULTS, show_zipped_badges: false })
  }, 60_000)
})
