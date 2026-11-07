import { json, type RequestHandler } from '@sveltejs/kit'
import { AgentPluginError, listAgentPlugins, pluginDescriptor } from '$lib/server/services/agentPlugins'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  try { return json({ plugins: (await listAgentPlugins(locals.user.id)).map(pluginDescriptor) }) }
  catch (error) {
    if (error instanceof AgentPluginError) return json({ error: error.message, code: error.code }, { status: error.status })
    console.error('[plugins] Failed to read the complete plugin list:', error)
    return json({ error: 'Plugin access could not be read. No default access was assumed.' }, { status: 503 })
  }
}
