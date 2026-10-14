import type { CatalogConnectionLimits, CatalogConnectionPricing } from '$lib/types/modelCatalog'

type LimitsSource = {
  contextWindow?: number | null
  maxOutputTokens?: number | null
  idVariants?: Record<string, { limits?: CatalogConnectionLimits }> | null
}

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/**
 * BL-68 / BL-132: the context window and max output a preset for `connectionId`
 * should take from a catalog row.
 *
 * A merged row carries ONE window and ONE output limit, taken from its base
 * (usually the gateway). A connection that joined the row through a reviewed
 * identity rule (BL-68), or whose own source listed a different limit (BL-132:
 * DeepInfra, Together, OpenRouter, Anthropic's own list), carries its own
 * `limits` on its variant; those win, and an unknown (`null`) stays unknown
 * instead of borrowing the row's number. Every other connection takes the row's
 * numbers. A window of 0 or less is unknown either way (BL-67).
 */
export function resolveCatalogConnectionLimits(
  model: LimitsSource,
  connectionId: string | null | undefined
): { contextWindow: number | undefined; maxOutputTokens: number | undefined; perConnection: boolean } {
  const own = connectionId ? model.idVariants?.[connectionId]?.limits : undefined
  if (own) {
    return {
      contextWindow: positive(own.contextWindow),
      maxOutputTokens: positive(own.maxOutputTokens),
      perConnection: true
    }
  }
  return {
    contextWindow: positive(model.contextWindow),
    maxOutputTokens: positive(model.maxOutputTokens),
    perConnection: false
  }
}

type PricingSource = {
  pricing?: CatalogConnectionPricing | null
  idVariants?: Record<string, { pricing?: CatalogConnectionPricing }> | null
}

/**
 * BL-132: the price a preset for `connectionId` should take from a catalog row.
 * A merged row carries its base's price (usually the gateway's); a connection
 * whose own source listed a different price (DeepInfra, Together) carries it on
 * its variant, and that wins as a whole: a field it did not list stays unknown
 * rather than borrowing another connection's number.
 */
export function resolveCatalogConnectionPricing(
  model: PricingSource,
  connectionId: string | null | undefined
): { pricing: CatalogConnectionPricing | undefined; perConnection: boolean } {
  const own = connectionId ? model.idVariants?.[connectionId]?.pricing : undefined
  if (own) return { pricing: own, perConnection: true }
  return { pricing: model.pricing ?? undefined, perConnection: false }
}
