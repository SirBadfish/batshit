import { describe, expect, it } from 'vitest'

import {
  SENSITIVE_HEADER_KEYS,
  redactHeaders
} from '$lib/server/services/executionViewerRedaction'

describe('executionViewerRedaction', () => {
  it('SA-117 DL-117-09: lists the run credential header explicitly, not only via the fallback', () => {
    // `shouldRedactHeader`'s `includes('token')` net would redact this one regardless, so the
    // output alone cannot prove the registration. The net is for headers nobody thought about;
    // a credential Batshit itself mints and sends is named.
    expect(SENSITIVE_HEADER_KEYS.has('x-batshit-agent-token')).toBe(true)
  })

  it('redacts credential headers from captured provider responses', () => {
    const redacted = redactHeaders({
      'content-type': 'application/json',
      authorization: 'Bearer sk-live-secret',
      cookie: 'session=abc',
      'x-api-key': 'provider-key',
      'x-batshit-service-token': 'service-secret',
      // SA-117 DL-117-09: the managed CLI run credential. Listed in the set rather than left
      // to the `includes('token')` fallback, so a rename cannot silently start capturing it.
      'X-Batshit-Agent-Token': 'arc_abc.bsac_run-secret',
      'x-request-id': 'req-123',
    }) as Record<string, unknown>

    expect(redacted).toEqual({
      'content-type': 'application/json',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-batshit-service-token': '[REDACTED]',
      'X-Batshit-Agent-Token': '[REDACTED]',
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
