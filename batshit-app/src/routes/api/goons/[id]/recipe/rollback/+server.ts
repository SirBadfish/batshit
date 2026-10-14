import { json, type RequestHandler } from '@sveltejs/kit'
import {
  getPreviousRecipeRevisionPreview,
  restorePreviousRecipeRevision
} from '$lib/server/services/goonRecipeLifecycleService.server'
import { RECIPE_ROLLBACK_PREVIEW_RESULT_CONTRACT } from '$lib/goons/recipe/recipeRollbackPreviewResult'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const GET: RequestHandler = async ({ params, locals, request }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner

  // The Node adapter can finish reading a GET before the browser disconnects,
  // so request.signal alone does not own the long verification. Its response
  // reader is canceled on socket close; that cancellation owns this controller.
  const abort = new AbortController()
  const onRequestAbort = () => abort.abort(request.signal.reason)
  request.signal.addEventListener('abort', onRequestAbort, { once: true })
  if (request.signal.aborted) onRequestAbort()
  const unlinkRequest = () => request.signal.removeEventListener('abort', onRequestAbort)
  const encoder = new TextEncoder()
  let streamCancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const preview = await getPreviousRecipeRevisionPreview({ ...owner, signal: abort.signal })
          if (!streamCancelled) {
            controller.enqueue(encoder.encode(JSON.stringify({
              contract: RECIPE_ROLLBACK_PREVIEW_RESULT_CONTRACT,
              kind: 'success',
              preview
            })))
          }
        } catch (error) {
          const failed = recipeRouteError(error)
          const result = await failed.json() as { error: string; code?: string }
          if (!streamCancelled) {
            controller.enqueue(encoder.encode(JSON.stringify({
              contract: RECIPE_ROLLBACK_PREVIEW_RESULT_CONTRACT,
              kind: 'error',
              status: failed.status,
              error: result.error,
              code: result.code ?? null
            })))
          }
        } finally {
          unlinkRequest()
          if (!streamCancelled) controller.close()
        }
      })()
    },
    cancel() {
      streamCancelled = true
      abort.abort(new DOMException('The rollback preview was canceled.', 'AbortError'))
      unlinkRequest()
    }
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  try {
    const body = await request.json()
    return json(await restorePreviousRecipeRevision({
      userId: owner.userId,
      goonId: owner.goonId,
      expectedWriteVersion: body.expectedWriteVersion
    }))
  } catch (error) {
    return recipeRouteError(error)
  }
}
