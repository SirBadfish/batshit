import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  getManagedAwareness,
  MemoryManageError
} from '$lib/server/services/memory/memoryManage'

/**
 * SA-104 — the agent-authored Awareness section, in exactly the compile order
 * the recall engine uses. DL-104-16: nothing the agent stores is hidden in v1.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const result = await getManagedAwareness({
      userId: user.value.id,
      agentId: url.searchParams.get('agentId') ?? ''
    })
    return json(result)
  } catch (error) {
    if (error instanceof MemoryManageError) {
      return json({ error: error.message }, { status: error.status })
    }
    console.error('[Memory Manage] Awareness failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to load Awareness entries' },
      { status: 500 }
    )
  }
}
