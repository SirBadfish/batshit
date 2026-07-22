import type { GoonLipSyncMode, GoonLipSyncPremiumAnalyzerId } from '$lib/types/voice'
import {
  CUSTOM_RHUBARB_MOUTH_ORDER,
  createEmptyCustomRhubarbMouthWeights,
  downmixCustomRhubarbMouthToGoonWeights,
  type CustomRhubarbMouthCue,
  type CustomRhubarbMouthWeights
} from '$lib/goons/semanticVisemes'
import {
  RHUBARB_9_SPEECH_FACE_PROFILE,
  cloneGoonSpeechFaceFrame,
  createEmptyGoonSpeechFaceFrame,
  lerpGoonSpeechFaceFrames,
  projectGoonSpeechFaceFrameToRhubarb9,
  sameGoonSpeechFaceFrame,
  type GoonSpeechFaceFrame,
  type GoonFaceDriverProfile
} from '$lib/goons/speechFaceProfiles'

export const DEFAULT_GOON_LIP_SYNC_MODE: GoonLipSyncMode = 'amplitude'
export const MIN_GOON_LIP_SYNC_VISEME_BLEND_MS = 0
export const MAX_GOON_LIP_SYNC_VISEME_BLEND_MS = 80
export const DEFAULT_GOON_LIP_SYNC_VISEME_BLEND_MS = 35

export type LegacyGoonLipSyncViseme = 'aa' | 'ih' | 'ou' | 'ee' | 'oh'
export type LegacyGoonLipSyncWeights = Record<LegacyGoonLipSyncViseme, number>
export type GoonLipSyncViseme = CustomRhubarbMouthCue
export type GoonLipSyncProviderAnalyzerId = 'inworld-viseme-timing'
export type GoonLipSyncAnalyzerId =
  | 'batshit-text-timing'
  | GoonLipSyncPremiumAnalyzerId
  | GoonLipSyncProviderAnalyzerId
export type GoonLipSyncTimelineSource = 'text-timing' | 'audio-analysis' | 'provider-alignment'

export type GoonLipSyncWeights = CustomRhubarbMouthWeights

export type GoonLipSyncTimelineKeyframe = {
  timeMs: number
  frame: GoonSpeechFaceFrame
}

export type GoonLipSyncTimeline = {
  analyzerId: GoonLipSyncAnalyzerId
  source: GoonLipSyncTimelineSource
  profile: GoonFaceDriverProfile
  keyframes: GoonLipSyncTimelineKeyframe[]
  durationMs: number
  unitCount: number
  sourceText: string
  visemeBlendMs?: number
  diagnostics?: GoonLipSyncTimelineDiagnostics
}

export type GoonLipSyncTimelineDiagnostics = {
  provider: string
  phoneCount: number
  mappedPhoneCount: number
  silencePhoneCount: number
  unmappedPhoneCount: number
  coveragePercent: number
  segmentCount: number
  chunkCount: number
  durationMs: number
  visemeSymbolCounts: Record<string, number>
  phoneSymbolCounts: Record<string, number>
  primaryCueCounts: Record<string, number>
  unmappedSymbols: Array<{
    phoneSymbol?: string
    visemeSymbol?: string
    count: number
  }>
  cueDurationMs?: Record<string, number>
  activeDurationMs?: number
  weightMaxima?: Record<string, number>
  weightedDurationMs?: Record<string, number>
}

export type GoonLipSyncSampleOptions = {
  visemeBlendMs?: number
}

export type GoonLipSyncAnalyzerRuntimeMode = 'precomputed' | 'provider-alignment'

export type GoonLipSyncAnalyzerMetrics = {
  analyzerId: GoonLipSyncAnalyzerId
  runtimeMode: GoonLipSyncAnalyzerRuntimeMode
  totalMs: number
  networkMs?: number | null
  normalizeMs?: number | null
  analyzeMs?: number | null
  notes?: string[]
}

export type AudioLedGoonLipSyncResult = {
  timeline: GoonLipSyncTimeline
  metrics?: GoonLipSyncAnalyzerMetrics | null
}

export type GoonLipSyncPlaybackMetrics = {
  providerId?: string | null
  analyzerId: GoonLipSyncAnalyzerId
  analyzerMode: GoonLipSyncAnalyzerRuntimeMode | 'fallback'
  metricKind?: 'playback-start' | 'stream-complete' | 'stream-aborted' | 'stream-error' | null
  runtimeMode?: 'batch' | 'realtime' | 'browser' | null
  transport?: string | null
  lipSyncMode?: string | null
  ttsTotalMs?: number | null
  lipSyncTotalMs?: number | null
  prePlaybackTotalMs?: number | null
  firstAudioMs?: number | null
  streamTotalMs?: number | null
  abortMs?: number | null
  chunkCount?: number | null
  audioBytes?: number | null
  aborted?: boolean | null
  audioDurationMs?: number | null
  mediaType?: string | null
  messageId?: string | null
  agentId?: string | null
  textPreview?: string
  lipSyncDiagnostics?: GoonLipSyncTimelineDiagnostics | null
  notes?: string[]
  capturedAt: string
}

type LipSyncUnit = {
  kind: 'viseme' | 'close' | 'pause'
  weight: number
  weights: GoonLipSyncWeights
}

const ZERO_LEGACY_WEIGHTS: LegacyGoonLipSyncWeights = {
  aa: 0,
  ih: 0,
  ou: 0,
  ee: 0,
  oh: 0
}
const ZERO_WEIGHTS: GoonLipSyncWeights = createEmptyCustomRhubarbMouthWeights()

const MIN_DURATION_MS = 260
const BASE_UNIT_DURATION_MS = 118
const WORD_GAP_WEIGHT = 0.14
const MINOR_PAUSE_WEIGHT = 0.42
const MAJOR_PAUSE_WEIGHT = 0.72

const NUMBER_WORDS: Record<string, string> = {
  '0': 'zero',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine'
}

const clamp01 = (value: number | null | undefined) => {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0
}

export function normalizeGoonLipSyncVisemeBlendMs(
  value: unknown,
  fallback = DEFAULT_GOON_LIP_SYNC_VISEME_BLEND_MS
): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  const next = Number.isFinite(numeric) ? numeric : fallback
  return Math.round(
    Math.max(MIN_GOON_LIP_SYNC_VISEME_BLEND_MS, Math.min(MAX_GOON_LIP_SYNC_VISEME_BLEND_MS, next))
  )
}

const cloneWeights = (weights: GoonLipSyncWeights): GoonLipSyncWeights => ({
  rest: clamp01(weights.rest),
  closed: clamp01(weights.closed),
  clenched: clamp01(weights.clenched),
  mid_open: clamp01(weights.mid_open),
  wide_open: clamp01(weights.wide_open),
  round: clamp01(weights.round),
  pucker: clamp01(weights.pucker),
  teeth_lip: clamp01(weights.teeth_lip),
  tongue_lift: clamp01(weights.tongue_lift)
})

function createRhubarbFrame(weights: GoonLipSyncWeights): GoonSpeechFaceFrame {
  return {
    profile: RHUBARB_9_SPEECH_FACE_PROFILE,
    weights: cloneWeights(weights)
  }
}

export function createEmptyGoonLipSyncWeights(): GoonLipSyncWeights {
  return createEmptyCustomRhubarbMouthWeights()
}

export function downmixGoonLipSyncWeightsToLegacy(
  weights: Partial<Record<CustomRhubarbMouthCue, number>>
): LegacyGoonLipSyncWeights {
  return downmixCustomRhubarbMouthToGoonWeights(weights)
}

export function downmixGoonLipSyncFrameToLegacy(
  frame: GoonSpeechFaceFrame
): LegacyGoonLipSyncWeights {
  return downmixGoonLipSyncWeightsToLegacy(projectGoonSpeechFaceFrameToRhubarb9(frame))
}

export function applyGoonLipSyncWeightMultipliers(
  weights: GoonLipSyncWeights,
  multipliers: Partial<GoonLipSyncWeights>
): GoonLipSyncWeights {
  const next = createEmptyGoonLipSyncWeights()
  for (const viseme of CUSTOM_RHUBARB_MOUTH_ORDER) {
    next[viseme] = clamp01(weights[viseme] * (multipliers[viseme] ?? 1))
  }
  return next
}

function easeVisemeBlend(amount: number) {
  const clamped = Math.max(0, Math.min(1, amount))
  return clamped * clamped * (3 - 2 * clamped)
}

function createVisemeWeights(viseme: LegacyGoonLipSyncViseme): GoonLipSyncWeights {
  const weights = createEmptyGoonLipSyncWeights()

  switch (viseme) {
    case 'aa':
      weights.wide_open = 1
      break
    case 'ih':
      weights.mid_open = 1
      break
    case 'ou':
      weights.pucker = 1
      break
    case 'ee':
      weights.clenched = 1
      break
    case 'oh':
      weights.round = 1
      break
  }

  return weights
}

function pushKeyframe(
  keyframes: GoonLipSyncTimelineKeyframe[],
  timeMs: number,
  frame: GoonSpeechFaceFrame
) {
  const clamped = Math.max(0, timeMs)
  const last = keyframes[keyframes.length - 1]
  if (!last) {
    keyframes.push({ timeMs: clamped, frame: cloneGoonSpeechFaceFrame(frame) })
    return
  }

  if (Math.abs(last.timeMs - clamped) < 0.0001) {
    last.frame = cloneGoonSpeechFaceFrame(frame)
    return
  }

  if (sameGoonSpeechFaceFrame(last.frame, frame)) {
    return
  }

  keyframes.push({ timeMs: clamped, frame: cloneGoonSpeechFaceFrame(frame) })
}

function normalizeWordToken(token: string): string[] {
  if (!/^\d+$/.test(token)) return [token]
  return token
    .split('')
    .map((digit) => NUMBER_WORDS[digit])
    .filter((value): value is string => Boolean(value))
}

function isPunctuationToken(token: string) {
  return /^[.,!?;:]+$/.test(token)
}

function isWordToken(token: string) {
  return /[a-z]/.test(token)
}

function isVowelChar(char: string, index: number) {
  return 'aeiou'.includes(char) || (char === 'y' && index > 0)
}

function hasFutureVowel(word: string, startIndex: number) {
  for (let index = startIndex; index < word.length; index += 1) {
    if (isVowelChar(word[index] ?? '', index)) {
      return true
    }
  }
  return false
}

function stripTrailingSilentE(word: string) {
  if (word.length <= 2 || !word.endsWith('e')) return word
  const body = word.slice(0, -1)
  return /[aeiouy]/.test(body) ? body : word
}

function mapVowelClusterToViseme(cluster: string): LegacyGoonLipSyncViseme {
  if (
    cluster.startsWith('oo') ||
    cluster.startsWith('ou') ||
    cluster.startsWith('ow') ||
    cluster.startsWith('ew') ||
    cluster.startsWith('ue') ||
    cluster === 'u'
  ) {
    return 'ou'
  }

  if (
    cluster.startsWith('oi') ||
    cluster.startsWith('oy') ||
    cluster.startsWith('oa') ||
    cluster.startsWith('oh') ||
    cluster.startsWith('au') ||
    cluster.startsWith('aw') ||
    cluster === 'o'
  ) {
    return 'oh'
  }

  if (
    cluster.startsWith('ee') ||
    cluster.startsWith('ea') ||
    cluster.startsWith('ei') ||
    cluster.startsWith('ie') ||
    cluster.startsWith('ey')
  ) {
    return 'ee'
  }

  if (cluster.startsWith('i') || cluster.startsWith('e') || cluster.startsWith('y')) {
    return 'ih'
  }

  return 'aa'
}

function createClosureUnit(cluster: string): LipSyncUnit {
  const weights = createEmptyGoonLipSyncWeights()

  if (/[bmp]/.test(cluster)) {
    weights.closed = 1
    return {
      kind: 'close',
      weight: 0.34,
      weights
    }
  }

  if (/l/.test(cluster)) {
    weights.tongue_lift = 0.9
    weights.mid_open = 0.12
    return {
      kind: 'close',
      weight: 0.22,
      weights
    }
  }

  if (/th/.test(cluster)) {
    weights.clenched = 0.82
    weights.pucker = 0.16
    return {
      kind: 'close',
      weight: 0.24,
      weights
    }
  }

  if (/[fv]/.test(cluster)) {
    weights.teeth_lip = 0.9
    return {
      kind: 'close',
      weight: 0.24,
      weights
    }
  }

  if (/w/.test(cluster)) {
    weights.pucker = 0.9
    return {
      kind: 'close',
      weight: 0.2,
      weights
    }
  }

  if (/ch|sh|j/.test(cluster)) {
    weights.clenched = 0.82
    weights.pucker = 0.22
    return {
      kind: 'close',
      weight: 0.2,
      weights
    }
  }

  if (/[szcx]/.test(cluster)) {
    weights.clenched = 0.82
    return {
      kind: 'close',
      weight: 0.18,
      weights
    }
  }

  return {
    kind: 'close',
    weight: 0.16,
    weights
  }
}

function createPauseUnit(weight: number): LipSyncUnit {
  return {
    kind: 'pause',
    weight,
    weights: ZERO_WEIGHTS
  }
}

function parseWordToUnits(word: string): LipSyncUnit[] {
  const simplified = stripTrailingSilentE(word.toLowerCase().replace(/[^a-z]/g, ''))
  if (!simplified) return []

  const units: LipSyncUnit[] = []
  let index = 0

  while (index < simplified.length) {
    const vowelCluster = isVowelChar(simplified[index] ?? '', index)
    let nextIndex = index + 1

    while (
      nextIndex < simplified.length &&
      isVowelChar(simplified[nextIndex] ?? '', nextIndex) === vowelCluster
    ) {
      nextIndex += 1
    }

    const cluster = simplified.slice(index, nextIndex)

    if (vowelCluster) {
      const viseme = mapVowelClusterToViseme(cluster)
      units.push({
        kind: 'viseme',
        weight: 1,
        weights: createVisemeWeights(viseme)
      })
    } else if (units.length > 0 || hasFutureVowel(simplified, nextIndex)) {
      units.push(createClosureUnit(cluster))
    }

    index = nextIndex
  }

  return units
}

function tokenizeTextForLipSync(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?|\d+|[.,!?;:]+/g) ?? []
  return matches.flatMap((token) => normalizeWordToken(token))
}

function buildLipSyncUnits(text: string): LipSyncUnit[] {
  const tokens = tokenizeTextForLipSync(text)
  const units: LipSyncUnit[] = []

  tokens.forEach((token, index) => {
    if (isPunctuationToken(token)) {
      units.push(createPauseUnit(/[!?\.]/.test(token) ? MAJOR_PAUSE_WEIGHT : MINOR_PAUSE_WEIGHT))
      return
    }

    const wordUnits = parseWordToUnits(token)
    if (wordUnits.length > 0) {
      units.push(...wordUnits)
    }

    const nextToken = tokens[index + 1]
    if (nextToken && isWordToken(nextToken)) {
      units.push(createPauseUnit(WORD_GAP_WEIGHT))
    }
  })

  return units
}

export function estimateGoonLipSyncDurationMs(
  text: string,
  playbackRate = 1
): number {
  const units = buildLipSyncUnits(text)
  const baseDurationMs = Math.max(
    MIN_DURATION_MS,
    units.reduce((sum, unit) => sum + unit.weight, 0) * BASE_UNIT_DURATION_MS
  )
  const safeRate = Math.max(0.5, Math.min(2, playbackRate || 1))
  return Math.round(baseDurationMs / safeRate)
}

export function buildTextGoonLipSyncTimeline(
  text: string,
  playbackRate = 1,
  durationOverrideMs?: number | null
): GoonLipSyncTimeline | null {
  const units = buildLipSyncUnits(text)
  if (units.length === 0) {
    return null
  }

  const totalWeight = units.reduce((sum, unit) => sum + unit.weight, 0)
  if (totalWeight <= 0) {
    return null
  }

  const estimatedDurationMs = estimateGoonLipSyncDurationMs(text, playbackRate)
  const durationMs =
    typeof durationOverrideMs === 'number' && Number.isFinite(durationOverrideMs) && durationOverrideMs > 0
      ? Math.max(estimatedDurationMs, Math.round(durationOverrideMs))
      : estimatedDurationMs
  const keyframes: GoonLipSyncTimelineKeyframe[] = [
    { timeMs: 0, frame: createRhubarbFrame(ZERO_WEIGHTS) }
  ]
  let elapsedMs = 0

  for (const unit of units) {
    const spanMs = (unit.weight / totalWeight) * durationMs
    const startMs = elapsedMs
    const endMs = Math.min(durationMs, elapsedMs + spanMs)
    const attackMs = Math.min(spanMs * 0.42, durationMs * 0.06)
    const releaseMs = Math.min(spanMs * 0.34, durationMs * 0.05)
    const attackEndMs = Math.min(endMs, startMs + attackMs)
    const releaseStartMs = Math.max(attackEndMs, endMs - releaseMs)

    pushKeyframe(keyframes, attackEndMs, createRhubarbFrame(unit.weights))
    pushKeyframe(keyframes, releaseStartMs, createRhubarbFrame(unit.weights))
    elapsedMs = endMs
  }

  pushKeyframe(keyframes, durationMs, createRhubarbFrame(ZERO_WEIGHTS))

  return {
    analyzerId: 'batshit-text-timing',
    source: 'text-timing',
    profile: RHUBARB_9_SPEECH_FACE_PROFILE,
    keyframes,
    durationMs,
    unitCount: units.length,
    sourceText: text
  }
}

export function sampleGoonLipSyncTimeline(
  timeline: GoonLipSyncTimeline | null | undefined,
  elapsedMs: number,
  options: GoonLipSyncSampleOptions = {}
): GoonSpeechFaceFrame {
  if (!timeline || timeline.keyframes.length === 0) {
    return createEmptyGoonSpeechFaceFrame(RHUBARB_9_SPEECH_FACE_PROFILE)
  }

  const clamped = Math.max(0, Math.min(timeline.durationMs, elapsedMs))
  const first = timeline.keyframes[0]
  const last = timeline.keyframes[timeline.keyframes.length - 1]

  if (!first || !last) {
    return createEmptyGoonSpeechFaceFrame(timeline.profile)
  }

  if (clamped <= first.timeMs) {
    return cloneGoonSpeechFaceFrame(first.frame)
  }

  if (clamped >= last.timeMs) {
    return cloneGoonSpeechFaceFrame(last.frame)
  }

  const transitionWeights = sampleTimelineBoundaryTransition(timeline, clamped, options)
  if (transitionWeights) {
    return transitionWeights
  }

  for (let index = 0; index < timeline.keyframes.length - 1; index += 1) {
    const current = timeline.keyframes[index]
    const next = timeline.keyframes[index + 1]
    if (clamped < current.timeMs || clamped > next.timeMs) continue
    const span = next.timeMs - current.timeMs
    if (span <= 0.0001) {
      return cloneGoonSpeechFaceFrame(next.frame)
    }
    const amount = (clamped - current.timeMs) / span
    return lerpGoonSpeechFaceFrames(current.frame, next.frame, amount)
  }

  return cloneGoonSpeechFaceFrame(last.frame)
}

export function normalizeGoonLipSyncTimelineDuration(
  timeline: GoonLipSyncTimeline | null | undefined,
  targetDurationMs: number | null | undefined,
  options: {
    allowShrink?: boolean
    minDeltaMs?: number
    minRatioDelta?: number
  } = {}
): GoonLipSyncTimeline | null {
  if (!timeline) return null

  const target = Math.round(Number(targetDurationMs))
  if (!Number.isFinite(target) || target <= 0) return timeline

  const current = Math.round(Number(timeline.durationMs))
  if (!Number.isFinite(current) || current <= 0) {
    return {
      ...timeline,
      durationMs: target,
      keyframes: timeline.keyframes.map((keyframe) => ({
        timeMs: Math.max(0, Math.min(target, Math.round(keyframe.timeMs))),
        frame: cloneGoonSpeechFaceFrame(keyframe.frame)
      }))
    }
  }

  const deltaMs = Math.abs(target - current)
  const minDeltaMs = options.minDeltaMs ?? 80
  const minRatioDelta = options.minRatioDelta ?? 0.03
  const ratioDelta = deltaMs / Math.max(1, current)
  if (deltaMs < minDeltaMs && ratioDelta < minRatioDelta) return timeline
  if (target < current && options.allowShrink !== true) return timeline

  const scale = target / current
  const keyframes = timeline.keyframes.map((keyframe) => ({
    timeMs: Math.max(0, Math.min(target, Math.round(keyframe.timeMs * scale))),
    frame: cloneGoonSpeechFaceFrame(keyframe.frame)
  }))
  const last = keyframes[keyframes.length - 1]
  if (last && last.timeMs < target) {
    keyframes.push({
      timeMs: target,
      frame: cloneGoonSpeechFaceFrame(last.frame)
    })
  }

  return {
    ...timeline,
    durationMs: target,
    keyframes
  }
}

export function isTimelineOwnedGoonLipSyncSource(
  source: GoonLipSyncTimelineSource | null | undefined
): boolean {
  return source === 'audio-analysis' || source === 'provider-alignment'
}

function sampleTimelineBoundaryTransition(
  timeline: GoonLipSyncTimeline,
  clampedMs: number,
  options: GoonLipSyncSampleOptions
): GoonSpeechFaceFrame | null {
  const requestedBlendMs = normalizeGoonLipSyncVisemeBlendMs(
    options.visemeBlendMs ?? timeline.visemeBlendMs ?? 0,
    0
  )
  if (requestedBlendMs <= 0) return null

  const keyframes = timeline.keyframes
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index]
    const to = keyframes[index + 1]
    if (!from || !to) continue
    if (Math.abs(from.timeMs - to.timeMs) > 0.0001) continue
    if (sameGoonSpeechFaceFrame(from.frame, to.frame)) continue

    const boundaryMs = from.timeMs
    const previousTimeMs = findPreviousDistinctTimeMs(keyframes, index, boundaryMs)
    const nextTimeMs = findNextDistinctTimeMs(keyframes, index + 1, boundaryMs, timeline.durationMs)
    const previousDurationMs = Math.max(0, boundaryMs - previousTimeMs)
    const nextDurationMs = Math.max(0, nextTimeMs - boundaryMs)
    const blendMs = Math.min(requestedBlendMs, previousDurationMs * 0.7, nextDurationMs * 0.7)
    if (blendMs <= 1) continue

    const halfBlendMs = blendMs / 2
    const transitionStartMs = boundaryMs - halfBlendMs
    const transitionEndMs = boundaryMs + halfBlendMs
    if (clampedMs < transitionStartMs || clampedMs > transitionEndMs) continue

    const amount = easeVisemeBlend((clampedMs - transitionStartMs) / blendMs)
    return lerpGoonSpeechFaceFrames(from.frame, to.frame, amount)
  }

  return null
}

function findPreviousDistinctTimeMs(
  keyframes: GoonLipSyncTimelineKeyframe[],
  index: number,
  boundaryMs: number
) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const timeMs = keyframes[cursor]?.timeMs
    if (typeof timeMs === 'number' && timeMs < boundaryMs - 0.0001) return timeMs
  }
  return keyframes[0]?.timeMs ?? 0
}

function findNextDistinctTimeMs(
  keyframes: GoonLipSyncTimelineKeyframe[],
  index: number,
  boundaryMs: number,
  durationMs: number
) {
  for (let cursor = index + 1; cursor < keyframes.length; cursor += 1) {
    const timeMs = keyframes[cursor]?.timeMs
    if (typeof timeMs === 'number' && timeMs > boundaryMs + 0.0001) return timeMs
  }
  return durationMs
}

export function getGoonLipSyncOpenness(
  frame: GoonSpeechFaceFrame
): number {
  const legacyWeights = downmixGoonLipSyncWeightsToLegacy(
    projectGoonSpeechFaceFrameToRhubarb9(frame)
  )
  return getLegacyGoonLipSyncOpenness(legacyWeights)
}

export function getLegacyGoonLipSyncOpenness(weights: LegacyGoonLipSyncWeights): number {
  return clamp01(
    weights.aa * 1 +
      weights.oh * 0.82 +
      weights.ou * 0.7 +
      weights.ee * 0.56 +
      weights.ih * 0.46
  )
}
