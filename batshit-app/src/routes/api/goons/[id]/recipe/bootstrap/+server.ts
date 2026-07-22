import { json, type RequestHandler } from '@sveltejs/kit'
import { bootstrapRecipeV2 } from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    const body = await request.json()
    return json(await bootstrapRecipeV2({
      userId: owner.userId,
      goonId: owner.goonId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      receipt: body.receipt,
      state: body.state
    }))
  } catch (error) {
    return recipeRouteError(error)
  }
}
