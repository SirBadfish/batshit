import { realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * BL-7 — one Codex START at a time per Batshit-managed Codex home.
 *
 * Every managed Codex run points `CODEX_HOME` at its agent's home under
 * `~/.batshit/agents/<profile>/.codex`, and Codex does unguarded one-time setup there when it
 * starts: it runs its SQLite migrations (state, goals, logs) and, on codex-cli 0.139.0,
 * reinstalls its bundled skills by deleting a folder and writing it again. Codex serializes
 * that only for its socket transport; Batshit uses stdio. Two runs of one agent that start
 * together (the agent in two chats, the compact worker beside a turn) therefore race: measured
 * live on a fresh home, four turns started at once and three Codex processes exited with
 * `failed to initialize sqlite state runtime … duplicate column name` / `table … already
 * exists`, so three replies were errors. The same happens on the first start after a Codex
 * update that adds a migration.
 *
 * The gate holds a home from just before the spawn until Codex has finished starting (the
 * app server answered `initialize`, or the exec lane printed its first line) or the process
 * is gone. Only the START is serialized; the turns themselves still run side by side, and a
 * run with no other start in flight never waits. A hold is bounded (`holdLimitMs`), so a
 * start that never answers cannot block the next one forever. It is in-process: two Batshit
 * processes sharing one home (the Mac app beside a dev lane) are not serialized by it.
 *
 * A Stop reaches a start that is still WAITING (BL-7 review): with the run's `signal`, the
 * wait ends at once with an `AbortError` and gives up its place, so the start behind it waits
 * only for the one ahead of it. A Stop that lands after the turn was handed over is the
 * caller's to check before it spawns, and a Stop of a start already under way is the lane's
 * (the hold then ends when the process is gone).
 */

export const CODEX_HOME_START_HOLD_LIMIT_MS = 15_000

const tails = new Map<string, Promise<void>>()

export type ReleaseCodexHomeStart = () => void

const CODEX_HOME_START_STOPPED = 'CODEX_HOME_START_STOPPED'

/** The error a start stopped at the gate ends with; `isStopError` reads it as a Stop. */
export function createCodexHomeStartStoppedError(signal?: AbortSignal | null): Error {
  const error = new Error(
    'The Codex start was stopped while it waited for another start in the same agent home.',
    signal?.reason === undefined ? undefined : { cause: signal.reason }
  )
  error.name = 'AbortError'
  ;(error as Error & { code?: string }).code = CODEX_HOME_START_STOPPED
  return error
}

/** True for exactly the error above: a start the Stop ended before any Codex process existed. */
export function isCodexHomeStartStopped(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === CODEX_HOME_START_STOPPED
}

export async function acquireCodexHomeStart(
  codexHome: string,
  options: { holdLimitMs?: number; signal?: AbortSignal | null } = {}
): Promise<ReleaseCodexHomeStart> {
  const { signal } = options
  // A start whose Stop came first never joins the queue.
  if (signal?.aborted) throw createCodexHomeStartStoppedError(signal)

  // Resolved before anything else: joining the queue stays synchronous, so starts still get
  // their turns in the order they asked.
  const key = canonicalCodexHomeKey(codexHome)
  const previous = tails.get(key) ?? Promise.resolve()

  let releaseHold: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve
  })
  const tail = previous.then(() => held)
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })

  if (signal) {
    let onStop: () => void = () => {}
    const stopped = new Promise<'stopped'>((resolve) => {
      onStop = () => resolve('stopped')
      signal.addEventListener('abort', onStop, { once: true })
    })
    const outcome = await Promise.race([previous.then(() => 'turn' as const), stopped])
    signal.removeEventListener('abort', onStop)
    if (outcome === 'stopped') {
      // Give up this place: the start behind this one now waits only for the one ahead.
      releaseHold()
      throw createCodexHomeStartStoppedError(signal)
    }
  } else {
    await previous
  }

  // Releasing twice is harmless: the hold is a promise, and it resolves once.
  const release = () => {
    clearTimeout(limit)
    releaseHold()
  }
  const limit = setTimeout(release, options.holdLimitMs ?? CODEX_HOME_START_HOLD_LIMIT_MS)
  limit.unref?.()
  return release
}

/**
 * BL-156: one key per folder on disk. `path.resolve` left a symlink on the way in place, so a
 * home reached by two spellings (a linked HOME, `/tmp` against `/private/tmp`) was two homes and
 * its starts ran at once. The key is the real path, every symlink followed; a home not made yet
 * is its nearest existing folder's real path plus the rest, which is where it will be. Only a
 * missing folder is walked past; any other error is the caller's (the run cannot start there).
 * Synchronous on purpose (a few `lstat`s under the agents folder), so the queue keeps its order.
 */
export function canonicalCodexHomeKey(codexHome: string): string {
  const resolved = path.resolve(codexHome)
  const rest: string[] = []
  let head = resolved
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...rest)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = path.dirname(head)
      if (parent === head) return resolved
      rest.unshift(path.basename(head))
      head = parent
    }
  }
}

/** Test seam: how many homes currently have a start held or queued. */
export function countCodexHomeStartsInFlight(): number {
  return tails.size
}
