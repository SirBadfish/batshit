// @vitest-environment node
// Actual buffered/streamed export and audit over owned files/default Redis. Test-local reply
// adapter supplies the cut; this proves consumer ordering, not Redis atomicity.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate/node'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import * as hairSnapshot from '../backupHairSnapshot'
import { auditBackupUploadFiles, createBackupBundle, createBackupBundleStream, restoreBackupBundle } from '../backupRestoreService'
import { uploadRecordFingerprint, archivedRecordSha256 } from '../backupUploadInspection'

const hooks = vi.hoisted(() => ({ beforeCut: null as null | (() => Promise<void>), afterCut: null as null | (() => Promise<void>) }))
vi.mock('../backupHairSnapshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backupHairSnapshot')>()
  return { ...original, readHairBackupSnapshot: async (client: any) => {
    if (process.env.VITEST_USE_REAL_REDIS === 'true') return original.readHairBackupSnapshot(client)
    if (hooks.beforeCut) { const hook = hooks.beforeCut; hooks.beforeCut = null; await hook() }
    const { fakeHairSnapshotAnswer } = await import('./fixtures/hairSnapshotFake')
    const answer = await fakeHairSnapshotAnswer(client)
    if (hooks.afterCut) { const hook = hooks.afterCut; hooks.afterCut = null; await hook() }
    return original.readHairBackupSnapshot({ eval: async () => answer })
  } }
})
useRedisTestServer()
const USER = 'hair_backup_user'
let root = ''
let uploadRoot = ''
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-hair-backup-'))
  uploadRoot = path.join(root, 'uploads')
  await fs.mkdir(uploadRoot)
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', path.join(root, 'staging'))
  vi.stubEnv('BATSHIT_TOKEN', 'synthetic-hair-backup-test-token')
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: any) => {
    if (!/\/api\/upload\/asset-maintenance\/(begin|end)$/.test(String(url))) throw new Error('unexpected network request')
    const { token } = JSON.parse(options.body)
    return Response.json({ success: true, token, state: String(url).endsWith('/begin') ? 'created' : 'released', activeOperations: 0 })
  }))
})
afterEach(async () => {
  hooks.beforeCut = hooks.afterCut = null
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})
function owner() { return { contract: 'hair-import-job/v4', userId: USER, jobId: 'job', status: 'preparing', stateVersion: 2,
    goonId: 'goon', startingTransform: {}, initialTransform: {}, calibration: null,
  target: { kind: 'new' }, candidate: null, cleanupFiles: [] } }
async function upload(type: string, filename: string, extra: Record<string, any> = {}, exists = true) {
  const bytes = 'hair bytes'
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const key = `upload:${type}:${filename}`
  const value = { uploadType: type, filename, originalName: filename, relativePath: `${type}/${filename}`,
    storage: 'filesystem', filePath: path.join(uploadRoot, type, filename), size: bytes.length, sha256,
    mimetype: 'model/gltf-binary', uploadedAt: '2026-10-12T00:00:00.000Z', ...extra }
  await redis.json.set(key, '$', value)
  if (exists) { await fs.mkdir(path.join(uploadRoot, type), { recursive: true }); await fs.writeFile(value.filePath, bytes) }
  return { key, value }
}
async function candidate(exists = true) {
  const sha256 = createHash('sha256').update('hair bytes').digest('hex')
  const assetId = 'imported-hair-job', revisionId = `${assetId}-r1`, role = 'geometry'
  const filename = `${assetId}_${revisionId}_${role}_${sha256}.glb`
  const file = await upload('goon_hair_assets', filename, {
    hairAssetArtifact: { assetId, revisionId, role, sha256 },
    hairImportUpload: { contract: 'hair-import-upload/v1', userId: USER, jobId: 'job', assetId, revisionId, role,
      sha256, filename, bytes: 10 }
  }, exists)
  return { ...file, assetId, revisionId }
}
async function rawStaging(exists = false) {
  const sha256 = createHash('sha256').update('hair bytes').digest('hex')
  return upload('goon_hair_imports', `1791750000000_12345678-1234-1234-1234-123456789abc_${sha256}.glb`, {
    hairImportSource: { sha256, stagedAt: '2026-10-12T00:00:00.000Z' }
  }, exists)
}
function archive(bytes: Uint8Array) {
  const entries = unzipSync(bytes)
  const records = Object.keys(entries).filter((key) => key.startsWith('redis/records/')).map((key) => JSON.parse(Buffer.from(entries[key]).toString()))
  return { entries, records, manifest: JSON.parse(Buffer.from(entries['manifest.json']).toString()) }
}

it('both export paths and upload audit omit positively staged pre-job/pre-CAS files without excluding unknown old files', async () => {
  const raw = await rawStaging()
  const staging = await candidate(false)
  await redis.json.set(`hair_import_job:${USER}:job`, '$', owner())
  const old = await upload('goon_hair_imports', 'old-untagged.glb')
  const orphan = await upload('goon_hair_assets', 'old-lost-owner.glb')
  const check = await auditBackupUploadFiles(USER)
  expect(check).toMatchObject({ problemCount: 0, fileBackedCount: 2, foundCount: 2 })
  const buffered = archive((await createBackupBundle(USER)).bytes)
  const streamed = await createBackupBundleStream(USER)
  const actualStream = archive(new Uint8Array(await new Response(streamed.stream).arrayBuffer()))
  for (const result of [buffered, actualStream]) {
    const keys = result.records.map((record: any) => record.key)
    expect(keys).toContain(old.key); expect(keys).toContain(orphan.key)
    expect(keys).not.toContain(raw.key); expect(keys).not.toContain(staging.key)
    expect(keys.some((key: string) => key.startsWith('hair_import_job:'))).toBe(false)
    expect(result.manifest.contents.fileAssetCount).toBe(2)
    expect(Object.keys(result.entries).filter((key) => key.startsWith('files/uploads/'))).toHaveLength(2)
  }
  expect(actualStream.records).toEqual(buffered.records)
})

it('completed sidecar and retained Goon paths win, including a shared refit source and raw legacy reference', async () => {
  const staging = await candidate()
  const raw = await rawStaging(true)
  await redis.json.set(`hair_import_job:${USER}:job`, '$', owner())
  await redis.json.set(`hair_refit_source:${USER}:old:old-r1`, '$', { source: { ref: `/uploads/${staging.value.relativePath}` } })
  // A durable owner outside the normal indexed archive collection still protects bytes.
  await redis.json.set('goon:owned', '$', { user_id: USER, retained: `/uploads/${raw.value.relativePath}` })
  expect((await auditBackupUploadFiles(USER)).fileBackedCount).toBe(2)
  const result = archive((await createBackupBundle(USER)).bytes)
  expect(result.records.map((record: any) => record.key)).toEqual(expect.arrayContaining([staging.key, raw.key]))
  expect(result.records.some((record: any) => record.key === 'goon:owned')).toBe(false)
})

it('the archived index/revision/sidecar all come from the cut even when publication followed generic key discovery', async () => {
  const file = await candidate()
  await redis.sAdd(`user:${USER}:hair_assets`, 'old@old-r1')
  const precise = 0.12345678901234568
  hooks.beforeCut = async () => {
    await redis.json.set(`hair_asset:${USER}:${file.assetId}:${file.revisionId}`, '$', { assetId: file.assetId, revisionId: file.revisionId, matrix: [precise] })
    await redis.json.set(`hair_refit_source:${USER}:${file.assetId}:${file.revisionId}`, '$', { source: { ref: `/uploads/${file.value.relativePath}` } })
    await redis.sAdd(`user:${USER}:hair_assets`, `${file.assetId}@${file.revisionId}`)
    await redis.del(`hair_import_job:${USER}:job`)
  }
  hooks.afterCut = async () => { await redis.sRem(`user:${USER}:hair_assets`, `${file.assetId}@${file.revisionId}`) }
  const result = archive((await createBackupBundle(USER)).bytes)
  const byKey = new Map(result.records.map((record: any) => [record.key, record])) as Map<string, any>
  expect(byKey.get(`user:${USER}:hair_assets`).value).toContain(`${file.assetId}@${file.revisionId}`)
  expect(byKey.get(`hair_asset:${USER}:${file.assetId}:${file.revisionId}`).value.matrix).toEqual([precise])
  expect(byKey.has(`hair_refit_source:${USER}:${file.assetId}:${file.revisionId}`)).toBe(true)
  expect(byKey.has(file.key)).toBe(true)
})

it('partial fingerprints use the same captured upload value, before normalization, without a later owner/read refresh', async () => {
  const file = await candidate(false) // lost job owner: preserve the record, acknowledge its missing file
  const check = await auditBackupUploadFiles(USER)
  const acknowledged = check.problems.map(({ key, relativePath, fingerprint }) => ({ key, relativePath, fingerprint }))
  expect(acknowledged[0].fingerprint).toBe(uploadRecordFingerprint(file.key, file.value))
  hooks.afterCut = async () => { await redis.json.set(file.key, '$', { ...file.value, originalName: 'changed-after-cut' }) }
  const result = archive((await createBackupBundle(USER, { partial: { acknowledged, confirmAllMissing: true } })).bytes)
  const archived = result.records.find((record: any) => record.key === file.key)
  expect(archived.value.originalName).toBe(file.value.originalName)
  expect(result.manifest.uploads.missing).toEqual([{ ...acknowledged[0], kind: 'missing', archivedRecordSha256: archivedRecordSha256(archived) }])
})

it('an old archive still restores tagged raw staging bytes without reconstructing a job owner', async () => {
  const file = await rawStaging(true)
  const selector = vi.spyOn(hairSnapshot, 'stagedHairUploadKeys').mockReturnValue(new Set())
  const oldArchive = await createBackupBundle(USER)
  selector.mockRestore()
  await restoreBackupBundle('restored', oldArchive.bytes, { confirmReplace: true })
  expect(await redis.json.get(file.key)).toMatchObject({ hairImportSource: file.value.hairImportSource })
  expect(await fs.readFile(path.join(uploadRoot, file.value.relativePath), 'utf8')).toBe('hair bytes')
  expect(await redis.keys('hair_import_job:*')).toEqual([])
})

it('refuses stale partial selection of positively staged records instead of claiming they disappeared', async () => {
  const raw = await rawStaging()
  const partial = { acknowledged: [{ key: raw.key, relativePath: raw.value.relativePath, fingerprint: uploadRecordFingerprint(raw.key, raw.value) }] }
  for (const exportBackup of [createBackupBundle, createBackupBundleStream]) {
    const error = await exportBackup(USER, { partial }).catch((error) => error)
    expect(error).toMatchObject({ status: 409, details: { reasons: ['staged-import'] } })
    expect(error.message).toContain('Run Check Upload Files again')
    expect(error.message).not.toContain(raw.value.filename)
    expect(error.message).not.toContain('no longer exists')
  }
  expect(await redis.json.get(raw.key)).toEqual(raw.value)
})

it.each(['root', 'unreadable'])('keeps %s500 ahead of staged-partial409 refusal', async (kind) => {
  const raw = await rawStaging()
  const orphan = await upload('goon_hair_assets', 'unknown.glb', {}, false)
  if (kind === 'root') await fs.rmdir(uploadRoot)
  else {
    const stat = fs.stat
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: any[]) => {
      if (String(args[0]) === orphan.value.filePath) throw Object.assign(new Error('synthetic unreadable'), { code: 'EACCES' })
      return (stat as any)(...args)
    })
  }
  const partial = { acknowledged: [{ key: raw.key, relativePath: raw.value.relativePath, fingerprint: uploadRecordFingerprint(raw.key, raw.value) }] }
  const error = await createBackupBundle(USER, { partial }).catch((error) => error)
  expect(error.status).toBe(500)
  expect(await redis.json.get(raw.key)).toEqual(raw.value)
})
