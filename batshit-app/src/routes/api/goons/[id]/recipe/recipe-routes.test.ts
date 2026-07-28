import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  bootstrapRecipeV2: vi.fn(),
  discardRecipePackageAnalysis: vi.fn(),
  getRecipePackageAnalysis: vi.fn(),
  getPreviousRecipeRevisionPreview: vi.fn(),
  restorePreviousRecipeRevision: vi.fn(),
  selectRecipeCleanReset: vi.fn(),
  reviewRecipePackageState: vi.fn(),
  startRecipeBake: vi.fn(),
  startRecipePackageUpdate: vi.fn(),
  registerRecipeCandidateAssets: vi.fn(),
  stageRecipeUpdateCandidate: vi.fn()
}))

vi.mock('$lib/server/services/goonRecipeLifecycleService.server', () => ({
  ...lifecycle,
  GoonRecipeLifecycleError: class GoonRecipeLifecycleError extends Error {}
}))

import { POST as bootstrapRecipe } from './bootstrap/+server'
import { DELETE as discardAnalysis, GET as getAnalysis } from './analysis/+server'
import { POST as resetAnalysis } from './analysis/reset/+server'
import { POST as reviewState } from './analysis/review-state/+server'
import { POST as startBake } from './bake/start/+server'
import { POST as startPackageUpdate } from './start/+server'
import { POST as registerCandidateAssets } from './jobs/[jobId]/candidate-assets/+server'
import { POST as stageCandidate } from './jobs/[jobId]/stage/+server'
import { GET as previewRollback } from './rollback/+server'

const USER_ID = 'user-route-1'
const GOON_ID = 'goon-route-1'
const JOB_ID = 'job-route-1'

function event(
  body?: Record<string, unknown>,
  options: { method?: string; authenticated?: boolean; jobId?: string } = {}
) {
  const method = options.method ?? 'POST'
  return {
    params: { id: GOON_ID, jobId: options.jobId },
    locals: options.authenticated === false ? {} : { user: { id: USER_ID } },
    request: new Request(`http://localhost/api/goons/${GOON_ID}/recipe`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    })
  } as any
}

describe('Recipe lifecycle routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const handler of Object.values(lifecycle)) {
      handler.mockResolvedValue({ ok: true })
    }
  })

  it('requires an authenticated owner before any lifecycle operation', async () => {
    const response = await bootstrapRecipe(event({}, { authenticated: false }))

    expect(response.status).toBe(401)
    expect(lifecycle.bootstrapRecipeV2).not.toHaveBeenCalled()
  })

  it('loads rollback preview evidence without mutating the previous revision', async () => {
    const response = await previewRollback(event(undefined, { method: 'GET' }))

    expect(response.status).toBe(200)
    expect(lifecycle.getPreviousRecipeRevisionPreview).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID
    })
  })

  it('forwards bootstrap evidence without accepting client lifecycle fields', async () => {
    const receipt = { contract: 'recipe-archive-containment-receipt/v1' }
    const state = { contract: 'appearance-recipe-state/v1' }
    const response = await bootstrapRecipe(event({
      expectedUpdatedAt: '2026-07-17T10:00:00.000Z',
      receipt,
      state,
      liveStatus: 'up_to_date',
      activeRevision: 99
    }))

    expect(response.status).toBe(200)
    expect(lifecycle.bootstrapRecipeV2).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedUpdatedAt: '2026-07-17T10:00:00.000Z',
      receipt,
      state
    })
  })

  it('keeps analysis hydration, reset, review, and discard server-owned', async () => {
    const state = { contract: 'appearance-recipe-state/v1' }
    const getResponse = await getAnalysis(event(undefined, { method: 'GET' }))
    const resetResponse = await resetAnalysis(event({
      expectedWriteVersion: 4,
      analysisId: 'analysis-1',
      confirmed: true
    }))
    const reviewResponse = await reviewState(event({
      expectedWriteVersion: 5,
      analysisId: 'analysis-1',
      state,
      confirmedControlIds: ['control-b', 'control-a'],
      cleanResetConfirmed: true
    }))
    const discardResponse = await discardAnalysis(event({
      expectedWriteVersion: 6,
      analysisId: 'analysis-1',
      confirmed: true
    }, { method: 'DELETE' }))

    expect([getResponse.status, resetResponse.status, reviewResponse.status, discardResponse.status])
      .toEqual([200, 200, 200, 200])
    expect(lifecycle.getRecipePackageAnalysis).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID
    })
    expect(lifecycle.selectRecipeCleanReset).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 4,
      analysisId: 'analysis-1',
      confirmed: true
    })
    expect(lifecycle.reviewRecipePackageState).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 5,
      analysisId: 'analysis-1',
      state,
      confirmedControlIds: ['control-b', 'control-a'],
      cleanResetConfirmed: true
    })
    expect(lifecycle.discardRecipePackageAnalysis).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 6,
      analysisId: 'analysis-1',
      confirmed: true
    })
  })

  it('uses separate ordinary-bake and package-update start contracts', async () => {
    const state = { contract: 'appearance-recipe-state/v1' }
    const bakeResponse = await startBake(event({
      expectedWriteVersion: 2,
      idempotencyKey: 'bake-idempotency',
      state,
      analysisId: 'must-not-cross-lanes'
    }))
    const updateResponse = await startPackageUpdate(event({
      expectedWriteVersion: 8,
      idempotencyKey: 'update-idempotency',
      analysisId: 'analysis-1',
      state: { forged: true }
    }))

    expect([bakeResponse.status, updateResponse.status]).toEqual([200, 200])
    expect(lifecycle.startRecipeBake).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 2,
      idempotencyKey: 'bake-idempotency',
      state
    })
    expect(lifecycle.startRecipePackageUpdate).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 8,
      idempotencyKey: 'update-idempotency',
      analysisId: 'analysis-1'
    })
  })

  it('registers uploaded candidates before Stage and never accepts browser state or reports', async () => {
    const live = { model: { ref: '/uploads/live.glb' } }
    const receipt = { contract: 'recipe-live-build-receipt/v1' }
    const candidateResponse = await registerCandidateAssets(event({
      expectedWriteVersion: 10,
      expectedJobStateVersion: 1,
      live
    }, { jobId: JOB_ID }))
    const stageResponse = await stageCandidate(event({
      expectedWriteVersion: 11,
      expectedJobStateVersion: 2,
      liveBuildReceipt: receipt,
      live,
      state: { forged: true },
      migrationReport: { forged: true }
    }, { jobId: JOB_ID }))

    expect([candidateResponse.status, stageResponse.status]).toEqual([200, 200])
    expect(lifecycle.registerRecipeCandidateAssets).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      jobId: JOB_ID,
      expectedWriteVersion: 10,
      expectedJobStateVersion: 1,
      live
    })
    expect(lifecycle.stageRecipeUpdateCandidate).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      jobId: JOB_ID,
      expectedWriteVersion: 11,
      expectedJobStateVersion: 2,
      liveBuildReceipt: receipt,
      live
    })
  })
})
