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
 * (BL-653 review). So a Stop that finds no run leaves a PENDING stop for its chat, and the next run
 * of that chat within `COMPACT_PENDING_STOP_MS` starts already stopped (and uses it up). The plan
 * (`previewOnly`) registers too, so a stale pending stop is used up by the next plan, which never
 * reads its signal, instead of stopping a later summary. In-process like the runs; no Redis key.
 * Batshit is one app process per instance, so an in-process map reaches every Compact.
 */

export type CompactRun = {
  /** The Compact's stop: aborted by a Stop for its chat. */
  signal: AbortSignal
  /** Take this run out of the registry. Idempotent. */
  end: () => void
}

const runsByChat = new Map<string, Set<AbortController>>()

/** How long a Stop that found no run waits for its Compact to register. */
export const COMPACT_PENDING_STOP_MS = 5_000
const pendingStopByChat = new Map<string, number>()

/** Register a Compact that is starting in this chat. The caller must `end()` it on every path. */
export function startCompactRun(sessionId: string): CompactRun {
  const controller = new AbortController()
  const pendingAt = pendingStopByChat.get(sessionId)
  if (pendingAt !== undefined) {
    pendingStopByChat.delete(sessionId)
    if (Date.now() - pendingAt <= COMPACT_PENDING_STOP_MS) controller.abort('stopped')
  }
  const runs = runsByChat.get(sessionId) ?? new Set<AbortController>()
  runs.add(controller)
  runsByChat.set(sessionId, runs)
  return {
    signal: controller.signal,
    end: () => {
      const current = runsByChat.get(sessionId)
      if (!current) return
      current.delete(controller)
      if (current.size === 0) runsByChat.delete(sessionId)
    }
  }
}

/**
 * Stop every Compact running in this chat (two tabs can each start one). Answers how many. When
 * none runs, the Stop stays pending for the chat's next run (see above).
 */
export function stopCompactRuns(sessionId: string, reason = 'stopped'): number {
  const runs = runsByChat.get(sessionId)
  if (!runs) {
    const now = Date.now()
    // Keep the map bounded: a pending stop nobody used lapses with its window.
    for (const [chat, at] of pendingStopByChat) {
      if (now - at > COMPACT_PENDING_STOP_MS) pendingStopByChat.delete(chat)
    }
    pendingStopByChat.set(sessionId, now)
    return 0
  }
  for (const controller of runs) controller.abort(reason)
  return runs.size
}

/** How many Compacts run in this chat now. */
export function countCompactRuns(sessionId: string): number {
  return runsByChat.get(sessionId)?.size ?? 0
}

/** Test-only: how many chats hold a pending stop. */
export function __countPendingCompactStopsForTests(): number {
  return pendingStopByChat.size
}

/** Test-only hard reset. */
export function __resetCompactRunRegistryForTests(): void {
  for (const runs of runsByChat.values()) for (const controller of runs) controller.abort('reset')
  runsByChat.clear()
  pendingStopByChat.clear()
}
