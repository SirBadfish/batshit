import { promises as fs } from 'node:fs'

import { json, type RequestHandler } from '@sveltejs/kit'

import { redis } from '$lib/server/redis'
import {
  prepareManagedClaudeSubagentProfile,
  getManagedClaudePaths,
} from '$lib/server/services/claudeProfileManager'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import {
  buildAgentProfileId,
  getManagedCodexPaths,
  prepareManagedCodexSubagentProfile,
} from '$lib/server/services/codexProfileManager'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import {
  resolveCliSubagentExecutableModel,
} from '$lib/server/services/cliSubagentModelResolution'
import type { SubagentRow } from '$lib/types/database'
import {
  canonicalizeSubagentRecord,
  normalizeSubagentType,
} from '$lib/utils/subagentType'
import {
  buildCliSubagentRuntimeId,
  resolveSubagentSlug
} from '$lib/utils/subagentSlug'

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
    const subagentData = await redis.json.get(`subagent:${params.id}`)
    if (!subagentData) {
      return json({ error: 'Subagent not found' }, { status: 404 })
    }

    const subagent = canonicalizeSubagentRecord(
      subagentData as Record<string, any>
    ) as SubagentRow

    if (subagent.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    if (normalizeSubagentType(subagent, subagent.subagentType) !== 'cli') {
      return json({ error: 'Managed CLI config is only available for CLI Subagents.' }, { status: 400 })
    }

    const payload = await readManagedConfig(locals.user.id, subagent, provider)
    return json(payload)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Managed ')) {
      return json({ error: error.message }, { status: 404 })
    }
    console.error('[Subagent ManagedConfig API] Failed to load managed config', error)
    return json({ error: 'Failed to load managed config' }, { status: 500 })
  }
}

async function readManagedConfig(
  userId: string,
  subagent: SubagentRow,
  provider: ManagedConfigProvider
) {
  const subagentSlug = resolveSubagentSlug(subagent)
  const runtimeId = buildCliSubagentRuntimeId(subagentSlug)
  const profileId = buildAgentProfileId(runtimeId)
  const profileLabel = `${subagent.displayName || subagentSlug} CLI Subagent`

  if (provider === 'codex') {
    const runtimeSettings = buildCodexRuntimeSettings(
      subagent.codex_settings ?? subagent.provider_specific_settings ?? null
    )
    runtimeSettings.model =
      resolveCliSubagentExecutableModel(subagent, 'codex') ?? runtimeSettings.model

    await prepareManagedCodexSubagentProfile({
      userId,
      profileId,
      runtimeId,
      label: profileLabel,
      displayName: subagent.displayName || subagentSlug,
      slug: subagentSlug,
      providerSettings: subagent.provider_specific_settings ?? null,
      defaultMCPGateways: subagent.defaultMCPGateways ?? null,
      defaultMCPToolSelections: subagent.defaultMCPToolSelections ?? null,
      defaultCliToolIds: subagent.defaultTools ?? null,
      workingDirectory: null,
      runtimeSettings,
    })

    const { configPath } = getManagedCodexPaths(profileId)
    const contents = await readConfigFile(configPath, 'config.toml')
    return {
      provider,
      fileName: 'config.toml',
      path: configPath,
      contents,
    }
  }

  const runtimeSettings = buildClaudeRuntimeSettings(
    subagent.claude_settings ?? subagent.provider_specific_settings ?? null
  )
  runtimeSettings.model =
    resolveCliSubagentExecutableModel(subagent, 'claude') ?? runtimeSettings.model
  runtimeSettings.profileId = profileId

  await prepareManagedClaudeSubagentProfile({
    userId,
    profileId,
    runtimeId,
    label: profileLabel,
    displayName: subagent.displayName || subagentSlug,
    slug: subagentSlug,
    providerSettings: subagent.provider_specific_settings ?? null,
    defaultMCPGateways: subagent.defaultMCPGateways ?? null,
    defaultMCPToolSelections: subagent.defaultMCPToolSelections ?? null,
    defaultCliToolIds: subagent.defaultTools ?? null,
    runtimeSettings,
  })

  const { settingsPath } = getManagedClaudePaths(profileId)
  const contents = await readConfigFile(settingsPath, 'settings.json')
  return {
    provider,
    fileName: 'settings.json',
    path: settingsPath,
    contents,
  }
}

async function readConfigFile(filePath: string, label: string) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Managed ${label} was not found for this subagent yet.`)
    }
    throw error
  }
}
