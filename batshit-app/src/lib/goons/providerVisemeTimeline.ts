import {
  OVR_15_SPEECH_FACE_PROFILE,
  OVR_15_VISEME_ORDER,
  createEmptyOvr15Weights,
  type Ovr15Viseme,
  type Ovr15Weights
} from '$lib/goons/speechFaceProfiles'
import type { VoiceRealtimeTtsAlignmentSegment } from '$lib/types/voiceRealtime'
import type {
  GoonLipSyncTimeline,
  GoonLipSyncTimelineDiagnostics,
  GoonLipSyncTimelineKeyframe
} from '$lib/utils/goonLipSync'

type InworldPhoneDetail = NonNullable<VoiceRealtimeTtsAlignmentSegment['phoneticDetails']>[number]

const MIN_PHONE_DURATION_MS = 24
const REST_GAP_THRESHOLD_MS = 35

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function createWeights(patch: Partial<Ovr15Weights>): Ovr15Weights {
  const weights = createEmptyOvr15Weights()
  for (const viseme of OVR_15_VISEME_ORDER) {
    weights[viseme] = clamp01(patch[viseme] ?? 0)
  }
  return weights
}

const REST_WEIGHTS = createWeights({ sil: 1 })

const INWORLD_VISEME_FALLBACK: Record<string, Ovr15Viseme> = {
  aei: 'aa',
  o: 'O',
  ee: 'I',
  bmp: 'PP',
  fv: 'FF',
  l: 'nn',
  r: 'RR',
  th: 'TH',
  qw: 'U',
  chjsh: 'CH',
  cdgknstxyz: 'SS'
}

const countRecordValue = (record: Record<string, number>, key: string | null) => {
  if (!key) return
  record[key] = (record[key] ?? 0) + 1
}

function cloneWeights(weights: Ovr15Weights): Ovr15Weights {
  return { ...weights }
}

function sameWeights(left: Ovr15Weights, right: Ovr15Weights): boolean {
  return OVR_15_VISEME_ORDER.every(
    (viseme) => Math.abs((left[viseme] ?? 0) - (right[viseme] ?? 0)) < 0.0001
  )
}

function normalizeInworldVisemeSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function normalizePhoneSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[0-9]/g, '')
  return normalized || null
}

function resolveOvrVisemeFromInworldPhone(
  visemeSymbol: string | null,
  phoneSymbol: string | null
): Ovr15Viseme | null {
  if (phoneSymbol === '[silence]') return 'sil'
  if (!phoneSymbol) return visemeSymbol ? INWORLD_VISEME_FALLBACK[visemeSymbol] ?? null : null

  if (visemeSymbol === 'aei') {
    if (/[iɪy]/.test(phoneSymbol)) return 'I'
    if (/[eɛ]/.test(phoneSymbol)) return 'E'
    return 'aa'
  }
  if (visemeSymbol === 'o') return /[uʊ]/.test(phoneSymbol) ? 'U' : 'O'
  if (visemeSymbol === 'ee') return /[eɛ]/.test(phoneSymbol) ? 'E' : 'I'
  if (visemeSymbol === 'cdgknstxyz') {
    if (phoneSymbol.includes('tʃ') || phoneSymbol.includes('dʒ') || /sh|ch|j|ʃ|ʝ/.test(phoneSymbol)) return 'CH'
    if (/[kgq]/.test(phoneSymbol)) return 'kk'
    if (/[td]/.test(phoneSymbol)) return 'DD'
    if (/[nlɫ]/.test(phoneSymbol)) return 'nn'
    return 'SS'
  }

  const categoryFallback = visemeSymbol ? INWORLD_VISEME_FALLBACK[visemeSymbol] ?? null : null
  if (categoryFallback) return categoryFallback

  if (/[bmp]/.test(phoneSymbol)) return 'PP'
  if (/[fv]/.test(phoneSymbol)) return 'FF'
  if (phoneSymbol.includes('θ') || phoneSymbol.includes('ð') || phoneSymbol === 'th') return 'TH'
  if (phoneSymbol.includes('tʃ') || phoneSymbol.includes('dʒ') || /sh|ch|j|ʃ|ʝ/.test(phoneSymbol)) return 'CH'
  if (/[kgq]/.test(phoneSymbol)) return 'kk'
  if (/[td]/.test(phoneSymbol)) return 'DD'
  if (/[szx]/.test(phoneSymbol)) return 'SS'
  if (/[nlɫ]/.test(phoneSymbol)) return 'nn'
  if (/[rɝɚ]/.test(phoneSymbol)) return 'RR'
  if (/[uʊwʍ]/.test(phoneSymbol)) return 'U'
  if (/[oʊɔ]/.test(phoneSymbol)) return 'O'
  if (/[iɪy]/.test(phoneSymbol)) return 'I'
  if (/[eɛ]/.test(phoneSymbol)) return 'E'
  if (/[aæɑəʌ]/.test(phoneSymbol)) return 'aa'
  return null
}

export function mapInworldVisemeToOvr15Weights(
  visemeSymbol: unknown,
  phoneSymbol?: unknown
): Ovr15Weights | null {
  const normalizedPhone = normalizePhoneSymbol(phoneSymbol)
  const normalizedViseme = normalizeInworldVisemeSymbol(visemeSymbol)
  const ovrViseme = resolveOvrVisemeFromInworldPhone(normalizedViseme, normalizedPhone)
  return ovrViseme ? createWeights({ [ovrViseme]: 1 }) : null
}

function resolvePrimaryCue(weights: Ovr15Weights): Ovr15Viseme {
  let bestCue: Ovr15Viseme = 'sil'
  let bestWeight = -1
  for (const cue of OVR_15_VISEME_ORDER) {
    const weight = weights[cue]
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
  weights: Ovr15Weights
) {
  const clampedTimeMs = Math.max(0, Math.round(timeMs))
  const last = keyframes[keyframes.length - 1]
  if (last && Math.abs(last.timeMs - clampedTimeMs) < 0.0001) {
    if (last.frame.profile !== OVR_15_SPEECH_FACE_PROFILE) {
      throw new Error('Inworld OVR-15 timeline cannot contain a non-OVR speech-face frame.')
    }
    if (sameWeights(last.frame.weights, weights)) {
      last.frame = { profile: OVR_15_SPEECH_FACE_PROFILE, weights: cloneWeights(weights) }
      return
    }

    keyframes.push({
      timeMs: clampedTimeMs,
      frame: { profile: OVR_15_SPEECH_FACE_PROFILE, weights: cloneWeights(weights) }
    })
    return
  }

  keyframes.push({
    timeMs: clampedTimeMs,
    frame: { profile: OVR_15_SPEECH_FACE_PROFILE, weights: cloneWeights(weights) }
  })
}

export function buildInworldVisemeLipSyncTimeline(options: {
  segments: VoiceRealtimeTtsAlignmentSegment[]
  sourceText: string
  durationMs?: number | null
}): GoonLipSyncTimeline | null {
  const visemeSymbolCounts: Record<string, number> = {}
  const phoneSymbolCounts: Record<string, number> = {}
  const primaryCueCounts: Record<string, number> = {}
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
        const weights = mapInworldVisemeToOvr15Weights(phone.visemeSymbol, phone.phoneSymbol)
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
    .filter((phone): phone is { startMs: number; endMs: number; weights: Ovr15Weights } =>
      Boolean(phone && phone.endMs >= phone.startMs)
    )
    .sort((left, right) => left.startMs - right.startMs)

  if (phones.length === 0) return null

  const keyframes: GoonLipSyncTimelineKeyframe[] = [
    {
      timeMs: 0,
      frame: { profile: OVR_15_SPEECH_FACE_PROFILE, weights: cloneWeights(REST_WEIGHTS) }
    }
  ]
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
    profile: OVR_15_SPEECH_FACE_PROFILE,
    keyframes,
    durationMs,
    unitCount: phones.length,
    sourceText: options.sourceText,
    diagnostics
  }
}
