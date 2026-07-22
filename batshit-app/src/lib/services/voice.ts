import { getUserSettings } from '$lib/stores/userSettings.svelte'
import { logger } from '$lib/utils/logger'
import { buildTextTimingLipSyncAnalysis } from '$lib/goons/lipSyncAnalyzer'
import { DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER } from '$lib/goons/lipSyncLab'
import { buildInworldVisemeLipSyncTimeline } from '$lib/goons/providerVisemeTimeline'
import { ARKIT_52_FACE_DRIVER_PROFILE } from '$lib/goons/speechFaceProfiles'
import { analyzeAudioLedGoonLipSync } from '$lib/services/goonLipSyncAnalysis'
import {
  publishAudioElementToLiveKitRoom,
  type LiveKitPublishedAudioTrackHandle,
  type LiveKitVoiceRoomHandle
} from '$lib/services/liveKitVoiceClient'
import { RealtimePcmAudioPlayer } from '$lib/services/realtimePcmAudioPlayer'
import {
  clearActiveSpeech,
  setActiveSpeech,
  updateQueueCount,
  clearQueueCounts
} from '$lib/stores/voicePlayback.svelte'
import type {
  AgentVoiceProfile,
  GoonLipSyncPremiumAnalyzerId,
  VoiceProviderId,
  VoiceProviderSummary,
  VoiceSettings
} from '$lib/types/voice'
import type {
  VoiceRealtimeSttEphemeralToken,
  VoiceRealtimeSttEvent,
  VoiceRealtimeSttSessionContract
} from '$lib/types/voiceRealtimeStt'
import type { VoiceRealtimeTtsAlignmentSegment, VoiceRealtimeTtsEvent } from '$lib/types/voiceRealtime'
import {
  getProviderOptionsFor,
  getSttEngineSettingsFor,
  normalizeAgentVoiceProfile,
  normalizeVoiceSettings,
  normalizeVoiceTtsConfig
} from '$lib/utils/voiceSchema'
import {
  applyRealtimeSttEventToTurnState,
  createRealtimeSttTurnState,
  type RealtimeSttTurnState
} from '$lib/utils/realtimeSttTurnState'
import {
  normalizeByoRealtimeSttEvent,
  normalizeDeepgramFluxRealtimeSttEvent
} from '$lib/utils/realtimeSttEvents'
import { cleanSpeechTranscript } from '$lib/utils/speechTranscript'
import {
  estimateGoonLipSyncDurationMs,
  normalizeGoonLipSyncTimelineDuration,
  normalizeGoonLipSyncVisemeBlendMs,
  type GoonLipSyncAnalyzerMetrics,
  type GoonLipSyncAnalyzerId,
  type GoonLipSyncPlaybackMetrics,
  type GoonLipSyncTimeline
} from '$lib/utils/goonLipSync'
import { extractSpeakableText, type SpeakableTextOptions } from '$lib/utils/speakableText'
import { toast } from 'svelte-sonner'
import { VOICE_ENGINES_UPDATED_EVENT } from '$lib/utils/voiceEngineEvents'

export type VoiceConfig = {
  provider?: VoiceProviderId
  model?: string
  voiceId?: string
  profileId?: string
  common?: Record<string, any>
  providerOptions?: Record<string, any>
  style?: Record<string, any>
}

export type VoiceInputConfig = {
  provider?: VoiceProviderId
  model?: string
  language?: string
}

type VoiceQueueItem = {
  text: string
  sourceText?: string
  agentId?: string | null
  messageId?: string | null
  voice?: VoiceConfig
  voiceSettings?: VoiceSettings
  goonLipSyncActive?: boolean
  onEnd?: () => void
  manual?: boolean
  manualPlaybackAudio?: HTMLAudioElement | null
  enqueueTime: number
  audioPromise?: Promise<SynthesizedAudioResult>
  abortController?: AbortController
  prefetchQueued?: boolean
}

type SynthesizedAudioResult = {
  buffer: ArrayBuffer
  mediaType: string
  metrics: {
    ttsTotalMs: number
  }
}

type RealtimeAlignmentSnapshot = {
  content: string | null
  offsetSec: number
  audioDurationSec: number | null
  segments: VoiceRealtimeTtsAlignmentSegment[]
}

const DICTATION_RESTART_DELAY_MS = 250
const VOICE_MODE_RESTART_DELAY_MS = 500
const MAX_PREFETCH_IN_FLIGHT = 2
const DEFAULT_CLIENT_PLAYBACK_RATE = 1
const DEFAULT_CLIENT_PLAYBACK_VOLUME = 1
const REALTIME_PCM_BYTES_PER_SAMPLE = 2
const MANUAL_PLAYBACK_PRIME_AUDIO_URL =
  'data:audio/wav;base64,UklGRlQBAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YTABAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const DEEPGRAM_REALTIME_STT_OPEN_TIMEOUT_MS = 10_000
const RECORDED_STT_MIME_CANDIDATES = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mimeType: 'audio/mp4', extension: 'm4a' }
] as const

const normaliseOptionalString = (value?: string | null) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function resolveVoiceSpeakableTextOptions(
  settings?: VoiceSettings | null
): SpeakableTextOptions {
  return {
    italicBehavior: settings?.tts?.narration?.italicBehavior === 'silent' ? 'silent' : 'speak'
  }
}

export function resolveVoiceSettingsForSpeech(
  settings?: VoiceSettings | null,
  agentVoiceProfile?: AgentVoiceProfile | null
): VoiceSettings {
  const normalizedSettings = normalizeVoiceSettings(settings)
  const normalizedAgentProfile = normalizeAgentVoiceProfile(agentVoiceProfile)
  const italicBehavior = normalizedAgentProfile?.tts?.narration?.italicBehavior
  if (!italicBehavior) return normalizedSettings

  return {
    ...normalizedSettings,
    tts: {
      ...(normalizedSettings.tts ?? {}),
      narration: {
        ...(normalizedSettings.tts?.narration ?? {}),
        italicBehavior
      }
    }
  }
}

function stripMimeParameters(mimeType?: string | null): string {
  return mimeType?.split(';')[0]?.trim().toLowerCase() ?? ''
}

function resolveAudioExtension(mimeType?: string | null): string {
  const normalized = stripMimeParameters(mimeType)
  const byMime: Record<string, string> = {
    'audio/webm': 'webm',
    'video/webm': 'webm',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/aac': 'aac'
  }
  return byMime[normalized] ?? 'webm'
}

function resolveRecordedSttMimeType(): { mimeType?: string; extension: string } {
  const mediaRecorder = globalThis.MediaRecorder
  if (!mediaRecorder || typeof mediaRecorder.isTypeSupported !== 'function') {
    return { extension: 'webm' }
  }

  for (const candidate of RECORDED_STT_MIME_CANDIDATES) {
    if (mediaRecorder.isTypeSupported(candidate.mimeType)) {
      return candidate
    }
  }

  return { extension: 'webm' }
}

function isVoiceInputConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const name = error.name?.toLowerCase() ?? ''
  const message = error.message?.toLowerCase() ?? ''
  return (
    name === 'overconstrainederror' ||
    name === 'constrainterror' ||
    name === 'notfounderror' ||
    message.includes('invalid constraint') ||
    message.includes('constraint')
  )
}

function describeVoiceError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    const message = error.message?.trim()
    return `${name}${message || 'Unknown error'}`.slice(0, 300)
  }

  if (typeof error === 'string') {
    return error.trim().slice(0, 300) || 'Unknown error'
  }

  return 'Unknown error'
}

export class VoiceService {
  private recognition: any = null
  private recognitionStarted = false
  private synthesis: SpeechSynthesis | null = null
  private isListening = false
  private voiceMode = false
  private dictationMode = false
  private dictationStopRequested = false
  private browserDictationResolve: (() => void) | null = null
  private recognitionRestartTimer: ReturnType<typeof setTimeout> | null = null
  private voiceInputInterruptActive = false
  private mediaRecorder: MediaRecorder | null = null
  private activeStream: MediaStream | null = null
  private recordedAudioActivityContext: AudioContext | null = null
  private recordedAudioActivitySource: MediaStreamAudioSourceNode | null = null
  private recordedAudioActivityInterval: ReturnType<typeof setInterval> | null = null
  private realtimeSttSocket: WebSocket | null = null
  private realtimeSttAudioContext: AudioContext | null = null
  private realtimeSttSource: MediaStreamAudioSourceNode | null = null
  private realtimeSttProcessor: ScriptProcessorNode | null = null
  private realtimeSttPendingPcm = new Int16Array(0)
  private realtimeSttChunkSampleCount = 0
  private realtimeSttStopping = false
  private currentAudio: HTMLAudioElement | null = null
  private currentAudioObjectUrl: string | null = null
  private currentAudioResolve: (() => void) | null = null
  private currentRealtimePlayer: RealtimePcmAudioPlayer | null = null
  private currentUtterance: SpeechSynthesisUtterance | null = null
  private pauseTimeout: ReturnType<typeof setTimeout> | null = null
  private queue: VoiceQueueItem[] = []
  private queueByAgent = new Map<string, VoiceQueueItem[]>()
  private isPlaying = false
  private duckedVolume: number | null = null
  private prefetchQueue: VoiceQueueItem[] = []
  private prefetchInFlight = 0
  private playbackGeneration = 0
  private activePlaybackRunId = 0
  private activeFetchController: AbortController | null = null
  private liveKitVoiceRoomHandle: LiveKitVoiceRoomHandle | null = null
  private liveKitPublishedAudio = new Map<string, LiveKitPublishedAudioTrackHandle>()
  private liveKitPublishTokens = new Map<string, number>()
  private liveKitPlaybackKeysByAudio = new WeakMap<HTMLMediaElement, string>()
  private liveKitPublishSerial = 0
  private providerSummaryCache: {
    loadedAt: number
    providers: VoiceProviderSummary[]
  } | null = null

  constructor() {
    if (typeof window !== 'undefined') {
      if ('webkitSpeechRecognition' in window) {
        this.recognition = new (window as any).webkitSpeechRecognition()
        this.setupRecognition()
      } else if ('SpeechRecognition' in window) {
        this.recognition = new (window as any).SpeechRecognition()
        this.setupRecognition()
      }

      this.synthesis = window.speechSynthesis
      window.addEventListener(VOICE_ENGINES_UPDATED_EVENT, () => {
        this.providerSummaryCache = null
      })
    }
  }

  private getVoiceSettings(): VoiceSettings {
    return normalizeVoiceSettings(getUserSettings()?.voice_settings)
  }

  private getSttConfig(
    override?: VoiceInputConfig,
    lane: 'transcribe' | 'realtime' = 'transcribe'
  ): {
    provider: VoiceProviderId
    model?: string
    language?: string
  } {
    const settings = this.getVoiceSettings()
    const defaults = lane === 'realtime' ? settings.realtimeStt : settings.stt
    const provider = (override?.provider ?? defaults?.providerId ?? 'browser') as VoiceProviderId
    const engineSettings = getSttEngineSettingsFor(settings, provider)
    return {
      provider,
      model: normaliseOptionalString(override?.model) ?? defaults?.modelId,
      language:
        normaliseOptionalString(override?.language) ??
        engineSettings?.language ??
        defaults?.language
    }
  }

  private async usesDirectRealtimeStt(provider: VoiceProviderId): Promise<boolean> {
    if (provider === 'browser' || provider === 'deepgram') return true
    if (!provider.startsWith('byo:') && !provider.startsWith('local:')) return false

    const summary = await this.getProviderSummary(provider)
    const capabilities = summary?.sttCapabilities
    return Boolean(capabilities?.realtime && capabilities.runtimeSupport === 'supported')
  }

  private async getProviderSummary(provider: VoiceProviderId): Promise<VoiceProviderSummary | null> {
    const now = Date.now()
    if (!this.providerSummaryCache || now - this.providerSummaryCache.loadedAt > 10_000) {
      const response = await fetch('/api/voice/providers')
      if (!response.ok) {
        const errorMessage = await this.readApiError(response, 'Failed to load voice providers')
        throw new Error(errorMessage)
      }
      const data = await response.json()
      this.providerSummaryCache = {
        loadedAt: now,
        providers: Array.isArray(data?.providers) ? data.providers : []
      }
    }

    return this.providerSummaryCache.providers.find((entry) => entry.id === provider) ?? null
  }

  private getTtsProvider(override?: VoiceProviderId): VoiceProviderId {
    if (override) return override
    return (this.getVoiceSettings().tts?.providerId ?? 'browser') as VoiceProviderId
  }

  private shouldUseRealtimeTts(provider: VoiceProviderId): boolean {
    const providerSummary = this.providerSummaryCache?.providers.find((entry) => entry.id === provider)
    if (providerSummary) return Boolean(providerSummary.supports.streaming)
    return provider === 'fish' || provider === 'inworld'
  }

  usesRealtimeTts(voice?: VoiceConfig): boolean {
    return this.shouldUseRealtimeTts(this.getTtsProvider(voice?.provider))
  }

  setLiveKitVoiceRoomHandle(handle: LiveKitVoiceRoomHandle | null): void {
    if (this.liveKitVoiceRoomHandle === handle) return
    this.stopAllLiveKitPublishedAudio()
    this.liveKitVoiceRoomHandle = handle
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }

  private setupRecognition() {
    if (!this.recognition) return

    this.recognition.continuous = false
    this.recognition.interimResults = true
    this.recognition.lang = 'en-US'

    this.recognition.onstart = () => {
      this.recognitionStarted = true
      this.isListening = true
    }

    this.recognition.onend = () => {
      this.recognitionStarted = false
      this.isListening = false
      if (this.voiceMode) {
        this.scheduleRecognitionRestart(VOICE_MODE_RESTART_DELAY_MS)
        return
      }

      if (this.dictationMode) {
        if (!this.dictationStopRequested) {
          this.scheduleRecognitionRestart(DICTATION_RESTART_DELAY_MS)
          return
        }

        this.finishBrowserDictation()
      }
    }

    this.recognition.onerror = (_event: any) => {
      this.recognitionStarted = false
      this.isListening = false
    }

    this.recognition.onspeechstart = () => {
      this.handleVoiceInputSpeechStart()
    }
  }

  private scheduleRecognitionRestart(delayMs: number): void {
    if (this.recognitionRestartTimer) {
      clearTimeout(this.recognitionRestartTimer)
    }

    this.recognitionRestartTimer = setTimeout(() => {
      this.recognitionRestartTimer = null
      if ((!this.voiceMode && !this.dictationMode) || !this.recognition) return
      if (this.dictationMode && this.dictationStopRequested) return
      try {
        this.recognition.start()
        this.recognitionStarted = true
      } catch (error) {
        console.error('Failed to restart voice recognition:', error)
      }
    }, delayMs)
  }

  private finishBrowserDictation(): void {
    this.recognitionStarted = false
    this.dictationMode = false
    this.dictationStopRequested = false
    const resolve = this.browserDictationResolve
    this.browserDictationResolve = null
    resolve?.()
  }

  private clearRecognitionRestartTimer(): void {
    if (!this.recognitionRestartTimer) return
    clearTimeout(this.recognitionRestartTimer)
    this.recognitionRestartTimer = null
  }

  private joinTranscriptParts(...parts: Array<string | null | undefined>): string {
    return cleanSpeechTranscript(
      parts
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(' ')
    )
  }

  private startRecognitionSafely(): boolean {
    if (!this.recognition) return false
    try {
      this.recognition.start()
      this.recognitionStarted = true
      return true
    } catch (error) {
      this.recognitionStarted = false
      console.error('Failed to start voice recognition:', error)
      return false
    }
  }

  private handleVoiceInputSpeechStart(): void {
    if (!this.voiceMode) return
    this.interruptVoicePlaybackForSpeech('browser')
  }

  private interruptVoicePlaybackForSpeech(provider: VoiceProviderId): void {
    if (!this.voiceMode) return
    this.stopAll()
    if (this.voiceInputInterruptActive) return
    this.voiceInputInterruptActive = true
    this.dispatchVoiceInputSpeechStart(provider)
  }

  private dispatchVoiceInputSpeechStart(provider: VoiceProviderId): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('batshit:voice-input-speech-start', {
          detail: {
            provider,
            interruptedPlayback: true
          }
        })
      )
    }
  }

  private dispatchVoiceInputActivity(source: 'dictation' | 'voice-mode', level: number): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('batshit:voice-input-activity', {
        detail: {
          source,
          level,
          active: true
        }
      })
    )
  }

  private startRecordedAudioActivityMonitor(
    stream: MediaStream,
    source: 'dictation' | 'voice-mode'
  ): void {
    if (typeof window === 'undefined') return
    const AudioContextConstructor =
      (window as any).AudioContext ?? (window as any).webkitAudioContext
    if (!AudioContextConstructor) return

    this.stopRecordedAudioActivityMonitor()

    try {
      const context = new AudioContextConstructor() as AudioContext
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
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
        this.dispatchVoiceInputActivity(source, rms)
      }, 80)

      this.recordedAudioActivityContext = context
      this.recordedAudioActivitySource = sourceNode
      this.recordedAudioActivityInterval = interval
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VoiceInputActivity] Failed to start microphone activity monitor.', error)
      }
      this.stopRecordedAudioActivityMonitor()
    }
  }

  private stopRecordedAudioActivityMonitor(): void {
    if (this.recordedAudioActivityInterval) {
      clearInterval(this.recordedAudioActivityInterval)
      this.recordedAudioActivityInterval = null
    }

    if (this.recordedAudioActivitySource) {
      try {
        this.recordedAudioActivitySource.disconnect()
      } catch {
        // Already disconnected
      }
      this.recordedAudioActivitySource = null
    }

    if (this.recordedAudioActivityContext) {
      void this.recordedAudioActivityContext.close().catch(() => {})
      this.recordedAudioActivityContext = null
    }
  }

  private dispatchVoiceModeEnd(provider: VoiceProviderId, reason: string): void {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('batshit:voice-mode-end', {
        detail: {
          provider,
          reason
        }
      })
    )
  }

  async startListening(
    onResult: (text: string) => void,
    onInterim?: (text: string) => void,
    input?: VoiceInputConfig
  ): Promise<void> {
    const stt = this.getSttConfig(input, 'transcribe')
    const provider = stt.provider

    if (provider === 'browser') {
      return this.startBrowserListening(onResult, onInterim)
    }

    if (this.isListening) {
      this.stopListening()
      return
    }

    this.isListening = true
    const previewStarted = this.startRecordedTranscriptionPreview(onInterim)
    try {
      const transcript = cleanSpeechTranscript(await this.recordAndTranscribe({ stt }))
      if (transcript) {
        onResult(transcript)
      }
    } catch (error) {
      console.error('Voice transcription failed:', error)
      throw error
    } finally {
      if (previewStarted) this.stopRecordedTranscriptionPreview()
      this.isListening = false
    }
  }

  private startRecordedTranscriptionPreview(onInterim?: (text: string) => void): boolean {
    if (!this.recognition || !onInterim) return false

    let committedTranscript = ''
    this.dictationMode = true
    this.dictationStopRequested = false
    this.browserDictationResolve = null
    this.recognition.continuous = true
    this.recognition.interimResults = true

    this.recognition.onresult = (event: any) => {
      let finalTranscript = ''
      let interimTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalTranscript += transcript
        } else {
          interimTranscript += transcript
        }
      }

      if (finalTranscript) {
        committedTranscript = this.joinTranscriptParts(committedTranscript, finalTranscript)
      }

      const previewTranscript = this.joinTranscriptParts(committedTranscript, interimTranscript)
      if (previewTranscript) {
        onInterim(previewTranscript)
      }
    }

    this.startRecognitionSafely()
    return true
  }

  private stopRecordedTranscriptionPreview(): void {
    if (!this.dictationMode) return
    this.dictationStopRequested = true
    this.clearRecognitionRestartTimer()

    if (this.recognition && this.isListening) {
      try {
        this.recognition.stop()
      } catch {
        this.finishBrowserDictation()
      }
    } else {
      this.finishBrowserDictation()
    }

    if (this.recognition) {
      this.recognition.continuous = false
    }
  }

  private async startBrowserListening(
    onResult: (text: string) => void,
    onInterim?: (text: string) => void
  ): Promise<void> {
    if (!this.recognition) {
      throw new Error(
        'Browser speech-to-text is not available in this app shell. Choose OpenAI, Deepgram, Fish, or a local STT engine for Mac app microphone dictation.'
      )
    }

    if (this.isListening) {
      this.stopListening()
      return
    }

    return new Promise((resolve, reject) => {
      let committedTranscript = ''
      this.dictationMode = true
      this.dictationStopRequested = false
      this.browserDictationResolve = resolve
      this.recognition!.continuous = true
      this.recognition!.interimResults = true

      this.recognition!.onresult = (event: any) => {
        let finalTranscript = ''
        let interimTranscript = ''

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript
          if (event.results[i].isFinal) {
            finalTranscript += transcript
          } else {
            interimTranscript += transcript
          }
        }

        if (interimTranscript && onInterim) {
          onInterim(this.joinTranscriptParts(committedTranscript, interimTranscript))
        }

        if (finalTranscript) {
          committedTranscript = this.joinTranscriptParts(committedTranscript, finalTranscript)
          onResult(committedTranscript)
        }
      }

      if (!this.startRecognitionSafely()) {
        this.finishBrowserDictation()
        reject(
          new Error(
            'Browser speech-to-text could not start. Choose OpenAI, Deepgram, Fish, or a local STT engine for Mac app microphone dictation.'
          )
        )
      }
    })
  }

  private async startRecordedTurnVoiceMode(
    onResult: (text: string) => void,
    _onInterim: ((text: string) => void) | undefined,
    stt: { provider: VoiceProviderId; model?: string; language?: string }
  ): Promise<void> {
    if (this.isListening) {
      this.stopListening()
      return
    }

    this.dictationMode = false
    this.dictationStopRequested = false
    this.voiceInputInterruptActive = false
    this.voiceMode = true
    this.isListening = true
    this.interruptVoicePlaybackForSpeech(stt.provider)

    try {
      const transcript = cleanSpeechTranscript(await this.recordAndTranscribe({ stt }))
      if (transcript) {
        onResult(transcript)
      }
    } catch (error) {
      console.error('Voice Mode recorded transcription failed:', error)
      throw error
    } finally {
      this.voiceMode = false
      this.voiceInputInterruptActive = false
      this.isListening = false
    }
  }

  private buildRealtimeSttUrl(contract: VoiceRealtimeSttSessionContract): string {
    const endpoint = contract.providerConfig.endpoint
    if (!endpoint) {
      throw new Error('Realtime STT provider did not return a WebSocket endpoint.')
    }

    const url = new URL(endpoint)
    for (const [key, value] of Object.entries(contract.providerConfig.query ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item))
        }
      } else {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  private async requestRealtimeSttContract(
    provider: VoiceProviderId,
    stt?: VoiceInputConfig
  ): Promise<VoiceRealtimeSttSessionContract> {
    const settings = this.getVoiceSettings()
    const response = await fetch('/api/voice/realtime-stt/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider,
        model: stt?.model,
        language: stt?.language,
        mode: 'direct',
        voiceMode: settings.voiceMode
      })
    })

    if (!response.ok) {
      const errorMessage = await this.readApiError(
        response,
        'Failed to prepare realtime voice input'
      )
      throw new Error(errorMessage)
    }

    return response.json()
  }

  private async requestDeepgramRealtimeToken(): Promise<VoiceRealtimeSttEphemeralToken> {
    const response = await fetch('/api/voice/realtime-stt/deepgram-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })

    if (!response.ok) {
      const errorMessage = await this.readApiError(
        response,
        'Failed to mint Deepgram realtime voice input token'
      )
      throw new Error(errorMessage)
    }

    return response.json()
  }

  private getVoiceInputAudioConstraints(settings: VoiceSettings): MediaStreamConstraints['audio'] {
    const base = this.getDefaultVoiceInputAudioConstraints()

    if (settings.inputDeviceId) {
      return {
        ...base,
        deviceId: { exact: settings.inputDeviceId }
      }
    }

    return base
  }

  private getDefaultVoiceInputAudioConstraints(): MediaTrackConstraints {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  }

  private async requestVoiceInputStream(settings: VoiceSettings): Promise<MediaStream> {
    const preferredAudio = this.getVoiceInputAudioConstraints(settings)

    try {
      return await navigator.mediaDevices.getUserMedia({ audio: preferredAudio })
    } catch (preferredError) {
      if (!isVoiceInputConstraintError(preferredError)) {
        throw preferredError
      }

      if (settings.inputDeviceId) {
        toast.warning(
          "Batshit couldn't use the selected microphone. Choose your microphone again in Voice Behavior; using your Mac's default microphone for this turn."
        )

        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: this.getDefaultVoiceInputAudioConstraints()
          })
        } catch (defaultDeviceError) {
          if (!isVoiceInputConstraintError(defaultDeviceError)) {
            throw defaultDeviceError
          }
        }
      }

      toast.warning(
        "This browser rejected Batshit's microphone processing settings, so Batshit is trying a plain microphone request."
      )

      return navigator.mediaDevices.getUserMedia({ audio: true })
    }
  }

  private resampleFloat32ToInt16(
    input: Float32Array,
    inputSampleRate: number,
    outputSampleRate: number
  ): Int16Array {
    if (inputSampleRate === outputSampleRate) {
      const exact = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i] ?? 0))
        exact[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      return exact
    }

    const ratio = inputSampleRate / outputSampleRate
    const outputLength = Math.max(1, Math.floor(input.length / ratio))
    const output = new Int16Array(outputLength)

    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = i * ratio
      const before = Math.floor(sourceIndex)
      const after = Math.min(before + 1, input.length - 1)
      const weight = sourceIndex - before
      const sample = (input[before] ?? 0) * (1 - weight) + (input[after] ?? 0) * weight
      const clamped = Math.max(-1, Math.min(1, sample))
      output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    }

    return output
  }

  private enqueueRealtimePcm(chunk: Int16Array): void {
    const socket = this.realtimeSttSocket
    if (!socket || socket.readyState !== WebSocket.OPEN || chunk.length === 0) return

    const combined = new Int16Array(this.realtimeSttPendingPcm.length + chunk.length)
    combined.set(this.realtimeSttPendingPcm, 0)
    combined.set(chunk, this.realtimeSttPendingPcm.length)

    let offset = 0
    while (combined.length - offset >= this.realtimeSttChunkSampleCount) {
      const next = combined.slice(offset, offset + this.realtimeSttChunkSampleCount)
      socket.send(next.buffer)
      offset += this.realtimeSttChunkSampleCount
    }

    this.realtimeSttPendingPcm = combined.slice(offset)
  }

  private startRealtimePcmCapture(
    stream: MediaStream,
    contract: VoiceRealtimeSttSessionContract
  ): void {
    const AudioContextCtor = window.AudioContext ?? (window as any).webkitAudioContext
    if (!AudioContextCtor) {
      throw new Error('Realtime microphone input requires AudioContext support in this browser.')
    }

    const audioContext = new AudioContextCtor()
    const source = audioContext.createMediaStreamSource(stream)
    const processor = audioContext.createScriptProcessor(4096, 1, 1)
    this.realtimeSttAudioContext = audioContext
    this.realtimeSttSource = source
    this.realtimeSttProcessor = processor
    this.realtimeSttPendingPcm = new Int16Array(0)
    this.realtimeSttChunkSampleCount = Math.max(
      1,
      Math.round(contract.audio.sampleRate * ((contract.audio.chunkMs ?? 80) / 1000))
    )

    let lastRealtimeActivityDispatchAt = 0
    processor.onaudioprocess = (event) => {
      if (!this.voiceMode || this.realtimeSttStopping) return
      const input = event.inputBuffer.getChannelData(0)
      const pcm = this.resampleFloat32ToInt16(
        input,
        audioContext.sampleRate,
        contract.audio.sampleRate
      )
      this.enqueueRealtimePcm(pcm)

      let sum = 0
      for (let index = 0; index < input.length; index += 1) {
        const sample = input[index] ?? 0
        sum += sample * sample
      }
      const rms = Math.sqrt(sum / input.length)
      if (rms >= 0.035) {
        const now = Date.now()
        if (now - lastRealtimeActivityDispatchAt >= 90) {
          lastRealtimeActivityDispatchAt = now
          this.dispatchVoiceInputActivity('voice-mode', rms)
        }
      }
    }

    source.connect(processor)
    processor.connect(audioContext.destination)
  }

  private processRealtimeSttEvent(
    state: RealtimeSttTurnState,
    event: VoiceRealtimeSttEvent,
    onResult: (text: string) => void,
    onInterim?: (text: string) => void
  ): RealtimeSttTurnState {
    const transition = applyRealtimeSttEventToTurnState(state, event)

    if (transition.action.stopPlayback) {
      this.interruptVoicePlaybackForSpeech(event.provider as VoiceProviderId)
    }

    if (event.type === 'partial' || event.type === 'final') {
      const transcript = event.transcript?.trim()
      if (transcript) onInterim?.(transcript)
    }

    if (transition.action.cancelPendingSubmit) {
      onInterim?.(transition.state.draftTranscript)
    }

    if (transition.action.submitTranscript?.trim()) {
      onResult(transition.action.submitTranscript.trim())
      this.voiceInputInterruptActive = false
    }

    if (transition.action.error) {
      toast.error(transition.action.error)
    }

    return transition.state
  }

  private normalizeRealtimeSttSocketEvent(
    contract: VoiceRealtimeSttSessionContract,
    payload: unknown
  ): VoiceRealtimeSttEvent[] {
    if (contract.provider === 'deepgram') {
      return normalizeDeepgramFluxRealtimeSttEvent(payload)
    }
    if (contract.provider === 'byo') {
      return normalizeByoRealtimeSttEvent(payload)
    }
    return []
  }

  private async startDirectRealtimeSttVoiceMode(
    provider: VoiceProviderId,
    onResult: (text: string) => void,
    onInterim?: (text: string) => void,
    stt?: VoiceInputConfig
  ): Promise<void> {
    const settings = this.getVoiceSettings()
    const contract = await this.requestRealtimeSttContract(provider, stt)
    if (!contract.launchSupported) {
      throw new Error(contract.launchBlockedReason ?? 'Realtime voice input is not ready.')
    }

    const protocols =
      contract.provider === 'deepgram'
        ? await this.requestDeepgramRealtimeToken().then((token) => [
            contract.providerConfig.auth?.websocketProtocol ?? token.tokenType,
            token.accessToken
          ])
        : undefined
    const stream = await this.requestVoiceInputStream(settings)
    this.activeStream = stream
    this.realtimeSttStopping = false

    const socket = protocols
      ? new WebSocket(this.buildRealtimeSttUrl(contract), protocols)
      : new WebSocket(this.buildRealtimeSttUrl(contract))
    socket.binaryType = 'arraybuffer'
    this.realtimeSttSocket = socket

    let turnState = createRealtimeSttTurnState()

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Realtime voice input connection timed out.'))
      }, DEEPGRAM_REALTIME_STT_OPEN_TIMEOUT_MS)

      socket.onopen = () => {
        clearTimeout(timeout)
        this.isListening = true
        try {
          this.startRealtimePcmCapture(stream, contract)
          turnState = this.processRealtimeSttEvent(
            turnState,
            {
              type: 'start',
              provider: contract.provider
            },
            onResult,
            onInterim
          )
          resolve()
        } catch (error) {
          reject(error)
        }
      }

      socket.onerror = () => {
        const error = new Error('Realtime voice input failed to connect.')
        if (socket.readyState !== WebSocket.OPEN) {
          clearTimeout(timeout)
          reject(error)
        } else {
          toast.error(error.message)
        }
      }
    })

    socket.onmessage = (message) => {
      try {
        const payload =
          typeof message.data === 'string' ? JSON.parse(message.data) : message.data
        const events = this.normalizeRealtimeSttSocketEvent(contract, payload)
        for (const event of events) {
          turnState = this.processRealtimeSttEvent(turnState, event, onResult, onInterim)
        }
      } catch (error) {
        console.error('Failed to process realtime STT event:', error)
        toast.error('Realtime voice input returned an unreadable event.')
      }
    }

    socket.onclose = () => {
      this.isListening = false
      if (!this.realtimeSttStopping && this.voiceMode) {
        this.voiceMode = false
        this.dispatchVoiceModeEnd(contract.voiceProviderId, 'socket_closed')
        toast.error('Realtime voice input disconnected.')
      }
    }
  }

  private stopRealtimeSttSession(): void {
    this.realtimeSttStopping = true

    if (this.realtimeSttProcessor) {
      this.realtimeSttProcessor.onaudioprocess = null
      this.realtimeSttProcessor.disconnect()
      this.realtimeSttProcessor = null
    }

    if (this.realtimeSttSource) {
      this.realtimeSttSource.disconnect()
      this.realtimeSttSource = null
    }

    if (this.realtimeSttAudioContext) {
      void this.realtimeSttAudioContext.close().catch(() => {})
      this.realtimeSttAudioContext = null
    }

    if (this.realtimeSttSocket) {
      const socket = this.realtimeSttSocket
      this.realtimeSttSocket = null
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'CloseStream' }))
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close()
      }
    }

    this.realtimeSttPendingPcm = new Int16Array(0)
    this.realtimeSttChunkSampleCount = 0
  }

  async startVoiceMode(
    onResult: (text: string) => void,
    onInterim?: (text: string) => void,
    input?: VoiceInputConfig
  ): Promise<void> {
    const stt = this.getSttConfig(input, 'realtime')
    const provider = stt.provider
    if (!(await this.usesDirectRealtimeStt(provider))) {
      return this.startRecordedTurnVoiceMode(onResult, onInterim, stt)
    }

    if (provider === 'deepgram' || provider.startsWith('byo:')) {
      this.dictationMode = false
      this.dictationStopRequested = false
      this.voiceInputInterruptActive = false
      this.voiceMode = true
      try {
        await this.startDirectRealtimeSttVoiceMode(provider, onResult, onInterim, stt)
      } catch (error) {
        this.voiceMode = false
        this.isListening = false
        this.stopRealtimeSttSession()
        if (this.activeStream) {
          this.activeStream.getTracks().forEach((track) => track.stop())
          this.activeStream = null
        }
        throw error
      }
      return
    }

    if (provider !== 'browser') {
      throw new Error(
        `Voice Mode does not know how to listen with ${provider}. Choose Browser, Deepgram Flux, or a recorded-audio STT provider.`
      )
    }

    if (!this.recognition) {
      throw new Error(
        'Browser Voice Mode speech-to-text is not available in this app shell. Choose Deepgram Flux or a registered realtime STT engine for Mac app voice mode.'
      )
    }

    this.dictationMode = false
    this.dictationStopRequested = false
    this.voiceInputInterruptActive = false
    this.voiceMode = true
    this.isListening = true
    this.recognition.continuous = true

    this.recognition.onresult = (event: any) => {
      let finalTranscript = ''
      let interimTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalTranscript += transcript
        } else {
          interimTranscript += transcript
        }
      }

      if ((interimTranscript || finalTranscript) && this.voiceMode) {
        this.interruptVoicePlaybackForSpeech('browser')
      }

      if (interimTranscript && onInterim) {
        onInterim(interimTranscript)
      }

      if (finalTranscript) {
        onResult(finalTranscript)
        this.voiceInputInterruptActive = false
      }
    }

    if (!this.startRecognitionSafely()) {
      this.voiceMode = false
      this.isListening = false
      throw new Error(
        'Browser Voice Mode speech-to-text could not start. Choose Deepgram Flux or a registered realtime STT engine for Mac app voice mode.'
      )
    }
  }

  stopListening(): void {
    const wasBrowserDictation = this.dictationMode
    const wasVoiceMode = this.voiceMode
    if (wasBrowserDictation) {
      this.dictationStopRequested = true
    }
    if (wasVoiceMode) {
      this.voiceMode = false
      this.voiceInputInterruptActive = false
    }
    this.clearRecognitionRestartTimer()

    if (this.recognition && this.recognitionStarted) {
      try {
        this.recognition.stop()
      } catch {
        this.recognitionStarted = false
        if (wasBrowserDictation) {
          this.finishBrowserDictation()
        }
      }
    } else if (wasBrowserDictation) {
      this.finishBrowserDictation()
    }
    if (this.recognition) {
      this.recognition.continuous = false
    }
    this.isListening = false

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
    this.stopRecordedAudioActivityMonitor()
    if (this.realtimeSttSocket || this.realtimeSttAudioContext) {
      this.stopRealtimeSttSession()
    }

    if (this.activeStream) {
      this.activeStream.getTracks().forEach((track) => track.stop())
      this.activeStream = null
    }
  }

  async speak(text: string, options?: {
    voice?: VoiceConfig
    voiceSettings?: VoiceSettings
    agentId?: string | null
    messageId?: string | null
    goonLipSyncActive?: boolean
    manual?: boolean
    onEnd?: () => void
  }): Promise<void> {
    const settings = options?.voiceSettings ?? this.getVoiceSettings()
    if (!this.willSpeakText(text, { manual: options?.manual, voiceSettings: settings })) return

    const speakable = extractSpeakableText(text, resolveVoiceSpeakableTextOptions(settings))

    const provider = this.getTtsProvider(options?.voice?.provider)
    const manualPlaybackAudio =
      options?.manual && provider !== 'browser' && !this.shouldUseRealtimeTts(provider)
        ? this.reserveManualPlaybackAudio()
        : null

    const item: VoiceQueueItem = {
      text: speakable,
      sourceText: text,
      agentId: options?.agentId ?? null,
      messageId: options?.messageId ?? null,
      voice: options?.voice,
      voiceSettings: settings,
      goonLipSyncActive: options?.goonLipSyncActive === true,
      onEnd: options?.onEnd,
      manual: options?.manual,
      manualPlaybackAudio,
      enqueueTime: Date.now()
    }

    this.enqueue(item)
  }

  willSpeakText(text: string, options?: { manual?: boolean; voiceSettings?: VoiceSettings }): boolean {
    const speakable = extractSpeakableText(
      text,
      resolveVoiceSpeakableTextOptions(options?.voiceSettings ?? this.getVoiceSettings())
    )
    if (!speakable.trim()) return false

    return true
  }

  stopSpeaking(): void {
    this.activePlaybackRunId += 1

    if (this.currentRealtimePlayer) {
      this.currentRealtimePlayer.stop()
      this.currentRealtimePlayer = null
    }

    if (this.currentAudio) {
      this.currentAudio.pause()
      this.currentAudio.currentTime = 0
      this.currentAudioResolve?.()
      this.currentAudio = null
    }

    if (this.synthesis && this.currentUtterance) {
      this.synthesis.cancel()
      this.currentUtterance = null
    }

    this.isPlaying = false
    this.activeFetchController?.abort()
    this.activeFetchController = null
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout)
      this.pauseTimeout = null
    }
    clearActiveSpeech()
    this.dispatchPlaybackEvent('batshit:voice-playback-end', {
      messageId: null,
      agentId: null
    })
  }

  stopAll(): void {
    this.stopSpeaking()
    this.playbackGeneration += 1
    this.cancelPrefetches()
    for (const item of this.queue) {
      this.releaseManualPlaybackAudio(item.manualPlaybackAudio)
      item.manualPlaybackAudio = null
    }
    this.queue = []
    this.queueByAgent.clear()
    clearQueueCounts()
  }

  private reserveManualPlaybackAudio(): HTMLAudioElement | null {
    if (typeof Audio === 'undefined') return null

    try {
      const audio = new Audio(MANUAL_PLAYBACK_PRIME_AUDIO_URL)
      audio.preload = 'auto'
      audio.playbackRate = DEFAULT_CLIENT_PLAYBACK_RATE
      audio.volume = 0
      void audio.play().catch((error) => {
        logger.debug('Manual voice preview audio prime was rejected:', error)
      })
      return audio
    } catch (error) {
      logger.debug('Manual voice preview audio prime failed:', error)
      return null
    }
  }

  private releaseManualPlaybackAudio(audio: HTMLAudioElement | null | undefined): void {
    if (!audio) return
    try {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    } catch (error) {
      logger.debug('Manual voice preview audio release failed:', error)
    }
  }

  isVoiceModeActive(): boolean {
    return this.voiceMode
  }

  isCurrentlyListening(): boolean {
    return this.isListening
  }

  private enqueue(item: VoiceQueueItem) {
    this.queue.push(item)
    const agentKey = item.agentId || 'default'
    const agentQueue = this.queueByAgent.get(agentKey) ?? []
    agentQueue.push(item)
    this.queueByAgent.set(agentKey, agentQueue)
    updateQueueCount(agentKey, agentQueue.length)

    if (this.isPlaying && this.currentAudio) {
      if (this.duckedVolume === null) {
        this.duckedVolume = this.currentAudio.volume
      }
      this.currentAudio.volume = Math.min(this.currentAudio.volume, 0.4)
    }

    this.schedulePrefetch(item)
    void this.playNext()
  }

  private async playNext() {
    if (this.isPlaying) return
    const next = this.queue.shift()
    if (!next) {
      if (this.currentAudio && this.duckedVolume !== null) {
        this.currentAudio.volume = this.duckedVolume
      }
      this.duckedVolume = null
      return
    }

    const agentKey = next.agentId || 'default'
    const agentQueue = this.queueByAgent.get(agentKey)
    if (agentQueue && agentQueue.length > 0) {
      agentQueue.shift()
      updateQueueCount(agentKey, agentQueue.length)
    }

    this.isPlaying = true
    const runGeneration = this.playbackGeneration
    const runId = ++this.activePlaybackRunId
    setActiveSpeech(next.messageId ?? null, next.agentId ?? null)

    try {
      await this.playItem(next)
    } catch (error) {
      if (!this.isAbortError(error)) {
        console.error('Voice playback failed:', error)
        toast.error(error instanceof Error ? error.message : 'Voice playback failed.')
      }
    } finally {
      const isCurrentPlaybackRun =
        runGeneration === this.playbackGeneration && runId === this.activePlaybackRunId
      if (isCurrentPlaybackRun) {
        this.isPlaying = false
        clearActiveSpeech()
        if (next.onEnd) {
          next.onEnd()
        }
        void this.playNext()
      }
    }
  }

  private async playItem(item: VoiceQueueItem) {
    const generation = this.playbackGeneration
    const settings = item.voiceSettings ?? this.getVoiceSettings()
    const provider = this.getTtsProvider(item.voice?.provider)

    if (provider === 'browser') {
      await this.playWithBrowser(item.text, settings, {
        messageId: item.messageId ?? null,
        agentId: item.agentId ?? null
      })
      return
    }

    if (this.shouldUseRealtimeTts(provider)) {
      await this.playRealtimeTts(item, settings, provider, generation)
      return
    }

    let audioResult: SynthesizedAudioResult
    let manualPlaybackAudio = item.manualPlaybackAudio

    try {
      if (item.audioPromise) {
        this.activeFetchController = item.abortController ?? null
        audioResult = await item.audioPromise
      } else {
        const controller = new AbortController()
        this.activeFetchController = controller
        audioResult = await this.fetchSynthesizedAudio(item, controller.signal)
      }

      this.activeFetchController = null
      if (generation !== this.playbackGeneration) {
        return
      }
      const lipSyncAnalysis = await this.resolveNonBrowserLipSyncAnalysis({
        buffer: audioResult.buffer,
        mediaType: audioResult.mediaType,
        text: item.text,
        settings,
        goonLipSyncActive: item.goonLipSyncActive === true
      })
      const playbackMetrics = this.buildPlaybackMetrics({
        providerId: provider,
        analyzerId: lipSyncAnalysis.analyzerId,
        analyzerMode:
          lipSyncAnalysis.analyzerId === 'batshit-text-timing'
            ? 'fallback'
            : (lipSyncAnalysis.metrics?.runtimeMode ?? 'precomputed'),
        messageId: item.messageId ?? null,
        agentId: item.agentId ?? null,
        text: item.text,
        mediaType: audioResult.mediaType,
        ttsTotalMs: audioResult.metrics.ttsTotalMs,
        lipSyncMode: settings.goonLipSync?.mode ?? 'amplitude',
        lipSyncMetrics: lipSyncAnalysis.metrics ?? null,
        lipSyncDiagnostics: lipSyncAnalysis.timeline?.diagnostics ?? null,
        runtimeMode: 'batch',
        extraNotes: lipSyncAnalysis.warnings ?? []
      })
      await this.playAudioBuffer(audioResult.buffer, audioResult.mediaType, settings, item.text, {
        messageId: item.messageId ?? null,
        agentId: item.agentId ?? null
      }, lipSyncAnalysis, playbackMetrics, manualPlaybackAudio)
      manualPlaybackAudio = null
    } catch (error) {
      item.audioPromise = undefined
      this.activeFetchController = null
      throw error
    } finally {
      item.manualPlaybackAudio = null
      this.releaseManualPlaybackAudio(manualPlaybackAudio)
    }
  }

  private async fetchSynthesizedAudio(
    item: VoiceQueueItem,
    signal?: AbortSignal
  ): Promise<SynthesizedAudioResult> {
    const startedAt = performance.now()
    const { payload } = this.buildVoiceRequestPayload(item)

    const response = await fetch('/api/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    })

    if (!response.ok) {
      const errorMessage = await this.readApiError(response, 'Failed to synthesize speech')
      throw new Error(errorMessage)
    }

    const buffer = await response.arrayBuffer()
    const mediaType = response.headers.get('content-type') || 'audio/mpeg'
    return {
      buffer,
      mediaType,
      metrics: {
        ttsTotalMs: Math.round(performance.now() - startedAt)
      }
    }
  }

  private buildVoiceRequestPayload(item: VoiceQueueItem) {
    const provider = this.getTtsProvider(item.voice?.provider)
    const model = normaliseOptionalString(item.voice?.model)
    const voiceId = normaliseOptionalString(item.voice?.voiceId)
    const profileId = normaliseOptionalString(item.voice?.profileId)
    const normalizedOverride = normalizeVoiceTtsConfig({
      providerId: provider,
      modelId: model,
      voiceId,
      profileId,
      common: item.voice?.common,
      providerOptions: item.voice?.providerOptions ? { [provider]: item.voice.providerOptions } : undefined,
      style: item.voice?.style
    })

    return {
      provider,
      model,
      voiceId,
      profileId,
      payload: {
        text: item.text,
        sourceText: item.sourceText ?? item.text,
        provider,
        model,
        voiceId,
        profileId,
        agentId: item.agentId ?? undefined,
        options: {
          common: normalizedOverride?.common,
          providerOptions: getProviderOptionsFor(normalizedOverride?.providerOptions, provider)
        }
      }
    }
  }

  private async playRealtimeTts(
    item: VoiceQueueItem,
    settings: VoiceSettings,
    provider: VoiceProviderId,
    generation: number
  ): Promise<void> {
    const controller = new AbortController()
    this.activeFetchController = controller
    const { payload } = this.buildVoiceRequestPayload(item)
    let response: Response
    try {
      response = await fetch('/api/voice/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      })
    } catch (error) {
      this.activeFetchController = null
      throw error
    }

    if (!response.ok) {
      const errorMessage = await this.readApiError(response, 'Failed to start realtime speech')
      this.activeFetchController = null
      throw new Error(errorMessage)
    }
    if (!response.body) {
      this.activeFetchController = null
      throw new Error('Realtime speech did not return an audio stream.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let lineBuffer = ''
    const playback = { player: null as RealtimePcmAudioPlayer | null }
    let startDispatched = false
    let endDispatched = false
    let chunkCount = 0
    let audioBytes = 0
    let ttsTotalMs: number | null = null
    let mediaType: string | null = null
    let firstAudioMs: number | null = null
    let clientStreamReadMs: number | null = null
    let streamCompleted = false
    let startEvent: Extract<VoiceRealtimeTtsEvent, { type: 'start' }> | null = null
    let fallbackLipSyncDurationMs = 0
    const initialAudioBufferChunks = provider === 'fish' ? 2 : 1
    const pendingInitialAudio: Uint8Array[] = []
    let initialAudioFlushed = false
    const alignmentByChunk = new Map<number, RealtimeAlignmentSnapshot>()
    const meta = {
      messageId: item.messageId ?? null,
      agentId: item.agentId ?? null
    }
    const startedAt = performance.now()
    let streamError: unknown = null

    const getAlignmentSegments = () => this.buildRealtimeAlignmentSegments(alignmentByChunk)

    const getAccumulatedAudioDurationMs = () => {
      if (!startEvent || audioBytes <= 0) return null
      const bytesPerSecond =
        startEvent.sampleRate * startEvent.channels * REALTIME_PCM_BYTES_PER_SAMPLE
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null
      return Math.round((audioBytes / bytesPerSecond) * 1000)
    }

    const buildRealtimeProviderLipSyncTimeline = (): GoonLipSyncTimeline | null => {
      if (settings.goonLipSync?.mode !== 'viseme') return null
      if (provider !== 'inworld') return null
      return this.withGoonLipSyncVisemeBlend(
        buildInworldVisemeLipSyncTimeline({
          segments: getAlignmentSegments(),
          sourceText: item.text
        }),
        settings
      )
    }

    const buildRealtimeLipSyncAnalysis = () => {
      const providerTimeline = buildRealtimeProviderLipSyncTimeline()
      if (providerTimeline) {
        return {
          analyzerId: providerTimeline.analyzerId,
          runtime: 'client' as const,
          source: providerTimeline.source,
          timeline: providerTimeline,
          warnings: [] as string[]
        }
      }

      return buildTextTimingLipSyncAnalysis({
        speakableText: item.text,
        playbackRate: DEFAULT_CLIENT_PLAYBACK_RATE,
        durationMs: getAccumulatedAudioDurationMs()
      })
    }

    const buildRealtimeFallbackLipSyncTimeline = (): GoonLipSyncTimeline | null => {
      const durationMs = getAccumulatedAudioDurationMs()
      if (durationMs === null) return null
      return this.withGoonLipSyncVisemeBlend(
        buildTextTimingLipSyncAnalysis({
          speakableText: item.text,
          playbackRate: DEFAULT_CLIENT_PLAYBACK_RATE,
          durationMs
        }).timeline,
        settings
      )
    }

    const dispatchAlignmentUpdate = () => {
      if (!startDispatched) return
      const alignmentSegments = getAlignmentSegments()
      if (alignmentSegments.length === 0) return
      const lipSyncTimeline = buildRealtimeProviderLipSyncTimeline()
      this.dispatchPlaybackEvent('batshit:voice-alignment-update', {
        ...meta,
        mode: 'realtime',
        provider,
        alignmentSegments,
        ...(lipSyncTimeline
          ? {
              lipSyncAnalyzerId: lipSyncTimeline.analyzerId,
              lipSyncTimeline,
              durationMs: lipSyncTimeline.durationMs
            }
          : {})
      })
    }

    const dispatchRealtimeFallbackLipSyncUpdate = () => {
      if (!startDispatched) return
      if (settings.goonLipSync?.mode !== 'viseme') return
      if (buildRealtimeProviderLipSyncTimeline()) return
      const lipSyncTimeline = buildRealtimeFallbackLipSyncTimeline()
      if (!lipSyncTimeline || lipSyncTimeline.durationMs <= fallbackLipSyncDurationMs) return
      fallbackLipSyncDurationMs = lipSyncTimeline.durationMs
      this.dispatchPlaybackEvent('batshit:voice-alignment-update', {
        ...meta,
        mode: 'realtime',
        provider,
        lipSyncAnalyzerId: lipSyncTimeline.analyzerId,
        lipSyncTimeline,
        durationMs: lipSyncTimeline.durationMs,
        alignmentSegments: getAlignmentSegments()
      })
    }

    const flushPendingInitialAudio = (player: RealtimePcmAudioPlayer, force = false): boolean => {
      if (initialAudioFlushed) return false
      if (pendingInitialAudio.length === 0) return false
      if (!force && pendingInitialAudio.length < initialAudioBufferChunks) return false

      initialAudioFlushed = true
      for (const audio of pendingInitialAudio) {
        player.enqueue(audio)
      }
      pendingInitialAudio.length = 0
      return true
    }

    const enqueueRealtimeAudio = (player: RealtimePcmAudioPlayer, audio: Uint8Array): boolean => {
      if (initialAudioFlushed) {
        player.enqueue(audio)
        return true
      }

      pendingInitialAudio.push(audio)
      return flushPendingInitialAudio(player)
    }

    const dispatchEnd = () => {
      if (!startDispatched || endDispatched) return
      endDispatched = true
      this.dispatchPlaybackEvent('batshit:voice-playback-end', {
        ...meta,
        mode: 'realtime',
        audio: playback.player?.audio
      })
    }

    const preparePlayback = async (event: Extract<VoiceRealtimeTtsEvent, { type: 'start' }>) => {
      if (playback.player) return
      startEvent = event
      mediaType = event.mediaType
      const player = new RealtimePcmAudioPlayer({
        sampleRate: event.sampleRate,
        channels: event.channels
      })
      playback.player = player
      this.currentRealtimePlayer = player
      this.currentAudio = player.audio
      await player.start()
    }

    const dispatchPlaybackStart = (event: Extract<VoiceRealtimeTtsEvent, { type: 'start' }>) => {
      if (startDispatched || !playback.player) return
      const lipSyncAnalysis = buildRealtimeLipSyncAnalysis()
      const lipSyncTimeline = this.withGoonLipSyncVisemeBlend(lipSyncAnalysis.timeline, settings)
      const estimatedDurationMs =
        lipSyncTimeline?.durationMs ??
        estimateGoonLipSyncDurationMs(item.text, DEFAULT_CLIENT_PLAYBACK_RATE)
      const usingProviderVisemes = lipSyncAnalysis.analyzerId === 'inworld-viseme-timing'
      if (!usingProviderVisemes && lipSyncTimeline) {
        fallbackLipSyncDurationMs = lipSyncTimeline.durationMs
      }
      const realtimeNotes = [
        'Realtime TTS starts audio before the complete file exists.',
        ...(typeof firstAudioMs === 'number' ? [`First realtime audio queued after ${firstAudioMs}ms.`] : []),
        ...(provider === 'fish'
          ? ['Fish realtime playback buffers the first two PCM chunks to avoid browser audio underruns.']
          : []),
        ...(usingProviderVisemes
          ? ['Inworld provider phoneme/viseme timestamps drove the realtime Goon mouth timeline.']
          : settings.goonLipSync?.mode === 'viseme'
            ? [
              'Rhubarb WASM needs a complete audio file, so realtime playback uses the live audio analyser plus Batshit text timing during the stream.'
            ]
            : [])
      ]
      const playbackMetrics = this.buildPlaybackMetrics({
        providerId: provider,
        analyzerId: lipSyncAnalysis.analyzerId,
        analyzerMode: usingProviderVisemes ? 'provider-alignment' : 'fallback',
        metricKind: 'playback-start',
        runtimeMode: 'realtime',
        transport: 'http-ndjson',
        lipSyncMode: settings.goonLipSync?.mode ?? 'amplitude',
        messageId: meta.messageId,
        agentId: meta.agentId,
        text: item.text,
        mediaType: event.mediaType,
        audioDurationMs: estimatedDurationMs,
        firstAudioMs,
        chunkCount,
        audioBytes,
        aborted: false,
        lipSyncDiagnostics: lipSyncTimeline?.diagnostics ?? null,
        extraNotes: realtimeNotes
      })

      startDispatched = true
      this.dispatchPlaybackEvent('batshit:voice-playback-start', {
        ...meta,
        mode: 'realtime',
        audio: playback.player.audio,
        durationMs: estimatedDurationMs,
        lipSyncMode: settings.goonLipSync?.mode ?? 'amplitude',
        lipSyncAnalyzerId: lipSyncAnalysis.analyzerId,
        lipSyncTimeline,
        playbackMetrics,
        alignmentSegments: getAlignmentSegments()
      })
    }

    const handleEvent = async (event: VoiceRealtimeTtsEvent) => {
      if (generation !== this.playbackGeneration || controller.signal.aborted) return
      if (event.type === 'error') {
        throw new Error(event.error)
      }
      if (event.type === 'start') {
        await preparePlayback(event)
        return
      }
      if (event.type === 'audio') {
        const player = playback.player
        if (!player || !startEvent) {
          throw new Error('Realtime speech sent audio before its start event.')
        }
        const alignmentSnapshot = this.normalizeRealtimeAlignmentSnapshot(event, provider)
        if (alignmentSnapshot && typeof event.chunkSeq === 'number') {
          alignmentByChunk.set(event.chunkSeq, alignmentSnapshot)
        }
        const audio = this.decodeBase64Audio(event.audioBase64)
        chunkCount += 1
        audioBytes += event.byteLength || audio.byteLength
        const audioQueuedForPlayback = enqueueRealtimeAudio(player, audio)
        if (audioQueuedForPlayback) {
          if (firstAudioMs === null) {
            firstAudioMs = Math.round(performance.now() - startedAt)
          }
          dispatchPlaybackStart(startEvent)
        }
        if (alignmentSnapshot) {
          dispatchAlignmentUpdate()
        }
        dispatchRealtimeFallbackLipSyncUpdate()
        return
      }
      if (event.type === 'end') {
        chunkCount = event.chunkCount
        audioBytes = event.audioBytes
        ttsTotalMs = event.elapsedMs
        streamCompleted = true
        if (playback.player && startEvent && flushPendingInitialAudio(playback.player, true)) {
          if (firstAudioMs === null) {
            firstAudioMs = Math.round(performance.now() - startedAt)
          }
          dispatchPlaybackStart(startEvent)
          dispatchAlignmentUpdate()
          dispatchRealtimeFallbackLipSyncUpdate()
        }
      }
    }

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split(/\r?\n/)
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const event = this.parseRealtimeTtsLine(line)
          if (event) {
            await handleEvent(event)
          }
        }
      }

      lineBuffer += decoder.decode()
      const finalEvent = this.parseRealtimeTtsLine(lineBuffer)
      if (finalEvent) {
        await handleEvent(finalEvent)
      }
      clientStreamReadMs = Math.round(performance.now() - startedAt)

      if (playback.player) {
        await playback.player.finish()
      }

      if (startDispatched && !controller.signal.aborted) {
        const clientStreamTotalMs = clientStreamReadMs ?? Math.round(performance.now() - startedAt)
        const totalMs = ttsTotalMs ?? clientStreamTotalMs
        this.logPlaybackMetrics(
          (() => {
            const providerTimeline = buildRealtimeProviderLipSyncTimeline()
            const analyzerId = providerTimeline?.analyzerId ?? 'batshit-text-timing'
            return this.buildPlaybackMetrics({
              providerId: provider,
              analyzerId,
              analyzerMode: providerTimeline ? 'provider-alignment' : 'fallback',
              metricKind: 'stream-complete',
              runtimeMode: 'realtime',
              transport: 'http-ndjson',
              lipSyncMode: settings.goonLipSync?.mode ?? 'amplitude',
              messageId: meta.messageId,
              agentId: meta.agentId,
              text: item.text,
              mediaType,
              ttsTotalMs: totalMs,
              firstAudioMs,
              streamTotalMs: clientStreamTotalMs,
              chunkCount,
              audioBytes,
              aborted: false,
              lipSyncDiagnostics: providerTimeline?.diagnostics ?? null,
              extraNotes: [
                `Realtime stream completed with ${chunkCount} audio chunks and ${audioBytes} audio bytes.`,
                ...(typeof firstAudioMs === 'number' ? [`First audio latency was ${firstAudioMs}ms.`] : []),
                ...(providerTimeline
                  ? [`Provider viseme timeline ended at ${providerTimeline.durationMs}ms.`]
                  : []),
                ...(streamCompleted ? [] : ['Realtime provider stream ended without an explicit end event.'])
              ]
            })
          })()
        )
      }
    } catch (error) {
      streamError = error
      throw error
    } finally {
      const aborted = controller.signal.aborted || generation !== this.playbackGeneration
      if (aborted && (startDispatched || chunkCount > 0)) {
        const abortMs = Math.round(performance.now() - startedAt)
        const providerTimeline = buildRealtimeProviderLipSyncTimeline()
        this.logPlaybackMetrics(
          this.buildPlaybackMetrics({
            providerId: provider,
            analyzerId: providerTimeline?.analyzerId ?? 'batshit-text-timing',
            analyzerMode: providerTimeline ? 'provider-alignment' : 'fallback',
            metricKind: 'stream-aborted',
            runtimeMode: 'realtime',
            transport: 'http-ndjson',
            lipSyncMode: settings.goonLipSync?.mode ?? 'amplitude',
            messageId: meta.messageId,
            agentId: meta.agentId,
            text: item.text,
            mediaType,
            ttsTotalMs,
            firstAudioMs,
            streamTotalMs: abortMs,
            abortMs,
            chunkCount,
            audioBytes,
            aborted: true,
            lipSyncDiagnostics: providerTimeline?.diagnostics ?? null,
            extraNotes: [
              `Realtime stream aborted after ${abortMs}ms with ${chunkCount} audio chunks and ${audioBytes} audio bytes.`,
              ...(typeof firstAudioMs === 'number' ? [`First audio latency before abort was ${firstAudioMs}ms.`] : []),
              ...(providerTimeline
                ? [`Provider viseme timeline had reached ${providerTimeline.durationMs}ms before abort.`]
                : [])
            ]
          })
        )
      }
      if (!aborted && streamError && (startDispatched || chunkCount > 0)) {
        const errorMs = Math.round(performance.now() - startedAt)
        const providerTimeline = buildRealtimeProviderLipSyncTimeline()
        this.logPlaybackMetrics(
          this.buildPlaybackMetrics({
            providerId: provider,
            analyzerId: providerTimeline?.analyzerId ?? 'batshit-text-timing',
            analyzerMode: providerTimeline ? 'provider-alignment' : 'fallback',
            metricKind: 'stream-error',
            runtimeMode: 'realtime',
            transport: 'http-ndjson',
            lipSyncMode: settings.goonLipSync?.mode ?? 'amplitude',
            messageId: meta.messageId,
            agentId: meta.agentId,
            text: item.text,
            mediaType,
            ttsTotalMs,
            firstAudioMs,
            streamTotalMs: errorMs,
            chunkCount,
            audioBytes,
            aborted: false,
            lipSyncDiagnostics: providerTimeline?.diagnostics ?? null,
            extraNotes: [
              `Realtime stream failed after ${errorMs}ms with ${chunkCount} audio chunks and ${audioBytes} audio bytes.`,
              ...(typeof firstAudioMs === 'number' ? [`First audio latency before failure was ${firstAudioMs}ms.`] : []),
              ...(providerTimeline
                ? [`Provider viseme timeline had reached ${providerTimeline.durationMs}ms before failure.`]
                : [])
            ]
          })
        )
      }
      reader.releaseLock()
      this.activeFetchController = null
      if (!aborted) {
        dispatchEnd()
      }
      playback.player?.stop()
      if (this.currentRealtimePlayer === playback.player) {
        this.currentRealtimePlayer = null
      }
      if (playback.player && this.currentAudio === playback.player.audio) {
        this.currentAudio = null
      }
    }
  }

  private parseRealtimeTtsLine(line: string): VoiceRealtimeTtsEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Realtime speech returned an invalid event.')
    }
    return parsed as VoiceRealtimeTtsEvent
  }

  private decodeBase64Audio(value: string): Uint8Array {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }

  private normalizeRealtimeAlignmentSnapshot(
    event: Extract<VoiceRealtimeTtsEvent, { type: 'audio' }>,
    provider: VoiceProviderId
  ): RealtimeAlignmentSnapshot | null {
    const alignment = event.alignment
    if (!alignment || typeof alignment !== 'object' || Array.isArray(alignment)) return null

    const rawSegments = (alignment as { segments?: unknown }).segments
    if (!Array.isArray(rawSegments)) return null

    const offsetSec =
      typeof event.chunkAudioOffsetSec === 'number' && Number.isFinite(event.chunkAudioOffsetSec)
        ? event.chunkAudioOffsetSec
        : 0
    const applyChunkOffset = provider !== 'inworld'
    const chunkSeq = typeof event.chunkSeq === 'number' ? event.chunkSeq : null
    const segments: VoiceRealtimeTtsAlignmentSegment[] = []

    for (const rawSegment of rawSegments) {
      if (!rawSegment || typeof rawSegment !== 'object' || Array.isArray(rawSegment)) continue
      const segment = rawSegment as {
        text?: unknown
        start?: unknown
        end?: unknown
        phoneticDetails?: unknown
      }
      const text = typeof segment.text === 'string' ? segment.text.trim() : ''
      const start = typeof segment.start === 'number' ? segment.start : Number(segment.start)
      const end = typeof segment.end === 'number' ? segment.end : Number(segment.end)
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue
      const phoneticDetails = Array.isArray(segment.phoneticDetails)
        ? segment.phoneticDetails
            .filter((item): item is Record<string, unknown> =>
              Boolean(item && typeof item === 'object' && !Array.isArray(item))
            )
            .map((item) => ({
              ...(typeof item.phoneSymbol === 'string' ? { phoneSymbol: item.phoneSymbol } : {}),
              ...(typeof item.startTimeSeconds === 'number'
                ? { startTimeSeconds: item.startTimeSeconds }
                : {}),
              ...(typeof item.durationSeconds === 'number'
                ? { durationSeconds: item.durationSeconds }
                : {}),
              ...(typeof item.visemeSymbol === 'string' ? { visemeSymbol: item.visemeSymbol } : {})
            }))
        : []
      segments.push({
        text,
        startSec: Math.max(0, applyChunkOffset ? offsetSec + start : start),
        endSec: Math.max(0, applyChunkOffset ? offsetSec + end : end),
        chunkSeq,
        chunkAudioOffsetSec: offsetSec,
        ...(phoneticDetails.length > 0 ? { phoneticDetails } : {})
      })
    }

    if (segments.length === 0) return null
    const rawDuration = (alignment as { audio_duration?: unknown }).audio_duration
    const duration = typeof rawDuration === 'number' ? rawDuration : Number(rawDuration)

    return {
      content: event.content ?? null,
      offsetSec,
      audioDurationSec: Number.isFinite(duration)
        ? applyChunkOffset
          ? offsetSec + duration
          : duration
        : null,
      segments
    }
  }

  private buildRealtimeAlignmentSegments(
    alignmentByChunk: Map<number, RealtimeAlignmentSnapshot>
  ): VoiceRealtimeTtsAlignmentSegment[] {
    return Array.from(alignmentByChunk.entries())
      .sort(([left], [right]) => left - right)
      .flatMap(([, snapshot]) => snapshot.segments)
      .sort((left, right) => left.startSec - right.startSec)
  }

  private schedulePrefetch(item: VoiceQueueItem) {
    const provider = this.getTtsProvider(item.voice?.provider)
    if (provider === 'browser') return
    if (this.shouldUseRealtimeTts(provider)) return
    if (item.prefetchQueued || item.audioPromise) return

    item.prefetchQueued = true
    this.prefetchQueue.push(item)
    this.runPrefetchQueue()
  }

  private runPrefetchQueue() {
    while (this.prefetchInFlight < MAX_PREFETCH_IN_FLIGHT) {
      const item = this.prefetchQueue.shift()
      if (!item) return

      const provider = this.getTtsProvider(item.voice?.provider)
      if (provider === 'browser') {
        continue
      }
      if (this.shouldUseRealtimeTts(provider)) {
        continue
      }
      if (item.audioPromise) {
        continue
      }

      this.prefetchInFlight += 1
      const controller = new AbortController()
      item.abortController = controller
      item.audioPromise = this.fetchSynthesizedAudio(item, controller.signal)
        .finally(() => {
          this.prefetchInFlight = Math.max(0, this.prefetchInFlight - 1)
          this.runPrefetchQueue()
        })
      void item.audioPromise.catch(() => {})
    }
  }

  private cancelPrefetches() {
    const pending = [...this.prefetchQueue, ...this.queue]
    for (const item of pending) {
      item.abortController?.abort()
      item.abortController = undefined
      item.audioPromise = undefined
      item.prefetchQueued = false
    }
    this.prefetchQueue = []
  }

  private async playWithBrowser(
    text: string,
    settings: VoiceSettings,
    meta?: { messageId?: string | null; agentId?: string | null }
  ) {
    if (!this.synthesis) return

    this.synthesis.cancel()

    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = DEFAULT_CLIENT_PLAYBACK_RATE
      utterance.volume = DEFAULT_CLIENT_PLAYBACK_VOLUME
      utterance.pitch = 1
      const lipSyncAnalysis = buildTextTimingLipSyncAnalysis({
        speakableText: text,
        playbackRate: DEFAULT_CLIENT_PLAYBACK_RATE
      })
      const lipSyncTimeline = this.withGoonLipSyncVisemeBlend(lipSyncAnalysis.timeline, settings)
      const durationMs =
        lipSyncTimeline?.durationMs ??
        estimateGoonLipSyncDurationMs(text, DEFAULT_CLIENT_PLAYBACK_RATE)
      const playbackMetrics = this.buildPlaybackMetrics({
        providerId: 'browser',
        analyzerId: lipSyncAnalysis.analyzerId,
        analyzerMode: 'fallback',
        messageId: meta?.messageId ?? null,
        agentId: meta?.agentId ?? null,
        text,
        audioDurationMs: durationMs,
        extraNotes: [
          ...(lipSyncAnalysis.warnings ?? []),
          ...(settings.goonLipSync?.mode === 'viseme'
            ? [
                'Browser speech synthesis does not expose final audio or synthesis timing, so Batshit used the text-timing fallback lane.'
              ]
            : [])
        ]
      })
      utterance.onstart = () => {
        this.logPlaybackMetrics(playbackMetrics)
        this.dispatchPlaybackEvent('batshit:voice-playback-start', {
          ...meta,
          mode: 'browser',
          durationMs,
          lipSyncMode: settings.goonLipSync?.mode ?? 'amplitude',
          lipSyncAnalyzerId: lipSyncAnalysis.analyzerId,
          lipSyncTimeline,
          playbackMetrics
        })
      }
      utterance.onend = () => {
        this.dispatchPlaybackEvent('batshit:voice-playback-end', {
          ...meta,
          mode: 'browser'
        })
        resolve()
      }
      utterance.onerror = () => {
        this.dispatchPlaybackEvent('batshit:voice-playback-end', {
          ...meta,
          mode: 'browser'
        })
        resolve()
      }
      this.currentUtterance = utterance
      this.synthesis?.speak(utterance)
    })
  }

  private async playAudioBuffer(
    buffer: ArrayBuffer,
    mediaType: string,
    settings: VoiceSettings,
    text: string,
    meta?: { messageId?: string | null; agentId?: string | null },
    lipSyncAnalysis = buildTextTimingLipSyncAnalysis({
      speakableText: text,
      playbackRate: DEFAULT_CLIENT_PLAYBACK_RATE
    }),
    playbackMetrics: GoonLipSyncPlaybackMetrics | null = null,
    reservedAudio?: HTMLAudioElement | null
  ) {
    const blob = new Blob([buffer], { type: mediaType })
    const url = URL.createObjectURL(blob)
    const audio = reservedAudio ?? new Audio()
    audio.src = url
    audio.load()
    audio.playbackRate = DEFAULT_CLIENT_PLAYBACK_RATE
    audio.volume = DEFAULT_CLIENT_PLAYBACK_VOLUME
    this.currentAudio = audio
    this.currentAudioObjectUrl = url
    let startDispatched = false
    let playbackSettled = false
    const estimatedDurationMs = estimateGoonLipSyncDurationMs(text, DEFAULT_CLIENT_PLAYBACK_RATE)
    const playbackRate = DEFAULT_CLIENT_PLAYBACK_RATE
    const baseLipSyncTimeline = this.withGoonLipSyncVisemeBlend(lipSyncAnalysis.timeline, settings)
    const resolveAudioDurationMs = () =>
      Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.round((audio.duration / playbackRate) * 1000)
        : null
    const resolveDurationMs = () =>
      resolveAudioDurationMs() ??
      baseLipSyncTimeline?.durationMs ??
      estimatedDurationMs
    const resolvePlaybackLipSyncTimeline = () => {
      const audioDurationMs = resolveAudioDurationMs()
      if (!baseLipSyncTimeline || !audioDurationMs) return baseLipSyncTimeline
      return normalizeGoonLipSyncTimelineDuration(baseLipSyncTimeline, audioDurationMs, {
        allowShrink: baseLipSyncTimeline.source === 'audio-analysis'
      })
    }

    const buildPlaybackMetricsForStart = () => {
      if (!playbackMetrics) return null
      return {
        ...playbackMetrics,
        audioDurationMs: resolveDurationMs()
      }
    }

    const resolvePlaybackDurationMs = (lipSyncTimeline: GoonLipSyncTimeline | null) =>
      lipSyncTimeline?.durationMs ??
      resolveAudioDurationMs() ??
      estimatedDurationMs

    const cleanupAudio = () => {
      if (this.currentAudioObjectUrl === url) {
        URL.revokeObjectURL(url)
        this.currentAudioObjectUrl = null
      }
      if (this.currentAudio === audio) {
        this.currentAudio = null
      }
      if (this.currentAudioResolve) {
        this.currentAudioResolve = null
      }
    }

    const dispatchStart = () => {
      if (startDispatched) return
      startDispatched = true
      const lipSyncTimeline = resolvePlaybackLipSyncTimeline()
      const durationMs = resolvePlaybackDurationMs(lipSyncTimeline)
      const playbackMetricsForStart = buildPlaybackMetricsForStart()
      this.logPlaybackMetrics(playbackMetricsForStart)
      this.dispatchPlaybackEvent('batshit:voice-playback-start', {
        ...meta,
        audio,
        duration: audio.duration,
        durationMs,
        lipSyncMode: settings.goonLipSync?.mode ?? 'amplitude',
        lipSyncAnalyzerId: lipSyncAnalysis.analyzerId,
        lipSyncTimeline,
        playbackMetrics: playbackMetricsForStart
      })
    }

    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (playbackSettled) return
        playbackSettled = true
        this.dispatchPlaybackEvent('batshit:voice-playback-end', {
          ...meta,
          audio
        })
        cleanupAudio()
        resolve()
      }

      audio.onloadedmetadata = () => {
        dispatchStart()
      }
      audio.onended = finish
      audio.onerror = finish
      this.currentAudioResolve = finish

      audio.play()
        .then(() => {
          if (!playbackSettled) {
            dispatchStart()
          }
        })
        .catch((error) => {
          if (playbackSettled) return
          cleanupAudio()
          reject(error)
        })
    })
  }

  pauseFor(durationMs: number) {
    if (durationMs <= 0) return
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout)
    }

    if (this.currentAudio) {
      this.currentAudio.pause()
      this.pauseTimeout = setTimeout(() => {
        this.currentAudio?.play().catch(() => {})
      }, durationMs)
      return
    }

    if (this.synthesis && this.currentUtterance) {
      this.synthesis.pause()
      this.pauseTimeout = setTimeout(() => {
        this.synthesis?.resume()
      }, durationMs)
    }
  }

  private dispatchPlaybackEvent(name: string, detail: Record<string, any>) {
    if (typeof window === 'undefined') return
    if (name === 'batshit:voice-playback-start') {
      this.publishPlaybackAudioToLiveKit(detail)
    } else if (name === 'batshit:voice-playback-end') {
      this.stopLiveKitPublishedAudio(detail)
    }
    window.dispatchEvent(new CustomEvent(name, { detail }))
  }

  private publishPlaybackAudioToLiveKit(detail: Record<string, any>): void {
    const handle = this.liveKitVoiceRoomHandle
    const audio = this.getLiveKitPublishableAudio(detail)
    if (!handle || !audio) return

    const key = this.getLiveKitPlaybackStartKey(detail, audio)
    const token = this.nextLiveKitPublishToken(key)
    this.stopLiveKitPublishedAudioByKey(key)

    void publishAudioElementToLiveKitRoom(handle, audio, {
      trackName: this.buildLiveKitTrackName(detail),
      streamName: 'batshit-voice'
    })
      .then((publishedAudio) => {
        const isCurrent =
          this.liveKitVoiceRoomHandle === handle &&
          this.liveKitPublishTokens.get(key) === token
        if (!isCurrent) {
          void publishedAudio.stop().catch((error) => {
            this.logLiveKitPublishWarning('stop stale published audio', error)
          })
          return
        }
        this.liveKitPublishedAudio.set(key, publishedAudio)
      })
      .catch((error) => {
        if (this.liveKitPublishTokens.get(key) === token) {
          this.liveKitPublishTokens.delete(key)
        }
        this.logLiveKitPublishWarning('publish playback audio', error)
      })
  }

  private stopLiveKitPublishedAudio(detail: Record<string, any>): void {
    const key = this.getLiveKitPlaybackEndKey(detail)
    if (!key) {
      this.stopAllLiveKitPublishedAudio()
      return
    }
    this.liveKitPublishTokens.delete(key)
    this.stopLiveKitPublishedAudioByKey(key)
  }

  private stopLiveKitPublishedAudioByKey(key: string): void {
    const publishedAudio = this.liveKitPublishedAudio.get(key)
    this.liveKitPublishedAudio.delete(key)
    if (!publishedAudio) return

    void publishedAudio.stop().catch((error) => {
      this.logLiveKitPublishWarning('unpublish playback audio', error)
    })
  }

  private stopAllLiveKitPublishedAudio(): void {
    this.liveKitPublishTokens.clear()
    for (const key of this.liveKitPublishedAudio.keys()) {
      this.stopLiveKitPublishedAudioByKey(key)
    }
    this.liveKitPublishedAudio.clear()
    this.liveKitPlaybackKeysByAudio = new WeakMap<HTMLMediaElement, string>()
  }

  private getLiveKitPublishableAudio(detail: Record<string, any>): HTMLMediaElement | null {
    const audio = detail.audio
    if (typeof HTMLMediaElement === 'undefined') return null
    return audio instanceof HTMLMediaElement ? audio : null
  }

  private getLiveKitPlaybackStartKey(
    detail: Record<string, any>,
    audio: HTMLMediaElement
  ): string {
    const messageKey = this.getLiveKitMessagePlaybackKey(detail)
    if (messageKey) {
      this.liveKitPlaybackKeysByAudio.set(audio, messageKey)
      return messageKey
    }

    const existingKey = this.liveKitPlaybackKeysByAudio.get(audio)
    if (existingKey) return existingKey

    const audioKey = `audio:${this.liveKitPublishSerial + 1}`
    this.liveKitPlaybackKeysByAudio.set(audio, audioKey)
    return audioKey
  }

  private getLiveKitPlaybackEndKey(detail: Record<string, any>): string | null {
    const messageKey = this.getLiveKitMessagePlaybackKey(detail)
    if (messageKey) return messageKey

    const audio = this.getLiveKitPublishableAudio(detail)
    return audio ? this.liveKitPlaybackKeysByAudio.get(audio) ?? null : null
  }

  private getLiveKitMessagePlaybackKey(detail: Record<string, any>): string | null {
    const messageId = typeof detail.messageId === 'string' ? detail.messageId.trim() : ''
    return messageId ? `message:${messageId}` : null
  }

  private nextLiveKitPublishToken(key: string): number {
    this.liveKitPublishSerial += 1
    this.liveKitPublishTokens.set(key, this.liveKitPublishSerial)
    return this.liveKitPublishSerial
  }

  private buildLiveKitTrackName(detail: Record<string, any>): string {
    const agent = this.sanitizeLiveKitTrackNameSegment(detail.agentId, 'agent')
    const message = this.sanitizeLiveKitTrackNameSegment(detail.messageId, 'speech')
    return `batshit-${agent}-${message}`.slice(0, 96)
  }

  private sanitizeLiveKitTrackNameSegment(value: unknown, fallback: string): string {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    const safe = normalized
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
    return safe || fallback
  }

  private logLiveKitPublishWarning(action: string, error: unknown): void {
    console.warn(`[VoiceService] Failed to ${action} for LiveKit voice room.`, error)
  }

  private async resolveNonBrowserLipSyncAnalysis(options: {
    buffer: ArrayBuffer
    mediaType: string
    text: string
    settings: VoiceSettings
    goonLipSyncActive: boolean
  }) {
    if (options.settings.goonLipSync?.mode !== 'viseme') {
      const fallback = buildTextTimingLipSyncAnalysis({
        speakableText: options.text,
        playbackRate: DEFAULT_CLIENT_PLAYBACK_RATE
      })
      return {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          `Goon lip sync mode resolved to "${options.settings.goonLipSync?.mode ?? 'unset'}", so Batshit used text timing for this utterance.`
        ],
        metrics: undefined
      }
    }

    const preferredAnalyzerId =
      options.settings.goonLipSync?.analyzerId ?? DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER

    const analyzerOrder: GoonLipSyncPremiumAnalyzerId[] =
      preferredAnalyzerId === 'audio2face-3d'
        ? ['audio2face-3d', 'rhubarb-wasm']
        : [preferredAnalyzerId]
    const failures: Array<{ analyzerId: GoonLipSyncPremiumAnalyzerId; reason: string }> = []

    for (const analyzerId of analyzerOrder) {
      try {
        const result = await analyzeAudioLedGoonLipSync({
          analyzerId,
          audioBuffer: options.buffer.slice(0),
          mediaType: options.mediaType,
          text: options.text
        })
        const audio2FaceFailure = failures.find((failure) => failure.analyzerId === 'audio2face-3d')

        return {
          analyzerId: result.timeline.analyzerId,
          runtime: 'client' as const,
          source: 'audio-analysis' as const,
          timeline: result.timeline,
          warnings: audio2FaceFailure
            ? [
                `NVIDIA Audio2Face failed before playback (${audio2FaceFailure.reason}), so Batshit used Rhubarb WASM for this utterance.`
              ]
            : ([] as string[]),
          metrics: result.metrics ?? undefined
        }
      } catch (error) {
        const reason = describeVoiceError(error)
        failures.push({ analyzerId, reason })
        console.warn(`[VoiceService] Lip sync analyzer "${analyzerId}" failed.`, error)
      }
    }

    const fallback = buildTextTimingLipSyncAnalysis({
      speakableText: options.text,
      playbackRate: DEFAULT_CLIENT_PLAYBACK_RATE
    })
    const failureWarning =
      preferredAnalyzerId === 'audio2face-3d'
        ? `NVIDIA Audio2Face failed before playback (${failures[0]?.reason ?? 'Unknown failure'}), and Rhubarb WASM also failed (${failures[1]?.reason ?? 'Unknown failure'}), so Batshit used text timing for this utterance.`
        : `Premium lip sync analyzer "${preferredAnalyzerId}" failed before playback (${failures[0]?.reason ?? 'Unknown failure'}), so Batshit used text timing for this utterance.`
    return {
      ...fallback,
      warnings: [...fallback.warnings, failureWarning],
      metrics: undefined
    }
  }

  private withGoonLipSyncVisemeBlend(
    timeline: GoonLipSyncTimeline | null | undefined,
    settings: VoiceSettings
  ): GoonLipSyncTimeline | null {
    if (!timeline) return null
    if (timeline.profile === ARKIT_52_FACE_DRIVER_PROFILE) {
      return { ...timeline, visemeBlendMs: 0 }
    }
    return {
      ...timeline,
      visemeBlendMs: normalizeGoonLipSyncVisemeBlendMs(settings.goonLipSync?.visemeBlendMs)
    }
  }

  private buildPlaybackMetrics(options: {
    providerId: string
    analyzerId: GoonLipSyncAnalyzerId
    analyzerMode: GoonLipSyncPlaybackMetrics['analyzerMode']
    metricKind?: GoonLipSyncPlaybackMetrics['metricKind']
    runtimeMode?: GoonLipSyncPlaybackMetrics['runtimeMode']
    transport?: string | null
    lipSyncMode?: string | null
    messageId?: string | null
    agentId?: string | null
    text: string
    mediaType?: string | null
    ttsTotalMs?: number | null
    lipSyncMetrics?: GoonLipSyncAnalyzerMetrics | null
    lipSyncDiagnostics?: GoonLipSyncPlaybackMetrics['lipSyncDiagnostics']
    audioDurationMs?: number | null
    firstAudioMs?: number | null
    streamTotalMs?: number | null
    abortMs?: number | null
    chunkCount?: number | null
    audioBytes?: number | null
    aborted?: boolean | null
    extraNotes?: string[]
  }): GoonLipSyncPlaybackMetrics {
    const notes = Array.from(
      new Set([
        ...(options.lipSyncMetrics?.notes ?? []),
        ...(options.extraNotes ?? [])
      ].filter((value): value is string => Boolean(value?.trim())))
    )
    const lipSyncTotalMs =
      typeof options.lipSyncMetrics?.totalMs === 'number' ? options.lipSyncMetrics.totalMs : null
    const prePlaybackTotalMs =
      (typeof options.ttsTotalMs === 'number' ? options.ttsTotalMs : 0) +
      (typeof lipSyncTotalMs === 'number' ? lipSyncTotalMs : 0)

    return {
      providerId: options.providerId,
      analyzerId: options.analyzerId,
      analyzerMode: options.analyzerMode,
      metricKind: options.metricKind ?? null,
      runtimeMode: options.runtimeMode ?? null,
      transport: options.transport ?? null,
      lipSyncMode: options.lipSyncMode ?? null,
      ttsTotalMs: options.ttsTotalMs ?? null,
      lipSyncTotalMs,
      prePlaybackTotalMs: prePlaybackTotalMs > 0 ? prePlaybackTotalMs : null,
      firstAudioMs: options.firstAudioMs ?? null,
      streamTotalMs: options.streamTotalMs ?? null,
      abortMs: options.abortMs ?? null,
      chunkCount: options.chunkCount ?? null,
      audioBytes: options.audioBytes ?? null,
      aborted: options.aborted ?? null,
      audioDurationMs: options.audioDurationMs ?? null,
      mediaType: options.mediaType ?? null,
      messageId: options.messageId ?? null,
      agentId: options.agentId ?? null,
      textPreview: this.buildPlaybackTextPreview(options.text),
      lipSyncDiagnostics: options.lipSyncDiagnostics ?? null,
      notes,
      capturedAt: new Date().toISOString()
    }
  }

  private buildPlaybackTextPreview(text: string) {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized.length <= 72) return normalized
    return `${normalized.slice(0, 69)}...`
  }

  private logPlaybackMetrics(metrics: GoonLipSyncPlaybackMetrics | null | undefined) {
    if (!metrics) return
    const lipSyncLabEnabled = Boolean(getUserSettings()?.admin_settings?.goon_lip_sync_lab_enabled)
    if (!import.meta.env.DEV && !lipSyncLabEnabled) return
    if (import.meta.env.DEV) {
      logger.debug('[VoicePlaybackMetrics]', metrics)
    }
    void this.persistPlaybackMetrics(metrics)
  }

  private async persistPlaybackMetrics(metrics: GoonLipSyncPlaybackMetrics) {
    try {
      await fetch('/api/voice/lip-sync/metrics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ metrics })
      })
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VoicePlaybackMetrics] Failed to persist metrics log.', error)
      }
    }
  }

  private async readApiError(response: Response, fallback: string): Promise<string> {
    const raw = await response.text().catch(() => '')
    if (!raw) return fallback

    try {
      const payload = JSON.parse(raw)
      if (typeof payload?.error === 'string' && payload.error.trim()) {
        const message = payload.error.trim()
        if (typeof payload?.setupHint === 'string' && payload.setupHint.trim()) {
          return `${message} ${payload.setupHint.trim()}`.trim()
        }
        return message
      }
    } catch {
      // Not JSON; fall through to raw text
    }

    const trimmed = raw.trim()
    return trimmed || fallback
  }

  private async recordAndTranscribe({
    stt
  }: {
    stt: { provider: VoiceProviderId; model?: string; language?: string }
  }): Promise<string> {
    const settings = this.getVoiceSettings()
    const stream = await this.requestVoiceInputStream(settings)

    this.activeStream = stream
    this.startRecordedAudioActivityMonitor(stream, this.voiceMode ? 'voice-mode' : 'dictation')

    const recorderConfig = resolveRecordedSttMimeType()
    const recorder = recorderConfig.mimeType
      ? new MediaRecorder(stream, { mimeType: recorderConfig.mimeType })
      : new MediaRecorder(stream)
    this.mediaRecorder = recorder
    const chunks: BlobPart[] = []

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data)
      }
    }

    const stopPromise = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })

    recorder.start()

    try {
      await stopPromise

      const mediaType = recorder.mimeType || recorderConfig.mimeType || 'audio/webm'
      const blob = new Blob(chunks, { type: mediaType })
      if (blob.size === 0) {
        throw new Error(
          'The microphone recording was empty. Check the selected input device and try again.'
        )
      }

      const extension = resolveAudioExtension(mediaType)
      const form = new FormData()
      form.append('audio', blob, `speech.${extension}`)
      form.append('provider', stt.provider)
      if (stt.model) {
        form.append('model', stt.model)
      }
      if (stt.language) {
        form.append('language', stt.language)
      }

      const response = await fetch('/api/voice/transcribe', {
        method: 'POST',
        body: form
      })

      if (!response.ok) {
        const errorMessage = await this.readApiError(response, 'Failed to transcribe audio')
        throw new Error(errorMessage)
      }

      const data = await response.json()
      return data?.text || ''
    } finally {
      this.stopRecordedAudioActivityMonitor()
      stream.getTracks().forEach((track) => track.stop())
      this.activeStream = null
      this.mediaRecorder = null
    }
  }
}

export const voiceService = new VoiceService()
