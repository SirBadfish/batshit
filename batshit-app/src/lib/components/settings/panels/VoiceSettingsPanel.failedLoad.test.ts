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
import { dispatchVoiceEnginesUpdated } from '$lib/utils/voiceEngineEvents'
import VoiceSettingsPanel from './VoiceSettingsPanel.svelte'
import { get } from 'svelte/store'
import { activeConfirmDialog, resolveConfirmDialog } from '$lib/stores/confirmDialog'

/**
 * BL-962: when `GET /api/user/settings` failed, the Voice panel put the page's copy of the voice
 * settings (or the defaults) in editable fields and ended its load. The next edit posted the whole
 * `voice_settings` block built from that copy, and the route replaces the whole block, so every
 * saved voice value the copy did not hold was erased (BL-487's class, BL-939's pattern). The
 * external voice-engine refresh reloads the settings too, and a failure there swapped the form the
 * user was editing for the page's older copy. Now only a successful read counts as a loaded copy:
 * until then the controls that hold voice values (the Global Voice Settings tab, and the Voice
 * Runtimes and per-engine cards of the Voice Engines tab) are not offered, the panel says so in a
 * plain sentence with a Retry, and a Retry that works shows the saved values and saves as before.
 * A failed refresh after a good load keeps the copy it had.
 *
 * Renders the REAL panel. `/api/user/settings` goes to the REAL route handlers on the default
 * lane's Redis fake, so every assertion below reads what is STORED, not what the panel sent. The
 * other loads the panel starts on open (providers, engines, LiveKit, clones) answer fixed bodies.
 */

useRedisTestServer()

const USER = 'vs962_user'
const SAVE_DEBOUNCE_PAST = 1500

/** Saved voice values: every one differs from its default, so an erasure is visible. */
const SAVED: Record<string, any> = {
  schemaVersion: 2,
  inputDeviceId: 'usb-mic-7',
  voiceSessionRuntime: 'direct',
  voiceRuntimes: { livekit: { startup: { autoStartOnLaunch: true, stopOnShutdown: false } } },
  goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 90 },
  tts: {
    providerId: 'openai',
    modelId: 'tts-1-hd',
    voiceId: 'nova',
    narration: { italicBehavior: 'silent' }
  },
  stt: { providerId: 'openai', modelId: 'whisper-1' }
}

/** The page opened before the voice settings were last saved: a real copy, but not the saved one. */
const OLDER_PAGE_COPY = {
  voice_settings: {
    schemaVersion: 2,
    tts: { providerId: 'browser' },
    stt: { providerId: 'browser' },
    goonLipSync: { mode: 'amplitude', analyzerId: 'rhubarb-wasm' }
  }
}

const browserProvider = {
  id: 'browser',
  label: 'Browser (Web Speech API)',
  type: 'browser',
  supports: { tts: true, stt: true, listVoices: false, clone: false, streaming: false, styles: false, emotions: false },
  sttModels: [],
  ttsModels: []
}

const openaiProvider = {
  id: 'openai',
  label: 'OpenAI',
  type: 'cloud',
  ready: true,
  supports: { tts: true, stt: true, listVoices: true, clone: false, streaming: false, styles: true, emotions: false },
  sttModels: ['whisper-1'],
  defaultTtsModel: 'gpt-4o-mini-tts',
  defaultModel: 'gpt-4o-mini-tts',
  ttsModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']
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
/** Every write to the engine list (the panel's own PUT). */
let enginePuts: Array<Record<string, any>> = []
let engineRecords: Array<Record<string, any>> = []
let failRegistryRead = false
let deletes: Array<Record<string, any>> = []
type DeleteFixture = { userId?: string; outcome?: 'success' | 'terminal-error' | 'transport' | 'wrong-id' | 'wrong-provider' | 'bad-agent' | 'missing-files'; agentReadFailure?: boolean; receipt?: unknown; failAfter?: 'settings' | 'registry' }
const DELETE_ENGINE = { id: '978-engine', providerId: 'byo:978-engine', name: 'Engine 978', enabled: true,
  supportsTts: true, supportsStt: false, supportsClone: false }

async function seedStored(voice: Record<string, unknown>, userId = USER) {
  // Seed an existing saved snapshot; the whole-Voice write path intentionally normalizes input.
  await redis.json.set(`user:${userId}:settings`, '$', {
    id: `settings_${userId}`, user_id: userId, displayName: 'Probe', voice_settings: structuredClone(voice)
  })
}

async function storedVoice(userId = USER) {
  return (await storedUserSettings(userId))?.voice_settings
}

function installRoutes(options: DeleteFixture = {}) {
  const userId = options.userId ?? USER
  engineRecords = options.outcome ? [structuredClone(DELETE_ENGINE)] : []
  failRegistryRead = false
  deletes = []
  failGetsWith = null
  holdGets = null
  enginePuts = []
  const installed = installUserSettingsRoutes({
    userId,
    route,
    failGetsWith: () => failGetsWith,
    holdGets: () => holdGets,
    extra: async (path, method, init) => {
      if (path === '/api/voice/byo/engines') {
        if (method === 'PUT') enginePuts.push(JSON.parse(String(init.body)))
        if (failRegistryRead && method === 'GET') return jsonResponse({ error: 'Registry unavailable' }, 500)
        return jsonResponse({ engines: structuredClone(engineRecords) })
      }
      if (path === '/api/voice/byo/engines/978-engine' && method === 'DELETE') {
        deletes.push(JSON.parse(String(init.body)))
        if ((options.receipt as any)?.configurationOutcome === 'known_no_change') {
          return jsonResponse({ error: 'Removal refused before a write', deleteOutcome: options.receipt }, 400)
        }
        const voice = await storedVoice(userId)
        await redis.updateUserSettings(userId, { voice_settings: { ...voice, tts: { providerId: 'browser' } } })
        engineRecords = []
        if (options.failAfter === 'settings') failGetsWith = 500
        if (options.failAfter === 'registry') failRegistryRead = true
        if (options.outcome === 'transport') throw new TypeError('Connection lost after issue')
        if (options.outcome === 'terminal-error') return jsonResponse({ error: 'Cleanup write was not confirmed', ...(options.receipt ? { deleteOutcome: options.receipt } : {}) }, 400)
        return jsonResponse({ success: true, deletedEngineId: options.outcome === 'wrong-id' ? 'other-engine' : '978-engine',
          deletedProviderId: options.outcome === 'wrong-provider' ? 'byo:other-engine' : 'byo:978-engine', deletedProviderIds: ['byo:978-engine'], clearedUserDefaults: true, clearedAgentIds: options.outcome === 'bad-agent' ? [null] : options.agentReadFailure ? ['agent-978'] : [], deletedVoiceProfileIds: [],
          localFiles: options.outcome === 'missing-files' ? undefined : { requested: false, deleted: false, deletedInstallRoots: [], deletedStateRoots: [], skipped: [], errors: [] } })
      }
      if (path === '/api/agents/agent-978' && options.agentReadFailure) throw new TypeError('Agent view refresh unavailable')
      if (path === '/api/voice/runtime/livekit') return jsonResponse({ runtime: null })
      if (path === '/api/voice/providers') return jsonResponse({ providers: [browserProvider, openaiProvider] })
      if (path === '/api/voice/profiles') return jsonResponse({ profiles: [] })
      if (path === '/api/voice/voices') return jsonResponse({ voices: [] })
      return undefined
    }
  })
  posts = installed.posts
  counts = installed.counts
}

function renderPanel(userSettings: unknown = null, userId = USER) {
  return render(VoiceSettingsPanel, {
    props: { data: { user: { id: userId }, userSettings } as any }
  })
}

const italicRow = () => screen.queryByText('Italic narration')?.closest('.batshit-settings-form-row') ?? null
const italicSwitch = () => (italicRow() ? within(italicRow() as HTMLElement).getByRole('switch') : null)
const startWithBatshitSwitch = () =>
  screen
    .queryByText('Start with Batshit')
    ?.closest('.batshit-settings-muted-panel')
    ?.querySelector('[role="switch"]') as HTMLElement | null

/** The user tries to change a setting on the Global Voice Settings tab: whatever it offers, click it. */
async function tryToChangeAGlobalSetting() {
  const control = italicSwitch()
  if (control) await fireEvent.click(control)
  await pause(SAVE_DEBOUNCE_PAST)
}

async function openEnginesTab() {
  await fireEvent.click(await screen.findByRole('tab', { name: 'Voice Engines' }))
}

/** Waits until the first settings read has been asked for and the panel has ended its load. */
async function waitForLoadEnded() {
  await waitFor(() => expect(counts.reads).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
  await waitFor(() => expect(screen.queryByText('Loading Voice settings...')).toBeNull(), { timeout: 10_000 })
  await pause(300)
}

async function openDeleteFixture() {
  await openEnginesTab()
  const title = await screen.findByText('Installed Engine Controls')
  const details = title.closest('details') as HTMLDetailsElement
  if (details && !details.open) await fireEvent.click(details.querySelector('summary')!)
  await fireEvent.click(await screen.findByRole('button', { name: /Engine 978/i }))
  return screen.getByRole('button', { name: 'Delete', exact: true })
}

async function confirmEngineDelete(button: HTMLElement) {
  await fireEvent.click(button)
  const confirmation = await waitFor(() => {
    const value = get(activeConfirmDialog)
    expect(value).toBeTruthy()
    return value!
  })
  resolveConfirmDialog(confirmation.id, true)
}

describe('Voice Settings never turns a failed load into a save (BL-962)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    for (let i = 0; i < 8; i += 1) {
      const pending = get(activeConfirmDialog)
      if (!pending) break
      resolveConfirmDialog(pending.id, false)
      await Promise.resolve()
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it.each(['settings', 'registry'] as const)('BL-978(j): a confirmed delete with a failed %s refresh holds both writers until Retry reads current values', async failAfter => {
    const userId = `vs978-delete-${failAfter}`
    await seedStored({ ...SAVED, tts: { providerId: 'byo:978-engine', narration: { italicBehavior: 'silent' } } }, userId)
    installRoutes({ userId, outcome: 'success', failAfter })
    renderPanel(null, userId)
    await confirmEngineDelete(await openDeleteFixture())
    await waitFor(() => expect(deletes).toHaveLength(1))
    const notice = await screen.findByTestId('voice-settings-load-error')
    await pause(700)
    expect(posts).toEqual([])
    expect(enginePuts).toEqual([])
    expect((await storedVoice(userId)).tts.providerId).toBe('browser')
    failGetsWith = null
    failRegistryRead = false
    await fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByTestId('voice-settings-load-error')).toBeNull())
    await fireEvent.click(screen.getByRole('tab', { name: 'Global Voice Settings' }))
    const control = await waitFor(() => { expect(italicSwitch()).toBeTruthy(); return italicSwitch()! })
    await fireEvent.click(control)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body.voice_settings.tts.providerId).toBe('browser')
    expect((await storedVoice(userId)).tts.providerId).toBe('browser')
    expect(deletes).toHaveLength(1)
  }, 60_000)

  it.each(['terminal-error', 'transport', 'wrong-id', 'wrong-provider', 'bad-agent', 'missing-files'] as const)('BL-978(j): %s remains held across refresh and remount without DELETE replay', async outcome => {
    const userId = `vs978-delete-${outcome}`
    await seedStored({ ...SAVED, tts: { providerId: 'byo:978-engine' } }, userId)
    installRoutes({ userId, outcome })
    const panel = renderPanel(null, userId)
    await confirmEngineDelete(await openDeleteFixture())
    await screen.findByTestId('voice-engine-delete-notice')
    await pause(100)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    dispatchVoiceEnginesUpdated()
    await pause(700)
    expect(posts).toEqual([])
    expect(enginePuts).toEqual([])
    panel.unmount()
    renderPanel(null, userId)
    await screen.findByTestId('voice-engine-delete-notice')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    expect(italicSwitch()).toBeNull()
    expect(deletes).toHaveLength(1)
    expect(posts).toEqual([])
  }, 60_000)

  it.each(['known_no_change', 'known_settled_partial'] as const)('BL-978(j): matching %s receipt requires explicit fresh reads and retains incomplete-removal notice', async configurationOutcome => {
    const userId = `vs978-receipt-${configurationOutcome}`
    await seedStored({ ...SAVED, tts: { providerId: 'byo:978-engine', narration: { italicBehavior: 'silent' } } }, userId)
    installRoutes({ userId, outcome: 'terminal-error', receipt: {
      contract: 'voice-engine-delete-outcome/v1', engineId: '978-engine', configurationOutcome
    } })
    renderPanel(null, userId)
    const remove = await openDeleteFixture()
    const before = counts.reads
    await confirmEngineDelete(remove)
    await screen.findByTestId('voice-engine-delete-notice')
    expect(counts.reads).toBe(before)
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry).not.toBeDisabled()
    expect(posts).toEqual([])
    await fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByTestId('voice-settings-load-error')).toBeNull())
    expect(counts.reads).toBeGreaterThan(before)
    expect(screen.getByTestId('voice-engine-delete-notice').textContent).toMatch(/incomplete|did not finish/)
    await fireEvent.click(screen.getByRole('tab', { name: 'Global Voice Settings' }))
    const control = await waitFor(() => { expect(italicSwitch()).toBeTruthy(); return italicSwitch()! })
    await fireEvent.click(control)
    await waitFor(() => expect(posts).toHaveLength(1))
    const currentProvider = configurationOutcome === 'known_no_change' ? 'byo:978-engine' : 'browser'
    expect(posts[0].body.voice_settings.tts.providerId).toBe(currentProvider)
    expect((await storedVoice(userId)).tts.providerId).toBe(currentProvider)
    expect(deletes).toHaveLength(1)
    expect(screen.getByTestId('voice-engine-delete-notice')).toBeTruthy()
  }, 60_000)

  it.each([
    ['wrong engine', { contract: 'voice-engine-delete-outcome/v1', engineId: 'other-engine', configurationOutcome: 'known_no_change' }],
    ['wrong contract', { contract: 'voice-engine-delete-outcome/v2', engineId: '978-engine', configurationOutcome: 'known_no_change' }],
    ['unknown outcome', { contract: 'voice-engine-delete-outcome/v1', engineId: '978-engine', configurationOutcome: 'unknown' }],
    ['invented outcome', { contract: 'voice-engine-delete-outcome/v1', engineId: '978-engine', configurationOutcome: 'settled' }]
  ])('BL-978(j): %s receipt never releases configuration custody', async (name, receipt) => {
    const userId = `vs978-receipt-${name}`
    await seedStored(SAVED, userId)
    installRoutes({ userId, outcome: 'terminal-error', receipt })
    renderPanel(null, userId)
    await confirmEngineDelete(await openDeleteFixture())
    await screen.findByTestId('voice-engine-delete-notice')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    dispatchVoiceEnginesUpdated()
    await pause(500)
    expect(posts).toEqual([])
    expect(deletes).toHaveLength(1)
  }, 60_000)

  it('BL-978(j): a changed same-ID target during confirmation requires a new choice', async () => {
    const userId = 'vs978-delete-replaced-target'
    await seedStored(SAVED, userId)
    installRoutes({ userId, outcome: 'success' })
    renderPanel(null, userId)
    await fireEvent.click(await openDeleteFixture())
    const confirmation = await waitFor(() => { expect(get(activeConfirmDialog)).toBeTruthy(); return get(activeConfirmDialog)! })
    const before = counts.reads
    engineRecords = [{ ...DELETE_ENGINE, name: 'Replacement engine' }]
    dispatchVoiceEnginesUpdated()
    await waitFor(() => expect(counts.reads).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Replacement engine/ }).some(button => button.hasAttribute('aria-expanded'))).toBe(true))
    resolveConfirmDialog(confirmation.id, true)
    await pause(700)
    expect(deletes).toEqual([])
    expect(enginePuts).toEqual([])
  }, 60_000)

  it('BL-978(j): a failed post-success agent view read never reclassifies the confirmed DELETE as unknown', async () => {
    const userId = 'vs978-delete-followup'
    await seedStored(SAVED, userId)
    installRoutes({ userId, outcome: 'success', agentReadFailure: true })
    renderPanel(null, userId)
    await confirmEngineDelete(await openDeleteFixture())
    await waitFor(() => expect(screen.getByTestId('voice-engine-delete-notice').textContent).toContain('removal was confirmed'))
    expect(screen.queryByTestId('voice-settings-load-error')).toBeNull()
    await fireEvent.click(screen.getByRole('tab', { name: 'Global Voice Settings' }))
    await waitFor(() => expect(italicSwitch()).toBeTruthy())
    expect(deletes).toHaveLength(1)
    expect(posts).toEqual([])
  }, 60_000)

  it('BL-978(j): an edit made during confirmation refuses Delete before HTTP admission', async () => {
    const userId = 'vs978-delete-confirmation'
    await seedStored(SAVED, userId)
    installRoutes({ userId, outcome: 'success' })
    renderPanel(null, userId)
    const remove = await openDeleteFixture()
    await fireEvent.click(remove)
    const confirmation = await waitFor(() => { expect(get(activeConfirmDialog)).toBeTruthy(); return get(activeConfirmDialog)! })
    const enabledRow = screen.getByText('Enabled').closest('.batshit-settings-pill') as HTMLElement
    await fireEvent.click(within(enabledRow).getByRole('switch'))
    resolveConfirmDialog(confirmation.id, true)
    await pause(800)
    expect(deletes).toEqual([])
    expect(enginePuts).toHaveLength(1)
    expect(await storedVoice(userId)).toMatchObject(SAVED)
  }, 60_000)

  it('the load fails and the user tries an edit: no write leaves and the stored voice settings are unchanged', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForLoadEnded()

    await tryToChangeAGlobalSetting()

    expect(posts).toEqual([])
    expect(await storedVoice()).toEqual(SAVED)
    // The panel says so in a plain sentence, with a Retry, and offers no field that looks saved.
    const notice = screen.getByTestId('voice-settings-load-error')
    expect(within(notice).getByText(/Voice settings could not load, so the Global Voice Settings controls are hidden/)).toBeTruthy()
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    // The Retry icon is the one the other panels' notices use.
    expect(notice.querySelector('svg.lucide-refresh-cw')).toBeTruthy()
    expect(italicRow()).toBeNull()
    expect(screen.queryByText('Text-to-Speech (TTS)')).toBeNull()
    // The failure shows in the panel's status line too.
    expect(document.querySelector('.batshit-settings-save-status.is-error')?.textContent).toContain('Redis unavailable')
  }, 60_000)

  it('the load fails while the page carries an older copy: the copy is never written over the stored voice settings', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    renderPanel(OLDER_PAGE_COPY)
    await waitForLoadEnded()

    await tryToChangeAGlobalSetting()

    expect(posts).toEqual([])
    expect(await storedVoice()).toEqual(SAVED)
    expect(screen.getByTestId('voice-settings-load-error')).toBeTruthy()
    expect(italicRow()).toBeNull()
  }, 60_000)

  it('the load fails and the user tries an edit on the Voice Engines tab: the cards that hold voice values are hidden and nothing is written', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForLoadEnded()
    await openEnginesTab()

    const control = startWithBatshitSwitch()
    if (control) await fireEvent.click(control)
    await pause(SAVE_DEBOUNCE_PAST)

    expect(posts).toEqual([])
    expect(enginePuts).toEqual([])
    expect(await storedVoice()).toEqual(SAVED)
    const notice = screen.getByTestId('voice-settings-load-error')
    expect(
      within(notice).getByText(
        /Voice Runtimes, Text-to-Speech Engines, and Speech-to-Text Engines cards are hidden/
      )
    ).toBeTruthy()
    expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(screen.queryByText('Voice Runtimes')).toBeNull()
    expect(screen.queryByText('Text-to-Speech Engines')).toBeNull()
    expect(screen.queryByText('Speech-to-Text Engines')).toBeNull()
    // The registry of installed engines is its own record and its own load: it stays.
    expect(screen.getByText('Installed Engine Controls')).toBeTruthy()
  }, 60_000)

  // The edit-before-landing half is a guard (green on the parent code too: the autosave already
  // waited for the load); only the loading line, which stands in for the fields, is new.
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

    await tryToChangeAGlobalSetting()
    expect(posts).toEqual([])
    expect(await storedVoice()).toEqual(SAVED)
    // Not editable until the load landed: the fields are not there, a plain line stands in.
    expect(screen.getByText('Loading Voice settings...')).toBeTruthy()
    expect(italicRow()).toBeNull()

    holdGets = null
    release()
    await waitFor(() => expect(italicSwitch()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByText('Loading Voice settings...')).toBeNull()
    expect(italicSwitch()?.getAttribute('aria-checked')).toBe('false')
    await pause(SAVE_DEBOUNCE_PAST)

    expect(posts).toEqual([])
    expect(await storedVoice()).toEqual(SAVED)
  }, 60_000)

  it('the load fails and Retry works: the form shows the saved values, one edit saves, and the other saved values stay', async () => {
    await seedStored(SAVED)
    installRoutes()
    failGetsWith = 500
    renderPanel()
    await waitForLoadEnded()
    const notice = screen.getByTestId('voice-settings-load-error')

    // A Retry that fails again changes nothing: the notice stays, and nothing is written.
    const readsBefore = counts.reads
    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(counts.reads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    await pause(300)
    expect(screen.getByTestId('voice-settings-load-error')).toBeTruthy()
    expect(italicRow()).toBeNull()
    expect(posts).toEqual([])

    // A Retry that works clears the notice and shows what is saved.
    failGetsWith = null
    await fireEvent.click(
      within(screen.getByTestId('voice-settings-load-error')).getByRole('button', { name: /Retry/ })
    )
    await waitFor(() => expect(italicSwitch()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId('voice-settings-load-error')).toBeNull()
    // The failure is gone from the status line too.
    expect(document.querySelector('.batshit-settings-save-status.is-error')).toBeNull()
    expect(italicSwitch()?.getAttribute('aria-checked')).toBe('false')
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedVoice()).toEqual(SAVED)

    // One edit saves that one change; every other saved value stays.
    await fireEvent.click(italicSwitch() as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(await storedVoice()).toMatchObject({
      inputDeviceId: 'usb-mic-7',
      voiceRuntimes: { livekit: { startup: { autoStartOnLaunch: true, stopOnShutdown: false } } },
      goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d' },
      tts: { providerId: 'openai', modelId: 'tts-1-hd', voiceId: 'nova', narration: { italicBehavior: 'speak' } },
      stt: { providerId: 'openai', modelId: 'whisper-1' }
    })
  }, 60_000)

  it('a refresh that fails after a good load keeps the values the form had (never the page copy), and the next edit sends them', async () => {
    await seedStored(SAVED)
    installRoutes()
    renderPanel(OLDER_PAGE_COPY)
    await waitFor(() => expect(italicSwitch()?.getAttribute('aria-checked')).toBe('false'), { timeout: 10_000 })

    // An engine is installed elsewhere: the panel refreshes its state, and the settings read fails.
    failGetsWith = 500
    const readsBefore = counts.reads
    dispatchVoiceEnginesUpdated()
    await waitFor(() => expect(counts.reads).toBeGreaterThan(readsBefore), { timeout: 10_000 })
    await pause(500)
    // The form the user was editing is still the saved one, and nothing is written.
    expect(italicSwitch()?.getAttribute('aria-checked')).toBe('false')
    expect(posts).toEqual([])
    // The failed refresh is not silent: the status chip says so, and stays until a save lands.
    expect(document.querySelector('.batshit-settings-save-status.is-error')?.textContent).toContain(
      'Redis unavailable'
    )

    await fireEvent.click(italicSwitch() as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    // The save landed (the store answered), so the chip no longer carries the load error, though
    // the settings read still fails. Before this the error stood until the next engine event.
    expect(document.querySelector('.batshit-settings-save-status.is-error')).toBeNull()
    expect(await storedVoice()).toMatchObject({
      inputDeviceId: 'usb-mic-7',
      goonLipSync: { mode: 'viseme' },
      tts: { providerId: 'openai', modelId: 'tts-1-hd', voiceId: 'nova', narration: { italicBehavior: 'speak' } },
      stt: { providerId: 'openai', modelId: 'whisper-1' }
    })
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a normal open writes nothing and a normal edit saves as before', async () => {
    await seedStored(SAVED)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(italicSwitch()?.getAttribute('aria-checked')).toBe('false'), { timeout: 10_000 })
    expect(screen.queryByTestId('voice-settings-load-error')).toBeNull()
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect(await storedVoice()).toEqual(SAVED)

    await fireEvent.click(italicSwitch() as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts.length).toBe(1)
    expect(await storedVoice()).toMatchObject({
      inputDeviceId: 'usb-mic-7',
      tts: { providerId: 'openai', modelId: 'tts-1-hd', voiceId: 'nova', narration: { italicBehavior: 'speak' } }
    })
  }, 60_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a user with no saved voice settings yet opens Voice, and the first edit saves the defaults plus that edit', async () => {
    installRoutes()
    renderPanel()
    await waitFor(() => expect(italicSwitch()).not.toBeNull(), { timeout: 10_000 })
    expect(screen.queryByTestId('voice-settings-load-error')).toBeNull()
    expect(italicSwitch()?.getAttribute('aria-checked')).toBe('true')
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    await fireEvent.click(italicSwitch() as HTMLElement)
    await waitFor(() => expect(posts.length).toBe(1), { timeout: 5_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(await storedVoice()).toMatchObject({
      tts: { providerId: 'browser', narration: { italicBehavior: 'silent' } },
      stt: { providerId: 'browser' }
    })
  }, 60_000)
})
