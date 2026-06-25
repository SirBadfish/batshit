import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { getVoiceEngineRecordByProviderId } from '$lib/server/services/voiceEngineRegistry'
import { rewriteLoopbackUrlToDockerHostForRuntime } from '$lib/server/services/runtimeUrlRewrites'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  normalizeVoiceModeTurnSettings,
  normalizeVoiceProviderId,
  normalizeVoiceSettings
} from '$lib/utils/voiceSchema'
import type { VoiceProviderId } from '$lib/types/voice'
import type { VoiceEngineRecord } from '$lib/types/voice'
import type {
  VoiceRealtimeSttAudioContract,
  VoiceRealtimeSttEphemeralToken,
  VoiceRealtimeSttEventType,
  VoiceRealtimeSttSessionContract,
  VoiceRealtimeSttSessionMode,
  VoiceRealtimeSttSessionProvider,
  VoiceRealtimeSttSessionRequest
} from '$lib/types/voiceRealtimeStt'

const REALTIME_STT_EVENTS: VoiceRealtimeSttEventType[] = [
  'start',
  'speech_start',
  'partial',
  'final',
  'endpoint',
  'speech_resume',
  'error',
  'end'
]

const OPENAI_REALTIME_TRANSCRIPTION_DOCS =
  'https://platform.openai.com/docs/guides/realtime-transcription'
const DEEPGRAM_FLUX_DOCS = 'https://developers.deepgram.com/docs/flux/quickstart'
const DEEPGRAM_TEMPORARY_TOKEN_DOCS =
  'https://developers.deepgram.com/guides/fundamentals/token-based-authentication'
const ELEVENLABS_REALTIME_STT_DOCS =
  'https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime'
const BATSHIT_BYO_REALTIME_STT_DOCS =
  'local Batshit BYO realtime STT WebSocket contract'
const DEEPGRAM_AUTH_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant'
const DEEPGRAM_REALTIME_STT_TOKEN_ENDPOINT = '/api/voice/realtime-stt/deepgram-token'
const DEEPGRAM_REALTIME_STT_TOKEN_TTL_SECONDS = 30
const DEEPGRAM_MEMBER_KEY_SETUP_HINT =
  'Deepgram realtime browser Voice Mode needs a Deepgram API key with Member or higher permissions because Batshit must call /v1/auth/grant to mint a temporary browser token. In the Deepgram Console, create a key with Advanced -> Permissions: Member, then save that key in Batshit Settings -> API Keys.'

export class RealtimeSttSessionSetupError extends Error {
  status: number
  setupHint?: string

  constructor(message: string, options?: { status?: number; setupHint?: string }) {
    super(message)
    this.name = 'RealtimeSttSessionSetupError'
    this.status = options?.status ?? 412
    this.setupHint = options?.setupHint
  }
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function cleanNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeRequestedProvider(provider?: VoiceProviderId | string | null): VoiceProviderId | null {
  return normalizeVoiceProviderId(provider) ?? null
}

async function resolveApiKey(userId: string, service: string, envKeys: string[]): Promise<boolean> {
  const stored = await resolveApiKeyValue(userId, service, envKeys)
  return Boolean(stored)
}

async function resolveApiKeyValue(
  userId: string,
  service: string,
  envKeys: string[]
): Promise<string | null> {
  const stored = await apiKeyService.retrieve(service, userId).catch(() => null)
  if (stored?.trim()) return stored.trim()

  for (const key of envKeys) {
    const value = env[key]?.trim()
    if (value) return value
  }

  return null
}

function missingKeyError(providerLabel: string, envKey: string): RealtimeSttSessionSetupError {
  return new RealtimeSttSessionSetupError(`${providerLabel} API key not configured.`, {
    setupHint: `Add a ${providerLabel} API key in Settings -> API Keys or set ${envKey} on the server.`
  })
}

function normalizeDeepgramTokenTtl(value?: number | null): number {
  if (!Number.isFinite(value) || !value) return DEEPGRAM_REALTIME_STT_TOKEN_TTL_SECONDS
  return Math.max(1, Math.min(3600, Math.floor(value)))
}

async function readUpstreamError(response: Response, fallback: string): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body.trim()) return fallback
  try {
    const parsed = JSON.parse(body)
    if (typeof parsed?.err_msg === 'string' && parsed.err_msg.trim()) return parsed.err_msg.trim()
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim()
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim()
  } catch {
    // Keep the upstream details generic for users; the raw body can include provider-specific noise.
  }
  return fallback
}

async function resolveProviderFromSettings(userId: string): Promise<VoiceProviderId> {
  const settings = await redis.getUserSettings(userId).catch(() => null)
  const normalized = normalizeVoiceSettings(settings?.voice_settings)
  return normalized.realtimeStt?.providerId ?? 'browser'
}

function withAudioDefaults(
  request: VoiceRealtimeSttSessionRequest,
  defaults: VoiceRealtimeSttAudioContract
): VoiceRealtimeSttAudioContract {
  return {
    encoding: cleanString(request.audio?.encoding) ?? defaults.encoding,
    sampleRate: cleanNumber(request.audio?.sampleRate, defaults.sampleRate),
    channels: cleanNumber(request.audio?.channels, defaults.channels),
    chunkMs:
      typeof request.audio?.chunkMs === 'number' &&
      Number.isFinite(request.audio.chunkMs) &&
      request.audio.chunkMs > 0
        ? request.audio.chunkMs
        : defaults.chunkMs
  }
}

function blockedCandidateReason(provider: VoiceRealtimeSttSessionProvider): string {
  if (provider === 'openai') {
    return 'OpenAI realtime transcription is source-backed, but Batshit has not built the server/WebRTC session bridge or live microphone smoke yet.'
  }
  if (provider === 'deepgram') {
    return 'Deepgram Flux is source-backed, but Batshit has not completed live microphone smoke in this session yet.'
  }
  return 'ElevenLabs Scribe v2 Realtime is source-backed, but Batshit has not built token minting, the client/session bridge, or live microphone smoke yet.'
}

function candidateMode(request: VoiceRealtimeSttSessionRequest): VoiceRealtimeSttSessionMode {
  return request.mode === 'livekit' ? 'livekit-candidate' : 'direct-provider-candidate'
}

function resolveDeepgramFluxModel(request: VoiceRealtimeSttSessionRequest): string {
  const requested = cleanString(request.model)
  if (requested === 'flux-general-en' || requested === 'flux-general-multi') return requested

  const language = cleanString(request.language)
  return language && language.toLowerCase() !== 'en' ? 'flux-general-multi' : 'flux-general-en'
}

function normalizePathWithDefault(value: string | undefined, fallback: string): string {
  const cleaned = cleanString(value)
  if (!cleaned) return fallback
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`
}

function buildWebSocketEndpoint(baseUrlValue: string | undefined, realtimePath: string): string {
  const baseUrl = cleanString(baseUrlValue)
  if (!baseUrl) {
    throw new RealtimeSttSessionSetupError('BYO realtime STT engine is missing its local base URL.', {
      setupHint: 'Re-register the realtime local STT engine with a local baseUrl such as http://127.0.0.1:8078.'
    })
  }

  const url = new URL(realtimePath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new RealtimeSttSessionSetupError('BYO realtime STT engine must use http(s) or ws(s).', {
      setupHint: 'Use a local HTTP/WebSocket endpoint for BYO realtime STT.'
    })
  }
  return url.toString()
}

function resolveByoRealtimeModel(
  record: VoiceEngineRecord,
  request: VoiceRealtimeSttSessionRequest
): string | undefined {
  const requested = cleanString(request.model)
  if (requested) return requested

  const configured = cleanString(record.sttDefaults?.modelId)
  if (configured) return configured

  const activeModelId = cleanString(record.sttModelCatalog?.activeModelId)
  const activeModel = record.sttModelCatalog?.models.find((model) => model.id === activeModelId)
  return cleanString(activeModel?.requestModel) ?? cleanString(activeModel?.filename) ?? cleanString(activeModel?.id)
}

function browserContract(provider: VoiceProviderId, request: VoiceRealtimeSttSessionRequest) {
  const audio = withAudioDefaults(request, {
    encoding: 'browser-dependent',
    sampleRate: 0,
    channels: 1
  })

  return {
    provider: 'browser',
    voiceProviderId: provider,
    mode: 'browser',
    ready: true,
    launchSupported: true,
    transport: 'browser-api',
    realtimeEvents: REALTIME_STT_EVENTS,
    audio,
    serverBridgeRequired: false,
    clientMayConnectDirectly: true,
    secretsExposed: false,
    providerConfig: {
      method: 'browser-api',
      docsUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API'
    },
    notes: [
      'Browser STT is the current free continuous Voice Mode lane.',
      'Support, privacy behavior, and recognition quality vary by browser and operating system.'
    ]
  } satisfies VoiceRealtimeSttSessionContract
}

async function openAiContract(
  userId: string,
  provider: VoiceProviderId,
  request: VoiceRealtimeSttSessionRequest
): Promise<VoiceRealtimeSttSessionContract> {
  const hasKey = await resolveApiKey(userId, 'openai', ['OPENAI_API_KEY'])
  if (!hasKey) throw missingKeyError('OpenAI', 'OPENAI_API_KEY')

  const language = cleanString(request.language)
  const model = cleanString(request.model) ?? 'gpt-realtime-whisper'
  const audio = withAudioDefaults(request, {
    encoding: 'audio/pcm',
    sampleRate: 24_000,
    channels: 1,
    chunkMs: 100
  })

  return {
    provider: 'openai',
    voiceProviderId: provider,
    mode: candidateMode(request),
    model,
    language,
    ready: true,
    launchSupported: false,
    launchBlockedReason: blockedCandidateReason('openai'),
    transport: 'provider-realtime-session',
    realtimeEvents: REALTIME_STT_EVENTS,
    audio,
    serverBridgeRequired: true,
    clientMayConnectDirectly: false,
    secretsExposed: false,
    providerConfig: {
      method: request.mode === 'livekit' ? 'webrtc' : 'websocket',
      endpoint: 'wss://api.openai.com/v1/realtime',
      docsUrl: OPENAI_REALTIME_TRANSCRIPTION_DOCS,
      messages: [
        {
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: {
                  type: audio.encoding,
                  rate: audio.sampleRate
                },
                transcription: {
                  model,
                  ...(language ? { language } : {})
                },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500
                }
              }
            }
          }
        }
      ]
    },
    notes: [
      'The server must own the OpenAI API key and create/bridge the realtime transcription session.',
      'Batshit chat message creation and Group routing must stay server-owned after final transcript events.'
    ]
  }
}

async function deepgramContract(
  userId: string,
  provider: VoiceProviderId,
  request: VoiceRealtimeSttSessionRequest
): Promise<VoiceRealtimeSttSessionContract> {
  const hasKey = await resolveApiKey(userId, 'deepgram', ['DEEPGRAM_API_KEY'])
  if (!hasKey) throw missingKeyError('Deepgram', 'DEEPGRAM_API_KEY')

  const language = cleanString(request.language)
  const model = resolveDeepgramFluxModel(request)
  const turnSettings = normalizeVoiceModeTurnSettings(request.voiceMode)
  const audio = withAudioDefaults(request, {
    encoding: 'linear16',
    sampleRate: 16_000,
    channels: 1,
    chunkMs: 80
  })
  const query: Record<string, string | number | boolean | string[]> = {
    model,
    encoding: audio.encoding,
    sample_rate: audio.sampleRate,
    eot_threshold: turnSettings.endOfTurnThreshold ?? 0.7,
    eot_timeout_ms: turnSettings.autoSubmitDelayMs ?? 1000
  }
  if (model === 'flux-general-multi' && language) {
    query.language_hint = [language]
  }

  return {
    provider: 'deepgram',
    voiceProviderId: provider,
    mode: 'direct-provider-candidate',
    model,
    language,
    ready: true,
    launchSupported: true,
    transport: 'provider-websocket',
    realtimeEvents: REALTIME_STT_EVENTS,
    audio,
    serverBridgeRequired: false,
    clientMayConnectDirectly: true,
    secretsExposed: false,
    providerConfig: {
      method: 'websocket',
      endpoint: 'wss://api.deepgram.com/v2/listen',
      docsUrl: DEEPGRAM_FLUX_DOCS,
      query,
      headers: ['Sec-WebSocket-Protocol'],
      auth: {
        kind: 'deepgram-temporary-token',
        tokenEndpoint: DEEPGRAM_REALTIME_STT_TOKEN_ENDPOINT,
        websocketProtocol: 'bearer',
        expiresInSeconds: DEEPGRAM_REALTIME_STT_TOKEN_TTL_SECONDS
      }
    },
    notes: [
      'Flux requires Deepgram /v2/listen and Flux model names, not the older /v1/listen STT endpoint.',
      'Batshit mints a short-lived Deepgram token for browser WebSocket handshakes; the saved API key stays server-side.',
      'StartOfTurn stops active TTS; EndOfTurn is the final submit point; TurnResumed cancels speculative submit.'
    ]
  }
}

async function elevenLabsContract(
  userId: string,
  provider: VoiceProviderId,
  request: VoiceRealtimeSttSessionRequest
): Promise<VoiceRealtimeSttSessionContract> {
  const hasKey = await resolveApiKey(userId, 'elevenlabs', ['ELEVENLABS_API_KEY'])
  if (!hasKey) throw missingKeyError('ElevenLabs', 'ELEVENLABS_API_KEY')

  const language = cleanString(request.language)
  const model = cleanString(request.model) ?? 'scribe_v2_realtime'
  const audio = withAudioDefaults(request, {
    encoding: 'pcm_16000',
    sampleRate: 16_000,
    channels: 1,
    chunkMs: 100
  })

  const query: Record<string, string | number | boolean> = {
    model_id: model,
    sample_rate: audio.sampleRate,
    audio_format: audio.encoding,
    include_timestamps: true
  }
  if (language) query.language_code = language

  return {
    provider: 'elevenlabs',
    voiceProviderId: provider,
    mode: candidateMode(request),
    model,
    language,
    ready: true,
    launchSupported: false,
    launchBlockedReason: blockedCandidateReason('elevenlabs'),
    transport: 'provider-websocket',
    realtimeEvents: REALTIME_STT_EVENTS,
    audio,
    serverBridgeRequired: true,
    clientMayConnectDirectly: false,
    secretsExposed: false,
    providerConfig: {
      method: 'websocket',
      endpoint: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
      docsUrl: ELEVENLABS_REALTIME_STT_DOCS,
      query,
      headers: ['xi-api-key']
    },
    notes: [
      'Browser-side ElevenLabs realtime STT needs a server-minted single-use token; Batshit must never expose xi-api-key.',
      'Committed transcript events are the Batshit submit boundary; partial transcript events only update draft text.'
    ]
  }
}

async function byoRealtimeContract(
  userId: string,
  provider: VoiceProviderId,
  request: VoiceRealtimeSttSessionRequest
): Promise<VoiceRealtimeSttSessionContract> {
  const record = await getVoiceEngineRecordByProviderId(userId, provider)
  if (!record) {
    throw new RealtimeSttSessionSetupError(`BYO realtime STT provider "${provider}" is not configured.`, {
      setupHint: 'Register a local realtime STT engine through the TTS/STT Engine Installer first.'
    })
  }
  if (record.enabled === false) {
    throw new RealtimeSttSessionSetupError(`BYO realtime STT provider "${record.name}" is disabled.`, {
      setupHint: 'Enable the engine in Settings -> Voice -> TTS/STT Engines after a passing health check.'
    })
  }
  if (record.supportsStt !== true) {
    throw new RealtimeSttSessionSetupError(`BYO provider "${record.name}" does not support STT.`, {
      setupHint: 'Choose a BYO engine that was registered with STT support.'
    })
  }

  const realtime = record.realtimeStt
  if (!realtime?.enabled || realtime.transport !== 'websocket') {
    throw new RealtimeSttSessionSetupError(
      `BYO provider "${record.name}" does not publish a realtime STT WebSocket contract.`,
      {
        setupHint:
          'Use the TTS/STT Engine Installer to add a separate realtime local STT lane, or keep this engine on uploaded-audio transcription.'
      }
    )
  }

  const authMode = record.authMode ?? 'none'
  if (authMode !== 'none' || record.authToken || record.authSavedKeyRef) {
    throw new RealtimeSttSessionSetupError(
      `BYO realtime STT provider "${record.name}" cannot be launched directly from the browser because it requires server-side auth.`,
      {
        setupHint:
          'Use a local no-auth loopback WebSocket endpoint, or add a Batshit-owned server bridge before enabling browser direct launch.'
      }
    )
  }

  const language = cleanString(request.language) ?? cleanString(record.sttDefaults?.language)
  const model = resolveByoRealtimeModel(record, request)
  const turnSettings = normalizeVoiceModeTurnSettings(request.voiceMode)
  const audio = withAudioDefaults(request, {
    encoding: cleanString(realtime.encoding) ?? 'linear16',
    sampleRate: cleanNumber(realtime.sampleRate, 16_000),
    channels: cleanNumber(realtime.channels, 1),
    chunkMs: cleanNumber(realtime.chunkMs, 100)
  })
  const realtimePath = normalizePathWithDefault(realtime.path, '/stream')
  const directEndpoint = buildWebSocketEndpoint(record.baseUrl, realtimePath)
  const endpoint =
    request.mode === 'livekit'
      ? (rewriteLoopbackUrlToDockerHostForRuntime(directEndpoint) ?? directEndpoint)
      : directEndpoint
  const query: Record<string, string | number | boolean> = {
    encoding: audio.encoding,
    sample_rate: audio.sampleRate,
    channels: audio.channels,
    chunk_ms: audio.chunkMs ?? 100,
    eot_timeout_ms: turnSettings.autoSubmitDelayMs ?? 1000,
    eot_threshold: turnSettings.endOfTurnThreshold ?? 0.7
  }
  if (model) query.model = model
  if (language) query.language = language

  const realtimeEvents: VoiceRealtimeSttEventType[] = [
    'start',
    'speech_start',
    ...(realtime.partialResults === true ? (['partial'] as VoiceRealtimeSttEventType[]) : []),
    ...(realtime.finalResults === false ? [] : (['final'] as VoiceRealtimeSttEventType[])),
    'endpoint',
    'error',
    'end'
  ]

  return {
    provider: 'byo',
    voiceProviderId: provider,
    mode: 'byo-local-websocket',
    model,
    language,
    ready: true,
    launchSupported: true,
    transport: 'byo-runtime',
    realtimeEvents,
    audio,
    serverBridgeRequired: false,
    clientMayConnectDirectly: true,
    secretsExposed: false,
    providerConfig: {
      method: 'websocket',
      endpoint,
      docsUrl: BATSHIT_BYO_REALTIME_STT_DOCS,
      query,
      messages: [
        {
          type: realtime.closeMessageType ?? 'CloseStream'
        }
      ]
    },
    notes: [
      `Local BYO realtime STT is provided by "${record.name}" over a loopback WebSocket.`,
      realtime.partialResults === true
        ? 'This engine contract advertises partial and final transcript events.'
        : 'This engine contract returns final turn transcripts only; no token-by-token partial transcript is claimed.',
      ...(realtime.notes ?? [])
    ]
  }
}

function unsupportedProviderError(provider: VoiceProviderId): RealtimeSttSessionSetupError {
  if (provider === 'fish') {
    return new RealtimeSttSessionSetupError('Fish Audio STT is recorded/uploaded-audio only in Batshit today.', {
      setupHint:
        'Use recorded Fish ASR through normal transcription, or choose Browser or Deepgram Flux for realtime Voice Mode.'
    })
  }

  if (provider === 'google') {
    return new RealtimeSttSessionSetupError('Google realtime STT is not supported in Batshit yet.', {
      setupHint: 'Choose Browser or Deepgram Flux for realtime Voice Mode.'
    })
  }

  if (provider === 'byo' || provider.startsWith('byo:') || provider.startsWith('local:')) {
    return new RealtimeSttSessionSetupError(
      'Realtime STT sessions for local/BYO engines need an explicit streaming engine contract before Batshit can launch them.',
      {
        setupHint:
          'Use the TTS/STT Engine Installer to register recorded local STT, or connect a realtime local engine that publishes Batshit\'s WebSocket contract.'
      }
    )
  }

  return new RealtimeSttSessionSetupError(`Realtime STT is not supported for provider "${provider}".`, {
    setupHint: 'Choose Browser or Deepgram Flux for realtime Voice Mode.'
  })
}

export async function createRealtimeSttSessionContract(
  userId: string,
  request: VoiceRealtimeSttSessionRequest = {}
): Promise<VoiceRealtimeSttSessionContract> {
  const provider =
    normalizeRequestedProvider(request.provider) ?? (await resolveProviderFromSettings(userId))

  if (provider === 'browser') return browserContract(provider, request)
  if (provider === 'openai') return openAiContract(userId, provider, request)
  if (provider === 'deepgram') return deepgramContract(userId, provider, request)
  if (provider === 'elevenlabs') return elevenLabsContract(userId, provider, request)
  if (provider.startsWith('byo:')) return byoRealtimeContract(userId, provider, request)

  throw unsupportedProviderError(provider)
}

export async function createDeepgramRealtimeSttEphemeralToken(
  userId: string,
  options: { ttlSeconds?: number | null } = {}
): Promise<VoiceRealtimeSttEphemeralToken> {
  const apiKey = await resolveApiKeyValue(userId, 'deepgram', ['DEEPGRAM_API_KEY'])
  if (!apiKey) throw missingKeyError('Deepgram', 'DEEPGRAM_API_KEY')

  const ttlSeconds = normalizeDeepgramTokenTtl(options.ttlSeconds)
  const response = await fetch(DEEPGRAM_AUTH_GRANT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ttl_seconds: ttlSeconds
    })
  })

  if (!response.ok) {
    const upstream = await readUpstreamError(
      response,
      'Deepgram rejected the temporary realtime STT token request.'
    )
    if (response.status === 403 && /insufficient permissions/i.test(upstream)) {
      throw new RealtimeSttSessionSetupError(
        'Deepgram API key cannot mint realtime STT browser tokens.',
        {
          status: 412,
          setupHint: `${DEEPGRAM_MEMBER_KEY_SETUP_HINT} Deepgram returned: ${upstream}. See ${DEEPGRAM_TEMPORARY_TOKEN_DOCS}.`
        }
      )
    }
    throw new RealtimeSttSessionSetupError('Failed to mint Deepgram realtime STT token.', {
      status: 502,
      setupHint: `${upstream} See ${DEEPGRAM_TEMPORARY_TOKEN_DOCS}.`
    })
  }

  const payload = await response.json().catch(() => null)
  const accessToken = cleanString(payload?.access_token)
  const expiresIn = cleanNumber(payload?.expires_in, ttlSeconds)
  if (!accessToken) {
    throw new RealtimeSttSessionSetupError('Deepgram temporary token response was missing access_token.', {
      status: 502,
      setupHint: `Deepgram token minting succeeded but returned an unexpected shape. See ${DEEPGRAM_TEMPORARY_TOKEN_DOCS}.`
    })
  }

  return {
    provider: 'deepgram',
    accessToken,
    tokenType: 'bearer',
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
  }
}

export function getRealtimeSttSessionSetupHint(error: unknown): string | undefined {
  return error instanceof RealtimeSttSessionSetupError ? error.setupHint : undefined
}
