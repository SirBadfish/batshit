import { describe, expect, it, vi } from 'vitest'
import {
  collectReasoningTextFromFinish,
  extractReasoningTextFromRawChunk,
  resolveTaggedReasoningTagName,
  withReasoningProviderOptions,
} from './reasoningDisplay'

describe('reasoningDisplay utilities', () => {
  it('requests OpenAI reasoning summaries when Display Reasoning is enabled', () => {
    const options = withReasoningProviderOptions(undefined, {
      provider: 'openai',
      modelId: 'gpt-5.5',
      capabilities: { reasoning: true },
      showReasoning: true,
    })

    expect(options?.openai?.reasoningSummary).toBe('auto')
  })

  it('requests Gemini thought summaries when Display Reasoning is enabled', () => {
    const options = withReasoningProviderOptions(
      { google: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: false } } },
      {
        provider: 'google',
        modelId: 'gemini-2.5-pro',
        capabilities: { reasoning: true },
        showReasoning: true,
      },
    )

    expect(options?.google?.thinkingConfig).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    })
  })

  it('extracts OpenAI-compatible raw reasoning deltas', () => {
    const text = extractReasoningTextFromRawChunk({
      choices: [
        {
          delta: {
            reasoning_content: 'Checking constraints...',
          },
        },
      ],
    })

    expect(text).toBe('Checking constraints...')
  })

  it('routes Gateway MiMo to Xiaomi without changing its reasoning mode', () => {
    const options = withReasoningProviderOptions(
      { gateway: { caching: 'auto' } },
      {
        provider: 'xiaomi',
        modelId: 'xiaomi/mimo-v2.5',
        connection: {
          id: 'vercel-gateway',
          type: 'vercel-gateway',
        },
        capabilities: { reasoning: true },
        showReasoning: false,
      },
    )

    expect(options).toEqual({
      gateway: { caching: 'auto', only: ['xiaomi'] },
    })
  })

  it('preserves an explicit MiMo Gateway routing choice', () => {
    const options = withReasoningProviderOptions(
      { gateway: { order: ['xiaomi', 'deepinfra'] } },
      {
        provider: 'xiaomi',
        modelId: 'xiaomi/mimo-v2.5',
        connection: {
          id: 'vercel-gateway',
          type: 'vercel-gateway',
        },
        capabilities: { reasoning: true },
        showReasoning: true,
      },
    )

    expect(options?.gateway?.order).toEqual(['xiaomi', 'deepinfra'])
    expect(options?.gateway?.only).toBeUndefined()
  })

  it('preserves an explicit MiMo thinking override', () => {
    const options = withReasoningProviderOptions(
      { xiaomi: { thinking: { type: 'disabled' } } },
      {
        provider: 'mimo',
        modelId: 'mimo-v2.5',
        capabilities: { reasoning: true },
        showReasoning: true,
      },
    )

    expect(options?.xiaomi?.thinking).toEqual({ type: 'disabled' })
  })

  it('normalizes think-tag reasoning for MiMo even without catalog capability metadata', () => {
    const tagName = resolveTaggedReasoningTagName({
      provider: 'mimo',
      modelId: 'mimo-v2.5-pro',
      connection: {
        id: 'direct:mimo',
        type: 'direct',
        service: 'mimo',
      },
      capabilities: null,
      showReasoning: false,
    })

    expect(tagName).toBe('think')
  })

  it('normalizes think-tag reasoning for DeepSeek even without catalog capability metadata', () => {
    const tagName = resolveTaggedReasoningTagName({
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      connection: {
        id: 'direct:deepseek',
        type: 'direct',
        service: 'deepseek',
      },
      capabilities: null,
      showReasoning: true,
    })

    expect(tagName).toBe('think')
  })

  it('normalizes think-tag reasoning for custom models declared reasoning-capable', () => {
    const tagName = resolveTaggedReasoningTagName({
      provider: 'custom_local_runtime',
      modelId: 'private-reasoning-model',
      capabilities: { reasoning: true },
      showReasoning: true,
    })

    expect(tagName).toBe('think')
  })

  it('leaves ordinary non-reasoning model text untouched', () => {
    const tagName = resolveTaggedReasoningTagName({
      provider: 'anthropic',
      modelId: 'claude-3-5-haiku',
      capabilities: { reasoning: false },
      showReasoning: true,
    })

    expect(tagName).toBeNull()
  })

  it('uses the installed AI SDK to extract think tags split across stream chunks', async () => {
    const { extractReasoningMiddleware } = await vi.importActual<typeof import('ai')>('ai')
    const middleware = extractReasoningMiddleware({ tagName: 'think' })
    const upstream = [
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: '<thi' },
      { type: 'text-delta', id: 'text-0', delta: 'nk>Checking constraints' },
      { type: 'text-delta', id: 'text-0', delta: ' carefully.</th' },
      { type: 'text-delta', id: 'text-0', delta: 'ink>The final answer.' },
      { type: 'text-end', id: 'text-0' },
    ]

    const transformed = await middleware.wrapStream!({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of upstream) controller.enqueue(part as any)
            controller.close()
          },
        }),
        request: { body: null },
      }),
    } as any)

    const parts: any[] = []
    const reader = transformed.stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }

    expect(
      parts
        .filter((part) => part.type === 'reasoning-delta')
        .map((part) => part.delta)
        .join(''),
    ).toBe('Checking constraints carefully.')
    expect(
      parts
        .filter((part) => part.type === 'text-delta')
        .map((part) => part.delta)
        .join(''),
    ).toBe('The final answer.')
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning-start' }),
        expect.objectContaining({ type: 'reasoning-end' }),
      ]),
    )
  })

  it('collects final SDK reasoning parts into display text', () => {
    const text = collectReasoningTextFromFinish([
      { type: 'reasoning', text: 'First summary.' },
      { reasoningText: 'Second summary.' },
    ])

    expect(text).toBe('First summary.\n\nSecond summary.')
  })
})
