import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { collectAllGoonUploadReferencesForClient, deleteGoonUploadAssetDisposition } from '../goonAssetCleanupService'
import { createHairImportJob, hairImportCleanupContext, replaceHairImportJob, retireHairImportJob } from '../hairImportJobRepository.server'

const raw = { uploadType: 'goon_hair_imports' as const, filename: 'raw.obj', originalName: 'raw.obj',
  ref: '/uploads/goon_hair_imports/raw.obj', sha256: 'a'.repeat(64), bytes: 20, mimeType: 'text/plain' }
const shared = { uploadType: 'goon_hair_assets' as const,
  filename: `asset_r2_neutral-value_${'b'.repeat(64)}.png`,
  ref: `/uploads/goon_hair_assets/asset_r2_neutral-value_${'b'.repeat(64)}.png`,
  sha256: 'b'.repeat(64), bytes: 100, mimeType: 'image/png' }
const borrowed = { ...shared, filename: 'borrowed.glb', ref: '/uploads/goon_hair_assets/borrowed.glb', mimeType: 'model/gltf-binary' }

describe('Hair shared cleanup ownership (default reference walk, not Lua or physical IO)', () => {
  useRedisTestServer()
  let restoreExecute: (() => void) | undefined
  beforeEach(() => { vi.stubEnv('BATSHIT_TOKEN', 'synthetic-hair-file-test-token') })
  afterEach(() => {
    vi.restoreAllMocks()
    restoreExecute?.()
    restoreExecute = undefined
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('refuses unknown completed ownership and releases its still-reserved claim before any DELETE', async () => {
    const recordKey = 'hair_asset:owner:legacy:r1'
    const original = { legacy: 'lost shared/noncanonical file refs' }
    await redis.json.set(recordKey, '$', original)
    const markerKey = `goon_asset_delete:goon_hair_assets:${shared.filename}`
    const markers = new Map<string, { contract: string; token: string; phase: string }>()
    const originalExecute = vi.mocked(redis.execute).getMockImplementation()!
    const client = await redis.execute(async (client: any) => client)
    restoreExecute = () => vi.mocked(redis.execute).mockImplementation(originalExecute)
    vi.spyOn(redis, 'execute').mockImplementation((operation: any) =>
      operation({ ...client, eval: async (_script: string, options: any) => {
        const marker = markers.get(options.keys[0])
        if (marker?.contract === 'goon-asset-deletion/v1' && marker.token === options.arguments[0] && marker.phase === 'reserved') {
          markers.delete(options.keys[0]); return 1
        }
        return 0
      } }))
    const fetcher = vi.fn(async (url: string) => {
      if (!url.endsWith('/asset-deletion/reserve')) throw new Error('Physical DELETE must not start')
      const reservation = { contract: 'goon-asset-deletion/v1', token: '00000000-0000-4000-8000-000000000001', phase: 'reserved' }
      markers.set(markerKey, reservation)
      return Response.json({ reservation })
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(deleteGoonUploadAssetDisposition('goon_hair_assets', shared.filename)).rejects.toThrow(recordKey)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(markers.size).toBe(0)
    expect(await redis.json.get(recordKey)).toEqual(original)
  })

  it('refuses a positive retained index whose ownership row is missing', async () => {
    await redis.sAdd('user:owner:hair_assets', 'asset@r2')
    await expect(redis.execute((client: any) => collectAllGoonUploadReferencesForClient(client,
      { candidateFiles: [shared] }))).rejects.toThrow('hair_asset:owner:asset:r2')
    expect(await redis.sMembers('user:owner:hair_assets')).toEqual(['asset@r2'])
  })

  it('keeps an old live candidate when a failed prepare cleanup receipt reuses its file', async () => {
    let job = await createHairImportJob({ userId: 'owner', goonId: 'goon', source: raw, inspection: {}, jobId: 'failed-prepare' })
    job = await replaceHairImportJob(job, { ...job, status: 'preparing', candidate: { files: { neutralValue: shared } }, cleanupFiles: [raw, shared] })
    const refs = await redis.execute((client: any) => collectAllGoonUploadReferencesForClient(client,
      { cleanupContext: hairImportCleanupContext(job, [shared]) }))
    expect(refs.has(`goon_hair_assets/${shared.filename}`)).toBe(true)
  })

  it('retires only owned raw/candidate refs and keeps a cancelled refit borrowed source', async () => {
    let job = await createHairImportJob({ userId: 'owner', goonId: 'goon', source: raw, inspection: {}, jobId: 'refit',
      target: { kind: 'refit', assetId: 'asset', revisionId: 'r2', revision: 2, sourceRevisionId: 'r1',
        displayName: 'Hair', author: 'User', license: 'user-provided', originalSourceSha256: raw.sha256, refitSource: borrowed } })
    job = await replaceHairImportJob(job, { ...job, status: 'reviewable', candidate: { files: { neutralValue: shared } }, cleanupFiles: [raw, shared] })
    job = await retireHairImportJob(job)
    const refs = await redis.execute((client: any) => collectAllGoonUploadReferencesForClient(client,
      { cleanupContext: hairImportCleanupContext(job, job.cleanupFiles) }))
    expect(refs.has(`goon_hair_imports/${raw.filename}`)).toBe(false)
    expect(refs.has(`goon_hair_assets/${shared.filename}`)).toBe(false)
    expect(refs.has(`goon_hair_assets/${borrowed.filename}`)).toBe(true)
  })

  it('keeps a second current target before its upload response/job CAS, even without upload metadata', async () => {
    const target = { kind: 'refit' as const, assetId: 'asset', revisionId: 'r2', revision: 2, sourceRevisionId: 'r1',
      displayName: 'Hair', author: 'User', license: 'user-provided', originalSourceSha256: raw.sha256, refitSource: borrowed }
    await createHairImportJob({ userId: 'owner', goonId: 'other-goon', source: raw, target, inspection: {}, jobId: 'other-current-job' })
    const refs = await redis.execute((client: any) => collectAllGoonUploadReferencesForClient(client,
      { candidateFiles: [shared] }))
    expect(refs.has(`goon_hair_assets/${shared.filename}`)).toBe(true)
  })

  it('keeps completed, sidecar and legacy direct references; rejects a stale same-job subset', async () => {
    await redis.json.set('hair_asset:owner:asset:r2', '$', { material: { neutralValue: shared } })
    await redis.json.set('hair_refit_source:owner:asset:r2', '$', { source: borrowed })
    await redis.json.set('goon:legacy', '$', { receipt: { ref: shared.ref } })
    const job = await createHairImportJob({ userId: 'owner', goonId: 'goon', source: raw, inspection: {}, jobId: 'stale' })
    await replaceHairImportJob(job, { ...job, status: 'preparing' })
    await expect(redis.execute((client: any) => collectAllGoonUploadReferencesForClient(client,
      { cleanupContext: hairImportCleanupContext(job, [raw]) }))).rejects.toThrow('Hair import changed')
    const refs = await redis.execute((client: any) => collectAllGoonUploadReferencesForClient(client))
    expect([...refs.get(`goon_hair_assets/${shared.filename}`)!]).toEqual(expect.arrayContaining(['hair_asset:owner:asset:r2', 'goon:legacy']))
    expect(refs.has(`goon_hair_assets/${borrowed.filename}`)).toBe(true)
  })

  it('does not reacquire a consumed raw source while preserving current candidate refs', async () => {
    const job = await createHairImportJob({ userId: 'owner', goonId: 'goon', source: raw, inspection: {}, jobId: 'finalizing' })
    const ready = await replaceHairImportJob(job, { ...job, status: 'reviewable', candidate: { files: { neutralValue: shared } }, cleanupFiles: [raw, shared] })
    const refs = await redis.execute((client: any) => collectAllGoonUploadReferencesForClient(client,
      { cleanupContext: hairImportCleanupContext(ready, [raw], 'source-consumed') }))
    expect(refs.has(`goon_hair_imports/${raw.filename}`)).toBe(false)
    expect(refs.has(`goon_hair_assets/${shared.filename}`)).toBe(true)
  })
})
