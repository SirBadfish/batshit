/**
 * Packet 5 finding 1 (the restored-provider Ready contradiction): a custom
 * provider whose saved API key is missing (a backup that leaves secrets out
 * nulls it) or cannot be read is never registered at run time, so its
 * connection must not say Ready. It is locked with a reason that says what to do.
 */
import { describe, expect, it } from 'vitest'
import { _buildConnectionOptions } from './+server'

const access = {
  apiKeys: {},
  availability: new Proxy({}, { get: () => ({ hasKey: false, source: null }) }),
  gateway: { apiKey: null, baseURL: null, availability: { hasKey: false, source: null } }
} as any

const summary = (id: string, apiKeyUsable: boolean) => ({
  id,
  label: id,
  baseUrl: 'https://custom.invalid/v1',
  maskedKey: apiKeyUsable ? '****...1234' : '****',
  apiKeyUsable,
  createdAt: '',
  updatedAt: ''
})

const REASON =
  'The saved API key of this custom provider is missing or cannot be read. ' +
  'Enter its API key again under Settings → API Keys → Custom OpenAI-Compatible.'

describe('/api/models connection options for custom providers', () => {
  it('locks a custom provider whose saved key is not usable, with the reason', () => {
    const options = _buildConnectionOptions(access, {
      codex: null,
      customProviders: [summary('custom_restored', false)]
    })
    expect(options.find((entry) => entry.id === 'direct:custom_restored')).toMatchObject({
      status: 'locked',
      lockedReason: REASON
    })
  })

  it('keeps a custom provider with a usable key Ready (the control)', () => {
    const options = _buildConnectionOptions(access, {
      codex: null,
      customProviders: [summary('custom_ok', true)]
    })
    const option = options.find((entry) => entry.id === 'direct:custom_ok')
    expect(option?.status).toBe('ready')
    expect(option?.lockedReason).toBeUndefined()
  })
})
