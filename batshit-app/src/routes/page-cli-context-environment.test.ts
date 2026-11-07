import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'

beforeEach(() => {
  for (const key of ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())

/**
 * The page load used to hand the chat bar the Claude Code CLI context-cap booleans, for the CLI
 * Primary's context selection. SA-139 R4 removed that lane and its metadata; the load still sends
 * nothing of the configured address or credentials, and nothing before authentication.
 */
describe('authenticated page load', () => {
  const event = { locals: { user: { id: 'context-cap-user' } }, url: new URL('http://proof.example/') }
  it('provides no provider route or credentials', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://SENTINEL-PRIVATE:password@provider.example/v1')
    vi.stubEnv('CLAUDE_CODE_DISABLE_1M_CONTEXT', '1')
    const result = await load(event as any)
    expect(result).toEqual({})
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
    expect(JSON.stringify(result)).not.toContain('provider.example')
  })

  it('sends no data before authentication', async () => {
    await expect(load({ ...event, locals: {} } as any)).rejects.toMatchObject({ status: 303, location: '/login?returnUrl=%2F' })
  })
})
