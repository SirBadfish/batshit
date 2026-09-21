import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TURN_OUTCOME_MAX_SETTLED,
  TURN_OUTCOME_RETENTION_MS,
  __resetTurnOutcomesForTests,
  hasTurnOutcome,
  inspectTurnOutcomes,
  openTurnOutcome,
  settleTurnOutcome,
  waitForRunningTurns,
  watchTurnOutcome,
  type TurnOutcome
} from '../turnOutcomeRegistry'

/**
 * The final answer of a send answered early (2026-09-18). The tab that sent reads it over the
 * live hub (`{scope: 'turn', turnId}`), and a subscription added AFTER the turn ended must still
 * get it, or a hub that reconnected mid-reply would leave the tab waiting forever.
 */

const OWNER = { userId: 'user-1' }
const DONE: TurnOutcome = { status: 200, contentType: 'application/json', body: '{"success":true}' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-18T12:00:00Z'))
})

afterEach(() => {
  __resetTurnOutcomesForTests()
  vi.useRealTimers()
})

describe('turn outcome registry', () => {
  it('opens a fresh id per turn that a new process could never hand out again', () => {
    const first = openTurnOutcome(OWNER)
    const second = openTurnOutcome(OWNER)
    expect(first).not.toBe(second)
    expect(first).toMatch(/^turn_[a-f0-9]{32}$/)
  })

  it('hands a running turn’s answer to its watchers once, when it ends', () => {
    const turnId = openTurnOutcome(OWNER)
    const seen: TurnOutcome[] = []
    expect(watchTurnOutcome(turnId, 'user-1', (outcome) => seen.push(outcome))).toBeTypeOf('function')
    expect(seen).toEqual([])

    expect(settleTurnOutcome(turnId, DONE)).toBe(true)
    expect(seen).toEqual([DONE])

    // A second settle is a bug somewhere else; the first answer stands and nobody hears twice.
    expect(settleTurnOutcome(turnId, { ...DONE, status: 500 })).toBe(false)
    expect(seen).toEqual([DONE])
  })

  it('hands an ended turn’s answer at once to a watcher that comes late (a hub that reconnected)', () => {
    const turnId = openTurnOutcome(OWNER)
    settleTurnOutcome(turnId, DONE)
    const seen: TurnOutcome[] = []
    watchTurnOutcome(turnId, 'user-1', (outcome) => seen.push(outcome))
    expect(seen).toEqual([DONE])
  })

  it('knows nothing of another user’s turn, or of an id it never opened', () => {
    const turnId = openTurnOutcome(OWNER)
    expect(hasTurnOutcome(turnId, 'user-2')).toBe(false)
    expect(watchTurnOutcome(turnId, 'user-2', () => {})).toBeNull()
    expect(hasTurnOutcome('turn_nope', 'user-1')).toBe(false)
    expect(watchTurnOutcome('turn_nope', 'user-1', () => {})).toBeNull()
    expect(hasTurnOutcome(turnId, 'user-1')).toBe(true)
  })

  it('stops handing the answer to a watcher that let go', () => {
    const turnId = openTurnOutcome(OWNER)
    const seen: TurnOutcome[] = []
    const stop = watchTurnOutcome(turnId, 'user-1', (outcome) => seen.push(outcome))!
    expect(inspectTurnOutcomes().watchers).toBe(1)
    stop()
    expect(inspectTurnOutcomes().watchers).toBe(0)
    settleTurnOutcome(turnId, DONE)
    expect(seen).toEqual([])
  })

  it('a watcher that throws does not keep the answer from the others', () => {
    const turnId = openTurnOutcome(OWNER)
    const seen: TurnOutcome[] = []
    watchTurnOutcome(turnId, 'user-1', () => {
      throw new Error('a closed stream')
    })
    watchTurnOutcome(turnId, 'user-1', (outcome) => seen.push(outcome))
    settleTurnOutcome(turnId, DONE)
    expect(seen).toEqual([DONE])
  })

  it('keeps an ended turn’s answer for the retention window, then forgets it', () => {
    const turnId = openTurnOutcome(OWNER)
    settleTurnOutcome(turnId, DONE)
    vi.advanceTimersByTime(TURN_OUTCOME_RETENTION_MS - 1000)
    openTurnOutcome(OWNER)
    expect(hasTurnOutcome(turnId, 'user-1')).toBe(true)

    vi.advanceTimersByTime(2000)
    openTurnOutcome(OWNER)
    expect(hasTurnOutcome(turnId, 'user-1')).toBe(false)
  })

  it('never forgets a turn that is still running, however long it runs', () => {
    const turnId = openTurnOutcome(OWNER)
    vi.advanceTimersByTime(TURN_OUTCOME_RETENTION_MS * 3)
    const other = openTurnOutcome(OWNER)
    settleTurnOutcome(other, DONE)
    expect(hasTurnOutcome(turnId, 'user-1')).toBe(true)
  })

  it('past its size cap forgets the OLDEST ended answers first, never a running turn', () => {
    const running = openTurnOutcome(OWNER)
    const ended: string[] = []
    for (let index = 0; index < TURN_OUTCOME_MAX_SETTLED + 2; index += 1) {
      vi.advanceTimersByTime(10)
      const turnId = openTurnOutcome(OWNER)
      settleTurnOutcome(turnId, DONE)
      ended.push(turnId)
    }
    expect(inspectTurnOutcomes()).toEqual({ running: 1, settled: TURN_OUTCOME_MAX_SETTLED, watchers: 0 })
    expect(hasTurnOutcome(ended[0], 'user-1')).toBe(false)
    expect(hasTurnOutcome(ended[1], 'user-1')).toBe(false)
    expect(hasTurnOutcome(ended[2], 'user-1')).toBe(true)
    expect(hasTurnOutcome(running, 'user-1')).toBe(true)
  })

  it('shutdown waits for running turns: at once when none run, when the last one ends, or until its bound', async () => {
    await expect(waitForRunningTurns(1000)).resolves.toBe(true)

    const first = openTurnOutcome(OWNER)
    const second = openTurnOutcome(OWNER)
    let idle: boolean | null = null
    void waitForRunningTurns(30_000).then((value) => {
      idle = value
    })
    settleTurnOutcome(first, DONE)
    await Promise.resolve()
    expect(idle).toBeNull()
    settleTurnOutcome(second, DONE)
    await Promise.resolve()
    expect(idle).toBe(true)

    openTurnOutcome(OWNER)
    const bounded = waitForRunningTurns(30_000)
    vi.advanceTimersByTime(30_000)
    await expect(bounded).resolves.toBe(false)
  })
})
