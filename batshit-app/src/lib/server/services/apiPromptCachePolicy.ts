import { type ModelMessage } from 'ai'
import { serializeRegisteredTools } from './toolDefinitionFingerprint'
import { createHash } from 'crypto'
import type { ModelConnectionInfo } from '$lib/types/savedModels'
import { COMPILED_TAG } from '$lib/utils/compiledChatTags'

type ProviderOptions = Record<string, Record<string, any>>
type ProviderKind =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'vercel-gateway'
  | 'xai'
  | 'baseten'
  | 'fireworks'
  | 'unknown'

export type ApiPromptCachePolicyMetadata = {
  enabled: boolean
  provider: ProviderKind
  modelId: string | null
  transport: ModelConnectionInfo['type'] | null
  stablePrefixHash: string
  stablePrefixParts: {
    systemMessages: number
    tools: number
  }
  applied: string[]
  preserved: string[]
  omitted: Array<{
    option: string
    reason: string
  }>
  providerOptionKeys: Record<string, string[]>
  /** Names of session-affinity request headers added to this call (values are pseudonymous hashes and stay out of metadata/logs). */
  requestHeaderNames: string[]
  /**
   * History cache blocks (2026-10-21): how many parts the compiled chat history was split into
   * (direct Anthropic, OpenRouter with a Claude model, and OpenAI on GPT-5.6 and later, direct or
   * through OpenRouter, BL-1991); the last of them carries a cache point (on OpenAI the last two do);
   * 0 when it was sent as one part.
   */
  historyParts: number
  /**
   * BL-184: the lifetime of every Anthropic-style cache point this request carries, which
   * decides what a cache write costs (Anthropic bills 1.25x the input price for 5 minutes and
   * 2x for 1 hour). `null` when Batshit cannot vouch for one lifetime: no such point was
   * placed, or a point it did not place was kept. The Token Panel reads it from the Execution
   * Viewer snapshot's `runtime.metadata.promptCachePolicy`.
   */
  cacheTtl: CacheTtl | null
}

export type CacheTtl = '5m' | '1h'

export type ApiPromptCachePolicyInput = {
  modelId?: string | null
  providerId?: string | null
  connection?: ModelConnectionInfo | null
  sessionId?: string | null
  agentId?: string | null
  userId?: string | null
  messages: ModelMessage[]
  tools?: Record<string, any> | undefined
  providerOptions?: ProviderOptions | undefined
}

export type ApiPromptCachePolicyResult = {
  messages: ModelMessage[]
  tools?: Record<string, any> | undefined
  providerOptions?: ProviderOptions | undefined
  /** Per-call HTTP headers (session cache-affinity hints); pass to streamText/generateText, never to provider construction. */
  headers?: Record<string, string> | undefined
  /**
   * BL-77: provider options for every step of a tool loop, the first included (BL-1976), which
   * the per-step hook (`buildTurnPrepareStep`) returns from `prepareStep`. The SDK merges them
   * into that one step's call options (they are not carried to the next step), and the provider
   * sends them as the request-level cache point that Anthropic places on the last block, so the
   * first step writes the step-start message and each later step reads everything the previous
   * step sent from the cache. Present only on direct Anthropic; OpenRouter gets
   * `toolLoopTailMarker` instead (BL-185).
   */
  stepProviderOptions?: ProviderOptions | undefined
  /**
   * BL-185: the tool loop's tail point on OpenRouter with a Claude-family model, as an explicit
   * marker the per-step hook moves to the last message on every step, the first included
   * (BL-1976; `placeToolLoopTailMarker`). OpenRouter's Amazon Bedrock route accepts the
   * request-level field and ignores it (measured 2026-09-22 and 2026-09-25); an explicit block
   * marker works on every upstream OpenRouter documents.
   */
  toolLoopTailMarker?: ToolLoopTailMarker | undefined
  metadata: ApiPromptCachePolicyMetadata
}

export type ToolLoopTailMarker = {
  namespace: 'openrouter'
  cacheControl: CacheControlValue
}

function hashText(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, length)
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function deepMerge<T extends Record<string, any>>(
  base: T,
  override?: Record<string, any>,
): T {
  const next: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(override ?? {})) {
    const existing = next[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      next[key] = deepMerge(existing, value)
    } else {
      next[key] = value
    }
  }
  return next as T
}

function cloneProviderOptions(options?: ProviderOptions): ProviderOptions {
  const clone: ProviderOptions = {}
  for (const [provider, providerOptions] of Object.entries(options ?? {})) {
    clone[provider] = isPlainObject(providerOptions)
      ? deepMerge({}, providerOptions)
      : {}
  }
  return clone
}

/**
 * SA-107 (DL-107-03): exact service ids that map to a cache-policy provider
 * kind. When a connection names its service, that id is authoritative — a
 * model NAMED `gpt-oss` hosted on Fireworks is not OpenAI, so fuzzy
 * model-name inference only runs when no service is known.
 */
const EXACT_PROVIDER_KINDS: Record<string, ProviderKind> = {
  'vercel-gateway': 'vercel-gateway',
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  xai: 'xai',
  baseten: 'baseten',
  fireworks: 'fireworks',
}

function normalizeServiceId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase()
  if (!trimmed) return null
  return trimmed.startsWith('direct:') ? trimmed.slice('direct:'.length) : trimmed
}

function resolveExactProviderKind(args: {
  providerId?: string | null
  connection?: ModelConnectionInfo | null
}): ProviderKind | null {
  const connectionType = args.connection?.type ?? null
  const connectionId = normalizeServiceId(args.connection?.id)
  if (connectionType === 'vercel-gateway' || connectionId === 'vercel-gateway') {
    return 'vercel-gateway'
  }
  if (connectionType === 'openrouter' || connectionId === 'openrouter') {
    return 'openrouter'
  }

  // A direct connection's service id is authoritative: exact kind when we
  // have one, otherwise 'unknown' so fuzzy model-name inference cannot
  // misclassify a hosted model (e.g. gpt-oss on Fireworks as OpenAI).
  const service =
    normalizeServiceId(args.connection?.service) ??
    (connectionType === 'direct' ? connectionId : null)
  if (service) {
    return EXACT_PROVIDER_KINDS[service] ?? 'unknown'
  }

  const providerId = normalizeServiceId(args.providerId)
  if (providerId && EXACT_PROVIDER_KINDS[providerId]) {
    return EXACT_PROVIDER_KINDS[providerId]
  }

  return null
}

function inferProvider(args: {
  modelId?: string | null
  providerId?: string | null
  connection?: ModelConnectionInfo | null
}): ProviderKind {
  const exact = resolveExactProviderKind(args)
  if (exact) return exact

  const values = [
    args.connection?.type,
    args.connection?.service,
    args.connection?.id,
    args.providerId,
    args.modelId,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase())

  if (values.some((value) => value.includes('vercel-gateway'))) {
    return 'vercel-gateway'
  }
  if (values.some((value) => value.includes('openrouter'))) {
    return 'openrouter'
  }
  if (
    values.some(
      (value) => value.includes('anthropic') || value.includes('claude'),
    )
  ) {
    return 'anthropic'
  }
  if (
    values.some((value) => value.includes('google') || value.includes('gemini'))
  ) {
    return 'google'
  }
  if (
    values.some(
      (value) =>
        value.includes('openai') ||
        value.includes('gpt-') ||
        value.includes('gpt_') ||
        value.startsWith('o1') ||
        value.startsWith('o3') ||
        value.startsWith('o4') ||
        value.startsWith('o5'),
    )
  ) {
    return 'openai'
  }

  return 'unknown'
}

function modelLooksAnthropic(modelId?: string | null): boolean {
  const lower = (modelId ?? '').toLowerCase()
  return lower.includes('anthropic') || lower.includes('claude')
}

function supportsOpenAiPromptCacheRetention(
  modelId: string | null | undefined,
  retention: unknown,
): boolean {
  const lower = (modelId ?? '').toLowerCase()
  const isGpt55OrLater =
    lower.includes('gpt-5.5') ||
    lower.includes('gpt-5-5') ||
    lower.includes('gpt-5.5-pro') ||
    lower.includes('gpt-5-5-pro')

  if (retention === 'in_memory') {
    return !isGpt55OrLater
  }

  if (retention !== '24h') return false

  return [
    'gpt-5.5',
    'gpt-5-5',
    'gpt-5.4',
    'gpt-5-4',
    'gpt-5.2',
    'gpt-5-2',
    'gpt-5.1',
    'gpt-5-1',
    'gpt-5',
    'gpt-4.1',
    'gpt-4-1',
  ].some((supported) => lower.includes(supported))
}

function buildStablePrefixSignature(
  messages: ModelMessage[],
  tools?: Record<string, any>,
) {
  const systemMessages = messages
    .filter((message) => message?.role === 'system')
    .map((message) => ({
      role: message.role,
      content: message.content,
      providerOptions: (message as any).providerOptions ?? null,
    }))

  const serializedTools = serializeRegisteredTools(tools)

  const hash = hashText(
    JSON.stringify({
      systemMessages,
      tools: serializedTools,
    }),
    24,
  )

  return {
    hash,
    parts: {
      systemMessages: systemMessages.length,
      tools: serializedTools.length,
    },
  }
}

function buildOpenAiPromptCacheKey(args: {
  userId?: string | null
  agentId?: string | null
  modelId?: string | null
  connection?: ModelConnectionInfo | null
  stablePrefixHash: string
}): string {
  const identityHash = hashText(
    [
      args.userId ?? 'single-user',
      args.agentId ?? 'no-agent',
      args.connection?.id ?? args.connection?.service ?? args.connection?.type,
    ].join('|'),
    12,
  )
  const modelHash = hashText(args.modelId ?? 'unknown-model', 12)
  return `bs-pc-v1-${identityHash}-${modelHash}-${args.stablePrefixHash.slice(0, 16)}`
}

function buildOpenRouterSessionId(args: {
  userId?: string | null
  agentId?: string | null
  sessionId?: string | null
  modelId?: string | null
}): string {
  return `bs-or-v1-${hashText(
    [
      args.userId ?? 'single-user',
      args.agentId ?? 'no-agent',
      args.sessionId ?? 'no-session',
      args.modelId ?? 'unknown-model',
    ].join('|'),
    32,
  )}`
}

/**
 * SA-107 (DL-107-02): pseudonymous per-session cache-affinity value. Same
 * recipe class as the OpenRouter session id — raw user/agent/session ids
 * never go on the wire, and the value is stable for a session so the
 * provider can pin a replica across turns.
 */
function buildSessionAffinityValue(args: {
  userId?: string | null
  agentId?: string | null
  sessionId?: string | null
  modelId?: string | null
}): string {
  return `bs-aff-v1-${hashText(
    [
      args.userId ?? 'single-user',
      args.agentId ?? 'no-agent',
      args.sessionId ?? 'no-session',
      args.modelId ?? 'unknown-model',
    ].join('|'),
    32,
  )}`
}

/**
 * SA-107 (DL-107-04): documented session-affinity request headers, direct
 * lanes only. xAI documents `x-grok-conv-id`; Baseten and Fireworks document
 * `x-session-affinity` (official docs fetched 2026-08-31).
 */
const SESSION_AFFINITY_HEADER_BY_PROVIDER: Partial<Record<ProviderKind, string>> = {
  xai: 'x-grok-conv-id',
  baseten: 'x-session-affinity',
  fireworks: 'x-session-affinity',
}

function providerOptionKeys(options: ProviderOptions): Record<string, string[]> {
  const output: Record<string, string[]> = {}
  for (const [provider, providerOptions] of Object.entries(options)) {
    output[provider] = Object.keys(providerOptions ?? {}).sort()
  }
  return output
}

function isEmptyProviderOptions(options: ProviderOptions): boolean {
  return Object.values(options).every(
    (providerOptions) => Object.keys(providerOptions ?? {}).length === 0,
  )
}

function getProviderOptionObject(
  options: ProviderOptions,
  provider: string,
): Record<string, any> {
  const current = options[provider]
  if (isPlainObject(current)) return current
  options[provider] = {}
  return options[provider]
}

function hasCacheControl(options?: Record<string, any>): boolean {
  return (
    options?.cacheControl !== undefined || options?.cache_control !== undefined
  )
}

type CacheControlValue = { type: 'ephemeral'; ttl?: '5m' | '1h' }

/**
 * BL-77: the ONE lifetime every cache point Batshit places on a request uses. A preset's
 * request-level setting (the Anthropic "Prompt cache TTL") wins; otherwise Anthropic's
 * default (5 minutes). One lifetime for every point keeps Anthropic's ordering rule — a
 * longer-lived point must come before a shorter-lived one — true by construction.
 */
function resolveCacheControlValue(options?: Record<string, any>): CacheControlValue {
  const value = options?.cacheControl ?? options?.cache_control
  const ttl =
    isPlainObject(value) && (value.ttl === '5m' || value.ttl === '1h')
      ? (value.ttl as '5m' | '1h')
      : undefined
  return ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }
}

/** Anthropic accepts at most four cache points per request, and the request-level
 *  (automatic) point takes one of the four. */
const ANTHROPIC_MAX_CACHE_POINTS = 4

/**
 * Counts every place a request already carries a cache point: message level, part level,
 * and tool level, in either namespace a provider reads (`@ai-sdk/anthropic` reads
 * `anthropic`; the OpenRouter provider reads `openrouter`, then `anthropic`). A location
 * that sets both counts once. Deliberately an upper bound: the provider applies a
 * message-level point to the last part only when that part has none of its own.
 */
function countCachePoints(
  messages: ModelMessage[],
  tools?: Record<string, any>,
): number {
  const carries = (options: unknown) =>
    isPlainObject(options) &&
    (hasCacheControl(options.anthropic) || hasCacheControl(options.openrouter))

  let count = 0
  for (const message of messages) {
    if (carries((message as any)?.providerOptions)) count += 1
    const content = (message as any)?.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if (carries(part?.providerOptions)) count += 1
      }
    }
  }
  for (const toolDefinition of Object.values(tools ?? {})) {
    if (carries((toolDefinition as any)?.providerOptions)) count += 1
  }
  return count
}


function annotateLastSystemMessageCacheControl(args: {
  messages: ModelMessage[]
  provider: 'anthropic' | 'openrouter'
  cacheControl: Record<string, any>
}): { messages: ModelMessage[]; applied: boolean; preserved: boolean } {
  const systemIndex = args.messages.findLastIndex(
    (message) => message?.role === 'system',
  )
  if (systemIndex === -1) {
    return { messages: args.messages, applied: false, preserved: false }
  }

  const message = args.messages[systemIndex] as ModelMessage & {
    providerOptions?: ProviderOptions
  }
  const messageOptions = cloneProviderOptions(message.providerOptions)
  const providerOptions = getProviderOptionObject(
    messageOptions,
    args.provider,
  )

  if (hasCacheControl(providerOptions)) {
    return { messages: args.messages, applied: false, preserved: true }
  }

  providerOptions.cacheControl = { ...args.cacheControl }

  const messages = [...args.messages]
  messages[systemIndex] = {
    ...message,
    providerOptions: messageOptions,
  } as ModelMessage

  return { messages, applied: true, preserved: false }
}

// SA-128: the standing manifest is the `<awareness_media>` element (the image parts follow it).
const STANDING_MEDIA_HEADER = `<${COMPILED_TAG.awarenessMedia}>\n`

function annotateLastStandingPartCacheControl(args: {
  messages: ModelMessage[]
  provider: 'anthropic'
  cacheControl: Record<string, any>
}): { messages: ModelMessage[]; applied: boolean; preserved: boolean } {
  for (let messageIndex = 0; messageIndex < args.messages.length; messageIndex += 1) {
    const message = args.messages[messageIndex] as ModelMessage & { content?: unknown[] }
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    const headerIndex = message.content.findIndex(
      (part: any) => part?.type === 'text' && part?.text?.startsWith(STANDING_MEDIA_HEADER)
    )
    if (headerIndex === -1) continue
    let lastStandingIndex = headerIndex
    for (let index = headerIndex + 1; index < message.content.length; index += 1) {
      const part = message.content[index] as any
      if (part?.type === 'text') break
      lastStandingIndex = index
    }
    const part = message.content[lastStandingIndex] as any
    const options = cloneProviderOptions(part?.providerOptions)
    const providerOptions = getProviderOptionObject(options, args.provider)
    if (hasCacheControl(providerOptions)) {
      return { messages: args.messages, applied: false, preserved: true }
    }
    providerOptions.cacheControl = { ...args.cacheControl }
    const content = [...message.content]
    content[lastStandingIndex] = { ...part, providerOptions: options }
    const messages = [...args.messages]
    messages[messageIndex] = { ...message, content } as ModelMessage
    return { messages, applied: true, preserved: false }
  }
  return { messages: args.messages, applied: false, preserved: false }
}

// History cache blocks (2026-10-21, Josh: "why is chat history not being cached?"). Anthropic's
// prompt cache matches at content-block boundaries, and the compiler sends the whole chat as ONE
// text part that changes every turn, so a turn's first call read only the system prompt back.
const CONVERSATION_OPEN = `<${COMPILED_TAG.conversation}>\n`
const CONVERSATION_CLOSE = `\n</${COMPILED_TAG.conversation}>`
const HISTORY_TURN_BOUNDARY = new RegExp(`\\n\\n(?=<${COMPILED_TAG.user}[\\s>])`, 'g')

/**
 * Splits the compiled text part that opens `<conversation>` at user-turn boundaries, bytes
 * unchanged: one history part per user turn (its `<user>` element and every element after it up
 * to the next one: the reply, another agent's reply in a group, a `<note>`), the first carrying the
 * opening `<conversation>` line and anything before the first `<user>`; then one TAIL part from
 * the closing `</conversation>` line on (the `<zip_index>`, the `<current_message>`, `<dynamic_info>`,
 * clipped-item elements). Each part after the first starts with the blank line before its
 * `<user>`, and the last history part ends where the closing line begins, so a history part
 * written on one turn is byte-identical on the next (BL-1541 keeps history frozen). The compiler
 * disarms every one of its tag names inside content (`disarmCompiledTags`), so the only real
 * `<user` and `</conversation>` at a line start are its own. Null when the text is not that shape.
 */
export function splitCompiledHistoryText(text: string): { history: string[]; tail: string } | null {
  if (!text.startsWith(CONVERSATION_OPEN)) return null
  const close = text.indexOf(CONVERSATION_CLOSE)
  if (close < 0) return null
  const history: string[] = []
  let start = 0
  for (const match of text.slice(0, close).matchAll(HISTORY_TURN_BOUNDARY)) {
    history.push(text.slice(start, match.index))
    start = match.index
  }
  history.push(text.slice(start, close))
  return { history, tail: text.slice(close) }
}

/**
 * Sends the compiled chat (the last user message whose text part opens `<conversation>`) as one
 * text part per history turn plus the tail part, and puts the lane's cache marker (`marker`, the
 * part's provider options) on the LAST history part. The next turn's call then reads every earlier
 * turn back (Anthropic looks back up to 20 blocks from a cache point for an earlier entry; here the
 * entry is one block back) and writes only the new turn's part. `markPrevious` also marks the history
 * part before the last, for a provider that does not look back from a marker (OpenAI, BL-1991): that
 * part ends where the previous turn's marker did, so the call reads that entry. What the model reads
 * is the same bytes in the same order. A message or part that already carries a cache marker, or any
 * provider options, is left as it is. `markers` is how many parts carry the marker.
 */
function splitHistoryIntoCacheBlocks(args: {
  messages: ModelMessage[]
  marker: ProviderOptions
  markPrevious?: boolean
}): { messages: ModelMessage[]; historyParts: number; markers: number; preserved: boolean } {
  for (let messageIndex = args.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = args.messages[messageIndex] as any
    if (message?.role !== 'user') continue
    const content: any[] =
      typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (!Array.isArray(content)) continue
    const partIndex = content.findIndex(
      (part) => part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith(CONVERSATION_OPEN)
    )
    if (partIndex === -1) continue
    if (message.providerOptions !== undefined || content[partIndex].providerOptions !== undefined) {
      return { messages: args.messages, historyParts: 0, markers: 0, preserved: true }
    }
    const split = splitCompiledHistoryText(content[partIndex].text)
    if (!split) return { messages: args.messages, historyParts: 0, markers: 0, preserved: false }
    const last = split.history.length - 1
    const marked = (index: number) => index === last || (args.markPrevious === true && index === last - 1)
    const parts = [
      ...split.history.map((text, index) =>
        marked(index) ? { type: 'text', text, providerOptions: structuredClone(args.marker) } : { type: 'text', text }
      ),
      { type: 'text', text: split.tail },
    ]
    const nextContent = [...content.slice(0, partIndex), ...parts, ...content.slice(partIndex + 1)]
    const messages = [...args.messages]
    messages[messageIndex] = { ...message, content: nextContent } as ModelMessage
    return { messages, historyParts: split.history.length, markers: split.history.filter((_text, index) => marked(index)).length, preserved: false }
  }
  return { messages: args.messages, historyParts: 0, markers: 0, preserved: false }
}

/**
 * Places the cache points of a lane that takes Anthropic cache control (direct Anthropic,
 * and OpenRouter for a Claude-family model):
 *
 * 1. The system point, on the last system message — ALWAYS. A request-level setting (a
 *    preset's Prompt cache TTL) is added beside it, never instead of it (BL-77): alone, the
 *    request-level point made Anthropic write a fresh entry at the end of every request and
 *    never read the system prompt back on the next turn, which is the SA-086 live finding
 *    that put Batshit's own point on the system message in the first place.
 * 2. The standing Awareness media point (direct Anthropic only), on the same lifetime.
 * 2b. The history point (direct Anthropic, and OpenRouter for a Claude-family model, when the
 *    connection names the lane): the compiled chat is sent as one part per history turn plus a
 *    tail part, with a point on the last history part (`splitHistoryIntoCacheBlocks`), on the
 *    same lifetime, and only when it leaves room for the tail point under the four-point cap.
 * 3. The tool loop's tail point (BL-77) for the per-step hook to add on every step, the first
 *    included (BL-1976, Josh 2026-10-21: the step-start message is written on the first call and
 *    read on the second, instead of billed fresh on the first and written on the second; a reply
 *    with one call pays one write nobody reads). On direct Anthropic it is the request-level
 *    point (`stepProviderOptions`), which the
 *    provider sends as Anthropic's automatic cache point on the last block. On OpenRouter it is
 *    an explicit marker the hook moves to the last message (`toolLoopTailMarker`, BL-185),
 *    because OpenRouter's Bedrock route ignores the request-level field. A lane whose
 *    request-level point is already set gets nothing extra: that point rides every step.
 *    Never added when it would be a fifth point, and only when the request's CONNECTION
 *    names the lane: a connection-less request is classified from its model name or a
 *    default provider id, and whatever serves it (the gateway, by default) may not take a
 *    request-level point.
 */
function placeAnthropicFamilyCachePoints(args: {
  namespace: 'anthropic' | 'openrouter'
  requestOptions: Record<string, any> | undefined
  messages: ModelMessage[]
  tools?: Record<string, any>
  standingMedia: boolean
  /** False when only a model name or a default provider id says which lane this is. */
  toolLoop: boolean
  /** Split the compiled history into cache blocks (the connection names the lane). */
  historyBlocks: boolean
  labels: { system: string; toolLoop: string }
  applied: string[]
  preserved: string[]
  omitted: ApiPromptCachePolicyMetadata['omitted']
}): {
  messages: ModelMessage[]
  stepProviderOptions?: ProviderOptions
  toolLoopTailMarker?: ToolLoopTailMarker
  cacheTtl: CacheTtl | null
  historyParts: number
} {
  const { namespace, labels, applied, preserved, omitted } = args
  const requestLevel = hasCacheControl(args.requestOptions)
  const cacheControl = resolveCacheControlValue(args.requestOptions)
  // BL-184: every point Batshit places uses this one lifetime. A point it kept rather than
  // placed may carry another, so the lifetime is then unknown.
  let cacheTtl: CacheTtl | null = cacheControl.ttl ?? '5m'

  const annotation = annotateLastSystemMessageCacheControl({
    messages: args.messages,
    provider: namespace,
    cacheControl,
  })
  let messages = annotation.messages
  if (annotation.applied) {
    applied.push(labels.system)
  } else if (annotation.preserved) {
    preserved.push(labels.system)
    cacheTtl = null
  } else {
    omitted.push({
      option: labels.system,
      reason:
        namespace === 'anthropic'
          ? 'No stable system message was available to mark as the Anthropic cache breakpoint.'
          : 'No stable system message was available to mark as the OpenRouter Anthropic cache breakpoint.',
    })
  }

  if (args.standingMedia) {
    const standingAnnotation = annotateLastStandingPartCacheControl({
      messages,
      provider: 'anthropic',
      cacheControl,
    })
    messages = standingAnnotation.messages
    if (standingAnnotation.applied) {
      applied.push('anthropic.standingMedia.cacheControl')
    } else if (standingAnnotation.preserved) {
      preserved.push('anthropic.standingMedia.cacheControl')
      cacheTtl = null
    }
  }

  // The history point leaves a slot for the tail point (the preset's request-level one, or the
  // tool loop's), which the next turn's within-turn reads depend on.
  let historyParts = 0
  if (args.historyBlocks) {
    const explicitPoints = countCachePoints(messages, args.tools)
    const tailSlot = requestLevel || args.toolLoop ? 1 : 0
    if (explicitPoints + 1 + tailSlot > ANTHROPIC_MAX_CACHE_POINTS) {
      omitted.push({
        option: `${namespace}.history.cacheControl`,
        reason: `The request already carries ${explicitPoints} cache points; Anthropic allows ${ANTHROPIC_MAX_CACHE_POINTS}, and the history point leaves a slot for the tail point.`,
      })
    } else {
      const split = splitHistoryIntoCacheBlocks({ messages, marker: { [namespace]: { cacheControl: { ...cacheControl } } } })
      if (split.historyParts > 0) {
        messages = split.messages
        historyParts = split.historyParts
        applied.push(`${namespace}.history.cacheControl`)
      } else if (split.preserved) {
        preserved.push(`${namespace}.history.cacheControl`)
      }
    }
  }

  if (requestLevel) {
    preserved.push(`${namespace}.cacheControl.automatic`)
    return { messages, cacheTtl, historyParts }
  }
  if (!args.toolLoop) return { messages, cacheTtl, historyParts }

  const explicitPoints = countCachePoints(messages, args.tools)
  if (explicitPoints + 1 > ANTHROPIC_MAX_CACHE_POINTS) {
    omitted.push({
      option: labels.toolLoop,
      reason: `The request already carries ${explicitPoints} cache points; Anthropic allows ${ANTHROPIC_MAX_CACHE_POINTS} including the tool loop's request-level point.`,
    })
    return { messages, cacheTtl, historyParts }
  }

  applied.push(labels.toolLoop)
  if (namespace === 'openrouter') {
    return { messages, toolLoopTailMarker: { namespace, cacheControl: { ...cacheControl } }, cacheTtl, historyParts }
  }
  return {
    messages,
    stepProviderOptions: { [namespace]: { cacheControl: { ...cacheControl } } },
    cacheTtl,
    historyParts,
  }
}

// BL-1991 (Josh, 2026-10-21: "We need each turn to be separated"). OpenAI's implicit caching puts ONE
// breakpoint at the end of the latest eligible message (a user message, the last tool response of a
// group, the last initial developer message; OpenAI prompt-caching guide, read 2026-10-21), and the
// compiled chat is ONE user message, so a turn's first call read back only the developer message
// (system and tools) and wrote the whole chat again (SA-126 Sol and Luna: 6,073 tokens read on every
// turn start). GPT-5.6 and later take an explicit breakpoint on a content block. OpenAI looks an entry up
// only at the request's own breakpoints (the first 2 and latest 50 explicit ones, and the implicit one),
// at up to 20 earlier eligible MESSAGE endings and at the end of the initial developer block; a content
// block boundary without a breakpoint is never one (guide, "lookup boundaries"; live, GPT-6 Luna,
// 2026-10-21: the split alone, and a breakpoint on the last history part alone, both read only the
// developer message on turn 3; breakpoints on the last two history parts read turn 1's part back). So
// the request marks the last history part (written for the next turn) and the one before it (where the
// previous turn's newest mark was). Were history ever sent as separate messages, one mark would do.
const OPENAI_HISTORY_BREAKPOINT = { mode: 'explicit' } as const
/** OpenAI creates at most four cache writes per request; the implicit breakpoint takes one of them
 *  while implicit mode is on (the default), leaving three for explicit breakpoints. */
const OPENAI_MAX_CACHE_WRITES = 4

/**
 * True for the OpenAI models that accept an explicit `prompt_cache_breakpoint`: GPT-5.6 and later.
 * GPT-5.5 and earlier cache implicitly only. A dated id (`gpt-5-2026-08-07`) is not read as a minor
 * version.
 */
function supportsOpenAiExplicitCacheBreakpoints(modelId?: string | null): boolean {
  const match = /(?:^|[^a-z])gpt-(\d+)(?:[.-](\d{1,2})(?!\d))?/.exec((modelId ?? '').toLowerCase())
  if (!match) return false
  const major = Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  return major > 5 || (major === 5 && minor >= 6)
}

/** Every explicit OpenAI breakpoint a request already carries (message level and part level). */
function countOpenAiBreakpoints(messages: ModelMessage[]): number {
  const carries = (options: unknown) =>
    isPlainObject(options) && isPlainObject(options.openai) && options.openai.promptCacheBreakpoint != null
  let count = 0
  for (const message of messages) {
    if (carries((message as any)?.providerOptions)) count += 1
    const content = (message as any)?.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if (carries(part?.providerOptions)) count += 1
      }
    }
  }
  return count
}

/**
 * The history points for an OpenAI model that takes explicit breakpoints (BL-1991): the compiled chat
 * is sent as one text part per history turn plus a tail part (`splitHistoryIntoCacheBlocks`), with a
 * breakpoint (`marker`) on the last history part and on the one before it. On direct OpenAI the marker
 * is `openai.promptCacheBreakpoint` (sent as `prompt_cache_breakpoint` on Responses `input_text`); through
 * OpenRouter it is `openrouter.cacheControl`, which OpenRouter converts to OpenAI's breakpoint. Implicit
 * mode stays on, so a tool loop's later calls keep the breakpoint OpenAI puts on their last tool
 * response. Placed only within the four-write cap (three explicit breakpoints while implicit mode is
 * on; `existing` counts the ones already there), and only when the caller checked the CONNECTION names
 * the lane and the model takes explicit breakpoints.
 */
function placeOpenAiHistoryBreakpoints(args: {
  messages: ModelMessage[]
  marker: ProviderOptions
  label: string
  implicit: boolean
  existing: number
  applied: string[]
  preserved: string[]
  omitted: ApiPromptCachePolicyMetadata['omitted']
}): { messages: ModelMessage[]; historyParts: number } {
  const { label, implicit, existing } = args
  const split = splitHistoryIntoCacheBlocks({ messages: args.messages, marker: args.marker, markPrevious: true })
  if (split.historyParts === 0) {
    if (split.preserved) args.preserved.push(label)
    return { messages: args.messages, historyParts: 0 }
  }
  const explicitCap = OPENAI_MAX_CACHE_WRITES - (implicit ? 1 : 0)
  if (existing + split.markers > explicitCap) {
    args.omitted.push({
      option: label,
      reason: `The request already carries ${existing} explicit cache breakpoints and the history needs ${split.markers}; OpenAI creates at most ${OPENAI_MAX_CACHE_WRITES} cache writes per request${implicit ? ', one of them the implicit breakpoint' : ''}.`,
    })
    return { messages: args.messages, historyParts: 0 }
  }
  args.applied.push(label)
  return { messages: split.messages, historyParts: split.historyParts }
}

function withoutTailMarker<T extends Record<string, any>>(holder: T, namespace: string): T {
  const options = holder?.providerOptions
  if (!isPlainObject(options) || !isPlainObject(options[namespace]) || !hasCacheControl(options[namespace])) {
    return holder
  }
  const { cacheControl: _cacheControl, cache_control: _cacheControlSnake, ...rest } = options[namespace]
  return { ...holder, providerOptions: { ...options, [namespace]: rest } }
}

function withTailMarker<T extends Record<string, any>>(holder: T, marker: ToolLoopTailMarker): T {
  const options = isPlainObject(holder?.providerOptions) ? holder.providerOptions : {}
  const current = isPlainObject(options[marker.namespace]) ? options[marker.namespace] : {}
  return {
    ...holder,
    providerOptions: {
      ...options,
      [marker.namespace]: { ...current, cacheControl: { ...marker.cacheControl } },
    },
  }
}

/**
 * BL-185: moves Batshit's one tail marker to the last message of a tool-loop step.
 *
 * `firstLoopIndex` is the number of messages Batshit compiled (the policy's output): those are
 * never marked on a step that has a loop message to mark, so the system point stays. Every
 * message from there on belongs to this run's loop (the model's responses, tool results, an
 * injected steer or image message), and none of them carries a cache marker of its own, so any
 * marker there is the one this function placed on an earlier step. The SDK hands a step's
 * returned messages to the next step, so that marker is stripped before the new one is placed:
 * a request carries the system point and ONE tail point.
 *
 * BL-1976: `stepStart` is the last message Batshit compiled, as the run's first step received
 * it (the one user message). On an approval resume the SDK has already run the approved tool
 * and appended its result, which is a loop message and takes the marker, so the replayed
 * messages are never marked. When no loop message can take the marker (a turn's first step), a
 * copy of it takes the
 * marker, so the first call writes the step-start message and the second reads it; on every later
 * step the original is put back before the loop tail is marked. It is never marked when it is a
 * system message or already carries a cache marker where this marker would go (the message
 * itself, or its last part): then that spot is already a cache point. A marker on an EARLIER
 * part (the history point of history cache blocks) stays: the step-one copy adds the tail marker
 * on the last part beside it, and the original that is put back still carries it. Marking a one-text user message sends it as a
 * one-block array instead of a plain string on that first call only (see the steer rule below);
 * Anthropic reads a plain string as exactly that one text block. A non-markable step-start (or a
 * last part the provider drops, such as a `tool-approval-response`) leaves that first call with
 * the system point only, while `applied` still says `fromStep1`; Batshit's compile marks no
 * user message, so this does not happen today.
 *
 * The marker goes on the last content PART: the OpenRouter provider copies a message-level
 * marker on a `tool` message onto every tool result in it, so parallel results would each carry
 * one and could pass Anthropic's four. An assistant message is marked at message level (the
 * provider reads only that).
 *
 * A trailing user message with ONE text part (a steer) is skipped and the loop message before it
 * is marked: the provider sends such a message as a plain string, but as a one-block array once
 * it carries a marker, so marking it would change more than the marker. The steer is short and
 * lands in the next step's write, well inside Anthropic's 20-block lookback.
 *
 * Nothing is mutated: the SDK keeps the step's own response objects as the run's response
 * messages, which send-routed saves and replays, so they must never see a marker. Changed
 * messages are copies.
 */
export function placeToolLoopTailMarker(
  messages: ModelMessage[],
  firstLoopIndex: number,
  marker: ToolLoopTailMarker,
  stepStart?: ModelMessage | null,
): ModelMessage[] {
  const stepStartIndex = firstLoopIndex - 1
  const stepStartMarkable =
    stepStart != null && stepStartIndex >= 0 && stepStart.role !== 'system' && !carriesMarkerWhereMarked(stepStart)
  let targetIndex = messages.length - 1
  while (targetIndex >= firstLoopIndex && isOneTextUserMessage(messages[targetIndex])) targetIndex -= 1
  if (targetIndex < firstLoopIndex) {
    if (!stepStartMarkable || stepStartIndex >= messages.length) return messages
    targetIndex = stepStartIndex
  }

  const out = messages.map((message, index) => {
    // BL-1976: the step-start message is always the compiled original here. A step with no loop
    // message marks a copy of it below; the next step puts the original back.
    if (index < firstLoopIndex) return index === stepStartIndex && stepStartMarkable ? stepStart : message
    let next = withoutTailMarker(message as Record<string, any>, marker.namespace)
    const content = (next as any).content
    if (Array.isArray(content)) {
      const parts = content.map((part: any) => withoutTailMarker(part, marker.namespace))
      if (parts.some((part: any, partIndex: number) => part !== content[partIndex])) {
        next = { ...next, content: parts }
      }
    }
    return next as ModelMessage
  })

  const target = out[targetIndex] as Record<string, any>
  const content = target.content
  if (target.role !== 'assistant' && Array.isArray(content) && content.length > 0) {
    const parts = [...content]
    parts[parts.length - 1] = withTailMarker(parts[parts.length - 1], marker)
    out[targetIndex] = { ...target, content: parts } as ModelMessage
  } else {
    out[targetIndex] = withTailMarker(target, marker) as ModelMessage
  }
  return out
}

/**
 * True when a message already carries an Anthropic or OpenRouter cache marker where the tail
 * marker would go: on the message, or on its last part (a non-assistant message with parts).
 */
function carriesMarkerWhereMarked(message: ModelMessage): boolean {
  const carries = (options: unknown) =>
    isPlainObject(options) && (hasCacheControl(options.anthropic) || hasCacheControl(options.openrouter))
  if (carries((message as any).providerOptions)) return true
  const content = (message as any).content
  return message.role !== 'assistant' && Array.isArray(content) && content.length > 0 && carries(content.at(-1)?.providerOptions)
}

function isOneTextUserMessage(message: ModelMessage | undefined): boolean {
  if (message?.role !== 'user') return false
  const content = (message as any).content
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
}

export function applyApiPromptCachePolicy(
  input: ApiPromptCachePolicyInput,
): ApiPromptCachePolicyResult {
  const provider = inferProvider(input)
  const existingOptions = cloneProviderOptions(input.providerOptions)
  const defaults: ProviderOptions = {}
  let messages = input.messages
  let stepProviderOptions: ProviderOptions | undefined
  let toolLoopTailMarker: ToolLoopTailMarker | undefined
  let cacheTtl: CacheTtl | null = null
  let historyParts = 0
  const stablePrefix = buildStablePrefixSignature(input.messages, input.tools)
  const applied: string[] = []
  const preserved: string[] = []
  const omitted: ApiPromptCachePolicyMetadata['omitted'] = []
  const modelId = input.modelId ?? null

  if (provider === 'openai') {
    defaults.openai = { ...(defaults.openai ?? {}) }
    if (existingOptions.openai?.promptCacheKey === undefined) {
      defaults.openai.promptCacheKey = buildOpenAiPromptCacheKey({
        userId: input.userId,
        agentId: input.agentId,
        modelId,
        connection: input.connection,
        stablePrefixHash: stablePrefix.hash,
      })
      applied.push('openai.promptCacheKey')
    } else {
      preserved.push('openai.promptCacheKey')
    }
  }

  // BL-77: the tool loop's point needs the CONNECTION to name the lane (see the helper).
  const connectionKind = resolveExactProviderKind({ connection: input.connection })

  // BL-1991: history cache blocks on direct OpenAI, for the models that take an explicit breakpoint.
  if (provider === 'openai' && connectionKind === 'openai' && supportsOpenAiExplicitCacheBreakpoints(modelId)) {
    const placed = placeOpenAiHistoryBreakpoints({
      messages,
      marker: { openai: { promptCacheBreakpoint: { ...OPENAI_HISTORY_BREAKPOINT } } },
      label: 'openai.history.promptCacheBreakpoint',
      implicit: existingOptions.openai?.promptCacheOptions?.mode !== 'explicit',
      existing: countOpenAiBreakpoints(messages),
      applied,
      preserved,
      omitted,
    })
    messages = placed.messages
    historyParts = placed.historyParts
  }

  if (provider === 'anthropic') {
    const placed = placeAnthropicFamilyCachePoints({
      namespace: 'anthropic',
      requestOptions: existingOptions.anthropic,
      messages,
      tools: input.tools,
      standingMedia: true,
      toolLoop: connectionKind === 'anthropic',
      historyBlocks: connectionKind === 'anthropic',
      labels: {
        system: 'anthropic.cacheControl',
        toolLoop: 'anthropic.toolLoop.cacheControl.fromStep1',
      },
      applied,
      preserved,
      omitted,
    })
    messages = placed.messages
    stepProviderOptions = placed.stepProviderOptions
    cacheTtl = placed.cacheTtl
    historyParts = placed.historyParts
  }

  if (provider === 'openrouter') {
    defaults.openrouter = { ...(defaults.openrouter ?? {}) }
    if (existingOptions.openrouter?.session_id === undefined) {
      defaults.openrouter.session_id = buildOpenRouterSessionId({
        userId: input.userId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        modelId,
      })
      applied.push('openrouter.session_id')
    } else {
      preserved.push('openrouter.session_id')
    }

    if (existingOptions.openrouter?.usage === undefined) {
      defaults.openrouter.usage = { include: true }
      applied.push('openrouter.usage.include')
    } else {
      preserved.push('openrouter.usage')
    }

    if (modelLooksAnthropic(modelId)) {
      const placed = placeAnthropicFamilyCachePoints({
        namespace: 'openrouter',
        requestOptions: existingOptions.openrouter,
        messages,
        tools: input.tools,
        standingMedia: false,
        toolLoop: connectionKind === 'openrouter',
        historyBlocks: connectionKind === 'openrouter',
        labels: {
          system: 'openrouter.cache_control',
          toolLoop: 'openrouter.toolLoop.cache_control.lastMessage.fromStep1',
        },
        applied,
        preserved,
        omitted,
      })
      messages = placed.messages
      toolLoopTailMarker = placed.toolLoopTailMarker
      cacheTtl = placed.cacheTtl
      historyParts = placed.historyParts
    } else if (
      connectionKind === 'openrouter' &&
      (modelId ?? '').toLowerCase().startsWith('openai/') &&
      supportsOpenAiExplicitCacheBreakpoints(modelId)
    ) {
      // BL-1991 Part B: an OpenAI GPT-5.6+ model through OpenRouter, which turns a part's
      // `cache_control` into OpenAI's `prompt_cache_breakpoint` (OpenRouter prompt-caching guide; live,
      // GPT-6 Luna, 2026-10-21: turn 3's first call read 6,109 before, 6,415 with the two parts marked).
      // A request-level `cache_control` (a Custom Parameter) passes through; it is recorded and counted
      // as one point, since what OpenRouter makes of it for an OpenAI model is not documented.
      const requestLevel = hasCacheControl(existingOptions.openrouter)
      if (requestLevel) preserved.push('openrouter.cacheControl.automatic')
      const placed = placeOpenAiHistoryBreakpoints({
        messages,
        marker: { openrouter: { cacheControl: { type: 'ephemeral' } } },
        label: 'openrouter.history.cacheControl.openai',
        implicit: true,
        existing: countCachePoints(messages, input.tools) + (requestLevel ? 1 : 0),
        applied,
        preserved,
        omitted,
      })
      messages = placed.messages
      historyParts = placed.historyParts
    }
  }

  if (provider === 'vercel-gateway') {
    defaults.gateway = { ...(defaults.gateway ?? {}) }
    if (existingOptions.gateway?.caching === undefined) {
      defaults.gateway.caching = 'auto'
      applied.push('gateway.caching')
      // BL-184: the gateway's automatic points on a Claude model use Anthropic's default
      // five-minute lifetime (Batshit sends no `cache_ttl`). A request that also carries its
      // own Anthropic cache setting may change that, so its lifetime stays unknown.
      if (modelLooksAnthropic(modelId) && !hasCacheControl(existingOptions.anthropic)) {
        cacheTtl = '5m'
      }
    } else {
      preserved.push('gateway.caching')
    }
  }

  // SA-107: per-session cache-affinity hint for providers that document one.
  const requestHeaders: Record<string, string> = {}
  const affinityHeaderName = SESSION_AFFINITY_HEADER_BY_PROVIDER[provider]
  if (affinityHeaderName) {
    requestHeaders[affinityHeaderName] = buildSessionAffinityValue({
      userId: input.userId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      modelId,
    })
    applied.push(`${provider}.${affinityHeaderName}`)
  }

  const providerOptions = deepMerge(defaults, existingOptions)

  const retention = providerOptions.openai?.promptCacheRetention
  if (
    retention !== undefined &&
    !supportsOpenAiPromptCacheRetention(modelId, retention)
  ) {
    delete providerOptions.openai.promptCacheRetention
    omitted.push({
      option: 'openai.promptCacheRetention',
      reason:
        'The selected OpenAI model is not in the documented support set for the requested prompt-cache retention policy.',
    })
  }

  for (const providerName of Object.keys(providerOptions)) {
    if (Object.keys(providerOptions[providerName] ?? {}).length === 0) {
      delete providerOptions[providerName]
    }
  }

  const metadata: ApiPromptCachePolicyMetadata = {
    enabled: applied.length > 0 || preserved.length > 0,
    provider,
    modelId,
    transport: input.connection?.type ?? null,
    stablePrefixHash: stablePrefix.hash,
    stablePrefixParts: stablePrefix.parts,
    applied,
    preserved,
    omitted,
    providerOptionKeys: providerOptionKeys(providerOptions),
    requestHeaderNames: Object.keys(requestHeaders).sort(),
    cacheTtl,
    historyParts,
  }

  return {
    messages,
    tools: input.tools,
    providerOptions: isEmptyProviderOptions(providerOptions)
      ? undefined
      : providerOptions,
    headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
    stepProviderOptions,
    toolLoopTailMarker,
    metadata,
  }
}
