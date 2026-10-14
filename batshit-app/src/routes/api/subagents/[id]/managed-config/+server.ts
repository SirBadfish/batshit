import { json, type RequestHandler } from '@sveltejs/kit'

import { redis } from '$lib/server/redis'
import { writeSubagentProfileFolderIfSubagentExists } from '$lib/server/services/agentProfileFolderGate'
import {
  prepareManagedClaudeSubagentProfile,
  getManagedClaudePaths,
  readManagedClaudeHomeFile,
} from '$lib/server/services/claudeProfileManager'
import {
  isManagedFileLinkError,
  readManagedCodexHomeFile,
} from '$lib/server/services/codexManagedHome'
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

/**
 * BL-761 (2026-09-28): `readManagedConfig` reads the Subagent's record, then awaits the
 * gateway list and MCP selections before writing its profile folder. A Subagent deleted in that
 * gap must not get its folder back; `writeSubagentProfileFolderIfSubagentExists` re-reads
 * `subagent:<id>` at the folder's own turn (`agentProfileFolderGate.ts`) and this error marks
 * that outcome so the route can answer 404 instead of returning a config for a gone Subagent.
 */
class SubagentGoneWhilePreparingError extends Error {}

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
    if (error instanceof SubagentGoneWhilePreparingError) {
      return json({ error: 'Subagent not found' }, { status: 404 })
    }
    if (isManagedFileLinkError(error)) {
      return json({ error: (error as Error).message }, { status: 409 })
    }
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

    // BL-761: only while the Subagent still exists at the folder's turn.
    const written = await writeSubagentProfileFolderIfSubagentExists(subagent.id, profileId, async () => {
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
    })
    if (!written) throw new SubagentGoneWhilePreparingError()

    const { configPath } = getManagedCodexPaths(profileId)
    const contents = await readConfigFile(configPath, 'config.toml', readManagedCodexHomeFile)
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

  // BL-761: only while the Subagent still exists at the folder's turn.
  const written = await writeSubagentProfileFolderIfSubagentExists(subagent.id, profileId, async () => {
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
  })
  if (!written) throw new SubagentGoneWhilePreparingError()

  const { settingsPath } = getManagedClaudePaths(profileId)
  const contents = await readConfigFile(settingsPath, 'settings.json', readManagedClaudeHomeFile)
  return {
    provider,
    fileName: 'settings.json',
    path: settingsPath,
    contents,
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
    throw new Error(`Managed ${label} was not found for this subagent yet.`)
  }
  return contents
}
