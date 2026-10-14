/**
 * BL-130 / BL-131: how the model catalog reads a price a source lists.
 *
 * Blank is unknown, zero is real (BL-67). A price nobody listed stays absent so
 * the Token Panel says Unknown; a listed 0 is a free model and stays 0. A
 * negative price is unknown too: OpenRouter lists -1 for its routers
 * (`openrouter/auto`), whose price depends on the model they route to.
 */

export type ListedPricing = {
  input?: number
  output?: number
  cachedInput?: number
}

/** One listed price as a number, or undefined when it is blank, junk, or negative. */
export function readListedPrice(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * A per-token price (gateway, OpenRouter, Baseten) as dollars per million
 * tokens. Six significant digits clear float noise the same way as
 * `readListedCentsPerTokenPrice` below, without rounding a real price too
 * small for a fixed decimal place (the gateway's 0.0000000001 per token on
 * its transcription models) down to a false $0.
 */
export function readListedPerTokenPrice(value: unknown): number | undefined {
  const perToken = readListedPrice(value)
  if (perToken === undefined) return undefined
  return Number((perToken * 1_000_000).toPrecision(6))
}

/**
 * BL-295: DeepInfra lists US cents per token (`cents_per_input_token`), so
 * dollars per million are cents × 10,000, read by the same rules: blank or
 * negative is unknown. Six significant digits clear the float noise (0.0003
 * cents a token is $3, not 2.9999999999999996) and the noise of DeepInfra's
 * eight-decimal cached-input rate (`multiplier`: $0.0027, not 0.0026999994)
 * without moving a real sub-cent price (review: a tenth-of-a-cent rounding
 * turned $0.0075 into $0.008).
 */
export function readListedCentsPerTokenPrice(value: unknown, multiplier = 1): number | undefined {
  const cents = readListedPrice(value)
  if (cents === undefined) return undefined
  return Number((cents * multiplier * 10_000).toPrecision(6))
}

/**
 * The gateway and OpenRouter mark a model whose price depends on which provider
 * serves it (`varies_by_provider`); a 0 listed next to that mark is not a free
 * model, so it is unknown.
 */
export function listedPriceVaries(pricing: Record<string, unknown> | null | undefined): boolean {
  return pricing?.varies_by_provider === true || pricing?.varies_by_provider === 'true'
}

/** True when a listed value holds any positive price (a number, a numeric string, or a list or table of them). */
export function holdsPositivePrice(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsPositivePrice)
  if (value && typeof value === 'object') return Object.values(value).some(holdsPositivePrice)
  const price = readListedPrice(value)
  return price !== undefined && price > 0
}

/**
 * Why a listed 0 token price may not be a free model (review finding 1,
 * 2026-09-25; the BL-84 false $0.00):
 * - `varies`: the source says the price depends on the serving provider;
 * - `pricedOtherwise`: the source prices the model another way (per second,
 *   image, request, song) or it makes non-text output, so its token price says
 *   nothing about what a run costs (OpenRouter's Lyria sells songs at $0.08 and
 *   lists 0/0; the gateway prices grok-stt per second and lists input 0);
 * - `markedFree`: for a source that marks its free models (OpenRouter's
 *   `:free`, the gateway's `-free`), whether this one is marked. A 0/0 without
 *   the mark is unknown. Leave it undefined for a source that marks nothing.
 */
export type ZeroPriceContext = {
  varies?: boolean
  pricedOtherwise?: boolean
  markedFree?: boolean
  /**
   * BL-295: the source prices this model by the second and lists a placeholder
   * token price beside it (the gateway's whisper-1: $0.0001 a second of audio
   * and 0.0000000001 a token), so no token price it lists is what a run costs.
   */
  tokenPricePlaceholder?: boolean
}

/**
 * The gateway's non-text model types and non-token price keys (per second, per
 * image, per character, per session), and its `-free` mark for free models.
 * One rule for the catalog sync and the instance-side gateway fallback.
 */
const GATEWAY_NON_TEXT_TYPES = new Set(['image', 'video', 'speech', 'transcription', 'realtime'])
const GATEWAY_NON_TOKEN_PRICE_KEYS = [
  'transcription_duration_cost_per_second',
  'realtime_session_duration_cost_per_second',
  'realtime_client_message_cost',
  'video_duration_pricing',
  'video_token_pricing',
  'image',
  'image_dimension_quality_pricing',
  'speech_input_character_cost'
]

export function gatewayZeroPriceContext(raw: {
  id: string
  type?: string | null
  pricing?: Record<string, unknown> | null
}): ZeroPriceContext {
  return {
    pricedOtherwise:
      GATEWAY_NON_TEXT_TYPES.has(String(raw.type ?? '').toLowerCase()) ||
      GATEWAY_NON_TOKEN_PRICE_KEYS.some((key) => holdsPositivePrice(raw.pricing?.[key])),
    markedFree: /-free$/i.test(raw.id),
    // On 2026-09-25 every gateway row with a per-second transcription price
    // listed only a placeholder token price (1 or 2 × 10^-10) or 0 beside it.
    tokenPricePlaceholder: holdsPositivePrice(raw.pricing?.transcription_duration_cost_per_second)
  }
}

/**
 * Drop the prices that are not a real per-token price (see `ZeroPriceContext`):
 * every token price beside a placeholder, and the zeros that are not a free
 * price; a marked free model keeps its zeros.
 */
export function withoutFalseZeros(pricing: ListedPricing, context: ZeroPriceContext): ListedPricing {
  if (context.tokenPricePlaceholder) return {}
  if (context.markedFree === true && !context.varies) return pricing
  const unmarkedFreePair = context.markedFree === false && pricing.input === 0 && pricing.output === 0
  if (!context.varies && !context.pricedOtherwise && !unmarkedFreePair) return pricing
  const known: ListedPricing = {}
  for (const field of ['input', 'output', 'cachedInput'] as const) {
    const value = pricing[field]
    if (value !== undefined && value !== 0) known[field] = value
  }
  return known
}

/**
 * Artificial Analysis lists 0 for every price of a model it has no price data
 * for (249 of 673 models on 2026-09-25, always all three at once), so only a
 * positive number is a price there.
 */
export function readArtificialAnalysisPrice(value: unknown): number | undefined {
  const price = readListedPrice(value)
  return price !== undefined && price > 0 ? price : undefined
}

/** The prices that are known, or undefined when none is. */
export function buildListedPricing(values: ListedPricing): ListedPricing | undefined {
  const pricing: ListedPricing = {}
  if (values.input !== undefined) pricing.input = values.input
  if (values.output !== undefined) pricing.output = values.output
  if (values.cachedInput !== undefined) pricing.cachedInput = values.cachedInput
  return Object.keys(pricing).length ? pricing : undefined
}

/**
 * BL-658 / BL-296: the direct connections that bill a flat, ongoing fee (a
 * model maker's own coding/token plan) instead of a per-token price. The
 * catalog keeps these plans' gateway list price as comparison data
 * (`MAKERS_OWN_CONNECTIONS`, `modelCatalogSync.ts`), so the price fields
 * themselves are unchanged; this is only what a user reads, and every price
 * display asks this one question instead of repeating the list.
 */
const FLAT_FEE_PLAN_CONNECTIONS: ReadonlySet<string> = new Set([
  'direct:kimi_code',
  'direct:zai_coding',
  'direct:minimax_token_plan',
  'direct:mimo_token_plan',
  'direct:qwen_token_plan'
])

/** True when `connectionId` is a flat-fee plan connection, so a display should read "Token plan" instead of a price. */
export function isFlatFeePlanConnection(connectionId?: string | null): boolean {
  return typeof connectionId === 'string' && FLAT_FEE_PLAN_CONNECTIONS.has(connectionId)
}

