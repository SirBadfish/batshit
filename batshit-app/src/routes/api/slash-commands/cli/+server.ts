import { json, type RequestHandler } from '@sveltejs/kit'
import { discoverClaudeCommands, discoverCodexCommands } from '$lib/server/services/slashCommandDiscovery'

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const provider = (url.searchParams.get('provider') || '').toLowerCase()
  const scope = (url.searchParams.get('scope') || 'managed').toLowerCase() as 'managed' | 'global'
  const agentId = url.searchParams.get('agentId')
  const projectPath = url.searchParams.get('projectPath')

  try {
    if (provider === 'claude') {
      const commands = await discoverClaudeCommands({
        scope: scope === 'global' ? 'global' : 'managed',
        agentId,
        projectPath: projectPath || null
      })
      return json({ commands })
    }

    if (provider === 'codex') {
      const commands = await discoverCodexCommands({
        scope: scope === 'global' ? 'global' : 'managed',
        agentId,
        projectPath: projectPath || null
      })
      return json({ commands })
    }

    return json({ error: 'Invalid provider' }, { status: 400 })
  } catch (error) {
    console.error('[slash-commands/cli] Failed to load CLI commands', error)
    return json({ error: 'Failed to load CLI commands' }, { status: 500 })
  }
}
