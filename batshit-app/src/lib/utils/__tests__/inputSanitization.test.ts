import { describe, expect, it } from 'vitest'

import { containsSuspiciousInput, normalizeHttpBaseUrl } from '../inputSanitization'

describe('inputSanitization', () => {
  it('pins the shared suspicious-input pattern set', () => {
    expect(containsSuspiciousInput('${process.env.SECRET}')).toBe(true)
    expect(containsSuspiciousInput('{{7*7}}')).toBe(true)
    expect(containsSuspiciousInput('../../../etc/passwd')).toBe(true)
    expect(containsSuspiciousInput('javascript:alert(1)')).toBe(true)
    expect(containsSuspiciousInput('plain_api_key_value')).toBe(false)
  })

  it('keeps API-key SQL keyword detection opt-in', () => {
    expect(containsSuspiciousInput('DROP TABLE users')).toBe(false)
    expect(containsSuspiciousInput('DROP TABLE users', { sqlKeywords: true })).toBe(true)
  })

  it('normalizes HTTP base URLs without changing existing error semantics', () => {
    expect(normalizeHttpBaseUrl(' https://example.com/// ')).toBe('https://example.com')
    expect(normalizeHttpBaseUrl('', { fallback: 'http://fallback.local' })).toBe(
      'http://fallback.local'
    )
    expect(() => normalizeHttpBaseUrl('ftp://example.com')).toThrow(
      'Base URL must start with http or https'
    )
    expect(() => normalizeHttpBaseUrl('<script>alert(1)</script>')).toThrow(
      'Base URL must start with http or https'
    )
    expect(() => normalizeHttpBaseUrl('https://example.com/{{7*7}}')).toThrow(
      'Base URL contains invalid characters'
    )
  })
})
