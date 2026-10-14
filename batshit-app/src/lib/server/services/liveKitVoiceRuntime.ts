import { randomUUID } from 'node:crypto'
import { env } from '$env/dynamic/private'
import { AccessToken, AgentDispatchClient, type AgentDispatch, type VideoGrant } from 'livekit-server-sdk'
import { redis } from '$lib/server/redis'
import { databaseService } from '$lib/services/databaseRedis.server'
import { normalizeDesktopGoonPresentationMode } from '$lib/goons/desktopGoonPresentation'
import type {
  LiveKitVoiceSessionRequest,
  LiveKitVoiceSessionResponse
} from '$lib/types/voiceLiveKit'
import type { AgentRow } from '$lib/types/database'
import { LIVEKIT_VOICE_RUNTIME_ID, LIVEKIT_VOICE_TRANSPORT } from '$lib/types/voiceLiveKit'
import { apiKeyService, normalizeApiKeyServiceName } from '$lib/services/apiKey.server'
import {
  assertLiveKitSpeechToSpeechProviderReady,
  getLiveKitSpeechToSpeechProviderConfig,
  normalizeLiveKitSpeechToSpeechProviderId,
  type LiveKitSpeechToSpeechProviderId
} from '$lib/server/services/liveKitSpeechToSpeechProviders'
import { resolveUploadUrlForBrowser } from '$lib/server/services/batshitServerUrls'

const DEFAULT_TOKEN_TTL_SEC = 10 * 60
const MIN_TOKEN_TTL_SEC = 60
const MAX_TOKEN_TTL_SEC = 60 * 60
const DEFAULT_ROOM_PREFIX = 'batshit-voice'
export const DEFAULT_LIVEKIT_AGENT_NAME = 'batshit-livekit-agent'
const MAX_SPEECH_TO_SPEECH_INSTRUCTIONS_LENGTH = 48_000
const RESERVED_METADATA_KEYS = new Set([
  'runtime',
  'transport',
  'userId',
  'createdAt',
  'sessionId',
  'agentId',
  'groupId',
  'mode',
  'providerId',
  'modelId',
  'voiceId',
  'instructions'
])

export type LiveKitVoiceRuntimeEnv = Partial<Record<string, string | undefined>>

type LiveKitVoiceRuntimeConfig = {
  serverUrl: string
  dispatchServerUrl: string
  apiKey: string
  apiSecret: string
  tokenTtlSec: number
  roomPrefix: string
  selfHosted: boolean
  agentName: string | null
  autoDispatchAgent: boolean
}

type NormalizedSpeechToSpeechConfig = {
  enabled: true
  providerId: LiveKitSpeechToSpeechProviderId
  providerLabel: string
  adapterId: string | null
  modelId: string | null
  voiceId: string | null
  instructions: string | null
}

export type LiveKitVoiceTokenFactoryInput = {
  apiKey: string
  apiSecret: string
  identity: string
  name: string
  ttlSec: number
  metadata: string
  attributes: Record<string, string>
  grant: VideoGrant
}

export type LiveKitVoiceTokenFactory = (
  input: LiveKitVoiceTokenFactoryInput
) => Promise<string>

export type CreateLiveKitVoiceSessionOptions = {
  env?: LiveKitVoiceRuntimeEnv
  now?: Date
  nonce?: string
  tokenFactory?: LiveKitVoiceTokenFactory
  dispatchFactory?: LiveKitVoiceAgentDispatchFactory
  /**
   * The check run immediately before an agent dispatch: null admits it, else the refusal to show.
   * Defaults to `refuseLiveKitDispatchUnlessOwnSidecar` (BL-1311); tests replace it.
   */
  admitAgentDispatch?: () => Promise<string | null>
}

export type LiveKitVoiceAgentDispatchInput = {
  serverUrl: string
  apiKey: string
  apiSecret: string
  roomName: string
  agentName: string
  metadata: string
}

export type LiveKitVoiceAgentDispatchFactory = (
  input: LiveKitVoiceAgentDispatchInput
) => Promise<Pick<AgentDispatch, 'id'> & Partial<AgentDispatch>>

function firstEnvValue(source: LiveKitVoiceRuntimeEnv, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]?.trim()
    if (value) return value
  }
  return null
}

function parseTokenTtlSec(source: LiveKitVoiceRuntimeEnv): number {
  const raw = firstEnvValue(source, ['LIVEKIT_TOKEN_TTL_SEC', 'LIVEKIT_VOICE_TOKEN_TTL_SEC'])
  if (!raw) return DEFAULT_TOKEN_TTL_SEC

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error('LIVEKIT_TOKEN_TTL_SEC must be a number of seconds.')
  }

  return Math.max(MIN_TOKEN_TTL_SEC, Math.min(MAX_TOKEN_TTL_SEC, Math.round(parsed)))
}

function parseBooleanEnv(value: string | null): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function isContainerizedLiveKitRuntime(source: LiveKitVoiceRuntimeEnv): boolean {
  return source.BATSHIT_CONTAINERIZED === '1' || source.BATSHIT_RUNTIME_ENV === 'docker'
}

function isLoopbackLiveKitUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

function rewriteLoopbackLiveKitUrlForDockerHost(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.hostname = 'host.docker.internal'
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return value
  }
}

export function normalizeLiveKitServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('LIVEKIT_URL must be a valid ws://, wss://, http://, or https:// URL.')
  }

  if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:'

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('LIVEKIT_URL must use ws://, wss://, http://, or https://.')
  }

  return parsed.toString().replace(/\/+$/, '')
}

export function resolveLiveKitVoiceRuntimeConfig(
  source: LiveKitVoiceRuntimeEnv = env
): LiveKitVoiceRuntimeConfig {
  const serverUrl = firstEnvValue(source, ['LIVEKIT_URL', 'LIVEKIT_WS_URL'])
  const explicitDispatchServerUrl = firstEnvValue(source, [
    'LIVEKIT_INTERNAL_URL',
    'LIVEKIT_SERVER_INTERNAL_URL',
    'LIVEKIT_DISPATCH_URL'
  ])
  const apiKey = firstEnvValue(source, ['LIVEKIT_API_KEY'])
  const apiSecret = firstEnvValue(source, ['LIVEKIT_API_SECRET'])

  if (!serverUrl) {
    throw new Error('LiveKit URL not configured.')
  }

  if (!apiKey || !apiSecret) {
    throw new Error('LiveKit API key and API secret are required.')
  }

  const normalizedUrl = normalizeLiveKitServerUrl(serverUrl)
  const shouldUseExplicitDispatchServerUrl =
    Boolean(explicitDispatchServerUrl) &&
    (isLoopbackLiveKitUrl(normalizedUrl) ||
      parseBooleanEnv(firstEnvValue(source, ['LIVEKIT_FORCE_INTERNAL_URL'])))
  const dispatchServerUrl = shouldUseExplicitDispatchServerUrl
    ? normalizeLiveKitServerUrl(explicitDispatchServerUrl as string)
    : isContainerizedLiveKitRuntime(source) && isLoopbackLiveKitUrl(normalizedUrl)
      ? rewriteLoopbackLiveKitUrlForDockerHost(normalizedUrl)
      : normalizedUrl
  const roomPrefix = sanitizeLiveKitName(
    firstEnvValue(source, ['LIVEKIT_ROOM_PREFIX']) ?? DEFAULT_ROOM_PREFIX,
    DEFAULT_ROOM_PREFIX
  )
  const agentName = sanitizeLiveKitName(
    firstEnvValue(source, ['LIVEKIT_VOICE_AGENT_NAME', 'LIVEKIT_AGENT_NAME']) ??
      DEFAULT_LIVEKIT_AGENT_NAME,
    DEFAULT_LIVEKIT_AGENT_NAME
  )

  return {
    serverUrl: normalizedUrl,
    dispatchServerUrl,
    apiKey,
    apiSecret,
    tokenTtlSec: parseTokenTtlSec(source),
    roomPrefix,
    selfHosted: !normalizedUrl.includes('.livekit.cloud'),
    agentName: agentName || null,
    autoDispatchAgent: parseBooleanEnv(
      firstEnvValue(source, ['LIVEKIT_VOICE_AUTO_DISPATCH_AGENT', 'LIVEKIT_AUTO_DISPATCH_AGENT'])
    )
  }
}

async function retrieveLiveKitSetting(userId: string, service: string): Promise<string | null> {
  const stored = await apiKeyService.retrieve(service, userId).catch(() => null)
  const trimmed = stored?.trim()
  return trimmed || null
}

export async function resolveLiveKitVoiceRuntimeConfigForUser(
  userId: string,
  source: LiveKitVoiceRuntimeEnv = env
): Promise<LiveKitVoiceRuntimeConfig> {
  const [savedUrl, savedApiKey, savedApiSecret] = await Promise.all([
    retrieveLiveKitSetting(userId, 'livekit_url'),
    retrieveLiveKitSetting(userId, 'livekit_api_key'),
    retrieveLiveKitSetting(userId, 'livekit_api_secret')
  ])

  return resolveLiveKitVoiceRuntimeConfig({
    ...source,
    ...(savedUrl ? { LIVEKIT_URL: savedUrl } : {}),
    ...(savedApiKey ? { LIVEKIT_API_KEY: savedApiKey } : {}),
    ...(savedApiSecret ? { LIVEKIT_API_SECRET: savedApiSecret } : {})
  })
}

/**
 * This user's LiveKit settings, or null when LiveKit is not configured. Unlike
 * `resolveLiveKitVoiceRuntimeConfigForUser`, a settings read that fails throws instead of reading
 * as "not configured", and so does a setting that is saved but does not decrypt (the key store
 * reads that as missing): the launch-record tidy must never drop LiveKit's records because a
 * read failed (BL-1300).
 */
export async function readLiveKitVoiceRuntimeConfigForUser(
  userId: string,
  source: LiveKitVoiceRuntimeEnv = env
): Promise<LiveKitVoiceRuntimeConfig | null> {
  const read = async (service: string) => {
    const value = (await apiKeyService.retrieve(service, userId))?.trim() || null
    if (value === null && (await redis.exists(`api_keys:${userId}:${normalizeApiKeyServiceName(service)}`))) {
      throw new Error(`the saved LiveKit setting "${service}" cannot be read`)
    }
    return value
  }
  const [savedUrl, savedApiKey, savedApiSecret] = await Promise.all([
    read('livekit_url'),
    read('livekit_api_key'),
    read('livekit_api_secret')
  ])
  try {
    return resolveLiveKitVoiceRuntimeConfig({
      ...source,
      ...(savedUrl ? { LIVEKIT_URL: savedUrl } : {}),
      ...(savedApiKey ? { LIVEKIT_API_KEY: savedApiKey } : {}),
      ...(savedApiSecret ? { LIVEKIT_API_SECRET: savedApiSecret } : {})
    })
  } catch {
    return null
  }
}

export function sanitizeLiveKitName(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
  return normalized || fallback
}

function sanitizeParticipantName(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
  return normalized || 'Batshit User'
}

function truncateMetadataString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength)
}

type SpeechToSpeechInstructionContext = {
  providerId?: LiveKitSpeechToSpeechProviderId | null
}

function buildSpeechToSpeechVoiceAddendum(
  context: SpeechToSpeechInstructionContext = {}
): string {
  const lines = [
    '==== LIVEKIT TRUE SPEECH-TO-SPEECH VOICE MODE ====',
    '',
    'You are speaking through Batshit true speech-to-speech Voice Mode.',
    'Keep the conversation natural, responsive, and interruptible.',
    'Prefer concise spoken replies unless the user asks for depth.',
    "Match the selected Batshit agent personality and the user's tone. Do not default to a corporate support-agent, customer-service, sales-call, or compliance-bot vibe unless the agent prompt asks for that.",
    'Do not speak markdown syntax, bullet markers, formatting markers, XML/control tags, or emoji names out loud.',
    'When the LiveKit runtime exposes a goon_emote function/tool, use it silently for one-shot facial Goon Emotes instead of saying the Emote name or writing Emote syntax in your spoken response. Body gestures are standalone Goon Motions, not Emotes. If the user asks you to use a Goon Emote tool, actually call goon_emote; do not merely claim you used it.',
    'If a normal Batshit capability describes tools, clips, zips, Dynamic MCP, or subagents, treat that as product/runtime context. Do not claim a tool was used unless the realtime voice runtime has actually executed it.'
  ]

  if (context.providerId === 'xai') {
    lines.push(
      '',
      '==== GROK VOICE GOON CUE COMPATIBILITY ====',
      'Use the goon_emote function/tool for one-shot Goon emotes on Grok Voice. Pass the exact cue name, e.g. smile, wink, or side_eye.',
      'If the user says to wink, smile, or use a Goon emote, call goon_emote before or while speaking. Do not answer "I winked" unless you actually called the tool.',
      'Use exact Goon emote cue names from the Batshit live session context. The cue names are listed under Emotes, and in Emoji triggers they are the value after the equals sign, e.g. 😄=smile means call goon_emote with name="smile".',
      'xAI/Grok Voice transcripts may omit literal emoji characters, markdown-style asterisk cues, and XML-like emote tags before Batshit receives them, so emoji-only, *goon:*, <emote>wink</emote>, or <emote-wink>.</emote-wink> cues may not reach the Goon Dock reliably on this provider.',
      'For persistent Goon mood changes, continue using <batshit-cue>{"goon_mood":"mood_name"}</batshit-cue>.',
      'Never speak goon_emote calls, emote tags, or <batshit-cue> tags out loud. Batshit treats them as non-spoken control syntax, while the resulting Goon mood/emote state remains visible in the chat/avatar surface.'
    )
  }

  return lines.join('\n')
}

// BL-467 (reworked): the earlier version cut the ALREADY-COMPILED text by finding the
// first `<conversation>` line, but the system prompt comes first and is NOT escaped — a
// system prompt containing such a line would be found instead of the real one — and
// cutting AFTER compilation breaks the compiler's own guarantees (only the first message
// of a day carries a date; the zip index lists exactly the zips of the messages that are
// actually present; a Compact summary note can be the oldest element and carries its own
// rules). The fix instead asks the SOLE compiler (`databaseService.buildFormattedChatInput`
// in `databaseRedis.server.ts`) to compile with FEWER messages until the whole thing fits,
// so the compiler itself produces a valid `<conversation>` block with correct dates and zip
// index — see `compileSpeechToSpeechPrimaryInstructionsFitting` below.

// LiveKit's own dispatch/job metadata size limit (`docs.livekit.io/agents/server/agent-dispatch/`,
// verified 2026-09-28): "The metadata field is a string, limited to 512 KiB." Batshit's own
// `MAX_SPEECH_TO_SPEECH_INSTRUCTIONS_LENGTH` (48,000 characters) is a conservative target for
// keeping the realtime voice prompt compact, not LiveKit's hard limit — the two are checked
// separately below.
const LIVEKIT_DISPATCH_METADATA_MAX_BYTES = 512 * 1024

function getAssignedSubagentIds(agent: AgentRow): string[] {
  const ids = new Set<string>()
  for (const source of [agent.assigned_subagent_ids, (agent as any).assignedSubagents]) {
    if (!Array.isArray(source)) continue
    for (const id of source) {
      if (typeof id === 'string' && id.trim()) ids.add(id.trim())
    }
  }
  return Array.from(ids)
}

function normalizeAssignedSubagentRecord(value: unknown, fallbackId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, any>
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : fallbackId
  const name = row.name || row.displayName || row.display_name || id
  const displayName = row.displayName || row.display_name || row.name || id
  const avatar =
    typeof row.avatar === 'string'
      ? row.avatar
      : typeof row.avatar_url === 'string'
        ? row.avatar_url
        : null
  return {
    ...row,
    id,
    name,
    displayName,
    avatar: avatar ? resolveUploadUrlForBrowser(avatar) : null,
    primary_model_provider: row.primary_model_provider || row.provider || null,
    primary_model_name: row.primary_model_name || row.model || null,
    include_global_prompt: row.include_global_prompt !== false,
    system_prompt: row.system_prompt,
    settings: {
      ...(row.settings && typeof row.settings === 'object' ? row.settings : {}),
      system_prompt: row.system_prompt,
      primary_model_provider: row.primary_model_provider || row.provider || null,
      primary_model_name: row.primary_model_name || row.model || null,
      primary_model_temperature: row.primary_model_temperature,
      primary_model_max_tokens: row.primary_model_max_tokens,
      primary_model_top_p: row.primary_model_top_p,
      include_global_prompt: row.include_global_prompt !== false
    }
  }
}

function readBooleanMetadata(
  metadata: LiveKitVoiceSessionRequest['metadata'],
  key: string
): boolean | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const value = metadata[key]
  return typeof value === 'boolean' ? value : undefined
}

async function loadAssignedSubagentsForPrompt(userId: string, agent: AgentRow): Promise<any[]> {
  const ids = getAssignedSubagentIds(agent)
  if (!ids.length) return []

  const subagents = await Promise.all(
    ids.map(async (id) => {
      const value = await redis.json.get(`subagent:${id}`).catch(() => null)
      return normalizeAssignedSubagentRecord(value, id)
    })
  )
  return subagents.filter((subagent): subagent is any => subagent !== null)
}

/**
 * Compiles the primary system prompt + the one compiled DCM/history user message through
 * the sole compiler (`databaseService.buildFormattedChatInput`), for the given HISTORY
 * slice. `history` is passed in (never re-fetched here) so a caller can compile the same
 * chat with fewer messages without a second Redis round trip.
 */
async function compileSpeechToSpeechPrimaryInstructions(
  userId: string,
  request: LiveKitVoiceSessionRequest,
  agent: AgentRow,
  history: unknown[],
  assignedSubagents: any[],
  userSettings: { goons_settings?: unknown } | null
): Promise<string | null> {
  const sessionId = request.sessionId?.trim() || 'livekit-speech-to-speech'
  const contextSeedMessage = [
    'LiveKit true speech-to-speech voice session started.',
    'This is a Batshit runtime context snapshot for the realtime voice model.',
    'Do not treat this line as a user question.'
  ].join(' ')
  const formatted = await databaseService.buildFormattedChatInput(
    sessionId,
    history as any[],
    agent,
    contextSeedMessage,
    assignedSubagents,
    userId,
    {
      runtimeFlavor: 'vercel',
      voiceState: {
        stt: true,
        tts: true,
        voiceMode: 'speech-to-speech',
        provider: 'livekit',
        guidance: [
          'LiveKit true speech-to-speech model owns listening, reasoning, and speaking.'
        ]
      },
      goonsEnabled: readBooleanMetadata(request.metadata, 'goonsEnabled'),
      goonPresentationMode: normalizeDesktopGoonPresentationMode(
        request.metadata?.goonPresentationMode
      ),
      goonsSettings: userSettings?.goons_settings ?? null,
      // SA-128 (DP-1): the seed line is Batshit's, not the user's.
      currentMessageFrom: 'batshit'
    }
  )
  const primarySystemPrompt = formatted.primarySystemPrompt?.trim() || ''
  const firstMessage = formatted.structuredInput?.messages?.[0]
  const runtimeContext =
    typeof firstMessage?.content === 'string'
      ? firstMessage.content.trim()
      : Array.isArray(firstMessage?.content)
        ? firstMessage.content
            .map((part: any) => (typeof part?.text === 'string' ? part.text.trim() : ''))
            .filter(Boolean)
            .join('\n\n')
            .trim()
        : ''

  return [
    primarySystemPrompt,
    runtimeContext
      ? `==== BATSHIT LIVE SESSION DYNAMIC CONTEXT SNAPSHOT ====\n\n${runtimeContext}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n') || null
}

/**
 * BL-467: shortens realtime voice HISTORY from its OLDEST end by asking the compiler for
 * fewer messages, never by cutting compiled text. `history` is fetched ONCE (head-first,
 * oldest-to-newest, per `getRecentMessages`); dropping from the oldest end means keeping
 * its TAIL (`history.slice(history.length - count)`), so the compiler always sees a
 * contiguous, chronologically valid slice — the first remaining message still carries its
 * own date, and the zip index the compiler builds only ever lists zips of messages that are
 * actually present.
 *
 * `budgetChars` is the room left for THIS compiled result once the caller's fixed trailing
 * parts (the LiveKit session instructions, the voice addendum) are reserved. A binary search
 * over the message count keeps the compile cost bounded (at most ~8 compiles for 80
 * messages) instead of compiling every count from 80 down to 0.
 */
async function compileSpeechToSpeechPrimaryInstructionsFitting(
  userId: string,
  request: LiveKitVoiceSessionRequest,
  agent: AgentRow,
  budgetChars: number
): Promise<{ compiledPrompt: string | null; totalMessages: number; keptMessages: number }> {
  const sessionId = request.sessionId?.trim() || 'livekit-speech-to-speech'
  const [history, assignedSubagents, userSettings] = await Promise.all([
    // SA-113 P3 (F-P2-1): the RECENT 80. `getMessages` is head-first, so a voice session
    // resumed on a long chat was seeded with that chat's opening exchange.
    request.sessionId?.trim() ? redis.getRecentMessages(sessionId, 80).catch(() => []) : [],
    loadAssignedSubagentsForPrompt(userId, agent),
    redis.getUserSettings(userId).catch(() => null)
  ])
  const totalMessages = (history as unknown[]).length

  const compileWithCount = (count: number) =>
    compileSpeechToSpeechPrimaryInstructions(
      userId,
      request,
      agent,
      (history as unknown[]).slice(totalMessages - count),
      assignedSubagents,
      userSettings
    )

  const fits = (compiled: string | null) => compiled === null || compiled.length <= budgetChars

  // Normal case: the full history already fits — ONE compile, no search.
  const fullCompiled = await compileWithCount(totalMessages)
  if (fits(fullCompiled)) {
    return { compiledPrompt: fullCompiled, totalMessages, keptMessages: totalMessages }
  }

  // Zero history is the floor: if even that does not fit, there is nothing left to drop —
  // hand the caller that result so it can decide (LiveKit's real limit, downstream).
  const zeroCompiled = await compileWithCount(0)
  if (totalMessages === 0 || !fits(zeroCompiled)) {
    return { compiledPrompt: zeroCompiled, totalMessages, keptMessages: 0 }
  }

  // Binary search the largest message count in (0, totalMessages) that still fits. Fewer
  // messages means less `<conversation>` text, so "fits" is monotonic in the count.
  let lo = 1
  let hi = totalMessages - 1
  let bestCount = 0
  let bestCompiled = zeroCompiled
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = await compileWithCount(mid)
    if (fits(candidate)) {
      bestCount = mid
      bestCompiled = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return { compiledPrompt: bestCompiled, totalMessages, keptMessages: bestCount }
}

function normalizeSpeechToSpeechConfig(
  request: LiveKitVoiceSessionRequest
): Omit<NormalizedSpeechToSpeechConfig, 'instructions'> | null {
  const raw = request.speechToSpeech
  if (!raw || raw.enabled === false) return null

  const providerId = normalizeLiveKitSpeechToSpeechProviderId(raw.providerId)
  if (!providerId) {
    throw new Error('A supported speech-to-speech provider is required for LiveKit speech-to-speech.')
  }

  const providerConfig = getLiveKitSpeechToSpeechProviderConfig(providerId)
  return {
    enabled: true,
    providerId,
    providerLabel:
      typeof raw.providerLabel === 'string' && raw.providerLabel.trim()
        ? truncateMetadataString(raw.providerLabel.trim(), 80)
        : providerConfig.label,
    adapterId:
      typeof raw.adapterId === 'string' && raw.adapterId.trim()
        ? truncateMetadataString(raw.adapterId.trim(), 80)
        : null,
    modelId:
      typeof raw.modelId === 'string' && raw.modelId.trim()
        ? truncateMetadataString(raw.modelId.trim(), 120)
        : null,
    voiceId:
      typeof raw.voiceId === 'string' && raw.voiceId.trim()
        ? truncateMetadataString(raw.voiceId.trim(), 120)
        : null
  }
}

async function resolveSpeechToSpeechInstructions(
  userId: string,
  request: LiveKitVoiceSessionRequest,
  context: SpeechToSpeechInstructionContext = {}
): Promise<string | null> {
  const requestedInstructions = request.speechToSpeech?.instructions?.trim()
  const agentId = request.agentId?.trim()
  if (!agentId) {
    throw new Error(
      'LiveKit speech-to-speech session could not start because no selected Batshit agent was provided for prompt compilation.'
    )
  }

  let agents: AgentRow[]
  try {
    agents = await redis.getAgents(userId)
  } catch (error) {
    console.error('[voice/livekit/session] Failed to load agent for speech-to-speech prompt:', error)
    throw new Error(
      'LiveKit speech-to-speech session could not start because Batshit could not load the selected agent prompt.'
    )
  }
  const agent = agents.find(
    (candidate): candidate is AgentRow => candidate.id === agentId && candidate.user_id === userId
  )
  if (!agent) {
    throw new Error(
      'LiveKit speech-to-speech session could not start because Batshit could not load the selected agent prompt.'
    )
  }

  // Fixed, never trimmed: computed BEFORE compiling so the compile's own budget can reserve
  // exact room for them, mirroring the join below byte-for-byte.
  const sessionInstructionsBlock = requestedInstructions
    ? `==== LIVEKIT SPEECH-TO-SPEECH SESSION INSTRUCTIONS ====\n\n${truncateMetadataString(requestedInstructions, 12000)}`
    : ''
  const voiceAddendum = buildSpeechToSpeechVoiceAddendum(context)
  const reservedSuffixLength =
    (sessionInstructionsBlock ? `\n\n${sessionInstructionsBlock}` : '').length +
    `\n\n${voiceAddendum}`.length
  const budgetForCompiledPrompt = Math.max(
    0,
    MAX_SPEECH_TO_SPEECH_INSTRUCTIONS_LENGTH - reservedSuffixLength
  )

  let compileResult: {
    compiledPrompt: string | null
    totalMessages: number
    keptMessages: number
  }
  try {
    compileResult = await compileSpeechToSpeechPrimaryInstructionsFitting(
      userId,
      request,
      agent,
      budgetForCompiledPrompt
    )
  } catch (error) {
    console.error('[voice/livekit/session] Failed to compile speech-to-speech primary prompt:', error)
    throw new Error(
      'LiveKit speech-to-speech session could not start because Batshit could not compile the selected agent prompt.'
    )
  }
  const { compiledPrompt, totalMessages, keptMessages } = compileResult
  if (!compiledPrompt) {
    throw new Error(
      'LiveKit speech-to-speech session could not start because Batshit compiled empty agent instructions.'
    )
  }

  if (keptMessages < totalMessages) {
    console.warn(
      '[voice/livekit] Trimmed the oldest realtime voice history to fit the LiveKit speech-to-speech dispatch metadata budget:',
      {
        budget: MAX_SPEECH_TO_SPEECH_INSTRUCTIONS_LENGTH,
        totalMessages,
        keptMessages,
        droppedMessages: totalMessages - keptMessages
      }
    )
  }

  const core = [compiledPrompt, sessionInstructionsBlock].filter(Boolean).join('\n\n')
  const suffix = core ? `\n\n${voiceAddendum}` : voiceAddendum
  // Batshit's own budget (`MAX_SPEECH_TO_SPEECH_INSTRUCTIONS_LENGTH`) may still be exceeded
  // here (even zero history did not fit). That is not decided HERE: the real question is
  // whether the actual LiveKit dispatch metadata JSON — built later, once `roomName` and
  // `createdAt` exist — fits LiveKit's own 512 KiB limit. See `LIVEKIT_DISPATCH_METADATA_MAX_BYTES`
  // at the dispatch call site in `createLiveKitVoiceSession`.
  return `${core}${suffix}`
}

function buildRoomName(
  request: LiveKitVoiceSessionRequest,
  config: LiveKitVoiceRuntimeConfig,
  nonce: string
): string {
  const explicitRoom = sanitizeLiveKitName(request.roomName, '')
  if (explicitRoom) return explicitRoom

  const scope =
    sanitizeLiveKitName(request.groupId, '') ||
    sanitizeLiveKitName(request.sessionId, '') ||
    sanitizeLiveKitName(request.agentId, '') ||
    'session'

  return sanitizeLiveKitName(`${config.roomPrefix}-${scope}-${nonce}`, `${config.roomPrefix}-${nonce}`)
}

function normalizeMetadata(
  request: LiveKitVoiceSessionRequest,
  userId: string,
  createdAt: string,
  speechToSpeech: NormalizedSpeechToSpeechConfig | null
): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {
    runtime: LIVEKIT_VOICE_RUNTIME_ID,
    transport: LIVEKIT_VOICE_TRANSPORT,
    userId,
    createdAt
  }

  if (request.sessionId) metadata.sessionId = request.sessionId
  if (request.agentId) metadata.agentId = request.agentId
  if (request.groupId) metadata.groupId = request.groupId
  if (speechToSpeech) {
    metadata.mode = 'speech-to-speech'
    metadata.providerId = speechToSpeech.providerId
    if (speechToSpeech.modelId) metadata.modelId = speechToSpeech.modelId
    if (speechToSpeech.voiceId) metadata.voiceId = speechToSpeech.voiceId
  }

  if (request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)) {
    for (const [key, value] of Object.entries(request.metadata)) {
      if (RESERVED_METADATA_KEYS.has(key)) continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        metadata[key] = value
      }
    }
  }

  return metadata
}

function normalizeAgentDispatchMetadata(
  request: LiveKitVoiceSessionRequest,
  userId: string,
  roomName: string,
  createdAt: string,
  speechToSpeech: NormalizedSpeechToSpeechConfig | null
): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {
    runtime: LIVEKIT_VOICE_RUNTIME_ID,
    transport: LIVEKIT_VOICE_TRANSPORT,
    userId,
    roomName,
    createdAt
  }

  if (request.sessionId) metadata.sessionId = request.sessionId
  if (request.agentId) metadata.agentId = request.agentId
  if (request.groupId) metadata.groupId = request.groupId

  if (speechToSpeech) {
    metadata.mode = 'speech-to-speech'
    metadata.providerId = speechToSpeech.providerId
    metadata.providerLabel = speechToSpeech.providerLabel
    if (speechToSpeech.adapterId) metadata.adapterId = speechToSpeech.adapterId
    if (speechToSpeech.modelId) metadata.modelId = speechToSpeech.modelId
    if (speechToSpeech.voiceId) metadata.voiceId = speechToSpeech.voiceId
    if (speechToSpeech.instructions) metadata.instructions = speechToSpeech.instructions
  }

  const clientMetadata = request.agentDispatch?.metadata
  if (clientMetadata && typeof clientMetadata === 'object' && !Array.isArray(clientMetadata)) {
    for (const [key, value] of Object.entries(clientMetadata)) {
      if (RESERVED_METADATA_KEYS.has(key) || key === 'roomName') continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        metadata[key] = value
      }
    }
  }

  return metadata
}

async function defaultLiveKitTokenFactory(input: LiveKitVoiceTokenFactoryInput): Promise<string> {
  const token = new AccessToken(input.apiKey, input.apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl: input.ttlSec,
    metadata: input.metadata,
    attributes: input.attributes
  })
  token.addGrant(input.grant)
  return token.toJwt()
}

/** In native Batshit, only this Batshit's own sidecar may take its sessions (BL-1311). */
async function defaultAdmitLiveKitAgentDispatch(): Promise<string | null> {
  // Loaded at call time: the sidecar module imports this one.
  const { refuseLiveKitDispatchUnlessOwnSidecar } = await import('$lib/server/services/liveKitSidecarRuntime')
  return refuseLiveKitDispatchUnlessOwnSidecar()
}

async function defaultLiveKitAgentDispatchFactory(
  input: LiveKitVoiceAgentDispatchInput
): Promise<Pick<AgentDispatch, 'id'> & Partial<AgentDispatch>> {
  const client = new AgentDispatchClient(input.serverUrl, input.apiKey, input.apiSecret)
  return await client.createDispatch(input.roomName, input.agentName, {
    metadata: input.metadata
  })
}

function resolveAgentDispatch(
  request: LiveKitVoiceSessionRequest,
  config: LiveKitVoiceRuntimeConfig
): {
  requested: boolean
  required: boolean
  agentName: string | null
} {
  const requested = request.agentDispatch?.enabled === true || config.autoDispatchAgent
  const disabled = request.agentDispatch?.enabled === false
  const required = request.agentDispatch?.required === true
  const agentName = sanitizeLiveKitName(request.agentDispatch?.agentName ?? config.agentName, '')

  return {
    requested: disabled ? false : requested,
    required,
    agentName: agentName || null
  }
}

export async function createLiveKitVoiceSession(
  userId: string,
  request: LiveKitVoiceSessionRequest = {},
  options: CreateLiveKitVoiceSessionOptions = {}
): Promise<LiveKitVoiceSessionResponse> {
  if (!userId.trim()) {
    throw new Error('User id is required to create a LiveKit voice session.')
  }

  const config = options.env
    ? resolveLiveKitVoiceRuntimeConfig(options.env)
    : await resolveLiveKitVoiceRuntimeConfigForUser(userId, env)
  const now = options.now ?? new Date()
  const createdAt = now.toISOString()
  const nonce = sanitizeLiveKitName(options.nonce ?? randomUUID(), 'room')
  const roomName = buildRoomName(request, config, nonce)
  const participantName = sanitizeParticipantName(request.participantName)
  const participantIdentity = sanitizeLiveKitName(`batshit-user-${userId}-${nonce}`, `batshit-user-${nonce}`)
  const speechToSpeechBase = normalizeSpeechToSpeechConfig(request)
  const speechToSpeech: NormalizedSpeechToSpeechConfig | null = speechToSpeechBase
    ? {
        ...speechToSpeechBase,
        instructions: await resolveSpeechToSpeechInstructions(userId, request, {
          providerId: speechToSpeechBase.providerId
        })
      }
    : null

  if (speechToSpeech) {
    await assertLiveKitSpeechToSpeechProviderReady(userId, speechToSpeech.providerId)
  }

  const metadata = normalizeMetadata(request, userId, createdAt, speechToSpeech)
  const grant: VideoGrant = {
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  }

  const tokenFactory = options.tokenFactory ?? defaultLiveKitTokenFactory
  const token = await tokenFactory({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    identity: participantIdentity,
    name: participantName,
    ttlSec: config.tokenTtlSec,
    metadata: JSON.stringify(metadata),
    attributes: {
      'batshit.runtime': LIVEKIT_VOICE_RUNTIME_ID,
      'batshit.transport': LIVEKIT_VOICE_TRANSPORT
    },
    grant
  })
  const dispatchConfig = resolveAgentDispatch(request, config)
  let agentDispatch: LiveKitVoiceSessionResponse['agentDispatch'] | undefined

  if (dispatchConfig.requested) {
    if (!dispatchConfig.agentName) {
      const warning = 'LiveKit agent dispatch requested, but no LiveKit agent name is configured.'
      if (dispatchConfig.required) {
        throw new Error(`${warning} Set LIVEKIT_VOICE_AGENT_NAME or LIVEKIT_AGENT_NAME.`)
      }
      agentDispatch = {
        requested: true,
        required: false,
        warning
      }
    } else {
      const metadata = JSON.stringify(
        normalizeAgentDispatchMetadata(request, userId, roomName, createdAt, speechToSpeech)
      )
      // BL-467: the size that matters is what LiveKit actually receives — this JSON string,
      // not the raw compiled instructions (`speechToSpeech.instructions` is only one field
      // of it). LiveKit's own dispatch/job metadata limit is 512 KiB
      // (`docs.livekit.io/agents/server/agent-dispatch/`, verified 2026-09-28); crossing it
      // fails the session start with a clear error rather than dispatching something LiveKit
      // may reject or truncate.
      const metadataBytes = Buffer.byteLength(metadata, 'utf8')
      if (metadataBytes > LIVEKIT_DISPATCH_METADATA_MAX_BYTES) {
        console.error(
          "[voice/livekit] LiveKit agent dispatch metadata exceeds LiveKit's own dispatch metadata limit:",
          { liveKitLimitBytes: LIVEKIT_DISPATCH_METADATA_MAX_BYTES, metadataBytes }
        )
        throw new Error(
          "LiveKit speech-to-speech session could not start because the compiled instructions are too large for LiveKit's dispatch metadata limit. Shorten the agent's system prompt or the LiveKit session instructions."
        )
      }
      if (
        speechToSpeech?.instructions &&
        speechToSpeech.instructions.length > MAX_SPEECH_TO_SPEECH_INSTRUCTIONS_LENGTH
      ) {
        // Batshit's own 48,000-char budget was exceeded (even zero realtime voice history
        // did not fit it), but the real LiveKit dispatch metadata still fits — ship it, but
        // say so loudly rather than silently exceed the intended target.
        console.error(
          "[voice/livekit] Speech-to-speech instructions exceed Batshit's own dispatch budget, but the real LiveKit dispatch metadata still fits; sending as-is:",
          {
            batshitBudgetChars: MAX_SPEECH_TO_SPEECH_INSTRUCTIONS_LENGTH,
            instructionsLength: speechToSpeech.instructions.length,
            metadataBytes
          }
        )
      }
      // Immediately before the dispatch: in native Batshit only this Batshit's own agent sidecar may
      // take the session (BL-1311). A refusal dispatches nothing and says why, like a missing agent name.
      const refusal = await (options.admitAgentDispatch ?? defaultAdmitLiveKitAgentDispatch)()
      if (refusal) {
        if (dispatchConfig.required) throw new Error(refusal)
        agentDispatch = { requested: true, required: false, warning: refusal }
      } else {
        const dispatchFactory = options.dispatchFactory ?? defaultLiveKitAgentDispatchFactory
        const dispatch = await dispatchFactory({
          serverUrl: config.dispatchServerUrl,
          apiKey: config.apiKey,
          apiSecret: config.apiSecret,
          roomName,
          agentName: dispatchConfig.agentName,
          metadata
        })
        agentDispatch = {
          requested: true,
          required: dispatchConfig.required,
          agentName: dispatchConfig.agentName,
          dispatchId: dispatch.id,
          metadata
        }
      }
    }
  }

  return {
    runtime: LIVEKIT_VOICE_RUNTIME_ID,
    transport: LIVEKIT_VOICE_TRANSPORT,
    mode: 'room-token',
    serverUrl: config.serverUrl,
    roomName,
    participantIdentity,
    participantName,
    token,
    expiresInSec: config.tokenTtlSec,
    permissions: {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    },
    selfHosted: config.selfHosted,
    createdAt,
    agentDispatch
  }
}

export function getLiveKitVoiceSetupHint(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase()
  if (message.includes('url not configured')) {
    return 'Add your LiveKit URL in Settings -> API Keys -> Voice Runtime, or set LIVEKIT_URL on the server. For local dev, ws://localhost:7880 is typical.'
  }
  if (message.includes('api key') || message.includes('api secret')) {
    return 'Add your LiveKit API key and API secret in Settings -> API Keys -> Voice Runtime, or set LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the server. For explicit local dev, run livekit-server --dev and use devkey/secret yourself.'
  }
  if (message.includes('agent dispatch requested') || message.includes('agent name')) {
    return 'Set LIVEKIT_VOICE_AGENT_NAME to the dispatch name of the LiveKit agent sidecar, for example batshit-livekit-agent.'
  }
  if (message.includes('api key is required for livekit speech-to-speech')) {
    return 'Add the selected speech-to-speech provider key in Settings -> API Keys, then restart or reconnect the LiveKit voice session.'
  }
  return undefined
}
