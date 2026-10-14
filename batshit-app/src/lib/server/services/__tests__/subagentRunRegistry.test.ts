import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  SubagentDeleteRunRefusedError,
  beginSubagentRun,
  hasRunningSubagentRun,
  isSubagentDeletedError,
  stopSubagentRunsForDelete
} from '$lib/server/services/subagentRunRegistry'

/**
 * BL-287 (2026-09-27): the registry a Subagent's delete stops its runs through. A run counts as
 * running until its call has ended AND the work it tracked (a CLI still shutting down after a
 * Stop) has settled, because that CLI can still write into the Subagent's profile folder.
 */

useRedisTestServer()

const USER = 'user-subagent-run-registry'

async function seed(id: string) {
  await redis.json.set(`subagent:${id}`, '$', { id, user_id: USER })
}

describe('subagentRunRegistry (BL-287)', () => {
  it('a run of a Subagent whose record is gone is refused, and leaves nothing registered', async () => {
    const refused = await beginSubagentRun({ userId: USER, subagentId: 'zc_gone', label: 'Gone' }).catch((e) => e)

    expect(isSubagentDeletedError(refused)).toBe(true)
    expect(refused.message).toBe('Gone was deleted, so it does not run any more.')
    expect(hasRunningSubagentRun(USER, 'zc_gone')).toBe(false)
  })

  it('a run stays registered until its call ended AND its tracked work settled', async () => {
    await seed('zc_track')
    const handle = await beginSubagentRun({ userId: USER, subagentId: 'zc_track', label: 'Track' })
    let exit!: () => void
    handle.track(new Promise<void>((resolve) => (exit = resolve)))

    handle.end()
    handle.end()
    expect(hasRunningSubagentRun(USER, 'zc_track')).toBe(true)
    exit()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hasRunningSubagentRun(USER, 'zc_track')).toBe(false)
    await redis.del('subagent:zc_track')
  })

  it('does not retain a generic execution error as an unverified cleanup', async () => {
    await seed('zc_execution_error')
    const handle = await beginSubagentRun({ userId: USER, subagentId: 'zc_execution_error', label: 'Failed work' })
    handle.track(Promise.reject(new Error('model request failed')))
    handle.end()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hasRunningSubagentRun(USER, 'zc_execution_error')).toBe(false)
    await redis.del('subagent:zc_execution_error')
  })

  it('retains a failed cleanup, refuses delete, then retries and releases only after verification', async () => {
    await seed('zc_cleanup_retry')
    const handle = await beginSubagentRun({ userId: USER, subagentId: 'zc_cleanup_retry', label: 'Retry' })
    let attempts = 0
    handle.track(Promise.reject(new Error('inspection uncertain')), {
      retry: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('still uncertain')
      }
    })
    handle.end()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hasRunningSubagentRun(USER, 'zc_cleanup_retry')).toBe(true)

    const first = await stopSubagentRunsForDelete(USER, 'zc_cleanup_retry', { timeoutMs: 200, pollMs: 10 }).catch((e) => e)
    expect(first).toBeInstanceOf(SubagentDeleteRunRefusedError)
    expect(first.code).toBe('subagent_run_cleanup_unverified')
    expect(await redis.exists('subagent:zc_cleanup_retry')).toBe(true)

    const second = await stopSubagentRunsForDelete(USER, 'zc_cleanup_retry', { timeoutMs: 200, pollMs: 10 })
    expect(second.stopped).toBe(1)
    expect(attempts).toBe(2)
    expect(hasRunningSubagentRun(USER, 'zc_cleanup_retry')).toBe(false)
    second.release()
    await redis.del('subagent:zc_cleanup_retry')
  })

  it('does not retry a cleanup failure first discovered during the current delete', async () => {
    await seed('zc_cleanup_new_failure')
    const handle = await beginSubagentRun({ userId: USER, subagentId: 'zc_cleanup_new_failure', label: 'New failure' })
    let fail!: (error: Error) => void
    let retries = 0
    handle.track(new Promise<void>((_resolve, reject) => { fail = reject }), {
      retry: async () => { retries += 1 }
    })
    handle.end()
    handle.signal.addEventListener('abort', () => fail(new Error('cleanup uncertain')))

    const first = await stopSubagentRunsForDelete(USER, 'zc_cleanup_new_failure', { timeoutMs: 200, pollMs: 10 }).catch((e) => e)
    expect(first.code).toBe('subagent_run_cleanup_unverified')
    expect(retries).toBe(0)
    expect(hasRunningSubagentRun(USER, 'zc_cleanup_new_failure')).toBe(true)

    const second = await stopSubagentRunsForDelete(USER, 'zc_cleanup_new_failure', { timeoutMs: 200, pollMs: 10 })
    expect(retries).toBe(1)
    expect(second.stopped).toBe(1)
    second.release()
    await redis.del('subagent:zc_cleanup_new_failure')
  })

  it('a delete stops only that user’s Subagent, and refuses past its bound with the mark taken off', async () => {
    await seed('zc_stuck')
    const stuck = await beginSubagentRun({ userId: USER, subagentId: 'zc_stuck', label: 'Stuck' })
    const otherUser = await beginSubagentRun({ userId: 'someone-else', subagentId: 'zc_stuck', label: 'Stuck' })

    const refused = await stopSubagentRunsForDelete(USER, 'zc_stuck', { timeoutMs: 120, pollMs: 20 }).catch((e) => e)

    expect(refused).toBeInstanceOf(SubagentDeleteRunRefusedError)
    expect(refused.code).toBe('subagent_run_still_stopping')
    expect(stuck.stoppedForDelete()).toBe(true)
    expect(otherUser.signal.aborted).toBe(false)
    // The mark is off again: a later run may start, and a retry is not "already being deleted".
    stuck.end()
    const again = await stopSubagentRunsForDelete(USER, 'zc_stuck')
    expect(again.stopped).toBe(0)
    again.release()
    otherUser.end()
    await redis.del('subagent:zc_stuck')
  })
})
