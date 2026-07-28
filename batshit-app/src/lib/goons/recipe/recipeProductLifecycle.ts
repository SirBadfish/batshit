import type { GoonRecord } from '$lib/types/goons'
import { isSupportedFirstPartyRecipeBase } from './recipeAuthorUpdatePolicy'
import { recipeOwnerV2 } from './recipeRuntimeProjection'

export type RecipeProductReadiness = 'not-required' | 'preparing' | 'ready' | 'failed'

export function isRecipePreparationRequired(
  goon: Pick<GoonRecord, 'sourceProfile' | 'customAvatar'> | null | undefined
) {
  return Boolean(
    goon?.sourceProfile === 'expert-custom-glb' &&
      goon.customAvatar?.manifestSummary?.recipeReady === true &&
      isSupportedFirstPartyRecipeBase(goon.customAvatar.manifestSummary.baseId)
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
