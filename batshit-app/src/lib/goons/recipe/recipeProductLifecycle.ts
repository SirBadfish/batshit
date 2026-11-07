import type { GoonRecord } from '$lib/types/goons'
import { requiresFirstPartyRecipePreparation, isRecognizedFirstPartyRecipeSourcePair } from './recipeAuthorUpdatePolicy'
import { recipeOwnerV2 } from './recipeRuntimeProjection'

export type RecipeProductReadiness = 'not-required' | 'preparing' | 'ready' | 'failed'

export function isRecipePreparationRequired(
  goon: Pick<GoonRecord, 'sourceProfile' | 'customAvatar' | 'recipe'> | null | undefined
) {
  const source = recipeOwnerV2(goon)?.authoringRevision?.source?.identities
  if (isRecognizedFirstPartyRecipeSourcePair(source)) return true
  return Boolean(
    goon?.sourceProfile === 'expert-custom-glb' &&
      requiresFirstPartyRecipePreparation(goon.customAvatar?.manifestSummary)
  )
}

export function isGoonRuntimeReady(
  goon: Pick<GoonRecord, 'sourceProfile' | 'customAvatar' | 'recipe'> | null | undefined
) {
  if (!isRecipePreparationRequired(goon)) return true
  return Boolean(recipeOwnerV2(goon)?.activeRevision)
}

export function resolveRecipeProductReadiness(
  goon: Pick<GoonRecord, 'sourceProfile' | 'customAvatar' | 'recipe'> | null | undefined
): RecipeProductReadiness {
  if (!isRecipePreparationRequired(goon)) return 'not-required'
  const owner = recipeOwnerV2(goon)
  if (owner?.activeRevision) return 'ready'
  if (owner?.liveStatus === 'failed' || owner?.liveStatus === 'interrupted') return 'failed'
  return 'preparing'
}
