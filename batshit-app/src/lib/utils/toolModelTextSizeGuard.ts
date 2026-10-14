import { TOOL_RESULT_TOO_LARGE_TOKENS } from './toolResultSizeGuard'

/**
 * The model-facing result, including its cut notice, stays within this many UTF-16 characters
 * (BL-677). It is 24,000 tokens by the `ceil(chars / 4)` estimate, below the 25,000-token guard,
 * so a first part with no line end is never itself too large: the compile's wrapper around a
 * saved cut view still fits, a second pass through a guard never cuts it again, and a cut result
 * always comes back shorter than it went in.
 */
export const TOOL_MODEL_TEXT_MAX_CHARS = 96_000
/** A cut result's server-owned raw zip keeps at most this many UTF-16 characters. */
export const TOOL_MODEL_RAW_MAX_CHARS = 8_000_000

export type ToolModelTextRemainder =
  | { kind: 'fetchable'; zipId: string }
  | { kind: 'unavailable' }
  /** BL-680: kept, but this run cannot fetch it (a delegated run in a group chat). */
  | { kind: 'group-unreadable' }
  | { kind: 'not-retained' }
  | { kind: 'memory' }

/** A server-derived effective model-facing byte ceiling, independent of token policy. */
export type ToolModelTextBudget = {
  maxUtf8Bytes?: number
  source?: string
}

export type ToolModelTextCutPlan = {
  cut: boolean
  totalChars: number
  estimatedTokens: number
  rawText: string
  rawDroppedChars: number
}

export type FormattedToolModelTextCut = ToolModelTextCutPlan & {
  text: string
  keptChars: number
  nextOffset: number | null
}

function safeSliceEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? end - 1
    : end
}

const encoder = new TextEncoder()

function byteLimit(budget?: ToolModelTextBudget): number | undefined {
  const limit = budget?.maxUtf8Bytes
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('The model-facing byte budget must be a non-negative safe integer.')
  }
  return limit
}

function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

/** Plan from the exact text the model would receive, never a renderer/storage JSON size. */
export function planToolModelTextCut(
  text: string,
  originalTextChars?: number,
  budget?: ToolModelTextBudget
): ToolModelTextCutPlan {
  if (originalTextChars !== undefined &&
      (!Number.isSafeInteger(originalTextChars) || originalTextChars < text.length)) {
    throw new Error('Original tool text length must be an integer at least as long as the delivered text.')
  }
  const totalChars = originalTextChars ?? text.length
  const estimatedTokens = Math.ceil(totalChars / 4)
  const maxUtf8Bytes = byteLimit(budget)
  const cut = estimatedTokens >= TOOL_RESULT_TOO_LARGE_TOKENS ||
    (maxUtf8Bytes !== undefined && utf8Bytes(text) > maxUtf8Bytes)
  if (!cut) {
    return { cut, totalChars, estimatedTokens, rawText: text, rawDroppedChars: 0 }
  }

  const rawEnd = safeSliceEnd(text, Math.min(text.length, TOOL_MODEL_RAW_MAX_CHARS))
  return {
    cut,
    totalChars,
    estimatedTokens,
    rawText: text.slice(0, rawEnd),
    rawDroppedChars: totalChars - rawEnd
  }
}

function firstPartEnd(text: string, maxChars: number): number {
  const safeEnd = safeSliceEnd(text, Math.min(text.length, maxChars))
  const lastLineEnd = text.lastIndexOf('\n', safeEnd - 1) + 1
  // Keep a partial long line when taking only whole lines would discard most of the budget.
  return lastLineEnd > 0 && safeEnd - lastLineEnd <= maxChars / 4 ? lastLineEnd : safeEnd
}

function safeBudgetSource(source: string | undefined): string {
  const clean = source?.trim()
  return clean && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(clean) ? clean : 'model lane'
}

const CUT_NOTICE_START = '[Output cut here by Batshit: this result is about '
// The fixed "how to read the rest" sentences. The notice and its reader share them (BL-678).
const REST_UNAVAILABLE = 'The rest cannot be read in this run, because this agent has no Fetch Zip. Run the tool again for a smaller part.'
const REST_MEMORY = 'Search again with a narrower query or a smaller limit, or recall one memory by its id.'
const REST_NOT_RETAINED = 'The rest was not kept because this reply reached its retained-copy limit. Run the tool again for a smaller part.'
const REST_GROUP_UNREADABLE = 'The rest cannot be read in this run, because in a group chat only the member\'s own reply can fetch its kept copy. Run the tool again for a smaller part.'

function cutNotice(
  plan: ToolModelTextCutPlan,
  remainder: ToolModelTextRemainder,
  keptChars: number,
  laneBudget?: ToolModelTextBudget
): string {
  const dropped = remainder.kind !== 'not-retained' && remainder.kind !== 'memory' && plan.rawDroppedChars > 0
    ? ` The raw copy keeps its first ${plan.rawText.length.toLocaleString('en-US')} characters; ${plan.rawDroppedChars.toLocaleString('en-US')} later characters were dropped.`
    : ''
  const maxUtf8Bytes = laneBudget?.maxUtf8Bytes
  const laneLimit = maxUtf8Bytes !== undefined
    ? ` The ${safeBudgetSource(laneBudget?.source)} model-facing result budget is ${maxUtf8Bytes.toLocaleString('en-US')} UTF-8 bytes.`
    : ''
  const next = remainder.kind === 'fetchable'
    ? `Call Fetch Zip with zipId ${remainder.zipId} and offset ${keptChars} to read the rest.`
    : remainder.kind === 'unavailable'
      ? REST_UNAVAILABLE
      : remainder.kind === 'group-unreadable'
        ? REST_GROUP_UNREADABLE
      : remainder.kind === 'memory'
        ? REST_MEMORY
      : REST_NOT_RETAINED
  return `${CUT_NOTICE_START}${plan.estimatedTokens.toLocaleString('en-US')} tokens (${plan.totalChars.toLocaleString('en-US')} characters). One result can be ${TOOL_RESULT_TOO_LARGE_TOKENS.toLocaleString('en-US')} tokens at most. You have the first ${keptChars.toLocaleString('en-US')} characters.${laneLimit} ${next}${dropped}]`
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const COUNT = '\\d{1,3}(?:,\\d{3})*'
/** Exactly the notice `cutNotice` writes, from its first character to the text's end. */
const CUT_NOTICE_EXACT = new RegExp(
  `^${escapeRegExp(CUT_NOTICE_START)}${COUNT} tokens \\(${COUNT} characters\\)\\. ` +
  `One result can be ${escapeRegExp(TOOL_RESULT_TOO_LARGE_TOKENS.toLocaleString('en-US'))} tokens at most\\. ` +
  `You have the first ${COUNT} characters\\.` +
  `(?: The [A-Za-z0-9][A-Za-z0-9 ._-]{0,63} model-facing result budget is ${COUNT} UTF-8 bytes\\.)? ` +
  `(?:Call Fetch Zip with zipId [^\\r\\n\\]]{1,256} and offset \\d+ to read the rest\\.|` +
  [REST_UNAVAILABLE, REST_GROUP_UNREADABLE, REST_MEMORY, REST_NOT_RETAINED].map(escapeRegExp).join('|') + ')' +
  `(?: The raw copy keeps its first ${COUNT} characters; ${COUNT} later characters were dropped\\.)?\\]$`
)

/**
 * BL-678: whether a text ends with the guard's exact notice, alone or after a line end. The words
 * of the notice anywhere else (a tool that printed them, a read of Batshit's own source) are
 * ordinary text. Display and dead-copy use only: never parse an id from the notice or trust it
 * as a reference.
 */
export function endsWithToolModelCutNotice(text: string): boolean {
  const start = text.lastIndexOf(CUT_NOTICE_START)
  if (start < 0 || (start > 0 && text[start - 1] !== '\n')) return false
  return CUT_NOTICE_EXACT.test(text.slice(start))
}

/**
 * The longest cut view ever saved: the P2 guard (3ac8f5517, before BL-677) cut to 100,000
 * characters. Only an already-saved `modelTextOnly` card may be this long; new text uses
 * `TOOL_MODEL_TEXT_MAX_CHARS`.
 */
export const SAVED_TOOL_MODEL_CUT_VIEW_MAX_CHARS = 100_000

/** BL-678: a size guard's cut view: within `maxChars`, ending in the guard's exact notice. */
export function isToolModelCutView(text: string, maxChars: number = TOOL_MODEL_TEXT_MAX_CHARS): boolean {
  return text.length <= maxChars && endsWithToolModelCutNotice(text)
}

function shortCutRefusal(maxUtf8Bytes: number): string {
  const notices = [
    '[Output cut: the model-facing byte limit cannot hold the full notice.]',
    '[Output cut]',
    'CUT',
    '!'
  ]
  return notices.find((notice) => notice.length <= maxUtf8Bytes) ?? ''
}

function formatWithByteBudget(
  plan: ToolModelTextCutPlan,
  remainder: ToolModelTextRemainder,
  budget: ToolModelTextBudget,
  maxUtf8Bytes: number,
  byteLimited: boolean
): FormattedToolModelTextCut {
  const noticeFor = (keptChars: number) => cutNotice(plan, remainder, keptChars, byteLimited ? budget : undefined)
  const render = (keptChars: number) => {
    const prefix = plan.rawText.slice(0, keptChars)
    return `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}${noticeFor(keptChars)}`
  }
  const fits = (keptChars: number) => {
    const finalText = render(keptChars)
    return finalText.length <= TOOL_MODEL_TEXT_MAX_CHARS && utf8Bytes(finalText) <= maxUtf8Bytes
  }

  if (!fits(0)) {
    return { ...plan, text: shortCutRefusal(maxUtf8Bytes), keptChars: 0, nextOffset: null }
  }

  // Search UTF-16 offsets, but measure the final encoded text and its changing notice.
  let low = 0
  let high = Math.min(plan.rawText.length, TOOL_MODEL_TEXT_MAX_CHARS)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(safeSliceEnd(plan.rawText, middle))) low = middle
    else high = middle - 1
  }
  let keptChars = safeSliceEnd(plan.rawText, low)
  const wholeLineEnd = firstPartEnd(plan.rawText, keptChars)
  if (wholeLineEnd < keptChars && fits(wholeLineEnd)) keptChars = wholeLineEnd
  const result = render(keptChars)
  if (result.length > TOOL_MODEL_TEXT_MAX_CHARS || utf8Bytes(result) > maxUtf8Bytes) {
    throw new Error('The tool-result cut exceeded its model budget.')
  }
  return {
    ...plan,
    text: result,
    keptChars,
    nextOffset: remainder.kind === 'fetchable' ? keptChars : null
  }
}

/** Format one bounded, visible cut after the named raw zip has been saved by the server. */
export function formatToolModelTextCut(
  text: string,
  target: string | ToolModelTextRemainder,
  originalTextChars?: number,
  budget?: ToolModelTextBudget
): FormattedToolModelTextCut {
  const plan = planToolModelTextCut(text, originalTextChars, budget)
  if (!plan.cut) return { ...plan, text, keptChars: text.length, nextOffset: null }
  if (byteLimit(budget) === 0) return { ...plan, text: '', keptChars: 0, nextOffset: null }
  const remainder = typeof target === 'string' ? { kind: 'fetchable' as const, zipId: target } : target
  if (remainder.kind === 'fetchable' && (!remainder.zipId || remainder.zipId.length > 256 || /[\r\n\]]/.test(remainder.zipId))) {
    throw new Error('A cut tool result needs a valid server-owned zip id.')
  }

  const maxUtf8Bytes = byteLimit(budget)
  if (maxUtf8Bytes !== undefined) {
    return formatWithByteBudget(plan, remainder, budget!, maxUtf8Bytes, utf8Bytes(text) > maxUtf8Bytes)
  }

  // The notice contains the kept-character count, so reserve its actual length and converge.
  // A generous initial reserve avoids transiently examining beyond the final budget.
  let keptChars = firstPartEnd(plan.rawText, TOOL_MODEL_TEXT_MAX_CHARS - 512)
  let notice = cutNotice(plan, remainder, keptChars)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const budget = TOOL_MODEL_TEXT_MAX_CHARS - notice.length - 1
    if (budget < 1) throw new Error('The tool-result cut notice exceeds its model budget.')
    const nextKept = firstPartEnd(plan.rawText, budget)
    if (nextKept === keptChars) break
    keptChars = nextKept
    notice = cutNotice(plan, remainder, keptChars)
  }

  // Recheck after the count's decimal width changes at a boundary.
  while (keptChars + 1 + notice.length > TOOL_MODEL_TEXT_MAX_CHARS) {
    keptChars = firstPartEnd(plan.rawText, keptChars - 1)
    notice = cutNotice(plan, remainder, keptChars)
  }
  const prefix = plan.rawText.slice(0, keptChars)
  const separator = prefix.endsWith('\n') ? '' : '\n'
  const result = `${prefix}${separator}${notice}`
  if (result.length > TOOL_MODEL_TEXT_MAX_CHARS) {
    throw new Error('The tool-result cut exceeded its model budget.')
  }
  return {
    ...plan,
    text: result,
    keptChars,
    nextOffset: remainder.kind === 'fetchable' ? keptChars : null
  }
}
