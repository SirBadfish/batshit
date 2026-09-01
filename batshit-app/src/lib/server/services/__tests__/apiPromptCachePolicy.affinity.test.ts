import { describe, expect, it } from 'vitest'
import { applyApiPromptCachePolicy } from '../apiPromptCachePolicy'

/**
 * SA-107: per-session cache-affinity headers (DL-107-01..04) and
 * exact-service-first provider resolution (DL-107-03).
 */

const baseMessages = () =>
  [
    { role: 'system', content: 'Stable Batshit API agent prompt.' },
    { role: 'user', content: 'hello' },
  ] as any[]

const identity = {
  userId: 'user-raw-id-1',
  agentId: 'agent-raw-id-1',
  sessionId: 'session-raw-id-1',
}

describe('apiPromptCachePolicy session affinity (SA-107)', () => {
  it('adds x-grok-conv-id on the direct xAI lane', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'grok-4.20-non-reasoning',
      providerId: 'xai',
      connection: { type: 'direct', service: 'xai', id: 'direct:xai' },
      ...identity,
      messages: baseMessages(),
    })

    expect(result.metadata.provider).toBe('xai')
    expect(result.headers?.['x-grok-conv-id']).toMatch(/^bs-aff-v1-/)
    expect(result.metadata.requestHeaderNames).toEqual(['x-grok-conv-id'])
    expect(result.metadata.applied).toContain('xai.x-grok-conv-id')
  })

  it('adds x-session-affinity on the direct Baseten lane', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'deepseek-ai/DeepSeek-V4-Pro',
      providerId: 'baseten',
      connection: { type: 'direct', service: 'baseten' },
      ...identity,
      messages: baseMessages(),
    })

    expect(result.metadata.provider).toBe('baseten')
    expect(result.headers?.['x-session-affinity']).toMatch(/^bs-aff-v1-/)
    expect(result.metadata.requestHeaderNames).toEqual(['x-session-affinity'])
  })

  it('classifies a gpt-oss model on Fireworks as fireworks, not openai, and adds x-session-affinity', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'accounts/fireworks/models/gpt-oss-120b',
      providerId: 'fireworks',
      connection: { type: 'direct', service: 'fireworks' },
      ...identity,
      messages: baseMessages(),
    })

    expect(result.metadata.provider).toBe('fireworks')
    expect(result.headers?.['x-session-affinity']).toMatch(/^bs-aff-v1-/)
    // Exact-service resolution means the dead OpenAI option must NOT appear.
    expect(result.providerOptions?.openai).toBeUndefined()
  })

  it('keeps the affinity value stable for the same session and changes it across sessions', () => {
    const args = {
      modelId: 'grok-4.20-non-reasoning',
      providerId: 'xai',
      connection: { type: 'direct', service: 'xai' } as any,
      userId: identity.userId,
      agentId: identity.agentId,
    }
    const first = applyApiPromptCachePolicy({
      ...args,
      sessionId: 'session-A',
      messages: baseMessages(),
    })
    const second = applyApiPromptCachePolicy({
      ...args,
      sessionId: 'session-A',
      messages: [
        { role: 'system', content: 'Stable Batshit API agent prompt.' },
        { role: 'user', content: 'a different current message' },
      ] as any[],
    })
    const otherSession = applyApiPromptCachePolicy({
      ...args,
      sessionId: 'session-B',
      messages: baseMessages(),
    })

    expect(first.headers?.['x-grok-conv-id']).toBe(
      second.headers?.['x-grok-conv-id'],
    )
    expect(first.headers?.['x-grok-conv-id']).not.toBe(
      otherSession.headers?.['x-grok-conv-id'],
    )
  })

  it('never leaks raw identifiers into the affinity value', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'grok-4.20-non-reasoning',
      providerId: 'xai',
      connection: { type: 'direct', service: 'xai' },
      ...identity,
      messages: baseMessages(),
    })

    const value = result.headers?.['x-grok-conv-id'] ?? ''
    expect(value).not.toContain(identity.sessionId)
    expect(value).not.toContain(identity.userId)
    expect(value).not.toContain(identity.agentId)
  })

  it('adds no affinity headers on lanes without a documented hint', () => {
    const lanes = [
      {
        modelId: 'claude-sonnet-4-5',
        providerId: 'anthropic',
        connection: { type: 'direct', service: 'anthropic' } as any,
      },
      {
        modelId: 'gemini-2.5-pro',
        providerId: 'google',
        connection: { type: 'direct', service: 'google' } as any,
      },
      {
        modelId: 'anthropic/claude-sonnet-4-5',
        providerId: 'openrouter',
        connection: { type: 'openrouter', id: 'openrouter' } as any,
      },
      {
        modelId: 'openai/gpt-5.5',
        providerId: 'vercel-gateway',
        connection: { type: 'vercel-gateway', id: 'vercel-gateway' } as any,
      },
      {
        modelId: 'openai/gpt-oss-120b',
        providerId: 'groq',
        connection: { type: 'direct', service: 'groq' } as any,
      },
    ]

    for (const lane of lanes) {
      const result = applyApiPromptCachePolicy({
        ...lane,
        ...identity,
        messages: baseMessages(),
      })
      expect(result.headers).toBeUndefined()
      expect(result.metadata.requestHeaderNames).toEqual([])
    }
  })
})

describe('apiPromptCachePolicy exact-service-first resolution (DL-107-03)', () => {
  it('treats a known direct service as authoritative over fuzzy model-name inference', () => {
    // gpt-oss on Groq previously fuzzy-matched 'openai'; the service id now wins.
    const result = applyApiPromptCachePolicy({
      modelId: 'openai/gpt-oss-120b',
      providerId: 'groq',
      connection: { type: 'direct', service: 'groq' },
      ...identity,
      messages: baseMessages(),
    })

    expect(result.metadata.provider).toBe('unknown')
    expect(result.providerOptions?.openai).toBeUndefined()
  })

  it('resolves the service from a direct: connection id when service is absent', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'grok-4.20-non-reasoning',
      connection: { type: 'direct', id: 'direct:xai' } as any,
      ...identity,
      messages: baseMessages(),
    })

    expect(result.metadata.provider).toBe('xai')
    expect(result.headers?.['x-grok-conv-id']).toMatch(/^bs-aff-v1-/)
  })

  it('still applies fuzzy inference when no connection or service exists', () => {
    const anthropicByName = applyApiPromptCachePolicy({
      modelId: 'claude-sonnet-4-5',
      ...identity,
      messages: baseMessages(),
    })
    const openaiByProviderId = applyApiPromptCachePolicy({
      modelId: 'some-model',
      providerId: 'openai',
      ...identity,
      messages: baseMessages(),
    })

    expect(anthropicByName.metadata.provider).toBe('anthropic')
    expect(
      (anthropicByName.messages[0] as any).providerOptions?.anthropic
        ?.cacheControl,
    ).toEqual({ type: 'ephemeral' })
    expect(openaiByProviderId.metadata.provider).toBe('openai')
    expect(
      openaiByProviderId.providerOptions?.openai?.promptCacheKey,
    ).toMatch(/^bs-pc-v1-/)
  })

  it('keeps custom providers out of provider-specific cache policies', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'claude-compatible-model',
      providerId: 'custom_myproxy',
      connection: { type: 'direct', service: 'custom_myproxy' },
      ...identity,
      messages: baseMessages(),
    })

    expect(result.metadata.provider).toBe('unknown')
    expect(result.headers).toBeUndefined()
    expect((result.messages[0] as any).providerOptions).toBeUndefined()
  })
})
