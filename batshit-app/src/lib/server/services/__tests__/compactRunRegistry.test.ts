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
   * the Compact then wrote. A Stop whose Compact has not registered leaves a short pending stop,
   * and that Compact's run starts already stopped.
   */
  it('a Stop whose Compact has not registered stops that Compact\'s run, once, within the window', () => {
    vi.useFakeTimers()
    expect(stopCompactRuns('chat-1', 'stopped', 'compact-a')).toBe(0)
    const late = startCompactRun('chat-1', 'compact-a')
    expect(late.signal.aborted).toBe(true)
    expect(late.signal.reason).toBe('stopped')
    // Used up: the run after it starts clean, and another chat never saw it.
    expect(startCompactRun('chat-1', 'compact-a').signal.aborted).toBe(false)
    expect(startCompactRun('chat-2', 'compact-a').signal.aborted).toBe(false)
  })

  /** BL-795: a pending stop was the chat's, so another tab's Compact of the chat met it. */
  it('a pending stop belongs to its Compact, never to another Compact of the same chat (BL-795)', () => {
    vi.useFakeTimers()
    expect(stopCompactRuns('chat-1', 'stopped', 'compact-a')).toBe(0)
    expect(startCompactRun('chat-1', 'compact-b').signal.aborted).toBe(false)
    expect(startCompactRun('chat-1').signal.aborted).toBe(false)
    expect(startCompactRun('chat-1', 'compact-a').signal.aborted).toBe(true)
  })

  it('a Stop while another tab\'s Compact runs stops it, and still waits for its own (BL-795)', () => {
    vi.useFakeTimers()
    const tabB = startCompactRun('chat-1', 'compact-b')
    expect(stopCompactRuns('chat-1', 'stopped', 'compact-a')).toBe(1)
    expect(tabB.signal.aborted).toBe(true)
    expect(startCompactRun('chat-1', 'compact-a').signal.aborted).toBe(true)
  })

  it('a Stop that names no Compact leaves nothing pending', () => {
    expect(stopCompactRuns('chat-1')).toBe(0)
    expect(__countPendingCompactStopsForTests()).toBe(0)
    expect(startCompactRun('chat-1').signal.aborted).toBe(false)
  })

  it('a pending stop lapses after its window', () => {
    vi.useFakeTimers()
    expect(stopCompactRuns('chat-1', 'stopped', 'compact-a')).toBe(0)
    vi.advanceTimersByTime(COMPACT_PENDING_STOP_MS + 1)
    expect(startCompactRun('chat-1', 'compact-a').signal.aborted).toBe(false)
  })

  it('expired pending stops are pruned when the next Stop comes, so the map stays bounded', () => {
    vi.useFakeTimers()
    for (const chat of ['chat-1', 'chat-2', 'chat-3']) expect(stopCompactRuns(chat, 'stopped', 'compact-a')).toBe(0)
    expect(__countPendingCompactStopsForTests()).toBe(3)
    vi.advanceTimersByTime(COMPACT_PENDING_STOP_MS + 1)
    expect(stopCompactRuns('chat-4', 'stopped', 'compact-a')).toBe(0)
    expect(__countPendingCompactStopsForTests()).toBe(1)
  })

  it('a Stop that found its Compact running leaves nothing pending', () => {
    startCompactRun('chat-1', 'compact-a')
    expect(stopCompactRuns('chat-1', 'stopped', 'compact-a')).toBe(1)
    expect(__countPendingCompactStopsForTests()).toBe(0)
    expect(startCompactRun('chat-1', 'compact-a').signal.aborted).toBe(false)
  })
})
