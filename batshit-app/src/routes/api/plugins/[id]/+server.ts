import { json, type RequestHandler } from '@sveltejs/kit'
import { AgentPluginError, setAgentPluginGlobalAccess } from '$lib/server/services/agentPlugins'
import { publishUserEvent } from '$lib/server/ssePublisher'

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  let body: unknown
  try { body = await request.json() } catch { return json({ error: 'Send {enabled_for_all_agents: boolean}.' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
    typeof (body as Record<string, unknown>).enabled_for_all_agents !== 'boolean') {
    return json({ error: 'Send only the Enable For All Agents setting.' }, { status: 400 })
  }
  try {
    const result = await setAgentPluginGlobalAccess(locals.user.id, params.id!, (body as { enabled_for_all_agents: boolean }).enabled_for_all_agents)
    if (result.changed) await publishUserEvent(locals.user.id, { type: 'plugin_access_changed', pluginId: params.id })
    return json(result)
  } catch (error) {
    if (error instanceof AgentPluginError) return json({ error: error.message, code: error.code, outcome: error.outcome }, { status: error.status })
    console.error('[plugins] Global access save failed:', error)
    return json({ error: 'Plugin access could not be confirmed. Reload before trying again.', outcome: 'unknown' }, { status: 503 })
  }
}

export const DELETE: RequestHandler = async ({ params, locals, request }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('expectedRevision' in body) || typeof body.expectedRevision !== 'string' || !body.expectedRevision) return json({ error: 'Refresh saved plugins before confirming removal.' }, { status: 400 })
  try {
    const { uninstallAgentPlugin } = await import('$lib/server/services/agentPluginImport')
    await uninstallAgentPlugin(locals.user.id, params.id!, body.expectedRevision)
    await publishUserEvent(locals.user.id, { type: 'plugin_access_changed', pluginId: params.id })
    return json({ success: true })
  } catch (error) {
    if (error instanceof AgentPluginError) return json({ error: error.message, code: error.code, outcome: error.outcome }, { status: error.status })
    console.error('[plugins] Removal did not finish:', error)
    return json({ error: 'Plugin removal did not finish. Refresh saved plugins before another change.', outcome: 'unknown' }, { status: 503 })
  }
}
