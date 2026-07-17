import { json, type RequestHandler } from '@sveltejs/kit'
import { analyzeRecipePackageUpdate } from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    const body = await request.json()
    const analysis = await analyzeRecipePackageUpdate({
      userId: owner.userId,
      goonId: owner.goonId,
      receipt: body.receipt,
      siblingInputs: body.siblingInputs,
      ...(body.componentMapBundle ? { componentMapBundle: body.componentMapBundle } : {})
    })
    return json(analysis)
  } catch (error) {
    return recipeRouteError(error)
  }
}
