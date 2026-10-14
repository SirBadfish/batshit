// @vitest-environment node
// HELD actual Redis + finite loopback file-service proof. The controller binds
// all roots before imports and admits app/admin/backend to the same owned DB14.
// Synthetic prepared assets qualify ownership/IO ordering, not Hair artwork,
// Blender preparation, product auth, ordinary data, or full app integration.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { collectHairAssetFileRefs, createHairState, hairAssetRevisionSha256, hairFitReceiptSha256,
  hairMaterialDefinitionSha256, verifyHairAsset } from '$lib/goons/hairAssets'
import { createHairAssetFixture, createRigidHairGlbFixture } from '$lib/goons/recipe/fixtures/hairAssetFixture'
import { GOON_RECIPE_AUTHORING_REVISION_CONTRACT, GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_STATE_CONTRACT, RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT, RECIPE_SOURCE_CONTRACT,
  parseGoonRecipeV2 } from '$lib/goons/recipe'
import type { RecipeSource } from '$lib/goons/recipe/recipeContracts'
import type { GoonRecord } from '$lib/types/goons'
import { buildImportedHairRefitSource } from '../hairImportAssetFactory.server'
import { beginHairRefit, discardHairImportJob } from '../hairImportLifecycle.server'
import { createHairImportJob, getHairImportJobForCleanup, hairImportCleanupContext,
  listDiscardableHairImportJobs, replaceHairImportJob, retireDiscardableHairImportJob,
  retireHairImportJob, trackRetiredHairCleanupFiles, type HairImportJob, type HairImportOwnedFile } from '../hairImportJobRepository.server'
import { createHairImportTexturePng, deleteHairImportOwnedFile, discoverHairImportCleanupFiles,
  stageHairImportSource, storeHairAssetArtifact } from '../hairImportOwnedFiles.server'
import { commitImportedHairAssetRevision, deleteUserHairAssetRevision, putUserHairAssetRevision } from '../hairAssetRepository.server'
import { auditGoonUploadAssets, cleanupOrphanGoonUploadAssets, deleteGoonUploadAssetDisposition,
  deleteReservedGoonUploadAsset, releaseGoonUploadReservation, reserveGoonUploadAsset } from '../goonAssetCleanupService'
import { patchOwnedGoonForClient } from '../goonMutationRepository.server'
import { compareAndSwapRecipeState } from '../goonRecipeRepository.server'
import { storeGoonReferenceRecordForClient } from '../goonCustomAssetOwnership.server'
import { saveClipRecord } from '../clipPersistence.server'
import { deleteUserClip } from '../clipDeletion'
import { readHairBackupSnapshot, stagedHairUploadKeys } from '../backupHairSnapshot'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'hair-fence-user'
const GOON = 'hair-fence-goon'
const ZERO = '0'.repeat(64)
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const transform = { move: { x: 0, y: 1.65, z: 0 }, rotate: { x: 0, y: 0, z: 0 }, uniformScale: 1, axisScale: { x: 1, y: 1, z: 1 } }
const identities = { contract: RECIPE_SOURCE_CONTRACT, schemaVersion: 1, baseId: 'batshit-base-female',
  fitFamily: 'batshit-base-female-v1', modelSha256: '3'.repeat(64), manifestSemanticSha256: '5'.repeat(64),
  definitionSha256: '6'.repeat(64), neutralId: 'neutral-1', neutralRecipeSha256: '7'.repeat(64),
  physicalBasisSha256: '8'.repeat(64), behaviorSha256: '9'.repeat(64), componentGraphSha256: 'a'.repeat(64),
  topologySha256: 'b'.repeat(64), skeletonHierarchySha256: 'c'.repeat(64) }
const recipeSource = { package: { ref: 'goons/source.bgoon', sha256: '2'.repeat(64) },
  model: { ref: 'goons/source.glb', sha256: '3'.repeat(64) }, manifest: { ref: 'goons/source.json', sha256: '4'.repeat(64) }, identities } as RecipeSource
function recipeOwner() {
  return parseGoonRecipeV2({ contract: GOON_RECIPE_OWNER_V2_CONTRACT, writeVersion: 1, nextRecipeRevision: 2,
    liveStatus: 'needs_bake', authoringRevision: { contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
      recipeRevision: 1, revisionId: 'revision-1', revisionSha256: '1'.repeat(64), source: recipeSource,
      state: { contract: GOON_RECIPE_STATE_CONTRACT, stateSha256: 'd'.repeat(64), appearanceDials: {
        contract: 'appearance-dial-values/v2', definitionSha256: identities.definitionSha256,
        neutralId: identities.neutralId, neutralRecipeSha256: identities.neutralRecipeSha256,
        values: { body_height: 0 }, unlockedDialIds: [] }, siblings: [] }, updateReport: null },
    authoringSourceContainmentReceipt: { contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
      ref: `goon_recipe_document:${USER}:${GOON}:${'5'.repeat(64)}`, sha256: '5'.repeat(64) },
    activeRevision: null, previousRevision: null, pendingAnalysis: null, pendingJob: null,
    latestUpdateReport: null, lastFailure: null, maintenanceFailure: null })
}

describe.skipIf(!REAL)('Hair/Clip shared cleanup actual Redis + owned file service', () => {
  useRedisTestServer()
  let backend: any, server: any, baseUrl: string, uploads: string
  let publicationQueue: any
  let queueArrival: ((index: number) => void) | undefined
  async function bounded<T>(promise: Promise<T>, label: string, timeout = 5000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned fixture ${label} did not arrive within ${timeout}ms.`)), timeout)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  beforeAll(async () => {
    const appRoot = process.env.HAIR_CASE_APP_ROOT!
    const owned = process.env.HAIR_CASE_OWNED_ROOT!
    assert(appRoot && owned && process.env.HAIR_CASE_REDIS_RUN_ID)
    assert.equal(process.cwd(), appRoot)
    // Normal refit/repository admission reads the pinned source-static catalog
    // and its trusted bytes. The controller admits that read-only input tree.
    await fs.access(path.join(appRoot, 'static/goon-assets/hair/v2/catalog.json'))
    uploads = process.env.UPLOADS_DIR!
    assert.equal(path.dirname(uploads), owned)
    assert.equal(new URL(process.env.REDIS_URL!).pathname, '/14')
    const require = createRequire(path.join(appRoot, 'package.json'))
    const backendRoot = path.resolve(appRoot, '../batshit-server/server')
    backend = require(path.join(backendRoot, 'src/services/redisService.js'))
    assert.equal(await backend.connect({ maxAttempts: 1 }), true)
    const connection = await backend.client.clientInfo()
    const info = await backend.client.info('server')
    assert.equal(connection.db, 14)
    assert(info.includes(`run_id:${process.env.HAIR_CASE_REDIS_RUN_ID}\r\n`))
    assert(info.includes('redis_version:8.10.1\r\n'))
    assert.equal((await backend.client.sendCommand(['COMMAND', 'INFO', 'JSON.GET']))[0][0], 'json.get')
    assert.equal(await backend.client.dbSize(), 0)
    await fs.writeFile(path.join(process.env.HAIR_CASE_EVIDENCE!, 'backend-client-admission.json'),
      JSON.stringify({ db: connection.db, id: connection.id, runId: process.env.HAIR_CASE_REDIS_RUN_ID, beforeSeed: true })+'\n', { flag: 'wx' })
    // Wrap the real queue before constructing the actual router; no copied queue,
    // claim script or product test hook. The latch fires AFTER real admission.
    const queues = require(path.join(backendRoot, 'src/services/serialTransactionQueue.js'))
    const createQueue = queues.createSerialTransactionQueue
    const observed: any[] = []
    queues.createSerialTransactionQueue = (...args: any[]) => {
      const actual = createQueue(...args)
      const wrapper: any = { arrivals: 0, starts: [] as number[], run(task: () => unknown) {
        const index = wrapper.arrivals++
        const pending = actual.run(() => { wrapper.starts.push(index); return task() })
        if (wrapper === publicationQueue) queueArrival?.(index)
        return pending
      }, get isIdle() { return actual.isIdle } }
      observed.push(wrapper); return wrapper
    }
    let routes: any
    try { routes = require(path.join(backendRoot, 'src/api/upload-redis.js')) }
    finally { queues.createSerialTransactionQueue = createQueue }
    publicationQueue = observed[0]
    assert(publicationQueue)
    const express = require(process.env.HAIR_CASE_SERVER_DEPS_ROOT! + '/express')
    const app = express(); app.use(express.json()); app.use('/api', routes)
    app.use('/uploads', express.static(uploads))
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
    const address = server.address(); assert.equal(address.address, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${address.port}`
    vi.stubEnv('BATSHIT_SERVER_URL', baseUrl)
    await fs.writeFile(path.join(process.env.HAIR_CASE_EVIDENCE!, 'file-listener-admission.json'),
      JSON.stringify({ pid: process.pid, address, uploads, scope: 'actual router only; no full app/auth path' })+'\n', { flag: 'wx' })
  })
  beforeEach(async () => {
    assert.equal((await backend.client.clientInfo()).db, 14)
    assert((await backend.client.info('server')).includes(`run_id:${process.env.HAIR_CASE_REDIS_RUN_ID}\r\n`))
    assert(publicationQueue.isIdle)
    await fs.rm(path.join(uploads, 'goon_hair_assets'), { recursive: true, force: true })
    await fs.rm(path.join(uploads, 'goon_hair_imports'), { recursive: true, force: true })
  })
  afterEach(() => {
    queueArrival = undefined
    vi.restoreAllMocks(); vi.unstubAllGlobals()
    expect(publicationQueue.isIdle).toBe(true)
  })
  afterAll(async () => {
    try {
      if (server) {
        const address = server.address()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((error: Error) => error ? reject(error) : resolve()))
        assert.equal(server.listening, false)
        await fs.writeFile(path.join(process.env.HAIR_CASE_EVIDENCE!, 'file-listener-cleanup.json'),
          JSON.stringify({ pid: process.pid, address, listening: false, queueIdle: publicationQueue.isIdle })+'\n', { flag: 'wx' })
      }
    } finally { vi.unstubAllEnvs(); if (backend) await backend.disconnect() }
  })
  async function rawSource() {
    return stageHairImportSource({ originalName: 'hair.obj', bytes: new TextEncoder().encode('o hair\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), mimeType: 'text/plain' })
  }
  async function job(id: string) {
    return createHairImportJob({ userId: USER, goonId: GOON, source: await rawSource(), inspection: {}, jobId: id })
  }
  async function artifact(owner: HairImportJob, role: 'neutral-value' | 'import-receipt' = 'neutral-value') {
    return storeHairAssetArtifact({ assetId: `imported-hair-${owner.jobId}`, revisionId: `imported-hair-${owner.jobId}-r1`,
      role, filename: role === 'neutral-value' ? 'neutral.png' : 'receipt.json',
      mimeType: role === 'neutral-value' ? 'image/png' : 'application/json',
      bytes: role === 'neutral-value' ? createHairImportTexturePng(role) : new TextEncoder().encode('{}\n'),
      importOwner: { userId: USER, jobId: owner.jobId, stateVersion: owner.stateVersion } })
  }
  async function preparedAsset(revision: number, owner?: HairImportJob) {
    const geometry = createRigidHairGlbFixture()
    const asset = await createHairAssetFixture({ recipeSource, mainBytes: geometry, headNode: 'head', sourceClass: 'user' })
    asset.revision = revision; asset.revisionId = `${asset.assetId}-r${revision}`
    asset.attachment.fitReceipt.assetRevisionId = asset.revisionId
    for (const ref of collectHairAssetFileRefs(asset)) {
      const name = ref.ref.split('/').at(-1)!
      const role = name === 'hair.glb' ? 'geometry' : name === 'neutral-value.png' ? 'neutral-value' :
        name === 'highlight-mask.png' ? 'highlight-mask' : name === 'preview.json' ? 'import-receipt' : 'fit-receipt'
      const bytes = role === 'geometry' ? geometry : role === 'neutral-value' || role === 'highlight-mask'
        ? createHairImportTexturePng(role) : new TextEncoder().encode(JSON.stringify({ fixture: role })+'\n')
      Object.assign(ref, await storeHairAssetArtifact({ assetId: asset.assetId, revisionId: asset.revisionId,
        role, filename: name, mimeType: ref.mimeType, bytes,
        ...(owner ? { importOwner: { userId: USER, jobId: owner.jobId, stateVersion: owner.stateVersion } } : {}) }))
      // Owned tuple transport has extra fields; persisted Hair file refs have
      // their original four-field schema. Never invent a product asset shape.
      delete (ref as any).uploadType; delete (ref as any).filename
    }
    asset.material.layout!.width = 64; asset.material.layout!.height = 64
    asset.material.definitionSha256 = await hairMaterialDefinitionSha256(asset.material)
    asset.revisionSha256 = ZERO; asset.attachment.fitReceipt.assetRevisionSha256 = ZERO; asset.attachment.fitReceipt.fitSha256 = ZERO
    asset.revisionSha256 = await hairAssetRevisionSha256(asset)
    asset.attachment.fitReceipt.assetRevisionSha256 = asset.revisionSha256
    asset.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(asset.attachment.fitReceipt)
    const verified = await verifyHairAsset(asset)
    const reusable = await storeHairAssetArtifact({ assetId: asset.assetId, revisionId: asset.revisionId,
      role: 'refit-source', filename: 'source.glb', mimeType: 'model/gltf-binary', bytes: geometry,
      ...(owner ? { importOwner: { userId: USER, jobId: owner.jobId, stateVersion: owner.stateVersion } } : {}) })
    const sidecar = buildImportedHairRefitSource({ assetId: asset.assetId, revisionId: asset.revisionId,
      source: reusable, startingTransform: transform, savedTransform: transform })
    return { asset: verified, sidecar }
  }
  const filesOf = (asset: Awaited<ReturnType<typeof preparedAsset>>['asset']) => collectHairAssetFileRefs(asset)
    .map((ref) => ({ ...ref, uploadType: 'goon_hair_assets' as const, filename: ref.ref.split('/').at(-1)! }))

  it('keeps completed r2 shared textures when a second normally admitted r2 refit is cancelled', async () => {
    const r1 = await preparedAsset(1)
    await putUserHairAssetRevision(USER, r1.asset)
    await redis.json.set(`hair_refit_source:${USER}:${r1.asset.assetId}:${r1.asset.revisionId}`, '$', r1.sidecar)
    await redis.json.set(`goon:${GOON}`, '$', { id: GOON, user_id: USER, recipe: recipeOwner() })
    const input = { userId: USER, goonId: GOON, assetId: r1.asset.assetId,
      revisionId: r1.asset.revisionId, revisionSha256: r1.asset.revisionSha256 }
    let a = (await beginHairRefit(input)).job
    let b = (await beginHairRefit(input)).job
    expect(a.target).toMatchObject({ kind: 'refit', revision: 2, revisionId: `${r1.asset.assetId}-r2` })
    expect(b.target).toEqual(a.target)
    a = await replaceHairImportJob(a, { ...a, status: 'preparing' })
    b = await replaceHairImportJob(b, { ...b, status: 'preparing' })
    const r2 = await preparedAsset(2, a)
    const neutral = filesOf(r2.asset).find((file) => file.filename.includes('_neutral-value_'))!
    const repeated = await storeHairAssetArtifact({ assetId: r2.asset.assetId, revisionId: r2.asset.revisionId,
      role: 'neutral-value', filename: 'neutral.png', mimeType: 'image/png', bytes: createHairImportTexturePng('neutral-value'),
      importOwner: { userId: USER, jobId: b.jobId, stateVersion: b.stateVersion } })
    expect(repeated).toEqual(neutral)
    const uploadKey = `upload:${neutral.uploadType}:${neutral.filename}`
    const beforePublication = await redis.execute(readHairBackupSnapshot)
    expect((beforePublication.get(uploadKey)!.value as any).filename).toBe(neutral.filename)
    expect(stagedHairUploadKeys(beforePublication).has(uploadKey)).toBe(true)
    b = await replaceHairImportJob(b, { ...b, status: 'reviewable', candidate: {
      assetId: r2.asset.assetId, revisionId: r2.asset.revisionId, files: { neutralValue: repeated } }, cleanupFiles: [...b.cleanupFiles, repeated] })
    a = await replaceHairImportJob(a, { ...a, status: 'reviewable', candidate: {
      assetId: r2.asset.assetId, revisionId: r2.asset.revisionId }, cleanupFiles: [...a.cleanupFiles, ...filesOf(r2.asset)] })
    await commitImportedHairAssetRevision({ userId: USER, jobId: a.jobId, expectedJobStateVersion: a.stateVersion,
      asset: r2.asset, refitSource: r2.sidecar })
    expect(stagedHairUploadKeys(await redis.execute(readHairBackupSnapshot)).has(uploadKey)).toBe(false)
    const result = await discardHairImportJob({ userId: USER, jobId: b.jobId })
    expect(result.retainedFiles).toBe(1)
    expect(result.deletedFiles).toBe(2)
    expect(result.missingFiles).toBe(0)
    expect(await redis.json.get(`hair_import_job:${USER}:${b.jobId}`)).toBeNull()
    expect(await redis.json.get(`hair_asset:${USER}:${r2.asset.assetId}:${r2.asset.revisionId}`)).toEqual(r2.asset)
    expect(hash(await fs.readFile(path.join(uploads, 'goon_hair_assets', neutral.filename)))).toBe(neutral.sha256)
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
  })

  it('preserves a reused live candidate and releases only a definitive late BEGIN refusal', async () => {
    let current = await job('subset')
    current = await replaceHairImportJob(current, { ...current, status: 'preparing' })
    const file = await artifact(current)
    current = await replaceHairImportJob(current, { ...current, status: 'reviewable',
      candidate: { files: { neutralValue: file } }, cleanupFiles: [...current.cleanupFiles, file] })
    expect(await deleteHairImportOwnedFile(file, hairImportCleanupContext(current, [file]))).toBe('retained')
    expect(await deleteHairImportOwnedFile(current.source, hairImportCleanupContext(current, [current.source], 'source-consumed'))).toBe('deleted')
    current = await replaceHairImportJob(current, { ...current, proposal: { retry: true } })
    expect(await redis.exists(`upload:${current.source.uploadType}:${current.source.filename}`)).toBe(false)
    expect(await redis.exists(`upload:${file.uploadType}:${file.filename}`)).toBe(true)
    current = await retireHairImportJob(current)
    const context = hairImportCleanupContext(current, [file])
    const originalEval = backend.client.eval.bind(backend.client)
    const spy = vi.spyOn(backend.client, 'eval').mockImplementation(async (script: any, options: any) => {
      if (script.includes('-- BEGIN_DELETION')) {
        await redis.execute((client) => client.json.numIncrBy(context.jobKey, '.stateVersion', 1))
      }
      return originalEval(script, options)
    })
    await expect(deleteHairImportOwnedFile(file, context)).rejects.toThrow('CHANGED_JOB')
    spy.mockRestore()
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
    expect(hash(await fs.readFile(path.join(uploads, file.uploadType, file.filename)))).toBe(file.sha256)
    expect((await getHairImportJobForCleanup(USER, current.jobId)).stateVersion).toBe(current.stateVersion + 1)
  })

  it('settles a held admitted publication before strict discovery despite a lost upload response', async () => {
    let current = await job('queue')
    current = await replaceHairImportJob(current, { ...current, status: 'preparing' })
    let entered!: () => void, release!: () => void
    const admission = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const originalSet = backend.setWithTTL.bind(backend)
    const write = vi.spyOn(backend, 'setWithTTL').mockImplementationOnce(async (...args: any[]) => {
      entered(); await held; return originalSet(...args)
    })
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
      const response = await originalFetch(input, init)
      if (String(input).endsWith('/upload/goon-hair-asset') && response.ok) {
        await response.arrayBuffer(); throw new Error('synthetic lost response after real completed upload')
      }
      return response
    })
    const publication = artifact(current, 'import-receipt').then(() => null, (error) => error)
    let discovery: Promise<HairImportOwnedFile[]> | undefined
    try {
      await bounded(admission, 'upload admission')
      current = await retireHairImportJob(current)
      const context = hairImportCleanupContext(current, current.cleanupFiles)
      const index = publicationQueue.arrivals
      let arrival!: () => void
      const arrived = new Promise<void>((resolve) => { arrival = resolve })
      queueArrival = (value) => { if (value === index) arrival() }
      let finished = false
      discovery = discoverHairImportCleanupFiles(context).then((value) => { finished = true; return value })
      await bounded(arrived, 'discovery queue ingress')
      const startedWhileHeld = publicationQueue.starts.includes(index)
      const finishedWhileHeld = finished
      release()
      expect((await bounded(publication, 'released upload response')).message).toContain('lost response')
      const found = await bounded(discovery, 'released discovery')
      expect(startedWhileHeld).toBe(false); expect(finishedWhileHeld).toBe(false)
      expect(found).toHaveLength(1)
      write.mockRestore(); vi.stubGlobal('fetch', originalFetch)
      expect(hash(await fs.readFile(path.join(uploads, found[0].uploadType, found[0].filename)))).toBe(found[0].sha256)
      await expect(artifact({ ...current, status: 'preparing', stateVersion: current.stateVersion - 1 }, 'import-receipt')).rejects.toThrow('409')
      expect((await discardHairImportJob({ userId: USER, jobId: current.jobId })).deletedFiles).toBe(2)
      expect(publicationQueue.isIdle).toBe(true)
    } finally {
      queueArrival = undefined
      release()
      // Always let delegated real IO settle; a failed latch cannot strand its
      // own queue. A settlement failure is retained in raw output and remains
      // subject to the controller's owned process/listener cleanup checks.
      await bounded(Promise.allSettled([publication, ...(discovery ? [discovery] : [])]), 'fixture settlement', 10000)
      write.mockRestore(); vi.unstubAllGlobals()
    }
  })

  it('refuses unknown completed/index ownership without IO and releases matching reserved claims', async () => {
    let current = await job('unknown')
    current = await replaceHairImportJob(current, { ...current, status: 'preparing' })
    const file = await artifact(current)
    const key = `hair_asset:${USER}:legacy:r1`
    const opaque = { unknown: [0.12345678901234568, null], note: 'preserve' }
    await redis.json.set(key, '$', opaque)
    const raw = await backend.client.sendCommand(['JSON.GET', key])
    await expect(deleteGoonUploadAssetDisposition(file.uploadType, file.filename)).rejects.toThrow(key)
    expect(await backend.client.sendCommand(['JSON.GET', key])).toBe(raw)
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
    expect(hash(await fs.readFile(path.join(uploads, file.uploadType, file.filename)))).toBe(file.sha256)
    const library = await preparedAsset(1)
    await putUserHairAssetRevision(USER, library.asset)
    const libraryKey = `hair_asset:${USER}:${library.asset.assetId}:${library.asset.revisionId}`
    const libraryRaw = await backend.client.sendCommand(['JSON.GET', libraryKey])
    await expect(deleteUserHairAssetRevision(USER, library.asset.assetId, library.asset.revisionId)).rejects.toThrow(key)
    expect(await backend.client.sendCommand(['JSON.GET', libraryKey])).toBe(libraryRaw)
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
    for (const owned of filesOf(library.asset)) {
      expect(hash(await fs.readFile(path.join(uploads, owned.uploadType, owned.filename)))).toBe(owned.sha256)
    }
    await redis.del(key); await redis.sAdd(`user:${USER}:hair_assets`, 'missing@r1')
    await expect(deleteGoonUploadAssetDisposition(file.uploadType, file.filename)).rejects.toThrow(`hair_asset:${USER}:missing:r1`)
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
    expect((await redis.sMembers(`user:${USER}:hair_assets`)).sort()).toEqual([
      `${library.asset.assetId}@${library.asset.revisionId}`, 'missing@r1'
    ].sort())
  })

  it('fences actual borrower publication and missing revision identity during library retirement', async () => {
    const r1 = await preparedAsset(1)
    await putUserHairAssetRevision(USER, r1.asset)
    const file = filesOf(r1.asset).find((file) => file.filename.includes('_neutral-value_'))!
    const hairState = createHairState(r1.asset)
    const goon: GoonRecord = { id: GOON, user_id: USER, name: 'Hair fence fixture',
      kind: 'custom', sourceProfile: 'expert-custom-glb', files: {}, recipe: recipeOwner(),
      created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T00:00:00.000Z' }
    await redis.json.set(`goon:${GOON}`, '$', goon)
    const reservation = await reserveGoonUploadAsset(file.uploadType, file.filename)
    try {
      await expect(redis.execute((client) => patchOwnedGoonForClient({ client, userId: USER, goonId: GOON,
        updates: { hairState }, updatedAt: '2026-10-12T00:00:00Z' }))).rejects.toMatchObject({ status: 409 })
      await expect(compareAndSwapRecipeState({ userId: USER, goonId: GOON, expectedWriteVersion: 1,
        nextGoon: { ...goon, hairState, recipe: { ...goon.recipe!, writeVersion: 2 } } })).rejects.toMatchObject({ status: 409 })
      await expect(redis.updateUserSettings(USER, { goons_settings: { retained: file.ref } })).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' })
      await expect(redis.execute((client) => storeGoonReferenceRecordForClient(client,
        `user:${USER}:goons_animation_library`, { retained: { sourceUri: file.ref } }, USER))).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' })
      await expect(saveClipRecord(`clip:${USER}:blocked`, { thumbnailUrl: file.ref })).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' })
    } finally { await releaseGoonUploadReservation(file.uploadType, file.filename, reservation) }
    // A real Clip keeps one shared file, while library metadata can retire.
    await saveClipRecord(`clip:${USER}:retained`, { fullResolutionUrl: file.ref })
    await deleteUserHairAssetRevision(USER, r1.asset.assetId, r1.asset.revisionId)
    expect(await redis.json.get(`hair_asset:${USER}:${r1.asset.assetId}:${r1.asset.revisionId}`)).toBeNull()
    expect(await redis.exists(`upload:${file.uploadType}:${file.filename}`)).toBe(true)
    await expect(redis.execute((client) => patchOwnedGoonForClient({ client, userId: USER, goonId: GOON,
      updates: { hairState }, updatedAt: '2026-10-12T00:00:00Z' }))).rejects.toMatchObject({ status: 409 })
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
  })

  it('preserves exact legacy raw precision through retirement/tracking and digest-guarded deletion', async () => {
    const rawFile = await rawSource()
    const key = `hair_import_job:${USER}:legacy`
    const raw = `{"contract":"hair-import-job/v3","userId":"${USER}","jobId":"legacy","cleanupFiles":${JSON.stringify([rawFile])},"number":0.123456789012345678901,"empty":[],"status":"failed"}`
    await backend.client.sendCommand(['JSON.SET', key, '$', raw])
    await redis.sAdd(`user:${USER}:hair_import_jobs`, 'legacy')
    const [listed] = await listDiscardableHairImportJobs(USER)
    expect(listed.observedRaw).toBe(await backend.client.sendCommand(['JSON.GET', key]))
    const numeric = await backend.client.sendCommand(['JSON.GET', key, '.number'])
    const empty = await backend.client.sendCommand(['JSON.GET', key, '.empty'])
    let context = await retireDiscardableHairImportJob(listed)
    expect(await backend.client.sendCommand(['JSON.GET', key, '.number'])).toBe(numeric)
    expect(await backend.client.sendCommand(['JSON.GET', key, '.empty'])).toBe(empty)
    context = await trackRetiredHairCleanupFiles(context, [rawFile])
    expect(await backend.client.sendCommand(['JSON.GET', key, '.number'])).toBe(numeric)
    expect(await backend.client.sendCommand(['JSON.GET', key, '.empty'])).toBe(empty)
    expect(context.stateVersion).toBeUndefined()
    expect(context.expectedRaw).toBe(await backend.client.sendCommand(['JSON.GET', key]))
    expect(await deleteHairImportOwnedFile(rawFile, context)).toBe('deleted')
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
    await expect(fs.stat(path.join(uploads, rawFile.uploadType, rawFile.filename))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps uncertain deleting claims for exact Admin recovery and removes a Clip without Hair unlink', async () => {
    const source = await rawSource()
    expect((await auditGoonUploadAssets(USER)).entries).toEqual([])
    const reservation = await reserveGoonUploadAsset(source.uploadType, source.filename)
    const failure = vi.spyOn(backend.client, 'del').mockRejectedValueOnce(new Error('synthetic metadata delete failure after unlink'))
    await expect(deleteReservedGoonUploadAsset(source.uploadType, source.filename, reservation)).rejects.toThrow('metadata delete failure')
    failure.mockRestore()
    expect(await redis.exists(`upload:${source.uploadType}:${source.filename}`)).toBe(true)
    const marker = await backend.client.get(`goon_asset_delete:${source.uploadType}:${source.filename}`)
    expect(JSON.parse(marker).phase).toBe('deleting')
    await expect(fs.stat(path.join(uploads, source.uploadType, source.filename))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await auditGoonUploadAssets(USER)).cleanupCandidates).toHaveLength(1)
    const result = await cleanupOrphanGoonUploadAssets(USER, { selectedAssets: [`${source.uploadType}/${source.filename}`] })
    expect(result.deletedCount).toBe(1)
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
    const borrowed = await rawSource()
    await saveClipRecord(`clip:${USER}:borrower`, { id: 'borrower', localUrl: borrowed.ref })
    await redis.sAdd(`user:${USER}:clips`, 'borrower')
    expect((await deleteUserClip(USER, 'borrower')).deleted).toBe(true)
    expect(hash(await fs.readFile(path.join(uploads, borrowed.uploadType, borrowed.filename)))).toBe(borrowed.sha256)
    expect(await redis.exists(`upload:${borrowed.uploadType}:${borrowed.filename}`)).toBe(true)
    expect(await redis.keys('goon_asset_delete:*')).toEqual([])
  })
})
