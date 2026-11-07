import { json, type RequestHandler } from '@sveltejs/kit'
import {
  advanceRecipeJobStage,
  discardRecipeJob,
  failRecipeJob,
  readReadyRecipeJob,
  recoverInterruptedRecipeJob,
  renewActiveRecipeJobLease,
  retryRecipeJob
} from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

function noStore(response: Response) {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const readyMode = url.searchParams.has('mode')
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return readyMode ? noStore(owner) : owner
  if (!params.jobId) {
    const response = json({ error: 'Recipe job id is required' }, { status: 400 })
    return readyMode ? noStore(response) : response
  }
  if (readyMode && (url.searchParams.size !== 1 || url.searchParams.get('mode') !== 'ready-only')) {
    return noStore(json({ error: 'Invalid Recipe job read mode' }, { status: 400 }))
  }
  try {
    const input = {
      userId: owner.userId,
      goonId: owner.goonId,
      jobId: params.jobId
    }
    if (readyMode) return noStore(json(await readReadyRecipeJob(input)))
    return json(await recoverInterruptedRecipeJob(input))
  } catch (error) {
    const response = recipeRouteError(error)
    return readyMode ? noStore(response) : response
  }
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  if (!params.jobId) return json({ error: 'Recipe job id is required' }, { status: 400 })
  try {
    const body = await request.json()
    const input = {
      userId: owner.userId,
      goonId: owner.goonId,
      jobId: params.jobId,
      expectedWriteVersion: body.expectedWriteVersion,
      expectedJobStateVersion: body.expectedJobStateVersion
    }
    if (body.action === 'retry') return json(await retryRecipeJob(input))
    if (body.action === 'discard') return json(await discardRecipeJob(input))
    if (body.action === 'renew') return json(await renewActiveRecipeJobLease(input))
    if (body.action === 'advance') {
      return json(await advanceRecipeJobStage({ ...input, nextStatus: body.nextStatus }))
    }
    if (body.action === 'fail') {
      return json(await failRecipeJob({
        ...input,
        stage: body.stage,
        reason: body.reason,
        reportRef: body.reportRef ?? null
      }))
    }
    return json({ error: 'Recipe job action must be advance, fail, renew, retry, or discard' }, { status: 400 })
  } catch (error) {
    return recipeRouteError(error)
  }
}
