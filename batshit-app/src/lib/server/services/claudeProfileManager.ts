import { getManagedAgentRootDir } from './batshitHome'
import { promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { hostProfileResource, withHostCommandDeletion } from '$lib/server/services/hostCommandOwnership'
import { withAgentProfileFolder } from '$lib/server/services/agentProfileFolderGate'

import { env } from '$env/dynamic/private'
import { buildAgentProfileId } from '$lib/server/services/managedProfileIdentity'
import {
  describeFsError,
  describeUnmanagedAgentHome,
  isManagedProfileId,
  type ManagedAgentHomeLayout
} from '$lib/server/services/managedAgentHome'

/**
 * SA-139 R5: the delete-only core of the managed Claude profiles. Nothing writes a managed
 * Claude profile any more (the Claude Code CLI Primary went in R4 and the CLI Subagent in R5),
 * but a leftover agent, Subagent or Worker slot can still have a folder under
 * `~/.batshit/agents/<profile id>/.claude`, and its delete must remove it (or only its link)
 * without ever reaching the user's own Claude home.
 */
const CLAUDE_DIR_NAME = '.claude'

export function buildClaudeProfileId(agentId: string | null | undefined) {
  return buildAgentProfileId(agentId ?? undefined)
}

export function agentClaudeProfileResource(agentId: string | null | undefined): string {
  return hostProfileResource(buildClaudeProfileId(agentId), getManagedRootDir())
}

function getManagedRootDir() {
  return getManagedAgentRootDir(env.BATSHIT_AGENT_RUNTIME_ROOT)
}

/**
 * BL-7 review — the Claude lane's managed homes follow the positive rule in
 * `managedAgentHome.ts` (first written for the removed Codex lane). A profile id is a folder
 * name, and a stored `claude_profile_id` was used unchecked: `../..` made every managed path
 * `~/.claude/…`, so the run's `--settings`, `--mcp-config` and `--plugin-dir` pointed into the
 * user's own Claude home and a CLI Subagent profile write merged Batshit's keys into their
 * `settings.json`. A folder symlinked out of the agents folder reached the same files by a
 * valid name. The delete below keeps the same checks.
 */
export const MANAGED_CLAUDE_HOME_REFUSED = 'CLAUDE_MANAGED_HOME_REFUSED'

export class ManagedClaudeHomeRefusedError extends Error {
  readonly code = MANAGED_CLAUDE_HOME_REFUSED

  constructor(message: string) {
    super(message)
    this.name = 'ManagedClaudeHomeRefusedError'
  }
}

/**
 * Every Claude profile id Batshit built came from `buildAgentProfileId` (an agent's id, or a
 * CLI Subagent's or Worker's `subagent_cli_<slug>`), so the shared managed profile id rule is this one.
 */
export function assertManagedClaudeProfileId(profileId: unknown): string {
  if (isManagedProfileId(profileId)) return profileId
  const shown = typeof profileId === 'string' ? JSON.stringify(profileId) : String(profileId)
  throw new ManagedClaudeHomeRefusedError(
    `Batshit refused to use ${shown} as a managed Claude profile: a managed profile id is ` +
      '"batshit_agent_" followed by lowercase letters, digits, "_" or "-", so its folder stays ' +
      `inside ${getManagedRootDir()}.`
  )
}

/** The user's own Claude home(s): `~/.claude`, and `CLAUDE_CONFIG_DIR` when it is set. */
function getUsersOwnClaudeHomes() {
  const home = process.env.HOME?.trim() || os.homedir()
  const homes = [path.join(home, CLAUDE_DIR_NAME)]
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (configured) homes.push(path.resolve(configured))
  return homes
}

function refuseClaudeHome(candidate: string, reason: string): never {
  throw new ManagedClaudeHomeRefusedError(
    `Batshit refused to use ${candidate} as a managed Claude home: ${reason}. A managed Claude ` +
      `home is only its own folder under ${getManagedRootDir()}, never your own ` +
      `${getUsersOwnClaudeHomes().join(' or ')}.`
  )
}

function getManagedClaudeHomeLayout(): ManagedAgentHomeLayout {
  return {
    root: getManagedRootDir(),
    dirName: CLAUDE_DIR_NAME,
    cliName: 'Claude',
    userHomes: getUsersOwnClaudeHomes()
  }
}

/** The home must resolve (every symlink followed) to `<agents>/<profile id>/.claude`. */
async function assertBatshitManagedClaudeHome(candidate: string) {
  const reason = await describeUnmanagedAgentHome(candidate, getManagedClaudeHomeLayout())
  if (reason !== null) refuseClaudeHome(candidate, reason)
}

/**
 * The profile folder itself must be `<agents>/<profile id>` once resolved, checked BEFORE
 * anything inside it is touched: a profile folder that is a symlink would otherwise lead the
 * delete wherever it points.
 */
async function assertProfileFolderInsideRoot(profileDir: string, profileId: string) {
  let realRoot: string
  let realProfile: string
  try {
    realRoot = await fs.realpath(getManagedRootDir())
    realProfile = await fs.realpath(profileDir)
  } catch (error) {
    refuseClaudeHome(profileDir, `the folder cannot be resolved (${describeFsError(error)})`)
  }
  if (realProfile !== path.join(realRoot, profileId)) {
    refuseClaudeHome(profileDir, `it resolves to ${realProfile}, outside ${realRoot}`)
  }
}

export async function deleteAgentClaudeConfig(agentId: string | null | undefined) {
  const profileId = buildClaudeProfileId(agentId ?? undefined)
  const removeHome = async () => {
    // BL-7 review: `rm -rf` of `<profile>/.claude` resolves THROUGH a profile folder that is a
    // symlink, so it deleted whatever `.claude` the link reached (the user's own, for a link to
    // their home), and an unlink there removed a link outside the agents folder. The profile
    // folder is checked first; then a `.claude` that is itself a symlink loses only the link,
    // and a real folder goes only when it is a managed home.
    const profileDir = path.join(getManagedRootDir(), assertManagedClaudeProfileId(profileId))
    try {
      await fs.lstat(profileDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await assertProfileFolderInsideRoot(profileDir, profileId)
    const dir = path.join(profileDir, CLAUDE_DIR_NAME)
    let entry: Stats
    try {
      entry = await fs.lstat(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (entry.isSymbolicLink()) {
      await fs.unlink(dir)
      return
    }
    await assertBatshitManagedClaudeHome(dir)
    await fs.rm(dir, { recursive: true, force: true })
  }
  // BL-745: after any earlier write or removal of this folder has finished.
  const remove = () => withAgentProfileFolder(profileId, removeHome)
  if (process.platform === 'win32') return remove() // BL-364: no supported host identity proof yet.
  return withHostCommandDeletion([agentClaudeProfileResource(agentId)], async () => remove())
}
