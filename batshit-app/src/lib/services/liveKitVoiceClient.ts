import type {
  LiveKitVoiceSessionRequest,
  LiveKitVoiceSessionResponse
} from '$lib/types/voiceLiveKit'
import type {
  LocalAudioTrack,
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  TrackPublication,
  TrackPublishOptions
} from 'livekit-client'
import type { TranscriptionSegment } from 'livekit-client'

export type LiveKitRemoteAudioTrackDetail = {
  audio: HTMLMediaElement
  participantIdentity: string
  trackSid?: string
}

export type LiveKitTranscriptionDetail = {
  segments: TranscriptionSegment[]
  participantIdentity: string | null
  trackSid?: string
  isLocalParticipant: boolean
}

export type LiveKitVoiceRoomHandle = {
  session: LiveKitVoiceSessionResponse
  room: import('livekit-client').Room
  audioElements: HTMLMediaElement[]
  disconnect: () => void
  performRpc: (options: {
    destinationIdentity: string
    method: string
    payload?: string
    responseTimeout?: number
  }) => Promise<string>
}

export type LiveKitPublishedAudioTrackHandle = {
  track: MediaStreamTrack
  publication: LocalTrackPublication
  stop: () => Promise<void>
}

export type LiveKitPublishedMicrophoneTrackHandle = {
  track: LocalAudioTrack
  publication: LocalTrackPublication
  stop: () => Promise<void>
}

export type PublishLiveKitAudioElementOptions = {
  trackName?: string
  streamName?: string
  stopTrackOnUnpublish?: boolean
}

export type ConnectLiveKitVoiceRoomOptions = {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onRemoteAudioTrack?: (detail: LiveKitRemoteAudioTrackDetail) => void
  onTranscription?: (detail: LiveKitTranscriptionDetail) => void
  onDisconnected?: (reason?: unknown) => void
}

function createAbortError(): Error {
  const error = new Error('LiveKit voice room connection was aborted.')
  error.name = 'AbortError'
  return error
}

type VoiceInputActivityMonitor = {
  stop: () => void
}

function dispatchLiveKitVoiceInputActivity(level: number): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('batshit:voice-input-activity', {
      detail: {
        source: 'livekit',
        level,
        active: true
      }
    })
  )
}

function startLiveKitMicrophoneActivityMonitor(track: LocalAudioTrack): VoiceInputActivityMonitor | null {
  if (typeof window === 'undefined') return null
  const AudioContextConstructor =
    (window as any).AudioContext ?? (window as any).webkitAudioContext
  if (!AudioContextConstructor) return null

  try {
    const context = new AudioContextConstructor() as AudioContext
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    const stream = new MediaStream([track.mediaStreamTrack])
    const sourceNode = context.createMediaStreamSource(stream)
    sourceNode.connect(analyser)

    const samples = new Uint8Array(analyser.fftSize)
    let lastDispatchAt = 0
    const interval = setInterval(() => {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) {
        const normalized = (sample - 128) / 128
        sum += normalized * normalized
      }
      const rms = Math.sqrt(sum / samples.length)
      if (rms < 0.035) return

      const now = Date.now()
      if (now - lastDispatchAt < 90) return
      lastDispatchAt = now
      dispatchLiveKitVoiceInputActivity(rms)
    }, 80)

    return {
      stop: () => {
        clearInterval(interval)
        try {
          sourceNode.disconnect()
        } catch {
          // Already disconnected
        }
        void context.close().catch(() => {})
      }
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[LiveKit voice] Failed to start microphone activity monitor:', error)
    }
    return null
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

function isMediaStreamLike(value: unknown): value is MediaStream {
  return Boolean(value && typeof (value as MediaStream).getAudioTracks === 'function')
}

function resolveAudioElementStream(audio: HTMLMediaElement): MediaStream {
  if (isMediaStreamLike(audio.srcObject)) {
    return audio.srcObject
  }

  const captureStream =
    (audio as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream ??
    (audio as HTMLMediaElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream
  if (captureStream) {
    const stream = captureStream.call(audio)
    if (isMediaStreamLike(stream)) {
      return stream
    }
  }

  throw new Error('LiveKit voice publishing requires an audio element backed by a MediaStream.')
}

async function readLiveKitSessionError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null)
  if (body && typeof body.error === 'string' && body.error.trim()) {
    const hint = typeof body.setupHint === 'string' && body.setupHint.trim() ? ` ${body.setupHint.trim()}` : ''
    return `${body.error.trim()}${hint}`
  }
  return `Failed to create LiveKit voice session (${response.status}).`
}

export async function requestLiveKitVoiceSession(
  request: LiveKitVoiceSessionRequest = {},
  options: Pick<ConnectLiveKitVoiceRoomOptions, 'fetchImpl' | 'signal'> = {}
): Promise<LiveKitVoiceSessionResponse> {
  throwIfAborted(options.signal)
  const fetcher = options.fetchImpl ?? fetch
  const response = await fetcher('/api/voice/livekit/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request),
    signal: options.signal
  })

  if (!response.ok) {
    throw new Error(await readLiveKitSessionError(response))
  }

  return (await response.json()) as LiveKitVoiceSessionResponse
}

export async function connectLiveKitVoiceRoom(
  request: LiveKitVoiceSessionRequest = {},
  options: ConnectLiveKitVoiceRoomOptions = {}
): Promise<LiveKitVoiceRoomHandle> {
  const session = await requestLiveKitVoiceSession(request, options)
  throwIfAborted(options.signal)
  const { Room, RoomEvent, Track } = await import('livekit-client')
  const room = new Room({
    adaptiveStream: true,
    dynacast: true
  })
  const audioElements: HTMLMediaElement[] = []
  const remoteAudioNotifyHandlers = new WeakMap<HTMLMediaElement, () => void>()

  const removeRemoteAudioNotifyHandler = (element: HTMLMediaElement) => {
    const handler = remoteAudioNotifyHandlers.get(element)
    if (!handler) return
    element.removeEventListener('play', handler)
    element.removeEventListener('playing', handler)
    element.removeEventListener('canplay', handler)
    remoteAudioNotifyHandlers.delete(element)
  }

  const removeAudioElements = () => {
    for (const element of [...audioElements]) {
      removeRemoteAudioNotifyHandler(element)
      element.remove()
    }
    audioElements.length = 0
  }

  const handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    if (track?.kind !== Track.Kind.Audio) return
    const element = track.attach()
    element.autoplay = true
    element.dataset.batshitLiveKitAudio = 'true'
    element.style.display = 'none'
    audioElements.push(element)
    const notifyRemoteAudioTrack = () => {
      options.onRemoteAudioTrack?.({
        audio: element,
        participantIdentity: participant.identity,
        trackSid: publication.trackSid
      })
    }
    remoteAudioNotifyHandlers.set(element, notifyRemoteAudioTrack)
    element.addEventListener('play', notifyRemoteAudioTrack)
    element.addEventListener('playing', notifyRemoteAudioTrack)
    element.addEventListener('canplay', notifyRemoteAudioTrack)
    if (typeof document !== 'undefined' && !element.isConnected) {
      document.body.appendChild(element)
    }
    try {
      const playPromise = element.play?.()
      if (playPromise && typeof playPromise.catch === 'function') {
        void playPromise.catch((error) => {
          console.warn('[LiveKit voice] Remote audio autoplay failed:', error)
        })
      }
    } catch (error) {
      console.warn('[LiveKit voice] Remote audio autoplay failed:', error)
    }
    notifyRemoteAudioTrack()
  }

  const handleTrackUnsubscribed = (track: RemoteTrack) => {
    for (const element of track.detach?.() ?? []) {
      removeRemoteAudioNotifyHandler(element)
      element.remove()
      const index = audioElements.indexOf(element)
      if (index >= 0) audioElements.splice(index, 1)
    }
  }

  const handleTranscriptionReceived = (
    segments: TranscriptionSegment[],
    participant?: Participant,
    publication?: TrackPublication
  ) => {
    options.onTranscription?.({
      segments,
      participantIdentity: participant?.identity ?? null,
      trackSid: publication?.trackSid,
      isLocalParticipant: Boolean(
        participant?.identity && participant.identity === room.localParticipant.identity
      )
    })
  }

  const handleDisconnected = (reason?: unknown) => {
    options.onDisconnected?.(reason)
  }

  const cleanupRoomHandlers = () => {
    room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed)
    room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
    room.off(RoomEvent.TranscriptionReceived, handleTranscriptionReceived)
    room.off(RoomEvent.Disconnected, handleDisconnected)
  }

  let disconnected = false
  const disconnectRoom = () => {
    if (disconnected) return
    disconnected = true
    options.signal?.removeEventListener('abort', disconnectRoom)
    cleanupRoomHandlers()
    removeAudioElements()
    room.disconnect()
  }

  room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
  room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
  room.on(RoomEvent.TranscriptionReceived, handleTranscriptionReceived)
  room.on(RoomEvent.Disconnected, handleDisconnected)

  options.signal?.addEventListener('abort', disconnectRoom, { once: true })

  try {
    throwIfAborted(options.signal)
    await room.connect(session.serverUrl, session.token, {
      autoSubscribe: true
    })
    throwIfAborted(options.signal)
  } catch (error) {
    disconnectRoom()
    throw error
  }

  return {
    session,
    room,
    audioElements,
    disconnect: disconnectRoom,
    performRpc: async ({ destinationIdentity, method, payload = '', responseTimeout }) => {
      return room.localParticipant.performRpc({
        destinationIdentity,
        method,
        payload,
        responseTimeout
      })
    }
  }
}

export async function publishMicrophoneToLiveKitRoom(
  handle: LiveKitVoiceRoomHandle,
  options: PublishLiveKitAudioElementOptions = {}
): Promise<LiveKitPublishedMicrophoneTrackHandle> {
  const { createLocalAudioTrack, Track } = await import('livekit-client')
  const track = await createLocalAudioTrack({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  })
  const publication = await handle.room.localParticipant.publishTrack(track, {
    name: options.trackName ?? 'batshit-user-microphone',
    source: Track.Source.Microphone,
    stream: options.streamName ?? 'batshit-user-audio'
  })
  const activityMonitor = startLiveKitMicrophoneActivityMonitor(track)
  let stopped = false

  return {
    track,
    publication,
    stop: async () => {
      if (stopped) return
      stopped = true
      activityMonitor?.stop()
      await handle.room.localParticipant.unpublishTrack(
        track,
        options.stopTrackOnUnpublish ?? true
      )
      track.stop()
    }
  }
}

export async function publishAudioElementToLiveKitRoom(
  handle: LiveKitVoiceRoomHandle,
  audio: HTMLMediaElement,
  options: PublishLiveKitAudioElementOptions = {}
): Promise<LiveKitPublishedAudioTrackHandle> {
  const stream = resolveAudioElementStream(audio)
  const [track] = stream.getAudioTracks()
  if (!track) {
    throw new Error('LiveKit voice publishing requires an audio track.')
  }

  const publishOptions: TrackPublishOptions = {
    name: options.trackName ?? 'batshit-agent-speech',
    stream: options.streamName ?? 'batshit-voice'
  }
  const publication = await handle.room.localParticipant.publishTrack(track, publishOptions)
  let stopped = false

  return {
    track,
    publication,
    stop: async () => {
      if (stopped) return
      stopped = true
      await handle.room.localParticipant.unpublishTrack(track, options.stopTrackOnUnpublish ?? false)
    }
  }
}
