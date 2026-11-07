// @vitest-environment node
/**
 * SA-139 (D10): the Claude plan run lifecycle is armed once at server start: the boot sweep of a
 * crashed Batshit's leftover run folders runs, and the shutdown task waits for running replies,
 * closes run admission, ends every run and awaits its exit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const tasks = vi.hoisted(() => new Map<string, (reason: string) => Promise<void>>())
vi.mock('$lib/server/services/runtimeShutdown', () => ({
  registerRuntimeShutdownTask: vi.fn((name: string, task: (reason: string) => Promise<void>) => {
    tasks.set(name, task)
    return () => tasks.delete(name)
  })
}))
const turns = vi.hoisted(() => ({ waited: [] as number[] }))
vi.mock('$lib/server/services/turnOutcomeRegistry', () => ({
  TURN_SHUTDOWN_WAIT_MS: 30_000,
  waitForRunningTurns: vi.fn(async (ms: number) => { turns.waited.push(ms); return true })
}))
const sweep = vi.hoisted(() => vi.fn(async () => ({ removed: ['/tmp/bcp-AAAAAA'], killed: [4321], kept: [] })))
vi.mock('$lib/server/services/claudePlanRun', () => ({ sweepStaleClaudePlanRunFolders: sweep }))

import {
  armClaudePlanRunLifecycle, closeClaudePlanRunAdmission, closeClaudePlanRunAdmissionForShutdown, registerClaudePlanRun, resetClaudePlanRunRegistryForTests
} from '../claudePlanRunRegistry'

afterEach(() => {
  resetClaudePlanRunRegistryForTests()
  tasks.clear()
  turns.waited.length = 0
  sweep.mockClear()
  vi.restoreAllMocks()
})

/** A live run: it settles only once something stops it. */
function fakeRun() {
  let settle!: (value: 'exited') => void
  const run = {
    owner: { userId: 'u', sessionId: 's', agentId: 'a', kind: 'primary' as const },
    settled: new Promise<'exited' | 'unknown'>(resolve => { settle = resolve }),
    exited: new Promise<void>(() => {}),
    isEnded: false,
    stop: vi.fn(() => { run.isEnded = true; settle('exited') })
  }
  return run
}

describe('armClaudePlanRunLifecycle', () => {
  it('runs the boot sweep once and registers one shutdown task', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    armClaudePlanRunLifecycle()
    armClaudePlanRunLifecycle()
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.stringContaining('removed 1 leftover run folder(s) and ended 1 leftover Claude Code run(s)')))
    expect(sweep).toHaveBeenCalledTimes(1)
    expect([...tasks.keys()]).toEqual(['claude-plan-runs'])
  })

  it('at shutdown admits no new run at once, waits for running replies, then ends every run', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    armClaudePlanRunLifecycle()
    const live = fakeRun()
    registerClaudePlanRun(live as any)
    const { waitForRunningTurns } = await import('$lib/server/services/turnOutcomeRegistry')
    let admittedDuringWait = true
    vi.mocked(waitForRunningTurns).mockImplementationOnce(async (ms: number) => {
      turns.waited.push(ms)
      try { registerClaudePlanRun(fakeRun() as any) } catch { admittedDuringWait = false }
      return true
    })
    await tasks.get('claude-plan-runs')!('test')
    expect(admittedDuringWait).toBe(false)
    expect(turns.waited).toEqual([30_000])
    expect(live.stop).toHaveBeenCalledTimes(1)
    expect(() => registerClaudePlanRun(fakeRun() as any)).toThrow(/shutting down/)
  })

  it('a restore that reopens admission never reopens it during shutdown, in either order', () => {
    const reopen = closeClaudePlanRunAdmission('A backup restore is running.')
    closeClaudePlanRunAdmissionForShutdown()
    reopen()
    expect(() => registerClaudePlanRun(fakeRun() as any)).toThrow(/shutting down/)
    resetClaudePlanRunRegistryForTests()
    closeClaudePlanRunAdmissionForShutdown()
    closeClaudePlanRunAdmission('A backup restore is running.')()
    expect(() => registerClaudePlanRun(fakeRun() as any)).toThrow(/shutting down/)
  })

  it('two owners that close admission each reopen only their own close', () => {
    const reopenRestore = closeClaudePlanRunAdmission('A backup restore is running.')
    const reopenOther = closeClaudePlanRunAdmission('Another owner.')
    reopenRestore()
    expect(() => registerClaudePlanRun(fakeRun() as any)).toThrow(/Another owner/)
    reopenOther()
    expect(() => registerClaudePlanRun(fakeRun() as any)).not.toThrow()
  })

  it('a filter field that is an empty string matches exactly, never every run', async () => {
    const { endClaudePlanRuns } = await import('../claudePlanRunRegistry')
    const run = fakeRun()
    registerClaudePlanRun(run as any)
    expect(await endClaudePlanRuns({ sessionId: '' }, 'none')).toEqual({ ended: 0, unsettled: 0 })
    expect(run.stop).not.toHaveBeenCalled()
  })

  it('a failed boot sweep is logged, never thrown into startup', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    sweep.mockRejectedValueOnce(new Error('disk gone'))
    expect(() => armClaudePlanRunLifecycle()).not.toThrow()
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('leftover-run sweep failed'), expect.any(Error)))
  })
})
