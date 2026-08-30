import { describe, expect, it } from 'vitest'

import { redactHeaders } from '$lib/server/services/executionViewerRedaction'

describe('executionViewerRedaction', () => {
  it('redacts credential headers from captured provider responses', () => {
    const redacted = redactHeaders({
      'content-type': 'application/json',
      authorization: 'Bearer sk-live-secret',
      cookie: 'session=abc',
      'x-api-key': 'provider-key',
      'x-batshit-service-token': 'service-secret',
      'x-request-id': 'req-123',
    }) as Record<string, unknown>

    expect(redacted).toEqual({
      'content-type': 'application/json',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-batshit-service-token': '[REDACTED]',
      'x-request-id': 'req-123',
    })
  })

  it('redacts conservatively on header names that merely imply credentials', () => {
    const redacted = redactHeaders({
      'x-some-token': 'a',
      'x-vendor-secret': 'b',
      'x-user-password': 'c',
      'x-thing-apikey': 'd',
      'x-safe-header': 'keep',
    }) as Record<string, unknown>

    expect(redacted).toEqual({
      'x-some-token': '[REDACTED]',
      'x-vendor-secret': '[REDACTED]',
      'x-user-password': '[REDACTED]',
      'x-thing-apikey': '[REDACTED]',
      'x-safe-header': 'keep',
    })
  })

  it('passes non-object header values straight through', () => {
    expect(redactHeaders(null)).toBeNull()
    expect(redactHeaders('nope')).toBe('nope')
    expect(redactHeaders(['a'])).toEqual(['a'])
  })
})
