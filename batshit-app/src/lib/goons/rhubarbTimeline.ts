import {
  CUSTOM_RHUBARB_MOUTH_ORDER,
  RHUBARB_CUE_TO_CUSTOM_RHUBARB_MOUTH,
  mapRhubarbCueToCustomRhubarbMouthWeights,
  RHUBARB_CUE_TO_CUSTOM_RHUBARB_MOUTH_WEIGHTS,
  type RhubarbCueValue
} from '$lib/goons/semanticVisemes'
import type {
  GoonLipSyncAnalyzerId,
  GoonLipSyncTimeline,
  GoonLipSyncTimelineDiagnostics,
  GoonLipSyncTimelineKeyframe,
  GoonLipSyncViseme,
  GoonLipSyncWeights
} from '$lib/utils/goonLipSync'

export type RhubarbJsonResult = {
  metadata?: {
    duration?: number
  }
  mouthCues?: Array<{
    start?: number
    end?: number
    value?: string
  }>
}

type RhubarbTimelineAnalyzerId = Extract<GoonLipSyncAnalyzerId, 'rhubarb-wasm'>

function normalizeCueValue(value: string | undefined): RhubarbCueValue | null {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  if (normalized in RHUBARB_CUE_TO_CUSTOM_RHUBARB_MOUTH_WEIGHTS) {
    return normalized as RhubarbCueValue
  }
  return null
}

function incrementCount(target: Record<string, number>, key: string, amount = 1) {
  target[key] = (target[key] ?? 0) + amount
}

function incrementCueCount(
  target: Partial<Record<GoonLipSyncViseme, number>>,
  cue: GoonLipSyncViseme,
  amount = 1
) {
  target[cue] = (target[cue] ?? 0) + amount
}

function setCueMaximum(
  target: Partial<Record<GoonLipSyncViseme, number>>,
  cue: GoonLipSyncViseme,
  value: number
) {
  target[cue] = Math.max(target[cue] ?? 0, value)
}

function roundTenths(value: number) {
  return Math.round(value * 10) / 10
}

function buildRhubarbDiagnostics(
  payload: RhubarbJsonResult,
  durationMs: number
): GoonLipSyncTimelineDiagnostics {
  const cues = Array.isArray(payload.mouthCues) ? payload.mouthCues : []
  const visemeSymbolCounts: Record<string, number> = {}
  const primaryCueCounts: Partial<Record<GoonLipSyncViseme, number>> = {}
  const cueDurationMs: Record<string, number> = {}
  const weightMaxima: Partial<Record<GoonLipSyncViseme, number>> = {}
  const weightedDurationMs: Partial<Record<GoonLipSyncViseme, number>> = {}
  const unmappedSymbolCounts = new Map<string, { visemeSymbol: string; count: number }>()
  let mappedCueCount = 0
  let silenceCueCount = 0
  let activeDurationMs = 0

  for (const cue of cues) {
    const rawValue = typeof cue.value === 'string' ? cue.value.trim().toUpperCase() : ''
    const cueValue = normalizeCueValue(cue.value)
    const normalizedCue = cueValue ?? 'X'
    const weights = mapRhubarbCueToWeights(normalizedCue)
    const primaryCue = RHUBARB_CUE_TO_CUSTOM_RHUBARB_MOUTH[normalizedCue]
    const startMs = Math.max(0, Math.round((cue.start ?? 0) * 1000))
    const endMs = Math.max(startMs, Math.round((cue.end ?? cue.start ?? 0) * 1000))
    const cueDuration = endMs - startMs

    incrementCount(visemeSymbolCounts, normalizedCue)
    incrementCount(cueDurationMs, normalizedCue, cueDuration)
    incrementCueCount(primaryCueCounts, primaryCue)

    if (cueValue) {
      mappedCueCount += 1
    } else if (rawValue) {
      const entry = unmappedSymbolCounts.get(rawValue) ?? { visemeSymbol: rawValue, count: 0 }
      entry.count += 1
      unmappedSymbolCounts.set(rawValue, entry)
    }

    if (normalizedCue === 'X') {
      silenceCueCount += 1
    } else {
      activeDurationMs += cueDuration
    }

    for (const mouthCue of CUSTOM_RHUBARB_MOUTH_ORDER) {
      const weight = weights[mouthCue] ?? 0
      setCueMaximum(weightMaxima, mouthCue, weight)
      if (cueDuration > 0 && weight > 0) {
        weightedDurationMs[mouthCue] = roundTenths(
          (weightedDurationMs[mouthCue] ?? 0) + weight * cueDuration
        )
      }
    }
  }

  return {
    provider: 'rhubarb-wasm',
    phoneCount: cues.length,
    mappedPhoneCount: mappedCueCount,
    silencePhoneCount: silenceCueCount,
    unmappedPhoneCount: Math.max(0, cues.length - mappedCueCount),
    coveragePercent: cues.length > 0 ? roundTenths((mappedCueCount / cues.length) * 100) : 0,
    segmentCount: cues.length,
    chunkCount: 1,
    durationMs,
    visemeSymbolCounts,
    phoneSymbolCounts: {},
    primaryCueCounts,
    unmappedSymbols: Array.from(unmappedSymbolCounts.values()).sort(
      (left, right) => right.count - left.count
    ),
    cueDurationMs,
    activeDurationMs,
    weightMaxima,
    weightedDurationMs
  }
}

function buildTimelineKeyframes(payload: RhubarbJsonResult): GoonLipSyncTimelineKeyframe[] {
  const cues = Array.isArray(payload.mouthCues) ? payload.mouthCues : []
  const keyframes: GoonLipSyncTimelineKeyframe[] = []

  for (const cue of cues) {
    const cueValue = normalizeCueValue(cue.value)
    const startMs = Math.max(0, Math.round((cue.start ?? 0) * 1000))
    const endMs = Math.max(startMs, Math.round((cue.end ?? cue.start ?? 0) * 1000))
    const weights = mapRhubarbCueToWeights(cueValue ?? 'X')

    keyframes.push({ timeMs: startMs, weights })
    keyframes.push({ timeMs: endMs, weights: { ...weights } })
  }

  if (keyframes.length === 0) {
    keyframes.push({ timeMs: 0, weights: mapRhubarbCueToWeights('X') })
  }

  return keyframes
}

export function mapRhubarbCueToWeights(value: string): GoonLipSyncWeights {
  return mapRhubarbCueToCustomRhubarbMouthWeights(normalizeCueValue(value) ?? 'X')
}

export function convertRhubarbJsonToTimeline(
  payload: RhubarbJsonResult,
  sourceText: string,
  analyzerId: RhubarbTimelineAnalyzerId = 'rhubarb-wasm'
): GoonLipSyncTimeline {
  const keyframes = buildTimelineKeyframes(payload)
  const durationMs = Math.max(
    0,
    Math.round((payload.metadata?.duration ?? 0) * 1000),
    keyframes[keyframes.length - 1]?.timeMs ?? 0
  )

  if ((keyframes[keyframes.length - 1]?.timeMs ?? 0) < durationMs) {
    keyframes.push({
      timeMs: durationMs,
      weights: {
        ...(keyframes[keyframes.length - 1]?.weights ?? mapRhubarbCueToWeights('X'))
      }
    })
  }

  return {
    analyzerId,
    source: 'audio-analysis',
    keyframes,
    durationMs,
    unitCount: Math.max(1, payload.mouthCues?.length ?? 0),
    sourceText,
    diagnostics: buildRhubarbDiagnostics(payload, durationMs)
  }
}
