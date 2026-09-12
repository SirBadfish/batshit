/**
 * SA-115 P2 (DL-115-10) — `sys.schedule.*`, an agent's own hand on the clock.
 *
 * The heartbeat story needs an agent that can say "wake me every morning" without a person
 * opening Admin. This is that, and it is deliberately the smallest version of it:
 *
 *  - **Self-only.** An agent may create, list, change, and delete schedules whose
 *    `agentId` is *itself*, and nothing else. An agent that wants a colleague on a clock
 *    sends that colleague a DM asking for it. That keeps a misbehaving agent inside its
 *    own caps — the per-agent schedule cap, its own hourly wake budget — rather than
 *    letting it spend somebody else's.
 *  - **`confirm` on every write.** Putting an agent on a clock is a spend decision that
 *    repeats, so it goes past a person once. `list` is `safe`.
 *  - **Gated exactly like `sys.dm.*`.** `scheduleControlsEnabled` equals
 *    `resolveAgentDmsEnabled`, because a schedule's whole output is a DM: an agent with
 *    DMs off could create a schedule it would never be able to see fire.
 *
 * The gate is re-checked here, per operation, and not merely at registration. The broker
 * allow-list should already have stopped anything else; this is the layer that makes that
 * true rather than assumed — the same reason `requireDmEnabledAgent` exists.
 */

import { redis } from '$lib/server/redis'
import { resolveAgentDmsEnabled } from '$lib/utils/dmControl'
import {
  describeCadence,
  describeNextRun,
  MAX_SCHEDULES_PER_AGENT
} from '$lib/utils/scheduleControl'
import { hasMissedRun, type ScheduleRecord } from '$lib/types/schedule'
import {
  createSchedule,
  deleteSchedule as deleteScheduleRecord,
  getOwnedSchedule,
  listSchedules,
  patchSchedule,
  ScheduleError
} from './scheduleStore'

export class ScheduleToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'ScheduleToolError'
  }
}

export interface ScheduleToolContext {
  userId: string
  /** The ACTING agent — server-owned, and the ONLY agent it may schedule. */
  agentId: string
}

/**
 * Server-side enablement gate, mirroring `requireDmEnabledAgent`.
 *
 * A schedule's only output is a DM, so the same switch decides both. An agent with Agent
 * DMs off that could still create a schedule would be building a clock whose alarm it can
 * never hear.
 */
async function requireScheduleEnabledAgent(
  context: ScheduleToolContext
): Promise<Record<string, any>> {
  const normalized = typeof context.agentId === 'string' ? context.agentId.trim() : ''
  if (!normalized) {
    throw new ScheduleToolError('Schedule operations need an agent context (agentId missing).')
  }
  const agent = (await redis.get(`agent:${normalized}`)) as Record<string, any> | null
  if (!agent) {
    throw new ScheduleToolError(`Agent "${normalized}" was not found.`)
  }
  if (typeof agent.user_id === 'string' && agent.user_id !== context.userId) {
    throw new ScheduleToolError(`Agent "${normalized}" does not belong to this user.`)
  }
  if (!resolveAgentDmsEnabled(agent)) {
    throw new ScheduleToolError(
      `Agent DMs are not turned on for "${agent.displayName ?? agent.name ?? normalized}", and a schedule works by sending one.`,
      'Turn on Agent DMs for this agent in Agent Settings first.'
    )
  }
  return agent
}

/** Translate the store's refusals into the tool error shape, keeping their hints. */
async function runStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ScheduleError) {
      throw new ScheduleToolError(error.message, error.hint)
    }
    throw error
  }
}

/**
 * The self-only rule, in one place.
 *
 * Reading the schedule first and comparing its `agentId` means another agent's schedule is
 * answered as "not found" rather than "forbidden" — the difference would confirm the id is
 * real, and an agent has even less business learning that than a browser does.
 */
async function requireOwnSchedule(
  context: ScheduleToolContext,
  scheduleId: unknown
): Promise<ScheduleRecord> {
  const record = await runStore(() => getOwnedSchedule(context.userId, scheduleId))
  if (record.agentId !== context.agentId) {
    throw new ScheduleToolError(
      'That schedule belongs to a different agent.',
      'You can only manage your own schedules. Ask that agent by DM if you need theirs changed.'
    )
  }
  return record
}

/**
 * What an agent sees. Summary-first: the message body is included because an agent that
 * cannot read what its own schedule says cannot sensibly change it, but everything else is
 * pre-formatted so the model spends no tokens re-deriving a cadence or a time zone.
 */
function toAgentView(record: ScheduleRecord): Record<string, any> {
  return {
    schedule_id: record.id,
    name: record.name,
    cadence: describeCadence(record.cadence),
    cadence_raw: record.cadence,
    time_zone: record.timeZone,
    message: record.message,
    kind: record.kind,
    deliver: record.deliver,
    enabled: record.enabled,
    next_run: record.enabled
      ? describeNextRun(record.nextRunAt, record.timeZone)
      : 'paused, so nothing is scheduled',
    last_run: record.lastRunAt ?? null,
    last_outcome: record.lastOutcome ?? null,
    run_count: record.runCount,
    ...(hasMissedRun(record)
      ? {
          // Say it, but say who can act on it: an agent pressing its own Run now would
          // be exactly the "it fired in the dark" outcome DL-115-07 exists to prevent.
          missed_run: {
            was_due: record.missedRun?.dueAt,
            count: record.missedRun?.count,
            note: 'Waiting for the user to run or skip it. Only they can.'
          }
        }
      : {}),
    created_by: typeof record.createdBy === 'object' ? 'agent' : 'user'
  }
}

/* ------------------------------------------------------------------ *
 * The four operations
 * ------------------------------------------------------------------ */

export async function listSchedulesOp(
  context: ScheduleToolContext
): Promise<{ schedules: Record<string, any>[]; total: number; limit: number }> {
  await requireScheduleEnabledAgent(context)
  const all = await runStore(() => listSchedules(context.userId))
  const mine = all.filter((record) => record.agentId === context.agentId)
  return {
    schedules: mine.map(toAgentView),
    total: mine.length,
    limit: MAX_SCHEDULES_PER_AGENT
  }
}

export async function createScheduleOp(
  context: ScheduleToolContext,
  input: {
    name: string
    cadence: unknown
    message: string
    time_zone?: string
    kind?: string
    deliver?: string
  }
): Promise<{ created: true; schedule: Record<string, any> }> {
  await requireScheduleEnabledAgent(context)
  const record = await runStore(() =>
    createSchedule({
      userId: context.userId,
      // Self-only, and not negotiable from input: the agent id here is the server-owned
      // acting agent, so there is no field a model could set to schedule somebody else.
      agentId: context.agentId,
      createdBy: { agentId: context.agentId },
      name: input.name,
      cadence: input.cadence,
      timeZone: input.time_zone ?? resolveDefaultTimeZone(),
      message: input.message,
      kind: input.kind,
      deliver: input.deliver
    })
  )
  return { created: true, schedule: toAgentView(record) }
}

export async function updateScheduleOp(
  context: ScheduleToolContext,
  input: {
    schedule_id: string
    name?: string
    cadence?: unknown
    message?: string
    time_zone?: string
    kind?: string
    deliver?: string
    enabled?: boolean
  }
): Promise<{ updated: true; schedule: Record<string, any> }> {
  await requireScheduleEnabledAgent(context)
  const current = await requireOwnSchedule(context, input.schedule_id)
  const record = await runStore(() =>
    patchSchedule({
      userId: context.userId,
      scheduleId: current.id,
      name: input.name,
      cadence: input.cadence,
      timeZone: input.time_zone,
      message: input.message,
      kind: input.kind,
      deliver: input.deliver,
      enabled: input.enabled
    })
  )
  return { updated: true, schedule: toAgentView(record) }
}

export async function deleteScheduleOp(
  context: ScheduleToolContext,
  input: { schedule_id: string }
): Promise<{ deleted: true; schedule_id: string; name: string }> {
  await requireScheduleEnabledAgent(context)
  const current = await requireOwnSchedule(context, input.schedule_id)
  await runStore(() => deleteScheduleRecord({ userId: context.userId, scheduleId: current.id }))
  return { deleted: true, schedule_id: current.id, name: current.name }
}

/**
 * The zone a schedule gets when the agent does not name one.
 *
 * The server's own zone is the honest default and the card shows it, so a wrong guess is
 * visible and one edit away. It is genuinely right on the packaged Mac app (the server
 * clock IS the user's) and usually UTC in Docker, which is also honest — the browser is
 * the only place the user's real zone is known, and no browser is involved in an agent's
 * call.
 */
function resolveDefaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
