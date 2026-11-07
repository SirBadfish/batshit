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
let holdTunnelGet: Promise<void> | null = null
let tunnelGetStatus = 200
let holdTunnelPost: Promise<void> | null = null
let tunnelPostStatus = 200
let tunnelPostResponse: Record<string, unknown> | null = null
let tunnelPosts: Array<{ body: Record<string, any> }> = []

/** A record with Clip values and values the Clips panel does not own (which must never change). */
async function seedStored() {
  await redis.updateUserSettings(USER, {
    displayName: 'Probe',
    global_custom_system_prompt: 'A saved global prompt',
    admin_settings: { dcm_tool_name_threshold: 33 },
    ...SAVED_CLIP
  })
}

async function seedUpload(overrides: Partial<typeof SAVED_UPLOAD>) {
  await seedStored()
  const upload = { ...SAVED_UPLOAD, ...overrides }
  await redis.updateUserSettings(USER, {
    ui_settings: { ...SAVED_UI, upload_settings: upload }, upload_settings: upload
  })
  return upload
}

function managedStatus(upload: typeof SAVED_UPLOAD) {
  return { ...QUIET_TUNNEL_STATUS, autoStart: upload.cloudflared_auto_start, targetUrl: upload.cloudflared_target_url,
    tunnel: { running: true, publicUrl: upload.tunnel_url, targetUrl: upload.cloudflared_target_url,
      pid: 41000, startedAt: '2026-10-23T00:00:00.000Z', lastError: null } }
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
  holdTunnelGet = null
  tunnelGetStatus = 200
  holdTunnelPost = null
  tunnelPostStatus = 200
  tunnelPostResponse = null
  tunnelPosts = []
  const installed = installUserSettingsRoutes({
    userId: USER,
    route,
    failGetsWith: () => failGetsWith,
    holdGets: () => holdGets,
    // The status the panel asks for on open (and after a Retry that works). By default it
    // changes nothing the panel holds (auto-start off, no target, no public URL).
    extra: (path, method, init) => {
      if (path === TUNNEL_ROUTE && method === 'GET') {
        tunnelReads += 1
        const snapshot = structuredClone(tunnelStatus), gate = holdTunnelGet, status = tunnelGetStatus
        return (async () => {
          if (gate) await gate
          return jsonResponse(status === 200 ? snapshot : { error: 'Tunnel observation unavailable' }, status)
        })()
      }
      if (path === TUNNEL_ROUTE && method === 'POST') {
        tunnelPosts.push({ body: JSON.parse(String(init.body)) })
        const snapshot = structuredClone(tunnelPostResponse ?? tunnelStatus), gate = holdTunnelPost, status = tunnelPostStatus
        return (async () => {
          if (gate) await gate
          return jsonResponse(status === 200 ? snapshot : { error: 'Tunnel action unavailable' }, status)
        })()
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

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function chooseManualTunnel() {
  const trigger = screen.getByText('Managed Cloudflare tunnel').closest('button')
  if (!trigger) throw new Error('Managed tunnel selector is missing')
  await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: /Manual tunnel URL/ }), { pointerType: 'mouse' })
  await waitFor(() => expect(tunnelUrlInput()).toBeTruthy())
}

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

  it('BL-1620: an empty nested alias shows the authoritative legacy managed tunnel and an image edit preserves its choices', async () => {
    const legacy = { ...SAVED_UPLOAD, tunnel_provider: 'cloudflared_managed',
      tunnel_url: 'https://legacy-managed.trycloudflare.com', cloudflared_target_url: 'http://localhost:5610' }
    await seedStored()
    await redis.updateUserSettings(USER, {
      ui_settings: { ...SAVED_UI, upload_settings: {} }, upload_settings: legacy
    })
    const before = await storedClip()
    installRoutes()
    // Matching observation: status/hydration are not user edits. The separate
    // BL-978 differing-status autosave behavior is not repaired by this case.
    tunnelStatus = { ...QUIET_TUNNEL_STATUS, autoStart: false, targetUrl: legacy.cloudflared_target_url,
      tunnel: { running: true, publicUrl: legacy.tunnel_url, targetUrl: legacy.cloudflared_target_url,
        pid: 41000, startedAt: '2026-10-17T00:00:00.000Z', lastError: null } }
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await waitFor(() => expect(tunnelReads).toBe(1))

    expect(screen.queryByText('Managed Cloudflare tunnel')).toBeTruthy()
    expect((document.getElementById('cloudflared-target-url') as HTMLInputElement | null)?.value).toBe(legacy.cloudflared_target_url)
    expect(screen.queryByText(legacy.tunnel_url)).toBeTruthy()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(before)

    await fireEvent.click(jpegSwitch())
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toHaveLength(1)
    expect(await storedClip()).toEqual({
      ui_settings: { ...SAVED_UI, force_jpeg: true, upload_settings: legacy },
      upload_settings: legacy, upload_provider: 'local'
    })
    expect(await storedOthers()).toEqual(OTHERS)
  }, 60_000)

  it('BL-978(b): differing managed status is visible without changing saved tunnel intent or posting on mount', async () => {
    const upload = await seedUpload({ tunnel_provider: 'cloudflared_managed', cloudflared_auto_start: true,
      cloudflared_target_url: 'http://saved-target.example.com:5610', tunnel_url: 'https://saved.trycloudflare.com' })
    installRoutes()
    tunnelStatus = managedStatus({ ...upload, cloudflared_auto_start: false,
      cloudflared_target_url: 'http://observed-target.example.com:9999', tunnel_url: 'https://observed.trycloudflare.com' })
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await waitFor(() => expect(tunnelReads).toBe(1))
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedClip()).toEqual({ ...SAVED_CLIP, ui_settings: { ...SAVED_UI, upload_settings: upload }, upload_settings: upload })
    expect(screen.getByText('https://observed.trycloudflare.com')).toBeTruthy()
    expect(screen.getByText('http://observed-target.example.com:9999')).toBeTruthy()
    expect((document.getElementById('cloudflared-target-url') as HTMLInputElement).value).toBe(upload.cloudflared_target_url)
  }, 60_000)

  it('BL-978(b): a saved managed HTTPS false is not repaired by hydration or an unrelated image edit', async () => {
    const upload = await seedUpload({ tunnel_provider: 'cloudflared_managed', use_https: false,
      cloudflared_target_url: 'http://saved-target.example.com:5610', tunnel_url: 'https://saved.trycloudflare.com' })
    installRoutes()
    tunnelStatus = managedStatus(upload)
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    await fireEvent.click(jpegSwitch())
    await waitFor(() => expect(posts).toHaveLength(1))
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toHaveLength(1)
    expect((await storedClip()).upload_settings).toEqual(upload)
    expect(await storedOthers()).toEqual(OTHERS)
  }, 60_000)

  it.each([false, true])('BL-978(b): a saved manual HTTPS URL/flag=%s mounts without rewriting the flag', async use_https => {
    const upload = await seedUpload({ use_https, tunnel_url: 'https://manual.example.com' })
    installRoutes()
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect((await storedClip()).upload_settings).toEqual(upload)
    expect(document.getElementById('use-https')?.getAttribute('aria-checked')).toBe(String(use_https))
  }, 60_000)

  it('BL-978(b): successful Retry plus differing status posts nothing; a deliberate image edit preserves saved tunnel fields', async () => {
    const upload = await seedUpload({ tunnel_provider: 'cloudflared_managed', cloudflared_auto_start: true,
      cloudflared_target_url: 'http://saved-target.example.com:5610', tunnel_url: 'https://saved.trycloudflare.com' })
    installRoutes()
    failGetsWith = 503
    tunnelStatus = managedStatus({ ...upload, cloudflared_auto_start: false,
      cloudflared_target_url: 'http://observed-target.example.com:9999', tunnel_url: 'https://observed.trycloudflare.com' })
    renderPanel()
    await waitForReadAndLoadingLineGone()
    const notice = await screen.findByTestId(NOTICE)
    expect(posts).toEqual([])
    failGetsWith = null
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(jpegSwitch()).toBeTruthy())
    await waitFor(() => expect(tunnelReads).toBe(2))
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    await fireEvent.click(jpegSwitch())
    await waitFor(() => expect(posts).toHaveLength(1))
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toHaveLength(1)
    expect((await storedClip()).upload_settings).toEqual(upload)
    expect(await storedOthers()).toEqual(OTHERS)
  }, 60_000)

  it.each([{}, { settings: [] }, { settings: 7 }])('Clip subset of BL-978(i): malformed settings envelope %j never opens saving', async payload => {
    await seedStored()
    installRoutes()
    vi.spyOn(route, 'GET').mockResolvedValueOnce(jsonResponse(payload))
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await tryToChangeAClipSetting()
    expect(posts).toEqual([])
    expect(await storedClip()).toEqual(SAVED_CLIP)
    expect(switches()).toEqual([])
    expect(screen.getByTestId(NOTICE)).toBeTruthy()
  }, 60_000)

  it.each([200, 503])('BL-978(b): late status HTTP %s cannot overwrite a newer image intent or save observed tunnel fields', async status => {
    const upload = await seedUpload({ tunnel_provider: 'cloudflared_managed', cloudflared_auto_start: true,
      cloudflared_target_url: 'http://saved-target.example.com:5610', tunnel_url: 'https://saved.trycloudflare.com' })
    installRoutes()
    const gate = deferred()
    holdTunnelGet = gate.promise
    tunnelGetStatus = status
    tunnelStatus = managedStatus({ ...upload, cloudflared_auto_start: false,
      cloudflared_target_url: 'http://observed-target.example.com:9999', tunnel_url: 'https://observed.trycloudflare.com' })
    renderPanel()
    try {
      await waitForReadAndLoadingLineGone()
      await waitFor(() => expect(tunnelReads).toBe(1))
      await fireEvent.click(jpegSwitch())
      await waitFor(() => expect(posts).toHaveLength(1))
      gate.release()
      await pause(SAVE_DEBOUNCE_PAST)
      expect(posts).toHaveLength(1)
      expect((await storedClip()).upload_settings).toEqual(upload)
      expect((await storedClip()).ui_settings.force_jpeg).toBe(true)
      expect((document.getElementById('cloudflared-target-url') as HTMLInputElement).value).toBe(upload.cloudflared_target_url)
      if (status === 200) expect(screen.getByText('https://observed.trycloudflare.com')).toBeTruthy()
      else expect(screen.getByText('Tunnel observation unavailable')).toBeTruthy()
    } finally { gate.release(); await pause(SAVE_DEBOUNCE_PAST) }
  }, 60_000)

  it('BL-978(b): deliberate manual URL input detects HTTPS, while an explicit flag change remains the user choice', async () => {
    await seedUpload({ tunnel_url: 'manual.example.com', use_https: false })
    installRoutes()
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    await fireEvent.input(tunnelUrlInput()!, { target: { value: 'https://pasted.example.com' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect((await storedClip()).upload_settings).toMatchObject({ tunnel_url: 'https://pasted.example.com', use_https: true })
    await fireEvent.click(document.getElementById('use-https')!)
    await waitFor(() => expect(posts).toHaveLength(2))
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toHaveLength(2)
    expect((await storedClip()).upload_settings).toMatchObject({ tunnel_url: 'https://pasted.example.com', use_https: false })
  }, 60_000)

  it('BL-978(b): explicit Start, Stop and auto-start actions keep their request and settings behavior', async () => {
    const upload = await seedUpload({ tunnel_provider: 'cloudflared_managed', tunnel_url: '',
      cloudflared_target_url: 'http://saved-target.example.com:5610' })
    installRoutes()
    tunnelStatus = { ...managedStatus(upload), tunnel: { running: false, publicUrl: null, targetUrl: upload.cloudflared_target_url } }
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    tunnelPostResponse = managedStatus({ ...upload, tunnel_url: 'https://started.trycloudflare.com' })
    await fireEvent.click(screen.getByRole('button', { name: 'Start Tunnel', exact: true }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(tunnelPosts[0]?.body).toEqual({ action: 'start', targetUrl: upload.cloudflared_target_url, autoStart: false })
    expect((await storedClip()).upload_settings).toMatchObject({ tunnel_url: 'https://started.trycloudflare.com', use_https: true })

    tunnelPostResponse = { ...managedStatus(upload), tunnel: { running: false, publicUrl: null, targetUrl: upload.cloudflared_target_url } }
    await fireEvent.click(screen.getByRole('button', { name: 'Stop Tunnel', exact: true }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(tunnelPosts[1]?.body).toEqual({ action: 'stop' })
    expect((await storedClip()).upload_settings.tunnel_url).toBe('')

    tunnelPostResponse = managedStatus({ ...upload, cloudflared_auto_start: true, tunnel_url: 'https://configured.trycloudflare.com' })
    await fireEvent.click(switches()[2])
    await waitFor(() => expect(posts).toHaveLength(3))
    expect(tunnelPosts[2]?.body).toEqual({ action: 'set-auto-start', enabled: true, targetUrl: upload.cloudflared_target_url })
    expect((await storedClip()).upload_settings).toMatchObject({ cloudflared_auto_start: true, tunnel_url: 'https://configured.trycloudflare.com' })
  }, 60_000)

  it.each([200, 503])('BL-978(b): late Start status HTTP %s cannot replace a newer manual panel intent', async status => {
    const upload = await seedUpload({ tunnel_provider: 'cloudflared_managed',
      cloudflared_target_url: 'http://saved-target.example.com:5610' })
    installRoutes()
    tunnelStatus = { ...managedStatus(upload), tunnel: { running: false, publicUrl: null, targetUrl: upload.cloudflared_target_url } }
    const gate = deferred()
    holdTunnelPost = gate.promise
    tunnelPostStatus = status
    tunnelPostResponse = managedStatus({ ...upload, tunnel_url: 'https://old-start.trycloudflare.com' })
    renderPanel()
    try {
      await waitForReadAndLoadingLineGone()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start Tunnel', exact: true })).toBeTruthy())
      await fireEvent.click(screen.getByRole('button', { name: 'Start Tunnel', exact: true }))
      await waitFor(() => expect(tunnelPosts).toHaveLength(1))
      await chooseManualTunnel()
      await fireEvent.input(tunnelUrlInput()!, { target: { value: 'https://new-intent.example.com' } })
      await waitFor(() => expect(posts).toHaveLength(1))
      gate.release()
      await pause(SAVE_DEBOUNCE_PAST)
      expect(tunnelUrlInput()?.value).toBe('https://new-intent.example.com')
      expect(posts).toHaveLength(1)
      // Native action HTTP is route-shaped only; its physical persistence/concurrency is not claimed.
      expect(posts[0].body.upload_settings.tunnel_provider).toBe('manual')
    } finally { gate.release(); await pause(SAVE_DEBOUNCE_PAST) }
  }, 60_000)

  it('BL-978(b): Docker internal target and public status stay visible without becoming saved preferences', async () => {
    const upload = await seedUpload({ tunnel_provider: 'cloudflared_managed',
      cloudflared_target_url: 'http://saved-target.example.com:5610', tunnel_url: 'https://saved.trycloudflare.com' })
    installRoutes()
    tunnelStatus = { ...managedStatus({ ...upload, tunnel_url: 'https://sidecar.trycloudflare.com',
      cloudflared_target_url: 'http://batshit-server:5600' }), supportLevel: 'docker-sidecar',
      dockerSidecar: { status: 'running', publicUrl: 'https://sidecar.trycloudflare.com',
        targetUrl: 'http://batshit-server:5600', lastSeenAt: '2026-10-23T00:00:00.000Z', stale: false } }
    renderPanel()
    await waitForReadAndLoadingLineGone()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect((await storedClip()).upload_settings).toEqual(upload)
    expect((screen.getByLabelText('Internal Target URL') as HTMLInputElement).value).toBe('http://batshit-server:5600')
    expect(screen.getByText('https://sidecar.trycloudflare.com')).toBeTruthy()
  }, 60_000)
})
