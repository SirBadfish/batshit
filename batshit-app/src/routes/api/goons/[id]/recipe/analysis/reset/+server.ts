import { json, type RequestHandler } from '@sveltejs/kit'
import { selectRecipeCleanReset } from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    const body = await request.json()
    return json(await selectRecipeCleanReset({
      userId: owner.userId,
      goonId: owner.goonId,
      expectedWriteVersion: body.expectedWriteVersion,
      analysisId: body.analysisId,
      confirmed: body.confirmed
    }))
  } catch (error) {
    return recipeRouteError(error)
  }
}
