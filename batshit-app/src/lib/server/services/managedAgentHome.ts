import { promises as fs, type Stats } from 'node:fs'
import path from 'node:path'

/**
 * Managed agent homes (BL-7 review), lane-neutral since SA-139 R1 moved these rules out of the
 * retired Codex lane's module: what a Batshit-managed profile id and home are. The profile-folder
 * owners and the deletes use them. (SA-139 R5 removed the helpers that read and wrote Batshit's
 * own files inside a home without following a link: their last callers, the Claude Code CLI
 * Subagent's profile writer and the managed-config viewer, went with it.)
 */

/**
 * The only shape a managed profile id has. Every id Batshit built came from
 * `buildAgentProfileId` (an agent's id, or a CLI Subagent's or Worker's
 * `subagent_cli_<slug>`, lowercased with everything outside `[a-z0-9_-]` turned into
 * `_`), or was the removed bridge's `batshit_agent_default`. No separator and no `.` can pass.
 */
const MANAGED_PROFILE_ID_PATTERN = /^batshit_agent_[a-z0-9_-]+$/

export const MANAGED_PROFILE_ID_REFUSED = 'MANAGED_PROFILE_ID_REFUSED'

/** A profile id that is not Batshit's to use as a folder name under the agents folder. */
export class ManagedProfileIdRefusedError extends Error {
  readonly code = MANAGED_PROFILE_ID_REFUSED

  constructor(message: string) {
    super(message)
    this.name = 'ManagedProfileIdRefusedError'
  }
}

export function isManagedProfileId(profileId: unknown): profileId is string {
  return typeof profileId === 'string' && MANAGED_PROFILE_ID_PATTERN.test(profileId)
}

export function assertManagedProfileId(profileId: unknown): string {
  if (isManagedProfileId(profileId)) return profileId
  const shown = typeof profileId === 'string' ? JSON.stringify(profileId) : String(profileId)
  throw new ManagedProfileIdRefusedError(
    `Batshit refused to use ${shown} as a managed profile: a managed profile id is ` +
      '"batshit_agent_" followed by lowercase letters, digits, "_" or "-", so its folder stays ' +
      "inside Batshit's agents folder."
  )
}

/**
 * Where one CLI lane keeps its managed homes: `<root>/<profile id>/<dirName>`, and the
 * user's own home(s) for that CLI, which a managed home must never be. The Claude lane uses
 * `~/.batshit/agents/<id>/.claude` and the user's own Claude homes.
 */
export interface ManagedAgentHomeLayout {
  root: string
  dirName: string
  cliName: string
  userHomes: string[]
}

/**
 * Why `candidate` is not a managed home of `layout`, or null when it is one: its real path
 * (every symlink followed) must be `<real root>/<profile id>/<dirName>` for a valid profile
 * id, it must be a folder, and it must not be one of the user's own homes (the same folder
 * on disk). One rule for every CLI home layout, so no two copies can drift apart.
 */
export async function describeUnmanagedAgentHome(
  candidate: unknown,
  layout: ManagedAgentHomeLayout
): Promise<string | null> {
  if (typeof candidate !== 'string' || !candidate.trim()) return 'no folder was given'

  let realHome: string
  try {
    realHome = await fs.realpath(candidate)
  } catch (error) {
    return `the folder cannot be resolved (${describeFsError(error)})`
  }
  let realRoot: string
  try {
    realRoot = await fs.realpath(layout.root)
  } catch (error) {
    return `Batshit's agents folder ${layout.root} cannot be resolved (${describeFsError(error)})`
  }

  const parts = path.relative(realRoot, realHome).split(path.sep)
  if (
    parts.length !== 2 ||
    !isManagedProfileId(parts[0]) ||
    parts[1] !== layout.dirName
  ) {
    return `it resolves to ${realHome}, which is not ${path.join(realRoot, '<profile id>', layout.dirName)}`
  }

  let home: Stats
  try {
    home = await fs.stat(realHome)
  } catch (error) {
    return `the folder cannot be read (${describeFsError(error)})`
  }
  if (!home.isDirectory()) return 'it is not a folder'

  for (const userHome of layout.userHomes) {
    const usersOwn = await isSameFolder(home, userHome)
    if (usersOwn === false) continue
    return usersOwn === true
      ? `it is your own ${layout.cliName} home (${userHome})`
      : `Batshit cannot tell it apart from your own ${layout.cliName} home (${userHome}): ${usersOwn}`
  }
  return null
}

/**
 * True when `home` is the folder at `userHome`: the same folder on disk (device and inode,
 * every symlink followed), which is the same real path and also catches a bind mount.
 * False when it is not, and a reason when that cannot be decided. Undecided is refused,
 * never assumed safe.
 */
async function isSameFolder(home: Stats, userHome: string): Promise<boolean | string> {
  let user: Stats
  try {
    user = await fs.stat(userHome)
  } catch (error) {
    // The user has no such home of their own, so this cannot be it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return describeFsError(error)
  }
  return home.dev === user.dev && home.ino === user.ino
}

export function describeFsError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code ?? (error instanceof Error ? error.message : String(error))
}
