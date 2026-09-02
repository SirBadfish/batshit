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
 * Two callers share it, which is exactly why it lives here rather than inside
 * `nativeTools.ts` (P2's original home):
 *   - the API path, through `formatBatshitToolUseModelOutput`, where the lane
 *     comes from the provider/model pair;
 *   - the managed CLI path (P3), through `/api/memory/recall-media`, where the
 *     lane comes from which CLI runtime launched the helper bridge.
 * Both must produce identical wording; a second implementation would drift.
 *
 * Byte loading is injected rather than imported, because the two callers
 * authorize differently: the API path is already inside an authorized run and
 * uses `loadMemoryMedia` directly, while the service-token route must go through
 * `loadManagedMemoryMedia`, which re-checks agent ownership.
 */

import {
  admitToolResultImages,
  type ToolResultImageLane
} from '../toolResultImageDelivery'

export const MEMORY_RECALL_CONTROL_ID = 'sys.memory.recall'

export interface RecallMediaPlanEntry {
  media_id: string
  filename: string
  mime_type: string
  bytes: number
  delivery?: 'in_turn' | 'next_message'
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
  }
): Promise<RecallMediaDeliveryResult | null> {
  if (!isRecallOutputWithMedia(output)) return null

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
    for (const entry of row.media as RecallMediaPlanEntry[]) {
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
  const decisions = new Map<string, { delivery: 'in_turn' | 'next_message'; reason?: string }>()
  for (const item of deferred) {
    decisions.set(item.candidate.id, { delivery: 'next_message', reason: item.reason })
  }

  const images: RecallDeliveredImage[] = []
  const inTurn: RecallMediaRecord['inTurn'] = []

  for (const candidate of admitted) {
    try {
      // Bytes are read HERE, at delivery time, never in the op — the Agent
      // Browser precedent. A memory deleted between the two degrades to a
      // next-message note instead of failing the send.
      const loaded = await options.loadBytes({
        memoryId: candidate.memoryId,
        mediaId: candidate.id
      })
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
      decisions.set(candidate.id, { delivery: 'next_message', reason: 'source_unavailable' })
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
        const later = media.filter((m) => m.delivery !== 'in_turn')
        const parts: string[] = []
        if (now.length > 0) {
          parts.push(
            `${now.length} image${now.length === 1 ? '' : 's'} available during THIS reply — look at ${now.length === 1 ? 'it' : 'them'} now.`
          )
        }
        if (later.length > 0) {
          const reasons = Array.from(new Set(later.map((m) => m.reason).filter(Boolean)))
          parts.push(
            `${later.length} image${later.length === 1 ? '' : 's'} arrive${later.length === 1 ? 's' : ''} in your REMEMBERED MEDIA with the next message${reasons.length ? ` (${reasons.join(', ')})` : ''}.`
          )
        }
        return { ...row, media, media_note: parts.join(' ') }
      })
    },
    // DL-105-12: byte-free truth for the Execution Viewer.
    recallMedia: {
      lane,
      inTurn,
      deferred: Array.from(decisions.entries())
        .filter(([, d]) => d.delivery === 'next_message')
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
