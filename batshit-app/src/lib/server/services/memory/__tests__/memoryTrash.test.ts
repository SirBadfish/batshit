import { createBackupBundle, restoreBackupBundle } from '../../backupRestoreService'
import { readMemoryObservation } from '../memoryOwnership'
import { createRecallMediaPermit, requireRecallMediaPermit } from '../memoryRecallDelivery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import * as memoryMedia from '../memoryMedia'
import { foldAwarenessState, computeMemoryCompileContext, commitMemoryTurnState } from '../memoryRecall'
import { redis } from '$lib/server/redis'
import { memorySearchLaneActive, useMemorySearchTestServer } from '$lib/test-utils/memory-search-server'
import { createMemory, deleteMemory, emptyDeletedMemories, getMemory, listMemories, restoreMemory, touchMemoryRecall, updateMemory } from '../memoryStore'
import { ensureMemoryIndexes, hybridSearchMemories, requireReadyMemoryIndexes, setMemoryConfig } from '../memoryIndex'
import type { MemoryEmbedder } from '../memoryEmbedder'
import type { MemoryLane } from '../memoryTypes'
vi.mock('../../localAiManagedProfiles', async original => ({ ...await original<typeof import('../../localAiManagedProfiles')>(), managedProfileHelper: vi.fn() }))

import { memoryIndexName } from '../memoryKeys'

useMemorySearchTestServer()
const embedder: MemoryEmbedder = { modelId: 'local-ai:trash-test@8', dims: 8, embedDocuments: async texts => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]), embedQuery: async () => [1, 0, 0, 0, 0, 0, 0, 0] }
let agentId: string
let uploadRoot = ''
let previousUploadsDir: string | undefined
const create = (content: string, lane: MemoryLane = 'ltm', extra: Record<string, unknown> = {}, writer = embedder) => createMemory({ agent_id: agentId, user_id: 'memory_trash_user', lane, content, importance: 5, provenance: [{ session_id: 'memory_trash_session', source: 'user' }], ...extra }, { embedder: writer })

describe.runIf(memorySearchLaneActive())('memory trash and expiry on owned Redis JSON/Search', () => {
  beforeEach(async () => {
    agentId = `memory_trash_${crypto.randomUUID().replaceAll('-', '')}`
    await redis.json.set(`agent:${agentId}`, '$', { id: agentId, user_id: 'memory_trash_user', memory_enabled: true } as never)
    await setMemoryConfig({ lane: 'local-ai', modelId: 'local-ai:trash-test', localAi: { baseUrl: 'http://127.0.0.1:9/v1', modelName: 'trash-test', dims: 8 } })
    await ensureMemoryIndexes()
    previousUploadsDir = process.env.UPLOADS_DIR
    uploadRoot = await mkdtemp(path.join(os.tmpdir(), 'memory-trash-'))
    process.env.UPLOADS_DIR = uploadRoot
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR
    else process.env.UPLOADS_DIR = previousUploadsDir
    if (uploadRoot) await rm(uploadRoot, { recursive: true, force: true })
    uploadRoot = ''
  })

  it('soft-deletes idempotently, blocks edits, and restores the same record', async () => {
    const original = await create('a remembered fact')
    expect(await deleteMemory(agentId, original.id)).toBe(true)
    const deleted = await getMemory(agentId, original.id)
    expect(deleted).toMatchObject({ ...original, deleted_at: expect.any(String), deleted_ts: expect.any(Number) })
    await deleteMemory(agentId, original.id)
    expect((await getMemory(agentId, original.id))?.deleted_ts).toBe(deleted?.deleted_ts)
    await expect(updateMemory(agentId, original.id, { content: 'overwrite' }, { embedder })).rejects.toThrow(/Deleted Memories/)
    const restored = await restoreMemory(agentId, original.id)
    expect(restored.content).toBe(original.content)
    expect(restored.embedding).toEqual(original.embedding)
    expect(restored.deleted_ts).toBeUndefined()
  })

  it('settles the old expired lane before renewal and before restoring trash', async () => {
    const original = await create('expired legacy awareness', 'awareness', { expires_at: '2000-01-01T00:00:00Z' })
    // An old app/backup can leave the original lane unprocessed until dreaming.
    await redis.json.set(`memory:${agentId}:${original.id}`, '$.lane', 'awareness')
    await deleteMemory(agentId, original.id)
    const restored = await restoreMemory(agentId, original.id)
    expect(restored.lane).toBe('ltm')
    const renewed = await updateMemory(agentId, original.id, { expires_at: null, lane: 'awareness' }, { embedder })
    expect(renewed.lane).toBe('ltm')
    const moved = await updateMemory(agentId, original.id, { lane: 'awareness' }, { embedder, deliberateLaneMove: true })
    expect(moved.lane).toBe('awareness')
  })

  it('filters deleted and expired rows before the Search limit; expired lookup reports effective LTM', async () => {
    const live = await create('shared fact active')
    const expired = await create('shared fact expired', 'awareness', { expires_at: '2000-01-01T00:00:00Z' })
    for (let i = 0; i < 5; i++) await deleteMemory(agentId, (await create(`shared fact deleted ${i}`)).id)
    const usual = await hybridSearchMemories({ agentId, query: 'shared fact', vector: await embedder.embedQuery('shared fact'), limit: 1 })
    expect(usual.map(hit => hit.key)).toEqual([`memory:${agentId}:${live.id}`])
    const historical = await hybridSearchMemories({ agentId, query: 'shared fact', vector: await embedder.embedQuery('shared fact'), limit: 10, filters: { lane: 'ltm', includeExpired: true } })
    expect(historical.map(hit => hit.key).sort()).toEqual([live.id, expired.id].map(id => `memory:${agentId}:${id}`).sort())
  })

  it('refuses an edit prepared before deletion rather than reviving its stale copy', async () => {
    const original = await create('before the delayed embedding')
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const delayed = { ...embedder, embedDocuments: async (texts: string[]) => { entered(); await gate; return embedder.embedDocuments(texts) } }
    const pending = updateMemory(agentId, original.id, { content: 'late replacement' }, { embedder: delayed })
    await ready
    await deleteMemory(agentId, original.id)
    release()
    await expect(pending).rejects.toThrow(/changed or expired/)
    expect(await getMemory(agentId, original.id)).toMatchObject({ content: original.content, deleted_ts: expect.any(Number) })
  })

  it('empties server-selected trash beyond a visible page and keeps active memories', async () => {
    const active = await create('keep this')
    for (let i = 0; i < 3; i++) await deleteMemory(agentId, (await create(`remove ${i}`)).id)
    expect(await emptyDeletedMemories(agentId)).toEqual({ purged: 3, remaining: 0 })
    expect((await listMemories(agentId)).map(record => record.id)).toEqual([active.id])
  })

  it('keeps unrelated recall statistics out of the content publication conflict set', async () => {
    const edited = await create('edit this fact'), recalled = await create('recall this other fact')
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const delayed = { ...embedder, embedDocuments: async (texts: string[]) => { entered(); await gate; return embedder.embedDocuments(texts) } }
    const pending = updateMemory(agentId, edited.id, { content: 'updated fact' }, { embedder: delayed })
    try {
      await ready
      await touchMemoryRecall(agentId, recalled.id)
    } finally { release() }
    expect((await pending).content).toBe('updated fact')
    expect((await getMemory(agentId, recalled.id))?.recall_count).toBe(1)
  })

  it('serializes concurrent standing-media admission against the memory-owned revision', async () => {
    const image = (owner: string, id: string) => ({ id, filename: `${agentId}/${owner}/${id}.png`, display_name: id, mime_type: 'image/png', bytes: 1, width: 1, height: 1, token_estimate: 1, sha256: 'a'.repeat(64) })
    await create('three standing images', 'awareness', { id: 'mem_cap_base', media_mode: 'always', media: ['a', 'b', 'c'].map(id => image('mem_cap_base', id)) })
    let release!: () => void, both!: () => void, entered = 0
    const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { both = resolve })
    const delayed = { ...embedder, embedDocuments: async (texts: string[]) => { if (++entered === 2) both(); await gate; return embedder.embedDocuments(texts) } }
    const first = create('first contender', 'awareness', { id: 'mem_cap_first', media_mode: 'always', media: [image('mem_cap_first', 'd')] }, delayed)
    const second = create('second contender', 'awareness', { id: 'mem_cap_second', media_mode: 'always', media: [image('mem_cap_second', 'e')] }, delayed)
    await ready; release()
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect((await listMemories(agentId)).filter(record => record.media_mode === 'always').reduce((count, record) => count + (record.media?.length ?? 0), 0)).toBe(4)
  })

  it('removes expired frozen Awareness in read-only previews and persists only at accepted commit', async () => {
    const remembered = await create('remove this expired frozen fact', 'awareness')
    const sessionId = `session_${agentId}`
    await redis.json.set(`session:${sessionId}`, '$', { id: sessionId, user_id: 'memory_trash_user', agent_id: agentId, metadata: {} } as never)
    await foldAwarenessState({ agentId, reason: 'bootstrap' })
    const before = await redis.json.getRaw(`memfold:${agentId}`, '$')
    const past = Date.now() - 1000
    await redis.json.set(`memory:${agentId}:${remembered.id}`, '$.expires_at', new Date(past).toISOString())
    await redis.json.set(`memory:${agentId}:${remembered.id}`, '$.expires_ts', past)
    const input = { userId: 'memory_trash_user', agentId, sessionId, currentUserMessage: 'hello' }
    const first = await computeMemoryCompileContext(input), second = await computeMemoryCompileContext(input)
    expect(first.onMyMindBlock).not.toContain(remembered.content)
    expect(second.onMyMindBlock).toBe(first.onMyMindBlock)
    expect(await redis.json.getRaw(`memfold:${agentId}`, '$')).toBe(before)
    await commitMemoryTurnState(input)
    expect((await redis.json.get(`memfold:${agentId}`) as any).records).not.toContainEqual(expect.objectContaining({ id: remembered.id }))
  })

  it('holds purge custody through unlink, refuses restore, and retires only after disposal', async () => {
    const id = 'mem_purge_photo'
    const media = await memoryMedia.saveMemoryMediaBytes({ agentId, memoryId: id, bytes: await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer(), mimeType: 'image/png', source: { kind: 'upload', label: 'trash-test' } })
    const record = await create('a photo to remove', 'ltm', { id, media: [media] })
    await deleteMemory(agentId, record.id)
    const file = path.join(uploadRoot, 'memory-media', media.filename)
    expect((await readFile(file)).byteLength).toBe(media.bytes)
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const remove = memoryMedia.deleteMemoryMedia
    vi.spyOn(memoryMedia, 'deleteMemoryMedia').mockImplementation(async image => { entered(); await gate; await remove(image) })
    const pending = emptyDeletedMemories(agentId)
    try {
      await ready
      await expect(restoreMemory(agentId, record.id)).rejects.toThrow(/Permanent removal has begun/)
      expect(await getMemory(agentId, record.id)).toMatchObject({ purge_pending: true })
      expect((await readFile(file)).byteLength).toBe(media.bytes)
    } finally { release() }
    expect(await pending).toEqual({ purged: 1, remaining: 0 })
    await expect(readFile(file)).rejects.toThrow()
    expect(await getMemory(agentId, record.id)).toBeNull()
  })


  it('repairs actual old index fields and dual timestamps without an embedding call', async () => {
    const embed = vi.spyOn(embedder, 'embedDocuments')
    const expired = await create('legacy expired index record', 'ltm', { expires_at: '2000-01-01T00:00:00Z' })
    const before = [...expired.embedding]
    embed.mockClear()
    await redis.execute(async client => {
      await client.sendCommand(['JSON.DEL', `memory:${agentId}:${expired.id}`, '$.expires_ts'])
      await client.sendCommand(['FT.DROPINDEX', memoryIndexName()])
      await client.sendCommand(['FT.CREATE', memoryIndexName(), 'ON', 'JSON', 'PREFIX', '1', 'memory:', 'SCHEMA', '$.agent_id', 'AS', 'agent', 'TAG'])
    })
    await expect(requireReadyMemoryIndexes()).rejects.toThrow(/schema is incomplete/)
    await ensureMemoryIndexes()
    expect(embed).not.toHaveBeenCalled()
    expect((await getMemory(agentId, expired.id))?.embedding).toEqual(before)
    expect((await getMemory(agentId, expired.id))?.expires_ts).toBe(Date.parse('2000-01-01T00:00:00Z'))
    expect(await hybridSearchMemories({ agentId, query: 'legacy expired', vector: before, limit: 1 })).toEqual([])
  })

  it('round-trips active/expired/trash/photos/fold through the real backup owner and healthy DB0 index', async () => {
    const userId = 'memory_trash_user', sessionId = `backup_${agentId}`
    const stage = await mkdtemp(path.join(os.tmpdir(), 'memory-trash-backup-'))
    vi.stubEnv('BATSHIT_TOKEN', 'memory-trash-test-service-token')
    vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', stage)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/api\/upload\/asset-maintenance\/(begin|end)$/)
      const { token } = JSON.parse(String(init.body))
      return Response.json({ success: true, token, state: url.endsWith('/begin') ? 'created' : 'released', activeOperations: 0 })
    }))
    try {
      await redis.sAdd(`user:${userId}:agents`, agentId)
      await redis.createSession({ id: sessionId, user_id: userId, agent_id: agentId, name: 'Owned memory roundtrip' })
      const active = await create('active awareness retained', 'awareness')
      const expired = await create('expired long-term retained', 'awareness', { expires_at: '2000-01-01T00:00:00Z' })
      const id = 'mem_backup_trash'
      const photo = await memoryMedia.saveMemoryMediaBytes({ agentId, memoryId: id, bytes: await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer(), mimeType: 'image/png', source: { kind: 'upload', label: 'backup-trash-photo' } })
      const trash = await create('deleted photo retained', 'ltm', { id, media: [photo] })
      await deleteMemory(agentId, trash.id)
      await foldAwarenessState({ agentId, reason: 'bootstrap' })
      const fold = await redis.json.get(`memfold:${agentId}`) as any
      const origin = await readMemoryObservation({ userId, agentId, sessionId })
      const token = createRecallMediaPermit({ userId, agentId, sessionId, lifecycle: origin.lifecycle, agentOwner: origin.agentOwner, sessionOwner: origin.sessionOwner!, includeExpired: false, records: [] })
      const plan = { result: { recall_media_token: token } }, actor = { userId, agentId, sessionId }
      requireRecallMediaPermit(plan, actor)
      const bundle = await createBackupBundle(userId)
      await updateMemory(agentId, active.id, { content: 'temporary post-backup edit' }, { embedder })
      await restoreBackupBundle(userId, bundle.bytes, { confirmReplace: true })
      await requireReadyMemoryIndexes()
      expect((await getMemory(agentId, active.id))?.content).toBe(active.content)
      expect((await getMemory(agentId, expired.id))?.lane).toBe('ltm')
      expect(await getMemory(agentId, trash.id)).toMatchObject({ deleted_ts: expect.any(Number), media: [photo] })
      expect((await memoryMedia.loadMemoryMedia(agentId, trash.id, photo, { audience: 'user', userId })).media.sha256).toBe(photo.sha256)
      const restoredFold = await redis.json.get(`memfold:${agentId}`) as any
      expect(restoredFold.mutation_revision).toBe(fold.mutation_revision)
      expect(restoredFold.block).toBe(fold.block)
      expect(await hybridSearchMemories({ agentId, query: 'retained', vector: await embedder.embedQuery('retained'), limit: 10 })).toEqual([expect.objectContaining({ key: `memory:${agentId}:${active.id}` })])
      expect(() => requireRecallMediaPermit(plan, actor)).toThrow(/identity changed|being replaced/)
    } finally {
      vi.unstubAllGlobals(); vi.unstubAllEnvs()
      await rm(stage, { recursive: true, force: true })
    }
  })

  it('retains published image bytes and replacement custody after a lost Redis acknowledgement', async () => {
    const id = 'mem_unknown_image', mediaId = 'media_unknown'
    const filename = `${agentId}/${id}/${mediaId}.png`
    const expectedUploadKey = `upload:memory-media:${filename}`
    const execute = redis.execute.bind(redis)
    let injected = false
    vi.spyOn(redis, 'execute').mockImplementation(operation => execute(client => {
      // Match the backup owner's empty-target command view: replacing a frozen
      // client's own json property would violate JavaScript Proxy invariants.
      const view = (target: any, json = false): any => new Proxy(Object.create(null), { get(_empty, name) {
        const method = Reflect.get(target, name, target)
        if (!json && name === 'json') return view(method, true)
        if (json && name === 'set') return async (...args: unknown[]) => {
          const answer = await Reflect.apply(method, target, args)
          if (!injected && args[0] === expectedUploadKey && args[1] === '$') {
            expect(args[2]).toMatchObject({ filename, uploadType: 'memory-media', storage: 'filesystem' })
            expect(answer).toBe('OK')
            injected = true
            throw new Error('Injected lost upload acknowledgement')
          }
          return answer
        }
        return typeof method === 'function' ? method.bind(target) : method
      } })
      return operation(view(client))
    }))
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer()
    await expect(memoryMedia.saveMemoryMediaBytes({ agentId, memoryId: id, mediaId, bytes, mimeType: 'image/png', source: { kind: 'upload', label: 'unknown-ack-test' } })).rejects.toMatchObject({ outcomeUnknown: true })
    expect(injected).toBe(true)
    expect(await redis.json.get(expectedUploadKey)).toMatchObject({ storage: 'filesystem' })
    expect((await readFile(path.join(uploadRoot, 'memory-media', filename))).byteLength).toBeGreaterThan(0)
    await expect(redis.deleteAgent(agentId)).rejects.toThrow(/unknown outcome/)
    expect(await redis.json.get(`agent:${agentId}`)).not.toBeNull()
  })

})
