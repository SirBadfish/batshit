/**
 * SA-120 P5 — the server-side writer for zip state Batshit changes on a Judge Juice judgment.
 *
 * Zip state has three sources (`ZipStateSource`): `user`, `agent`, and `inferred`. This module
 * is the ONLY writer of `inferred`, and it writes the very keys the `/api/unzipping` routes
 * write, in the same shapes, so every reader (the compiler, the chat badges, the Zip Manager,
 * session deletion, backup) handles them with no new key and no new sweep:
 *
 *   unzipped:{sessionId}                 set of zip ids held open
 *   unzipped_item:{sessionId}:{zipId}    { …, source: 'inferred', permanent: false, duration, messageCount }
 *   rezipped:{sessionId}                 set of zip ids forced compressed
 *   rezipped_item:{sessionId}:{zipId}    { …, source: 'inferred', reason, toldAgent }
 *
 * Keys use the NORMALIZED zip id, because that is the id `compileForAI` looks zip state up by
 * (the chat badges and the Zip Manager look up both spellings). Callers pass and get back the
 * ids as they know them.
 *
 * Explicit beats inferred AT THE WRITE, not only at the decision: between a compile and the
 * accepted-send boundary the user or the agent may have acted on the same zip, so each write
 * re-reads the state it would replace and steps aside when someone else owns it. The re-read
 * and the write run under the chat's zip state lock (SA-129 P2b, BL-352), so no other writer
 * lands between them.
 */

import { redis } from '$lib/server/redis'
import { isZipStateSource, type UnzippedItem, type ZipStateSource } from '$lib/services/zipping'
import { normalizeId } from '$lib/utils/idNormalizer'
import { withZipStateLock } from './zipStateLock'
import { classifyStoredSkillReadZip } from '$lib/utils/skillReadZip'

export type InferredZipWriteSkipReason = 'source_unavailable' | 'unknown_source' | 'skill_lifecycle' | 'explicit_state'
export interface InferredZipWriteOptions {
  /** Route-owned receipt collector: the EV row reports why a proposed change did not apply. */
  onSkipped?: (skip: { zipId: string; reason: InferredZipWriteSkipReason }) => void
}

function reportSkipped(options: InferredZipWriteOptions | undefined, zipId: string, reason: InferredZipWriteSkipReason): void {
  if (reason === 'source_unavailable' || reason === 'unknown_source') {
    console.warn('[Judge Juice] Smart Zip left a result unchanged: its stored source could not be verified.', { zipId, reason })
  }
  try { options?.onSkipped?.({ zipId, reason }) } catch {
    console.warn('[Judge Juice] Smart Zip could not attach a skipped-change receipt.', { zipId, reason })
  }
}

/** A null-catching facade cannot prove non-skill identity. Read the source with the throwing owner. */
async function admitsNonSkillSource(zipId: string, options?: InferredZipWriteOptions): Promise<boolean> {
  let source: unknown
  try { source = await redis.json.get(`zip:${zipId}`) } catch {
    reportSkipped(options, zipId, 'source_unavailable')
    return false
  }
  const kind = classifyStoredSkillReadZip(source)
  if (kind === 'non_skill') return true
  reportSkipped(options, zipId, kind === 'skill' ? 'skill_lifecycle' : 'unknown_source')
  return false
}

export interface InferredUnzipInput {
  zipId: string
  description?: string
  name?: string
  tokens?: number
  /** Jev's probability, kept on the record so the badge tooltip and the Zip Manager can show it. */
  probability: number
  /** How many messages the zip stays open (the server's countdown burns it, `advanceZipCountdowns`). */
  durationMessages: number
}

export interface InferredRezipInput {
  zipId: string
  description?: string
  /** Jev's two post-turn answers, kept for the next turn's "Batshit zipped this" line. */
  done: number
  again: number
}

export interface InferredRezipMarker {
  zipId: string
  sessionId: string
  source: 'inferred'
  rezippedAt: number
  reason: 'jev_done_with_it'
  description: string
  done: number
  again: number
  /** False until a compile has told the agent; the accepted-send boundary flips it. */
  toldAgent: boolean
}

async function readStateSource(key: string): Promise<ZipStateSource | 'unknown' | null> {
  const raw = await redis.get(key)
  if (!raw) return null
  const source = (raw as { source?: unknown })?.source
  // A record with no readable source predates sources; treat it as someone's explicit act.
  return isZipStateSource(source) ? source : 'unknown'
}

/** The source of each rezip marker in a session (the compiler needs to know whose zip it is). */
export async function loadRezippedSources(
  sessionId: string,
  rezippedIds: string[]
): Promise<Record<string, ZipStateSource>> {
  const sources: Record<string, ZipStateSource> = {}
  for (const zipId of rezippedIds) {
    const source = await readStateSource(`rezipped_item:${sessionId}:${zipId}`)
    sources[zipId] = source === null || source === 'unknown' ? 'user' : source
  }
  return sources
}

/**
 * Holds zips open for a few messages as `source: 'inferred'`. Skips a zip that is already
 * unzipped by anyone, or that a user or an agent zipped by hand (only Jev's own earlier rezip
 * may be reopened by Jev). Returns the ids it really opened.
 */
export async function writeInferredUnzips(sessionId: string, items: InferredUnzipInput[], options?: InferredZipWriteOptions): Promise<string[]> {
  return withZipStateLock(sessionId, async () => {
    const written: string[] = []
    for (const item of items) {
      if (!item?.zipId) continue
      if (!await admitsNonSkillSource(item.zipId, options)) continue
      const zipId = normalizeId(item.zipId)
      const unzippedKey = `unzipped_item:${sessionId}:${zipId}`
      const rezippedKey = `rezipped_item:${sessionId}:${zipId}`
      if ((await readStateSource(unzippedKey)) !== null) {
        reportSkipped(options, item.zipId, 'explicit_state')
        continue
      }
      const rezippedBy = await readStateSource(rezippedKey)
      if (rezippedBy !== null && rezippedBy !== 'inferred') {
        reportSkipped(options, item.zipId, 'explicit_state')
        continue
      }

      const record: UnzippedItem & { inferredProbability: number } = {
        zipId,
        sessionId,
        permanent: false,
        duration: item.durationMessages,
        unzippedAt: Date.now(),
        messageCount: 0,
        ...(item.name ? { name: item.name } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(typeof item.tokens === 'number' ? { tokens: item.tokens } : {}),
        source: 'inferred',
        inferredProbability: item.probability
      }
      await redis.sAdd(`unzipped:${sessionId}`, zipId)
      await redis.sRem(`rezipped:${sessionId}`, zipId)
      await redis.del(rezippedKey)
      await redis.set(unzippedKey, record)
      written.push(item.zipId)
    }
    return written
  })
}

/**
 * Forces zips compressed as `source: 'inferred'`, the way agent zip control's `zip` action
 * does. Never touches a zip the USER or the AGENT holds open (a user unzip is a lock; an
 * agent unzip is the agent's own explicit choice), and never replaces a hand-made rezip.
 * Jev's own temporary unzip is closed. Returns the ids it really zipped.
 */
export async function writeInferredRezips(sessionId: string, items: InferredRezipInput[], options?: InferredZipWriteOptions): Promise<string[]> {
  return withZipStateLock(sessionId, async () => {
    const written: string[] = []
    for (const item of items) {
      if (!item?.zipId) continue
      if (!await admitsNonSkillSource(item.zipId, options)) continue
      const zipId = normalizeId(item.zipId)
      const unzippedKey = `unzipped_item:${sessionId}:${zipId}`
      const rezippedKey = `rezipped_item:${sessionId}:${zipId}`
      const unzippedBy = await readStateSource(unzippedKey)
      if (unzippedBy !== null && unzippedBy !== 'inferred') {
        reportSkipped(options, item.zipId, 'explicit_state')
        continue
      }
      if ((await readStateSource(rezippedKey)) !== null) {
        reportSkipped(options, item.zipId, 'explicit_state')
        continue
      }

      const marker: InferredRezipMarker = {
        zipId,
        sessionId,
        source: 'inferred',
        rezippedAt: Date.now(),
        reason: 'jev_done_with_it',
        description: item.description ?? '',
        done: item.done,
        again: item.again,
        toldAgent: false
      }
      await redis.sRem(`unzipped:${sessionId}`, zipId)
      await redis.del(unzippedKey)
      await redis.sAdd(`rezipped:${sessionId}`, zipId)
      await redis.set(rezippedKey, marker)
      written.push(item.zipId)
    }
    return written
  })
}

/** Jev's rezips the agent has not been told about yet, oldest first. */
export async function loadUntoldInferredRezips(sessionId: string): Promise<InferredRezipMarker[]> {
  const ids = (await redis.sMembers(`rezipped:${sessionId}`)) ?? []
  const markers: InferredRezipMarker[] = []
  for (const zipId of ids) {
    const raw = (await redis.get(`rezipped_item:${sessionId}:${zipId}`)) as Partial<InferredRezipMarker> | null
    if (!raw || raw.source !== 'inferred' || raw.toldAgent === true) continue
    markers.push({
      zipId,
      sessionId,
      source: 'inferred',
      rezippedAt: typeof raw.rezippedAt === 'number' ? raw.rezippedAt : 0,
      reason: 'jev_done_with_it',
      description: typeof raw.description === 'string' ? raw.description : '',
      done: typeof raw.done === 'number' ? raw.done : 0,
      again: typeof raw.again === 'number' ? raw.again : 0,
      toldAgent: false
    })
  }
  return markers.sort((a, b) => a.rezippedAt - b.rezippedAt)
}

/**
 * Marks Jev's rezips as told, once the send that told the agent was accepted. A marker that changed
 * hands meanwhile is left alone. `zipIds` are the state ids `loadUntoldInferredRezips` listed (the
 * `rezipped:` set's members), so they are used as they are: `normalizeId` cuts an all-digit tail
 * again, which missed the marker and told the agent the same rezip every turn (BL-1515 class).
 */
export async function markInferredRezipsTold(sessionId: string, zipIds: string[]): Promise<void> {
  await withZipStateLock(sessionId, async () => {
    for (const stateId of zipIds) {
      const key = `rezipped_item:${sessionId}:${stateId}`
      const raw = (await redis.get(key)) as Record<string, unknown> | null
      if (!raw || raw.source !== 'inferred') continue
      await redis.set(key, { ...raw, toldAgent: true })
    }
  })
}
