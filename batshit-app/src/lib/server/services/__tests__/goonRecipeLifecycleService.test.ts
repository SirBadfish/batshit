import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import type { GoonRecord } from '$lib/types/goons'
import { createHairState } from '$lib/goons/hairAssets'
import {
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_REVISION_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  RECIPE_MIGRATION_REPORT_CONTRACT,
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  anatomyFitRecipeSibling,
  bakeLiveGoon,
  createAnatomyFitState,
  createGoonRecipeDocument,
  createRecipeArchiveContainmentReceipt,
  createRecipeRevisionEnvelope,
  recipeAuthoringRevisionSha256,
  recipeRevisionBundleSha256,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
  recipeMigrationReportSha256,
  recipeJobRedisKey,
  sha256Hex,
  type RecipeArchiveContainmentReceipt,
  type RecipeMigrationPlan,
  type RecipeSource,
  type RecipeStoredAssetRef
} from '$lib/goons/recipe'
import { createRecipePhysicalMigrationFixture } from '$lib/goons/recipe/fixtures/recipePhysicalMigrationPair'
import * as liveGoonBaker from '$lib/goons/recipe/liveGoonBaker'
import {
  createHairAssetFixture,
  createRigidHairGlbFixture,
  HAIR_HIGHLIGHT_MASK_PNG_FIXTURE,
  HAIR_NEUTRAL_VALUE_PNG_FIXTURE
} from '$lib/goons/recipe/fixtures/hairAssetFixture'
import {
  getGoonRecipeJob,
  getGoonRecipeDocument,
  getRecipeRevisionEnvelope,
  putGoonRecipeDocument,
  putRecipeRevisionEnvelope
} from '../goonRecipeRepository.server'
import * as recipeRepository from '../goonRecipeRepository.server'
import { withRecipeVerificationRestore } from '../recipeVerificationEpoch.server'
import { duplicateRecipeGoon } from '../goonRecipeDuplicationService.server'
import { collectCustomGoonUploadKeys } from '../goonCustomAssetOwnership.server'
import { auditGoonUploadAssets } from '../goonAssetCleanupService'
import {
  analyzeRecipePackageUpdate,
  buildExternalRecipeSiblingInputs,
  bootstrapRecipeV2,
  discardRecipeJob,
  recoverInterruptedRecipeJob,
  renewActiveRecipeJobLease,
  recipeReplayControl,
  readOnlyRecipeReplayControl,
  failRecipeJob,
  registerRecipeCandidateAssets,
  reviewRecipePackageState,
  retryRecipeJob,
  startRecipePackageUpdate,
  startRecipeBake,
  stageRecipeUpdateCandidate,
  commitRecipeUpdate,
  pruneRecipeRetention,
  resetRetiredHairRecipeState,
  discardRecipePackageAnalysis,
  getPreviousRecipeRevisionPreview,
  restorePreviousRecipeRevision,
  verifyCompleteRecipeRevision,
  selectRecipeCleanReset
} from '../goonRecipeLifecycleService.server'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER_ID = 'recipe-lifecycle-user'
const GOON_ID = 'recipe-lifecycle-goon'
const ZERO_SHA256 = '0'.repeat(64)

afterEach(() => vi.restoreAllMocks())

function currentFixtureClock() {
  // The Recipe Lua CAS compares lease expiry with Redis TIME, not injected time.
  // Keep historical relative transitions but put the live lease in the future.
  const base = Date.now() + 2 * 60_000
  return (seconds: number) => new Date(base + seconds * 1000)
}

async function prepareAdmissionCandidate(attachment: 'hair') {
  const at = currentFixtureClock()
  const fixture = await createRecipePhysicalMigrationFixture()
  const sourceArchive = await archiveReceipt(`admission-${attachment}`, fixture.source)
  const state = structuredClone(fixture.sourceState)
  const bytes = new Map<string, Uint8Array>([
    [sourceArchive.assets[0]!.ref, fixture.source.packageBytes],
    [sourceArchive.assets[1]!.ref, fixture.source.glbBytes],
    [sourceArchive.assets[2]!.ref, fixture.source.manifestBytes]
  ])
  let hairAsset: Awaited<ReturnType<typeof createHairAssetFixture>> | null = null
  let hairBakeInput: Parameters<typeof bakeLiveGoon>[0]['hair']

  if (attachment === 'hair') {
    const mainBytes = createRigidHairGlbFixture()
    hairAsset = await createHairAssetFixture({
      recipeSource: fixture.source.recipeSource,
      mainBytes,
      headNode: 'HeadAnchor',
      sourceClass: 'user'
    })
    const hairState = createHairState(hairAsset)
    state.siblings.push({
      id: 'hairState',
      contract: 'hair-state/v2',
      definitionSha256: hairState.definitionSha256!,
      stateSha256: await recipeSiblingStateSha256(hairState),
      state: hairState
    })
    bytes.set(hairAsset.geometry.main.ref, mainBytes)
    bytes.set(hairAsset.material.neutralValueTexture!.ref, HAIR_NEUTRAL_VALUE_PNG_FIXTURE)
    bytes.set(hairAsset.material.highlightMask!.ref, HAIR_HIGHLIGHT_MASK_PNG_FIXTURE)
    hairBakeInput = {
      asset: hairAsset,
      mainBytes,
      neutralValueBytes: Uint8Array.from(HAIR_NEUTRAL_VALUE_PNG_FIXTURE),
      highlightMaskBytes: Uint8Array.from(HAIR_HIGHLIGHT_MASK_PNG_FIXTURE)
    }
  }
  state.siblings.sort((left, right) => left.id.localeCompare(right.id))
  state.stateSha256 = await recipeStateSnapshotSha256(state)
  const readAsset = async (asset: RecipeStoredAssetRef) => {
    const value = bytes.get(asset.ref)
    if (!value) throw new Error(`missing fixture asset ${asset.ref}`)
    return value
  }
  const resolveHairAsset = async () => {
    if (!hairAsset) throw new Error('Unexpected Hair resolution.')
    return hairAsset
  }
  const dependencies = { readAsset, resolveHairAsset, now: () => at(4) }
  const legacyLive = {
    package: { url: '/uploads/goon_custom_packages/legacy.bgoon', filename: 'legacy.bgoon', size: 10 },
    model: { url: '/uploads/goon_custom_models/legacy.glb', filename: 'legacy.glb', size: 10 },
    manifest: { url: '/uploads/goon_custom_manifests/legacy.json', filename: 'legacy.json', size: 10 }
  }
  const legacy: GoonRecord = {
    id: GOON_ID, user_id: USER_ID, name: 'Admission Fixture', kind: 'custom',
    sourceProfile: 'expert-custom-glb', files: {}, customAvatar: legacyLive,
    appearanceDials: state.appearanceDials,
    ...(hairAsset ? { hairState: createHairState(hairAsset) } : {}),
    created_at: at(0).toISOString(), updated_at: at(0).toISOString()
  }
  await registerFixtureCustomUploads(legacyLive)
  await redis.json.set(`goon:${GOON_ID}`, '$', legacy)
  await redis.sAdd(`user:${USER_ID}:goons`, GOON_ID)
  const bootstrapped = await bootstrapRecipeV2({
    userId: USER_ID, goonId: GOON_ID,
    expectedUpdatedAt: legacy.updated_at,
    receipt: sourceArchive.receipt,
    state
  }, { ...dependencies, now: () => at(1) })
  const started = await startRecipeBake({
    userId: USER_ID, goonId: GOON_ID,
    expectedWriteVersion: (bootstrapped.goon.recipe as any).writeVersion,
    idempotencyKey: `admission-${attachment}`,
    state
  }, { ...dependencies, now: () => at(2), leaseMs: 10_000 })
  const bake = await bakeLiveGoon({
    source: started.job.stagedSource.source,
    sourceRevision: {
      revisionId: started.job.targetRevisionId,
      revision: started.job.targetRecipeRevision
    },
    state: started.reviewedState.state,
    packageBytes: fixture.source.packageBytes,
    modelBytes: fixture.source.glbBytes,
    manifestBytes: fixture.source.manifestBytes,
    ...(hairBakeInput ? { hair: hairBakeInput } : {})
  })
  const live = {
    package: await storedAsset(`/uploads/goon_custom_packages/${attachment}-live.bgoon`, bake.packageBytes),
    model: await storedAsset(`/uploads/goon_custom_models/${attachment}-live.glb`, bake.modelBytes),
    manifest: await storedAsset(`/uploads/goon_custom_manifests/${attachment}-live.json`, bake.manifestBytes)
  }
  bytes.set(live.package.ref, bake.packageBytes)
  bytes.set(live.model.ref, bake.modelBytes)
  bytes.set(live.manifest.ref, bake.manifestBytes)
  await registerFixtureCustomUploads(live)
  const registered = await registerRecipeCandidateAssets({
    userId: USER_ID, goonId: GOON_ID, jobId: started.job.jobId,
    expectedWriteVersion: (started.goon.recipe as any).writeVersion,
    expectedJobStateVersion: started.job.stateVersion,
    live
  }, { ...dependencies, now: () => at(3) })
  const stage = (stageDependencies = dependencies) => stageRecipeUpdateCandidate({
    userId: USER_ID, goonId: GOON_ID, jobId: started.job.jobId,
    expectedWriteVersion: registered.owner.writeVersion,
    expectedJobStateVersion: registered.job.stateVersion,
    liveBuildReceipt: bake.receipt,
    live
  }, stageDependencies)
  const commitInput = (staged: Awaited<ReturnType<typeof stage>>) => ({
    userId: USER_ID, goonId: GOON_ID, jobId: started.job.jobId,
    expectedWriteVersion: (staged.goon.recipe as any).writeVersion,
    expectedJobStateVersion: staged.job.stateVersion
  })
  return {
    at, bytes, readAsset, resolveHairAsset,
    hairAsset, sourceArchive, live, legacyLive,
    registered, stage, commitInput, dependencies
  }
}

async function storedAsset(ref: string, bytes: Uint8Array): Promise<RecipeStoredAssetRef> {
  return { ref, sha256: await sha256Hex(bytes), bytes: bytes.byteLength }
}

async function registerFixtureCustomUploads(value: unknown) {
  for (const key of collectCustomGoonUploadKeys(value)) {
    const [, uploadType, filename] = key.split(':', 3)
    await redis.json.set(key, '$', { uploadType, filename, size: 10 })
  }
}

async function archiveReceipt(
  prefix: string,
  value: { packageBytes: Uint8Array; glbBytes: Uint8Array; manifestBytes: Uint8Array }
) {
  const archive = await storedAsset(`/uploads/goon_custom_packages/${prefix}.bgoon`, value.packageBytes)
  const model = await storedAsset(`/uploads/goon_custom_models/${prefix}.glb`, value.glbBytes)
  const manifest = await storedAsset(`/uploads/goon_custom_manifests/${prefix}.json`, value.manifestBytes)
  const receipt = await createRecipeArchiveContainmentReceipt({
    contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    archiveFormat: 'zip',
    extractor: { id: 'batshit-server-recipe-archive', version: 1 },
    archive,
    entryCount: 2,
    totalUncompressedBytes: model.bytes + manifest.bytes,
    members: [
      { role: 'manifest', path: 'avatar.json', sha256: manifest.sha256, bytes: manifest.bytes, extracted: manifest },
      { role: 'model', path: 'avatar.glb', sha256: model.sha256, bytes: model.bytes, extracted: model }
    ]
  })
  await registerFixtureCustomUploads([archive, model, manifest])
  return { receipt, assets: [archive, model, manifest] }
}

function sourceFromReceipt(receipt: RecipeArchiveContainmentReceipt, identities: RecipeSource['identities']): RecipeSource {
  const model = receipt.members.find((member) => member.role === 'model')!
  const manifest = receipt.members.find((member) => member.role === 'manifest')!
  return {
    package: { ref: receipt.archive.ref, sha256: receipt.archive.sha256 },
    model: { ref: model.extracted.ref, sha256: model.sha256 },
    manifest: { ref: manifest.extracted.ref, sha256: manifest.sha256 },
    identities
  }
}

async function migrationReport(plan: RecipeMigrationPlan, edge: Awaited<ReturnType<typeof createRecipePhysicalMigrationFixture>>['edge']) {
  const classification = {
    keep: 'kept',
    'presentation-only': 'presentation-updated',
    affine: 'remapped',
    piecewise: 'remapped',
    new: 'new',
    removed: 'removed',
    'reset-required': 'reset-required',
    blocked: 'blocked'
  } as const
  const rows = new Map(plan.controlRows.map((row) => [row.ledgerId, row]))
  const report: any = {
    contract: RECIPE_MIGRATION_REPORT_CONTRACT,
    reportId: `report_${plan.planId}`,
    directEdgeKey: plan.directEdgeKey,
    edgeSha256: plan.edgeSha256,
    fromRecipeRevision: plan.fromRecipeRevision,
    toRecipeRevision: plan.toRecipeRevision,
    status: 'preserved',
    entries: edge.controls.map((control) => {
      const row = rows.get(control.id)!
      const kind = classification[control.action]
      return {
        id: control.id,
        classification: kind,
        componentId: control.componentId,
        oldValue: row.sourceControl?.value ?? null,
        proposedValue: row.targetControl?.value ?? null,
        reason: row.message,
        proofStatus:
          kind === 'new' || kind === 'removed'
            ? 'not-required'
            : kind === 'reset-required'
              ? 'not-preserved'
              : kind === 'blocked'
                ? 'failed'
                : 'verified',
        maximumError: row.maximumScalarError,
        tolerance: 1e-7,
        proofSha256: row.componentProofSha256,
        requiresPreview: row.requiresPreview,
        requiresConfirmation: row.requiresConfirmation
      }
    }),
    warnings: edge.warnings,
    proof: {
      toleranceProfile: 'recipe-strict/v1',
      wholeRecipeMaximumError: plan.wholeRecipeProof.errors.positionMaximumMeters,
      wholeRecipeRmsError: plan.wholeRecipeProof.errors.positionRmsMeters,
      wholeRecipeTolerance: 1e-6,
      wholeRecipeProofSha256: plan.wholeRecipeProof.proofSha256,
      reportSha256: ZERO_SHA256
    }
  }
  report.proof.reportSha256 = await recipeMigrationReportSha256(report, edge)
  return report
}

describe('Goon Recipe lifecycle service', () => {
  useRedisTestServer()

  it.runIf(REAL_REDIS_LANE)('publishes ready evidence atomically after retention runs during Stage', async () => {
    const prepared = await prepareAdmissionCandidate('hair')
    const actualCas = recipeRepository.compareAndSwapRecipeJobState
    let enteredReady!: () => void
    const readyReached = new Promise<void>((resolve) => { enteredReady = resolve })
    let releaseReady!: () => void
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve })
    let readyRecords: Array<{ key: string; value: unknown }> = []
    vi.spyOn(recipeRepository, 'compareAndSwapRecipeJobState').mockImplementation(async (input) => {
      if (input.nextJob.status === 'ready') {
        readyRecords = input.records ?? []
        enteredReady()
        await readyGate
      }
      return actualCas(input)
    })
    const operation = prepared.stage()
    await readyReached
    try {
      expect(readyRecords).toHaveLength(2)
      for (const record of readyRecords) expect(await redis.exists(record.key)).toBe(false)
      const activeJobKey = recipeJobRedisKey(USER_ID, GOON_ID, prepared.registered.job.jobId)
      const activeJob = await getGoonRecipeJob(USER_ID, GOON_ID, prepared.registered.job.jobId)
      expect(activeJob.stagedLive?.model.ref).toBe('/uploads/goon_custom_models/hair-live.glb')
      const staleJobKey = recipeJobRedisKey(USER_ID, GOON_ID, 'stale-retention-job')
      await redis.json.set(staleJobKey, '$', { ...activeJob, jobId: 'stale-retention-job' })
      const deletedAssets: string[] = []
      const pruned = await pruneRecipeRetention(USER_ID, GOON_ID, {
        deleteAsset: async (uploadType, filename) => {
          deletedAssets.push(`${uploadType}/${filename}`)
        }
      })
      expect(pruned.deletedRecords).toContain(staleJobKey)
      expect(await redis.exists(staleJobKey)).toBe(false)
      expect(await redis.exists(activeJobKey)).toBe(true)
      expect((await getGoonRecipeJob(USER_ID, GOON_ID, prepared.registered.job.jobId)).stagedLive)
        .toEqual(activeJob.stagedLive)
      expect(await redis.exists('upload:goon_custom_models:hair-live.glb')).toBe(true)
      expect(deletedAssets).not.toContain('goon_custom_models/hair-live.glb')
      for (const record of readyRecords) expect(await redis.exists(record.key)).toBe(false)
    } finally {
      releaseReady()
    }
    const staged = await operation
    expect(staged.job.status).toBe('ready')
    for (const record of readyRecords) expect(await redis.exists(record.key)).toBe(true)
  }, 30_000)

  it.runIf(REAL_REDIS_LANE)('retention refuses to prune records when the owner changes during traversal', async () => {
    await prepareAdmissionCandidate('hair')
    const orphanKey = `goon_recipe_document:${USER_ID}:${GOON_ID}:${'a'.repeat(64)}`
    await redis.json.set(orphanKey, '$', { marker: 'must-survive' })
    const actualExecute = redis.execute.bind(redis)
    let changedOwner = false
    const executeSpy = vi.spyOn(redis, 'execute').mockImplementation((operation: any) =>
      actualExecute((client: any) => operation(new Proxy(client, {
        get(target, property) {
          if (property === 'eval') {
            return async (script: string, options: unknown) => {
              if (!changedOwner && script.includes("tonumber(current['recipe']['writeVersion'])")) {
                changedOwner = true
                await client.json.set(`goon:${GOON_ID}`, '$.recipe.writeVersion', 999)
              }
              return client.eval(script, options)
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }))) as any
    )
    try {
      await expect(pruneRecipeRetention(USER_ID, GOON_ID, { deleteAsset: async () => {} }))
        .rejects.toMatchObject({ code: 'WRITE_CONFLICT', status: 409 })
    } finally {
      executeSpy.mockRestore()
    }
    expect(changedOwner).toBe(true)
    expect(await redis.json.get(orphanKey)).toEqual({ marker: 'must-survive' })
  }, 30_000)

  it('refuses an unsupported evaluated Source before Recipe initialization or publication', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const manifestBytes = new TextEncoder().encode(JSON.stringify({
      ...fixture.source.avatarManifest,
      sphericalEyelidEvaluatedBuild: { contract: 'spherical-eyelid-evaluated-build-source/v2' }
    }))
    const entries = unzipSync(fixture.source.packageBytes)
    entries['avatar.json'] = manifestBytes
    const packageBytes = zipSync(entries, { level: 0 })
    const receipt = await archiveReceipt('unsupported-evaluated-source', {
      ...fixture.source, packageBytes, manifestBytes
    })
    const bytes = new Map(receipt.assets.map((asset, index) => [asset.ref,
      [packageBytes, fixture.source.glbBytes, manifestBytes][index]!]))
    const original: GoonRecord = {
      id: GOON_ID, user_id: USER_ID, name: 'Original Goon', kind: 'custom',
      sourceProfile: 'expert-custom-glb', files: {},
      created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z'
    }
    await redis.json.set(`goon:${GOON_ID}`, '$', original)
    await redis.sAdd(`user:${USER_ID}:goons`, GOON_ID)
    await expect(bootstrapRecipeV2({
      userId: USER_ID, goonId: GOON_ID, expectedUpdatedAt: original.updated_at,
      receipt: receipt.receipt, state: fixture.sourceState
    }, { readAsset: async (asset) => bytes.get(asset.ref)! })).rejects.toMatchObject({
      code: 'INVALID_STATE', status: 400,
      message: 'This Goon file uses a construction format that this version does not support.'
    })
    expect(await redis.json.get(`goon:${GOON_ID}`)).toEqual(original)
    expect(await redis.execute(client => client.keys(`goon_recipe_*:${USER_ID}:${GOON_ID}:*`))).toEqual([])
  })

  it('cancels read-only replay at its next checkpoint and preserves its deadline', async () => {
    let wallNow = 0
    const abort = new AbortController()
    const control = readOnlyRecipeReplayControl(() => wallNow, abort.signal)
    await control.checkpoint()

    const waiting = control.checkpoint()
    abort.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'REPLAY_CANCELLED' })
    expect(() => control.checkCancelled()).toThrow('preview was canceled')

    const timed = readOnlyRecipeReplayControl(() => wallNow)
    wallNow = 15 * 60_000
    expect(() => timed.checkCancelled()).toThrow('took too long')
  })

  it('rejects an already-canceled rollback preview before reading stored state', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(getPreviousRecipeRevisionPreview({
      userId: USER_ID,
      goonId: GOON_ID,
      signal: abort.signal
    })).rejects.toMatchObject({ code: 'REPLAY_CANCELLED' })
  })

  it('blocks exact Hair carry-forward when its fit receipt is stale for the target Recipe source', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const hairAsset = await createHairAssetFixture({
      recipeSource: fixture.source.recipeSource,
      mainBytes: createRigidHairGlbFixture(),
      headNode: 'HeadAnchor',
      sourceClass: 'user'
    })
    const hairState = createHairState(hairAsset)
    const sourceState = structuredClone(fixture.sourceState)
    sourceState.siblings.push({
      id: 'hairState',
      contract: 'hair-state/v2',
      definitionSha256: hairState.definitionSha256!,
      stateSha256: await recipeSiblingStateSha256(hairState),
      state: hairState
    })
    sourceState.siblings.sort((left, right) => left.id.localeCompare(right.id))
    sourceState.stateSha256 = await recipeStateSnapshotSha256(sourceState)

    await expect(
      buildExternalRecipeSiblingInputs({
        userId: USER_ID,
        state: sourceState,
        source: fixture.source.recipeSource,
        target: fixture.target.recipeSource,
        sourceManifest: fixture.source.avatarManifest,
        targetManifest: fixture.target.avatarManifest,
        resolveAsset: async () => hairAsset
      })
    ).rejects.toMatchObject({
      code: 'EXTERNAL_SIBLING_INCOMPATIBLE',
      status: 409
    })
  })

  it('proposes an explicit current-head successor for stale built-in Hair without changing its state id', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const hairBytes = createRigidHairGlbFixture()
    const sourceAsset = await createHairAssetFixture({
      recipeSource: fixture.source.recipeSource,
      mainBytes: hairBytes,
      headNode: 'HeadAnchor',
      sourceClass: 'builtin'
    })
    const targetAsset = await createHairAssetFixture({
      recipeSource: fixture.target.recipeSource,
      mainBytes: hairBytes,
      headNode: 'HeadAnchor',
      sourceClass: 'builtin'
    })
    const sourceHairState = createHairState(sourceAsset, {
      baseColor: '#142536',
      highlightColor: '#abcdef'
    })
    const targetHairState = createHairState(targetAsset, {
      baseColor: sourceHairState.baseColor,
      highlightColor: sourceHairState.highlightColor
    })
    const sourceState = structuredClone(fixture.sourceState)
    sourceState.siblings.push({
      id: 'hairState',
      contract: sourceHairState.schemaVersion,
      definitionSha256: sourceHairState.definitionSha256!,
      stateSha256: await recipeSiblingStateSha256(sourceHairState),
      state: sourceHairState
    })
    sourceState.siblings.sort((left, right) => left.id.localeCompare(right.id))
    sourceState.stateSha256 = await recipeStateSnapshotSha256(sourceState)

    const bindings = await buildExternalRecipeSiblingInputs({
      userId: USER_ID,
      state: sourceState,
      source: fixture.source.recipeSource,
      target: fixture.target.recipeSource,
      sourceManifest: fixture.source.avatarManifest,
      targetManifest: fixture.target.avatarManifest,
      resolveAsset: async () => sourceAsset,
      migrateBuiltinState: async () => ({
        status: 'migrated',
        state: targetHairState,
        sourceAsset,
        targetAsset,
        path: []
      })
    })

    const binding = bindings.find((entry) => entry.sourceStateId === 'hairState')
    expect(binding).toMatchObject({
      sourceStateId: 'hairState',
      targetStateId: 'hairState',
      targetState: {
        id: 'hairState',
        contract: 'hair-state/v2',
        definitionSha256: targetHairState.definitionSha256,
        state: {
          selected: {
            assetRevisionSha256: targetAsset.revisionSha256,
            fitSha256: targetAsset.attachment.fitReceipt.fitSha256
          },
          baseColor: sourceHairState.baseColor,
          highlightColor: sourceHairState.highlightColor,
          motionSettings: null
        }
      }
    })
    expect(binding?.targetState.stateSha256).toBe(
      await recipeSiblingStateSha256(targetHairState)
    )
    expect(binding?.validationSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it.runIf(REAL_REDIS_LANE)(
    'resets only retired Hair state while preserving the Goon and every unrelated Recipe surface',
    async () => {
      const fixture = await createRecipePhysicalMigrationFixture()
      const sourceArchive = await archiveReceipt('retired-hair-recovery', fixture.source)
      const source = sourceFromReceipt(sourceArchive.receipt, fixture.source.identity)
      const containmentDocument = await createGoonRecipeDocument({
        userId: USER_ID,
        goonId: GOON_ID,
        content: sourceArchive.receipt
      })
      const storedContainment = await putGoonRecipeDocument(containmentDocument)
      const containmentReceipt = {
        contract: containmentDocument.documentContract,
        ref: storedContainment.key,
        sha256: containmentDocument.sha256
      }
      const retiredHairState = {
        schemaVersion: 'hair-state/v1',
        definitionSha256: 'e'.repeat(64),
        selected: null,
        baseColor: '#20152f',
        highlightColor: '#76558f',
        motionSettings: null
      }
      const retiredState = structuredClone(fixture.sourceState)
      retiredState.siblings.push({
        id: 'hairState',
        contract: 'hair-state/v1',
        definitionSha256: retiredHairState.definitionSha256,
        stateSha256: await recipeSiblingStateSha256(retiredHairState),
        state: retiredHairState
      })
      retiredState.siblings.sort((left, right) => left.id.localeCompare(right.id))
      retiredState.stateSha256 = await recipeStateSnapshotSha256(retiredState)
      const authoringRevision = {
        contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
        recipeRevision: 1,
        revisionId: 'recipe_revision_retired_hair',
        revisionSha256: ZERO_SHA256,
        source,
        state: retiredState,
        updateReport: null
      }
      authoringRevision.revisionSha256 = await recipeAuthoringRevisionSha256(authoringRevision)
      const goon = {
        id: GOON_ID,
        user_id: USER_ID,
        name: 'Retired Hair Recovery Fixture',
        description: 'Must survive Hair recovery.',
        kind: 'custom',
        sourceProfile: 'expert-custom-glb',
        files: {},
        customAvatar: {
          package: { url: '/live/current.bgoon', filename: 'current.bgoon' },
          model: { url: '/live/current.glb', filename: 'current.glb' },
          manifest: { url: '/live/current.json', filename: 'current.json' }
        },
        recipe: {
          contract: GOON_RECIPE_OWNER_V2_CONTRACT,
          writeVersion: 1,
          nextRecipeRevision: 2,
          liveStatus: 'needs_bake',
          authoringRevision,
          authoringSourceContainmentReceipt: containmentReceipt,
          activeRevision: null,
          previousRevision: null,
          pendingAnalysis: null,
          pendingJob: null,
          latestUpdateReport: null,
          lastFailure: null,
          maintenanceFailure: null
        },
        appearanceDials: retiredState.appearanceDials,
        facialArtwork: { preserved: 'face' },
        skinAppearance: { preserved: 'skin' },
        hairState: retiredHairState,
        recipeFitReceipts: [
          { receiptId: 'fit-hair', surface: 'hair', marker: 'remove' },
          { receiptId: 'fit-shirt', surface: 'clothing', marker: 'preserve' }
        ],
        cues: { enabled: ['happy'] },
        defaults: { baseLoop: 'base_stand' },
        camera: { mode: 'free' },
        created_at: '2026-08-10T00:00:00.000Z',
        updated_at: '2026-08-10T00:00:00.000Z'
      } as unknown as GoonRecord
      await registerFixtureCustomUploads({ customAvatar: goon.customAvatar })
      await redis.json.set(`goon:${GOON_ID}`, '$', goon)
      await redis.sAdd(`user:${USER_ID}:goons`, GOON_ID)

      const result = await resetRetiredHairRecipeState(
        { userId: USER_ID, goonId: GOON_ID, expectedWriteVersion: 1 },
        { now: () => new Date('2026-08-10T00:00:01.000Z') }
      )

      expect(result).toMatchObject({ recovered: true, removedContract: 'hair-state/v1' })
      expect(result.goon).toMatchObject({
        name: goon.name,
        description: goon.description,
        customAvatar: goon.customAvatar,
        facialArtwork: goon.facialArtwork,
        skinAppearance: goon.skinAppearance,
        cues: goon.cues,
        defaults: goon.defaults,
        camera: goon.camera,
        recipe: {
          writeVersion: 2,
          liveStatus: 'needs_bake',
          activeRevision: null,
          authoringRevision: {
            recipeRevision: 1,
            revisionId: 'recipe_revision_retired_hair',
            state: {
              appearanceDials: retiredState.appearanceDials,
              siblings: expect.not.arrayContaining([
                expect.objectContaining({ id: 'hairState' })
              ])
            }
          }
        },
        recipeFitReceipts: [
          { receiptId: 'fit-shirt', surface: 'clothing', marker: 'preserve' }
        ]
      })
      expect(result.goon.hairState).toBeUndefined()
      expect(
        (result.goon.recipe as any).authoringRevision.revisionSha256
      ).toBe(
        await recipeAuthoringRevisionSha256(
          (result.goon.recipe as any).authoringRevision
        )
      )

      await expect(
        resetRetiredHairRecipeState({
          userId: USER_ID,
          goonId: GOON_ID,
          expectedWriteVersion: 2
        })
      ).rejects.toMatchObject({ code: 'RECOVERY_NOT_REQUIRED' })
    }
  )

  it.runIf(REAL_REDIS_LANE)(
    'discovers package-authored maps, persists exact analysis evidence, and recovers durable jobs without asset leaks',
    async () => {
      const at = currentFixtureClock()
      const fixture = await createRecipePhysicalMigrationFixture()
      const sourceArchive = await archiveReceipt('source', fixture.source)
      let targetArchive = await archiveReceipt('target', fixture.target)
      const source = sourceFromReceipt(sourceArchive.receipt, fixture.source.identity)
      const bytes = new Map<string, Uint8Array>([
        [sourceArchive.assets[0]!.ref, fixture.source.packageBytes],
        [sourceArchive.assets[1]!.ref, fixture.source.glbBytes],
        [sourceArchive.assets[2]!.ref, fixture.source.manifestBytes],
        [targetArchive.assets[0]!.ref, fixture.target.packageBytes],
        [targetArchive.assets[1]!.ref, fixture.target.glbBytes],
        [targetArchive.assets[2]!.ref, fixture.target.manifestBytes]
      ])
      const readAsset = async (asset: RecipeStoredAssetRef) => {
        const value = bytes.get(asset.ref)
        if (!value) throw new Error(`missing fixture asset ${asset.ref}`)
        return value
      }
      const sourceBake = await bakeLiveGoon({
        source,
        sourceRevision: { revisionId: 'revision-1', revision: 1 },
        state: fixture.sourceState,
        packageBytes: fixture.source.packageBytes,
        modelBytes: fixture.source.glbBytes,
        manifestBytes: fixture.source.manifestBytes
      })
      const sourceLiveBytes = {
        package: sourceBake.packageBytes,
        model: sourceBake.modelBytes,
        manifest: sourceBake.manifestBytes
      }
      const liveAssets = {
        package: await storedAsset('/uploads/goon_custom_packages/live-source.bgoon', sourceLiveBytes.package),
        model: await storedAsset('/uploads/goon_custom_models/live-source.glb', sourceLiveBytes.model),
        manifest: await storedAsset('/uploads/goon_custom_manifests/live-source.json', sourceLiveBytes.manifest)
      }
      bytes.set(liveAssets.package.ref, sourceLiveBytes.package)
      bytes.set(liveAssets.model.ref, sourceLiveBytes.model)
      bytes.set(liveAssets.manifest.ref, sourceLiveBytes.manifest)
      await registerFixtureCustomUploads(liveAssets)
      const sourceLiveReceipt = sourceBake.receipt
      const sourceReceiptDocument = await createGoonRecipeDocument({
        userId: USER_ID,
        goonId: GOON_ID,
        content: sourceArchive.receipt
      })
      const liveDocument = await createGoonRecipeDocument({
        userId: USER_ID,
        goonId: GOON_ID,
        content: sourceLiveReceipt
      })
      const [storedSourceReceipt, storedLive] = await Promise.all([
        putGoonRecipeDocument(sourceReceiptDocument),
        putGoonRecipeDocument(liveDocument)
      ])
      const sourceReceiptRef = {
        contract: sourceReceiptDocument.documentContract,
        ref: storedSourceReceipt.key,
        sha256: sourceReceiptDocument.sha256
      }
      const liveRef = {
        contract: liveDocument.documentContract,
        ref: storedLive.key,
        sha256: liveDocument.sha256
      }
      const revision = {
        contract: GOON_RECIPE_REVISION_CONTRACT,
        recipeRevision: 1,
        revisionId: 'revision-1',
        revisionSha256: ZERO_SHA256,
        source,
        state: fixture.sourceState,
        liveBuildReceipt: liveRef,
        updateReport: null
      }
      revision.revisionSha256 = await recipeRevisionBundleSha256(revision)
      const envelope = await createRecipeRevisionEnvelope({
        contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
        revision,
        sourceContainmentReceipt: sourceReceiptRef,
        live: liveAssets
      })
      await putRecipeRevisionEnvelope(USER_ID, GOON_ID, envelope)
      const activeRef = {
        contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
        ref: `goon_recipe_revision:${USER_ID}:${GOON_ID}:${revision.revisionId}`,
        sha256: envelope.envelopeSha256
      }
      const authoringRevision = {
        contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
        recipeRevision: 1,
        revisionId: revision.revisionId,
        revisionSha256: ZERO_SHA256,
        source,
        state: fixture.sourceState,
        updateReport: null
      }
      authoringRevision.revisionSha256 = await recipeAuthoringRevisionSha256(authoringRevision)
      const goon: GoonRecord = {
        id: GOON_ID,
        user_id: USER_ID,
        name: 'Lifecycle Fixture',
        kind: 'custom',
        sourceProfile: 'expert-custom-glb',
        files: {},
        recipe: {
          contract: GOON_RECIPE_OWNER_V2_CONTRACT,
          writeVersion: 1,
          nextRecipeRevision: 2,
          liveStatus: 'up_to_date',
          authoringRevision,
          authoringSourceContainmentReceipt: sourceReceiptRef,
          activeRevision: activeRef,
          previousRevision: null,
          pendingAnalysis: null,
          pendingJob: null,
          latestUpdateReport: null,
          lastFailure: null,
          maintenanceFailure: null
        },
        appearanceDials: fixture.sourceState.appearanceDials,
        created_at: at(0).toISOString(),
        updated_at: at(0).toISOString()
      }
      await redis.json.set(`goon:${GOON_ID}`, '$', goon)
      await redis.sAdd(`user:${USER_ID}:goons`, GOON_ID)

      const documentsBeforePlanningFailure = (
        await redis.keys(`goon_recipe_document:${USER_ID}:${GOON_ID}:*`)
      ).sort()
      await expect(analyzeRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        receipt: targetArchive.receipt,
        siblingInputs: fixture.siblingInputs,
        componentMapBundle: fixture.componentMapBundle
      }, {
        readAsset,
        planMigration: async () => {
          throw new Error('Injected Recipe planning failure.')
        }
      })).rejects.toThrow('Injected Recipe planning failure.')
      expect((await redis.keys(`goon_recipe_document:${USER_ID}:${GOON_ID}:*`)).sort())
        .toEqual(documentsBeforePlanningFailure)
      expect(await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)).toMatchObject({
        recipe: { writeVersion: 1, pendingAnalysis: null, pendingJob: null }
      })

      const unsupportedAnalysis = await analyzeRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        receipt: targetArchive.receipt,
        siblingInputs: fixture.siblingInputs
      }, { readAsset })
      expect(unsupportedAnalysis.plan.outcome).toMatchObject({
        kind: 'unsupported',
        readiness: 'blocked',
        cleanResetEligibility: 'eligible'
      })
      expect(unsupportedAnalysis.report).toMatchObject({
        status: 'blocked',
        entries: expect.arrayContaining([
          expect.objectContaining({
            id: 'affine_control',
            classification: 'blocked',
            proofStatus: 'failed'
          }),
          expect.objectContaining({
            id: 'new_control',
            classification: 'new',
            proposedValue: 0
          })
        ])
      })
      const cleanReset = await selectRecipeCleanReset({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: unsupportedAnalysis.owner.writeVersion,
        analysisId: unsupportedAnalysis.pendingAnalysis.analysisId,
        confirmed: true
      }, { readAsset })
      expect(cleanReset.plan.outcome).toMatchObject({
        kind: 'clean-reset',
        readiness: 'preview-required'
      })
      expect(cleanReset.report).toMatchObject({
        status: 'preview-required',
        entries: expect.arrayContaining([
          expect.objectContaining({
            id: 'affine_control',
            classification: 'reset-required',
            proposedValue: 0,
            proofStatus: 'not-preserved'
          }),
          expect.objectContaining({
            id: 'new_control',
            classification: 'new',
            proposedValue: 0,
            requiresConfirmation: true
          })
        ])
      })
      await discardRecipePackageAnalysis({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: cleanReset.owner.writeVersion,
        analysisId: cleanReset.pendingAnalysis.analysisId,
        confirmed: true
      }, { readAsset, deleteAsset: async () => {} })

      // The ordinary Update Goon File request carries no client map. Replace
      // only the discarded target fixture with its package-authored carrier.
      const embeddedFixture = await createRecipePhysicalMigrationFixture({ embeddedComponentMaps: true })
      fixture.target = embeddedFixture.target
      targetArchive = await archiveReceipt('target', fixture.target)
      bytes.set(targetArchive.assets[0]!.ref, fixture.target.packageBytes)
      bytes.set(targetArchive.assets[1]!.ref, fixture.target.glbBytes)
      bytes.set(targetArchive.assets[2]!.ref, fixture.target.manifestBytes)
      let analysis = await analyzeRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        receipt: targetArchive.receipt,
        siblingInputs: fixture.siblingInputs
      }, { readAsset })
      expect(analysis.plan.outcome).toMatchObject({ kind: 'automatic', readiness: 'ready' })
      expect(analysis.plan.componentMapBundleSha256).toBe(fixture.componentMapBundle.bundleSha256)
      const mapContext = await getGoonRecipeDocument(USER_ID, GOON_ID, analysis.pendingAnalysis.analysisRef.sha256)
      expect(mapContext.content).toMatchObject({ componentMapBundle: fixture.componentMapBundle })
      expect(analysis.owner.writeVersion).toBeGreaterThan(2)
      const rejectedPlanRef = analysis.pendingAnalysis.selectedPlan.ref
      const rejectedPlanDocument = await redis.json.get<Record<string, unknown>>(rejectedPlanRef)
      expect(rejectedPlanDocument).not.toBeNull()
      await redis.json.set(rejectedPlanRef, '$', {
        ...rejectedPlanDocument,
        sha256: 'f'.repeat(64)
      })
      const discardedAnalysisAssets: string[] = []
      await expect(discardRecipePackageAnalysis({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: analysis.owner.writeVersion,
        analysisId: analysis.pendingAnalysis.analysisId,
        confirmed: true
      }, {
        readAsset,
        deleteAsset: async (uploadType, filename) => {
          discardedAnalysisAssets.push(`${uploadType}/${filename}`)
        }
      })).resolves.toMatchObject({ discarded: true })
      await expect(redis.json.get(rejectedPlanRef)).resolves.toBeNull()
      expect(discardedAnalysisAssets.sort()).toEqual([
        'goon_custom_manifests/target.json',
        'goon_custom_models/target.glb',
        'goon_custom_packages/target.bgoon'
      ])
      analysis = await analyzeRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        receipt: targetArchive.receipt,
        siblingInputs: fixture.siblingInputs
      }, { readAsset })

      const submittedState = structuredClone(analysis.plan.proposedState!)
      const injectedFit = await createAnatomyFitState('a'.repeat(64), [])
      submittedState.siblings.push(await anatomyFitRecipeSibling(injectedFit))
      submittedState.siblings.sort((left, right) => left.id.localeCompare(right.id))
      submittedState.stateSha256 = await recipeStateSnapshotSha256(submittedState)
      const reviewed = await reviewRecipePackageState({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: analysis.owner.writeVersion,
        analysisId: analysis.pendingAnalysis.analysisId,
        state: submittedState,
        confirmedControlIds: [],
        cleanResetConfirmed: false
      }, { readAsset })
      expect(reviewed.reviewedState?.state.siblings.some((entry) => entry.id === 'anatomy-fit'))
        .toBe(false)
      const replayedReview = await reviewRecipePackageState({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: reviewed.owner.writeVersion,
        analysisId: reviewed.pendingAnalysis.analysisId,
        state: submittedState,
        confirmedControlIds: [],
        cleanResetConfirmed: false
      }, { readAsset })
      expect(replayedReview.owner.writeVersion).toBe(reviewed.owner.writeVersion)
      expect(replayedReview.pendingAnalysis.reviewedState).toEqual(
        reviewed.pendingAnalysis.reviewedState
      )

      const started = await startRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: replayedReview.owner.writeVersion,
        idempotencyKey: 'fixture-update-1',
        analysisId: replayedReview.pendingAnalysis.analysisId
      }, {
        readAsset,
        now: () => at(0),
        leaseMs: 1000
      })
      expect(started.job.status).toBe('baking')
      expect(started.job.targetRecipeRevision).toBe(2)
      // The repository's Lua guard uses Redis TIME, so even this isolated
      // renewal probe shares the current-relative fixture clock.
      const renewalNow = at(0).getTime()
      const renewalJob = structuredClone(started.job)
      renewalJob.lease = {
        ownerId: started.job.lease!.ownerId,
        expiresAt: new Date(renewalNow + 60_000).toISOString()
      }
      await redis.json.set(recipeJobRedisKey(USER_ID, GOON_ID, started.job.jobId), '$', renewalJob)

      const renewed = await renewActiveRecipeJobLease({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (started.goon.recipe as any).writeVersion,
        expectedJobStateVersion: started.job.stateVersion
      }, {
        now: () => new Date(renewalNow + 30_000),
        leaseMs: 60_000
      })
      expect(renewed.job.lease?.expiresAt).toBe(new Date(renewalNow + 90_000).toISOString())
      expect(renewed.owner.writeVersion).toBe((started.goon.recipe as any).writeVersion)
      expect(renewed.job.stateVersion).toBe(started.job.stateVersion)
      await expect(renewActiveRecipeJobLease({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (started.goon.recipe as any).writeVersion,
        expectedJobStateVersion: started.job.stateVersion
      }, {
        now: () => new Date(renewalNow + 91_000),
        leaseMs: 60_000
      })).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })

      const held = recipeReplayControl({
        userId: USER_ID,
        goonId: GOON_ID,
        job: renewalJob,
        expectedWriteVersion: (started.goon.recipe as any).writeVersion,
        dependencies: {
          now: () => new Date(renewalNow + 65_000),
          leaseMs: 60_000
        }
      })
      await held.checkpoint()
      expect((await getGoonRecipeJob(USER_ID, GOON_ID, started.job.jobId)).lease?.expiresAt)
        .toBe(new Date(renewalNow + 125_000).toISOString())
      const failedDuringReplay = await failRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (started.goon.recipe as any).writeVersion,
        expectedJobStateVersion: started.job.stateVersion,
        stage: 'verifying',
        reason: 'Canceled during server replay.'
      }, { now: () => new Date(renewalNow + 66_000) })
      expect(failedDuringReplay.job.status).toBe('failed')
      await expect(held.checkpoint()).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
      expect(() => held.checkCancelled()).toThrow('changed while this operation was in progress')
      await redis.json.set(`goon:${GOON_ID}`, '$', started.goon)
      await redis.json.set(recipeJobRedisKey(USER_ID, GOON_ID, started.job.jobId), '$', started.job)

      let wallNow = 0
      const timed = readOnlyRecipeReplayControl(() => wallNow)
      await timed.checkpoint()
      wallNow = 15 * 60_000
      expect(() => timed.checkCancelled()).toThrow('took too long')
      const canceled = new AbortController()
      canceled.abort()
      expect(() => recipeReplayControl({
        userId: USER_ID, goonId: GOON_ID, job: renewalJob,
        expectedWriteVersion: (started.goon.recipe as any).writeVersion,
        dependencies: {}, signal: canceled.signal
      }).checkCancelled()).toThrow('canceled')

      const startedGoonSnapshot = structuredClone(started.goon)
      const startedJobSnapshot = structuredClone(started.job)
      for (const status of ['validating', 'planning', 'packaging', 'verifying'] as const) {
        const jobAtStage = {
          ...structuredClone(startedJobSnapshot),
          status,
          lease: { ownerId: 'restart-proof', expiresAt: at(1).toISOString() }
        }
        const goonAtStage = structuredClone(startedGoonSnapshot)
        goonAtStage.recipe = {
          ...(goonAtStage.recipe as any),
          liveStatus: 'building',
          pendingJob: {
            ...(goonAtStage.recipe as any).pendingJob,
            status
          }
        }
        await redis.json.set(`goon:${GOON_ID}`, '$', goonAtStage)
        await redis.json.set(recipeJobRedisKey(USER_ID, GOON_ID, jobAtStage.jobId), '$', jobAtStage)
        const recoveredStage = await recoverInterruptedRecipeJob({
          userId: USER_ID,
          goonId: GOON_ID,
          jobId: jobAtStage.jobId
        }, { now: () => at(2) })
        expect(recoveredStage).toMatchObject({
          recovered: true,
          job: {
            status: 'interrupted',
            failure: { stage: 'restart', reason: expect.stringContaining(status) }
          }
        })
      }
      await redis.json.set(`goon:${GOON_ID}`, '$', startedGoonSnapshot)
      await redis.json.set(
        recipeJobRedisKey(USER_ID, GOON_ID, startedJobSnapshot.jobId),
        '$',
        startedJobSnapshot
      )

      const interrupted = await recoverInterruptedRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId
      }, { now: () => at(2) })
      expect(interrupted).toMatchObject({ recovered: true, job: { status: 'interrupted' } })

      const retried = await retryRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (interrupted.goon.recipe as any).writeVersion,
        expectedJobStateVersion: interrupted.job.stateVersion
      }, {
        now: () => at(3),
        leaseMs: 1000
      })
      expect(retried.job).toMatchObject({ status: 'baking', attempt: 2 })

      const interruptedAgain = await recoverInterruptedRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId
      }, { now: () => at(5) })
      const deletedAssets: string[] = []
      const discarded = await discardRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (interruptedAgain.goon.recipe as any).writeVersion,
        expectedJobStateVersion: interruptedAgain.job.stateVersion
      }, {
        now: () => at(6),
        deleteAsset: async (uploadType, filename) => {
          deletedAssets.push(`${uploadType}/${filename}`)
        }
      })
      expect(discarded.goon.recipe).toMatchObject({
        liveStatus: 'up_to_date',
        pendingJob: null,
        nextRecipeRevision: 3
      })
      expect(deletedAssets.sort()).toEqual([
        'goon_custom_manifests/target.json',
        'goon_custom_models/target.glb',
        'goon_custom_packages/target.bgoon'
      ])
      await expect(getGoonRecipeJob(USER_ID, GOON_ID, started.job.jobId)).rejects.toMatchObject({
        code: 'NOT_FOUND'
      })

      const secondAnalysis = await analyzeRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        receipt: targetArchive.receipt,
        siblingInputs: fixture.siblingInputs
      }, { readAsset })
      expect(secondAnalysis.plan).toMatchObject({ fromRecipeRevision: 1, toRecipeRevision: 3 })
      const secondReviewed = await reviewRecipePackageState({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: secondAnalysis.owner.writeVersion,
        analysisId: secondAnalysis.pendingAnalysis.analysisId,
        state: secondAnalysis.plan.proposedState!,
        confirmedControlIds: [],
        cleanResetConfirmed: false
      }, { readAsset })
      const secondStarted = await startRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: secondReviewed.owner.writeVersion,
        idempotencyKey: 'fixture-update-2',
        analysisId: secondReviewed.pendingAnalysis.analysisId
      }, {
        readAsset,
        now: () => at(7),
        leaseMs: 10_000
      })
      const candidateState = secondStarted.reviewedState.state
      const candidateBake = await bakeLiveGoon({
        source: secondAnalysis.plan.toSource,
        sourceRevision: {
          revisionId: secondStarted.job.targetRevisionId,
          revision: secondStarted.job.targetRecipeRevision
        },
        state: candidateState,
        packageBytes: fixture.target.packageBytes,
        modelBytes: fixture.target.glbBytes,
        manifestBytes: fixture.target.manifestBytes
      })
      const candidateBytes = {
        package: candidateBake.packageBytes,
        model: candidateBake.modelBytes,
        manifest: candidateBake.manifestBytes
      }
      const candidateLive = {
        package: await storedAsset('/uploads/goon_custom_packages/live-target.bgoon', candidateBytes.package),
        model: await storedAsset('/uploads/goon_custom_models/live-target.glb', candidateBytes.model),
        manifest: await storedAsset('/uploads/goon_custom_manifests/live-target.json', candidateBytes.manifest)
      }
      bytes.set(candidateLive.package.ref, candidateBytes.package)
      bytes.set(candidateLive.model.ref, candidateBytes.model)
      bytes.set(candidateLive.manifest.ref, candidateBytes.manifest)
      await registerFixtureCustomUploads(candidateLive)
      const candidateReceipt = candidateBake.receipt
      const registered = await registerRecipeCandidateAssets({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: secondStarted.job.jobId,
        expectedWriteVersion: (secondStarted.goon.recipe as any).writeVersion,
        expectedJobStateVersion: secondStarted.job.stateVersion,
        live: candidateLive
      }, { readAsset, now: () => at(8) })
      const staged = await stageRecipeUpdateCandidate({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: secondStarted.job.jobId,
        expectedWriteVersion: registered.owner.writeVersion,
        expectedJobStateVersion: registered.job.stateVersion,
        liveBuildReceipt: candidateReceipt,
        live: candidateLive
      }, {
        readAsset,
        now: () => at(9)
      })
      expect(staged.job.status).toBe('ready')
      expect(staged.envelope.localReviewEyeStateProjection).toBeUndefined()
      expect(staged.goon.recipe).toMatchObject({ liveStatus: 'building' })
      const readyRecovery = await recoverInterruptedRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: staged.job.jobId
      }, { now: () => at(1800) })
      expect(readyRecovery).toMatchObject({ recovered: false, job: { status: 'ready', lease: null } })
      expect(readyRecovery.candidate).toEqual(staged.envelope)

      const readyFailure = await failRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: staged.job.jobId,
        expectedWriteVersion: (staged.goon.recipe as any).writeVersion,
        expectedJobStateVersion: staged.job.stateVersion,
        stage: 'preview-load',
        reason: 'Injected staged-candidate preview failure.'
      }, { now: () => at(9.25) })
      expect(readyFailure).toMatchObject({
        job: { status: 'failed', failure: { stage: 'preview-load' }, candidateRevision: staged.job.candidateRevision },
        goon: { recipe: { liveStatus: 'failed', activeRevision: activeRef } }
      })
      await redis.json.set(`goon:${GOON_ID}`, '$', staged.goon)
      await redis.json.set(recipeJobRedisKey(USER_ID, GOON_ID, staged.job.jobId), '$', staged.job)

      const committingWriteVersion = (staged.goon.recipe as any).writeVersion + 1
      const committingJob = {
        ...structuredClone(staged.job),
        status: 'committing' as const,
        stateVersion: staged.job.stateVersion + 1,
        targetWriteVersion: committingWriteVersion,
        lease: { ownerId: 'restart-proof', expiresAt: at(9.5).toISOString() },
        updatedAt: at(9).toISOString()
      }
      const committingGoon = structuredClone(staged.goon)
      committingGoon.recipe = {
        ...(committingGoon.recipe as any),
        writeVersion: committingWriteVersion,
        liveStatus: 'building',
        pendingJob: {
          ...(committingGoon.recipe as any).pendingJob,
          status: 'committing',
          targetWriteVersion: committingWriteVersion
        }
      }
      await redis.json.set(`goon:${GOON_ID}`, '$', committingGoon)
      await redis.json.set(recipeJobRedisKey(USER_ID, GOON_ID, committingJob.jobId), '$', committingJob)
      const committingRecovery = await recoverInterruptedRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: committingJob.jobId
      }, { now: () => at(10) })
      expect(committingRecovery).toMatchObject({
        recovered: true,
        job: { status: 'interrupted', failure: { stage: 'restart', reason: expect.stringContaining('committing') } },
        goon: { recipe: { activeRevision: activeRef } }
      })
      await redis.json.set(`goon:${GOON_ID}`, '$', staged.goon)
      await redis.json.set(recipeJobRedisKey(USER_ID, GOON_ID, staged.job.jobId), '$', staged.job)

      const orphanRecordA = `goon_recipe_document:${USER_ID}:${GOON_ID}:${'a'.repeat(64)}`
      const orphanRecordB = `goon_recipe_document:${USER_ID}:${GOON_ID}:${'b'.repeat(64)}`
      await redis.json.set(orphanRecordA, '$', {
        asset: { ref: '/uploads/goon_custom_models/retention-orphan-a.glb' }
      })
      await redis.json.set(orphanRecordB, '$', {
        asset: { ref: '/uploads/goon_custom_models/retention-orphan-b.glb' }
      })
      const retentionDeleteAttempts: string[] = []
      let injectRetentionFailure = true
      const committed = await commitRecipeUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: secondStarted.job.jobId,
        expectedWriteVersion: (staged.goon.recipe as any).writeVersion,
        expectedJobStateVersion: staged.job.stateVersion
      }, {
        readAsset,
        now: () => at(10),
        deleteAsset: async (uploadType, filename) => {
          retentionDeleteAttempts.push(`${uploadType}/${filename}`)
          if (injectRetentionFailure && filename === 'retention-orphan-b.glb') {
            injectRetentionFailure = false
            throw new Error('Injected retention asset delete failure.')
          }
        }
      })
      expect(committed.goon.recipe).toMatchObject({
        liveStatus: 'up_to_date',
        nextRecipeRevision: 4,
        activeRevision: { ref: expect.stringContaining(secondStarted.job.targetRevisionId) },
        previousRevision: activeRef
      })
      expect(committed.cleanupError).toBe('Injected retention asset delete failure.')
      expect(committed.goon.recipe).toMatchObject({
        maintenanceFailure: { stage: 'cleanup', reason: 'Injected retention asset delete failure.' }
      })
      // Retention now prunes unreachable records under the owner version
      // before attempting physical deletion. A failed physical delete leaves
      // an orphan upload for Admin cleanup, not an orphan Recipe document.
      expect(await redis.exists(orphanRecordA)).toBe(false)
      expect(await redis.exists(orphanRecordB)).toBe(false)

      const cleanupRetry = await pruneRecipeRetention(USER_ID, GOON_ID, {
        deleteAsset: async (uploadType, filename) => {
          retentionDeleteAttempts.push(`${uploadType}/${filename}`)
        }
      })
      expect(cleanupRetry.deletedRecords).not.toContain(orphanRecordA)
      expect(cleanupRetry.deletedRecords).not.toContain(orphanRecordB)
      expect(await redis.exists(orphanRecordA)).toBe(false)
      expect(await redis.exists(orphanRecordB)).toBe(false)
      expect(retentionDeleteAttempts.filter((entry) => entry.endsWith('retention-orphan-a.glb'))).toHaveLength(1)
      expect(retentionDeleteAttempts.filter((entry) => entry.endsWith('retention-orphan-b.glb'))).toHaveLength(1)
      await expect(getGoonRecipeJob(USER_ID, GOON_ID, secondStarted.job.jobId)).rejects.toMatchObject({
        code: 'NOT_FOUND'
      })
      await expect(
        getGoonRecipeDocument(USER_ID, GOON_ID, secondAnalysis.pendingAnalysis.selectedPlan.sha256)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const rollbackPreview = await getPreviousRecipeRevisionPreview(
        { userId: USER_ID, goonId: GOON_ID },
        { readAsset }
      )
      expect(rollbackPreview.previous.envelopeSha256).toBe(activeRef.sha256)
      expect(rollbackPreview.goon.recipe).toEqual(committed.goon.recipe)
      const rolledBack = await restorePreviousRecipeRevision({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: (committed.goon.recipe as any).writeVersion
      }, {
        readAsset,
        now: () => at(11),
        deleteAsset: async () => {}
      })
      expect(rolledBack.goon.recipe).toMatchObject({
        liveStatus: 'up_to_date',
        nextRecipeRevision: 4,
        activeRevision: activeRef,
        previousRevision: { ref: expect.stringContaining(secondStarted.job.targetRevisionId) }
      })

      const rebakeState = structuredClone(fixture.sourceState)
      rebakeState.appearanceDials.values.keep_control = 0.3
      rebakeState.stateSha256 = await recipeStateSnapshotSha256(rebakeState)
      const activeBeforeRebake = structuredClone((rolledBack.goon.recipe as any).activeRevision)
      const liveBeforeRebake = structuredClone(rolledBack.goon.customAvatar)
      const rebakeStarted = await startRecipeBake({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: (rolledBack.goon.recipe as any).writeVersion,
        idempotencyKey: 'fixture-rebake-1',
        state: rebakeState
      }, {
        readAsset,
        now: () => at(12),
        leaseMs: 10_000
      })
      expect(rebakeStarted.goon.recipe).toMatchObject({
        liveStatus: 'building',
        activeRevision: activeBeforeRebake,
        authoringRevision: { state: rebakeState }
      })
      expect(rebakeStarted.goon.customAvatar).toEqual(liveBeforeRebake)

      const corruptStoredGoon = structuredClone(rebakeStarted.goon)
      const corruptOwner = (corruptStoredGoon.recipe as any)
      corruptOwner.authoringRevision.state.appearanceDials.values.keep_control = 238 / 255
      corruptOwner.authoringRevision.state.stateSha256 = ZERO_SHA256
      corruptOwner.authoringRevision.state.stateSha256 = await recipeStateSnapshotSha256(
        corruptOwner.authoringRevision.state
      )
      corruptOwner.authoringRevision.revisionSha256 = ZERO_SHA256
      corruptOwner.authoringRevision.revisionSha256 = await recipeAuthoringRevisionSha256(
        corruptOwner.authoringRevision
      )
      const corruptStoredJob = structuredClone(rebakeStarted.job)
      corruptStoredJob.lease = {
        ...corruptStoredJob.lease!,
        expiresAt: at(12.5).toISOString()
      }
      await redis.json.set(`goon:${GOON_ID}`, '$', corruptStoredGoon)
      await redis.json.set(
        recipeJobRedisKey(USER_ID, GOON_ID, corruptStoredJob.jobId),
        '$',
        corruptStoredJob
      )
      const integrityRecovered = await recoverInterruptedRecipeJob(
        {
          userId: USER_ID,
          goonId: GOON_ID,
          jobId: corruptStoredJob.jobId
        },
        { now: () => at(13) }
      )
      const activeBeforeRecovery = await getRecipeRevisionEnvelope(
        USER_ID,
        GOON_ID,
        activeBeforeRebake.ref.split(':').pop()!
      )
      expect(integrityRecovered).toMatchObject({
        recovered: true,
        job: {
          status: 'failed',
          failure: {
            stage: 'restart',
            reason: expect.stringContaining('restored the last verified active revision')
          }
        },
        goon: {
          recipe: {
            liveStatus: 'failed',
            activeRevision: activeBeforeRebake,
            authoringRevision: { state: activeBeforeRecovery.revision.state }
          },
          customAvatar: liveBeforeRebake
        }
      })

      await redis.json.set(`goon:${GOON_ID}`, '$', rebakeStarted.goon)
      await redis.json.set(
        recipeJobRedisKey(USER_ID, GOON_ID, rebakeStarted.job.jobId),
        '$',
        rebakeStarted.job
      )
      const rebakeFailed = await failRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: rebakeStarted.job.jobId,
        expectedWriteVersion: (rebakeStarted.goon.recipe as any).writeVersion,
        expectedJobStateVersion: rebakeStarted.job.stateVersion,
        stage: 'baking',
        reason: 'Injected deterministic Worker failure.',
        reportRef: null
      }, { now: () => at(13) })
      expect(rebakeFailed.goon.recipe).toMatchObject({
        liveStatus: 'failed',
        activeRevision: activeBeforeRebake,
        authoringRevision: { state: rebakeState },
        lastFailure: { stage: 'baking' }
      })
      expect(rebakeFailed.goon.customAvatar).toEqual(liveBeforeRebake)

      const sourceBeforeDuplication = await redis.json.get(`goon:${GOON_ID}`) as unknown as GoonRecord
      const duplicate = await duplicateRecipeGoon({
        userId: USER_ID,
        sourceGoonId: GOON_ID,
        targetGoonId: 'recipe-lifecycle-copy',
        name: 'Lifecycle Fixture Copy',
        now: at(14).toISOString()
      }, { readAsset })
      expect(duplicate.recipe).toMatchObject({
        writeVersion: 1,
        nextRecipeRevision: 5,
        pendingJob: null,
        previousRevision: { ref: expect.stringContaining(':recipe-lifecycle-copy:') }
      })
      const duplicateActive = (duplicate.recipe as any).activeRevision
      expect(duplicateActive.ref).toContain(':recipe-lifecycle-copy:')
      expect(duplicateActive.ref).not.toBe(activeRef.ref)
      const duplicateEnvelope = await getRecipeRevisionEnvelope(
        USER_ID,
        'recipe-lifecycle-copy',
        duplicateActive.ref.split(':').pop()
      )
      expect(duplicateEnvelope.live).toEqual(envelope.live)
      expect(duplicateEnvelope.revision.source).toEqual(envelope.revision.source)
      for (const field of ['activeRevision', 'previousRevision'] as const) {
        const sourceRef = (sourceBeforeDuplication.recipe as any)[field]
        const duplicateRef = (duplicate.recipe as any)[field]
        const sourceEnvelope = await getRecipeRevisionEnvelope(
          USER_ID, GOON_ID, sourceRef.ref.split(':').pop()
        )
        const verifiedDuplicate = await verifyCompleteRecipeRevision(
          USER_ID, 'recipe-lifecycle-copy', duplicateRef, readAsset
        )
        expect(verifiedDuplicate.revision.revisionId).toBe(sourceEnvelope.revision.revisionId)
        expect(verifiedDuplicate.revision.state).toEqual(sourceEnvelope.revision.state)
        expect(verifiedDuplicate.revision.source).toEqual(sourceEnvelope.revision.source)
        expect(verifiedDuplicate.live).toEqual(sourceEnvelope.live)
        expect(duplicateRef.ref).not.toBe(sourceRef.ref)
        expect(await getRecipeRevisionEnvelope(
          USER_ID, GOON_ID, sourceRef.ref.split(':').pop()
        )).toEqual(sourceEnvelope)
      }
      expect((duplicate.recipe as any).authoringRevision.state).toEqual(duplicateEnvelope.revision.state)
      expect(duplicate.appearanceDials).toEqual(duplicateEnvelope.revision.state.appearanceDials)
      expect(await redis.json.get(`goon:${GOON_ID}`)).toEqual(sourceBeforeDuplication)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE).each([false, true])(
    'bootstraps across runtime-only writes, rejects source races, and completes its first bake without replacing Live early (edit before Save: %s)',
    async (editBeforeSave) => {
      const at = currentFixtureClock()
      const fixture = await createRecipePhysicalMigrationFixture()
      const sourceArchive = await archiveReceipt('bootstrap-source', fixture.source)
      const hairBytes = createRigidHairGlbFixture()
      const hairAsset = await createHairAssetFixture({
        recipeSource: fixture.source.recipeSource,
        mainBytes: hairBytes,
        headNode: 'HeadAnchor',
        sourceClass: 'user'
      })
      const hairState = createHairState(hairAsset)
      const recipeState = structuredClone(fixture.sourceState)
      recipeState.siblings.push({
        id: 'hairState',
        contract: 'hair-state/v2',
        definitionSha256: hairState.definitionSha256!,
        stateSha256: await recipeSiblingStateSha256(hairState),
        state: hairState
      })
      recipeState.siblings.sort((left, right) => left.id.localeCompare(right.id))
      recipeState.stateSha256 = await recipeStateSnapshotSha256(recipeState)
      const bytes = new Map<string, Uint8Array>([
        [sourceArchive.assets[0]!.ref, fixture.source.packageBytes],
        [sourceArchive.assets[1]!.ref, fixture.source.glbBytes],
        [sourceArchive.assets[2]!.ref, fixture.source.manifestBytes],
        [hairAsset.geometry.main.ref, hairBytes],
        [hairAsset.material.neutralValueTexture!.ref, HAIR_NEUTRAL_VALUE_PNG_FIXTURE],
        [hairAsset.material.highlightMask!.ref, HAIR_HIGHLIGHT_MASK_PNG_FIXTURE]
      ])
      let hairResolutions = 0
      const resolveHairAsset = async () => {
        hairResolutions++
        return hairAsset
      }
      const readAsset = async (asset: RecipeStoredAssetRef) => {
        const value = bytes.get(asset.ref)
        if (!value) throw new Error(`missing fixture asset ${asset.ref}`)
        return value
      }
      const legacyLive = {
        package: { url: '/uploads/goon_custom_packages/legacy.bgoon', filename: 'legacy.bgoon', size: 10 },
        model: { url: '/uploads/goon_custom_models/legacy.glb', filename: 'legacy.glb', size: 10 },
        manifest: { url: '/uploads/goon_custom_manifests/legacy.json', filename: 'legacy.json', size: 10 }
      }
      const legacy: GoonRecord = {
        id: GOON_ID,
        user_id: USER_ID,
        name: 'Legacy Recipe Fixture',
        kind: 'custom',
        sourceProfile: 'expert-custom-glb',
        files: {},
        customAvatar: legacyLive,
        appearanceDials: recipeState.appearanceDials,
        hairState,
        created_at: at(0).toISOString(),
        updated_at: at(0).toISOString()
      }
      await registerFixtureCustomUploads(legacyLive)
      await redis.json.set(`goon:${GOON_ID}`, '$', legacy)
      await redis.sAdd(`user:${USER_ID}:goons`, GOON_ID)

      const submittedBootstrapState = structuredClone(recipeState)
      const injectedBootstrapFit = await createAnatomyFitState('a'.repeat(64), [])
      submittedBootstrapState.siblings.push(
        await anatomyFitRecipeSibling(injectedBootstrapFit)
      )
      submittedBootstrapState.siblings.sort((left, right) => left.id.localeCompare(right.id))
      submittedBootstrapState.stateSha256 = await recipeStateSnapshotSha256(
        submittedBootstrapState
      )

      let sourceRaceInjected = false
      const readAssetWithSourceRace = async (asset: RecipeStoredAssetRef) => {
        if (!sourceRaceInjected) {
          sourceRaceInjected = true
          await redis.json.set(`goon:${GOON_ID}`, '$.customAvatar.package.filename', 'replaced-source.bgoon')
          await redis.json.set(`goon:${GOON_ID}`, '$.updated_at', at(0.5).toISOString())
        }
        return readAsset(asset)
      }
      await expect(bootstrapRecipeV2({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedUpdatedAt: legacy.updated_at,
        receipt: sourceArchive.receipt,
        state: submittedBootstrapState
      }, {
        readAsset: readAssetWithSourceRace,
        resolveHairAsset
      })).rejects.toMatchObject({
        code: 'WRITE_CONFLICT'
      })
      const conflicted = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(conflicted?.recipe).toBeUndefined()
      expect(conflicted).toMatchObject({
        customAvatar: { package: { filename: 'replaced-source.bgoon' } }
      })

      await redis.json.set(`goon:${GOON_ID}`, '$', legacy)
      let runtimeWriteInjected = false
      const readAssetWithRuntimeWrite = async (asset: RecipeStoredAssetRef) => {
        if (!runtimeWriteInjected) {
          runtimeWriteInjected = true
          await redis.json.set(`goon:${GOON_ID}`, '$.camera', {
            mode: 'free',
            target: [0, 1.2, 0]
          })
          await redis.json.set(`goon:${GOON_ID}`, '$.updated_at', at(0.75).toISOString())
        }
        return readAsset(asset)
      }

      const bootstrapped = await bootstrapRecipeV2({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedUpdatedAt: legacy.updated_at,
        receipt: sourceArchive.receipt,
        state: submittedBootstrapState
      }, {
        readAsset: readAssetWithRuntimeWrite,
        resolveHairAsset,
        now: () => at(1)
      })
      expect(bootstrapped.goon.recipe).toMatchObject({
        writeVersion: 1,
        liveStatus: 'needs_bake',
        activeRevision: null,
        authoringRevision: { state: recipeState }
      })
      expect(bootstrapped.goon.customAvatar).toEqual(legacyLive)
      expect(bootstrapped.goon.camera).toEqual({ mode: 'free', target: [0, 1.2, 0] })

      const savedDraft = structuredClone(recipeState)
      if (editBeforeSave) {
        savedDraft.appearanceDials.values.keep_control = 0.35
        savedDraft.stateSha256 = await recipeStateSnapshotSha256(savedDraft)
      }
      await expect(startRecipeBake({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 0,
        idempotencyKey: 'fixture-first-bake-stale',
        state: savedDraft
      }, { readAsset, resolveHairAsset })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
      expect(await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)).toEqual(bootstrapped.goon)

      await expect(startRecipeBake({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 1,
        idempotencyKey: 'fixture-first-bake-corrupt-source',
        state: savedDraft
      }, {
        readAsset: async (asset) => asset.ref === sourceArchive.assets[1]!.ref
          ? Uint8Array.of(1, 2, 3)
          : readAsset(asset),
        resolveHairAsset
      })).rejects.toMatchObject({ code: 'ASSET_MISMATCH' })
      expect(await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)).toEqual(bootstrapped.goon)

      let recipeRaceInjected = false
      await expect(startRecipeBake({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 1,
        idempotencyKey: 'fixture-first-bake-race',
        state: savedDraft
      }, {
        readAsset: async (asset) => {
          if (!recipeRaceInjected) {
            recipeRaceInjected = true
            await redis.json.set(`goon:${GOON_ID}`, '$.recipe.writeVersion', 2)
          }
          return readAsset(asset)
        },
        resolveHairAsset
      })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
      expect(await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)).toEqual({
        ...bootstrapped.goon,
        recipe: { ...bootstrapped.goon.recipe, writeVersion: 2 }
      })
      await redis.json.set(`goon:${GOON_ID}`, '$', bootstrapped.goon)

      const started = await startRecipeBake({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 1,
        idempotencyKey: 'fixture-first-bake-1',
        state: savedDraft
      }, {
        readAsset,
        resolveHairAsset,
        now: () => at(2),
        leaseMs: 10_000
      })
      expect(started.job).toMatchObject({ operation: 'first-bake', targetRecipeRevision: 1 })
      expect(started.goon.customAvatar).toEqual(legacyLive)
      expect(started.goon.recipe).toMatchObject({
        writeVersion: 2,
        nextRecipeRevision: 2,
        activeRevision: null,
        previousRevision: null,
        authoringRevision: { state: savedDraft }
      })
      expect(started.reviewedState.state).toEqual(savedDraft)
      const initialRevisionId = (bootstrapped.goon.recipe as any).authoringRevision.revisionId
      expect(started.job.targetRevisionId === initialRevisionId).toBe(!editBeforeSave)
      const replay = await startRecipeBake({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 1,
        idempotencyKey: 'fixture-first-bake-1',
        state: savedDraft
      }, { readAsset, resolveHairAsset })
      expect(replay.replayed).toBe(true)
      expect(replay.job).toEqual(started.job)
      expect(replay.reviewedState.state).toEqual(savedDraft)

      const bake = await bakeLiveGoon({
        source: started.job.stagedSource.source,
        sourceRevision: {
          revisionId: started.job.targetRevisionId,
          revision: started.job.targetRecipeRevision
        },
        state: started.reviewedState.state,
        packageBytes: fixture.source.packageBytes,
        modelBytes: fixture.source.glbBytes,
        manifestBytes: fixture.source.manifestBytes,
        hair: {
          asset: hairAsset,
          mainBytes: hairBytes,
          neutralValueBytes: Uint8Array.from(HAIR_NEUTRAL_VALUE_PNG_FIXTURE),
          highlightMaskBytes: Uint8Array.from(HAIR_HIGHLIGHT_MASK_PNG_FIXTURE)
        }
      })
      const live = {
        package: await storedAsset('/uploads/goon_custom_packages/bootstrap-live.bgoon', bake.packageBytes),
        model: await storedAsset('/uploads/goon_custom_models/bootstrap-live.glb', bake.modelBytes),
        manifest: await storedAsset('/uploads/goon_custom_manifests/bootstrap-live.json', bake.manifestBytes)
      }
      bytes.set(live.package.ref, bake.packageBytes)
      bytes.set(live.model.ref, bake.modelBytes)
      bytes.set(live.manifest.ref, bake.manifestBytes)
      await registerFixtureCustomUploads(live)
      const registered = await registerRecipeCandidateAssets({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (started.goon.recipe as any).writeVersion,
        expectedJobStateVersion: started.job.stateVersion,
        live
      }, { readAsset, now: () => at(3) })
      const selectedBakeSpy = vi.spyOn(liveGoonBaker, 'bakeLiveGoon')
      const staged = await stageRecipeUpdateCandidate({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: registered.owner.writeVersion,
        expectedJobStateVersion: registered.job.stateVersion,
        liveBuildReceipt: bake.receipt,
        live
      }, {
        readAsset,
        resolveHairAsset,
        now: () => at(4)
      })
      expect(selectedBakeSpy).toHaveBeenCalledTimes(1)
      selectedBakeSpy.mockClear()
      expect(staged.goon.customAvatar).toEqual(legacyLive)
      const hairResolutionsAfterStage = hairResolutions
      const committed = await commitRecipeUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (staged.goon.recipe as any).writeVersion,
        expectedJobStateVersion: staged.job.stateVersion
      }, {
        readAsset,
        resolveHairAsset,
        now: () => at(5),
        deleteAsset: async () => {}
      })
      expect(selectedBakeSpy).not.toHaveBeenCalled()
      expect(hairResolutions).toBeGreaterThan(hairResolutionsAfterStage)
      expect(committed.goon.recipe).toMatchObject({
        liveStatus: 'up_to_date',
        activeRevision: { ref: expect.stringContaining(started.job.targetRevisionId) },
        previousRevision: null,
        authoringRevision: { recipeRevision: 1, state: savedDraft }
      })
      expect(committed.goon.customAvatar?.package?.url).toBe(live.package.ref)
      await verifyCompleteRecipeRevision(
        USER_ID,
        GOON_ID,
        (committed.goon.recipe as any).activeRevision,
        readAsset,
        resolveHairAsset
      )
      expect(selectedBakeSpy).toHaveBeenCalledTimes(1)
      bytes.delete(hairAsset.geometry.main.ref)
      expect(bytes.get(live.model.ref)).toEqual(bake.modelBytes)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'keeps an already registered asset reachable while a reservation blocks ready publication',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      const uploadKey = collectCustomGoonUploadKeys(prepared.live)
        .find((key) => key.startsWith('upload:goon_custom_models:'))!
      const markerKey = uploadKey.replace(/^upload:/, 'goon_asset_delete:')
      const filename = uploadKey.slice('upload:goon_custom_models:'.length)
      const beforeJob = await getGoonRecipeJob(USER_ID, GOON_ID, prepared.registered.job.jobId)
      await redis.execute((client) => client.set(markerKey, JSON.stringify({
        contract: 'goon-asset-deletion/v1', phase: 'reserved'
      })))
      const audit = await auditGoonUploadAssets(USER_ID)
      expect(audit.entries.find((entry) => entry.uploadType === 'goon_custom_models' &&
        entry.filename === filename)).toMatchObject({ referenced: true })

      await expect(prepared.stage()).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
      const afterJob = await getGoonRecipeJob(USER_ID, GOON_ID, prepared.registered.job.jobId)
      expect(afterJob).toEqual({
        ...beforeJob,
        lease: expect.objectContaining({ ownerId: beforeJob.lease!.ownerId })
      })
      expect(Date.parse(afterJob.lease!.expiresAt)).toBeGreaterThanOrEqual(Date.parse(beforeJob.lease!.expiresAt))
      expect((await redis.json.get<GoonRecord>(`goon:${GOON_ID}`))?.recipe?.pendingJob?.status)
        .toBe(beforeJob.status)

      await redis.execute((client) => client.del(markerKey))
      const staged = await prepared.stage()
      expect(staged.job.status).toBe('ready')
      expect(staged.envelope.live.model.ref).toBe(prepared.live.model.ref)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'refuses delayed ready publication after upload metadata is gone',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      const uploadKey = collectCustomGoonUploadKeys(prepared.live)
        .find((key) => key.startsWith('upload:goon_custom_models:'))!
      const beforeJob = await getGoonRecipeJob(USER_ID, GOON_ID, prepared.registered.job.jobId)
      await redis.execute((client) => client.del(uploadKey))
      await expect(prepared.stage()).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', status: 409 })
      const afterJob = await getGoonRecipeJob(USER_ID, GOON_ID, prepared.registered.job.jobId)
      expect(afterJob).toEqual({
        ...beforeJob,
        lease: expect.objectContaining({ ownerId: beforeJob.lease!.ownerId })
      })
      expect(Date.parse(afterJob.lease!.expiresAt)).toBeGreaterThanOrEqual(Date.parse(beforeJob.lease!.expiresAt))
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE).each([0, 1, 2])(
    'rejects changed independently stored Source asset %s before Stage construction',
    async (assetIndex) => {
      const prepared = await prepareAdmissionCandidate('hair')
      const asset = prepared.sourceArchive.assets[assetIndex]!
      const damaged = (await prepared.readAsset(asset)).slice()
      damaged[damaged.length - 1] ^= 1
      prepared.bytes.set(asset.ref, damaged)
      const selectedBakeSpy = vi.spyOn(liveGoonBaker, 'bakeLiveGoon')
      await expect(prepared.stage()).rejects.toMatchObject({ code: 'ASSET_MISMATCH' })
      expect(selectedBakeSpy).not.toHaveBeenCalled()
      const stored = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(stored?.recipe?.activeRevision).toBeNull()
      expect(stored?.customAvatar).toEqual(prepared.legacyLive)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'replays fully after a ready candidate fails and retries with a new attempt',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      const staged = await prepared.stage()
      const failed = await failRecipeJob({
        ...prepared.commitInput(staged),
        stage: 'preview-load',
        reason: 'Injected preview failure before Commit.'
      }, { now: () => prepared.at(5) })
      const retried = await retryRecipeJob({
        userId: USER_ID, goonId: GOON_ID, jobId: failed.job.jobId,
        expectedWriteVersion: (failed.goon.recipe as any).writeVersion,
        expectedJobStateVersion: failed.job.stateVersion
      }, { now: () => prepared.at(6) })
      expect(retried.job).toMatchObject({ status: 'ready', attempt: staged.job.attempt + 1 })
      const selectedBakeSpy = vi.spyOn(liveGoonBaker, 'bakeLiveGoon')
      const committed = await commitRecipeUpdate({
        userId: USER_ID, goonId: GOON_ID, jobId: retried.job.jobId,
        expectedWriteVersion: (retried.goon.recipe as any).writeVersion,
        expectedJobStateVersion: retried.job.stateVersion
      }, { ...prepared.dependencies, now: () => prepared.at(7), deleteAsset: async () => {} })
      expect(selectedBakeSpy).toHaveBeenCalledTimes(1)
      expect(committed.goon.recipe).toMatchObject({ liveStatus: 'up_to_date' })
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE).each(['source', 'live'] as const)(
    'rejects corrupted stored %s bytes even after a successful Stage admission',
    async (role) => {
      const prepared = await prepareAdmissionCandidate('hair')
      const staged = await prepared.stage()
      const ref = role === 'source'
        ? prepared.sourceArchive.assets[1]!.ref
        : prepared.live.model.ref
      prepared.bytes.set(ref, Uint8Array.of(1, 2, 3))

      await expect(commitRecipeUpdate(prepared.commitInput(staged), {
        ...prepared.dependencies, now: () => prepared.at(5)
      })).rejects.toMatchObject({ code: 'ASSET_MISMATCH' })
      const stored = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(stored?.recipe?.activeRevision).toBeNull()
      expect(stored?.customAvatar).toEqual(prepared.legacyLive)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE).each(['bytes', 'metadata'] as const)(
    'rereads Hair %s and rejects changes before activating a cached candidate',
    async (kind) => {
      const prepared = await prepareAdmissionCandidate('hair')
      const staged = await prepared.stage()
      if (kind === 'bytes') {
        prepared.bytes.set(prepared.hairAsset!.geometry.main.ref, Uint8Array.of(1, 2, 3))
      } else {
        const altered = structuredClone(prepared.hairAsset!)
        altered.display.name = `${altered.display.name} changed`
        prepared.resolveHairAsset = async () => altered
      }
      const selectedBakeSpy = vi.spyOn(liveGoonBaker, 'bakeLiveGoon')
      await expect(commitRecipeUpdate(prepared.commitInput(staged), {
        ...prepared.dependencies,
        resolveHairAsset: prepared.resolveHairAsset,
        now: () => prepared.at(5)
      })).rejects.toThrow()
      expect(selectedBakeSpy).not.toHaveBeenCalled()
      const stored = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(stored?.recipe?.activeRevision).toBeNull()
      expect(stored?.customAvatar).toEqual(prepared.legacyLive)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'does not publish ready or mint admission after another writer changes the job during Stage',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      let interrupted = false
      await expect(prepared.stage({
        ...prepared.dependencies,
        readAsset: async (asset) => {
          if (!interrupted && asset.ref === prepared.live.manifest.ref) {
            interrupted = true
            await failRecipeJob({
              userId: USER_ID, goonId: GOON_ID,
              jobId: prepared.registered.job.jobId,
              expectedWriteVersion: prepared.registered.owner.writeVersion,
              expectedJobStateVersion: prepared.registered.job.stateVersion,
              stage: 'verifying', reason: 'Concurrent Stage cancellation.'
            }, { now: () => prepared.at(4) })
          }
          return prepared.readAsset(asset)
        }
      })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
      expect(interrupted).toBe(true)
      const storedJob = await getGoonRecipeJob(USER_ID, GOON_ID, prepared.registered.job.jobId)
      expect(storedJob.status).toBe('failed')
      expect(storedJob.candidateRevision).toBeNull()
      const stored = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(stored?.recipe?.activeRevision).toBeNull()
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'rejects an ordinary Stage whose lease expires during stored Live verification',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      let now = prepared.at(4)
      let crossedLease = false
      await expect(prepared.stage({
        ...prepared.dependencies,
        now: () => now,
        readAsset: async (asset) => {
          if (asset.ref === prepared.live.manifest.ref) {
            crossedLease = true
            now = prepared.at(400)
          }
          return prepared.readAsset(asset)
        }
      })).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
      expect(crossedLease).toBe(true)
      const storedJob = await getGoonRecipeJob(USER_ID, GOON_ID, prepared.registered.job.jobId)
      expect(storedJob.status).not.toBe('ready')
      expect(storedJob.candidateRevision).toBeNull()
      const stored = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(stored?.recipe?.activeRevision).toBeNull()
      expect(stored?.customAvatar).toEqual(prepared.legacyLive)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'rejects a fresh-admission Commit whose lease expires during stored Live verification',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      const staged = await prepared.stage()
      let now = prepared.at(5)
      let crossedLease = false
      const selectedBakeSpy = vi.spyOn(liveGoonBaker, 'bakeLiveGoon')
      await expect(commitRecipeUpdate(prepared.commitInput(staged), {
        ...prepared.dependencies,
        now: () => now,
        readAsset: async (asset) => {
          if (asset.ref === prepared.live.manifest.ref) {
            crossedLease = true
            now = prepared.at(400)
          }
          return prepared.readAsset(asset)
        }
      })).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
      expect(crossedLease).toBe(true)
      expect(selectedBakeSpy).not.toHaveBeenCalled()
      const stored = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(stored?.recipe?.activeRevision).toBeNull()
      expect(stored?.customAvatar).toEqual(prepared.legacyLive)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'guards the final Commit CAS against a durable lease change after its last checkpoint',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      const staged = await prepared.stage()
      const actualCas = recipeRepository.compareAndSwapRecipeJobState
      let interceptedFinalCas = false
      vi.spyOn(recipeRepository, 'compareAndSwapRecipeJobState').mockImplementation(async (input) => {
        if (input.nextJob.status === 'committed') {
          interceptedFinalCas = true
          expect(input.expectedLease).toEqual(expect.objectContaining({ ownerId: expect.any(String) }))
          const key = recipeJobRedisKey(USER_ID, GOON_ID, staged.job.jobId)
          const changedJob = structuredClone(await getGoonRecipeJob(USER_ID, GOON_ID, staged.job.jobId))
          changedJob.lease!.expiresAt = prepared.at(-200).toISOString()
          await redis.json.set(key, '$', changedJob)
        }
        return actualCas(input)
      })
      await expect(commitRecipeUpdate(prepared.commitInput(staged), {
        ...prepared.dependencies, now: () => prepared.at(5)
      })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
      expect(interceptedFinalCas).toBe(true)
      const stored = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(stored?.recipe?.activeRevision).toBeNull()
      expect(stored?.customAvatar).toEqual(prepared.legacyLive)
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'replays fully when the ready job changes without a state-version change',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      const staged = await prepared.stage()
      const jobKey = recipeJobRedisKey(USER_ID, GOON_ID, staged.job.jobId)
      const changedJob = structuredClone(staged.job)
      changedJob.attempt++
      await redis.json.set(jobKey, '$', changedJob)
      const selectedBakeSpy = vi.spyOn(liveGoonBaker, 'bakeLiveGoon')
      const committed = await commitRecipeUpdate(prepared.commitInput(staged), {
        ...prepared.dependencies, now: () => prepared.at(5), deleteAsset: async () => {}
      })
      expect(selectedBakeSpy).toHaveBeenCalledTimes(1)
      expect(committed.goon.recipe).toMatchObject({ liveStatus: 'up_to_date' })
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'replays fully when the ready owner changes without a write-version change',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      const staged = await prepared.stage()
      const changedGoon = structuredClone(staged.goon)
      const changedOwner = changedGoon.recipe as any
      changedOwner.nextRecipeRevision++
      await redis.json.set(`goon:${GOON_ID}`, '$', changedGoon)

      const selectedBakeSpy = vi.spyOn(liveGoonBaker, 'bakeLiveGoon')
      const committed = await commitRecipeUpdate(prepared.commitInput(staged), {
        ...prepared.dependencies, now: () => prepared.at(5), deleteAsset: async () => {}
      })
      expect(selectedBakeSpy).toHaveBeenCalledTimes(1)
      expect(committed.goon.recipe).toMatchObject({ liveStatus: 'up_to_date' })
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'rejects a mismatched candidate envelope after Stage without activating it',
    async () => {
      const prepared = await prepareAdmissionCandidate('hair')
      const staged = await prepared.stage()
      const changedJob = structuredClone(staged.job)
      changedJob.candidateRevision!.sha256 = 'f'.repeat(64)
      await redis.json.set(recipeJobRedisKey(USER_ID, GOON_ID, staged.job.jobId), '$', changedJob)

      await expect(commitRecipeUpdate(prepared.commitInput(staged), {
        ...prepared.dependencies, now: () => prepared.at(5)
      })).rejects.toThrow()
      const stored = await redis.json.get<GoonRecord>(`goon:${GOON_ID}`)
      expect(stored?.recipe?.activeRevision).toBeNull()
      expect(stored?.customAvatar).toEqual(prepared.legacyLive)
    },
    30_000
  )
})
