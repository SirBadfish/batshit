import { asSchema, type Tool } from 'ai'
import { normalizeUsageLike } from '$lib/server/services/apiProviderUsage'
import type {
  CacheForensicsProviderCacheUsage,
  CacheForensicsRecord,
  CacheForensicsSegmentType,
} from '$lib/types/cacheForensics'
import { segmentCompiledUserMessage } from './compiledMessageSegments'
import type { CacheForensicsSegmentInput } from './fingerprint'
import { captureCacheForensicsRecord } from './record'

/**
 * SA-093 Codex/Claude `CLI` runtime adapter (P4).
 *
 * Fingerprints the BATSHIT-COMPILED boundary — the only boundary these lanes
 * honestly own (DL-093-08): Batshit's compiled message array, image
 * attachments, and the gateway tool contract handed to the managed CLI run.
 * The CLI harness then adds its own native instructions, built-in tools,
 * thread state, and provider serialization AFTER this boundary; that hidden
 * material is explicitly unavailable and is disclosed in record notes rather
 * than guessed at (DL-093-07).
 *
 * One record covers the whole run: the harness may make many provider calls
 * internally, but Batshit sees a single opaque run with one usage total, so a
 * per-call breakdown would be invented evidence.
 *
 * IMPORTANT: fingerprint RAW inputs, never log-sanitized copies — log
 * redaction replaces distinct base64/image payloads with size markers, which
 * could make two genuinely different requests hash identically.
 */

interface CliMessageLike {
  role?: string
  content?: unknown
  name?: string
}

function messageSegmentType(
  message: CliMessageLike,
  index: number,
  total: number,
): CacheForensicsSegmentType {
  if (message?.role === 'system') return 'system-prompt'
  if (index === total - 1 && message?.role === 'user') return 'current-user-turn'
  return 'history-message'
}

/**
 * Shared batshit-compiled message segmentation: one ordered segment per
 * compiled message, role-labeled. Used by the CLI adapter and the managed
 * subagent adapter so the two lanes stay hash-comparable in shape.
 */
export function segmentCompiledMessages(messages: unknown[]): CacheForensicsSegmentInput[] {
  const list = Array.isArray(messages) ? messages : []
  const segments: CacheForensicsSegmentInput[] = []
  list.forEach((message, index) => {
    const entry = (message ?? {}) as CliMessageLike
    const role = typeof entry.role === 'string' && entry.role ? entry.role : 'unknown'
    const label = `prompt.messages[${index}]:${role}`
    // SA-108: Batshit compiles the whole conversation into one user message, so
    // that element is sub-segmented here exactly like the API lane does.
    const compiled =
      typeof entry.content === 'string' ? segmentCompiledUserMessage(entry.content, label) : null
    if (compiled) {
      segments.push(...compiled)
      return
    }
    segments.push({
      type: messageSegmentType(entry, index, list.length),
      label,
      content: message ?? null,
    })
  })
  return segments
}

/**
 * Converted JSON schemas can carry non-JSON decorations (schema-library
 * validators show up as function properties in some module resolutions). A
 * JSON round-trip keeps exactly the JSON-visible contract, deterministically
 * in every environment, and never trips the loud function-rejection in
 * canonicalSerialize for the whole record.
 */
function toPlainJson(value: unknown): unknown {
  if (value === undefined || value === null) return null
  try {
    return JSON.parse(JSON.stringify(value)) ?? null
  } catch {
    return null
  }
}

/** Batshit-visible tool contract: name, description, and JSON schemas only. */
function serializeToolContract(toolName: string, tool: Tool): Record<string, unknown> {
  const contract: Record<string, unknown> = {
    name: toolName,
    description: (tool as any)?.description ?? null,
  }
  try {
    contract.inputSchema = toPlainJson(asSchema((tool as any).inputSchema).jsonSchema)
  } catch {
    contract.inputSchema = null
  }
  try {
    contract.outputSchema = (tool as any).outputSchema
      ? toPlainJson(asSchema((tool as any).outputSchema).jsonSchema)
      : null
  } catch {
    contract.outputSchema = null
  }
  return contract
}

function providerCacheUsageFromRuntime(
  usage: unknown,
): CacheForensicsProviderCacheUsage | undefined {
  const normalized = normalizeUsageLike(usage)
  if (!normalized) return undefined

  const cacheUsage: CacheForensicsProviderCacheUsage = { source: 'runtime' }
  if (typeof normalized.inputTokens === 'number') {
    cacheUsage.inputTokens = normalized.inputTokens
  }
  if (typeof normalized.cachedInputTokens === 'number') {
    cacheUsage.cachedInputTokens = normalized.cachedInputTokens
  }
  if (typeof normalized.cacheCreationInputTokens === 'number') {
    cacheUsage.cacheCreationInputTokens = normalized.cacheCreationInputTokens
  }
  if (
    cacheUsage.inputTokens === undefined &&
    cacheUsage.cachedInputTokens === undefined &&
    cacheUsage.cacheCreationInputTokens === undefined
  ) {
    return undefined
  }
  return cacheUsage
}

export function buildCliCacheForensicsRecord(args: {
  runtime: 'codex' | 'claude'
  /** RAW compiled message array handed to the bridge (not log-sanitized). */
  messages: unknown[]
  /** RAW image attachments handed to the bridge. */
  images?: Array<{ url: string; alt?: string }> | null
  /** RAW gateway tool map handed to the managed run, in delivery order. */
  tools?: Record<string, Tool> | null
  /** Runtime-reported usage total for the whole run. */
  usage?: unknown
  agentId: string | null | undefined
  connectionId: string | null | undefined
  modelId: string | null | undefined
  messageId: string
  experimentGroup?: string | null
  capturedAt?: string
}): CacheForensicsRecord {
  const messages = Array.isArray(args.messages) ? args.messages : []
  const images = Array.isArray(args.images) ? args.images : []
  const tools =
    args.tools && typeof args.tools === 'object' ? Object.entries(args.tools) : []

  const segments: CacheForensicsSegmentInput[] = [
    ...segmentCompiledMessages(messages),
  ]

  images.forEach((image, index) => {
    segments.push({
      type: 'attachment',
      label: `prompt.images[${index}]`,
      content: { url: image?.url ?? null, alt: image?.alt ?? null },
    })
  })

  // Tool serialization is harness-owned past this boundary, so the tool
  // segments carry 'near' confidence while the compiled prompt stays exact.
  tools.forEach(([toolName, tool]) => {
    segments.push({
      type: 'tool',
      label: `tool:${toolName}`,
      content: serializeToolContract(toolName, tool),
      confidence: 'near',
    })
  })

  const runtimeName = args.runtime === 'codex' ? 'Codex CLI' : 'Claude Code CLI'
  const record = captureCacheForensicsRecord({
    runtime: args.runtime,
    boundary: 'batshit-compiled',
    confidence: 'exact',
    agentId: args.agentId,
    connectionId: args.connectionId,
    modelId: args.modelId,
    runId: args.messageId,
    experimentGroup: args.experimentGroup ?? null,
    segments,
    capturedAt: args.capturedAt,
    notes: [
      `Segments cover Batshit's compiled boundary only: ${runtimeName} adds native instructions, built-in tools, thread state, and provider serialization after this point, and that hidden material is unavailable to Batshit.`,
      'The harness may make several provider calls internally; Batshit sees one opaque run with one usage total, so this record deliberately has no per-call breakdown.',
    ],
  })

  const cacheUsage = providerCacheUsageFromRuntime(args.usage)
  if (cacheUsage) record.providerCacheUsage = cacheUsage

  return record
}
