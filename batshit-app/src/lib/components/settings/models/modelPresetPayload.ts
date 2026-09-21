// BL-67: how the Models panel turns its form (and a Model Catalog row) into the
// `pricing` and `contextWindow` a preset stores. Batshit's rule: blank sends nothing,
// zero is real. A price or window nobody knows stays ABSENT, so the Token Panel says
// Unknown instead of an exact $0.00; a typed or catalog 0 is kept as a real 0.
import type { PricingTier, SavedModel } from '$lib/types/savedModels'
import { parseFormattedInteger, parseFormattedNumber } from './modelSettingsFormatters'

export interface PresetPricingFormFields {
  pricingInputMode: 'flat' | 'tiered'
  pricingInput: string
  pricingInputTiers: Array<{ from: string; to: string; cost: string }>
  pricingOutput: string
  pricingCachedInput: string
}

function buildTieredInput(tiers: PresetPricingFormFields['pricingInputTiers']): PricingTier[] | undefined {
  const parsed = tiers
    .map((tier): PricingTier | null => {
      const from = parseFormattedNumber(tier.from)
      const to = parseFormattedNumber(tier.to)
      const cost = parseFormattedNumber(tier.cost)
      if (from === undefined || to === undefined || cost === undefined) return null
      if (from < 0 || to <= 0 || cost < 0) return null
      return { from, to, costPerMillion: cost }
    })
    .filter((tier): tier is PricingTier => tier !== null)
  return parsed.length > 0 ? parsed.sort((a, b) => a.from - b.from) : undefined
}

/** The preset's stored prices from the form: blank fields are left out, never 0. */
export function buildPresetPricingFromForm(form: PresetPricingFormFields): SavedModel['pricing'] {
  const pricing: SavedModel['pricing'] = {}
  const input =
    form.pricingInputMode === 'tiered'
      ? buildTieredInput(form.pricingInputTiers)
      : parseFormattedNumber(form.pricingInput)
  const output = parseFormattedNumber(form.pricingOutput)
  const cachedInput = parseFormattedNumber(form.pricingCachedInput)
  if (input !== undefined) pricing.input = input
  if (output !== undefined) pricing.output = output
  if (cachedInput !== undefined) pricing.cachedInput = cachedInput
  return pricing
}

/** A context window is a positive token count; blank, 0, or junk means unknown. */
export function parsePresetContextWindow(value: unknown): number | undefined {
  const parsed = parseFormattedInteger(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

/** A catalog row's prices as a preset shape, or undefined when the row lists none. */
export function buildCatalogPresetPricing(values: {
  input?: number
  output?: number
  cachedInput?: number
}): SavedModel['pricing'] | undefined {
  const pricing: SavedModel['pricing'] = {}
  if (values.input !== undefined) pricing.input = values.input
  if (values.output !== undefined) pricing.output = values.output
  if (values.cachedInput !== undefined) pricing.cachedInput = values.cachedInput
  return Object.keys(pricing).length > 0 ? pricing : undefined
}
