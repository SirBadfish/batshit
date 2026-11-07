/**
 * Where a reply's structured tags are (BL-475): `<img>`, and Batshit's `<image>`, `<file>`,
 * `<error>`, `<diff>`, `<terminal>`, and `<cool_tool>`, outside the code the chat's Markdown view
 * draws (`markdownCodeRegions.ts`). `parseMessageContent` turns each found tag into its card and
 * keeps everything between them as the reply's own text, so code stays byte-for-byte and a tag
 * inside code stays text. Pure; linear in the reply's length.
 */

import { CodeSpanReader, codeRegionAt, readCodeLayout, type CodeLayout, type CodeRegion } from './markdownCodeRegions'
import { scanZipReferences, type ReferenceMatch } from './zipReferenceSafety'

/** The server's Error form opens with exactly `<error>` and closes with exactly `</error>`, either case (`zipDetection.ts`). */
const ERROR_OPEN_TAG = /<error>/gi
const ERROR_CLOSE_TAG = /<\/error>/i
/** The start of a fence: three backticks or three tildes. A block with neither holds no fence. */
const FENCE_MARK = /```|~~~/

/**
 * The first exact `</error>` (either case) in `text[from, limit)`, or -1. It reads a window that
 * doubles until it finds one, so it reads at most about twice the distance to it (never on to the
 * text's end when `limit` is near): each stretch of a reply is read once.
 */
function nextErrorCloseTag(text: string, from: number, limit: number): number {
  for (let size = 256; ; size *= 2) {
    const end = Math.min(limit, from + size)
    const found = text.slice(from, end).search(ERROR_CLOSE_TAG)
    if (found >= 0) return from + found
    if (end >= limit) return -1
  }
}

/**
 * BL-779 (d): the fenced code blocks of `text` as the chat's Markdown view reads them, except that
 * each exact `<error>` tag is read as plain words: alone on its line, the tag would otherwise open
 * an HTML block for the Markdown reader and hide every fence after it up to the next blank line.
 * Both halves of the Error block's close rule read these (`findErrorBlockClose`).
 */
export function errorBlockFences(text: string): CodeRegion[] {
  const tagsAsWords = text.replace(ERROR_OPEN_TAG, (tag) => 'x'.repeat(tag.length))
  return readCodeLayout(tagsAsWords).blocks.filter((region) => region.kind === 'fenced')
}

/**
 * BL-779 (d): where the Error block whose words start at `bodyStart` ends: the first exact
 * `</error>` (either case) at or after `from` and before `limit` that is not inside a fenced code
 * block opening after `bodyStart`; null when there is none. A fence that opens inside the block is
 * the block's words, so a closing tag inside it is too: ended there, the fence's own closing line
 * would stand alone after the block and turn the rest of the reply into code. A fence that opened
 * before the block is not the block's. `fences` (the `errorBlockFences` of `text`) is read only when
 * a fence mark lies between the block's start and a closing tag. The server's zip detector
 * (`zipDetection.ts`) and the chat view (below) both end an Error block here, so the view never
 * draws a card the save kept as words. Reads the text from `bodyStart` to the closing tag (or to
 * `limit`) about twice, plus the one fence read.
 */
export function findErrorBlockClose(
  text: string,
  bodyStart: number,
  from: number,
  limit: number,
  fences: () => readonly CodeRegion[]
): { at: number; end: number } | null {
  let blockFences: readonly CodeRegion[] | null = null
  for (let at = nextErrorCloseTag(text, from, limit); at >= 0; at = nextErrorCloseTag(text, at + 1, limit)) {
    const close = { at, end: at + '</error>'.length }
    if (blockFences === null) {
      if (!FENCE_MARK.test(text.slice(bodyStart, at))) return close
      blockFences = fences()
    }
    const fence = codeRegionAt(blockFences, at)
    if (!fence || fence.start < bodyStart) return close
  }
  return null
}

/**
 * The structured tags a reply may carry: `img` is standard HTML, the others are Batshit's own.
 * A tag is the name, then a space, `>`, or `/`.
 */
export const STRUCTURED_TAG_PRESENT = /<(terminal|diff|error|image|img|file|cool_tool)[\s>/]/i
const STRUCTURED_TAG = /<(terminal|diff|error|image|img|file|cool_tool)(?=[\s>/])/gi
/** The old `<img alt="...">` + URL-on-the-next-line shape a model sometimes writes. */
const IMG_SRC_ON_NEXT_LINE = /\s*\n\s*(https?:\/\/[^\s<]+|data:[^<\s]+)/y

export type StructuredElement = {
  /** The tag's name, lower case. */
  name: string
  /** Its `<`. */
  start: number
  /** One past its closing tag; the text's end for a tag that is never closed. */
  end: number
  /** An opening tag still arriving at the very end of the text (no `>` yet, nothing after it). */
  partial?: boolean
  /** An `<img>` with no `src` whose address stands on the next line; the element covers it. */
  srcFromNextLine?: string
  /** One past the opening tag's `>`. */
  openEnd?: number
}

/**
 * One past the `>` that ends the opening tag starting at `from`, reading quoted attribute values
 * as HTML does; -1 when `limit` (the text's end, or the start of the next zip reference, which an
 * opening tag never reaches into) comes first.
 */
function openingTagEnd(content: string, from: number, limit: number): number {
  let quote = ''
  // The last character that was not a space: a quote opens a value only right after `=`, as in
  // HTML; an apostrophe inside an unquoted value is text.
  let previous = ''
  for (let index = from; index < limit; index += 1) {
    const char = content[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if ((char === '"' || char === "'") && previous === '=') {
      quote = char
    } else if (char === '>') {
      return index + 1
    }
    if (!/\s/.test(char)) previous = char
  }
  return -1
}

const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
/** Characters an attribute name never holds (HTML), plus `<` and a backtick, which no tag a model writes holds. */
const NOT_IN_NAME = new Set(['"', "'", '<', '>', '/', '=', '`'])

/**
 * Whether everything from `from` (just past an opening tag's name) to the text's end can be the
 * rest of that opening tag still arriving over several lines (BL-780): attributes, each written
 * whole as `name=value` except the last, which may still be arriving, with no blank line, `<`, or
 * `>`. Words of a sentence after a tag named in prose are bare names, so they are not attributes.
 * One pass from `from`.
 */
function attributesStillArriving(content: string, from: number): boolean {
  let index = from
  let bareName = false
  while (index < content.length) {
    const char = content[index]
    if (isSpace(char)) {
      if (char === '\n') {
        let next = index + 1
        while (next < content.length && content[next] !== '\n' && isSpace(content[next])) next += 1
        if (content[next] === '\n') return false
      }
      index += 1
      continue
    }
    if (char === '/') return content.slice(index + 1).trim() === ''
    // Another word after a name with no value: a sentence, not attributes.
    if (bareName || NOT_IN_NAME.has(char)) return false
    while (index < content.length && !isSpace(content[index]) && !NOT_IN_NAME.has(content[index])) index += 1
    let afterName = index
    while (afterName < content.length && isSpace(content[afterName]) && content[afterName] !== '\n') afterName += 1
    if (content[afterName] !== '=') {
      bareName = true
      continue
    }
    index = afterName + 1
    while (index < content.length && isSpace(content[index])) index += 1
    const quote = content[index]
    if (quote === '"' || quote === "'") {
      const close = content.indexOf(quote, index + 1)
      if (close < 0) return !/[<>]|\n[ \t]*\n/.test(content.slice(index + 1))
      index = close + 1
      continue
    }
    while (index < content.length && !isSpace(content[index])) {
      if (NOT_IN_NAME.has(content[index]) && content[index] !== '/') return false
      index += 1
    }
  }
  return true
}

/** Whether one of `elements` (in order) starts after `from` and before `to`. */
function elementStartsBetween(elements: readonly StructuredElement[], from: number, to: number): boolean {
  let low = 0
  let high = elements.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (elements[mid].start <= from) low = mid + 1
    else high = mid
  }
  return low < elements.length && elements[low].start < to
}

/** Whether `index` lies inside one of `elements` (in order, none overlapping). */
function insideElement(elements: readonly StructuredElement[], index: number): boolean {
  let low = 0
  let high = elements.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (elements[mid].end <= index) low = mid + 1
    else high = mid
  }
  return low < elements.length && elements[low].start < index && index < elements[low].end
}

/**
 * The structured tags of `content` that lie outside code, in order, with `layout` saying where the
 * code is (the chat's Markdown view's code, `readCodeLayout`). A tag inside a fenced, indented, or
 * inline code region is text. Everything between two tags is payload of the first: a backtick
 * there never opens a code span (the spans are paired left to right, `CodeSpanReader`, skipping
 * those runs, as the control-block scanner does, BL-701).
 */
/** The value of attribute `name` in an opening tag's text, or null. */
function attributeValue(opening: string, name: string): string | null {
  const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(opening)
  return found ? (found[1] ?? found[2] ?? found[3] ?? '') : null
}

function scanStructuredElements(
  content: string,
  layout: CodeLayout,
  errorFences: () => readonly CodeRegion[],
  isTrustedZipId?: (zipId: string) => boolean,
  firstScan?: readonly StructuredElement[],
  streaming = false
): StructuredElement[] {
  const elements: StructuredElement[] = []
  /**
   * BL-779 (d): after an exact `<error>` with no closing tag before the next zip reference, the
   * server's zip detector holds the words to that reference (a tool card) or the reply's end and
   * saves them as words, with every `<error>` among them: up to here an exact `<error>` is a word.
   */
  let errorWordsUntil = -1
  // In the second scan, no code span reaches across a tag the first scan read (BL-813): the
  // blanked text keeps a one- or two-line tag on lines of letters, with no blank line to stop a
  // lone backtick before it pairing with one after it.
  const spans = new CodeSpanReader(
    layout.runs,
    (start, spanEnd) =>
      insideElement(elements, start) || (firstScan !== undefined && elementStartsBetween(firstScan, start, spanEnd))
  )
  const blocks = layout.blocks
  let block = 0
  // A tag inside a zip reference (its label) is part of the reference, never a card (BL-489).
  const references: ReferenceMatch[] = content.includes('{{batshit-zip:') ? scanZipReferences(content) : []
  let reference = 0
  /**
   * Per tag name, the last closing-tag search: where it started and where it found the closing
   * tag (-1: none after that point). A later search that starts between the two finds the same
   * answer, so each stretch of text is searched once per name.
   */
  const lastClose = new Map<string, { from: number; at: number; end: number }>()
  const findClose = (name: string, from: number): { at: number; end: number } => {
    const cached = lastClose.get(name)
    if (cached && cached.from <= from && (cached.at === -1 || cached.at >= from)) return cached
    // The server's Error form closes with exactly `</error>` (`zipDetection.ts`).
    const closing = new RegExp(name === 'error' ? '</error>' : `</${name}\\s*>`, 'gi')
    closing.lastIndex = from
    const found = closing.exec(content)
    const result = { from, at: found ? found.index : -1, end: found ? closing.lastIndex : -1 }
    lastClose.set(name, result)
    return result
  }
  const pattern = new RegExp(STRUCTURED_TAG.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const start = match.index
    while (block < blocks.length && blocks[block].end <= start) block += 1
    if (block < blocks.length && blocks[block].start <= start) {
      pattern.lastIndex = blocks[block].end
      continue
    }
    if (spans.covers(start)) continue
    while (reference < references.length && references[reference].end <= start) reference += 1
    if (reference < references.length && references[reference].start <= start) {
      pattern.lastIndex = references[reference].end
      continue
    }

    const name = match[1].toLowerCase()
    const limit = reference < references.length ? references[reference].start : content.length
    const openEnd = openingTagEnd(content, start + match[0].length, limit)
    if (openEnd < 0) {
      // Still arriving at the end of a streaming reply: hidden until whole, on one line or, while
      // the reply streams, for a tag that can still become a card, over several lines of
      // attributes (BL-780; a finished reply shows those lines, as its saved record has them). Anywhere
      // else it is text, and so is everything after it up to the next zip reference (reading on
      // from each later `<` would cost the square of the reply's length).
      if (
        limit === content.length &&
        (!content.includes('\n', start) ||
          (streaming && name !== 'error' && attributesStillArriving(content, start + match[0].length)))
      ) {
        elements.push({ name, start, end: content.length, partial: true })
      }
      // An opening tag never reaches into a zip reference: it is text up to the reference, and the
      // scan goes on after the reference, so the cards after it still show (BL-813).
      if (limit < content.length) {
        pattern.lastIndex = references[reference].end
        continue
      }
      break
    }

    if (name === 'error') {
      // The server's Error form only (BL-489, `zipDetection.ts`): an exact `<error>`, or the
      // compiled form of an Error zip, which carries `data-zip-id`. `<error/>`, attributes, and
      // any other spelling are text.
      const opening = content.substring(start, openEnd)
      const compiled = /\sdata-zip-id\s*=/i.test(opening)
      if (!(/^<error>$/i.test(opening) || compiled) || content[openEnd - 2] === '/') continue
      if (!compiled) {
        // The server's form ends where the server ends it (BL-779 d): never inside the block's own
        // fence, and never past the next zip reference (a tool card).
        if (start < errorWordsUntil) continue
        const exactClose = findErrorBlockClose(content, openEnd, openEnd, limit, errorFences)
        if (!exactClose) {
          errorWordsUntil = limit
          continue
        }
        elements.push({ name, start, end: exactClose.end, openEnd })
        pattern.lastIndex = exactClose.end
        continue
      }
      // The compiled form of an Error zip holds the zip's stored words, escaped, so its first
      // closing tag is its own.
      const close = findClose(name, openEnd)
      if (close.at === -1) continue
      // A matched pair never spans a zip reference (a tool card), except the compiled form of a
      // TRUSTED Error zip (its id in this message's trusted set, `data-zip-type="error"`), whose
      // content is the zip's own stored text. A model can write a compiled-looking opening; with
      // no trusted set, the span check stays.
      const zipId = compiled ? attributeValue(opening, 'data-zip-id') : null
      const trustedCompiled =
        Boolean(zipId && isTrustedZipId?.(zipId)) && attributeValue(opening, 'data-zip-type')?.toLowerCase() === 'error'
      if (!trustedCompiled && references.some((ref) => ref.start >= openEnd && ref.start < close.at)) continue
      elements.push({ name, start, end: close.end, openEnd })
      pattern.lastIndex = close.end
      continue
    }

    let end: number
    let srcFromNextLine: string | undefined
    if (name === 'img' || content[openEnd - 2] === '/') {
      end = openEnd
      if (name === 'img' && !/\ssrc\s*=/i.test(content.substring(start, openEnd))) {
        IMG_SRC_ON_NEXT_LINE.lastIndex = openEnd
        const next = IMG_SRC_ON_NEXT_LINE.exec(content)
        if (next) {
          srcFromNextLine = next[1]
          end = IMG_SRC_ON_NEXT_LINE.lastIndex
        }
      }
    } else {
      // The first closing tag of the same name ends it; a tag never closed runs to the end, as a
      // streaming tag does.
      const close = findClose(name, openEnd)
      end = close.at === -1 ? content.length : close.end
    }
    elements.push({ name, start, end, openEnd, srcFromNextLine })
    pattern.lastIndex = end
  }
  return elements
}

/**
 * The structured tags of `content` outside code (BL-475). Code is found with the chat's own
 * Markdown lexer on the text as written. A fence can open inside a tag's content (a terminal's
 * output with a ``` line), and on the text as written it then runs over the tags after it; so when
 * a code block opens inside a tag that was read, the tags are blanked (see below) and the text is lexed and
 * scanned once more: at most two scans, as the control-block scanner does (BL-700).
 */
export function findStructuredElements(
  content: string,
  isTrustedZipId?: (zipId: string) => boolean,
  options: { streaming?: boolean } = {}
): StructuredElement[] {
  const streaming = options.streaming === true
  const layout = readCodeLayout(content)
  // Read at most once, and only for an Error block with a fence mark before its closing tag.
  let fences: CodeRegion[] | null = null
  const errorFences = () => (fences ??= errorBlockFences(content))
  const first = scanStructuredElements(content, layout, errorFences, isTrustedZipId, undefined, streaming)
  if (first.length === 0) return first
  const codeOpensInsideTag = layout.blocks.some((region) => insideElement(first, region.start))
  if (!codeOpensInsideTag) return first
  // A read tag's first and last line fragments become letters (so the text after its closing tag
  // on the same line never starts with spaces and turns into indented code); every line wholly
  // inside it becomes spaces (a blank line, so a backtick before the tag never pairs with one
  // after it across the tag).
  let blanked = ''
  let from = 0
  for (const element of first) {
    const lines = content.substring(element.start, element.end).split('\n')
    const filled = lines.map((line, index) =>
      index === 0 || index === lines.length - 1 ? line.replace(/./g, 'x') : line.replace(/./g, ' ')
    )
    blanked += content.substring(from, element.start) + filled.join('\n')
    from = element.end
  }
  blanked += content.substring(from)
  return scanStructuredElements(content, readCodeLayout(blanked), errorFences, isTrustedZipId, first, streaming)
}
