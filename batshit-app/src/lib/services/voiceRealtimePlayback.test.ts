import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const voicePlaybackMock = vi.hoisted(() => ({
  setActiveSpeech: vi.fn(),
  clearActiveSpeech: vi.fn(),
  updateQueueCount: vi.fn(),
  clearQueueCounts: vi.fn()
}))

const userSettingsMock = vi.hoisted(() => ({
  getUserSettings: vi.fn()
}))

const realtimePlayerMock = vi.hoisted(() => {
  class MockRealtimePcmAudioPlayer {
    static instances: MockRealtimePcmAudioPlayer[] = []

    readonly audio: HTMLAudioElement
    readonly options: unknown
    start = vi.fn(async () => {})
    enqueue = vi.fn()
    finish = vi.fn(async () => {})
    stop = vi.fn()

    constructor(options: unknown) {
      this.options = options
      this.audio = document.createElement('audio')
      MockRealtimePcmAudioPlayer.instances.push(this)
    }
  }

  return { MockRealtimePcmAudioPlayer }
})

const liveKitPublishMock = vi.hoisted(() => ({
  publishAudioElementToLiveKitRoom: vi.fn()
}))

const lipSyncAnalysisMock = vi.hoisted(() => ({
  analyzeAudioLedGoonLipSync: vi.fn()
}))

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn()
}))

const audioMock = vi.hoisted(() => {
  class MockAudio {
    static instances: MockAudio[] = []

    onloadedmetadata: (() => void) | null = null
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    playbackRate = 1
    volume = 1
    preload = ''
    currentTime = 0
    duration = 0.5
    src: string
    pause = vi.fn()
    load = vi.fn()
    removeAttribute = vi.fn((name: string) => {
      if (name === 'src') this.src = ''
    })
    play = vi.fn(async () => {
      setTimeout(() => {
        this.onended?.()
      }, 0)
    })

    constructor(src = '') {
      this.src = src
      MockAudio.instances.push(this)
    }
  }

  return { MockAudio }
})

vi.mock('$lib/stores/userSettings.svelte', () => ({
  getUserSettings: (...args: any[]) => userSettingsMock.getUserSettings(...args)
}))

vi.mock('$lib/stores/voicePlayback.svelte', () => ({
  setActiveSpeech: (...args: any[]) => voicePlaybackMock.setActiveSpeech(...args),
  clearActiveSpeech: (...args: any[]) => voicePlaybackMock.clearActiveSpeech(...args),
  updateQueueCount: (...args: any[]) => voicePlaybackMock.updateQueueCount(...args),
  clearQueueCounts: (...args: any[]) => voicePlaybackMock.clearQueueCounts(...args)
}))

vi.mock('$lib/services/realtimePcmAudioPlayer', () => ({
  RealtimePcmAudioPlayer: realtimePlayerMock.MockRealtimePcmAudioPlayer
}))

vi.mock('$lib/services/liveKitVoiceClient', () => ({
  publishAudioElementToLiveKitRoom: (...args: any[]) =>
    liveKitPublishMock.publishAudioElementToLiveKitRoom(...args)
}))

vi.mock('$lib/services/goonLipSyncAnalysis', () => ({
  analyzeAudioLedGoonLipSync: (...args: any[]) =>
    lipSyncAnalysisMock.analyzeAudioLedGoonLipSync(...args)
}))

vi.mock('svelte-sonner', () => ({
  toast: toastMock
}))

import { resolveVoiceSettingsForSpeech, VoiceService } from '$lib/services/voice'

const createRealtimeResponse = (...events: Array<Record<string, unknown>>) => {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`))
        controller.close()
      }
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson'
      }
    }
  )
}

const pcmBase64 = () => btoa(String.fromCharCode(0, 0, 120, 0, 0, 0, 120, 0))

const realtimeStartEvent = () => ({
  type: 'start',
  provider: 'fish',
  format: 'pcm',
  mediaType: 'audio/pcm;rate=24000',
  sampleRate: 24000,
  channels: 1
})

const realtimeAudioEvent = () => ({
  type: 'audio',
  audioBase64: pcmBase64(),
  byteLength: 8,
  chunkSeq: 0
})

const realtimeEndEvent = () => ({
  type: 'end',
  elapsedMs: 120,
  chunkCount: 1,
  audioBytes: 8
})

const inworldRealtimeStartEvent = () => ({
  type: 'start',
  provider: 'inworld',
  model: 'inworld-tts-2',
  voiceId: 'Dennis',
  mediaType: 'audio/pcm;rate=24000',
  audioFormat: 'pcm_s16le',
  sampleRate: 24000,
  channels: 1
})

const inworldRealtimeAudioEvent = () => ({
  type: 'audio',
  sequence: 1,
  audioBase64: pcmBase64(),
  byteLength: 8,
  content: 'Hello Josh',
  chunkSeq: 0,
  chunkAudioOffsetSec: 0,
  alignment: {
    audio_duration: 0.8,
    segments: [
      {
        text: 'Hello',
        start: 0.1,
        end: 0.5,
        phoneticDetails: [
          {
            phoneSymbol: 'h',
            startTimeSeconds: 0.1,
            durationSeconds: 0.08,
            visemeSymbol: 'cdgknstxyz'
          },
          {
            phoneSymbol: 'eh',
            startTimeSeconds: 0.18,
            durationSeconds: 0.07,
            visemeSymbol: 'aei'
          }
        ]
      },
      {
        text: 'Josh',
        start: 0.5,
        end: 0.8,
        phoneticDetails: [
          {
            phoneSymbol: 'j',
            startTimeSeconds: 0.5,
            durationSeconds: 0.1,
            visemeSymbol: 'chjsh'
          }
        ]
      }
    ]
  }
})

const createControlledRealtimeStream = () => {
  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      }
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson'
      }
    }
  )

  const write = (event: Record<string, unknown>) => {
    if (!streamController) throw new Error('Realtime stream is not ready.')
    streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
  }

  const close = () => {
    streamController?.close()
  }

  return { response, write, close }
}

describe('VoiceService realtime playback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    realtimePlayerMock.MockRealtimePcmAudioPlayer.instances.length = 0
    audioMock.MockAudio.instances.length = 0
    lipSyncAnalysisMock.analyzeAudioLedGoonLipSync.mockReset()
    liveKitPublishMock.publishAudioElementToLiveKitRoom.mockResolvedValue({
      track: {},
      publication: {},
      stop: vi.fn(async () => {})
    })
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'fish'
        },
        goonLipSync: {
          mode: 'amplitude'
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lets an agent italic narration override win over the global speech setting', () => {
    const effective = resolveVoiceSettingsForSpeech(
      {
        schemaVersion: 2,
        tts: {
          providerId: 'fish',
          narration: {
            italicBehavior: 'speak'
          }
        }
      },
      {
        schemaVersion: 2,
        tts: {
          narration: {
            italicBehavior: 'silent'
          }
        }
      }
    )

    expect(effective.tts?.providerId).toBe('fish')
    expect(effective.tts?.narration?.italicBehavior).toBe('silent')
  })

  it('uses the direct realtime stream route, dispatches playback events, and keeps Markdown out of the spoken text', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return createRealtimeResponse(
        realtimeStartEvent(),
        realtimeAudioEvent(),
        realtimeEndEvent()
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const starts: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleStart = (event: Event) => starts.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-start', handleStart)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('**Hello realtime** from Fish.', {
        voice: {
          provider: 'fish',
          voiceId: 'voice-123'
        },
        agentId: 'agent-1',
        messageId: 'message-1',
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/voice/stream',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      )
      expect(fetchMock).not.toHaveBeenCalledWith(
        '/api/voice/synthesize',
        expect.anything()
      )

      const realtimeRequest = fetchMock.mock.calls.find(([url]) => url === '/api/voice/stream')?.[1]
      const body = JSON.parse(String(realtimeRequest?.body))
      expect(body).toMatchObject({
        text: 'Hello realtime from Fish.',
        sourceText: '**Hello realtime** from Fish.',
        provider: 'fish',
        voiceId: 'voice-123',
        agentId: 'agent-1'
      })

      const player = realtimePlayerMock.MockRealtimePcmAudioPlayer.instances[0]
      expect(player.options).toEqual({ sampleRate: 24000, channels: 1 })
      expect(player.start).toHaveBeenCalled()
      expect(player.enqueue).toHaveBeenCalledWith(expect.any(Uint8Array))
      expect(player.finish).toHaveBeenCalled()
      expect(player.stop).toHaveBeenCalled()

      expect(starts).toHaveLength(1)
      expect(starts[0].detail).toMatchObject({
        mode: 'realtime',
        messageId: 'message-1',
        agentId: 'agent-1',
        audio: player.audio,
        lipSyncMode: 'amplitude'
      })
      expect(ends[0].detail).toMatchObject({
        mode: 'realtime',
        messageId: 'message-1',
        agentId: 'agent-1',
        audio: player.audio
      })
      expect(voicePlaybackMock.setActiveSpeech).toHaveBeenCalledWith('message-1', 'agent-1')
      expect(voicePlaybackMock.clearActiveSpeech).toHaveBeenCalled()
    } finally {
      window.removeEventListener('batshit:voice-playback-start', handleStart)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('keeps italic narration visible but silent in realtime TTS requests', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return createRealtimeResponse(
        realtimeStartEvent(),
        realtimeAudioEvent(),
        realtimeEndEvent()
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const ends: CustomEvent[] = []
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('*She looks away.* Hello **Josh**.', {
        voice: {
          provider: 'fish',
          voiceId: 'voice-123'
        },
        voiceSettings: {
          schemaVersion: 2,
          tts: {
            providerId: 'fish',
            narration: {
              italicBehavior: 'silent'
            }
          },
          goonLipSync: {
            mode: 'amplitude'
          }
        },
        agentId: 'agent-1',
        messageId: 'message-italics',
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      const realtimeRequest = fetchMock.mock.calls.find(([url]) => url === '/api/voice/stream')?.[1]
      const body = JSON.parse(String(realtimeRequest?.body))
      expect(body).toMatchObject({
        text: 'Hello Josh.',
        sourceText: '*She looks away.* Hello **Josh**.',
        provider: 'fish',
        voiceId: 'voice-123',
        agentId: 'agent-1'
      })
    } finally {
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('buffers the first two Fish realtime PCM chunks before starting audible playback', async () => {
    const stream = createControlledRealtimeStream()
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return stream.response
    })
    vi.stubGlobal('fetch', fetchMock)

    const starts: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleStart = (event: Event) => starts.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-start', handleStart)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('Fish should buffer before audible playback starts.', {
        voice: {
          provider: 'fish',
          voiceId: 'voice-123'
        },
        agentId: 'agent-1',
        messageId: 'message-fish-buffer',
        manual: true
      })

      stream.write(realtimeStartEvent())
      await vi.waitFor(() =>
        expect(realtimePlayerMock.MockRealtimePcmAudioPlayer.instances).toHaveLength(1)
      )
      const player = realtimePlayerMock.MockRealtimePcmAudioPlayer.instances[0]

      stream.write({
        ...realtimeAudioEvent(),
        sequence: 1,
        chunkSeq: 0
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(player.enqueue).not.toHaveBeenCalled()
      expect(starts).toHaveLength(0)

      stream.write({
        ...realtimeAudioEvent(),
        sequence: 2,
        chunkSeq: 1
      })
      await vi.waitFor(() => expect(player.enqueue).toHaveBeenCalledTimes(2))
      expect(starts).toHaveLength(1)
      expect(starts[0].detail).toMatchObject({
        mode: 'realtime',
        messageId: 'message-fish-buffer',
        agentId: 'agent-1',
        playbackMetrics: {
          notes: expect.arrayContaining([
            'Fish realtime playback buffers the first two PCM chunks to avoid browser audio underruns.'
          ])
        }
      })

      stream.write({
        type: 'end',
        elapsedMs: 200,
        chunkCount: 2,
        audioBytes: 16
      })
      stream.close()
      await vi.waitFor(() => expect(ends).toHaveLength(1))
    } finally {
      window.removeEventListener('batshit:voice-playback-start', handleStart)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('stretches realtime text-timing fallback lip sync to streamed PCM duration', async () => {
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'fish'
        },
        goonLipSync: {
          mode: 'viseme',
          analyzerId: 'rhubarb-wasm'
        }
      }
    })
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return createRealtimeResponse(
        realtimeStartEvent(),
        {
          ...realtimeAudioEvent(),
          byteLength: 48_000
        },
        {
          ...realtimeAudioEvent(),
          sequence: 2,
          chunkSeq: 1,
          byteLength: 96_000
        },
        {
          type: 'end',
          elapsedMs: 200,
          chunkCount: 2,
          audioBytes: 144_000
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const starts: CustomEvent[] = []
    const alignmentUpdates: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleStart = (event: Event) => starts.push(event as CustomEvent)
    const handleAlignmentUpdate = (event: Event) => alignmentUpdates.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-start', handleStart)
    window.addEventListener('batshit:voice-alignment-update', handleAlignmentUpdate)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('Tiny.', {
        voice: {
          provider: 'fish',
          voiceId: 'voice-123'
        },
        agentId: 'agent-1',
        messageId: 'message-fish-stretch',
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      expect(starts).toHaveLength(1)
      expect(starts[0].detail).toMatchObject({
        lipSyncMode: 'viseme',
        lipSyncAnalyzerId: 'batshit-text-timing',
        durationMs: 3000,
        lipSyncTimeline: {
          analyzerId: 'batshit-text-timing',
          source: 'text-timing',
          durationMs: 3000
        }
      })
      expect(alignmentUpdates).toHaveLength(0)
    } finally {
      window.removeEventListener('batshit:voice-playback-start', handleStart)
      window.removeEventListener('batshit:voice-alignment-update', handleAlignmentUpdate)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('uses Inworld provider visemes for realtime Goon lip sync when Viseme mode is enabled', async () => {
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'inworld',
          modelId: 'inworld-tts-2'
        },
        goonLipSync: {
          mode: 'viseme',
          analyzerId: 'rhubarb-wasm',
          visemeBlendMs: 42
        }
      }
    })

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/providers') {
        return new Response(
          JSON.stringify({
            providers: [
              {
                id: 'inworld',
                label: 'Inworld',
                type: 'cloud',
                supports: {
                  tts: true,
                  stt: false,
                  listVoices: true,
                  clone: false,
                  streaming: true,
                  styles: false,
                  emotions: false
                }
              }
            ]
          }),
          { status: 200 }
        )
      }

      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return createRealtimeResponse(
        inworldRealtimeStartEvent(),
        inworldRealtimeAudioEvent(),
        realtimeEndEvent()
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const starts: CustomEvent[] = []
    const alignmentUpdates: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleStart = (event: Event) => starts.push(event as CustomEvent)
    const handleAlignmentUpdate = (event: Event) => alignmentUpdates.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-start', handleStart)
    window.addEventListener('batshit:voice-alignment-update', handleAlignmentUpdate)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('**Hello** Josh.', {
        voice: {
          provider: 'inworld',
          voiceId: 'Dennis'
        },
        agentId: 'agent-inworld',
        messageId: 'message-inworld',
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/voice/stream',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      )
      expect(lipSyncAnalysisMock.analyzeAudioLedGoonLipSync).not.toHaveBeenCalled()

      expect(starts).toHaveLength(1)
      expect(starts[0].detail).toMatchObject({
        mode: 'realtime',
        messageId: 'message-inworld',
        agentId: 'agent-inworld',
        lipSyncMode: 'viseme',
        lipSyncAnalyzerId: 'inworld-viseme-timing',
        lipSyncTimeline: {
          analyzerId: 'inworld-viseme-timing',
          source: 'provider-alignment',
          unitCount: 3,
          visemeBlendMs: 42
        },
        playbackMetrics: {
          analyzerId: 'inworld-viseme-timing',
          analyzerMode: 'provider-alignment',
          lipSyncDiagnostics: {
            provider: 'inworld',
            phoneCount: 3,
            mappedPhoneCount: 3,
            coveragePercent: 100
          }
        }
      })
      expect(starts[0].detail.lipSyncTimeline.keyframes.length).toBeGreaterThan(3)

      expect(alignmentUpdates).toHaveLength(1)
      expect(alignmentUpdates[0].detail).toMatchObject({
        messageId: 'message-inworld',
        agentId: 'agent-inworld',
        lipSyncAnalyzerId: 'inworld-viseme-timing',
        lipSyncTimeline: {
          analyzerId: 'inworld-viseme-timing',
          source: 'provider-alignment'
        }
      })
      expect(alignmentUpdates[0].detail.alignmentSegments).toHaveLength(2)
    } finally {
      window.removeEventListener('batshit:voice-playback-start', handleStart)
      window.removeEventListener('batshit:voice-alignment-update', handleAlignmentUpdate)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('keeps Inworld absolute alignment timestamps from being offset twice', async () => {
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'inworld',
          modelId: 'inworld-tts-2'
        },
        goonLipSync: {
          mode: 'viseme',
          analyzerId: 'rhubarb-wasm',
          visemeBlendMs: 42
        }
      }
    })

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/providers') {
        return new Response(
          JSON.stringify({
            providers: [
              {
                id: 'inworld',
                label: 'Inworld',
                type: 'cloud',
                supports: {
                  tts: true,
                  stt: false,
                  listVoices: true,
                  clone: false,
                  streaming: true,
                  styles: false,
                  emotions: false
                }
              }
            ]
          }),
          { status: 200 }
        )
      }

      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return createRealtimeResponse(
        inworldRealtimeStartEvent(),
        {
          type: 'audio',
          audioBase64: pcmBase64(),
          byteLength: 8,
          content: 'First',
          chunkSeq: 0,
          chunkAudioOffsetSec: 0,
          alignment: {
            segments: [
              {
                text: 'First',
                start: 0.1,
                end: 0.3,
                phoneticDetails: [
                  {
                    phoneSymbol: 'f',
                    startTimeSeconds: 0.1,
                    durationSeconds: 0.08,
                    visemeSymbol: 'fv'
                  }
                ]
              }
            ]
          }
        },
        {
          type: 'audio',
          audioBase64: pcmBase64(),
          byteLength: 8,
          content: 'Later',
          chunkSeq: 1,
          chunkAudioOffsetSec: 1,
          alignment: {
            segments: [
              {
                text: 'Later',
                start: 1.1,
                end: 1.3,
                phoneticDetails: [
                  {
                    phoneSymbol: 'l',
                    startTimeSeconds: 1.1,
                    durationSeconds: 0.08,
                    visemeSymbol: 'l'
                  }
                ]
              }
            ]
          }
        },
        {
          type: 'end',
          elapsedMs: 500,
          chunkCount: 2,
          audioBytes: 16
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const alignmentUpdates: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleAlignmentUpdate = (event: Event) => alignmentUpdates.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-alignment-update', handleAlignmentUpdate)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('First Later', {
        voice: {
          provider: 'inworld',
          voiceId: 'Dennis'
        },
        agentId: 'agent-inworld',
        messageId: 'message-inworld-absolute',
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      expect(alignmentUpdates).toHaveLength(2)
      const finalTimeline = alignmentUpdates[1].detail.lipSyncTimeline
      expect(finalTimeline.durationMs).toBe(1300)
      expect(finalTimeline.diagnostics).toMatchObject({
        phoneCount: 2,
        mappedPhoneCount: 2,
        coveragePercent: 100
      })
    } finally {
      window.removeEventListener('batshit:voice-alignment-update', handleAlignmentUpdate)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('aborts an in-flight realtime stream when stopAll is called', async () => {
    let capturedSignal: AbortSignal | null = null
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? null
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true }
        )
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = new VoiceService()
    await service.speak('Please stop this realtime stream.', {
      voice: {
        provider: 'fish',
        voiceId: 'voice-123'
      },
      messageId: 'message-stop',
      manual: true
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/voice/stream', expect.anything()))
    service.stopAll()

    expect(capturedSignal?.aborted).toBe(true)
    expect(voicePlaybackMock.clearQueueCounts).toHaveBeenCalled()
  })

  it('does not let a stale interrupted playback run start queued speech over the active reply', async () => {
    const streams = [
      createControlledRealtimeStream(),
      createControlledRealtimeStream(),
      createControlledRealtimeStream()
    ]
    const voiceStreamCalls: Array<string | URL | Request> = []
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      voiceStreamCalls.push(url)
      const stream = streams[voiceStreamCalls.length - 1]
      if (!stream) throw new Error('Unexpected extra realtime stream request.')
      return stream.response
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = new VoiceService()
    await service.speak('First interrupted realtime reply.', {
      voice: { provider: 'fish', voiceId: 'voice-123' },
      agentId: 'agent-1',
      messageId: 'message-first',
      manual: true
    })

    await vi.waitFor(() => expect(voiceStreamCalls).toHaveLength(1))
    streams[0].write(realtimeStartEvent())
    streams[0].write(realtimeAudioEvent())
    streams[0].write({
      ...realtimeAudioEvent(),
      sequence: 2,
      chunkSeq: 1
    })
    await vi.waitFor(() =>
      expect(realtimePlayerMock.MockRealtimePcmAudioPlayer.instances[0]?.enqueue).toHaveBeenCalled()
    )

    service.stopAll()

    await service.speak('Second active realtime reply.', {
      voice: { provider: 'fish', voiceId: 'voice-123' },
      agentId: 'agent-1',
      messageId: 'message-second',
      manual: true
    })
    await vi.waitFor(() => expect(voiceStreamCalls).toHaveLength(2))
    streams[1].write(realtimeStartEvent())
    streams[1].write(realtimeAudioEvent())
    streams[1].write({
      ...realtimeAudioEvent(),
      sequence: 2,
      chunkSeq: 1
    })
    await vi.waitFor(() =>
      expect(realtimePlayerMock.MockRealtimePcmAudioPlayer.instances[1]?.enqueue).toHaveBeenCalled()
    )

    await service.speak('Third queued realtime reply.', {
      voice: { provider: 'fish', voiceId: 'voice-123' },
      agentId: 'agent-1',
      messageId: 'message-third',
      manual: true
    })
    expect(voiceStreamCalls).toHaveLength(2)

    streams[0].close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(voiceStreamCalls).toHaveLength(2)

    service.stopAll()
    streams[1].close()
    streams[2].close()
  })

  it('stops active playback when browser voice input detects speech in voice mode', async () => {
    const recognitionInstances: any[] = []
    class MockSpeechRecognition {
      continuous = false
      interimResults = true
      lang = ''
      onstart: (() => void) | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      onresult: ((event: any) => void) | null = null
      onspeechstart: (() => void) | null = null
      start = vi.fn(() => {
        this.onstart?.()
      })
      stop = vi.fn(() => {
        this.onend?.()
      })

      constructor() {
        recognitionInstances.push(this)
      }
    }

    vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'browser'
        },
        tts: {
          providerId: 'browser'
        }
      }
    })

    const speechStartEvents: CustomEvent[] = []
    const handleSpeechStart = (event: Event) => speechStartEvents.push(event as CustomEvent)
    window.addEventListener('batshit:voice-input-speech-start', handleSpeechStart)

    try {
      const service = new VoiceService()
      const stopSpy = vi.spyOn(service, 'stopSpeaking')
      await service.startVoiceMode(vi.fn(), vi.fn())

      recognitionInstances[0]?.onspeechstart?.()

      expect(stopSpy).toHaveBeenCalled()
      expect(speechStartEvents).toHaveLength(1)
      expect(speechStartEvents[0].detail).toMatchObject({
        provider: 'browser',
        interruptedPlayback: true
      })
    } finally {
      window.removeEventListener('batshit:voice-input-speech-start', handleSpeechStart)
    }
  })

  it('keeps browser dictation open after a final transcript until the user stops it', async () => {
    vi.useFakeTimers()
    const recognitionInstances: any[] = []
    class MockSpeechRecognition {
      continuous = false
      interimResults = true
      lang = ''
      onstart: (() => void) | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      onresult: ((event: any) => void) | null = null
      onspeechstart: (() => void) | null = null
      start = vi.fn(() => {
        this.onstart?.()
      })
      stop = vi.fn(() => {
        this.onend?.()
      })

      constructor() {
        recognitionInstances.push(this)
      }
    }

    vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'browser'
        }
      }
    })

    try {
      const service = new VoiceService()
      const final = vi.fn()
      let resolved = false
      const pending = service.startListening(final).then(() => {
        resolved = true
      })

      const recognition = recognitionInstances[0]
      expect(recognition.continuous).toBe(true)
      expect(recognition.start).toHaveBeenCalledTimes(1)

      recognition.onresult?.({
        resultIndex: 0,
        results: [
          {
            0: {
              transcript: 'Josh is still talking'
            },
            isFinal: true
          }
        ]
      })

      await Promise.resolve()
      expect(final).toHaveBeenCalledWith('Josh is still talking')
      expect(recognition.stop).not.toHaveBeenCalled()
      expect(resolved).toBe(false)

      recognition.onend?.()
      await vi.advanceTimersByTimeAsync(250)
      expect(recognition.start).toHaveBeenCalledTimes(2)
      expect(resolved).toBe(false)

      service.stopListening()
      await pending
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('can report browser preview text separately while recorded STT is still capturing', async () => {
    const recognitionInstances: any[] = []
    class MockSpeechRecognition {
      continuous = false
      interimResults = true
      lang = ''
      onstart: (() => void) | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      onresult: ((event: any) => void) | null = null
      onspeechstart: (() => void) | null = null
      start = vi.fn(() => {
        this.onstart?.()
      })
      stop = vi.fn(() => {
        this.onend?.()
      })

      constructor() {
        recognitionInstances.push(this)
      }
    }

    const mediaTrack = { stop: vi.fn() }
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [mediaTrack]
        }))
      },
      configurable: true
    })

    class MockMediaRecorder {
      static instances: MockMediaRecorder[] = []
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start = vi.fn(() => {
        this.state = 'recording'
      })
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
        this.onstop?.()
      })

      constructor(readonly stream: unknown) {
        MockMediaRecorder.instances.push(this)
      }
    }

    vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ text: 'final cloud transcript [BLANK_AUDIO]' }), {
            status: 200
          })
      )
    )
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'deepgram',
          modelId: 'nova-3'
        }
      }
    })

    try {
      const service = new VoiceService()
      const final = vi.fn()
      const interim = vi.fn()
      const pending = service.startListening(final, interim)
      for (let index = 0; index < 10 && MockMediaRecorder.instances.length === 0; index += 1) {
        await Promise.resolve()
      }

      const recognition = recognitionInstances[0]
      expect(recognition.continuous).toBe(true)
      recognition.onresult?.({
        resultIndex: 0,
        results: [
          {
            0: {
              transcript: 'live preview'
            },
            isFinal: false
          }
        ]
      })

      expect(interim).toHaveBeenCalledWith('live preview')

      service.stopListening()
      await pending

      expect(final).toHaveBeenCalledWith('final cloud transcript')
      expect(mediaTrack.stop).toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true
      })
    }
  })

  it('uploads recorded STT with the MediaRecorder MIME extension selected by the WebView', async () => {
    const mediaTrack = { stop: vi.fn() }
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [mediaTrack]
        }))
      },
      configurable: true
    })

    class MockMediaRecorder {
      static instances: MockMediaRecorder[] = []
      static isTypeSupported = vi.fn((mimeType: string) => mimeType === 'audio/mp4')
      state = 'inactive'
      mimeType = 'audio/mp4'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(
        readonly stream: unknown,
        readonly options?: MediaRecorderOptions
      ) {
        MockMediaRecorder.instances.push(this)
      }
      start = vi.fn(() => {
        this.state = 'recording'
      })
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/mp4' }) })
        this.onstop?.()
      })
    }

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: 'mac app recording worked' }), {
          status: 200
        })
    )
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    vi.stubGlobal('fetch', fetchMock)
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini-transcribe'
        }
      }
    })

    try {
      const service = new VoiceService()
      const final = vi.fn()
      const pending = service.startListening(final)
      for (let index = 0; index < 10 && MockMediaRecorder.instances.length === 0; index += 1) {
        await Promise.resolve()
      }

      service.stopListening()
      await pending

      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData
      const audio = body.get('audio') as File
      expect(MockMediaRecorder.isTypeSupported).toHaveBeenCalledWith('audio/mp4')
      expect(audio.name).toBe('speech.m4a')
      expect(audio.type).toBe('audio/mp4')
      expect(final).toHaveBeenCalledWith('mac app recording worked')
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true
      })
    }
  })

  it('fails visibly when Browser STT is unavailable in the app shell', async () => {
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'browser'
        }
      }
    })

    const service = new VoiceService()

    await expect(service.startListening(vi.fn())).rejects.toThrow(
      'Browser speech-to-text is not available in this app shell.'
    )
  })

  it('keeps Mac app Voice Mode Browser STT fallback copy on launch-supported realtime options', async () => {
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'browser'
        }
      }
    })

    const service = new VoiceService()

    await expect(service.startVoiceMode(vi.fn(), vi.fn())).rejects.toThrow(
      'Browser Voice Mode speech-to-text is not available in this app shell. Choose Deepgram Flux or a registered realtime STT engine for Mac app voice mode.'
    )

    try {
      await service.startVoiceMode(vi.fn(), vi.fn())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain('OpenAI')
      expect(message).not.toContain('ElevenLabs')
      expect(message).not.toContain('Fish')
      expect(message).not.toContain('Mistral')
    }
  })

  it('passes STT overrides into Deepgram realtime voice mode startup', async () => {
    const mediaTrack = { stop: vi.fn() }
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [mediaTrack]
    }))
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true
    })

    class MockWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 3
      static instances: MockWebSocket[] = []

      readyState = MockWebSocket.CONNECTING
      binaryType: BinaryType = 'blob'
      onopen: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      send = vi.fn()
      close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSED
        this.onclose?.(new Event('close'))
      })

      constructor(
        readonly url: string,
        readonly protocols?: string | string[]
      ) {
        MockWebSocket.instances.push(this)
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN
          this.onopen?.(new Event('open'))
        })
      }
    }

    class MockAudioContext {
      sampleRate = 48_000
      destination = {}
      source = { connect: vi.fn(), disconnect: vi.fn() }
      processor = {
        onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
        connect: vi.fn(),
        disconnect: vi.fn()
      }
      createMediaStreamSource = vi.fn(() => this.source)
      createScriptProcessor = vi.fn(() => this.processor)
      close = vi.fn(async () => {})
    }

    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('AudioContext', MockAudioContext)

    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        stt: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini-transcribe'
        },
        realtimeStt: {
          providerId: 'deepgram',
          modelId: 'flux-general-multi'
        },
        voiceMode: {
          submitMode: 'auto',
          autoSubmitDelayMs: 1200,
          endOfTurnThreshold: 0.8
        }
      }
    })

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/realtime-stt/session') {
        return new Response(
          JSON.stringify({
            provider: 'deepgram',
            voiceProviderId: 'deepgram',
            mode: 'direct-provider-candidate',
            model: 'flux-general-multi',
            language: 'es',
            ready: true,
            launchSupported: true,
            transport: 'websocket',
            realtimeEvents: ['start', 'partial', 'final', 'endpoint'],
            audio: {
              encoding: 'linear16',
              sampleRate: 16_000,
              channels: 1,
              chunkMs: 80
            },
            serverBridgeRequired: false,
            clientMayConnectDirectly: true,
            secretsExposed: false,
            providerConfig: {
              method: 'websocket',
              endpoint: 'wss://api.deepgram.test/v2/listen',
              docsUrl: 'https://developers.deepgram.com/docs/listen-live-streaming-audio',
              query: {
                model: 'flux-general-multi'
              },
              auth: {
                kind: 'deepgram-temporary-token',
                tokenEndpoint: '/api/voice/realtime-stt/deepgram-token',
                websocketProtocol: 'bearer',
                expiresInSeconds: 30
              }
            },
            notes: []
          }),
          { status: 200 }
        )
      }

      if (String(url) === '/api/voice/realtime-stt/deepgram-token') {
        return new Response(
          JSON.stringify({
            provider: 'deepgram',
            accessToken: 'temporary-deepgram-token',
            tokenType: 'bearer',
            expiresIn: 30,
            expiresAt: '2026-05-18T00:00:30.000Z'
          }),
          { status: 200 }
        )
      }

      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const service = new VoiceService()
      await service.startVoiceMode(vi.fn(), vi.fn(), {
        provider: 'deepgram',
        model: 'flux-general-multi',
        language: 'es'
      })

      const sessionRequest = fetchMock.mock.calls.find(
        ([url]) => String(url) === '/api/voice/realtime-stt/session'
      )?.[1]
      expect(JSON.parse(String(sessionRequest?.body))).toMatchObject({
        provider: 'deepgram',
        model: 'flux-general-multi',
        language: 'es',
        mode: 'direct',
        voiceMode: {
          submitMode: 'auto',
          autoSubmitDelayMs: 1200,
          endOfTurnThreshold: 0.8
        }
      })
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      expect(MockWebSocket.instances[0].protocols).toEqual([
        'bearer',
        'temporary-deepgram-token'
      ])

      service.stopListening()
      expect(mediaTrack.stop).toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true
      })
    }
  })

  it('uses recorded-turn transcription for non-realtime Voice Mode STT providers', async () => {
    const mediaTrack = { stop: vi.fn() }
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [mediaTrack]
    }))
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true
    })

    class MockMediaRecorder {
      static instances: MockMediaRecorder[] = []
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(readonly stream: unknown) {
        MockMediaRecorder.instances.push(this)
      }
      start = vi.fn(() => {
        this.state = 'recording'
      })
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
        this.onstop?.()
      })
    }

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/transcribe') {
        return new Response(JSON.stringify({ text: 'recorded voice mode turn' }), { status: 200 })
      }

      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 })
    })
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    vi.stubGlobal('fetch', fetchMock)
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        realtimeStt: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini-transcribe',
          language: 'en'
        }
      }
    })

    try {
      const service = new VoiceService()
      const final = vi.fn()
      const interim = vi.fn()
      const pending = service.startVoiceMode(final, interim, {
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
        language: 'en'
      })
      for (let index = 0; index < 10 && MockMediaRecorder.instances.length === 0; index += 1) {
        await Promise.resolve()
      }

      service.stopListening()
      await pending

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/voice/transcribe')
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData
      expect(body.get('provider')).toBe('openai')
      expect(body.get('model')).toBe('gpt-4o-mini-transcribe')
      expect(body.get('language')).toBe('en')
      expect(final).toHaveBeenCalledWith('recorded voice mode turn')
      expect(interim).not.toHaveBeenCalled()
      expect(mediaTrack.stop).toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true
      })
    }
  })

  it('emits microphone activity during recorded-turn Voice Mode without interim transcript text', async () => {
    vi.useFakeTimers()
    const mediaTrack = { stop: vi.fn() }
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [mediaTrack]
    }))
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true
    })

    class MockMediaRecorder {
      static instances: MockMediaRecorder[] = []
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(readonly stream: unknown) {
        MockMediaRecorder.instances.push(this)
      }
      start = vi.fn(() => {
        this.state = 'recording'
      })
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
        this.onstop?.()
      })
    }

    const disconnect = vi.fn()
    class MockAudioContext {
      createAnalyser = vi.fn(() => ({
        fftSize: 0,
        getByteTimeDomainData: (samples: Uint8Array) => samples.fill(200)
      }))
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect
      }))
      close = vi.fn(async () => {})
    }

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/transcribe') {
        return new Response(JSON.stringify({ text: 'recorded voice mode turn' }), { status: 200 })
      }

      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 })
    })
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    vi.stubGlobal('AudioContext', MockAudioContext)
    vi.stubGlobal('fetch', fetchMock)

    const activityEvents: CustomEvent[] = []
    const handleActivity = (event: Event) => activityEvents.push(event as CustomEvent)
    window.addEventListener('batshit:voice-input-activity', handleActivity)

    try {
      const service = new VoiceService()
      const final = vi.fn()
      const interim = vi.fn()
      const pending = service.startVoiceMode(final, interim, {
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe'
      })
      for (let index = 0; index < 10 && MockMediaRecorder.instances.length === 0; index += 1) {
        await Promise.resolve()
      }

      vi.advanceTimersByTime(120)
      service.stopListening()
      await pending

      expect(activityEvents.length).toBeGreaterThan(0)
      expect(activityEvents[0]?.detail).toMatchObject({
        source: 'voice-mode',
        active: true
      })
      expect(interim).not.toHaveBeenCalled()
      expect(final).toHaveBeenCalledWith('recorded voice mode turn')
      expect(disconnect).toHaveBeenCalled()
    } finally {
      window.removeEventListener('batshit:voice-input-activity', handleActivity)
      vi.useRealTimers()
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true
      })
    }
  })

  it('falls back to the default microphone when the selected input device is unavailable', async () => {
    const mediaTrack = { stop: vi.fn() }
    const staleDeviceError = Object.assign(new Error('Invalid constraint'), {
      name: 'OverconstrainedError'
    })
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(staleDeviceError)
      .mockResolvedValueOnce({
        getTracks: () => [mediaTrack]
      })
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true
    })

    class MockMediaRecorder {
      static instances: MockMediaRecorder[] = []
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(readonly stream: unknown) {
        MockMediaRecorder.instances.push(this)
      }
      start = vi.fn(() => {
        this.state = 'recording'
      })
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
        this.onstop?.()
      })
    }

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/transcribe') {
        return new Response(JSON.stringify({ text: 'default microphone recovered' }), {
          status: 200
        })
      }

      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 })
    })
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    vi.stubGlobal('fetch', fetchMock)
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        inputDeviceId: 'stale-mic-id',
        realtimeStt: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini-transcribe',
          language: 'en'
        }
      }
    })

    try {
      const service = new VoiceService()
      const final = vi.fn()
      const pending = service.startVoiceMode(final, vi.fn(), {
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
        language: 'en'
      })
      for (let index = 0; index < 10 && MockMediaRecorder.instances.length === 0; index += 1) {
        await Promise.resolve()
      }

      service.stopListening()
      await pending

      expect(getUserMedia).toHaveBeenNthCalledWith(1, {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId: { exact: 'stale-mic-id' }
        }
      })
      expect(getUserMedia).toHaveBeenNthCalledWith(2, {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      expect(toastMock.warning).toHaveBeenCalledWith(
        "Batshit couldn't use the selected microphone. Choose your microphone again in Voice Behavior; using your Mac's default microphone for this turn."
      )
      expect(final).toHaveBeenCalledWith('default microphone recovered')
      expect(mediaTrack.stop).toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true
      })
    }
  })

  it('falls back to a plain microphone request when WebKit rejects processing constraints', async () => {
    const mediaTrack = { stop: vi.fn() }
    const webkitConstraintError = Object.assign(new Error('Invalid constraint'), {
      name: 'ConstraintError'
    })
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(webkitConstraintError)
      .mockResolvedValueOnce({
        getTracks: () => [mediaTrack]
      })
    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true
    })

    class MockMediaRecorder {
      static instances: MockMediaRecorder[] = []
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(readonly stream: unknown) {
        MockMediaRecorder.instances.push(this)
      }
      start = vi.fn(() => {
        this.state = 'recording'
      })
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
        this.onstop?.()
      })
    }

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/transcribe') {
        return new Response(JSON.stringify({ text: 'plain microphone recovered' }), {
          status: 200
        })
      }

      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 })
    })
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    vi.stubGlobal('fetch', fetchMock)
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        realtimeStt: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini-transcribe',
          language: 'en'
        }
      }
    })

    try {
      const service = new VoiceService()
      const final = vi.fn()
      const pending = service.startVoiceMode(final, vi.fn(), {
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
        language: 'en'
      })
      for (let index = 0; index < 10 && MockMediaRecorder.instances.length === 0; index += 1) {
        await Promise.resolve()
      }

      service.stopListening()
      await pending

      expect(getUserMedia).toHaveBeenNthCalledWith(1, {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true })
      expect(toastMock.warning).toHaveBeenCalledWith(
        "This browser rejected Batshit's microphone processing settings, so Batshit is trying a plain microphone request."
      )
      expect(final).toHaveBeenCalledWith('plain microphone recovered')
      expect(mediaTrack.stop).toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true
      })
    }
  })

  it('dispatches playback end when a realtime provider fails after audio starts', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return createRealtimeResponse(
        realtimeStartEvent(),
        realtimeAudioEvent(),
        {
          ...realtimeAudioEvent(),
          sequence: 2,
          chunkSeq: 1
        },
        {
          type: 'error',
          error: 'Fish stream failed'
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const starts: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleStart = (event: Event) => starts.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-start', handleStart)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('This realtime stream will fail.', {
        voice: {
          provider: 'fish',
          voiceId: 'voice-123'
        },
        agentId: 'agent-1',
        messageId: 'message-failed',
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      const player = realtimePlayerMock.MockRealtimePcmAudioPlayer.instances[0]
      expect(starts).toHaveLength(1)
      expect(ends[0].detail).toMatchObject({
        mode: 'realtime',
        messageId: 'message-failed',
        agentId: 'agent-1',
        audio: player.audio
      })
      expect(player.stop).toHaveBeenCalled()
    } finally {
      window.removeEventListener('batshit:voice-playback-start', handleStart)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
      consoleError.mockRestore()
    }
  })

  it('publishes realtime playback audio into an attached LiveKit room and unpublishes on playback end', async () => {
    const stopPublishedAudio = vi.fn(async () => {})
    liveKitPublishMock.publishAudioElementToLiveKitRoom.mockResolvedValue({
      track: {},
      publication: {},
      stop: stopPublishedAudio
    })
    const liveKitRoomHandle = { room: { localParticipant: {} } }
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return createRealtimeResponse(
        realtimeStartEvent(),
        realtimeAudioEvent(),
        realtimeEndEvent()
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = new VoiceService()
    service.setLiveKitVoiceRoomHandle(liveKitRoomHandle as any)
    await service.speak('Publish this realtime speech.', {
      voice: {
        provider: 'fish',
        voiceId: 'voice-123'
      },
      agentId: 'agent-1',
      messageId: 'message-livekit',
      manual: true
    })

    await vi.waitFor(() => expect(stopPublishedAudio).toHaveBeenCalledTimes(1))

    const player = realtimePlayerMock.MockRealtimePcmAudioPlayer.instances[0]
    expect(liveKitPublishMock.publishAudioElementToLiveKitRoom).toHaveBeenCalledWith(
      liveKitRoomHandle,
      player.audio,
      {
        trackName: 'batshit-agent-1-message-livekit',
        streamName: 'batshit-voice'
      }
    )
  })

  it('unpublishes active LiveKit playback when the room handle is cleared', async () => {
    const stopPublishedAudio = vi.fn(async () => {})
    liveKitPublishMock.publishAudioElementToLiveKitRoom.mockResolvedValue({
      track: {},
      publication: {},
      stop: stopPublishedAudio
    })
    const liveKitRoomHandle = { room: { localParticipant: {} } }
    const stream = createControlledRealtimeStream()
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return stream.response
    })
    vi.stubGlobal('fetch', fetchMock)

    const service = new VoiceService()
    service.setLiveKitVoiceRoomHandle(liveKitRoomHandle as any)
    await service.speak('Clear this LiveKit room while speech is active.', {
      voice: {
        provider: 'fish',
        voiceId: 'voice-123'
      },
      agentId: 'agent-1',
      messageId: 'message-clear-livekit',
      manual: true
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/voice/stream', expect.anything()))
    stream.write(realtimeStartEvent())
    stream.write(realtimeAudioEvent())
    stream.write({
      ...realtimeAudioEvent(),
      sequence: 2,
      chunkSeq: 1
    })
    await vi.waitFor(() =>
      expect(liveKitPublishMock.publishAudioElementToLiveKitRoom).toHaveBeenCalledTimes(1)
    )

    service.setLiveKitVoiceRoomHandle(null)
    await vi.waitFor(() => expect(stopPublishedAudio).toHaveBeenCalledTimes(1))

    stream.write(realtimeEndEvent())
    stream.close()
  })

  it('keeps batch providers on the completed-audio synthesize route', async () => {
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'openai'
        },
        goonLipSync: {
          mode: 'amplitude'
        }
      }
    })
    const createObjectURL = vi.fn(() => 'blob:batch-audio')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('Audio', audioMock.MockAudio)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL
    })
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const starts: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleStart = (event: Event) => starts.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-start', handleStart)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('Batch **speech** still works.', {
        voice: {
          provider: 'openai',
          voiceId: 'alloy'
        },
        agentId: 'agent-batch',
        messageId: 'message-batch',
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/voice/synthesize',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      )
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/voice/synthesize')).toHaveLength(1)
      expect(fetchMock).not.toHaveBeenCalledWith('/api/voice/stream', expect.anything())

      const synthesizeRequest = fetchMock.mock.calls.find(([url]) => url === '/api/voice/synthesize')?.[1]
      const body = JSON.parse(String(synthesizeRequest?.body))
      expect(body).toMatchObject({
        text: 'Batch speech still works.',
        sourceText: 'Batch **speech** still works.',
        provider: 'openai',
        voiceId: 'alloy',
        agentId: 'agent-batch'
      })

      expect(realtimePlayerMock.MockRealtimePcmAudioPlayer.instances).toHaveLength(0)
      expect(createObjectURL).toHaveBeenCalled()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:batch-audio')
      expect(audioMock.MockAudio.instances).toHaveLength(1)
      expect(audioMock.MockAudio.instances[0].play).toHaveBeenCalledTimes(2)
      expect(audioMock.MockAudio.instances[0].src).toBe('blob:batch-audio')
      expect(audioMock.MockAudio.instances[0].load).toHaveBeenCalled()
      expect(starts[0].detail).toMatchObject({
        messageId: 'message-batch',
        agentId: 'agent-batch',
        audio: audioMock.MockAudio.instances[0],
        lipSyncMode: 'amplitude'
      })
      expect(ends[0].detail).toMatchObject({
        messageId: 'message-batch',
        agentId: 'agent-batch',
        audio: audioMock.MockAudio.instances[0]
      })
    } finally {
      window.removeEventListener('batshit:voice-playback-start', handleStart)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('plays batch provider audio when Premium lip sync initialization fails', async () => {
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'byo:dots-tts-soar'
        },
        goonLipSync: {
          mode: 'viseme',
          analyzerId: 'rhubarb-wasm'
        }
      }
    })
    lipSyncAnalysisMock.analyzeAudioLedGoonLipSync.mockRejectedValue(
      new Error('Worker initialization failed: Aborted(NetworkError: A network error occurred.).')
    )
    const createObjectURL = vi.fn(() => 'blob:dots-audio')
    const revokeObjectURL = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('Audio', audioMock.MockAudio)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL
    })
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/voice/lip-sync/metrics') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          'content-type': 'audio/wav'
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const starts: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleStart = (event: Event) => starts.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-start', handleStart)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('Dots should still speak.', {
        voice: {
          provider: 'byo:dots-tts-soar',
          voiceId: 'default'
        },
        agentId: 'agent-dots',
        messageId: 'message-dots',
        goonLipSyncActive: true,
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      expect(lipSyncAnalysisMock.analyzeAudioLedGoonLipSync).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        '[VoiceService] Lip sync analyzer "rhubarb-wasm" failed.',
        expect.any(Error)
      )
      expect(createObjectURL).toHaveBeenCalled()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:dots-audio')
      expect(starts[0].detail).toMatchObject({
        messageId: 'message-dots',
        agentId: 'agent-dots',
        lipSyncMode: 'viseme',
        lipSyncAnalyzerId: 'batshit-text-timing'
      })
      expect(starts[0].detail.playbackMetrics.notes).toContain(
        'Premium lip sync analyzer "rhubarb-wasm" failed before playback (Worker initialization failed: Aborted(NetworkError: A network error occurred.).), so Batshit used text timing for this utterance.'
      )
      expect(ends[0].detail).toMatchObject({
        messageId: 'message-dots',
        agentId: 'agent-dots'
      })
      expect(toastMock.error).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      window.removeEventListener('batshit:voice-playback-start', handleStart)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('uses explicit Voice Settings for Premium lip sync analysis even when the global store is stale', async () => {
    userSettingsMock.getUserSettings.mockReturnValue({
      voice_settings: {
        schemaVersion: 2,
        tts: {
          providerId: 'byo:dots-tts-soar'
        },
        goonLipSync: {
          mode: 'amplitude'
        }
      }
    })
    const weights = {
      rest: 0,
      closed: 0,
      clenched: 0,
      mid_open: 0,
      wide_open: 1,
      round: 0,
      pucker: 0,
      teeth_lip: 0,
      tongue_lift: 0
    }
    lipSyncAnalysisMock.analyzeAudioLedGoonLipSync.mockResolvedValue({
      timeline: {
        analyzerId: 'rhubarb-wasm',
        source: 'audio-analysis',
        profile: 'rhubarb-9',
        keyframes: [
          { timeMs: 0, frame: { profile: 'rhubarb-9', weights } },
          { timeMs: 500, frame: { profile: 'rhubarb-9', weights } }
        ],
        durationMs: 500,
        unitCount: 1,
        sourceText: 'Dots should use hidden Goon lip sync.'
      },
      metrics: {
        analyzerId: 'rhubarb-wasm',
        runtimeMode: 'precomputed',
        totalMs: 64
      }
    })
    const createObjectURL = vi.fn(() => 'blob:dots-audio')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('Audio', audioMock.MockAudio)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url) === '/api/voice/lip-sync/metrics') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }

        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            'content-type': 'audio/wav'
          }
        })
      })
    )

    const starts: CustomEvent[] = []
    const ends: CustomEvent[] = []
    const handleStart = (event: Event) => starts.push(event as CustomEvent)
    const handleEnd = (event: Event) => ends.push(event as CustomEvent)
    window.addEventListener('batshit:voice-playback-start', handleStart)
    window.addEventListener('batshit:voice-playback-end', handleEnd)

    try {
      const service = new VoiceService()
      await service.speak('Dots should use hidden Goon lip sync.', {
        voice: {
          provider: 'byo:dots-tts-soar',
          voiceId: 'default'
        },
        voiceSettings: {
          goonLipSync: {
            mode: 'viseme',
            analyzerId: 'rhubarb-wasm',
            visemeBlendMs: 10
          }
        } as any,
        agentId: 'agent-dots',
        messageId: 'message-dots',
        manual: true
      })

      await vi.waitFor(() => expect(ends).toHaveLength(1))

      expect(lipSyncAnalysisMock.analyzeAudioLedGoonLipSync).toHaveBeenCalledWith(
        expect.objectContaining({
          analyzerId: 'rhubarb-wasm',
          mediaType: 'audio/wav',
          text: 'Dots should use hidden Goon lip sync.'
        })
      )
      expect(createObjectURL).toHaveBeenCalled()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:dots-audio')
      expect(starts[0].detail).toMatchObject({
        messageId: 'message-dots',
        agentId: 'agent-dots',
        lipSyncMode: 'viseme',
        lipSyncAnalyzerId: 'rhubarb-wasm',
        lipSyncTimeline: {
          analyzerId: 'rhubarb-wasm',
          source: 'audio-analysis'
        }
      })
      expect(ends[0].detail).toMatchObject({
        messageId: 'message-dots',
        agentId: 'agent-dots'
      })
      expect(toastMock.error).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('batshit:voice-playback-start', handleStart)
      window.removeEventListener('batshit:voice-playback-end', handleEnd)
    }
  })

  it('falls visibly from Audio2Face to Rhubarb before using text timing', async () => {
    const rhubarbWeights = {
      rest: 0,
      closed: 0,
      clenched: 0,
      mid_open: 0,
      wide_open: 1,
      round: 0,
      pucker: 0,
      teeth_lip: 0,
      tongue_lift: 0
    }
    lipSyncAnalysisMock.analyzeAudioLedGoonLipSync
      .mockRejectedValueOnce(new Error('AUDIO2FACE_NIM_UNAVAILABLE: NVIDIA NIM is unavailable.'))
      .mockResolvedValueOnce({
        timeline: {
          analyzerId: 'rhubarb-wasm',
          source: 'audio-analysis',
          profile: 'rhubarb-9',
          keyframes: [{ timeMs: 0, frame: { profile: 'rhubarb-9', weights: rhubarbWeights } }],
          durationMs: 500,
          unitCount: 1,
          sourceText: 'Fallback speech.'
        },
        metrics: {
          analyzerId: 'rhubarb-wasm',
          runtimeMode: 'precomputed',
          totalMs: 12
        }
      })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const service = new VoiceService()
      const result = await (service as any).resolveNonBrowserLipSyncAnalysis({
        buffer: new ArrayBuffer(4),
        mediaType: 'audio/wav',
        text: 'Fallback speech.',
        settings: {
          goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d' }
        },
        goonLipSyncActive: true
      })

      expect(lipSyncAnalysisMock.analyzeAudioLedGoonLipSync).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ analyzerId: 'audio2face-3d' })
      )
      expect(lipSyncAnalysisMock.analyzeAudioLedGoonLipSync).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ analyzerId: 'rhubarb-wasm' })
      )
      expect(result).toMatchObject({
        analyzerId: 'rhubarb-wasm',
        timeline: { analyzerId: 'rhubarb-wasm' }
      })
      expect(result.warnings).toEqual([
        'NVIDIA Audio2Face failed before playback (AUDIO2FACE_NIM_UNAVAILABLE: NVIDIA NIM is unavailable.), so Batshit used Rhubarb WASM for this utterance.'
      ])
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not add Rhubarb boundary blending to continuous Audio2Face frames', () => {
    const service = new VoiceService()
    const timeline = (service as any).withGoonLipSyncVisemeBlend(
      {
        analyzerId: 'audio2face-3d',
        source: 'audio-analysis',
        profile: 'arkit-52',
        keyframes: [],
        durationMs: 500,
        unitCount: 0,
        sourceText: ''
      },
      { goonLipSync: { mode: 'viseme', analyzerId: 'audio2face-3d', visemeBlendMs: 80 } }
    )

    expect(timeline.visemeBlendMs).toBe(0)
  })
})
