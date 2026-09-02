import type {
  ExecutionConfidenceLevel,
  ExecutionLlmCall,
  ExecutionLlmSummary,
  ExecutionTokenStat,
  ExecutionTokenUsage,
} from '$lib/types/executionViewer'
import { redactHeaders } from '$lib/server/services/executionViewerRedaction'
import { asSchema } from 'ai'
import type { Tool } from 'ai'
import {
  hasUsageValues as hasNormalizedUsageValues,
  mergeUsageLike,
  normalizeUsageLike,
  type ApiUsageLike,
} from '$lib/server/services/apiProviderUsage'

type UsageLike = ApiUsageLike

export const buildTokenStat = (
  value: number | undefined | null,
  confidence: ExecutionConfidenceLevel,
  source?: string,
): ExecutionTokenStat => ({
  value: typeof value === 'number' ? value : null,
  confidence,
  ...(source ? { source } : {}),
})

export const buildTokenUsage = (
  usage: UsageLike,
  confidence: ExecutionConfidenceLevel,
  source?: string,
): ExecutionTokenUsage => {
  const normalizedUsage = normalizeUsageLike(usage) ?? usage
  const inputTokens = normalizedUsage?.inputTokens
  const outputTokens = normalizedUsage?.outputTokens
  const totalTokensRaw = normalizedUsage?.totalTokens
  const cachedInputTokens =
    normalizedUsage?.cachedInputTokens ??
    normalizedUsage?.inputTokenDetails?.cacheReadTokens
  const cacheCreationInputTokens = normalizedUsage?.cacheCreationInputTokens
  const reasoningTokens =
    normalizedUsage?.reasoningTokens ??
    normalizedUsage?.outputTokenDetails?.reasoningTokens
  const canSum =
    typeof inputTokens === 'number' && typeof outputTokens === 'number'
  const totalTokens =
    typeof totalTokensRaw === 'number'
      ? totalTokensRaw
      : canSum
        ? inputTokens + outputTokens
        : undefined

  const totalConfidence: ExecutionConfidenceLevel =
    typeof totalTokensRaw === 'number'
      ? confidence
      : canSum
        ? 'near'
        : confidence

  const usageStats: ExecutionTokenUsage = {
    inputTokens: buildTokenStat(inputTokens, confidence, source),
    outputTokens: buildTokenStat(outputTokens, confidence, source),
    totalTokens: buildTokenStat(totalTokens, totalConfidence, source),
  }

  if (typeof cachedInputTokens === 'number') {
    usageStats.cachedInputTokens = buildTokenStat(
      cachedInputTokens,
      confidence,
      source,
    )
  }

  if (typeof cacheCreationInputTokens === 'number') {
    usageStats.cacheCreationInputTokens = buildTokenStat(
      cacheCreationInputTokens,
      confidence,
      source,
    )
  }

  if (typeof reasoningTokens === 'number') {
    usageStats.reasoningTokens = buildTokenStat(
      reasoningTokens,
      confidence,
      source,
    )
  }

  return usageStats
}

const hasUsageValues = (usage: UsageLike): boolean =>
  hasNormalizedUsageValues(usage)

const DATA_IMAGE_URL_REGEX =
  /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)/gi

function redactDataImageUrlsInString(value: string): string {
  if (!value || !value.toLowerCase().includes('data:image/')) return value
  return value.replace(
    DATA_IMAGE_URL_REGEX,
    (_full, mediaType: string, base64Data: string) => {
      const approxBytes = Math.max(0, Math.floor((base64Data.length * 3) / 4))
      return `[redacted ${mediaType} data URL (${approxBytes} bytes)]`
    },
  )
}

/**
 * SA-105 P1 (DL-105-12): redact in-turn image bytes carried as AI SDK 7 parts.
 *
 * The data-URL regex above and the base64 key heuristic below both miss these.
 * A tool-result image part is `{ type: 'file', mediaType: 'image/png',
 * data: { type: 'data', data: '<raw base64>' } }` — the base64 has no
 * `data:image/` prefix, and the key is plain `data`. The same shape is used by
 * the synthetic user-message parts on text-only lanes, so one structural rule
 * covers both delivery channels. Without it, every recall or screenshot turn
 * would write megabytes of base64 into the execution log and the cache
 * forensics records.
 */
function redactImagePartInPlace(node: Record<string, unknown>): boolean {
  const mediaType = typeof node.mediaType === 'string' ? node.mediaType.toLowerCase() : ''

  // Current shape: a `file` part whose nested data payload holds the bytes.
  if (node.type === 'file' && mediaType.startsWith('image/')) {
    const data = node.data
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const inner = data as Record<string, unknown>
      if (inner.type === 'data' && typeof inner.data === 'string') {
        const approxBytes = Math.max(0, Math.floor((inner.data.length * 3) / 4))
        inner.data = `[redacted ${mediaType || 'image'} bytes (${approxBytes} bytes)]`
        return true
      }
    }
    return false
  }

  // Deprecated shims. `ai` converts these before they reach a provider, but a
  // captured payload can still hold one if a caller has not migrated yet.
  if (node.type === 'image-data' && typeof node.data === 'string') {
    const approxBytes = Math.max(0, Math.floor((node.data.length * 3) / 4))
    node.data = `[redacted ${mediaType || 'image'} bytes (${approxBytes} bytes)]`
    return true
  }

  // SA-105 P3: the managed CLI shape. MCP content blocks are
  // `{ type: 'image', data: '<raw base64>', mimeType: 'image/png' }` — a
  // different type, a different key for the MIME (`mimeType`, not `mediaType`)
  // and, like the `file` shape above, base64 with no `data:` prefix under a
  // plain `data` key. Every existing heuristic here misses it, which is exactly
  // how a delivered recall photo turned up in a real execution log during the
  // P3 live probe.
  if (node.type === 'image' && typeof node.data === 'string') {
    const mimeType = typeof node.mimeType === 'string' ? node.mimeType.toLowerCase() : ''
    const approxBytes = Math.max(0, Math.floor((node.data.length * 3) / 4))
    node.data = `[redacted ${mimeType || mediaType || 'image'} bytes (${approxBytes} bytes)]`
    return true
  }

  return false
}

function sanitizePayloadForCapture<T>(value: T, keyHint?: string): T {
  const seen = new WeakSet<object>()

  const sanitizeString = (input: string, key?: string): string => {
    if (key && /(thoughtSignature|thinkingSignature|reasoningSignature)/i.test(key)) {
      return `[redacted provider thought signature (${input.length} chars)]`
    }
    const redactedDataUrl = redactDataImageUrlsInString(input)
    if (key && /(base64|localbase64|b64|b64_json|image_data)/i.test(key)) {
      const trimmed = redactedDataUrl.trim()
      if (trimmed.length > 0) {
        const approxBytes = Math.max(0, Math.floor((trimmed.length * 3) / 4))
        return `[redacted base64 payload (${approxBytes} bytes)]`
      }
    }
    return redactedDataUrl
  }

  const visit = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') return sanitizeString(node, key)
    if (!node || typeof node !== 'object') return node
    if (seen.has(node as object)) return node
    seen.add(node as object)

    if (Array.isArray(node)) {
      return node.map((entry) => visit(entry, key))
    }

    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(
      node as Record<string, unknown>,
    )) {
      output[childKey] = visit(childValue, childKey)
    }
    // Applied after the children are copied so the redaction lands on this
    // capture's own object, never on the live payload being captured.
    redactImagePartInPlace(output)
    return output
  }

  return visit(value, keyHint) as T
}

/**
 * SA-105 P3 — sanitize the managed CLI runtimes' RAW transport event trace
 * before it is persisted into the Execution Viewer snapshot.
 *
 * `__rawEvents` is the untouched Codex/Claude event stream, and it was being
 * stored verbatim. That was invisible until this packet, because nothing in a
 * CLI event carried image bytes — now an MCP tool result can, and the P3 live
 * probe found a delivered recall photo sitting in a real execution log even
 * though every other boundary had stripped it. Running the trace through the
 * same sanitizer the LLM captures use fixes that and, more usefully, closes the
 * whole class: data URLs, base64-keyed fields and provider thought signatures
 * in any future raw event are covered by one rule instead of a new patch each
 * time.
 */
export function sanitizeRuntimeEventLogForCapture<T>(value: T): T {
  return sanitizePayloadForCapture(value)
}

export function buildVercelLlmCapture(params: {
  steps: any[]
  totalUsage: UsageLike
  finalText?: string | null
}): { llmSummary: ExecutionLlmSummary; llmCalls: ExecutionLlmCall[] } {
  const steps = Array.isArray(params.steps) ? params.steps : []
  const finalText =
    typeof params.finalText === 'string' ? params.finalText : null
  const totalUsage = normalizeUsageLike(params.totalUsage) ?? params.totalUsage
  const hasTotalUsage = hasUsageValues(totalUsage)
  const allowTotalUsageFallback = steps.length === 1 && hasTotalUsage

  const normalizeToolArgsForBilledOutput = (raw: any): any => {
    if (raw == null) return {}
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }
    return raw
  }

  const llmCalls: ExecutionLlmCall[] = steps.map((step, idx) => {
    const requestBody = sanitizePayloadForCapture(step?.request?.body)
    const rawResponsePayload = step?.response
      ? sanitizePayloadForCapture({
          id: step.response.id,
          modelId: step.response.modelId,
          timestamp: step.response.timestamp,
          headers: redactHeaders(step.response.headers),
          messages: step.response.messages,
          body: step.response.body,
        })
      : undefined

    const toolCallsCount = Array.isArray(step?.toolCalls)
      ? step.toolCalls.length
      : undefined
    const toolResultsCount = Array.isArray(step?.toolResults)
      ? step.toolResults.length
      : undefined

    const toolCallsForBilledOutput = Array.isArray(step?.toolCalls)
      ? step.toolCalls
          .map((toolCall: any) => {
            const name = toolCall?.toolName ?? toolCall?.name ?? null
            if (typeof name !== 'string' || name.trim().length === 0)
              return null

            const args =
              toolCall?.args ??
              toolCall?.input ??
              toolCall?.toolInput ??
              toolCall?.parameters ??
              null

            const toolCallId = toolCall?.toolCallId ?? toolCall?.id ?? null

            return {
              name,
              args: sanitizePayloadForCapture(
                normalizeToolArgsForBilledOutput(args),
              ),
              ...(typeof toolCallId === 'string' && toolCallId.trim().length > 0
                ? { toolCallId }
                : {}),
            }
          })
          .filter((entry: any) => Boolean(entry))
      : []

    const responseText = (() => {
      if (toolCallsForBilledOutput.length > 0) return ''
      if (idx === steps.length - 1 && finalText !== null) return finalText
      if (typeof step?.text === 'string') return step.text
      return ''
    })()

    const responsePayload = sanitizePayloadForCapture({
      response: responseText,
      ...(toolCallsForBilledOutput.length > 0
        ? { toolCalls: toolCallsForBilledOutput }
        : {}),
    })

    const finishReasonRaw = step?.finishReason ?? null
    const finishReason =
      finishReasonRaw === 'unknown' ? 'other' : finishReasonRaw

    const stepUsageFromSdk = normalizeUsageLike(step?.usage)
    const stepUsageFromMetadata = normalizeUsageLike({
      providerMetadata: step?.providerMetadata,
    })
    const stepUsage =
      stepUsageFromSdk && stepUsageFromMetadata
        ? mergeUsageLike(stepUsageFromSdk, stepUsageFromMetadata)
        : stepUsageFromSdk ?? stepUsageFromMetadata ?? step?.usage
    const hasStepUsage = hasUsageValues(stepUsage)
    const resolvedUsage = hasStepUsage
      ? stepUsage
      : allowTotalUsageFallback
        ? totalUsage
        : stepUsage
    const usageConfidence: ExecutionConfidenceLevel = hasStepUsage
      ? 'exact'
      : allowTotalUsageFallback
        ? 'near'
        : 'exact'
    const usageSource = hasStepUsage
      ? 'provider'
      : allowTotalUsageFallback
        ? 'provider-total'
        : 'provider'

    return {
      index: idx + 1,
      runtime: 'vercel',
      usage: buildTokenUsage(resolvedUsage, usageConfidence, usageSource),
      requestPayload: requestBody ?? null,
      requestConfidence: requestBody ? 'exact' : 'near',
      responsePayload,
      rawResponsePayload,
      responseConfidence: rawResponsePayload ? 'near' : 'speculative',
      finishReason,
      toolCallsCount,
      toolResultsCount,
    }
  })

  const callsCount = steps.length
  const hasMissingStepUsage = steps.some((step) => !hasUsageValues(step?.usage))
  const llmSummary: ExecutionLlmSummary = {
    callsCount: buildTokenStat(callsCount, 'exact', 'vercel ai sdk'),
    totalUsage: buildTokenUsage(totalUsage, 'exact', 'provider'),
    breakdownConfidence:
      hasMissingStepUsage && hasTotalUsage ? 'near' : 'exact',
  }

  return { llmSummary, llmCalls }
}

export function buildCodexLlmCapture(params: {
  prompt: string
  developerInstructions?: string | null
  images?: Array<{ url: string; alt?: string }>
  tools?: Record<string, Tool> | null
  toolMetadata?: Map<string, any> | null
  totalUsage: UsageLike
}): { llmSummary: ExecutionLlmSummary; llmCalls: ExecutionLlmCall[] } {
  return buildCliModeLlmCapture({
    runtime: 'codex',
    prompt: params.prompt,
    developerInstructions: params.developerInstructions,
    images: params.images,
    tools: params.tools,
    toolMetadata: params.toolMetadata,
    totalUsage: params.totalUsage,
  })
}

export function buildClaudeLlmCapture(params: {
  prompt: string
  images?: Array<{ url: string; alt?: string }>
  tools?: Record<string, Tool> | null
  toolMetadata?: Map<string, any> | null
  totalUsage: UsageLike
}): { llmSummary: ExecutionLlmSummary; llmCalls: ExecutionLlmCall[] } {
  return buildCliModeLlmCapture({
    runtime: 'claude',
    prompt: params.prompt,
    images: params.images,
    tools: params.tools,
    toolMetadata: params.toolMetadata,
    totalUsage: params.totalUsage,
  })
}

function buildCliModeLlmCapture(params: {
  runtime: 'codex' | 'claude'
  prompt: string
  developerInstructions?: string | null
  images?: Array<{ url: string; alt?: string }>
  tools?: Record<string, Tool> | null
  toolMetadata?: Map<string, any> | null
  totalUsage: UsageLike
}): { llmSummary: ExecutionLlmSummary; llmCalls: ExecutionLlmCall[] } {
  const serializedTools = (() => {
    const output: Array<Record<string, any>> = []
    const tools =
      params.tools && typeof params.tools === 'object' ? params.tools : {}

    for (const [toolName, tool] of Object.entries(tools)) {
      const safe: Record<string, any> = {
        name: toolName,
        description: tool?.description ?? null,
      }

      try {
        safe.inputSchema = asSchema((tool as any).inputSchema).jsonSchema
      } catch {
        safe.inputSchema = null
      }

      try {
        safe.outputSchema = (tool as any).outputSchema
          ? asSchema((tool as any).outputSchema).jsonSchema
          : null
      } catch {
        safe.outputSchema = null
      }

      const meta = params.toolMetadata?.get?.(toolName)
      if (meta && typeof meta === 'object') {
        safe.gateway = meta
      }

      output.push(safe)
    }

    return output.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  })()

  const requestPayload = sanitizePayloadForCapture({
    ...(params.developerInstructions
      ? { developerInstructions: params.developerInstructions }
      : {}),
    prompt: params.prompt,
    ...(Array.isArray(params.images) && params.images.length > 0
      ? { images: params.images }
      : {}),
    ...(serializedTools.length > 0 ? { tools: serializedTools } : {}),
  })

  const runtimeName =
    params.runtime === 'codex' ? 'Codex CLI' : 'Claude Code CLI'
  const usageSource = params.runtime === 'codex' ? 'codex' : 'claude'
  const responseNote =
    params.runtime === 'codex'
      ? 'Codex CLI does not expose a raw provider response object. See Response Summary for the final output and Debug -> Raw Runtime Events for the runtime stream.'
      : 'Claude Code CLI does not expose a raw provider response object. See Response Summary for the final output and Debug -> Raw Runtime Events for the runtime stream.'
  const toolSerializationNote =
    params.runtime === 'codex'
      ? 'Codex tool definitions are provided via runtime/MCP configuration; the exact on-wire representation may differ from the direct API runtime payload.'
      : 'Claude tool definitions are provided via runtime/MCP configuration; the exact on-wire representation may differ from the direct API runtime payload.'
  const promptSerializationNote =
    params.runtime === 'claude'
      ? 'The compiled prompt captured here is exact, but Claude wraps it into stream-json text/image blocks before sending.'
      : 'The developerInstructions and prompt captured here are the exact Batshit-to-Codex launch payload pieces. Codex still wraps them with native permissions, environment, tool, and built-in instruction context before the provider call.'

  const llmCalls: ExecutionLlmCall[] = [
    {
      index: 1,
      runtime: params.runtime,
      usage: buildTokenUsage(params.totalUsage, 'exact', usageSource),
      requestPayload,
      requestConfidence: 'near',
      responsePayload: {
        note: responseNote,
      },
      responseConfidence: 'speculative',
      finishReason: null,
      toolCallsCount: undefined,
      toolResultsCount: undefined,
      notes: [
        ...(serializedTools.length > 0
          ? [
              `Tool definitions shown here are derived from Batshit gateway discovery (MCP). ${runtimeName} may serialize them differently internally.`,
            ]
          : []),
        ...(promptSerializationNote ? [promptSerializationNote] : []),
        toolSerializationNote,
        `${runtimeName} native built-in tools are runtime-owned and may not appear in this request payload list even when they were available during the run.`,
      ],
    },
  ]

  const llmSummary: ExecutionLlmSummary = {
    callsCount: buildTokenStat(1, 'speculative', usageSource),
    totalUsage: buildTokenUsage(params.totalUsage, 'exact', usageSource),
    breakdownConfidence: 'speculative',
  }

  return { llmSummary, llmCalls }
}
