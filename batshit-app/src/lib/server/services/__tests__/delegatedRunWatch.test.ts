import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Delegation limits (Josh, 2026-10-24, decision 2) — the stall guard on its own. A run that
 * shows no progress for 10 minutes is stopped (Claude Code's watchdog); time inside a running
 * tool call is not silence.
 */

import {
  DELEGATED_RUN_STALL_MS,
  countDelegatedToolCalls,
  createDelegatedStallWatch,
  delegatedRunStopCondition,
  reportDelegatedStreamPart,
} from '../delegatedRunWatch'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the delegated run stall guard', () => {
  it("matches Claude Code's default: 10 minutes", () => {
    expect(DELEGATED_RUN_STALL_MS).toBe(600_000)
  })

  it('fires once after the window passes with nothing reported, even if nothing was ever said', () => {
    const onStall = vi.fn()
    createDelegatedStallWatch({ stallMs: 1_000, onStall })
    vi.advanceTimersByTime(999)
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onStall).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('activity restarts the window', () => {
    const onStall = vi.fn()
    const watch = createDelegatedStallWatch({ stallMs: 1_000, onStall })
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(900)
      watch.activity()
    }
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('never fires while a tool call is open, however long, and re-arms when the last one ends', () => {
    const onStall = vi.fn()
    const watch = createDelegatedStallWatch({ stallMs: 1_000, onStall })
    watch.toolStarted('a')
    watch.toolStarted('b')
    vi.advanceTimersByTime(60_000)
    watch.toolEnded('a')
    vi.advanceTimersByTime(60_000)
    expect(onStall).not.toHaveBeenCalled()
    watch.toolEnded('b')
    vi.advanceTimersByTime(999)
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('a tool call with no id is activity only, so it cannot pause the guard for good', () => {
    const onStall = vi.fn()
    const watch = createDelegatedStallWatch({ stallMs: 1_000, onStall })
    watch.toolStarted(undefined)
    vi.advanceTimersByTime(1_000)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('does nothing once disposed', () => {
    const onStall = vi.fn()
    const watch = createDelegatedStallWatch({ stallMs: 1_000, onStall })
    watch.dispose()
    watch.activity()
    vi.advanceTimersByTime(5_000)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('reads AI SDK parts: tool-call opens, its result, error or refusal closes, the rest is activity', () => {
    const calls: string[] = []
    const progress = {
      activity: () => calls.push('activity'),
      toolStarted: (id: string | null | undefined) => calls.push(`start:${id}`),
      toolEnded: (id: string | null | undefined) => calls.push(`end:${id}`),
    }
    for (const part of [
      { type: 'start-step' },
      { type: 'text-delta', text: 'x' },
      { type: 'tool-call', toolCallId: 't1' },
      { type: 'tool-result', toolCallId: 't1' },
      { type: 'tool-call', toolCallId: 't2' },
      { type: 'tool-error', toolCallId: 't2' },
      { type: 'tool-call', toolCallId: 't3' },
      { type: 'tool-output-denied', toolCallId: 't3' },
      { type: 'reasoning-delta', text: 'y' },
      null,
    ]) {
      reportDelegatedStreamPart(progress, part)
    }
    expect(calls).toEqual([
      'activity', 'activity', 'start:t1', 'end:t1', 'start:t2', 'end:t2', 'start:t3', 'end:t3', 'activity', 'activity',
    ])
  })

  it('a call the provider runs itself is activity only, so a result that never comes cannot switch the guard off', () => {
    let stalled = false
    const watch = createDelegatedStallWatch({ stallMs: 1_000, onStall: () => { stalled = true } })
    reportDelegatedStreamPart(watch, { type: 'tool-call', toolCallId: 'ws_1', providerExecuted: true })
    vi.advanceTimersByTime(1_001)
    expect(stalled).toBe(true)
    watch.dispose()
  })
})

describe('the delegated API loop stop condition (decision 3)', () => {
  const steps = (...toolCallsPerStep: number[]) =>
    toolCallsPerStep.map((count) => ({ toolCalls: Array.from({ length: count }, () => ({})) }))

  it('counts tool calls, not steps', () => {
    expect(countDelegatedToolCalls(steps(1, 3, 0))).toBe(4)
    expect(countDelegatedToolCalls([])).toBe(0)
  })

  it('never stops a run with no limit', () => {
    const stop = delegatedRunStopCondition(null)
    expect(stop({ steps: steps(...Array.from({ length: 500 }, () => 4)) } as any)).toBe(false)
  })

  it('stops at the end of the step whose calls reach the limit', () => {
    const stop = delegatedRunStopCondition(5)
    expect(stop({ steps: steps(2, 2) })).toBe(false)
    expect(stop({ steps: steps(2, 2, 3) })).toBe(true)
    expect(stop({ steps: steps(5) })).toBe(true)
  })
})
