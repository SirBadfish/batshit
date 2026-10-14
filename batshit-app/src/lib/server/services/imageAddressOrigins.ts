/**
 * BL-474 step 2: where each outside picture address of a reply came from, kept beside the reply by
 * the server (the `codexCleanupWarnings.ts` pattern). It is not part of the message: a browser's
 * save of the reply cannot change it, and the page only reads it.
 *
 * image_origins:{sessionId}                   set of reply ids
 * image_origin:{sessionId}:{messageId}        one record (`imageOriginRecord.ts`)
 *
 * Both live as long as their chat and reply, with no TTL: the reply delete and the chat delete sweep
 * them, and backup carries them in the `chats` group. Every write goes through
 * `redis.writeImageOriginRecord` (one Lua step: the chat, its owner, the reply for a decided record,
 * and the version).
 */
import { redis } from '$lib/server/redis'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { isSessionDeleting } from '$lib/server/services/streamAbortRegistry'
import { escapeRedisGlob } from '$lib/utils/redisGlob'
import {
  readImageOriginRecord,
  type DecidedImageOriginRecord,
  type ImageOriginRecord
} from '$lib/utils/imageOriginRecord'

const indexKey = (sessionId: string) => `image_origins:${sessionId}`
const itemKey = (sessionId: string, messageId: string) => `image_origin:${sessionId}:${messageId}`

/** The version of a reply's first end; an approval resume uses its own, larger, version. */
export const FIRST_IMAGE_ORIGIN_VERSION = 1

/**
 * The reply's run starts: its record is pending until its end decides. A chat being deleted, a
 * missing chat, or a newer record writes nothing. Throws only when Redis fails.
 */
export async function markImageOriginPending(input: {
  userId: string
  sessionId: string
  messageId: string
  version: number
}): Promise<void> {
  const { userId, sessionId, messageId, version } = input
  if (!userId || !sessionId || !messageId || isSessionDeleting(sessionId)) return
  await redis.writeImageOriginRecord({
    userId,
    sessionId,
    messageId,
    version,
    state: 'pending',
    record: { messageId, version, state: 'pending' }
  })
}

/**
 * The reply's end decided: write it (never over a newer version) and tell the tabs showing the chat.
 * Answers whether it was stored; throws only when Redis fails.
 */
export async function writeImageOriginDecision(input: {
  userId: string
  sessionId: string
  record: DecidedImageOriginRecord
}): Promise<boolean> {
  const { userId, sessionId, record } = input
  if (!userId || !sessionId || isSessionDeleting(sessionId)) return false
  const validated = readImageOriginRecord(record, record.messageId)
  if (!validated || validated.state !== 'decided') {
    throw new Error(`The image origin decision for reply ${record.messageId} is malformed.`)
  }
  const answer = await redis.writeImageOriginRecord({
    userId,
    sessionId,
    messageId: validated.messageId,
    version: validated.version,
    state: 'decided',
    record: validated
  })
  if (answer !== 'ok') {
    console.warn('[Image origin] The decision was not stored:', { sessionId, messageId: validated.messageId, answer })
    return false
  }
  // A reply with no picture has nothing on screen to change.
  if (Object.keys(validated.addresses).length > 0) {
    await publishUserEvent(userId, { type: 'image_origin_changed', sessionId, messageId: validated.messageId })
  }
  return true
}

function readIndexedRecord(value: unknown, sessionId: string, messageId: string): ImageOriginRecord {
  if (value === null || value === undefined) {
    throw new Error(`The image origin index for chat ${sessionId} names missing reply ${messageId}.`)
  }
  const record = readImageOriginRecord(value, messageId)
  if (!record) {
    throw new Error(`The image origin index for chat ${sessionId} names malformed reply ${messageId}.`)
  }
  return record
}

/**
 * Read the full index for the chat view, or only explicit history reply ids on the reply-end
 * hot path. Indexed corruption is an error, never indistinguishable from a pre-feature absence.
 */
export async function loadImageOrigins(
  sessionId: string,
  options?: { messageIds: readonly string[] }
): Promise<Record<string, ImageOriginRecord>> {
  const records: Record<string, ImageOriginRecord> = {}
  if (!sessionId) return records
  const requestedIds = options
    ? [...new Set(options.messageIds.filter((messageId) => typeof messageId === 'string' && messageId.length > 0))]
    : null
  if (requestedIds && requestedIds.length === 0) return records
  return redis.execute(async (client) => {
    if (requestedIds) {
      // Only inspect membership and record keys for the history ids the compiler actually used.
      const membership = await Promise.all(
        requestedIds.map((messageId) => client.sIsMember(indexKey(sessionId), messageId))
      )
      const indexedIds = requestedIds.filter((_messageId, index) => membership[index])
      const values = await Promise.all(
        indexedIds.map(async (messageId) => [
          messageId,
          await client.json.get(itemKey(sessionId, messageId))
        ] as const)
      )
      for (const [messageId, value] of values) {
        records[messageId] = readIndexedRecord(value, sessionId, messageId)
      }
      return records
    }

    const messageIds = [...new Set(await client.sMembers(indexKey(sessionId)))]
    const values = await Promise.all(
      messageIds.map(async (messageId) => [
        messageId,
        await client.json.get(itemKey(sessionId, messageId))
      ] as const)
    )
    for (const [messageId, value] of values) {
      records[messageId] = readIndexedRecord(value, sessionId, messageId)
    }
    return records
  })
}

export async function deleteImageOrigin(sessionId: string, messageId: string): Promise<void> {
  if (!sessionId || !messageId) return
  await redis.execute(async (client) => {
    // An index removal failure keeps the valid record. A later delete failure leaves only an
    // invisible orphan, which the chat's pattern sweep removes; never a missing indexed record.
    await client.sRem(indexKey(sessionId), messageId)
    await client.del(itemKey(sessionId, messageId))
  })
}

export async function sweepImageOrigins(sessionId: string): Promise<void> {
  if (!sessionId) return
  await redis.execute(async (client) => {
    // A failed earlier SADD can leave a record outside the index; sweep by escaped key pattern.
    const keys = await client.keys(`image_origin:${escapeRedisGlob(sessionId)}:*`)
    if (keys.length > 0) await client.del(keys as [string, ...string[]])
    await client.del(indexKey(sessionId))
  })
}
