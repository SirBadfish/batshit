import { describe, expect, it } from 'vitest'
import {
  KOBOLDCPP_DEFAULT_SAMPLER_ORDER,
  KOBOLDCPP_SAMPLER_SLOTS,
  fromInputValue,
  parseSamplerOrder,
  toInputValue
} from '../parameterValueAdapter'

const definition = { name: 'samplerOrder', label: 'Sampler order', inputType: 'sampler-order' } as any

/**
 * SA-124 P1. A sampler order is only valid as a full permutation of the seven
 * slots. A partial or duplicated list would silently drop a sampler, so it is
 * refused rather than sent — measured: reordering changes output only when
 * several samplers are active, so a dropped one would be invisible.
 */
describe('KoboldCpp sampler order', () => {
  it('accepts a full permutation of all seven slots', () => {
    expect(parseSamplerOrder([6, 0, 1, 3, 4, 2, 5])).toEqual([6, 0, 1, 3, 4, 2, 5])
    expect(parseSamplerOrder('5,4,3,2,1,0,6')).toEqual([5, 4, 3, 2, 1, 0, 6])
  })

  it('refuses anything that would drop or duplicate a sampler', () => {
    expect(parseSamplerOrder([6, 0, 1])).toBeUndefined()
    expect(parseSamplerOrder([6, 6, 1, 3, 4, 2, 5])).toBeUndefined()
    expect(parseSamplerOrder([6, 0, 1, 3, 4, 2, 9])).toBeUndefined()
    expect(parseSamplerOrder([6, 0, 1, 3, 4, 2, 5.5])).toBeUndefined()
    expect(parseSamplerOrder('not a list')).toBeUndefined()
  })

  it('round-trips through the editor as seven real integers', () => {
    const shown = toInputValue(definition, [6, 0, 1, 3, 4, 2, 5])
    expect(shown).toBe('6,0,1,3,4,2,5')
    const sent = fromInputValue(definition, shown)
    // Integers, not strings — KoboldCpp passes this list straight to C.
    expect(sent).toEqual([6, 0, 1, 3, 4, 2, 5])
    expect((sent as number[]).every((n) => typeof n === 'number')).toBe(true)
  })

  it('treats a blank editor as "do not send"', () => {
    expect(fromInputValue(definition, '')).toBeUndefined()
  })

  it('names all seven slots, and the default is a permutation of them', () => {
    expect(KOBOLDCPP_SAMPLER_SLOTS).toHaveLength(7)
    expect(parseSamplerOrder(KOBOLDCPP_DEFAULT_SAMPLER_ORDER)).toEqual(KOBOLDCPP_DEFAULT_SAMPLER_ORDER)
  })
})

/**
 * SA-124 P1, caught by the live wire capture on 2026-09-21: a DRY breaker typed
 * as `\n` reached KoboldCpp as a literal backslash-n. The editor splits on
 * newlines, so a real newline can never be an ENTRY — yet SillyTavern's default
 * breaker list starts with one. A backslash-n never appears in prose, so the
 * breaker would silently never match.
 */
describe('DRY sequence breakers accept typed escapes', () => {
  const breakers = {
    name: 'drySequenceBreakers',
    label: 'DRY sequence breakers',
    inputType: 'string-array',
    arrayDelimiter: 'newline',
    unescapeEntries: true
  } as any

  it('turns a typed \\n into a real newline on the wire', () => {
    const sent = fromInputValue(breakers, '\\n\n:\n"') as string[]
    expect(sent).toEqual(['\n', ':', '"'])
    expect(sent[0]).toHaveLength(1)
    expect(sent[0].charCodeAt(0)).toBe(10)
  })

  it('shows it back as \\n so an edited preset reads the way it was typed', () => {
    const shown = toInputValue(breakers, ['\n', ':', '"'])
    expect(shown).toBe('\\n\n:\n"')
    // and it survives a second round trip unchanged
    expect(fromInputValue(breakers, shown)).toEqual(['\n', ':', '"'])
  })

  it('keeps a real backslash when that is what was meant', () => {
    expect(fromInputValue(breakers, '\\\\')).toEqual(['\\'])
  })

  it('leaves plain string arrays alone', () => {
    // Only fields that opt in are unescaped: a phrase ban containing a literal
    // backslash-n must stay exactly as typed.
    const bans = { name: 'bannedTokens', label: 'Phrase bans', inputType: 'string-array', arrayDelimiter: 'newline' } as any
    expect(fromInputValue(bans, 'a\\nb')).toEqual(['a\\nb'])
  })
})
