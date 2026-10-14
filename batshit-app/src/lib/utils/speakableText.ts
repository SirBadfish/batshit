import { CONTROL_TAGS, findControlBlocks, removeControlBlocks, type ControlTagId } from './controlTags'
import { findCodeRegions } from './markdownCodeRegions'
import { replaceBracedTokens } from './braceScan'

const SPEAKABLE_HTML_TAGS = new Set([
  'a',
  'abbr',
  'article',
  'aside',
  'b',
  'blockquote',
  'br',
  'cite',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'wbr'
])

const EMOJI_CLUSTER_SOURCE =
  String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*`
const EMOJI_COMBO_JOINER_PATTERN = new RegExp(
  `(${EMOJI_CLUSTER_SOURCE})\\s*\\+\\s*(${EMOJI_CLUSTER_SOURCE})`,
  'gu'
)

// Markdown reference definitions (`[label]: https://example.com`). The label is
// captured so reference-link collapsing can require a definition that actually
// exists in the same text; bracket TTS cues share the `[a][b]` shape and must not
// be mistaken for links. See `collectMarkdownReferenceLabels`.
const MARKDOWN_REFERENCE_DEFINITION_PATTERN = /^\s{0,3}\[([^\]]+)\]:\s+\S+.*$/gm

export type SpeakableItalicBehavior = 'speak' | 'silent'

export type SpeakableTextOptions = {
  italicBehavior?: SpeakableItalicBehavior
}

function shouldSilenceItalics(options?: SpeakableTextOptions): boolean {
  return options?.italicBehavior === 'silent'
}

const XML_NAME_CHAR = /[a-z0-9:_-]/i

function isXmlWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/**
 * The names an XML-style tag starting at `at` (a `<` followed by a letter) may have, longest first,
 * as the regex `<([a-z][a-z0-9:_-]*)\b` reads them: the name run, shortened back to each place a
 * word boundary allows.
 */
function xmlTagNamesAt(text: string, at: number): string[] {
  let runEnd = at + 2
  while (runEnd < text.length && XML_NAME_CHAR.test(text[runEnd])) runEnd += 1
  const names: string[] = []
  for (let end = runEnd; end >= at + 2; end -= 1) {
    if (isXmlWordChar(text[end - 1]) !== isXmlWordChar(text[end])) names.push(text.slice(at + 1, end))
  }
  return names
}

/**
 * One pass of `text.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*\/>/gi, keepOrDrop)`, in linear time (the
 * regex scanned from every `<name` to the next `>`). `drop` decides by the tag's name.
 */
function replaceSelfClosingXmlTags(text: string, drop: (tagName: string) => boolean): string {
  const kept: string[] = []
  let cursor = 0
  let closeAngle = -1
  for (let at = text.indexOf('<'); at >= 0; at = text.indexOf('<', Math.max(at + 1, cursor))) {
    if (!/[a-z]/i.test(text[at + 1] ?? '')) continue
    if (closeAngle < at) closeAngle = text.indexOf('>', at)
    if (closeAngle < 0) break
    if (text[closeAngle - 1] !== '/') continue
    // The name ends before the `/` (a `/` is not a name character), so any `\b` place fits.
    const names = xmlTagNamesAt(text, at)
    if (names.length === 0) continue
    if (drop(names[0])) {
      kept.push(text.slice(cursor, at))
      cursor = closeAngle + 1
    } else {
      kept.push(text.slice(cursor, closeAngle + 1))
      cursor = closeAngle + 1
    }
  }
  if (cursor === 0) return text
  kept.push(text.slice(cursor))
  return kept.join('')
}

/**
 * One pass of `text.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, keepOrDrop)`, in linear
 * time: that regex tried every opening tag against the rest of the text (the BL-640 shape, in the
 * browser's speech). Returns the text and whether a block was dropped.
 */
function replacePairedXmlBlocks(text: string, drop: (tagName: string) => boolean): { text: string; dropped: boolean } {
  const folded = text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
  // Every `</name>` by name, in order.
  const closings = new Map<string, number[]>()
  for (let at = folded.indexOf('</'); at >= 0; at = folded.indexOf('</', at + 2)) {
    let end = at + 2
    while (end < folded.length && XML_NAME_CHAR.test(folded[end])) end += 1
    if (end === at + 2 || folded[end] !== '>') continue
    const name = folded.slice(at + 2, end)
    const list = closings.get(name)
    if (list) list.push(at)
    else closings.set(name, [at])
  }
  const firstClosingAfter = (name: string, from: number): number => {
    const list = closings.get(name)
    if (!list) return -1
    let low = 0
    let high = list.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (list[mid] < from) low = mid + 1
      else high = mid
    }
    return low < list.length ? list[low] : -1
  }
  const kept: string[] = []
  let cursor = 0
  let dropped = false
  let closeAngle = -1
  for (let at = folded.indexOf('<'); at >= 0; at = folded.indexOf('<', Math.max(at + 1, cursor))) {
    if (!/[a-z]/.test(folded[at + 1] ?? '')) continue
    if (closeAngle < at) closeAngle = folded.indexOf('>', at)
    if (closeAngle < 0) break
    let match: { name: string; end: number } | null = null
    for (const name of xmlTagNamesAt(folded, at)) {
      const closing = firstClosingAfter(name, closeAngle + 1)
      if (closing >= 0) {
        match = { name, end: closing + name.length + 3 }
        break
      }
    }
    if (!match) continue
    if (drop(match.name)) {
      kept.push(text.slice(cursor, at))
      dropped = true
    } else {
      kept.push(text.slice(cursor, match.end))
    }
    cursor = match.end
  }
  if (cursor === 0) return { text, dropped: false }
  kept.push(text.slice(cursor))
  return { text: kept.join(''), dropped }
}

/** Exported, with the speakable set as a parameter, for the old-against-new comparison test. */
export function stripUnsupportedXmlBlocks(
  text: string,
  speakableTags: ReadonlySet<string> = SPEAKABLE_HTML_TAGS
): string {
  const drop = (tagName: string) => !speakableTags.has(tagName.toLowerCase())
  // Remove unsupported self-closing tags before paired tags so a tag like
  // `<emote name="smile" />` is not mistaken for an opener when another
  // `</emote>` appears later in the same reply.
  let output = replaceSelfClosingXmlTags(text, drop)

  // Remove unsupported paired tags repeatedly so nested tags are fully stripped.
  for (;;) {
    const pass = replacePairedXmlBlocks(output, drop)
    output = pass.text
    if (!pass.dropped) break
  }

  // Remove unsupported self-closing tags.
  return replaceSelfClosingXmlTags(output, drop)
}

function stripEmojiComboJoiners(text: string): string {
  let output = text
  let changed = true

  while (changed) {
    changed = false
    output = output.replace(EMOJI_COMBO_JOINER_PATTERN, (_match, left: string, right: string) => {
      changed = true
      return `${left}${right}`
    })
  }

  return output
}

function isHtmlTagNameBoundary(char: string | undefined): boolean {
  return !char || char === '>' || char === '/' || char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

function findHtmlTag(lowerText: string, tagName: string, fromIndex: number, closing = false): number {
  const prefix = closing ? `</${tagName}` : `<${tagName}`
  let searchIndex = fromIndex
  while (searchIndex < lowerText.length) {
    const index = lowerText.indexOf(prefix, searchIndex)
    if (index < 0) return -1
    if (isHtmlTagNameBoundary(lowerText[index + prefix.length])) return index
    searchIndex = index + prefix.length
  }
  return -1
}

function stripSelfClosingHtmlTagsByName(text: string, tagName: string): string {
  let output = text
  for (let scanCount = 0; scanCount < 50; scanCount += 1) {
    const lower = output.toLowerCase()
    const openIndex = findHtmlTag(lower, tagName, 0)
    if (openIndex < 0) return output

    const openEnd = lower.indexOf('>', openIndex)
    if (openEnd < 0) return output.slice(0, openIndex)

    const tagText = lower.slice(openIndex, openEnd + 1)
    if (!tagText.trimEnd().endsWith('/>')) {
      return output
    }

    output = `${output.slice(0, openIndex)} ${output.slice(openEnd + 1)}`
  }
  return output
}

function stripHtmlBlocksByTagName(text: string, tagName: string): string {
  let output = text

  for (let scanCount = 0; scanCount < 50; scanCount += 1) {
    const lower = output.toLowerCase()
    const openIndex = findHtmlTag(lower, tagName, 0)
    if (openIndex < 0) return output

    const openEnd = lower.indexOf('>', openIndex)
    if (openEnd < 0) {
      output = `${output.slice(0, openIndex)} ${output.slice(openIndex + tagName.length + 1)}`
      continue
    }

    const closeIndex = findHtmlTag(lower, tagName, openEnd + 1, true)
    if (closeIndex < 0) {
      output = output.slice(0, openIndex)
      continue
    }

    const closeEnd = lower.indexOf('>', closeIndex)
    output = `${output.slice(0, openIndex)} ${closeEnd >= 0 ? output.slice(closeEnd + 1) : ''}`
  }

  return output
}

/**
 * BL-442 R5 (BL-477): only a real tag is removed from speech: `<`, a tag name (after an optional
 * `/`), attributes written as HTML writes them (`name`, `name="value"`), and a closing `>`. Words
 * that only happen to sit between a `<` and a `>` ("<batshit-memory then f = () =>") are spoken. A lone `<` or `>` is spoken:
 * "x < 5 and y > 3" used to be spoken as "x 3", and "If the count is < 5, retry" as "If the count
 * is". One linear pass: each `<` is read up to the next `<` or `>` at most.
 */
const REAL_TAG_FOR_SPEECH =
  /<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'=<>`]+))?)*\s*\/?>/g

function stripRemainingHtmlTags(text: string): string {
  return text.replace(REAL_TAG_FOR_SPEECH, ' ')
}

function stripHtmlItalicNarrationForSpeech(text: string): string {
  let output = stripHtmlBlocksByTagName(text, 'em')
  output = stripHtmlBlocksByTagName(output, 'i')
  output = stripSelfClosingHtmlTagsByName(output, 'em')
  return stripSelfClosingHtmlTagsByName(output, 'i')
}

function stripMarkdownItalicNarrationForSpeech(text: string): string {
  let output = text
  const trailingBoundary = String.raw`(?=$|[\s.,!?;:)\]}])`

  output = output.replace(
    new RegExp(String.raw`(^|[\s([{])\*\*\*([^*\n]+)\*\*\*${trailingBoundary}`, 'g'),
    '$1'
  )
  output = output.replace(
    new RegExp(String.raw`(^|[\s([{])___([^_\n]+)___${trailingBoundary}`, 'g'),
    '$1'
  )
  output = output.replace(
    new RegExp(String.raw`(^|[\s([{])\*([^*\n]+)\*${trailingBoundary}`, 'g'),
    '$1'
  )
  output = output.replace(
    new RegExp(String.raw`(^|[\s([{])_([^_\n]+)_${trailingBoundary}`, 'g'),
    '$1'
  )

  return output
}

// A Markdown reference link only resolves when its label is defined somewhere in
// the same text. Collecting the defined labels first lets `[a][b]` collapse for
// real links while leaving adjacent bracket TTS cues (`[sad][whispering]`) alone.
function collectMarkdownReferenceLabels(text: string): Set<string> {
  const labels = new Set<string>()
  for (const match of text.matchAll(MARKDOWN_REFERENCE_DEFINITION_PATTERN)) {
    const label = match[1]?.trim().toLowerCase()
    if (label) labels.add(label)
  }
  return labels
}

function stripMarkdownForSpeech(text: string, options: SpeakableTextOptions = {}): string {
  let output = text

  // Drop fenced code blocks; reading raw code aloud is usually punctuation soup.
  output = output.replace(/```[\s\S]*?```/g, '')
  output = output.replace(/~~~[\s\S]*?~~~/g, '')

  // Capture reference labels before their definitions are removed below.
  const referenceLabels = collectMarkdownReferenceLabels(output)

  // Remove reference definitions and image/link URLs while preserving useful labels.
  output = output.replace(MARKDOWN_REFERENCE_DEFINITION_PATTERN, '')
  output = output.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  output = output.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // Collapse full (`[text][label]`) and collapsed (`[label][]`) reference links only
  // when the label was defined. Bracket-cue TTS engines (Fish Audio S2, Inworld) emit
  // adjacent cues such as `[excited][laughing]`, which are the same shape but must
  // reach the engine intact instead of being spoken as the literal word "excited".
  output = output.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (match, label: string, reference: string) => {
    const target = (reference.trim() || label.trim()).toLowerCase()
    return referenceLabels.has(target) ? label : match
  })

  // Strip block-level Markdown markers that should not be spoken.
  output = output.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '$1')
  output = output.replace(/^\s{0,3}>\s?/gm, '')
  output = output.replace(/^\s{0,3}([-*_]\s*){3,}$/gm, '')
  output = output.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')

  // Strip inline formatting markers but keep the words.
  output = output.replace(/`{1,2}([^`\n]+)`{1,2}/g, '$1')
  output = output.replace(/~~([^~\n]+)~~/g, '$1')
  if (shouldSilenceItalics(options)) {
    output = stripMarkdownItalicNarrationForSpeech(output)
  }
  output = output.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  output = output.replace(/__([^_\n]+)__/g, '$1')
  if (!shouldSilenceItalics(options)) {
    output = output.replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s.,!?;:)\]}])/g, '$1$2')
    output = output.replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s.,!?;:)\]}])/g, '$1$2')
  }

  // Clean up common table/separator punctuation that speech engines tend to vocalize.
  output = output.replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/gm, '')
  output = output.replace(/^\s*\|(.+)\|\s*$/gm, (_match, cells: string) =>
    cells
      .split('|')
      .map((cell: string) => cell.trim())
      .filter(Boolean)
      .join(', ')
  )

  // Remove leftover Markdown emphasis markers after structured cases are handled.
  output = output.replace(/[*~`]/g, '')

  return output
}

function stripToolResultsSummarySections(text: string): string {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const normalized = line.trim()

    if (!/^#{0,6}\s*tool results summary\b/i.test(normalized)) {
      kept.push(line)
      continue
    }

    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? ''
      const trimmed = next.trim()

      if (!trimmed) {
        index += 1
        break
      }

      if (/^#{1,6}\s+\S/.test(trimmed)) break

      index += 1
    }
  }

  return kept.join('\n')
}

const TTS_HIDDEN_TAG_IDS: ReadonlySet<ControlTagId> = new Set(
  CONTROL_TAGS.filter((spec) => spec.hideFromTts).map((spec) => spec.id)
)

/**
 * Every registered control block, as the registry's scanner reads a finished reply (BL-442): a
 * complete block and a real block left open at the end are never spoken (the open one is
 * load-bearing: realtime TTS can see a message end mid-block). An example in code and a tag named
 * in a sentence are not blocks: they are spoken as code and words are.
 */
function stripControlBlocksForSpeech(text: string): string {
  const blocks = findControlBlocks(text, { final: true }).filter((block) => TTS_HIDDEN_TAG_IDS.has(block.id))
  return removeControlBlocks(text, blocks)
}

/**
 * Bounded opening/closing patterns scan disjoint spans. With no closing match,
 * no later opener can match either, so the unread tail needs no retry (BL-694).
 * Thinking/mute retain their old permissive prefix plus first-`>` grammar.
 */
function stripClosedLegacySpeechBlocks(
  text: string,
  opening: RegExp,
  closing: RegExp,
  requireOpeningAngle = false
): string {
  const kept: string[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = opening.exec(text))) {
    let payloadStart = match.index + match[0].length
    if (requireOpeningAngle) {
      const angle = text.indexOf('>', payloadStart)
      if (angle < 0) break
      payloadStart = angle + 1
    }
    closing.lastIndex = payloadStart
    const end = closing.exec(text)
    if (!end) break
    kept.push(text.slice(cursor, match.index))
    cursor = end.index + end[0].length
    opening.lastIndex = cursor
  }
  if (cursor === 0) return text
  kept.push(text.slice(cursor))
  return kept.join('')
}

/** Legacy thinking/mute/tool-results blocks and notes key, not registered control tags. */
export function stripLegacySpeechBlocks(text: string): string {
  let output = stripClosedLegacySpeechBlocks(text, /<thinking/gi, /<\/thinking>/gi, true)
  output = stripClosedLegacySpeechBlocks(output, /<mute/gi, /<\/mute>/gi, true)
  output = stripClosedLegacySpeechBlocks(
    output,
    /<tool[-_ ]?results(?:[-_ ]?summary)?\b/gi,
    /<\/tool[-_ ]?results(?:[-_ ]?summary)?>/gi
  )
  return output
    .replace(/<tool[-_ ]?results(?:[-_ ]?summary)?\b[\s\S]*$/gi, '')
    // A legacy notes payload's key, not the word in a sentence (BL-477).
    .replace(/\btoolResultsSummary\b(?=["']?\s*:)[\s\S]*$/i, '')
}

/**
 * Trap 2 (BL-442, BL-618): code is found on the text as written, before any pass removes its
 * backticks, and the angle brackets inside it are set aside until the tag passes are done, so no
 * tag pass reads code as a tag. "Put it in a `<script>` tag at the end" was spoken as "Put it in
 * a": the Markdown pass removed the backticks, and the script pass then cut everything after the
 * `<script>`. The brackets come back at the end; a tag written in code is spoken as its name.
 */
const CODE_LT = '\uF8F0'
const CODE_GT = '\uF8F1'

function setCodeBracketsAside(text: string): string {
  if (!text.includes('<') && !text.includes('>')) return text
  if (!text.includes('`') && !text.includes('~~~') && !/^(?: {4}|\t)/m.test(text)) return text
  const regions = findCodeRegions(text)
  if (regions.length === 0) return text
  let output = ''
  let cursor = 0
  for (const region of regions) {
    output += text.slice(cursor, region.start)
    output += text.slice(region.start, region.end).replace(/</g, CODE_LT).replace(/>/g, CODE_GT)
    cursor = region.end
  }
  return output + text.slice(cursor)
}

function restoreCodeBrackets(text: string): string {
  if (!text.includes(CODE_LT) && !text.includes(CODE_GT)) return text
  return text
    .replace(new RegExp(`${CODE_LT}\\/?([A-Za-z][A-Za-z0-9:_-]*)[^${CODE_LT}${CODE_GT}]*${CODE_GT}`, 'g'), '$1')
    .replace(new RegExp(CODE_LT, 'g'), '<')
    .replace(new RegExp(CODE_GT, 'g'), '>')
}

export function extractSpeakableText(content: string, options: SpeakableTextOptions = {}): string {
  if (!content) return ''

  // The control blocks first, by the registry's scanner, which reads code itself and knows that a
  // backtick inside a block's payload is payload. Code found BEFORE that would pair a lone
  // backtick in one block with the next block and hide its tags from this step (review).
  // Trap 2: then code is found before any other pass changes the text (`setCodeBracketsAside`).
  let text = setCodeBracketsAside(stripControlBlocksForSpeech(content))

  // Legacy thinking/mute/tool-results blocks (the registered controls went first, above).
  text = stripLegacySpeechBlocks(text)

  // Remove Tool Results Summary blocks from speech; they remain visible app metadata in chat.
  text = stripToolResultsSummarySections(text)

  // Remove goon stage directions (never read aloud).
  text = text.replace(/\*goon:\s*[^*]*\*/gi, '')

  if (shouldSilenceItalics(options)) {
    text = stripHtmlItalicNarrationForSpeech(text)
  }

  // Remove Markdown formatting markers so TTS does not say "asterisk",
  // "hash", or raw link punctuation during normal assistant replies.
  text = stripMarkdownForSpeech(text, options)

  // Remove zip references (new + legacy) so we never read `{{batshit-zip:...}}`.
  text = replaceBracedTokens(text, '{{batshit-zip:', () => '')
  text = replaceBracedTokens(text, '{{batshit|id:', () => '')

  // Remove script/style blocks entirely (avoid reading embedded JSON payloads).
  text = stripHtmlBlocksByTagName(text, 'script')
  text = stripHtmlBlocksByTagName(text, 'style')

  // Remove unsupported XML-style blocks entirely so custom control tags
  // (for example <emotion>...</emotion>) are never read aloud.
  text = stripUnsupportedXmlBlocks(text)

  // Preserve line breaks where HTML intentionally inserts them.
  text = text.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')

  // Strip remaining XML/HTML tags but keep their inner text.
  text = stripRemainingHtmlTags(text)

  // Remove `+` only when it is acting as an emoji-combo joiner (for example `🙄+🤨`).
  text = stripEmojiComboJoiners(text)

  // Strip emoji characters (Goon cues should not be read aloud).
  text = text.replace(/\p{Extended_Pictographic}/gu, '')

  // Normalize repeated spaces created by tag stripping.
  text = text.replace(/[ \t]{2,}/g, ' ')
  text = text.replace(/\s+([,.;:!?])/g, '$1')
  text = text.replace(/^[ \t]+/gm, '')
  text = text.replace(/[ \t]+$/gm, '')

  // Normalize whitespace.
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return restoreCodeBrackets(text)
}
