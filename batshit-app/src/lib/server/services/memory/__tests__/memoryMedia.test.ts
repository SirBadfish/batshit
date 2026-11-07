import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const mediaIo = { release: null as null | (() => void), pending: null as null | Promise<unknown> }

const state = vi.hoisted(() => ({
  records: new Map<string, any>(), failedRead: '', loseUploadAck: false,
  observations: 0, beforeObservation: null as null | ((keys: string[]) => Promise<void>)
}))
const clipMocks = vi.hoisted(() => ({
  loadClipRow: vi.fn(),
  resolveClipDataUrlFromStoredUpload: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    execute: async (callback: (client: any) => unknown) => callback({
      type: async (key: string) => {
        if (state.failedRead === key) throw new Error('Injected migration read failure')
        return !state.records.has(key) ? 'none' : typeof state.records.get(key) === 'string' ? 'string' : 'ReJSON-RL'
      },
      eval: async (script: string, options: { keys: string[] }) => {
        if (!script.includes('BATSHIT_MEMORY_OBSERVATION_V1')) throw new Error('This image fixture accepts only an opaque ownership read.')
        state.observations += 1
        if (state.beforeObservation) await state.beforeObservation(options.keys)
        const read = (key: string) => {
          const value = state.records.get(key)
          return !state.records.has(key) ? ['none', ''] : typeof value === 'string' ? ['string', value] : ['ReJSON-RL', JSON.stringify(value)]
        }
        const [agent, session, ...keys] = options.keys
        return [String(Math.floor(Date.now() / 1000)), String(Date.now() % 1000 * 1000), ...read(agent), ...(session ? read(session) : ['none', '']), keys.map(key => [key, state.records.has(key) ? JSON.stringify(state.records.get(key)) : ''])]
      }, json: {
      get: async (key: string) => {
        if (state.failedRead === key) throw new Error('Injected migration read failure')
        return state.records.get(key) ?? null
      },
      set: async (key: string, _path: string, value: unknown) => {
        state.records.set(key, value)
        if (state.loseUploadAck && key.startsWith('upload:memory-media:')) { state.loseUploadAck = false; throw new Error('Injected lost upload acknowledgement') }
        return 'OK'
      }
    } }),
    json: { get: async (key: string) => state.records.get(key) ?? null },
    get: async (key: string) => state.records.get(key) ?? null,
    set: async (key: string, value: any) => void state.records.set(key, value),
    del: async (key: string) => void state.records.delete(key),
    exists: async (key: string) => state.records.has(key),
    keys: async (pattern: string) => {
      const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      return Array.from(state.records.keys()).filter((key) => expression.test(key))
    }
  }
}))
// Consumer fixture only: the actual Lua/cap/concurrency owner is exercised on
// the disposable Search lane. Do not simulate that protocol in this image unit fake.
vi.mock('../memoryMutation', async importOriginal => {
  const actual = await importOriginal<typeof import('../memoryMutation')>()
  const { captureSettingsLifecycle } = await import('$lib/server/services/appActions/settings/lifecycle')
  return {
    ...actual,
    readMemoryMutationSnapshot: async (agentId: string) => ({
      agentId, lifecycle: captureSettingsLifecycle([`agent:${agentId}`]),
      records: [...state.records.entries()].filter(([key]) => key.startsWith(`memory:${agentId}:`)).map(([, record]) => structuredClone(record)),
      raw: new Map([...state.records.entries()].map(([key, value]) => [key, JSON.stringify(value)]))
    }),
    commitMemoryMutation: async (_snapshot: unknown, changes: Map<string, unknown>) => {
      for (const [key, value] of changes) if (value === null) state.records.delete(key)
      else state.records.set(key, structuredClone(value))
    }
  }
})
vi.mock('$lib/server/services/clipService', () => ({ loadClipRow: clipMocks.loadClipRow }))
vi.mock('$lib/server/services/clipUploadPayload', () => ({
  resolveClipDataUrlFromStoredUpload: clipMocks.resolveClipDataUrlFromStoredUpload
}))

import {
  copyClipToMemoryMedia,
  deleteMemoryMedia,
  loadMemoryMedia,
  saveMemoryMediaBytes
} from '../memoryMedia'
import { ensureMemoryMediaMigration } from '../memoryMediaMigration'
import { MEMORY_MEDIA_MIGRATION_KEY } from '../memoryKeys'

let uploadRoot = ''
let previousUploadsDir: string | undefined

beforeEach(async () => {
  state.records.clear()
  state.failedRead = ''
  state.loseUploadAck = false
  state.observations = 0
  state.beforeObservation = null
  mediaIo.release = null
  mediaIo.pending = null
  state.records.set('agent:agent_test', { id: 'agent_test', user_id: 'user_test', memory_enabled: true })
  clipMocks.loadClipRow.mockReset()
  clipMocks.resolveClipDataUrlFromStoredUpload.mockReset()
  previousUploadsDir = process.env.UPLOADS_DIR
  uploadRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-memory-media-'))
  process.env.UPLOADS_DIR = uploadRoot
})

afterEach(async () => {
  mediaIo.release?.()
  try {
    if (mediaIo.pending) await Promise.allSettled([mediaIo.pending])
  } finally {
    state.beforeObservation = null
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR
    else process.env.UPLOADS_DIR = previousUploadsDir
    if (uploadRoot) await rm(uploadRoot, { recursive: true, force: true })
  }
})

async function png(width = 1500, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: '#7c3aed' } }).png().toBuffer()
}

describe('memory-owned media', () => {
  it('downscales once, stores an owned upload, loads identical bytes, and deletes both stores', async () => {
    const media = await saveMemoryMediaBytes({
      agentId: 'agent_test',
      memoryId: 'mem_test',
      bytes: await png(),
      mimeType: 'image/png',
      filename: 'portrait.png',
      source: { kind: 'upload', label: 'test' }
    })

    expect(media.width).toBe(1024)
    expect(media.height).toBeLessThanOrEqual(1024)
    expect(media.display_name).toBe('portrait.png')
    const uploadKey = `upload:memory-media:${media.filename}`
    expect(state.records.get(uploadKey)).toMatchObject({
      uploadType: 'memory-media',
      storage: 'filesystem',
      relativePath: `memory-media/${media.filename}`
    })

    state.records.set('memory:agent_test:mem_test', { id: 'mem_test', agent_id: 'agent_test', user_id: 'user_test', media: [media] })
    const loaded = await loadMemoryMedia('agent_test', 'mem_test', media)
    expect(loaded.bytes.byteLength).toBe(media.bytes)
    expect(loaded.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(await readFile(path.join(uploadRoot, 'memory-media', media.filename))).toEqual(
      Buffer.from(loaded.bytes)
    )

    state.records.set('memory:agent_test:mem_test', { id: 'mem_test', agent_id: 'agent_test', user_id: 'user_test', media: [media] })
    await expect(loadMemoryMedia('agent_test', 'mem_test', media.id)).resolves.toMatchObject({
      url: `/uploads/memory-media/agent_test/mem_test/${media.id}.png`
    })

    await deleteMemoryMedia(media)
    expect(state.records.has(uploadKey)).toBe(false)
    await expect(readFile(path.join(uploadRoot, 'memory-media', media.filename))).rejects.toThrow()
  })

  it('copies Clip bytes through the thin adapter and refuses a missing source loudly', async () => {
    clipMocks.loadClipRow.mockResolvedValueOnce(null)
    await expect(
      copyClipToMemoryMedia({
        userId: 'user_test',
        agentId: 'agent_test',
        memoryId: 'mem_test',
        clipId: 'clip_missing'
      })
    ).rejects.toThrow(/not found/)

    const bytes = await png(64, 48)
    clipMocks.loadClipRow.mockResolvedValueOnce({
      id: 'clip_ok',
      user_id: 'user_test',
      filename: 'maggie.png',
      mimeType: 'image/png',
      storageMode: 'local',
      created_at: new Date().toISOString()
    })
    clipMocks.resolveClipDataUrlFromStoredUpload.mockResolvedValueOnce(
      `data:image/png;base64,${bytes.toString('base64')}`
    )
    const copied = await copyClipToMemoryMedia({
      userId: 'user_test',
      agentId: 'agent_test',
      memoryId: 'mem_test',
      clipId: 'clip_ok'
    })
    expect(copied.source_clip_id).toBe('clip_ok')
    expect(copied.display_name).toBe('maggie.png')
  })

  it('refuses a source above the 10 MiB memory-media boundary before decoding', async () => {
    await expect(
      saveMemoryMediaBytes({
        agentId: 'agent_test',
        memoryId: 'mem_test',
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        mimeType: 'image/png',
        filename: 'too-large.png',
        source: { kind: 'upload', label: 'test' }
      })
    ).rejects.toThrow(/10 MiB/)
  })

  it('migrates legacy clip_ids once and records unresolved source provenance honestly', async () => {
    state.records.set('memory:agent_test:mem_legacy', {
      id: 'mem_legacy',
      agent_id: 'agent_test',
      user_id: 'user_test',
      lane: 'awareness',
      content: 'portrait',
      clip_ids: ['clip_missing'],
      provenance: [{ session_id: 'sess_old', source: 'agent' }]
    })
    clipMocks.loadClipRow.mockResolvedValue(null)

    const first = await ensureMemoryMediaMigration()
    expect(first).toMatchObject({ status: 'migrated', records: 1, unresolved: 1 })
    const migrated = state.records.get('memory:agent_test:mem_legacy')
    expect(migrated.clip_ids).toBeUndefined()
    expect(migrated.media).toEqual([])
    expect(migrated.provenance[0].note).toContain('could not copy')

    await expect(ensureMemoryMediaMigration()).resolves.toMatchObject({ status: 'already-complete', records: 1, unresolved: 1 })
  })

  it('keeps successful migrated bytes and receipt counts identical after restart', async () => {
    const bytes = await png(32, 24)
    state.records.set('memory:agent_test:mem_legacy', {
      id: 'mem_legacy', agent_id: 'agent_test', user_id: 'user_test',
      clip_ids: ['clip_ok'], provenance: [{ session_id: 'old', source: 'agent' }]
    })
    clipMocks.loadClipRow.mockResolvedValue({ id: 'clip_ok', user_id: 'user_test', filename: 'picture.png', mimeType: 'image/png' })
    clipMocks.resolveClipDataUrlFromStoredUpload.mockResolvedValue(`data:image/png;base64,${bytes.toString('base64')}`)
    await expect(ensureMemoryMediaMigration()).resolves.toEqual({ status: 'migrated', records: 1, media: 1, unresolved: 0 })
    const record = state.records.get('memory:agent_test:mem_legacy')
    const migratedBytes = await readFile(path.join(uploadRoot, 'memory-media', record.media[0].filename))
    await expect(ensureMemoryMediaMigration()).resolves.toEqual({ status: 'already-complete', records: 1, media: 1, unresolved: 0 })
    expect(await readFile(path.join(uploadRoot, 'memory-media', record.media[0].filename))).toEqual(migratedBytes)
    expect(clipMocks.loadClipRow).toHaveBeenCalledTimes(1)
  })

  it('does not certify a migration when a memory read failed', async () => {
    const key = 'memory:agent_test:mem_legacy'
    state.records.set(key, { clip_ids: ['clip_ok'] })
    state.failedRead = key
    await expect(ensureMemoryMediaMigration()).rejects.toThrow('Injected migration read failure')
    expect(state.records.has(MEMORY_MEDIA_MIGRATION_KEY)).toBe(false)
    expect(state.records.get(key)).toEqual({ clip_ids: ['clip_ok'] })
  })

  it('preserves a present JSON-null receipt and legacy source rather than rerunning migration', async () => {
    state.records.set(MEMORY_MEDIA_MIGRATION_KEY, null)
    state.records.set('memory:agent_test:legacy', { clip_ids: ['clip_ok'] })
    await expect(ensureMemoryMediaMigration()).rejects.toThrow('migration receipt is unreadable or unsupported')
    expect(state.records.get(MEMORY_MEDIA_MIGRATION_KEY)).toBeNull()
    expect(state.records.get('memory:agent_test:legacy')).toEqual({ clip_ids: ['clip_ok'] })
    expect(clipMocks.loadClipRow).not.toHaveBeenCalled()
  })

  it('refuses unreadable and malformed persisted receipts', async () => {
    state.failedRead = MEMORY_MEDIA_MIGRATION_KEY
    await expect(ensureMemoryMediaMigration()).rejects.toThrow('Injected migration read failure')
    state.failedRead = ''
    state.records.set(MEMORY_MEDIA_MIGRATION_KEY, { status: 'migrated', unresolved: -1 })
    await expect(ensureMemoryMediaMigration()).rejects.toThrow('migration receipt is unreadable or unsupported')
  })

  it('rejects same-length corruption against the saved image hash (BL-2223)', async () => {
    const media = await saveMemoryMediaBytes({ agentId: 'agent_test', memoryId: 'mem_test', bytes: await png(16, 16), mimeType: 'image/png', source: { kind: 'upload', label: 'hash-test' } })
    state.records.set('memory:agent_test:mem_test', { id: 'mem_test', agent_id: 'agent_test', user_id: 'user_test', media: [media] })
    const file = path.join(uploadRoot, 'memory-media', media.filename)
    const changed = await readFile(file)
    changed[changed.length - 1] ^= 1
    await writeFile(file, changed)
    expect(changed.byteLength).toBe(media.bytes)
    await expect(loadMemoryMedia('agent_test', 'mem_test', media)).rejects.toThrow(/saved hash/)
  })

  it('separates human trash-photo viewing from a stale agent delivery object', async () => {
    const media = await saveMemoryMediaBytes({ agentId: 'agent_test', memoryId: 'mem_test', bytes: await png(16, 16), mimeType: 'image/png', source: { kind: 'upload', label: 'trash-view-test' } })
    state.records.set('memory:agent_test:mem_test', { id: 'mem_test', agent_id: 'agent_test', user_id: 'user_test', deleted_ts: Date.now(), media: [media] })
    await expect(loadMemoryMedia('agent_test', 'mem_test', media)).rejects.toThrow(/deleted or expired/)
    expect((await loadMemoryMedia('agent_test', 'mem_test', media, { audience: 'user' })).bytes.byteLength).toBe(media.bytes)
  })

  it('reads a supported legacy STRING agent without converting its storage', async () => {
    const legacy = JSON.stringify({ id: 'agent_test', user_id: 'user_test', memory_enabled: true, created_at: 'legacy-created' })
    state.records.set('agent:agent_test', legacy)
    const media = await saveMemoryMediaBytes({ agentId: 'agent_test', memoryId: 'mem_test', bytes: await png(16, 16), mimeType: 'image/png', source: { kind: 'upload', label: 'legacy-owner' } })
    state.records.set('memory:agent_test:mem_test', { id: 'mem_test', agent_id: 'agent_test', user_id: 'user_test', media: [media] })
    expect((await loadMemoryMedia('agent_test', 'mem_test', media)).bytes.byteLength).toBe(media.bytes)
    expect(state.records.get('agent:agent_test')).toBe(legacy)
  })

  it.each(['delete', 'expire', 'replace'] as const)('refuses a direct agent photo when %s occurs at the post-I/O final observation', async change => {
    const media = await saveMemoryMediaBytes({ agentId: 'agent_test', memoryId: 'mem_test', bytes: await png(16, 16), mimeType: 'image/png', source: { kind: 'upload', label: 'deferred-owner' } })
    const record = { id: 'mem_test', agent_id: 'agent_test', user_id: 'user_test', media: [media] }
    state.records.set('memory:agent_test:mem_test', record)
    let enter!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    state.observations = 0
    state.beforeObservation = async keys => {
      if (state.observations !== 2) return
      expect(keys).toEqual(['agent:agent_test', '', 'memory:agent_test:mem_test'])
      enter()
      await gate
    }
    const pending = loadMemoryMedia('agent_test', 'mem_test', media)
    mediaIo.pending = pending; mediaIo.release = release
    try {
      await Promise.race([ready, pending.then(result => {
        throw new Error('Photo load completed before the deferred final-observation seam: ' + JSON.stringify({
          status: 'fulfilled', returnedMediaId: result.media.id, returnedBytes: result.bytes.byteLength,
          observations: state.observations
        }))
      })])
      // Real bytes have passed the loader's size/hash checks. Changing this owned
      // file now must not turn the final eligibility refusal into a hash failure.
      await writeFile(path.join(uploadRoot, 'memory-media', media.filename), Buffer.alloc(media.bytes))
      state.records.set('memory:agent_test:mem_test', change === 'delete' ? { ...record, deleted_ts: Date.now() }
        : change === 'expire' ? { ...record, expires_ts: Date.now() - 1 }
        : { ...record, media: [{ ...media, id: 'replacement' }] })
    } finally { release(); await Promise.allSettled([pending]) }
    expect(state.observations).toBe(2)
    await expect(pending).rejects.toThrow(/changed, expired or was deleted/)
  })

  it('keeps bytes and upload metadata when publication succeeds but its acknowledgement is lost (BL-2222)', async () => {
    state.loseUploadAck = true
    await expect(saveMemoryMediaBytes({ agentId: 'agent_test', memoryId: 'mem_test', mediaId: 'media_unknown', bytes: await png(16, 16), mimeType: 'image/png', source: { kind: 'upload', label: 'unknown-test' } })).rejects.toMatchObject({ outcomeUnknown: true })
    const filename = 'agent_test/mem_test/media_unknown.png'
    expect(state.records.get(`upload:memory-media:${filename}`)).toMatchObject({ storage: 'filesystem' })
    expect((await readFile(path.join(uploadRoot, 'memory-media', filename))).byteLength).toBeGreaterThan(0)
  })

})
