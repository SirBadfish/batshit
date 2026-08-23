import {
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition,
  parseEyeAppearanceState,
  type EyeAppearanceDefinition
} from '../eyeAppearance'
import {
  LEGACY_EYE_APPEARANCE_DEFINITION_V4,
  LEGACY_EYE_APPEARANCE_STATE_V4,
  migrateEyeAppearanceStateV4ToV5,
  type EyeAppearanceStateBounds,
  type EyeAppearanceV4MigrationBinding,
  type EyeAppearanceV5MigrationBinding
} from './eyeAppearanceV5StateMigration'
import type { AppearanceRecipeSiblingVerifier } from './appearanceRecipeMigrationPlanner'
import { canonicalRecipeSha256, canonicalRecipeString, requireLowercaseSha256 } from './recipeCanonical'
import {
  recipeSiblingStateSha256,
  type RecipeJsonValue,
  type RecipeSiblingStateRecord
} from './recipeContracts'

const CONTROL_IDS = [
  'iris_size',
  'pupil_size',
  'iris_horizontal_position',
  'iris_vertical_position'
] as const

function clone<T>(value: T): T {
  return JSON.parse(canonicalRecipeString(value)) as T
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`)
  }
  return value as Record<string, unknown>
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be finite.`)
  }
  return value
}

function legacyBinding(value: unknown): EyeAppearanceV4MigrationBinding {
  const definition = record(value, 'source Eye Appearance definition')
  if (
    definition.schemaVersion !== LEGACY_EYE_APPEARANCE_DEFINITION_V4 ||
    definition.stateSchemaVersion !== LEGACY_EYE_APPEARANCE_STATE_V4
  ) {
    throw new Error('Eye Appearance migration source must be the exact v4 contract.')
  }
  const definitionSha256 = requireLowercaseSha256(
    definition.definitionSha256,
    'source Eye Appearance definitionSha256'
  )
  if (!Array.isArray(definition.controls) || definition.controls.length !== CONTROL_IDS.length) {
    throw new Error('Source Eye Appearance definition must contain exactly four controls.')
  }
  const controls = new Map<string, Record<string, unknown>>()
  for (const [index, value] of definition.controls.entries()) {
    const control = record(value, `source Eye Appearance controls[${index}]`)
    if (typeof control.id !== 'string' || controls.has(control.id)) {
      throw new Error('Source Eye Appearance controls must have unique ids.')
    }
    controls.set(control.id, control)
  }
  if (CONTROL_IDS.some((id) => !controls.has(id)) || controls.size !== CONTROL_IDS.length) {
    throw new Error('Source Eye Appearance control inventory does not match v4.')
  }
  const range = (id: (typeof CONTROL_IDS)[number]): readonly [number, number] => {
    const control = controls.get(id)!
    const minimum = finite(control.minimum, `source Eye Appearance ${id}.minimum`)
    const maximum = finite(control.maximum, `source Eye Appearance ${id}.maximum`)
    if (minimum > maximum) throw new Error(`Source Eye Appearance ${id} bounds are inverted.`)
    return [minimum, maximum]
  }
  return {
    schemaVersion: LEGACY_EYE_APPEARANCE_DEFINITION_V4,
    stateSchemaVersion: LEGACY_EYE_APPEARANCE_STATE_V4,
    definitionSha256,
    bounds: {
      irisSize: range('iris_size'),
      pupilSize: range('pupil_size'),
      irisHorizontalPosition: range('iris_horizontal_position'),
      irisVerticalPosition: range('iris_vertical_position')
    }
  }
}

function targetBinding(definition: EyeAppearanceDefinition): EyeAppearanceV5MigrationBinding {
  const controls = new Map(definition.controls.map((control) => [control.id, control]))
  const range = (id: (typeof CONTROL_IDS)[number]): readonly [number, number] => {
    const control = controls.get(id)
    if (!control) throw new Error(`Target Eye Appearance definition is missing ${id}.`)
    return [control.minimum, control.maximum]
  }
  return {
    schemaVersion: definition.schemaVersion,
    stateSchemaVersion: definition.stateSchemaVersion,
    definitionSha256: definition.definitionSha256,
    bounds: {
      irisSize: range('iris_size'),
      pupilSize: range('pupil_size'),
      irisHorizontalPosition: range('iris_horizontal_position'),
      irisVerticalPosition: range('iris_vertical_position')
    } satisfies EyeAppearanceStateBounds
  }
}

async function stateRecord(
  id: string,
  definition: EyeAppearanceDefinition,
  state: ReturnType<typeof parseEyeAppearanceState>
): Promise<RecipeSiblingStateRecord> {
  const serialized = clone(state) as unknown as { [key: string]: RecipeJsonValue }
  return {
    id,
    contract: definition.stateSchemaVersion,
    definitionSha256: definition.definitionSha256,
    stateSha256: await recipeSiblingStateSha256(serialized),
    state: serialized
  }
}

/**
 * Verify the one supported Eye Appearance Recipe boundary. The runtime is v5
 * only; this handler exists solely at the explicit v4 package-update edge.
 */
export function createEyeAppearanceRecipeSiblingVerifier(
  sourceDefinitionValue: unknown | null,
  targetDefinitionValue: unknown
): AppearanceRecipeSiblingVerifier {
  const sourceSchema =
    sourceDefinitionValue === null
      ? null
      : record(sourceDefinitionValue, 'source Eye Appearance definition').schemaVersion
  const legacySource =
    sourceSchema === LEGACY_EYE_APPEARANCE_DEFINITION_V4
      ? legacyBinding(sourceDefinitionValue)
      : null
  const currentSource =
    sourceDefinitionValue !== null && sourceSchema === 'eye-appearance/v5'
      ? parseEyeAppearanceDefinition(sourceDefinitionValue)
      : null
  if (sourceDefinitionValue !== null && !legacySource && !currentSource) {
    throw new Error('Eye Appearance migration source contract is unsupported.')
  }
  const targetDefinition = parseEyeAppearanceDefinition(targetDefinitionValue)
  const target = targetBinding(targetDefinition)
  return {
    verifierId: 'eye-appearance-state-v4-to-v5',
    verifierVersion: 1,
    async verify(request) {
      if (request.surface !== 'eyeAppearance') {
        throw new Error('Eye Appearance verifier received another sibling surface.')
      }
      if (
        request.targetDefinition.contract !== targetDefinition.stateSchemaVersion ||
        request.targetDefinition.definitionSha256 !== targetDefinition.definitionSha256
      ) {
        throw new Error('Eye Appearance verifier target does not match the loaded package definition.')
      }

      const state =
        request.operation === 'reset'
          ? createDefaultEyeAppearanceState(targetDefinition)
          : (() => {
              if (!request.sourceState) {
                throw new Error('Eye Appearance migration requires an exact source state.')
              }
              if (request.sourceState.contract === LEGACY_EYE_APPEARANCE_STATE_V4) {
                if (
                  !legacySource ||
                  request.sourceState.definitionSha256 !== legacySource.definitionSha256
                ) {
                  throw new Error('Eye Appearance migration requires the exact v4 source state.')
                }
                return parseEyeAppearanceState(
                  targetDefinition,
                  migrateEyeAppearanceStateV4ToV5({
                    source: legacySource,
                    target,
                    state: request.sourceState.state
                  })
                )
              }
              if (
                request.sourceState.contract !== targetDefinition.stateSchemaVersion ||
                !currentSource ||
                request.sourceState.definitionSha256 !== currentSource.definitionSha256
              ) {
                throw new Error('Eye Appearance migration source contract is unsupported.')
              }
              const sourceState = parseEyeAppearanceState(
                currentSource,
                request.sourceState.state
              )
              return parseEyeAppearanceState(targetDefinition, {
                ...sourceState,
                definitionSha256: targetDefinition.definitionSha256
              })
            })()
      const proposedState = await stateRecord(request.targetStateId, targetDefinition, state)
      const domainEvidenceSha256 = await canonicalRecipeSha256({
        contract: 'eye-appearance-recipe-migration-evidence/v1',
        operation: request.operation,
        sourceDefinitionSha256:
          legacySource?.definitionSha256 ?? currentSource?.definitionSha256 ?? null,
        sourceContract: request.sourceState?.contract ?? null,
        sourceStateSha256: request.sourceState?.stateSha256 ?? null,
        targetDefinitionSha256: targetDefinition.definitionSha256,
        proposedStateSha256: proposedState.stateSha256,
        mapping:
          request.sourceState?.contract === LEGACY_EYE_APPEARANCE_STATE_V4
            ? {
                irisSize: 'divide-by-1.35',
                pupilSize: 'divide-by-1.40',
                irisHorizontalPosition: 'add-0.50',
                irisVerticalPosition: 'add-0.70'
              }
            : 'current-contract-definition-rebind'
      })
      return {
        proposedState,
        domainEvidenceSha256,
        message:
          request.operation === 'migrate'
            ? request.sourceState?.contract === LEGACY_EYE_APPEARANCE_STATE_V4
              ? 'Eye Appearance was migrated exactly from v4 to the calibrated v5 size and neutral-placement basis.'
              : 'Eye Appearance v5 values were rebound to the exact updated definition.'
            : 'Eye Appearance was explicitly reset to the calibrated v5 defaults.'
      }
    }
  }
}
