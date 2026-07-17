import { json, type RequestHandler } from '@sveltejs/kit'
import {
  advanceRecipeJobStage,
  discardRecipeJob,
  failRecipeJob,
  recoverInterruptedRecipeJob,
  retryRecipeJob
} from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const GET: RequestHandler = async ({ params, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  if (!params.jobId) return json({ error: 'Recipe job id is required' }, { status: 400 })
  try {
    return json(await recoverInterruptedRecipeJob({
      userId: owner.userId,
      goonId: owner.goonId,
      jobId: params.jobId
    }))
  } catch (error) {
    return recipeRouteError(error)
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
    return json({ error: 'Recipe job action must be advance, fail, retry, or discard' }, { status: 400 })
  } catch (error) {
    return recipeRouteError(error)
  }
}
