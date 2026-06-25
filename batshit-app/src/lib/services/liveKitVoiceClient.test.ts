import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const liveKitMock = vi.hoisted(() => {
  type Handler = (...args: any[]) => void
  const events = {
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    TranscriptionReceived: 'transcriptionReceived',
    Disconnected: 'disconnected'
  }

  class MockRoom {
    options: unknown
    handlers = new Map<string, Set<Handler>>()
    connect = vi.fn(async (...args: any[]) => {
      if (liveKitMock.connectImpl) {
        await liveKitMock.connectImpl(this, ...args)
      }
    })
    disconnect = vi.fn()
    on = vi.fn((event: string, handler: Handler) => {
      const handlers = this.handlers.get(event) ?? new Set<Handler>()
      handlers.add(handler)
      this.handlers.set(event, handlers)
      return this
    })
    off = vi.fn((event: string, handler: Handler) => {
      this.handlers.get(event)?.delete(handler)
      return this
    })
    localParticipant = {
      identity: 'batshit-user-josh',
      performRpc: vi.fn(async (options: any) => `rpc:${options.method}`),
      publishTrack: vi.fn(async (_track: any, options: any) => ({
        trackSid: 'published-track-1',
        options
      })),
      unpublishTrack: vi.fn(async (_track: any, _stopOnUnpublish: boolean) => ({
        trackSid: 'published-track-1'
      }))
    }

    constructor(options: unknown) {
      this.options = options
      liveKitMock.rooms.push(this)
    }

    emit(event: string, ...args: any[]) {
      this.handlers.get(event)?.forEach((handler) => handler(...args))
    }
  }

  return {
    events,
    rooms: [] as MockRoom[],
    connectImpl: null as null | ((room: MockRoom, ...args: any[]) => Promise<void> | void),
    localAudioTrack: {
      id: 'local-mic-track-1',
      mediaStreamTrack: { id: 'raw-local-mic-track-1' },
      stop: vi.fn()
    },
    createLocalAudioTrack: vi.fn(async () => liveKitMock.localAudioTrack),
    MockRoom
  }
})

vi.mock('livekit-client', () => ({
  Room: liveKitMock.MockRoom,
  createLocalAudioTrack: liveKitMock.createLocalAudioTrack,
  RoomEvent: liveKitMock.events,
  Track: {
    Kind: {
      Audio: 'audio'
    },
    Source: {
      Microphone: 'microphone'
    }
  }
}))

import {
  connectLiveKitVoiceRoom,
  publishAudioElementToLiveKitRoom,
  publishMicrophoneToLiveKitRoom,
  requestLiveKitVoiceSession
} from '$lib/services/liveKitVoiceClient'
import type { LiveKitVoiceSessionResponse } from '$lib/types/voiceLiveKit'

const createSession = (): LiveKitVoiceSessionResponse => ({
  runtime: 'livekit',
  transport: 'webrtc',
  mode: 'room-token',
  serverUrl: 'ws://localhost:7880',
  roomName: 'batshit-voice-session',
  participantIdentity: 'batshit-user-josh',
  participantName: 'Josh',
  token: 'token-123',
  expiresInSec: 600,
  permissions: {
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  },
  selfHosted: true,
  createdAt: '2026-05-17T00:00:00.000Z'
})

describe('liveKitVoiceClient', () => {
  beforeEach(() => {
    liveKitMock.rooms.length = 0
    liveKitMock.connectImpl = null
    liveKitMock.localAudioTrack.stop.mockClear()
    vi.clearAllMocks()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('requests a LiveKit room token with the expected payload', async () => {
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))

    await expect(
      requestLiveKitVoiceSession(
        { sessionId: 'chat-1', agentId: 'agent-1', metadata: { source: 'test' } },
        { fetchImpl: fetchMock as unknown as typeof fetch }
      )
    ).resolves.toEqual(session)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice/livekit/session',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'chat-1',
          agentId: 'agent-1',
          metadata: { source: 'test' }
        })
      })
    )
  })

  it('includes setup hints in LiveKit session errors', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'LiveKit URL not configured.',
            setupHint: 'Set LIVEKIT_URL to ws://localhost:7880.'
          }),
          { status: 412 }
        )
    )

    await expect(
      requestLiveKitVoiceSession({}, { fetchImpl: fetchMock as unknown as typeof fetch })
    ).rejects.toThrow('LiveKit URL not configured. Set LIVEKIT_URL to ws://localhost:7880.')
  })

  it('does not call the token route when the request is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()

    await expect(
      requestLiveKitVoiceSession({}, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('connects to a room and exposes subscribed remote audio tracks', async () => {
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const onRemoteAudioTrack = vi.fn()
    const handle = await connectLiveKitVoiceRoom(
      { roomName: 'voice-room' },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        onRemoteAudioTrack
      }
    )
    const room = liveKitMock.rooms[0]

    expect(room.options).toEqual({ adaptiveStream: true, dynacast: true })
    expect(room.connect).toHaveBeenCalledWith('ws://localhost:7880', 'token-123', {
      autoSubscribe: true
    })

    const audio = document.createElement('audio')
    const removeSpy = vi.spyOn(audio, 'remove')
    const track = {
      kind: 'audio',
      attach: vi.fn(() => audio),
      detach: vi.fn(() => [audio])
    }

    room.emit(
      liveKitMock.events.TrackSubscribed,
      track,
      { trackSid: 'track-1' },
      { identity: 'agent-1' }
    )

    expect(handle.audioElements).toEqual([audio])
    expect(audio.autoplay).toBe(true)
    expect(audio.dataset.batshitLiveKitAudio).toBe('true')
    expect(audio.style.display).toBe('none')
    expect(document.body.contains(audio)).toBe(true)
    expect(audio.play).toHaveBeenCalled()
    expect(onRemoteAudioTrack).toHaveBeenCalledWith({
      audio,
      participantIdentity: 'agent-1',
      trackSid: 'track-1'
    })

    room.emit(liveKitMock.events.TrackUnsubscribed, track)
    expect(removeSpy).toHaveBeenCalled()
    expect(handle.audioElements).toEqual([])
  })

  it('publishes the browser microphone into the LiveKit room and releases it on stop', async () => {
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const handle = await connectLiveKitVoiceRoom({}, { fetchImpl: fetchMock as unknown as typeof fetch })
    const room = liveKitMock.rooms[0]

    const published = await publishMicrophoneToLiveKitRoom(handle, {
      trackName: 'josh-mic',
      streamName: 'batshit-sidecar'
    })

    expect(liveKitMock.createLocalAudioTrack).toHaveBeenCalledWith({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    })
    expect(published.track).toBe(liveKitMock.localAudioTrack)
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(liveKitMock.localAudioTrack, {
      name: 'josh-mic',
      source: 'microphone',
      stream: 'batshit-sidecar'
    })

    await published.stop()
    await published.stop()

    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1)
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(
      liveKitMock.localAudioTrack,
      true
    )
    expect(liveKitMock.localAudioTrack.stop).toHaveBeenCalledTimes(1)
  })

  it('dispatches local microphone activity while the LiveKit microphone is published', async () => {
    vi.useFakeTimers()
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const disconnect = vi.fn()
    const close = vi.fn(async () => {})

    class MockMediaStream {
      constructor(readonly tracks: unknown[]) {}
    }

    class MockAudioContext {
      createAnalyser = vi.fn(() => ({
        fftSize: 0,
        getByteTimeDomainData: (samples: Uint8Array) => samples.fill(200)
      }))
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect
      }))
      close = close
    }

    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('AudioContext', MockAudioContext)

    const activityEvents: CustomEvent[] = []
    const handleActivity = (event: Event) => activityEvents.push(event as CustomEvent)
    window.addEventListener('batshit:voice-input-activity', handleActivity)

    try {
      const handle = await connectLiveKitVoiceRoom({}, { fetchImpl: fetchMock as unknown as typeof fetch })
      const published = await publishMicrophoneToLiveKitRoom(handle)

      vi.advanceTimersByTime(100)

      expect(activityEvents.length).toBeGreaterThan(0)
      expect(activityEvents[0]?.detail).toMatchObject({
        source: 'livekit',
        active: true
      })

      await published.stop()

      expect(disconnect).toHaveBeenCalled()
      expect(close).toHaveBeenCalled()
    } finally {
      window.removeEventListener('batshit:voice-input-activity', handleActivity)
    }
  })

  it('forwards LiveKit transcription events with participant identity context', async () => {
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const onTranscription = vi.fn()
    await connectLiveKitVoiceRoom(
      {},
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        onTranscription
      }
    )
    const room = liveKitMock.rooms[0]
    const segments = [
      {
        id: 'seg-1',
        text: '😏 Hello',
        language: 'en',
        startTime: 0,
        endTime: 1,
        final: false,
        firstReceivedTime: 10,
        lastReceivedTime: 12
      }
    ]

    room.emit(
      liveKitMock.events.TranscriptionReceived,
      segments,
      { identity: 'batshit-livekit-agent' },
      { trackSid: 'agent-track-1' }
    )
    room.emit(
      liveKitMock.events.TranscriptionReceived,
      segments,
      { identity: 'batshit-user-josh' },
      { trackSid: 'user-track-1' }
    )

    expect(onTranscription).toHaveBeenNthCalledWith(1, {
      segments,
      participantIdentity: 'batshit-livekit-agent',
      trackSid: 'agent-track-1',
      isLocalParticipant: false
    })
    expect(onTranscription).toHaveBeenNthCalledWith(2, {
      segments,
      participantIdentity: 'batshit-user-josh',
      trackSid: 'user-track-1',
      isLocalParticipant: true
    })
  })

  it('cleans up handlers, audio elements, and the room on disconnect', async () => {
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const handle = await connectLiveKitVoiceRoom({}, { fetchImpl: fetchMock as unknown as typeof fetch })
    const room = liveKitMock.rooms[0]
    const audio = document.createElement('audio')
    const removeSpy = vi.spyOn(audio, 'remove')

    room.emit(
      liveKitMock.events.TrackSubscribed,
      { kind: 'audio', attach: vi.fn(() => audio), detach: vi.fn(() => [audio]) },
      { trackSid: 'track-1' },
      { identity: 'agent-1' }
    )

    await expect(
      handle.performRpc({
        destinationIdentity: 'agent-1',
        method: 'interrupt',
        payload: '{}',
        responseTimeout: 500
      })
    ).resolves.toBe('rpc:interrupt')

    handle.disconnect()
    expect(removeSpy).toHaveBeenCalled()
    expect(handle.audioElements).toEqual([])
    expect(room.off).toHaveBeenCalledTimes(4)
    expect(room.disconnect).toHaveBeenCalled()
    expect(room.localParticipant.performRpc).toHaveBeenCalledWith({
      destinationIdentity: 'agent-1',
      method: 'interrupt',
      payload: '{}',
      responseTimeout: 500
    })
  })

  it('cleans up the room when the abort signal fires after connection', async () => {
    const session = createSession()
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const handle = await connectLiveKitVoiceRoom(
      {},
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        signal: controller.signal
      }
    )
    const room = liveKitMock.rooms[0]
    const audio = document.createElement('audio')
    const removeSpy = vi.spyOn(audio, 'remove')

    room.emit(
      liveKitMock.events.TrackSubscribed,
      { kind: 'audio', attach: vi.fn(() => audio), detach: vi.fn(() => [audio]) },
      { trackSid: 'track-1' },
      { identity: 'agent-1' }
    )

    controller.abort()

    expect(removeSpy).toHaveBeenCalled()
    expect(handle.audioElements).toEqual([])
    expect(room.off).toHaveBeenCalledTimes(4)
    expect(room.disconnect).toHaveBeenCalled()
  })

  it('cleans up if LiveKit room connection fails after a track appears', async () => {
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const audio = document.createElement('audio')
    const removeSpy = vi.spyOn(audio, 'remove')
    liveKitMock.connectImpl = async (room) => {
      room.emit(
        liveKitMock.events.TrackSubscribed,
        { kind: 'audio', attach: vi.fn(() => audio), detach: vi.fn(() => [audio]) },
        { trackSid: 'track-1' },
        { identity: 'agent-1' }
      )
      throw new Error('connection failed')
    }

    await expect(
      connectLiveKitVoiceRoom({}, { fetchImpl: fetchMock as unknown as typeof fetch })
    ).rejects.toThrow('connection failed')

    const room = liveKitMock.rooms[0]
    expect(removeSpy).toHaveBeenCalled()
    expect(room.off).toHaveBeenCalledTimes(4)
    expect(room.disconnect).toHaveBeenCalled()
  })

  it('publishes Batshit-generated audio elements as LiveKit audio tracks', async () => {
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const handle = await connectLiveKitVoiceRoom({}, { fetchImpl: fetchMock as unknown as typeof fetch })
    const room = liveKitMock.rooms[0]
    const audio = document.createElement('audio')
    const audioTrack = { id: 'audio-track-1' } as MediaStreamTrack
    ;(audio as any).srcObject = {
      getAudioTracks: () => [audioTrack]
    }

    const published = await publishAudioElementToLiveKitRoom(handle, audio, {
      trackName: 'agent-1-speech',
      streamName: 'batshit-group-1'
    })

    expect(published.track).toBe(audioTrack)
    expect(published.publication).toMatchObject({
      trackSid: 'published-track-1'
    })
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(audioTrack, {
      name: 'agent-1-speech',
      stream: 'batshit-group-1'
    })

    await published.stop()
    await published.stop()

    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1)
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(audioTrack, false)
  })

  it('fails loudly when LiveKit audio publishing has no media stream track', async () => {
    const session = createSession()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const handle = await connectLiveKitVoiceRoom({}, { fetchImpl: fetchMock as unknown as typeof fetch })
    const audio = document.createElement('audio')

    await expect(publishAudioElementToLiveKitRoom(handle, audio)).rejects.toThrow(
      'LiveKit voice publishing requires an audio element backed by a MediaStream.'
    )
  })
})
