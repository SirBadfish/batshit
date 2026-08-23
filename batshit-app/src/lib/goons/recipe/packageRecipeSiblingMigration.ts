import type { GoonCustomAvatarManifest } from '../customAvatar'
import {
  parseLipArtworkDefinition,
  parseLipArtworkPresenceState,
  parseLipArtworkState
} from '../lipArtwork'
import {
  parseNailSurfaceDefinition,
  parseNailSurfacePresenceState,
  parseNailSurfaceState
} from '../nailSurface'
import { parseSkinAppearanceDefinition, parseSkinAppearanceState } from '../skinAppearance'
import type { AppearanceRecipeMigrationExternalSiblingInput } from './appearanceRecipeMigrationPlanner'
import type { RecipeSourceIdentity } from './packageMetadata'
import { canonicalRecipeSha256 } from './recipeCanonical'
import type { RecipeSiblingStateRecord, RecipeStateSnapshot } from './recipeContracts'

type PackageRecipeSiblingSpec = {
  id: string
  label: string
  aliases: readonly string[]
  contract: string
  manifestKey: 'lipArtwork' | 'nailSurface' | 'skinAppearance'
  validate: (definition: unknown, state: unknown) => string
}

const PACKAGE_RECIPE_SIBLING_SPECS: readonly PackageRecipeSiblingSpec[] = [
  {
    id: 'lipArtwork',
    label: 'Lip Artwork',
    aliases: ['lipArtwork', 'lip-artwork'],
    contract: 'lip-artwork-state/v2',
    manifestKey: 'lipArtwork',
    validate: (rawDefinition: unknown, state: unknown) => {
      const definition = parseLipArtworkDefinition(rawDefinition)
      parseLipArtworkState(definition, state)
      return definition.definitionSha256
    }
  },
  {
    id: 'lipArtworkPresence',
    label: 'Lip Artwork presence',
    aliases: ['lipArtworkPresence', 'lip-artwork-presence'],
    contract: 'lip-artwork-presence-state/v1',
    manifestKey: 'lipArtwork',
    validate: (rawDefinition: unknown, state: unknown) => {
      const definition = parseLipArtworkDefinition(rawDefinition)
      parseLipArtworkPresenceState(definition, state)
      return definition.definitionSha256
    }
  },
  {
    id: 'nailSurface',
    label: 'Nail Surface',
    aliases: ['nailSurface', 'nail-surface'],
    contract: 'nail-surface-state/v1',
    manifestKey: 'nailSurface',
    validate: (rawDefinition: unknown, state: unknown) => {
      const definition = parseNailSurfaceDefinition(rawDefinition)
      parseNailSurfaceState(definition, state)
      return definition.definitionSha256
    }
  },
  {
    id: 'nailSurfacePresence',
    label: 'Nail Surface presence',
    aliases: ['nailSurfacePresence', 'nail-surface-presence'],
    contract: 'nail-surface-presence-state/v1',
    manifestKey: 'nailSurface',
    validate: (rawDefinition: unknown, state: unknown) => {
      const definition = parseNailSurfaceDefinition(rawDefinition)
      parseNailSurfacePresenceState(definition, state)
      return definition.definitionSha256
    }
  },
  {
    id: 'skinAppearance',
    label: 'Skin Appearance',
    aliases: ['skinAppearance', 'skin-appearance'],
    contract: 'skin-appearance-state/v2',
    manifestKey: 'skinAppearance',
    validate: (rawDefinition: unknown, state: unknown) => {
      const definition = parseSkinAppearanceDefinition(rawDefinition)
      parseSkinAppearanceState(definition, state)
      return definition.definitionSha256
    }
  }
]

type MatchedPackageRecipeSibling = {
  spec: PackageRecipeSiblingSpec
  sibling: RecipeSiblingStateRecord
}

function manifestDefinition(
  manifest: GoonCustomAvatarManifest | Record<string, unknown>,
  spec: PackageRecipeSiblingSpec,
  context: string
) {
  const definition = (manifest as Record<string, unknown>)[spec.manifestKey]
  if (definition === undefined || definition === null) {
    throw new Error(`${context} has ${spec.label} state but no ${spec.manifestKey} definition.`)
  }
  return definition
}

function validateDefinitionBoundState(
  spec: PackageRecipeSiblingSpec,
  definition: unknown,
  sibling: RecipeSiblingStateRecord,
  context: string
) {
  try {
    return spec.validate(definition, sibling.state)
  } catch (error) {
    throw new Error(
      `${spec.label} cannot be carried into this Goon file update because ${context} is incompatible: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function matchPackageRecipeSiblings(state: RecipeStateSnapshot): MatchedPackageRecipeSibling[] {
  const matches: MatchedPackageRecipeSibling[] = []
  const claimedIds = new Set<string>()

  for (const spec of PACKAGE_RECIPE_SIBLING_SPECS) {
    const candidates = state.siblings.filter(
      (sibling) => spec.aliases.includes(sibling.id) || sibling.contract === spec.contract
    )
    if (candidates.length > 1) {
      throw new Error(`Recipe State ambiguously binds more than one ${spec.label} sibling.`)
    }
    const sibling = candidates[0]
    if (!sibling) continue
    if (claimedIds.has(sibling.id)) {
      throw new Error(`Recipe sibling ${sibling.id} matches more than one package-managed surface.`)
    }
    claimedIds.add(sibling.id)
    matches.push({ spec, sibling })
  }

  return matches.sort((left, right) => left.sibling.id.localeCompare(right.sibling.id))
}

/**
 * Validate and identify package-managed Recipe siblings on the client before
 * analysis. Hair and Clothing remain separately asset-bound external siblings.
 */
export function collectPackageRecipeSiblingRecords(input: {
  state: RecipeStateSnapshot
  targetManifest: GoonCustomAvatarManifest | Record<string, unknown>
}): RecipeSiblingStateRecord[] {
  return matchPackageRecipeSiblings(input.state).map(({ spec, sibling }) => {
    const targetDefinition = manifestDefinition(input.targetManifest, spec, 'Target package')
    const targetDefinitionSha256 = validateDefinitionBoundState(
      spec,
      targetDefinition,
      sibling,
      'the target package definition'
    )
    if (targetDefinitionSha256 !== sibling.definitionSha256) {
      throw new Error(
        `${spec.label} cannot be carried into this Goon file update because its package definition changed.`
      )
    }
    return sibling
  })
}

/**
 * Author exact planner bindings for definition-compatible package-managed
 * siblings. Both archives and the state are independently parsed before the
 * planner is allowed to copy a sibling unchanged.
 */
export async function buildPackageRecipeSiblingMigrationInputs(input: {
  state: RecipeStateSnapshot
  sourceManifest: GoonCustomAvatarManifest | Record<string, unknown>
  targetManifest: GoonCustomAvatarManifest | Record<string, unknown>
  sourceRecipeIdentities: RecipeSourceIdentity
  targetRecipeIdentities: RecipeSourceIdentity
}): Promise<AppearanceRecipeMigrationExternalSiblingInput[]> {
  return Promise.all(
    matchPackageRecipeSiblings(input.state).map(async ({ spec, sibling }) => {
      const sourceDefinition = manifestDefinition(input.sourceManifest, spec, 'Source package')
      const targetDefinition = manifestDefinition(input.targetManifest, spec, 'Target package')
      const sourceDefinitionSha256 = validateDefinitionBoundState(
        spec,
        sourceDefinition,
        sibling,
        'the source package definition'
      )
      const targetDefinitionSha256 = validateDefinitionBoundState(
        spec,
        targetDefinition,
        sibling,
        'the target package definition'
      )
      if (
        sourceDefinitionSha256 !== sibling.definitionSha256 ||
        targetDefinitionSha256 !== sibling.definitionSha256
      ) {
        throw new Error(
          `${spec.label} cannot be carried into this Goon file update because its package definition changed.`
        )
      }
      const validationSha256 = await canonicalRecipeSha256({
        contract: 'recipe-package-sibling-validation/v1',
        sourceStateId: sibling.id,
        sourceStateSha256: sibling.stateSha256,
        targetStateId: sibling.id,
        sourceDefinitionSha256,
        targetDefinitionSha256,
        sourceRecipeIdentities: input.sourceRecipeIdentities,
        targetRecipeIdentities: input.targetRecipeIdentities
      })
      return {
        sourceStateId: sibling.id,
        targetStateId: sibling.id,
        validationSha256,
        message: `The exact ${spec.label} state remains definition-compatible with the target Recipe source.`,
        targetState: structuredClone(sibling)
      }
    })
  ).then((bindings) =>
    bindings.sort((left, right) => left.sourceStateId.localeCompare(right.sourceStateId))
  )
}
