import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  listManagedSegments,
  MemoryManageError
} from '$lib/server/services/memory/memoryManage'

/**
 * Graduated History browser (2026-08-26): the summarized old-chat segments an
 * agent's episodes and idle chats graduated into. Read-only in v1; ownership-gated.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const limitParam = url.searchParams.get('limit')
    const result = await listManagedSegments(
      {
        userId: user.value.id,
        agentId: url.searchParams.get('agentId') ?? ''
      },
      {
        query: url.searchParams.get('query') ?? undefined,
        limit: limitParam ? Number.parseInt(limitParam, 10) : undefined
      }
    )
    return json(result)
  } catch (error) {
    if (error instanceof MemoryManageError) {
      return json({ error: error.message }, { status: error.status })
    }
    console.error('[Memory Manage] Segments failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load graduated history' },
      { status: 500 }
    )
  }
}
