import { json, type RequestHandler } from '@sveltejs/kit'
import { getEnabledAgentSlashCapabilities } from '$lib/server/services/slashCommandCapabilities'

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const agentId = (url.searchParams.get('agentId') || '').trim()
  if (!agentId) {
    return json({ error: 'agentId is required' }, { status: 400 })
  }

  try {
    const capabilities = await getEnabledAgentSlashCapabilities(locals.user.id, agentId)
    return json({ capabilities })
  } catch (error) {
    console.error('[slash-commands/agent-capabilities] Failed to load capabilities', error)
    return json({ error: 'Failed to load agent slash capabilities' }, { status: 500 })
  }
}
