/**
 * BL-622 (rules C6 and C7 of `Plans/2026-09-27-bl622-a-compact-yields-to-a-turn.md`): the Compacts
 * running in this process, by chat, so a Stop can end one.
 *
 * A Compact's request cannot be ended by its own request: SvelteKit aborts `request.signal` only
 * when the connection closes before the body is fully read, and the Compact route reads its body
 * first (the SSE deep dive measured the same for send-routed). So each running Compact registers
 * here with its own AbortController, its summary call listens to that signal, and ONE Stop route
 * (`POST /api/messages/compact/stop`) ends the chat's Compact through `stopCompactRuns`. A closed
 * tab cannot be seen at all: the summary call's limit bounds it (`SUMMARY_CALL_LIMIT_MS` in
 * `summaryGeneration.ts`), and the Compact's look before its write refuses a write beside a turn.
 *
 * Every entry leaves when its Compact ends, on every path: the route ends its run in a `finally`.
 *
 * A Stop can reach the server before its Compact registered (the route registers only after it has
 * read its body and checked the chat's owner): it found no run and the Compact went on and wrote
 * (BL-653 review). So a Stop whose own Compact has not registered leaves a PENDING stop, and that
 * Compact's run starts already stopped within `COMPACT_PENDING_STOP_MS` (and uses it up). The plan
 * (`previewOnly`) registers too, so a stale pending stop is used up by the next plan, which never
 * reads its signal, instead of stopping a later summary. In-process like the runs; no Redis key.
 * Batshit is one app process per instance, so an in-process map reaches every Compact.
 *
 * BL-795: a pending stop belongs to the Compact the Stop was pressed for (the page's `compactId`,
 * the same for its plan and its summary), never to the chat: a pending stop per chat stopped
 * another tab's Compact of the same chat that nobody stopped. A Stop of a RUNNING Compact still
 * stops every Compact of the chat (two tabs can each run one), as before.
 */

export type CompactRun = {
  /** The Compact's stop: aborted by a Stop for its chat. */
  signal: AbortSignal
  /** Take this run out of the registry. Idempotent. */
  end: () => void
}

type RegisteredRun = { controller: AbortController; compactId: string | null }
const runsByChat = new Map<string, Set<RegisteredRun>>()

/** How long a Stop whose Compact has not registered waits for it. */
export const COMPACT_PENDING_STOP_MS = 5_000
/** Pending stops by chat and Compact (`pendingStopKey`). */
const pendingStops = new Map<string, number>()

const pendingStopKey = (sessionId: string, compactId: string) => `${sessionId}\u0000${compactId}`

/**
 * Register a Compact that is starting in this chat. `compactId` names the page's Compact (its plan
 * and its summary share it); a Compact without one cannot be stopped before it registers. The
 * caller must `end()` it on every path.
 */
export function startCompactRun(sessionId: string, compactId: string | null = null): CompactRun {
  const controller = new AbortController()
  if (compactId) {
    const key = pendingStopKey(sessionId, compactId)
    const pendingAt = pendingStops.get(key)
    if (pendingAt !== undefined) {
      pendingStops.delete(key)
      if (Date.now() - pendingAt <= COMPACT_PENDING_STOP_MS) controller.abort('stopped')
    }
  }
  const run: RegisteredRun = { controller, compactId }
  const runs = runsByChat.get(sessionId) ?? new Set<RegisteredRun>()
  runs.add(run)
  runsByChat.set(sessionId, runs)
  return {
    signal: controller.signal,
    end: () => {
      const current = runsByChat.get(sessionId)
      if (!current) return
      current.delete(run)
      if (current.size === 0) runsByChat.delete(sessionId)
    }
  }
}

/**
 * Stop every Compact running in this chat (two tabs can each start one). Answers how many. When
 * the Compact the Stop was pressed for (`compactId`) has not registered, the Stop stays pending
 * for that Compact only (see above).
 */
export function stopCompactRuns(
  sessionId: string,
  reason = 'stopped',
  compactId: string | null = null
): number {
  const runs = runsByChat.get(sessionId)
  if (compactId && ![...(runs ?? [])].some((run) => run.compactId === compactId)) {
    const now = Date.now()
    // Keep the map bounded: a pending stop nobody used lapses with its window.
    for (const [key, at] of pendingStops) {
      if (now - at > COMPACT_PENDING_STOP_MS) pendingStops.delete(key)
    }
    pendingStops.set(pendingStopKey(sessionId, compactId), now)
  }
  if (!runs) return 0
  for (const run of runs) run.controller.abort(reason)
  return runs.size
}

/** How many Compacts run in this chat now. */
export function countCompactRuns(sessionId: string): number {
  return runsByChat.get(sessionId)?.size ?? 0
}

/** Test-only: how many pending stops are held. */
export function __countPendingCompactStopsForTests(): number {
  return pendingStops.size
}

/** Test-only hard reset. */
export function __resetCompactRunRegistryForTests(): void {
  for (const runs of runsByChat.values()) for (const run of runs) run.controller.abort('reset')
  runsByChat.clear()
  pendingStops.clear()
}
