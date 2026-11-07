/**
 * SA-137 P4 (D9, D10): a Read File copy that the chat's newest reply showed as a file snapshot
 * (live file reads), for the zip badges and the Zip Manager.
 *
 * The server compiled that reply with the file as it was when the reply started, at a size the
 * prompt size guard (10,000 large, 25,000 too large) already judged. So a badge judges the same
 * size, not the stored one: `withLiveSnapshotSize` hands activation the snapshot's size, while the
 * badge's own token label keeps the stored size. A static copy (the stored text was shown) and a
 * chat with no current receipt change nothing here.
 *
 * Round 2 (strict freshness): a Read File copy the newest reply's compile did NOT refresh was zipped
 * that turn, held or not, so under a `strict` receipt a `static` copy is a `not-refreshed` snapshot.
 * It draws compressed whatever its buffer, Hold or Off says, and its tooltip says why. A `static`
 * copy under a receipt that is not strict (an older reply, or the setting changed) changes nothing.
 */

import type { LiveReadCopyFact, LiveReadDeliveryFact } from './liveFileReadFacts'
import type { ZipLikeMetadata } from './zipActivation'

export type ZipLiveSnapshot =
  /** `issued` once the reply's first model request was sent with the snapshot. */
  | { delivery: LiveReadDeliveryFact; promptTokens: number }
  /** No usable record says whether the newest reply refreshed this copy. */
  | { delivery: 'unknown' }
  /** The newest reply's compile zipped this copy instead of refreshing it (strict freshness), and why. */
  | { delivery: 'not-refreshed'; reason: string }

/** A snapshot that carries the size the newest reply's size guard judged. */
export type ZipLiveSnapshotWithSize = Extract<ZipLiveSnapshot, { promptTokens: number }>

/**
 * The snapshot of a `refreshed` copy fact, `unknown` for an unknown one, `not-refreshed` for a
 * `static` copy of a current, strict receipt, null for any other static copy or no fact.
 */
export function liveSnapshotFromFact(
  fact: (LiveReadCopyFact & { delivery: LiveReadDeliveryFact | null; strict?: boolean }) | null | undefined
): ZipLiveSnapshot | null {
  if (fact?.status === 'unknown') return { delivery: 'unknown' }
  if (fact?.status === 'static') {
    return fact.strict === true && fact.delivery ? { delivery: 'not-refreshed', reason: fact.reason } : null
  }
  return fact?.status === 'refreshed' && fact.delivery ? { delivery: fact.delivery, promptTokens: fact.promptTokens } : null
}

/** Whether this snapshot carries the size the newest reply judged (a refreshed copy). */
export function snapshotHasSize(snapshot: ZipLiveSnapshot | null | undefined): snapshot is ZipLiveSnapshotWithSize {
  return Boolean(snapshot) && snapshot!.delivery !== 'unknown' && snapshot!.delivery !== 'not-refreshed'
}

/**
 * Whether this copy draws compressed whatever its buffer, Hold or Off says: the newest reply's
 * compile zipped it instead of showing it. One rule for the chat badge and the Zip Manager.
 */
export function snapshotCompressesCopy(snapshot: ZipLiveSnapshot | null | undefined): boolean {
  return snapshot?.delivery === 'not-refreshed'
}

/**
 * The zip data activation should read: the snapshot's size in every field the prompt size guard
 * and the token fallbacks look at. Without a snapshot the same object comes back untouched.
 */
export function withLiveSnapshotSize(
  zipData: ZipLikeMetadata | null | undefined,
  snapshot: ZipLiveSnapshot | null
): ZipLikeMetadata | null | undefined {
  // An unknown or not-refreshed copy keeps its stored size: nothing says what the newest reply's
  // size guard saw (it showed no text of this copy).
  if (!snapshotHasSize(snapshot)) return zipData
  const tokens = snapshot.promptTokens
  return {
    ...(zipData ?? {}),
    tokens,
    promptTokens: tokens,
    aiTokens: tokens,
    metadata: { ...(zipData?.metadata ?? {}), tokens, promptTokens: tokens, aiTokens: tokens }
  }
}

/** The size the newest reply's size guard judged, or undefined when there is none to use. */
export function liveSnapshotTokens(snapshot: ZipLiveSnapshot | null | undefined): number | undefined {
  return snapshotHasSize(snapshot) ? snapshot.promptTokens : undefined
}
