/**
 * BL-520: a custom OpenAI-compatible provider is registered with the key the
 * user saved, however short. Its save takes any non-empty key and
 * `/api/models` shows it Ready, so a placeholder key such as vLLM's `EMPTY` or
 * LiteLLM's `sk-1234` must not be dropped at run time (every send then failed
 * with "Provider custom_x not configured"). Seller keys keep their rules.
 */
import { describe, expect, it, vi } from 'vitest'
import { ProviderManager } from '../index'

vi.mock('$env/dynamic/private', () => ({ env: {} }))

const custom = (id: string, apiKey: string) => ({
  id,
  label: id,
  baseUrl: 'http://127.0.0.1:8000/v1',
  apiKey
})

describe('BL-520: custom provider keys', () => {
  it('registers a custom provider whose key is a short placeholder', () => {
    const manager = new ProviderManager({
      customProviders: [custom('custom_vllm', 'EMPTY'), custom('custom_litellm', 'sk-1234')]
    })
    expect(manager.hasProvider('custom_vllm')).toBe(true)
    expect(manager.hasProvider('custom_litellm')).toBe(true)
  })

  it('still registers a custom provider with a long key (the control)', () => {
    const manager = new ProviderManager({ customProviders: [custom('custom_acme', 'acme-key-0123456789')] })
    expect(manager.hasProvider('custom_acme')).toBe(true)
  })

  it('registers no custom provider without a key', () => {
    const manager = new ProviderManager({ customProviders: [custom('custom_blank', '')] })
    expect(manager.hasProvider('custom_blank')).toBe(false)
  })

  it('keeps the seller key rules: a short or misprefixed seller key is still refused', () => {
    const manager = new ProviderManager({
      apiKeys: { openai: 'sk-1234', anthropic: 'not-an-anthropic-key-0123', mistral: 'EMPTY' }
    })
    expect(manager.hasProvider('openai')).toBe(false)
    expect(manager.hasProvider('anthropic')).toBe(false)
    expect(manager.hasProvider('mistral')).toBe(false)
  })
})
