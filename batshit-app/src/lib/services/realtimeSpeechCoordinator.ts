import type { VoiceConfig } from '$lib/services/voice'
import type { VoiceSettings } from '$lib/types/voice'
import {
  realtimeHiddenTagNames,
  realtimeHiddenTagOpenPrefixes
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

function isPotentialHiddenControlPrefix(value: string): boolean {
  const normalized = normalizeControlPrefix(value)
  return HIDDEN_CONTROL_TAG_OPEN_PREFIXES.some(
    (prefix) =>
      prefix.startsWith(normalized) ||
      (normalized.startsWith(prefix) && /[\s/>]/.test(normalized[prefix.length] ?? ''))
  )
}

function findNextHiddenControlOpener(text: string): HiddenControlOpener | null {
  let searchIndex = 0

  while (searchIndex < text.length) {
    const index = text.indexOf('<', searchIndex)
    if (index === -1) return null

    const endIndex = text.indexOf('>', index + 1)
    if (endIndex === -1) {
      return isPotentialHiddenControlPrefix(text.slice(index)) ? { type: 'partial', index } : null
    }

    const tagSource = text.slice(index, endIndex + 1)
    const match = /^<\s*([a-z][a-z0-9:_-]*)\b/i.exec(tagSource)
    const tagName = match?.[1]?.toLowerCase()
    if (tagName && isHiddenControlTag(tagName)) {
      return {
        type: 'open',
        index,
        endIndex: endIndex + 1,
        tagName,
        selfClosing: /\/\s*>$/.test(tagSource)
      }
    }

    searchIndex = endIndex + 1
  }

  return null
}

function findClosingHiddenControlTag(text: string, tagName: string): { index: number; endIndex: number } | null {
  const pattern = new RegExp(`<\\/\\s*${escapeRegExp(tagName)}\\s*>`, 'i')
  const match = pattern.exec(text)
  if (!match) return null
  return { index: match.index, endIndex: match.index + match[0].length }
}

function findPlainControlSectionEnd(text: string): number | null {
  const blankLine = /\n\s*\n/.exec(text)
  if (blankLine) return blankLine.index + blankLine[0].length
  return null
}

function stripRealtimeHiddenControls(session: RealtimeSpeechSession, chunkText: string): string {
  let text = `${session.pendingHiddenControlOpener}${chunkText}`
  session.pendingHiddenControlOpener = ''
  let output = ''

  while (text.length > 0) {
    if (session.hiddenControlTagName) {
      const tagName = session.hiddenControlTagName
      const closing = findClosingHiddenControlTag(text, tagName)
      if (!closing) {
        if (isGoonControlTag(tagName)) {
          session.hiddenControlBlockBuffer += text
        }
        return output
      }
      if (isGoonControlTag(tagName)) {
        pushPendingGoonControlBlock(
          session,
          `${session.hiddenControlBlockBuffer}${text.slice(0, closing.endIndex)}`
        )
      }
      text = text.slice(closing.endIndex)
      session.hiddenControlTagName = null
      session.hiddenControlBlockBuffer = ''
      continue
    }

    if (session.hiddenPlainControlSection) {
      const sectionEnd = findPlainControlSectionEnd(text)
      if (sectionEnd === null) return output
      text = text.slice(sectionEnd)
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
      text = sectionRemainder.slice(sectionEnd)
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
        text = text.slice(opener.endIndex)
        continue
      }

      const afterOpen = text.slice(opener.endIndex)
      const closing = findClosingHiddenControlTag(afterOpen, opener.tagName)
      if (!closing) {
        session.hiddenControlTagName = opener.tagName
        session.hiddenControlBlockBuffer = isGoonControlTag(opener.tagName)
          ? text.slice(opener.index)
          : ''
        break
      }

      if (isGoonControlTag(opener.tagName)) {
        pushPendingGoonControlBlock(
          session,
          text.slice(opener.index, opener.endIndex + closing.endIndex)
        )
      }
      text = afterOpen.slice(closing.endIndex)
    }
  }

  return output
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
