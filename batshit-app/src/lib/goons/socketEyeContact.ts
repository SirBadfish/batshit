export const SOCKET_EYE_CONTACT_SETTINGS_SCHEMA_VERSION =
  'socket-eye-contact-settings/v2' as const

export const SOCKET_EYE_CONTACT_CONVERGENCE_MIN = -0.25
export const SOCKET_EYE_CONTACT_CONVERGENCE_MAX = 0.25

export type SocketEyeContactSettingsV2 = {
  schemaVersion: typeof SOCKET_EYE_CONTACT_SETTINGS_SCHEMA_VERSION
  enabled: boolean
  strength: number
  convergence: number
  headFollow: number
  response: number
}

export const DEFAULT_SOCKET_EYE_CONTACT_SETTINGS = Object.freeze({
  schemaVersion: SOCKET_EYE_CONTACT_SETTINGS_SCHEMA_VERSION,
  enabled: true,
  strength: 0.8,
  convergence: 0,
  headFollow: 0.5,
  response: 0.5
}) satisfies Readonly<SocketEyeContactSettingsV2>

function fail(message: string): never {
  throw new Error(`[socket-eye-contact-settings/v2] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function unitInterval(value: unknown, context: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${context} must be a finite number inside [0, 1]`)
  }
  return value
}

function convergenceInterval(value: unknown, context: string) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < SOCKET_EYE_CONTACT_CONVERGENCE_MIN ||
    value > SOCKET_EYE_CONTACT_CONVERGENCE_MAX
  ) {
    fail(
      `${context} must be a finite number inside ` +
        `[${SOCKET_EYE_CONTACT_CONVERGENCE_MIN}, ${SOCKET_EYE_CONTACT_CONVERGENCE_MAX}]`
    )
  }
  return value
}

export function parseSocketEyeContactSettings(value: unknown): SocketEyeContactSettingsV2 {
  const source = record(value, 'settings')
  const allowed = new Set([
    'schemaVersion',
    'enabled',
    'strength',
    'convergence',
    'headFollow',
    'response'
  ])
  const unsupported = Object.keys(source).filter((key) => !allowed.has(key))
  if (unsupported.length > 0) {
    fail(`settings contains unsupported fields: ${unsupported.join(', ')}`)
  }
  if (source.schemaVersion !== SOCKET_EYE_CONTACT_SETTINGS_SCHEMA_VERSION) {
    fail(`settings.schemaVersion must be ${SOCKET_EYE_CONTACT_SETTINGS_SCHEMA_VERSION}`)
  }
  if (typeof source.enabled !== 'boolean') fail('settings.enabled must be a boolean')
  return {
    schemaVersion: SOCKET_EYE_CONTACT_SETTINGS_SCHEMA_VERSION,
    enabled: source.enabled,
    strength: unitInterval(source.strength, 'settings.strength'),
    convergence: convergenceInterval(source.convergence, 'settings.convergence'),
    headFollow: unitInterval(source.headFollow, 'settings.headFollow'),
    response: unitInterval(source.response, 'settings.response')
  }
}

export function resolveSocketEyeContactSettings(
  value: SocketEyeContactSettingsV2 | null | undefined
): SocketEyeContactSettingsV2 {
  return value
    ? parseSocketEyeContactSettings(value)
    : { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS }
}

export function socketEyeContactResponseLerp(response: number) {
  const resolved = unitInterval(response, 'response')
  return 0.04 + resolved * 0.31
}
