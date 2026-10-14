import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRequest, setResponse } from '@sveltejs/kit/node'
import { RECIPE_ROLLBACK_PREVIEW_RESULT_CONTRACT } from '$lib/goons/recipe/recipeRollbackPreviewResult'

const lifecycle = vi.hoisted(() => ({
  analyzeRecipePackageUpdate: vi.fn(),
  bootstrapRecipeV2: vi.fn(),
  discardRecipePackageAnalysis: vi.fn(),
  getRecipePackageAnalysis: vi.fn(),
  getPreviousRecipeRevisionPreview: vi.fn(),
  resetRetiredHairRecipeState: vi.fn(),
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
  GoonRecipeLifecycleError: class GoonRecipeLifecycleError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message)
    }
  }
}))

import { POST as bootstrapRecipe } from './bootstrap/+server'
import { POST as analyzeUpdate } from './analyze/+server'
import { DELETE as discardAnalysis, GET as getAnalysis } from './analysis/+server'
import { POST as resetAnalysis } from './analysis/reset/+server'
import { POST as reviewState } from './analysis/review-state/+server'
import { POST as startBake } from './bake/start/+server'
import { POST as startPackageUpdate } from './start/+server'
import { POST as resetRetiredHair } from './recover-retired-hair/+server'
import { POST as registerCandidateAssets } from './jobs/[jobId]/candidate-assets/+server'
import { POST as stageCandidate } from './jobs/[jobId]/stage/+server'
import { GET as previewRollback } from './rollback/+server'
import { GoonRecipeLifecycleError } from '$lib/server/services/goonRecipeLifecycleService.server'

const USER_ID = 'user-route-1'
const GOON_ID = 'goon-route-1'
const JOB_ID = 'job-route-1'

function event(
  body?: Record<string, unknown>,
  options: { method?: string; authenticated?: boolean; jobId?: string; signal?: AbortSignal } = {}
) {
  const method = options.method ?? 'POST'
  return {
    params: { id: GOON_ID, jobId: options.jobId },
    locals: options.authenticated === false ? {} : { user: { id: USER_ID } },
    request: new Request(`http://localhost/api/goons/${GOON_ID}/recipe`, {
      method,
      signal: options.signal,
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

  it('analyzes an ordinary file upload without a client map and preserves present invalid maps for server rejection', async () => {
    const receipt = { contract: 'recipe-archive-containment-receipt/v1' }
    const siblingInputs = { facialArtwork: null, eyeAppearance: null, oralAppearance: null }
    await analyzeUpdate(event({ receipt, siblingInputs, componentMapBundles: ['must-not-cross-lanes'] }))
    expect(lifecycle.analyzeRecipePackageUpdate).toHaveBeenLastCalledWith({
      userId: USER_ID, goonId: GOON_ID, receipt, siblingInputs
    })
    await analyzeUpdate(event({ receipt, siblingInputs, componentMapBundle: null }))
    expect(lifecycle.analyzeRecipePackageUpdate).toHaveBeenLastCalledWith({
      userId: USER_ID, goonId: GOON_ID, receipt, siblingInputs, componentMapBundle: null
    })
  })

  it('loads rollback preview evidence without mutating the previous revision', async () => {
    const cancel = new AbortController()
    const requestEvent = event(undefined, { method: 'GET', signal: cancel.signal })
    const response = await previewRollback(requestEvent)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      contract: RECIPE_ROLLBACK_PREVIEW_RESULT_CONTRACT,
      kind: 'success',
      preview: { ok: true }
    })
    expect(lifecycle.getPreviousRecipeRevisionPreview).toHaveBeenCalledOnce()
    expect(lifecycle.getPreviousRecipeRevisionPreview.mock.calls[0]?.[0]).toMatchObject({
      userId: USER_ID,
      goonId: GOON_ID
    })
    expect(lifecycle.getPreviousRecipeRevisionPreview.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
    cancel.abort()
    expect(requestEvent.request.signal.aborted).toBe(true)
  })

  it('returns a versioned error result with the original verification status and code', async () => {
    lifecycle.getPreviousRecipeRevisionPreview.mockRejectedValueOnce(
      new GoonRecipeLifecycleError('CORRUPT_REVISION', 'The previous Recipe revision is invalid.', 409)
    )
    const response = await previewRollback(event(undefined, { method: 'GET' }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      contract: RECIPE_ROLLBACK_PREVIEW_RESULT_CONTRACT,
      kind: 'error',
      status: 409,
      error: 'The previous Recipe revision is invalid.',
      code: 'CORRUPT_REVISION'
    })
  })

  it('keeps rollback preview authentication failures as real HTTP errors', async () => {
    const response = await previewRollback(event(undefined, { method: 'GET', authenticated: false }))

    expect(response.status).toBe(401)
    expect(lifecycle.getPreviousRecipeRevisionPreview).not.toHaveBeenCalled()
  })

  it('aborts pending replay on Node response close after the GET request has ended', async () => {
    let entered!: () => void
    const replayEntered = new Promise<void>(resolve => { entered = resolve })
    let stopped!: () => void
    const replayStopped = new Promise<void>(resolve => { stopped = resolve })
    let serverRequestSignal: AbortSignal | null = null
    lifecycle.getPreviousRecipeRevisionPreview.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      entered()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          stopped()
          reject(signal.reason)
        }, { once: true })
      })
    })

    const server = createServer((incoming, outgoing) => {
      void (async () => {
        const request = await getRequest({ request: incoming, base: 'http://127.0.0.1' })
        const requestEnded = new Promise<void>(resolve => incoming.once('end', resolve))
        incoming.resume()
        await requestEnded
        serverRequestSignal = request.signal
        const response = await previewRollback({
          params: { id: GOON_ID },
          locals: { user: { id: USER_ID } },
          request
        } as any)
        await setResponse(outgoing, response)
      })().catch(error => outgoing.destroy(error))
    })
    const waitBounded = async (pending: Promise<void>, message: string) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        await Promise.race([
          pending,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(message)), 1500)
          })
        ])
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }
    let browserAbort: AbortController | null = null
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      browserAbort = new AbortController()
      const request = fetch(`http://127.0.0.1:${port}/api/goons/${GOON_ID}/recipe/rollback`, {
        signal: browserAbort.signal
      }).catch(error => error)
      await waitBounded(replayEntered, 'The rollback route did not start replay.')
      expect(serverRequestSignal?.aborted).toBe(false)
      browserAbort.abort()
      await waitBounded(replayStopped, 'Response close did not cancel replay.')
      expect(serverRequestSignal?.aborted).toBe(false)
      await request
    } finally {
      browserAbort?.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 3000)

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

  it('keeps retired Hair recovery server-owned and revision-guarded', async () => {
    const response = await resetRetiredHair(event({
      expectedWriteVersion: 7,
      replacementHairState: { forged: true },
      appearanceDials: { forged: true }
    }))

    expect(response.status).toBe(200)
    expect(lifecycle.resetRetiredHairRecipeState).toHaveBeenCalledWith({
      userId: USER_ID,
      goonId: GOON_ID,
      expectedWriteVersion: 7
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
    const stageEvent = event({
      expectedWriteVersion: 11,
      expectedJobStateVersion: 2,
      liveBuildReceipt: receipt,
      live,
      state: { forged: true },
      migrationReport: { forged: true }
    }, { jobId: JOB_ID })
    const stageResponse = await stageCandidate(stageEvent)

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
      live,
      signal: stageEvent.request.signal
    })
  })
})
