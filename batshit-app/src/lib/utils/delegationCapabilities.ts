/**
 * SA-111 — the one place that says which delegation capabilities actually EXIST in this
 * build, and the one rule for reading a primary agent's Workers setting.
 *
 * Why a flag rather than shipping the surfaces dark: P1 built the guidance block and the
 * DCM roster that P2 (thread control) and P4 (Workers) filled in. Advertising a `workers:`
 * line or a `spawn_workers` tool before the runtime existed would have taught primary
 * agents to call something that was not there — the opposite of Batshit's fail-loudly rule.
 * So the plumbing landed gated, and each packet flipped exactly one constant here.
 *
 * P4 (2026-09-04) flipped it: `native_spawn_workers` (API) and `spawn_workers` (managed
 * CLI bridge) exist, the runner is `$lib/server/services/workerRunner.ts`, and the caps
 * below are enforced there through `workerTurnBudget.ts`.
 *
 * No `$lib/server` imports: Agent Settings loads this in the browser.
 */

/** DL-111-09..12. Flipped by SA-111 P4 when the worker tools and runner shipped. */
export const WORKERS_FEATURE_ENABLED = true

/** DL-111-09: three workers per call, three concurrent, nine runs per parent turn. */
export const WORKERS_MAX_PER_CALL = 3
export const WORKERS_MAX_CONCURRENT = 3
export const WORKERS_MAX_RUNS_PER_TURN = 9

/** DL-111-10: a worker's brief and its optional role label are bounded, not unbounded text. */
export const WORKER_TASK_MAX_CHARS = 20_000
export const WORKER_ROLE_MAX_CHARS = 80

/** The name a worker with no `role` and no `base` shows in cards, accounting, and the EV. */
export const DEFAULT_WORKER_DISPLAY_NAME = 'Worker'

/**
 * THE per-agent Workers gate. Returns false whenever the feature itself is off, so no
 * surface can advertise workers ahead of the runtime. Reads the agent's stored
 * `workers_enabled` field, defaulting to ON for primary agents (DL-111-11) — a camelCase
 * alias is tolerated for API-shaped agent objects.
 *
 * IMPORTANT: the default is ON, so this must never be called on a synthesized/virtual
 * agent record (the CLI subagent profile's `virtualAgent`, an ephemeral worker record) —
 * a subagent or worker would inherit worker spawning and break DL-111-12's depth-1 rule.
 * Every runtime that can host a delegated run passes an EXPLICIT `false` instead.
 */
export function resolveWorkersEnabled(agent: unknown): boolean {
  if (!WORKERS_FEATURE_ENABLED) return false
  if (!agent || typeof agent !== 'object') return false
  const record = agent as Record<string, any>
  if (typeof record.workers_enabled === 'boolean') return record.workers_enabled
  if (typeof record.workersEnabled === 'boolean') return record.workersEnabled
  return true
}

/**
 * DL-111-01: the `SUBAGENTS & WORKERS (DELEGATION)` system-prompt block compiles when the
 * agent has something to delegate to — an assigned subagent, workers, or both — which is
 * also why an agent with neither pays no prompt bytes for the block.
 */
export function shouldCompileDelegationGuidance(options: {
  hasSubagents: boolean
  workersEnabled: boolean
}): boolean {
  return options.hasSubagents || options.workersEnabled
}
