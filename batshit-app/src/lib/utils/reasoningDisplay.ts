import type { ModelCapabilities } from '$lib/types/savedModels'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
import type { ExecutionReasoningPersistence } from '$lib/types/executionViewer'
import type { InterruptedReasoningRecovery } from '$lib/utils/reasoningRecovery'

type ReasoningOptionsArgs = {
  provider?: string | null
  modelId?: string | null
  connection?: Record<string, any> | null
  capabilities?: ModelCapabilities | null
  showReasoning: boolean
}

function cloneProviderOptions(
  providerOptions?: Record<string, Record<string, any>> | null
): Record<string, Record<string, any>> {
  const clone: Record<string, Record<string, any>> = {}
  for (const [provider, options] of Object.entries(providerOptions ?? {})) {
    clone[provider] =
      options && typeof options === 'object' && !Array.isArray(options)
        ? { ...options }
        : {}
  }
  return clone
}

function textIncludesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle))
}

function inferProviderKey(args: ReasoningOptionsArgs): string {
  const values = [
    args.provider,
    args.connection?.provider,
    args.connection?.service,
    args.connection?.id,
    args.connection?.type,
    args.modelId,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase())

  const joined = values.join(' ')
  if (textIncludesAny(joined, ['anthropic', 'claude'])) return 'anthropic'
  if (textIncludesAny(joined, ['google', 'gemini'])) return 'google'
  if (textIncludesAny(joined, ['zai', 'z.ai', 'glm'])) return 'zai'
  if (textIncludesAny(joined, ['deepseek', 'r1'])) return 'deepseek'
  if (textIncludesAny(joined, ['xiaomi', 'mimo'])) return 'mimo'
  if (textIncludesAny(joined, ['openai', 'gpt-', 'gpt_', 'o1', 'o3', 'o4', 'o5'])) return 'openai'
  return ''
}

function looksReasoningCapable(args: ReasoningOptionsArgs): boolean {
  if (args.capabilities?.reasoning === true) return true
  const providerKey = inferProviderKey(args)
  if (providerKey === 'deepseek' || providerKey === 'mimo') return true
  const model = (args.modelId ?? '').toLowerCase()
  return textIncludesAny(model, [
    'gpt-5',
    'o1',
    'o3',
    'o4',
    'o5',
    'gemini-2.5',
    'gemini-3',
    'claude-3-7',
    'claude-4',
    'claude-opus-4',
    'claude-sonnet-4',
    'deepseek-reasoner',
    'deepseek-r1',
    'mimo-v2.5',
    'glm-',
    'r1',
  ])
}

/**
 * SA-102 P3: is this model served by one of Batshit's local AI programs?
 *
 * Uses the connection's own identity, never the model name — a local model may
 * legitimately be called `gpt-oss-20b` or `glm-4-9b`, and name inference is
 * exactly the trap SA-102 P2 removed from two other places.
 */
function isLocalRuntime(args: ReasoningOptionsArgs): boolean {
  const candidates = [args.provider, args.connection?.service, args.connection?.provider]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && LOCAL_AI_SERVER_IDS.has(candidate.trim().toLowerCase() as any)) {
      return true
    }
  }
  const connectionId = args.connection?.id
  if (typeof connectionId === 'string' && connectionId.startsWith('direct:')) {
    return LOCAL_AI_SERVER_IDS.has(connectionId.slice('direct:'.length).trim().toLowerCase() as any)
  }
  return false
}

function usesVercelGateway(args: ReasoningOptionsArgs): boolean {
  return [
    args.connection?.id,
    args.connection?.type,
    args.connection?.service,
  ].some(
    (value) =>
      typeof value === 'string' &&
      value.trim().toLowerCase() === 'vercel-gateway',
  )
}

/**
 * Some reasoning-capable OpenAI-compatible models stream their reasoning inside
 * ordinary text using XML-style tags instead of a structured reasoning field.
 * Resolve the tag at the request boundary so the AI SDK can normalize it before
 * Batshit's normal reasoning display/persistence pipeline sees the stream.
 */
export function resolveTaggedReasoningTagName(
  args: ReasoningOptionsArgs,
): 'think' | null {
  // SA-102 P3: local thinking models are the common case, and their names match
  // none of the cloud substrings above — a `Qwen3.8-27B-MLX-4bit` matched
  // nothing, so its <think> block rendered as raw text unless the user knew to
  // tick the preset's Reasoning capability by hand. Detection is enabled for
  // every local program: a model that never emits the tag is unaffected, and a
  // model that does was previously showing the user its private thinking as
  // part of its answer.
  //
  // Deliberately NOT widened to `withReasoningProviderOptions`. That function
  // injects cloud-shaped options (`openai.reasoningSummary`,
  // `google.thinkingConfig`, `anthropic.sendReasoning`) which mean nothing to a
  // local engine.
  if (looksReasoningCapable(args) || isLocalRuntime(args)) return 'think'
  return null
}

export function withReasoningProviderOptions(
  providerOptions: Record<string, Record<string, any>> | undefined,
  args: ReasoningOptionsArgs
): Record<string, Record<string, any>> | undefined {
  if (!looksReasoningCapable(args)) {
    return providerOptions
  }

  const providerKey = inferProviderKey(args)

  // Gateway's DeepInfra MiMo route can emit one unterminated <think> block and
  // no final answer. The creator-hosted Xiaomi route emits structured reasoning
  // and text parts, so prefer it for Batshit's reasoning/display contract. Do
  // not add a Xiaomi-specific thinking option: Xiaomi's default already emits
  // the structured parts, and preserving the original request shape avoids
  // coupling Display Reasoning to model behavior. Explicit user routing wins.
  if (providerKey === 'mimo') {
    const next = cloneProviderOptions(providerOptions)
    if (usesVercelGateway(args)) {
      const gateway = { ...(next.gateway ?? {}) }
      if (gateway.only === undefined && gateway.order === undefined) {
        gateway.only = ['xiaomi']
      }
      next.gateway = gateway
    }

    return Object.keys(next).length > 0 ? next : providerOptions
  }

  const next = cloneProviderOptions(providerOptions)

  if (providerKey === 'openai') {
    next.openai = { ...(next.openai ?? {}) }
    if (next.openai.reasoningSummary === undefined) {
      next.openai.reasoningSummary = 'auto'
    }
    return next
  }

  if (providerKey === 'google') {
    next.google = { ...(next.google ?? {}) }
    const thinkingConfig =
      next.google.thinkingConfig &&
      typeof next.google.thinkingConfig === 'object' &&
      !Array.isArray(next.google.thinkingConfig)
        ? { ...next.google.thinkingConfig }
        : {}
    thinkingConfig.includeThoughts = true
    next.google.thinkingConfig = thinkingConfig
    return next
  }

  if (providerKey === 'anthropic') {
    next.anthropic = { ...(next.anthropic ?? {}) }
    if (next.anthropic.sendReasoning === undefined) {
      next.anthropic.sendReasoning = true
    }
    return next
  }

  return Object.keys(next).length > 0 ? next : providerOptions
}

function collectString(value: unknown, out: string[]) {
  if (typeof value === 'string' && value.length > 0) {
    out.push(value)
  }
}

function collectReasoningFromRecord(record: Record<string, any>, out: string[]) {
  collectString(record.reasoning_content, out)
  collectString(record.reasoningContent, out)
  collectString(record.reasoning_text, out)
  collectString(record.reasoningText, out)
  collectString(record.thinking_content, out)
  collectString(record.thinkingContent, out)
}

export function extractReasoningTextFromRawChunk(rawValue: unknown): string {
  if (!rawValue || typeof rawValue !== 'object') return ''
  const raw = rawValue as Record<string, any>

  if (
    typeof raw.type === 'string' &&
    raw.type.startsWith('response.reasoning_summary')
  ) {
    return ''
  }

  const parts: string[] = []
  collectReasoningFromRecord(raw, parts)

  const choices = Array.isArray(raw.choices) ? raw.choices : []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const delta = (choice as any).delta
    if (delta && typeof delta === 'object') {
      collectReasoningFromRecord(delta, parts)
    }
    const message = (choice as any).message
    if (message && typeof message === 'object') {
      collectReasoningFromRecord(message, parts)
    }
  }

  return parts.join('')
}

/**
 * Raw provider chunks are diagnostic/fallback evidence. Current AI SDK provider
 * adapters can emit the same reasoning_content value again as a normalized
 * reasoning event, so the normalized lane becomes authoritative as soon as it
 * appears. Raw-only providers still stream with a one-raw-chunk delay.
 */
export class ReasoningStreamSourceArbiter {
  private normalizedReasoningObserved = false
  private pendingRawReasoning = ''

  noteNormalizedReasoning(): void {
    this.normalizedReasoningObserved = true
    this.pendingRawReasoning = ''
  }

  queueRawFallback(content: string): string {
    if (this.normalizedReasoningObserved) {
      this.pendingRawReasoning = ''
      return ''
    }
    if (!content) {
      return ''
    }

    const ready = this.pendingRawReasoning
    this.pendingRawReasoning = content
    return ready
  }

  flushRawFallback(): string {
    if (this.normalizedReasoningObserved) {
      this.pendingRawReasoning = ''
      return ''
    }

    const ready = this.pendingRawReasoning
    this.pendingRawReasoning = ''
    return ready
  }
}

export function buildReasoningPersistenceEvidence(args: {
  showReasoning: boolean
  preserveReasoning: boolean
  reasoningSummary?: string | null
  interruptedReasoningRecovery?: InterruptedReasoningRecovery | null
}): ExecutionReasoningPersistence {
  const summary =
    typeof args.reasoningSummary === 'string' ? args.reasoningSummary : ''
  const requested = args.showReasoning

  return {
    userHistoryStatus: !requested ? 'not-requested' : summary ? 'saved' : 'not-emitted',
    agentHistoryStatus:
      !requested || !summary
        ? 'not-applicable'
        : args.preserveReasoning
          ? 'included'
          : 'excluded',
    characterCount: requested ? summary.length : 0,
    source: 'message.metadata.reasoningSummary',
    recoveryStatus: args.interruptedReasoningRecovery ? 'pending' : 'not-applicable',
    recoveryTrigger: args.interruptedReasoningRecovery?.trigger ?? null,
    recoveryCharacterCount: args.interruptedReasoningRecovery
      ? args.interruptedReasoningRecovery.reasoningCharacterCount +
        args.interruptedReasoningRecovery.planCharacterCount
      : 0,
    recoverySource: args.interruptedReasoningRecovery
      ? 'message.metadata.interruptedReasoningRecovery.renderedBlock'
      : null,
  }
}

function collectReasoningText(value: unknown, out: string[]) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) out.push(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReasoningText(entry, out)
    }
    return
  }
  if (!value || typeof value !== 'object') return

  const record = value as Record<string, any>
  for (const candidate of [
    record.text,
    record.reasoningText,
    record.reasoning_text,
    record.reasoning,
    record.content,
  ]) {
    collectReasoningText(candidate, out)
  }
}

export function collectReasoningTextFromFinish(value: unknown): string {
  const parts: string[] = []
  collectReasoningText(value, parts)
  return parts.join('\n\n').trim()
}
