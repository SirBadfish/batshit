import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const state = vi.hoisted(() => ({ records: new Map<string, any>() }))
const clipMocks = vi.hoisted(() => ({
  loadClipRow: vi.fn(),
  resolveClipDataUrlFromStoredUpload: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
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

let uploadRoot = ''
let previousUploadsDir: string | undefined

beforeEach(async () => {
  state.records.clear()
  clipMocks.loadClipRow.mockReset()
  clipMocks.resolveClipDataUrlFromStoredUpload.mockReset()
  previousUploadsDir = process.env.UPLOADS_DIR
  uploadRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-memory-media-'))
  process.env.UPLOADS_DIR = uploadRoot
})

afterEach(async () => {
  if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR
  else process.env.UPLOADS_DIR = previousUploadsDir
  await rm(uploadRoot, { recursive: true, force: true })
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

    const loaded = await loadMemoryMedia('agent_test', 'mem_test', media)
    expect(loaded.bytes.byteLength).toBe(media.bytes)
    expect(loaded.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(await readFile(path.join(uploadRoot, 'memory-media', media.filename))).toEqual(
      Buffer.from(loaded.bytes)
    )

    state.records.set('memory:agent_test:mem_test', { media: [media] })
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

    await expect(ensureMemoryMediaMigration()).resolves.toMatchObject({ status: 'already-complete' })
  })
})
