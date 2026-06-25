import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents'
import type { JobContext } from '@livekit/agents'
import * as deepgram from '@livekit/agents-plugin-deepgram'
import * as google from '@livekit/agents-plugin-google'
import * as openai from '@livekit/agents-plugin-openai'
import * as xai from '@livekit/agents-plugin-xai'
import {
  BatshitRealtimeStt,
  type BatshitRealtimeSttContract
} from './batshit-realtime-stt.js'

const agentFile = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(agentFile), '../../..')

function parseEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return
  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [rawKey, ...rawValue] = line.split('=')
    const key = rawKey?.trim()
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = parseEnvValue(rawValue.join('='))
  }
}

loadEnvFile(resolve(repoRoot, '.env'))
loadEnvFile(resolve(repoRoot, 'batshit-app/.env'))

const agentName =
  process.env.LIVEKIT_VOICE_AGENT_NAME?.trim() ||
  process.env.LIVEKIT_AGENT_NAME?.trim() ||
  'batshit-livekit-agent'
const openAiRealtimeModel =
  process.env.LIVEKIT_AGENT_OPENAI_MODEL?.trim() ||
  process.env.LIVEKIT_AGENT_REALTIME_MODEL?.trim() ||
  'gpt-realtime-2'
const openAiRealtimeVoice = process.env.LIVEKIT_AGENT_OPENAI_VOICE?.trim() || 'marin'
const googleRealtimeModel =
  process.env.LIVEKIT_AGENT_GOOGLE_MODEL?.trim() || 'gemini-live-2.5-flash-native-audio'
const googleRealtimeVoice = process.env.LIVEKIT_AGENT_GOOGLE_VOICE?.trim() || 'Puck'
const xaiRealtimeModel =
  process.env.LIVEKIT_AGENT_XAI_MODEL?.trim() || 'grok-voice-think-fast-1.0'
const xaiRealtimeVoice = process.env.LIVEKIT_AGENT_XAI_VOICE?.trim() || 'ara'
const xaiTurnDetectionThreshold = parseNumberEnv(
  ['LIVEKIT_AGENT_XAI_TURN_THRESHOLD', 'LIVEKIT_AGENT_XAI_TURN_DETECTION_THRESHOLD'],
  0.85,
  0.1,
  0.9
)
const xaiTurnSilenceDurationMs = parseIntegerEnv(
  ['LIVEKIT_AGENT_XAI_SILENCE_DURATION_MS', 'LIVEKIT_AGENT_XAI_TURN_SILENCE_DURATION_MS'],
  900,
  100,
  10000
)
const xaiTurnPrefixPaddingMs = parseIntegerEnv(
  ['LIVEKIT_AGENT_XAI_PREFIX_PADDING_MS', 'LIVEKIT_AGENT_XAI_TURN_PREFIX_PADDING_MS'],
  333,
  0,
  2000
)
const transcriptionModel =
  process.env.LIVEKIT_AGENT_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe'
const deepgramTranscriptionModel =
  process.env.LIVEKIT_AGENT_DEEPGRAM_TRANSCRIPTION_MODEL?.trim() ||
  process.env.LIVEKIT_AGENT_DEEPGRAM_MODEL?.trim() ||
  'flux-general-en'
const transcriptionLanguage = process.env.LIVEKIT_AGENT_TRANSCRIPTION_LANGUAGE?.trim() || 'en'
const xaiTranscriptEndpointingMs = parseIntegerEnv(
  ['LIVEKIT_AGENT_XAI_STT_ENDPOINTING_MS', 'LIVEKIT_AGENT_XAI_TRANSCRIPT_ENDPOINTING_MS'],
  xaiTurnSilenceDurationMs,
  100,
  5000
)
const healthPortSource =
  process.env.LIVEKIT_AGENT_HEALTH_PORT?.trim() || process.env.LIVEKIT_AGENT_PORT?.trim() || '7899'
const healthPort = Number.parseInt(healthPortSource, 10)
if (!Number.isFinite(healthPort) || healthPort <= 0 || healthPort > 65535) {
  throw new Error(
    `LIVEKIT_AGENT_HEALTH_PORT must be a valid TCP port number, received "${healthPortSource}".`
  )
}
const instructions =
  process.env.LIVEKIT_AGENT_INSTRUCTIONS?.trim() ||
  [
    'You are Batshit’s experimental LiveKit voice sidecar.',
    'Talk naturally, keep replies short, and leave pauses so the user can interrupt.',
    'Do not speak markdown syntax, bullets, formatting markers, or emoji names out loud.',
    'If asked what you are, say you are the LiveKit voice runtime test agent for Batshit.'
  ].join(' ')

process.env.LIVEKIT_AGENT_NAME = agentName

type SidecarMode = 'batshit-bridge' | 'speech-to-speech'
type SpeechToSpeechProviderId = 'openai' | 'google' | 'xai'
type BridgeSttNativeProviderId = 'openai' | 'deepgram'
type BridgeSttAdapterKind = 'livekit-openai' | 'livekit-deepgram' | 'batshit-realtime-contract'
type LiveKitProviderKeyId = SpeechToSpeechProviderId | BridgeSttNativeProviderId
type LiveKitTurnKind =
  | 'final_transcript'
  | 'speech_started'
  | 'speech_to_speech_user_transcript'
  | 'speech_to_speech_assistant_message'
  | 'speech_to_speech_goon_cue'

type BridgeContext = {
  userId: string
  sessionId: string
  agentId: string
  roomName: string
  participantIdentity: string
  participantName: string
  stt: BridgeSttConfig
}

type BridgeSttConfig = {
  adapterKind: BridgeSttAdapterKind
  providerId: string
  modelId: string
  language: string
  voiceMode?: BridgeSttVoiceModeSettings
}

type BridgeSttVoiceModeSettings = {
  submitMode?: string
  autoSubmitDelayMs?: number
  endOfTurnThreshold?: number
}

type SpeechToSpeechContext = BridgeContext & {
  providerId: SpeechToSpeechProviderId
  modelId: string
  voiceId: string
  instructions: string
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanGoonCueName(value: unknown): string | null {
  const cueName = stringValue(value)
  if (!cueName || cueName.length > 80) return null
  return /^[a-zA-Z0-9 _-]+$/.test(cueName) ? cueName.replace(/\s+/g, ' ') : null
}

function firstEnvNumberValue(keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

function parseNumberEnv(keys: string[], fallback: number, min: number, max: number): number {
  const raw = firstEnvNumberValue(keys)
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function parseIntegerEnv(keys: string[], fallback: number, min: number, max: number): number {
  return Math.round(parseNumberEnv(keys, fallback, min, max))
}

function normalizeProviderId(value: unknown): SpeechToSpeechProviderId | null {
  const normalized = stringValue(value).toLowerCase()
  if (normalized === 'openai' || normalized === 'google' || normalized === 'xai') {
    return normalized
  }
  if (normalized === 'grok' || normalized === 'x-ai') return 'xai'
  if (
    normalized === 'gemini' ||
    normalized === 'google-ai' ||
    normalized === 'google-generative-ai' ||
    normalized === 'google-vertex' ||
    normalized === 'vertex-ai'
  ) {
    return 'google'
  }
  return null
}

function normalizeSidecarMode(value: unknown): SidecarMode | null {
  const normalized = stringValue(value).toLowerCase()
  if (
    normalized === 'batshit-bridge' ||
    normalized === 'batshit_bridge' ||
    normalized === 'bridge' ||
    normalized === 'path2' ||
    normalized === 'path-2'
  ) {
    return 'batshit-bridge'
  }
  if (
    normalized === 'openai-realtime' ||
    normalized === 'openai_realtime' ||
    normalized === 'realtime' ||
    normalized === 'speech-to-speech' ||
    normalized === 'speech_to_speech'
  ) {
    return 'speech-to-speech'
  }
  return null
}

function normalizeBridgeSttNativeProviderId(value: unknown): BridgeSttNativeProviderId | null {
  const normalized = stringValue(value).toLowerCase()
  if (normalized === 'openai') return 'openai'
  if (normalized === 'deepgram') return 'deepgram'
  return null
}

function isBatshitRealtimeSttContractProvider(value: unknown): boolean {
  const normalized = stringValue(value).toLowerCase()
  return normalized.startsWith('byo:') || normalized.startsWith('local:')
}

function numberMetadataValue(value: unknown): number | undefined {
  if (value === null || value === undefined || stringValue(value) === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(stringValue(value))
  return Number.isFinite(parsed) ? parsed : undefined
}

function resolveBridgeSttVoiceModeSettings(
  metadata: Record<string, unknown>
): BridgeSttVoiceModeSettings | undefined {
  const voiceMode: BridgeSttVoiceModeSettings = {}
  const submitMode = stringValue(metadata.bridgeSttSubmitMode)
  const autoSubmitDelayMs = numberMetadataValue(metadata.bridgeSttAutoSubmitDelayMs)
  const endOfTurnThreshold = numberMetadataValue(metadata.bridgeSttEndOfTurnThreshold)

  if (submitMode) voiceMode.submitMode = submitMode
  if (autoSubmitDelayMs !== undefined) voiceMode.autoSubmitDelayMs = autoSubmitDelayMs
  if (endOfTurnThreshold !== undefined) voiceMode.endOfTurnThreshold = endOfTurnThreshold

  return Object.keys(voiceMode).length > 0 ? voiceMode : undefined
}

function resolveBridgeSttModel(providerId: BridgeSttNativeProviderId, value: unknown): string {
  const requested = stringValue(value)
  if (providerId === 'deepgram') {
    return requested.startsWith('flux-') ? requested : deepgramTranscriptionModel
  }

  return !requested || requested === 'whisper-1' ? transcriptionModel : requested
}

function resolveBridgeSttConfig(metadata: Record<string, unknown>): BridgeSttConfig {
  const rawProvider =
    stringValue(metadata.bridgeSttProviderId) ||
    stringValue(metadata.sttProviderId) ||
    stringValue(metadata.sttProvider)
  if (!rawProvider) {
    throw new Error(
      'LiveKit bridge mode needs an explicit Voice Mode STT provider. Configure Voice Mode STT in the agent or Global Voice Settings; Batshit will not silently substitute a provider.'
    )
  }

  const nativeProviderId = normalizeBridgeSttNativeProviderId(rawProvider)
  const rawModel = metadata.bridgeSttModelId ?? metadata.sttModelId ?? metadata.sttModel
  const rawLanguage =
    stringValue(metadata.bridgeSttLanguage) ||
    stringValue(metadata.sttLanguage) ||
    transcriptionLanguage
  const voiceMode = resolveBridgeSttVoiceModeSettings(metadata)

  if (nativeProviderId) {
    const providerId = nativeProviderId
    return {
      adapterKind: providerId === 'deepgram' ? 'livekit-deepgram' : 'livekit-openai',
      providerId,
      modelId: resolveBridgeSttModel(providerId, rawModel),
      language: rawLanguage,
      ...(voiceMode ? { voiceMode } : {})
    }
  }

  if (isBatshitRealtimeSttContractProvider(rawProvider)) {
    return {
      adapterKind: 'batshit-realtime-contract',
      providerId: rawProvider,
      modelId: stringValue(rawModel),
      language: rawLanguage,
      ...(voiceMode ? { voiceMode } : {})
    }
  }

  if (stringValue(rawProvider).toLowerCase() === 'browser') {
    throw new Error(
      'Browser STT cannot run inside LiveKit bridge mode because it lives in the browser. Choose OpenAI, Deepgram, or a local/BYO realtime WebSocket STT engine for LiveKit bridge mode.'
    )
  }

  throw new Error(
    `LiveKit bridge STT does not currently support "${rawProvider}". Use a provider with a native LiveKit sidecar plugin, or install a Batshit realtime STT engine that exposes a local/BYO WebSocket contract.`
  )
}

function defaultModelForProvider(providerId: SpeechToSpeechProviderId): string {
  if (providerId === 'google') return googleRealtimeModel
  if (providerId === 'xai') return xaiRealtimeModel
  return openAiRealtimeModel
}

function defaultVoiceForProvider(providerId: SpeechToSpeechProviderId): string {
  if (providerId === 'google') return googleRealtimeVoice
  if (providerId === 'xai') return xaiRealtimeVoice
  return openAiRealtimeVoice
}

function resolveBatshitBaseUrl(): string {
  const raw =
    process.env.LIVEKIT_AGENT_BATSHIT_BASE_URL?.trim() ||
    process.env.LIVEKIT_AGENT_BATSHIT_URL?.trim() ||
    process.env.BATSHIT_FRONTEND_URL?.trim() ||
    process.env.PUBLIC_BASE_URL?.trim() ||
    process.env.ORIGIN?.trim() ||
    process.env.BATSHIT_APP_URL?.trim() ||
    ''
  if (raw) return raw.replace(/\/+$/, '')

  const port =
    process.env.BATSHIT_FRONTEND_PORT?.trim() ||
    '5620'
  return `http://localhost:${port}`
}

function resolveBatshitServiceToken(): string {
  const token =
    process.env.BATSHIT_TOKEN?.trim() ||
    process.env.MCP_GATEWAY_AUTH_TOKEN?.trim() ||
    process.env.LIVEKIT_AGENT_BATSHIT_TOKEN?.trim() ||
    ''
  if (!token) {
    throw new Error(
      'BATSHIT_TOKEN or MCP_GATEWAY_AUTH_TOKEN is required for LiveKit Batshit bridge mode.'
    )
  }
  return token
}

async function fetchBatshitProviderKey(
  userId: string,
  providerId: LiveKitProviderKeyId
): Promise<string> {
  const baseUrl = resolveBatshitBaseUrl()
  const token = resolveBatshitServiceToken()
  const response = await fetch(`${baseUrl}/api/voice/livekit/provider-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-request': '1',
      'x-batshit-service-token': token
    },
    body: JSON.stringify({
      userId,
      providerId
    })
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success === false || typeof payload?.apiKey !== 'string') {
    throw new Error(
      payload?.setupHint ||
        payload?.error ||
        `Batshit LiveKit provider key lookup failed with status ${response.status} at ${baseUrl}.`
    )
  }

  const apiKey = payload.apiKey.trim()
  if (!apiKey) {
    throw new Error(`Batshit LiveKit provider key lookup returned an empty ${providerId} key.`)
  }
  return apiKey
}

async function fetchBatshitRealtimeSttContract(
  userId: string,
  config: BridgeSttConfig
): Promise<BatshitRealtimeSttContract> {
  const baseUrl = resolveBatshitBaseUrl()
  const token = resolveBatshitServiceToken()
  const response = await fetch(`${baseUrl}/api/voice/realtime-stt/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-request': '1',
      'x-batshit-service-token': token
    },
    body: JSON.stringify({
      userId,
      provider: config.providerId,
      model: config.modelId || undefined,
      language: config.language || undefined,
      mode: 'livekit',
      ...(config.voiceMode ? { voiceMode: config.voiceMode } : {})
    })
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success === false) {
    throw new Error(
      payload?.setupHint ||
        payload?.error ||
        `Batshit realtime STT contract lookup failed with status ${response.status} at ${baseUrl}.`
    )
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Batshit realtime STT contract lookup returned an invalid response.')
  }

  return payload as BatshitRealtimeSttContract
}

function resolveBridgeContext(ctx: JobContext): BridgeContext {
  const metadata = parseJsonObject(ctx.job.metadata)
  const userId = stringValue(metadata.userId)
  const sessionId = stringValue(metadata.sessionId)
  const agentId = stringValue(metadata.agentId)
  const roomName =
    stringValue(metadata.roomName) || stringValue(ctx.room.name) || 'batshit-livekit-room'
  const participantIdentity =
    stringValue(ctx.info.acceptArguments.identity) || 'batshit-livekit-agent'
  const participantName = stringValue(ctx.info.acceptArguments.name) || agentName
  const stt = resolveBridgeSttConfig(metadata)

  if (!userId || !sessionId || !agentId) {
    throw new Error(
      'LiveKit Batshit bridge mode requires dispatch metadata with userId, sessionId, and agentId.'
    )
  }

  return {
    userId,
    sessionId,
    agentId,
    roomName,
    participantIdentity,
    participantName,
    stt
  }
}

function resolveSpeechToSpeechContext(ctx: JobContext): SpeechToSpeechContext {
  const metadata = parseJsonObject(ctx.job.metadata)
  const bridgeContext = resolveBridgeContext(ctx)
  const providerId = normalizeProviderId(metadata.providerId) || 'openai'
  const modelId = stringValue(metadata.modelId) || defaultModelForProvider(providerId)
  const voiceId = stringValue(metadata.voiceId) || defaultVoiceForProvider(providerId)

  return {
    ...bridgeContext,
    providerId,
    modelId,
    voiceId,
    instructions: stringValue(metadata.instructions) || instructions
  }
}

function buildXaiTurnDetection() {
  return {
    type: 'server_vad' as const,
    threshold: xaiTurnDetectionThreshold,
    prefix_padding_ms: xaiTurnPrefixPaddingMs,
    silence_duration_ms: xaiTurnSilenceDurationMs,
    create_response: true,
    interrupt_response: true
  }
}

function resolveMode(ctx: JobContext): SidecarMode {
  const metadata = parseJsonObject(ctx.job.metadata)
  return (
    normalizeSidecarMode(metadata.mode) ||
    normalizeSidecarMode(process.env.LIVEKIT_AGENT_MODE) ||
    'batshit-bridge'
  )
}

async function postBatshitBridgeTurn(
  kind: LiveKitTurnKind,
  context: BridgeContext,
  transcript?: string,
  options: {
    messageId?: string
    providerId?: SpeechToSpeechProviderId
    modelId?: string
    voiceId?: string
    metadata?: Record<string, unknown>
  } = {}
) {
  const baseUrl = resolveBatshitBaseUrl()
  const token = resolveBatshitServiceToken()
  const sidecarMode =
    kind.startsWith('speech_to_speech') || options.metadata?.mode === 'speech-to-speech'
      ? 'speech-to-speech'
      : 'batshit-bridge'
  const response = await fetch(`${baseUrl}/api/voice/livekit/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-request': '1',
      'x-batshit-service-token': token
    },
    body: JSON.stringify({
      kind,
      userId: context.userId,
      sessionId: context.sessionId,
      agentId: context.agentId,
      roomName: context.roomName,
      participantIdentity: context.participantIdentity,
      participantName: context.participantName,
      messageId: options.messageId,
      providerId: options.providerId,
      modelId: options.modelId,
      voiceId: options.voiceId,
      transcript,
      metadata: {
        source: 'livekit-agent-sidecar',
        sidecarMode,
        ...options.metadata
      }
    })
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success === false) {
    throw new Error(
      payload?.error ||
        payload?.details ||
        `Batshit LiveKit bridge turn failed with status ${response.status} at ${baseUrl}.`
    )
  }
  return payload
}

class BatshitBridgeAgent extends voice.Agent {
  constructor(private readonly bridgeContext: BridgeContext) {
    super({
      instructions:
        'You transcribe user turns for Batshit. Do not generate assistant replies; Batshit handles the selected agent, messages, tools, and speech.'
    })
  }

  async onUserTurnCompleted(
    _chatCtx: llm.ChatContext,
    newMessage: llm.ChatMessage
  ): Promise<void> {
    const transcript = newMessage.textContent?.trim()
    if (!transcript) return

    await postBatshitBridgeTurn('final_transcript', this.bridgeContext, transcript)
  }
}

async function startBatshitBridgeSession(ctx: JobContext) {
  const bridgeContext = resolveBridgeContext(ctx)
  const bridgeStt = await createBridgeStt(bridgeContext)

  await ctx.connect()

  const session = new voice.AgentSession({
    stt: bridgeStt,
    turnHandling: {
      turnDetection: 'stt',
      interruption: {
        enabled: true
      }
    }
  })

  let lastSpeechStartedAt = 0
  session.on(
    voice.AgentSessionEventTypes.UserStateChanged,
    (event: voice.UserStateChangedEvent) => {
      if (event.newState !== 'speaking') return
      const now = Date.now()
      if (now - lastSpeechStartedAt < 750) return
      lastSpeechStartedAt = now
      void postBatshitBridgeTurn('speech_started', bridgeContext).catch((error) => {
        console.warn('[batshit-livekit-sidecar] Failed to forward speech-start interruption:', error)
      })
    }
  )

  await session.start({
    room: ctx.room,
    agent: new BatshitBridgeAgent(bridgeContext)
  })

  console.info(
    `[batshit-livekit-sidecar] bridge connected room="${bridgeContext.roomName}" session="${bridgeContext.sessionId}" agent="${bridgeContext.agentId}" sttAdapter="${bridgeContext.stt.adapterKind}" sttProvider="${bridgeContext.stt.providerId}" sttModel="${bridgeContext.stt.modelId}"`
  )
}

async function createBridgeStt(context: BridgeContext) {
  const { stt: config } = context
  if (config.adapterKind === 'batshit-realtime-contract') {
    const contract = await fetchBatshitRealtimeSttContract(context.userId, config)
    return new BatshitRealtimeStt(contract)
  }

  const providerId = config.providerId as BridgeSttNativeProviderId
  const apiKey = await fetchBatshitProviderKey(context.userId, providerId)
  if (config.adapterKind === 'livekit-deepgram') {
    return new deepgram.STTv2({
      apiKey,
      model: config.modelId,
      language: config.language
    })
  }

  return new openai.STT({
    apiKey,
    model: config.modelId,
    language: config.language,
    useRealtime: true
  })
}

function createSpeechToSpeechRealtimeModel(
  context: SpeechToSpeechContext,
  apiKey: string
): llm.RealtimeModel {
  if (context.providerId === 'google') {
    return new google.beta.realtime.RealtimeModel({
      apiKey,
      model: context.modelId,
      voice: context.voiceId,
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    })
  }

  if (context.providerId === 'xai') {
    const options: xai.realtime.RealtimeModelOptions & {
      inputAudioTranscription: null
      turnDetection: ReturnType<typeof buildXaiTurnDetection>
    } = {
      apiKey,
      model: context.modelId,
      voice: context.voiceId,
      inputAudioTranscription: null,
      turnDetection: buildXaiTurnDetection()
    }
    return new xai.realtime.RealtimeModel(options)
  }

  return new openai.realtime.RealtimeModel({
    apiKey,
    model: context.modelId,
    voice: context.voiceId,
    inputAudioTranscription: {
      model: transcriptionModel
    },
    turnDetection: {
      type: 'semantic_vad',
      eagerness: 'medium',
      create_response: true,
      interrupt_response: true
    }
  })
}

function attachSpeechToSpeechForwarders(
  session: voice.AgentSession,
  context: SpeechToSpeechContext
) {
  const forwardedUserTranscripts = new Set<string>()
  const forwardedAssistantMessages = new Set<string>()
  let activeUserTranscriptMessageId: string | null = null
  let lastForwardedUserTranscript = ''
  let lastForwardedUserTranscriptAt = 0
  let userTranscriptSequence = 0
  let assistantMessageSinceLastUserTranscript = false
  const providerMetadata = {
    providerId: context.providerId,
    modelId: context.modelId,
    voiceId: context.voiceId
  }

  function normalizeTranscriptForComparison(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function mergeTranscriptIntoActiveTurn(transcript: string): {
    text: string
    startNewTurn: boolean
  } | null {
    const existing = lastForwardedUserTranscript.trim()
    if (!existing) {
      return { text: transcript, startNewTurn: false }
    }

    const normalizedTranscript = normalizeTranscriptForComparison(transcript)
    const normalizedExisting = normalizeTranscriptForComparison(existing)
    if (!normalizedTranscript) return null
    if (normalizedTranscript === normalizedExisting) return null
    if (normalizedExisting && normalizedExisting.startsWith(normalizedTranscript)) return null
    if (normalizedExisting && normalizedTranscript.startsWith(normalizedExisting)) {
      return { text: transcript, startNewTurn: false }
    }

    const now = Date.now()
    const withinXaiCoalescingWindow =
      context.providerId === 'xai' &&
      lastForwardedUserTranscriptAt > 0 &&
      now - lastForwardedUserTranscriptAt < 8_000

    if (withinXaiCoalescingWindow) {
      const separator = /[.!?]$/.test(existing) ? ' ' : '. '
      return { text: `${existing}${separator}${transcript}`, startNewTurn: false }
    }

    return { text: transcript, startNewTurn: true }
  }

  function resolveUserTranscriptForward(transcript: string): {
    messageId: string
    sequence: number
    isUpdate: boolean
    transcript: string
  } | null {
    const normalizedTranscript = normalizeTranscriptForComparison(transcript)
    if (!normalizedTranscript) return null

    const shouldContinueXaiTranscript =
      context.providerId === 'xai' &&
      activeUserTranscriptMessageId &&
      lastForwardedUserTranscriptAt > 0 &&
      Date.now() - lastForwardedUserTranscriptAt < 8_000

    const merge = assistantMessageSinceLastUserTranscript && !shouldContinueXaiTranscript
      ? { text: transcript, startNewTurn: true }
      : mergeTranscriptIntoActiveTurn(transcript)
    if (!merge) return null

    if (!activeUserTranscriptMessageId || merge.startNewTurn) {
      activeUserTranscriptMessageId = `livekit-user-${randomUUID()}`
      userTranscriptSequence = 0
    }

    userTranscriptSequence += 1
    lastForwardedUserTranscript = merge.text
    lastForwardedUserTranscriptAt = Date.now()
    assistantMessageSinceLastUserTranscript = false

    return {
      messageId: activeUserTranscriptMessageId,
      sequence: userTranscriptSequence,
      isUpdate: userTranscriptSequence > 1,
      transcript: merge.text
    }
  }

  let lastSpeechStartedAt = 0
  session.on(
    voice.AgentSessionEventTypes.UserStateChanged,
    (event: voice.UserStateChangedEvent) => {
      if (event.newState !== 'speaking') return
      const now = Date.now()
      if (now - lastSpeechStartedAt < 750) return
      lastSpeechStartedAt = now
      void postBatshitBridgeTurn('speech_started', context, undefined, {
        ...providerMetadata,
        metadata: {
          mode: 'speech-to-speech'
        }
      }).catch((error) => {
        console.warn(
          '[batshit-livekit-sidecar] Failed to forward speech-to-speech interruption:',
          error
        )
      })
    }
  )

  session.on(
    voice.AgentSessionEventTypes.UserInputTranscribed,
    (event: voice.UserInputTranscribedEvent) => {
      const transcript = event.transcript.trim()
      if (!transcript) return
      if (!event.isFinal) return

      const forward = resolveUserTranscriptForward(transcript)
      if (!forward) return

      const key = `${forward.messageId}:${forward.sequence}:${forward.transcript}`
      if (forwardedUserTranscripts.has(key)) return
      forwardedUserTranscripts.add(key)

      void postBatshitBridgeTurn('speech_to_speech_user_transcript', context, forward.transcript, {
        messageId: forward.messageId,
        ...providerMetadata,
        metadata: {
          mode: 'speech-to-speech',
          transcriptSequence: forward.sequence,
          transcriptUpdate: forward.isUpdate,
          isFinal: event.isFinal,
          language: event.language,
          speakerId: event.speakerId
        }
      }).catch((error) => {
        console.warn(
          '[batshit-livekit-sidecar] Failed to forward speech-to-speech user transcript:',
          error
        )
      })
    }
  )

  session.on(
    voice.AgentSessionEventTypes.ConversationItemAdded,
    (event: voice.ConversationItemAddedEvent) => {
      if (event.item.type !== 'message' || event.item.role !== 'assistant') return

      const transcript = event.item.textContent?.trim()
      if (!transcript) return

      const key = event.item.id || `${event.createdAt}:${transcript}`
      if (forwardedAssistantMessages.has(key)) return
      forwardedAssistantMessages.add(key)
      assistantMessageSinceLastUserTranscript = true

      void postBatshitBridgeTurn('speech_to_speech_assistant_message', context, transcript, {
        ...providerMetadata,
        metadata: {
          mode: 'speech-to-speech',
          itemId: event.item.id,
          interrupted: event.item.interrupted
        }
      }).catch((error) => {
        console.warn(
          '[batshit-livekit-sidecar] Failed to forward speech-to-speech assistant transcript:',
          error
        )
      })
    }
  )

  session.on(
    voice.AgentSessionEventTypes.FunctionToolsExecuted,
    (event: voice.FunctionToolsExecutedEvent) => {
      const names = event.functionCalls.map((call) => call.name).filter(Boolean)
      if (!names.length) return
      console.info(
        `[batshit-livekit-sidecar] speech-to-speech tool calls executed room="${context.roomName}" provider="${context.providerId}" tools="${names.join(',')}"`
      )
    }
  )
}

function createSpeechToSpeechToolContext(context: SpeechToSpeechContext): llm.ToolContext {
  return {
    goon_emote: llm.tool({
      description:
        'Silently trigger a Batshit Goon one-shot facial expression or gesture. Use exact cue names from the live Batshit session context. This tool is not spoken out loud and should be used instead of saying emoji names or writing emote tags.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Exact Goon emote cue name to trigger, such as Playful Wink, Happy Smile, side_eye, or the specific cue name listed in the live session context. Short aliases such as wink may work only when Batshit can map them to one enabled cue.'
          }
        },
        required: ['name'],
        additionalProperties: false
      },
      execute: async ({ name }: { name?: string }) => {
        const cueName = cleanGoonCueName(name)
        if (!cueName) return undefined

        console.info(
          `[batshit-livekit-sidecar] goon_emote tool called room="${context.roomName}" provider="${context.providerId}" cue="${cueName}"`
        )

        await postBatshitBridgeTurn('speech_to_speech_goon_cue', context, cueName, {
          messageId: `livekit-goon-cue-${randomUUID()}`,
          providerId: context.providerId,
          modelId: context.modelId,
          voiceId: context.voiceId,
          metadata: {
            mode: 'speech-to-speech',
            source: 'livekit-function-tool',
            cueName
          }
        }).catch((error) => {
          console.warn('[batshit-livekit-sidecar] Failed to forward Goon emote cue:', error)
        })

        return undefined
      }
    })
  }
}

async function startSpeechToSpeechSession(ctx: JobContext) {
  const speechContext = resolveSpeechToSpeechContext(ctx)
  const apiKey = await fetchBatshitProviderKey(speechContext.userId, speechContext.providerId)

  await ctx.connect()

  const sessionOptions: ConstructorParameters<typeof voice.AgentSession>[0] = {
    llm: createSpeechToSpeechRealtimeModel(speechContext, apiKey)
  }
  if (speechContext.providerId === 'xai') {
    sessionOptions.stt = new xai.STT({
      apiKey,
      interimResults: false,
      language: transcriptionLanguage,
      endpointing: xaiTranscriptEndpointingMs
    })
  }

  const session = new voice.AgentSession(sessionOptions)
  const agent = new voice.Agent({
    instructions: speechContext.instructions,
    tools: createSpeechToSpeechToolContext(speechContext)
  })
  attachSpeechToSpeechForwarders(session, speechContext)

  await session.start({
    room: ctx.room,
    agent
  })

  const greeting = process.env.LIVEKIT_AGENT_GREETING?.trim()
  if (greeting && greeting !== '0') {
    session.generateReply({
      instructions: greeting
    })
  }

  console.info(
    `[batshit-livekit-sidecar] speech-to-speech connected room="${speechContext.roomName}" session="${speechContext.sessionId}" agent="${speechContext.agentId}" provider="${speechContext.providerId}" model="${speechContext.modelId}" voice="${speechContext.voiceId}"`
  )
}

export default defineAgent({
  entry: async (ctx) => {
    const mode = resolveMode(ctx)
    if (mode === 'speech-to-speech') {
      await startSpeechToSpeechSession(ctx)
      return
    }

    await startBatshitBridgeSession(ctx)
  }
})

if (process.argv[1] === agentFile) {
  const serverOptions: ConstructorParameters<typeof ServerOptions>[0] = {
    agent: agentFile,
    agentName,
    agentNameIsEnv: true,
    port: healthPort
  }
  const wsURL = process.env.LIVEKIT_URL?.trim()
  const apiKey = process.env.LIVEKIT_API_KEY?.trim()
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim()
  if (wsURL) serverOptions.wsURL = wsURL
  if (apiKey) serverOptions.apiKey = apiKey
  if (apiSecret) serverOptions.apiSecret = apiSecret

  console.info(
    `[batshit-livekit-sidecar] agentName="${agentName}" defaultMode="${process.env.LIVEKIT_AGENT_MODE?.trim() || 'batshit-bridge'}" openaiModel="${openAiRealtimeModel}" googleModel="${googleRealtimeModel}" xaiModel="${xaiRealtimeModel}" bridgeOpenaiStt="${transcriptionModel}" bridgeDeepgramStt="${deepgramTranscriptionModel}" healthPort=${healthPort} batshitBaseUrl="${resolveBatshitBaseUrl()}"`
  )

  cli.runApp(new ServerOptions(serverOptions))
}
