import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { rebuildMemoryIndexes } from '$lib/server/services/memory/memoryIndex'

/**
 * SA-104 P5 — the EXPLICIT re-index path (DL-104-10). With reembed, every stored
 * memory/segment is re-embedded through the configured model (required after a model
 * change); without it, stored vectors are kept and the indexes rebuild from records
 * (index-loss recovery — refused across a model change by the service).
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: { reembed?: boolean }
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  try {
    const result = await rebuildMemoryIndexes({
      reembed: body.reembed !== false,
      userId: user.value.id
    })
    return json(result)
  } catch (error) {
    console.error('[Memory Reindex] Failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Memory re-index failed' },
      { status: 500 }
    )
  }
}
