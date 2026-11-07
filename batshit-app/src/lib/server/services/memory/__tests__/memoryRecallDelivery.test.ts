import { readMemoryObservation } from '../memoryOwnership'
/**
 * SA-105 — the shared recall-media finalizer.
 *
 * This module is the one place that decides, per image, whether it arrives now
 * or next message, and the one place that writes the words the model reads about
 * it. Both the API path (`nativeTools`) and the managed CLI route
 * (`/api/memory/recall-media`) run it, so a change here changes both lanes; that
 * is the point, and these tests pin the contract they share.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { captureSettingsLifecycle, withSettingsRecordReplacement } from '../../appActions/settings/lifecycle'
import {
  applyRecallMediaDelivery as applyRecallMediaDeliveryBound,
  isRecallOutputWithMedia,
  MEMORY_RECALL_CONTROL_ID,
  createRecallMediaPermit,
  requireRecallMediaPermit
} from '../memoryRecallDelivery'

let restoreExecute: (() => void) | undefined
beforeEach(() => {
  const original = vi.mocked(redis.execute).getMockImplementation()!
  const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => original(async client => operation(new Proxy(client, {
    get(target, key) {
      if (key !== 'eval') return Reflect.get(target, key)
      return async (script: string, options: { keys: string[] }) => {
        if (!script.includes('BATSHIT_MEMORY_OBSERVATION_V1')) throw new Error('This delivery fixture accepts only an opaque ownership read.')
        const readOwner = async (owner: string) => {
          if (!owner) return ['none', '']
          const kind = await client.type(owner)
          if (kind === 'none') return ['none', '']
          return kind === 'string' ? ['string', await client.get(owner)] : ['ReJSON-RL', JSON.stringify(await client.json.get(owner))]
        }
        const [agent, session, ...keys] = options.keys
        return [String(Math.floor(Date.now() / 1000)), String(Date.now() % 1000 * 1000), ...await readOwner(agent), ...await readOwner(session), await Promise.all(keys.map(async recordKey => [recordKey, (await client.json.get(recordKey)) == null ? '' : JSON.stringify(await client.json.get(recordKey))]))]
      }
    }
  }))))
  restoreExecute = () => spy.mockRestore()
})
afterEach(() => { restoreExecute?.(); restoreExecute = undefined })

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

const USER = 'recall_delivery_user', AGENT = 'recall_delivery_agent', SESSION = 'recall_delivery_session'
const ACTOR = { userId: USER, agentId: AGENT, sessionId: SESSION }

/** Actual typed producer admission over the existing fake Redis owner; byte loading stays injected. */
async function admittedPayload(options?: Parameters<typeof recallPayload>[0] & { expired?: boolean; includeExpired?: boolean }) {
  const payload = recallPayload(options)
  const expiryTs = Date.now() - 1000
  await redis.json.set(`agent:${AGENT}`, '$', { id: AGENT, user_id: USER, memory_enabled: true } as never)
  await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, user_id: USER, agent_id: AGENT, created_at: 'original-chat' } as never)
  for (const row of payload.result.recalled) {
    await redis.json.set(`memory:${AGENT}:${row.id}`, '$', {
      id: row.id, agent_id: AGENT, user_id: USER, lane: row.lane, content: row.content,
      ...(options?.expired ? { expires_ts: expiryTs, expires_at: new Date(expiryTs).toISOString() } : {}),
      media: (row.media ?? []).map((media: any) => ({ id: media.media_id, filename: `${AGENT}/${row.id}/${media.media_id}.png`, display_name: media.filename, mime_type: media.mime_type, bytes: media.bytes }))
    } as never)
  }
  const ownership = await readMemoryObservation({ userId: USER, agentId: AGENT, sessionId: SESSION })
  payload.result.recall_media_token = createRecallMediaPermit({
    userId: USER, agentId: AGENT, sessionId: SESSION,
    lifecycle: captureSettingsLifecycle([`agent:${AGENT}`, `session:${SESSION}`]),
    agentOwner: ownership.agentOwner, sessionOwner: ownership.sessionOwner!,
    includeExpired: options?.includeExpired === true,
    records: payload.result.recalled.map((row: any) => ({ ...row, expired: options?.expired === true }))
  })
  return payload
}

const applyRecallMediaDelivery = (output: any, options: Parameters<typeof applyRecallMediaDeliveryBound>[1]) => applyRecallMediaDeliveryBound(output, { actor: ACTOR, ...options })

const loadOk = async () => ({ bytes: new Uint8Array([1, 2, 3, 4]) })

describe.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('isRecallOutputWithMedia', () => {
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

describe.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('applyRecallMediaDelivery', () => {
  it('returns null for a recall with no media so the payload stays byte-identical (DL-105-13)', async () => {
    const output = { target: MEMORY_RECALL_CONTROL_ID, result: { recalled: [{ id: 'mem-1' }] } }
    const loadBytes = vi.fn(loadOk)

    expect(await applyRecallMediaDelivery(output, { lane: 'tool_result', loadBytes })).toBeNull()
    expect(loadBytes).not.toHaveBeenCalled()
  })

  it('delivers in-turn on a tool_result lane and says so in the note', async () => {
    const payload = await admittedPayload({ extraMemoryWithoutMedia: true })
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
    const result = await applyRecallMediaDelivery(await admittedPayload(), { lane: 'none', loadBytes })

    expect(result).not.toBeNull()
    expect(result!.images).toEqual([])
    expect(loadBytes).not.toHaveBeenCalled()

    const row = result!.output.result.recalled[0]
    expect(row.media[0]).toMatchObject({ delivery: 'next_message', reason: 'lane_none' })
    expect(row.media_note).toContain('remembered_media with the next message')
    expect(row.media_note).toContain('lane_none')
    expect(row.media_note).not.toContain('THIS reply')
    expect(result!.record).toEqual({
      lane: 'none',
      inTurn: [],
      deferred: [{ memoryId: 'mem-1', mediaId: 'media-1', reason: 'lane_none' }]
    })
  })

  it('never mutates the payload it was handed, because that object gets persisted', async () => {
    const payload = await admittedPayload()
    const before = JSON.stringify(payload)

    await applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes: loadOk })

    expect(JSON.stringify(payload)).toBe(before)
  })

  it('marks an unloadable image unavailable without promising next-message delivery', async () => {
    const payload = await admittedPayload({
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
    expect(media[1]).toMatchObject({ delivery: 'unavailable', reason: 'source_unavailable' })
    expect(result!.output.result.recalled[0].media_note).toContain('source_unavailable')
  })

  it('applies the shared caps: unsupported MIME and over-count both defer with a reason', async () => {
    const payload = await admittedPayload({
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
    const result = await applyRecallMediaDelivery(await admittedPayload(), {
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

  it('refuses a fabricated result flag without the original typed admission', async () => {
    const payload = recallPayload()
    payload.result.include_expired = true
    const loadBytes = vi.fn(loadOk)
    await expect(applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes })).rejects.toThrow(/no current recall admission/)
    expect(loadBytes).not.toHaveBeenCalled()
  })

  it('binds a valid admission to the current actor', async () => {
    const payload = await admittedPayload()
    const loadBytes = vi.fn(loadOk)
    await expect(applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes, actor: { userId: 'other', agentId: AGENT, sessionId: SESSION } })).rejects.toThrow(/no current recall admission/)
    expect(loadBytes).not.toHaveBeenCalled()
  })

  it.each(['tool_result', 'none'] as const)('does not deliver or promise a stale trashed record on %s', async lane => {
    const payload = await admittedPayload()
    await redis.json.set(`memory:${AGENT}:mem-1`, '$.deleted_ts', Date.now())
    const loadBytes = vi.fn(loadOk)
    const result = await applyRecallMediaDelivery(payload, { lane, loadBytes })
    expect(result!.images).toEqual([])
    expect(loadBytes).not.toHaveBeenCalled()
    expect(result!.output.result.recalled[0].media[0].delivery).toBe('unavailable')
    expect(result!.output.result.recalled[0].media_note).not.toContain('with the next message')
  })

  it('cannot widen an ordinary admission by forging an expired-result flag', async () => {
    const payload = await admittedPayload()
    await redis.json.set(`memory:${AGENT}:mem-1`, '$.expires_ts', Date.now() - 1)
    payload.result.recalled[0].expired = true
    payload.result.include_expired = true
    const loadBytes = vi.fn(loadOk)
    const result = await applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes })
    expect(result!.images).toEqual([])
    expect(loadBytes).not.toHaveBeenCalled()
    expect(result!.output.result.recalled[0].media[0].delivery).toBe('unavailable')
  })

  it('delivers explicit expired photos now but never promises a deferred expired photo later', async () => {
    const payload = await admittedPayload({ expired: true, includeExpired: true })
    expect((await applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes: loadOk }))!.images).toHaveLength(1)
    const deferred = await applyRecallMediaDelivery(payload, { lane: 'none', loadBytes: vi.fn(loadOk) })
    expect(deferred!.images).toEqual([])
    expect(deferred!.output.result.recalled[0].media[0].delivery).toBe('unavailable')
    expect(deferred!.output.result.recalled[0].media_note).not.toContain('with the next message')
  })


  it('retains only typed admission metadata, never recalled text, vectors or media bytes', async () => {
    const originalMedia = { media_id: 'media-minimal', filename: 'photo.png', mime_type: 'image/png', bytes: 4, data: 'private_image_bytes' }
    const record = { id: 'mem-minimal', expired: false, content: 'private_recalled_content', embedding: [0.12345, 0.6789], media: [originalMedia] }
    const authority = requireRecallMediaPermit(await admittedPayload(), ACTOR)
    const input = { userId: USER, agentId: AGENT, sessionId: SESSION, agentOwner: authority.agentOwner, sessionOwner: authority.sessionOwner, lifecycle: captureSettingsLifecycle([`agent:${AGENT}`]), includeExpired: false, records: [record], extraText: 'private_top_level_text' }
    const token = createRecallMediaPermit(input)
    originalMedia.filename = 'changed-after-admission.png'
    const permit = requireRecallMediaPermit({ result: { recall_media_token: token } }, ACTOR)
    expect(permit.records).toEqual([{ id: 'mem-minimal', expired: false, media: [{ media_id: 'media-minimal', filename: 'photo.png', mime_type: 'image/png', bytes: 4 }] }])
    expect(permit).not.toHaveProperty('extraText')
    expect(permit.records[0]).not.toHaveProperty('content')
    expect(permit.records[0]).not.toHaveProperty('embedding')
    expect(permit.records[0].media?.[0]).not.toHaveProperty('data')
    expect(JSON.stringify(permit)).not.toContain('private_')
  })


  it('refuses a same-agent token in a different server-bound chat', async () => {
    const payload = await admittedPayload()
    payload.result.sessionId = 'chat-from-untrusted-result'
    await expect(applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes: loadOk, actor: { ...ACTOR, sessionId: 'another-chat' } })).rejects.toThrow(/no current recall admission/)
  })

  it('refuses a deleted and byte-identically recreated originating chat', async () => {
    const payload = await admittedPayload()
    const original = await redis.json.get(`session:${SESSION}`)
    await withSettingsRecordReplacement(`session:${SESSION}`, async () => {
      await redis.del(`session:${SESSION}`)
      await redis.json.set(`session:${SESSION}`, '$', original as never)
    })
    await expect(applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes: loadOk })).rejects.toThrow(/identity changed|being replaced/)
  })

  it('keeps a regular multi-agent chat valid for its user', async () => {
    const payload = await admittedPayload()
    await redis.json.set(`session:${SESSION}`, '$.agent_id', 'another-primary-in-the-same-chat')
    expect((await applyRecallMediaDelivery(payload, { lane: 'tool_result', loadBytes: loadOk }))!.images).toHaveLength(1)
  })

})
