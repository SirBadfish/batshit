import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getManagedAgentRootDir } from './batshitHome'
import { withAgentProfileFolder } from './agentProfileFolderGate'
import { hostProfileResource, withHostCommandDeletion } from './hostCommandOwnership'
import { buildAgentProfileId } from './managedProfileIdentity'

const MANAGED_AGENT_ROOT_DIR = getManagedAgentRootDir()

/**
 * Removes the WHOLE managed profile folder `~/.batshit/agents/<profile id>` of an agent, a CLI
 * Subagent or a Worker slot (every CLI home inside it, logs and prompts included): the agent
 * delete, the Subagent delete (BL-157) and the Worker slot cleanup (BL-393) call it. It waits for
 * any profile sync write already under way for this folder (BL-745) and holds the host command
 * deletion marker for the folder while it removes it.
 */
export async function deleteManagedProfileFolder(agentId: string | null | undefined) {
  const profileId = buildAgentProfileId(agentId ?? undefined)
  const dir = path.join(MANAGED_AGENT_ROOT_DIR, profileId)
  const remove = async () => withAgentProfileFolder(profileId, () => fs.rm(dir, { recursive: true, force: true }))
  if (process.platform === 'win32') return remove() // BL-364: no supported host identity proof yet.
  return withHostCommandDeletion([hostProfileResource(profileId)], async () => remove())
}
