export const AMBIENT_BLINK_INTERVAL_MIN_MS = 2000
export const AMBIENT_BLINK_INTERVAL_MAX_MS = 5000
export const AMBIENT_BLINK_DURATION_MIN_MS = 100
export const AMBIENT_BLINK_DURATION_MAX_MS = 220
export const AMBIENT_BLINK_SLOW_DURATION_MIN_MS = 220
export const AMBIENT_BLINK_SLOW_DURATION_MAX_MS = 320
export const AMBIENT_BLINK_SLOW_CHANCE = 0.15

export type AmbientBlinkState = {
  nextBlinkAt: number
  activeBlink: {
    startedAt: number
    durationMs: number
  } | null
}

export type AmbientBlinkUpdateOptions = {
  canBlink?: boolean
  random?: () => number
}

function lerp(min: number, max: number, t: number) {
  return min + (max - min) * t
}

function sampleRange(min: number, max: number, random: () => number) {
  return lerp(min, max, random())
}

export function sampleAmbientBlinkIntervalMs(random: () => number) {
  return sampleRange(AMBIENT_BLINK_INTERVAL_MIN_MS, AMBIENT_BLINK_INTERVAL_MAX_MS, random)
}

export function sampleAmbientBlinkDurationMs(random: () => number) {
  const useSlowBlink = random() < AMBIENT_BLINK_SLOW_CHANCE
  if (useSlowBlink) {
    return sampleRange(AMBIENT_BLINK_SLOW_DURATION_MIN_MS, AMBIENT_BLINK_SLOW_DURATION_MAX_MS, random)
  }
  return sampleRange(AMBIENT_BLINK_DURATION_MIN_MS, AMBIENT_BLINK_DURATION_MAX_MS, random)
}

export function createAmbientBlinkState(now: number, random: () => number = Math.random): AmbientBlinkState {
  return {
    nextBlinkAt: now + sampleAmbientBlinkIntervalMs(random),
    activeBlink: null
  }
}

export function resolveAmbientBlinkWeight(progress: number) {
  const clamped = Math.max(0, Math.min(1, progress))
  if (clamped <= 0 || clamped >= 1) return 0
  return Math.sin(clamped * Math.PI)
}

export function updateAmbientBlinkState(
  state: AmbientBlinkState,
  now: number,
  options: AmbientBlinkUpdateOptions = {}
) {
  const random = options.random ?? Math.random
  const canBlink = options.canBlink ?? true
  const nextState: AmbientBlinkState = {
    nextBlinkAt: state.nextBlinkAt,
    activeBlink: state.activeBlink ? { ...state.activeBlink } : null
  }

  if (!canBlink) {
    nextState.activeBlink = null
    if (nextState.nextBlinkAt <= now) {
      nextState.nextBlinkAt = now + sampleAmbientBlinkIntervalMs(random)
    }
    return { state: nextState, weight: 0 }
  }

  if (nextState.activeBlink) {
    const progress = (now - nextState.activeBlink.startedAt) / nextState.activeBlink.durationMs
    if (progress >= 1) {
      nextState.activeBlink = null
      nextState.nextBlinkAt = now + sampleAmbientBlinkIntervalMs(random)
      return { state: nextState, weight: 0 }
    }
    return {
      state: nextState,
      weight: resolveAmbientBlinkWeight(progress)
    }
  }

  if (now < nextState.nextBlinkAt) {
    return { state: nextState, weight: 0 }
  }

  nextState.activeBlink = {
    startedAt: now,
    durationMs: sampleAmbientBlinkDurationMs(random)
  }

  return { state: nextState, weight: 0 }
}
