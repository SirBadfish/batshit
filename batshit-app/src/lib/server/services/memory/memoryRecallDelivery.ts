import { randomBytes } from 'node:crypto'
import { assertSettingsLifecycle, type SettingsLifecycleSnapshot } from '../appActions/settings/lifecycle'
import { readMemoryObservation, type MemoryOwnerProof } from './memoryOwnership'
import { memoryIsEligible, memoryIsExpired } from './memoryState'
import type { MemoryRecord } from './memoryTypes'
import { withMemoryDeliveryAdmission } from './memoryDeliveryAdmission'
/**
 * SA-105 — finalize a memory-recall result's media plan for ONE run.
 *
 * The recall op emits only byte-free facts (DL-105-04): it has no provider or
 * runtime knowledge, so it cannot say whether an image arrives now or next
 * message. This module is where the lane IS known, so this is where the plan
 * gains `delivery`/`reason` and where the per-memory `media_note` is written —
 * one source of truth, so the model never reads "arrives next message" about an
 * image sitting right there in the same tool result (DL-105-08).
 *
 * The API model-output formatter owns this delivery; bytes are injected only after
 * its original recall admission and fresh ownership checks.
 */

import {
  admitToolResultImages,
  type ToolResultImageLane
} from '../toolResultImageDelivery'

export class MemoryRecallAdmissionError extends Error { readonly status = 403; readonly code = 'MEMORY_RECALL_ADMISSION_INVALID' }

type RecallMediaPermit = {
  userId: string; agentId: string; sessionId: string; lifecycle: SettingsLifecycleSnapshot
  includeExpired: boolean; expires: number
  agentOwner: MemoryOwnerProof; sessionOwner: MemoryOwnerProof
  records: Array<{ id: string; expired: boolean; media?: Array<{ media_id: string; filename: string; mime_type: string; bytes: number }> }>
}
const recallMediaPermits = new Map<string, RecallMediaPermit>()

/** The original typed recall input owns this short-lived, process-only delivery intent. */
export function createRecallMediaPermit(input: Omit<RecallMediaPermit, 'expires'>): string {
  const now = Date.now()
  for (const [token, permit] of recallMediaPermits) if (permit.expires <= now) recallMediaPermits.delete(token)
  if (recallMediaPermits.size >= 256) throw new Error('Memory photo delivery is busy; no new delivery was admitted.')
  const token = randomBytes(24).toString('base64url')
  recallMediaPermits.set(token, {
    userId: input.userId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    lifecycle: { epoch: input.lifecycle.epoch, records: input.lifecycle.records.map(([key, revision]) => [key, revision] as [string, string]) },
    includeExpired: input.includeExpired,
    agentOwner: { id: input.agentOwner.id, userId: input.agentOwner.userId, storage: input.agentOwner.storage, created: input.agentOwner.created },
    sessionOwner: { id: input.sessionOwner.id, userId: input.sessionOwner.userId, storage: input.sessionOwner.storage, created: input.sessionOwner.created },
    expires: now + 5 * 60_000,
    records: input.records.map(record => ({
      id: record.id,
      expired: record.expired,
      ...(record.media ? { media: record.media.map(media => ({ media_id: media.media_id, filename: media.filename, mime_type: media.mime_type, bytes: media.bytes })) } : {})
    }))
  })
  return token
}

export function requireRecallMediaPermit(output: any, actor?: { userId: string; agentId: string; sessionId: string }): RecallMediaPermit {
  const token = output?.result?.recall_media_token
  const permit = typeof token === 'string' ? recallMediaPermits.get(token) : undefined
  if (!permit || permit.expires <= Date.now() || !actor || permit.userId !== actor.userId || permit.agentId !== actor.agentId || !actor.sessionId || permit.sessionId !== actor.sessionId) {
    throw new MemoryRecallAdmissionError('This memory photo delivery has no current recall admission.')
  }
  assertSettingsLifecycle(permit.lifecycle)
  return permit
}

async function assertCurrentDelivery(permit: RecallMediaPermit, memoryId: string, mediaId: string) {
  const current = await readMemoryObservation({ agentId: permit.agentId, userId: permit.userId, sessionId: permit.sessionId,
    lifecycle: permit.lifecycle, expectedAgent: permit.agentOwner, expectedSession: permit.sessionOwner, memoryIds: [memoryId], requireEnabled: true })
  const record = current.records.get(memoryId)
  if (!record || !memoryIsEligible(record, permit.includeExpired, current.nowTs) || !record.media?.some(media => media.id === mediaId)) throw new Error('This memory photo is no longer eligible for delivery.')
  return record
}

export const MEMORY_RECALL_CONTROL_ID = 'sys.memory.recall'

export interface RecallMediaPlanEntry {
  media_id: string
  filename: string
  mime_type: string
  bytes: number
  delivery?: 'in_turn' | 'next_message' | 'unavailable'
  reason?: string
}

export interface RecallDeliveredImage {
  mediaType: string
  /** Base64 bytes. */
  data: string
  filename?: string | null
}

export interface RecallMediaRecord {
  lane: ToolResultImageLane
  inTurn: Array<{ memoryId: string; mediaId: string; filename: string; bytes: number }>
  deferred: Array<{ memoryId: string; mediaId: string; reason: string }>
}

export interface RecallMediaDeliveryResult {
  /** The tool payload with `delivery`, `reason` and `media_note` filled in. */
  output: any
  images: RecallDeliveredImage[]
  /** Byte-free truth for the Execution Viewer (DL-105-12). */
  record: RecallMediaRecord
}

export type RecallMediaByteLoader = (input: {
  memoryId: string
  mediaId: string
}) => Promise<{ bytes: Uint8Array }>

/** True when this tool payload is a memory recall carrying at least one image. */
export function isRecallOutputWithMedia(output: any): boolean {
  if (!output || typeof output !== 'object') return false
  const target =
    typeof output.target === 'string'
      ? output.target
      : typeof output.controlId === 'string'
        ? output.controlId
        : ''
  if (target !== MEMORY_RECALL_CONTROL_ID) return false
  const recalled = output?.result?.recalled
  if (!Array.isArray(recalled)) return false
  return recalled.some((row: any) => Array.isArray(row?.media) && row.media.length > 0)
}

/**
 * Apply the lane to a recall result: decide per image, load bytes for whatever
 * arrives in-turn, and write the notes.
 *
 * Returns `null` when the payload is not a recall with media, so callers can
 * keep their existing output untouched — a recall with no media must stay
 * byte-identical to pre-SA-105 behaviour (DL-105-13).
 *
 * The input object is never mutated: it is the payload that gets persisted, and
 * it must stay byte-free.
 */
export async function applyRecallMediaDelivery(
  output: any,
  options: {
    lane: ToolResultImageLane
    loadBytes: RecallMediaByteLoader
    actor?: { userId: string; agentId: string; sessionId: string }
  }
): Promise<RecallMediaDeliveryResult | null> {
  if (!isRecallOutputWithMedia(output)) return null

  const permit = requireRecallMediaPermit(output, options.actor)
  const recalled = output.result.recalled as any[]
  const withMedia = recalled.filter((row: any) => Array.isArray(row?.media) && row.media.length > 0)
  const lane = options.lane

  // Memory order, then media order within each memory (DL-105-07).
  const candidates: Array<{
    id: string
    mediaType: string
    bytes: number
    filename: string
    memoryId: string
    entry: RecallMediaPlanEntry
  }> = []
  for (const row of withMedia) {
    const admittedRow = permit.records.find(record => record.id === row.id)
    if (!admittedRow) throw new Error('Recall photo plan does not match its original input.')
    for (const supplied of row.media as RecallMediaPlanEntry[]) {
      const entry = admittedRow.media?.find(media => media.media_id === supplied.media_id)
      if (!entry) throw new Error('Recall photo is outside its original admission.')
      candidates.push({
        id: entry.media_id,
        mediaType: entry.mime_type,
        bytes: entry.bytes,
        filename: entry.filename,
        memoryId: row.id,
        entry
      })
    }
  }

  const { admitted, deferred } = admitToolResultImages(candidates, { lane })
  const decisions = new Map<string, { delivery: 'in_turn' | 'next_message' | 'unavailable'; reason?: string }>()
  for (const item of deferred) {
    try {
      const current = await assertCurrentDelivery(permit, item.candidate.memoryId, item.candidate.id)
      decisions.set(item.candidate.id, { delivery: memoryIsExpired(current) ? 'unavailable' : 'next_message', reason: item.reason })
    } catch { decisions.set(item.candidate.id, { delivery: 'unavailable', reason: 'source_unavailable' }) }
  }

  const images: RecallDeliveredImage[] = []
  const inTurn: RecallMediaRecord['inTurn'] = []

  for (const candidate of admitted) {
    try {
      // Bytes are read HERE, at delivery time, never in the op — the Agent
      // Browser precedent. A memory deleted between the two degrades to a
      // next-message note instead of failing the send.
      await assertCurrentDelivery(permit, candidate.memoryId, candidate.id)
      const loaded = await withMemoryDeliveryAdmission({ agentId: permit.agentId, userId: permit.userId, sessionId: permit.sessionId, agentOwner: permit.agentOwner, sessionOwner: permit.sessionOwner, memoryId: candidate.memoryId, includeExpired: permit.includeExpired, lifecycle: permit.lifecycle }, () => options.loadBytes({ memoryId: candidate.memoryId, mediaId: candidate.id }))
      await assertCurrentDelivery(permit, candidate.memoryId, candidate.id)
      const base64 = Buffer.from(loaded.bytes).toString('base64')
      images.push({ mediaType: candidate.mediaType, data: base64, filename: candidate.filename })
      inTurn.push({
        memoryId: candidate.memoryId,
        mediaId: candidate.id,
        filename: candidate.filename,
        bytes: candidate.bytes
      })
      decisions.set(candidate.id, { delivery: 'in_turn' })
    } catch {
      decisions.set(candidate.id, { delivery: 'unavailable', reason: 'source_unavailable' })
    }
  }

  const nextOutput = {
    ...output,
    result: {
      ...output.result,
      recalled: recalled.map((row: any) => {
        if (!Array.isArray(row?.media) || row.media.length === 0) return row
        const media = (row.media as RecallMediaPlanEntry[]).map((entry) => {
          const decision = decisions.get(entry.media_id) ?? {
            delivery: 'next_message' as const,
            reason: 'lane_none'
          }
          return {
            ...entry,
            delivery: decision.delivery,
            ...(decision.reason ? { reason: decision.reason } : {})
          }
        })
        const now = media.filter((m) => m.delivery === 'in_turn')
        const later = media.filter((m) => m.delivery === 'next_message')
        const unavailable = media.filter((m) => m.delivery === 'unavailable')
        const parts: string[] = []
        if (now.length > 0) {
          parts.push(
            `${now.length} image${now.length === 1 ? '' : 's'} available during THIS reply — look at ${now.length === 1 ? 'it' : 'them'} now.`
          )
        }
        if (later.length > 0) {
          const reasons = Array.from(new Set(later.map((m) => m.reason).filter(Boolean)))
          parts.push(
            `${later.length} image${later.length === 1 ? '' : 's'} arrive${later.length === 1 ? 's' : ''} in your remembered_media with the next message${reasons.length ? ` (${reasons.join(', ')})` : ''}.`
          )
        }
        if (unavailable.length) {
          const reasons = Array.from(new Set(unavailable.map(image => image.reason).filter(Boolean)))
          parts.push(`${unavailable.length} image${unavailable.length === 1 ? ' is' : 's are'} unavailable for this reply${reasons.length ? ` (${reasons.join(', ')})` : ''}; no later delivery is queued for these images.`)
        }
        return { ...row, media, media_note: parts.join(' ') }
      })
    },
    // DL-105-12: byte-free truth for the Execution Viewer.
    recallMedia: {
      lane,
      inTurn,
      deferred: Array.from(decisions.entries())
        .filter(([, d]) => d.delivery !== 'in_turn')
        .map(([mediaId, d]) => {
          const candidate = candidates.find((c) => c.id === mediaId)
          return {
            memoryId: candidate?.memoryId ?? 'unknown',
            mediaId,
            reason: d.reason ?? 'lane_none'
          }
        })
    } satisfies RecallMediaRecord
  }

  return { output: nextOutput, images, record: nextOutput.recallMedia }
}
