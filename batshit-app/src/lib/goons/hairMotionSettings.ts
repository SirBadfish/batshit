export const HAIR_MOTION_SETTINGS_CONTRACT = 'hair-motion-settings/v2' as const
export const HAIR_ROOT_WEIGHTED_MOTION_TAG = 'root-weighted-motion-v2' as const
export const HAIR_MOTION_INTENSITY_MIN = 0 as const
export const HAIR_MOTION_INTENSITY_MAX = 1.5 as const
export const HAIR_MOTION_DEFAULT_INTENSITY = 1 as const

export type HairMotionSettingsV2 = {
  enabled: boolean
  intensity: number
}

function fail(message: string): never {
  throw new Error(`[${HAIR_MOTION_SETTINGS_CONTRACT}] ${message}`)
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be finite`)
  }
  return Object.is(value, -0) ? 0 : value
}

export function parseHairMotionSettings(value: unknown): HairMotionSettingsV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('settings must be an object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('settings must be a plain object')
  }
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw).sort()
  if (keys.length !== 2 || keys[0] !== 'enabled' || keys[1] !== 'intensity') {
    fail('settings must contain exactly: enabled, intensity')
  }
  if (typeof raw.enabled !== 'boolean') {
    fail('enabled must be boolean')
  }
  const intensity = finite(raw.intensity, 'intensity')
  if (intensity < HAIR_MOTION_INTENSITY_MIN || intensity > HAIR_MOTION_INTENSITY_MAX) {
    fail(`intensity must be between ${HAIR_MOTION_INTENSITY_MIN} and ${HAIR_MOTION_INTENSITY_MAX}`)
  }
  return { enabled: raw.enabled, intensity }
}
