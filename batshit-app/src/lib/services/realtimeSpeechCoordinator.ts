import type { VoiceConfig } from '$lib/services/voice'
import type { VoiceSettings } from '$lib/types/voice'
import {
  PLAIN_CONTROL_SECTION_TAGS,
  controlTagPayloadStart,
  findControlBlocks,
  realtimeHiddenTagNames,
  realtimeHiddenTagOpenPrefixes,
  removeControlBlocks
} from '$lib/utils/controlTags'
import { splitRealtimeSpeechBuffer } from '$lib/utils/realtimeSpeechChunker'
import type { SpeakableTextOptions } from '$lib/utils/speakableText'

export type RealtimeSpeechMetadata = Record<string, any>

type RealtimeSpeechSession = {
  messageId: string
  sessionId: string | null
  agentId: string | null
  voice?: VoiceConfig
  buffer: string
  chunkIndex: number
  spokeChunks: boolean
  hiddenControlTagName: string | null
  hiddenControlBlockBuffer: string
  pendingGoonControlBlocks: string[]
  pendingHiddenControlOpener: string
  hiddenPlainControlSection: boolean
  /** The whole reply so far, as it streamed (BL-442: where code is, and the end-of-reply check). */
  rawText: string
  /** Where in `rawText` the hidden block still open began, or -1. */
  hiddenBlockStart: number
  speakableTextOptions?: SpeakableTextOptions
  flushTimer: ReturnType<typeof setTimeout> | null
  controlDispatchIndex: number
}

export type RealtimeSpeechCoordinatorOptions = {
  latencyFlushMs?: number
  forceMinSpeakableChars?: number
  getCurrentSessionId: () => string | null
  isSpeechRequested: (metadata: RealtimeSpeechMetadata | null | undefined) => boolean
  resolveVoiceConfig: (metadata: RealtimeSpeechMetadata, agentId: string | null) => VoiceConfig | undefined
  resolveSpeakableTextOptions?: (
    metadata: RealtimeSpeechMetadata,
    agentId: string | null
  ) => SpeakableTextOptions
  usesRealtimeTts: (voice?: VoiceConfig) => boolean
  willSpeakText: (text: string, options?: { manual?: boolean; agentId?: string | null }) => boolean
  speak: (
    text: string,
    options: {
      voice?: VoiceConfig
      voiceSettings?: VoiceSettings
      agentId?: string | null
      messageId?: string | null
      manual?: boolean
    }
  ) => void | Promise<void>
  dispatchGoonSpeechMessage: (
    messageId: string,
    agentId: string | null | undefined,
    content: string,
    speechPlanned: boolean
  ) => void
  stopAll: () => void
}

const DEFAULT_LATENCY_FLUSH_MS = 900
const DEFAULT_FORCE_MIN_SPEAKABLE_CHARS = 48
// Registry-driven (SA-104 P1): registering a control tag in
// `$lib/utils/controlTags` automatically extends the realtime hold-back —
// partial `<batshit-*` prefixes and open blocks are withheld from the speech
// chunker until the tag resolves.
const HIDDEN_CONTROL_TAGS = new Set(realtimeHiddenTagNames())
const HIDDEN_CONTROL_TAG_OPEN_PREFIXES = realtimeHiddenTagOpenPrefixes()
/** The plain tool-results spellings: not registered tags, so they keep their old hold (no R2). */
const PLAIN_CONTROL_SECTION_TAG_SET = new Set(PLAIN_CONTROL_SECTION_TAGS)
const PLAIN_CONTROL_SECTION_PATTERN = /(^|\n)\s*#{0,6}\s*tool results summary\b[^\n]*(?:\n|$)/i

type HiddenControlOpener =
  | { type: 'partial'; index: number }
  | { type: 'open'; index: number; endIndex: number; tagName: string; selfClosing: boolean }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isHiddenControlTag(tagName: string): boolean {
  return HIDDEN_CONTROL_TAGS.has(tagName.toLowerCase())
}

function isGoonControlTag(tagName: string | null | undefined): boolean {
  return tagName?.toLowerCase() === 'batshit-cue'
}

function pushPendingGoonControlBlock(session: RealtimeSpeechSession, block: string): void {
  const trimmed = block.trim()
  if (!trimmed) return
  session.pendingGoonControlBlocks.push(trimmed)
}

function consumePendingGoonControlBlocks(session: RealtimeSpeechSession): string {
  if (session.pendingGoonControlBlocks.length === 0) return ''
  const blocks = session.pendingGoonControlBlocks.join('\n')
  session.pendingGoonControlBlocks = []
  return blocks
}

function normalizeControlPrefix(value: string): string {
  return value.toLowerCase().replace(/^<\s+/, '<')
}

/**
 * Whether a piece of text with no `>` after it may still become an opening tag: part of `<name`,
 * or `<name` then spaces. No tag has attributes (R4 strict), so a name followed by words is text.
 */
function isPotentialHiddenControlPrefix(value: string): boolean {
  const normalized = normalizeControlPrefix(value)
  return HIDDEN_CONTROL_TAG_OPEN_PREFIXES.some(
    (prefix) =>
      prefix.startsWith(normalized) ||
      (normalized.startsWith(prefix) && /^\s+$/.test(normalized.slice(prefix.length)))
  )
}

/**
 * The next hidden control tag in a piece of streamed text: an opening tag, or a partial one the
 * piece ends in. A lone `<` ("x < 5") is text, and a tag may still start after it (BL-477). One
 * pass: the next `>` is remembered across the `<`s, a stretch with another `<` before its `>` is
 * no tag, and a partial tag is judged on its first characters only.
 */
/** Exported for its one-pass test. */
export function findNextHiddenControlOpener(text: string): HiddenControlOpener | null {
  let searchIndex = 0
  let nextClose = -2

  while (searchIndex < text.length) {
    const index = text.indexOf('<', searchIndex)
    if (index === -1) return null

    if (nextClose !== -1 && nextClose <= index) nextClose = text.indexOf('>', index + 1)
    if (nextClose === -1) {
      if (isPotentialHiddenControlPrefix(text.slice(index, index + 256))) return { type: 'partial', index }
      searchIndex = index + 1
      continue
    }

    // Another `<` before the `>`: no tag starts here.
    const nextOpen = text.indexOf('<', index + 1)
    if (nextOpen !== -1 && nextOpen < nextClose) {
      searchIndex = nextOpen
      continue
    }

    const tagSource = text.slice(index, nextClose + 1)
    const match = /^<\s*([a-z][a-z0-9:_-]*)\b/i.exec(tagSource)
    const tagName = match?.[1]?.toLowerCase()
    if (tagName && isHiddenControlTag(tagName)) {
      return {
        type: 'open',
        index,
        endIndex: nextClose + 1,
        tagName,
        selfClosing: /\/\s*>$/.test(tagSource)
      }
    }

    searchIndex = nextClose + 1
  }

  return null
}

function findClosingHiddenControlTag(text: string, tagName: string): { index: number; endIndex: number } | null {
  const pattern = new RegExp(`<\\/\\s*${escapeRegExp(tagName)}\\s*>`, 'i')
  const match = pattern.exec(text)
  if (!match) return null
  return { index: match.index, endIndex: match.index + match[0].length }
}

/**
 * BL-699: where a closing tag that the text's end cut in two starts (`<`, `</`,
 * `</batshit-c`, `</batshit-cue `), or -1. The rest arrives with the next chunk, so this tail is
 * held and put in front of it; thrown away, it left the block open for good, and the rest of the
 * reply was never spoken (and a cue never fired).
 */
function partialClosingTagStart(text: string): number {
  const at = text.lastIndexOf('<')
  // Only the shape of a closing tag's start is held; held text inside a hidden block is part of it
  // anyway, so a tail that is not this tag's closing tag costs nothing.
  return at >= 0 && /^<(?:\/\s*[a-z0-9:_-]*\s*)?$/i.test(text.slice(at)) ? at : -1
}

function findPlainControlSectionEnd(text: string): number | null {
  const blankLine = /\n\s*\n/.exec(text)
  if (blankLine) return blankLine.index + blankLine[0].length
  return null
}

/**
 * Withholds the control blocks from a chunk of a streaming reply before it reaches the speech
 * chunker. BL-442: an opening tag hides what follows only when it is a real block: its payload
 * comes next (R2; a tag named in a sentence is spoken as words are, and the speech text step
 * removes the tag itself, R5) and it is not in code (R1, read on the whole reply so far). A tag
 * whose next words have not arrived yet is held for the next chunk, and a held start that never
 * became a tag is spoken at the end (R4, `finish`).
 */
/**
 * Whether a backtick run is still open (no closing run of the same length) in `paragraph`, the
 * text from the start of the paragraph to an opening tag. Such a tag may yet turn out to be inline
 * code when the closing backtick arrives in a later chunk.
 */
function hasOpenBacktickRun(paragraph: string): boolean {
  let open = 0
  for (let at = paragraph.indexOf('`'); at >= 0; at = paragraph.indexOf('`', at)) {
    let end = at
    while (paragraph[end] === '`') end += 1
    let length = end - at
    if (open === 0) {
      let slashes = 0
      for (let before = at - 1; before >= 0 && paragraph[before] === '\\'; before -= 1) slashes += 1
      if (slashes % 2 === 1) length -= 1
      open = length
    } else if (length === open) {
      open = 0
    }
    at = end
  }
  return open > 0
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/

/** The text of the paragraph that holds `index` in `text`, up to `index` (at most 4,000 characters back). */
function paragraphBefore(text: string, index: number): string {
  const from = Math.max(0, index - 4000)
  const window = text.slice(from, index)
  let start = 0
  for (const match of window.matchAll(/\n[ \t]*\n/g)) start = (match.index ?? 0) + match[0].length
  return window.slice(start)
}

function stripRealtimeHiddenControls(session: RealtimeSpeechSession, chunkText: string, final = false): string {
  let text = `${session.pendingHiddenControlOpener}${chunkText}`
  // Where `text` starts in the whole reply: the held opener is the tail of what came before.
  let textStart = session.rawText.length - session.pendingHiddenControlOpener.length
  session.rawText += chunkText
  session.pendingHiddenControlOpener = ''
  let output = ''
  // BL-442: whether a block starts here, as the registry's scanner reads the whole reply so far.
  // It reads code itself (R1), and knows that a backtick inside an earlier block's payload is
  // payload, so a lone backtick there cannot turn this block into code (review, 2026-09-27).
  let scanned: ReturnType<typeof findControlBlocks> | null = null
  const isRealBlockStart = (index: number) =>
    (scanned ??= findControlBlocks(session.rawText, { final: false })).some((block) => block.start === index)
  const advance = (count: number) => {
    text = text.slice(count)
    textStart += count
  }

  while (text.length > 0) {
    if (session.hiddenControlTagName) {
      const tagName = session.hiddenControlTagName
      const closing = findClosingHiddenControlTag(text, tagName)
      if (!closing) {
        // Hold a closing tag the chunk's end cut in two: the next chunk completes it (BL-699).
        const cut = partialClosingTagStart(text)
        const kept = cut < 0 ? text : text.slice(0, cut)
        if (cut >= 0) session.pendingHiddenControlOpener = text.slice(cut)
        if (isGoonControlTag(tagName)) {
          session.hiddenControlBlockBuffer += kept
        }
        return output
      }
      if (isGoonControlTag(tagName)) {
        pushPendingGoonControlBlock(
          session,
          `${session.hiddenControlBlockBuffer}${text.slice(0, closing.endIndex)}`
        )
      }
      advance(closing.endIndex)
      session.hiddenControlTagName = null
      session.hiddenControlBlockBuffer = ''
      session.hiddenBlockStart = -1
      continue
    }

    if (session.hiddenPlainControlSection) {
      const sectionEnd = findPlainControlSectionEnd(text)
      if (sectionEnd === null) return output
      advance(sectionEnd)
      session.hiddenPlainControlSection = false
      continue
    }

    const plainSectionMatch = PLAIN_CONTROL_SECTION_PATTERN.exec(text)
    const opener = findNextHiddenControlOpener(text)
    const openerIndex = opener?.index ?? Number.POSITIVE_INFINITY
    const plainSectionIndex = plainSectionMatch
      ? plainSectionMatch.index + (plainSectionMatch[1] ? plainSectionMatch[1].length : 0)
      : Number.POSITIVE_INFINITY

    if (!opener && !plainSectionMatch) {
      output += text
      break
    }

    if (plainSectionIndex <= openerIndex) {
      output += text.slice(0, plainSectionIndex)
      const sectionEndIndex =
        (plainSectionMatch?.index ?? 0) + (plainSectionMatch?.[0]?.length ?? 0)
      const sectionRemainder = text.slice(sectionEndIndex)
      const sectionEnd = findPlainControlSectionEnd(sectionRemainder)
      if (sectionEnd === null) {
        session.hiddenPlainControlSection = true
        break
      }
      advance(sectionEndIndex + sectionEnd)
      continue
    }

    if (opener?.type === 'partial') {
      output += text.slice(0, opener.index)
      session.pendingHiddenControlOpener = text.slice(opener.index)
      break
    }

    if (opener?.type === 'open') {
      output += text.slice(0, opener.index)
      if (opener.selfClosing) {
        if (isGoonControlTag(opener.tagName)) {
          pushPendingGoonControlBlock(session, text.slice(opener.index, opener.endIndex))
        }
        advance(opener.endIndex)
        continue
      }

      // R2: the tag's payload must come next; R1: a tag in code does nothing.
      const payload = PLAIN_CONTROL_SECTION_TAG_SET.has(opener.tagName)
        ? 'payload'
        : controlTagPayloadStart(text, opener.endIndex, opener.tagName)
      if (payload === 'undecided') {
        session.pendingHiddenControlOpener = text.slice(opener.index)
        break
      }
      const isPlainSection = PLAIN_CONTROL_SECTION_TAG_SET.has(opener.tagName)
      if (!isPlainSection && (payload === 'mention' || !isRealBlockStart(textStart + opener.index))) {
        output += text.slice(opener.index, opener.endIndex)
        advance(opener.endIndex)
        continue
      }
      // A backtick still open before it in its paragraph: the closing one may arrive in the next
      // chunk and make this an example in inline code, which must never fire a cue or be hidden.
      // Hold it until that backtick closes, the paragraph ends, or the reply does (review).
      if (
        !isPlainSection &&
        !final &&
        hasOpenBacktickRun(paragraphBefore(session.rawText, textStart + opener.index)) &&
        !PARAGRAPH_BREAK.test(text.slice(opener.endIndex))
      ) {
        session.pendingHiddenControlOpener = text.slice(opener.index)
        break
      }

      const afterOpen = text.slice(opener.endIndex)
      const closing = findClosingHiddenControlTag(afterOpen, opener.tagName)
      if (!closing) {
        session.hiddenControlTagName = opener.tagName
        session.hiddenBlockStart = textStart + opener.index
        // Hold a closing tag the chunk's end cut in two: the next chunk completes it (BL-699).
        const cut = partialClosingTagStart(afterOpen)
        const keptEnd = cut < 0 ? text.length : opener.endIndex + cut
        if (cut >= 0) session.pendingHiddenControlOpener = afterOpen.slice(cut)
        session.hiddenControlBlockBuffer = isGoonControlTag(opener.tagName)
          ? text.slice(opener.index, keptEnd)
          : ''
        break
      }

      if (isGoonControlTag(opener.tagName)) {
        pushPendingGoonControlBlock(
          session,
          text.slice(opener.index, opener.endIndex + closing.endIndex)
        )
      }
      advance(opener.endIndex + closing.endIndex)
    }
  }

  return output
}

/**
 * The end of the reply (R4, R3): a held start that never became a tag is spoken, and a block that
 * never closed is checked against the finished reply. A real block left open stays silent; one the
 * finished reply does not count as a block (a tag in inline code whose closing backtick came
 * later) is spoken, without the real blocks after it.
 */
function releaseHeldControlText(session: RealtimeSpeechSession): string {
  // While a block is still open, what is held is part of it (a cut closing tag, BL-699): the
  // block's own check below decides whether any of it is spoken.
  const pending = session.hiddenControlTagName ? '' : session.pendingHiddenControlOpener
  session.pendingHiddenControlOpener = ''
  let blocks: ReturnType<typeof findControlBlocks> | null = null
  const finishedBlocks = () => (blocks ??= findControlBlocks(session.rawText, { final: true }))
  // R4: a held start is spoken unless it holds `<batshit-` in full (the start of a cut block,
  // which the finished reply hides) or the full start of a plain tool-results section tag.
  const pendingStart = session.rawText.length - pending.length
  const cutBlock =
    pending.length > 0 &&
    (finishedBlocks().some((block) => block.kind === 'held-start' && block.start === pendingStart) ||
      /^<\s*tool[-_]/i.test(pending))
  let released = cutBlock ? '' : pending
  if (session.hiddenControlTagName && session.hiddenBlockStart >= 0) {
    const start = session.hiddenBlockStart
    const blocks = finishedBlocks()
    if (!blocks.some((block) => block.start === start)) {
      const later = blocks
        .filter((block) => block.start >= start)
        .map((block) => ({ ...block, start: block.start - start, end: block.end - start }))
      released = `${removeControlBlocks(session.rawText.slice(start), later)}${released}`
      session.hiddenControlTagName = null
      session.hiddenControlBlockBuffer = ''
      session.hiddenBlockStart = -1
    }
  }
  return released
}

export function buildRealtimeSpeechChunkId(messageId: string, chunkIndex: number): string {
  return `${messageId}:realtime-tts:${chunkIndex}`
}

export class RealtimeSpeechCoordinator {
  private readonly sessions = new Map<string, RealtimeSpeechSession>()
  private readonly latencyFlushMs: number
  private readonly forceMinSpeakableChars: number

  constructor(private readonly options: RealtimeSpeechCoordinatorOptions) {
    this.latencyFlushMs = Math.max(0, options.latencyFlushMs ?? DEFAULT_LATENCY_FLUSH_MS)
    this.forceMinSpeakableChars = Math.max(
      1,
      options.forceMinSpeakableChars ?? DEFAULT_FORCE_MIN_SPEAKABLE_CHARS
    )
  }

  append(
    messageId: string,
    agentId: string | null,
    metadata: RealtimeSpeechMetadata,
    chunkText: string
  ): void {
    if (!this.options.isSpeechRequested(metadata)) return

    const voice = this.options.resolveVoiceConfig(metadata, agentId)
    if (!this.options.usesRealtimeTts(voice)) return

    const session = this.getSession(messageId, agentId, voice)
    session.speakableTextOptions = this.options.resolveSpeakableTextOptions?.(metadata, agentId)
    session.buffer += stripRealtimeHiddenControls(session, chunkText)

    const split = splitRealtimeSpeechBuffer(session.buffer, {
      speakableTextOptions: session.speakableTextOptions
    })
    session.buffer = split.remainder
    split.chunks.forEach((rawChunk) => this.speakChunk(session, rawChunk))
    this.scheduleLatencyFlush(session)
  }

  async finish(
    messageId: string,
    agentId: string | null,
    metadata: RealtimeSpeechMetadata
  ): Promise<boolean> {
    const session = this.sessions.get(messageId)
    if (!session) return false
    if (session.sessionId !== this.options.getCurrentSessionId()) {
      this.cancel(messageId)
      return false
    }

    session.agentId = agentId
    session.voice = this.options.resolveVoiceConfig(metadata, agentId)
    session.speakableTextOptions = this.options.resolveSpeakableTextOptions?.(metadata, agentId)
    this.clearFlushTimer(session)
    // A block held for an open backtick is decided now: the reply is over (review).
    session.buffer += stripRealtimeHiddenControls(session, '', true)
    session.buffer += releaseHeldControlText(session)

    const split = splitRealtimeSpeechBuffer(session.buffer, {
      final: true,
      speakableTextOptions: session.speakableTextOptions
    })
    session.buffer = split.remainder
    split.chunks.forEach((rawChunk) => this.speakChunk(session, rawChunk))
    this.dispatchPendingGoonControls(session)
    this.sessions.delete(messageId)
    return session.spokeChunks
  }

  cancel(messageId?: string | null): void {
    if (messageId) {
      const session = this.sessions.get(messageId)
      if (session) this.clearFlushTimer(session)
      this.sessions.delete(messageId)
      return
    }

    this.sessions.forEach((session) => this.clearFlushTimer(session))
    this.sessions.clear()
  }

  /**
   * BL-759: a managed lane took the end of this reply back (Codex lost its connection mid-answer
   * and started the answer again): `removedText` went, and the reply now reads `content`. What was
   * handed to the voice is spoken and stays spoken. Of what still waits here, the words taken back
   * go: when the waiting words end with them, only they go (a finished message's last words before
   * them are still spoken); when they lie inside them, or the words cannot be told apart (a hidden
   * control block in them, or no `removedText`), everything waiting goes. Speech goes on with the
   * words that come next.
   */
  discardUnspoken(messageId: string, content: string, removedText: string | null = null): void {
    const session = this.sessions.get(messageId)
    if (!session) return
    this.clearFlushTimer(session)
    const keepsBefore =
      Boolean(removedText) &&
      !session.hiddenControlTagName &&
      !session.pendingHiddenControlOpener &&
      session.buffer.endsWith(removedText as string)
    session.buffer = keepsBefore ? session.buffer.slice(0, session.buffer.length - (removedText as string).length) : ''
    session.hiddenControlTagName = null
    session.hiddenControlBlockBuffer = ''
    session.pendingGoonControlBlocks = []
    session.pendingHiddenControlOpener = ''
    session.hiddenPlainControlSection = false
    session.hiddenBlockStart = -1
    session.rawText = content
    if (session.buffer.trim()) this.scheduleLatencyFlush(session)
  }

  stopPlayback(messageId?: string | null): void {
    this.cancel(messageId)
    this.options.stopAll()
  }

  get size(): number {
    return this.sessions.size
  }

  private getSession(
    messageId: string,
    agentId: string | null,
    voice?: VoiceConfig
  ): RealtimeSpeechSession {
    const existing = this.sessions.get(messageId)
    if (existing) {
      existing.sessionId = this.options.getCurrentSessionId()
      existing.agentId = agentId
      existing.voice = voice
      return existing
    }

    const session: RealtimeSpeechSession = {
      messageId,
      sessionId: this.options.getCurrentSessionId(),
      agentId,
      voice,
      buffer: '',
      chunkIndex: 0,
      spokeChunks: false,
      hiddenControlTagName: null,
      hiddenControlBlockBuffer: '',
      pendingGoonControlBlocks: [],
      pendingHiddenControlOpener: '',
      hiddenPlainControlSection: false,
      rawText: '',
      hiddenBlockStart: -1,
      speakableTextOptions: undefined,
      flushTimer: null,
      controlDispatchIndex: 0
    }
    this.sessions.set(messageId, session)
    return session
  }

  private clearFlushTimer(session: RealtimeSpeechSession): void {
    if (!session.flushTimer) return
    clearTimeout(session.flushTimer)
    session.flushTimer = null
  }

  private scheduleLatencyFlush(session: RealtimeSpeechSession): void {
    this.clearFlushTimer(session)
    if (!session.buffer.trim()) return

    session.flushTimer = setTimeout(() => {
      session.flushTimer = null
      if (this.sessions.get(session.messageId) !== session) return
      if (session.sessionId !== this.options.getCurrentSessionId()) {
        this.cancel(session.messageId)
        return
      }

      const split = splitRealtimeSpeechBuffer(session.buffer, {
        force: true,
        minSpeakableChars: this.forceMinSpeakableChars,
        speakableTextOptions: session.speakableTextOptions
      })
      session.buffer = split.remainder
      split.chunks.forEach((rawChunk) => this.speakChunk(session, rawChunk))

      if (session.buffer.trim()) {
        this.scheduleLatencyFlush(session)
      }
    }, this.latencyFlushMs)
  }

  private speakChunk(session: RealtimeSpeechSession, rawChunk: string): void {
    if (session.sessionId !== this.options.getCurrentSessionId()) return
    const goonControlContent = consumePendingGoonControlBlocks(session)
    if (!this.options.willSpeakText(rawChunk, { manual: true, agentId: session.agentId })) {
      if (goonControlContent) this.dispatchPendingGoonControls(session, goonControlContent)
      return
    }

    const chunkMessageId = buildRealtimeSpeechChunkId(session.messageId, session.chunkIndex)
    session.chunkIndex += 1
    session.spokeChunks = true

    this.options.dispatchGoonSpeechMessage(
      chunkMessageId,
      session.agentId,
      goonControlContent ? `${goonControlContent}\n${rawChunk}` : rawChunk,
      true
    )
    void this.options.speak(rawChunk, {
      voice: session.voice,
      agentId: session.agentId,
      messageId: chunkMessageId,
      manual: true
    })
  }

  private dispatchPendingGoonControls(
    session: RealtimeSpeechSession,
    controlContent = consumePendingGoonControlBlocks(session)
  ): void {
    const content = controlContent.trim()
    if (!content || session.sessionId !== this.options.getCurrentSessionId()) return

    const controlMessageId = `${session.messageId}:realtime-tts:control:${session.controlDispatchIndex}`
    session.controlDispatchIndex += 1
    this.options.dispatchGoonSpeechMessage(controlMessageId, session.agentId, content, false)
  }
}
