/**
 * SA-115 P1 (DL-115-02) — every Redis key the schedule store owns, in one place.
 *
 * Two families. Each one is registered in THREE other places and missing any of them is a
 * silent data leak or a silent data loss, so they are listed here as the checklist
 * (`dmKeys.ts` is the precedent):
 *
 *   1. `redis.deleteAgent` (`redis.ts`) — schedules pointing at a deleted agent go with
 *      it, via `sweepAgentSchedules`, called BEFORE the agent record is removed because
 *      the sweep reads `agent.user_id`. Proved by `groupAgentCleanup.test.ts` on the real
 *      Redis lane (the in-memory fake has no `deleteAgent`).
 *   2. the backup `dms` group (`backupRestoreService.ts`) — `GROUP_DEFINITIONS`,
 *      `groupForKey`, `isRestorableKeyForUser` (both the user-prefix and the global-prefix
 *      lists), the restore remap on `schedules:{userId}`, and `collectCandidateKeys`,
 *      which reads the index as a **SET**. All six proved by `backupRestoreService.test.ts`
 *      through the real export/restore path.
 *   3. this file.
 *
 * `deleteSession` deliberately owes nothing: a schedule is agent-scoped, and the session
 * links it carries (`lastOutcome: 'woke: <sessionId>'`) are shown as "(session deleted)"
 * rather than followed.
 */

export const SCHEDULE_KEY_PREFIX = 'schedule:'
export const SCHEDULES_INDEX_PREFIX = 'schedules:'

/**
 * A schedule id is `sch_` plus base64url, and NOTHING else may be turned into a key.
 *
 * The id arrives as a URL path segment (the routes) and as agent-supplied tool input
 * (`sys.schedule.update`), so it is attacker-controlled text. The guard is hygiene, and
 * worth having for exactly these reasons: a malformed id answers "no such schedule" without
 * a key read; the charset and length are bounded, so no wildcard, control character, or
 * unbounded string ever reaches a key name or a log line built from one; and a typo is a
 * clean miss instead of a Redis error escaping as a 500.
 *
 * What it is NOT: a fix for `schedule:` and `schedules:` colliding. This header used to
 * claim `schedule:` + `s:{userId}` is byte-identical to `schedules:{userId}`; SA-116 P1
 * checked the arithmetic and it is false — the record prefix ends in `:` where the index
 * prefix has `s`, so no id can turn one key into the other, in either direction.
 */
const SCHEDULE_ID_PATTERN = /^sch_[A-Za-z0-9_-]{1,64}$/

export function isWellFormedScheduleId(scheduleId: unknown): scheduleId is string {
  return typeof scheduleId === 'string' && SCHEDULE_ID_PATTERN.test(scheduleId)
}

/** The record itself (RedisJSON). */
export function scheduleKey(scheduleId: string): string {
  return `${SCHEDULE_KEY_PREFIX}${scheduleId}`
}

/** SET of this user's schedule ids. A SET, like `wake_hooks:` — backup reads it as one. */
export function schedulesIndexKey(userId: string): string {
  return `${SCHEDULES_INDEX_PREFIX}${userId}`
}
