import type { CompatibilityMatrixSnapshot } from '$lib/types/compatibilityMatrix'

export const COMPATIBILITY_MATRIX_SEED: CompatibilityMatrixSnapshot = {
  version: 1,
  fetchedAt: new Date().toISOString(),
  entries: []
}
