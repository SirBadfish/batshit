// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, zipSync } from 'fflate/node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createHairAssetFixture, createRigidHairGlbFixture } from '$lib/goons/recipe/fixtures/hairAssetFixture'
import { collectHairAssetFileRefs, hairAssetRevisionSha256, hairFitReceiptSha256, hairMaterialDefinitionSha256, verifyHairAsset } from '$lib/goons/hairAssets'
import { RECIPE_SOURCE_CONTRACT } from '$lib/goons/recipe/packageMetadata'
import { sha256Hex } from '$lib/goons/recipe/recipeCanonical'
import type { RecipeSource } from '$lib/goons/recipe/recipeContracts'
import { buildImportedHairRefitSource } from '../hairImportAssetFactory.server'
import { createHairImportTexturePng } from '../hairImportOwnedFiles.server'
import { replaceHairImportJob } from '../hairImportJobRepository.server'
import { beginHairRefit, discardHairImportJob, pruneDiscardableHairImportJobs } from '../hairImportLifecycle.server'
import { createBackupBundle, ensureBackupRestoreRecovery, restoreBackupBundle } from '../backupRestoreService'

vi.mock('../goonRecipeRepository.server', () => ({ getOwnedRecipeGoon: vi.fn().mockResolvedValue({}) }))
vi.mock('../backupHairSnapshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backupHairSnapshot')>()
  return { ...original, readHairBackupSnapshot: async (client: any) => {
    const { fakeHairSnapshotAnswer } = await import('./fixtures/hairSnapshotFake')
    return original.readHairBackupSnapshot({ eval: async () => fakeHairSnapshotAnswer(client) })
  } }
})
useRedisTestServer()
const executeUnwrapped = vi.mocked(redis.execute).getMockImplementation()!
const USER = 'restore-hair-user'
const JOB = `hair_import_job:${USER}:orphan`
const INDEX = `user:${USER}:hair_import_jobs`
const SETTINGS = `user:${USER}:settings`
const ZERO = '0'.repeat(64)
const transform = { move: { x: 0, y: 1.65, z: 0 }, rotate: { x: 0, y: 0, z: 0 }, uniformScale: 1, axisScale: { x: 1, y: 1, z: 1 } }
const recipeSource = { identities: {
  contract: RECIPE_SOURCE_CONTRACT, schemaVersion: 1, baseId: 'batshit-base-female', fitFamily: 'batshit-base-female-v1',
  modelSha256: '1'.repeat(64), manifestSemanticSha256: '2'.repeat(64), definitionSha256: '3'.repeat(64),
  neutralId: 'neutral', neutralRecipeSha256: '4'.repeat(64), physicalBasisSha256: '5'.repeat(64), behaviorSha256: '6'.repeat(64),
  componentGraphSha256: '7'.repeat(64), topologySha256: '8'.repeat(64), skeletonHierarchySha256: '9'.repeat(64)
} } as RecipeSource
let root: string, uploads: string, staging: string
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hair-retirement-'))
  uploads = path.join(root, 'uploads'); staging = path.join(root, 'staging')
  await fs.mkdir(uploads); await fs.mkdir(staging)
  vi.stubEnv('UPLOADS_DIR', uploads); vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', staging)
  vi.stubEnv('BATSHIT_TOKEN', 'synthetic-hair-retirement-token')
  vi.stubEnv('BATSHIT_RUNTIME_OWNER', ''); vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (/\/asset-maintenance\/(begin|end)$/.test(String(url))) {
      const { token } = JSON.parse(String(init?.body))
      return Response.json({ success: true, token, activeOperations: 0, state: String(url).endsWith('/begin') ? 'created' : 'released' })
    }
    if (init?.method === 'POST' && init.body instanceof FormData) {
      const file = init.body.get('file') as File
      const bytes = new Uint8Array(await file.arrayBuffer())
      const filename = `staged-${file.name}`
      await fs.mkdir(path.join(uploads, 'goon_hair_imports'), { recursive: true })
      await fs.writeFile(path.join(uploads, 'goon_hair_imports', filename), bytes)
      return Response.json({ file: { filename, size: bytes.length, sha256: await sha256Hex(bytes) } })
    }
    const marker = '/uploads/'
    if (!init?.method && String(url).includes(marker)) return new Response(await fs.readFile(path.join(uploads, String(url).split(marker)[1])))
    throw new Error('unexpected fixture network request')
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.mocked(redis.execute).mockImplementation(executeUnwrapped)
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})
function wrapClient(wrap: (client: any) => any) {
  vi.mocked(redis.execute).mockImplementation((operation: any) => executeUnwrapped((client: any) => operation(wrap(client))))
}
async function baseArchive() {
  await redis.json.set(SETTINGS, '$', { marker: 'archive' })
  const bundle = await createBackupBundle(USER)
  await redis.json.set(SETTINGS, '$', { marker: 'original' })
  await fs.writeFile(path.join(uploads, 'original.txt'), 'original bytes')
  return bundle
}
async function currentAuthority() {
  // Opaque obsolete/malformed JSON is data to replay, never a job to execute.
  const value = [{ contract: 'hair-import-job/v0', unknown: [0.12345678901234568, null], secretLike: 'kept verbatim' }]
  await redis.json.set(JOB, '$', value)
  await redis.sAdd(INDEX, ['dangling', 'unrelated-index-member'])
  await redis.json.set('hair_import_job:other-user:keep', '$', { marker: 'foreign' })
  await redis.json.set('user_session:keep', '$', { marker: 'authenticated session' })
  return value
}
async function assertOriginal(value: unknown) {
  expect(await redis.json.get(JOB)).toEqual(value)
  expect((await redis.sMembers(INDEX)).sort()).toEqual(['dangling', 'unrelated-index-member'])
  expect(await redis.json.get(SETTINGS)).toEqual({ marker: 'original' })
  expect(await fs.readFile(path.join(uploads, 'original.txt'), 'utf8')).toBe('original bytes')
}
async function retainedRevision(revision: number) {
  const geometry = createRigidHairGlbFixture()
  const asset = await createHairAssetFixture({ recipeSource, mainBytes: geometry, headNode: 'head', sourceClass: 'user' })
  asset.revision = revision; asset.revisionId = `${asset.assetId}-r${revision}`
  asset.attachment.fitReceipt.assetRevisionId = asset.revisionId
  const textureFiles: any[] = []
  for (const ref of collectHairAssetFileRefs(asset)) {
    const oldName = ref.ref.split('/').at(-1)!
    const role = oldName === 'hair.glb' ? 'geometry' : oldName.replace(/\.(png|json)$/, '')
    const bytes = role === 'geometry' ? geometry : role === 'neutral-value' || role === 'highlight-mask' ? createHairImportTexturePng(role) : new TextEncoder().encode('{}')
    const sha256 = await sha256Hex(bytes)
    const extension = role === 'geometry' ? '.glb' : role === 'neutral-value' || role === 'highlight-mask' ? '.png' : '.json'
    const filename = `${asset.assetId}_${asset.revisionId}_${role}_${sha256}${extension}`
    ref.ref = `/uploads/goon_hair_assets/${filename}`; ref.sha256 = sha256; ref.bytes = bytes.length
    await fs.mkdir(path.join(uploads, 'goon_hair_assets'), { recursive: true })
    await fs.writeFile(path.join(uploads, 'goon_hair_assets', filename), bytes)
    await redis.json.set(`upload:goon_hair_assets:${filename}`, '$', {
      storage: 'filesystem', uploadType: 'goon_hair_assets', filename, relativePath: `goon_hair_assets/${filename}`,
      size: bytes.length, sha256, mimetype: ref.mimeType, hairAssetArtifact: { assetId: asset.assetId, revisionId: asset.revisionId, role, sha256 }
    })
    if (role === 'neutral-value' || role === 'highlight-mask') textureFiles.push({ uploadType: 'goon_hair_assets', filename, ...ref })
  }
  asset.material.layout.width = 64; asset.material.layout.height = 64
  asset.material.definitionSha256 = await hairMaterialDefinitionSha256(asset.material)
  asset.revisionSha256 = ZERO; asset.attachment.fitReceipt.assetRevisionSha256 = ZERO; asset.attachment.fitReceipt.fitSha256 = ZERO
  asset.revisionSha256 = await hairAssetRevisionSha256(asset)
  asset.attachment.fitReceipt.assetRevisionSha256 = asset.revisionSha256
  asset.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(asset.attachment.fitReceipt)
  const verified = await verifyHairAsset(asset)
  const source = { uploadType: 'goon_hair_assets' as const, filename: asset.geometry.main.ref.split('/').at(-1)!, ...asset.geometry.main }
  const sidecar = buildImportedHairRefitSource({ assetId: asset.assetId, revisionId: asset.revisionId, source, startingTransform: transform, savedTransform: transform })
  await redis.json.set(`hair_asset:${USER}:${asset.assetId}:${asset.revisionId}`, '$', verified)
  await redis.json.set(`hair_refit_source:${USER}:${asset.assetId}:${asset.revisionId}`, '$', sidecar)
  await redis.sAdd(`user:${USER}:hair_assets`, `${asset.assetId}@${asset.revisionId}`)
  return { asset: verified, textureFiles }
}

it('retires the normally reused r2 authority while preserving completed r2 deterministic textures', async () => {
  const r1 = await retainedRevision(1)
  const a = await createBackupBundle(USER)
  const r2 = await retainedRevision(2)
  const b = await createBackupBundle(USER)
  await restoreBackupBundle(USER, a.bytes, { confirmReplace: true })
  const started = await beginHairRefit({ userId: USER, goonId: 'test-goon', assetId: r1.asset.assetId, revisionId: r1.asset.revisionId, revisionSha256: r1.asset.revisionSha256 })
  expect(started.job.target).toMatchObject({ kind: 'refit', revision: 2, revisionId: r2.asset.revisionId })
  for (const file of r2.textureFiles) {
    const role = file.filename.includes('_neutral-value_') ? 'neutral-value' : 'highlight-mask'
    expect(await sha256Hex(createHairImportTexturePng(role))).toBe(file.sha256)
    expect(file.filename).toBe(`${r2.asset.assetId}_${started.job.target.kind === 'refit' ? started.job.target.revisionId : ''}_${role}_${file.sha256}.png`)
  }
  // The repository's normal CAS persists an unfinished job with generated owned receipts.
  await replaceHairImportJob(started.job, { ...started.job, status: 'preparing', cleanupFiles: [...started.job.cleanupFiles, ...r2.textureFiles] })
  fetchMock.mockClear()
  await restoreBackupBundle(USER, b.bytes, { confirmReplace: true })
  expect(await redis.keys(`hair_import_job:${USER}:*`)).toEqual([])
  expect(await redis.type(INDEX)).toBe('none')
  await expect(discardHairImportJob({ userId: USER, jobId: started.job.jobId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await pruneDiscardableHairImportJobs(USER, new Date(Date.now() + 2 * 86400_000))
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  expect(await redis.json.get(`hair_asset:${USER}:${r2.asset.assetId}:${r2.asset.revisionId}`)).toEqual(r2.asset)
  for (const file of r2.textureFiles) expect(await sha256Hex(await fs.readFile(path.join(uploads, 'goon_hair_assets', file.filename)))).toBe(file.sha256)
})

it('retires orphan opaque rows and the exact index, preserving other users and sessions', async () => {
  const bundle = await baseArchive(); await currentAuthority()
  await restoreBackupBundle(USER, bundle.bytes, { confirmReplace: true })
  expect(await redis.type(JOB)).toBe('none'); expect(await redis.type(INDEX)).toBe('none')
  expect(await redis.json.get('hair_import_job:other-user:keep')).toEqual({ marker: 'foreign' })
  expect(await redis.json.get('user_session:keep')).toEqual({ marker: 'authenticated session' })
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
})

it.each(['before', 'after'])('replays jobs/index and original files after failure %s retirement', async (timing) => {
  const bundle = await baseArchive(); const value = await currentAuthority()
  let injected = false
  wrapClient((client) => ({ ...client, del: async (keys: string | string[]) => {
    const retires = !injected && Array.isArray(keys) && keys.includes(JOB)
    if (retires) injected = true
    if (retires && timing === 'before') throw new Error('injected retirement failure')
    const result = await client.del(keys)
    if (retires && timing === 'after') throw new Error('injected retirement failure')
    return result
  } }))
  await expect(restoreBackupBundle(USER, bundle.bytes, { confirmReplace: true })).rejects.toThrow('injected retirement failure')
  await assertOriginal(value)
})

it.each([
  { type: 'json', value: null },
  { type: 'string', value: 'opaque old job text' },
  { type: 'set', value: ['a', 'z'] },
  { type: 'list', value: ['z', 'a', 'z'] },
  { type: 'hash', value: { raw: 'uninterpreted', version: '0' } },
  { type: 'zset', value: [{ value: 'a', score: -1.5 }, { value: 'z', score: 2.25 }] }
])('faithfully rolls back non-expiring opaque $type rows without decoding jobs', async ({ type, value }) => {
  const bundle = await baseArchive()
  // Test-local raw-client adapter supplies shapes the shared fake lacks (notably HASH).
  // Its method replies match node-redis; actual type fidelity is a separate held boundary.
  let row: { type: string; value: any; ttl: number } | null = { type, value: structuredClone(value), ttl: -1 }
  let failed = false
  const read = (expected: string) => {
    if (row && row.type !== expected) throw new Error('wrong Redis type')
    return row ? structuredClone(row.value) : null
  }
  const set = (nextType: string, nextValue: any) => { row = { type: nextType, value: structuredClone(nextValue), ttl: -1 }; return 'OK' }
  wrapClient((client) => ({ ...client,
    keys: async (pattern: string) => [...await client.keys(pattern), ...(row && pattern === `hair_import_job:${USER}:*` ? [JOB] : [])],
    type: async (key: string) => key === JOB ? row?.type === 'json' ? 'ReJSON-RL' : row?.type ?? 'none' : client.type(key),
    ttl: async (key: string) => key === JOB ? row?.ttl ?? -2 : client.ttl(key),
    expire: async (key: string, ttl: number) => { if (key === JOB && row) { row.ttl = ttl; return 1 }; return client.expire(key, ttl) },
    get: async (key: string) => key === JOB ? read('string') : client.get(key),
    set: async (key: string, next: any) => key === JOB ? set('string', next) : client.set(key, next),
    sMembers: async (key: string) => key === JOB ? read('set') ?? [] : client.sMembers(key),
    sAdd: async (key: string, next: string[]) => key === JOB ? set('set', next) : client.sAdd(key, next),
    lRange: async (key: string, start: number, stop: number) => key === JOB ? read('list') ?? [] : client.lRange(key, start, stop),
    rPush: async (key: string, next: string) => key === JOB ? set('list', [...(read('list') ?? []), next]) : client.rPush(key, next),
    hGetAll: async (key: string) => key === JOB ? read('hash') ?? {} : client.hGetAll(key),
    hSet: async (key: string, next: any) => key === JOB ? set('hash', next) : client.hSet(key, next),
    zRangeWithScores: async (key: string, start: number, stop: number) => key === JOB ? read('zset') ?? [] : client.zRangeWithScores(key, start, stop),
    zAdd: async (key: string, next: any) => key === JOB ? set('zset', next) : client.zAdd(key, next),
    json: { ...client.json,
      get: async (key: string) => key === JOB ? read('json') : client.json.get(key),
      set: async (key: string, jsonPath: string, next: any) => key === JOB ? set('json', next) : client.json.set(key, jsonPath, next)
    },
    del: async (keys: string | string[]) => {
      if ((Array.isArray(keys) ? keys : [keys]).includes(JOB)) row = null
      const result = await client.del(keys)
      if (!failed && Array.isArray(keys) && keys.includes(JOB)) { failed = true; throw new Error('injected post-retirement failure') }
      return result
    }
  }))
  await expect(restoreBackupBundle(USER, bundle.bytes, { confirmReplace: true })).rejects.toThrow('injected post-retirement failure')
  expect(row).toEqual({ type, value, ttl: -1 })
  expect(await fs.readFile(path.join(uploads, 'original.txt'), 'utf8')).toBe('original bytes')
})

it.each(['before', 'after'])('uses persisted final phase %s rename to replay or permanently retire authority', async (timing) => {
  const bundle = await baseArchive(); const value = await currentAuthority()
  const rename = fs.rename.bind(fs)
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    const final = String(target).endsWith('.restore-journal.json') && JSON.parse(await fs.readFile(source, 'utf8')).phase === 'redis-complete'
    if (final && timing === 'before') throw new Error('injected final marker interruption')
    await rename(source, target)
    if (final && timing === 'after') throw new Error('injected final marker interruption')
  })
  await expect(restoreBackupBundle(USER, bundle.bytes, { confirmReplace: true })).rejects.toThrow('injected final marker interruption')
  spy.mockRestore()
  const journals = (await fs.readdir(staging)).filter((name) => name.endsWith('.restore-journal.json'))
  const journal = JSON.parse(await fs.readFile(path.join(staging, journals[0]), 'utf8'))
  expect(journal.contract).toBe('batshit-backup-restore-journal/v3')
  expect(journal.phase).toBe(timing === 'before' ? 'redis-replacing' : 'redis-complete')
  await ensureBackupRestoreRecovery()
  if (timing === 'before') await assertOriginal(value)
  else { expect(await redis.type(JOB)).toBe('none'); expect(await redis.type(INDEX)).toBe('none'); expect(await redis.json.get(SETTINGS)).toEqual({ marker: 'archive' }) }
  expect((await fs.readdir(staging)).filter((name) => name.endsWith('.restore-journal.json'))).toEqual([])
})

it.each(['unsupported', 'read', 'type-read', 'ttl-read', 'namespace', 'expiry-zero', 'expiry-positive'])('refuses %s capture before replacing files or records', async (kind) => {
  const bundle = await baseArchive(); const value = await currentAuthority()
  wrapClient((client) => ({ ...client,
    type: async (key: string) => { if (kind === 'type-read' && key === JOB) throw new Error('injected TYPE failure'); return kind === 'unsupported' && key === JOB ? 'stream' : client.type(key) },
    ttl: async (key: string) => { if (kind === 'ttl-read' && key === JOB) throw new Error('injected TTL failure'); return key === JOB && kind.startsWith('expiry-') ? kind === 'expiry-zero' ? 0 : 3600 : client.ttl(key) },
    keys: async (pattern: string) => kind === 'namespace' && pattern.startsWith('hair_import_job:') ? ['hair_import_job:other-user:keep'] : client.keys(pattern),
    json: { ...client.json, get: async (key: string) => { if (kind === 'read' && key === JOB) throw new Error('injected raw read failure'); return client.json.get(key) } }
  }))
  await expect(restoreBackupBundle(USER, bundle.bytes, { confirmReplace: true })).rejects.toThrow()
  vi.restoreAllMocks()
  vi.mocked(redis.execute).mockImplementation(executeUnwrapped)
  await assertOriginal(value)
  expect((await fs.readdir(uploads)).some((name) => name.startsWith('.restore-'))).toBe(false)
})

it('requires destructive confirmation when only target cleanup authority exists', async () => {
  const bundle = await baseArchive()
  await redis.del(SETTINGS)
  const value = await currentAuthority()
  await expect(restoreBackupBundle(USER, bundle.bytes)).rejects.toMatchObject({ status: 409, details: { currentRecordCount: 2 } })
  expect(await redis.json.get(JOB)).toEqual(value)
  expect(await redis.type(INDEX)).toBe('set')
})

it('replays the exact opaque string index instead of reconstructing its membership', async () => {
  const bundle = await baseArchive(); await currentAuthority()
  await redis.del(INDEX); await redis.set(INDEX, 'obsolete-index-format')
  let injected = false
  wrapClient((client) => ({ ...client, del: async (keys: string | string[]) => {
    const result = await client.del(keys)
    if (!injected && Array.isArray(keys) && keys.includes(INDEX)) { injected = true; throw new Error('injected retirement failure') }
    return result
  } }))
  await expect(restoreBackupBundle(USER, bundle.bytes, { confirmReplace: true })).rejects.toThrow('injected retirement failure')
  expect(await redis.type(INDEX)).toBe('string')
  expect(await redis.get(INDEX)).toBe('obsolete-index-format')
})

it('does not resurrect a key that disappears during capture', async () => {
  const bundle = await baseArchive(); await currentAuthority()
  wrapClient((client) => ({ ...client, json: { ...client.json, get: async (key: string) => {
    if (key === JOB) { await client.del(JOB); return null }
    return client.json.get(key)
  } } }))
  await restoreBackupBundle(USER, bundle.bytes, { confirmReplace: true })
  expect(await redis.type(JOB)).toBe('none'); expect(await redis.type(INDEX)).toBe('none')
})

it.each(['job', 'index'])('never exports or admits an incoming %s cleanup authority', async (kind) => {
  const bundle = await baseArchive(); await currentAuthority()
  const entries = unzipSync((await createBackupBundle(USER)).bytes)
  const records = Object.keys(entries).filter((name) => name.startsWith('redis/records/')).map((name) => JSON.parse(Buffer.from(entries[name]).toString()))
  expect(records.some((record) => record.key === JOB || record.key === INDEX)).toBe(false)
  const old = unzipSync(bundle.bytes)
  const record = { key: kind === 'job' ? JOB : INDEX, type: 'json', value: {}, groupId: 'goons', ttlSeconds: null }
  old['redis/records/injected.json'] = new TextEncoder().encode(JSON.stringify(record))
  const manifest = JSON.parse(Buffer.from(old['manifest.json']).toString()); manifest.contents.redisRecordCount++
  old['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
  await expect(restoreBackupBundle(USER, zipSync(old), { confirmReplace: true })).rejects.toThrow('will not restore')
})
