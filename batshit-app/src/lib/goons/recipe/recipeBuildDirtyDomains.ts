import type { RecipeSiblingStateRecord, RecipeStateSnapshot } from './recipeContracts'
import { canonicalRecipeString } from './recipeCanonical'

export const RECIPE_BUILD_DIRTY_DOMAINS = [
  'initial-preparation',
  'appearance-dials',
  'facial-artwork',
  'eye-appearance',
  'oral-appearance',
  'recipe-state'
] as const

export type RecipeBuildDirtyDomain =
  | (typeof RECIPE_BUILD_DIRTY_DOMAINS)[number]
  | `recipe-sibling:${string}`

export type RecipeBuildDecision = {
  action: 'none' | 'prepare' | 'update'
  requiresBuild: boolean
  hasAppearanceChanges: boolean
  dirtyDomains: RecipeBuildDirtyDomain[]
}

const SIBLING_DOMAIN_ALIASES: Record<string, RecipeBuildDirtyDomain> = {
  facialArtwork: 'facial-artwork',
  'facial-artwork': 'facial-artwork',
  eyeAppearance: 'eye-appearance',
  'eye-appearance': 'eye-appearance',
  oralAppearance: 'oral-appearance',
  'oral-appearance': 'oral-appearance'
}

function siblingDomain(sibling: RecipeSiblingStateRecord): RecipeBuildDirtyDomain {
  const known = SIBLING_DOMAIN_ALIASES[sibling.id]
  if (known) return known
  if (sibling.contract === 'facial-artwork-state/v4') return 'facial-artwork'
  if (sibling.contract === 'eye-appearance-state/v3') return 'eye-appearance'
  if (sibling.contract.startsWith('oral-appearance-state/')) return 'oral-appearance'
  return `recipe-sibling:${sibling.id}`
}

function siblingMap(state: RecipeStateSnapshot) {
  return new Map(state.siblings.map((sibling) => [sibling.id, sibling]))
}

function differs(left: unknown, right: unknown) {
  return canonicalRecipeString(left) !== canonicalRecipeString(right)
}

/**
 * The one authoritative build decision for Goon Editor saves.
 *
 * Only versioned Recipe-owned appearance state enters this classifier. Moods,
 * Emotes, Motions, camera, Eye Contact behavior/tuning, voice, wardrobe, and
 * other runtime settings deliberately have no input here and therefore cannot
 * trigger a Recipe build.
 */
export function classifyRecipeBuildDirtyDomains(input: {
  savedState: RecipeStateSnapshot | null
  draftState: RecipeStateSnapshot | null
}): RecipeBuildDecision {
  const { savedState, draftState } = input
  if (!draftState) {
    return {
      action: 'none',
      requiresBuild: false,
      hasAppearanceChanges: false,
      dirtyDomains: []
    }
  }

  if (!savedState) {
    return {
      action: 'prepare',
      requiresBuild: true,
      hasAppearanceChanges: false,
      dirtyDomains: ['initial-preparation']
    }
  }

  if (savedState.stateSha256 === draftState.stateSha256) {
    return {
      action: 'none',
      requiresBuild: false,
      hasAppearanceChanges: false,
      dirtyDomains: []
    }
  }

  const domains = new Set<RecipeBuildDirtyDomain>()
  if (differs(savedState.appearanceDials, draftState.appearanceDials)) {
    domains.add('appearance-dials')
  }

  const savedSiblings = siblingMap(savedState)
  const draftSiblings = siblingMap(draftState)
  const siblingIds = [...new Set([...savedSiblings.keys(), ...draftSiblings.keys()])].sort()
  for (const id of siblingIds) {
    const savedSibling = savedSiblings.get(id)
    const draftSibling = draftSiblings.get(id)
    if (!differs(savedSibling ?? null, draftSibling ?? null)) continue
    domains.add(siblingDomain(draftSibling ?? savedSibling!))
  }

  // A verified state hash should only move when one of its owned domains moves.
  // Keep future contract fields fail-safe by rebuilding instead of silently
  // treating an unknown Recipe-state change as runtime-only.
  if (domains.size === 0) domains.add('recipe-state')

  return {
    action: 'update',
    requiresBuild: true,
    hasAppearanceChanges: true,
    dirtyDomains: [...domains]
  }
}
