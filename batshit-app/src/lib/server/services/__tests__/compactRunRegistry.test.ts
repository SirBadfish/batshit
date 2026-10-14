import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPACT_PENDING_STOP_MS,
  __countPendingCompactStopsForTests,
  __resetCompactRunRegistryForTests,
  countCompactRuns,
  startCompactRun,
  stopCompactRuns
} from '../compactRunRegistry'

/** BL-622 (C6, C7): the Compacts running per chat, so one Stop route can end a chat's Compact. */
describe('compactRunRegistry', () => {
  afterEach(() => {
    __resetCompactRunRegistryForTests()
    vi.useRealTimers()
  })

  it('a Stop ends every Compact of its chat and none of another chat', () => {
    const first = startCompactRun('chat-1')
    const second = startCompactRun('chat-1')
    const elsewhere = startCompactRun('chat-2')

    expect(stopCompactRuns('chat-1')).toBe(2)

    expect(first.signal.aborted).toBe(true)
    expect(first.signal.reason).toBe('stopped')
    expect(second.signal.aborted).toBe(true)
    expect(elsewhere.signal.aborted).toBe(false)
    expect(stopCompactRuns('chat-9')).toBe(0)
  })

  it('an ended run leaves the registry, and the chat leaves with its last run', () => {
    const first = startCompactRun('chat-1')
    const second = startCompactRun('chat-1')
    expect(countCompactRuns('chat-1')).toBe(2)

    first.end()
    first.end()
    expect(countCompactRuns('chat-1')).toBe(1)
    second.end()
    expect(countCompactRuns('chat-1')).toBe(0)

    // Nothing is left to stop, and a later run starts clean.
    expect(countCompactRuns('chat-1')).toBe(0)
    expect(startCompactRun('chat-1').signal.aborted).toBe(false)
  })

  /**
   * BL-653 (review): the Compact route registers its run only after it has read the body and
   * checked the chat's owner, so a Stop pressed in those milliseconds found no run (stopped 0) and
   * the Compact then wrote. A Stop that finds no run leaves a short pending stop for its chat, and
   * the next run of that chat starts already stopped.
   */
  it('a Stop that finds no run stops the next run of its chat, once, within the window', () => {
    vi.useFakeTimers()
    expect(stopCompactRuns('chat-1')).toBe(0)
    const late = startCompactRun('chat-1')
    expect(late.signal.aborted).toBe(true)
    expect(late.signal.reason).toBe('stopped')
    // Used up: the run after it starts clean, and another chat never saw it.
    expect(startCompactRun('chat-1').signal.aborted).toBe(false)
    expect(startCompactRun('chat-2').signal.aborted).toBe(false)
  })

  it('a pending stop lapses after its window', () => {
    vi.useFakeTimers()
    expect(stopCompactRuns('chat-1')).toBe(0)
    vi.advanceTimersByTime(COMPACT_PENDING_STOP_MS + 1)
    expect(startCompactRun('chat-1').signal.aborted).toBe(false)
  })

  it('expired pending stops are pruned when the next Stop comes, so the map stays bounded', () => {
    vi.useFakeTimers()
    for (const chat of ['chat-1', 'chat-2', 'chat-3']) expect(stopCompactRuns(chat)).toBe(0)
    expect(__countPendingCompactStopsForTests()).toBe(3)
    vi.advanceTimersByTime(COMPACT_PENDING_STOP_MS + 1)
    expect(stopCompactRuns('chat-4')).toBe(0)
    expect(__countPendingCompactStopsForTests()).toBe(1)
  })

  it('a Stop that found a run leaves nothing pending', () => {
    startCompactRun('chat-1')
    expect(stopCompactRuns('chat-1')).toBe(1)
    expect(startCompactRun('chat-1').signal.aborted).toBe(false)
  })
})
