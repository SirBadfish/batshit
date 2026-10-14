import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CLAUDE_CONTEXT_GUARD_THRESHOLD,
  applyClaudeContextGuard,
  buildClaudeContextGuardStopMessage,
  extractClaudeContextUsedTokens,
  resolveClaudeContextGuardThreshold,
  resolveClaudeContextWindow,
} from '../services/claudeContextGuard'
import { isContextExhaustionError } from '../services/contextExhaustion'
import { capturedClaudePrimaryEvents } from './fixtures/claudePrimaryContext'

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

  it('ignores zero/invalid preset values and uses only a verified choice', () => {
    expect(resolveClaudeContextWindow({ presetContextWindow: 0, model: 'claude-opus-4-8' })).toBe(1_000_000)
    expect(resolveClaudeContextWindow({ presetContextWindow: NaN, model: null })).toBeNull()
  })

  it('detects the 1M-token beta from a [1m] model suffix', () => {
    expect(resolveClaudeContextWindow({ presetContextWindow: 0, model: 'sonnet[1m]' })).toBe(
      1_000_000,
    )
    expect(
      resolveClaudeContextWindow({ presetContextWindow: null, model: 'claude-sonnet-4-6[1M]' }),
    ).toBeNull()
  })

  it('keeps an unresolved default unknown until the CLI names a model', () => {
    expect(resolveClaudeContextWindow({})).toBeNull()
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
  it('accepts the captured initialized [1m] row as fresh primary runtime evidence', async () => {
    const events = capturedClaudePrimaryEvents()
    const reports: any[] = []
    const result = await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 1_000_000, threshold: 0.8, model: 'sonnet[1m]',
      onReport: report => reports.push(report), onTrip: vi.fn()
    }))
    expect(result).toEqual({ events, error: null })
    expect(extractClaudeContextUsedTokens(events[1])).toBe(13_529)
    expect(reports.at(-1)).toMatchObject({ model: 'sonnet[1m]', actualModel: 'claude-sonnet-5-5',
      contextWindow: 1_000_000, evidence: 'runtime' })
  })

  it.each([false, true])('lets a differing runtime limit override preset/choice with disable1M=%s', async disableClaude1M => {
    const events = capturedClaudePrimaryEvents()
    events[2].modelUsage['claude-sonnet-5-5[1m]'].contextWindow = 550_000
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 200_000, presetContextWindow: 200_000, threshold: 0.8, model: 'sonnet[1m]',
      disableClaude1M, onReport: reports, onTrip: vi.fn()
    }))
    expect(reports).toHaveBeenLastCalledWith(expect.objectContaining({
      evidence: 'runtime', contextWindow: 550_000, disableClaude1M
    }))
  })

  it.each([
    ['canonical-only worker key', { 'worker-model': { canonicalModel: 'claude-sonnet-5-5', contextWindow: 17_000 } }],
    ['unobserved suffixed key', { 'claude-sonnet-5-5[other]': { canonicalModel: 'claude-sonnet-5-5', contextWindow: 17_000 } }],
    ['missing canonical identity', { 'claude-sonnet-5-5[1m]': { contextWindow: 17_000 } }],
    ['contradictory initialized row', { 'claude-sonnet-5-5[1m]': { canonicalModel: 'claude-haiku-5-5', contextWindow: 17_000 } }],
    ['contradictory exact row', { 'claude-sonnet-5-5': { canonicalModel: 'claude-haiku-5-5', contextWindow: 17_000 } }],
    ['two primary rows', {
      'claude-sonnet-5-5': { canonicalModel: 'claude-sonnet-5-5', contextWindow: 500_000 },
      'claude-sonnet-5-5[1m]': { canonicalModel: 'claude-sonnet-5-5', contextWindow: 1_000_000 }
    }],
    ['malformed row', { 'claude-sonnet-5-5[1m]': [] }],
    ['malformed usage', []]
  ])('refuses fresh runtime evidence for %s', async (_label, modelUsage) => {
    const events = capturedClaudePrimaryEvents()
    events[2].modelUsage = modelUsage
    const reports: any[] = []
    const result = await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 1_000_000, threshold: 0.8, model: 'sonnet[1m]',
      onReport: report => reports.push(report), onTrip: vi.fn()
    }))
    expect(result.error).toBeNull()
    expect(reports.some(report => report.evidence === 'runtime')).toBe(false)
    expect(reports.at(-1).contextWindow).toBe(1_000_000)
  })

  it.each([0, -1, 0.1, NaN, Infinity, Number.MAX_VALUE, '550000', null])('rejects invalid runtime window %s', async window => {
    const events = capturedClaudePrimaryEvents()
    events[2].modelUsage['claude-sonnet-5-5[1m]'].contextWindow = window
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 1_000_000, threshold: null, model: 'sonnet[1m]',
      onReport: reports, onTrip: vi.fn()
    }))
    expect(reports.mock.calls.some(([report]) => report.evidence === 'runtime')).toBe(false)
  })

  it('ignores sidechain init, assistant and result identities without losing the primary match', async () => {
    const events = capturedClaudePrimaryEvents()
    const worker = { parent_tool_use_id: 'worker-call' }
    events.splice(2, 0,
      { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', ...worker },
      { type: 'assistant', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 999_999 } }, ...worker },
      { type: 'result', modelUsage: { 'claude-sonnet-5-5': { contextWindow: 17_000 } }, ...worker })
    const reports: any[] = []
    const trip = vi.fn()
    const result = await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 1_000_000, threshold: 0.8, model: 'sonnet[1m]',
      onReport: report => reports.push(report), onTrip: trip
    }))
    expect(result.error).toBeNull()
    expect(trip).not.toHaveBeenCalled()
    expect(reports.filter(report => report.evidence === 'runtime')).toEqual([
      expect.objectContaining({ actualModel: 'claude-sonnet-5-5', contextWindow: 1_000_000 })
    ])
  })

  it('cannot borrow the initialized model after the top-level primary changes', async () => {
    const events = capturedClaudePrimaryEvents()
    events[1].message.model = 'claude-haiku-5-5'
    events[2].modelUsage['claude-sonnet-5-5[1m]'].canonicalModel = 'claude-haiku-5-5'
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 1_000_000, threshold: null, model: 'sonnet[1m]',
      onReport: reports, onTrip: vi.fn()
    }))
    expect(reports.mock.calls.some(([report]) => report.evidence === 'runtime')).toBe(false)
  })

  it('keeps an unknown primary window unknown when only a worker reports a limit', async () => {
    const events = capturedClaudePrimaryEvents()
    events[0].model = 'unknown-primary[1m]'
    events[1].message.model = 'unknown-primary'
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: null, threshold: 0.8, model: 'default',
      onReport: reports, onTrip: vi.fn()
    }))
    expect(reports).toHaveBeenLastCalledWith(expect.objectContaining({ evidence: 'unresolved', contextWindow: null }))
    expect(reports.mock.calls.some(([report]) => report.evidence === 'runtime')).toBe(false)
  })

  // What the previous [1m] run saved: the assistant's base name and its result row's limit.
  const savedBaseReport = (extra: Record<string, unknown> = {}): any => ({
    runtime: 'claude', model: 'sonnet[1m]', actualModel: 'claude-sonnet-5-5', contextWindow: 550_000,
    evidence: 'runtime', disableClaude1M: false, reportedAt: 1_760_184_000_000, ...extra
  })

  it('keeps the saved base-name window at the next exact [1m] init, with no new report', async () => {
    const reported = savedBaseReport()
    const saved = structuredClone(reported)
    const events = capturedClaudePrimaryEvents().slice(0, 2)
    events[1].message.usage = { input_tokens: 450_000, output_tokens: 0 }
    const reports = vi.fn()
    const trip = vi.fn()
    const result = await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 550_000, threshold: 0.8, model: 'sonnet[1m]', reported,
      onReport: reports, onTrip: trip
    }))
    // The 1M estimate would not trip at 450k; the retained 550k window does.
    expect(result.error?.message).toContain('550,000')
    expect(trip).toHaveBeenCalledOnce()
    // An init is not fresh telemetry: nothing is reported and the saved report keeps its time.
    expect(reports).not.toHaveBeenCalled()
    expect(reported).toEqual(saved)
  })

  it('lets the fresh result replace a retained [1m] baseline', async () => {
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(capturedClaudePrimaryEvents()), {
      contextWindow: 550_000, threshold: 0.8, model: 'sonnet[1m]', reported: savedBaseReport(),
      onReport: reports, onTrip: vi.fn()
    }))
    expect(reports).toHaveBeenCalledOnce()
    expect(reports).toHaveBeenCalledWith(expect.objectContaining({
      evidence: 'runtime', actualModel: 'claude-sonnet-5-5', contextWindow: 1_000_000
    }))
  })

  it.each([
    ['another suffix', 'claude-sonnet-5-5[2m]'],
    ['a differently cased suffix', 'claude-sonnet-5-5[1M]'],
    ['another model with [1m]', 'claude-opus-5-5[1m]'],
    ['a family prefix with [1m]', 'claude-sonnet-5[1m]']
  ])('drops the saved window at an init with %s', async (_label, initModel) => {
    const events = capturedClaudePrimaryEvents().slice(0, 1)
    events[0].model = initModel
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 550_000, threshold: 0.8, model: 'sonnet[1m]', reported: savedBaseReport(),
      onReport: reports, onTrip: vi.fn()
    }))
    expect(reports).toHaveBeenCalledOnce()
    expect(reports.mock.calls[0][0]).toMatchObject({ actualModel: initModel })
    expect(reports.mock.calls[0][0].evidence).not.toBe('runtime')
  })

  it.each([
    ['another requested model', { model: 'sonnet' }, 'claude-sonnet-5-5[1m]'],
    ['another 1M cap setting', { disableClaude1M: true }, 'claude-sonnet-5-5[1m]'],
    ['estimate-only evidence', { evidence: 'resolved' }, 'claude-sonnet-5-5[1m]'],
    ['no saved actual model', { actualModel: undefined }, 'undefined[1m]']
  ])('drops a saved window with %s at the [1m] init', async (_label, extra, initModel) => {
    const events = capturedClaudePrimaryEvents().slice(0, 1)
    events[0].model = initModel
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 550_000, threshold: 0.8, model: 'sonnet[1m]', reported: savedBaseReport(extra),
      onReport: reports, onTrip: vi.fn()
    }))
    expect(reports).toHaveBeenCalledOnce()
    expect(reports.mock.calls[0][0].evidence).not.toBe('runtime')
  })

  it('drops a retained [1m] baseline when a later top-level primary differs', async () => {
    const events = capturedClaudePrimaryEvents().slice(0, 2)
    events[1].message.model = 'claude-haiku-5-5'
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 550_000, threshold: null, model: 'sonnet[1m]', reported: savedBaseReport(),
      onReport: reports, onTrip: vi.fn()
    }))
    // The init kept it (no report), then the different primary discarded it.
    expect(reports).toHaveBeenCalledOnce()
    expect(reports.mock.calls[0][0]).toMatchObject({ actualModel: 'claude-haiku-5-5' })
    expect(reports.mock.calls[0][0].evidence).not.toBe('runtime')
  })

  it('gives an assistant that names the suffixed model no [1m] init allowance', async () => {
    const events = capturedClaudePrimaryEvents().slice(1, 2)
    events[0].message.model = 'claude-sonnet-5-5[1m]'
    const reports = vi.fn()
    await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: 550_000, threshold: null, model: 'sonnet[1m]', reported: savedBaseReport(),
      onReport: reports, onTrip: vi.fn()
    }))
    expect(reports).toHaveBeenCalledOnce()
    expect(reports.mock.calls[0][0]).toMatchObject({ actualModel: 'claude-sonnet-5-5[1m]' })
    expect(reports.mock.calls[0][0].evidence).not.toBe('runtime')
  })

  it('uses the actual model in captured managed CLI init, assistant and result events', async () => {
    // Sanitized from the managed Claude 2.1.283 no-tool proof, 2026-09-29.
    const reports: any[] = []
    const events = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
      assistantEvent({
        input_tokens: 2, cache_creation_input_tokens: 16_252,
        cache_read_input_tokens: 3_397, output_tokens: 4
      }, { message: { role: 'assistant', model: 'claude-sonnet-5', usage: {
        input_tokens: 2, cache_creation_input_tokens: 16_252,
        cache_read_input_tokens: 3_397, output_tokens: 4
      } } }),
      { type: 'result', modelUsage: {
        'claude-sonnet-5': { contextWindow: 1_000_000, canonicalModel: 'claude-sonnet-5' },
        'worker-model': { contextWindow: 17_000 }
      } }
    ]
    const result = await collect(applyClaudeContextGuard(streamOf(events), {
      contextWindow: null, threshold: 0.8, model: 'sonnet',
      onReport: (report) => reports.push(report), onTrip: vi.fn()
    }))
    expect(result.error).toBeNull()
    expect(reports.at(-1)).toMatchObject({
      runtime: 'claude', model: 'sonnet', actualModel: 'claude-sonnet-5', contextWindow: 1_000_000
    })
    expect(reports.every((report) => report.contextWindow !== 17_000)).toBe(true)
  })
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
