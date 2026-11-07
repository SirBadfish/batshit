import { describe, expect, it } from 'vitest'
import { createCompactRuns } from './compactRuns.svelte'

/**
 * BL-781: one Compact flag for the whole page made chat B's composer busy (an enabled Stop, the
 * Token Panel's "Compacting...") while chat A compacted, and a Stop in B stopped A. The flag was
 * also false during the confirm dialog, so a second Compact could start and the two cleared the
 * one flag early.
 */
describe('each chat\'s Compact on its own (BL-781)', () => {
  it('a Compact in chat A makes only chat A busy, with its own status', () => {
    const runs = createCompactRuns()
    expect(runs.begin('chat-a')).toMatch(/^compact_[0-9a-f]{32}$/)
    runs.enterPhase('chat-a', 'Calculating compact plan...')
    expect(runs.isBusy('chat-a')).toBe(true)
    expect(runs.statusOf('chat-a')).toBe('Calculating compact plan...')
    expect(runs.isBusy('chat-b')).toBe(false)
    expect(runs.statusOf('chat-b')).toBeNull()
    expect(runs.isBusy(null)).toBe(false)
  })

  it('a Stop in chat B does not reach chat A\'s Compact', () => {
    const runs = createCompactRuns()
    runs.begin('chat-a')
    runs.enterPhase('chat-a', 'Generating compact summary...')
    expect(runs.requestStop('chat-b')).toBe(false)
    expect(runs.stopRequested('chat-a')).toBe(false)
    expect(runs.requestStop('chat-a')).toBe(true)
    expect(runs.stopRequested('chat-a')).toBe(true)
  })

  it('one Compact per chat, the confirm dialog included; another chat may run its own', () => {
    const runs = createCompactRuns()
    expect(runs.begin('chat-a')).toMatch(/^compact_[0-9a-f]{32}$/)
    runs.enterPhase('chat-a', 'Calculating compact plan...')
    runs.leavePhase('chat-a')
    // The confirm dialog: no request runs, the chat is not busy, and its Compact still runs.
    expect(runs.isBusy('chat-a')).toBe(false)
    expect(runs.begin('chat-a')).toBeNull()
    expect(runs.begin('chat-b')).toMatch(/^compact_/)
    runs.enterPhase('chat-b', 'Calculating compact plan...')
    runs.end('chat-a')
    expect(runs.isBusy('chat-b')).toBe(true)
    expect(runs.begin('chat-a')).toMatch(/^compact_[0-9a-f]{32}$/)
  })

  it('a Stop during the plan is remembered after the plan ends, until the Compact ends (BL-653)', () => {
    const runs = createCompactRuns()
    runs.begin('chat-a')
    runs.enterPhase('chat-a', 'Calculating compact plan...')
    expect(runs.requestStop('chat-a')).toBe(true)
    runs.leavePhase('chat-a')
    expect(runs.stopRequested('chat-a')).toBe(true)
    // No request runs now: the Stop route has nothing to end, the Compact still knows.
    expect(runs.requestStop('chat-a')).toBe(false)
    runs.end('chat-a')
    runs.begin('chat-a')
    expect(runs.stopRequested('chat-a')).toBe(false)
  })

  it('the end of a Compact clears its busy state on every path', () => {
    const runs = createCompactRuns()
    runs.begin('chat-a')
    runs.enterPhase('chat-a', 'Generating compact summary...')
    runs.end('chat-a')
    expect(runs.isBusy('chat-a')).toBe(false)
    expect(runs.statusOf('chat-a')).toBeNull()
    // A phase of a Compact that has ended draws nothing.
    runs.enterPhase('chat-a', 'Generating compact summary...')
    expect(runs.isBusy('chat-a')).toBe(false)
  })
})
