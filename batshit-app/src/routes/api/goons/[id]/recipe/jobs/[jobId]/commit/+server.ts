import { json, type RequestHandler } from '@sveltejs/kit'
import { commitRecipeUpdate } from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  if (!params.jobId) return json({ error: 'Recipe job id is required' }, { status: 400 })
  try {
    const body = await request.json()
    return json(await commitRecipeUpdate({
      userId: owner.userId,
      goonId: owner.goonId,
      jobId: params.jobId,
      expectedWriteVersion: body.expectedWriteVersion,
      expectedJobStateVersion: body.expectedJobStateVersion
    }))
  } catch (error) {
    return recipeRouteError(error)
  }
}
