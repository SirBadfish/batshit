/**
 * The catalog's one rule for a listed price (BL-130, BL-131, review finding 1):
 * blank is unknown, zero is real, negative is unknown, whether the source sends
 * a string or a number.
 */
import { describe, expect, it } from 'vitest'
import { readListedPrice, readListedPerTokenPrice, isFlatFeePlanConnection } from './catalogPricing'

describe('readListedPrice', () => {
  it('reads a negative price as unknown, as a number and as a string', () => {
    expect(readListedPrice(-1)).toBeUndefined()
    expect(readListedPrice(-0.5)).toBeUndefined()
    expect(readListedPrice('-1')).toBeUndefined()
    expect(readListedPerTokenPrice(-1)).toBeUndefined()
  })

  it('reads blank and junk as unknown, and keeps a real 0 and a real price', () => {
    expect(readListedPrice('')).toBeUndefined()
    expect(readListedPrice('  ')).toBeUndefined()
    expect(readListedPrice(Number.NaN)).toBeUndefined()
    expect(readListedPrice(null)).toBeUndefined()
    expect(readListedPrice(0)).toBe(0)
    expect(readListedPrice('0')).toBe(0)
    expect(readListedPrice(2.5)).toBe(2.5)
  })
})

describe('readListedPerTokenPrice', () => {
  it('keeps six significant digits instead of rounding to a tenth of a cent', () => {
    // $0.0028/1M would round to $0.003 at a tenth-of-a-cent precision.
    expect(readListedPerTokenPrice(0.0028 / 1_000_000)).toBe(0.0028)
    // $0.7326/1M would round to $0.733 at a tenth-of-a-cent precision.
    expect(readListedPerTokenPrice(0.7326 / 1_000_000)).toBe(0.7326)
    expect(readListedPerTokenPrice(3 / 1_000_000)).toBe(3)
  })
})

describe('isFlatFeePlanConnection', () => {
  it('is true for each of the five flat-fee plan connections (BL-658)', () => {
    expect(isFlatFeePlanConnection('direct:kimi_code')).toBe(true)
    expect(isFlatFeePlanConnection('direct:zai_coding')).toBe(true)
    expect(isFlatFeePlanConnection('direct:minimax_token_plan')).toBe(true)
    expect(isFlatFeePlanConnection('direct:mimo_token_plan')).toBe(true)
    expect(isFlatFeePlanConnection('direct:qwen_token_plan')).toBe(true)
  })

  it('is false for a normal per-token connection, and for null/undefined/blank', () => {
    expect(isFlatFeePlanConnection('direct:openai')).toBe(false)
    expect(isFlatFeePlanConnection('vercel-gateway')).toBe(false)
    expect(isFlatFeePlanConnection('openrouter')).toBe(false)
    expect(isFlatFeePlanConnection(null)).toBe(false)
    expect(isFlatFeePlanConnection(undefined)).toBe(false)
    expect(isFlatFeePlanConnection('')).toBe(false)
  })
})
