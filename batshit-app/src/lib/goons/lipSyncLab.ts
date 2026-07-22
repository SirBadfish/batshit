import type { GoonLipSyncPremiumAnalyzerId } from '$lib/types/voice'

export const DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER: GoonLipSyncPremiumAnalyzerId = 'rhubarb-wasm'

export const PREMIUM_GOON_LIP_SYNC_ANALYZER_OPTIONS: Array<{
  value: GoonLipSyncPremiumAnalyzerId
  label: string
  shortLabel: string
}> = [
  {
    value: 'rhubarb-wasm',
    label: 'Rhubarb WASM',
    shortLabel: 'WASM'
  },
  {
    value: 'audio2face-3d',
    label: 'NVIDIA Audio2Face',
    shortLabel: 'A2F'
  }
]

export function normalizePremiumGoonLipSyncAnalyzerId(
  value: unknown
): GoonLipSyncPremiumAnalyzerId {
  return PREMIUM_GOON_LIP_SYNC_ANALYZER_OPTIONS.some((option) => option.value === value)
    ? (value as GoonLipSyncPremiumAnalyzerId)
    : DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER
}
