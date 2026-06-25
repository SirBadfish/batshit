import type { ParsedGoonCue } from '$lib/goons/cueParser'
import type { VoiceRealtimeTtsAlignmentSegment } from '$lib/types/voiceRealtime'
import type { GoonLipSyncAnalyzerId } from '$lib/utils/goonLipSync'
import { estimateGoonLipSyncDurationMs } from '$lib/utils/goonLipSync'
import { extractSpeakableText } from '$lib/utils/speakableText'

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const DEFAULT_SENTENCE_BOUNDARY_NEXT_WORD_DELAY_MS = 400
const NEXT_WORD_ONSET_CUE_DELAY_MS = 110
const AFTER_REACTION_CUE_DELAY_MS = 120
const AFTER_REACTION_PUNCTUATION = new Set(['.', '!', '?'])
const LEADING_WORD_PUNCTUATION = new Set([',', ';', ':', '"', "'", ')', '(', ']', '[', '}', '{', '-', '—'])

type CueTimingAnchorMode = 'authored' | 'next-word-onset' | 'after-reaction'

function hasSentenceBoundaryBeforeCue(rawText: string, cueStart: number) {
  const prefix = rawText.slice(0, cueStart).replace(/\s+$/g, '')
  if (!prefix) return false
  return /[.!?]$/.test(prefix)
}

function resolveCueAnchor(
  rawText: string,
  cue: Pick<ParsedGoonCue, 'index' | 'spanStart' | 'spanEnd' | 'source' | 'definition'>
): { anchorIndex: number; mode: CueTimingAnchorMode } {
  const cueStart = Math.max(0, Math.min(rawText.length, cue.spanStart ?? cue.index))
  const cueEnd = Math.max(cueStart, Math.min(rawText.length, cue.spanEnd ?? cueStart))

  if (cue.source !== 'emoji' || cue.definition?.blocking) {
    return { anchorIndex: cueStart, mode: 'authored' }
  }

  let cursor = cueEnd
  while (cursor < rawText.length && /\s/u.test(rawText[cursor] ?? '')) {
    cursor += 1
  }

  const nextChar = rawText[cursor]
  if (!nextChar) {
    return { anchorIndex: cueStart, mode: 'after-reaction' }
  }

  if (AFTER_REACTION_PUNCTUATION.has(nextChar)) {
    return { anchorIndex: cueStart, mode: 'after-reaction' }
  }

  while (cursor < rawText.length) {
    const char = rawText[cursor] ?? ''
    if (!char) break
    if (/\s/u.test(char)) {
      cursor += 1
      continue
    }
    if (LEADING_WORD_PUNCTUATION.has(char)) {
      cursor += 1
      continue
    }
    break
  }

  if (cursor >= rawText.length) {
    return { anchorIndex: cueStart, mode: 'after-reaction' }
  }

  return { anchorIndex: cursor, mode: 'next-word-onset' }
}

function resolveCueTimingDelayMs(mode: CueTimingAnchorMode) {
  switch (mode) {
    case 'next-word-onset':
      return NEXT_WORD_ONSET_CUE_DELAY_MS
    case 'after-reaction':
      return AFTER_REACTION_CUE_DELAY_MS
    default:
      return 0
  }
}

function tokenizeSpeakableTimingText(text: string): string[] {
  const normalized = text
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}'’]+/gu, ' ')
    .replace(/[’']/g, '')
    .trim()
    .toLowerCase()

  return normalized ? normalized.split(/\s+/g).filter(Boolean) : []
}

function resolveSentenceBoundaryNextWordDelayMs(analyzerId?: GoonLipSyncAnalyzerId | null) {
  void analyzerId
  return DEFAULT_SENTENCE_BOUNDARY_NEXT_WORD_DELAY_MS
}

export function usesAnalyzerOwnedCueProgress(
  analyzerId?: GoonLipSyncAnalyzerId | null
): analyzerId is Exclude<GoonLipSyncAnalyzerId, 'batshit-text-timing'> {
  return Boolean(analyzerId && analyzerId !== 'batshit-text-timing')
}

export function estimateCueTimingFraction(
  rawText: string,
  cue: Pick<ParsedGoonCue, 'index' | 'spanStart' | 'spanEnd' | 'source' | 'definition'>,
  options?: {
    analyzerId?: GoonLipSyncAnalyzerId | null
  }
): number {
  if (!rawText) return 0

  const totalSpeakable = extractSpeakableText(rawText)
  if (!totalSpeakable) {
    return rawText.length > 0 ? clamp01(cue.index / rawText.length) : 0
  }

  const cueStart = Math.max(0, Math.min(rawText.length, cue.spanStart ?? cue.index))
  const { anchorIndex, mode } = resolveCueAnchor(rawText, cue)
  const prefixSpeakable = extractSpeakableText(rawText.slice(0, anchorIndex))
  if (!prefixSpeakable) return 0

  const totalEstimate = estimateGoonLipSyncDurationMs(totalSpeakable, 1)
  if (totalEstimate <= 0) {
    return rawText.length > 0 ? clamp01(cue.index / rawText.length) : 0
  }

  const prefixEstimate = estimateGoonLipSyncDurationMs(prefixSpeakable, 1)
  const adjustedPrefixEstimate =
    prefixEstimate +
    (mode === 'next-word-onset' && hasSentenceBoundaryBeforeCue(rawText, cueStart)
      ? resolveSentenceBoundaryNextWordDelayMs(options?.analyzerId)
      : 0) +
    resolveCueTimingDelayMs(mode)
  return clamp01(adjustedPrefixEstimate / totalEstimate)
}

export function estimateCueTimingMsFromAlignment(
  rawText: string,
  cue: Pick<ParsedGoonCue, 'index' | 'spanStart' | 'spanEnd' | 'source' | 'definition'>,
  segments: VoiceRealtimeTtsAlignmentSegment[]
): number | null {
  if (!rawText || segments.length === 0) return null

  const cueStart = Math.max(0, Math.min(rawText.length, cue.spanStart ?? cue.index))
  const { anchorIndex, mode } = resolveCueAnchor(rawText, cue)
  const prefixSpeakable = extractSpeakableText(rawText.slice(0, anchorIndex))
  const prefixTokenCount = tokenizeSpeakableTimingText(prefixSpeakable).length
  const alignedSegments = segments
    .map((segment) => ({
      ...segment,
      tokenCount: tokenizeSpeakableTimingText(segment.text).length
    }))
    .filter((segment) => segment.tokenCount > 0)
    .sort((left, right) => left.startSec - right.startSec)

  if (alignedSegments.length === 0) return null

  let elapsedTokens = 0
  for (const segment of alignedSegments) {
    const segmentStartToken = elapsedTokens
    const segmentEndToken = elapsedTokens + segment.tokenCount

    if (mode === 'next-word-onset') {
      if (prefixTokenCount >= segmentStartToken && prefixTokenCount < segmentEndToken) {
        return Math.max(0, segment.startSec * 1000 + resolveCueTimingDelayMs(mode))
      }
    } else if (prefixTokenCount > segmentStartToken && prefixTokenCount <= segmentEndToken) {
      return Math.max(0, segment.endSec * 1000 + resolveCueTimingDelayMs(mode))
    }

    elapsedTokens = segmentEndToken
  }

  if (prefixTokenCount === 0) {
    return Math.max(0, alignedSegments[0].startSec * 1000 + resolveCueTimingDelayMs(mode))
  }

  const alignedTokenCount = alignedSegments.reduce((sum, segment) => sum + segment.tokenCount, 0)
  return prefixTokenCount > alignedTokenCount ? null : Math.max(0, alignedSegments.at(-1)!.endSec * 1000)
}
