import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { readAgentWhiteboard } from '$lib/server/services/whiteboard'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { resolveApiReasoningRetention } from '$lib/utils/reasoningRetention'

export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  const sessionId = params.id!
  const agentId = url.searchParams.get('agentId')?.trim()
  if (!agentId) return json({ error: 'agentId is required.' }, { status: 400 })
  try {
    const [session, agent] = await Promise.all([
      redis.json.get(`session:${sessionId}`), redis.json.get(`agent:${agentId}`)
    ])
    if (!session || !agent || session.user_id !== locals.user.id || agent.user_id !== locals.user.id) {
      return json({ error: 'Whiteboard owner not found.' }, { status: 404 })
    }
    if (normalizePrimaryAgentType(agent) !== 'api' || session.metadata?.group_chat) {
      return json({ error: 'Whiteboards are available in single-agent API chats.' }, { status: 400 })
    }
    const board = await readAgentWhiteboard({ userId: locals.user.id, sessionId, agentId })
    return json({ board, settings: resolveApiReasoningRetention(agent) },
      { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[Whiteboard] Failed to read saved board:', error)
    return json({ error: 'Could not load the saved whiteboard.' }, { status: 500 })
  }
}
