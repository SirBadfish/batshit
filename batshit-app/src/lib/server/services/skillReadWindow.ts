/**
 * Skill reads return a window of a file, and a partial window says so in plain words.
 *
 * Find 1 (bug batch 2026-09-22): a skill reference read is cut at `maxChars` (12,000 characters
 * by default). A cut read used to end in a bare `[truncated]`, with no sizes and no way to reach
 * the rest, so an agent silently built from the first part of a long reference. Now every read
 * takes an `offset` (where the window starts) beside `maxChars` (how long it is), and a read that
 * did not return the whole file carries its sizes and the exact next call.
 *
 * One rule for every lane that serves skill reads: the API `native_skill` tool, the managed CLI
 * helper's `native_skill` (`/api/skills/runtime`), the native-tools dispatch (n8n Workflow
 * Subagents), and the later-turn zip view of a kept-open reference.
 *
 * This module imports nothing on purpose: `nativeTools.test.ts` mocks the whole skill runtime
 * service, so a helper living there would disappear from that test's view of `nativeTools.ts`.
 */

export type SkillReadAction = 'read' | 'script_read'

export type SkillReadWindow = {
  content: string
  /** More of the file follows this window. */
  truncated: boolean
  originalChars: number
  /** Where the window starts, in characters from the start of the file. */
  offset: number
}

export function readSkillTextWindow(text: string, maxChars: number, offset = 0): SkillReadWindow {
  const start = Math.max(0, Math.floor(offset))
  let end = Math.min(text.length, start + maxChars)
  if (end > start && end < text.length &&
      /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1
  const content = text.slice(start, end)
  return {
    content,
    truncated: start + content.length < text.length,
    originalChars: text.length,
    offset: start
  }
}

export const SKILL_READ_OFFSET_SHAPE_ERROR = 'offset must be a whole number of characters, 0 or more.'

/** An absent offset reads from the start; a present one must be a whole number, 0 or more. */
export function normalizeSkillReadOffset(
  value: unknown
): { ok: true; offset: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, offset: 0 }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: SKILL_READ_OFFSET_SHAPE_ERROR }
  }
  return { ok: true, offset: value }
}

const count = (value: number) => value.toLocaleString('en-US')

/** The refusal for a window that starts at or after the end of the file, or null when it fits. */
export function skillReadOffsetPastEndError(offset: number, originalChars: number, path: string): string | null {
  if (offset > 0 && offset >= originalChars) {
    return `offset ${offset} is past the end of ${path}, which has ${count(originalChars)} characters.`
  }
  return null
}

/**
 * The fields a partial read adds to its result: where it started, where the next part starts
 * (while there is one), and one plain sentence with the sizes and the exact next call. A read
 * that returned the whole file from its start gets none, so its result is exactly what it was
 * before this rule.
 */
export function partialSkillReadFields(input: {
  skillId: string
  action: SkillReadAction
  path: string
  offset: number
  returnedChars: number
  originalChars: number
}): { offset?: number; nextOffset?: number; readMore?: string } {
  const end = input.offset + input.returnedChars
  const cut = end < input.originalChars
  if (!cut && input.offset === 0) return {}

  const shown = `Showing characters ${count(input.offset + 1)} to ${count(end)} of ${count(input.originalChars)}`
  if (!cut) return { offset: input.offset, readMore: `${shown}: the end of ${input.path}.` }
  return {
    offset: input.offset,
    nextOffset: end,
    readMore:
      `${shown}. To read on, call native_skill again with skillId "${input.skillId}", ` +
      `action "${input.action}", path "${input.path}", and offset ${end}.`
  }
}

/**
 * The line a partial read ends with in a text transcript: its sentence in brackets. A result
 * from before this rule has no sentence and keeps its old bare marker.
 */
export function skillReadNoteLine(output: Record<string, unknown>): string {
  if (typeof output.readMore === 'string' && output.readMore.trim()) return `[${output.readMore}]`
  return output.contentTruncated === true ? '[truncated]' : ''
}
