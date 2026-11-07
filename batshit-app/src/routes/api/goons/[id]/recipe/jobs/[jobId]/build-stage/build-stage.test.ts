import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({ buildAndStageRecipeCandidate: vi.fn() }))
vi.mock('$lib/server/services/goonRecipeLifecycleService.server', () => ({
  ...lifecycle,
  GoonRecipeLifecycleError: class GoonRecipeLifecycleError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message) }
  }
}))

import { POST } from './+server'
import { GoonRecipeLifecycleError } from '$lib/server/services/goonRecipeLifecycleService.server'
import { RECIPE_SERVER_BUILD_RESULT_CONTRACT } from '$lib/goons/recipe/recipeServerBuildResult'

function event(body: Record<string, unknown>, options: {
  userId?: string | null; goonId?: string; jobId?: string; signal?: AbortSignal
} = {}) {
  return {
    params: { id: options.goonId ?? 'goon-1', jobId: options.jobId ?? 'job-1' },
    locals: options.userId === null ? {} : { user: { id: options.userId ?? 'user-1' } },
    request: new Request('http://localhost/api/goons/goon-1/recipe/jobs/job-1/build-stage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: options.signal
    })
  } as any
}

describe('server-owned Recipe build-stage route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lifecycle.buildAndStageRecipeCandidate.mockResolvedValue({ staged: true })
  })

  it('requires a signed-in owner and a job id before starting construction', async () => {
    expect((await POST(event({}, { userId: null }))).status).toBe(401)
    expect((await POST(event({}, { jobId: '' }))).status).toBe(400)
    expect(lifecycle.buildAndStageRecipeCandidate).not.toHaveBeenCalled()
  })

  it('passes only owned identity, optimistic versions and cancellation signal', async () => {
    const abort = new AbortController()
    const e = event({
      expectedWriteVersion: 7, expectedJobStateVersion: 3,
      userId: 'forged-user', goonId: 'forged-goon', jobId: 'forged-job',
      live: { forged: true }, liveBuildReceipt: { forged: true },
      packageBytes: [1, 2, 3], trustedSuccess: true
    }, { signal: abort.signal })
    const unlink = vi.spyOn(e.request.signal, 'removeEventListener')
    const response = await POST(e)
    expect(response.status).toBe(200)
    expect(lifecycle.buildAndStageRecipeCandidate).toHaveBeenCalledOnce()
    const input = lifecycle.buildAndStageRecipeCandidate.mock.calls[0]![0]
    expect(input).toEqual({
      userId: 'user-1', goonId: 'goon-1', jobId: 'job-1',
      expectedWriteVersion: 7, expectedJobStateVersion: 3,
      signal: expect.any(AbortSignal)
    })
    await expect(response.json()).resolves.toEqual({
      contract: RECIPE_SERVER_BUILD_RESULT_CONTRACT, kind: 'success', staged: { staged: true }
    })
    expect(unlink).toHaveBeenCalledWith('abort', expect.any(Function))
    abort.abort()
    expect(input.signal.aborted).toBe(false)
  })

  it('preserves a version refusal inside the streamed error envelope', async () => {
    lifecycle.buildAndStageRecipeCandidate.mockRejectedValueOnce(
      new GoonRecipeLifecycleError('WRITE_CONFLICT', 'The Recipe changed.', 409)
    )
    const response = await POST(event({ expectedWriteVersion: -1, expectedJobStateVersion: 1,
      live: { forged: true } }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      contract: RECIPE_SERVER_BUILD_RESULT_CONTRACT, kind: 'error', status: 409,
      error: 'The Recipe changed.', code: 'WRITE_CONFLICT'
    })
  })

  it('aborts a pending build when the response reader is canceled and unlinks the request listener', async () => {
    let settle!: (value: unknown) => void
    lifecycle.buildAndStageRecipeCandidate.mockImplementationOnce(() =>
      new Promise(resolve => { settle = resolve }))
    const e = event({ expectedWriteVersion: 7, expectedJobStateVersion: 3 })
    const unlink = vi.spyOn(e.request.signal, 'removeEventListener')
    const response = await POST(e)
    const input = lifecycle.buildAndStageRecipeCandidate.mock.calls[0]![0]
    expect(input.signal.aborted).toBe(false)
    await response.body!.getReader().cancel()
    expect(input.signal.aborted).toBe(true)
    expect(unlink).toHaveBeenCalledWith('abort', expect.any(Function))
    settle({ staged: true })
    await vi.waitFor(() => expect(unlink).toHaveBeenCalled())
  })

  it('aborts a pending build on incoming request abort and unlinks after its error settles', async () => {
    lifecycle.buildAndStageRecipeCandidate.mockImplementationOnce(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }))
    const abort = new AbortController()
    const e = event({ expectedWriteVersion: 7, expectedJobStateVersion: 3 }, { signal: abort.signal })
    const unlink = vi.spyOn(e.request.signal, 'removeEventListener')
    const response = await POST(e)
    const input = lifecycle.buildAndStageRecipeCandidate.mock.calls[0]![0]
    abort.abort()
    expect(input.signal.aborted).toBe(true)
    await expect(response.json()).resolves.toMatchObject({
      contract: RECIPE_SERVER_BUILD_RESULT_CONTRACT, kind: 'error'
    })
    expect(unlink).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
