// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createBackupBundle, preflightBackupRestore } from '../backupRestoreService'
import { buildAvatarServingUrlOverrides, rewriteRestoredUploadUrls } from '../backupAvatarServingUrls'

useRedisTestServer()

const NAME = 'agent_avatar_probe_1.png'
const FLAT = `/uploads/avatars/${NAME}`
const NESTED = `avatars/agent/${NAME}`
const KEY = `upload:avatars:agent:${NAME}`
const SOURCE = 'avatar_source'
let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-avatar-url-'))
  vi.stubEnv('UPLOADS_DIR', root)
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('avatar URL proof must not call the network') }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})

function avatar(key = KEY, relativePath = NESTED) {
  return { key, value: { storage: 'filesystem', relativePath } }
}

describe('exact avatar lookup eligibility', () => {
  it('binds the recognized typed filename to the existing flat serving route', () => {
    expect([...buildAvatarServingUrlOverrides([avatar()])]).toEqual([
      [FLAT, FLAT], [`/uploads/${NESTED}`, FLAT]
    ])
  })

  it('keeps flat avatar keys reachable without inferring an entity from their filename', () => {
    const flat = avatar('upload:avatars:legacy-avatar.png', 'avatars/legacy-avatar.png')
    expect(buildAvatarServingUrlOverrides([flat]).get('/uploads/avatars/legacy-avatar.png')).toBe('/uploads/avatars/legacy-avatar.png')
  })

  it('does not promise a typed key the existing GET cannot infer from its filename', () => {
    expect(buildAvatarServingUrlOverrides([avatar('upload:avatars:agent:legacy-avatar.png', 'avatars/agent/legacy-avatar.png')]).size).toBe(0)
    expect(buildAvatarServingUrlOverrides([avatar('upload:avatars:user:' + NAME, 'avatars/user/' + NAME)]).size).toBe(0)
  })

  it('uses an existing flat alias while preserving both records and flat-first lookup', () => {
    const records = [avatar('upload:avatars:agent:legacy-avatar.png', 'avatars/agent/legacy-avatar.png'),
      avatar('upload:avatars:legacy-avatar.png', 'avatars/legacy-avatar.png')]
    const before = structuredClone(records)
    expect(buildAvatarServingUrlOverrides(records).get('/uploads/avatars/agent/legacy-avatar.png')).toBe('/uploads/avatars/legacy-avatar.png')
    expect(records).toEqual(before)
  })

  it('does not flatten unknown types, mismatched paths or unsafe key segments', () => {
    const records = [avatar('upload:avatars:other:' + NAME, 'avatars/other/' + NAME),
      avatar(KEY, 'images/' + NAME), avatar(KEY, 'avatars/user/' + NAME),
      avatar('upload:avatars:agent:../' + NAME, NESTED), avatar(KEY, 'avatars/agent/extra/' + NAME),
      { key: KEY, value: JSON.stringify({ relativePath: NESTED }) }]
    expect(buildAvatarServingUrlOverrides(records).size).toBe(0)
  })
})

describe('restore URL transformation', () => {
  it('fixes relative, source-host and already-nested avatar URLs in every existing field', () => {
    const fields = ['url', 'displayUrl', 'localUrl', 'thumbnailUrl', 'avatar', 'avatar_url', 'imageUrl', 'image_url', 'tunnelPath']
    const value = Object.fromEntries(fields.map((field, index) => [field, index % 2 ? `http://127.0.0.1:5600${FLAT}` : `/uploads/${NESTED}`]))
    const rewritten = rewriteRestoredUploadUrls(value, new Map([[NAME, NESTED]]), buildAvatarServingUrlOverrides([avatar()]))
    expect(rewritten).toEqual(Object.fromEntries(fields.map((field) => [field, FLAT])))
    expect(value.url).toBe(`/uploads/${NESTED}`)
  })

  it('keeps nested file identity while correcting the explicit-path fallback', () => {
    const value = { storage: 'filesystem', relativePath: NESTED, filePath: path.join(root, NESTED), tunnelPath: null }
    expect(rewriteRestoredUploadUrls(value, new Map([[NAME, NESTED]]), buildAvatarServingUrlOverrides([avatar()]))).toEqual({ ...value, tunnelPath: FLAT })
  })

  it('does not let a same-basename non-avatar capture an exact avatar URL', () => {
    const index = new Map([[NAME, 'images/' + NAME]])
    const overrides = buildAvatarServingUrlOverrides([avatar()])
    expect(rewriteRestoredUploadUrls({ avatar: FLAT, imageUrl: '/uploads/images/' + NAME }, index, overrides)).toEqual({ avatar: FLAT, imageUrl: '/uploads/images/' + NAME })
  })

  it('preserves other upload namespaces, memory-media paths, external URLs and non-URL fields', () => {
    const memory = 'memory-media/agent/memory/photo.png'
    const value = { files: [{ imageUrl: 'http://127.0.0.1:5600/uploads/' + memory, relativePath: memory }],
      url: 'https://example.invalid/external.png', name: FLAT, base64: 'retained test value', number: 1.25 }
    expect(rewriteRestoredUploadUrls(value, new Map([['photo.png', memory]]), buildAvatarServingUrlOverrides([avatar()]))).toEqual({ ...value, files: [{ imageUrl: '/uploads/' + memory, relativePath: memory }] })
  })

  it('leaves an unsupported typed-name URL at its existing nested outcome', () => {
    const name = 'legacy-avatar.png'
    const records = [avatar('upload:avatars:agent:' + name, 'avatars/agent/' + name)]
    expect(rewriteRestoredUploadUrls({ avatar: '/uploads/avatars/' + name }, new Map([[name, 'avatars/agent/' + name]]), buildAvatarServingUrlOverrides(records))).toEqual({ avatar: '/uploads/avatars/agent/' + name })
  })
})

describe('real export fixture and preflight boundary', () => {
  async function exported(name: string) {
    const bytes = Buffer.from('owned legacy avatar bytes')
    const flat = `/uploads/avatars/${name}`
    await redis.json.set(`upload:avatars:agent:${name}`, '$', {
      filename: name, originalName: name, uploadType: 'avatars', mimetype: 'image/png',
      size: bytes.length, base64: bytes.toString('base64'), url: 'http://127.0.0.1:5600' + flat,
      displayUrl: flat, tunnelPath: flat
    })
    await redis.json.set('agent:avatar_probe', '$', { id: 'avatar_probe', user_id: SOURCE, avatar: flat })
    await redis.execute((client) => client.sAdd(`user:${SOURCE}:agents`, 'avatar_probe'))
    const bundle = await createBackupBundle(SOURCE)
    const entries = unzipSync(bundle.bytes)
    const records = Object.entries(entries).filter(([key]) => key.startsWith('redis/records/'))
      .map(([, value]) => JSON.parse(Buffer.from(value).toString('utf8')))
    return { bundle, entries, records, bytes }
  }

  it('keeps the supported Base64 archive/path/bytes and restores only its serving URL', async () => {
    const { bundle, entries, records, bytes } = await exported(NAME)
    expect(bundle.manifest.schemaVersion).toBe(1)
    expect(Buffer.from(entries[`files/uploads/${NESTED}`])).toEqual(bytes)
    const upload = records.find((record) => record.key === KEY)
    expect(upload.value.relativePath).toBe(NESTED)
    expect(upload.value.base64).toBeUndefined()
    expect(upload.value.filePath).toBeUndefined()
    const value = { ...upload.value, filePath: path.join(root, NESTED) }
    const transformed = rewriteRestoredUploadUrls(value, new Map([[NAME, NESTED]]), buildAvatarServingUrlOverrides(records))
    expect(transformed).toMatchObject({ relativePath: NESTED, filePath: value.filePath, url: FLAT, displayUrl: FLAT, tunnelPath: FLAT })
    // The actual shared target builder runs in both preflights; no restore is performed.
    await expect(preflightBackupRestore(SOURCE, bundle.bytes)).resolves.toMatchObject({ ok: true, userRemapRequired: false })
    await expect(preflightBackupRestore('avatar_target', bundle.bytes)).resolves.toMatchObject({ ok: true, sourceUserId: SOURCE, targetUserId: 'avatar_target', userRemapRequired: true })
  })

  it('preserves the existing generic-name Base64 archive compatibility pin', async () => {
    const { bundle, entries, records, bytes } = await exported('legacy-avatar.png')
    expect(Buffer.from(entries['files/uploads/avatars/agent/legacy-avatar.png'])).toEqual(bytes)
    expect(records.find((record) => record.key === 'upload:avatars:agent:legacy-avatar.png').value.relativePath).toBe('avatars/agent/legacy-avatar.png')
    await expect(preflightBackupRestore(SOURCE, bundle.bytes)).resolves.toMatchObject({ ok: true, fileAssetCount: 1 })
  })
})
