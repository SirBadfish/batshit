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
  RECIPE_SOURCE_CONTRACT,
  createGoonRecipeDocument
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
    activeRevision: documentRef('e'),
    previousRevision: null,
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

  it.runIf(REAL_REDIS_LANE)('atomically creates and advances a restart-safe job without changing empty arrays', async () => {
    await redis.json.set(`goon:${GOON_ID}`, '$', goon())
    const created = await compareAndSwapRecipeJobState({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 1,
      expectedJobStateVersion: null,
      nextGoon: goonWithPendingJob(1, 2),
      nextJob: bakingJob(1, 2)
    })
    expect(created.recipe).toMatchObject({ writeVersion: 2, liveStatus: 'building' })
    const storedJob = await redis.json.get(`goon_recipe_job:${USER_ID}:${GOON_ID}:job-1`) as any
    expect(storedJob.cleanupAssets).toEqual([])
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
    await redis.json.set(`goon:${GOON_ID}`, '$', goon())
    await redis.json.set(planKey, '$', { contract: RECIPE_MIGRATION_PLAN_CONTRACT })
    await redis.json.set(receiptKey, '$', { contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT })

    await expect(discardRecipeAnalysisRecords({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 1,
      planRef: planKey,
      containmentReceiptRef: receiptKey
    })).resolves.toBeUndefined()
    await expect(redis.json.get(planKey)).resolves.toBeNull()
    await expect(redis.json.get(receiptKey)).resolves.toBeNull()

    await redis.json.set(`goon:${GOON_ID}`, '$', goonWithPendingJob(1, 2))
    await redis.json.set(planKey, '$', { contract: RECIPE_MIGRATION_PLAN_CONTRACT })
    await redis.json.set(receiptKey, '$', { contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT })
    await expect(discardRecipeAnalysisRecords({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 2,
      planRef: planKey,
      containmentReceiptRef: receiptKey
    })).rejects.toMatchObject({ code: 'WRITE_CONFLICT', status: 409 })
    await expect(redis.json.get(planKey)).resolves.not.toBeNull()
    await expect(redis.json.get(receiptKey)).resolves.not.toBeNull()
  })
})
