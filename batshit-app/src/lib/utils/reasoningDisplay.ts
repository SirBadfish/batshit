import type { ModelCapabilities } from '$lib/types/savedModels'

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
 * Some reasoning-capable OpenAI-compatible models stream their reasoning inside
 * ordinary text using XML-style tags instead of a structured reasoning field.
 * Resolve the tag at the request boundary so the AI SDK can normalize it before
 * Batshit's normal reasoning display/persistence pipeline sees the stream.
 */
export function resolveTaggedReasoningTagName(
  args: ReasoningOptionsArgs,
): 'think' | null {
  return looksReasoningCapable(args) ? 'think' : null
}

export function withReasoningProviderOptions(
  providerOptions: Record<string, Record<string, any>> | undefined,
  args: ReasoningOptionsArgs
): Record<string, Record<string, any>> | undefined {
  if (!looksReasoningCapable(args)) {
    return providerOptions
  }

  const providerKey = inferProviderKey(args)

  // MiMo defaults to thinking mode, but some OpenAI-compatible routes collapse
  // the reasoning and final answer into one tagged text block when that default
  // is left implicit. Explicitly requesting Xiaomi's thinking contract makes
  // reasoning_content and content arrive as separate stream fields. Keep this
  // independent of Display Reasoning so hiding the panel never changes model
  // behavior or leaks reasoning back into ordinary assistant text.
  if (providerKey === 'mimo') {
    const next = cloneProviderOptions(providerOptions)
    const xiaomi = { ...(next.xiaomi ?? {}) }
    if (xiaomi.thinking === undefined) {
      xiaomi.thinking = { type: 'enabled' }
    }
    next.xiaomi = xiaomi
    return next
  }

  if (!args.showReasoning) {
    return providerOptions
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
