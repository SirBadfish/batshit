import { redis } from '$lib/server/redis'
import { holdAgentProfileFolder } from '$lib/server/services/agentProfileFolderGate'
import { deleteAgentClaudeConfig } from '$lib/server/services/claudeProfileManager'
import { buildAgentProfileId } from '$lib/server/services/managedProfileIdentity'
import { deleteManagedProfileFolder } from '$lib/server/services/managedProfileFolderDelete'
import type { SubagentRow } from '$lib/types/database'
import {
  buildCliSubagentRuntimeId,
  buildCliWorkerRuntimeId,
  normalizeSubagentSlugValue,
  resolveSubagentSlug
} from '$lib/utils/subagentSlug'
import { WORKER_PROFILE_SLOTS } from '$lib/utils/delegationCapabilities'

/**
 * SA-139 R5: the delete side of the managed CLI profile folders. Nothing writes a CLI Subagent
 * or CLI Worker profile any more (R5 removed the Claude Code CLI Subagent), but a leftover
 * record can still have one, and its delete removes it here.
 */

/** The managed CLI profile folder a Subagent's slug names (`batshit_agent_subagent_cli-<slug>`). */
function managedCliSubagentProfileId(subagent: SubagentRow): string {
  return buildAgentProfileId(buildCliSubagentRuntimeId(resolveSubagentSlug(subagent)))
}

/**
 * BL-753: runs a Subagent delete's steps from its profile folder removal until its record is
 * gone while holding that folder's turn, so other work queued on that folder meanwhile finds no
 * record.
 */
export async function holdManagedCliSubagentProfileFolder<T>(
  subagent: SubagentRow,
  action: () => Promise<T>
): Promise<T> {
  return holdAgentProfileFolder(managedCliSubagentProfileId(subagent), action)
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
 * `~/.batshit/agents/batshit_agent_subagent_cli_<slug>/`: every CLI home inside it, its config,
 * logs and prompts included. Every type is asked, since a Subagent that was CLI once kept its
 * folder after a switch to another type, and asking for a folder that does not exist deletes
 * nothing.
 *
 * The folder is named for the Subagent's SLUG, so a folder another of the user's Subagents
 * resolves to is theirs as well and stays (`sharedWith`). So does a folder one of the user's
 * Primary Agents is named for (`batshit_agent_<id lowercased>`): an agent id starting with
 * `subagent_cli` is refused since BL-285, but an older one may exist. A Worker's folder is
 * never a Subagent's (`buildCliWorkerRuntimeId`). Other Batshit instances on the same Mac
 * share `~/.batshit/agents` and are not seen from here (BL-285, open). The deletes are the
 * Primary Agent delete's own (BL-7 reviewed): Claude's first, which refuses a `.claude` that is not a
 * managed home and removes only the link of a symlinked one, then the whole profile folder
 * (`deleteManagedProfileFolder`), removed without following links. A failure throws, so the
 * caller can keep the Subagent for a retry.
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
  await deleteManagedProfileFolder(runtimeId)
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
  const slots = Array.from({ length: WORKER_PROFILE_SLOTS }, (_, index) => `worker_${parentSlug}_${index + 1}`)
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
 * BL-393 (2026-09-27): a deleted Primary Agent's Worker slot folders go with it. Its CLI Workers
 * ran in one folder per slot (`worker_<agent slug>_<1..WORKER_PROFILE_SLOTS>`, until SA-139 R5
 * removed the CLI Worker), each holding the Workers' prompts and logs, and the agent's delete
 * removed only its own folder. Both names a slot has had are removed: `subagent_cli-worker_…`
 * since BL-285 and `subagent_cli_worker_…` before it. The deletes are the careful ones the
 * agent's own folder uses (Claude's home first, then the folder without following links).
 *
 * Never a folder another record also owns: another of the user's agents with the same slug
 * (`Cooper` and `cooper`) ran its Workers in the same slots, so they all stay; and an old-name
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
    await deleteManagedProfileFolder(runtimeId)
    result.deleted.push(profileId)
  }
  return result
}
