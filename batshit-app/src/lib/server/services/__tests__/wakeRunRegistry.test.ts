import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RUNNING_WOKEN_TURNS,
  MAX_WAKES_PER_AGENT_PER_HOUR,
  MAX_WAKES_PER_INSTANCE_PER_HOUR
} from '$lib/utils/dmControl'
import {
  __resetWakeRunRegistryForTests,
  abortWakeRun,
  checkWakeCaps,
  clearWakeRun,
  findWakeRunForAgent,
  getWakeAbortSignal,
  hasActiveWakeRun,
  listWakeRuns,
  registerWakeRun,
  releaseWakeSlot,
  reserveWakeSlot
} from '$lib/server/services/wakeRunRegistry'
import { buildSessionOrigin } from '$lib/utils/sessionOrigin'

/**
 * SA-113 P1 (DL-113-12) — every cap branch. These numbers are the zombie rules: a wake-up
 * that cannot pass one of them degrades to `wait` with a readable reason.
 */

const origin = buildSessionOrigin({ kind: 'dm', label: 'Cooper', chainDepth: 1 })

function start(sessionId: string, agentId: string) {
  const timer = setTimeout(() => {}, 60_000)
  registerWakeRun({
    sessionId,
    agentId,
    userId: 'u1',
    origin,
    startedAt: Date.now(),
    controller: new AbortController(),
    timer
  })
}

afterEach(() => {
  __resetWakeRunRegistryForTests()
  vi.useRealTimers()
})

describe('checkWakeCaps', () => {
  it('allows a wake-up when nothing is running and nothing is spent', () => {
    expect(checkWakeCaps('agent-a')).toBeNull()
  })

  it('refuses a second running turn for the SAME agent', () => {
    start('s1', 'agent-a')
    const refusal = checkWakeCaps('agent-a')
    expect(refusal?.code).toBe('wake_running_limit_agent')
    expect(refusal?.reason).toContain('already has a woken turn running')
  })

  it('still allows a different agent while one is running', () => {
    start('s1', 'agent-a')
    expect(checkWakeCaps('agent-b')).toBeNull()
  })

  it(`refuses once ${MAX_RUNNING_WOKEN_TURNS} turns are running instance-wide`, () => {
    for (let i = 0; i < MAX_RUNNING_WOKEN_TURNS; i += 1) start(`s${i}`, `agent-${i}`)
    const refusal = checkWakeCaps('agent-new')
    expect(refusal?.code).toBe('wake_running_limit_instance')
  })

  it('refuses the per-agent hourly budget after enough starts', () => {
    for (let i = 0; i < MAX_WAKES_PER_AGENT_PER_HOUR; i += 1) {
      start(`s${i}`, 'agent-a')
      clearWakeRun(`s${i}`, 'completed')
    }
    const refusal = checkWakeCaps('agent-a')
    expect(refusal?.code).toBe('wake_rate_limit_agent')
    expect(refusal?.reason).toContain(String(MAX_WAKES_PER_AGENT_PER_HOUR))
  })

  it('refuses the instance hourly budget across different agents', () => {
    for (let i = 0; i < MAX_WAKES_PER_INSTANCE_PER_HOUR; i += 1) {
      start(`s${i}`, `agent-${i}`)
      clearWakeRun(`s${i}`, 'completed')
    }
    const refusal = checkWakeCaps('agent-fresh')
    expect(refusal?.code).toBe('wake_rate_limit_instance')
  })

  it('forgets starts older than an hour, so the budget rolls rather than latching', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T10:00:00.000Z'))
    for (let i = 0; i < MAX_WAKES_PER_AGENT_PER_HOUR; i += 1) {
      start(`s${i}`, 'agent-a')
      clearWakeRun(`s${i}`, 'completed')
    }
    expect(checkWakeCaps('agent-a')?.code).toBe('wake_rate_limit_agent')

    vi.setSystemTime(new Date('2026-09-07T11:00:01.000Z'))
    expect(checkWakeCaps('agent-a')).toBeNull()
  })
})

describe('registry lookups', () => {
  it('reports an active woken turn for a session (AMD-113-01 gate)', () => {
    expect(hasActiveWakeRun('s1')).toBe(false)
    start('s1', 'agent-a')
    expect(hasActiveWakeRun('s1')).toBe(true)
    expect(listWakeRuns()).toHaveLength(1)
    expect(findWakeRunForAgent('agent-a')?.sessionId).toBe('s1')
    expect(findWakeRunForAgent('agent-b')).toBeNull()
  })
})

describe('clearWakeRun', () => {
  it('is idempotent, so completion and the timeout cannot both report', () => {
    start('s1', 'agent-a')
    expect(clearWakeRun('s1', 'completed')?.endReason).toBe('completed')
    expect(clearWakeRun('s1', 'timed_out')).toBeNull()
  })

  it('cancels the hard-stop timer when the turn ends normally', () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const timer = setTimeout(fired, 1000)
    registerWakeRun({
      sessionId: 's1',
      agentId: 'agent-a',
      userId: 'u1',
      origin,
      startedAt: Date.now(),
      controller: new AbortController(),
      timer
    })
    clearWakeRun('s1', 'completed')
    vi.advanceTimersByTime(5000)
    expect(fired).not.toHaveBeenCalled()
  })
})

describe('abortWakeRun (AMD-113-02)', () => {
  it('aborts the woken turn’s own request and the signal send-routed listens on', () => {
    const controller = new AbortController()
    const timer = setTimeout(() => {}, 60_000)
    registerWakeRun({
      sessionId: 's1',
      agentId: 'agent-a',
      userId: 'u1',
      origin,
      startedAt: Date.now(),
      controller,
      timer
    })
    expect(controller.signal.aborted).toBe(false)
    expect(abortWakeRun('s1', 'stopped')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    clearTimeout(timer)
  })

  it('is a harmless no-op for a session with no woken turn', () => {
    expect(abortWakeRun('not-a-wake', 'stopped')).toBe(false)
  })
})

describe('getWakeAbortSignal (AMD-113-02)', () => {
  it('hands send-routed the same signal the interrupt route aborts', () => {
    const controller = new AbortController()
    const timer = setTimeout(() => {}, 60_000)
    registerWakeRun({
      sessionId: 's1',
      agentId: 'agent-a',
      userId: 'u1',
      origin,
      startedAt: Date.now(),
      controller,
      timer
    })

    const signal = getWakeAbortSignal('s1')
    expect(signal).toBe(controller.signal)

    // Aborting through the registry is what a Stop does; the run sees it directly, which
    // is the whole point: during setup there is no stream controller to abort, and the
    // P1 live run measured that a client-side fetch abort does not reach send-routed.
    let seen = false
    signal!.addEventListener('abort', () => {
      seen = true
    })
    abortWakeRun('s1', 'stopped')
    expect(seen).toBe(true)

    clearTimeout(timer)
  })

  it('returns null for an ordinary browser turn, so nothing extra is wired', () => {
    expect(getWakeAbortSignal('not-a-wake')).toBeNull()
  })
})

describe('F-P1-3: reservations', () => {
  it('holds the running slot synchronously, so a second caller in the same tick is refused', () => {
    const first = reserveWakeSlot('agent-a')
    expect(first).toMatchObject({ ok: true })

    const second = reserveWakeSlot('agent-a')
    expect(second).toMatchObject({ ok: false, code: 'wake_running_limit_agent' })
  })

  it('counts a reservation toward the instance running cap too', () => {
    for (let index = 0; index < MAX_RUNNING_WOKEN_TURNS; index += 1) {
      expect(reserveWakeSlot(`agent-${index}`)).toMatchObject({ ok: true })
    }
    expect(reserveWakeSlot('agent-late')).toMatchObject({
      ok: false,
      code: 'wake_running_limit_instance'
    })
  })

  it('counts a reservation toward the hourly budget', () => {
    // Fill the hour for one agent, minus one, then hold the last slot.
    for (let index = 0; index < MAX_WAKES_PER_AGENT_PER_HOUR - 1; index += 1) {
      start(`s${index}`, 'agent-a')
      clearWakeRun(`s${index}`, 'completed')
    }
    expect(reserveWakeSlot('agent-a')).toMatchObject({ ok: true })
    // The held slot is the sixth of six, so nothing else fits this hour.
    expect(checkWakeCaps('agent-a')).toMatchObject({ code: 'wake_running_limit_agent' })
  })

  it('gives the slot back on release', () => {
    const first = reserveWakeSlot('agent-a')
    if (!first.ok) throw new Error('expected a reservation')
    releaseWakeSlot(first.reservationId)
    expect(reserveWakeSlot('agent-a')).toMatchObject({ ok: true })
  })

  it('is safe to release twice, or to release nothing at all', () => {
    const first = reserveWakeSlot('agent-a')
    if (!first.ok) throw new Error('expected a reservation')
    releaseWakeSlot(first.reservationId)
    releaseWakeSlot(first.reservationId)
    releaseWakeSlot(null)
    releaseWakeSlot(undefined)
    expect(checkWakeCaps('agent-a')).toBeNull()
  })

  it('consumes the reservation when the run registers, so the slot is not double-counted', () => {
    const reservation = reserveWakeSlot('agent-a')
    if (!reservation.ok) throw new Error('expected a reservation')
    const timer = setTimeout(() => {}, 60_000)
    registerWakeRun(
      {
        sessionId: 's1',
        agentId: 'agent-a',
        userId: 'u1',
        origin,
        startedAt: Date.now(),
        controller: new AbortController(),
        timer
      },
      reservation.reservationId
    )

    // One running turn, not one running turn plus a stranded reservation.
    expect(listWakeRuns()).toHaveLength(1)
    clearWakeRun('s1', 'completed')
    expect(checkWakeCaps('agent-a')).toBeNull()
  })
})

describe('F-P1-5: the abort reason says who ended the turn', () => {
  it('uses `wake_timeout` for the hard time limit and `wake_stop` for a Stop', () => {
    start('s-timeout', 'agent-a')
    abortWakeRun('s-timeout', 'timed_out')
    expect(getWakeAbortSignal('s-timeout')?.reason).toBe('wake_timeout')

    start('s-stop', 'agent-b')
    abortWakeRun('s-stop', 'stopped')
    expect(getWakeAbortSignal('s-stop')?.reason).toBe('wake_stop')
  })
})
