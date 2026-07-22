import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER,
  PREMIUM_GOON_LIP_SYNC_ANALYZER_OPTIONS,
  normalizePremiumGoonLipSyncAnalyzerId
} from './lipSyncLab'

describe('premium Goon lip-sync analyzer catalog', () => {
  it('exposes Rhubarb and NVIDIA Audio2Face without changing the safe default', () => {
    expect(DEFAULT_PREMIUM_GOON_LIP_SYNC_ANALYZER).toBe('rhubarb-wasm')
    expect(PREMIUM_GOON_LIP_SYNC_ANALYZER_OPTIONS).toEqual([
      { value: 'rhubarb-wasm', label: 'Rhubarb WASM', shortLabel: 'WASM' },
      { value: 'audio2face-3d', label: 'NVIDIA Audio2Face', shortLabel: 'A2F' }
    ])
  })

  it('preserves Audio2Face and normalizes retired values to Rhubarb', () => {
    expect(normalizePremiumGoonLipSyncAnalyzerId('audio2face-3d')).toBe('audio2face-3d')
    expect(normalizePremiumGoonLipSyncAnalyzerId('wawa-lipsync')).toBe('rhubarb-wasm')
  })
})
