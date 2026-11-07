import { json, type RequestHandler } from '@sveltejs/kit'
import { buildAndStageRecipeCandidate } from '$lib/server/services/goonRecipeLifecycleService.server'
import { RECIPE_SERVER_BUILD_RESULT_CONTRACT } from '$lib/goons/recipe/recipeServerBuildResult'
import { authenticatedRecipeOwner, recipeRouteError } from '$lib/server/services/goonRecipeRoute.server'

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const owner = authenticatedRecipeOwner(locals.user?.id, params.id)
  if (owner instanceof Response) return owner
  if (!params.jobId) return json({ error: 'Recipe job id is required' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await request.json() } catch (error) {
    return recipeRouteError(error)
  }
  // The adapter has consumed the POST body before construction begins. Own
  // disconnect cancellation through the response reader, as rollback preview does.
  const abort = new AbortController()
  const onRequestAbort = () => abort.abort(request.signal.reason)
  request.signal.addEventListener('abort', onRequestAbort, { once: true })
  if (request.signal.aborted) onRequestAbort()
  const unlink = () => request.signal.removeEventListener('abort', onRequestAbort)
  const encoder = new TextEncoder()
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const staged = await buildAndStageRecipeCandidate({
            ...owner, jobId: params.jobId!,
            expectedWriteVersion: body.expectedWriteVersion as number,
            expectedJobStateVersion: body.expectedJobStateVersion as number,
            signal: abort.signal
          })
          if (!canceled) controller.enqueue(encoder.encode(JSON.stringify({
            contract: RECIPE_SERVER_BUILD_RESULT_CONTRACT, kind: 'success', staged
          })))
        } catch (error) {
          const failed = recipeRouteError(error)
          const result = await failed.json() as { error: string; code?: string }
          if (!canceled) controller.enqueue(encoder.encode(JSON.stringify({
            contract: RECIPE_SERVER_BUILD_RESULT_CONTRACT, kind: 'error',
            status: failed.status, error: result.error, code: result.code ?? null
          })))
        } finally {
          unlink()
          if (!canceled) controller.close()
        }
      })()
    },
    cancel() {
      canceled = true
      abort.abort(new DOMException('The Goon build was canceled.', 'AbortError'))
      unlink()
    }
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  })
}
