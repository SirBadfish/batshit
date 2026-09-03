import type { CacheForensicsSegment, CacheForensicsSegmentType } from '$lib/types/cacheForensics'
import type { CacheForensicsSegmentInput } from './fingerprint'

/**
 * SA-108: sub-segmentation for Batshit's single compiled user message.
 *
 * `buildFormattedChatInput` compiles the WHOLE conversation — previous
 * history, the current turn, and the DCM — into ONE user message, so the wire
 * body is `[system, user]` and nothing more. Fingerprinting that message as a
 * single segment made `firstDivergence: changed body.messages[1]:user`
 * architecturally guaranteed on every multi-turn send: the current turn lives
 * inside the same segment, so the record could not distinguish "a new turn was
 * appended" (normal) from "an already-written history message changed" (the
 * compile-stability defect), and `reusablePrefixBytes` stopped at the system
 * message.
 *
 * Splitting is driven ONLY by the literal markers `buildFormattedChatInput`
 * writes (DL-108-02). Content without those markers is never touched, so
 * non-Batshit provider shapes keep their existing single-segment fingerprints.
 *
 * DQ-D-028 (splitter v3): the same rules now reach Responses-shaped wire
 * bodies. xAI (`providers/index.ts` builds it with `createXai`, whose default
 * model is the RESPONSES model) and direct OpenAI in Responses mode send a
 * `body.input[]` item list whose text parts are typed `input_text`, not
 * `text` — so the v2 splitter never matched them and those lanes reported
 * `historyStability: not-applicable` with a `reusablePrefixBytes` frozen at
 * the system item. `COMPILED_TEXT_PART_TYPES` is the shared allow-list that
 * closes that gap.
 */

/** Written by `buildFormattedChatInput` ahead of the compiled chat history. */
export const COMPILED_HISTORY_MARKER = '==== PREVIOUS CONVERSATION ===='
/** Written by `buildFormattedChatInput` ahead of the current turn + DCM. */
export const COMPILED_CURRENT_MARKER = '==== CURRENT USER MESSAGE ===='
/** `compileChatHistory` joins formatted history messages with this separator. */
export const COMPILED_HISTORY_SEPARATOR = '\n\n---\n\n'
/** `buildZipAppend` opens the agent-managed appended-zip block with this line. */
export const COMPILED_ZIP_APPEND_MARKER = '==== UNZIP INDEX (chronological) ===='

/**
 * Oldest-first cap on per-message history sub-segments (DL-108-04). The prefix
 * is what matters for cache analysis, so the OLDEST messages stay individually
 * addressable and any remainder folds into one trailing segment. This keeps a
 * single long conversation from consuming the global
 * CACHE_FORENSICS_MAX_SEGMENTS budget on its own.
 */
export const COMPILED_HISTORY_SEGMENT_CAP = 256

/**
 * DQ-D-028: the content-part `type` values a Batshit-compiled message can
 * arrive under. Chat-shaped bodies (Anthropic, OpenAI chat mode, every
 * `@ai-sdk/openai-compatible` lane) use `text`; Responses-shaped bodies (xAI,
 * direct OpenAI in Responses mode) use `input_text`.
 *
 * This stays a code-owned ALLOW-LIST rather than a "has a `.text` string"
 * heuristic, for the same reason as DL-108-02: a heuristic could silently
 * change the fingerprints of a provider shape Batshit does not emit.
 */
export const COMPILED_TEXT_PART_TYPES: readonly string[] = ['text', 'input_text']

/**
 * Returns a content part's text when the part is one of the recognised text
 * shapes, and null otherwise (including a recognised type whose `text` is not
 * a string — that part keeps its own segment, exactly as before).
 */
export function compiledTextPartValue(part: unknown): string | null {
  if (!part || typeof part !== 'object') return null
  const record = part as Record<string, unknown>
  if (typeof record.type !== 'string') return null
  if (!COMPILED_TEXT_PART_TYPES.includes(record.type)) return null
  return typeof record.text === 'string' ? record.text : null
}

/** Label suffix that marks a per-message compiled-history sub-segment. */
const HISTORY_LABEL_MARKER = '#history['

export interface CompiledUserMessageSplit {
  /** False when the text carries none of Batshit's compile markers. */
  matched: boolean
  /** One entry per compiled history message, oldest first. */
  historyMessages: string[]
  /** The appended agent-managed zip block, when the layout is `appended`. */
  zipAppend: string | null
  /** Current turn + DCM (+ any clipped-item text), from its marker to the end. */
  current: string | null
}

/**
 * Splits one compiled user message into its Batshit-owned parts.
 *
 * The trailing whitespace handling mirrors the compiler: `compileChatHistory`
 * trims the joined history, so the last history chunk is trimmed here too and
 * a message therefore hashes identically whether it is currently last or has
 * been followed by newer turns.
 */
export function splitCompiledUserMessageContent(text: unknown): CompiledUserMessageSplit {
  const empty: CompiledUserMessageSplit = {
    matched: false,
    historyMessages: [],
    zipAppend: null,
    current: null,
  }
  if (typeof text !== 'string' || text.length === 0) return empty

  const currentIndex = text.indexOf(COMPILED_CURRENT_MARKER)
  const hasHistoryHeader = text.startsWith(COMPILED_HISTORY_MARKER)
  if (currentIndex === -1 && !hasHistoryHeader) return empty

  const current = currentIndex === -1 ? null : text.slice(currentIndex)
  let head = currentIndex === -1 ? text : text.slice(0, currentIndex)

  if (head.startsWith(COMPILED_HISTORY_MARKER)) {
    head = head.slice(COMPILED_HISTORY_MARKER.length).replace(/^\n+/, '')
  }

  let zipAppend: string | null = null
  const zipIndex = head.indexOf(COMPILED_ZIP_APPEND_MARKER)
  if (zipIndex !== -1) {
    zipAppend = head.slice(zipIndex).trimEnd()
    head = head.slice(0, zipIndex)
  }

  const historyText = head.trimEnd()
  const historyMessages =
    historyText.length > 0 ? historyText.split(COMPILED_HISTORY_SEPARATOR) : []

  return { matched: true, historyMessages, zipAppend, current }
}

/**
 * Builds the ordered sub-segment inputs for one compiled user message.
 * Returns null when the content is not a Batshit-compiled message, so callers
 * fall back to their existing single-segment behavior.
 */
export function segmentCompiledUserMessage(
  text: unknown,
  baseLabel: string,
): CacheForensicsSegmentInput[] | null {
  const split = splitCompiledUserMessageContent(text)
  if (!split.matched) return null

  const segments: CacheForensicsSegmentInput[] = []
  const { historyMessages } = split

  const individual = Math.min(historyMessages.length, COMPILED_HISTORY_SEGMENT_CAP)
  for (let i = 0; i < individual; i += 1) {
    segments.push({
      type: 'history-message',
      label: `${baseLabel}${HISTORY_LABEL_MARKER}${i}]`,
      content: historyMessages[i],
    })
  }
  if (historyMessages.length > individual) {
    segments.push({
      type: 'history-message',
      label: `${baseLabel}${HISTORY_LABEL_MARKER}tail]`,
      content: historyMessages.slice(individual).join(COMPILED_HISTORY_SEPARATOR),
    })
  }

  if (split.zipAppend !== null) {
    segments.push({
      type: 'history-message',
      label: `${baseLabel}#zips`,
      content: split.zipAppend,
    })
  }

  if (split.current !== null) {
    segments.push({
      type: 'current-user-turn',
      label: `${baseLabel}#current`,
      content: split.current,
    })
  }

  return segments
}

/**
 * True for a per-message compiled-history sub-segment. Both the type and the
 * label suffix are code-owned, so this stays the single rule that
 * `analyzeHistoryStability` and the adapters share.
 */
export function isCompiledHistorySegment(
  segment: Pick<CacheForensicsSegment, 'type' | 'label'>,
): boolean {
  return (
    (segment.type as CacheForensicsSegmentType) === 'history-message' &&
    segment.label.includes(HISTORY_LABEL_MARKER)
  )
}
