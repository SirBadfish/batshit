import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { GET } from './+server'
import { POST as EXPORT } from '../export/+server'

// BL-378: the actual Admin check and export handlers, fake Redis under the default lane.
useRedisTestServer()

const admin = { user: { id: 'bl378', is_admin: true } }
let uploadRoot: string
let previousUploadsDir: string | undefined

beforeEach(async () => {
  previousUploadsDir = process.env.UPLOADS_DIR
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bl378-route-'))
  process.env.UPLOADS_DIR = uploadRoot
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('BL-378 routes must not call the network')
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR
  else process.env.UPLOADS_DIR = previousUploadsDir
  await fs.rm(uploadRoot, { recursive: true, force: true })
})

async function seedMissingUpload() {
  await redis.json.set('upload:images:1700_gone.png', '$', {
    filename: '1700_gone.png',
    originalName: 'gone.png',
    uploadType: 'images',
    storage: 'filesystem',
    relativePath: 'images/1700_gone.png',
    filePath: path.join(uploadRoot, 'images/1700_gone.png'),
    size: 3
  })
}

const exportRequest = () =>
  new Request('http://localhost/api/admin/backup/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeSecrets: false })
  })

describe('GET /api/admin/backup/missing-uploads', () => {
  it('is Admin-only', async () => {
    expect(((await GET({ locals: {} } as any)) as Response).status).toBe(401)
    expect(((await GET({ locals: { user: { id: 'bl378' } } } as any)) as Response).status).toBe(403)
  })

  it('lists a missing upload with its owner and changes nothing', async () => {
    await seedMissingUpload()
    const before = await redis.json.get('upload:images:1700_gone.png')

    const response = (await GET({ locals: admin } as any)) as Response

    expect(response.status).toBe(200)
    const { audit } = await response.json()
    expect(audit).toMatchObject({ problemCount: 1, problemFileCount: 1, foundCount: 0, fileBackedCount: 1 })
    expect(audit.problems[0]).toMatchObject({
      key: 'upload:images:1700_gone.png',
      relativePath: 'images/1700_gone.png',
      kind: 'missing',
      owner: { kind: 'clip', state: 'not-found' }
    })
    expect(audit.exportBlockedMessage).toContain('images/1700_gone.png')
    expect(await redis.json.get('upload:images:1700_gone.png')).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/backup/export with a missing upload', () => {
  it('answers 409 with the complete list and logs only the sentence', async () => {
    await seedMissingUpload()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = (await EXPORT({ locals: admin, request: exportRequest() } as any)) as Response

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toContain('images/1700_gone.png')
    expect(body.details).toMatchObject({ code: 'BACKUP_UPLOAD_FILES_UNAVAILABLE', problemCount: 1 })
    expect(body.details.problems[0]).toMatchObject({ key: 'upload:images:1700_gone.png', kind: 'missing' })
    // No error object: its details carry every stored record's metadata.
    expect(logged).toHaveBeenCalledTimes(1)
    for (const argument of logged.mock.calls[0]) expect(typeof argument).not.toBe('object')
  })
})
