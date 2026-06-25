import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { assertInternalServiceTokenConfigured } from './hooks.server'

vi.mock('$app/environment', () => ({
  building: false,
  dev: false
}))

const restoreEnv = (snapshot: Record<string, string | undefined>) => {
  for (const key of Object.keys(env)) {
    delete env[key]
  }
  Object.assign(env, snapshot)
}

describe('production startup service-token guard', () => {
  const originalEnv = { ...env }

  afterEach(() => {
    restoreEnv(originalEnv)
  })

  it('rejects a missing internal service token in production', () => {
    env.NODE_ENV = 'production'
    delete env.BATSHIT_TOKEN
    delete env.MCP_GATEWAY_AUTH_TOKEN

    expect(() => assertInternalServiceTokenConfigured()).toThrow(
      'BATSHIT_TOKEN must be set to a stable, non-placeholder secret of at least 32 characters'
    )
  })

  it('rejects short or placeholder internal service tokens in production', () => {
    env.NODE_ENV = 'production'
    env.BATSHIT_TOKEN = 'short'
    delete env.MCP_GATEWAY_AUTH_TOKEN

    expect(() => assertInternalServiceTokenConfigured()).toThrow(
      'BATSHIT_TOKEN must be set to a stable, non-placeholder secret of at least 32 characters'
    )

    env.BATSHIT_TOKEN = 'replace-with-a-real-service-token-value'

    expect(() => assertInternalServiceTokenConfigured()).toThrow(
      'BATSHIT_TOKEN must be set to a stable, non-placeholder secret of at least 32 characters'
    )
  })

  it('accepts a stable internal service token in production', () => {
    env.NODE_ENV = 'production'
    env.BATSHIT_TOKEN = 'valid-production-service-token-123456'
    delete env.MCP_GATEWAY_AUTH_TOKEN

    expect(() => assertInternalServiceTokenConfigured()).not.toThrow()
  })

  it('accepts the gateway token fallback when the dedicated token is absent', () => {
    env.NODE_ENV = 'production'
    delete env.BATSHIT_TOKEN
    env.MCP_GATEWAY_AUTH_TOKEN = 'valid-production-gateway-token-123456'

    expect(() => assertInternalServiceTokenConfigured()).not.toThrow()
  })
})
