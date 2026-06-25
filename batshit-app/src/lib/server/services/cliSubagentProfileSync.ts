import { prepareManagedClaudeSubagentProfile } from '$lib/server/services/claudeProfileManager'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import {
  buildAgentProfileId,
  prepareManagedCodexSubagentProfile,
} from '$lib/server/services/codexProfileManager'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import {
  resolveCliSubagentExecutableModel,
  resolveCliSubagentRuntime,
  type CliSubagentRuntime,
} from '$lib/server/services/cliSubagentModelResolution'
import type { SubagentRow } from '$lib/types/database'
import {
  buildCliSubagentRuntimeId,
  resolveSubagentSlug
} from '$lib/utils/subagentSlug'

export async function syncManagedCliSubagentProfile(
  userId: string,
  subagent: SubagentRow,
  preferredRuntime?: CliSubagentRuntime | null
): Promise<{ runtime: CliSubagentRuntime; profileId: string } | null> {
  const runtime = preferredRuntime ?? resolveCliSubagentRuntime(subagent)
  if (!runtime) return null

  const subagentSlug = resolveSubagentSlug(subagent)
  const runtimeId = buildCliSubagentRuntimeId(subagentSlug)
  const profileId = buildAgentProfileId(runtimeId)
  const profileLabel = `${subagent.displayName || subagentSlug} CLI Subagent`

  if (runtime === 'codex') {
    const runtimeSettings = buildCodexRuntimeSettings(
      subagent.codex_settings ?? subagent.provider_specific_settings ?? null
    )
    const executableModel = resolveCliSubagentExecutableModel(subagent, 'codex')
    if (executableModel) {
      runtimeSettings.model = executableModel
    }
    runtimeSettings.profileId = profileId

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

    return { runtime, profileId }
  }

  const runtimeSettings = buildClaudeRuntimeSettings(
    subagent.claude_settings ?? subagent.provider_specific_settings ?? null
  )
  const executableModel = resolveCliSubagentExecutableModel(subagent, 'claude')
  if (executableModel) {
    runtimeSettings.model = executableModel
  }
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

  return { runtime, profileId }
}
