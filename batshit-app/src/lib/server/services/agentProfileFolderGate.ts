import { advanceProfileFolderGeneration, withProfileFolderTurn } from './agentProfileFolderQueue'

/**
 * BL-745 (2026-09-28): a managed profile folder (`~/.batshit/agents/<profile id>`) was written by
 * the Claude profile syncs and removed by the agent's delete, and a write that finished after the
 * delete made the deleted agent's folder again. Folder work runs through this gate, one at a time
 * per profile id, in this process. The agent delete removes the record before it removes the
 * folders (`routes/api/agents/[id]`).
 *
 * BL-753 (2026-09-28): a CLI Subagent's folder (`subagent_cli-<slug>`). Its delete removes the
 * folder BEFORE the record (BL-157: a failure keeps the Subagent for a retry), so the delete holds
 * the folder's turn (`holdAgentProfileFolder`) from the removal until the record is gone; the
 * folder removal inside that hold runs at once instead of queueing behind it.
 *
 * SA-139 R5 removed the last profile writers (the Claude Code CLI Subagent's profile sync, its
 * run-start write and the managed-config viewer), so the deletes' own steps are what take turns
 * here now. Subject population changes still take canonical folder turns so a shared-folder
 * deletion cannot race a new or replaced owner.
 *
 * In-process only: a second Batshit process sharing the agents folder is not serialized by it.
 * Separate from the command ownership guard (`hostCommandOwnership.ts`), which decides whether a
 * delete may start at all.
 */

/**
 * Runs `action` after every earlier write or removal of this profile folder has finished. Inside
 * a `holdAgentProfileFolder` of the same folder it runs at once: the hold is its turn.
 */
export async function withAgentProfileFolder<T>(profileId: string, action: () => Promise<T>): Promise<T> {
  return withProfileFolderTurn(profileId, action)
}

/**
 * Holds this profile folder's turn for all of `action`, a delete's several steps: every write
 * queued meanwhile waits until `action` has finished, and the folder removals `action` makes
 * itself do not wait for the hold. Only for a delete's own steps; never start other work inside.
 */
export async function holdAgentProfileFolder<T>(profileId: string, action: () => Promise<T>): Promise<T> {
  return withProfileFolderTurn(profileId, async turn => { advanceProfileFolderGeneration(turn); return action() })
}
