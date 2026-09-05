/**
 * SA-111 P2 (DL-111-04, DL-111-05, DL-111-06) — subagent thread control.
 *
 * Josh's decision #3: a subagent call starts a FRESH thread unless the calling agent asks
 * to RESUME the previous one, and a later fresh call RESETS (discards) the stored thread.
 * *"If an agent wants resume to be used, they shouldn't use fresh, because it's going to
 * erase the ability to resume later. That's fine."*
 *
 * Two storage shapes, because two owners:
 * - **Managed API/CLI subagents** — Batshit stores the exchanges itself under
 *   `subagent_sessions:{sessionId}:subagent:{slug}`. `fresh` deletes that key.
 * - **n8n Workflow Subagents** — n8n owns the memory (its Redis Chat Memory node), so the
 *   only lever Batshit has is the KEY. Batshit issues a thread id, stores it under
 *   `subagent_thread:{sessionId}:{slug}`, and ships it in the webhook payload; the official
 *   templates append it to their session key. `fresh` mints a new id, which orphans the old
 *   n8n list to its own 7-day TTL.
 *
 * The lock exists because of F7: AI SDK v7 runs every tool call of a step through
 * `Promise.all`, so a primary agent can already call the SAME subagent twice at once. Both
 * calls would load → run → persist, and the last writer would silently erase the other
 * exchange. Parallel throwaway work is what Workers (P4) are for; a named specialist is one
 * thread, so same-subagent calls serialize instead.
 *
 * Everything here is Batshit-owned Redis state and belongs to the session, so all three key
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

/** DL-111-05: TTL = call timeout + 5 s, so a lock can never outlive one call. */
const LOCK_TTL_GRACE_MS = 5_000

/** A queued caller waits out the holder's whole TTL before giving up. */
const LOCK_WAIT_GRACE_MS = 2_000

const LOCK_POLL_MIN_MS = 50
const LOCK_POLL_MAX_MS = 500

/**
 * n8n's Redis Chat Memory gets a 7-day `sessionTTL` in the official templates. Batshit's
 * thread id ages on the same clock so the two sides do not drift into a stored id that
 * points at memory n8n already expired.
 */
export const N8N_SUBAGENT_THREAD_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Stored exchanges for a managed API/CLI subagent. Exported since SA-111 P1 so the DCM
 * roster reports `thread: none | resumable` from the same string the runner reads.
 */
export function buildSubagentThreadKey(sessionId: string, slug: string) {
  return `subagent_sessions:${sessionId}:subagent:${slug}`
}

/**
 * The Batshit-issued thread id for an n8n Workflow Subagent (DL-111-06). Batshit never
 * stores the n8n conversation itself — only the id that names it.
 */
export function buildSubagentN8nThreadIdKey(sessionId: string, slug: string) {
  return `subagent_thread:${sessionId}:${slug}`
}

/** In-flight marker for one `(session, subagent)` pair (DL-111-05). */
export function buildSubagentRunLockKey(sessionId: string, slug: string) {
  return `subagent_lock:${sessionId}:${slug}`
}

/**
 * The key whose existence answers "does this subagent have a thread to resume in this
 * chat?" — the `thread: none | resumable` fact on its DCM roster line.
 *
 * Two owners, two keys, and picking the wrong one is a confidently-wrong roster fact the
 * primary would act on: reading the managed exchange key for an n8n Workflow Subagent
 * reports `none` whenever n8n runs on its own Redis, even though a resumable thread exists.
 */
export function buildSubagentThreadStateKey(
  sessionId: string,
  slug: string,
  subagentType: string
) {
  return subagentType === 'n8n-workflow'
    ? buildSubagentN8nThreadIdKey(sessionId, slug)
    : buildSubagentThreadKey(sessionId, slug)
}

export function normalizeSubagentThreadMode(value: unknown): SubagentThreadMode {
  return value === 'resume' ? 'resume' : DEFAULT_SUBAGENT_THREAD_MODE
}

/**
 * Thrown when a same-subagent call could not take its turn. Callers turn this into a
 * model-readable result rather than a bare failure, so the agent can pick a different
 * specialist or try again — never a silent overwrite of the other call's thread.
 *
 * This is the safety valve, not the common path. A lock cannot outlive its own TTL and the
 * waiter's budget is that TTL plus grace, so with equal budgets the queued call always gets
 * its turn. It fires when the budgets are ASYMMETRIC — a queued CLI-bridge call (its own
 * `timeoutMs`, 120 s by default) behind an API-lane holder sized by the longer documented
 * default — or when a third caller repeatedly takes the freed lock first.
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

export function resolveSubagentLockTtlMs(callTimeoutMs: number): number {
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
    throw new Error('Subagent lock TTL requires a resolved positive call timeout.')
  }
  return Math.floor(callTimeoutMs) + LOCK_TTL_GRACE_MS
}

export interface SubagentRunLockHandle {
  key: string
  token: string
  ttlMs: number
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
 * Take the `(session, slug)` turn, waiting out an earlier call rather than racing it.
 * Throws `SubagentBusyError` when the holder outlives its own TTL — an explicit result the
 * model can read, never a quiet second run over the same thread.
 */
export async function acquireSubagentRunLock(options: {
  sessionId: string
  slug: string
  subagentLabel: string
  ttlMs: number
  abortSignal?: AbortSignal
}): Promise<SubagentRunLockHandle> {
  const key = buildSubagentRunLockKey(options.sessionId, options.slug)
  const token = randomUUID()
  const ttlMs = Math.max(1_000, Math.floor(options.ttlMs))
  const waitBudgetMs = ttlMs + LOCK_WAIT_GRACE_MS
  const startedAt = Date.now()
  let pollMs = LOCK_POLL_MIN_MS

  for (;;) {
    const acquired = await redis.execute(async (client) =>
      client.set(key, token, { NX: true, PX: ttlMs })
    )
    if (acquired) {
      return { key, token, ttlMs }
    }

    if (options.abortSignal?.aborted) {
      throw new Error('Subagent call was cancelled while waiting for its turn.')
    }

    const waitedMs = Date.now() - startedAt
    if (waitedMs >= waitBudgetMs) {
      throw new SubagentBusyError(options.subagentLabel, waitedMs)
    }

    await sleep(Math.min(pollMs, waitBudgetMs - waitedMs), options.abortSignal)
    pollMs = Math.min(pollMs * 2, LOCK_POLL_MAX_MS)
  }
}

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
  try {
    return await redis.execute(async (client) => {
      const current = await client.get(handle.key)
      if (current !== handle.token) return false
      await client.del(handle.key)
      return true
    })
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

export interface N8nSubagentThreadSelection {
  threadId: string
  outcome: SubagentThreadOutcome
}

/**
 * Pick the thread id an n8n Workflow Subagent call runs under, and store it.
 *
 * `fresh` always mints a new id — the previous n8n conversation is orphaned to its own
 * `sessionTTL`, which is exactly Josh's "fresh resets" rule expressed through the only
 * lever Batshit has over n8n-owned memory. `resume` reuses the stored id, and honestly
 * reports `resumed-empty` when there was nothing to resume.
 */
export async function selectN8nSubagentThreadId(options: {
  sessionId: string
  slug: string
  mode: SubagentThreadMode
}): Promise<N8nSubagentThreadSelection> {
  const key = buildSubagentN8nThreadIdKey(options.sessionId, options.slug)

  if (options.mode === 'resume') {
    let existing: string | null = null
    try {
      const stored = await redis.get(key)
      existing = typeof stored === 'string' && stored.trim().length > 0 ? stored.trim() : null
    } catch (error) {
      console.warn('[SubagentThreads] Failed to read n8n subagent thread id:', error)
    }
    if (existing) {
      await touchN8nSubagentThreadId(key)
      return { threadId: existing, outcome: 'resumed' }
    }
    const threadId = randomUUID()
    await writeN8nSubagentThreadId(key, threadId)
    return { threadId, outcome: 'resumed-empty' }
  }

  const threadId = randomUUID()
  await writeN8nSubagentThreadId(key, threadId)
  return { threadId, outcome: 'fresh' }
}

async function writeN8nSubagentThreadId(key: string, threadId: string) {
  try {
    await redis.set(key, threadId)
    await redis.expire(key, N8N_SUBAGENT_THREAD_TTL_SECONDS)
  } catch (error) {
    console.warn('[SubagentThreads] Failed to store n8n subagent thread id:', error)
  }
}

async function touchN8nSubagentThreadId(key: string) {
  try {
    await redis.expire(key, N8N_SUBAGENT_THREAD_TTL_SECONDS)
  } catch (error) {
    console.warn('[SubagentThreads] Failed to refresh n8n subagent thread id TTL:', error)
  }
}
