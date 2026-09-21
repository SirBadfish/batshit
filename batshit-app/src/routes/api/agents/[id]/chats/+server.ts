import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { selectAgentChatsForUser } from '$lib/server/services/agentChatDeletion'

/**
 * GET /api/agents/[id]/chats — what "Also delete its chats" would delete (2026-09-19). The
 * delete dialog shows these counts; the delete itself uses the same selection, so the number
 * the user reads is the number that goes. Group chats are never counted.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  const agent = await redis.get(`agent:${params.id}`)
  if (!agent) {
    return json({ error: 'Agent not found' }, { status: 404 })
  }
  if (agent.user_id !== locals.user.id) {
    return json({ error: 'Unauthorized' }, { status: 403 })
  }
  try {
    const selection = await selectAgentChatsForUser(locals.user.id, params.id!)
    return json({
      deletable: selection.deletable.length,
      infinite: selection.deletable.filter((chat) => chat.fixed).length,
      keptLocked: selection.keptLocked.length
    })
  } catch (error) {
    console.error('[Agents API] Failed to count agent chats:', error)
    return json({ error: 'Failed to count chats' }, { status: 500 })
  }
}
