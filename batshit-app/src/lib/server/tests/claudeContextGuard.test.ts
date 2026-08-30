import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CLAUDE_CONTEXT_GUARD_THRESHOLD,
  DEFAULT_CLAUDE_CONTEXT_WINDOW,
  applyClaudeContextGuard,
  buildClaudeContextGuardStopMessage,
  extractClaudeContextUsedTokens,
  resolveClaudeContextGuardThreshold,
  resolveClaudeContextWindow,
} from '../services/claudeContextGuard'
import { isContextExhaustionError } from '../services/contextExhaustion'

function assistantEvent(usage: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'working on it' }],
      ...(usage ? { usage } : {}),
    },
    ...extra,
  }
}

async function* streamOf(events: any[]): AsyncGenerator<any> {
  for (const event of events) {
    yield event
  }
}

async function collect(stream: AsyncGenerator<any>): Promise<{ events: any[]; error: Error | null }> {
  const events: any[] = []
  try {
    for await (const event of stream) {
      events.push(event)
    }
    return { events, error: null }
  } catch (error) {
    return { events, error: error as Error }
  }
}

describe('resolveClaudeContextGuardThreshold', () => {
  it('defaults to 0.8 when unset or blank', () => {
    expect(resolveClaudeContextGuardThreshold({})).toBe(DEFAULT_CLAUDE_CONTEXT_GUARD_THRESHOLD)
    expect(
      resolveClaudeContextGuardThreshold({ BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD: '  ' }),
    ).toBe(DEFAULT_CLAUDE_CONTEXT_GUARD_THRESHOLD)
  })

  it('accepts values in [0.5, 1)', () => {
    expect(
      resolveClaudeContextGuardThreshold({ BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD: '0.5' }),
    ).toBe(0.5)
    expect(
      resolveClaudeContextGuardThreshold({ BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD: '0.95' }),
    ).toBe(0.95)
  })

  it('fails loudly for out-of-range or junk values', () => {
    for (const raw of ['0.2', '1', '1.5', '-0.8', 'abc']) {
      expect(() =>
        resolveClaudeContextGuardThreshold({ BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD: raw }),
      ).toThrow(/BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD must be/)
    }
  })

  it('returns null (guard disabled) for explicit opt-out values', () => {
    for (const raw of ['off', 'OFF', 'false', 'disabled', 'none', '0']) {
      expect(
        resolveClaudeContextGuardThreshold({ BATSHIT_CLAUDE_CONTEXT_GUARD_THRESHOLD: raw }),
      ).toBeNull()
    }
  })
})

describe('resolveClaudeContextWindow', () => {
  it('prefers a positive preset context window', () => {
    expect(
      resolveClaudeContextWindow({ presetContextWindow: 500_000, model: 'claude-opus-4-8' }),
    ).toBe(500_000)
  })

  it('ignores zero/invalid preset values (CLI presets default to 0)', () => {
    expect(resolveClaudeContextWindow({ presetContextWindow: 0, model: 'claude-opus-4-8' })).toBe(
      DEFAULT_CLAUDE_CONTEXT_WINDOW,
    )
    expect(resolveClaudeContextWindow({ presetContextWindow: NaN, model: null })).toBe(
      DEFAULT_CLAUDE_CONTEXT_WINDOW,
    )
  })

  it('detects the 1M-token beta from a [1m] model suffix', () => {
    expect(resolveClaudeContextWindow({ presetContextWindow: 0, model: 'sonnet[1m]' })).toBe(
      1_000_000,
    )
    expect(
      resolveClaudeContextWindow({ presetContextWindow: null, model: 'claude-sonnet-4-6[1M]' }),
    ).toBe(1_000_000)
  })

  it('falls back to the standard 200k window', () => {
    expect(resolveClaudeContextWindow({})).toBe(200_000)
  })
})

describe('extractClaudeContextUsedTokens', () => {
  it('sums fresh, cache-read, cache-write, and output tokens', () => {
    const event = assistantEvent({
      input_tokens: 1_000,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 4_000,
      output_tokens: 2_500,
    })
    expect(extractClaudeContextUsedTokens(event)).toBe(157_500)
  })

  it('falls back to summing the cache_creation breakdown object', () => {
    const event = assistantEvent({
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
      output_tokens: 10,
    })
    expect(extractClaudeContextUsedTokens(event)).toBe(210)
  })

  it('tolerates partially missing usage fields', () => {
    expect(extractClaudeContextUsedTokens(assistantEvent({ input_tokens: 42 }))).toBe(42)
  })

  it('returns null for events without usable usage', () => {
    expect(extractClaudeContextUsedTokens(assistantEvent(undefined))).toBeNull()
    expect(extractClaudeContextUsedTokens(assistantEvent({}))).toBeNull()
    expect(extractClaudeContextUsedTokens(null)).toBeNull()
    expect(extractClaudeContextUsedTokens({ type: 'result', usage: { input_tokens: 9 } })).toBeNull()
    expect(extractClaudeContextUsedTokens({ type: 'user', message: {} })).toBeNull()
  })

  it('ignores subagent sidechain events (parent_tool_use_id set)', () => {
    const event = assistantEvent(
      { input_tokens: 999_999 },
      { parent_tool_use_id: 'toolu_parent_123' },
    )
    expect(extractClaudeContextUsedTokens(event)).toBeNull()
  })
})

describe('buildClaudeContextGuardStopMessage', () => {
  it('is classified as a context-exhaustion failure', () => {
    const message = buildClaudeContextGuardStopMessage({
      usedTokens: 160_000,
      contextWindow: 200_000,
      threshold: 0.8,
    })
    expect(message).toContain('Batshit context guard')
    expect(message).toContain('80%')
    expect(message).toContain('160,000')
    expect(message).toContain('200,000')
    expect(isContextExhaustionError(message)).toBe(true)
  })
})

describe('applyClaudeContextGuard', () => {
  const guardConfig = { contextWindow: 200_000, threshold: 0.8 }

  it('passes events through untouched below the threshold', async () => {
    const onTrip = vi.fn()
    const events = [
      { type: 'system', subtype: 'init' },
      assistantEvent({ input_tokens: 10_000, output_tokens: 500 }),
      { type: 'user', message: { content: [] } },
      assistantEvent({ input_tokens: 50_000, cache_read_input_tokens: 20_000, output_tokens: 900 }),
      { type: 'result', subtype: 'success' },
    ]

    const { events: seen, error } = await collect(
      applyClaudeContextGuard(streamOf(events), { ...guardConfig, onTrip }),
    )

    expect(error).toBeNull()
    expect(seen).toEqual(events)
    expect(onTrip).not.toHaveBeenCalled()
  })

  it('yields the triggering event, calls onTrip, then throws a classified error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const onTrip = vi.fn()
      const tripping = assistantEvent({
        input_tokens: 1_000,
        cache_read_input_tokens: 158_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 1_000,
      })
      const events = [
        assistantEvent({ input_tokens: 10_000 }),
        tripping,
        { type: 'result', subtype: 'success' },
      ]

      const { events: seen, error } = await collect(
        applyClaudeContextGuard(streamOf(events), { ...guardConfig, onTrip }),
      )

      expect(seen).toHaveLength(2)
      expect(seen[1]).toBe(tripping)
      expect(onTrip).toHaveBeenCalledTimes(1)
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).toContain('Batshit context guard')
      expect(isContextExhaustionError(error?.message)).toBe(true)
      expect(onTrip.mock.calls[0][0]).toBe(error?.message)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not trip on sidechain usage above the threshold', async () => {
    const onTrip = vi.fn()
    const events = [
      assistantEvent({ input_tokens: 199_000 }, { parent_tool_use_id: 'toolu_parent' }),
      { type: 'result', subtype: 'success' },
    ]

    const { events: seen, error } = await collect(
      applyClaudeContextGuard(streamOf(events), { ...guardConfig, onTrip }),
    )

    expect(error).toBeNull()
    expect(seen).toHaveLength(2)
    expect(onTrip).not.toHaveBeenCalled()
  })

  it('closes the underlying stream when the guard trips', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let finallyRan = false
      async function* upstream(): AsyncGenerator<any> {
        try {
          yield assistantEvent({ input_tokens: 190_000 })
          yield { type: 'result', subtype: 'success' }
        } finally {
          finallyRan = true
        }
      }

      const { error } = await collect(
        applyClaudeContextGuard(upstream(), { ...guardConfig, onTrip: vi.fn() }),
      )

      expect(error).toBeInstanceOf(Error)
      expect(finallyRan).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
