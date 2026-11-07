import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VoiceSettingsPanel from './VoiceSettingsPanel.svelte'
import { FISH_STT_CAPABILITIES } from '$lib/data/voiceCapabilityRegistry'
import { dispatchVoiceEnginesUpdated } from '$lib/utils/voiceEngineEvents'
import { BUNDLED_VOICE_PROVIDER_SUMMARIES } from '$lib/data/builtinVoiceProviderBaseline'

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const originalResizeObserver = globalThis.ResizeObserver

const baseVoiceSettings = {
  schemaVersion: 2,
  goonLipSync: {
    mode: 'amplitude',
    analyzerId: 'rhubarb-wasm'
  },
  tts: { providerId: 'browser' },
  stt: { providerId: 'browser' }
}

const byoEngine = {
  id: 'chatterbox-turbo',
  providerId: 'byo:chatterbox-turbo',
  name: 'Chatterbox Turbo',
  enabled: true,
  supportsTts: true,
  supportsStt: false,
  supportsClone: false,
  voiceSurface: {
    kind: 'single_voice',
    summary: 'Only one configured default voice is currently available here (default).',
    requiresDiscussion: true,
    voices: ['default']
  },
  ttsDefaults: {},
  sttDefaults: {},
  expression: { strategy: 'none' }
}

const browserProvider = {
  id: 'browser',
  label: 'Browser (Web Speech API)',
  type: 'browser',
  supports: {
    tts: true,
    stt: true,
    listVoices: false,
    clone: false,
    streaming: false,
    styles: false,
    emotions: false
  },
  sttModels: [],
  ttsModels: []
}

const openaiProvider = {
  id: 'openai',
  label: 'OpenAI',
  type: 'cloud',
  ready: true,
  supports: {
    tts: true,
    stt: true,
    listVoices: true,
    clone: false,
    streaming: false,
    styles: true,
    emotions: false
  },
  sttModels: ['whisper-1'],
  defaultTtsModel: 'gpt-4o-mini-tts',
  defaultModel: 'gpt-4o-mini-tts',
  ttsModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']
}

const fishProvider = {
  id: 'fish',
  label: 'Fish Audio',
  type: 'cloud',
  ready: true,
  supports: {
    tts: true,
    stt: true,
    listVoices: true,
    clone: false,
    streaming: true,
    styles: false,
    emotions: false
  },
  defaultSttModel: 'transcribe-1',
  defaultTtsModel: 's2-pro',
  defaultModel: 's2-pro',
  sttModels: ['transcribe-1'],
  ttsModels: ['s2-pro'],
  sttCapabilities: FISH_STT_CAPABILITIES
}

const byoProvider = {
  id: 'byo:chatterbox-turbo',
  label: 'Chatterbox Turbo',
  type: 'byo',
  ready: true,
  defaultModel: 'mlx-community/chatterbox-turbo-fp16',
  defaultVoice: 'default',
  voiceSurface: {
    kind: 'single_voice',
    summary: 'Only one configured default voice is currently available here (default).',
    requiresDiscussion: true,
    voices: ['default']
  },
  supports: {
    tts: true,
    stt: false,
    listVoices: false,
    clone: false,
    streaming: false,
    styles: false,
    emotions: false
  },
  sttModels: [],
  ttsModels: []
}

const secondByoEngine = {
  id: 'kokoro-suite',
  providerId: 'byo:kokoro-suite',
  name: 'Kokoro Suite',
  enabled: true,
  supportsTts: true,
  supportsStt: true,
  supportsClone: true,
  voiceSurface: {
    kind: 'hybrid',
    summary: 'Kokoro exposes both preset voices and clone-ready lanes.',
    requiresDiscussion: false,
    voices: ['af_sky', 'af_nova']
  },
  ttsDefaults: {},
  sttDefaults: {},
  expression: { strategy: 'none' }
}

const secondByoProvider = {
  id: 'byo:kokoro-suite',
  label: 'Kokoro Suite',
  type: 'byo',
  ready: true,
  defaultModel: 'kokoro-v1',
  defaultVoice: 'af_sky',
  voiceSurface: {
    kind: 'hybrid',
    summary: 'Kokoro exposes both preset voices and clone-ready lanes.',
    requiresDiscussion: false,
    voices: ['af_sky', 'af_nova']
  },
  supports: {
    tts: true,
    stt: true,
    listVoices: true,
    clone: true,
    streaming: false,
    styles: false,
    emotions: false
  },
  sttModels: ['whisper-large-v3'],
  ttsModels: ['kokoro-v1']
}

function jsonResponse(payload: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => payload
  })
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

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

function ensureResizeObserverStub() {
  if (typeof globalThis.ResizeObserver !== 'undefined') return

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

function stubObjectUrlApi() {
  const createObjectURL = vi.fn(() => 'blob:clone-preview')
  const revokeObjectURL = vi.fn()

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL
  })

  return { createObjectURL, revokeObjectURL }
}

async function openVoiceTab(name: 'Global Voice Settings' | 'Voice Studio' | 'Voice Engines') {
  await fireEvent.click(await screen.findByRole('tab', { name }))
}

async function openVoiceEngineSection(
  name: 'Voice Runtimes' | 'Text-to-Speech Engines' | 'Speech-to-Text Engines' | 'Installed Engine Controls'
) {
  const title = await screen.findByText(name)
  const details = title.closest('details')
  if (!details?.hasAttribute('open')) {
    const summary = title.closest('summary')
    expect(summary).toBeTruthy()
    await fireEvent.click(summary as HTMLElement)
  }
  return within(details as HTMLElement)
}

describe('VoiceSettingsPanel external engine refresh', () => {
  beforeEach(() => {
    ensureAnimateStub()
    ensureResizeObserverStub()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (originalResizeObserver) {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: originalResizeObserver
      })
    } else {
      Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: originalCreateObjectURL
      })
    }
    if (originalRevokeObjectURL) {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: originalRevokeObjectURL
      })
    }
  })

  function installEngineDraftFixture(userId: string) {
    let stored = { ...byoEngine, localRuntime: { canStopOnShutdown: true, shutdownStopPolicy: 'per-engine',
      startup: { autoStartOnLaunch: false, stopOnShutdown: false } } }
    const puts: Array<Record<string, any>> = []
    let hold: Promise<void> | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) return jsonResponse({ settings: { voice_settings: baseVoiceSettings } })
      if (url.includes('/api/voice/byo/engines')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body))
          puts.push(body)
          stored = { ...stored, ...body.engines[0] }
          const reply = structuredClone(stored)
          const gate = hold
          hold = null
          if (gate) await gate
          return jsonResponse({ engines: [reply] })
        }
        return jsonResponse({ engines: [structuredClone(stored)] })
      }
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider, byoProvider] })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    // @ts-expect-error test override
    global.fetch = fetchMock
    const panel = render(VoiceSettingsPanel, { props: { data: { user: { id: userId }, userSettings: { voice_settings: baseVoiceSettings } } } })
    return { panel, puts, setHold: (value: Promise<void>) => { hold = value }, stored: () => stored }
  }

  async function openInstalledControls() {
    await openVoiceTab('Voice Engines')
    const installed = await openVoiceEngineSection('Installed Engine Controls')
    await fireEvent.click(await installed.findByRole('button', { name: /Chatterbox Turbo/i }))
    return installed
  }

  it('shows model-specific transport badges in the actual TTS dropdown without saving on load', async () => {
    vi.useFakeTimers()
    let saved = { ...baseVoiceSettings, tts: { providerId: 'inworld', modelId: 'inworld-tts-2', voiceId: 'Zoe', profileId: '' } }
    const writes: unknown[] = []
    const inworld = BUNDLED_VOICE_PROVIDER_SUMMARIES.find(provider => provider.id === 'inworld')!
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) { if (init?.method === 'POST') writes.push(JSON.parse(String(init.body))); return jsonResponse({ settings: { voice_settings: saved } }) }
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider, { ...inworld, ready: true, ttsModels: ['inworld-tts-2', 'inworld-tts-2-flash'] }] })
      if (url.includes('/api/voice/byo/engines')) return jsonResponse({ engines: [] })
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [{ id: 'flash-profile', user_id: 'inworld-flash-test', name: 'Flash', provider: 'inworld', model: 'inworld-tts-2-flash', voiceId: 'Zoe', created_at: '2026-10-28T00:00:00.000Z', updated_at: '2026-10-28T00:00:00.000Z' }] })
      if (url.includes('/api/voice/voices')) return jsonResponse({ voices: [{ id: 'Zoe', name: 'Zoe' }] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    const panel = render(VoiceSettingsPanel, { props: { data: { user: { id: 'inworld-test' }, userSettings: { voice_settings: saved } } } })
    const label = await screen.findByText('Model', { selector: 'label' })
    const row = label.closest('.batshit-settings-form-row')!
    const trigger = row.querySelector('button[aria-haspopup="listbox"]')!
    expect(trigger).toHaveTextContent('inworld-tts-2')
    expect(trigger).toHaveTextContent('Realtime TTS')
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(await screen.findByRole('option', { name: /inworld-tts-2-flash.*Batch TTS/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^inworld-tts-2\s+Realtime TTS/ })).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual([])
    expect(saved.tts).toEqual({ providerId: 'inworld', modelId: 'inworld-tts-2', voiceId: 'Zoe', profileId: '' })
    panel.unmount()
    saved = { ...saved, tts: { ...saved.tts, modelId: '', profileId: 'flash-profile' } }
    const flashPanel = render(VoiceSettingsPanel, { props: { data: { user: { id: 'inworld-flash-test' }, userSettings: { voice_settings: saved } } } })
    await screen.findByText('Flash supports batch synthesis; Direct streaming is not available yet. Delivery mode and spoken steering instructions do not apply. Saved settings remain available for other models; non-verbal tags still work.')
    const flashLabel = await screen.findByText('Model', { selector: 'label' })
    const flashTrigger = flashLabel.closest('.batshit-settings-form-row')!.querySelector('button[aria-haspopup="listbox"]')!
    expect(flashTrigger).toHaveTextContent('inworld-tts-2-flash')
    expect(flashTrigger).toHaveTextContent('Batch TTS')
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual([])
    expect(saved.tts).toEqual({ providerId: 'inworld', modelId: '', voiceId: 'Zoe', profileId: 'flash-profile' })
    flashPanel.unmount()
  })

  it('shows MiMo design applicability from a saved profile while preserving its preset field and hydration', async () => {
    vi.useFakeTimers()
    const saved = { ...baseVoiceSettings, tts: { providerId: 'mimo', profileId: 'mimo-configured-design', voiceId: 'Chloe' } }, writes: unknown[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) { if (init?.method === 'POST') writes.push(JSON.parse(String(init.body))); return jsonResponse({ settings: { voice_settings: saved } }) }
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider, { ...BUNDLED_VOICE_PROVIDER_SUMMARIES.find(provider => provider.id === 'mimo'), ready: true }] })
      if (url.includes('/api/voice/byo/engines')) return jsonResponse({ engines: [] })
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [{ id: 'mimo-configured-design', user_id: 'mimo-applicability', name: 'Configured design', provider: 'mimo', voiceId: 'Chloe',
        model: 'mimo-v2.5-tts-voicedesign', created_at: '2026-10-28T00:00:00.000Z', updated_at: '2026-10-28T00:00:00.000Z' }] })
      if (url.includes('/api/voice/voices')) return jsonResponse({ voices: [{ id: 'Chloe', name: 'Chloe' }] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    const panel = render(VoiceSettingsPanel, { props: { data: { user: { id: 'mimo-applicability' }, userSettings: { voice_settings: saved } } } })
    await screen.findByText('Voice Design requires a voice description in Voice Engines → Instructions. The saved Voice value is kept and is not sent.')
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual([])
    expect(saved.tts).toEqual({ providerId: 'mimo', profileId: 'mimo-configured-design', voiceId: 'Chloe' })
    panel.unmount()
  })

  it('uses a selected Qwen profile model and region for the visible voice choices', async () => {
    vi.useFakeTimers()
    const endpoint = 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    const saved = { ...baseVoiceSettings, tts: { providerId: 'alibaba', profileId: 'qwen-profile', voiceId: 'longanhuan_v3.1' }, ttsEngineSettings: { alibaba: { common: { endpoint } } } }, writes: unknown[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) { if (init?.method === 'POST') writes.push(JSON.parse(String(init.body))); return jsonResponse({ settings: { voice_settings: saved } }) }
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider, { ...BUNDLED_VOICE_PROVIDER_SUMMARIES.find(provider => provider.id === 'alibaba'), ready: true }] })
      if (url.includes('/api/voice/byo/engines')) return jsonResponse({ engines: [] })
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [{ id: 'qwen-profile', user_id: 'qwen-test', name: 'Qwen', provider: 'alibaba', voiceId: 'longanhuan_v3.1', model: 'qwen-audio-3.1-tts-flash', created_at: '2026-10-28T00:00:00.000Z', updated_at: '2026-10-28T00:00:00.000Z' }] })
      if (url.includes('/api/voice/voices')) return jsonResponse({ voices: [{ id: 'Cherry', name: 'Cherry', provider: 'alibaba' }] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    const panel = render(VoiceSettingsPanel, { props: { data: { user: { id: 'qwen-test' }, userSettings: { voice_settings: saved } } } })
    await screen.findByText('Qwen Audio requires the workspace endpoint for your key’s region and a voice supported by the chosen model. Language hints vary by model and voice.')
    const label = screen.getByText('Voice', { selector: 'label' })
    const row = label.closest('.batshit-settings-form-row')!
    const trigger = row.querySelector('button')!
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(await screen.findByRole('option', { name: 'longanhuan_v3.1', exact: true })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Cherry', exact: true })).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual([])
    panel.unmount()
  })

  it('refreshes catalog metadata on focus without replacing a pending custom model or saving hydration', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let phase: 'initial' | 'updated' | 'malformed' = 'initial', providerReads = 0
    let saved = { ...baseVoiceSettings, tts: { providerId: 'openai', modelId: 'gpt-4o-mini-tts', voiceId: 'alloy' } }
    const writes: any[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) {
        if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); writes.push(body); saved = { ...saved, ...body.voice_settings } }
        return jsonResponse({ settings: { voice_settings: saved } })
      }
      if (url.includes('/api/voice/providers')) {
        providerReads += 1
        if (phase === 'malformed') return jsonResponse({ providers: {} })
        const modelCatalog = { source: 'remote', sourceStatus: 'verified', lastVerifiedAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), stale: false,
          discoveryCoverage: 'complete', qualificationCoverage: 'pending', unavailableCount: phase === 'updated' ? 2 : 0 }
        return jsonResponse({ providers: [browserProvider, { ...openaiProvider, modelCatalog }] })
      }
      if (url.includes('/api/voice/byo/engines')) return jsonResponse({ engines: [] })
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      if (url.includes('/api/voice/voices')) return jsonResponse({ voices: [] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    global.fetch = fetchMock
    const panel = render(VoiceSettingsPanel, { props: { data: { user: { id: 'catalog-focus' }, userSettings: { voice_settings: saved } } } })
    await screen.findByText('Text-to-Speech (TTS)')
    await waitFor(() => expect(providerReads).toBe(1))
    expect(writes).toEqual([])
    const ttsSection = screen.getByText('Text-to-Speech (TTS)').closest('details') as HTMLElement
    const modelRow = within(ttsSection).getByText('Model', { selector: 'label' }).closest('.batshit-settings-form-row') as HTMLElement
    await fireEvent.click(within(modelRow).getByRole('button', { name: 'Enter manually' }))
    const input = await screen.findByPlaceholderText('gpt-4o-mini-tts') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'custom-unsent-model' } })
    phase = 'updated'
    await fireEvent(window, new Event('focus'))
    await screen.findByText('2 model updates await compatibility checks.')
    expect(input.value).toBe('custom-unsent-model')
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].voice_settings.tts.modelId).toBe('custom-unsent-model')
    phase = 'malformed'
    await fireEvent(window, new Event('focus'))
    await screen.findByText('The voice provider list could not be read. Previous choices are kept.')
    expect(input.value).toBe('custom-unsent-model')
    await vi.advanceTimersByTimeAsync(700)
    expect(writes).toHaveLength(1)
    panel.unmount()
    const reads = providerReads
    await fireEvent(window, new Event('focus'))
    expect(providerReads).toBe(reads)
  })

  it('does not offer cloud-ready fallback after an unreadable first provider response or save the preserved custom ID', async () => {
    vi.useFakeTimers()
    const writes: unknown[] = [], saved = { ...baseVoiceSettings, tts: { providerId: 'openai', modelId: 'saved-custom-model', voiceId: 'alloy' } }
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) { if (init?.method === 'POST') writes.push(JSON.parse(String(init.body))); return jsonResponse({ settings: { voice_settings: saved } }) }
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: {} })
      if (url.includes('/api/voice/byo/engines')) return jsonResponse({ engines: [] })
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      if (url.includes('/api/voice/voices')) return jsonResponse({ voices: [] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    const panel = render(VoiceSettingsPanel, { props: { data: { user: { id: 'catalog-first-unreadable' }, userSettings: { voice_settings: saved } } } })
    await screen.findByText('The voice provider list could not be read. Previous choices are kept.')
    const section = screen.getByText('Text-to-Speech (TTS)').closest('details') as HTMLElement
    const modelRow = within(section).getByText('Model', { selector: 'label' }).closest('.batshit-settings-form-row') as HTMLElement
    const model = within(modelRow).getByPlaceholderText('gpt-4o-mini-tts') as HTMLInputElement
    expect(model.value).toBe('saved-custom-model')
    expect(within(modelRow).queryByRole('button', { name: /saved-custom-model/ })).toBeNull()
    expect(within(section).getByText('Voice model compatibility could not be read. Saved choices are kept.')).toBeTruthy()
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual([])
    panel.unmount()
  })

  it('keeps a deliberate choice available when catalog narrowing leaves one different healthy model', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let narrowed = false, saved = { ...baseVoiceSettings, tts: { providerId: 'openai', modelId: 'gpt-4o-mini-tts', voiceId: 'alloy' } }
    const writes: any[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) { if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); writes.push(body); saved = { ...saved, ...body.voice_settings } }; return jsonResponse({ settings: { voice_settings: saved } }) }
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider, { ...openaiProvider, ttsModels: narrowed ? ['tts-1'] : openaiProvider.ttsModels,
        modelCatalog: { source: 'retained', sourceStatus: 'verified', lastVerifiedAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), stale: false,
          discoveryCoverage: 'complete', qualificationCoverage: narrowed ? 'blocked' : 'pending', unavailableCount: narrowed ? 1 : 0 } }] })
      if (url.includes('/api/voice/byo/engines')) return jsonResponse({ engines: [] })
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      if (url.includes('/api/voice/voices')) return jsonResponse({ voices: [] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    const panel = render(VoiceSettingsPanel, { props: { data: { user: { id: 'catalog-one-healthy' }, userSettings: { voice_settings: saved } } } })
    await screen.findByText('Text-to-Speech (TTS)')
    const section = screen.getByText('Text-to-Speech (TTS)').closest('details') as HTMLElement
    const modelRow = within(section).getByText('Model', { selector: 'label' }).closest('.batshit-settings-form-row') as HTMLElement
    await waitFor(() => expect(within(modelRow).getByRole('button', { name: /gpt-4o-mini-tts/ }).textContent).toContain('gpt-4o-mini-tts'))
    narrowed = true
    await fireEvent(window, new Event('focus'))
    await screen.findByText('1 model update awaits compatibility checks.')
    const trigger = within(modelRow).getByRole('button', { name: /gpt-4o-mini-tts/ })
    expect(trigger.textContent).toContain('gpt-4o-mini-tts')
    expect(trigger).not.toHaveAttribute('disabled')
    expect(writes).toEqual([])
    await fireEvent.click(within(modelRow).getByRole('button', { name: 'Enter manually' }))
    const manual = within(modelRow).getByPlaceholderText('gpt-4o-mini-tts')
    await fireEvent.input(manual, { target: { value: 'tts-1' } })
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].voice_settings.tts.modelId).toBe('tts-1')
    panel.unmount()
  })

  it('BL-978(k): a held Engine Manager acknowledgement preserves a later startup draft', async () => {
    const fixture = installEngineDraftFixture('voice978-engine-ack')
    const installed = await openInstalledControls()
    const enabled = within((await installed.findByText('Enabled')).closest('.batshit-settings-pill') as HTMLElement).getByRole('switch')
    const startup = within((await installed.findByText('Start with Batshit')).closest('.batshit-settings-pill') as HTMLElement).getByRole('switch')
    let release = () => {}
    fixture.setHold(new Promise<void>(resolve => { release = resolve }))
    try {
      await fireEvent.click(enabled)
      await waitFor(() => expect(fixture.puts).toHaveLength(1))
      await fireEvent.click(startup)
      release()
      await waitFor(() => expect(startup).toHaveAttribute('aria-checked', 'true'))
      await waitFor(() => expect(fixture.puts).toHaveLength(2))
    } finally { release() }
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(fixture.puts).toHaveLength(2)
    expect(fixture.stored().localRuntime.startup).toEqual({ autoStartOnLaunch: true, stopOnShutdown: false })
    expect(fixture.puts.every(body => !('ttsDefaults' in body.engines[0]) && !('sttDefaults' in body.engines[0]))).toBe(true)
  })

  it('BL-978(k): unmount revokes the queued Engine Manager timer', async () => {
    const fixture = installEngineDraftFixture('voice978-engine-unmount')
    const installed = await openInstalledControls()
    const enabled = within((await installed.findByText('Enabled')).closest('.batshit-settings-pill') as HTMLElement).getByRole('switch')
    await fireEvent.click(enabled)
    fixture.panel.unmount()
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(fixture.puts).toEqual([])
    expect(fixture.stored().enabled).toBe(true)
  })

  it('BL-978(k): a malformed Engine Manager reply is an error, never a confirmed empty list or save', async () => {
    const writes: string[] = []
    let readable = false
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (init?.method === 'POST' || init?.method === 'PUT') writes.push(url)
      if (url.includes('/api/user/settings')) return jsonResponse({ settings: { voice_settings: baseVoiceSettings } })
      if (url.includes('/api/voice/byo/engines')) return jsonResponse(readable ? { engines: [] } : {})
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider] })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    // @ts-expect-error test override
    global.fetch = fetchMock
    render(VoiceSettingsPanel, { props: { data: { user: { id: 'voice978-malformed-engines' }, userSettings: null } } })
    await openVoiceTab('Voice Engines')
    const installed = await openVoiceEngineSection('Installed Engine Controls')
    const notice = await installed.findByTestId('voice-engines-load-error')
    expect(installed.getByRole('button', { name: 'Connect Existing' })).toBeDisabled()
    expect(installed.queryByText('No BYO engines registered yet.')).toBeNull()
    readable = true
    await fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(installed.queryByTestId('voice-engines-load-error')).toBeNull())
    expect(installed.getByRole('button', { name: 'Connect Existing' })).not.toBeDisabled()
    expect(installed.getByText('No BYO engines registered yet.')).toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(writes).toEqual([])
  })

  it('BL-978(e): an older Engine Manager window omits registry defaults on an unrelated edit', async () => {
    const oldEngine = {
      ...byoEngine,
      iconRef: { kind: 'brand', slug: 'openai-mono' },
      ttsDefaults: { modelId: 'old-tts-model', voiceId: 'old-voice' },
      sttDefaults: { modelId: 'old-stt-model', language: 'en' },
      localRuntime: {
        canStopOnShutdown: true, shutdownStopPolicy: 'per-engine',
        startup: { autoStartOnLaunch: false, stopOnShutdown: false }
      }
    }
    let storedEngine = structuredClone(oldEngine)
    const puts: Array<Record<string, any>> = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) return jsonResponse({ settings: { voice_settings: baseVoiceSettings } })
      if (url.includes('/api/voice/byo/engines')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body))
          puts.push(body)
          storedEngine = { ...storedEngine, ...body.engines[0] }
        }
        return jsonResponse({ engines: [structuredClone(storedEngine)] })
      }
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ runtime: null })
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider, byoProvider] })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    // @ts-expect-error test override
    global.fetch = fetchMock
    render(VoiceSettingsPanel, { props: { data: { user: { id: 'josh' }, userSettings: { voice_settings: baseVoiceSettings } } } })
    await openVoiceTab('Voice Engines')
    const installedSection = await openVoiceEngineSection('Installed Engine Controls')
    await fireEvent.click(await installedSection.findByRole('button', { name: /Chatterbox Turbo/i }))
    const enabledRow = (await installedSection.findByText('Enabled')).closest('.batshit-settings-pill') as HTMLElement
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(puts).toEqual([])

    // A separate writer changes registry defaults after this panel read the old summary.
    const currentTts = { modelId: 'current-tts-model', voiceId: 'current-voice' }
    const currentStt = { modelId: 'current-stt-model', language: 'fr' }
    storedEngine = { ...storedEngine, ttsDefaults: currentTts, sttDefaults: currentStt }
    await fireEvent.click(within(enabledRow).getByRole('switch'))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ engines: [{
      id: oldEngine.id, enabled: false, iconRef: oldEngine.iconRef,
      localRuntime: { startup: { autoStartOnLaunch: false, stopOnShutdown: false } }
    }] })
    expect(storedEngine.ttsDefaults).toEqual(currentTts)
    expect(storedEngine.sttDefaults).toEqual(currentStt)
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(puts).toHaveLength(1)
  })

  it('no longer shows the old auto-mute zipped content toggle', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({ engines: [] })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({
          runtime: null
        })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await screen.findByRole('tab', { name: 'Global Voice Settings' })
    // BL-962: the controls appear once the saved settings have been read.
    expect((await screen.findAllByText('3D Goon Lip Sync')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Speak AI responses')).not.toBeInTheDocument()
    expect(screen.queryByText('Auto-mute zipped content')).not.toBeInTheDocument()
    const previewInput = screen.getByLabelText('Voice Preview')
    expect(previewInput).toHaveAttribute('type', 'text')
    expect(previewInput).toHaveAttribute('name', 'voice-preview-phrase')
    expect(previewInput).toHaveAttribute('data-lpignore', 'true')
    expect(previewInput).toHaveValue('Hey! This is a quick voice test from Batshit.')
  })

  it('offers the tested managed LiveKit update and installs it before restart', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({ settings: { voice_settings: baseVoiceSettings } })
      }
      if (url.includes('/api/voice/byo/engines')) return jsonResponse({ engines: [] })
      if (url.includes('/api/voice/providers')) {
        return jsonResponse({ providers: [browserProvider] })
      }
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      if (url.includes('/api/voice/runtime/livekit')) {
        if (init?.method === 'POST') {
          return jsonResponse({
            runtime: {
              id: 'livekit',
              name: 'LiveKit',
              installed: true,
              selected: false,
              autoStartOnLaunch: false,
              status: 'ready',
              statusHint: 'Sidecar worker is ready.',
              healthUrl: 'http://127.0.0.1:7899/worker',
              agentName: 'batshit-livekit-agent',
              updateAvailable: false,
              installedVersion: '1.6.3',
              targetVersion: '1.6.3',
              started: true,
              restarted: true
            }
          })
        }
        return jsonResponse({
          runtime: {
            id: 'livekit',
            name: 'LiveKit',
            installed: true,
            selected: false,
            autoStartOnLaunch: false,
            status: 'unreachable',
            statusHint: 'A tested LiveKit runtime update is available.',
            healthUrl: 'http://127.0.0.1:7899/worker',
            agentName: null,
            updateAvailable: true,
            installedVersion: '1.4.3',
            targetVersion: '1.6.3',
            server: {
              managed: true,
              status: 'ready',
              statusHint: 'Local LiveKit server is reachable.',
              url: 'http://127.0.0.1:7880',
              containerName: null,
              image: null,
              installScope: 'native-managed',
              version: '1.12.0',
              targetVersion: '1.13.5',
              updateAvailable: true
            }
          }
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock
    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: { voice_settings: baseVoiceSettings }
        }
      }
    })

    await openVoiceTab('Voice Engines')
    expect(await screen.findByText('Update available')).toBeInTheDocument()
    expect(screen.getByText(/Agent 1\.4\.3 -> 1\.6\.3/)).toBeInTheDocument()
    expect(screen.getByText(/Server 1\.12\.0 -> 1\.13\.5/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Update & Restart' }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([input, init]) =>
          resolveUrl(input).includes('/api/voice/runtime/livekit') && init?.method === 'POST'
      )
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
        operation: 'install',
        forceRestart: true
      })
    })
  })

  it('refreshes Voice Engines when an external voice-engine event is dispatched', async () => {
    let byoLoadCount = 0

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        byoLoadCount += 1
        return jsonResponse({
          engines: byoLoadCount === 1 ? [] : [byoEngine]
        })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({ status: 'not-installed' })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: byoLoadCount === 1 ? [browserProvider] : [browserProvider, byoProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await openVoiceTab('Voice Engines')
    await waitFor(() => expect(byoLoadCount).toBe(1))
    expect(screen.queryByText('Chatterbox Turbo')).not.toBeInTheDocument()

    dispatchVoiceEnginesUpdated({
      source: 'tool-result',
      controlId: 'sys.voice.engine.register'
    })

    await waitFor(() => expect(byoLoadCount).toBeGreaterThanOrEqual(2))
    const ttsSection = await openVoiceEngineSection('Text-to-Speech Engines')
    await ttsSection.findByRole('button', { name: /Chatterbox Turbo/i })
  })

  it('separates dictation, Voice Mode, LiveKit bridge, and recorded-turn STT in the global voice UI', async () => {
    const voiceSettings = {
      ...baseVoiceSettings,
      voiceSessionRuntime: 'livekit',
      tts: { providerId: 'fish', modelId: 's2-pro' },
      stt: { providerId: 'fish', modelId: 'transcribe-1' },
      realtimeStt: { providerId: 'fish', modelId: 'transcribe-1' }
    }

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: voiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({ engines: [] })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({
          runtime: {
            id: 'livekit',
            name: 'LiveKit',
            installed: true,
            selected: true,
            autoStartOnLaunch: false,
            status: 'ready',
            statusHint: 'Ready',
            healthUrl: 'http://127.0.0.1:7880',
            agentName: 'local'
          }
        })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider, fishProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      if (url.includes('/api/voice/voices')) {
        return jsonResponse({ voices: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: voiceSettings
          }
        }
      }
    })

    await screen.findByText('Voice Lane Map')
    expect(screen.getByText('Voice Mode (Input/STT + TTS)')).toBeInTheDocument()
    expect(screen.getAllByText('Voice Mode Input').length).toBeGreaterThan(0)
    expect(screen.getAllByText('LiveKit Bridge (room + sidecar)').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Recorded turn').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Realtime TTS').length).toBeGreaterThan(0)
    expect(
      screen.getByText('Fish Audio records one turn at a time in Voice Mode. It is not continuous microphone STT.')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'LiveKit Bridge is room transport for Batshit STT/TTS. True speech-to-speech comes from a LiveKit-enabled model preset.'
      )
    ).toBeInTheDocument()
  })

  it('connects an already running voice engine from Installed Engine Controls', async () => {
    let saved = false
    let postedPayload: { engineId: string; payload: Record<string, unknown> } | null = null

    const connectedEngine = {
      ...byoEngine,
      id: 'launch-kokoro',
      providerId: 'byo:launch-kokoro',
      name: 'Launch Kokoro',
      enabled: false
    }

    const connectedProvider = {
      ...byoProvider,
      id: 'byo:launch-kokoro',
      label: 'Launch Kokoro',
      ready: false
    }

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/health')) {
        return jsonResponse({ ready: true, statusHint: 'Ready' })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({ status: 'not-installed' })
      }

      if (url.includes('/api/voice/byo/engines')) {
        if (init?.method === 'POST') {
          postedPayload = JSON.parse(init.body as string) as {
            engineId: string
            payload: Record<string, unknown>
          }
          saved = true
          return jsonResponse({
            success: true,
            created: true,
            engine: connectedEngine,
            engines: [connectedEngine]
          })
        }

        return jsonResponse({ engines: saved ? [connectedEngine] : [] })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: saved ? [browserProvider, connectedProvider] : [browserProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await openVoiceTab('Voice Engines')
    const installedSection = await openVoiceEngineSection('Installed Engine Controls')
    await fireEvent.click(await installedSection.findByRole('button', { name: /Connect Existing/i }))
    await fireEvent.input(installedSection.getByLabelText('Name'), { target: { value: 'Launch Kokoro' } })
    await fireEvent.input(installedSection.getByLabelText('Base URL'), {
      target: { value: 'http://host.docker.internal:8010/' }
    })
    await fireEvent.input(installedSection.getByLabelText('Model'), { target: { value: 'kokoro-v1' } })
    await fireEvent.input(installedSection.getByLabelText('Voice'), { target: { value: 'af_sky' } })
    await fireEvent.click(installedSection.getByRole('button', { name: /Save & Check/i }))

    await waitFor(() => expect(postedPayload).toBeTruthy())
    expect(postedPayload).toMatchObject({
      engineId: 'launch-kokoro',
      payload: {
        name: 'Launch Kokoro',
        baseUrl: 'http://host.docker.internal:8010/',
        supportsTts: true,
        supportsStt: false,
        requestFormat: 'openai-compatible',
        modelId: 'kokoro-v1',
        voiceId: 'af_sky',
        enabled: false
      }
    })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/voice/byo/health?provider=byo%3Alaunch-kokoro')
    )
  })

  it('shows the local file delete option for Batshit-managed local engines', async () => {
    const managedEngine = {
      ...byoEngine,
      localRuntime: {
        installOwnership: 'batshit-managed',
        startup: {
          autoStartOnLaunch: false
        }
      }
    }

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({ status: 'not-installed' })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({ engines: [managedEngine] })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider, byoProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await openVoiceTab('Voice Engines')
    const installedSection = await openVoiceEngineSection('Installed Engine Controls')
    await fireEvent.click(await installedSection.findByRole('button', { name: /Chatterbox Turbo/i }))

    expect(await installedSection.findByText('Delete local files too')).toBeInTheDocument()
  })

  it.each(['per-engine', 'all-owned'] as const)('shows %s runtime controls without changing saved OFF preferences, including an unrelated save', async (policy) => {
    vi.useFakeTimers()
    const storedVoice = { ...baseVoiceSettings, voiceRuntimes: { livekit: { startup: { stopOnShutdown: false, autoStartOnLaunch: false } } } }
    const managedEngine = {
      ...byoEngine,
      localRuntime: {
        installOwnership: 'batshit-managed', canStopOnShutdown: true, shutdownStopPolicy: policy,
        startup: { autoStartOnLaunch: false, stopOnShutdown: false }
      }
    }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) {
        const saved = init?.method === 'POST' ? JSON.parse(String(init.body)).voice_settings : storedVoice
        return jsonResponse({ settings: { voice_settings: saved } })
      }
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({
        runtime: { id: 'livekit', name: 'LiveKit', installed: false, selected: false, autoStartOnLaunch: false,
          status: 'not-installed', statusHint: 'Not installed.', healthUrl: '', agentName: null },
        runtimeContext: { localVoiceEngineStopPolicy: policy }
      })
      if (url.includes('/api/voice/byo/engines')) {
        const saved = init?.method === 'PUT' ? JSON.parse(String(init.body)).engines[0] : null
        return jsonResponse({ engines: [saved ? { ...managedEngine, ...saved, localRuntime: { ...managedEngine.localRuntime, ...saved.localRuntime } } : managedEngine] })
      }
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider, byoProvider] })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    // @ts-expect-error test override
    global.fetch = fetchMock
    render(VoiceSettingsPanel, { props: { data: { user: { id: 'josh' }, userSettings: { voice_settings: storedVoice } } } })
    await openVoiceTab('Voice Engines')
    const runtimeSection = await openVoiceEngineSection('Voice Runtimes')
    const stopLabel = policy === 'all-owned' ? 'Always Stop with Batshit' : 'Stop with Batshit'
    const liveKitStopRow = (await runtimeSection.findByText(stopLabel)).closest('.batshit-settings-muted-panel') as HTMLElement
    const liveKitStop = within(liveKitStopRow).getByRole('switch')
    expect(liveKitStop).toHaveAttribute('aria-checked', policy === 'all-owned' ? 'true' : 'false')
    expect(liveKitStop.hasAttribute('disabled')).toBe(policy === 'all-owned')
    const installedSection = await openVoiceEngineSection('Installed Engine Controls')
    await fireEvent.click(await installedSection.findByRole('button', { name: /Chatterbox Turbo/i }))
    const engineStopRow = (await installedSection.findByText(stopLabel)).closest('.batshit-settings-pill') as HTMLElement
    const engineStop = within(engineStopRow).getByRole('switch')
    expect(engineStop).toHaveAttribute('aria-checked', policy === 'all-owned' ? 'true' : 'false')
    expect(engineStop.hasAttribute('disabled')).toBe(policy === 'all-owned')
    await vi.advanceTimersByTimeAsync(700)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT' || init?.method === 'POST')).toHaveLength(0)

    const engineStartRow = (await installedSection.findByText('Start with Batshit')).closest('.batshit-settings-pill') as HTMLElement
    await fireEvent.click(within(engineStartRow).getByRole('switch'))
    await openVoiceEngineSection('Voice Runtimes')
    const liveKitStartRow = (await runtimeSection.findByText('Start with Batshit')).closest('.batshit-settings-muted-panel') as HTMLElement
    await fireEvent.click(within(liveKitStartRow).getByRole('switch'))
    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => {
      const engineSave = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      const voiceSave = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(engineSave).toBeTruthy()
      expect(voiceSave).toBeTruthy()
      const engineBody = JSON.parse(String(engineSave?.[1]?.body)).engines[0].localRuntime
      expect(engineBody.startup.stopOnShutdown).toBe(false)
      expect(engineBody).not.toHaveProperty('shutdownStopPolicy')
      expect(JSON.parse(String(voiceSave?.[1]?.body)).voice_settings.voiceRuntimes.livekit.startup.stopOnShutdown).toBe(false)
    })
  })

  // A saved record the registry cannot read (a newer Batshit wrote it) is kept unchanged on the
  // server, which names it beside the engines it lists; the card says so instead of hiding it.
  async function renderInstalledEnginesWith(unreadableEngines: unknown[]) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings')) {
        return jsonResponse({ settings: { voice_settings: baseVoiceSettings } })
      }
      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({ status: 'not-installed' })
      }
      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({ engines: [byoEngine], unreadableEngines })
      }
      if (url.includes('/api/voice/providers')) {
        return jsonResponse({ providers: [browserProvider, byoProvider] })
      }
      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: { data: { user: { id: 'josh' }, userSettings: { voice_settings: baseVoiceSettings } } }
    })

    await openVoiceTab('Voice Engines')
    return openVoiceEngineSection('Installed Engine Controls')
  }

  it('says when a saved engine record cannot be read, and that it is kept unchanged', async () => {
    const installedSection = await renderInstalledEnginesWith([
      { scope: 'record', id: 'dots-tts-mf', reason: 'has settings this Batshit does not know: futureOption' }
    ])

    const notice = await installedSection.findByText(/A saved engine can.t be read: dots-tts-mf/)
    expect(notice).toHaveTextContent('has settings this Batshit does not know: futureOption')
    expect(notice).toHaveTextContent("Batshit keeps it unchanged and won't edit or delete it.")
    expect(notice).toHaveClass('batshit-settings-inline-alert', 'is-warning')
  })

  it('a record with no usable id is one engine, not the whole list', async () => {
    const installedSection = await renderInstalledEnginesWith([
      { scope: 'record', id: null, reason: 'id: Invalid input: expected string, received undefined' }
    ])

    const notice = await installedSection.findByText(/A saved engine can.t be read: an engine with no usable id/)
    expect(notice).toHaveTextContent('id: Invalid input')
    expect(notice).not.toHaveTextContent('engine list')
  })

  it('says when the saved engine list as a whole cannot be read', async () => {
    const installedSection = await renderInstalledEnginesWith([
      { scope: 'list', id: null, reason: 'it is format version 2, and this Batshit reads version 1' }
    ])

    const notice = await installedSection.findByText(/The saved engine list can.t be read \(it is format version 2/)
    expect(notice).toHaveTextContent("Batshit keeps it unchanged and won't change it.")
  })

  it('shows BYO default model and voice hints when the provider has no remote voice list', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: {
              ...baseVoiceSettings,
              tts: { providerId: 'byo:chatterbox-turbo' }
            }
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({
          engines: [byoEngine]
        })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({ status: 'not-installed' })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider, byoProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: {
              ...baseVoiceSettings,
              tts: { providerId: 'byo:chatterbox-turbo' }
            }
          }
        }
      }
    })

    await screen.findByText('Text-to-Speech (TTS)')
    await screen.findByDisplayValue('mlx-community/chatterbox-turbo-fp16')
    await screen.findByText('default')
  })

  it('shows a voice coverage warning for narrow BYO voice surfaces', async () => {
    ensureAnimateStub()

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({
          engines: [byoEngine]
        })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider, byoProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await openVoiceTab('Voice Engines')
    const installedSection = await openVoiceEngineSection('Installed Engine Controls')
    await installedSection.findByText('Discuss voices')
    await fireEvent.click(installedSection.getByRole('button', { name: /Chatterbox Turbo/i }))
    await installedSection.findByText('Voice Coverage Note')
    await installedSection.findByText('Only one configured default voice is currently available here (default).')
  })

  it('keeps Text-to-Speech Engines to one open accordion at a time', async () => {
    ensureAnimateStub()

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({
          engines: [byoEngine, secondByoEngine]
        })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({ status: 'not-installed' })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider, byoProvider, secondByoProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await openVoiceTab('Voice Engines')
    const ttsSection = await openVoiceEngineSection('Text-to-Speech Engines')

    const chatterboxButton = ttsSection.getByRole('button', { name: /Chatterbox Turbo/i })
    const kokoroButton = ttsSection.getByRole('button', { name: /Kokoro Suite/i })

    await fireEvent.click(chatterboxButton)
    await waitFor(() => expect(chatterboxButton).toHaveAttribute('aria-expanded', 'true'))
    expect(kokoroButton).toHaveAttribute('aria-expanded', 'false')

    await fireEvent.click(kokoroButton)
    await waitFor(() => expect(kokoroButton).toHaveAttribute('aria-expanded', 'true'))
    expect(chatterboxButton).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows a playable preview for uploaded clone reference audio', async () => {
    const { createObjectURL } = stubObjectUrlApi()
    const cloneCapableProvider = {
      ...byoProvider,
      supports: {
        ...byoProvider.supports,
        clone: true
      }
    }
    const cloneCapableEngine = {
      ...byoEngine,
      supportsClone: true
    }

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({
          engines: [cloneCapableEngine]
        })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider, cloneCapableProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await openVoiceTab('Voice Studio')
    await screen.findByText('Voice Clones')
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(fileInput).not.toBeNull()

    const file = new File(['voice sample'], 'reference.wav', { type: 'audio/wav' })
    await fireEvent.change(fileInput!, {
      target: {
        files: [file]
      }
    })

    expect(createObjectURL).toHaveBeenCalledWith(file)
    await screen.findByText('Reference Audio Preview')
    await screen.findByText('reference.wav')

    const audio = document.querySelector('audio')
    expect(audio).not.toBeNull()
    expect(audio?.getAttribute('src')).toBe('blob:clone-preview')
  })

  it('can transcribe the uploaded reference audio into the transcript field', async () => {
    const { createObjectURL } = stubObjectUrlApi()
    const cloneCapableProvider = {
      ...secondByoProvider
    }
    const cloneCapableEngine = {
      ...secondByoEngine
    }

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)

      if (url.includes('/api/voice/transcribe') && init?.method === 'POST') {
        const form = init.body as FormData
        expect(form.get('provider')).toBe('openai')
        expect(form.get('audio')).toBeInstanceOf(File)
        expect(form.get('model')).toBe('whisper-1')
        return jsonResponse({ text: 'This is the cloned sample transcript.' })
      }

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: {
              ...baseVoiceSettings,
              stt: {
                providerId: 'openai',
                modelId: 'whisper-1'
              }
            }
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({
          engines: [cloneCapableEngine]
        })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider, openaiProvider, cloneCapableProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: {
              ...baseVoiceSettings,
              stt: {
                providerId: 'openai',
                modelId: 'whisper-1'
              }
            }
          }
        }
      }
    })

    await openVoiceTab('Voice Studio')
    await screen.findByText('Voice Clones')

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(fileInput).not.toBeNull()

    const file = new File(['voice sample'], 'reference.wav', { type: 'audio/wav' })
    await fireEvent.change(fileInput!, {
      target: {
        files: [file]
      }
    })

    expect(createObjectURL).toHaveBeenCalledWith(file)

    await fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }))

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Paste what the reference speaker says if you know it.')).toHaveValue(
        'This is the cloned sample transcript.'
      )
    })
  })

  it('saves provider default changes through the shared auto-save path', async () => {
    vi.useFakeTimers()

    let savedVoiceSettings: Record<string, any> | null = null

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings') && init?.method === 'POST') {
        savedVoiceSettings = JSON.parse(String(init.body)).voice_settings
        return jsonResponse({
          settings: {
            voice_settings: savedVoiceSettings
          }
        })
      }

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({ engines: [] })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await screen.findByText('Text-to-Speech (TTS)')
    const manualButtons = screen.getAllByRole('button', { name: 'Enter manually' })
    const ttsManualButton = manualButtons.at(-1)
    expect(ttsManualButton).toBeTruthy()
    await fireEvent.click(ttsManualButton as HTMLElement)
    const ttsModelInput = screen.getByPlaceholderText('gpt-4o-mini-tts')
    await fireEvent.input(ttsModelInput, { target: { value: 'demo-voice-model' } })

    await vi.advanceTimersByTimeAsync(700)

    await waitFor(() => {
      expect(savedVoiceSettings?.tts?.modelId).toBe('demo-voice-model')
    })
    expect(savedVoiceSettings).not.toHaveProperty('speakResponses')
    expect(savedVoiceSettings).not.toHaveProperty('playbackRate')
    expect(savedVoiceSettings).not.toHaveProperty('volume')
  })

  it('saves the italic narration speech preference through the shared auto-save path', async () => {
    vi.useFakeTimers()

    let savedVoiceSettings: Record<string, any> | null = null

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings') && init?.method === 'POST') {
        savedVoiceSettings = JSON.parse(String(init.body)).voice_settings
        return jsonResponse({
          settings: {
            voice_settings: savedVoiceSettings
          }
        })
      }

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: baseVoiceSettings
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({ engines: [] })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({ status: 'not-installed' })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: baseVoiceSettings
          }
        }
      }
    })

    await screen.findByText('Text-to-Speech (TTS)')
    const row = screen.getByText('Italic narration').closest('.batshit-settings-form-row')
    expect(row).toBeTruthy()
    const rowTools = within(row as HTMLElement)
    const narrationSwitch = rowTools.getByRole('switch')
    expect(narrationSwitch).toHaveAttribute('aria-checked', 'true')

    await fireEvent.click(narrationSwitch)
    await vi.advanceTimersByTimeAsync(700)

    await waitFor(() => {
      expect(savedVoiceSettings?.tts?.narration?.italicBehavior).toBe('silent')
    })
    expect(rowTools.getByText('Silent')).toBeInTheDocument()
  })

  it('SA-120 P9 (LS-060): a stored Quick Actions ON survives an unrelated save, and the switch flips it through the same auto-save path', async () => {
    vi.useFakeTimers()

    const stored = {
      ...baseVoiceSettings,
      voiceMode: { inputMode: 'stt', submitMode: 'auto', autoSubmitDelayMs: 1000, endOfTurnThreshold: 0.7, jevJuiceQuickActions: true }
    }
    const saves: Array<Record<string, any>> = []

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)
      if (url.includes('/api/user/settings') && init?.method === 'POST') {
        const voice = JSON.parse(String(init.body)).voice_settings
        saves.push(voice)
        return jsonResponse({ settings: { voice_settings: voice } })
      }
      if (url.includes('/api/user/settings')) return jsonResponse({ settings: { voice_settings: stored } })
      if (url.includes('/api/voice/byo/engines')) return jsonResponse({ engines: [] })
      if (url.includes('/api/voice/runtime/livekit')) return jsonResponse({ status: 'not-installed' })
      if (url.includes('/api/voice/providers')) return jsonResponse({ providers: [browserProvider] })
      if (url.includes('/api/voice/profiles')) return jsonResponse({ profiles: [] })
      throw new Error(`Unhandled fetch: ${url}`)
    })
    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, { props: { data: { user: { id: 'josh' }, userSettings: { voice_settings: stored } } } })
    await screen.findByText('Text-to-Speech (TTS)')

    const quickActions = screen.getByRole('switch', { name: /Judge Juice: Quick Actions/i })
    expect(quickActions).toHaveAttribute('aria-checked', 'true')

    // An unrelated edit (the italic narration switch) must carry the field along, not drop it.
    // The panel names the voiceMode fields one by one in its payload; the first live proof lost
    // the switch to exactly that.
    const narrationRow = screen.getByText('Italic narration').closest('.batshit-settings-form-row')
    await fireEvent.click(within(narrationRow as HTMLElement).getByRole('switch'))
    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].voiceMode).toMatchObject({ inputMode: 'stt', submitMode: 'auto', jevJuiceQuickActions: true, jevJuiceQuickActionsWakeWordRequired: true, jevJuiceQuickActionsWakeWord: 'Yo' })

    // P9b: the wake word saves through the same path; a bad word is refused in the field and never saved.
    const wakeWord = screen.getByLabelText('Wake Word') as HTMLInputElement
    expect(wakeWord.value).toBe('Yo')
    await fireEvent.input(wakeWord, { target: { value: 'Hey Bat' } })
    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1].voiceMode).toMatchObject({ jevJuiceQuickActions: true, jevJuiceQuickActionsWakeWord: 'Hey Bat' })
    await fireEvent.input(wakeWord, { target: { value: 'one two three four' } })
    await vi.advanceTimersByTimeAsync(700)
    expect(saves).toHaveLength(2)
    expect(screen.getByText(/one to three plain words/)).toBeInTheDocument()

    const wakeRequired = screen.getByRole('switch', { name: /Require Wake Word/i })
    expect(wakeRequired).toHaveAttribute('aria-checked', 'true')
    await fireEvent.click(wakeRequired)
    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => expect(saves).toHaveLength(3))
    expect(saves[2].voiceMode.jevJuiceQuickActionsWakeWordRequired).toBe(false)

    await fireEvent.click(quickActions)
    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => expect(saves).toHaveLength(4))
    expect(saves[3].voiceMode.jevJuiceQuickActions).toBe(false)
    expect(quickActions).toHaveAttribute('aria-checked', 'false')
  })

  it('shows BYO speed default as a placeholder and clearing it removes the saved override', async () => {
    let savedVoiceSettings: Record<string, any> | null = null
    const byoEngineWithSpeedField = {
      ...byoEngine,
      uiSchema: {
        fields: [
          {
            id: 'speed',
            type: 'number',
            label: 'Speed',
            path: 'tts.common.speed',
            defaultValue: 1,
            min: 0.25,
            max: 4,
            step: 0.05
          }
        ]
      }
    }

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveUrl(input)

      if (url.includes('/api/user/settings') && init?.method === 'POST') {
        savedVoiceSettings = JSON.parse(String(init.body)).voice_settings
        return jsonResponse({
          settings: {
            voice_settings: savedVoiceSettings
          }
        })
      }

      if (url.includes('/api/user/settings')) {
        return jsonResponse({
          settings: {
            voice_settings: {
              ...baseVoiceSettings,
              tts: {
                providerId: 'byo:chatterbox-turbo'
              }
            }
          }
        })
      }

      if (url.includes('/api/voice/byo/engines')) {
        return jsonResponse({
          engines: [byoEngineWithSpeedField]
        })
      }

      if (url.includes('/api/voice/runtime/livekit')) {
        return jsonResponse({ status: 'not-installed' })
      }

      if (url.includes('/api/voice/providers')) {
        return jsonResponse({
          providers: [browserProvider, byoProvider]
        })
      }

      if (url.includes('/api/voice/profiles')) {
        return jsonResponse({ profiles: [] })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    // @ts-expect-error test override
    global.fetch = fetchMock

    render(VoiceSettingsPanel, {
      props: {
        data: {
          user: { id: 'josh' },
          userSettings: {
            voice_settings: {
              ...baseVoiceSettings,
              tts: {
                providerId: 'byo:chatterbox-turbo'
              }
            }
          }
        }
      }
    })

    await openVoiceTab('Voice Engines')
    const ttsSection = await openVoiceEngineSection('Text-to-Speech Engines')
    await fireEvent.click(await ttsSection.findByRole('button', { name: /Chatterbox Turbo/i }))

    const speedInput = ttsSection.getByRole('spinbutton')
    expect(speedInput).toHaveAttribute('placeholder', 'Default: 1')
    expect((speedInput as HTMLInputElement).value).toBe('')

    await fireEvent.input(speedInput, { target: { value: '1.35' } })

    await waitFor(() => {
      expect(savedVoiceSettings?.ttsEngineSettings?.['byo:chatterbox-turbo']?.common?.speed).toBe(1.35)
    })

    await fireEvent.input(speedInput, { target: { value: '' } })
    expect((speedInput as HTMLInputElement).value).toBe('')

    await waitFor(() => {
      expect(savedVoiceSettings?.ttsEngineSettings).toBeUndefined()
    })
  })
})
