/**
 * SA-105 — the shared recall-media finalizer.
 *
 * This module is the one place that decides, per image, whether it arrives now
 * or next message, and the one place that writes the words the model reads about
 * it. Both the API path (`nativeTools`) and the managed CLI route
 * (`/api/memory/recall-media`) run it, so a change here changes both lanes; that
 * is the point, and these tests pin the contract they share.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  applyRecallMediaDelivery,
  isRecallOutputWithMedia,
  MEMORY_RECALL_CONTROL_ID
} from '../memoryRecallDelivery'

function recallPayload(options?: {
  media?: Array<{ media_id: string; filename?: string; mime_type?: string; bytes?: number }>
  extraMemoryWithoutMedia?: boolean
  idKey?: 'target' | 'controlId'
}) {
  const media = (options?.media ?? [
    { media_id: 'media-1', filename: 'maggie.png', mime_type: 'image/png', bytes: 2048 }
  ]).map((entry) => ({
    media_id: entry.media_id,
    filename: entry.filename ?? `${entry.media_id}.png`,
    mime_type: entry.mime_type ?? 'image/png',
    bytes: entry.bytes ?? 2048
  }))

  const recalled: any[] = [
    { id: 'mem-1', lane: 'ltm', content: 'Maggie is my dog.', media }
  ]
  if (options?.extraMemoryWithoutMedia) {
    recalled.push({ id: 'mem-2', lane: 'stm', content: 'No picture here.' })
  }

  const idKey = options?.idKey ?? 'target'
  return {
    success: true,
    [idKey]: MEMORY_RECALL_CONTROL_ID,
    ref: `fabric:${MEMORY_RECALL_CONTROL_ID}`,
    family: 'fabric',
    result: { recalled }
  } as any
}

const loadOk = async () => ({ bytes: new Uint8Array([1, 2, 3, 4]) })

describe('isRecallOutputWithMedia', () => {
  it('matches a recall carrying media through either id field', () => {
    expect(isRecallOutputWithMedia(recallPayload())).toBe(true)
    expect(isRecallOutputWithMedia(recallPayload({ idKey: 'controlId' }))).toBe(true)
  })

  it('rejects anything that is not a recall with media', () => {
    expect(isRecallOutputWithMedia(null)).toBe(false)
    expect(isRecallOutputWithMedia({ target: 'sys.memory.search', result: { recalled: [] } })).toBe(
      false
    )
    expect(
      isRecallOutputWithMedia({
        target: MEMORY_RECALL_CONTROL_ID,
        result: { recalled: [{ id: 'mem-1', media: [] }] }
      })
    ).toBe(false)
  })
})

describe('applyRecallMediaDelivery', () => {
  it('returns null for a recall with no media so the payload stays byte-identical (DL-105-13)', async () => {
    const output = { target: MEMORY_RECALL_CONTROL_ID, result: { recalled: [{ id: 'mem-1' }] } }
    const loadBytes = vi.fn(loadOk)

    expect(await applyRecallMediaDelivery(output, { lane: 'tool_result', loadBytes })).toBeNull()
    expect(loadBytes).not.toHaveBeenCalled()
  })

  it('delivers in-turn on a tool_result lane and says so in the note', async () => {
    const payload = recallPayload({ extraMemoryWithoutMedia: true })
    const result = await applyRecallMediaDelivery(payload, {
      lane: 'tool_result',
      loadBytes: loadOk
    })

    expect(result).not.toBeNull()
    expect(result!.images).toEqual([
      { mediaType: 'image/png', data: Buffer.from([1, 2, 3, 4]).toString('base64'), filename: 'maggie.png' }
    ])

    const row = result!.output.result.recalled[0]
    expect(row.media[0].delivery).toBe('in_turn')
    expect(row.media[0].reason).toBeUndefined()
    expect(row.media_note).toContain('available during THIS reply')
    expect(row.media_note).not.toContain('next message')

    // A memory with no media is passed through untouched — no note, no fields.
    expect(result!.output.result.recalled[1]).toEqual({
      id: 'mem-2',
      lane: 'stm',
      content: 'No picture here.'
    })
  })

  it('defers everything with lane_none on the Claude CLI lane and never loads bytes', async () => {
    const loadBytes = vi.fn(loadOk)
    const result = await applyRecallMediaDelivery(recallPayload(), { lane: 'none', loadBytes })

    expect(result).not.toBeNull()
    expect(result!.images).toEqual([])
    expect(loadBytes).not.toHaveBeenCalled()

    const row = result!.output.result.recalled[0]
    expect(row.media[0]).toMatchObject({ delivery: 'next_message', reason: 'lane_none' })
    expect(row.media_note).toContain('REMEMBERED MEDIA with the next message')
    expect(row.media_note).toContain('lane_none')
    expect(row.media_note).not.toContain('THIS reply')
    expect(result!.record).toEqual({
      lane: 'none',
      inTurn: [],
      deferred: [{ memoryId: 'mem-1', mediaId: 'media-1', reason: 'lane_none' }]
    })
  })

  it('never mutates the payload it was handed, because that object gets persisted', async () => {
    const payload = recallPayload()
    const before = JSON.stringify(payload)

    await applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes: loadOk })

    expect(JSON.stringify(payload)).toBe(before)
  })

  it('degrades one unloadable image to next_message instead of failing the turn', async () => {
    const payload = recallPayload({
      media: [
        { media_id: 'media-1' },
        { media_id: 'media-2' }
      ]
    })
    const loadBytes = vi.fn(async ({ mediaId }: { mediaId: string }) => {
      if (mediaId === 'media-2') throw new Error('gone')
      return { bytes: new Uint8Array([9]) }
    })

    const result = await applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes })

    expect(result!.images).toHaveLength(1)
    const media = result!.output.result.recalled[0].media
    expect(media[0].delivery).toBe('in_turn')
    expect(media[1]).toMatchObject({ delivery: 'next_message', reason: 'source_unavailable' })
    expect(result!.output.result.recalled[0].media_note).toContain('source_unavailable')
  })

  it('applies the shared caps: unsupported MIME and over-count both defer with a reason', async () => {
    const payload = recallPayload({
      media: [
        { media_id: 'm1' },
        { media_id: 'm2' },
        { media_id: 'm3' },
        { media_id: 'm4' },
        { media_id: 'm5' },
        { media_id: 'bad', mime_type: 'image/tiff' },
        { media_id: 'huge', bytes: 50 * 1024 * 1024 }
      ]
    })

    const result = await applyRecallMediaDelivery(payload, {
      lane: 'tool_result',
      loadBytes: loadOk
    })

    expect(result!.images).toHaveLength(4)
    const byId = new Map(
      result!.output.result.recalled[0].media.map((m: any) => [m.media_id, m])
    )
    expect(byId.get('m5')).toMatchObject({ delivery: 'next_message', reason: 'over_count' })
    expect(byId.get('bad')).toMatchObject({ delivery: 'next_message', reason: 'unsupported_mime' })
    expect(byId.get('huge')).toMatchObject({ delivery: 'next_message', reason: 'over_size' })
  })

  it('records the byte-free Execution Viewer truth (DL-105-12)', async () => {
    const result = await applyRecallMediaDelivery(recallPayload(), {
      lane: 'tool_result',
      loadBytes: loadOk
    })

    expect(result!.record).toEqual({
      lane: 'tool_result',
      inTurn: [{ memoryId: 'mem-1', mediaId: 'media-1', filename: 'maggie.png', bytes: 2048 }],
      deferred: []
    })
    expect(JSON.stringify(result!.record)).not.toContain(
      Buffer.from([1, 2, 3, 4]).toString('base64')
    )
  })
})
