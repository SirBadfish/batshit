import { isRecipeVerificationEpochCurrent } from './recipeVerificationEpoch.server'

export const RECIPE_STAGE_ADMISSION_ALGORITHM = 'recipe-stage-admission/v1'

export type RecipeStageAdmission = Readonly<{
  epoch: symbol
  dependenciesSha256: string
}>

/** Ephemeral server evidence, never a persisted ready flag or client receipt.
 * Keys bind the complete ready owner/job snapshots. Values retain no asset bytes.
 * Each lifecycle service instance owns its own cache, including across HMR. */
export function createRecipeStageAdmissionCache(options: {
  now?: () => number
  capacity?: number
  ttlMs?: number
} = {}) {
  const now = options.now ?? (() => performance.now())
  const capacity = options.capacity ?? 16
  const ttlMs = options.ttlMs ?? 5 * 60_000
  if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Invalid Recipe Stage admission bounds.')
  }
  const entries = new Map<string, RecipeStageAdmission & { expiresAt: number }>()
  const prune = () => {
    const current = now()
    for (const [key, value] of entries) {
      if (value.expiresAt <= current || !isRecipeVerificationEpochCurrent(value.epoch)) entries.delete(key)
    }
  }
  return {
    remember(key: string, dependenciesSha256: string, epoch: symbol | null) {
      prune()
      if (!isRecipeVerificationEpochCurrent(epoch)) return
      entries.delete(key)
      while (entries.size >= capacity) entries.delete(entries.keys().next().value!)
      entries.set(key, { epoch, dependenciesSha256, expiresAt: now() + ttlMs })
    },
    take(key: string): RecipeStageAdmission | null {
      prune()
      const value = entries.get(key)
      entries.delete(key)
      return value ? Object.freeze({ epoch: value.epoch, dependenciesSha256: value.dependenciesSha256 }) : null
    }
  }
}
