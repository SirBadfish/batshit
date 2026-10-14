import { asSchema, type ModelMessage } from 'ai'
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
   * BL-77: provider options for a tool loop's SECOND and later steps, which the per-step hook
   * (`buildTurnPrepareStep`) returns from `prepareStep`. The SDK merges them into that one
   * step's call options (they are not carried to the next step), and the provider sends them
   * as the request-level cache point that Anthropic places on the last block, so each step
   * reads everything the previous step sent from the cache. Present only on direct Anthropic;
   * OpenRouter gets `toolLoopTailMarker` instead (BL-185).
   */
  stepProviderOptions?: ProviderOptions | undefined
  /**
   * BL-185: the tool loop's tail point on OpenRouter with a Claude-family model, as an explicit
   * marker the per-step hook moves to the last message from the SECOND step on
   * (`placeToolLoopTailMarker`). OpenRouter's Amazon Bedrock route accepts the request-level
   * field and ignores it (measured 2026-09-22 and 2026-09-25); an explicit block marker works on
   * every upstream OpenRouter documents.
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

function serializeToolForSignature(name: string, toolDefinition: any) {
  const safe: Record<string, any> = {
    name,
    description:
      typeof toolDefinition?.description === 'string'
        ? toolDefinition.description
        : null,
  }

  try {
    safe.inputSchema = toolDefinition?.inputSchema
      ? asSchema(toolDefinition.inputSchema).jsonSchema
      : null
  } catch {
    safe.inputSchema = null
  }

  try {
    safe.outputSchema = toolDefinition?.outputSchema
      ? asSchema(toolDefinition.outputSchema).jsonSchema
      : null
  } catch {
    safe.outputSchema = null
  }

  return safe
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

  const serializedTools = Object.entries(tools ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, toolDefinition]) =>
      serializeToolForSignature(name, toolDefinition),
    )

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
 * 3. The tool loop's tail point (BL-77) for the per-step hook to add from a turn's second step
 *    on. On direct Anthropic it is the request-level point (`stepProviderOptions`), which the
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
  labels: { system: string; toolLoop: string }
  applied: string[]
  preserved: string[]
  omitted: ApiPromptCachePolicyMetadata['omitted']
}): {
  messages: ModelMessage[]
  stepProviderOptions?: ProviderOptions
  toolLoopTailMarker?: ToolLoopTailMarker
  cacheTtl: CacheTtl | null
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

  if (requestLevel) {
    preserved.push(`${namespace}.cacheControl.automatic`)
    return { messages, cacheTtl }
  }
  if (!args.toolLoop) return { messages, cacheTtl }

  const explicitPoints = countCachePoints(messages, args.tools)
  if (explicitPoints + 1 > ANTHROPIC_MAX_CACHE_POINTS) {
    omitted.push({
      option: labels.toolLoop,
      reason: `The request already carries ${explicitPoints} cache points; Anthropic allows ${ANTHROPIC_MAX_CACHE_POINTS} including the tool loop's request-level point.`,
    })
    return { messages, cacheTtl }
  }

  applied.push(labels.toolLoop)
  if (namespace === 'openrouter') {
    return { messages, toolLoopTailMarker: { namespace, cacheControl: { ...cacheControl } }, cacheTtl }
  }
  return {
    messages,
    stepProviderOptions: { [namespace]: { cacheControl: { ...cacheControl } } },
    cacheTtl,
  }
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
 * never touched, so the system point stays and a replayed approval continuation is never marked.
 * Every message from there on belongs to this run's loop (the model's responses, tool results, an
 * injected steer or image message), and none of them carries a cache marker of its own, so any
 * marker there is the one this function placed on an earlier step. The SDK hands a step's
 * returned messages to the next step, so that marker is stripped before the new one is placed:
 * a request carries the system point and ONE tail point.
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
): ModelMessage[] {
  let targetIndex = messages.length - 1
  while (targetIndex >= firstLoopIndex && isOneTextUserMessage(messages[targetIndex])) targetIndex -= 1
  if (targetIndex < firstLoopIndex) return messages

  const out = messages.map((message, index) => {
    if (index < firstLoopIndex) return message
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

  if (provider === 'anthropic') {
    const placed = placeAnthropicFamilyCachePoints({
      namespace: 'anthropic',
      requestOptions: existingOptions.anthropic,
      messages,
      tools: input.tools,
      standingMedia: true,
      toolLoop: connectionKind === 'anthropic',
      labels: {
        system: 'anthropic.cacheControl',
        toolLoop: 'anthropic.toolLoop.cacheControl.fromStep2',
      },
      applied,
      preserved,
      omitted,
    })
    messages = placed.messages
    stepProviderOptions = placed.stepProviderOptions
    cacheTtl = placed.cacheTtl
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
        labels: {
          system: 'openrouter.cache_control',
          toolLoop: 'openrouter.toolLoop.cache_control.lastMessage.fromStep2',
        },
        applied,
        preserved,
        omitted,
      })
      messages = placed.messages
      toolLoopTailMarker = placed.toolLoopTailMarker
      cacheTtl = placed.cacheTtl
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
