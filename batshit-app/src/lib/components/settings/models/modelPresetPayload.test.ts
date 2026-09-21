import { describe, expect, it } from 'vitest'
import {
  buildCatalogPresetPricing,
  buildPresetPricingFromForm,
  parsePresetContextWindow,
  type PresetPricingFormFields
} from './modelPresetPayload'

function form(overrides: Partial<PresetPricingFormFields> = {}): PresetPricingFormFields {
  return {
    pricingInputMode: 'flat',
    pricingInput: '',
    pricingInputTiers: [],
    pricingOutput: '',
    pricingCachedInput: '',
    ...overrides
  }
}

describe('modelPresetPayload (BL-67: blank sends nothing, zero is real)', () => {
  it('stores no price at all when every price field is blank', () => {
    expect(buildPresetPricingFromForm(form())).toEqual({})
  })

  it('keeps a typed price of 0 as a real zero', () => {
    expect(
      buildPresetPricingFromForm(
        form({ pricingInput: '$0.000', pricingOutput: '0', pricingCachedInput: '0' })
      )
    ).toEqual({ input: 0, output: 0, cachedInput: 0 })
  })

  it('keeps only the prices that were filled in', () => {
    expect(buildPresetPricingFromForm(form({ pricingOutput: '$15.000' }))).toEqual({ output: 15 })
  })

  it('leaves the input price out when tiered mode has no usable tier', () => {
    expect(
      buildPresetPricingFromForm(
        form({
          pricingInputMode: 'tiered',
          pricingInputTiers: [{ from: '', to: '', cost: '' }],
          pricingOutput: '10'
        })
      )
    ).toEqual({ output: 10 })
  })

  it('sorts usable tiers', () => {
    expect(
      buildPresetPricingFromForm(
        form({
          pricingInputMode: 'tiered',
          pricingInputTiers: [
            { from: '200,000', to: '1,000,000', cost: '6' },
            { from: '0', to: '200,000', cost: '3' }
          ]
        })
      ).input
    ).toEqual([
      { from: 0, to: 200000, costPerMillion: 3 },
      { from: 200000, to: 1000000, costPerMillion: 6 }
    ])
  })

  it('treats a blank or zero context window as unknown', () => {
    expect(parsePresetContextWindow('')).toBeUndefined()
    expect(parsePresetContextWindow('0')).toBeUndefined()
    expect(parsePresetContextWindow(undefined)).toBeUndefined()
    expect(parsePresetContextWindow('200,000')).toBe(200000)
  })

  it('gives a catalog row with no price no pricing, and keeps a catalog 0', () => {
    expect(buildCatalogPresetPricing({})).toBeUndefined()
    expect(buildCatalogPresetPricing({ output: 4 })).toEqual({ output: 4 })
    expect(buildCatalogPresetPricing({ input: 0, output: 0 })).toEqual({ input: 0, output: 0 })
  })
})
