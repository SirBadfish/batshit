import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  deleteManagedMemory,
  getManagedMemoryDetail,
  MemoryManageError,
  updateManagedMemory
} from '$lib/server/services/memory/memoryManage'

function handleError(error: unknown, action: string): Response {
  if (error instanceof MemoryManageError) {
    return json({ error: error.message }, { status: error.status })
  }
  console.error(`[Memory Manage] ${action} failed:`, error)
  return json(
    { error: error instanceof Error ? error.message : `Memory ${action} failed` },
    { status: 500 }
  )
}

/** SA-104 P5 — full record + supersession chain for the Memory Panel detail lane. */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const detail = await getManagedMemoryDetail(
      { userId: user.value.id, agentId: url.searchParams.get('agentId') ?? '' },
      url.searchParams.get('memoryId') ?? ''
    )
    return json(detail)
  } catch (error) {
    return handleError(error, 'detail')
  }
}

/** User edits: content/gist/triggers/importance/event/expiry/lane/links/clips. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: Record<string, any>
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const record = await updateManagedMemory(
      { userId: user.value.id, agentId: typeof body.agentId === 'string' ? body.agentId : '' },
      typeof body.memoryId === 'string' ? body.memoryId : '',
      body.updates && typeof body.updates === 'object' ? body.updates : {}
    )
    return json({ record })
  } catch (error) {
    return handleError(error, 'update')
  }
}

/** Delete with confirmation happens in the panel; this is the explicit delete. */
export const DELETE: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const result = await deleteManagedMemory(
      { userId: user.value.id, agentId: url.searchParams.get('agentId') ?? '' },
      url.searchParams.get('memoryId') ?? ''
    )
    return json(result)
  } catch (error) {
    return handleError(error, 'delete')
  }
}
