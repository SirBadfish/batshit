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
  readManagedClaudeHomeFile,
  syncAgentClaudeProfiles
} from '$lib/server/services/claudeProfileManager'
import {
  isManagedFileLinkError,
  readManagedCodexHomeFile
} from '$lib/server/services/codexManagedHome'

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
    if (isManagedFileLinkError(error)) {
      return json({ error: (error as Error).message }, { status: 409 })
    }
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
    const contents = await readConfigFile(configPath, 'config.toml', readManagedCodexHomeFile)
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
  const contents = await readConfigFile(settingsPath, 'settings.json', readManagedClaudeHomeFile)
  return {
    provider,
    fileName: 'settings.json',
    path: settingsPath,
    contents
  }
}

async function readConfigFile(
  filePath: string,
  label: string,
  read: (filePath: string) => Promise<string | null>
) {
  // BL-7 review: shown only from a managed home and never through a symlink (a link planted
  // there would have shown the file it points at, such as the user's own config).
  const contents = await read(filePath)
  if (contents === null) {
    throw new Error(`Managed ${label} was not found for this agent yet.`)
  }
  return contents
}
