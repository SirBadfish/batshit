import { describe, expect, it } from 'vitest'
import { escapeRedisGlob, hasRedisGlobCharacters } from './redisGlob'

/**
 * BL-541: a chat id goes into KEYS patterns (`episode:{id}:*`, `unzipped_item:{id}:*`, …), and
 * Redis reads `*`, `?`, `[`, `]`, and `\` in a pattern as glob syntax, so deleting a chat named
 * `a*` swept every chat whose id starts with `a`.
 */
describe('escapeRedisGlob (BL-541)', () => {
  it('escapes every Redis glob character with a backslash', () => {
    expect(escapeRedisGlob('a*')).toBe('a\\*')
    expect(escapeRedisGlob('a?b')).toBe('a\\?b')
    expect(escapeRedisGlob('[ab]')).toBe('\\[ab\\]')
    expect(escapeRedisGlob('a\\b')).toBe('a\\\\b')
    expect(escapeRedisGlob('*?[]\\')).toBe('\\*\\?\\[\\]\\\\')
  })

  it('leaves an ordinary id as it is', () => {
    const id = '09-27-26-10_30-pm-and-123S-pm'
    expect(escapeRedisGlob(id)).toBe(id)
    expect(escapeRedisGlob('0f6c2e0a-5d7b-4f0e-9d53-2d0b4e3b8f11')).toBe('0f6c2e0a-5d7b-4f0e-9d53-2d0b4e3b8f11')
  })
})

describe('hasRedisGlobCharacters (BL-541)', () => {
  it('finds each glob character', () => {
    for (const id of ['a*', 'a?', 'a[', 'a]', 'a\\b']) expect(hasRedisGlobCharacters(id)).toBe(true)
  })

  it('passes an ordinary id', () => {
    expect(hasRedisGlobCharacters('09-27-26-10_30-pm-and-123S-pm')).toBe(false)
    expect(hasRedisGlobCharacters('my chat (2)!')).toBe(false)
  })
})
