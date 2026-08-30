import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VoiceSettingsPanel from './VoiceSettingsPanel.svelte'
import { FISH_STT_CAPABILITIES } from '$lib/data/voiceCapabilityRegistry'
import { dispatchVoiceEnginesUpdated } from '$lib/utils/voiceEngineEvents'

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
  name: 'Text-to-Speech Engines' | 'Speech-to-Text Engines' | 'Installed Engine Controls'
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
    expect(screen.queryByText('Speak AI responses')).not.toBeInTheDocument()
    expect(screen.queryByText('Auto-mute zipped content')).not.toBeInTheDocument()
    expect(screen.getAllByText('3D Goon Lip Sync').length).toBeGreaterThan(0)
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
