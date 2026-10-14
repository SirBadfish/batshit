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
import { resetUserSettings } from '$lib/stores/userSettings.svelte'
import VoiceSettingsPanel from './VoiceSettingsPanel.svelte'

/**
 * BL-976: Goon lip-sync mode/analyzer and blend have different save ownership. A narration or
 * runtime edit must not replay an old form copy over a pair changed elsewhere, and a blend-only
 * edit must preserve the latest pair. The real panel talks to the real user-settings route on the
 * Redis test lane; the external change below is also a real POST through that route.
 */

useRedisTestServer()

const USER = 'vs976_lipsync_user'
const SAVE_DEBOUNCE_PAST = 1500

const LOADED_AMPLITUDE = {
  schemaVersion: 2,
  inputDeviceId: 'usb-mic-7',
  voiceSessionRuntime: 'direct',
  voiceRuntimes: { livekit: { startup: { autoStartOnLaunch: true, stopOnShutdown: false } } },
  goonLipSync: { mode: 'amplitude', analyzerId: 'rhubarb-wasm', visemeBlendMs: 65 },
  tts: {
    providerId: 'openai',
    modelId: 'tts-1-hd',
    voiceId: 'nova',
    narration: { italicBehavior: 'silent' }
  },
  stt: { providerId: 'openai', modelId: 'whisper-1' }
}

const LOADED_RHUBARB = {
  ...LOADED_AMPLITUDE,
  goonLipSync: { mode: 'viseme', analyzerId: 'rhubarb-wasm', visemeBlendMs: 60 }
}

const EXTERNAL_AUDIO2FACE = {
  ...LOADED_AMPLITUDE,
  goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 45 }
}

const AUDIO2FACE_SAME_BLEND = {
  ...LOADED_AMPLITUDE,
  goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 65 }
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
let posts: Array<{ body: Record<string, any> }> = []
let counts: { reads: number } = { reads: 0 }
let holdNextPanelPost: Promise<void> | null = null
let holdNextPanelResponse: Promise<void> | null = null
let panelResponseHoldReached: (() => void) | null = null
let panelPostResponses = 0
let queuedSettingsGetBodies: unknown[] = []
const originalFetch = global.fetch

beforeAll(async () => {
  route = await loadUserSettingsRoute()
}, 60_000)

async function seedStored(voice: Record<string, unknown>) {
  await redis.updateUserSettings(USER, { displayName: 'Lip Sync Probe', voice_settings: structuredClone(voice) })
}

async function storedVoice() {
  return (await storedUserSettings(USER))?.voice_settings
}

function installRoutes(options: { firstGetBodies?: unknown[] } = {}) {
  holdNextPanelPost = null
  holdNextPanelResponse = null
  panelResponseHoldReached = null
  panelPostResponses = 0
  queuedSettingsGetBodies = [...(options.firstGetBodies ?? [])]
  const panelRoute = {
    GET: async (event: any) => {
      if (queuedSettingsGetBodies.length > 0) return jsonResponse(queuedSettingsGetBodies.shift())
      return route.GET(event)
    },
    POST: async (event: any) => {
      const gate = holdNextPanelPost
      if (gate) {
        holdNextPanelPost = null
        await gate
      }
      const response = await route.POST(event)
      const responseGate = holdNextPanelResponse
      if (responseGate) {
        holdNextPanelResponse = null
        panelResponseHoldReached?.()
        panelResponseHoldReached = null
        await responseGate
      }
      panelPostResponses += 1
      return response
    }
  } as typeof route

  const installed = installUserSettingsRoutes({
    userId: USER,
    route: panelRoute,
    extra: (path) => {
      if (path === '/api/voice/byo/engines') return jsonResponse({ engines: [] })
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

function renderPanel() {
  return render(VoiceSettingsPanel, {
    props: { data: { user: { id: USER }, userSettings: null } as any }
  })
}

function lipSyncTrigger() {
  const trigger = queryLipSyncTrigger()
  expect(trigger, 'the 3D Goon Lip Sync select').toBeTruthy()
  return trigger as HTMLElement
}

function queryLipSyncTrigger() {
  const rows = screen.queryAllByText('3D Goon Lip Sync')
  const row = rows.map((label) => label.closest('.batshit-settings-form-row')).find((candidate) =>
    candidate?.querySelector('[data-select-trigger]')
  )
  return row?.querySelector('[data-select-trigger]') as HTMLElement | null ?? null
}

function visemeBlendSlider() {
  const label = screen.getByText('Viseme Blend')
  const slider = label.closest('.batshit-settings-form-row')?.querySelector('[role="slider"]')
  expect(slider, 'the Viseme Blend slider').toBeTruthy()
  return slider as HTMLElement
}

async function selectLipSyncOption(label: string) {
  await fireEvent.keyDown(lipSyncTrigger(), { key: 'ArrowDown' })
  await waitFor(() => expect(screen.queryAllByRole('option', { hidden: true }).length).toBeGreaterThan(0))
  const option = screen
    .getAllByRole('option', { hidden: true })
    .find((element) => (element.textContent ?? '').trim() === label)
  expect(option, `lip-sync option ${label}`).toBeTruthy()
  await fireEvent.pointerUp(option as HTMLElement, { pointerType: 'mouse' })
}

async function saveFromAnotherWindow(voiceSettings: Record<string, unknown>) {
  const request = new Request('http://localhost/api/user/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_settings: voiceSettings })
  })
  const response = await route.POST({ request, locals: { user: { id: USER } } } as any)
  expect(response.status).toBe(200)
}

async function waitForPanelPost(count: number) {
  await waitFor(() => expect(posts).toHaveLength(count), { timeout: 10_000 })
}

async function openVoiceEnginesTab() {
  await fireEvent.click(await screen.findByRole('tab', { name: 'Voice Engines' }))
}

async function openGlobalVoiceSettingsTab() {
  await fireEvent.click(await screen.findByRole('tab', { name: 'Global Voice Settings' }))
}

function startWithBatshitSwitch() {
  return screen
    .queryByText('Start with Batshit')
    ?.closest('.batshit-settings-muted-panel')
    ?.querySelector('[role="switch"]') as HTMLElement | null
}

beforeEach(() => {
  ensureBrowserStubs()
  holdNextPanelPost = null
  holdNextPanelResponse = null
  panelResponseHoldReached = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetUserSettings()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  global.fetch = originalFetch
  resetUserSettings()
})

describe('Voice Settings keeps Goon lip-sync ownership separate from unrelated and blend edits (BL-976)', () => {
  it('an older A=L1 answer cannot rebase or cancel newer B=L2 then C=L1 intent', async () => {
    await seedStored(LOADED_AMPLITUDE)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(lipSyncTrigger().textContent).toContain('Shitty but Fast'), { timeout: 10_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    let releaseA: () => void = () => {}
    let resolveAResponseHeld: () => void = () => {}
    const aResponseHeld = new Promise<void>((resolve) => {
      resolveAResponseHeld = resolve
    })
    holdNextPanelResponse = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    panelResponseHoldReached = resolveAResponseHeld

    let savingRemainedAfterB = false
    try {
      // A selects L1. The real route writes L1, but its successful HTTP response remains held.
      await selectLipSyncOption('NVIDIA Audio2Face')
      await waitForPanelPost(1)
      await waitFor(async () =>
        expect((await storedVoice()).goonLipSync).toMatchObject({ mode: 'viseme', analyzerId: 'audio2face-3d' })
      )
      await aResponseHeld

      // B selects L2 and its real route answer returns while A's older answer is still outstanding.
      await selectLipSyncOption('Rhubarb WASM')
      await waitForPanelPost(2)
      await waitFor(() => expect(panelPostResponses).toBe(1), { timeout: 10_000 })
      await pause(50)
      const statusText = document.querySelector('.batshit-settings-save-status')?.textContent ?? ''
      savingRemainedAfterB = /Saving\.\.\./i.test(statusText) && !/\bSaved\b/i.test(statusText)

      // C chooses L1 again while its autosave is still queued; then the old A=L1 response arrives.
      await selectLipSyncOption('NVIDIA Audio2Face')
      releaseA()
    } finally {
      releaseA()
    }

    await pause(SAVE_DEBOUNCE_PAST + 200)
    const finalVoice = await storedVoice()
    expect({
      savingRemainedAfterB,
      cReachedRoute: posts.length === 3,
      finalPair: finalVoice.goonLipSync,
      finalChoice: lipSyncTrigger().textContent?.trim(),
      cPairPatch: posts[2]?.body.voice_settings_patch?.goonLipSync ?? null
    }).toEqual({
      savingRemainedAfterB: true,
      cReachedRoute: true,
      finalPair: { ...AUDIO2FACE_SAME_BLEND.goonLipSync },
      finalChoice: 'NVIDIA Audio2Face',
      cPairPatch: { mode: 'viseme', analyzerId: 'audio2face-3d' }
    })
  }, 60_000)

  it('a full A answer adopts L1 and cancels a queued A+old-L0 payload after another setting is edited and undone', async () => {
    await seedStored(LOADED_AMPLITUDE)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(lipSyncTrigger().textContent).toContain('Shitty but Fast'), { timeout: 10_000 })
    await waitFor(() => expect(screen.getByText('Italic narration')).toBeTruthy(), { timeout: 10_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    let release: () => void = () => {}
    holdNextPanelPost = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstBody: Record<string, any> = {}
    try {
      const narration = screen.getByText('Italic narration').closest('.batshit-settings-form-row') as HTMLElement
      await fireEvent.click(within(narration).getByRole('switch'))
      await waitForPanelPost(1)
      firstBody = posts[0].body

      // Queue A + old L0, then return this unrelated runtime setting to its original value.
      await openVoiceEnginesTab()
      const startWithBatshit = await waitFor(() => {
        const control = startWithBatshitSwitch()
        expect(control).toBeTruthy()
        return control as HTMLElement
      })
      expect(startWithBatshit.getAttribute('aria-checked')).toBe('true')
      await fireEvent.click(startWithBatshit)
      await fireEvent.click(startWithBatshit)

      // The external L1 write lands before A is allowed to answer.
      await saveFromAnotherWindow(EXTERNAL_AUDIO2FACE)
      release()
    } finally {
      release()
    }

    // Let both the A response and any erroneous trailing full-form debounce settle before checking.
    await waitFor(async () => expect((await storedVoice()).tts.narration.italicBehavior).toBe('speak'))
    await pause(SAVE_DEBOUNCE_PAST)
    await openGlobalVoiceSettingsTab()
    const finalVoice = await storedVoice()
    expect(firstBody.voice_settings).not.toHaveProperty('goonLipSync')
    expect(firstBody.voice_settings_patch?.goonLipSync).toBeUndefined()
    expect(finalVoice.goonLipSync).toEqual(EXTERNAL_AUDIO2FACE.goonLipSync)
    expect(lipSyncTrigger().textContent).toContain('NVIDIA Audio2Face')
    expect(posts.every(({ body }) =>
      !('goonLipSync' in (body.voice_settings ?? {})) && body.voice_settings_patch?.goonLipSync === undefined
    )).toBe(true)
    expect(posts).toHaveLength(1)
  }, 60_000)

  it('an unrelated edit leaves an externally changed lip-sync pair intact and keeps a later draft through the held save', async () => {
    await seedStored(LOADED_AMPLITUDE)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(lipSyncTrigger().textContent).toContain('Shitty but Fast'), { timeout: 10_000 })
    await waitFor(() => expect(screen.getByText('Italic narration')).toBeTruthy(), { timeout: 10_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])
    expect((await storedVoice()).goonLipSync).toEqual(LOADED_AMPLITUDE.goonLipSync)

    // A real other-window/Dock write lands after this panel loaded its amplitude/Rhubarb copy.
    await saveFromAnotherWindow(EXTERNAL_AUDIO2FACE)
    expect((await storedVoice()).goonLipSync).toEqual(EXTERNAL_AUDIO2FACE.goonLipSync)

    let release: () => void = () => {}
    holdNextPanelPost = new Promise<void>((resolve) => {
      release = resolve
    })

    let firstBody: Record<string, any> = {}
    try {
      const narration = screen.getByText('Italic narration').closest('.batshit-settings-form-row') as HTMLElement
      const toggle = within(narration).getByRole('switch')
      expect(toggle.getAttribute('aria-checked')).toBe('false')
      await fireEvent.click(toggle)
      await waitForPanelPost(1)
      firstBody = posts[0].body

      // A second local draft is made while the first save is still waiting before the real route.
      await fireEvent.click(toggle)
      release()
    } finally {
      release()
    }

    await waitForPanelPost(2)
    await waitFor(async () => expect((await storedVoice()).tts.narration.italicBehavior).toBe('silent'))
    const finalVoice = await storedVoice()
    expect(firstBody.voice_settings).not.toHaveProperty('goonLipSync')
    expect(firstBody.voice_settings_patch?.goonLipSync).toBeUndefined()
    expect(lipSyncTrigger().textContent).toContain('NVIDIA Audio2Face')
    expect(finalVoice.goonLipSync).toEqual(EXTERNAL_AUDIO2FACE.goonLipSync)
    expect(toggleStillShowsSilent()).toBe(true)
    expect(posts[1].body.voice_settings).not.toHaveProperty('goonLipSync')
    expect(posts[1].body.voice_settings_patch?.goonLipSync).toBeUndefined()
    expect((await storedVoice()).goonLipSync).toEqual(EXTERNAL_AUDIO2FACE.goonLipSync)
  }, 60_000)

  it('an explicit analyzer choice sends the mode/analyzer pair as an owned patch', async () => {
    await seedStored(LOADED_AMPLITUDE)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(lipSyncTrigger().textContent).toContain('Shitty but Fast'), { timeout: 10_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    await selectLipSyncOption('NVIDIA Audio2Face')
    await waitForPanelPost(1)

    expect(posts[0].body.voice_settings).not.toHaveProperty('goonLipSync')
    expect(posts[0].body.voice_settings_patch.goonLipSync).toEqual({
      mode: 'viseme',
      analyzerId: 'audio2face-3d'
    })
    expect((await storedVoice()).goonLipSync).toMatchObject({ mode: 'viseme', analyzerId: 'audio2face-3d' })
  }, 60_000)

  it('a blend-only edit patches only blend and preserves a newer server mode/analyzer pair', async () => {
    await seedStored(LOADED_RHUBARB)
    installRoutes()
    renderPanel()
    await waitFor(() => expect(screen.getByText('Viseme Blend')).toBeTruthy(), { timeout: 10_000 })
    await waitFor(() => expect(visemeBlendSlider()).toHaveAttribute('aria-valuenow', '60'), { timeout: 10_000 })
    await pause(SAVE_DEBOUNCE_PAST)
    expect(posts).toEqual([])

    await saveFromAnotherWindow(EXTERNAL_AUDIO2FACE)
    expect((await storedVoice()).goonLipSync).toEqual(EXTERNAL_AUDIO2FACE.goonLipSync)

    const blendSlider = visemeBlendSlider()
    await fireEvent.keyDown(blendSlider, { key: 'ArrowRight' })
    await waitFor(() => expect(blendSlider).toHaveAttribute('aria-valuenow', '65'))
    await waitForPanelPost(1)

    expect(posts[0].body.voice_settings).not.toHaveProperty('goonLipSync')
    expect(posts[0].body.voice_settings_patch.goonLipSync).toEqual({ visemeBlendMs: 65 })
    expect((await storedVoice()).goonLipSync).toEqual({
      mode: 'viseme',
      analyzerId: 'audio2face-3d',
      visemeBlendMs: 65
    })
  }, 60_000)

  for (const malformed of [
    { name: 'missing settings', body: {} },
    { name: 'array settings', body: { settings: [] } }
  ]) {
    it(`an HTTP 200 with ${malformed.name} stays unreadable until Retry returns the real saved voice values`, async () => {
      await seedStored(LOADED_AMPLITUDE)
      installRoutes({ firstGetBodies: [malformed.body] })
      renderPanel()

      await waitFor(() => {
        const notice = screen.queryByTestId('voice-settings-load-error')
        const hasLoadedControls = italicSwitchForMalformedRead() !== null || queryLipSyncTrigger() !== null
        if (notice || hasLoadedControls) return
        throw new Error('waiting for the first settings read to settle')
      }, { timeout: 10_000 })

      let notice = screen.queryByTestId('voice-settings-load-error')
      if (!notice) await pause(SAVE_DEBOUNCE_PAST)
      notice = screen.queryByTestId('voice-settings-load-error')
      const controlsStayedHidden = italicSwitchForMalformedRead() === null && queryLipSyncTrigger() === null
      const writesBeforeRetry = [...posts]
      const voiceBeforeRetry = await storedVoice()

      if (notice) {
        await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
        await waitFor(() => expect(lipSyncTrigger().textContent).toContain('Shitty but Fast'), { timeout: 10_000 })
        await pause(SAVE_DEBOUNCE_PAST)
      }

      expect({
        hasUnreadableNotice: Boolean(notice),
        controlsStayedHidden,
        writesBeforeRetry,
        voiceBeforeRetry
      }).toEqual({
        hasUnreadableNotice: true,
        controlsStayedHidden: true,
        writesBeforeRetry: [],
        voiceBeforeRetry: LOADED_AMPLITUDE
      })
      expect(posts).toEqual([])
      expect(await storedVoice()).toEqual(LOADED_AMPLITUDE)
      expect(lipSyncTrigger().textContent).toContain('Shitty but Fast')
      expect(italicSwitchForMalformedRead()).not.toBeNull()
    }, 60_000)
  }
})

function italicSwitchForMalformedRead() {
  const row = screen.queryByText('Italic narration')?.closest('.batshit-settings-form-row')
  return row ? within(row as HTMLElement).queryByRole('switch') : null
}

function toggleStillShowsSilent() {
  const row = screen.getByText('Italic narration').closest('.batshit-settings-form-row') as HTMLElement
  return within(row).getByRole('switch').getAttribute('aria-checked') === 'false'
}
