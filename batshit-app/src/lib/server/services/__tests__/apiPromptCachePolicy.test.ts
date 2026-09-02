import { describe, expect, it } from 'vitest'
import { applyApiPromptCachePolicy } from '../apiPromptCachePolicy'

const baseMessages = (userText: string) =>
  [
    { role: 'system', content: 'Stable Batshit API agent prompt.' },
    { role: 'user', content: userText },
  ] as any[]

describe('apiPromptCachePolicy', () => {
  it('uses a stable OpenAI promptCacheKey that ignores current user text', () => {
    const first = applyApiPromptCachePolicy({
      modelId: 'gpt-5.5',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai', id: 'direct:openai' },
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      messages: baseMessages('first current message with secret-text-a'),
    })
    const second = applyApiPromptCachePolicy({
      modelId: 'gpt-5.5',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai', id: 'direct:openai' },
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-2',
      messages: baseMessages('different current message with secret-text-b'),
    })

    expect(first.providerOptions?.openai?.promptCacheKey).toBe(
      second.providerOptions?.openai?.promptCacheKey,
    )
    expect(first.providerOptions?.openai?.promptCacheKey).not.toContain(
      'secret-text-a',
    )
    expect(first.metadata.applied).toContain('openai.promptCacheKey')
  })

  it('changes OpenAI promptCacheKey when the stable system prefix changes', () => {
    const first = applyApiPromptCachePolicy({
      modelId: 'gpt-5.5',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai' },
      userId: 'user-1',
      agentId: 'agent-1',
      messages: baseMessages('hello'),
    })
    const second = applyApiPromptCachePolicy({
      modelId: 'gpt-5.5',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai' },
      userId: 'user-1',
      agentId: 'agent-1',
      messages: [
        { role: 'system', content: 'Different stable Batshit API agent prompt.' },
        { role: 'user', content: 'hello' },
      ] as any[],
    })

    expect(first.providerOptions?.openai?.promptCacheKey).not.toBe(
      second.providerOptions?.openai?.promptCacheKey,
    )
  })

  it('keeps the stable prefix signature deterministic across tool insertion order', () => {
    const alphaTool = {
      description: 'Alpha tool',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    }
    const betaTool = {
      description: 'Beta tool',
      inputSchema: { type: 'object', properties: { count: { type: 'number' } } },
    }
    const first = applyApiPromptCachePolicy({
      modelId: 'gpt-5.5',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai' },
      userId: 'user-1',
      agentId: 'agent-1',
      messages: baseMessages('hello'),
      tools: {
        beta: betaTool,
        alpha: alphaTool,
      },
    })
    const second = applyApiPromptCachePolicy({
      modelId: 'gpt-5.5',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai' },
      userId: 'user-1',
      agentId: 'agent-1',
      messages: baseMessages('hello'),
      tools: {
        alpha: alphaTool,
        beta: betaTool,
      },
    })

    expect(first.metadata.stablePrefixHash).toBe(second.metadata.stablePrefixHash)
    expect(first.providerOptions?.openai?.promptCacheKey).toBe(
      second.providerOptions?.openai?.promptCacheKey,
    )
  })

  it('preserves manual OpenAI cache key and omits unsupported 24h retention', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'gpt-4o',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai' },
      messages: baseMessages('hello'),
      providerOptions: {
        openai: {
          promptCacheKey: 'manual-key',
          promptCacheRetention: '24h',
        },
      },
    })

    expect(result.providerOptions?.openai?.promptCacheKey).toBe('manual-key')
    expect(result.providerOptions?.openai?.promptCacheRetention).toBeUndefined()
    expect(result.metadata.preserved).toContain('openai.promptCacheKey')
    expect(result.metadata.omitted[0]?.option).toBe(
      'openai.promptCacheRetention',
    )
  })

  it('allows documented OpenAI 24h retention models and gates in-memory on GPT-5.5', () => {
    const allowed = applyApiPromptCachePolicy({
      modelId: 'gpt-4.1',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai' },
      messages: baseMessages('hello'),
      providerOptions: {
        openai: {
          promptCacheRetention: '24h',
        },
      },
    })
    const invalidInMemory = applyApiPromptCachePolicy({
      modelId: 'gpt-5.5',
      providerId: 'openai',
      connection: { type: 'direct', service: 'openai' },
      messages: baseMessages('hello'),
      providerOptions: {
        openai: {
          promptCacheRetention: 'in_memory',
        },
      },
    })

    expect(allowed.providerOptions?.openai?.promptCacheRetention).toBe('24h')
    expect(invalidInMemory.providerOptions?.openai?.promptCacheRetention).toBeUndefined()
    expect(invalidInMemory.metadata.omitted[0]?.option).toBe(
      'openai.promptCacheRetention',
    )
  })

  it('adds Anthropic automatic cache control to the stable system message', () => {
    const automaticMessages = baseMessages('hello')
    const automatic = applyApiPromptCachePolicy({
      modelId: 'claude-sonnet-4-5',
      providerId: 'anthropic',
      connection: { type: 'direct', service: 'anthropic' },
      messages: automaticMessages,
    })
    const manual = applyApiPromptCachePolicy({
      modelId: 'claude-sonnet-4-5',
      providerId: 'anthropic',
      connection: { type: 'direct', service: 'anthropic' },
      messages: baseMessages('hello'),
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral', ttl: '1h' },
        },
      },
    })

    expect(
      (automatic.messages[0] as any).providerOptions?.anthropic?.cacheControl,
    ).toEqual({
      type: 'ephemeral',
    })
    expect(automatic.providerOptions?.anthropic?.cacheControl).toBeUndefined()
    expect((automatic.messages[1] as any).providerOptions).toBeUndefined()
    expect(automatic.messages).not.toBe(automaticMessages)
    expect((automaticMessages[0] as any).providerOptions).toBeUndefined()
    expect(manual.providerOptions?.anthropic?.cacheControl).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect((manual.messages[0] as any).providerOptions).toBeUndefined()
  })

  it('adds a second Anthropic breakpoint to the last standing Awareness media part', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'claude-sonnet-4-5',
      providerId: 'anthropic',
      connection: { type: 'direct', service: 'anthropic' },
      messages: [
        { role: 'system', content: 'stable system' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '==== AWARENESS MEDIA (STANDING) ====\n- portrait.png — image' },
            { type: 'image', image: 'data:image/png;base64,AAAA' },
            { type: 'text', text: '==== CURRENT USER MESSAGE ====\n\nhello' }
          ]
        }
      ] as any
    })

    expect((result.messages[0] as any).providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral' })
    expect((result.messages[1] as any).content[1].providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral' })
    expect(result.metadata.applied).toContain('anthropic.standingMedia.cacheControl')
  })

  it('enables Vercel AI Gateway automatic caching while preserving provider options', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'openai/gpt-5.5',
      providerId: 'vercel-gateway',
      connection: { type: 'vercel-gateway', id: 'vercel-gateway' },
      messages: baseMessages('hello'),
      providerOptions: {
        openai: {
          reasoningSummary: 'auto',
        },
      },
    })

    expect(result.providerOptions?.gateway?.caching).toBe('auto')
    expect(result.providerOptions?.openai?.reasoningSummary).toBe('auto')
  })

  it('adds OpenRouter session stickiness, usage accounting, and Anthropic cache control', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'anthropic/claude-sonnet-4-5',
      providerId: 'openrouter',
      connection: { type: 'openrouter', id: 'openrouter' },
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      messages: baseMessages('hello'),
    })

    expect(result.providerOptions?.openrouter?.session_id).toMatch(/^bs-or-v1-/)
    expect(result.providerOptions?.openrouter?.usage).toEqual({ include: true })
    expect(
      (result.messages[0] as any).providerOptions?.openrouter?.cacheControl,
    ).toEqual({
      type: 'ephemeral',
    })
    expect(result.providerOptions?.openrouter?.cache_control).toBeUndefined()
  })

  it('does not add explicit cache options for Gemini implicit caching', () => {
    const result = applyApiPromptCachePolicy({
      modelId: 'gemini-2.5-pro',
      providerId: 'google',
      connection: { type: 'direct', service: 'google' },
      messages: baseMessages('hello'),
    })

    expect(result.providerOptions).toBeUndefined()
    expect(result.metadata.enabled).toBe(false)
  })
})
