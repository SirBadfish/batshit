import { afterEach, describe, expect, it, vi } from 'vitest'

const apiKeyMocks = vi.hoisted(() => ({
  retrieve: vi.fn()
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: apiKeyMocks.retrieve
  }
}))

import {
  normalizeLiveKitSpeechToSpeechProviderId,
  resolveLiveKitSpeechToSpeechProviderKey
} from '$lib/server/services/liveKitSpeechToSpeechProviders'

describe('liveKitSpeechToSpeechProviders', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    apiKeyMocks.retrieve.mockReset()
  })

  it('normalizes supported provider aliases', () => {
    expect(normalizeLiveKitSpeechToSpeechProviderId('openai')).toBe('openai')
    expect(normalizeLiveKitSpeechToSpeechProviderId('Google')).toBe('google')
    expect(normalizeLiveKitSpeechToSpeechProviderId('google-generative-ai')).toBe('google')
    expect(normalizeLiveKitSpeechToSpeechProviderId('grok')).toBe('xai')
    expect(normalizeLiveKitSpeechToSpeechProviderId('x-ai')).toBe('xai')
    expect(normalizeLiveKitSpeechToSpeechProviderId('unknown')).toBeNull()
  })

  it('prefers the saved user provider key over environment fallback', async () => {
    apiKeyMocks.retrieve.mockResolvedValue(' saved-xai-key ')
    vi.stubEnv('XAI_API_KEY', 'env-xai-key')

    await expect(resolveLiveKitSpeechToSpeechProviderKey('user-1', 'xai')).resolves.toEqual({
      apiKey: 'saved-xai-key',
      source: 'user'
    })
    expect(apiKeyMocks.retrieve).toHaveBeenCalledWith('xai', 'user-1')
  })

  it('falls back to provider environment keys when no saved key exists', async () => {
    apiKeyMocks.retrieve.mockResolvedValue(null)

    await expect(resolveLiveKitSpeechToSpeechProviderKey('user-1', 'google')).resolves.toMatchObject({
      apiKey: expect.any(String),
      source: 'env'
    })
  })
})
