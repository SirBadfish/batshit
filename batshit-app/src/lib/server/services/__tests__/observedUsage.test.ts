import { describe, expect, it, vi } from 'vitest'
import { createCodexDelegatedAccounting, readObservedUsage } from '../observedUsage'

const partial = (counts: Record<string, number>) => ({ completeness: 'partial' as const, parts: [{ source: 'codex-app-server-progress' as const, counts }] })

describe('invocation-owned Codex delegated accounting', () => {
  it('registers without reading and freezes only the current coherent aggregate once', () => {
    let current = partial({ inputTokens: 100, outputTokens: 10, totalTokens: 110 })
    const getter = vi.fn(() => current)
    const latch = createCodexDelegatedAccounting()
    latch.register(getter)
    expect(getter).not.toHaveBeenCalled()
    current = partial({ outputTokens: 20 }) // Replace, never splice in older input.
    const result = latch.freeze()
    expect(result).toEqual({ usage: null, observedUsage: current })
    current.parts[0].counts.outputTokens = 999
    result.observedUsage!.parts[0].counts.outputTokens = 888
    latch.reportFinish({ observedUsage: partial({ outputTokens: 777 }) })
    const late = vi.fn(() => partial({ inputTokens: 666 }))
    latch.register(late)
    expect(latch.freeze()).toEqual({ usage: null, observedUsage: partial({ outputTokens: 20 }) })
    expect(getter).toHaveBeenCalledTimes(1); expect(late).not.toHaveBeenCalled()
  })

  it('returns unknown at a pre-registration deadline and refuses late accounting', () => {
    const latch = createCodexDelegatedAccounting()
    expect(latch.freeze()).toEqual({ usage: null })
    const late = vi.fn(() => partial({ inputTokens: 100 }))
    latch.register(late); latch.reportCompleted({ inputTokens: 100, outputTokens: 10 })
    latch.reportFinish({ observedUsage: partial({ inputTokens: 100 }) })
    expect(latch.freeze()).toEqual({ usage: null }); expect(late).not.toHaveBeenCalled()
  })

  it.each([{ outputTokens: 0 }, { cacheCreationInputTokens: 0 }, { reasoningTokens: 3 }])('preserves %j without filling absent members or canonical usage', (counts) => {
    const latch = createCodexDelegatedAccounting(); latch.register(() => partial(counts))
    expect(latch.freeze()).toEqual({ usage: null, observedUsage: partial(counts) })
  })

  it('keeps consumed successful accounting canonical and detached across copies/late updates', () => {
    const latch = createCodexDelegatedAccounting()
    const getter = vi.fn(() => partial({ inputTokens: 900 }))
    latch.register(getter)
    const reported = { inputTokens: 100, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 20 }, outputTokenDetails: { reasoningTokens: 5 } }
    latch.reportCompleted(reported)
    const expected = structuredClone(latch.freeze())
    reported.inputTokenDetails.cacheReadTokens = 700
    const returned = latch.freeze()
    if (returned.usage?.inputTokenDetails) returned.usage.inputTokenDetails.cacheReadTokens = 800
    if (returned.usage?.outputTokenDetails) returned.usage.outputTokenDetails.reasoningTokens = 900
    returned.usage!.inputTokens = 1000
    latch.reportCompleted({ inputTokens: 5000, outputTokens: 5000 })
    expect(latch.freeze()).toEqual(expected)
    expect(expected.usage?.inputTokens).toBe(100)
    expect(expected.usage?.inputTokenDetails?.cacheReadTokens).toBe(20)
    expect(getter).not.toHaveBeenCalled()
    expect(expected.observedUsage).toBeUndefined()
  })

  it('does not borrow a partial when an actual consumed finish reports no usage', () => {
    const getter = vi.fn(() => partial({ inputTokens: 100 }))
    const latch = createCodexDelegatedAccounting(); latch.register(getter); latch.reportCompleted(undefined)
    expect(latch.freeze()).toEqual({ usage: null }); expect(getter).not.toHaveBeenCalled()
  })

  it.each([() => ({ completeness: 'complete', parts: [] } as any), () => { throw new Error('private getter detail') }])('marks invalid evidence explicitly without canonical promotion', (getter) => {
    const latch = createCodexDelegatedAccounting(); latch.register(getter)
    expect(latch.freeze()).toEqual({ usage: null, observedUsageUnavailable: 'invalid' })
    expect(JSON.stringify(latch.freeze())).not.toContain('private getter detail')
  })

  it('closes a parent-abort no-result invocation without reading or publishing a child', () => {
    const getter = vi.fn(() => partial({ inputTokens: 100 }))
    const latch = createCodexDelegatedAccounting(); latch.register(getter); latch.discard()
    latch.reportFinish({ observedUsage: partial({ inputTokens: 200 }) })
    expect(latch.freeze()).toEqual({ usage: null }); expect(getter).not.toHaveBeenCalled()
  })

  it('shares the established strict completeness validator without filtering malformed portions', () => {
    expect(() => readObservedUsage({ completeness: 'partial', parts: [partial({ outputTokens: 0 }).parts[0], { source: 'unknown', counts: { outputTokens: 1 } }] })).toThrow('unknown source')
    expect(readObservedUsage(partial({ outputTokens: 0 }))).toEqual(partial({ outputTokens: 0 }))
  })
})
