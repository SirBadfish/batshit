/**
 * BL-390: which zips go with a deleted message.
 *
 * A message CLAIMS a zip when it names it the way the rest of Batshit reads a message's zips
 * (`zipClaimsOfMessage`): its metadata (`collectTrustedZipIdsFromMetadata`: `zipIds`, `zip_ids`,
 * `zipReferences`; plus any string in `zipIds`), or a reference in its text
 * (`zipIdsNamedInText`: as trust and the chat view read it, `scanZipReferences`, which takes an
 * empty description, and the older `{{batshit|id:…|` shape, which the chat-load trust repair
 * trusts for same-chat text references). The chat delete reads the same claims (BL-1513) and
 * takes only the zips whose record names the chat (`zipsOfDeletedChat`, BL-1798).
 *
 * A zip of this chat (`metadata.sessionId`) goes when no other message of the chat claims it and
 * either its record says this message made it (`metadata.messageId`), or this message claims it
 * and the message that made it is no longer in the chat (it goes with the last message that
 * claims it). Everything else stays. Pure: the caller reads Redis (`redis.deleteMessage`, and the
 * default lane's fake in `vitest-setup.ts`).
 */

import { collectTrustedZipIdsFromMetadata, scanZipReferences } from './zipReferenceSafety'

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

/**
 * Every zip id a message's TEXT names: each reference as the trust reader reads it
 * (`scanZipReferences`, BL-609: an empty description included, which `zipService.ts` writes for
 * an empty one, BL-1513), then the older `{{batshit|id:…|` form. The chat delete
 * (`redis.deleteSession`) and a message delete count these as claims, so both stay a superset of
 * what trust and the chat view read. Read once each (BL-707).
 */
export function zipIdsNamedInText(content: string): string[] {
  if (typeof content !== 'string' || !content) return []
  const ids = new Set<string>()
  for (const reference of scanZipReferences(content)) ids.add(reference.id)
  for (const match of content.matchAll(OLD_ZIP_REFERENCE)) ids.add(match[1])
  return [...ids]
}

/** Every zip a stored message names, in its metadata or its text. */
export function zipClaimsOfMessage(message: unknown): string[] {
  if (!message || typeof message !== 'object') return []
  const record = message as Record<string, any>
  const ids = new Set<string>([
    ...readMessageZipIds(record.metadata?.zipIds),
    ...collectTrustedZipIdsFromMetadata(record.metadata)
  ])
  for (const id of zipIdsNamedInText(typeof record.content === 'string' ? record.content : '')) ids.add(id)
  return [...ids]
}

/**
 * BL-1798: the paths of a zip record that can name its chat, in the order the compile
 * (`zipBelongsToAnotherChat`) and the zip routes (`extractZipSessionId`) read them.
 */
export const ZIP_RECORD_CHAT_PATHS = [
  '$.metadata.sessionId',
  '$.metadata.session_id',
  '$.sessionId',
  '$.session_id'
] as const

/**
 * The chat a zip record names, from its `ZIP_RECORD_CHAT_PATHS` values in that order: the first
 * that is set, trimmed, as those readers take it (`??`); `null` when it names no chat.
 */
export function zipRecordChat(values: unknown[]): string | null {
  const value = values.find((entry) => entry !== undefined && entry !== null)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Every zip a message names for the chat delete: its claims plus the page-saved `zipMetadata`. */
export function zipCandidatesOfDeletedMessage(message: unknown): string[] {
  if (!message || typeof message !== 'object') return []
  const ids = new Set(zipClaimsOfMessage(message))
  const zipMetadata = (message as Record<string, any>).zipMetadata
  if (Array.isArray(zipMetadata)) {
    for (const entry of zipMetadata) {
      if (typeof entry?.zipId === 'string' && entry.zipId.length > 0) ids.add(entry.zipId)
    }
  }
  return [...ids]
}

/**
 * BL-1798: which zips go with a deleted chat. The candidates are the chat's own zip set
 * (`session:{id}:zips`, which only the server's zip writers fill, for the chat they write for)
 * and every zip its messages name (`zipCandidatesOfDeletedMessage`). A message's words and
 * metadata are no proof of whose a zip is: the older `{{batshit|id:…|` form and a reply saved
 * through `saveMessage` (the LiveKit voice transcript) keep another chat's reference as written,
 * and a tab posts `zipMetadata` and `metadata.zipIds`. So a zip goes when its record names this
 * chat (`recordedSessionId`, `zipRecordChat`), never when it names another chat, and a record that
 * names no chat (a missing key, a key that is not JSON, or an older record) goes only when this
 * chat's own set lists it.
 */
export function zipsOfDeletedChat(input: {
  sessionId: string
  /** The chat's `session:{id}:zips` members. */
  setMembers: Iterable<string>
  /** Every candidate with the chat its record names (`null` for none). */
  zips: Array<{ zipId: string; recordedSessionId: string | null }>
}): string[] {
  const listed = new Set(input.setMembers)
  const owned = new Set<string>()
  for (const zip of input.zips) {
    if (zip.recordedSessionId === input.sessionId) owned.add(zip.zipId)
    else if (zip.recordedSessionId === null && listed.has(zip.zipId)) owned.add(zip.zipId)
  }
  return [...owned].sort()
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
