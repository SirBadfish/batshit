import { describe, expect, it } from 'vitest'
import { applyBaselineSecurityHeaders } from '../securityHeaders'

describe('applyBaselineSecurityHeaders (G-0235)', () => {
  it('sets the baseline header set on plain responses', () => {
    const headers = new Headers()
    applyBaselineSecurityHeaders(headers)
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(headers.get('Permissions-Policy')).toContain('microphone=(self)')
    expect(headers.get('Permissions-Policy')).toContain('camera=()')
  })

  it('never overrides per-route values (artifact route owns its frame headers)', () => {
    const headers = new Headers({
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    })
    applyBaselineSecurityHeaders(headers)
    expect(headers.get('X-Frame-Options')).toBe('DENY')
    expect(headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
