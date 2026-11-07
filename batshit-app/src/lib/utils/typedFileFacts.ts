/**
 * SA-136: the frozen result blocks of the API lane's typed file tools (`typedFileTools.ts`), and
 * the one reader every shaper, transcript and ledger uses for them. A block is kept only as its
 * version defines it: unknown fields are dropped, a wrong type drops the block.
 *
 * - `typedFileRead` v1: what one `read_file` showed: the lines (1-based), the file's total, whether
 *   that is the whole file, whether the 90,000-character cap cut it, and the file's bytes.
 * - `typedFileWrite` / `typedFileEdit` v1: the effect of a `write_file` / `edit_file`: `applied`
 *   (renamed over the target), `unapplied` (nothing written) or `unknown` (the call never returned
 *   after it reported `committing`, just before its rename).
 */

export type TypedFileOutcome = 'applied' | 'unapplied' | 'unknown'
export type TypedFileLineEnding = 'lf' | 'crlf' | 'mixed' | 'none'

export interface TypedFileReadFacts {
  v: 1
  /** First line shown (1-based); 0 for an empty file. */
  startLine: number
  /** Last line shown; `startLine - 1` when no line is shown (a range past the end). */
  endLine: number
  totalLines: number
  /** Every line of the file was shown, and none was cut. */
  whole: boolean
  /** The 90,000-character cap stopped the text before the range asked for (or within its one line). */
  truncated: boolean
  empty: boolean
  bytes: number
  lineEnding: TypedFileLineEnding
}

export interface TypedFileChangeFacts {
  v: 1
  outcome: TypedFileOutcome
  /** Only on the report made just before the rename, which a stopped reply may keep. */
  stage?: 'committing'
  created?: boolean
  totalLines?: number
  bytes?: number
  editsApplied?: number
  lineEnding?: TypedFileLineEnding
  /** Other names the file had; they keep the old text. */
  otherHardLinks?: number
}

const OUTCOMES = new Set<TypedFileOutcome>(['applied', 'unapplied', 'unknown'])
const LINE_ENDINGS = new Set<TypedFileLineEnding>(['lf', 'crlf', 'mixed', 'none'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** A valid `typedFileRead` v1 block, copied field by field; null for anything else. */
export function readTypedFileReadFacts(value: unknown): TypedFileReadFacts | null {
  const block = record(value)
  if (!block || block.v !== 1) return null
  const { startLine, endLine, totalLines, whole, truncated, empty, bytes, lineEnding } = block
  if (!count(startLine) || !count(totalLines) || !count(bytes)) return null
  if (typeof endLine !== 'number' || !Number.isSafeInteger(endLine) || endLine < startLine - 1 || endLine > totalLines) return null
  if (typeof whole !== 'boolean' || typeof truncated !== 'boolean' || typeof empty !== 'boolean') return null
  if (typeof lineEnding !== 'string' || !LINE_ENDINGS.has(lineEnding as TypedFileLineEnding)) return null
  // A whole read shows every line uncut; a block that says otherwise is not one Batshit wrote.
  if (whole && (truncated || (!empty && (startLine !== 1 || endLine !== totalLines)))) return null
  return { v: 1, startLine, endLine, totalLines, whole, truncated, empty, bytes, lineEnding: lineEnding as TypedFileLineEnding }
}

/** A valid `typedFileWrite` / `typedFileEdit` v1 block, copied field by field; null for anything else. */
export function readTypedFileChangeFacts(value: unknown): TypedFileChangeFacts | null {
  const block = record(value)
  if (!block || block.v !== 1 || typeof block.outcome !== 'string' || !OUTCOMES.has(block.outcome as TypedFileOutcome)) return null
  const facts: TypedFileChangeFacts = { v: 1, outcome: block.outcome as TypedFileOutcome }
  if (block.stage === 'committing') facts.stage = 'committing'
  if (typeof block.created === 'boolean') facts.created = block.created
  if (count(block.totalLines)) facts.totalLines = block.totalLines
  if (count(block.bytes)) facts.bytes = block.bytes
  if (count(block.editsApplied)) facts.editsApplied = block.editsApplied
  if (typeof block.lineEnding === 'string' && LINE_ENDINGS.has(block.lineEnding as TypedFileLineEnding)) {
    facts.lineEnding = block.lineEnding as TypedFileLineEnding
  }
  if (count(block.otherHardLinks) && block.otherHardLinks > 0) facts.otherHardLinks = block.otherHardLinks
  return facts
}

/** The typed blocks a stored result carries, as the shapers keep them (none for any other result). */
export function typedFileFactsFields(result: unknown): Record<string, unknown> {
  const source = record(result)
  if (!source) return {}
  const read = readTypedFileReadFacts(source.typedFileRead)
  const write = readTypedFileChangeFacts(source.typedFileWrite)
  const edit = readTypedFileChangeFacts(source.typedFileEdit)
  return {
    ...(read ? { typedFileRead: read } : {}),
    ...(read && source.partialLine === true ? { partialLine: true } : {}),
    ...(write ? { typedFileWrite: write } : {}),
    ...(edit ? { typedFileEdit: edit } : {})
  }
}

/** A typed write's or edit's outcome, or null for any other result. */
export function typedFileChangeOutcome(result: unknown): TypedFileOutcome | null {
  const source = record(result)
  if (!source) return null
  return (readTypedFileChangeFacts(source.typedFileEdit) ?? readTypedFileChangeFacts(source.typedFileWrite))?.outcome ?? null
}

const lines = (value: number) => value.toLocaleString('en-US')

/** A typed read's range as cards and transcripts say it: `4–6 of 10`, `none of 10`, `empty file`. */
export function describeTypedReadRange(facts: TypedFileReadFacts): string {
  if (facts.empty) return 'empty file'
  if (facts.endLine < facts.startLine) return `none of ${lines(facts.totalLines)}`
  return `${lines(facts.startLine)}–${lines(facts.endLine)} of ${lines(facts.totalLines)}${facts.truncated ? ' (cut)' : ''}`
}

// ---------------------------------------------------------------------------------------------
// The read rule (versioned with `typedFileRead` v1; SA-137's `typed` view emulates a read with it)

/**
 * The most text one read returns, in whole lines. The API lane's in-turn guard cuts a tool result
 * at 96,000 characters (`TOOL_MODEL_TEXT_MAX_CHARS`); a read it cut would leave the model's next
 * `offset` past text it never saw (BL-676), so a read stops below it, header included.
 */
export const TYPED_READ_MAX_CHARS = 90_000

/** Where each line starts and ends (its line break included), as `countTextLines` counts them. */
function lineSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  const breaks = /\r\n|\r|\n/g
  let start = 0
  for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
    spans.push({ start, end: match.index + match[0].length })
    start = match.index + match[0].length
  }
  if (start < text.length) spans.push({ start, end: text.length })
  return spans
}

export interface TypedReadSlice {
  content: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  empty: boolean
  /** The one line shown is longer than the cap and only its start is shown. */
  partialLine: boolean
}

/** The lines a read shows: `offset` (1-based) and `limit`, in whole lines up to `maxChars`. */
export function sliceTypedRead(text: string, offset?: number, limit?: number, maxChars = TYPED_READ_MAX_CHARS): TypedReadSlice {
  const spans = lineSpans(text)
  const totalLines = spans.length
  if (totalLines === 0) {
    return { content: '', startLine: 0, endLine: 0, totalLines: 0, truncated: false, empty: true, partialLine: false }
  }
  const startLine = offset && offset > 0 ? offset : 1
  if (startLine > totalLines) {
    return { content: '', startLine, endLine: startLine - 1, totalLines, truncated: false, empty: false, partialLine: false }
  }
  const lastAsked = limit && limit > 0 ? Math.min(totalLines, startLine + limit - 1) : totalLines
  const first = spans[startLine - 1]
  if (first.end - first.start > maxChars) {
    return {
      content: text.slice(first.start, first.start + maxChars),
      startLine,
      endLine: startLine,
      totalLines,
      truncated: true,
      empty: false,
      partialLine: true
    }
  }
  let endLine = startLine
  while (endLine < lastAsked && spans[endLine].end - first.start <= maxChars) endLine += 1
  return {
    content: text.slice(first.start, spans[endLine - 1].end),
    startLine,
    endLine,
    totalLines,
    truncated: endLine < lastAsked,
    empty: false,
    partialLine: false
  }
}
