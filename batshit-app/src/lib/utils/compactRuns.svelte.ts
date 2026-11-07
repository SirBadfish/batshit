import { newCompactId } from './compactRunId'

/**
 * BL-781: each chat's Compact, on its own.
 *
 * The page held ONE Compact flag (`compactBusy`) and one tracked chat for the whole page, so while
 * chat A compacted, chat B's composer showed an enabled Stop, its Token Panel said "Compacting...",
 * and a Stop pressed in B stopped A's Compact. The flag was also false while the Compact's confirm
 * dialog was open, so a second Compact could start, and two overlapping Compacts cleared the one
 * flag and the tracked chat early.
 *
 * Now each chat has its own Compact from `begin` to `end` (the confirm dialog included), and one
 * chat can run only one at a time. Its requests (the plan, then the summary) are its busy phases:
 * the chat's composer and Token Panel read `isBusy` and `statusOf` for the chat on screen, and
 * the chat's Stop ends that chat's Compact.
 *
 * BL-653 (kept): a Stop during the plan is remembered for that Compact (the plan request never
 * reads its run's stop), so no summary request starts after it; `begin` starts each Compact clean.
 *
 * BL-795: each Compact has its own id (`compactRunId.ts`), which its requests and its Stop carry.
 */
export type CompactRuns = {
  /** A Compact starts in this chat: its id. Null (and nothing changes) while one already runs there. */
  begin: (sessionId: string) => string | null
  /** The id of this chat's running Compact. */
  compactIdOf: (sessionId: string) => string | null
  /** This chat's Compact is over, on every path. */
  end: (sessionId: string) => void
  /** A request of this chat's Compact starts; the chat shows `status` and is busy until it ends. */
  enterPhase: (sessionId: string, status: string) => void
  /** That request ended. */
  leavePhase: (sessionId: string) => void
  /** Stop pressed in this chat: remembered; true when a request runs there for the Stop route to end. */
  requestStop: (sessionId: string) => boolean
  /** A Stop was pressed during this chat's Compact. */
  stopRequested: (sessionId: string) => boolean
  /** A request of this chat's Compact runs (reactive). */
  isBusy: (sessionId: string | null | undefined) => boolean
  /** What this chat's Compact is doing, while a request runs (reactive). */
  statusOf: (sessionId: string | null | undefined) => string | null
}

export function createCompactRuns(): CompactRuns {
  /** Chat to status, while one of its Compact's requests runs. */
  let phases = $state<Record<string, string>>({})
  /** Chat to its Compact, from `begin` to `end`. */
  const runs = new Map<string, { compactId: string; stopRequested: boolean }>()

  const setPhase = (sessionId: string, status: string | null) => {
    if (status === null) {
      if (!(sessionId in phases)) return
      const next = { ...phases }
      delete next[sessionId]
      phases = next
      return
    }
    phases = { ...phases, [sessionId]: status }
  }

  return {
    begin: (sessionId) => {
      if (runs.has(sessionId)) return null
      const compactId = newCompactId()
      runs.set(sessionId, { compactId, stopRequested: false })
      return compactId
    },
    compactIdOf: (sessionId) => runs.get(sessionId)?.compactId ?? null,
    end: (sessionId) => {
      runs.delete(sessionId)
      setPhase(sessionId, null)
    },
    enterPhase: (sessionId, status) => {
      if (runs.has(sessionId)) setPhase(sessionId, status)
    },
    leavePhase: (sessionId) => setPhase(sessionId, null),
    requestStop: (sessionId) => {
      const run = runs.get(sessionId)
      if (!run) return false
      run.stopRequested = true
      return sessionId in phases
    },
    stopRequested: (sessionId) => runs.get(sessionId)?.stopRequested === true,
    isBusy: (sessionId) => Boolean(sessionId && sessionId in phases),
    statusOf: (sessionId) => (sessionId ? (phases[sessionId] ?? null) : null)
  }
}
