import { json, type RequestHandler } from '@sveltejs/kit'
import { discardRecipePackageAnalysis } from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    const body = await request.json()
    return json(await discardRecipePackageAnalysis({
      userId: owner.userId,
      goonId: owner.goonId,
      expectedWriteVersion: body.expectedWriteVersion,
      planRef: body.planRef,
      containmentReceipt: body.containmentReceipt
    }))
  } catch (error) {
    return recipeRouteError(error)
  }
}
