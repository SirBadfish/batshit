/**
 * SA-113 — the one place that owns the Agent DM / wake-up rules that both sides of the
 * app need, plus the caps that keep a wake-up from becoming a zombie (DL-113-12).
 *
 * P1 filled in the wake half: `resolveAgentWakeEnabled`, `resolveWakeTimeoutMs`,
 * `resolveWakeTarget`, and the constants. P2 added the DM half
 * (`resolveAgentDmsEnabled`, `resolveDmSenderAllowed`) to this same file, so there is
 * exactly one gate module to audit, the way `memoryControl.ts` owns the memory gate.
 *
 * No `$lib/server` imports: Agent Settings, the sidebar, and the Admin panel load this in
 * the browser.
 */

/* ------------------------------------------------------------------ *
 * Caps (DL-113-12) — fixed numbers in v1, printed in the docs.
 * The ONE exception is the woken-turn time limit, which Josh made a
 * per-agent setting on 2026-09-06; its code default lives here too.
 * ------------------------------------------------------------------ */

/** A wakes B, B wakes C… stops here. Depth 0 is a wake started by a human/webhook. */
export const MAX_WAKE_CHAIN_DEPTH = 3

/** Rolling-hour wake budgets. Refusals degrade to `wait`; nothing retries. */
export const MAX_WAKES_PER_AGENT_PER_HOUR = 6
export const MAX_WAKES_PER_INSTANCE_PER_HOUR = 20

/** Woken turns allowed to be RUNNING at the same moment. */
export const MAX_RUNNING_WOKEN_TURNS_PER_AGENT = 1
export const MAX_RUNNING_WOKEN_TURNS = 3

/** Hard stop on a single woken turn. Per-agent override: `wake_timeout_minutes`. */
export const DEFAULT_WAKE_TIMEOUT_MINUTES = 30
export const MIN_WAKE_TIMEOUT_MINUTES = 5
export const MAX_WAKE_TIMEOUT_MINUTES = 240

/** The auto-name a woken session gets, trimmed to this (DL-113-08). */
export const WAKE_SESSION_NAME_MAX_CHARS = 60

/* ------------------------------------------------------------------ *
 * DM caps and sizes (DL-113-02, DL-113-12)
 * ------------------------------------------------------------------ */

export const DM_SUBJECT_MAX_CHARS = 240
export const DM_BODY_MAX_CHARS = 40_000
export const DM_RESULT_MAX_CHARS = 20_000

/** A full inbox refuses new items with a reason rather than silently dropping them. */
export const MAX_OPEN_DMS_PER_INBOX = 50

/** How long an unhandled DM stays open before the lazy reaper marks it `expired`. */
export const DM_EXPIRY_DAYS_INFO = 7
export const DM_EXPIRY_DAYS_ASSIGNMENT = 14

/** A sender may override the expiry within this range. */
export const MIN_DM_EXPIRES_IN_HOURS = 1
export const MAX_DM_EXPIRES_IN_HOURS = 720

/** How long a closed or expired DM is kept before Redis drops it. */
export const DM_RETENTION_DAYS = 30

/**
 * Two loop guards borrowed from Claude Code's cross-session messaging: an agent cannot DM
 * itself, and an identical DM inside this window is refused as a duplicate rather than
 * quietly written twice.
 */
export const DM_DUPLICATE_WINDOW_MS = 10 * 60 * 1000

/** How many open items the DCM roster lists before it summarises the rest. */
export const DM_ROSTER_MAX_LINES = 8

/* ------------------------------------------------------------------ *
 * Wake-up webhooks (DL-113-09)
 * ------------------------------------------------------------------ */

/** Calls one hook may make in a rolling hour before the route answers 429. */
export const MAX_WAKE_WEBHOOK_CALLS_PER_HOUR = 30

/** How long Batshit waits for a result callback before giving up. It never retries. */
export const WAKE_CALLBACK_TIMEOUT_MS = 10_000

export const WAKE_HOOK_NAME_MAX_CHARS = 80

/* ------------------------------------------------------------------ *
 * Working style (DL-113-15)
 * ------------------------------------------------------------------ */

/**
 * How a wake-up reaches this agent.
 *
 * - `new-session` (**Parallel**, the default): the wake opens its own chat, so the agent
 *   can be woken while it is already working somewhere else.
 * - `current-session` (**One at a time**): the wake lands in the agent's current chat, so
 *   two copies of one agent never run. Josh's own way of working.
 */
export const WAKE_TARGETS = ['new-session', 'current-session'] as const
export type WakeTarget = (typeof WAKE_TARGETS)[number]

export const DEFAULT_WAKE_TARGET: WakeTarget = 'new-session'

/* ------------------------------------------------------------------ *
 * Delivery (DL-113-03) — the enum is reserved here in P1 so the wake
 * primitive and P2's `sys.dm.send` cannot drift apart.
 * ------------------------------------------------------------------ */

/**
 * `steer` is RESERVED, not implemented: SA-114 owns delivering a message into a running
 * turn at its next tool boundary. `isDeliverableNow` is the one rule that says so, so a
 * caller can never quietly treat `steer` as `wake`.
 */
export const DM_DELIVERY_MODES = ['wait', 'wake', 'steer'] as const
export type DmDeliveryMode = (typeof DM_DELIVERY_MODES)[number]

export const STEER_UNAVAILABLE_REASON =
  'Steering a running turn is not available until SA-114 ships. Send this as "wait" or "wake".'

export function isDeliverableNow(mode: DmDeliveryMode): mode is 'wait' | 'wake' {
  return mode === 'wait' || mode === 'wake'
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

/**
 * THE per-agent "may be woken" gate (DL-113-01). Defaults **ON**, which is safe because
 * nothing can wake an agent until the user has configured a sender or a webhook — the
 * switch is inert, not permissive.
 *
 * Like `resolveWorkersEnabled`, the ON default means this must never be called on a
 * synthesized agent record. Only real primary agent rows reach it.
 */
export function resolveAgentWakeEnabled(agent: unknown): boolean {
  if (!agent || typeof agent !== 'object') return false
  const record = agent as Record<string, any>
  if (typeof record.wake_enabled === 'boolean') return record.wake_enabled
  if (typeof record.wakeEnabled === 'boolean') return record.wakeEnabled
  return true
}

/**
 * THE per-agent "Agent DMs" gate (DL-113-01). Defaults **OFF**, unlike the wake switch:
 * DMs create sessions and spend tokens outside the user's view, so an agent gets them
 * only when the user turns them on. Off means zero prompt bytes, no roster, no tools.
 *
 * This is the single rule behind the `sys.dm.*` family, the guidance block, the DCM
 * roster, and the header inbox icon — they ship together or not at all (DL-113-13).
 */
export function resolveAgentDmsEnabled(agent: unknown): boolean {
  if (!agent || typeof agent !== 'object') return false
  const record = agent as Record<string, any>
  if (typeof record.dms_enabled === 'boolean') return record.dms_enabled
  if (typeof record.dmsEnabled === 'boolean') return record.dmsEnabled
  return false
}

/* ------------------------------------------------------------------ *
 * Who may write to an agent (DL-113-01)
 * ------------------------------------------------------------------ */

export const DM_SENDER_SCOPES = ['all', 'selected'] as const
export type DmSenderScope = (typeof DM_SENDER_SCOPES)[number]

export interface DmSenderPolicy {
  scope: DmSenderScope
  agentIds: string[]
}

/**
 * THE recipient-side sender policy read. `all` (the default) means any DM-enabled agent
 * may write; `selected` means only the listed agent ids.
 *
 * `selected` with an EMPTY list means nobody, deliberately — the same reading the
 * artifact allowlist uses. Silently treating it as "everybody" would turn a half-finished
 * setting into an open door.
 */
export function resolveDmSenderPolicy(agent: unknown): DmSenderPolicy {
  const record =
    agent && typeof agent === 'object' ? (agent as Record<string, any>) : {}
  const raw = record.dm_senders ?? record.dmSenders
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return {
      scope: (DM_SENDER_SCOPES as readonly string[]).includes(trimmed)
        ? (trimmed as DmSenderScope)
        : 'all',
      agentIds: normalizeAgentIdList(record.dm_sender_agent_ids ?? record.dmSenderAgentIds)
    }
  }
  if (raw && typeof raw === 'object') {
    const scopeRaw = typeof raw.scope === 'string' ? raw.scope.trim() : 'all'
    return {
      scope: (DM_SENDER_SCOPES as readonly string[]).includes(scopeRaw)
        ? (scopeRaw as DmSenderScope)
        : 'all',
      agentIds: normalizeAgentIdList(raw.agentIds ?? raw.agent_ids)
    }
  }
  return { scope: 'all', agentIds: [] }
}

function normalizeAgentIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * Route-level validation for the two stored DM sender fields.
 *
 * `resolveDmSenderPolicy` treats anything unrecognised as `all`, which is the right
 * READ-side default but the wrong thing to allow on the WRITE side: `all` is the more
 * permissive value, so a typo must be refused rather than quietly widening who may write
 * to an agent. Returns an error sentence, or null when there is nothing wrong.
 */
export function validateDmSenderFields(input: {
  dm_senders?: unknown
  dm_sender_agent_ids?: unknown
}): string | null {
  if (input.dm_senders !== undefined && input.dm_senders !== null) {
    const raw = typeof input.dm_senders === 'string' ? input.dm_senders.trim() : null
    if (!raw || !(DM_SENDER_SCOPES as readonly string[]).includes(raw)) {
      return `"Who may DM this agent" must be ${DM_SENDER_SCOPES.join(' or ')}.`
    }
  }
  if (input.dm_sender_agent_ids !== undefined && input.dm_sender_agent_ids !== null) {
    if (
      !Array.isArray(input.dm_sender_agent_ids) ||
      input.dm_sender_agent_ids.some((entry) => typeof entry !== 'string')
    ) {
      return 'The chosen DM senders must be a list of agent ids.'
    }
  }
  return null
}

/**
 * THE "may this sender write to this recipient?" rule, read from the RECIPIENT's record.
 * A webhook sender has no agent id and is governed by its own hook record, not by this.
 */
export function resolveDmSenderAllowed(
  recipientAgent: unknown,
  senderAgentId: string | null | undefined
): boolean {
  const policy = resolveDmSenderPolicy(recipientAgent)
  if (policy.scope === 'all') return true
  const sender = typeof senderAgentId === 'string' ? senderAgentId.trim() : ''
  if (!sender) return false
  return policy.agentIds.includes(sender)
}

/**
 * THE instance-wide master switch read (DL-113-01), from the `admin_settings` blob.
 * Defaults ON; only an explicit `false` turns wake-ups off for the whole instance.
 */
export function resolveInstanceWakeupsEnabled(adminSettings: unknown): boolean {
  if (!adminSettings || typeof adminSettings !== 'object') return true
  const record = adminSettings as Record<string, any>
  if (typeof record.agent_wakeups_enabled === 'boolean') return record.agent_wakeups_enabled
  if (typeof record.agentWakeupsEnabled === 'boolean') return record.agentWakeupsEnabled
  return true
}

/**
 * THE working-style read (DL-113-15). Anything unrecognised resolves to Parallel, which
 * is the default and the behaviour every other Batshit session already has.
 */
export function resolveWakeTarget(agent: unknown): WakeTarget {
  if (!agent || typeof agent !== 'object') return DEFAULT_WAKE_TARGET
  const record = agent as Record<string, any>
  const raw = record.wake_target ?? record.wakeTarget
  if (typeof raw !== 'string') return DEFAULT_WAKE_TARGET
  const trimmed = raw.trim()
  return (WAKE_TARGETS as readonly string[]).includes(trimmed)
    ? (trimmed as WakeTarget)
    : DEFAULT_WAKE_TARGET
}

/**
 * Validation for the **Wake-up time limit** field, in the LS-037 shape Josh asked for
 * (DL-113-01): blank means "use the code default", and a nonblank invalid value fails
 * loudly instead of being quietly clamped, so a typo cannot silently shorten a turn.
 */
export type WakeTimeoutValidation =
  | { ok: true; minutes: number | null }
  | { ok: false; error: string }

export function validateWakeTimeoutMinutes(value: unknown): WakeTimeoutValidation {
  if (value === undefined || value === null) return { ok: true, minutes: null }
  if (typeof value === 'string' && value.trim().length === 0) {
    return { ok: true, minutes: null }
  }

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return {
      ok: false,
      error: `Wake-up time limit must be a whole number of minutes between ${MIN_WAKE_TIMEOUT_MINUTES} and ${MAX_WAKE_TIMEOUT_MINUTES}, or blank for the ${DEFAULT_WAKE_TIMEOUT_MINUTES}-minute default.`
    }
  }

  if (parsed < MIN_WAKE_TIMEOUT_MINUTES || parsed > MAX_WAKE_TIMEOUT_MINUTES) {
    return {
      ok: false,
      error: `Wake-up time limit must be between ${MIN_WAKE_TIMEOUT_MINUTES} and ${MAX_WAKE_TIMEOUT_MINUTES} minutes, or blank for the ${DEFAULT_WAKE_TIMEOUT_MINUTES}-minute default.`
    }
  }

  return { ok: true, minutes: parsed }
}

/**
 * THE resolved hard stop for one woken turn, in milliseconds. The wake primitive calls
 * this ONCE per woken turn against a freshly read agent record, so a change to the
 * setting governs the next wake-up without a reload.
 *
 * A stored value that no longer validates falls back to the code default rather than
 * throwing: the setting surface is where an invalid value fails loudly, and a woken turn
 * with a broken dial should still be bounded rather than unbounded.
 */
export function resolveWakeTimeoutMs(agent: unknown): number {
  const record =
    agent && typeof agent === 'object' ? (agent as Record<string, any>) : {}
  const validation = validateWakeTimeoutMinutes(
    record.wake_timeout_minutes ?? record.wakeTimeoutMinutes
  )
  const minutes = validation.ok && validation.minutes !== null
    ? validation.minutes
    : DEFAULT_WAKE_TIMEOUT_MINUTES
  return minutes * 60 * 1000
}
