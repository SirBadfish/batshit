import { json, type RequestHandler } from '@sveltejs/kit'
import { startRecipePackageUpdate } from '$lib/server/services/goonRecipeLifecycleService.server'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    const body = await request.json()
    const result = await startRecipePackageUpdate({
      userId: owner.userId,
      goonId: owner.goonId,
      expectedWriteVersion: body.expectedWriteVersion,
      idempotencyKey: body.idempotencyKey,
      planRef: body.planRef,
      containmentReceipt: body.containmentReceipt
    })
    return json(result)
  } catch (error) {
    return recipeRouteError(error)
  }
}
