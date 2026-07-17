import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import type { GoonRecord } from '$lib/types/goons'
import {
  GOON_LIVE_BUILD_CONTRACT,
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_REVISION_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  RECIPE_MIGRATION_REPORT_CONTRACT,
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  createGoonLiveBuildReceipt,
  createGoonRecipeDocument,
  createRecipeArchiveContainmentReceipt,
  createRecipeRevisionEnvelope,
  recipeAuthoringRevisionSha256,
  recipeRevisionBundleSha256,
  recipeMigrationReportSha256,
  sha256Hex,
  type RecipeArchiveContainmentReceipt,
  type RecipeMigrationPlan,
  type RecipeSource,
  type RecipeStateSnapshot,
  type RecipeStoredAssetRef
} from '$lib/goons/recipe'
import { createRecipePhysicalMigrationFixture } from '$lib/goons/recipe/fixtures/recipePhysicalMigrationPair'
import {
  getGoonRecipeJob,
  getGoonRecipeDocument,
  getRecipeRevisionEnvelope,
  putGoonRecipeDocument,
  putRecipeRevisionEnvelope
} from '../goonRecipeRepository.server'
import { duplicateRecipeGoon } from '../goonRecipeDuplicationService.server'
import {
  analyzeRecipePackageUpdate,
  discardRecipeJob,
  recoverInterruptedRecipeJob,
  retryRecipeJob,
  startRecipePackageUpdate,
  stageRecipeUpdateCandidate,
  commitRecipeUpdate,
  discardRecipePackageAnalysis,
  restorePreviousRecipeRevision
} from '../goonRecipeLifecycleService.server'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER_ID = 'recipe-lifecycle-user'
const GOON_ID = 'recipe-lifecycle-goon'
const ZERO_SHA256 = '0'.repeat(64)

async function storedAsset(ref: string, bytes: Uint8Array): Promise<RecipeStoredAssetRef> {
  return { ref, sha256: await sha256Hex(bytes), bytes: bytes.byteLength }
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

async function liveReceipt(input: {
  source: RecipeSource
  state: RecipeStateSnapshot
  revisionId: string
  revision: number
  live: { package: RecipeStoredAssetRef; model: RecipeStoredAssetRef; manifest: RecipeStoredAssetRef }
}) {
  return createGoonLiveBuildReceipt({
    contract: GOON_LIVE_BUILD_CONTRACT,
    source: {
      revisionId: input.revisionId,
      revision: input.revision,
      packageSha256: input.source.package.sha256,
      modelSha256: input.source.model.sha256,
      manifestSha256: input.source.manifest.sha256,
      definitionSha256: input.source.identities.definitionSha256,
      neutralRecipeSha256: input.source.identities.neutralRecipeSha256,
      basisSha256: input.source.identities.physicalBasisSha256
    },
    state: { contract: input.state.contract, sha256: input.state.stateSha256 },
    baker: {
      id: 'batshit.recipe-baker',
      version: '1.0.0',
      resolverVersion: 'appearance-resolver/v1',
      schemaVersion: 'goon-recipe-baker/v1'
    },
    inventory: {
      kept: ['node:/Body/morph:/blink', 'node:/hips'],
      removed: ['manifest:/appearanceDials'],
      liveMorphTargets: ['node:/Body/morph:/blink'],
      retainedDynamicMorphs: ['node:/Body/morph:/blink'],
      retainedCorrectiveMorphs: []
    },
    proofs: {
      neutralPositionSha256: '1'.repeat(64),
      skeletonRestSha256: '2'.repeat(64),
      followerSha256: '3'.repeat(64),
      rootSha256: '4'.repeat(64),
      groundingSha256: '5'.repeat(64),
      performanceSha256: '6'.repeat(64),
      pivotSha256: '7'.repeat(64),
      attachmentSha256: '8'.repeat(64),
      validationReportSha256: '9'.repeat(64),
      liveManifestProvenanceSha256: 'a'.repeat(64)
    },
    output: {
      package: { sha256: input.live.package.sha256, bytes: input.live.package.bytes },
      model: { sha256: input.live.model.sha256, bytes: input.live.model.bytes },
      manifest: { sha256: input.live.manifest.sha256, bytes: input.live.manifest.bytes },
      counts: {
        meshes: 1,
        vertices: 3,
        nodes: 2,
        bones: 1,
        morphTargets: 1,
        dynamicMorphTargets: 1,
        correctiveMorphTargets: 0,
        recipeMorphTargets: 0
      }
    },
    cost: { inputBytes: 10, meshesProcessed: 1, verticesProcessed: 3, morphTargetsProcessed: 1 },
    validation: {
      maxWeightScalarError: 0,
      maxVertexErrorMeters: 0,
      maxJointErrorMeters: 0,
      maxNodeTranslationErrorMeters: 0,
      maxPivotErrorMeters: 0,
      maxScaleError: 0,
      maxRotationErrorRadians: 0,
      maxGroundingErrorMeters: 0,
      maxFinalPositionErrorMeters: 0,
      rmsFinalPositionErrorMeters: 0
    }
  })
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
    }).sort((left, right) => left.id.localeCompare(right.id)),
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

  it.runIf(REAL_REDIS_LANE)(
    'persists exact analysis evidence and recovers, retries, and discards one durable job without asset leaks',
    async () => {
      const fixture = await createRecipePhysicalMigrationFixture()
      const sourceArchive = await archiveReceipt('source', fixture.source)
      const targetArchive = await archiveReceipt('target', fixture.target)
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
      const sourceLiveBytes = {
        package: new Uint8Array([1, 2, 3]),
        model: new Uint8Array([4, 5, 6]),
        manifest: new Uint8Array([7, 8, 9])
      }
      const liveAssets = {
        package: await storedAsset('/uploads/goon_custom_packages/live-source.bgoon', sourceLiveBytes.package),
        model: await storedAsset('/uploads/goon_custom_models/live-source.glb', sourceLiveBytes.model),
        manifest: await storedAsset('/uploads/goon_custom_manifests/live-source.json', sourceLiveBytes.manifest)
      }
      bytes.set(liveAssets.package.ref, sourceLiveBytes.package)
      bytes.set(liveAssets.model.ref, sourceLiveBytes.model)
      bytes.set(liveAssets.manifest.ref, sourceLiveBytes.manifest)
      const sourceLiveReceipt = await liveReceipt({
        source,
        state: fixture.sourceState,
        revisionId: 'revision-1',
        revision: 1,
        live: liveAssets
      })
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
          activeRevision: activeRef,
          previousRevision: null,
          pendingJob: null,
          latestUpdateReport: null,
          lastFailure: null,
          maintenanceFailure: null
        },
        appearanceDials: fixture.sourceState.appearanceDials,
        created_at: '2026-07-17T00:00:00.000Z',
        updated_at: '2026-07-17T00:00:00.000Z'
      }
      await redis.json.set(`goon:${GOON_ID}`, '$', goon)
      await redis.sAdd(`user:${USER_ID}:goons`, GOON_ID)

      let analysis = await analyzeRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        receipt: targetArchive.receipt,
        siblingInputs: fixture.siblingInputs,
        componentMapBundle: fixture.componentMapBundle
      }, { readAsset })
      expect(analysis.plan.outcome).toMatchObject({ kind: 'automatic', readiness: 'ready' })
      expect(analysis.expectedWriteVersion).toBe(1)
      const discardedAnalysisAssets: string[] = []
      await expect(discardRecipePackageAnalysis({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: analysis.expectedWriteVersion,
        planRef: analysis.planRef,
        containmentReceipt: analysis.containmentReceipt
      }, {
        readAsset,
        deleteAsset: async (uploadType, filename) => {
          discardedAnalysisAssets.push(`${uploadType}/${filename}`)
        }
      })).resolves.toMatchObject({ discarded: true })
      expect(discardedAnalysisAssets.sort()).toEqual([
        'goon_custom_manifests/target.json',
        'goon_custom_models/target.glb',
        'goon_custom_packages/target.bgoon'
      ])
      analysis = await analyzeRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        receipt: targetArchive.receipt,
        siblingInputs: fixture.siblingInputs,
        componentMapBundle: fixture.componentMapBundle
      }, { readAsset })

      const started = await startRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: analysis.expectedWriteVersion,
        idempotencyKey: 'fixture-update-1',
        planRef: analysis.planRef,
        containmentReceipt: analysis.containmentReceipt
      }, {
        readAsset,
        now: () => new Date('2026-07-17T00:00:00.000Z'),
        leaseMs: 1000
      })
      expect(started.job.status).toBe('baking')
      expect(started.job.targetRecipeRevision).toBe(2)

      const interrupted = await recoverInterruptedRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId
      }, { now: () => new Date('2026-07-17T00:00:02.000Z') })
      expect(interrupted).toMatchObject({ recovered: true, job: { status: 'interrupted' } })

      const retried = await retryRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (interrupted.goon.recipe as any).writeVersion,
        expectedJobStateVersion: interrupted.job.stateVersion
      }, {
        now: () => new Date('2026-07-17T00:00:03.000Z'),
        leaseMs: 1000
      })
      expect(retried.job).toMatchObject({ status: 'baking', attempt: 2 })

      const interruptedAgain = await recoverInterruptedRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId
      }, { now: () => new Date('2026-07-17T00:00:05.000Z') })
      const deletedAssets: string[] = []
      const discarded = await discardRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (interruptedAgain.goon.recipe as any).writeVersion,
        expectedJobStateVersion: interruptedAgain.job.stateVersion
      }, {
        now: () => new Date('2026-07-17T00:00:06.000Z'),
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
        siblingInputs: fixture.siblingInputs,
        componentMapBundle: fixture.componentMapBundle
      }, { readAsset })
      expect(secondAnalysis.plan).toMatchObject({ fromRecipeRevision: 1, toRecipeRevision: 3 })
      const secondStarted = await startRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: secondAnalysis.expectedWriteVersion,
        idempotencyKey: 'fixture-update-2',
        planRef: secondAnalysis.planRef,
        containmentReceipt: secondAnalysis.containmentReceipt
      }, {
        readAsset,
        now: () => new Date('2026-07-17T00:00:07.000Z'),
        leaseMs: 10_000
      })
      const candidateBytes = {
        package: new Uint8Array([10, 11, 12, 13]),
        model: new Uint8Array([14, 15, 16]),
        manifest: new Uint8Array([17, 18])
      }
      const candidateLive = {
        package: await storedAsset('/uploads/goon_custom_packages/live-target.bgoon', candidateBytes.package),
        model: await storedAsset('/uploads/goon_custom_models/live-target.glb', candidateBytes.model),
        manifest: await storedAsset('/uploads/goon_custom_manifests/live-target.json', candidateBytes.manifest)
      }
      bytes.set(candidateLive.package.ref, candidateBytes.package)
      bytes.set(candidateLive.model.ref, candidateBytes.model)
      bytes.set(candidateLive.manifest.ref, candidateBytes.manifest)
      const candidateState = secondAnalysis.plan.proposedState!
      const candidateReceipt = await liveReceipt({
        source: secondAnalysis.plan.toSource,
        state: candidateState,
        revisionId: secondStarted.job.targetRevisionId,
        revision: secondStarted.job.targetRecipeRevision,
        live: candidateLive
      })
      const report = await migrationReport(secondAnalysis.plan, fixture.edge)
      const staged = await stageRecipeUpdateCandidate({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: secondStarted.job.jobId,
        expectedWriteVersion: (secondStarted.goon.recipe as any).writeVersion,
        expectedJobStateVersion: secondStarted.job.stateVersion,
        state: candidateState,
        migrationReport: report,
        liveBuildReceipt: candidateReceipt,
        live: candidateLive
      }, {
        readAsset,
        now: () => new Date('2026-07-17T00:00:08.000Z')
      })
      expect(staged.job.status).toBe('ready')
      expect(staged.goon.recipe).toMatchObject({ liveStatus: 'building' })
      const committed = await commitRecipeUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: secondStarted.job.jobId,
        expectedWriteVersion: (staged.goon.recipe as any).writeVersion,
        expectedJobStateVersion: staged.job.stateVersion
      }, {
        readAsset,
        now: () => new Date('2026-07-17T00:00:09.000Z'),
        deleteAsset: async () => {}
      })
      expect(committed.goon.recipe).toMatchObject({
        liveStatus: 'up_to_date',
        nextRecipeRevision: 4,
        activeRevision: { ref: expect.stringContaining(secondStarted.job.targetRevisionId) },
        previousRevision: activeRef
      })
      await expect(getGoonRecipeJob(USER_ID, GOON_ID, secondStarted.job.jobId)).rejects.toMatchObject({
        code: 'NOT_FOUND'
      })
      await expect(
        getGoonRecipeDocument(USER_ID, GOON_ID, secondAnalysis.planRef.sha256)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const rolledBack = await restorePreviousRecipeRevision({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: (committed.goon.recipe as any).writeVersion
      }, {
        readAsset,
        now: () => new Date('2026-07-17T00:00:10.000Z'),
        deleteAsset: async () => {}
      })
      expect(rolledBack.goon.recipe).toMatchObject({
        liveStatus: 'up_to_date',
        nextRecipeRevision: 4,
        activeRevision: activeRef,
        previousRevision: { ref: expect.stringContaining(secondStarted.job.targetRevisionId) }
      })

      const duplicate = await duplicateRecipeGoon({
        userId: USER_ID,
        sourceGoonId: GOON_ID,
        targetGoonId: 'recipe-lifecycle-copy',
        name: 'Lifecycle Fixture Copy',
        now: '2026-07-17T00:00:11.000Z'
      }, { readAsset })
      expect(duplicate.recipe).toMatchObject({
        writeVersion: 1,
        nextRecipeRevision: 4,
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
    },
    30_000
  )
})
