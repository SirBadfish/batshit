import { describe, expect, it } from 'vitest'
import { env } from '$env/dynamic/private'

import {
  internalServiceHeaders,
  isTrustedInternalRequest
} from '$lib/server/services/internalRequestAuth'

describe('internalRequestAuth', () => {
  it('marks trusted server-to-server calls for rate-limit bypass', () => {
    const previousToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
    ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = 'test-service-token'

    try {
      expect(internalServiceHeaders()).toEqual({
        'x-batshit-service-token': 'test-service-token',
        'x-internal-api-request': '1'
      })
    } finally {
      if (previousToken === undefined) {
        delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
      } else {
        ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousToken
      }
    }
  })

  /**
   * SA-117 DL-117-06 — the `|| MCP_GATEWAY_AUTH_TOKEN` fallback is gone.
   *
   * It mattered because this module and `nativeToolAuth.ts`'s service lane DISAGREED about
   * what "the internal token" was: the service lane only ever compared `BATSHIT_TOKEN`, so a
   * Docker-gateway token could satisfy the rate-limit bypass here while failing there. One
   * secret per boundary, and the gateway's token is the gateway's.
   */
  it('does not accept the Docker gateway token as the instance token', () => {
    const previousInstance = (env as Record<string, string | undefined>).BATSHIT_TOKEN
    const previousGateway = (env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN
    delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
    ;(env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN = 'gateway-token'

    try {
      expect(internalServiceHeaders()).toEqual({})

      const request = new Request('http://localhost/api/messages/send-routed', {
        headers: {
          'x-internal-api-request': '1',
          'x-batshit-service-token': 'gateway-token'
        }
      })
      expect(isTrustedInternalRequest(request)).toBe(false)
    } finally {
      if (previousInstance === undefined) {
        delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
      } else {
        ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousInstance
      }
      if (previousGateway === undefined) {
        delete (env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN
      } else {
        ;(env as Record<string, string | undefined>).MCP_GATEWAY_AUTH_TOKEN = previousGateway
      }
    }
  })

  it('requires the service token even when the internal bypass marker is present', () => {
    const previousToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
    ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = 'test-service-token'

    try {
      const request = new Request('http://localhost/api/messages/send-routed', {
        headers: {
          'x-internal-api-request': '1'
        }
      })
      expect(isTrustedInternalRequest(request)).toBe(false)
    } finally {
      if (previousToken === undefined) {
        delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
      } else {
        ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = previousToken
      }
    }
  })
})
