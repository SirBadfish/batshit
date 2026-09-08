/**
 * SA-113 P2 (DL-113-02) — every Redis key the DM store owns, in one place.
 *
 * Four families. Each one is registered in THREE other places and missing any of them is
 * a silent data leak or a silent data loss, so they are listed here as the checklist:
 *
 *   1. `redis.deleteAgent` (`redis.ts`) — DMs addressed to a deleted agent go with it.
 *   2. the backup `dms` group (`backupRestoreService.ts`) — `GROUP_DEFINITIONS`,
 *      `groupForKey`, `isRestorableKeyForUser`, and `collectCandidateKeys`.
 *   3. this file.
 *
 * `deleteSession` deliberately owes nothing: a DM is agent-scoped, and the session links
 * it carries are shown as "(session deleted)" rather than followed.
 */

export const DM_KEY_PREFIX = 'dm:'
export const DM_INBOX_KEY_PREFIX = 'dm_inbox:'
export const DM_SENT_KEY_PREFIX = 'dm_sent:'
export const DM_INDEX_KEY_PREFIX = 'dm_index:'

/** The record itself (RedisJSON). */
export function dmKey(dmId: string): string {
  return `${DM_KEY_PREFIX}${dmId}`
}

/** ZSET of the recipient's DM ids. Urgent first, then oldest — see `dmInboxScore`. */
export function dmInboxKey(agentId: string): string {
  return `${DM_INBOX_KEY_PREFIX}${agentId}`
}

/** ZSET of the DM ids this agent sent, same ordering. */
export function dmSentKey(agentId: string): string {
  return `${DM_SENT_KEY_PREFIX}${agentId}`
}

/** ZSET of every DM on the instance, by creation time, for the all-agents drawer. */
export function dmUserIndexKey(userId: string): string {
  return `${DM_INDEX_KEY_PREFIX}${userId}`
}

/**
 * Urgent-first, then oldest-first, in one ascending ZSET read.
 *
 * `1e15` is comfortably past any real millisecond timestamp (year 33658), so every
 * non-urgent item sorts after every urgent one while both halves stay in time order.
 */
export const DM_NON_URGENT_SCORE_OFFSET = 1e15

export function dmInboxScore(priority: 'normal' | 'urgent', createdTs: number): number {
  return priority === 'urgent' ? createdTs : DM_NON_URGENT_SCORE_OFFSET + createdTs
}
