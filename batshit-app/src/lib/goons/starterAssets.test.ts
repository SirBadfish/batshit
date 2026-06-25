import { describe, expect, it } from 'vitest'
import { STARTER_GOON_ASSETS, resolveStarterGoonAsset } from './starterAssets'

describe('starter goon assets', () => {
  it('points starter imports at a hosted asset instead of bundled static VRMs', () => {
    expect(STARTER_GOON_ASSETS).toHaveLength(1)
    expect(STARTER_GOON_ASSETS[0].downloadUrl).toBe(
      'https://batshit.ai/downloads/goons/starter-vroid.vrm'
    )
    expect(STARTER_GOON_ASSETS[0].downloadUrl).not.toContain('/goons/starter-female.vrm')
    expect(STARTER_GOON_ASSETS[0].downloadUrl).not.toContain('/goons/starter-male.vrm')
  })

  it('resolves only allowlisted starter asset IDs', () => {
    expect(resolveStarterGoonAsset('starter_vroid')?.filename).toBe('starter-vroid.vrm')
    expect(resolveStarterGoonAsset('starter-male')).toBeNull()
    expect(resolveStarterGoonAsset(null)).toBeNull()
  })
})
