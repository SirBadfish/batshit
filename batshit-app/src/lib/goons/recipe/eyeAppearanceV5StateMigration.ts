export const LEGACY_EYE_APPEARANCE_DEFINITION_V4 = 'eye-appearance/v4' as const
export const LEGACY_EYE_APPEARANCE_STATE_V4 = 'eye-appearance-state/v4' as const
export const TARGET_EYE_APPEARANCE_DEFINITION_V5 = 'eye-appearance/v5' as const
export const TARGET_EYE_APPEARANCE_STATE_V5 = 'eye-appearance-state/v5' as const

export const EYE_APPEARANCE_V5_MIGRATION = {
  irisSizeDivisor: 1.35,
  pupilSizeDivisor: 1.4,
  irisHorizontalOffset: 0.5,
  irisVerticalOffset: 0.7
} as const

export type EyeAppearanceStateV4MigrationSource = {
  schemaVersion: typeof LEGACY_EYE_APPEARANCE_STATE_V4
  definitionSha256: string
  irisSize: number
  pupilSize: number
  irisHorizontalPosition: number
  irisVerticalPosition: number
}

export type EyeAppearanceStateV5MigrationTarget = {
  schemaVersion: typeof TARGET_EYE_APPEARANCE_STATE_V5
  definitionSha256: string
  irisSize: number
  pupilSize: number
  irisHorizontalPosition: number
  irisVerticalPosition: number
}

export type EyeAppearanceStateBounds = {
  irisSize: readonly [number, number]
  pupilSize: readonly [number, number]
  irisHorizontalPosition: readonly [number, number]
  irisVerticalPosition: readonly [number, number]
}

export type EyeAppearanceV4MigrationBinding = {
  schemaVersion: typeof LEGACY_EYE_APPEARANCE_DEFINITION_V4
  stateSchemaVersion: typeof LEGACY_EYE_APPEARANCE_STATE_V4
  definitionSha256: string
  bounds: EyeAppearanceStateBounds
}

export type EyeAppearanceV5MigrationBinding = {
  schemaVersion: typeof TARGET_EYE_APPEARANCE_DEFINITION_V5
  stateSchemaVersion: typeof TARGET_EYE_APPEARANCE_STATE_V5
  definitionSha256: string
  bounds: EyeAppearanceStateBounds
}

export type EyeAppearanceV5StateMigrationInput = {
  source: EyeAppearanceV4MigrationBinding
  target: EyeAppearanceV5MigrationBinding
  state: unknown
}

export type EyeAppearanceV5StateMigrationErrorCode =
  | 'INVALID_BINDING'
  | 'INCOMPATIBLE_SOURCE'
  | 'OUT_OF_BOUNDS'

export class EyeAppearanceV5StateMigrationError extends Error {
  constructor(
    readonly code: EyeAppearanceV5StateMigrationErrorCode,
    message: string
  ) {
    super(`[eye-appearance-state/v4->v5] ${message}`)
    this.name = 'EyeAppearanceV5StateMigrationError'
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const STATE_KEYS = [
  'schemaVersion',
  'definitionSha256',
  'irisSize',
  'pupilSize',
  'irisHorizontalPosition',
  'irisVerticalPosition'
] as const
const BOUND_KEYS = [
  'irisSize',
  'pupilSize',
  'irisHorizontalPosition',
  'irisVerticalPosition'
] as const

function fail(
  code: EyeAppearanceV5StateMigrationErrorCode,
  message: string
): never {
  throw new EyeAppearanceV5StateMigrationError(code, message)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INCOMPATIBLE_SOURCE', `${context} must be an object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('INCOMPATIBLE_SOURCE', `${context} must be a plain object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
  code: EyeAppearanceV5StateMigrationErrorCode
) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${context} must contain exactly: ${wanted.join(', ')}.`)
  }
}

function hash(value: unknown, context: string, code: EyeAppearanceV5StateMigrationErrorCode) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(code, `${context} must be a lowercase SHA-256.`)
  }
  return value
}

function finite(value: unknown, context: string, code: EyeAppearanceV5StateMigrationErrorCode) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(code, `${context} must be finite.`)
  }
  return Object.is(value, -0) ? 0 : value
}

function bounds(
  value: EyeAppearanceStateBounds,
  context: string
): EyeAppearanceStateBounds {
  const raw = record(value, context)
  exactKeys(raw, BOUND_KEYS, context, 'INVALID_BINDING')
  const parsed = {} as Record<(typeof BOUND_KEYS)[number], readonly [number, number]>
  for (const key of BOUND_KEYS) {
    const candidate = raw[key]
    if (!Array.isArray(candidate) || candidate.length !== 2) {
      fail('INVALID_BINDING', `${context}.${key} must contain exactly two bounds.`)
    }
    const minimum = finite(candidate[0], `${context}.${key}[0]`, 'INVALID_BINDING')
    const maximum = finite(candidate[1], `${context}.${key}[1]`, 'INVALID_BINDING')
    if (minimum > maximum) {
      fail('INVALID_BINDING', `${context}.${key} minimum cannot exceed its maximum.`)
    }
    parsed[key] = [minimum, maximum]
  }
  return parsed as EyeAppearanceStateBounds
}

function bounded(
  value: unknown,
  range: readonly [number, number],
  context: string,
  code: EyeAppearanceV5StateMigrationErrorCode
) {
  const parsed = finite(value, context, code)
  if (parsed < range[0] || parsed > range[1]) {
    fail(code, `${context} must be inside [${range[0]}, ${range[1]}].`)
  }
  return parsed
}

function validateBindings(input: EyeAppearanceV5StateMigrationInput) {
  const source = record(input.source, 'source definition')
  exactKeys(
    source,
    ['schemaVersion', 'stateSchemaVersion', 'definitionSha256', 'bounds'],
    'source definition',
    'INVALID_BINDING'
  )
  const target = record(input.target, 'target definition')
  exactKeys(
    target,
    ['schemaVersion', 'stateSchemaVersion', 'definitionSha256', 'bounds'],
    'target definition',
    'INVALID_BINDING'
  )
  if (
    source.schemaVersion !== LEGACY_EYE_APPEARANCE_DEFINITION_V4 ||
    source.stateSchemaVersion !== LEGACY_EYE_APPEARANCE_STATE_V4
  ) {
    fail('INVALID_BINDING', 'source definition must bind eye-appearance/v4 state v4.')
  }
  if (
    target.schemaVersion !== TARGET_EYE_APPEARANCE_DEFINITION_V5 ||
    target.stateSchemaVersion !== TARGET_EYE_APPEARANCE_STATE_V5
  ) {
    fail('INVALID_BINDING', 'target definition must bind eye-appearance/v5 state v5.')
  }
  const sourceHash = hash(source.definitionSha256, 'source.definitionSha256', 'INVALID_BINDING')
  const targetHash = hash(target.definitionSha256, 'target.definitionSha256', 'INVALID_BINDING')
  if (sourceHash === targetHash) {
    fail('INVALID_BINDING', 'source and target definitions must have distinct immutable hashes.')
  }
  return {
    sourceHash,
    targetHash,
    sourceBounds: bounds(input.source.bounds, 'source.bounds'),
    targetBounds: bounds(input.target.bounds, 'target.bounds')
  }
}

export function migrateEyeAppearanceStateV4ToV5(
  input: EyeAppearanceV5StateMigrationInput
): EyeAppearanceStateV5MigrationTarget {
  const binding = validateBindings(input)
  const state = record(input.state, 'state')
  exactKeys(state, STATE_KEYS, 'state', 'INCOMPATIBLE_SOURCE')
  if (state.schemaVersion !== LEGACY_EYE_APPEARANCE_STATE_V4) {
    fail('INCOMPATIBLE_SOURCE', `state.schemaVersion must equal ${LEGACY_EYE_APPEARANCE_STATE_V4}.`)
  }
  if (state.definitionSha256 !== binding.sourceHash) {
    fail('INCOMPATIBLE_SOURCE', 'state.definitionSha256 does not match the exact source definition.')
  }

  const source = {
    irisSize: bounded(
      state.irisSize,
      binding.sourceBounds.irisSize,
      'state.irisSize',
      'INCOMPATIBLE_SOURCE'
    ),
    pupilSize: bounded(
      state.pupilSize,
      binding.sourceBounds.pupilSize,
      'state.pupilSize',
      'INCOMPATIBLE_SOURCE'
    ),
    irisHorizontalPosition: bounded(
      state.irisHorizontalPosition,
      binding.sourceBounds.irisHorizontalPosition,
      'state.irisHorizontalPosition',
      'INCOMPATIBLE_SOURCE'
    ),
    irisVerticalPosition: bounded(
      state.irisVerticalPosition,
      binding.sourceBounds.irisVerticalPosition,
      'state.irisVerticalPosition',
      'INCOMPATIBLE_SOURCE'
    )
  }
  const migrated = {
    irisSize: source.irisSize / EYE_APPEARANCE_V5_MIGRATION.irisSizeDivisor,
    pupilSize: source.pupilSize / EYE_APPEARANCE_V5_MIGRATION.pupilSizeDivisor,
    irisHorizontalPosition:
      source.irisHorizontalPosition + EYE_APPEARANCE_V5_MIGRATION.irisHorizontalOffset,
    irisVerticalPosition:
      source.irisVerticalPosition + EYE_APPEARANCE_V5_MIGRATION.irisVerticalOffset
  }
  for (const key of BOUND_KEYS) {
    migrated[key] = bounded(
      migrated[key],
      binding.targetBounds[key],
      `migrated.${key}`,
      'OUT_OF_BOUNDS'
    )
  }
  return {
    schemaVersion: TARGET_EYE_APPEARANCE_STATE_V5,
    definitionSha256: binding.targetHash,
    ...migrated
  }
}
