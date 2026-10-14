import type { CacheForensicsSegment, CacheForensicsSegmentType } from '$lib/types/cacheForensics'
import { COMPILED_MESSAGE_TAGS, COMPILED_TAG } from '$lib/utils/compiledChatTags'
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

/**
 * SA-128 (splitter v4): the compiled message is tags now (`$lib/utils/compiledChatTags`). The
 * history is `<conversation>` holding one element per message, the appended zips are one
 * `<zip_index>` element after it, and the new message (`<user>` or `<note>`) plus
 * `<dynamic_info>` and the live media follow. The compiler disarms every tag of that grammar
 * inside content, so a real tag can only be the compiler's own: the split below is exact.
 */
/** Opens the compiled chat history. */
export const COMPILED_HISTORY_OPEN = `<${COMPILED_TAG.conversation}>\n`
/** Closes the compiled chat history. */
export const COMPILED_HISTORY_CLOSE = `\n</${COMPILED_TAG.conversation}>`
/** `compileChatHistory` puts one blank line between history elements. */
export const COMPILED_HISTORY_SEPARATOR = '\n\n'
/** `buildZipAppend` writes the agent-managed appended zips as this element. */
export const COMPILED_ZIP_APPEND_OPEN = `<${COMPILED_TAG.zipIndex}>\n`
export const COMPILED_ZIP_APPEND_CLOSE = `\n</${COMPILED_TAG.zipIndex}>`
/** The standing media manifest, the first text part when an Awareness image is standing. */
export const COMPILED_STANDING_MEDIA_OPEN = `<${COMPILED_TAG.awarenessMedia}>\n`

// The new message opens with one of these (the user's own, or Batshit's note).
const CURRENT_MESSAGE_START = new RegExp(`^<(?:${COMPILED_TAG.user}|${COMPILED_TAG.note})(?: [^>\\n]*)?>\\n`)

/** Each history element, in order. A fresh expression per call (`/g` keeps `lastIndex`). */
function historyElementPattern(): RegExp {
  const names = COMPILED_MESSAGE_TAGS.join('|')
  return new RegExp(`<(${names})(?: [^>\\n]*)?>\\n[\\s\\S]*?\\n</\\1>`, 'g')
}

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
 * The history elements inside `<conversation>`, oldest first. Each element is hashed exactly as
 * the compiler wrote it, so a message hashes identically whether it is currently last or has
 * been followed by newer turns. A body that is not a clean run of elements (never written by
 * the compiler) stays one segment rather than being guessed at.
 */
function splitHistoryElements(body: string): string[] {
  const elements: string[] = []
  let cursor = 0
  for (const match of body.matchAll(historyElementPattern())) {
    const gap = body.slice(cursor, match.index)
    if (gap !== (elements.length === 0 ? '' : COMPILED_HISTORY_SEPARATOR)) return [body]
    elements.push(match[0])
    cursor = (match.index ?? 0) + match[0].length
  }
  if (cursor !== body.length) return [body]
  return elements
}

/** Splits one compiled user message into its Batshit-owned parts. */
export function splitCompiledUserMessageContent(text: unknown): CompiledUserMessageSplit {
  const empty: CompiledUserMessageSplit = {
    matched: false,
    historyMessages: [],
    zipAppend: null,
    current: null,
  }
  if (typeof text !== 'string' || text.length === 0) return empty

  const hasHistory = text.startsWith(COMPILED_HISTORY_OPEN)
  const opensWithZips = text.startsWith(COMPILED_ZIP_APPEND_OPEN)
  if (!hasHistory && !opensWithZips && !CURRENT_MESSAGE_START.test(text)) return empty

  let rest = text
  let historyMessages: string[] = []
  if (hasHistory) {
    const close = rest.indexOf(COMPILED_HISTORY_CLOSE)
    if (close === -1) return empty
    historyMessages = splitHistoryElements(rest.slice(COMPILED_HISTORY_OPEN.length, close))
    rest = rest.slice(close + COMPILED_HISTORY_CLOSE.length).replace(/^\n+/, '')
  }

  let zipAppend: string | null = null
  if (rest.startsWith(COMPILED_ZIP_APPEND_OPEN)) {
    const close = rest.indexOf(COMPILED_ZIP_APPEND_CLOSE)
    if (close === -1) return empty
    zipAppend = rest.slice(0, close + COMPILED_ZIP_APPEND_CLOSE.length)
    rest = rest.slice(zipAppend.length).replace(/^\n+/, '')
  }

  const current = rest.length > 0 ? rest : null
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
