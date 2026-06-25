import { describe, expect, it } from 'vitest'
import { env } from '$env/dynamic/private'

import {
  internalServiceHeaders,
  isTrustedInternalRequest
} from '$lib/server/services/internalRequestAuth'

describe('internalRequestAuth', () => {
  it('marks trusted server-to-server calls for rate-limit bypass', () => {
    const previousToken = (env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN
    ;(env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN = 'test-service-token'

    try {
      expect(internalServiceHeaders()).toEqual({
        'x-batshit-service-token': 'test-service-token',
        'x-internal-api-request': '1'
      })
    } finally {
      if (previousToken === undefined) {
        delete (env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN
      } else {
        ;(env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN = previousToken
      }
    }
  })

  it('requires the service token even when the internal bypass marker is present', () => {
    const previousToken = (env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN
    ;(env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN = 'test-service-token'

    try {
      const request = new Request('http://localhost/api/messages/send-routed', {
        headers: {
          'x-internal-api-request': '1'
        }
      })
      expect(isTrustedInternalRequest(request)).toBe(false)
    } finally {
      if (previousToken === undefined) {
        delete (env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN
      } else {
        ;(env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN = previousToken
      }
    }
  })
})
