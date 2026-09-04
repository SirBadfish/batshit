import { env } from '$env/dynamic/private'
import { normalizeUsageLike, withHonestLocalCacheUsage } from '$lib/server/services/apiProviderUsage'
import { resolveLocalPromptCacheReporting } from '$lib/data/localAiServers'
import type {
  CacheForensicsProviderCacheUsage,
  CacheForensicsRecord,
  CacheForensicsSegmentType,
} from '$lib/types/cacheForensics'
import {
  COMPILED_TEXT_PART_TYPES,
  compiledTextPartValue,
  segmentCompiledUserMessage,
} from './compiledMessageSegments'
import type { CacheForensicsSegmentInput } from './fingerprint'
import { captureCacheForensicsRecord } from './record'

/**
 * SA-093 `API` runtime adapter (P4).
 *
 * Fingerprints the PROVIDER-REQUEST boundary from AI SDK v7 step results:
 * `step.request.body` is the exact serialized provider request (restored by
 * vercelBrain's `include: { requestBody: true }`), so this is 'exact'
 * confidence evidence (DL-093-08). One record per model call keeps tool-loop
 * calls separate (DL-093-07 / P4).
 *
 * IMPORTANT: fingerprint RAW step data, never log-sanitized copies — the log
 * redaction replaces distinct base64 payloads with size-labeled markers, which
 * could make two genuinely different requests hash identically.
 */

function parseBody(body: unknown): { value: unknown; parsed: boolean } {
  if (typeof body === 'string') {
    try {
      return { value: JSON.parse(body), parsed: true }
    } catch {
      return { value: body, parsed: false }
    }
  }
  if (body && typeof body === 'object') return { value: body, parsed: true }
  return { value: body, parsed: false }
}

function segmentTypeForKey(key: string): CacheForensicsSegmentType {
  if (key === 'tools' || key === 'tool_config' || key === 'toolConfig') return 'tool'
  if (key === 'messages' || key === 'contents' || key === 'input') return 'history-message'
  if (
    key === 'system' ||
    key === 'systemInstruction' ||
    key === 'system_instruction' ||
    // DQ-D-028: the Responses API's own system-instruction field.
    key === 'instructions'
  )
    return 'system-prompt'
  return 'request-block'
}

function elementNameSuffix(element: unknown): string {
  if (!element || typeof element !== 'object') return ''
  const record = element as Record<string, unknown>
  const name =
    (typeof record.name === 'string' && record.name) ||
    (typeof (record.function as Record<string, unknown> | undefined)?.name === 'string' &&
      ((record.function as Record<string, unknown>).name as string)) ||
    (typeof record.role === 'string' && record.role) ||
    (typeof record.type === 'string' && record.type) ||
    ''
  return name ? `:${name}` : ''
}

/**
 * DQ-D-028: label rule for Responses-shaped `body.input[]` items.
 *
 * Role-bearing items keep their role suffix, matching the chat-shaped labels.
 * Typed items — `function_call`, `function_call_output`, `reasoning`, … — are
 * labelled by their ITEM TYPE, with the tool name appended when they carry
 * one, because `elementNameSuffix` prefers `name` and would otherwise label a
 * `function_call` with the bare tool name and hide what kind of item it is.
 *
 * Scoped to the `input` array on purpose: applying a type-first rule globally
 * would relabel chat-shaped `body.tools[i]` entries (OpenAI chat tools carry
 * `type: 'function'`), and chat-shaped bodies must stay byte-identical.
 */
function responsesInputNameSuffix(element: unknown): string {
  if (!element || typeof element !== 'object') return ''
  const record = element as Record<string, unknown>
  if (typeof record.role === 'string' && record.role) return `:${record.role}`
  const itemType = typeof record.type === 'string' && record.type ? record.type : ''
  if (!itemType) return elementNameSuffix(element)
  const name = typeof record.name === 'string' && record.name ? record.name : ''
  return name ? `:${itemType}:${name}` : `:${itemType}`
}

/**
 * True when a content part is one of the recognised text-part shapes,
 * regardless of whether its `text` is actually a string. The standing-media
 * boundary scan needs the TYPE test alone (a malformed text part still ends
 * the leading image run), so it cannot use `compiledTextPartValue`.
 */
function isCompiledTextPartType(part: unknown): boolean {
  const partType =
    part && typeof part === 'object' ? (part as Record<string, unknown>).type : undefined
  return typeof partType === 'string' && COMPILED_TEXT_PART_TYPES.includes(partType)
}

/**
 * SA-108: expands one message-array element. Batshit compiles the entire
 * conversation into ONE user message, so a Batshit-compiled element is split
 * into per-history-message + current-turn sub-segments; anything else keeps
 * its existing single-segment shape.
 *
 * DQ-D-028: the same rule covers Responses-shaped items, whose text parts are
 * typed `input_text` rather than `text`. An array of parts that produced no
 * split still collapses back to ONE segment — one rule for both shapes, which
 * is what keeps chat-shaped fingerprints byte-identical.
 */
function expandMessageElement(
  element: unknown,
  type: CacheForensicsSegmentType,
  label: string,
): CacheForensicsSegmentInput[] {
  const single: CacheForensicsSegmentInput[] = [{ type, label, content: element ?? null }]
  if (!element || typeof element !== 'object') return single

  const content = (element as Record<string, unknown>).content

  if (typeof content === 'string') {
    return segmentCompiledUserMessage(content, label) ?? single
  }

  if (Array.isArray(content)) {
    const expanded: CacheForensicsSegmentInput[] = []
    let splitAnyPart = false
    let startIndex = 0
    const standingHeader = content[0] as Record<string, unknown> | undefined
    if (
      isCompiledTextPartType(standingHeader) &&
      typeof standingHeader?.text === 'string' &&
      standingHeader.text.startsWith('==== AWARENESS MEDIA (STANDING) ====')
    ) {
      let standingEnd = 1
      while (standingEnd < content.length) {
        const part = content[standingEnd] as Record<string, unknown> | undefined
        if (isCompiledTextPartType(part)) break
        standingEnd += 1
      }
      expanded.push({
        type: 'attachment',
        label: `${label}#standing`,
        content: content.slice(0, standingEnd)
      })
      startIndex = standingEnd
      splitAnyPart = true
    }
    content.slice(startIndex).forEach((part, relativePartIndex) => {
      const partIndex = startIndex + relativePartIndex
      const partRecord = part && typeof part === 'object' ? (part as Record<string, unknown>) : null
      const partText = compiledTextPartValue(part)
      const partSegments =
        partText !== null ? segmentCompiledUserMessage(partText, label) : null
      if (partSegments) {
        splitAnyPart = true
        expanded.push(...partSegments)
        return
      }
      const partType = typeof partRecord?.type === 'string' ? `:${partRecord.type}` : ''
      expanded.push({
        type: 'attachment',
        label: `${label}#part[${partIndex}]${partType}`,
        content: part ?? null,
      })
    })
    return splitAnyPart ? expanded : single
  }

  return single
}

/**
 * Segments a provider request body generically and deterministically:
 * top-level entries in the object's own key order (approximating wire order),
 * arrays expanded one segment per element so message/tool order is non-lossy.
 * Batshit-compiled user messages are additionally sub-segmented (SA-108),
 * on chat-shaped (`messages`/`contents`) and Responses-shaped (`input`)
 * bodies alike (DQ-D-028, splitter v3).
 */
export function segmentProviderRequestBody(body: unknown): {
  segments: CacheForensicsSegmentInput[]
  parsed: boolean
} {
  const { value, parsed } = parseBody(body)

  if (!parsed || !value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      segments: [{ type: 'request-block', label: 'body.raw', content: value ?? null }],
      parsed: false,
    }
  }

  const segments: CacheForensicsSegmentInput[] = []
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryValue === undefined) continue
    if (Array.isArray(entryValue)) {
      const type = segmentTypeForKey(key)
      const isMessageArray = type === 'history-message'
      // DQ-D-028: `input` is the Responses API's item list (xAI, direct OpenAI
      // in Responses mode). No chat-shaped body Batshit sends uses that key.
      const isResponsesInput = key === 'input'
      entryValue.forEach((element, index) => {
        const suffix = isResponsesInput
          ? responsesInputNameSuffix(element)
          : elementNameSuffix(element)
        const label = `body.${key}[${index}]${suffix}`
        if (isMessageArray) {
          segments.push(...expandMessageElement(element, type, label))
          return
        }
        segments.push({ type, label, content: element ?? null })
      })
      continue
    }
    segments.push({
      type: segmentTypeForKey(key),
      label: `body.${key}`,
      content: entryValue,
    })
  }

  return { segments, parsed: true }
}

function providerCacheUsageForStep(step: any, providerId?: string | null): CacheForensicsProviderCacheUsage | undefined {
  const fromUsage = normalizeUsageLike(step?.usage)
  const fromMetadata = normalizeUsageLike({ providerMetadata: step?.providerMetadata })
  const usage = withHonestLocalCacheUsage(
    fromUsage ?? fromMetadata,
    resolveLocalPromptCacheReporting(providerId),
    [step?.usage?.raw],
  )
  if (!usage) return undefined

  const cacheUsage: CacheForensicsProviderCacheUsage = { source: 'provider' }
  if (typeof usage.inputTokens === 'number') cacheUsage.inputTokens = usage.inputTokens
  if (typeof usage.cachedInputTokens === 'number') {
    cacheUsage.cachedInputTokens = usage.cachedInputTokens
  }
  if (typeof usage.cacheCreationInputTokens === 'number') {
    cacheUsage.cacheCreationInputTokens = usage.cacheCreationInputTokens
  }
  return cacheUsage
}

/**
 * Deliberate experiment grouping for controlled P5 runs: set
 * BATSHIT_CACHE_FORENSICS_EXPERIMENT to a label before an experiment batch.
 * The label is pseudonymized before storage/export (DL-093-09).
 */
export function resolveCacheForensicsExperimentGroup(): string | null {
  const value = (env.BATSHIT_CACHE_FORENSICS_EXPERIMENT || '').trim()
  return value.length > 0 ? value : null
}

export function buildApiCacheForensicsRecords(args: {
  steps: unknown[]
  agentId: string | null | undefined
  connectionId: string | null | undefined
  modelId: string | null | undefined
  providerId?: string | null
  messageId: string
  experimentGroup?: string | null
  capturedAt?: string
}): CacheForensicsRecord[] {
  const steps = Array.isArray(args.steps) ? args.steps : []

  return steps.map((step: any, index) => {
    const callIndex = index + 1
    const body = step?.request?.body
    const hasBody = body !== undefined && body !== null

    const { segments, parsed } = hasBody
      ? segmentProviderRequestBody(body)
      : { segments: [], parsed: false }

    const record = captureCacheForensicsRecord({
      runtime: 'vercel',
      boundary: 'provider-request',
      confidence: hasBody && parsed ? 'exact' : 'near',
      agentId: args.agentId,
      connectionId: args.connectionId,
      modelId: args.modelId,
      runId: `${args.messageId}#call${callIndex}`,
      experimentGroup: args.experimentGroup ?? null,
      segments,
      capturedAt: args.capturedAt,
      ...(hasBody && !parsed
        ? { notes: ['Provider request body was not parseable JSON; fingerprinted as one opaque block.'] }
        : {}),
    })

    record.callIndex = callIndex

    const cacheUsage = providerCacheUsageForStep(step, args.providerId)
    if (cacheUsage) record.providerCacheUsage = cacheUsage

    if (!hasBody && record.divergence?.state !== 'capture-failed') {
      record.divergence = {
        state: 'provider-evidence-unavailable',
        reason:
          'The runtime did not expose a provider request body for this call, so there is nothing to fingerprint at the provider-request boundary.',
      }
    }

    return record
  })
}
