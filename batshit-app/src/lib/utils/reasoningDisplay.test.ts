import { describe, expect, it } from 'vitest'
import {
  collectReasoningTextFromFinish,
  extractReasoningTextFromRawChunk,
  withReasoningDisplayProviderOptions,
} from './reasoningDisplay'

describe('reasoningDisplay utilities', () => {
  it('requests OpenAI reasoning summaries when Display Reasoning is enabled', () => {
    const options = withReasoningDisplayProviderOptions(undefined, {
      provider: 'openai',
      modelId: 'gpt-5.5',
      capabilities: { reasoning: true },
      showReasoning: true,
    })

    expect(options?.openai?.reasoningSummary).toBe('auto')
  })

  it('requests Gemini thought summaries when Display Reasoning is enabled', () => {
    const options = withReasoningDisplayProviderOptions(
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

  it('collects final SDK reasoning parts into display text', () => {
    const text = collectReasoningTextFromFinish([
      { type: 'reasoning', text: 'First summary.' },
      { reasoningText: 'Second summary.' },
    ])

    expect(text).toBe('First summary.\n\nSecond summary.')
  })
})
