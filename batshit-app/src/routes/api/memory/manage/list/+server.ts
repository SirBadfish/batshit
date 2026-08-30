import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  listManagedMemories,
  MemoryManageError
} from '$lib/server/services/memory/memoryManage'

/** SA-104 P5 — Memory Panel browse (summaries only, ownership-gated). */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const limitParam = url.searchParams.get('limit')
    const result = await listManagedMemories(
      { userId: user.value.id, agentId: url.searchParams.get('agentId') ?? '' },
      {
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
    console.error('[Memory Manage] List failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to list memories' },
      { status: 500 }
    )
  }
}
