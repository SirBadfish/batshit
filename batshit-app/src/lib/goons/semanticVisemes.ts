import type { LegacyGoonLipSyncWeights } from '$lib/utils/goonLipSync'

export type CustomRhubarbMouthCue =
  | 'rest'
  | 'closed'
  | 'clenched'
  | 'mid_open'
  | 'wide_open'
  | 'round'
  | 'pucker'
  | 'teeth_lip'
  | 'tongue_lift'

export type CustomRhubarbMouthWeights = Record<CustomRhubarbMouthCue, number>

export type RhubarbCueValue = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'X'

export const CUSTOM_RHUBARB_MOUTH_ORDER: CustomRhubarbMouthCue[] = [
  'rest',
  'closed',
  'clenched',
  'mid_open',
  'wide_open',
  'round',
  'pucker',
  'teeth_lip',
  'tongue_lift'
]

export const CUSTOM_RHUBARB_LIP_SYNC_MOUTH_ORDER: Exclude<CustomRhubarbMouthCue, 'rest'>[] = [
  'closed',
  'clenched',
  'mid_open',
  'wide_open',
  'round',
  'pucker',
  'teeth_lip',
  'tongue_lift'
]

const ZERO_CUSTOM_RHUBARB_MOUTH_WEIGHTS: CustomRhubarbMouthWeights = {
  rest: 0,
  closed: 0,
  clenched: 0,
  mid_open: 0,
  wide_open: 0,
  round: 0,
  pucker: 0,
  teeth_lip: 0,
  tongue_lift: 0
}

const ZERO_GOON_WEIGHTS: LegacyGoonLipSyncWeights = {
  aa: 0,
  ih: 0,
  ou: 0,
  ee: 0,
  oh: 0
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function createCustomRhubarbMouthWeights(
  patch: Partial<CustomRhubarbMouthWeights>
): CustomRhubarbMouthWeights {
  const weights = { ...ZERO_CUSTOM_RHUBARB_MOUTH_WEIGHTS }
  for (const cue of CUSTOM_RHUBARB_MOUTH_ORDER) {
    weights[cue] = clamp01(patch[cue] ?? 0)
  }
  return weights
}

export const RHUBARB_CUE_TO_CUSTOM_RHUBARB_MOUTH: Record<
  RhubarbCueValue,
  CustomRhubarbMouthCue
> = {
  X: 'rest',
  A: 'closed',
  B: 'clenched',
  C: 'mid_open',
  D: 'wide_open',
  E: 'round',
  F: 'pucker',
  G: 'teeth_lip',
  H: 'tongue_lift'
}

export const RHUBARB_CUE_TO_CUSTOM_RHUBARB_MOUTH_WEIGHTS: Record<
  RhubarbCueValue,
  CustomRhubarbMouthWeights
> = {
  X: createCustomRhubarbMouthWeights({ rest: 1 }),
  A: createCustomRhubarbMouthWeights({ closed: 1 }),
  B: createCustomRhubarbMouthWeights({ clenched: 0.9, mid_open: 0.08 }),
  C: createCustomRhubarbMouthWeights({ mid_open: 0.86, wide_open: 0.18 }),
  D: createCustomRhubarbMouthWeights({ wide_open: 1, mid_open: 0.16 }),
  E: createCustomRhubarbMouthWeights({ round: 0.82, pucker: 0.18, mid_open: 0.12 }),
  F: createCustomRhubarbMouthWeights({ pucker: 0.96, round: 0.34 }),
  G: createCustomRhubarbMouthWeights({ teeth_lip: 1 }),
  H: createCustomRhubarbMouthWeights({ tongue_lift: 0.95, mid_open: 0.5 })
}

export const CUSTOM_RHUBARB_MOUTH_TO_GOON_WEIGHTS: Record<
  CustomRhubarbMouthCue,
  LegacyGoonLipSyncWeights
> = {
  rest: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
  closed: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
  clenched: { aa: 0, ih: 0.32, ou: 0, ee: 0.72, oh: 0 },
  mid_open: { aa: 0.58, ih: 0.26, ou: 0, ee: 0.12, oh: 0.04 },
  wide_open: { aa: 1, ih: 0.08, ou: 0, ee: 0, oh: 0.1 },
  round: { aa: 0.12, ih: 0, ou: 0.18, ee: 0, oh: 0.74 },
  pucker: { aa: 0, ih: 0, ou: 0.96, ee: 0, oh: 0.34 },
  teeth_lip: { aa: 0, ih: 0, ou: 0.08, ee: 0, oh: 0.12 },
  tongue_lift: { aa: 0.58, ih: 0.26, ou: 0, ee: 0.12, oh: 0.04 }
}

function cloneCustomRhubarbMouthWeights(
  weights: CustomRhubarbMouthWeights
): CustomRhubarbMouthWeights {
  return { ...weights }
}

export function createEmptyCustomRhubarbMouthWeights(): CustomRhubarbMouthWeights {
  return cloneCustomRhubarbMouthWeights(ZERO_CUSTOM_RHUBARB_MOUTH_WEIGHTS)
}

function normalizeRhubarbCueValue(value: string | undefined): RhubarbCueValue | null {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  if (normalized in RHUBARB_CUE_TO_CUSTOM_RHUBARB_MOUTH_WEIGHTS) {
    return normalized as RhubarbCueValue
  }
  return null
}

export function mapRhubarbCueToCustomRhubarbMouthWeights(
  value: string
): CustomRhubarbMouthWeights {
  const cueValue = normalizeRhubarbCueValue(value) ?? 'X'
  return cloneCustomRhubarbMouthWeights(RHUBARB_CUE_TO_CUSTOM_RHUBARB_MOUTH_WEIGHTS[cueValue])
}

export function downmixCustomRhubarbMouthToGoonWeights(
  weights: Partial<Record<CustomRhubarbMouthCue, number>>
): LegacyGoonLipSyncWeights {
  const next = { ...ZERO_GOON_WEIGHTS }

  for (const [visemeName, contribution] of Object.entries(
    CUSTOM_RHUBARB_MOUTH_TO_GOON_WEIGHTS
  ) as Array<[CustomRhubarbMouthCue, LegacyGoonLipSyncWeights]>) {
    const amount = clamp01(weights[visemeName] ?? 0)
    if (amount <= 0) continue

    next.aa += contribution.aa * amount
    next.ih += contribution.ih * amount
    next.ou += contribution.ou * amount
    next.ee += contribution.ee * amount
    next.oh += contribution.oh * amount
  }

  next.aa = clamp01(next.aa)
  next.ih = clamp01(next.ih)
  next.ou = clamp01(next.ou)
  next.ee = clamp01(next.ee)
  next.oh = clamp01(next.oh)

  return next
}
