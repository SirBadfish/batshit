import { json, type RequestHandler } from '@sveltejs/kit'
import { AgentPluginError, pluginDescriptor } from '$lib/server/services/agentPlugins'
import { importAgentPlugin } from '$lib/server/services/agentPluginImport'
import { publishUserEvent } from '$lib/server/ssePublisher'

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  let source: string | Buffer
  if (request.headers.get('content-type')?.split(';')[0].trim() === 'application/zip') {
    const chunks: Buffer[] = []
    let length = 0
    const reader = request.body?.getReader()
    if (!reader) return json({ error: 'Choose a complete plugin ZIP.' }, { status: 400 })
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > 32 * 1024 * 1024) { await reader.cancel(); return json({ error: 'Choose a plugin ZIP no larger than 32 MB.' }, { status: 413 }) }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
    source = Buffer.concat(chunks)
  } else {
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('path' in body) || typeof body.path !== 'string' || !body.path.trim()) {
      return json({ error: 'Choose one complete plugin ZIP.' }, { status: 400 })
    }
    source = body.path.trim()
  }
  try {
    const { plugin, warnings } = await importAgentPlugin(locals.user.id, source)
    await publishUserEvent(locals.user.id, { type: 'plugin_access_changed', pluginId: plugin.id })
    return json({ plugin: pluginDescriptor(plugin), warnings }, { status: 201 })
  } catch (error) {
    if (error instanceof AgentPluginError) return json({ error: error.message, code: error.code, outcome: error.outcome }, { status: error.status })
    console.error('[plugins] Import failed:', error)
    return json({ error: 'Plugin import did not finish. Refresh saved plugins before another change.', outcome: 'unknown' }, { status: 503 })
  }
}
