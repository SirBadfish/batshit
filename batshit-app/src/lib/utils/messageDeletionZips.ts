/**
 * BL-390: which zips go with a deleted message.
 *
 * A message CLAIMS a zip when it names it the way the rest of Batshit reads a message's zips
 * (`zipClaimsOfMessage`): its metadata (`collectTrustedZipIdsFromMetadata`: `zipIds`, `zip_ids`,
 * `zipReferences`; plus any string in `zipIds`), or a reference in its text, read like the chat
 * delete reads it (`scanDeletionSweepZipReferences`) and as the chat view reads it
 * (`scanZipReferences`, which takes an empty description), and the older `{{batshit|id:…|` shape
 * (the chat-load trust repair trusts same-chat text references).
 *
 * A zip of this chat (`metadata.sessionId`) goes when no other message of the chat claims it and
 * either its record says this message made it (`metadata.messageId`), or this message claims it
 * and the message that made it is no longer in the chat (it goes with the last message that
 * claims it). Everything else stays. Pure: the caller reads Redis (`redis.deleteMessage`, and the
 * default lane's fake in `vitest-setup.ts`).
 */

import {
  collectTrustedZipIdsFromMetadata,
  scanDeletionSweepZipReferences,
  scanZipReferences
} from './zipReferenceSafety'

export interface ZipOwnership {
  zipId: string
  /** The zip record's `metadata.messageId`, or `undefined` when the record is gone. */
  messageId: unknown
  /** The zip record's `metadata.sessionId`. */
  sessionId: unknown
}

/** The ids in a message's `metadata.zipIds` (anything else reads as none). */
export function readMessageZipIds(zipIds: unknown): string[] {
  if (!Array.isArray(zipIds)) return []
  return zipIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

const OLD_ZIP_REFERENCE = /\{\{batshit\|id:([^|]+)\|/g

/** Every zip a stored message names, in its metadata or its text. */
export function zipClaimsOfMessage(message: unknown): string[] {
  if (!message || typeof message !== 'object') return []
  const record = message as Record<string, any>
  const ids = new Set<string>([
    ...readMessageZipIds(record.metadata?.zipIds),
    ...collectTrustedZipIdsFromMetadata(record.metadata)
  ])
  const content = typeof record.content === 'string' ? record.content : ''
  if (content) {
    for (const reference of scanDeletionSweepZipReferences(content)) ids.add(reference.id)
    // The chat view's reader too, which takes an empty description (`{{batshit-zip:id:::}}`).
    for (const reference of scanZipReferences(content)) ids.add(reference.id)
    for (const match of content.matchAll(OLD_ZIP_REFERENCE)) ids.add(match[1])
  }
  return [...ids]
}

/**
 * A `JSON.MGET` answer for one key read with a `$` path: an array of matches, or `null` for a
 * missing key (or a key that is not JSON). The first match, or `undefined`.
 */
export function firstJsonPathMatch(reply: unknown): unknown {
  if (Array.isArray(reply)) return reply.length > 0 ? reply[0] : undefined
  return undefined
}

export function zipsOwnedOnlyByMessage(input: {
  messageId: string
  sessionId: string
  zips: ZipOwnership[]
  /** The message being deleted (null when it is already gone). */
  message: unknown
  /** The ids of every OTHER message still in the chat. */
  otherMessageIds: string[]
  /** Every OTHER message of the chat, as stored (null for one that is gone). */
  otherMessages: unknown[]
}): string[] {
  const claimedHere = new Set(zipClaimsOfMessage(input.message))
  const others = new Set(input.otherMessageIds)
  const claimedElsewhere = new Set<string>()
  for (const other of input.otherMessages) {
    for (const id of zipClaimsOfMessage(other)) claimedElsewhere.add(id)
  }
  const owned = new Set<string>()
  for (const zip of input.zips) {
    if (zip.sessionId !== input.sessionId) continue
    const madeHere = zip.messageId === input.messageId
    const makerGone =
      claimedHere.has(zip.zipId) && !(typeof zip.messageId === 'string' && others.has(zip.messageId))
    if (!madeHere && !makerGone) continue
    if (claimedElsewhere.has(zip.zipId)) continue
    owned.add(zip.zipId)
  }
  return [...owned].sort()
}

/**
 * BL-775: the zips a message made that no message of its chat claims, the message itself
 * included, among `candidates`. A reply the finalize saved from its own copy (its stream record
 * could not be had) does not name the zips the stream path made for it; those go, by the same
 * claim rules as a message delete (BL-390), so no zip is left without a reference.
 */
export function unclaimedZipsMadeByMessage(input: {
  messageId: string
  sessionId: string
  zips: ZipOwnership[]
  /** Every message of the chat, the maker included, as stored (null for one that is gone). */
  chatMessages: unknown[]
}): string[] {
  const claimed = new Set<string>()
  for (const message of input.chatMessages) {
    for (const id of zipClaimsOfMessage(message)) claimed.add(id)
  }
  return input.zips
    .filter((zip) => zip.sessionId === input.sessionId && zip.messageId === input.messageId && !claimed.has(zip.zipId))
    .map((zip) => zip.zipId)
    .sort()
}
