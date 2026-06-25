import { promises as fs } from 'node:fs'

import { json, type RequestHandler } from '@sveltejs/kit'

import { redis } from '$lib/server/redis'
import {
  buildAgentProfileId,
  getManagedCodexPaths,
  syncAgentCodexProfiles
} from '$lib/server/services/codexProfileManager'
import {
  buildClaudeProfileId,
  getManagedClaudePaths,
  syncAgentClaudeProfiles
} from '$lib/server/services/claudeProfileManager'

type ManagedConfigProvider = 'codex' | 'claude'

export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const provider = url.searchParams.get('provider')
  if (provider !== 'codex' && provider !== 'claude') {
    return json({ error: 'Query param `provider` must be `codex` or `claude`.' }, { status: 400 })
  }

  try {
    const agent = await redis.get(`agent:${params.id}`)
    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }

    if (agent.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    const payload = await readManagedConfig(locals.user.id, params.id!, provider)
    return json(payload)
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Managed ')
    ) {
      return json({ error: error.message }, { status: 404 })
    }
    console.error('[ManagedConfig API] Failed to load managed config', error)
    return json({ error: 'Failed to load managed config' }, { status: 500 })
  }
}

async function readManagedConfig(
  userId: string,
  agentId: string,
  provider: ManagedConfigProvider
) {
  if (provider === 'codex') {
    await syncAgentCodexProfiles(userId)
    const profileId = buildAgentProfileId(agentId)
    const { configPath } = getManagedCodexPaths(profileId)
    const contents = await readConfigFile(configPath, 'config.toml')
    return {
      provider,
      fileName: 'config.toml',
      path: configPath,
      contents
    }
  }

  await syncAgentClaudeProfiles(userId)
  const profileId = buildClaudeProfileId(agentId)
  const { settingsPath } = getManagedClaudePaths(profileId)
  const contents = await readConfigFile(settingsPath, 'settings.json')
  return {
    provider,
    fileName: 'settings.json',
    path: settingsPath,
    contents
  }
}

async function readConfigFile(filePath: string, label: string) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Managed ${label} was not found for this agent yet.`)
    }
    throw error
  }
}
