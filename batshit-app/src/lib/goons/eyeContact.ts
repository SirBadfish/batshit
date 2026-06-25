import type {
  GoonEyeContactMode,
  GoonEyeContactTuning,
  ResolvedGoonEyeContactTuning
} from '$lib/types/goons'

export type EyeContactChannels = {
  amount: number
  eyeYaw: number
  eyePitch: number
  headYaw: number
  headPitch: number
}

export type EyeContactTravelDirection = 'out' | 'in'

export type EyeLookApplierType = 'bone' | 'expression' | 'unknown'
export type EyeLookRuntimeLane =
  | 'bone-look-at'
  | 'expression-look-at'
  | 'expression-presets'
  | 'expression-guided-controls'
  | 'none'

export type EyeLookRuntimeResolutionInput = {
  requestedMode: GoonEyeContactMode
  lookAtApplierType: EyeLookApplierType | null
  hasUsableLookAtEyeBones: boolean
  hasUsableLookExpressions: boolean
  hasGuidedDirectionControls: boolean
}

export type EyeContactMotionInput = {
  yawTravel?: EyeContactTravelDirection
  pitchTravel?: EyeContactTravelDirection
}

const FRONT_YAW_DEG = 14
const WIDE_YAW_DEG = 52
const GIVE_UP_YAW_DEG = 92
const FRONT_PITCH_DEG = 8
const WIDE_PITCH_DEG = 22
const GIVE_UP_PITCH_DEG = 40
const FADE_YAW_OVERFLOW_DEG = 27
const FADE_PITCH_OVERFLOW_DEG = 18
const EYE_MAX_YAW = 0.72
const EYE_MAX_PITCH = 0.55
const HEAD_MAX_YAW = 1
const HEAD_MAX_PITCH = 1
const HEAD_YAW_CURVE_EXPONENT = 2
const HEAD_YAW_TARGET_COVERAGE_DEG = 18
const HEAD_PITCH_TARGET_COVERAGE_DEG = 9
const MIN_TARGET_CAPACITY_DEG = 0.0001
const DEFAULT_TUNING: ResolvedGoonEyeContactTuning = {
  eyeYawSensitivity: 1,
  eyeYawRange: 1,
  eyePitchSensitivity: 1,
  eyePitchRange: 1,
  headYawStartOutDeg: FRONT_YAW_DEG,
  headYawStartInDeg: WIDE_YAW_DEG,
  headYawSensitivity: 1,
  headYawRange: 1,
  headYawSpeed: 1,
  headPitchStartOutDeg: FRONT_PITCH_DEG,
  headPitchStartInDeg: WIDE_PITCH_DEG,
  headPitchSensitivity: 1,
  headPitchRange: 1,
  headPitchSpeed: 1,
  eyeYawHeadCompensation: 1,
  eyePitchHeadCompensation: 1
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function smoothstep(edge0: number, edge1: number, x: number) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function resolveHeadBias(
  axisAbsDeg: number,
  startOutDeg: number,
  startInDeg: number,
  fullOutDeg: number,
  travel: EyeContactTravelDirection
) {
  if (travel === 'in') {
    return smoothstep(0, Math.max(1, startInDeg), axisAbsDeg)
  }

  return smoothstep(startOutDeg, Math.max(startOutDeg + 1, fullOutDeg), axisAbsDeg)
}

type SharedTargetAxisConfig = {
  fullOutDeg: number
  giveUpDeg: number
  fadeOverflowDeg: number
  eyeMax: number
  headMax: number
  headTargetCoverageDeg: number
  headCurveExponent?: number
}

type SharedTargetAxisTuning = {
  eyeSensitivity: number
  eyeRange: number
  headStartOutDeg: number
  headStartInDeg: number
  headSensitivity: number
  headRange: number
  headTargetCompensation: number
}

type SharedTargetAxisResult = {
  amount: number
  eye: number
  head: number
}

function resolveSharedTargetAxis(
  axisDeg: number,
  tuning: SharedTargetAxisTuning,
  config: SharedTargetAxisConfig,
  travel: EyeContactTravelDirection
): SharedTargetAxisResult {
  const axisAbsDeg = Math.abs(axisDeg)
  const direction = axisDeg === 0 ? 0 : axisDeg > 0 ? 1 : -1
  const headBias = resolveHeadBias(
    axisAbsDeg,
    tuning.headStartOutDeg,
    tuning.headStartInDeg,
    config.fullOutDeg,
    travel
  )
  const curvedHeadBias =
    travel === 'in' ? headBias : Math.pow(headBias, config.headCurveExponent ?? 1)
  const headStrength = clamp01(curvedHeadBias * tuning.headSensitivity)
  const effectiveHeadCoverageDeg =
    config.headTargetCoverageDeg *
    headStrength *
    tuning.headRange *
    tuning.headTargetCompensation
  const maxHeadCoverageDeg =
    config.headTargetCoverageDeg *
    clamp01(tuning.headSensitivity) *
    tuning.headRange *
    tuning.headTargetCompensation
  const effectiveEyeCapacityDeg =
    tuning.eyeRange <= 0 || tuning.eyeSensitivity <= 0
      ? 0
      : ((config.giveUpDeg - config.headTargetCoverageDeg) * tuning.eyeRange) /
        tuning.eyeSensitivity
  const remainingEyeTargetDeg = Math.max(0, axisAbsDeg - effectiveHeadCoverageDeg)
  const eyeStrength =
    effectiveEyeCapacityDeg > MIN_TARGET_CAPACITY_DEG
      ? clamp01(remainingEyeTargetDeg / effectiveEyeCapacityDeg)
      : 0
  const giveUpStartDeg = maxHeadCoverageDeg + effectiveEyeCapacityDeg
  const amount =
    giveUpStartDeg > MIN_TARGET_CAPACITY_DEG
      ? 1 -
        smoothstep(
          0,
          config.fadeOverflowDeg,
          Math.max(0, axisAbsDeg - giveUpStartDeg)
        )
      : 0

  return {
    amount,
    eye: direction * eyeStrength * config.eyeMax,
    head: direction * headStrength * config.headMax
  }
}

function resolveNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return clamp(numeric, min, max)
}

function resolveTuning(tuning?: GoonEyeContactTuning | null): ResolvedGoonEyeContactTuning {
  const legacy = tuning as
    | (GoonEyeContactTuning & {
        yawStrength?: number
        pitchStrength?: number
        headStartDeg?: number
        headStrength?: number
      })
    | undefined

  return {
    eyeYawSensitivity: resolveNumber(
      tuning?.eyeYawSensitivity ?? legacy?.yawStrength,
      DEFAULT_TUNING.eyeYawSensitivity,
      0,
      8
    ),
    eyeYawRange: resolveNumber(
      tuning?.eyeYawRange ?? legacy?.yawStrength,
      DEFAULT_TUNING.eyeYawRange,
      0,
      8
    ),
    eyePitchSensitivity: resolveNumber(
      tuning?.eyePitchSensitivity ?? legacy?.pitchStrength,
      DEFAULT_TUNING.eyePitchSensitivity,
      0,
      8
    ),
    eyePitchRange: resolveNumber(
      tuning?.eyePitchRange ?? legacy?.pitchStrength,
      DEFAULT_TUNING.eyePitchRange,
      0,
      8
    ),
    headYawStartOutDeg: resolveNumber(
      tuning?.headYawStartOutDeg ?? tuning?.headYawStartDeg ?? legacy?.headStartDeg,
      DEFAULT_TUNING.headYawStartOutDeg,
      0,
      90
    ),
    headYawStartInDeg: resolveNumber(
      tuning?.headYawStartInDeg,
      DEFAULT_TUNING.headYawStartInDeg,
      0,
      90
    ),
    headYawSensitivity: resolveNumber(
      tuning?.headYawSensitivity ?? legacy?.headStrength,
      DEFAULT_TUNING.headYawSensitivity,
      0,
      8
    ),
    headYawRange: resolveNumber(
      tuning?.headYawRange ?? legacy?.headStrength,
      DEFAULT_TUNING.headYawRange,
      0,
      8
    ),
    headYawSpeed: resolveNumber(tuning?.headYawSpeed, DEFAULT_TUNING.headYawSpeed, 0.05, 3),
    headPitchStartOutDeg: resolveNumber(
      tuning?.headPitchStartOutDeg ?? tuning?.headPitchStartDeg,
      DEFAULT_TUNING.headPitchStartOutDeg,
      0,
      90
    ),
    headPitchStartInDeg: resolveNumber(
      tuning?.headPitchStartInDeg,
      DEFAULT_TUNING.headPitchStartInDeg,
      0,
      90
    ),
    headPitchSensitivity: resolveNumber(
      tuning?.headPitchSensitivity ?? legacy?.headStrength,
      DEFAULT_TUNING.headPitchSensitivity,
      0,
      8
    ),
    headPitchRange: resolveNumber(
      tuning?.headPitchRange ?? legacy?.headStrength,
      DEFAULT_TUNING.headPitchRange,
      0,
      8
    ),
    headPitchSpeed: resolveNumber(tuning?.headPitchSpeed, DEFAULT_TUNING.headPitchSpeed, 0.05, 3),
    eyeYawHeadCompensation: resolveNumber(
      tuning?.eyeYawHeadCompensation,
      DEFAULT_TUNING.eyeYawHeadCompensation,
      0,
      5
    ),
    eyePitchHeadCompensation: resolveNumber(
      tuning?.eyePitchHeadCompensation,
      DEFAULT_TUNING.eyePitchHeadCompensation,
      0,
      5
    )
  }
}

export function resolveEyeContactChannels(
  yawDeg: number,
  pitchDeg: number,
  tuning?: GoonEyeContactTuning | null,
  motion?: EyeContactMotionInput
): EyeContactChannels {
  const resolvedTuning = resolveTuning(tuning)
  const yawTravel = motion?.yawTravel ?? 'out'
  const pitchTravel = motion?.pitchTravel ?? 'out'

  const yaw = resolveSharedTargetAxis(
    yawDeg,
    {
      eyeSensitivity: resolvedTuning.eyeYawSensitivity,
      eyeRange: resolvedTuning.eyeYawRange,
      headStartOutDeg: resolvedTuning.headYawStartOutDeg,
      headStartInDeg: resolvedTuning.headYawStartInDeg,
      headSensitivity: resolvedTuning.headYawSensitivity,
      headRange: resolvedTuning.headYawRange,
      headTargetCompensation: resolvedTuning.eyeYawHeadCompensation
    },
    {
      fullOutDeg: WIDE_YAW_DEG,
      giveUpDeg: GIVE_UP_YAW_DEG,
      fadeOverflowDeg: FADE_YAW_OVERFLOW_DEG,
      eyeMax: EYE_MAX_YAW,
      headMax: HEAD_MAX_YAW,
      headTargetCoverageDeg: HEAD_YAW_TARGET_COVERAGE_DEG,
      headCurveExponent: HEAD_YAW_CURVE_EXPONENT
    },
    yawTravel
  )
  const pitch = resolveSharedTargetAxis(
    pitchDeg,
    {
      eyeSensitivity: resolvedTuning.eyePitchSensitivity,
      eyeRange: resolvedTuning.eyePitchRange,
      headStartOutDeg: resolvedTuning.headPitchStartOutDeg,
      headStartInDeg: resolvedTuning.headPitchStartInDeg,
      headSensitivity: resolvedTuning.headPitchSensitivity,
      headRange: resolvedTuning.headPitchRange,
      headTargetCompensation: resolvedTuning.eyePitchHeadCompensation
    },
    {
      fullOutDeg: WIDE_PITCH_DEG,
      giveUpDeg: GIVE_UP_PITCH_DEG,
      fadeOverflowDeg: FADE_PITCH_OVERFLOW_DEG,
      eyeMax: EYE_MAX_PITCH,
      headMax: HEAD_MAX_PITCH,
      headTargetCoverageDeg: HEAD_PITCH_TARGET_COVERAGE_DEG
    },
    pitchTravel
  )
  const amount = Math.min(yaw.amount, pitch.amount)

  return {
    amount,
    eyeYaw: yaw.eye,
    eyePitch: pitch.eye,
    headYaw: yaw.head,
    headPitch: pitch.head
  }
}

export function resolveEyeLookExpressionWeights(
  eyeYaw: number,
  eyePitch: number,
  tuning?: GoonEyeContactTuning | null
) {
  const resolvedTuning = resolveTuning(tuning)
  return {
    lookLeft: Math.max(0, eyeYaw) * resolvedTuning.eyeYawRange,
    lookRight: Math.max(0, -eyeYaw) * resolvedTuning.eyeYawRange,
    lookUp: Math.max(0, -eyePitch) * resolvedTuning.eyePitchRange,
    lookDown: Math.max(0, eyePitch) * resolvedTuning.eyePitchRange
  }
}

export function resolveEyeLookRuntimeLane(
  input: EyeLookRuntimeResolutionInput
): EyeLookRuntimeLane {
  if (input.requestedMode === 'bone') {
    return input.lookAtApplierType === 'bone' && input.hasUsableLookAtEyeBones
      ? 'bone-look-at'
      : 'none'
  }

  if (input.lookAtApplierType === 'expression' && input.hasUsableLookExpressions) {
    return 'expression-look-at'
  }

  if (input.hasUsableLookExpressions) {
    return 'expression-presets'
  }

  if (input.hasGuidedDirectionControls) {
    return 'expression-guided-controls'
  }

  return 'none'
}
