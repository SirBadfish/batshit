/**
 * SA-105 P1 — shared, feature-neutral tool-result image delivery (DL-105-01).
 *
 * One module owns every decision about handing a model an image that came back
 * from a tool: which delivery lane the run can use, how the part is shaped, the
 * caps and MIME gate, the ephemeral marker, and the strip that keeps those bytes
 * out of persisted provider context.
 *
 * Two features consume it — Agent Browser screenshots and memory recall — and
 * neither depends on the other. Josh's lock: visual recall must survive Agent
 * Browser being removed from Batshit entirely (AMD-105-14). The vocabulary here
 * is therefore neutral; Agent Browser adapts to it, never the reverse.
 *
 * The lane table is not guesswork. Every row was verified twice on 2026-09-02:
 * by reading the installed provider dist, and by a live obedience probe that
 * asked a model to name four quadrant colours only the image could reveal
 * across the supported native and synthetic delivery lanes.
 * The rule that run established, and the one any future edit here must follow:
 * **a lane is only verified if the probe built the model the way
 * `providers/index.ts` builds it** — an earlier run stood xAI up on
 * `createOpenAICompatible` and got the wrong answer, because Batshit actually
 * uses `createXai`, whose default factory is the Responses model (AMD-105-13).
 */

import type { ModelCapabilities } from '$lib/types/savedModels'
import { modelAllowsImageInput } from './modelInputCapabilities'

// ---------------------------------------------------------------- lane

export type ToolResultImageLane = 'tool_result' | 'synthetic_user' | 'none'

/** Which managed runtime is consuming the tool result. */
export type ToolResultImageRuntime = 'api' | 'codex' | 'claude'

export interface ToolResultImageDeliveryDecision {
  lane: ToolResultImageLane
  /** Machine-readable cause, for EV records and test assertions. */
  reason: string
}

export interface ResolveToolResultImageDeliveryInput {
  providerId?: string | null
  /**
   * Only meaningful for OpenAI-shaped providers. Batshit registers each provider
   * with a fixed mode (`providers/index.ts`), so the table below already knows
   * the mode for every id; pass this only to override a specific run.
   */
  apiMode?: 'responses' | 'chat' | null
  modelId?: string | null
  capabilities?: ModelCapabilities | null
  runtime?: ToolResultImageRuntime | null
}

/**
 * Providers whose tool results carry an image natively.
 *
 * Verified per package on 2026-09-02 (installed dists) and live:
 * - `anthropic` — `@ai-sdk/anthropic` maps a `file` part to an `image` block.
 * - `openai` — Batshit registers it in Responses mode, which maps image data
 *   parts to `input_image` inside `function_call_output`. Chat mode does NOT
 *   (same model, same image, only `apiMode` differs → vision flips), which is
 *   why `apiMode: 'chat'` demotes this row.
 * - `google` — `tool_result` for ANY vision-capable Gemini, not only 3-series.
 *   The pre-3 path (`appendLegacyToolResultParts`) still pushes a real
 *   `inlineData` part; `usesGemini3Features` only changes WHERE the image sits
 *   (nested in `functionResponse.parts` vs a sibling top-level part). Verified
 *   live on `gemini-2.5-flash` (AMD-105-01).
 * - `xai` — Batshit builds it with `createXai`, whose default factory is the
 *   Responses model with its own `input_image` converter (AMD-105-13).
 */
const TOOL_RESULT_PROVIDER_IDS = new Set(['anthropic', 'openai', 'google', 'xai'])

/**
 * The Vercel AI Gateway is a routing surface, not a serialization surface, so it
 * cannot be one row: it resolves to whatever provider family the model id names
 * (AMD-105-02). Verified live — Gateway→Anthropic and Gateway→OpenAI deliver the
 * image; Gateway→`alibaba/qwen3-vl-instruct` does not, and that is Bob's shape.
 */
const GATEWAY_PROVIDER_IDS = new Set(['vercel-gateway'])

/** Gateway model-id prefixes that map onto a `tool_result` family. */
const GATEWAY_TOOL_RESULT_PREFIXES = new Set(['anthropic', 'openai', 'google', 'xai'])

function normalizeId(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Resolve the delivery lane for one run.
 *
 * Unknown providers deliberately fall to `synthetic_user`, never `tool_result`.
 * The failure mode of a wrong `tool_result` guess is not a missing image — it is
 * a megabyte of base64 landing in the model's TEXT context. That is exactly the
 * Agent Browser defect this story fixes: one 423 KB screenshot measured at
 * ~141,125 tokens of base64 text, with the model replying "RECEIVED TEXT NOT
 * IMAGE" (AMD-105-11).
 */
export function resolveToolResultImageDelivery(
  input: ResolveToolResultImageDeliveryInput,
): ToolResultImageDeliveryDecision {
  // One vision rule for the whole app (DL-105-06). Unknown capabilities stay
  // allowed, matching how attached clips already behave; a genuinely text-only
  // model then fails loudly through IMAGE_INPUT_UNSUPPORTED rather than having
  // its image silently dropped here.
  if (!modelAllowsImageInput(input.capabilities ?? null)) {
    return { lane: 'none', reason: 'model_capabilities_vision_false' }
  }

  const runtime = input.runtime ?? 'api'
  if (runtime === 'claude') {
    // Blocked upstream, not by us: Claude Code stores MCP ImageContent as text
    // at 10-20x the token cost (anthropic/claude-code#31208, closed not-planned
    // 2026-03). Emitting image content here would cost tokens for nothing.
    return { lane: 'none', reason: 'claude_cli_stores_mcp_images_as_text' }
  }
  if (runtime === 'codex') {
    // Codex renders MCP `image` content blocks into the model's turn
    // (openai/codex#4819, closed by PR #5600). The one hard constraint is on the
    // producing side, not here: the helper bridge must never set
    // `structuredContent` on the same result, because Codex drops `content[]`
    // entirely when it is present (openai/codex#10334). Proven live in P3.
    return { lane: 'tool_result', reason: 'codex_cli_mcp_image_content' }
  }

  const providerId = normalizeId(input.providerId)
  if (!providerId) {
    return { lane: 'synthetic_user', reason: 'provider_unknown_defaults_text_safe' }
  }

  if (GATEWAY_PROVIDER_IDS.has(providerId)) {
    const modelId = normalizeId(input.modelId)
    const separator = modelId.indexOf('/')
    if (separator <= 0) {
      return { lane: 'synthetic_user', reason: 'gateway_model_id_unparseable' }
    }
    const underlying = modelId.slice(0, separator)
    if (GATEWAY_TOOL_RESULT_PREFIXES.has(underlying)) {
      return { lane: 'tool_result', reason: `gateway_underlying_${underlying}` }
    }
    return { lane: 'synthetic_user', reason: `gateway_underlying_${underlying || 'unknown'}_text` }
  }

  if (TOOL_RESULT_PROVIDER_IDS.has(providerId)) {
    // OpenAI is the one row where a caller can legitimately change the answer:
    // the same model in chat mode cannot see a tool-result image.
    if (providerId === 'openai' && input.apiMode === 'chat') {
      return { lane: 'synthetic_user', reason: 'openai_chat_mode_serializes_tool_results_as_text' }
    }
    return { lane: 'tool_result', reason: `provider_${providerId}_native_tool_result_images` }
  }

  // Everything else serializes a `content` output with `JSON.stringify`. That
  // covers the openai-compatible family and the dedicated packages built on the
  // same shape; five of those (`groq`, `mistral`, `deepseek`, `cohere`,
  // `alibaba`) contain no image-mapping code at all, so there is no path by
  // which they could emit an image.
  return { lane: 'synthetic_user', reason: `provider_${providerId}_serializes_tool_results_as_text` }
}

// ---------------------------------------------------------------- caps + MIME

/**
 * Anthropic's exact accepted list, which every other `tool_result` lane also
 * accepts. Anything else defers to the next-message channel with a reason.
 */
export const TOOL_RESULT_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

/**
 * Per-image raw cap. ~6.8 MB once base64-encoded, comfortably under Anthropic's
 * 10 MB-base64 per-image limit and Google's inline limits.
 */
export const MAX_TOOL_RESULT_IMAGE_BYTES = 5 * 1024 * 1024

/** Keeps a recall of 8 memories from becoming a 32-image request. */
export const MAX_TOOL_RESULT_IMAGES = 4

export type ToolResultImageDeferralReason =
  | 'over_size'
  | 'unsupported_mime'
  | 'over_count'
  | 'lane_none'
  | 'source_unavailable'

export function isSupportedToolResultImageMimeType(mimeType?: string | null): boolean {
  const normalized = normalizeId(mimeType)
  return (TOOL_RESULT_IMAGE_MIME_TYPES as readonly string[]).includes(normalized)
}

export interface ToolResultImageCandidate {
  /** Stable id for the source (a memory media id, a screenshot path, …). */
  id: string
  mediaType: string
  /** Raw byte length before base64. Used for the size gate. */
  bytes?: number | null
  filename?: string | null
}

export interface ToolResultImageAdmission<T extends ToolResultImageCandidate> {
  admitted: T[]
  deferred: Array<{ candidate: T; reason: ToolResultImageDeferralReason }>
}

/**
 * Apply the lane, MIME, size and count gates in that order, returning both what
 * is admitted and — just as importantly — why everything else was not. Callers
 * surface the deferrals to the model so a missing image is always explained
 * rather than silently absent.
 */
export function admitToolResultImages<T extends ToolResultImageCandidate>(
  candidates: T[],
  options: { lane: ToolResultImageLane; maxImages?: number },
): ToolResultImageAdmission<T> {
  const admitted: T[] = []
  const deferred: Array<{ candidate: T; reason: ToolResultImageDeferralReason }> = []
  const limit = Math.max(0, options.maxImages ?? MAX_TOOL_RESULT_IMAGES)

  for (const candidate of candidates) {
    if (options.lane === 'none') {
      deferred.push({ candidate, reason: 'lane_none' })
      continue
    }
    if (!isSupportedToolResultImageMimeType(candidate.mediaType)) {
      deferred.push({ candidate, reason: 'unsupported_mime' })
      continue
    }
    if (typeof candidate.bytes === 'number' && candidate.bytes > MAX_TOOL_RESULT_IMAGE_BYTES) {
      deferred.push({ candidate, reason: 'over_size' })
      continue
    }
    if (admitted.length >= limit) {
      deferred.push({ candidate, reason: 'over_count' })
      continue
    }
    admitted.push(candidate)
  }

  return { admitted, deferred }
}

// ---------------------------------------------------------------- part builder

export interface ToolResultImagePart {
  mediaType: string
  /** Base64 bytes. Mutually exclusive with `url`. */
  data?: string | null
  /** A model-visible URL. Mutually exclusive with `data`. */
  url?: string | null
  filename?: string | null
}

export interface ToolResultImageContentOutput {
  type: 'content'
  value: Array<
    | { type: 'text'; text: string }
    | {
        type: 'file'
        mediaType: string
        filename?: string
        // The SDK's `SharedV4FileDataUrl` requires a real `URL` instance, not a
        // string — providers call `.toString()` on it. Passing a string here
        // collapses `tool()`'s generic inference to `never`, which surfaces as a
        // confusing "not assignable to FlexibleSchema<never>" error on the tool
        // definition rather than on this part.
        data: { type: 'data'; data: string } | { type: 'url'; url: URL }
      }
  >
}

/**
 * Build a tool result in the CURRENT AI SDK 7 shape.
 *
 * Never the deprecated `image-data` / `image-url` / `image-file-id` shims: `ai`
 * converts them to this exact shape anyway while logging a warning on every
 * call. Worth stating plainly, because it was the one thing the story's recon
 * had inverted — those shims are NOT what makes an image arrive as text on a
 * text lane. The captured wire body showed `ai` had already converted the shim
 * to a `file` part before the provider stringified it. The LANE decision is the
 * fix; the shape is just hygiene (AMD-105-11).
 */
export function buildToolResultImageContentOutput(options: {
  text: string
  images: ToolResultImagePart[]
}): ToolResultImageContentOutput {
  const value: ToolResultImageContentOutput['value'] = [{ type: 'text', text: options.text }]

  for (const image of options.images) {
    const mediaType = typeof image.mediaType === 'string' ? image.mediaType : 'image/png'
    const filename = typeof image.filename === 'string' && image.filename.trim().length > 0
      ? { filename: image.filename.trim() }
      : {}

    if (typeof image.data === 'string' && image.data.length > 0) {
      value.push({ type: 'file', mediaType, ...filename, data: { type: 'data', data: image.data } })
      continue
    }
    if (typeof image.url === 'string' && image.url.trim().length > 0) {
      try {
        value.push({
          type: 'file',
          mediaType,
          ...filename,
          data: { type: 'url', url: new URL(image.url.trim()) }
        })
      } catch {
        // A malformed URL is dropped rather than thrown: the caller's text part
        // still explains what was returned, and one bad screenshot URL must not
        // fail the whole send.
      }
    }
  }

  return { type: 'content', value }
}

// ---------------------------------------------------------------- ephemeral marker

/**
 * Leading text of the synthetic user message that carries images on text-only
 * lanes. The strip below matches on this sentinel rather than on any tool name.
 *
 * The synthetic message never reached `response.messages` on any lane probed in
 * P0, so this half of the strip is defence in depth rather than the load-bearing
 * boundary (AMD-105-06) — but SDK behaviour can change, and a silent leak here
 * would be base64 in persisted context.
 */
export const EPHEMERAL_IMAGE_MESSAGE_MARKER = '[batshit:ephemeral-images]'

export function buildEphemeralImageMessageText(source: string, purpose?: string | null): string {
  const suffix = purpose && purpose.trim().length > 0 ? ` (${purpose.trim()})` : ''
  return `${EPHEMERAL_IMAGE_MESSAGE_MARKER} Images returned by ${source}${suffix}:`
}

export interface EphemeralImageDelivery {
  mediaType: string
  /** Base64 bytes. */
  data: string
  filename?: string | null
}

/**
 * Per-run store handing images from `toModelOutput` to `prepareStep` on
 * text-only lanes (DL-105-03).
 *
 * Deliberately NOT module-level state. A module-level Map would be shared by
 * every concurrent run in the process — group chat runs several agents through
 * the same server, and one agent's recalled photo must never surface in
 * another's step. The brain creates one registry per run and passes it down, so
 * the images cannot outlive or escape the run that loaded them.
 */
export interface EphemeralImageRegistry {
  register(toolCallId: string, source: string, images: EphemeralImageDelivery[]): void
  /** Reads AND clears, so a delivery is injected exactly once. */
  take(toolCallId: string): { source: string; images: EphemeralImageDelivery[] } | undefined
  pending(): number
}

export function createEphemeralImageRegistry(): EphemeralImageRegistry {
  const entries = new Map<string, { source: string; images: EphemeralImageDelivery[] }>()
  return {
    register(toolCallId, source, images) {
      if (!toolCallId || !images.length) return
      entries.set(toolCallId, { source, images })
    },
    take(toolCallId) {
      const entry = entries.get(toolCallId)
      if (entry) entries.delete(toolCallId)
      return entry
    },
    pending() {
      return entries.size
    }
  }
}

/**
 * The single user message that carries images on a text-only lane. Uses the
 * current `file` part shape — `{ type: 'image', image }` still works but logs a
 * deprecation warning on every call (AMD-105-05).
 */
export function buildEphemeralImageUserMessage(options: {
  source: string
  purpose?: string | null
  images: EphemeralImageDelivery[]
}): { role: 'user'; content: Array<Record<string, any>> } {
  return {
    role: 'user',
    content: [
      { type: 'text', text: buildEphemeralImageMessageText(options.source, options.purpose) },
      ...options.images.map((image) => ({
        type: 'file',
        mediaType: image.mediaType,
        ...(image.filename ? { filename: image.filename } : {}),
        data: image.data
      }))
    ]
  }
}

function isEphemeralImageMessage(message: any): boolean {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return false
  return message.content.some(
    (part: any) =>
      part?.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.includes(EPHEMERAL_IMAGE_MESSAGE_MARKER),
  )
}

// ---------------------------------------------------------------- strip

/**
 * Feature-neutral replacement text. The old wording named Agent Browser, which
 * is precisely the coupling Josh asked us to remove.
 */
export function buildOmittedImageNote(label: string): string {
  return `[Image omitted from persisted provider context after this loop: ${label}]`
}

const DEPRECATED_IMAGE_PART_TYPES = new Set(['image-data', 'image-url', 'image-file-id'])

function isImageContentPart(part: any): boolean {
  if (!part || typeof part !== 'object') return false
  if (DEPRECATED_IMAGE_PART_TYPES.has(part.type)) return true
  if (part.type !== 'file') return false
  const mediaType = normalizeId(part.mediaType)
  return mediaType.startsWith('image/')
}

function toolResultCarriesImage(part: any): boolean {
  if (!part || part.type !== 'tool-result') return false
  const output = part.output
  if (!output || output.type !== 'content' || !Array.isArray(output.value)) return false
  return output.value.some(isImageContentPart)
}

/**
 * Remove in-turn image bytes from provider messages before they are persisted.
 *
 * Keyed on PART SHAPE and the ephemeral marker — never on a tool name. The
 * previous implementation matched only `native_bash_execute` /
 * `native_agent_browser_use` plus the deprecated part types, which had two
 * consequences worth remembering (AMD-105-04): changing Agent Browser's shape
 * without changing this in the same commit would have silently begun persisting
 * screenshot base64, and memory recall — which arrives as `batshit_tool_use` —
 * would never have matched at all. Persisted provider messages are replayed on
 * tool-approval resume and on context continuation, so this is the boundary.
 */
export function stripEphemeralImagesFromProviderMessages<T extends { role?: string; content?: any }>(
  providerMessages: T[],
  options?: { label?: string },
): T[] {
  const label = options?.label ?? 'in-turn image'
  const note = buildOmittedImageNote(label)
  let changed = false

  const sanitized = providerMessages.map((message) => {
    if (!message || typeof message !== 'object' || !Array.isArray((message as any).content)) {
      return message
    }

    // Channel 2: the synthetic user message on text-only lanes.
    if (isEphemeralImageMessage(message)) {
      const content = (message as any).content as any[]
      if (!content.some(isImageContentPart)) return message
      changed = true
      return {
        ...message,
        content: content
          .filter((part) => !isImageContentPart(part))
          .concat([{ type: 'text', text: note }]),
      } as T
    }

    // Channel 1: images riding a tool result. This is the load-bearing half.
    const content = (message as any).content as any[]
    let messageChanged = false
    const nextContent = content.map((part) => {
      if (!toolResultCarriesImage(part)) return part
      messageChanged = true
      changed = true
      return { ...part, output: { type: 'text', value: note } }
    })

    if (!messageChanged) return message
    return { ...message, content: nextContent } as T
  })

  return changed ? sanitized : providerMessages
}

// ---------------------------------------------------------------- MCP strip (managed CLI lanes)

/**
 * The managed CLI half of the strip above (SA-105 P3).
 *
 * On the API lanes the bytes ride inside `providerMessages`, so
 * `stripEphemeralImagesFromProviderMessages` is the boundary. On the managed CLI
 * lanes they ride as MCP `image` content blocks in the tool result the CLI hands
 * back, and Batshit stores THAT object as an intermediate step — which becomes a
 * zip and then compiled history. Without this, a recalled photo delivered
 * in-turn would be base64 in the transcript forever, which is the exact cost
 * this story exists to remove.
 *
 * Deliberately narrow: only MCP `image` blocks in a `content` array, matched on
 * shape rather than on which server produced them. A `resource` block carrying
 * an image blob is not stripped, because nothing in Batshit emits one — widening
 * this on speculation would risk eating a legitimate result.
 */
export function stripMcpImageContentBlocks<T>(result: T, options?: { label?: string }): T {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const content = (result as any).content
  if (!Array.isArray(content)) return result

  const note = buildOmittedImageNote(options?.label ?? 'in-turn image')
  let changed = false
  const nextContent = content.map((block: any) => {
    if (
      !block ||
      typeof block !== 'object' ||
      block.type !== 'image' ||
      typeof block.data !== 'string'
    ) {
      return block
    }
    changed = true
    return { type: 'text', text: note }
  })

  if (!changed) return result
  return { ...(result as any), content: nextContent } as T
}

// ---------------------------------------------------------------- neutral payload vocabulary

/**
 * How a feature describes an image it handed the model, for `send-routed`'s
 * sanitized tool payload. Agent Browser used to own these words; the helper owns
 * them now and Agent Browser adapts, so removing Agent Browser cannot take the
 * vocabulary with it (AMD-105-14).
 */
export interface ToolResultImageDeliveryPayload {
  /** Whether the model could actually see the image during this run. */
  modelVisibleInLoop: boolean
  /** In-turn images are never kept in compiled history. */
  historyRetention: 'none'
  lane: ToolResultImageLane
  reason: string
}

export function buildToolResultImageDeliveryPayload(
  decision: ToolResultImageDeliveryDecision,
  options?: { modelVisibleInLoop?: boolean },
): ToolResultImageDeliveryPayload {
  return {
    modelVisibleInLoop:
      options?.modelVisibleInLoop ?? (decision.lane === 'tool_result' || decision.lane === 'synthetic_user'),
    historyRetention: 'none',
    lane: decision.lane,
    reason: decision.reason,
  }
}
