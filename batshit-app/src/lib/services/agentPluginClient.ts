import type { AgentPluginDescriptor } from '$lib/types/agentPlugins'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readAgentPlugin(value: unknown): AgentPluginDescriptor {
  if (!isObject(value) ||
    !['id', 'name', 'description', 'version', 'revision'].every(key => typeof value[key] === 'string') ||
    !value.id || !value.revision || typeof value.builtIn !== 'boolean' ||
    typeof value.enabled_for_all_agents !== 'boolean' ||
    ['installing', 'removing'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean') ||
    !Array.isArray(value.enabled_agent_ids) || value.enabled_agent_ids.some(id => typeof id !== 'string' || !id) ||
    !Array.isArray(value.skills) || value.skills.length === 0 || value.skills.some(skill =>
      !isObject(skill) || !['commandId', 'skillId', 'name', 'invocation'].every(key => typeof skill[key] === 'string' && skill[key] !== '')
    )) {
    throw new Error('The saved plugin details are unavailable. Refresh before changing access.')
  }
  return value as unknown as AgentPluginDescriptor
}

export async function loadAgentPlugins(): Promise<AgentPluginDescriptor[]> {
  const response = await fetch('/api/plugins')
  const payload: unknown = await response.json()
  if (!response.ok || !isObject(payload) || !Array.isArray(payload.plugins)) {
    throw new Error(isObject(payload) && typeof payload.error === 'string' ? payload.error : 'The saved plugins list is unavailable.')
  }
  const plugins = payload.plugins.map(readAgentPlugin)
  if (new Set(plugins.map(plugin => plugin.id)).size !== plugins.length) throw new Error('The saved plugins list is incomplete. Refresh before changing access.')
  return plugins
}

export class AgentPluginSaveError extends Error {
  constructor(message: string, readonly outcomeUnknown: boolean) { super(message) }
}

export async function changeAgentPlugin(path: string, body?: unknown, method = 'PUT', onWarnings?: (warnings: string[]) => void): Promise<AgentPluginDescriptor | null> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': body instanceof Blob ? 'application/zip' : 'application/json' }, body: body instanceof Blob ? body : JSON.stringify(body) })
    })
  } catch {
    throw new AgentPluginSaveError('The plugin change could not be confirmed. Refresh saved plugins before another change.', true)
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new AgentPluginSaveError(
      isObject(payload) && typeof payload.error === 'string' ? payload.error : 'The plugin change could not be confirmed. Refresh saved plugins before another change.',
      ![400, 401, 403, 404, 409, 422].includes(response.status)
    )
  }
  if (isObject(payload) && Array.isArray(payload.warnings)) onWarnings?.(payload.warnings.filter((item): item is string => typeof item === 'string'))
  if (method === 'DELETE') return null
  try {
    return readAgentPlugin(isObject(payload) ? payload.plugin : null)
  } catch {
    throw new AgentPluginSaveError('The change was accepted, but its saved details are unavailable. Refresh before another change.', true)
  }
}
