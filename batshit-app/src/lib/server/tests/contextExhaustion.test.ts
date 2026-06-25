import { describe, expect, it } from 'vitest'

import { isContextExhaustionError } from '../services/contextExhaustion'

describe('isContextExhaustionError', () => {
  it('matches the Codex CLI context-window failure verbatim', () => {
    expect(
      isContextExhaustionError(
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      ),
    ).toBe(true)
  })

  it('matches the Codex CLI failure with a typographic apostrophe', () => {
    expect(
      isContextExhaustionError(
        'Codex ran out of room in the model’s context window. Start a new thread or clear earlier history before retrying.',
      ),
    ).toBe(true)
  })

  it('matches OpenAI context_length_exceeded codes and messages', () => {
    expect(isContextExhaustionError('context_length_exceeded')).toBe(true)
    expect(
      isContextExhaustionError(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 131210 tokens.",
      ),
    ).toBe(true)
  })

  it('matches Anthropic prompt-too-long variants', () => {
    expect(
      isContextExhaustionError('prompt is too long: 210034 tokens > 200000 maximum'),
    ).toBe(true)
    expect(
      isContextExhaustionError(
        'input length and `max_tokens` exceed context limit: 199121 + 8192 > 200000',
      ),
    ).toBe(true)
  })

  it('matches Google Gemini input-token-count phrasing', () => {
    expect(
      isContextExhaustionError(
        'The input token count (1194467) exceeds the maximum number of tokens allowed (1048576).',
      ),
    ).toBe(true)
  })

  it('matches generic exceeded-context phrasings', () => {
    expect(
      isContextExhaustionError('Request exceeds the maximum context window of this model'),
    ).toBe(true)
    expect(
      isContextExhaustionError('The context window (272000 tokens) was exceeded'),
    ).toBe(true)
  })

  it('does not match unrelated failures', () => {
    expect(isContextExhaustionError(null)).toBe(false)
    expect(isContextExhaustionError(undefined)).toBe(false)
    expect(isContextExhaustionError('')).toBe(false)
    expect(isContextExhaustionError('API key not configured')).toBe(false)
    expect(isContextExhaustionError('rate limit exceeded, retry after 30s')).toBe(false)
    expect(isContextExhaustionError('connection reset by peer')).toBe(false)
    expect(
      isContextExhaustionError('Tool execution failed: file too long to read'),
    ).toBe(false)
    expect(
      isContextExhaustionError('max output tokens reached for this response'),
    ).toBe(false)
  })
})
