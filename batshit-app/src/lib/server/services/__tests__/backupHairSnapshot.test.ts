// @vitest-environment node
// Pure classification/reply coverage; this file does not prove the read-only Lua cut.
import { describe, expect, it, vi } from 'vitest'
import { hairImportCandidateIds } from '../hairImportCandidateIdentity'
import {
  HAIR_BACKUP_SNAPSHOT_LIMITS, HAIR_BACKUP_SNAPSHOT_SCRIPT, parseHairBackupSnapshot,
  readHairBackupSnapshot, stagedHairUploadKeys, type HairSnapshotRecord
} from '../backupHairSnapshot'

const SHA = 'a'.repeat(64)
function record(key: string, value: unknown): HairSnapshotRecord { return { key, type: 'json', value, ttlSeconds: null } }
function job(extra: Record<string, any> = {}): any {
  return { contract: 'hair-import-job/v4', userId: 'user', jobId: 'job', status: 'preparing', stateVersion: 2,
    goonId: 'goon', startingTransform: {}, initialTransform: {}, calibration: null,
    target: { kind: 'new' }, candidate: null, cleanupFiles: [], ...extra }
}
function artifact(owner = job(), extra: Record<string, any> = {}) {
  const { assetId, revisionId } = hairImportCandidateIds(owner)
  const role = 'geometry'
  const filename = `${assetId}_${revisionId}_${role}_${SHA}.glb`
  const value = { storage: 'filesystem', uploadType: 'goon_hair_assets', filename,
    relativePath: `goon_hair_assets/${filename}`, sha256: SHA, size: 3, mimetype: 'model/gltf-binary',
    hairAssetArtifact: { assetId, revisionId, role, sha256: SHA },
    hairImportUpload: { contract: 'hair-import-upload/v1', userId: owner.userId, jobId: owner.jobId,
      assetId, revisionId, role, sha256: SHA, filename, bytes: 3 }, ...extra }
  return record(`upload:goon_hair_assets:${filename}`, value)
}
function snapshot(...records: HairSnapshotRecord[]) { return new Map(records.map((item) => [item.key, item])) }
function ownerRecord(owner = job()) { return record(`hair_import_job:${owner.userId}:${owner.jobId}`, owner) }

it('omits a canonical candidate in the pre-CAS window with exact current identity', () => {
  const file = artifact()
  expect(stagedHairUploadKeys(snapshot(file, ownerRecord()))).toEqual(new Set([file.key]))
  const refit = job({ target: { kind: 'refit', assetId: 'saved-style', revisionId: 'saved-style-r2', revision: 2 } })
  const refitFile = artifact(refit)
  expect(stagedHairUploadKeys(snapshot(refitFile, ownerRecord(refit)))).toEqual(new Set([refitFile.key]))
})

it('keeps actual encoded Clip URL borrowers while ignoring content/description/tag mentions', () => {
  const file = artifact()
  const filename = (file.value as any).filename
  const base = snapshot(file, ownerRecord())
  const prose = { key: 'clip:user:text', value: { content: `/uploads/goon_hair_assets/${filename}`,
    description: `/uploads/goon_hair_assets/${filename}`, tags: [`/uploads/goon_hair_assets/${filename}`] } }
  expect(stagedHairUploadKeys(base, [prose])).toEqual(new Set([file.key]))
  for (const field of ['tunnelPath', 'localUrl', 'displayUrl', 'externalUrl', 'thumbnailUrl', 'fullResolutionUrl']) {
    expect(stagedHairUploadKeys(base, [{ key: 'clip:user:media', value: { [field]: `/uploads/%67oon_hair_assets/${filename}` } }]))
      .toEqual(new Set())
  }
  expect(stagedHairUploadKeys(base, [{ key: 'clip:user:legacy', value: JSON.stringify({ localUrl: `/uploads/%67oon_hair_assets/${filename}` }) }]))
    .toEqual(new Set())
})

it.each([
  ['lost owner', null], ['complete', job({ status: 'complete' })], ['obsolete', job({ contract: 'hair-import-job/v3' })],
  ['missing goon', job({ goonId: undefined })], ['missing transform', job({ startingTransform: undefined })],
  ['missing calibration', job({ calibration: undefined })], ['foreign candidate', job({ candidate: { assetId: 'foreign', revisionId: 'foreign-r1' } })],
  ['changed target', job({ target: { kind: 'refit', assetId: 'foreign', revisionId: 'foreign-r1', revision: 1 } })],
  ['malformed cleanup', job({ cleanupFiles: [{ ref: '/uploads/goon_hair_assets/anything' }] })]
])('carries a receipt with %s instead of treating its permanent origin tag as disposal authority', (_label, owner) => {
  const file = artifact()
  expect(stagedHairUploadKeys(snapshot(file, ...(owner ? [ownerRecord(owner)] : [])))).toEqual(new Set())
})

it('carries mismatched hash/path/role/bytes/owner receipts and untagged old files', () => {
  for (const change of [{ sha256: 'b'.repeat(64) }, { filename: 'foreign.glb' }, { role: 'preview' }, { bytes: 4 },
    { userId: 'user:job', jobId: '' }, { contract: 'older' }, { extra: 'unexpected' }]) {
    const file = artifact()
    ;(file.value as any).hairImportUpload = { ...(file.value as any).hairImportUpload, ...change }
    expect(stagedHairUploadKeys(snapshot(file, ownerRecord()))).toEqual(new Set())
  }
  expect(stagedHairUploadKeys(snapshot(artifact(job(), { hairImportUpload: undefined }), ownerRecord()))).toEqual(new Set())
})

it('accepts exact current cleanup ownership for older files, never a refit target mention', () => {
  const file = artifact(job(), { hairImportUpload: undefined })
  const value = file.value as any
  const cleanup = { uploadType: value.uploadType, filename: value.filename, ref: `/uploads/${value.relativePath}`,
    sha256: value.sha256, bytes: value.size, mimeType: value.mimetype }
  expect(stagedHairUploadKeys(snapshot(file, ownerRecord(job({ cleanupFiles: [cleanup] }))))).toEqual(new Set([file.key]))
  expect(stagedHairUploadKeys(snapshot(file, ownerRecord(job({ target: { kind: 'refit', assetId: 'old', revisionId: 'old-r2', revision: 2, refitSource: cleanup } }))))).toEqual(new Set())
})

it.each(['hair_asset:user:style:r1', 'hair_refit_source:user:style:r1'])('retained %s and shared refs win over unfinished cleanup ownership', (key) => {
  const file = artifact()
  const ref = `/uploads/${(file.value as any).relativePath}`
  const retained = record(key, { source: { ref } })
  expect(stagedHairUploadKeys(snapshot(file, ownerRecord(), retained))).toEqual(new Set())
  expect(stagedHairUploadKeys(snapshot(file, ownerRecord()), [{ value: { hair: { assetId: 'imported-hair-job', revisionId: 'imported-hair-job-r1' } } }])).toEqual(new Set())
})

it('omits only validated supported raw staging, including before job creation; a durable ref wins', () => {
  const filename = `1791750000000_12345678-1234-1234-1234-123456789abc_${SHA}.obj`
  const file = record(`upload:goon_hair_imports:${filename}`, {
    storage: 'filesystem', uploadType: 'goon_hair_imports', filename, relativePath: `goon_hair_imports/${filename}`,
    sha256: SHA, size: 3, hairImportSource: { sha256: SHA, stagedAt: '2026-10-12T00:00:00.000Z' }
  })
  expect(stagedHairUploadKeys(snapshot(file))).toEqual(new Set([file.key]))
  expect(stagedHairUploadKeys(snapshot(file), [{ value: { oldRef: `http://localhost:5600/uploads/goon_hair_imports/${filename}` } }])).toEqual(new Set())
  ;(file.value as any).hairImportSource.sha256 = 'b'.repeat(64)
  expect(stagedHairUploadKeys(snapshot(file))).toEqual(new Set())
})

it('parses original JSON.GET text in JS and keeps nested full-precision numbers and one-entry arrays', async () => {
  const raw = '{"matrix":[0.12345678901234568],"revisionSha256":"untouched"}'
  const evalCut = vi.fn(async () => ['OK', ['hair_asset:user:a:r1', 'json', -1, raw],
    ['user:user:hair_assets', 'set', 45, ['z@r1', 'a@r1']]])
  const result = await readHairBackupSnapshot({ eval: evalCut })
  expect(result.get('hair_asset:user:a:r1')?.value).toEqual(JSON.parse(raw))
  expect(result.get('user:user:hair_assets')).toMatchObject({ value: ['a@r1', 'z@r1'], ttlSeconds: 45 })
  expect(evalCut).toHaveBeenCalledWith(HAIR_BACKUP_SNAPSHOT_SCRIPT, { keys: [], arguments: [4096, 256 * 1024 * 1024, 4096, 128 * 1024 * 1024].map(String) })
  expect(HAIR_BACKUP_SNAPSHOT_LIMITS.recordBytes).toBeGreaterThan(64 * 1024 * 1024 * 4 / 3)
})

it.each([['LIMIT', 'record count'], ['LIMIT', 'record bytes'], ['LIMIT', 'collection items'], ['READ_FAILED', 'record read']])('refuses %s/%s without accepting a truncated cut', (status, reason) => {
  expect(() => parseHairBackupSnapshot([status, reason])).toThrow(/Retry backup/)
})

it('requires EVAL instead of a sequential production fallback', async () => {
  await expect(readHairBackupSnapshot({})).rejects.toThrow(/atomic Redis snapshot/)
})

it.each(['revision-key', 'sidecar-key', 'index'])('retained %s identity conserves files even when legacy metadata lost its refs', (kind) => {
  const file = artifact()
  const retained = kind === 'index'
    ? { key: 'user:user:hair_assets', type: 'set' as const, value: ['imported-hair-job@imported-hair-job-r1'], ttlSeconds: null }
    : record(`${kind === 'sidecar-key' ? 'hair_refit_source' : 'hair_asset'}:user:imported-hair-job:imported-hair-job-r1`, { legacy: 'lost refs' })
  expect(stagedHairUploadKeys(snapshot(file, ownerRecord(), retained))).toEqual(new Set())
})
