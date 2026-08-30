import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { startMemoryEmbedderPreparation } from '$lib/server/services/memory/memoryEmbedderPrepare'

/** SA-104 P5 — start (or join) embedding-model preparation; poll the status route. */
export const POST: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    return json(await startMemoryEmbedderPreparation())
  } catch (error) {
    console.error('[Memory Embedder] Failed to start preparation:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to start embedder preparation' },
      { status: 500 }
    )
  }
}
