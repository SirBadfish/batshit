import { extractSpeakableText, type SpeakableTextOptions } from './speakableText'

export type RealtimeSpeechChunkerOptions = {
  minSpeakableChars?: number
  shortSentenceMinChars?: number
  preferredMaxSpeakableChars?: number
  hardMaxRawChars?: number
  force?: boolean
  speakableTextOptions?: SpeakableTextOptions
}

export type RealtimeSpeechChunkSplit = {
  chunks: string[]
  remainder: string
}

const DEFAULT_MIN_SPEAKABLE_CHARS = 32
const DEFAULT_SHORT_SENTENCE_MIN_CHARS = 12
const DEFAULT_PREFERRED_MAX_SPEAKABLE_CHARS = 220
const DEFAULT_HARD_MAX_RAW_CHARS = 520

const SENTENCE_BOUNDARY = /[.!?\u2026](?:["')\]}\u201d\u2019\u00bb]+)?(?=\s|$)/g
const SOFT_BOUNDARY = /[,;:](?:["')\]}\u201d\u2019\u00bb]+)?(?=\s|$)/g
const LINE_BOUNDARY = /\n+/g

function lastBoundaryEnd(text: string, pattern: RegExp): number | null {
  pattern.lastIndex = 0
  let end: number | null = null
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    end = match.index + match[0].length
  }
  return end
}

function speakableLength(text: string, options?: SpeakableTextOptions): number {
  return extractSpeakableText(text, options).replace(/\s+/g, ' ').trim().length
}

function isWordCharacter(value: string): boolean {
  return /[A-Za-z0-9]/.test(value)
}

function hasUnclosedSingleEmphasis(text: string, marker: '*' | '_'): boolean {
  let open = false

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== marker) continue
    const previous = text[index - 1] ?? ''
    const next = text[index + 1] ?? ''
    if (previous === marker || next === marker) continue
    if (marker === '_' && previous && next && isWordCharacter(previous) && isWordCharacter(next)) {
      continue
    }
    if (!/\S/.test(previous) && !/\S/.test(next)) continue
    open = !open
  }

  return open
}

function hasUnstableSpeechMarkup(text: string, options?: SpeakableTextOptions): boolean {
  const lastOpenTag = text.lastIndexOf('<')
  const lastCloseTag = text.lastIndexOf('>')
  if (lastOpenTag > lastCloseTag) return true

  const lastOpenZip = text.lastIndexOf('{{')
  const lastCloseZip = text.lastIndexOf('}}')
  if (lastOpenZip > lastCloseZip) return true

  const fenceMatches = text.match(/```|~~~/g)
  if (fenceMatches && fenceMatches.length % 2 === 1) return true

  if (options?.italicBehavior === 'silent') {
    return hasUnclosedSingleEmphasis(text, '*') || hasUnclosedSingleEmphasis(text, '_')
  }

  return false
}

function findHardBoundary(text: string, maxRawChars: number): number | null {
  if (text.length < maxRawChars) return null

  const searchEnd = Math.min(text.length, maxRawChars)
  for (let index = searchEnd; index > Math.max(0, searchEnd - 160); index -= 1) {
    if (/\s/.test(text[index] ?? '')) {
      return index + 1
    }
  }

  return searchEnd
}

function findFlushBoundary(
  text: string,
  options: Required<Omit<RealtimeSpeechChunkerOptions, 'force' | 'speakableTextOptions'>>,
  speakableTextOptions?: SpeakableTextOptions
): number | null {
  if (hasUnstableSpeechMarkup(text, speakableTextOptions)) return null

  const totalSpeakableLength = speakableLength(text, speakableTextOptions)
  if (totalSpeakableLength < options.shortSentenceMinChars) return null

  const sentenceEnd = lastBoundaryEnd(text, SENTENCE_BOUNDARY)
  if (sentenceEnd !== null) {
    const sentenceSpeakableLength = speakableLength(text.slice(0, sentenceEnd), speakableTextOptions)
    if (
      sentenceSpeakableLength >= options.shortSentenceMinChars ||
      totalSpeakableLength >= options.minSpeakableChars
    ) {
      return sentenceEnd
    }
  }

  const lineEnd = lastBoundaryEnd(text, LINE_BOUNDARY)
  if (
    lineEnd !== null &&
    speakableLength(text.slice(0, lineEnd), speakableTextOptions) >= options.minSpeakableChars
  ) {
    return lineEnd
  }

  if (totalSpeakableLength >= options.preferredMaxSpeakableChars) {
    const softEnd = lastBoundaryEnd(text, SOFT_BOUNDARY)
    if (
      softEnd !== null &&
      speakableLength(text.slice(0, softEnd), speakableTextOptions) >= options.minSpeakableChars
    ) {
      return softEnd
    }
  }

  const hardEnd = findHardBoundary(text, options.hardMaxRawChars)
  if (
    hardEnd !== null &&
    speakableLength(text.slice(0, hardEnd), speakableTextOptions) >= options.minSpeakableChars
  ) {
    return hardEnd
  }

  return null
}

export function splitRealtimeSpeechBuffer(
  buffer: string,
  options: RealtimeSpeechChunkerOptions & { final?: boolean } = {}
): RealtimeSpeechChunkSplit {
  const resolvedOptions: Required<Omit<RealtimeSpeechChunkerOptions, 'force' | 'speakableTextOptions'>> = {
    minSpeakableChars: options.minSpeakableChars ?? DEFAULT_MIN_SPEAKABLE_CHARS,
    shortSentenceMinChars: options.shortSentenceMinChars ?? DEFAULT_SHORT_SENTENCE_MIN_CHARS,
    preferredMaxSpeakableChars:
      options.preferredMaxSpeakableChars ?? DEFAULT_PREFERRED_MAX_SPEAKABLE_CHARS,
    hardMaxRawChars: options.hardMaxRawChars ?? DEFAULT_HARD_MAX_RAW_CHARS
  }
  const chunks: string[] = []
  let remainder = buffer

  while (remainder.trim().length > 0) {
    const boundary = findFlushBoundary(remainder, resolvedOptions, options.speakableTextOptions)
    if (boundary === null) break

    const chunk = remainder.slice(0, boundary).trim()
    if (!chunk) break
    chunks.push(chunk)
    remainder = remainder.slice(boundary).replace(/^\s+/, '')
  }

  if (options.final) {
    const finalChunk = remainder.trim()
    if (finalChunk && speakableLength(finalChunk, options.speakableTextOptions) > 0) {
      chunks.push(finalChunk)
      remainder = ''
    }
  } else if (options.force && remainder.trim().length > 0) {
    const forcedChunk = remainder.trim()
    if (
      !hasUnstableSpeechMarkup(forcedChunk, options.speakableTextOptions) &&
      speakableLength(forcedChunk, options.speakableTextOptions) >= resolvedOptions.minSpeakableChars
    ) {
      chunks.push(forcedChunk)
      remainder = ''
    }
  }

  return { chunks, remainder }
}
