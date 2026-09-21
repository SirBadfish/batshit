/**
 * SA-120 P6 — the server-side store for what the after-reply check noticed about a reply.
 *
 * WHY NOT THE MESSAGE'S OWN METADATA. The check runs after the session stream has emitted
 * `end`. From that moment the browser owns the next write of the message: it rebuilds the
 * content from the stream events and saves its own copy, possibly seconds later (after speech).
 * The history the compiler reads is the browser's copy too (it arrives in the request body).
 * So a finding written into the message could be lost to that save and would never reach the
 * next prompt (SSE Streaming Contract; F-P5-10). P5 solved the same problem with a marker in
 * Redis plus a user-channel event, and so does this:
 *
 *   jev_post_turn:{sessionId}                     set of message ids that hold a record
 *   jev_post_turn_item:{sessionId}:{messageId}    one `JevJuicePostTurnRecord`
 *
 * This module is the ONLY writer of both keys. Obligations of a new session-scoped key:
 *   - deletion: `sweepPostTurnRecords` runs inside `deleteSession`, `deletePostTurnRecord`
 *     inside `deleteMessage` (`$lib/server/redis.ts`);
 *   - backup: both prefixes are collected and restorable in the `chats` group
 *     (`backupRestoreService.ts`), because the chip is part of how the chat reads;
 *   - no TTL: a record is an annotation of its reply and lives exactly as long as it does.
 *
 * A clean check stores NOTHING, so a chat only ever pays for replies that were flagged.
 */

import { redis } from '$lib/server/redis'
import type { JevJuicePostTurnRecord } from '$lib/types/typesafe'
import { readJevJuicePostTurnRecord } from '$lib/utils/jevJuice'

export const POST_TURN_INDEX_KEY_PREFIX = 'jev_post_turn:'
export const POST_TURN_ITEM_KEY_PREFIX = 'jev_post_turn_item:'

const indexKey = (sessionId: string) => `${POST_TURN_INDEX_KEY_PREFIX}${sessionId}`
const itemKey = (sessionId: string, messageId: string) => `${POST_TURN_ITEM_KEY_PREFIX}${sessionId}:${messageId}`

/**
 * Stores one reply's record. A record with no findings and no notes is not stored at all
 * (returns `false`), and an earlier record for the same reply is replaced whole.
 */
export async function writePostTurnRecord(record: JevJuicePostTurnRecord): Promise<boolean> {
  const readable = readJevJuicePostTurnRecord(record)
  if (!readable || !record.sessionId) return false
  await redis.set(itemKey(record.sessionId, record.messageId), { ...readable, sessionId: record.sessionId })
  await redis.sAdd(indexKey(record.sessionId), record.messageId)
  return true
}

export async function loadPostTurnRecord(sessionId: string, messageId: string): Promise<JevJuicePostTurnRecord | null> {
  if (!sessionId || !messageId) return null
  return readJevJuicePostTurnRecord(await redis.get(itemKey(sessionId, messageId)))
}

/** Every stored record of a chat, keyed by message id (the chat page draws the chips from this). */
export async function loadPostTurnRecords(sessionId: string): Promise<Record<string, JevJuicePostTurnRecord>> {
  const records: Record<string, JevJuicePostTurnRecord> = {}
  if (!sessionId) return records
  for (const messageId of (await redis.sMembers(indexKey(sessionId))) ?? []) {
    const record = await loadPostTurnRecord(sessionId, messageId)
    if (record) records[messageId] = record
  }
  return records
}

/**
 * Marks a record as told, once the send whose prompt carried its lines was accepted. A record
 * that was deleted meanwhile (its message is gone) stays gone: this never re-creates one.
 */
export async function markPostTurnRecordTold(sessionId: string, messageId: string): Promise<void> {
  const record = await loadPostTurnRecord(sessionId, messageId)
  if (!record || record.toldAgent) return
  await redis.set(itemKey(sessionId, messageId), { ...record, toldAgent: true })
}

/** A message was deleted: its record goes with it. */
export async function deletePostTurnRecord(sessionId: string, messageId: string): Promise<void> {
  if (!sessionId || !messageId) return
  await redis.del(itemKey(sessionId, messageId))
  await redis.sRem(indexKey(sessionId), messageId)
}

/** A session was deleted: every record and the index go with it. */
export async function sweepPostTurnRecords(sessionId: string): Promise<void> {
  if (!sessionId) return
  for (const messageId of (await redis.sMembers(indexKey(sessionId))) ?? []) {
    await redis.del(itemKey(sessionId, messageId))
  }
  await redis.del(indexKey(sessionId))
}
