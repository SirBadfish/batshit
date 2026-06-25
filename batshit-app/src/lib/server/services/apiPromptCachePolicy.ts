import { asSchema, type ModelMessage } from 'ai'
import { createHash } from 'crypto'
import type { ModelConnectionInfo } from '$lib/types/savedModels'

type ProviderOptions = Record<string, Record<string, any>>
type ProviderKind =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'vercel-gateway'
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
}

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
  metadata: ApiPromptCachePolicyMetadata
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

function inferProvider(args: {
  modelId?: string | null
  providerId?: string | null
  connection?: ModelConnectionInfo | null
}): ProviderKind {
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

export function applyApiPromptCachePolicy(
  input: ApiPromptCachePolicyInput,
): ApiPromptCachePolicyResult {
  const provider = inferProvider(input)
  const existingOptions = cloneProviderOptions(input.providerOptions)
  const defaults: ProviderOptions = {}
  let messages = input.messages
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

  if (provider === 'anthropic') {
    if (!hasCacheControl(existingOptions.anthropic)) {
      const annotation = annotateLastSystemMessageCacheControl({
        messages,
        provider: 'anthropic',
        cacheControl: { type: 'ephemeral' },
      })
      messages = annotation.messages
      if (annotation.applied) {
        applied.push('anthropic.cacheControl')
      } else if (annotation.preserved) {
        preserved.push('anthropic.cacheControl')
      } else {
        omitted.push({
          option: 'anthropic.cacheControl',
          reason:
            'No stable system message was available to mark as the Anthropic cache breakpoint.',
        })
      }
    } else {
      preserved.push('anthropic.cacheControl')
    }
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
      if (
        existingOptions.openrouter?.cache_control === undefined &&
        existingOptions.openrouter?.cacheControl === undefined
      ) {
        const annotation = annotateLastSystemMessageCacheControl({
          messages,
          provider: 'openrouter',
          cacheControl: { type: 'ephemeral' },
        })
        messages = annotation.messages
        if (annotation.applied) {
          applied.push('openrouter.cache_control')
        } else if (annotation.preserved) {
          preserved.push('openrouter.cache_control')
        } else {
          omitted.push({
            option: 'openrouter.cache_control',
            reason:
              'No stable system message was available to mark as the OpenRouter Anthropic cache breakpoint.',
          })
        }
      } else {
        preserved.push('openrouter.cache_control')
      }
    }
  }

  if (provider === 'vercel-gateway') {
    defaults.gateway = { ...(defaults.gateway ?? {}) }
    if (existingOptions.gateway?.caching === undefined) {
      defaults.gateway.caching = 'auto'
      applied.push('gateway.caching')
    } else {
      preserved.push('gateway.caching')
    }
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
  }

  return {
    messages,
    tools: input.tools,
    providerOptions: isEmptyProviderOptions(providerOptions)
      ? undefined
      : providerOptions,
    metadata,
  }
}
