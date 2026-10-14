/**
 * BL-287 (2026-09-27): deleting a Subagent stops its delegated runs first, the way a Stop stops
 * them, and waits until each has ended before anything of it is deleted.
 *
 * Before, the delete removed the Subagent's managed CLI profile folder (BL-157) while its CLI
 * could still be running, and the CLI wrote into that folder again (Codex's logs and sessions),
 * so the folder the delete had just removed came back with the deleted Subagent's prompts in it.
 *
 * A Subagent's own run (never a Worker's: a Worker runs in its own slot folder, BL-285) is
 * registered here for as long as it runs, including its CLI's shutdown after a Stop:
 *
 * 1. The runner calls `beginSubagentRun` before anything else of the run happens. It refuses a
 *    Subagent that is being deleted, and one whose record is already gone (a turn that loaded
 *    the Subagent before its delete and calls it after), with `SubagentDeletedError`.
 * 2. The runner combines the handle's `signal` with its own stop signal, hands the lane's work
 *    to `track` (the lane keeps working after a Stop until its CLI has exited, beyond the
 *    moment the call itself gives up), and calls `end` when the call is done. What it tracks
 *    is `settleSubagentRunWork` (`subagentRunSettle.ts`): the lane's work, then verified cleanup
 *    of its CLI processes. An unverified cleanup at 25 s keeps the run registered for a retry;
 *    non-Codex CLI children retain their 15 s kill grace.
 * 3. The delete calls `stopSubagentRunsForDelete`: the Subagent is marked (no new run starts),
 *    every registered run is stopped through its signal with the reason `subagent_deleted`, and
 *    the delete waits until each has ended. Past 30 s it refuses (409) with nothing deleted and
 *    the mark taken off, so a retry waits for the same run again. A failed cleanup also refuses
 *    with a specific reason and retains the run. The mark stays until the delete calls
 *    `release`, after the record is gone.
 *
 * Only this Subagent's runs are touched: the parent's reply, other Subagents, and Workers run on.
 * The registry is in-process, like every other run registry: each Batshit process runs its own
 * Subagents against its own Redis.
 */

import { redis } from '$lib/server/redis'

export const SUBAGENT_DELETED_ABORT_REASON = 'subagent_deleted'
export const SUBAGENT_DELETE_RUN_STOP_MS = 30_000
export const SUBAGENT_DELETE_RUN_POLL_MS = 100

/** A run refused, or stopped, because its Subagent was deleted. */
export class SubagentDeletedError extends Error {
  readonly code = 'subagent_deleted'

  constructor(label: string) {
    super(`${label} was deleted, so it does not run any more.`)
    this.name = 'SubagentDeletedError'
  }
}

export function isSubagentDeletedError(error: unknown): error is SubagentDeletedError {
  return error instanceof SubagentDeletedError
}

export type SubagentDeleteRunRefusalCode =
  | 'subagent_delete_in_progress'
  | 'subagent_run_still_stopping'
  | 'subagent_run_cleanup_unverified'

const REFUSALS: Record<SubagentDeleteRunRefusalCode, string> = {
  subagent_delete_in_progress: 'This Subagent is already being deleted.',
  subagent_run_still_stopping:
    'This Subagent is still running and did not stop within 30 seconds, so nothing was deleted. Try again in a moment.',
  subagent_run_cleanup_unverified:
    'Batshit could not confirm this Subagent\'s command processes exited. Nothing was deleted. Try deleting it again, or quit and restart Batshit if cleanup still cannot be verified.'
}

/** The delete did not run: nothing was deleted, and the route answers 409 with the reason. */
export class SubagentDeleteRunRefusedError extends Error {
  readonly code: SubagentDeleteRunRefusalCode
  readonly status = 409

  constructor(code: SubagentDeleteRunRefusalCode, label?: string) {
    super(label && code === 'subagent_run_cleanup_unverified' ? `${label}: ${REFUSALS[code]}` : REFUSALS[code])
    this.name = 'SubagentDeleteRunRefusedError'
    this.code = code
  }
}

type TrackedFailure = { retry: () => Promise<unknown>; error: unknown; retrying: boolean }
type RunEntry = {
  controller: AbortController
  ended: Promise<void>
  failures: Set<TrackedFailure>
  pending: number
  callEnded: boolean
  label: string
  finishIfSettled: () => void
}

const runs = new Map<string, Set<RunEntry>>()
const deleting = new Set<string>()

function runKey(userId: string, subagentId: string) {
  return `${userId}\u0000${subagentId}`
}

export interface SubagentRunHandle {
  /** Aborted, with `SUBAGENT_DELETED_ABORT_REASON`, when the Subagent's delete stops this run. */
  readonly signal: AbortSignal
  /** Work that keeps running after the call gave up (a CLI shutting down): the run ends after it. */
  track(work: Promise<unknown>, options?: { retry?: () => Promise<unknown> }): void
  /** The call is done. The run ends here, or when the last tracked work settles. */
  end(): void
  /** Whether this run was stopped because its Subagent is being deleted. */
  stoppedForDelete(): boolean
}

/**
 * Register a Subagent's own run. Throws `SubagentDeletedError` when the Subagent is being
 * deleted or its record is gone; the registration comes first, so a delete that starts while
 * the record is read still sees, and stops, this run.
 */
export async function beginSubagentRun(options: {
  userId: string
  subagentId: string
  label: string
}): Promise<SubagentRunHandle> {
  const key = runKey(options.userId, options.subagentId)
  if (deleting.has(key)) throw new SubagentDeletedError(options.label)

  const controller = new AbortController()
  let finish!: () => void
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  const entry: RunEntry = {
    controller, ended, failures: new Set(), pending: 1, callEnded: false,
    label: options.label, finishIfSettled: () => {}
  }
  const entries = runs.get(key) ?? new Set<RunEntry>()
  entries.add(entry)
  runs.set(key, entries)

  const finishIfSettled = () => {
    if (entry.pending > 0 || entry.failures.size > 0) return
    entries.delete(entry)
    if (entries.size === 0 && runs.get(key) === entries) runs.delete(key)
    finish()
  }
  entry.finishIfSettled = finishIfSettled
  const handle: SubagentRunHandle = {
    signal: controller.signal,
    track(work, options) {
      entry.pending += 1
      void work.then(
        () => {
          entry.pending -= 1
          finishIfSettled()
        },
        (error) => {
          if (options?.retry) entry.failures.add({ retry: options.retry, error, retrying: false })
          entry.pending -= 1
          finishIfSettled()
        }
      )
    },
    end() {
      if (entry.callEnded) return
      entry.callEnded = true
      entry.pending -= 1
      finishIfSettled()
    },
    stoppedForDelete() {
      return controller.signal.aborted && controller.signal.reason === SUBAGENT_DELETED_ABORT_REASON
    }
  }

  let exists: boolean
  try {
    exists = Boolean(await redis.exists(`subagent:${options.subagentId}`))
  } catch (error) {
    handle.end()
    throw error
  }
  if (!exists || controller.signal.aborted) {
    handle.end()
    throw new SubagentDeletedError(options.label)
  }
  return handle
}

/** Whether a run of this Subagent is registered (running, or its CLI still shutting down). */
export function hasRunningSubagentRun(userId: string, subagentId: string): boolean {
  return (runs.get(runKey(userId, subagentId))?.size ?? 0) > 0
}

/**
 * The Subagent delete's first step: mark the Subagent, stop its runs, and wait until each has
 * ended. Call `release` once the delete is done, whether it succeeded or not.
 */
export async function stopSubagentRunsForDelete(
  userId: string,
  subagentId: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<{ stopped: number; waitedMs: number; release: () => void }> {
  const key = runKey(userId, subagentId)
  if (deleting.has(key)) throw new SubagentDeleteRunRefusedError('subagent_delete_in_progress')
  deleting.add(key)
  const release = () => {
    deleting.delete(key)
  }

  const startedAt = Date.now()
  const running = [...(runs.get(key) ?? [])]
  for (const entry of running) entry.controller.abort(SUBAGENT_DELETED_ABORT_REASON)

  // Only retry failures that predated this delete. A cleanup that fails while this delete is
  // waiting remains visible and requires a fresh, explicit delete attempt.
  const retrying = new Set<TrackedFailure>()
  for (const entry of running) {
    for (const failure of [...entry.failures]) {
      retrying.add(failure)
      failure.retrying = true
      void Promise.resolve().then(failure.retry).then(
        () => {
          entry.failures.delete(failure)
          failure.retrying = false
          entry.finishIfSettled()
        },
        (error) => { failure.error = error; failure.retrying = false }
      )
    }
  }

  const timeoutMs = options.timeoutMs ?? SUBAGENT_DELETE_RUN_STOP_MS
  const pollMs = options.pollMs ?? SUBAGENT_DELETE_RUN_POLL_MS
  while (hasRunningSubagentRun(userId, subagentId)) {
    const failedEntry = [...(runs.get(key) ?? [])].find((entry) =>
      [...entry.failures].some((failure) => !failure.retrying && !retrying.has(failure)) ||
      [...entry.failures].some((failure) => retrying.has(failure) && !failure.retrying)
    )
    if (failedEntry) {
      release()
      throw new SubagentDeleteRunRefusedError('subagent_run_cleanup_unverified', failedEntry.label)
    }
    if (Date.now() - startedAt >= timeoutMs) {
      release()
      const uncertain = [...(runs.get(key) ?? [])].find((entry) => entry.failures.size > 0)
      if (uncertain) throw new SubagentDeleteRunRefusedError('subagent_run_cleanup_unverified', uncertain.label)
      throw new SubagentDeleteRunRefusedError('subagent_run_still_stopping')
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return { stopped: running.length, waitedMs: Date.now() - startedAt, release }
}
