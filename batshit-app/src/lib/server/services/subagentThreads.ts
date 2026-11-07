/**
 * SA-111 P2 (DL-111-04, DL-111-05, DL-111-06) — subagent thread control.
 *
 * Josh's decision #3: a subagent call starts a FRESH thread unless the calling agent asks
 * to RESUME the previous one, and a later fresh call RESETS (discards) the stored thread.
 * *"If an agent wants resume to be used, they shouldn't use fresh, because it's going to
 * erase the ability to resume later. That's fine."*
 *
 * Batshit stores a Subagent's exchanges itself under
 * `subagent_sessions:{sessionId}:subagent:{slug}`. `fresh` deletes that key.
 *
 * The lock exists because of F7: AI SDK v7 runs every tool call of a step through
 * `Promise.all`, so a primary agent can already call the SAME subagent twice at once. Both
 * calls would load → run → persist, and the last writer would silently erase the other
 * exchange. Parallel throwaway work is what Workers (P4) are for; a named specialist is one
 * thread, so same-subagent calls serialize instead.
 *
 * Everything here is Batshit-owned Redis state and belongs to the session, so both key
 * families are enumerated by `deleteSession` (FM: Session Key Cleanup).
 */

import { randomUUID } from 'crypto'
import { redis } from '$lib/server/redis'

export type SubagentThreadMode = 'fresh' | 'resume'

/** What actually happened, reported back to the calling agent (DL-111-04). */
export type SubagentThreadOutcome = 'fresh' | 'resumed' | 'resumed-empty'

export const SUBAGENT_THREAD_MODES: readonly SubagentThreadMode[] = ['fresh', 'resume']

/** Josh's decision #3: fresh unless the agent asks otherwise. */
export const DEFAULT_SUBAGENT_THREAD_MODE: SubagentThreadMode = 'fresh'

/**
 * Delegation limits (2026-10-24): a call has no time limit by default, so the lock cannot be
 * sized to one call any more (it was call timeout + 5 s, DL-111-05). It lives a short TTL that
 * the call holding it refreshes while it runs (a heartbeat). A holder that crashes stops
 * refreshing, so its lock is gone within one TTL instead of blocking the Subagent for hours.
 */
export const SUBAGENT_LOCK_TTL_MS = 30_000

/** How often the holder refreshes its lock: three chances per TTL before it could lapse. */
export const SUBAGENT_LOCK_HEARTBEAT_MS = 10_000

const LOCK_POLL_MIN_MS = 50
const LOCK_POLL_MAX_MS = 500

/**
 * Stored exchanges for a managed API/CLI subagent. Exported since SA-111 P1 so the DCM
 * roster reports `thread: none | resumable` from the same string the runner reads.
 */
export function buildSubagentThreadKey(sessionId: string, slug: string) {
  return `subagent_sessions:${sessionId}:subagent:${slug}`
}

/** In-flight marker for one `(session, subagent)` pair (DL-111-05). */
export function buildSubagentRunLockKey(sessionId: string, slug: string) {
  return `subagent_lock:${sessionId}:${slug}`
}

export function normalizeSubagentThreadMode(value: unknown): SubagentThreadMode {
  return value === 'resume' ? 'resume' : DEFAULT_SUBAGENT_THREAD_MODE
}

/**
 * Thrown when a same-subagent call could not take its turn within an explicit `waitBudgetMs`.
 * Callers turn this into a model-readable result rather than a bare failure, so the agent can
 * pick a different specialist or try again — never a silent overwrite of the other call's
 * thread.
 *
 * The runner passes no budget since the delegation limits (2026-10-24): a queued call waits
 * while the holder's heartbeat lives, which is exactly as long as the call ahead of it runs,
 * and the user's Stop ends the wait. A bounded caller (a test, a future one) still gets this.
 */
export class SubagentBusyError extends Error {
  readonly code = 'subagent_busy'

  constructor(subagentLabel: string, waitedMs: number) {
    super(
      `${subagentLabel} is already running in this chat and did not finish within ${Math.round(
        waitedMs / 1000
      )}s. Batshit runs one call per subagent at a time so their thread stays intact. Wait for the current call to finish, or call a different subagent.`
    )
    this.name = 'SubagentBusyError'
  }
}

export function isSubagentBusyError(error: unknown): error is SubagentBusyError {
  return error instanceof SubagentBusyError
}

/**
 * Thrown when a call ends because the Stop of the reply that made it (the run's own stop signal)
 * fired, before the call finished or while it queued for its turn. The Stop is the user's choice,
 * not a failure of the Subagent: `managed-execute` tells the two apart by this type, never by the
 * message (BL-643). A Subagent deleted mid-call is `SubagentDeletedError`, a different outcome.
 */
export class SubagentCallCancelledError extends Error {
  readonly code = 'subagent_call_cancelled'

  constructor(message = 'Managed Subagent call was cancelled.') {
    super(message)
    this.name = 'SubagentCallCancelledError'
  }
}

export function isSubagentCallCancelledError(error: unknown): error is SubagentCallCancelledError {
  return error instanceof SubagentCallCancelledError
}

export interface SubagentRunLockHandle {
  key: string
  token: string
  ttlMs: number
  /** How long this call queued behind another call to the same subagent. */
  waitedMs: number
  /**
   * Set when a heartbeat found the lock no longer ours (it lapsed and another call took it).
   * The thread commit checks the lock itself too.
   */
  lost: boolean
  /**
   * Aborts when `lost` is set. The runner stops the call on it, so two runs of one Subagent in
   * one chat never work at once in its one CLI profile folder.
   */
  lostSignal: AbortSignal
  /** Ends the heartbeat. `releaseSubagentRunLock` calls it; safe to call twice. */
  stopHeartbeat: () => void
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', finish)
      resolve()
    }
    abortSignal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Compare-and-refresh in ONE Redis round trip, for the same reason the release is one: a
 * separate GET then PEXPIRE could extend a lock that lapsed and was re-taken in between, which
 * would keep the OTHER call's lock alive on our clock.
 */
const REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

async function refreshSubagentRunLock(handle: SubagentRunLockHandle): Promise<boolean> {
  const refreshed = await redis.execute(async (client) =>
    client.eval(REFRESH_LOCK_SCRIPT, {
      keys: [handle.key],
      arguments: [handle.token, String(handle.ttlMs)],
    })
  )
  return Number(refreshed) === 1
}

function startSubagentRunLockHeartbeat(
  handle: SubagentRunLockHandle,
  heartbeatMs: number,
  onLost: () => void
): () => void {
  let stopped = false
  let inFlight = false
  const timer = setInterval(() => {
    if (stopped || inFlight) return
    inFlight = true
    refreshSubagentRunLock(handle)
      .then((stillOurs) => {
        if (stillOurs || stopped) return
        handle.lost = true
        stopped = true
        clearInterval(timer)
        console.warn(
          `[SubagentThreads] ${handle.key} lapsed while its call was still running; the call is stopped and will not save its thread over the newer one.`
        )
        onLost()
      })
      .catch((error) => {
        // A failed refresh is retried on the next beat; three misses in a row let the lock lapse,
        // and the thread commit then sees it is no longer ours.
        console.warn('[SubagentThreads] Failed to refresh subagent run lock:', error)
      })
      .finally(() => {
        inFlight = false
      })
  }, heartbeatMs)
  // A heartbeat must never keep a stopping process alive.
  ;(timer as { unref?: () => void }).unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Take the `(session, slug)` turn, waiting out an earlier call rather than racing it. The
 * returned handle keeps its lock alive with a heartbeat until `releaseSubagentRunLock`.
 *
 * A queued call waits while the holder's lock exists, which is as long as the holder runs (its
 * heartbeat keeps it) or one TTL past a holder that crashed. Its Stop ends the wait with
 * `SubagentCallCancelledError`. Only an explicit `waitBudgetMs` turns a long wait into
 * `SubagentBusyError`.
 */
export async function acquireSubagentRunLock(options: {
  sessionId: string
  slug: string
  subagentLabel: string
  /** Test seams: the lock's TTL and heartbeat. Production uses the constants above. */
  ttlMs?: number
  heartbeatMs?: number
  /**
   * Optional queue budget. Absent (the runner): wait while the holder lives. When given it must
   * be a non-negative number; `Math.floor(undefined)` is NaN and every `waitedMs >= NaN` is
   * false, so a malformed budget would queue forever, and it is refused instead.
   */
  waitBudgetMs?: number
  abortSignal?: AbortSignal
}): Promise<SubagentRunLockHandle> {
  const key = buildSubagentRunLockKey(options.sessionId, options.slug)
  const token = randomUUID()
  const ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? SUBAGENT_LOCK_TTL_MS))
  // A shorter test TTL gets a heartbeat that still beats three times per TTL.
  const heartbeatMs = Math.max(
    100,
    Math.floor(options.heartbeatMs ?? Math.min(SUBAGENT_LOCK_HEARTBEAT_MS, ttlMs / 3))
  )
  if (heartbeatMs >= ttlMs) {
    throw new Error('Subagent lock heartbeat must be shorter than its TTL.')
  }
  if (
    options.waitBudgetMs !== undefined &&
    (!Number.isFinite(options.waitBudgetMs) || options.waitBudgetMs < 0)
  ) {
    throw new Error('Subagent lock acquisition requires a resolved non-negative wait budget.')
  }
  const waitBudgetMs =
    options.waitBudgetMs === undefined ? null : Math.floor(options.waitBudgetMs)
  const startedAt = Date.now()
  let pollMs = LOCK_POLL_MIN_MS

  for (;;) {
    if (options.abortSignal?.aborted) {
      throw new SubagentCallCancelledError('Subagent call was cancelled while waiting for its turn.')
    }

    const acquired = await redis.execute(async (client) =>
      client.set(key, token, { NX: true, PX: ttlMs })
    )
    if (acquired) {
      const lostController = new AbortController()
      const handle: SubagentRunLockHandle = {
        key,
        token,
        ttlMs,
        waitedMs: Date.now() - startedAt,
        lost: false,
        lostSignal: lostController.signal,
        stopHeartbeat: () => {},
      }
      handle.stopHeartbeat = startSubagentRunLockHeartbeat(handle, heartbeatMs, () => lostController.abort())
      return handle
    }

    if (options.abortSignal?.aborted) {
      throw new SubagentCallCancelledError('Subagent call was cancelled while waiting for its turn.')
    }

    const waitedMs = Date.now() - startedAt
    if (waitBudgetMs !== null && waitedMs >= waitBudgetMs) {
      throw new SubagentBusyError(options.subagentLabel, waitedMs)
    }

    const pause = waitBudgetMs === null ? pollMs : Math.min(pollMs, waitBudgetMs - waitedMs)
    await sleep(pause, options.abortSignal)
    pollMs = Math.min(pollMs * 2, LOCK_POLL_MAX_MS)
  }
}

/**
 * Compare-and-delete in ONE Redis round trip. A separate GET then DEL has a real window:
 * the key can expire between the two calls and be re-acquired by the queued caller, and
 * our DEL would then remove THEIR lock — handing the thread to a third call while the
 * second is still running, which is exactly the F7 overwrite this lock exists to stop.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

/**
 * Give the turn back. Returns `false` when the lock was no longer ours — the run outlived
 * its own TTL and another call has already started, so our thread write would clobber
 * theirs. The caller reports that instead of persisting (DL-111-05).
 */
export async function releaseSubagentRunLock(
  // SA-111 P4: worker runs take no lock, so the shared `finally` releases `null`.
  handle: SubagentRunLockHandle | null
): Promise<boolean> {
  if (!handle) return false
  handle.stopHeartbeat()
  try {
    const deleted = await redis.execute(async (client) =>
      client.eval(RELEASE_LOCK_SCRIPT, {
        keys: [handle.key],
        arguments: [handle.token],
      })
    )
    return Number(deleted) === 1
  } catch (error) {
    console.warn('[SubagentThreads] Failed to release subagent run lock:', error)
    return false
  }
}

/**
 * Check whether we still hold the turn, without giving it up. Used right before persisting
 * a managed thread so a lock we already lost never overwrites the newer run's exchanges.
 */
export async function stillHoldsSubagentRunLock(
  handle: SubagentRunLockHandle
): Promise<boolean> {
  try {
    return await redis.execute(async (client) => {
      const current = await client.get(handle.key)
      return current === handle.token
    })
  } catch (error) {
    console.warn('[SubagentThreads] Failed to verify subagent run lock:', error)
    return false
  }
}

/**
 * Discard a managed subagent's stored exchanges. Runs BEFORE the call so an interrupted
 * `fresh` still leaves the thread genuinely reset rather than half-old.
 */
export async function resetManagedSubagentThread(sessionId: string, slug: string) {
  try {
    await redis.del(buildSubagentThreadKey(sessionId, slug))
  } catch (error) {
    console.warn('[SubagentThreads] Failed to reset subagent thread:', error)
  }
}
