/**
 * SA-104 P1 — the single control-tag registry (DL-104-06).
 *
 * Every inline `<batshit-*>` control tag is registered exactly once here. The
 * render strip (zipControl.hideStreamingHiddenControlBlocks), the TTS final
 * strip (speakableText), the realtime TTS mid-stream hold-back
 * (realtimeSpeechCoordinator), and group-chat presentation stripping all derive
 * their tag lists from this module instead of keeping their own copies.
 *
 * BL-442: every reader also finds the blocks with this module's ONE scanner,
 * `findControlBlocks` (below): a block is a tag outside code, followed by its payload,
 * and closed. The plain-search helpers every reader used to build its own lazy regex
 * from (`pairedBlockRegexGlobal`, `unclosedTailRegexGlobal`, `renderHiddenOpenRegex`,
 * `closeTagRegex`, `splitTrailingPartialControlPrefix`) are gone, so no reader can
 * go back to reading a mention, an example in code, or a lone `<` as a command.
 *
 * Adding a tag here is the whole registration: it is hidden from render,
 * stripped from speech (closed AND unclosed trailing forms), held back
 * mid-stream by the realtime speech pipeline, and covered by the shared
 * chunk-split partial-prefix hold. Site-specific behavior (payload parsing,
 * side-channel dispatch such as Goon cue firing, group-protocol lead parsing)
 * stays with its owning module — this registry owns identity and strip policy,
 * not semantics.
 */

import { CodeSpanReader, codeRegionAt, pairCodeSpans, readCodeLayout, type CodeLayout, type CodeRegion } from './markdownCodeRegions'

export type ControlTagId = 'zip-control' | 'tool-notes' | 'memory' | 'cue' | 'group'

export interface ControlTagSpec {
  id: ControlTagId
  /** Element name as emitted by agents, e.g. `batshit-cue`. */
  tag: string
  /** Payload style inside the block. `json-tolerant` allows the cue-style lenient parse. */
  parse: 'json' | 'json-tolerant'
  /**
   * `any`: valid anywhere in a message (the strip layer makes every position safe).
   * `lead-required`: the group-chat protocol tag — it must be the first output and
   * keeps its own buffering logic in groupChatUtils.
   */
  position: 'any' | 'lead-required'
  /** Documented default convention for prompts: append bulky blocks at message end. */
  bulkyEndOfMessageConvention: boolean
  /** Hidden from chat rendering while streaming and in final render. */
  hideFromRender: boolean
  /** Stripped from TTS text (final pass) and held back mid-stream by realtime TTS. */
  hideFromTts: boolean
  /** Additionally stripped from group-chat presentation output. */
  strippedInGroupPresentation: boolean
  /**
   * Malformed payloads surface loudly: a `controlErrors` entry on the message
   * metadata plus a next-turn context line (DL-104-05). Never a silent drop.
   */
  loudFailure: boolean
}

export const CONTROL_TAGS: readonly ControlTagSpec[] = [
  {
    id: 'zip-control',
    tag: 'batshit-zip-control',
    parse: 'json',
    position: 'any',
    bulkyEndOfMessageConvention: true,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: false,
    loudFailure: true
  },
  {
    id: 'tool-notes',
    tag: 'batshit-tool-notes',
    parse: 'json',
    position: 'any',
    bulkyEndOfMessageConvention: true,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: false,
    loudFailure: true
  },
  {
    // SA-104 P3: the inline memory save (DL-104-05 hot path). Multiple blocks per
    // message are supported — each block is one save; parsing/writes live in
    // $lib/utils/memoryControl.ts + the server's reply-end step (replyControlFinalize.ts).
    id: 'memory',
    tag: 'batshit-memory',
    parse: 'json',
    position: 'any',
    bulkyEndOfMessageConvention: true,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: false,
    loudFailure: true
  },
  {
    id: 'cue',
    tag: 'batshit-cue',
    parse: 'json-tolerant',
    position: 'any',
    bulkyEndOfMessageConvention: false,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: true,
    loudFailure: false
  },
  {
    id: 'group',
    tag: 'batshit-group',
    parse: 'json',
    position: 'lead-required',
    bulkyEndOfMessageConvention: false,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: false,
    loudFailure: false
  }
] as const

const TAG_BY_NAME = new Map(CONTROL_TAGS.map((spec) => [spec.tag.toLowerCase(), spec]))
const TAG_BY_ID = new Map(CONTROL_TAGS.map((spec) => [spec.id, spec]))

export function controlTag(id: ControlTagId): ControlTagSpec {
  const spec = TAG_BY_ID.get(id)
  if (!spec) throw new Error(`Unknown control tag id: ${id}`)
  return spec
}

export function controlTagByName(name: string): ControlTagSpec | null {
  return TAG_BY_NAME.get(name.toLowerCase()) ?? null
}

/**
 * Non-tag speech/presentation strip families that ride along with the control
 * grammar. They are not `<batshit-*>` tags but share the "never spoken, never
 * group-presented" policy, so their single source of truth lives here too: the
 * emote tags by `stripEmoteTags` and `stripIncompleteEmoteTag` below (BL-442 retired
 * their lazy regexes), and the Goon stage direction by this regex.
 */
export const GOON_STAGE_DIRECTION_REGEX_SOURCE = String.raw`\*goon:\s*[a-zA-Z0-9 _-]+\s*\*[ \t]*`

const EMOTE_TAG_BASES = ['emote', 'goon-emote']

function isRegexWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/** At `at` in the folded text, the `emote` or `goon-emote` name that follows `prefix` (`<` or `</`). */
function emoteBaseAt(folded: string, at: number, prefix: string): string | null {
  if (!folded.startsWith(prefix, at)) return null
  return EMOTE_TAG_BASES.find((base) => folded.startsWith(base, at + prefix.length)) ?? null
}

/** Where a valid emote closing tag (`</emote>`, `</goon-emote-name>`, …) starting at `at` ends, or -1. */
function emoteClosingEndAt(folded: string, at: number): number {
  const base = emoteBaseAt(folded, at, '</')
  if (!base) return -1
  let cursor = at + 2 + base.length
  if (folded[cursor] === '>') return cursor + 1
  if (folded[cursor] !== '-') return -1
  cursor += 1
  const runStart = cursor
  while (cursor < folded.length && /[a-z0-9_-]/.test(folded[cursor])) cursor += 1
  return cursor > runStart && folded[cursor] === '>' ? cursor + 1 : -1
}

function skipSpacesAndTabs(text: string, at: number): number {
  let cursor = at
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1
  return cursor
}

/**
 * `text` with every emote tag removed, in one pass: exactly what the retired lazy regex
 * `<(emote|goon-emote)(-name)?\b[^>]*\/>[ \t]*|<(emote|goon-emote)(-name)?\b[^>]*>[\s\S]*?<\/(emote|goon-emote)(-name)?>[ \t]*`
 * (global, case-insensitive) removed. That regex tried every unclosed `<emote…>` against the rest
 * of the text, so its cost was (unclosed emote tags) x (text length), the stall BL-543 and BL-640
 * removed for control tags. Compared with the regex over generated texts in the tests.
 */
export function stripEmoteTags(text: string): string {
  if (!text) return text
  const folded = foldAsciiCase(text)
  if (!folded.includes('emote')) return text
  // Every valid closing tag, in order: a paired emote takes the first one after its `>`.
  const closings: Array<{ start: number; end: number }> = []
  for (let at = folded.indexOf('</', 0); at >= 0; at = folded.indexOf('</', at + 2)) {
    const end = emoteClosingEndAt(folded, at)
    if (end >= 0) closings.push({ start: at, end })
  }
  const kept: string[] = []
  let cursor = 0
  let closing = 0
  let closeAngle = -2
  for (let at = folded.indexOf('<', cursor); at >= 0; at = folded.indexOf('<', at + 1)) {
    if (at < cursor) continue
    const base = emoteBaseAt(folded, at, '<')
    if (!base) continue
    const nameEnd = at + 1 + base.length
    // After the name comes a non-word character (the regex's `\b`); an optional `-name` needs no check.
    if (isRegexWordChar(folded[nameEnd])) continue
    // The first `>` after the name, remembered across candidates (they come in order).
    if (closeAngle < nameEnd) closeAngle = folded.indexOf('>', nameEnd)
    if (closeAngle < 0) break
    let end = -1
    if (closeAngle - 1 >= nameEnd && folded[closeAngle - 1] === '/') {
      end = closeAngle + 1
    } else {
      while (closing < closings.length && closings[closing].start <= closeAngle) closing += 1
      if (closing < closings.length) end = closings[closing].end
    }
    if (end < 0) continue
    kept.push(text.slice(cursor, at))
    cursor = skipSpacesAndTabs(text, end)
    at = cursor - 1
  }
  if (cursor === 0) return text
  kept.push(text.slice(cursor))
  return kept.join('')
}

/**
 * `text` without an emote tag still being written at its end, in one pass: exactly what the
 * retired regex `<(emote|goon-emote)(-name)?\b[^>]*$` (case-insensitive) removed; it scanned from
 * every `<emote` to the next `>`.
 */
export function stripIncompleteEmoteTag(text: string): string {
  if (!text) return text
  const folded = foldAsciiCase(text)
  const lastClose = folded.lastIndexOf('>')
  for (let at = folded.indexOf('<', lastClose + 1); at >= 0; at = folded.indexOf('<', at + 1)) {
    const base = emoteBaseAt(folded, at, '<')
    if (!base || isRegexWordChar(folded[at + 1 + base.length])) continue
    return text.slice(0, at)
  }
  return text
}

/**
 * Plain-text control sections (no XML tag) recognized by the speech pipeline —
 * today only the Tool Results Summary heading family, in tag-ish and
 * heading-ish spellings.
 */
export const PLAIN_CONTROL_SECTION_TAGS: readonly string[] = [
  'tool-results',
  'tool-results-summary',
  'tool_results',
  'tool_results_summary'
]

/** Tag names hidden from TTS (final strip + realtime hold-back). */
export function ttsHiddenTagNames(): string[] {
  return CONTROL_TAGS.filter((spec) => spec.hideFromTts).map((spec) => spec.tag)
}

/** Realtime hold-back also withholds the plain tool-results tag spellings. */
export function realtimeHiddenTagNames(): string[] {
  return [...ttsHiddenTagNames(), ...PLAIN_CONTROL_SECTION_TAGS]
}

export function realtimeHiddenTagOpenPrefixes(): string[] {
  return realtimeHiddenTagNames().map((tag) => `<${tag}`)
}

/**
 * BL-442: what counts as a control block, for EVERY reader (the server's reply end, the Stop
 * fallback, the live view, the `end` rebuild, speech, the group presentation, the compile's last
 * strip, Judge Juice). The rule
 * is shared by all those readers:
 *
 *   A control block is a tag that is outside code, that is followed by its payload, and that is
 *   closed. Everything else is text.
 *
 * - R1: a tag inside fenced, indented, or inline code (as the chat's Markdown view draws it,
 *   `markdownCodeRegions.ts`) is text.
 * - R2 (Faye's exact words, 2026-09-27): an opening tag outside code starts a block in two cases.
 *   (a) The next thing after it (spaces and line breaks may come between) is the start of its
 *   payload: `{` for every tag; for the cue tag also a JSON string (`"…"`) or a cue key followed
 *   by `:` or `=`, the forms its tolerant parser (`extractBatshitCuePayload`) reads. (b) Its own
 *   closing tag comes after it (outside code), and no other opening tag of the same kind stands
 *   between them: a block with a bad payload, hidden, and each reader reports it loudly as before
 *   (an empty block is one). In every other case the opening tag is a mention, and it is text.
 * - R3: a case (a) opening tag with no closing tag after it is `unclosed`: it runs to the end of
 *   the text (only text from that tag on is hidden), and a finished reply reports it as broken.
 * - R4: while a reply streams (`final: false`), a last `<` that can still become a real tag is a
 *   `held-start` and is hidden until it resolves. When the reply ends or is stopped
 *   (`final: true`), only a bare cut start is hidden (a `held-start` block, no error): it holds
 *   `<batshit-` in full and is then part of a tag's name at the very end, or the full name
 *   followed by spaces or nothing. Everything else is text: `<` or `<bat`, and a full tag name
 *   followed by anything but spaces (R4 strict, Faye 2026-09-27). Finished words are never cut.
 *
 * A tag inside a block's payload is payload, not a block: a case (a) opening tag takes the FIRST
 * closing tag of its name after it (as the lazy regexes did), and the scan goes on after that
 * closing tag.
 * After an unclosed opening tag the scan goes on for the OTHER tags (a later Tool Notes block after
 * a broken memory block is still read); a later opening tag of the same name is part of the broken
 * block. Tag names match without regard to ASCII case. An opening tag is the tag's name, then
 * spaces or nothing, then `>`: no tag has attributes (R4 strict), so an opening tag never runs on
 * over other words. A closing tag may have spaces inside it (`</ batshit-memory >`).
 *
 * One pass, linear in the text's length: no lazy whole-reply regex, whose cost was (unclosed
 * opening tags) x (reply length) (BL-640, BL-543), and the code regions are read only when the
 * text holds a candidate tag. Every block is returned, however many; a reader that does work per
 * block (a parse, a Redis write, an error line) caps what it READS, as the Tool Notes reader does
 * (`TOOL_NOTES_BLOCK_LIMIT`), and still removes them all.
 */
export type ControlBlockKind = 'paired' | 'unclosed' | 'held-start'

export interface ControlBlock {
  id: ControlTagId
  /** The registered tag name, e.g. `batshit-memory`. */
  tag: string
  kind: ControlBlockKind
  /** The `<` of the opening tag. */
  start: number
  /** One past the closing tag's `>`; the text's end for an unclosed block or a held start. */
  end: number
  /** One past the opening tag's `>` (for a held start, the text's end). */
  bodyStart: number
  /** The `<` of the closing tag; the text's end for an unclosed block or a held start. */
  bodyEnd: number
}

export interface FindControlBlocksOptions {
  /**
   * The reply has ended or was stopped. `true`: a held start is text (R4). `false` (streaming):
   * a last `<` that can still become a tag, or a complete opening tag with nothing after it yet,
   * is a `held-start` block.
   */
  final: boolean
}

/** Every registered tag name starts with this; candidates are found by it. */
const TAG_NAME_PREFIX = (() => {
  const names = CONTROL_TAGS.map((spec) => spec.tag.toLowerCase())
  let prefix = names[0] ?? ''
  for (const name of names) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  if (prefix.length < 2) throw new Error('Control tag names need a shared prefix for the scanner.')
  return prefix
})()

/** The cue tag's `key: value` payload form, as its tolerant parser reads it (`batshitCue.ts`). */
const CUE_KEY_PAYLOAD_REGEX =
  /^["']?(?:goon_mood|goonmood|mood|goonmoodname|goon_cue|gooncue|goon_emote|goonemote|goon_motion|goonmotion|emote|motion)["']?\s*[:=]/i
const CUE_KEY_NAMES = [
  'goon_mood',
  'goonmood',
  'mood',
  'goonmoodname',
  'goon_cue',
  'gooncue',
  'goon_emote',
  'goonemote',
  'goon_motion',
  'goonmotion',
  'emote',
  'motion'
]

function isTagNameChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 95 ||
    code === 58
  )
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char)
}

/** ASCII letters lowered and nothing else, so every index stays where it was. */
function foldAsciiCase(text: string): string {
  return /[A-Z]/.test(text) ? text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()) : text
}

type PayloadStart = 'payload' | 'mention' | 'undecided'

/** Whether the folded text at `at` is `name`'s closing tag, the start of one, or neither. */
function closingTagAt(folded: string, name: string, at: number): 'closing' | 'partial' | 'no' {
  const closing = `</${name}>`
  let cursor = at
  let index = 0
  // Walk the closing tag's letters, allowing spaces after `</` and before `>`.
  while (index < closing.length) {
    if (cursor >= folded.length) return 'partial'
    const char = folded[cursor]
    if ((index === 2 || index === closing.length - 1) && isSpace(char)) {
      cursor += 1
      continue
    }
    if (char !== closing[index]) return 'no'
    cursor += 1
    index += 1
  }
  return 'closing'
}

/** Whether a cue payload's `key: value` form may still be being written at the text's end. */
function isPartialCueKey(tail: string): boolean {
  if (tail.length > 40) return false
  const unquoted = tail.replace(/^'/, '')
  return CUE_KEY_NAMES.some(
    (key) => key.startsWith(unquoted) || (unquoted.startsWith(key) && /^'?\s*$/.test(unquoted.slice(key.length)))
  )
}

/** R2: whether what follows an opening tag of `spec` (from `bodyStart`) starts its payload. */
function payloadStartAfter(folded: string, spec: ControlTagSpec, bodyStart: number): PayloadStart {
  let at = bodyStart
  while (isSpace(folded[at])) at += 1
  if (at >= folded.length) return 'undecided'
  const char = folded[at]
  if (char === '{') return 'payload'
  if (char === '<') {
    // No payload. A closed one (an empty block) is R2 (b)'s; the start of its own closing tag at
    // the text's end waits for more.
    return closingTagAt(folded, spec.tag, at) === 'partial' ? 'undecided' : 'mention'
  }
  if (spec.parse === 'json-tolerant') {
    if (char === '"') return 'payload'
    if (CUE_KEY_PAYLOAD_REGEX.test(folded.slice(at, at + 40))) return 'payload'
    if (isPartialCueKey(folded.slice(at))) return 'undecided'
  }
  return 'mention'
}

/**
 * R2 for a reader that sees a reply piece by piece (the realtime speech coordinator): whether what
 * follows an opening tag of `tagName` in `text` (from `bodyStart`, one past its `>`) starts the
 * tag's payload, names the tag in a sentence, or cannot tell yet because `text` ends first.
 */
export function controlTagPayloadStart(
  text: string,
  bodyStart: number,
  tagName: string
): 'payload' | 'mention' | 'undecided' {
  const spec = controlTagByName(tagName)
  if (!spec) return 'mention'
  return payloadStartAfter(foldAsciiCase(text), spec, bodyStart)
}

/**
 * R4 (strict, Faye 2026-09-27): the registered tag a start (from a `<` to the text's end, folded)
 * can still grow into, or null. No tag has attributes, so a start can grow into a tag only while it
 * is part of `<name` or `<name` then spaces. While the reply streams any such start is held. When it
 * has ended (`final`) only a bare cut start is hidden: it holds `<batshit-` in full and is then part
 * of a name at the very end, or a full name followed by spaces or nothing. A shorter start (`<`,
 * `<bat`) is text. Finished words are never cut.
 */
function heldStartSpec(candidate: string, final: boolean): ControlTagSpec | null {
  if (final && !candidate.startsWith(`<${TAG_NAME_PREFIX}`)) return null
  // Part of `<name` (a full name followed by spaces is read in the scan loop itself).
  return CONTROL_TAGS.find((spec) => `<${spec.tag}`.startsWith(candidate)) ?? null
}

type ControlBlockScan = {
  blocks: ControlBlock[]
  /** The paired blocks read, in order. */
  accepted: ControlBlock[]
  /** The code layout the scan read, or null when it needed none. */
  layout: CodeLayout | null
}

function scanControlBlocks(
  text: string,
  folded: string,
  options: FindControlBlocksOptions,
  givenLayout: CodeLayout | null
): ControlBlockScan {
  const blocks: ControlBlock[] = []
  let layout: CodeLayout | null = givenLayout
  const codeLayout = () => (layout ??= readCodeLayout(text))
  /** The paired blocks read so far, in order: their payloads are theirs, not Markdown. */
  const accepted: ControlBlock[] = []
  /** Whether `index` is inside a block read so far (a paired one) or hidden by an unclosed one. */
  const payloadAt = (index: number): boolean => {
    if (index >= hiddenFrom) return true
    const owner = lastBlockStartingAtOrBefore(accepted, index)
    return owner !== null && index < owner.end
  }
  /**
   * R1 for fenced and indented code, read on the whole text. A region that OPENS inside a block
   * already read is not code: it is payload, and the view never shows it, because the block is
   * hidden.
   */
  const inBlockCode = (index: number): boolean => {
    const region = codeRegionAt(codeLayout().blocks, index)
    return region !== null && !payloadAt(region.start)
  }
  /**
   * R1 for inline code (BL-701), read in this same left-to-right pass: a run of backticks inside
   * a block already read is payload, so it never opens a code span, and every pairing after the
   * block is the one the view draws once the block is hidden, however many blocks come before. A
   * lone backtick in a payload (a Tool Notes summary quoting `all'`) used to pair with a backtick
   * after the block, which turned the next real block into "code" (review, 2026-09-27) or an
   * inline-code example after it into a block (BL-700, BL-701).
   */
  let spans: CodeSpanReader | null = null
  const spanReader = () => (spans ??= new CodeSpanReader(codeLayout().runs, payloadAt))
  const inCode = (index: number): boolean => inBlockCode(index) || spanReader().covers(index)
  const heldStart = (spec: ControlTagSpec, at: number): ControlBlock => ({
    id: spec.id,
    tag: spec.tag,
    kind: 'held-start',
    start: at,
    end: text.length,
    bodyStart: text.length,
    bodyEnd: text.length
  })
  /** Tags with an unclosed block: a later opening tag of the same name is part of it. */
  const brokenTags = new Set<ControlTagId>()
  /** Where the next candidate is looked for: past every paired block read so far. */
  let scanFrom = 0
  /** Everything from here on is hidden by an unclosed block. */
  let hiddenFrom = Number.POSITIVE_INFINITY
  const candidatePrefix = `<${TAG_NAME_PREFIX}`
  // Every closing tag and every opening-tag start of each registered name, in order, read once
  // when first needed: a block's closing tag and R2 (b)'s "no other opening tag between" are then
  // binary searches, never a search of the rest of the text per tag.
  let index: { closings: Map<string, Array<{ start: number; end: number }>>; openers: Map<string, number[]> } | null =
    null
  const tagIndex = () => (index ??= indexTags(folded))

  for (let at = folded.indexOf(candidatePrefix); at >= 0; at = folded.indexOf(candidatePrefix, scanFrom)) {
    scanFrom = at + 1
    let nameEnd = at + 1
    while (nameEnd < folded.length && isTagNameChar(folded.charCodeAt(nameEnd))) nameEnd += 1
    if (nameEnd >= folded.length) {
      // The name runs to the text's end: the held-start check below decides.
      scanFrom = at
      break
    }
    const spec = controlTagByName(folded.slice(at + 1, nameEnd))
    if (!spec || brokenTags.has(spec.id)) continue
    // An opening tag is its name, then spaces or nothing, then `>`: no tag has attributes (R4
    // strict), so an opening tag never runs on over other words.
    let closeAngle = nameEnd
    while (isSpace(folded[closeAngle])) closeAngle += 1
    if (closeAngle >= folded.length) {
      // The full name, then only spaces, to the text's end: a bare cut start (R4), held while the
      // reply streams and hidden at its end, with no error. Nothing after it can be a tag.
      if (at < hiddenFrom && !inCode(at)) blocks.push(heldStart(spec, at))
      return { blocks, accepted, layout }
    }
    if (folded[closeAngle] !== '>') continue
    if (inCode(at)) continue
    const bodyStart = closeAngle + 1
    const payload = payloadStartAfter(folded, spec, bodyStart)
    if (payload === 'undecided') {
      // Only spaces or a partial payload start follow, to the text's end: held while the reply
      // streams. At the end it is text: a full name followed by anything but spaces (R4 strict).
      if (!options.final && at < hiddenFrom) blocks.push(heldStart(spec, at))
      return { blocks, accepted, layout }
    }
    const { closings, openers } = tagIndex()
    const closingsOfTag = closings.get(spec.tag) ?? []
    if (payload === 'mention') {
      // R2 (b): its own closing tag comes after it (outside code), and no other opening tag of
      // the same kind stands between them: a block with a bad payload (hidden, a loud error).
      // What lies between is read as Markdown, ahead of the scan, by a fork of the span reader:
      // only up to the next opening tag of this kind, so the read-aheads stay linear.
      const nextOpener = firstAfter(openers.get(spec.tag) ?? [], at + 1)
      const limit = nextOpener < 0 ? Number.POSITIVE_INFINITY : nextOpener
      let ahead: CodeSpanReader | null = null
      let closing: { start: number; end: number } | null = null
      for (let at2 = firstIndexAtOrAfter(closingsOfTag, bodyStart); at2 < closingsOfTag.length; at2 += 1) {
        const candidate = closingsOfTag[at2]
        if (candidate.start >= limit) break
        if (!inBlockCode(candidate.start) && !(ahead ??= spanReader().fork()).covers(candidate.start)) {
          closing = candidate
          break
        }
      }
      if (!closing) continue
      const block: ControlBlock = { id: spec.id, tag: spec.tag, kind: 'paired', start: at, end: closing.end, bodyStart, bodyEnd: closing.start }
      blocks.push(block)
      accepted.push(block)
      scanFrom = closing.end
      continue
    }
    // R2 (a): its payload comes next; the block runs to the first closing tag of its name.
    const closingAt = firstIndexAtOrAfter(closingsOfTag, bodyStart)
    const closing = closingAt < closingsOfTag.length ? closingsOfTag[closingAt] : null
    if (!closing) {
      blocks.push({ id: spec.id, tag: spec.tag, kind: 'unclosed', start: at, end: text.length, bodyStart, bodyEnd: text.length })
      brokenTags.add(spec.id)
      hiddenFrom = Math.min(hiddenFrom, at)
      scanFrom = bodyStart
      continue
    }
    const block: ControlBlock = { id: spec.id, tag: spec.tag, kind: 'paired', start: at, end: closing.end, bodyStart, bodyEnd: closing.start }
    blocks.push(block)
    accepted.push(block)
    scanFrom = closing.end
  }

  // R4: a last `<` that can still become an opening tag: held while the reply streams; at the end,
  // hidden only when it holds `<batshit-` in full (a cut block), otherwise text.
  const lastOpen = folded.lastIndexOf('<')
  if (lastOpen >= scanFrom && lastOpen < hiddenFrom) {
    const spec = heldStartSpec(folded.slice(lastOpen), options.final)
    if (spec && !inCode(lastOpen)) blocks.push(heldStart(spec, lastOpen))
  }
  return { blocks, accepted, layout }
}

/**
 * Every control block of `text`, as BL-442's rules read them (see above).
 *
 * Inline code is paired in the scan's own left-to-right pass, so a backtick inside a block's payload
 * never pairs with a backtick after the block, however many such blocks come before (BL-700,
 * BL-701): an inline-code example after a block ("the syntax is
 * `<batshit-memory>{…}</batshit-memory>`") stays code. Two things the pass cannot see from where it
 * stands are left to one rescan (BL-700's): fenced code comes from `marked`'s block lexer on the text
 * as written (a ``` line in a payload opens a fence there), and R2 (b) reads what lies between a
 * mention and its closing tag before the blocks inside it are read. So when a code region of the text
 * as written opens inside a block the scan read, the backticks inside the blocks read are blanked, the
 * text is lexed once more, and scanned again. At most two scans and two lexes: linear, however many
 * blocks there are.
 */
export function findControlBlocks(text: string, options: FindControlBlocksOptions): ControlBlock[] {
  if (!text) return []
  const folded = foldAsciiCase(text)
  const first = scanControlBlocks(text, folded, options, null)
  const layout = first.layout
  if (!layout) return first.blocks
  if (!codeOpensInsideBlocks(layout.blocks, first.accepted) && !codeOpensInsideBlocks(pairCodeSpans(layout.runs), first.accepted)) {
    return first.blocks
  }
  return scanControlBlocks(text, folded, options, readCodeLayout(blankBackticksInside(text, first.accepted))).blocks
}

/** Whether any of `regions` opens inside one of `blocks` (both in order). */
function codeOpensInsideBlocks(regions: readonly CodeRegion[], blocks: readonly ControlBlock[]): boolean {
  let block = 0
  for (const region of regions) {
    while (block < blocks.length && blocks[block].end <= region.start) block += 1
    if (block < blocks.length && blocks[block].start <= region.start) return true
  }
  return false
}

/** `text` with every backtick inside `blocks` replaced by a plain letter (same length). */
function blankBackticksInside(text: string, blocks: readonly ControlBlock[]): string {
  const parts: string[] = []
  let cursor = 0
  for (const block of blocks) {
    parts.push(text.slice(cursor, block.start), text.slice(block.start, block.end).replace(/`/g, 'x'))
    cursor = block.end
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

/** The closing tags (`</name>`, spaces allowed inside) and opening-tag starts (`<name` + boundary) of every registered name. */
function indexTags(folded: string): {
  closings: Map<string, Array<{ start: number; end: number }>>
  openers: Map<string, number[]>
} {
  const closings = new Map<string, Array<{ start: number; end: number }>>()
  const openers = new Map<string, number[]>()
  const closePrefix = TAG_NAME_PREFIX
  for (let at = folded.indexOf('</'); at >= 0; at = folded.indexOf('</', at + 2)) {
    let cursor = at + 2
    while (isSpace(folded[cursor])) cursor += 1
    if (!folded.startsWith(closePrefix, cursor)) continue
    let nameEnd = cursor
    while (nameEnd < folded.length && isTagNameChar(folded.charCodeAt(nameEnd))) nameEnd += 1
    const spec = controlTagByName(folded.slice(cursor, nameEnd))
    if (!spec) continue
    let end = nameEnd
    while (isSpace(folded[end])) end += 1
    if (folded[end] !== '>') continue
    const list = closings.get(spec.tag)
    const entry = { start: at, end: end + 1 }
    if (list) list.push(entry)
    else closings.set(spec.tag, [entry])
  }
  const openPrefix = `<${TAG_NAME_PREFIX}`
  for (let at = folded.indexOf(openPrefix); at >= 0; at = folded.indexOf(openPrefix, at + 1)) {
    let nameEnd = at + 1
    while (nameEnd < folded.length && isTagNameChar(folded.charCodeAt(nameEnd))) nameEnd += 1
    const spec = controlTagByName(folded.slice(at + 1, nameEnd))
    const boundary = folded[nameEnd]
    if (!spec || (boundary !== undefined && boundary !== '>' && boundary !== '/' && !isSpace(boundary))) continue
    const list = openers.get(spec.tag)
    if (list) list.push(at)
    else openers.set(spec.tag, [at])
  }
  return { closings, openers }
}

/** The last of `blocks` (in order) that starts at or before `index`, or null. */
function lastBlockStartingAtOrBefore(blocks: readonly ControlBlock[], index: number): ControlBlock | null {
  let low = 0
  let high = blocks.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (blocks[mid].start <= index) low = mid + 1
    else high = mid
  }
  return low > 0 ? blocks[low - 1] : null
}

/** The first position in `sorted` at or after `from`, or -1. */
function firstAfter(sorted: readonly number[], from: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sorted[mid] < from) low = mid + 1
    else high = mid
  }
  return low < sorted.length ? sorted[low] : -1
}

/** The index of the first entry starting at or after `from` (`entries.length` when none). */
function firstIndexAtOrAfter(entries: ReadonlyArray<{ start: number }>, from: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (entries[mid].start < from) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * `text` without the given blocks' ranges (their union: a block inside an unclosed block's range
 * goes with it). `blocks` must be in order, as `findControlBlocks` returns them.
 */
export function removeControlBlocks(text: string, blocks: readonly ControlBlock[]): string {
  if (blocks.length === 0) return text
  const kept: string[] = []
  let cursor = 0
  for (const block of blocks) {
    if (block.start >= cursor) {
      kept.push(text.slice(cursor, block.start))
      cursor = block.end
    } else if (block.end > cursor) {
      cursor = block.end
    }
  }
  kept.push(text.slice(cursor))
  return kept.join('')
}

/**
 * One entry in a message's `metadata.controlErrors` — the machine-readable half
 * of the DL-104-05 loud-failure surface. The next turn's compile reads these and
 * inserts a correction line so the agent can retry.
 */
export interface ControlErrorRecord {
  tag: string
  error: string
  hint?: string
  at: string
  /**
   * SA-116 P3 (DL-116-08). `tag` (the default) is a malformed control block in the agent's
   * own output. `approval` is the user answering a pending approval card — not a mistake
   * the agent made, and it rides the same one-turn channel because it is the same job:
   * tell the agent once, on its next turn, what happened while it was not looking.
   */
  kind?: 'tag' | 'approval'
}

export function buildControlErrorRecord(
  tag: string,
  error: string,
  hint?: string
): ControlErrorRecord {
  return {
    tag,
    error,
    ...(hint ? { hint } : {}),
    at: new Date().toISOString()
  }
}

/**
 * The one-turn line a DENIED approval leaves behind (SA-116 DL-116-08).
 *
 * Deny starts no turn — the agent already said what it wanted to do and stopped — so this
 * is how it learns the answer: on its next turn, once, and with "do not retry it" said
 * plainly, because the alternative is an agent asking for the same thing again.
 *
 * **No clock time in the sentence** (PR #106 review F-17). It used to carry
 * `decidedAt`'s UTC `HH:MM`, unlabelled — so a user in `America/Chicago` who denied at
 * 09:32 had the agent told "(14:32)" and repeated that back to them. Every other
 * agent-facing instant in this product is rendered in the user's own zone, and this one
 * had no zone to render in at the point it is built. It is also the one detail the model
 * cannot use: `buildControlErrorDcmLines` reads the MOST RECENT assistant message only, so
 * the DCM's position already says "this just happened". The machine-readable `at` stays on
 * the record (full ISO) for anything that needs the instant.
 */
export function buildControlDenialRecord(
  controlTitle: string,
  decidedAt?: string
): ControlErrorRecord {
  const at =
    typeof decidedAt === 'string' && decidedAt.trim() ? decidedAt.trim() : new Date().toISOString()
  return {
    tag: 'approval',
    kind: 'approval',
    error: `Denied by the user: ${controlTitle} — do not retry it.`,
    at
  }
}

/**
 * Next-turn surfacing (DL-104-05): correction lines for the DCM, read from the
 * MOST RECENT assistant message only — control errors are one-turn correction
 * hints, not persistent state. The compilation path calls this with its message list.
 */
export function buildControlErrorDcmLines(
  messages: Array<{ role?: string; metadata?: Record<string, any> | null }>
): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    const errors = Array.isArray(message?.metadata?.controlErrors)
      ? (message.metadata!.controlErrors as ControlErrorRecord[])
      : []
    if (errors.length === 0) return []
    // Two kinds share this channel and must not share a heading: a malformed control block
    // is the agent's own mistake, and a denied approval is the user's answer. Telling an
    // agent its approval was "a malformed control block" would send it looking for a bug
    // in its own output.
    const tagErrors = errors.filter((entry) => entry?.kind !== 'approval')
    const approvalErrors = errors.filter((entry) => entry?.kind === 'approval')
    const lines: string[] = []
    if (tagErrors.length > 0) {
      lines.push('control_errors (your previous response had malformed control blocks):')
      for (const entry of tagErrors.slice(0, 4)) {
        const tag = typeof entry?.tag === 'string' ? entry.tag : 'unknown'
        const error = typeof entry?.error === 'string' ? entry.error : 'malformed control block'
        const hint = typeof entry?.hint === 'string' && entry.hint ? ` | fix: ${entry.hint}` : ''
        lines.push(`- <${tag}>: ${error}${hint}`)
      }
    }
    if (approvalErrors.length > 0) {
      lines.push('control_errors (the user answered a pending approval):')
      for (const entry of approvalErrors.slice(0, 4)) {
        const error = typeof entry?.error === 'string' ? entry.error : 'the user answered an approval'
        lines.push(`- ${error}`)
      }
    }
    return lines
  }
  return []
}
