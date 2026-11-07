import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { emptyDeletedManagedMemories, listDeletedManagedMemories, restoreManagedMemory, MemoryManageError } from '$lib/server/services/memory/memoryManage'
import { MemoryMutationError } from '$lib/server/services/memory/memoryMutation'

function failure(error: unknown) {
  const status = error instanceof MemoryManageError || error instanceof MemoryMutationError ? error.status : 500
  return json({ error: error instanceof Error ? error.message : 'Deleted Memories could not be updated.', ...(error instanceof MemoryMutationError ? { code: error.code } : {}) }, { status })
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try { return json(await listDeletedManagedMemories({ userId: user.value.id, agentId: url.searchParams.get('agentId') ?? '' })) }
  catch (error) { return failure(error) }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const body = await request.json()
    if (typeof body?.agentId !== 'string' || typeof body?.memoryId !== 'string') return json({ error: 'agentId and memoryId are required.' }, { status: 400 })
    return json(await restoreManagedMemory({ userId: user.value.id, agentId: body.agentId }, body.memoryId))
  } catch (error) { return failure(error) }
}

export const DELETE: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try { return json(await emptyDeletedManagedMemories({ userId: user.value.id, agentId: url.searchParams.get('agentId') ?? '' })) }
  catch (error) { return failure(error) }
}
