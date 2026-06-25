import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'

import { resolveCliHelperBatshitToken } from '../cliHelperToken'

describe('resolveCliHelperBatshitToken', () => {
  let previousEnvToken: string | undefined
  let previousGatewayToken: string | undefined

  beforeEach(() => {
    previousEnvToken = env.BATSHIT_TOKEN
    previousGatewayToken = env.MCP_GATEWAY_AUTH_TOKEN
    delete env.BATSHIT_TOKEN
    env.MCP_GATEWAY_AUTH_TOKEN = 'gateway-token'
  })

  afterEach(() => {
    if (previousEnvToken === undefined) delete env.BATSHIT_TOKEN
    else env.BATSHIT_TOKEN = previousEnvToken

    if (previousGatewayToken === undefined) delete env.MCP_GATEWAY_AUTH_TOKEN
    else env.MCP_GATEWAY_AUTH_TOKEN = previousGatewayToken
  })

  it('prefers BATSHIT_TOKEN when a dedicated service token is configured', async () => {
    env.BATSHIT_TOKEN = 'env-batshit-token'

    await expect(resolveCliHelperBatshitToken('user-123')).resolves.toBe('env-batshit-token')
  })

  it('falls back to MCP_GATEWAY_AUTH_TOKEN because managed routes trust the same configured token', async () => {
    await expect(resolveCliHelperBatshitToken('user-123')).resolves.toBe('gateway-token')
  })

  it('returns null when no internal service token is configured', async () => {
    delete env.MCP_GATEWAY_AUTH_TOKEN
    await expect(resolveCliHelperBatshitToken('user-123')).resolves.toBeNull()
  })
})
