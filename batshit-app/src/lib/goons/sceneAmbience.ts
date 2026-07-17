import type {
  GoonSceneAmbience,
  GoonSceneAmbiencePlacement,
  GoonSceneAmbiencePreset
} from '$lib/types/goons'

export const GOON_SCENE_AMBIENCE_PRESET_OPTIONS = [
  { value: 'rain', label: 'Rain' },
  { value: 'snow', label: 'Snow' },
  { value: 'embers', label: 'Embers' },
  { value: 'fireflies', label: 'Fireflies' },
  { value: 'dust', label: 'Dust / Pollen' },
  { value: 'petals', label: 'Petals' },
  { value: 'magic_sparks', label: 'Magic Sparks' },
  { value: 'mist', label: 'Mist' }
] as const satisfies Array<{ value: GoonSceneAmbiencePreset; label: string }>

export const GOON_SCENE_AMBIENCE_PLACEMENT_OPTIONS = [
  { value: 'whole_stage', label: 'Whole Stage' },
  { value: 'inside', label: 'Inside' },
  { value: 'outside', label: 'Outside' }
] as const satisfies Array<{ value: GoonSceneAmbiencePlacement; label: string }>

export const GOON_SCENE_AMBIENCE_DEFAULT_PRESET: GoonSceneAmbiencePreset = 'dust'
export const GOON_SCENE_AMBIENCE_DEFAULT_PLACEMENT: GoonSceneAmbiencePlacement = 'whole_stage'
export const GOON_SCENE_AMBIENCE_DEFAULT_INTENSITY = 0.45
export const GOON_SCENE_AMBIENCE_DEFAULT_SPEED = 1
export const GOON_SCENE_AMBIENCE_DEFAULT_WIND: [number, number] = [0.15, 0]
export const GOON_SCENE_AMBIENCE_MAX_WIND = 2

export type NormalizedGoonSceneAmbience = Required<GoonSceneAmbience>

const PRESET_VALUES = new Set<GoonSceneAmbiencePreset>(
  GOON_SCENE_AMBIENCE_PRESET_OPTIONS.map((option) => option.value)
)
const PLACEMENT_VALUES = new Set<GoonSceneAmbiencePlacement>(
  GOON_SCENE_AMBIENCE_PLACEMENT_OPTIONS.map((option) => option.value)
)

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  const numeric = Number.isFinite(parsed) ? parsed : fallback
  return Math.min(max, Math.max(min, numeric))
}

function normalizePreset(value: unknown): GoonSceneAmbiencePreset {
  return typeof value === 'string' && PRESET_VALUES.has(value as GoonSceneAmbiencePreset)
    ? (value as GoonSceneAmbiencePreset)
    : GOON_SCENE_AMBIENCE_DEFAULT_PRESET
}

function normalizePlacement(value: unknown): GoonSceneAmbiencePlacement {
  return typeof value === 'string' && PLACEMENT_VALUES.has(value as GoonSceneAmbiencePlacement)
    ? (value as GoonSceneAmbiencePlacement)
    : GOON_SCENE_AMBIENCE_DEFAULT_PLACEMENT
}

function normalizeWind(value: unknown): [number, number] {
  if (!Array.isArray(value)) return [...GOON_SCENE_AMBIENCE_DEFAULT_WIND]
  return [
    clampNumber(value[0], GOON_SCENE_AMBIENCE_DEFAULT_WIND[0], -GOON_SCENE_AMBIENCE_MAX_WIND, GOON_SCENE_AMBIENCE_MAX_WIND),
    clampNumber(value[1], GOON_SCENE_AMBIENCE_DEFAULT_WIND[1], -GOON_SCENE_AMBIENCE_MAX_WIND, GOON_SCENE_AMBIENCE_MAX_WIND)
  ]
}

export function normalizeGoonSceneAmbience(
  ambience?: GoonSceneAmbience | null
): NormalizedGoonSceneAmbience {
  const preset = normalizePreset(ambience?.preset)
  const seedFallback = preset.split('').reduce((sum, char) => sum + char.charCodeAt(0), 17)
  return {
    enabled: Boolean(ambience?.enabled),
    preset,
    placement: normalizePlacement(ambience?.placement),
    intensity: clampNumber(
      ambience?.intensity,
      GOON_SCENE_AMBIENCE_DEFAULT_INTENSITY,
      0,
      1
    ),
    speed: clampNumber(ambience?.speed, GOON_SCENE_AMBIENCE_DEFAULT_SPEED, 0.2, 2.5),
    wind: normalizeWind(ambience?.wind),
    seed: Math.round(clampNumber(ambience?.seed, seedFallback, 1, 2147483647))
  }
}
