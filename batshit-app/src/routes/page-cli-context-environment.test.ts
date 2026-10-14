import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'
import { claudeContextCappedByFlags } from '$lib/utils/cliContextWindow'

beforeEach(() => {
  for (const key of ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())

describe('authenticated page context-cap metadata', () => {
  const event = { locals: { user: { id: 'context-cap-user' } }, url: new URL('http://proof.example/') }
  it('provides only cap booleans, never the configured address or credentials', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://SENTINEL-PRIVATE:password@provider.example/v1')
    const result = await load(event as any)
    expect(result).toEqual({ claudeContextEnvironment: { disable1M: false, externalRoute: true } })
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
    expect(JSON.stringify(result)).not.toContain('provider.example')
    expect(claudeContextCappedByFlags('sonnet', (result as any).claudeContextEnvironment)).toBe(true)
    expect(claudeContextCappedByFlags('sonnet[1m]', (result as any).claudeContextEnvironment)).toBe(false)
  })

  it('honors explicit disable even for a 1M selection and sends no metadata before authentication', async () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_1M_CONTEXT', '1')
    const result = await load(event as any)
    expect(claudeContextCappedByFlags('sonnet[1m]', (result as any).claudeContextEnvironment)).toBe(true)
    await expect(load({ ...event, locals: {} } as any)).rejects.toMatchObject({ status: 303, location: '/login?returnUrl=%2F' })
  })
})
