/**
 * The server side of the plan pause (plan sections 3 and 3a).
 *
 * The pause is the default on every copy. Josh's own Dev copy can switch it off
 * with "Use paused plans on this copy" in the internal Dev panel. The SERVER
 * decides: this module reads the Dev panel gate (env) and the switch (Redis).
 * A browser flag or a body field is never enough.
 *
 * The switch is a setting of ONE copy:
 * - owner: this module; key `batshit:dev:paused_plans` (RedisJSON,
 *   `{ usePausedPlans, updatedAt }`), written only by `PUT /api/admin/paused-plans`;
 * - delete rule: none needed; it is one small global record, removed by turning
 *   the switch off (the route deletes the key), never by user or agent deletion;
 * - backup rule: never exported and refused on import, so a backup never
 *   carries it into another copy (`backupRestoreService.ts`).
 */
import { redis } from '$lib/server/redis'
import { isInternalDevPanelEnabled } from '$lib/server/internalDevPanel'
import {
  PAUSED_PLANS,
  findPausedPlan,
  pausedPlanDevOnSentence,
  pausedPlanSentence,
  type PausedPlan
} from '$lib/data/pausedPlans'

export const PAUSED_PLANS_DEV_SWITCH_KEY = 'batshit:dev:paused_plans'

/** A paused plan refused a call or an add. Never caught by a fallback. */
export class PausedPlanError extends Error {
  readonly status = 409
  readonly service: string
  constructor(plan: PausedPlan) {
    super(pausedPlanSentence(plan))
    this.name = 'PausedPlanError'
    this.service = plan.service
  }
}

/** The stored switch alone, true only for a stored `usePausedPlans: true`. */
export async function readPausedPlansDevSwitch(): Promise<boolean> {
  const stored = (await redis.json.get(PAUSED_PLANS_DEV_SWITCH_KEY)) as
    | { usePausedPlans?: unknown }
    | null
  return stored?.usePausedPlans === true
}

export async function writePausedPlansDevSwitch(usePausedPlans: boolean): Promise<void> {
  if (usePausedPlans) {
    await redis.json.set(PAUSED_PLANS_DEV_SWITCH_KEY, '$', {
      usePausedPlans: true,
      updatedAt: new Date().toISOString()
    } as never)
  } else {
    await redis.del(PAUSED_PLANS_DEV_SWITCH_KEY)
  }
}

/**
 * True only on a copy whose Dev panel exists AND whose switch is on. A stored
 * switch on a copy without the Dev panel counts for nothing.
 */
export async function pausedPlansAllowedOnThisCopy(): Promise<boolean> {
  if (!isInternalDevPanelEnabled()) return false
  return readPausedPlansDevSwitch()
}

/** Throws the plain sentence when `service` is a paused plan and this copy does not allow it. */
export function assertPlanNotPaused(service: string | null | undefined, allowed: boolean): void {
  const plan = findPausedPlan(service)
  if (plan && !allowed) throw new PausedPlanError(plan)
}

/**
 * Refuses adding a paused plan (a key or a saved model), on the server. Returns
 * the refusal to send, or null when the add may go ahead.
 */
export async function pausedPlanAddRefusal(
  serviceOrConnection: string | null | undefined
): Promise<PausedPlanError | null> {
  const plan = findPausedPlan(serviceOrConnection)
  if (!plan) return null
  if (await pausedPlansAllowedOnThisCopy()) return null
  return new PausedPlanError(plan)
}

export interface PausedPlanStatus {
  /** False only on a Dev copy with "Use paused plans on this copy" on. */
  paused: boolean
  /** The plain words for the plan's row. */
  message: string
}

/** What each paused plan's Settings row says on this copy. */
export async function pausedPlanStatuses(): Promise<Record<string, PausedPlanStatus>> {
  const allowed = await pausedPlansAllowedOnThisCopy()
  return Object.fromEntries(
    PAUSED_PLANS.map((plan) => [
      plan.service,
      allowed
        ? { paused: false, message: pausedPlanDevOnSentence(plan) }
        : { paused: true, message: pausedPlanSentence(plan) }
    ])
  )
}
