import { describe, expect, it } from 'vitest'
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
import { duplicateRecipeGoon } from '../goonRecipeDuplicationService.server'
import {
  analyzeRecipePackageUpdate,
  buildExternalRecipeSiblingInputs,
  bootstrapRecipeV2,
  discardRecipeJob,
  recoverInterruptedRecipeJob,
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
  selectRecipeCleanReset
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
        created_at: '2026-07-17T00:00:00.000Z',
        updated_at: '2026-07-17T00:00:00.000Z'
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

      let analysis = await analyzeRecipePackageUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        receipt: targetArchive.receipt,
        siblingInputs: fixture.siblingInputs,
        componentMapBundle: fixture.componentMapBundle
      }, { readAsset })
      expect(analysis.plan.outcome).toMatchObject({ kind: 'automatic', readiness: 'ready' })
      expect(analysis.owner.writeVersion).toBeGreaterThan(2)
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
        now: () => new Date('2026-07-17T00:00:00.000Z'),
        leaseMs: 1000
      })
      expect(started.job.status).toBe('baking')
      expect(started.job.targetRecipeRevision).toBe(2)

      const startedGoonSnapshot = structuredClone(started.goon)
      const startedJobSnapshot = structuredClone(started.job)
      for (const status of ['validating', 'planning', 'packaging', 'verifying'] as const) {
        const jobAtStage = {
          ...structuredClone(startedJobSnapshot),
          status,
          lease: { ownerId: 'restart-proof', expiresAt: '2026-07-17T00:00:01.000Z' }
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
        }, { now: () => new Date('2026-07-17T00:00:02.000Z') })
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
        now: () => new Date('2026-07-17T00:00:07.000Z'),
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
      const candidateReceipt = candidateBake.receipt
      const registered = await registerRecipeCandidateAssets({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: secondStarted.job.jobId,
        expectedWriteVersion: (secondStarted.goon.recipe as any).writeVersion,
        expectedJobStateVersion: secondStarted.job.stateVersion,
        live: candidateLive
      }, { readAsset, now: () => new Date('2026-07-17T00:00:08.000Z') })
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
        now: () => new Date('2026-07-17T00:00:09.000Z')
      })
      expect(staged.job.status).toBe('ready')
      expect(staged.goon.recipe).toMatchObject({ liveStatus: 'building' })
      const readyRecovery = await recoverInterruptedRecipeJob({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: staged.job.jobId
      }, { now: () => new Date('2026-07-17T00:30:00.000Z') })
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
      }, { now: () => new Date('2026-07-17T00:00:09.250Z') })
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
        lease: { ownerId: 'restart-proof', expiresAt: '2026-07-17T00:00:09.500Z' },
        updatedAt: '2026-07-17T00:00:09.000Z'
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
      }, { now: () => new Date('2026-07-17T00:00:10.000Z') })
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
        now: () => new Date('2026-07-17T00:00:10.000Z'),
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
      expect(await redis.exists(orphanRecordA)).toBe(true)
      expect(await redis.exists(orphanRecordB)).toBe(true)

      const cleanupRetry = await pruneRecipeRetention(USER_ID, GOON_ID, {
        deleteAsset: async (uploadType, filename) => {
          retentionDeleteAttempts.push(`${uploadType}/${filename}`)
        }
      })
      expect(cleanupRetry.deletedRecords).toEqual(expect.arrayContaining([orphanRecordA, orphanRecordB]))
      expect(await redis.exists(orphanRecordA)).toBe(false)
      expect(await redis.exists(orphanRecordB)).toBe(false)
      expect(retentionDeleteAttempts.filter((entry) => entry.endsWith('retention-orphan-a.glb'))).toHaveLength(2)
      expect(retentionDeleteAttempts.filter((entry) => entry.endsWith('retention-orphan-b.glb'))).toHaveLength(2)
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
        now: () => new Date('2026-07-17T00:00:11.000Z'),
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
        now: () => new Date('2026-07-17T00:00:12.000Z'),
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
        expiresAt: '2026-07-17T00:00:12.500Z'
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
        { now: () => new Date('2026-07-17T00:00:13.000Z') }
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
      }, { now: () => new Date('2026-07-17T00:00:13.000Z') })
      expect(rebakeFailed.goon.recipe).toMatchObject({
        liveStatus: 'failed',
        activeRevision: activeBeforeRebake,
        authoringRevision: { state: rebakeState },
        lastFailure: { stage: 'baking' }
      })
      expect(rebakeFailed.goon.customAvatar).toEqual(liveBeforeRebake)

      const duplicate = await duplicateRecipeGoon({
        userId: USER_ID,
        sourceGoonId: GOON_ID,
        targetGoonId: 'recipe-lifecycle-copy',
        name: 'Lifecycle Fixture Copy',
        now: '2026-07-17T00:00:14.000Z'
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
    },
    30_000
  )

  it.runIf(REAL_REDIS_LANE)(
    'bootstraps across runtime-only writes, rejects source races, and completes its first bake without replacing Live early',
    async () => {
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
      const resolveHairAsset = async () => hairAsset
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
        created_at: '2026-07-17T00:00:00.000Z',
        updated_at: '2026-07-17T00:00:00.000Z'
      }
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
          await redis.json.set(`goon:${GOON_ID}`, '$.updated_at', '2026-07-17T00:00:00.500Z')
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
          await redis.json.set(`goon:${GOON_ID}`, '$.updated_at', '2026-07-17T00:00:00.750Z')
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
        now: () => new Date('2026-07-17T00:00:01.000Z')
      })
      expect(bootstrapped.goon.recipe).toMatchObject({
        writeVersion: 1,
        liveStatus: 'needs_bake',
        activeRevision: null,
        authoringRevision: { state: recipeState }
      })
      expect(bootstrapped.goon.customAvatar).toEqual(legacyLive)
      expect(bootstrapped.goon.camera).toEqual({ mode: 'free', target: [0, 1.2, 0] })

      const started = await startRecipeBake({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 1,
        idempotencyKey: 'fixture-first-bake-1',
        state: recipeState
      }, {
        readAsset,
        resolveHairAsset,
        now: () => new Date('2026-07-17T00:00:02.000Z'),
        leaseMs: 10_000
      })
      expect(started.job).toMatchObject({ operation: 'first-bake', targetRecipeRevision: 1 })
      expect(started.goon.customAvatar).toEqual(legacyLive)

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
      const registered = await registerRecipeCandidateAssets({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (started.goon.recipe as any).writeVersion,
        expectedJobStateVersion: started.job.stateVersion,
        live
      }, { readAsset, now: () => new Date('2026-07-17T00:00:03.000Z') })
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
        now: () => new Date('2026-07-17T00:00:04.000Z')
      })
      expect(staged.goon.customAvatar).toEqual(legacyLive)
      const committed = await commitRecipeUpdate({
        userId: USER_ID,
        goonId: GOON_ID,
        jobId: started.job.jobId,
        expectedWriteVersion: (staged.goon.recipe as any).writeVersion,
        expectedJobStateVersion: staged.job.stateVersion
      }, {
        readAsset,
        resolveHairAsset,
        now: () => new Date('2026-07-17T00:00:05.000Z'),
        deleteAsset: async () => {}
      })
      expect(committed.goon.recipe).toMatchObject({
        liveStatus: 'up_to_date',
        activeRevision: { ref: expect.stringContaining(started.job.targetRevisionId) },
        previousRevision: null
      })
      expect(committed.goon.customAvatar?.package?.url).toBe(live.package.ref)
      bytes.delete(hairAsset.geometry.main.ref)
      expect(bytes.get(live.model.ref)).toEqual(bake.modelBytes)
    },
    30_000
  )
})
