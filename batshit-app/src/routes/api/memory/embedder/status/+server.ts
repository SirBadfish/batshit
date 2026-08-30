import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { getMemoryEmbedderPreparationStatus } from '$lib/server/services/memory/memoryEmbedderPrepare'

/** SA-104 P5 — poll target for the enable flow's visible download progress. */
export const GET: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  return json(getMemoryEmbedderPreparationStatus())
}
