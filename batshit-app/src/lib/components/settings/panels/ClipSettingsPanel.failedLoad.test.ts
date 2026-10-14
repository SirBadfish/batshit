import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  installUserSettingsRoutes,
  jsonResponse,
  loadUserSettingsRoute,
  storedUserSettings
} from '$lib/test-utils/userSettingsRoute'
import ClipSettingsPanel from './ClipSettingsPanel.svelte'

/**
 * BL-962 (the class of BL-939 and BL-487): when `GET /api/user/settings` failed, the Clips panel
 * showed the page's copy of the settings (or the defaults) in editable fields and ended its
 * load. The next edit posted `ui_settings` and `upload_settings` built from that copy, and the
 * route replaces both blocks whole, so every saved Clip value the copy did not hold (the
 * compression quality, the maximum size, the tunnel URL) was erased. Now only a successful read
 * counts as a loaded copy: until then the two cards that hold Clip values (Image Optimization
 * and Tunnel Access) are not offered at all, the panel says so in a plain sentence with a Retry,
 * and a Retry that works shows the saved values and saves as before.
 *
 * Renders the REAL panel. `/api/user/settings` goes to the REAL route handlers on the default
 * lane's Redis fake, so every assertion below reads what is STORED, not what the panel sent.
 */

useRedisTestServer()

const USER = 'ss962_clip_user'
/** The panel saves 500 ms after the last edit; wait past it before asserting nothing was sent. */
const SAVE_DEBOUNCE_PAST = 1200
const NOTICE = 'clip-settings-load-error'
const TUNNEL_ROUTE = '/api/native-tools/cloudflared/tunnel'

/** Saved Clip values: every one differs from its default, so an erasure is visible. */
const SAVED_UPLOAD = {
  strategy: 'local',
  storage_mode: 'local',
  tunnel_url: 'https://saved.example.com',
  use_https: true,
  tunnel_provider: 'manual',
  cloudflared_auto_start: false,
  cloudflared_target_url: ''
}
const SAVED_UI = {
  compress_images: true,
  compression_quality: 65,
  max_image_size: '1536',
  force_jpeg: false
}
const SAVED_CLIP = {
  ui_settings: { ...SAVED_UI, upload_settings: SAVED_UPLOAD },
  upload_settings: SAVED_UPLOAD,
  upload_provider: 'local'
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
let tunnelReads = 0
/** What the managed tunnel status route answers: quiet by default (it changes nothing the panel holds). */
const QUIET_TUNNEL_STATUS: Record<string, unknown> = {
  installed: true,
  command: null,
  version: null,
  reason: null,
  autoStart: false
}
let tunnelStatus: Record<string, unknown> = QUIET_TUNNEL_STATUS
/** While set, a settings GET answers this status (a failed load). */
let failGetsWith: number | null = null
/** While set, a settings GET waits for it (a slow load). */
let holdGets: Promise<void> | null = null

/** A record with Clip values and values the Clips panel does not own (which must never change). */
async function seedStored() {
  await redis.updateUserSettings(USER, {
    displayName: 'Probe',
    global_custom_system_prompt: 'A saved global prompt',
    admin_settings: { dcm_tool_name_threshold: 33 },
    ...SAVED_CLIP
  })
}

async function storedClip() {
  const stored = await storedUserSettings(USER)
  return {
    ui_settings: stored?.ui_settings,
    upload_settings: stored?.upload_settings,
    upload_provider: stored?.upload_provider
  }
}

async function storedOthers() {
  const stored = await storedUserSettings(USER)
  return {
    displayName: stored?.displayName,
    global_custom_system_prompt: stored?.global_custom_system_prompt,
    admin_settings: stored?.admin_settings
  }
}
const OTHERS = {
  displayName: 'Probe',
  global_custom_system_prompt: 'A saved global prompt',
  admin_settings: { dcm_tool_name_threshold: 33 }
}

function installRoutes() {
  failGetsWith = null
  holdGets = null
  tunnelReads = 0
  tunnelStatus = QUIET_TUNNEL_STATUS
  const installed = installUserSettingsRoutes({
    userId: USER,
    route,
    failGetsWith: () => failGetsWith,
    holdGets: () => holdGets,
    // The status the panel asks for on open (and after a Retry that works). By default it
    // changes nothing the panel holds (auto-start off, no target, no public URL).
    extra: (path, method) => {
      if (path === TUNNEL_ROUTE && method === 'GET') {
        tunnelReads += 1
        return jsonResponse(tunnelStatus)
      }
      return undefined
    }
  })
  posts = installed.posts
  counts = installed.counts
}

function renderPanel(userSettings: unknown = null) {
  return render(ClipSettingsPanel, {
    props: { data: { user: { id: USER }, userSettings } as any }
  })
}

const switches = () => Array.from(document.querySelectorAll<HTMLElement>('button[role="switch"]'))
/** The switches in card order: Resize & Compress, Always Convert to JPEG, then Use HTTPS. */
const compressSwitch = () => switches()[0]
const jpegSwitch = () => switches()[1]
const tunnelUrlInput = () => document.getElementById('tunnel-url') as HTMLInputElement | null
const loadingLine = () => screen.queryByText('Loading clip settings…')

/** The user tries to change a setting on the Clip cards: whatever the panel offers, click it. */
async function tryToChangeAClipSetting() {
  const control = compressSwitch()
  if (control) await fireEvent.click(control)
  await pause(SAVE_DEBOUNCE_PAST)
}

async function waitForReadAndLoadingLineGone() {
  await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
  await waitFor(() => expect(loadingLine()).toBeNull(), { timeout: 10_000 })
}

describe('Clip Settings never turns a failed load into a save (BL-962)', () => {
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
    await seedStored()
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForReadAndLoadingLineGone()

    await tryToChangeAClipSetting()

    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(SAVED_CLIP)
    expect(await storedOthers()).toEqual(OTHERS)
    // The panel says so in a plain sentence, with a Retry, and offers no field that looks saved.
    const notice = screen.getByTestId(NOTICE)
    expect(within(notice).getByText(/Clip settings could not load/)).toBeTruthy()
    expect(within(notice).getByText(/Redis unavailable/)).toBeTruthy()
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(switches()).toEqual([])
    expect(tunnelUrlInput()).toBeNull()
    expect(screen.queryByText('Image Optimization')).toBeNull()
    expect(screen.queryByText('Tunnel Access')).toBeNull()
  }, 60_000)

  it('the load fails while the page carries an older copy: the copy is never written over the stored settings', async () => {
    await seedStored()
    installRoutes()
    failGetsWith = 500
    // The page opened before the settings were last saved: a real copy, but not the saved one.
    renderPanel({
      ui_settings: {
        compress_images: true,
        compression_quality: 20,
        max_image_size: '512',
        force_jpeg: true,
        upload_settings: { ...SAVED_UPLOAD, tunnel_url: 'https://older.example.com' }
      }
    })
    await waitForReadAndLoadingLineGone()

    await tryToChangeAClipSetting()

    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(SAVED_CLIP)
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
    expect(switches()).toEqual([])
  }, 60_000)

  it('the load fails and the tunnel status then answers with other values: the panel changes its own copy, and still writes nothing without an edit', async () => {
    await seedStored()
    installRoutes()
    failGetsWith = 500
    // The status route reads the saved record on the server, so it can answer while the panel's
    // own read failed. Its answer lands on the panel's copy (the defaults), which differs from
    // that copy's saved signature: nothing the user did, yet the autosave sees a change.
    tunnelStatus = { ...QUIET_TUNNEL_STATUS, autoStart: true, targetUrl: 'http://elsewhere.example:9' }
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await waitFor(() => expect(tunnelReads).toBe(1), { timeout: 10_000 })
    await pause(SAVE_DEBOUNCE_PAST)

    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(SAVED_CLIP)
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
  }, 60_000)

  it('the read succeeds and says there is no record while the page still carries a copy: the defaults show, not the page copy', async () => {
    installRoutes()
    renderPanel({
      ui_settings: {
        compress_images: true,
        compression_quality: 20,
        max_image_size: '512',
        force_jpeg: true
      }
    })
    await waitForReadAndLoadingLineGone()
    await waitFor(() => expect(compressSwitch()).toBeTruthy(), { timeout: 10_000 })

    expect(screen.getByText('40%')).toBeTruthy()
    expect(screen.getByText('1024×1024 pixels')).toBeTruthy()
    expect(screen.queryByText('20%')).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a slow load shows a loading line and nothing to edit, and the form shows the saved values once it landed', async () => {
    await seedStored()
    installRoutes()
    let release: () => void = () => {}
    holdGets = new Promise<void>((resolve) => {
      release = resolve
    })
    renderPanel()
    await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    await pause(300)

    await tryToChangeAClipSetting()
    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(SAVED_CLIP)
    // Not editable until the load landed: the fields are not there, a plain line stands in.
    expect(loadingLine()).toBeTruthy()
    expect(switches()).toEqual([])

    holdGets = null
    release()
    await waitFor(() => expect(jpegSwitch()).toBeTruthy(), { timeout: 10_000 })
    expect(loadingLine()).toBeNull()
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(compressSwitch().getAttribute('aria-checked')).toBe('true')
    expect(jpegSwitch().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('65%')).toBeTruthy()
    await pause(SAVE_DEBOUNCE_PAST)

    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(SAVED_CLIP)
  }, 60_000)

  it('the load fails and Retry works: the form shows the saved values, one edit saves, and the other saved values stay', async () => {
    await seedStored()
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForReadAndLoadingLineGone()
    const notice = await screen.findByTestId(NOTICE)
    expect(tunnelReads).toBe(1)

    // A Retry that fails again changes nothing: the notice stays, and nothing is written.
    const readsBefore = counts.reads
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(counts.reads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    await pause(300)
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
    expect(switches()).toEqual([])
    expect(posts).toEqual([])
    expect(tunnelReads).toBe(1)

    // A Retry that works clears the notice and shows what is saved.
    failGetsWith = null
    await fireEvent.click(within(screen.getByTestId(NOTICE)).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(jpegSwitch()).toBeTruthy(), { timeout: 10_000 })
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(compressSwitch().getAttribute('aria-checked')).toBe('true')
    expect(jpegSwitch().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('65%')).toBeTruthy()
    expect(screen.getByText('1536×1536 pixels')).toBeTruthy()
    expect(screen.getByText('Manual tunnel URL')).toBeTruthy()
    expect(tunnelUrlInput()?.value).toBe('https://saved.example.com')
    // The tunnel card asks for its status as it does on open.
    await waitFor(() => expect(tunnelReads).toBe(2), { timeout: 10_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(SAVED_CLIP)

    // One edit saves that one change; every other saved value stays.
    await fireEvent.click(jpegSwitch())
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(Object.keys(posts[0].body).sort()).toEqual([
      'ui_settings',
      'updated_at',
      'upload_provider',
      'upload_settings'
    ])
    expect(await storedClip()).toEqual({
      ...SAVED_CLIP,
      ui_settings: { ...SAVED_UI, force_jpeg: true, upload_settings: SAVED_UPLOAD }
    })
    expect(await storedOthers()).toEqual(OTHERS)
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a normal open writes nothing and a normal edit saves as before', async () => {
    await seedStored()
    installRoutes()
    renderPanel()
    await waitFor(() => expect(jpegSwitch()?.getAttribute('aria-checked')).toBe('false'), { timeout: 10_000 })
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('65%')).toBeTruthy()
    expect(tunnelUrlInput()?.value).toBe('https://saved.example.com')
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(SAVED_CLIP)

    await fireEvent.click(jpegSwitch())
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(await storedClip()).toEqual({
      ...SAVED_CLIP,
      ui_settings: { ...SAVED_UI, force_jpeg: true, upload_settings: SAVED_UPLOAD }
    })
    expect(await storedOthers()).toEqual(OTHERS)
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a user with no saved settings yet opens Clips, and the first edit saves the defaults plus that edit', async () => {
    installRoutes()
    renderPanel()
    await waitForReadAndLoadingLineGone()
    // The load answered (no record yet): the defaults show and nothing is hidden.
    await waitFor(() => expect(compressSwitch()).toBeTruthy(), { timeout: 10_000 })
    expect(screen.queryByTestId(NOTICE)).toBeNull()
    expect(screen.getByText('40%')).toBeTruthy()
    expect(screen.getByText('1024×1024 pixels')).toBeTruthy()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    await fireEvent.click(compressSwitch())
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    const stored = await storedClip()
    expect(stored.ui_settings).toEqual({
      compress_images: false,
      compression_quality: 40,
      max_image_size: '1024',
      force_jpeg: true,
      upload_settings: stored.upload_settings
    })
    expect(stored.upload_settings).toMatchObject({
      strategy: 'local',
      tunnel_url: '',
      use_https: false,
      tunnel_provider: 'none'
    })
    expect(stored.upload_provider).toBe('local')
  }, 60_000)
})
