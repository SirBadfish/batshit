import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  MemoryManageError,
  searchManagedMemories
} from '$lib/server/services/memory/memoryManage'

/** SA-104 P5 — Memory Panel hybrid search (summaries only, ownership-gated). */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const limitParam = url.searchParams.get('limit')
    const result = await searchManagedMemories(
      { userId: user.value.id, agentId: url.searchParams.get('agentId') ?? '' },
      {
        query: url.searchParams.get('query') ?? '',
        lane: url.searchParams.get('lane') ?? undefined,
        includeSuperseded: url.searchParams.get('includeSuperseded') !== 'false',
        limit: limitParam ? Number(limitParam) : undefined,
        savedFrom: url.searchParams.get('savedFrom') ?? undefined,
        savedTo: url.searchParams.get('savedTo') ?? undefined
      }
    )
    return json(result)
  } catch (error) {
    if (error instanceof MemoryManageError) {
      return json({ error: error.message }, { status: error.status })
    }
    console.error('[Memory Manage] Search failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Memory search failed' },
      { status: 500 }
    )
  }
}
