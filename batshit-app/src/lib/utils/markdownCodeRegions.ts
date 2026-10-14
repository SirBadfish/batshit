/**
 * Where the code is in a chat text, as the chat's Markdown view draws it (BL-442; BL-475 builds
 * on it too).
 *
 * The chat draws Markdown with `marked` (`MarkdownRenderer.svelte`, with `CHAT_MARKDOWN_OPTIONS`
 * below). This module asks the same `marked` for the same text's blocks and returns where its code
 * is, as character ranges of the text it was given, in order and never overlapping:
 *
 * - `fenced`: a ``` or ~~~ block, its fences included. A fence that is never closed runs to the end
 *   of the text, as the view draws it (a streaming reply is often in that state).
 * - `indented`: a block of lines indented by four spaces or a tab, only where `marked` says it is
 *   code (a lazy continuation line of a paragraph is not).
 * - `inline`: a code span, its backticks included: a run of N backticks closed by the next run of
 *   exactly N (one or several), as `marked`'s code span rule reads it. A run with no closing run is
 *   not code, and a backslash before a run takes its first backtick out of it.
 *
 * An HTML block is not code: `marked` passes it through as HTML, so a tag written there is a tag.
 *
 * How: `marked`'s BLOCK lexer gives the blocks (paragraphs, headings, table cells, list items,
 * quotes, code blocks), and the code spans are found in each paragraph's, heading's, or cell's own
 * text by the rule above. `marked`'s inline lexer is not used: its time grows with the square of
 * the number of inline tokens in one paragraph (about 8 s for 50,000 tags in one paragraph,
 * measured), and the server reads every reply with this. Where the two could differ: a backtick
 * inside an inline HTML tag's attributes or a link's address, which `marked` never reads as a code
 * span; here it can open one.
 *
 * Pure, with no browser or Svelte imports, so the server's reply-end step reads the same regions
 * the page draws. Linear in the text's length.
 *
 * BL-701: the control-block scanner (`controlTags.ts`) pairs the code spans itself, with
 * `readCodeLayout` and `CodeSpanReader` below, in the same left-to-right pass as the blocks, so a
 * backtick inside a block it has read is payload: it never opens a span, and never pairs with a
 * backtick after the block. The code-span rule lives once, in `pushCodeSpanRuns`; `findCodeRegions`
 * pairs the same runs from each text's start.
 */

import { Lexer, getDefaults, type Token } from 'marked'

/** The options the chat's Markdown view parses with. `MarkdownRenderer.svelte` uses this object. */
export const CHAT_MARKDOWN_OPTIONS = Object.freeze({ breaks: true, gfm: true })

export type CodeRegionKind = 'fenced' | 'indented' | 'inline'

export interface CodeRegion {
  /** The first character of the code (its opening fence or backtick). */
  start: number
  /** One past its last character (its closing fence or backtick; the text's end for an open fence). */
  end: number
  kind: CodeRegionKind
}

const BACKTICK = 96
const BACKSLASH = 92

/**
 * A run of backticks in a paragraph's, heading's, or cell's text, as the code-span rule reads it
 * (BL-701): `findCodeRegions` pairs the runs from each text's start; the control-block scanner
 * pairs them with `CodeSpanReader`, passing over the runs inside the blocks it has read.
 */
export interface CodeSpanRun {
  /** Where a span this run opens starts: its first backtick, or its second when a backslash escapes the first. */
  start: number
  /** One past its last backtick. */
  end: number
  /** The run that closes a span this run opens (its index in the same list), or -1 when there is none. */
  close: number
}

/** A text's code before its code spans are paired (BL-701). */
export interface CodeLayout {
  /** Fenced and indented code, in order, as `findCodeRegions` returns them. */
  blocks: CodeRegion[]
  /** Every run of backticks in the text's paragraphs, headings, and cells, in order. */
  runs: CodeSpanRun[]
}

/**
 * The runs of backticks in `source[from, to)`, one paragraph's (or heading's, or cell's) text,
 * appended to `runs`. A run that opens a span is closed by the next run of exactly the same length
 * in the same text. A backslash before a run (an odd number of them) escapes its first backtick.
 */
function pushCodeSpanRuns(source: string, from: number, to: number, runs: CodeSpanRun[]): void {
  const first = runs.length
  const runsByLength = new Map<number, number[]>()
  for (let at = source.indexOf('`', from); at >= 0 && at < to; at = source.indexOf('`', at)) {
    let end = at
    while (end < to && source.charCodeAt(end) === BACKTICK) end += 1
    const sameLength = runsByLength.get(end - at)
    if (sameLength) sameLength.push(runs.length)
    else runsByLength.set(end - at, [runs.length])
    runs.push({ start: at, end, close: -1 })
    at = end
  }

  /** The first run after `run` with exactly `length` backticks, or -1. */
  const nextRunOfLength = (run: number, length: number): number => {
    const candidates = runsByLength.get(length)
    if (!candidates) return -1
    let low = 0
    let high = candidates.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (candidates[mid] <= run) low = mid + 1
      else high = mid
    }
    return low < candidates.length ? candidates[low] : -1
  }

  for (let run = first; run < runs.length; run += 1) {
    const entry = runs[run]
    let length = entry.end - entry.start
    let slashes = 0
    for (let at = entry.start - 1; at >= from && source.charCodeAt(at) === BACKSLASH; at -= 1) slashes += 1
    if (slashes % 2 === 1) {
      entry.start += 1
      length -= 1
    }
    entry.close = length > 0 ? nextRunOfLength(run, length) : -1
  }
}

/** The code spans of `runs`, paired from the first: each run not taken by an earlier span opens one. */
function pushPairedSpans(runs: readonly CodeSpanRun[], regions: CodeRegion[]): void {
  let run = 0
  while (run < runs.length) {
    const { start, close } = runs[run]
    if (close < 0) {
      run += 1
      continue
    }
    regions.push({ start, end: runs[close].end, kind: 'inline' })
    run = close + 1
  }
}

/** The code spans of `runs` (a `CodeLayout`'s), paired from each text's start: `findCodeRegions`'s inline regions. */
export function pairCodeSpans(runs: readonly CodeSpanRun[]): CodeRegion[] {
  const regions: CodeRegion[] = []
  pushPairedSpans(runs, regions)
  return regions
}

/**
 * Whether a position is in a code span, with `runs` (a `CodeLayout`'s) paired left to right as
 * `findCodeRegions` pairs them, lazily: the positions asked about never go back. A run that `skip`
 * names (by its `start`) never opens a span. The control-block scanner skips the runs inside the
 * blocks it has read, so a backtick in a payload never shifts a pairing after the block (BL-701),
 * however many such blocks come before. Each run is read once: linear.
 */
export class CodeSpanReader {
  private readonly runs: readonly CodeSpanRun[]
  private readonly skip: (start: number) => boolean
  private next = 0
  private spanStart = 0
  private spanEnd = 0

  constructor(runs: readonly CodeSpanRun[], skip: (start: number) => boolean) {
    this.runs = runs
    this.skip = skip
  }

  /** A reader at the same place, to read ahead without moving this one. */
  fork(): CodeSpanReader {
    const copy = new CodeSpanReader(this.runs, this.skip)
    copy.next = this.next
    copy.spanStart = this.spanStart
    copy.spanEnd = this.spanEnd
    return copy
  }

  /** Whether the character at `index` is in a code span. `index` is never less than at the last call. */
  covers(index: number): boolean {
    while (index >= this.spanEnd) {
      const run = this.runs[this.next]
      if (!run || run.start > index) return false
      this.next += 1
      if (run.close < 0 || this.skip(run.start)) continue
      this.spanStart = run.start
      this.spanEnd = this.runs[run.close].end
      this.next = run.close + 1
    }
    return index >= this.spanStart
  }
}

/**
 * A block inside a container (a list item, a quote) is lexed from the container's text with its
 * markers and indentation removed, so it is found again in the source line by line, near where the
 * walk is. `NEAR_SLACK` is how far past the walk a line may start (list and quote markers, blank
 * lines). A line not found that close is looked for up to the end of its top-level block, at most
 * `FAR_SEARCHES_PER_BLOCK` times per top-level block, so the cost stays linear.
 */
const NEAR_SLACK = 4096
const FAR_SEARCHES_PER_BLOCK = 64

/** Where the walk puts what it finds: fenced and indented code, and the texts code spans are read in. */
type CodeSink = {
  block(region: CodeRegion): void
  inline(from: number, to: number): void
}

type Walk = {
  source: string
  cursor: number
  /** The end of the top-level block being walked; nothing inside it lies past this. */
  limit: number
  farSearches: number
  sink: CodeSink
}

function searchWindow(walk: Walk, piece: string, windowEnd: number): number {
  if (windowEnd - walk.cursor < piece.length) return -1
  const index = walk.source.slice(walk.cursor, windowEnd).indexOf(piece)
  return index < 0 ? -1 : walk.cursor + index
}

function findPiece(walk: Walk, piece: string): number {
  if (walk.source.startsWith(piece, walk.cursor)) return walk.cursor
  const nearEnd = Math.min(walk.limit, walk.cursor + piece.length + NEAR_SLACK)
  const near = searchWindow(walk, piece, nearEnd)
  if (near >= 0 || nearEnd >= walk.limit || walk.farSearches >= FAR_SEARCHES_PER_BLOCK) return near
  walk.farSearches += 1
  return searchWindow(walk, piece, walk.limit)
}

/** The spellings a nested block's line may have in the source (see `findPiece`). */
function pieceVariants(piece: string): string[] {
  const variants = [piece]
  // A table cell's text has its escaped pipes unescaped.
  if (piece.includes('|')) variants.push(piece.replace(/\|/g, '\\|'))
  // Some list lines have their tabs widened to four spaces.
  if (piece.includes('    ')) variants.push(piece.replace(/ {4}/g, '\t'))
  return variants
}

/**
 * Finds a nested block's text in the source, line by line from the walk's cursor, and moves the
 * cursor past it. `complete` is false when a line was not found; the range then covers the lines
 * that were.
 */
function locate(walk: Walk, text: string): { start: number; end: number; complete: boolean } | null {
  let start = -1
  let end = -1
  for (const line of text.split('\n')) {
    const piece = line.trim()
    if (!piece) continue
    // The nearest spelling wins: a plain spelling may also occur later, inside another cell.
    let at = -1
    let length = piece.length
    for (const variant of pieceVariants(piece)) {
      const found = findPiece(walk, variant)
      if (found >= 0 && (at < 0 || found < at)) {
        at = found
        length = variant.length
      }
    }
    if (at < 0) return start < 0 ? null : { start, end, complete: false }
    if (start < 0) start = at
    end = at + length
    walk.cursor = end
  }
  return start < 0 ? null : { start, end, complete: true }
}

type BlockToken = Token & {
  text?: string
  tokens?: Token[]
  items?: Token[]
  header?: Array<{ text: string }>
  rows?: Array<Array<{ text: string }>>
  codeBlockStyle?: string
}

function codeKind(token: BlockToken): CodeRegionKind {
  return token.codeBlockStyle === 'indented' ? 'indented' : 'fenced'
}

function walkInlineText(walk: Walk, text: string | undefined): void {
  if (!text) return
  const found = locate(walk, text)
  if (found) walk.sink.inline(found.start, found.end)
}

function walkNestedBlock(walk: Walk, token: BlockToken): void {
  switch (token.type) {
    case 'code': {
      const found = locate(walk, token.raw)
      if (!found) return
      // A code block whose lines could not all be found is code up to its top-level block's end:
      // its tags stay text, which is the side the rule falls on (a tag in code does nothing).
      const end = found.complete ? found.end : walk.limit
      walk.sink.block({ start: found.start, end, kind: codeKind(token) })
      walk.cursor = end
      return
    }
    case 'paragraph':
    case 'heading':
    case 'text':
      walkInlineText(walk, token.text)
      return
    case 'table':
      for (const cell of token.header ?? []) walkInlineText(walk, cell.text)
      for (const row of token.rows ?? []) for (const cell of row) walkInlineText(walk, cell.text)
      return
    case 'list':
      for (const item of token.items ?? []) walkNestedBlock(walk, item as BlockToken)
      return
    case 'blockquote':
    case 'list_item':
      for (const child of token.tokens ?? []) walkNestedBlock(walk, child as BlockToken)
      return
    case 'space':
      return
    default:
      // An HTML block, a rule, a link definition: no code; step over it.
      locate(walk, token.raw)
  }
}

function walkNormalizedSource(source: string, sink: CodeSink): void {
  const lexer = new Lexer({ ...getDefaults(), ...CHAT_MARKDOWN_OPTIONS })
  let offset = 0
  for (const block of lexer.blockTokens(source, []) as BlockToken[]) {
    const start = offset
    const end = offset + block.raw.length
    offset = end
    if (block.type === 'code') {
      sink.block({ start, end, kind: codeKind(block) })
      continue
    }
    if (block.type === 'paragraph' && typeof block.text === 'string' && source.startsWith(block.text, start)) {
      // The common case, found exactly: a top-level paragraph's text is its raw text.
      sink.inline(start, start + block.text.length)
      continue
    }
    if (block.type === 'space' || block.type === 'html' || block.type === 'hr' || block.type === 'def') continue
    walkNestedBlock({ source, cursor: start, limit: end, farSearches: 0, sink }, block)
  }
}

/**
 * `marked` reads `\r\n` and `\r` as `\n` before it lexes. For a text that holds a `\r\n`, this
 * moves a normalized offset back to the text's own; null when there is nothing to move.
 */
function originalOffsets(text: string): ((position: number) => number) | null {
  const collapsed: number[] = []
  let normalizedIndex = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 13 && text.charCodeAt(index + 1) === 10) {
      collapsed.push(normalizedIndex)
      index += 1
    }
    normalizedIndex += 1
  }
  if (collapsed.length === 0) return null
  return (position: number): number => {
    let low = 0
    let high = collapsed.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (collapsed[mid] < position) low = mid + 1
      else high = mid
    }
    return Math.min(text.length, position + low)
  }
}

/** `marked`'s view of `text`: the text itself, or its `\r\n` and `\r` read as `\n`. */
function normalizedSource(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n|\r/g, '\n') : text
}

/** Every code region of `text`, in order, none overlapping. */
export function findCodeRegions(text: string): CodeRegion[] {
  if (!text) return []
  const source = normalizedSource(text)
  const regions: CodeRegion[] = []
  walkNormalizedSource(source, {
    block: (region) => regions.push(region),
    inline: (from, to) => {
      const runs: CodeSpanRun[] = []
      pushCodeSpanRuns(source, from, to, runs)
      pushPairedSpans(runs, regions)
    }
  })
  const toOriginal = source === text ? null : originalOffsets(text)
  if (!toOriginal) return regions
  return regions.map((region) => ({ kind: region.kind, start: toOriginal(region.start), end: toOriginal(region.end) }))
}

/**
 * `text`'s fenced and indented code and its runs of backticks, before the code spans are paired
 * (BL-701). `findCodeRegions(text)` is these blocks and `pairCodeSpans` of these runs, in order.
 */
export function readCodeLayout(text: string): CodeLayout {
  const layout: CodeLayout = { blocks: [], runs: [] }
  if (!text) return layout
  const source = normalizedSource(text)
  walkNormalizedSource(source, {
    block: (region) => layout.blocks.push(region),
    inline: (from, to) => pushCodeSpanRuns(source, from, to, layout.runs)
  })
  const toOriginal = source === text ? null : originalOffsets(text)
  if (!toOriginal) return layout
  for (const region of layout.blocks) {
    region.start = toOriginal(region.start)
    region.end = toOriginal(region.end)
  }
  for (const run of layout.runs) {
    run.start = toOriginal(run.start)
    run.end = toOriginal(run.end)
  }
  return layout
}

/** The region of `regions` (as `findCodeRegions` returns them) that holds the character at `index`, or null. */
export function codeRegionAt(regions: readonly CodeRegion[], index: number): CodeRegion | null {
  let low = 0
  let high = regions.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (regions[mid].end <= index) low = mid + 1
    else high = mid
  }
  return low < regions.length && regions[low].start <= index && index < regions[low].end ? regions[low] : null
}

/** Whether the character at `index` lies in one of `regions` (as `findCodeRegions` returns them). */
export function isInCodeRegion(regions: readonly CodeRegion[], index: number): boolean {
  return codeRegionAt(regions, index) !== null
}
