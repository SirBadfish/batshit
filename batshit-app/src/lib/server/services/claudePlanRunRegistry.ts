import { ClaudePlanRunError } from '$lib/server/services/claudePlanProtocol'
import type { ClaudePlanRun, ClaudePlanSettlement } from '$lib/server/services/claudePlanRun'
import { registerRuntimeShutdownTask } from '$lib/server/services/runtimeShutdown'
import { TURN_SHUTDOWN_WAIT_MS, waitForRunningTurns } from '$lib/server/services/turnOutcomeRegistry'

/**
 * SA-139 (D10): the one in-process owner of every live Claude plan run. A run registers when it
 * starts and leaves only once it has SETTLED: its Claude Code process exit confirmed and its run
 * folder removed, or the exit left unknown at the bound (then it stays listed, so a destructive
 * owner keeps failing closed).
 *
 * Destructive owners (chat delete, agent delete, backup restore, app shutdown) close admission,
 * end the matching runs and await real settlement before they replace or remove anything; SIGTERM
 * alone is not settlement. A run held at an approval card (D6) is kept here by its key so the same
 * sweeps reach it; the held-run flow itself (claim at the click, the card clock) is P3's.
 */

export type ClaudePlanRunFilter = { userId?: string | null; sessionId?: string | null; agentId?: string | null }

export type ClaudePlanHoldKey = Readonly<{ sessionId: string; replyId: string; version: string }>

/** What the adapter needs to continue a held run's reply after the click (opaque to the registry). */
export type ClaudePlanHeldState = Readonly<Record<string, unknown>>
/** Who may claim a held run: the same user, agent and chat as the reply it belongs to (D6 claim binding). */
export type ClaudePlanHoldOwner = Readonly<{ userId: string; agentId: string }>

type HeldEntry = { run: ClaudePlanRun; key: ClaudePlanHoldKey; state: ClaudePlanHeldState; awaiting: readonly string[]; deadlineAt: number; timer: ReturnType<typeof setTimeout> }

const runs = new Set<ClaudePlanRun>()
const unsettled = new Set<ClaudePlanRun>()
const held = new Map<string, HeldEntry>()
/** Every owner that closed run admission, by its own key: one owner's reopen never reopens another's close. */
const closers = new Map<symbol, string>()
/** Shutdown closes for good and names itself first. */
let shutdownReason: string | null = null
const admissionClosedReason = (): string | null => shutdownReason ?? closers.values().next().value ?? null

const holdKeyText = (key: ClaudePlanHoldKey) => `${key.sessionId}\n${key.replyId}\n${key.version}`

export function registerClaudePlanRun(run: ClaudePlanRun): void {
  const closed = admissionClosedReason()
  if (closed) {
    throw new ClaudePlanRunError('run_ended', closed)
  }
  runs.add(run)
  void run.settled.then((settlement: ClaudePlanSettlement) => {
    runs.delete(run)
    for (const [text, entry] of held) if (entry.run === run) { clearTimeout(entry.timer); held.delete(text) }
    if (settlement === 'unknown') {
      unsettled.add(run)
      // A later confirmed exit lets the chat's delete go ahead again (S5).
      void run.exited.then(() => unsettled.delete(run))
    }
  })
}

/** A field the filter names (even an empty string) must match exactly; only an absent field matches all. */
function matches(run: ClaudePlanRun, filter: ClaudePlanRunFilter): boolean {
  if (filter.userId != null && run.owner.userId !== filter.userId) return false
  if (filter.sessionId != null && run.owner.sessionId !== filter.sessionId) return false
  if (filter.agentId != null && run.owner.agentId !== filter.agentId) return false
  return true
}

/** Live runs (and runs whose exit is still unconfirmed) that match. */
export function listClaudePlanRuns(filter: ClaudePlanRunFilter = {}): ClaudePlanRun[] {
  return [...runs, ...unsettled].filter(run => matches(run, filter))
}

/**
 * Ends every matching run and waits for each to settle. `unsettled` counts runs whose exit could
 * not be confirmed (now or earlier): the caller keeps failing closed while it is above zero.
 */
export async function endClaudePlanRuns(filter: ClaudePlanRunFilter, reason: string): Promise<{ ended: number; unsettled: number }> {
  const targets = [...runs].filter(run => matches(run, filter))
  for (const run of targets) run.stop(new ClaudePlanRunError('run_ended', reason))
  const settlements = await Promise.all(targets.map(run => run.settled))
  const stillUnknown = [...unsettled].filter(run => matches(run, filter)).length
  return { ended: targets.length, unsettled: Math.max(stillUnknown, settlements.filter(state => state === 'unknown').length) }
}

const CLAUDE_PLAN_SHUTDOWN_REASON = 'Batshit is shutting down.'

/** App shutdown: no new run starts, and every run ends and settles (bounded by each run's own bound). */
export async function shutdownClaudePlanRuns(reason = CLAUDE_PLAN_SHUTDOWN_REASON): Promise<{ ended: number; unsettled: number }> {
  closeClaudePlanRunAdmissionForShutdown(reason)
  return endClaudePlanRuns({}, reason)
}

/** Shutdown: no new run starts from now on; nothing reopens it. */
export function closeClaudePlanRunAdmissionForShutdown(reason = CLAUDE_PLAN_SHUTDOWN_REASON): void {
  shutdownReason ??= reason
}

let lifecycleArmed = false

/**
 * Server start (`hooks.server.ts`), once: the boot sweep of the run folders a crashed Batshit left
 * (`sweepStaleClaudePlanRunFolders`), and the shutdown task. At shutdown running replies get the
 * same wait every shutdown owner gives them, then every run ends and its exit is awaited.
 */
export function armClaudePlanRunLifecycle(): void {
  if (lifecycleArmed) return
  lifecycleArmed = true
  registerRuntimeShutdownTask('claude-plan-runs', async () => {
    // No new run starts while running replies get their shutdown wait (a supervisor may kill the
    // app before the wait ends; a run never started is one less process left for the boot sweep).
    closeClaudePlanRunAdmissionForShutdown()
    await waitForRunningTurns(TURN_SHUTDOWN_WAIT_MS)
    const { unsettled } = await shutdownClaudePlanRuns()
    if (unsettled > 0) console.warn(`[Claude plan] ${unsettled} Claude Code run(s) did not confirm their exit at shutdown.`)
  })
  void import('$lib/server/services/claudePlanRun')
    .then(({ sweepStaleClaudePlanRunFolders }) => sweepStaleClaudePlanRunFolders())
    .then(outcome => {
      if (outcome.removed.length || outcome.killed.length) {
        console.info(`[Startup] Claude plan: removed ${outcome.removed.length} leftover run folder(s) and ended ${outcome.killed.length} leftover Claude Code run(s).`)
      }
    })
    .catch(error => console.error('[Startup] The Claude plan leftover-run sweep failed; the next start retries:', error))
}

/** Backup restore and similar owners: no new run starts until they reopen admission. */
export function closeClaudePlanRunAdmission(reason: string): () => void {
  const key = Symbol(reason)
  closers.set(key, reason)
  return () => { closers.delete(key) }
}

/**
 * D6: keeps a run whose reply ended at an approval card, under its (chat, reply, paused version) key,
 * with the state its continuation needs and an absolute server deadline (the card's own clock) that
 * ends it with every browser closed. Every sweep that ends runs by owner still reaches it (it stays in
 * `runs`); `endHeldClaudePlanRuns` ends only held ones (Stop in the gap, a new ordinary turn).
 */
export function holdClaudePlanRun(run: ClaudePlanRun, key: ClaudePlanHoldKey, deadlineAt: number, state: ClaudePlanHeldState = {}, awaiting: readonly string[] = []): void {
  if (run.isEnded) return
  const text = holdKeyText(key)
  if (held.has(text)) throw new ClaudePlanRunError('integrity', 'This approval card already holds a Claude plan run.')
  const timer = setTimeout(() => {
    held.delete(text)
    run.stop(new ClaudePlanRunError('run_ended', 'The approval card expired, so the Claude plan run ended.'))
  }, Math.max(0, deadlineAt - Date.now()))
  timer.unref?.()
  held.set(text, { run, key, state, awaiting: [...awaiting], deadlineAt, timer })
}

/**
 * D6 claim at the click: atomic and once, bound to the reply's user, agent and chat. A missing, ended,
 * mismatched or already-claimed run returns null and nothing of it runs; a mismatched one is ended.
 */
export function claimHeldClaudePlanRun(key: ClaudePlanHoldKey, owner: ClaudePlanHoldOwner, toolCallIds?: readonly string[]): { run: ClaudePlanRun; state: ClaudePlanHeldState } | null {
  const text = holdKeyText(key)
  const entry = held.get(text)
  if (!entry) return null
  // The card's clock ran out (a timer late under load): the run is gone, not claimable (review B delta N2).
  if (Date.now() >= entry.deadlineAt) {
    held.delete(text)
    clearTimeout(entry.timer)
    entry.run.stop(new ClaudePlanRunError('run_ended', 'The approval card expired, so the Claude plan run ended.'))
    return null
  }
  // A click for calls this run does not wait for (a stale card) claims nothing and leaves it held (review B M1).
  if (toolCallIds && !toolCallIds.every(id => entry.awaiting.includes(id))) return null
  held.delete(text)
  clearTimeout(entry.timer)
  const runOwner = entry.run.owner
  if (runOwner.userId !== owner.userId || runOwner.agentId !== owner.agentId || runOwner.sessionId !== key.sessionId) {
    entry.run.stop(new ClaudePlanRunError('integrity', 'An approval click named a held Claude plan run of another owner. The run was ended.'))
    return null
  }
  return entry.run.isEnded ? null : { run: entry.run, state: entry.state }
}

/** Held runs only (D6, D10): Stop in the gap after the reply, and a new ordinary turn in the chat. */
export async function endHeldClaudePlanRuns(filter: ClaudePlanRunFilter, reason: string): Promise<{ ended: number; unsettled: number }> {
  const targets: ClaudePlanRun[] = []
  for (const [text, entry] of held) {
    if (!matches(entry.run, filter)) continue
    held.delete(text)
    clearTimeout(entry.timer)
    targets.push(entry.run)
  }
  for (const run of targets) run.stop(new ClaudePlanRunError('run_ended', reason))
  const settled = await Promise.all(targets.map(run => run.settled))
  return { ended: targets.length, unsettled: settled.filter(result => result === 'unknown').length }
}

/** Does a run held under this key wait for every one of these tool calls (the click's own cards)? */
export function heldClaudePlanRunWaitsFor(key: ClaudePlanHoldKey, toolCallIds: readonly string[]): boolean {
  const entry = held.get(holdKeyText(key))
  return Boolean(entry && !entry.run.isEnded && Date.now() < entry.deadlineAt && toolCallIds.length > 0 && toolCallIds.every(id => entry.awaiting.includes(id)))
}

/** Is a run of this reply held at a card (for tests and the reply's own checks)? */
export function isClaudePlanRunHeld(key: ClaudePlanHoldKey): boolean {
  return held.has(holdKeyText(key))
}

/** Test reset only. */
export function resetClaudePlanRunRegistryForTests(): void {
  for (const entry of held.values()) clearTimeout(entry.timer)
  held.clear()
  runs.clear()
  unsettled.clear()
  closers.clear()
  shutdownReason = null
  lifecycleArmed = false
}
