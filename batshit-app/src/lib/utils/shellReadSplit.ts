import { readSegmentsFromCommand, SED_RANGE_SCRIPT, type FileReadMode, type ShellReadSegment } from './zipDeadCopies'
import { sliceTypedRead } from './typedFileFacts'

/**
 * BL-1652: one shell command that read several files (`cat a b`, `cat a && sed -n 1,60p b`,
 * `cat a && ls && head -c 300 c`) used to be stored as ONE Read File zip labeled with one path,
 * its body every file's output. The label told the agent the wrong file, and a copy of several
 * files stays open until every file in it is dead (`findDeadCopies`), so an edit of one of them
 * retired nothing.
 *
 * This module proves, after the command ran, which part of its stdout each file is: it reads each
 * file again and works out, exactly, what the read printed (`cat`, `cat -n`, `nl -ba`,
 * `sed -n <range>p`, `head`, `tail`, a whole read piped to a range filter), and finds those texts
 * in stdout in order. The output of any other command (`ls`, `npm test`) is whatever lies between
 * them. Anything it cannot prove gives null, and the result is stored exactly as before: a command
 * outside the grammar, a read it cannot emulate, a file it cannot read, a file that changed after
 * the command, or a text that is not found where it must be, or is found twice after an unknown
 * output.
 *
 * Pure: the caller reads the files (`nativeTools.ts`, inside the workspace, with a size cap) and
 * hands their text in. The split itself is offsets into stdout; the zip adapter cuts the parts.
 */

export const SHELL_READ_SPLIT_VERSION = 1

/** One part of a split command's stdout: `[start, end)`. */
export type ShellReadSplitPart =
  | {
      kind: 'read'
      /** The path as the command wrote it (the zip label names it, as for a one-file read). */
      path: string
      mode: FileReadMode
      /** A command that reads this file alone, as the ledger reads it (`cd <dir> && cat a.js`). */
      command: string
      start: number
      end: number
    }
  | {
      kind: 'other'
      /** The commands whose output this is, joined by ` && ` (after the leading `cd`, if any). */
      command: string
      /** Only `echo`/`printf` separators printed it. */
      separatorsOnly: boolean
      start: number
      end: number
    }

export interface ShellReadSplit {
  version: typeof SHELL_READ_SPLIT_VERSION
  /** The whole command, as the model wrote it. */
  command: string
  parts: ShellReadSplitPart[]
}

/** What a command needs before its output can be split: its segments and the files they read. */
export interface ShellReadSplitPlan {
  command: string
  segments: ShellReadSegment[]
  /** The leading `cd` target, or null. */
  cdDir: string | null
  /** Every file a read segment names, as written, in order (repeats kept once). */
  files: string[]
}

const SAFE_WORD = /^[A-Za-z0-9_./,:=+@%^-]+$/

function quoteWord(word: string): string {
  if (word.length > 0 && SAFE_WORD.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

function renderWords(words: string[]): string {
  return words.map(quoteWord).join(' ')
}

function withCd(cdDir: string | null, text: string): string {
  return cdDir ? `cd ${quoteWord(cdDir)} && ${text}` : text
}

/**
 * The plan for a command whose output may be split, or null when it cannot be: outside the
 * grammar, or fewer than two parts to split into (one file read and nothing else, or no file read).
 */
export function planShellReadSplit(command: string): ShellReadSplitPlan | null {
  const segments = readSegmentsFromCommand(command)
  if (!segments) return null
  const cdDir = segments[0]?.kind === 'cd' ? segments[0].dir : null
  const reads = segments.filter((segment): segment is Extract<ShellReadSegment, { kind: 'read' }> => segment.kind === 'read')
  if (reads.length === 0) return null
  const readParts = reads.reduce((count, read) => count + (read.pipe ? 1 : read.files.length), 0)
  const hasOther = segments.some((segment) => segment.kind === 'other')
  if (readParts + (hasOther ? 1 : 0) < 2) return null
  const files: string[] = []
  for (const read of reads) for (const file of read.files) if (!files.includes(file)) files.push(file)
  return { command, segments, cdDir, files }
}

// ---------------------------------------------------------------------------------------------
// What a read printed

/** Lines with their own line ending; a last line without one is kept as it is. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * What a read printed when its file ends without a newline is taken as exactly the file's bytes
 * (BSD `sed` and `nl` print it so). A tool that adds the newline (GNU `nl`) leaves it in front of
 * the next part, where a read then fails to match and nothing is split; it is never guessed
 * (review: a guessed newline could take one that the next command printed).
 */
function exactly(text: string): string[] {
  return [text]
}

function numbered(content: string, nonBlankOnly: boolean): string {
  let number = 0
  return linesOf(content)
    .map((line) => {
      if (nonBlankOnly && line === '\n') return line
      number += 1
      return `${String(number).padStart(6)}\t${line}`
    })
    .join('')
}

const SED_RANGE = /^(\d+)(?:,(\d+|\$))?p$/

function sedPrint(content: string, script: string): string | null {
  const commands = script.replace(/;$/, '').split(';').map((part) => part.match(SED_RANGE))
  if (commands.some((match) => !match)) return null
  const lines = linesOf(content)
  const last = lines.length
  const out: string[] = []
  lines.forEach((line, index) => {
    const number = index + 1
    for (const match of commands as RegExpMatchArray[]) {
      const start = Number(match[1])
      const endRaw = match[2]
      const end = endRaw === undefined ? start : endRaw === '$' ? last : Number(endRaw)
      // `A,B` with B at or before A prints line A only.
      const inRange = endRaw === undefined || end <= start ? number === start : number >= start && number <= end
      if (inRange) out.push(line)
    }
  })
  return out.join('')
}

/** `head`/`tail` count options: lines (default 10) or bytes; null for anything else. */
function countOption(args: string[]): { unit: 'lines' | 'bytes'; count: number; operands: string[] } | null {
  let unit: 'lines' | 'bytes' = 'lines'
  let count = 10
  const operands: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    let match: RegExpMatchArray | null
    if ((arg === '-n' || arg === '-c') && /^\d+$/.test(args[index + 1] ?? '')) {
      unit = arg === '-n' ? 'lines' : 'bytes'
      count = Number(args[index + 1])
      index += 1
    } else if ((match = arg.match(/^-(\d+)$/))) {
      unit = 'lines'
      count = Number(match[1])
    } else if ((match = arg.match(/^-([nc])(\d+)$/))) {
      unit = match[1] === 'n' ? 'lines' : 'bytes'
      count = Number(match[2])
    } else if ((match = arg.match(/^--(lines|bytes)=(\d+)$/))) {
      unit = match[1] === 'lines' ? 'lines' : 'bytes'
      count = Number(match[2])
    } else if (arg.startsWith('-')) {
      return null
    } else {
      operands.push(arg)
    }
  }
  return { unit, count, operands }
}

function headTail(program: 'head' | 'tail', content: string, unit: 'lines' | 'bytes', count: number): string {
  if (unit === 'bytes') {
    const bytes = new TextEncoder().encode(content)
    const slice = program === 'head' ? bytes.subarray(0, count) : bytes.subarray(Math.max(0, bytes.length - count))
    return new TextDecoder().decode(slice)
  }
  const lines = linesOf(content)
  return (program === 'head' ? lines.slice(0, count) : lines.slice(Math.max(0, lines.length - count))).join('')
}

/** A range filter (`sed -n <range>p`, `head`, `tail`) applied to text, or null. */
function filterText(words: string[], content: string): string[] | null {
  const program = words[0].slice(words[0].lastIndexOf('/') + 1)
  const args = words.slice(1)
  if (program === 'sed') {
    if (args.length < 2 || args[0] !== '-n') return null
    const printed = sedPrint(content, args[1])
    return printed === null ? null : exactly(printed)
  }
  if (program === 'head' || program === 'tail') {
    const option = countOption(args)
    if (!option) return null
    return [headTail(program, content, option.unit, option.count)]
  }
  return null
}

/**
 * What one read segment printed, per file part, as candidate texts (the exact one first), or
 * null when the read is not one this module emulates.
 */
function expectedReadOutput(
  segment: Extract<ShellReadSegment, { kind: 'read' }>,
  contents: ReadonlyMap<string, string | null>
): Array<{ path: string; candidates: string[] }> | null {
  const text = (file: string): string | null => contents.get(file) ?? null
  const words = segment.words
  const program = words[0].slice(words[0].lastIndexOf('/') + 1)
  const args = words.slice(1)

  if (segment.pipe) {
    const content = text(segment.files[0])
    if (content === null || program !== 'cat' || args.some((arg) => arg.startsWith('-') && arg !== '-u')) return null
    const candidates = filterText(segment.pipe, content)
    return candidates ? [{ path: segment.files[0], candidates }] : null
  }

  if (program === 'cat') {
    const options = args.filter((arg) => arg.startsWith('-') && arg !== '--')
    const numbering = options.includes('-n') ? 'all' : options.includes('-b') ? 'nonblank' : null
    // Numbering across several files differs between cats (GNU counts on, BSD starts again).
    if (numbering && segment.files.length !== 1) return null
    const out: Array<{ path: string; candidates: string[] }> = []
    for (const file of segment.files) {
      const content = text(file)
      if (content === null) return null
      out.push({ path: file, candidates: [numbering ? numbered(content, numbering === 'nonblank') : content] })
    }
    return out
  }

  if (program === 'nl') {
    // Only `nl -ba` (every line numbered) is emulated; plain `nl` pads unnumbered lines.
    if (!(args[0] === '-ba' || (args[0] === '-b' && args[1] === 'a'))) return null
    const content = text(segment.files[0])
    if (content === null) return null
    return [{ path: segment.files[0], candidates: exactly(numbered(content, false)) }]
  }

  if (program === 'sed') {
    if (segment.files.length !== 1) return null
    const content = text(segment.files[0])
    if (content === null) return null
    const printed = sedPrint(content, args[1] ?? '')
    return printed === null ? null : [{ path: segment.files[0], candidates: exactly(printed) }]
  }

  if (program === 'head' || program === 'tail') {
    // Several files get `==> name <==` headers.
    if (segment.files.length !== 1) return null
    const option = countOption(args)
    const content = text(segment.files[0])
    if (!option || content === null) return null
    return [{ path: segment.files[0], candidates: [headTail(program, content, option.unit, option.count)] }]
  }

  return null
}

/** Where a `cat` command's file operands sit among its words (after any options and `--`). */
function catOperandIndexes(words: string[]): number[] {
  const indexes: number[] = []
  let optionsDone = false
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]
    if (!optionsDone && word === '--') {
      optionsDone = true
      continue
    }
    if (!optionsDone && word.startsWith('-')) continue
    indexes.push(index)
  }
  return indexes
}

// ---------------------------------------------------------------------------------------------
// Matching

/**
 * Splits `stdout` by a plan, given each planned file's text as read after the command (null when
 * it could not be read). Null unless every part is proven.
 */
export function matchShellReadSplit(
  plan: ShellReadSplitPlan,
  stdout: string,
  contents: ReadonlyMap<string, string | null>
): ShellReadSplit | null {
  if (typeof stdout !== 'string' || stdout.length === 0) return null
  const parts: ShellReadSplitPart[] = []
  let cursor = 0
  let pending: Array<Extract<ShellReadSegment, { kind: 'echo' | 'other' }>> = []

  const flushOther = (end: number) => {
    if (pending.length === 0) return
    const command = pending
      .map((segment) => (segment.kind === 'echo' ? renderWords(segment.words) : segment.pipeline.map(renderWords).join(' | ')))
      .join(' && ')
    parts.push({
      kind: 'other',
      command: withCd(plan.cdDir, command),
      separatorsOnly: pending.every((segment) => segment.kind === 'echo'),
      start: cursor,
      end
    })
    cursor = end
    pending = []
  }

  for (const segment of plan.segments) {
    if (segment.kind === 'cd') continue
    if (segment.kind === 'echo' || segment.kind === 'other') {
      pending.push(segment)
      continue
    }
    const expected = expectedReadOutput(segment, contents)
    if (!expected) return null
    for (const [at, { path, candidates }] of expected.entries()) {
      let start = -1
      let text = ''
      if (pending.length === 0) {
        const hit = candidates.find((candidate) => stdout.startsWith(candidate, cursor))
        if (hit === undefined) return null
        start = cursor
        text = hit
      } else {
        // After an unknown output the read is found by search, and only a single, non-empty match
        // is proof of where it starts.
        for (const candidate of candidates) {
          if (candidate.length === 0) continue
          const found = stdout.indexOf(candidate, cursor)
          if (found < 0) continue
          if (stdout.indexOf(candidate, found + 1) >= 0) return null
          if (start >= 0 && found !== start) return null
          if (start < 0 || candidate.length > text.length) {
            start = found
            text = candidate
          }
        }
        if (start < 0) return null
        flushOther(start)
      }
      // Each file of `cat a b` gets `cat a` and `cat b`: the operands are dropped by their place
      // (review: `cat -u cat dog` named the program as a file when dropped by value).
      const operandAt = catOperandIndexes(segment.words)
      const single =
        expected.length > 1
          ? segment.words.filter((_, index) => !operandAt.includes(index) || index === operandAt[at])
          : segment.words
      const rendered = segment.pipe
        ? `${renderWords(segment.words)} | ${renderWords(segment.pipe)}`
        : renderWords(single)
      parts.push({
        kind: 'read',
        path,
        mode: segment.mode,
        command: withCd(plan.cdDir, rendered),
        start,
        end: start + text.length
      })
      cursor = start + text.length
    }
  }
  if (pending.length > 0) flushOther(stdout.length)
  if (cursor !== stdout.length) return null

  const reads = parts.filter((part) => part.kind === 'read').length
  const informative = parts.some((part) => part.kind === 'other' && !part.separatorsOnly && part.end > part.start)
  if (reads + (informative ? 1 : 0) < 2) return null
  return { version: SHELL_READ_SPLIT_VERSION, command: plan.command, parts }
}

// ---------------------------------------------------------------------------------------------
// SA-137: the read forms a live file read may show again at a later turn start

/**
 * What one read showed of its one file, in a form that can be shown again from the file's text
 * (`emulateFileReadView`). Only the v1 forms (SA-137 D8): a whole `cat` (plain, `-n` or `-b`), a
 * `sed -n` numeric range script, and `head`/`tail` by a positive line count. `nl`, byte counts and
 * anything else have no view, so their copies stay as printed.
 */
export type FileReadView =
  | { kind: 'whole'; numbering: 'none' | 'all' | 'nonblank' }
  | { kind: 'lines'; script: string }
  | { kind: 'head' | 'tail'; lines: number }
  /**
   * SA-136: a typed `read_file`, by the range it ASKED for (1-based, inclusive; `endLine` null reads
   * to the end), shown again by the tool's own line rule (`sliceTypedRead`).
   */
  | { kind: 'typed'; startLine: number; endLine: number | null }

/** `head`/`tail` by a positive line count, with no operand left (a filter) or exactly one. */
function lineCountView(program: 'head' | 'tail', args: string[], operands: number): FileReadView | null {
  const option = countOption(args)
  if (!option || option.unit !== 'lines' || option.count < 1 || option.operands.length !== operands) return null
  return { kind: program, lines: option.count }
}

/** A range filter after `cat f |`, as a view; only a bare program name (never a path) counts. */
function filterView(words: string[]): FileReadView | null {
  const [program, ...args] = words
  if (program === 'sed') {
    return args.length === 2 && args[0] === '-n' && SED_RANGE_SCRIPT.test(args[1]) ? { kind: 'lines', script: args[1] } : null
  }
  if (program === 'head' || program === 'tail') return lineCountView(program, args, 0)
  return null
}

/**
 * The view of each file a read segment printed, in the order `matchShellReadSplit` makes its read
 * parts (one per file of a `cat`, else one), with null for a file whose form has no view. The
 * program must be named bare (`cat`, not `/bin/cat`): a path is never assumed to be that program.
 */
export function fileReadViewsOfSegment(
  segment: Extract<ShellReadSegment, { kind: 'read' }>
): Array<{ file: string; view: FileReadView | null }> {
  const [program, ...args] = segment.words
  const none = segment.files.map((file) => ({ file, view: null }))
  if (segment.pipe) {
    // The split's own rule for the left side: `cat` with no option but `-u`.
    if (program !== 'cat' || segment.files.length !== 1 || args.some((arg) => arg.startsWith('-') && arg !== '-u')) return none
    return [{ file: segment.files[0], view: filterView(segment.pipe) }]
  }
  if (program === 'cat') {
    // Plain, `-n` or `-b`: one flag at most (never both), and numbering only on one file.
    const options = args.filter((arg) => arg.startsWith('-'))
    if (options.length > 1 || (options.length === 1 && options[0] !== '-n' && options[0] !== '-b')) return none
    const numbering = options[0] === '-n' ? 'all' : options[0] === '-b' ? 'nonblank' : 'none'
    if (numbering !== 'none' && segment.files.length !== 1) return none
    return segment.files.map((file) => ({ file, view: { kind: 'whole', numbering } }))
  }
  if (segment.files.length !== 1) return none
  if (program === 'sed') {
    const view = args.length === 3 && args[0] === '-n' && SED_RANGE_SCRIPT.test(args[1])
      ? ({ kind: 'lines', script: args[1] } as const)
      : null
    return [{ file: segment.files[0], view }]
  }
  if (program === 'head' || program === 'tail') return [{ file: segment.files[0], view: lineCountView(program, args, 1) }]
  return none
}

/** `readSegmentsFromCommand`'s depth at which it no longer unwraps a shell wrapper. */
const SHELL_WRAPPER_NOT_UNWRAPPED = 2

/**
 * A command that is exactly one read of one file in a v1 form, after an optional leading `cd`:
 * nothing else runs, and a pipe stands only as a proven part of a split (SA-137 D8), never alone.
 * A read inside a shell wrapper (`bash -c '…'`, `zsh -lc '…'`) is not a v1 form: a login shell may
 * move first, so the command is read as written, unwrapped never.
 */
export function planSingleFileRead(command: string): { cdDir: string | null; file: string; view: FileReadView } | null {
  const segments = readSegmentsFromCommand(command, SHELL_WRAPPER_NOT_UNWRAPPED)
  if (!segments) return null
  const cdDir = segments[0]?.kind === 'cd' ? segments[0].dir : null
  const rest = cdDir === null ? segments : segments.slice(1)
  if (rest.length !== 1 || rest[0].kind !== 'read' || rest[0].pipe || rest[0].files.length !== 1) return null
  const [{ file, view }] = fileReadViewsOfSegment(rest[0])
  return view ? { cdDir, file, view } : null
}

/**
 * Whether a command reads at its top level, without unwrapping a shell wrapper: a split of a
 * wrapped command (BL-1652 unwraps one) is never a v1 live read (SA-137 D8).
 */
export function readsWithoutShellWrapper(command: string): boolean {
  return readSegmentsFromCommand(command, SHELL_WRAPPER_NOT_UNWRAPPED)?.some((segment) => segment.kind === 'read') === true
}

/**
 * Each read part of a split (in `matchShellReadSplit`'s order) with its view, or null for a part
 * whose form has none.
 */
export function readSplitViews(plan: ShellReadSplitPlan): Array<{ file: string; view: FileReadView | null }> {
  return plan.segments.flatMap((segment) => (segment.kind === 'read' ? fileReadViewsOfSegment(segment) : []))
}

/** What a read in `view` prints of `content` now (SA-137): the same emulation the split proves with. */
export function emulateFileReadView(view: FileReadView, content: string): string | null {
  if (view.kind === 'whole') return view.numbering === 'none' ? content : numbered(content, view.numbering === 'nonblank')
  if (view.kind === 'typed') {
    // A typed read shows nothing cut and nothing past the end: such a copy stays as it was read
    // (agreed with SA-137: a cut slice is never shown as live).
    const slice = sliceTypedRead(content, view.startLine, view.endLine === null ? undefined : view.endLine - view.startLine + 1)
    if (slice.truncated || slice.partialLine) return null
    if (!slice.empty && view.startLine > slice.totalLines) return null
    return slice.content
  }
  if (view.kind === 'lines') return sedPrint(content, view.script)
  return headTail(view.kind, content, 'lines', view.lines)
}

/**
 * A stored split checked against the stdout it describes: contiguous parts that cover it exactly,
 * each with the fields it needs. Anything else (an older or forged record, a stdout changed after
 * the split) is null, and the result is stored as one zip.
 */
export function validShellReadSplit(value: unknown, stdout: unknown): ShellReadSplit | null {
  if (!value || typeof value !== 'object' || typeof stdout !== 'string') return null
  const split = value as Partial<ShellReadSplit>
  if (split.version !== SHELL_READ_SPLIT_VERSION || typeof split.command !== 'string' || !Array.isArray(split.parts)) return null
  let cursor = 0
  let reads = 0
  for (const part of split.parts as any[]) {
    if (!part || typeof part !== 'object') return null
    if (!Number.isInteger(part.start) || !Number.isInteger(part.end) || part.start !== cursor || part.end < part.start) return null
    if (typeof part.command !== 'string' || part.command.length === 0) return null
    if (part.kind === 'read') {
      if (typeof part.path !== 'string' || part.path.length === 0 || (part.mode !== 'whole' && part.mode !== 'partial')) return null
      reads += 1
    } else if (part.kind === 'other') {
      if (typeof part.separatorsOnly !== 'boolean') return null
    } else {
      return null
    }
    cursor = part.end
  }
  if (cursor !== stdout.length || reads === 0) return null
  return split as ShellReadSplit
}
