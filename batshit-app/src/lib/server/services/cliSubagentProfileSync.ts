import { redis } from '$lib/server/redis'
import {
  holdAgentProfileFolder,
  writeSubagentProfileFolderIfSubagentExists
} from '$lib/server/services/agentProfileFolderGate'
import {
  deleteAgentClaudeConfig,
  prepareManagedClaudeSubagentProfile
} from '$lib/server/services/claudeProfileManager'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import { buildCliSubagentProviderSettings } from '$lib/server/services/cliSubagentProfile'
import {
  buildAgentProfileId,
  deleteAgentCodexConfig,
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
  buildCliWorkerRuntimeId,
  normalizeSubagentSlugValue,
  resolveSubagentSlug
} from '$lib/utils/subagentSlug'
import { WORKERS_MAX_PER_CALL } from '$lib/utils/delegationCapabilities'

/** The managed CLI profile folder a Subagent's slug names (`batshit_agent_subagent_cli-<slug>`). */
function managedCliSubagentProfileId(subagent: SubagentRow): string {
  return buildAgentProfileId(buildCliSubagentRuntimeId(resolveSubagentSlug(subagent)))
}

/**
 * Writes a CLI Subagent's managed profile folder from `subagent`, a row its caller holds in memory.
 *
 * BL-753 (2026-09-28): the write runs in the folder's turn (`agentProfileFolderGate.ts`) and only
 * while `subagent:<id>` still exists then, read at that turn, so an edit racing the Subagent's
 * delete never makes the deleted Subagent's folder again. `written` is false when the Subagent
 * was gone by then (nothing was written).
 */
export async function syncManagedCliSubagentProfile(
  userId: string,
  subagent: SubagentRow,
  preferredRuntime?: CliSubagentRuntime | null
): Promise<{ runtime: CliSubagentRuntime; profileId: string; written: boolean } | null> {
  const runtime = preferredRuntime ?? resolveCliSubagentRuntime(subagent)
  if (!runtime) return null
  const profileId = managedCliSubagentProfileId(subagent)
  const written = await writeSubagentProfileFolderIfSubagentExists(subagent.id, profileId, () =>
    writeManagedCliSubagentProfile(userId, subagent, runtime, profileId)
  )
  return { runtime, profileId, written }
}

/**
 * BL-753: runs a Subagent delete's steps from its profile folder removal until its record is
 * gone while holding that folder's turn, so a profile write queued meanwhile finds no record.
 */
export async function holdManagedCliSubagentProfileFolder<T>(
  subagent: SubagentRow,
  action: () => Promise<T>
): Promise<T> {
  return holdAgentProfileFolder(managedCliSubagentProfileId(subagent), action)
}

async function writeManagedCliSubagentProfile(
  userId: string,
  subagent: SubagentRow,
  runtime: CliSubagentRuntime,
  profileId: string
): Promise<void> {
  const subagentSlug = resolveSubagentSlug(subagent)
  const runtimeId = buildCliSubagentRuntimeId(subagentSlug)
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
      providerSettings: buildCliSubagentProviderSettings(subagent),
      defaultMCPGateways: subagent.defaultMCPGateways ?? null,
      defaultMCPToolSelections: subagent.defaultMCPToolSelections ?? null,
      defaultCliToolIds: subagent.defaultTools ?? null,
      workingDirectory: null,
      runtimeSettings,
    })
    return
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
    providerSettings: buildCliSubagentProviderSettings(subagent),
    defaultMCPGateways: subagent.defaultMCPGateways ?? null,
    defaultMCPToolSelections: subagent.defaultMCPToolSelections ?? null,
    defaultCliToolIds: subagent.defaultTools ?? null,
    runtimeSettings,
  })
}

export interface ManagedCliSubagentProfileDeletion {
  profileId: string
  /** False when another of the user's records resolves to the same folder. */
  deleted: boolean
  /** The id of the record the kept folder is also named for. */
  sharedWith: string | null
  sharedWithKind: 'subagent' | 'agent' | null
}

/**
 * BL-157 (2026-09-25): a deleted Subagent's managed CLI profile folder goes with it,
 * `~/.batshit/agents/batshit_agent_subagent_cli_<slug>/`: its Codex and Claude config and
 * Codex's `logs_2.sqlite`, which holds its prompts. Every type is asked, since a Subagent that
 * was CLI once keeps its folder after a switch to API or n8n Workflow, and asking for a folder
 * that does not exist deletes nothing.
 *
 * The folder is named for the Subagent's SLUG, so a folder another of the user's Subagents
 * resolves to is theirs as well and stays (`sharedWith`). So does a folder one of the user's
 * Primary Agents is named for (`batshit_agent_<id lowercased>`): an agent id starting with
 * `subagent_cli` is refused since BL-285, but an older one may exist. A Worker's folder is
 * never a Subagent's (`buildCliWorkerRuntimeId`). Other Batshit instances on the same Mac
 * share `~/.batshit/agents` and are not seen from here (BL-285, open). The deletes are the
 * Primary Agent delete's own (BL-7 reviewed): Claude's first, which refuses a `.claude` that is not a
 * managed home and removes only the link of a symlinked one, then Codex's, which removes the
 * profile folder without following links. A failure throws, so the caller can keep the
 * Subagent for a retry.
 */
export async function planManagedCliSubagentProfileDeletion(
  userId: string,
  subagent: SubagentRow
): Promise<ManagedCliSubagentProfileDeletion> {
  const runtimeId = buildCliSubagentRuntimeId(resolveSubagentSlug(subagent))
  const profileId = buildAgentProfileId(runtimeId)

  const otherIds = ((await redis.sMembers(`user:${userId}:subagents`)) as string[]).filter(
    (id) => id !== subagent.id
  )
  for (const otherId of otherIds) {
    const other = (await redis.json.get(`subagent:${otherId}`)) as SubagentRow | null
    if (!other) continue
    if (buildAgentProfileId(buildCliSubagentRuntimeId(resolveSubagentSlug(other))) === profileId) {
      return { profileId, deleted: false, sharedWith: otherId, sharedWithKind: 'subagent' }
    }
  }
  for (const agentId of (await redis.sMembers(`user:${userId}:agents`)) as string[]) {
    if (buildAgentProfileId(agentId) === profileId) {
      return { profileId, deleted: false, sharedWith: agentId, sharedWithKind: 'agent' }
    }
  }

  return { profileId, deleted: true, sharedWith: null, sharedWithKind: null }
}

export async function deleteManagedCliSubagentProfile(
  userId: string,
  subagent: SubagentRow
): Promise<ManagedCliSubagentProfileDeletion> {
  const plan = await planManagedCliSubagentProfileDeletion(userId, subagent)
  if (!plan.deleted) return plan
  const runtimeId = buildCliSubagentRuntimeId(resolveSubagentSlug(subagent))
  await deleteAgentClaudeConfig(runtimeId)
  await deleteAgentCodexConfig(runtimeId)
  return plan
}

export interface AgentWorkerProfileDeletion {
  /** Slot folders removed (a folder that was not there counts: nothing of it is left). */
  deleted: string[]
  kept: Array<{ profileId: string; sharedWith: string; sharedWithKind: 'subagent' | 'agent' }>
}

type AgentWorkerProfilePlan = {
  deletable: Array<{ profileId: string; runtimeId: string }>
  kept: AgentWorkerProfileDeletion['kept']
}

/** The route pre-acquires guards for exactly the folders this delete will remove. */
export async function planAgentWorkerProfileDeletion(userId: string, agentId: string): Promise<AgentWorkerProfilePlan> {
  const parentSlug = normalizeSubagentSlugValue(agentId, 'agent')
  const slots = Array.from({ length: WORKERS_MAX_PER_CALL }, (_, index) => `worker_${parentSlug}_${index + 1}`)
  const slotFolders = slots.flatMap((slot) => [
    { slot, runtimeId: buildCliWorkerRuntimeId(slot), legacy: false },
    { slot, runtimeId: buildCliSubagentRuntimeId(slot), legacy: true }
  ])

  const plan: AgentWorkerProfilePlan = { deletable: [], kept: [] }
  const otherAgentIds = ((await redis.sMembers(`user:${userId}:agents`)) as string[]).filter(
    (otherId) => otherId !== agentId
  )
  const sameSlugAgent = otherAgentIds.find(
    (otherId) => normalizeSubagentSlugValue(otherId, 'agent') === parentSlug
  )
  if (sameSlugAgent) {
    for (const { runtimeId } of slotFolders) {
      plan.kept.push({ profileId: buildAgentProfileId(runtimeId), sharedWith: sameSlugAgent, sharedWithKind: 'agent' })
    }
    return plan
  }

  const subagentBySlug = new Map<string, string>()
  for (const subagentId of (await redis.sMembers(`user:${userId}:subagents`)) as string[]) {
    const subagent = (await redis.json.get(`subagent:${subagentId}`)) as SubagentRow | null
    if (subagent) subagentBySlug.set(resolveSubagentSlug(subagent), subagentId)
  }
  const agentByProfileId = new Map(otherAgentIds.map((otherId) => [buildAgentProfileId(otherId), otherId]))

  for (const { slot, runtimeId, legacy } of slotFolders) {
    const profileId = buildAgentProfileId(runtimeId)
    const subagentOwner = legacy ? subagentBySlug.get(slot) : undefined
    if (subagentOwner) {
      plan.kept.push({ profileId, sharedWith: subagentOwner, sharedWithKind: 'subagent' })
      continue
    }
    const agentOwner = agentByProfileId.get(profileId)
    if (agentOwner) {
      plan.kept.push({ profileId, sharedWith: agentOwner, sharedWithKind: 'agent' })
      continue
    }
    plan.deletable.push({ profileId, runtimeId })
  }
  return plan
}

/**
 * BL-393 (2026-09-27): a deleted Primary Agent's Worker slot folders go with it. Its Workers run
 * in one folder per position in a batch (`worker_<agent slug>_<1..3>`, `workerRunner.ts`), each
 * with Codex's `logs_2.sqlite` holding the Workers' prompts, and the agent's delete removed only
 * its own folder. Both names a slot has had are removed: `subagent_cli-worker_…` since BL-285
 * and `subagent_cli_worker_…` before it. The deletes are the careful ones the agent's own folder
 * uses (Claude's home first, then the folder without following links).
 *
 * Never a folder another record also owns: another of the user's agents with the same slug
 * (`Cooper` and `cooper`) runs its Workers in the same slots, so they all stay; and an old-name
 * slot a Subagent slugged `worker_<agent>_<n>` resolves to is that Subagent's folder too.
 */
export async function deleteAgentWorkerProfiles(
  userId: string,
  agentId: string
): Promise<AgentWorkerProfileDeletion> {
  const plan = await planAgentWorkerProfileDeletion(userId, agentId)
  const result: AgentWorkerProfileDeletion = { deleted: [], kept: plan.kept }
  for (const { profileId, runtimeId } of plan.deletable) {
    await deleteAgentClaudeConfig(runtimeId)
    await deleteAgentCodexConfig(runtimeId)
    result.deleted.push(profileId)
  }
  return result
}
