import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  GOON_RECIPE_STATE_CONTRACT,
  GOON_RECIPE_JOB_CONTRACT,
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  RECIPE_MIGRATION_PLAN_CONTRACT,
  RECIPE_MIGRATION_REPORT_CONTRACT,
  RECIPE_SOURCE_CONTRACT,
  anatomyFitRecipeSibling,
  canonicalRecipeSha256,
  createAnatomyFitInput,
  createAnatomyFitResult,
  createAnatomyFitState,
  createGoonRecipeDocument,
  createRecipeMigrationPlan,
  verifyRecipeStateSnapshot
} from '$lib/goons/recipe'
import type { GoonRecord } from '$lib/types/goons'
import {
  RecipeRepositoryError,
  compareAndSwapRecipeJobState,
  compareAndSwapRecipeState,
  discardRecipeAnalysisRecords,
  getGoonRecipeDocument,
  getOwnedRecipeGoon,
  putGoonRecipeDocument
} from '../goonRecipeRepository.server'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER_ID = 'recipe-cas-user'
const GOON_ID = 'recipe-cas-goon'
const sha = (character: string) => character.repeat(64)

function documentRef(character: string) {
  return {
    contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
    ref: `goon_recipe_revision:${USER_ID}:${GOON_ID}:revision-${character}`,
    sha256: sha(character)
  }
}

function recipeOwner(writeVersion = 1) {
  return {
    contract: GOON_RECIPE_OWNER_V2_CONTRACT,
    writeVersion,
    nextRecipeRevision: 2,
    liveStatus: 'up_to_date',
    authoringRevision: {
      contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
      recipeRevision: 1,
      revisionId: 'revision-1',
      revisionSha256: sha('1'),
      source: {
        package: { ref: 'goons/source.bgoon', sha256: sha('2') },
        model: { ref: 'goons/source.glb', sha256: sha('3') },
        manifest: { ref: 'goons/source.json', sha256: sha('4') },
        identities: {
          contract: RECIPE_SOURCE_CONTRACT,
          schemaVersion: 1,
          baseId: 'batshit-base-female',
          fitFamily: 'batshit-base-female-v1',
          modelSha256: sha('3'),
          manifestSemanticSha256: sha('5'),
          definitionSha256: sha('6'),
          neutralId: 'neutral-1',
          neutralRecipeSha256: sha('7'),
          physicalBasisSha256: sha('8'),
          behaviorSha256: sha('9'),
          componentGraphSha256: sha('a'),
          topologySha256: sha('b'),
          skeletonHierarchySha256: sha('c')
        }
      },
      state: {
        contract: GOON_RECIPE_STATE_CONTRACT,
        stateSha256: sha('d'),
        appearanceDials: {
          contract: 'appearance-dial-values/v2',
          definitionSha256: sha('6'),
          neutralId: 'neutral-1',
          neutralRecipeSha256: sha('7'),
          values: { body_height: 0 },
          unlockedDialIds: []
        },
        siblings: []
      },
      updateReport: null
    },
    authoringSourceContainmentReceipt: {
      contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
      ref: `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('5')}`,
      sha256: sha('5')
    },
    activeRevision: documentRef('e'),
    previousRevision: null,
    pendingAnalysis: null,
    pendingJob: null,
    latestUpdateReport: null,
    lastFailure: null,
    maintenanceFailure: null
  } as const
}

function goon(name = 'Recipe CAS Goon', writeVersion = 1): GoonRecord {
  return {
    id: GOON_ID,
    user_id: USER_ID,
    name,
    kind: 'custom',
    sourceProfile: 'expert-custom-glb',
    files: {},
    recipe: recipeOwner(writeVersion),
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z'
  }
}

async function storageStableAnatomyFitSnapshot() {
  const fitInput = await createAnatomyFitInput({
    solverVersion: 'eye-socket-fit/neutral-relative/v3',
    domain: 'eye-socket-left',
    source: {
      modelSha256: sha('3'),
      appearanceDefinitionSha256: sha('6'),
      topologySha256: sha('b'),
      positionsSha256: sha('d'),
      positionsScalarCount: 61_074,
      physicalEvaluationSha256: sha('e'),
      physicalEvaluationScalarCount: 128,
      landmarkSetSha256: sha('f'),
      landmarkSampleCount: 194
    },
    relevantInputs: [
      { id: 'eye_size', value: 0.9963701302315507 }
    ],
    parameters: [
      {
        id: 'sclera-scale',
        lower: 0.88,
        upper: 1.12,
        neutral: 1,
        regularizationWeight: 0.5,
        initialStep: 0.04,
        minimumStep: 0.005
      }
    ]
  })
  const fitResult = await createAnatomyFitResult({
    solverVersion: fitInput.solverVersion,
    domain: fitInput.domain,
    inputSha256: fitInput.inputSha256,
    status: 'converged',
    convergence: {
      converged: true,
      iterations: 8,
      objective: 0.0015013614251065596,
      tolerance: 0.00025,
      reason: 'objective-tolerance'
    },
    resolvedParameters: [
      { id: 'sclera-scale', value: 0.9722222222222207, lower: 0.88, upper: 1.12, neutral: 1 }
    ],
    nodeTransforms: [
      {
        nodeId: 'eye-l-sclera',
        rootDeltaMatrix: [
          -0.11218153564400829, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          3.3040728006091187, 0, 0, 1
        ]
      }
    ],
    followerMorphCoefficients: [],
    metrics: [
      {
        id: 'minimum-lid-clearance',
        value: 0.0015013614251065596,
        unit: 'meters',
        minimum: 0.00025,
        maximum: null,
        passed: true
      }
    ],
    diagnostics: []
  })
  const fitState = await createAnatomyFitState(sha('6'), [
    { input: fitInput, result: fitResult }
  ])
  const sibling = await anatomyFitRecipeSibling(fitState)
  const content = {
    contract: GOON_RECIPE_STATE_CONTRACT,
    appearanceDials: {
      contract: 'appearance-dial-values/v2' as const,
      definitionSha256: sha('6'),
      neutralId: 'neutral-1',
      neutralRecipeSha256: sha('7'),
      values: { body_height: 0 },
      unlockedDialIds: []
    },
    siblings: [sibling]
  }
  return {
    ...content,
    stateSha256: await canonicalRecipeSha256(content)
  }
}

function bakingJob(stateVersion = 1, targetWriteVersion = 2) {
  return {
    contract: GOON_RECIPE_JOB_CONTRACT,
    userId: USER_ID,
    goonId: GOON_ID,
    jobId: 'job-1',
    idempotencyKey: 'update-1',
    operation: 'package-update',
    status: stateVersion === 1 ? 'baking' as const : 'packaging' as const,
    stateVersion,
    attempt: 1,
    targetWriteVersion,
    targetRecipeRevision: 2,
    targetRevisionId: 'revision-2',
    sourceRevision: documentRef('e'),
    stagedSource: {
      source: recipeOwner().authoringRevision.source,
      containmentReceipt: {
        contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
        ref: `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('5')}`,
        sha256: sha('5')
      }
    },
    plan: {
      contract: RECIPE_MIGRATION_PLAN_CONTRACT,
      ref: `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('6')}`,
      sha256: sha('6')
    },
    migrationReport: {
      contract: RECIPE_MIGRATION_REPORT_CONTRACT,
      ref: `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('7')}`,
      sha256: sha('7')
    },
    reviewedState: {
      contract: 'recipe-reviewed-state/v1',
      ref: `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('8')}`,
      sha256: sha('8')
    },
    stagedLive: null,
    candidateRevision: null,
    lease: { ownerId: 'worker-1', expiresAt: '2026-07-17T00:05:00.000Z' },
    failure: null,
    cleanupAssets: [],
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: `2026-07-17T00:00:0${stateVersion - 1}.000Z`
  }
}

function goonWithPendingJob(stateVersion = 1, writeVersion = 2): GoonRecord {
  const job = bakingJob(stateVersion, writeVersion)
  return {
    ...goon('Recipe CAS Goon', writeVersion),
    recipe: {
      ...recipeOwner(writeVersion),
      nextRecipeRevision: 3,
      liveStatus: 'building',
      pendingJob: {
        jobId: job.jobId,
        jobRef: `goon_recipe_job:${USER_ID}:${GOON_ID}:${job.jobId}`,
        status: job.status,
        operation: job.operation,
        targetWriteVersion: writeVersion,
        targetRecipeRevision: job.targetRecipeRevision,
        targetRevisionId: job.targetRevisionId
      }
    },
    updated_at: `2026-07-17T00:00:0${writeVersion - 1}.000Z`
  }
}

async function storageStableMigrationPlanDocument() {
  const owner = recipeOwner()
  const source = owner.authoringRevision.source
  const state = owner.authoringRevision.state
  const errors = {
    scalarMaximum: 0,
    positionMaximumMeters: 0,
    positionRmsMeters: 0,
    scaleMaximum: 0,
    quaternionMaximumRadians: 0,
    matrixMaximum: 0,
    bakedPositionMaximumMeters: 4.470348358154297e-8,
    bakedPositionRmsMeters: 3.3219461576257802e-9
  }
  const componentId = 'component.body'
  const plan = await createRecipeMigrationPlan({
    contract: RECIPE_MIGRATION_PLAN_CONTRACT,
    schemaVersion: 1,
    planId: 'migration.redisjson.storage-stability',
    directEdgeKey: 'recipe.redisjson.v1-to-v2',
    edgeSha256: sha('1'),
    fromSource: source,
    toSource: source,
    fromRecipeRevision: 1,
    toRecipeRevision: 2,
    fromStateSha256: state.stateSha256,
    toleranceProfile: 'recipe-strict/v1',
    componentMapBundleSha256: null,
    outcome: {
      kind: 'automatic',
      readiness: 'ready',
      preservationClaim: 'appearance-preserved',
      rejectionCodes: [],
      cleanResetEligibility: 'not-applicable',
      basedOnUnsupportedPlanSha256: null
    },
    controlRows: [
      {
        ledgerId: 'body_height',
        sourceControl: { id: 'body_height', kind: 'dial', value: 0 },
        targetControl: { id: 'body_height', kind: 'dial', value: 0 },
        edgeAction: 'keep',
        componentId,
        resolution: 'kept',
        aliasId: null,
        candidateOrigin: 'identity',
        candidateProofSha256: sha('2'),
        componentProofSha256: sha('0'),
        maximumScalarError: 0,
        proofStatus: 'verified',
        reasonCode: 'UNCHANGED_IDENTITY',
        message: 'The saved value remains exact.',
        requiresPreview: false,
        requiresConfirmation: false
      }
    ],
    siblingRows: ['eyeAppearance', 'facialArtwork', 'oralAppearance'].map((surface) => ({
      surface: surface as 'eyeAppearance' | 'facialArtwork' | 'oralAppearance',
      sourceState: null,
      targetDefinition: null,
      action: 'not-present' as const,
      resolution: 'not-present' as const,
      proposedState: null,
      proofStatus: 'not-required' as const,
      proofSha256: sha('3'),
      reasonCode: 'SIBLING_NOT_PRESENT' as const,
      message: 'This sibling surface is not present.',
      requiresPreview: false,
      requiresConfirmation: false
    })),
    componentProofs: [
      {
        componentId,
        sourceControlIds: ['body_height'],
        targetControlIds: ['body_height'],
        solver: 'identity',
        authorizedCandidateCount: 1,
        selectedCandidateSha256: sha('4'),
        uniquenessMethod: 'identity',
        uniquenessProofSha256: sha('5'),
        componentMapSha256: null,
        sourcePhysicalOutputSha256: sha('6'),
        targetPhysicalOutputSha256: sha('6'),
        comparedOutputKeysSha256: sha('7'),
        mismatchDomains: [],
        status: 'verified',
        errors,
        rejectionCodes: [],
        proofSha256: sha('0')
      }
    ],
    wholeRecipeProof: {
      status: 'verified',
      sourcePhysicalOutputSha256: sha('6'),
      targetPhysicalOutputSha256: sha('6'),
      sourceAbsoluteOutputSha256: sha('8'),
      targetAbsoluteOutputSha256: sha('8'),
      sourceMaterialSha256: sha('9'),
      targetMaterialSha256: sha('9'),
      materialMatches: true,
      errors: { ...errors, bakedPositionMaximumMeters: 0, bakedPositionRmsMeters: 0 },
      mismatchDomains: [],
      permitsAppearancePreservedClaim: true,
      proofSha256: sha('0')
    },
    warnings: [],
    proposedState: state
  })
  return createGoonRecipeDocument({
    userId: USER_ID,
    goonId: GOON_ID,
    content: plan as unknown as Record<string, unknown>
  })
}

describe('Goon Recipe repository', () => {
  useRedisTestServer()

  it('round-trips owned Recipe Goons and content-addressed documents', async () => {
    await redis.json.set(`goon:${GOON_ID}`, '$', goon())
    await expect(getOwnedRecipeGoon(USER_ID, GOON_ID)).resolves.toMatchObject({
      id: GOON_ID,
      recipe: { contract: GOON_RECIPE_OWNER_V2_CONTRACT, writeVersion: 1 }
    })

    const document = await createGoonRecipeDocument({
      userId: USER_ID,
      goonId: GOON_ID,
      content: { contract: 'recipe-job-report/v1', status: 'ready' }
    })
    await putGoonRecipeDocument(document)
    await putGoonRecipeDocument(document)
    await expect(getGoonRecipeDocument(USER_ID, GOON_ID, document.sha256)).resolves.toEqual(
      document
    )
  })

  it.runIf(REAL_REDIS_LANE)('allows exactly one of two concurrent CAS writers', async () => {
    await redis.json.set(`goon:${GOON_ID}`, '$', goon())
    const first = {
      ...goon('Stale Writer A', 2),
      recipe: { ...recipeOwner(2), activeRevision: documentRef('f') },
      updated_at: '2026-07-17T00:00:01.000Z'
    }
    const second = {
      ...goon('Stale Writer B', 2),
      recipe: { ...recipeOwner(2), activeRevision: documentRef('f') },
      updated_at: '2026-07-17T00:00:02.000Z'
    }

    const results = await Promise.allSettled([
      compareAndSwapRecipeState({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 1,
        nextGoon: first
      }),
      compareAndSwapRecipeState({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 1,
        nextGoon: second
      })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'WRITE_CONFLICT', status: 409 })
    })
    expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(RecipeRepositoryError)

    const stored = (await redis.json.get(`goon:${GOON_ID}`)) as GoonRecord
    expect(stored.recipe).toMatchObject({ writeVersion: 2 })
    expect(stored.name).toBe('Recipe CAS Goon')
  })

  it.runIf(REAL_REDIS_LANE)('preserves unrelated Goon fields changed after a Recipe snapshot', async () => {
    await redis.json.set(`goon:${GOON_ID}`, '$', goon())
    const staleNext = {
      ...goon('Stale Recipe Snapshot', 2),
      recipe: { ...recipeOwner(2), activeRevision: documentRef('f') },
      updated_at: '2026-07-17T00:00:01.000Z'
    }
    await redis.json.set(`goon:${GOON_ID}`, '$.name', 'Fresh Unrelated Edit')

    const stored = await compareAndSwapRecipeState({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 1,
      nextGoon: staleNext
    })

    expect(stored.name).toBe('Fresh Unrelated Edit')
    expect(stored.recipe).toMatchObject({
      writeVersion: 2,
      activeRevision: documentRef('f')
    })
  })

  it.runIf(REAL_REDIS_LANE)('commits the complete Recipe sibling and fit projection in one CAS', async () => {
    await redis.json.set(`goon:${GOON_ID}`, '$', {
      ...goon(),
      appearanceDials: { marker: 'old' },
      facialArtwork: { marker: 'old' },
      eyeAppearance: { marker: 'old' },
      oralAppearance: { marker: 'old' },
      nailSurface: { marker: 'old' },
      skinAppearance: { marker: 'old' },
      hairState: { marker: 'old' },
      recipeFitReceipts: [{ receiptId: 'old-fit' }]
    })
    const next = {
      ...goon('Complete Revision', 2),
      recipe: { ...recipeOwner(2), activeRevision: documentRef('f') },
      appearanceDials: { marker: 'new' },
      facialArtwork: { marker: 'new' },
      eyeAppearance: { marker: 'new' },
      oralAppearance: { marker: 'new' },
      nailSurface: { marker: 'new' },
      skinAppearance: { marker: 'new' },
      hairState: { marker: 'new' },
      recipeFitReceipts: [{ receiptId: 'new-fit', status: 'stale' }],
      updated_at: '2026-07-17T00:00:01.000Z'
    } as unknown as GoonRecord

    const stored = await compareAndSwapRecipeState({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 1,
      nextGoon: next
    })

    expect(stored).toMatchObject({
      appearanceDials: { marker: 'new' },
      facialArtwork: { marker: 'new' },
      eyeAppearance: { marker: 'new' },
      oralAppearance: { marker: 'new' },
      nailSurface: { marker: 'new' },
      skinAppearance: { marker: 'new' },
      hairState: { marker: 'new' },
      recipeFitReceipts: [{ receiptId: 'new-fit', status: 'stale' }]
    })
  })

  it.runIf(REAL_REDIS_LANE)('preserves Anatomy Fit hashes through a nested RedisJSON round trip', async () => {
    const snapshot = await storageStableAnatomyFitSnapshot()
    const storedInput = {
      ...goon(),
      recipe: {
        ...recipeOwner(),
        authoringRevision: {
          ...recipeOwner().authoringRevision,
          state: snapshot
        }
      }
    } as GoonRecord

    await redis.json.set(`goon:${GOON_ID}`, '$', storedInput)
    const stored = await getOwnedRecipeGoon(USER_ID, GOON_ID)

    await expect(
      verifyRecipeStateSnapshot(stored.recipe!.authoringRevision.state)
    ).resolves.toEqual(snapshot)
  })

  it.runIf(REAL_REDIS_LANE)('preserves migration-plan proof hashes through RedisJSON', async () => {
    const document = await storageStableMigrationPlanDocument()
    const proof = (document.content.componentProofs as Array<{ errors: Record<string, number> }>)[0]
    expect(proof.errors.bakedPositionMaximumMeters).toBe(4.4703483581543e-8)
    expect(proof.errors.bakedPositionRmsMeters).toBe(3.32194615762578e-9)

    await putGoonRecipeDocument(document)

    await expect(
      getGoonRecipeDocument(USER_ID, GOON_ID, document.sha256)
    ).resolves.toEqual(document)
  })

  it.runIf(REAL_REDIS_LANE)('never replaces an existing immutable transaction record', async () => {
    await redis.json.set(`goon:${GOON_ID}`, '$', goon())
    const immutableKey = `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('c')}`
    await redis.json.set(immutableKey, '$', { contract: 'recipe-job-report/v1', marker: 'original' })
    const next = {
      ...goon('Stale Snapshot', 2),
      recipe: { ...recipeOwner(2), activeRevision: documentRef('f') },
      updated_at: '2026-07-17T00:00:01.000Z'
    }

    await expect(
      compareAndSwapRecipeState({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 1,
        nextGoon: next,
        records: [
          { key: immutableKey, value: { contract: 'recipe-job-report/v1', marker: 'replacement' } }
        ]
      })
    ).rejects.toMatchObject({ code: 'CORRUPT_RECORD', status: 500 })

    await expect(redis.json.get(immutableKey)).resolves.toEqual({
      contract: 'recipe-job-report/v1',
      marker: 'original'
    })
    const storedGoon = (await redis.json.get(`goon:${GOON_ID}`)) as GoonRecord
    expect(storedGoon.recipe).toMatchObject({ writeVersion: 1 })
  })

  it.runIf(REAL_REDIS_LANE)('atomically creates and advances a restart-safe Nail Surface job without shifting Redis arguments', async () => {
    await redis.json.set(`goon:${GOON_ID}`, '$', goon())
    const jobRecordKey =
      `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('f')}`
    const nextWithNails = {
      ...goonWithPendingJob(1, 2),
      nailSurface: { marker: 'v24-default' },
      skinAppearance: { marker: 'v29-default' }
    } as unknown as GoonRecord
    const created = await compareAndSwapRecipeJobState({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 1,
      expectedJobStateVersion: null,
      nextGoon: nextWithNails,
      nextJob: bakingJob(1, 2),
      records: [
        {
          key: jobRecordKey,
          value: { contract: 'recipe-job-report/v1', marker: 'nail-surface-v24' }
        }
      ]
    })
    expect(created).toMatchObject({
      recipe: { writeVersion: 2, liveStatus: 'building' },
      nailSurface: { marker: 'v24-default' },
      skinAppearance: { marker: 'v29-default' },
      updated_at: '2026-07-17T00:00:01.000Z'
    })
    const storedJob = await redis.json.get(`goon_recipe_job:${USER_ID}:${GOON_ID}:job-1`) as any
    expect(storedJob).toMatchObject({
      jobId: 'job-1',
      stateVersion: 1,
      status: 'baking'
    })
    expect(storedJob.cleanupAssets).toEqual([])
    await expect(redis.json.get(jobRecordKey)).resolves.toEqual({
      contract: 'recipe-job-report/v1',
      marker: 'nail-surface-v24'
    })
    expect((created.recipe as any).authoringRevision.state.appearanceDials.unlockedDialIds).toEqual([])
    expect((created.recipe as any).authoringRevision.state.siblings).toEqual([])

    const results = await Promise.allSettled([
      compareAndSwapRecipeJobState({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 2,
        expectedJobStateVersion: 1,
        nextGoon: goonWithPendingJob(2, 3),
        nextJob: bakingJob(2, 3)
      }),
      compareAndSwapRecipeJobState({
        userId: USER_ID,
        goonId: GOON_ID,
        expectedWriteVersion: 2,
        expectedJobStateVersion: 1,
        nextGoon: goonWithPendingJob(2, 3),
        nextJob: bakingJob(2, 3)
      })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it.runIf(REAL_REDIS_LANE)('atomically discards analysis only when pendingJob is JSON null', async () => {
    const planKey = `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('1')}`
    const receiptKey = `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('2')}`
    const analysisOwner = {
      ...recipeOwner(1),
      pendingAnalysis: {
        analysisId: 'analysis-1',
        analysisRef: {
          contract: 'recipe-update-analysis-context/v3',
          ref: `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('3')}`,
          sha256: sha('3')
        },
        basePlan: {
          contract: RECIPE_MIGRATION_PLAN_CONTRACT,
          ref: planKey,
          sha256: sha('1')
        },
        selectedPlan: {
          contract: RECIPE_MIGRATION_PLAN_CONTRACT,
          ref: planKey,
          sha256: sha('1')
        },
        migrationReport: {
          contract: RECIPE_MIGRATION_REPORT_CONTRACT,
          ref: `goon_recipe_document:${USER_ID}:${GOON_ID}:${sha('4')}`,
          sha256: sha('4')
        },
        containmentReceipt: {
          contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
          ref: receiptKey,
          sha256: sha('2')
        },
        reviewedState: null,
        targetWriteVersion: 1
      }
    }
    const analysisGoon = { ...goon(), recipe: analysisOwner }
    await redis.json.set(`goon:${GOON_ID}`, '$', analysisGoon)
    await redis.json.set(planKey, '$', { contract: RECIPE_MIGRATION_PLAN_CONTRACT })
    await redis.json.set(receiptKey, '$', { contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT })

    const discarded = await discardRecipeAnalysisRecords({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 1,
      analysisId: 'analysis-1',
      nextGoon: {
        ...analysisGoon,
        recipe: { ...analysisOwner, writeVersion: 2, pendingAnalysis: null },
        updated_at: '2026-07-17T00:00:01.000Z'
      },
      recordRefs: [planKey, receiptKey]
    })
    expect(discarded.recipe).toMatchObject({ writeVersion: 2, pendingAnalysis: null })
    await expect(redis.json.get(planKey)).resolves.toBeNull()
    await expect(redis.json.get(receiptKey)).resolves.toBeNull()

    await redis.json.set(`goon:${GOON_ID}`, '$', goonWithPendingJob(1, 2))
    await redis.json.set(planKey, '$', { contract: RECIPE_MIGRATION_PLAN_CONTRACT })
    await redis.json.set(receiptKey, '$', { contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT })
    await expect(discardRecipeAnalysisRecords({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 2,
      analysisId: 'analysis-1',
      nextGoon: {
        ...goonWithPendingJob(1, 2),
        recipe: { ...recipeOwner(3), writeVersion: 3, pendingAnalysis: null },
        updated_at: '2026-07-17T00:00:02.000Z'
      },
      recordRefs: [planKey, receiptKey]
    })).rejects.toMatchObject({ code: 'WRITE_CONFLICT', status: 409 })
    await expect(redis.json.get(planKey)).resolves.not.toBeNull()
    await expect(redis.json.get(receiptKey)).resolves.not.toBeNull()
  })
})
