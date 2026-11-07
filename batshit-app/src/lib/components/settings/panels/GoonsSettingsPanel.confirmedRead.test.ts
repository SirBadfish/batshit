// @vitest-environment jsdom
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
import {
  confirmUserSettings,
  failUserSettingsRead,
  getUserSettings,
  getUserSettingsReadState,
  resetUserSettings
} from '$lib/stores/userSettings.svelte'
import type { GoonsSettings } from '$lib/types/goons'
import type { GoonRecord } from '$lib/types/goons'
import { getGoons } from '$lib/stores/goons.svelte'
import {
  beginGoonAnimationLibraryOperation, failGoonAnimationLibraryOperation,
  setGoonAnimationLibrary
} from '$lib/stores/goonAnimationLibrary.svelte'
import { captureGoonCompatibilityBasis, compatibilityOwnerForBasis } from '$lib/goons/goonCompatibilityBasis'

/**
 * The old Goons panel called the full-object helper. Keep that legacy shape available only in this
 * fixture so the pre-packet panel reaches the real settings route and demonstrates its overwrite.
 * The new panel uses the real section-patch helper from the service.
 */
vi.mock('$lib/services/goonsSettingsPersistence', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return {
    ...actual,
    persistGoonsSettingsRequest: async (fetcher: typeof fetch, settings: GoonsSettings) => {
      const response = await fetcher('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goons_settings: settings })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error ?? 'Failed to save Goon settings')
      return payload.settings.goons_settings
    }
  }
})

import GoonsSettingsPanel from './GoonsSettingsPanel.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'

useRedisTestServer()

const USER = 'bl975-confirmed-read'
const SAVED: GoonsSettings = {
  dockOpen: true,
  showCues: true,
  immersiveMode: false,
  desktop: {
    fullHeight: false,
    normalizedWidth: 0.6,
    stayOnTop: false,
    clickThrough: true,
    controlsShortcut: 'CommandOrControl+Alt+G',
    workspace: 'all-workspaces'
  },
  globalCloset: { items: { saved_coat: { id: 'saved_coat', name: 'Saved coat' } } },
  kitchen: {
    cues: { saved_cue: { kind: 'mood', name: 'Saved cue' } },
    scenes: { saved_scene: { id: 'saved_scene', name: 'Saved scene' } }
  },
  motions: { glbPreviewGoonId: 'saved-preview-goon' }
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

let settingsRoute: Awaited<ReturnType<typeof loadUserSettingsRoute>>
let failedSettingsReads = false
let routedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let posts: Array<{ body: Record<string, any> }> = []
let counts: { reads: number } = { reads: 0 }
let routedGoons: GoonRecord[] = []
let routedMotions: GoonRecord['files']['animations'] = []
let failedMotionReads = false

beforeAll(async () => {
  settingsRoute = await loadUserSettingsRoute()
}, 60_000)

async function seedSettings() {
  // This is a retained legacy Closet record, not a new production write.
  // Seed the historical fixture directly; the tested Settings route still
  // exercises the real guard and must preserve this exact sibling.
  await redis.json.set(`user:${USER}:settings`, '$', {
    id: 'settings', user_id: USER, displayName: 'Probe', goons_settings: structuredClone(SAVED)
  })
}

function installRoutes() {
  const installed = installUserSettingsRoutes({
    userId: USER,
    route: settingsRoute,
    failGetsWith: () => failedSettingsReads ? 500 : null,
    extra: (path) => {
      if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: routedGoons })
      if (path === '/api/goons/animations') return failedMotionReads
        ? new Response('Unavailable', { status: 503 })
        : jsonResponse({ ownerId: 'josh', library: { vrma: routedMotions } })
      if (path === '/api/goons/animations/converter') return jsonResponse({ installed: false })
      return undefined
    }
  })
  posts = installed.posts
  counts = installed.counts
  routedFetch = installed.fetchMock
}

function renderPanel() {
  return render(TooltipProviderWrapper, { props: { component: GoonsSettingsPanel, props: { active: true } } })
}

describe('Goons Settings requires a confirmed user-settings read (BL-975)', () => {
  beforeEach(async () => {
    ensureBrowserStubs()
    resetUserSettings()
    failedSettingsReads = false
    posts = []
    counts = { reads: 0 }
    routedGoons = []
    routedMotions = []
    failedMotionReads = false
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seedSettings()
    installRoutes()
  })

  afterEach(() => {
    resetUserSettings()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a failed settings read shows Retry and offers no saved-settings controls or writes', async () => {
    failUserSettingsRead(new Error('Redis unavailable'))
    failedSettingsReads = true
    renderPanel()

    const notice = await screen.findByTestId('goons-settings-load-error')
    expect(notice.textContent).toContain('Goons settings could not load')
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Full Height' })).toBeNull()

    const fullHeight = screen.queryByRole('switch', { name: 'Full Height' })
    if (fullHeight) await fireEvent.click(fullHeight)
    await waitFor(() => expect(posts).toEqual([]))
    expect(await storedUserSettings(USER)).toMatchObject({ goons_settings: SAVED })
  }, 60_000)

  it('shows a current Tier A report issue while preserving a legacy report as unverified', async () => {
    const current = {
      id: 'current', user_id: 'josh', name: 'Current Goon', kind: 'vrm',
      files: { vrm: { url: '/current.vrm', filename: 'current.vrm' }, animations: [] },
      created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z'
    } as GoonRecord
    const legacy = {
      id: 'legacy', user_id: 'josh', name: 'Legacy Goon', kind: 'vrm',
      files: { vrm: { url: '/legacy.vrm', filename: 'legacy.vrm' }, animations: [] },
      compatibility: { tier: 'A', issues: ['old motion warning'], animationNames: ['old-motion'],
        boneCoverage: { present: 7, total: 7 } },
      created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z'
    } as GoonRecord
    const basis = captureGoonCompatibilityBasis(current, [current, legacy], [], { eager: [], deferred: [] })
    current.compatibility = { tier: 'A', issues: ['No matching motion tracks'],
      boneCoverage: { present: 7, total: 7 }, owner: compatibilityOwnerForBasis(basis) }
    routedGoons = [current, legacy]
    confirmUserSettings({ goons_settings: SAVED })
    renderPanel()
    const tier = await screen.findByText('Tier A', {}, { timeout: 10_000 })
    expect(tier.className).toContain('is-warning')
    const legacyCard = screen.getByText('Legacy Goon').closest('.batshit-settings-display-card')
    if (!legacyCard) throw new Error('Legacy Goon card missing')
    expect(within(legacyCard as HTMLElement).getByText('Pending')).toBeTruthy()
    expect(getGoons().find((goon) => goon.id === 'legacy')?.compatibility).toEqual(legacy.compatibility)
    const trigger = tier.closest('button')
    if (!trigger) throw new Error('Tier tooltip trigger missing')
    await fireEvent.pointerEnter(trigger)
    await screen.findByText('No matching motion tracks', {}, { timeout: 3_000 })
  }, 60_000)

  it('keeps a saved global Mood motion visible when the library is unavailable', async () => {
    const settings = structuredClone(SAVED)
    settings.kitchen!.cues!.saved_cue.animationName = 'saved-wave'
    await redis.json.set(`user:${USER}:settings`, '$', {
      id: 'settings', user_id: USER, displayName: 'Probe', goons_settings: settings
    })
    confirmUserSettings({ goons_settings: settings })
    failedMotionReads = true
    renderPanel()
    await fireEvent.click(await screen.findByRole('tab', { name: 'Kitchen' }))
    await fireEvent.click(await screen.findByText('Moods'))
    await fireEvent.click(await screen.findByText('Saved cue'))
    const picker = await screen.findByRole('button', { name: 'Select Mood Loop Motion' })
    expect(picker.textContent).toContain('saved-wave')
    expect(picker.textContent).toContain('Saved · unverified')
    expect(posts).toEqual([])
  }, 60_000)

  it('retains a transient preview selection while its Motion inventory is unverified', async () => {
    routedGoons = [{ id: 'preview', user_id: 'josh', name: 'Preview Goon', files: { animations: [] },
      created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z' } as GoonRecord]
    routedMotions = [{ url: '/wave.glb', filename: 'wave.glb' }]
    confirmUserSettings({ goons_settings: SAVED })
    renderPanel()
    await fireEvent.click(await screen.findByRole('tab', { name: 'Kitchen' }))
    const trigger = await screen.findByRole('button', { name: 'Select preview Motion' })
    await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false))
    await fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    await fireEvent.click(await screen.findByText('wave'))
    await waitFor(() => expect(trigger.getAttribute('title')).toBe('Preview Motion: wave'))
    // Batch an unavailable read with a changed projection so the real panel
    // effect sees no options while the saved source is unconfirmed.
    setGoonAnimationLibrary({ vrma: [] })
    const ticket = beginGoonAnimationLibraryOperation('josh')
    failGoonAnimationLibraryOperation(ticket, 'Unavailable')
    await waitFor(() => expect(trigger.getAttribute('title')).toBe('Preview Motion: wave'))
    expect(posts).toEqual([])
  }, 60_000)

  it('Retry confirms a successful fresh settings response and then exposes the saved cards', async () => {
    failUserSettingsRead(new Error('Redis unavailable'))
    failedSettingsReads = true
    renderPanel()
    await screen.findByTestId('goons-settings-load-error')

    failedSettingsReads = false
    await fireEvent.click(screen.getByRole('button', { name: /Retry/ }))

    await waitFor(() => expect(getUserSettingsReadState()).toBe('confirmed'), { timeout: 10_000 })
    expect(counts.reads).toBeGreaterThan(0)
    expect(getUserSettings()).toMatchObject({ goons_settings: SAVED })
    expect(screen.queryByTestId('goons-settings-load-error')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Full Height' })).toBeTruthy()
  }, 60_000)

  it('a successful explicit null response confirms an empty settings record', async () => {
    failUserSettingsRead(new Error('Redis unavailable'))
    failedSettingsReads = true
    renderPanel()
    await screen.findByTestId('goons-settings-load-error')

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.split('?')[0] === '/api/user/settings') {
        return jsonResponse({ success: true, settings: null })
      }
      return routedFetch(input, init)
    })
    await fireEvent.click(screen.getByRole('button', { name: /Retry/ }))

    await waitFor(() => expect(getUserSettingsReadState()).toBe('confirmed'), { timeout: 10_000 })
    expect(getUserSettings()).toEqual({})
    expect(screen.queryByTestId('goons-settings-load-error')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Full Height' })).toBeTruthy()
  }, 60_000)

  it('a failed refresh after confirmation shows the error but retains the confirmed cards and value', async () => {
    const confirmed = { displayName: 'Probe', goons_settings: structuredClone(SAVED) }
    confirmUserSettings(confirmed as any)
    failUserSettingsRead(new Error('Refresh timed out'))
    renderPanel()

    const notice = await screen.findByTestId('goons-settings-refresh-error')
    expect(notice.textContent).toContain('last confirmed Goons settings remain in use')
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Full Height' })).toBeTruthy()
    expect(getUserSettingsReadState()).toBe('confirmed')
    expect(getUserSettings()).toEqual(confirmed)
    expect(posts).toEqual([])
  }, 60_000)

  it('a confirmed Desktop Mode edit patches only the changed key and preserves the stored siblings', async () => {
    const confirmed = { displayName: 'Probe', goons_settings: structuredClone(SAVED) }
    confirmUserSettings(confirmed as any)
    renderPanel()

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Full Height' })).toBeTruthy())
    await fireEvent.click(screen.getByRole('switch', { name: 'Full Height' }))
    await waitFor(() => expect(posts).toHaveLength(1), { timeout: 10_000 })
    await waitFor(() => expect(getUserSettings()).toMatchObject({
      goons_settings: { desktop: { ...SAVED.desktop, fullHeight: true } }
    }), { timeout: 10_000 })

    expect(posts[0].body).toEqual({ goons_settings_patch: { desktop: { fullHeight: true } } })
    expect(await storedUserSettings(USER)).toMatchObject({
      goons_settings: {
        ...SAVED,
        desktop: { ...SAVED.desktop, fullHeight: true }
      }
    })
    expect(getUserSettings()).toMatchObject({
      goons_settings: { ...SAVED, desktop: { ...SAVED.desktop, fullHeight: true } }
    })
  }, 60_000)
})
