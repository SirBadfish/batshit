import {
  CUSTOM_RHUBARB_MOUTH_ORDER,
  createEmptyCustomRhubarbMouthWeights,
  type CustomRhubarbMouthWeights
} from '$lib/goons/semanticVisemes'
import type { VoiceRealtimeTtsAlignmentSegment } from '$lib/types/voiceRealtime'
import type {
  GoonLipSyncTimeline,
  GoonLipSyncTimelineDiagnostics,
  GoonLipSyncTimelineKeyframe,
  GoonLipSyncViseme,
  GoonLipSyncWeights
} from '$lib/utils/goonLipSync'

type InworldPhoneDetail = NonNullable<VoiceRealtimeTtsAlignmentSegment['phoneticDetails']>[number]

const MIN_PHONE_DURATION_MS = 24
const REST_GAP_THRESHOLD_MS = 35

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function createWeights(patch: Partial<CustomRhubarbMouthWeights>): GoonLipSyncWeights {
  const weights = createEmptyCustomRhubarbMouthWeights()
  for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
    weights[cue] = clamp01(patch[cue] ?? 0)
  }
  return weights
}

const REST_WEIGHTS = createWeights({ rest: 1 })

const INWORLD_VISEME_WEIGHTS: Record<string, GoonLipSyncWeights> = {
  aei: createWeights({ wide_open: 0.92, mid_open: 0.32 }),
  o: createWeights({ round: 0.92, pucker: 0.18 }),
  ee: createWeights({ clenched: 0.9, mid_open: 0.14 }),
  bmp: createWeights({ closed: 1 }),
  fv: createWeights({ teeth_lip: 1 }),
  l: createWeights({ tongue_lift: 0.95, mid_open: 0.16 }),
  r: createWeights({ tongue_lift: 0.56, round: 0.48 }),
  th: createWeights({ clenched: 0.78, pucker: 0.16 }),
  qw: createWeights({ pucker: 0.95, round: 0.2 }),
  chjsh: createWeights({ tongue_lift: 0.76, clenched: 0.42, pucker: 0.18 }),
  cdgknstxyz: createWeights({ clenched: 0.92 })
}

const countRecordValue = (record: Record<string, number>, key: string | null) => {
  if (!key) return
  record[key] = (record[key] ?? 0) + 1
}

function cloneWeights(weights: GoonLipSyncWeights): GoonLipSyncWeights {
  return { ...weights }
}

function sameWeights(left: GoonLipSyncWeights, right: GoonLipSyncWeights): boolean {
  return CUSTOM_RHUBARB_MOUTH_ORDER.every(
    (cue) => Math.abs((left[cue] ?? 0) - (right[cue] ?? 0)) < 0.0001
  )
}

function normalizeInworldVisemeSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function normalizePhoneSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function deriveWeightsFromPhoneSymbol(phoneSymbol: string | null): GoonLipSyncWeights | null {
  if (!phoneSymbol) return null
  if (phoneSymbol === '[silence]') return REST_WEIGHTS
  if (/[bmp]/.test(phoneSymbol)) return INWORLD_VISEME_WEIGHTS.bmp
  if (/[fv]/.test(phoneSymbol)) return INWORLD_VISEME_WEIGHTS.fv
  if (phoneSymbol.includes('tʃ') || phoneSymbol.includes('dʒ') || /sh|ch|j|ʃ|ʝ/.test(phoneSymbol)) {
    return INWORLD_VISEME_WEIGHTS.chjsh
  }
  if (phoneSymbol.includes('θ') || phoneSymbol.includes('ð') || phoneSymbol === 'th') {
    return INWORLD_VISEME_WEIGHTS.th
  }
  if (/[wʍ]/.test(phoneSymbol)) return INWORLD_VISEME_WEIGHTS.qw
  if (/[rlɝɚɫ]/.test(phoneSymbol)) return phoneSymbol.includes('r') ? INWORLD_VISEME_WEIGHTS.r : INWORLD_VISEME_WEIGHTS.l
  if (/[uoʊɔ]/.test(phoneSymbol)) return INWORLD_VISEME_WEIGHTS.o
  if (/[iɪe]/.test(phoneSymbol)) return INWORLD_VISEME_WEIGHTS.ee
  if (/[aæɑəʌɛ]/.test(phoneSymbol)) return INWORLD_VISEME_WEIGHTS.aei
  if (/[cdgknstxyz]/.test(phoneSymbol)) return INWORLD_VISEME_WEIGHTS.cdgknstxyz
  return null
}

export function mapInworldVisemeToGoonLipSyncWeights(
  visemeSymbol: unknown,
  phoneSymbol?: unknown
): GoonLipSyncWeights | null {
  const normalizedPhone = normalizePhoneSymbol(phoneSymbol)
  if (normalizedPhone === '[silence]') {
    return cloneWeights(REST_WEIGHTS)
  }

  const normalized = normalizeInworldVisemeSymbol(visemeSymbol)
  if (normalized && INWORLD_VISEME_WEIGHTS[normalized]) {
    return cloneWeights(INWORLD_VISEME_WEIGHTS[normalized])
  }

  const derived = deriveWeightsFromPhoneSymbol(normalizedPhone)
  return derived ? cloneWeights(derived) : null
}

function resolvePrimaryCue(weights: GoonLipSyncWeights): GoonLipSyncViseme {
  let bestCue: GoonLipSyncViseme = 'rest'
  let bestWeight = -1
  for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
    const weight = weights[cue] ?? 0
    if (weight > bestWeight) {
      bestCue = cue
      bestWeight = weight
    }
  }
  return bestCue
}

function normalizePhoneStartSec(
  phone: InworldPhoneDetail,
  segment: VoiceRealtimeTtsAlignmentSegment
): number | null {
  const raw =
    typeof phone.startTimeSeconds === 'number'
      ? phone.startTimeSeconds
      : Number(phone.startTimeSeconds)
  if (!Number.isFinite(raw)) return null

  if (raw + 0.02 >= segment.startSec && raw <= segment.endSec + 0.2) {
    return Math.max(0, raw)
  }

  const chunkOffsetSec =
    typeof segment.chunkAudioOffsetSec === 'number' && Number.isFinite(segment.chunkAudioOffsetSec)
      ? segment.chunkAudioOffsetSec
      : null
  if (chunkOffsetSec !== null && chunkOffsetSec > 0) {
    const chunkRelativeAbsolute = chunkOffsetSec + raw
    if (
      chunkRelativeAbsolute + 0.02 >= segment.startSec &&
      chunkRelativeAbsolute <= segment.endSec + 0.2
    ) {
      return Math.max(0, chunkRelativeAbsolute)
    }
  }

  if (raw + 0.02 < segment.startSec && segment.startSec > 0) {
    return segment.startSec + raw
  }

  return Math.max(0, raw)
}

function normalizePhoneDurationSec(
  phone: InworldPhoneDetail,
  segment: VoiceRealtimeTtsAlignmentSegment,
  startSec: number
): number {
  const raw =
    typeof phone.durationSeconds === 'number'
      ? phone.durationSeconds
      : Number(phone.durationSeconds)
  if (Number.isFinite(raw) && raw > 0) return raw
  return Math.max(MIN_PHONE_DURATION_MS / 1000, segment.endSec - startSec)
}

function pushKeyframe(
  keyframes: GoonLipSyncTimelineKeyframe[],
  timeMs: number,
  weights: GoonLipSyncWeights
) {
  const clampedTimeMs = Math.max(0, Math.round(timeMs))
  const last = keyframes[keyframes.length - 1]
  if (last && Math.abs(last.timeMs - clampedTimeMs) < 0.0001) {
    if (sameWeights(last.weights, weights)) {
      last.weights = cloneWeights(weights)
      return
    }

    keyframes.push({
      timeMs: clampedTimeMs,
      weights: cloneWeights(weights)
    })
    return
  }

  keyframes.push({
    timeMs: clampedTimeMs,
    weights: cloneWeights(weights)
  })
}

export function buildInworldVisemeLipSyncTimeline(options: {
  segments: VoiceRealtimeTtsAlignmentSegment[]
  sourceText: string
  durationMs?: number | null
}): GoonLipSyncTimeline | null {
  const visemeSymbolCounts: Record<string, number> = {}
  const phoneSymbolCounts: Record<string, number> = {}
  const primaryCueCounts: Partial<Record<GoonLipSyncViseme, number>> = {}
  const unmappedSymbolCounts = new Map<string, { phoneSymbol?: string; visemeSymbol?: string; count: number }>()
  let phoneCount = 0
  let mappedPhoneCount = 0
  let silencePhoneCount = 0

  const phones = options.segments
    .flatMap((segment) =>
      (segment.phoneticDetails ?? []).map((phone) => {
        phoneCount += 1
        const normalizedPhone = normalizePhoneSymbol(phone.phoneSymbol)
        const normalizedViseme = normalizeInworldVisemeSymbol(phone.visemeSymbol)
        countRecordValue(phoneSymbolCounts, normalizedPhone)
        countRecordValue(visemeSymbolCounts, normalizedViseme)
        if (normalizedPhone === '[silence]') {
          silencePhoneCount += 1
        }

        const startSec = normalizePhoneStartSec(phone, segment)
        if (startSec === null) return null
        const durationSec = normalizePhoneDurationSec(phone, segment, startSec)
        const weights = mapInworldVisemeToGoonLipSyncWeights(phone.visemeSymbol, phone.phoneSymbol)
        if (!weights) {
          const unmappedKey = `${normalizedPhone ?? ''}|${normalizedViseme ?? ''}`
          const existing = unmappedSymbolCounts.get(unmappedKey)
          if (existing) {
            existing.count += 1
          } else {
            unmappedSymbolCounts.set(unmappedKey, {
              ...(normalizedPhone ? { phoneSymbol: normalizedPhone } : {}),
              ...(normalizedViseme ? { visemeSymbol: normalizedViseme } : {}),
              count: 1
            })
          }
          return null
        }
        mappedPhoneCount += 1
        const primaryCue = resolvePrimaryCue(weights)
        primaryCueCounts[primaryCue] = (primaryCueCounts[primaryCue] ?? 0) + 1
        return {
          startMs: Math.max(0, Math.round(startSec * 1000)),
          endMs: Math.max(0, Math.round((startSec + durationSec) * 1000)),
          weights
        }
      })
    )
    .filter((phone): phone is { startMs: number; endMs: number; weights: GoonLipSyncWeights } =>
      Boolean(phone && phone.endMs >= phone.startMs)
    )
    .sort((left, right) => left.startMs - right.startMs)

  if (phones.length === 0) return null

  const keyframes: GoonLipSyncTimelineKeyframe[] = [{ timeMs: 0, weights: cloneWeights(REST_WEIGHTS) }]
  let lastEndMs = 0

  for (const phone of phones) {
    if (phone.startMs - lastEndMs > REST_GAP_THRESHOLD_MS) {
      pushKeyframe(keyframes, lastEndMs, REST_WEIGHTS)
      pushKeyframe(keyframes, phone.startMs, REST_WEIGHTS)
    }

    pushKeyframe(keyframes, phone.startMs, phone.weights)
    pushKeyframe(keyframes, Math.max(phone.startMs + MIN_PHONE_DURATION_MS, phone.endMs), phone.weights)
    lastEndMs = Math.max(lastEndMs, phone.endMs)
  }

  const segmentEndMs = Math.max(
    0,
    ...options.segments.map((segment) => Math.round(Math.max(segment.endSec, segment.startSec) * 1000))
  )
  const durationMs = Math.max(0, Math.round(options.durationMs ?? 0), segmentEndMs, lastEndMs)

  if (durationMs > lastEndMs) {
    pushKeyframe(keyframes, lastEndMs, REST_WEIGHTS)
  }
  pushKeyframe(keyframes, durationMs, REST_WEIGHTS)
  const chunkCount = new Set(
    options.segments
      .map((segment) => segment.chunkSeq)
      .filter((chunkSeq): chunkSeq is number => typeof chunkSeq === 'number' && Number.isFinite(chunkSeq))
  ).size
  const diagnostics: GoonLipSyncTimelineDiagnostics = {
    provider: 'inworld',
    phoneCount,
    mappedPhoneCount,
    silencePhoneCount,
    unmappedPhoneCount: Math.max(0, phoneCount - mappedPhoneCount),
    coveragePercent: phoneCount > 0 ? Math.round((mappedPhoneCount / phoneCount) * 1000) / 10 : 0,
    segmentCount: options.segments.length,
    chunkCount,
    durationMs,
    visemeSymbolCounts,
    phoneSymbolCounts,
    primaryCueCounts,
    unmappedSymbols: Array.from(unmappedSymbolCounts.values()).sort((left, right) => right.count - left.count)
  }

  return {
    analyzerId: 'inworld-viseme-timing',
    source: 'provider-alignment',
    keyframes,
    durationMs,
    unitCount: phones.length,
    sourceText: options.sourceText,
    diagnostics
  }
}
