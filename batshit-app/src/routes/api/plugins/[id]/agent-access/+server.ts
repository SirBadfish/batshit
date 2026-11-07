import { json, type RequestHandler } from '@sveltejs/kit'
import { AgentPluginError, setAgentPluginAgentAccess } from '$lib/server/services/agentPlugins'
import { parseAgentAccessChange } from '$lib/server/services/agentAccessLists'
import { publishUserEvent } from '$lib/server/ssePublisher'

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  let body: unknown
  try { body = await request.json() } catch { return json({ error: 'Send {agentId, enabled}.' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'agentId' && key !== 'enabled')) {
    return json({ error: 'Send only {agentId, enabled}.' }, { status: 400 })
  }
  const change = parseAgentAccessChange(body)
  if ('error' in change) return json({ error: change.error }, { status: 400 })
  try {
    const result = await setAgentPluginAgentAccess(locals.user.id, params.id!, change.agentId, change.enabled)
    if (result.changed) await publishUserEvent(locals.user.id, { type: 'plugin_access_changed', pluginId: params.id })
    return json(result)
  } catch (error) {
    if (error instanceof AgentPluginError) return json({ error: error.message, code: error.code, outcome: error.outcome }, { status: error.status })
    console.error('[plugins] Agent access save failed:', error)
    return json({ error: 'Plugin access could not be confirmed. Reload before trying again.', outcome: 'unknown' }, { status: 503 })
  }
}
