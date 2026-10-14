import { getManagedAgentRootDir } from './batshitHome'
import { constants as fsConstants, promises as fs, type Stats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * BL-7 review — what counts as a Batshit-managed Codex home, in one place.
 *
 * Batshit runs every managed Codex turn with `CODEX_HOME` set to the agent's own folder,
 * `~/.batshit/agents/<profile id>/.codex`, links the user's `auth.json` and
 * `credentials.json` into it, and passes `skills.bundled.enabled=false` for it. codex-cli
 * 0.139.0 answers that switch by DELETING `CODEX_HOME/skills/.system`, and linking a
 * credential into a folder first removes whatever sits at the link's path. Pointed at the
 * user's own `~/.codex` (which belongs to their Codex app), those steps delete the app's
 * bundled skills and the user's real `auth.json`.
 *
 * Two roads led there. A profile id is a folder name, and it can come from stored settings
 * (`codex_settings.profileId`, `provider_specific_settings.codex_profile_id`), so `../..`
 * made the "managed" home `~/.batshit/agents/../../.codex`, which is `~/.codex`. And an
 * agent folder whose `.codex` is a symlink to `~/.codex` reached it by a valid name. So the
 * check is positive: a profile id must have the one shape Batshit builds, and a home must
 * RESOLVE (every symlink followed) to `<agents folder>/<profile id>/.codex` and must not
 * be the user's own Codex home by any spelling. A home that fails is refused loudly; a
 * managed run never falls back to another home.
 */

/** `~/.batshit/agents`: every managed Codex home is `<this>/<profile id>/.codex`. */
export const MANAGED_CODEX_ROOT_DIR = getManagedAgentRootDir()
export const CODEX_HOME_DIR_NAME = '.codex'
/** The user's own Codex home. Batshit never runs a managed turn in it. */
export const USER_CODEX_HOME = path.join(os.homedir(), CODEX_HOME_DIR_NAME)

/**
 * The only shape a managed profile id has. Every id Batshit builds comes from
 * `buildAgentProfileId` (an agent's id, or a CLI Subagent's or Worker's
 * `subagent_cli_<slug>`, lowercased with everything outside `[a-z0-9_-]` turned into
 * `_`), or is the bridge's `batshit_agent_default`. No separator and no `.` can pass.
 */
const MANAGED_CODEX_PROFILE_ID_PATTERN = /^batshit_agent_[a-z0-9_-]+$/

export const MANAGED_CODEX_HOME_REFUSED = 'CODEX_MANAGED_HOME_REFUSED'

/**
 * A profile id or a home that is not Batshit's to use. Callers that log and carry on when
 * a home merely could not be prepared rethrow this one (`isManagedCodexHomeRefusal`).
 */
export class ManagedCodexHomeRefusedError extends Error {
  readonly code = MANAGED_CODEX_HOME_REFUSED

  constructor(message: string) {
    super(message)
    this.name = 'ManagedCodexHomeRefusedError'
  }
}

export function isManagedCodexHomeRefusal(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === MANAGED_CODEX_HOME_REFUSED
}

export function isManagedCodexProfileId(profileId: unknown): profileId is string {
  return typeof profileId === 'string' && MANAGED_CODEX_PROFILE_ID_PATTERN.test(profileId)
}

export function assertManagedCodexProfileId(profileId: unknown): string {
  if (isManagedCodexProfileId(profileId)) return profileId
  const shown = typeof profileId === 'string' ? JSON.stringify(profileId) : String(profileId)
  throw new ManagedCodexHomeRefusedError(
    `Batshit refused to use ${shown} as a managed Codex ` +
      'profile: a managed profile id is "batshit_agent_" followed by lowercase letters, digits, ' +
      '"_" or "-", so its folder stays inside ' +
      `${MANAGED_CODEX_ROOT_DIR}.`
  )
}

/**
 * Where one CLI lane keeps its managed homes: `<root>/<profile id>/<dirName>`, and the
 * user's own home(s) for that CLI, which a managed home must never be. The Codex lane uses
 * `~/.batshit/agents/<id>/.codex` and `~/.codex`; the Claude lane its own root and `.claude`.
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
 * on disk). Shared by both CLI lanes, so the two rules cannot drift apart.
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
    !isManagedCodexProfileId(parts[0]) ||
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

/** Why `candidate` is not a managed Codex home, or null when it is one. */
function describeUnmanagedCodexHome(candidate: unknown): Promise<string | null> {
  return describeUnmanagedAgentHome(candidate, MANAGED_CODEX_HOME_LAYOUT)
}

export function describeFsError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code ?? (error instanceof Error ? error.message : String(error))
}

/** A positive check: true only for a folder that resolves to a Batshit-managed Codex home. */
export async function isBatshitManagedCodexHome(candidate: unknown): Promise<boolean> {
  return (await describeUnmanagedCodexHome(candidate)) === null
}

/**
 * Throws `ManagedCodexHomeRefusedError` unless `candidate` is a Batshit-managed Codex home.
 * Required before `CODEX_HOME` is set to it, before the bundled-skills switch is passed
 * for it, and before any credential link in it is made or removed.
 */
export async function assertBatshitManagedCodexHome(candidate: unknown): Promise<void> {
  const reason = await describeUnmanagedCodexHome(candidate)
  if (reason === null) return
  throw new ManagedCodexHomeRefusedError(
    `Batshit refused to run Codex in ${String(candidate)}: ${reason}. A managed Codex run uses ` +
      `only its own folder under ${MANAGED_CODEX_ROOT_DIR}, never your own ${USER_CODEX_HOME}.`
  )
}

/**
 * BL-7 review: a profile folder must resolve to itself inside the agents folder BEFORE
 * `.codex` is made in it; one planted as a symlink would otherwise get a new `.codex` made
 * wherever it points.
 */
export async function assertCodexProfileFolderInsideRoot(profileDir: string): Promise<void> {
  const state = await describeFolderBelowRoot(profileDir, MANAGED_CODEX_ROOT_DIR)
  if (state === 'ok') return
  throw new ManagedCodexHomeRefusedError(
    `Batshit refused to use ${profileDir} as a managed Codex profile folder: ` +
      `${state === 'missing' ? 'it does not exist' : state}. A managed Codex run uses only its own ` +
      `folder under ${MANAGED_CODEX_ROOT_DIR}, never your own ${USER_CODEX_HOME}.`
  )
}

/**
 * The folder a managed run falls back to when no home was prepared for it (the bridge's
 * `batshit_agent_default` case). The profile id is refused before it becomes a path, so
 * no folder is created outside the agents folder, and the folder is checked like any
 * managed home before its linked Codex folders are replaced (both Codex lanes check it again
 * before they start). No credential link is made here, as before. A folder that cannot be
 * created fails the run: the run never goes on without a managed home, which would have
 * meant the user's own CODEX_HOME.
 */
export async function ensureManagedCodexFallbackHome(profileId: string): Promise<string> {
  const profileDir = path.join(MANAGED_CODEX_ROOT_DIR, assertManagedCodexProfileId(profileId))
  const dir = path.join(profileDir, CODEX_HOME_DIR_NAME)
  try {
    await fs.mkdir(profileDir, { recursive: true })
    await assertCodexProfileFolderInsideRoot(profileDir)
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    if (isManagedCodexHomeRefusal(error)) throw error
    throw new Error(
      `Batshit could not create the managed Codex home ${dir} for this run (${describeFsError(error)}).`,
      { cause: error }
    )
  }
  await assertBatshitManagedCodexHome(dir)
  await replaceLinkedCodexFolders(dir)
  return dir
}

/**
 * Folders codex-cli (0.139.0) writes into inside CODEX_HOME: `sessions` and
 * `archived_sessions` (rollout/src/lib.rs), `shell_snapshots` (core/src/shell_snapshot.rs),
 * `skills` (bundled skills in `skills/.system`), and `tmp` and `.tmp`, which a live run made.
 */
export const CODEX_HOME_WRITE_FOLDERS = [
  'skills',
  'sessions',
  'archived_sessions',
  'shell_snapshots',
  'tmp',
  '.tmp'
] as const

/**
 * BL-7 review: Codex writes and deletes inside these folders (with `skills.bundled.enabled=
 * false` it deletes `skills/.system`), so one planted as a symlink sent that work to wherever
 * it pointed, the user's own `~/.codex` included. A folder that is a link is replaced with a
 * real, empty one; the folder it pointed at is never touched. Run on a home that already
 * passed `assertBatshitManagedCodexHome`.
 */
export async function replaceLinkedCodexFolders(home: string): Promise<void> {
  for (const name of CODEX_HOME_WRITE_FOLDERS) {
    const folder = path.join(home, name)
    const entry = await fs.lstat(folder).catch(() => null)
    if (!entry?.isSymbolicLink()) continue
    console.warn(
      "[ManagedHome] Replaced a symlinked folder in a managed Codex home with a real one; the folder it pointed at was not touched",
      { folder }
    )
    await fs.unlink(folder)
    await fs.mkdir(folder)
  }
}

/* ---------------------------------------------------------------------------------------- *
 * Files inside a managed home (BL-7 review).
 *
 * A symlink planted INSIDE a managed home (an in-app agent can plant one: sandboxes mount
 * `~/.batshit`) made Batshit write its managed `config.toml` / `settings.json` / `mcp.json`
 * into the file it pointed at, merge that file's content into the managed one, and show it in
 * the managed-config viewer. The rule: Batshit REPLACES a link where one of its own files
 * belongs and never touches the link's target. Every write is a temp file renamed over the
 * target (a rename replaces the directory entry and never follows a link there, and it is
 * atomic, so a crash never leaves half a file); a read opens the file with O_NOFOLLOW and
 * checks that no folder between the root and the file is a link. Batshit owns every file in
 * a managed home and makes no link there except the credential links (`auth.json`,
 * `credentials.json`), so a link anywhere else is foreign; replacing it heals the home without
 * asking the user to find and delete a hidden symlink, and the target is never read, written,
 * chmod-ed, chown-ed, or deleted.
 * ---------------------------------------------------------------------------------------- */

export const MANAGED_FILE_IS_A_LINK = 'MANAGED_FILE_IS_A_LINK'

/**
 * What a refused managed file turned out to be (BL-291: the logs named every one of them a
 * symlink, a hard link included).
 */
export type ManagedFileLinkKind =
  | 'symlink'
  | 'hard-link'
  | 'not-a-plain-file'
  | 'folder'
  | 'unmanaged-home'

/** A managed file that is, or sits behind, a symlink (or is not a plain file), so Batshit did not use it. */
export class ManagedFileLinkError extends Error {
  readonly code = MANAGED_FILE_IS_A_LINK

  constructor(
    message: string,
    readonly kind: ManagedFileLinkKind
  ) {
    super(message)
    this.name = 'ManagedFileLinkError'
  }
}

/**
 * BL-291: a few words for a log line that say what a refused managed file actually was, so a
 * hard link is not reported as a symlink. The error's own message carries the full detail.
 */
export function describeManagedFileLinkRefusal(error: unknown): string {
  switch ((error as { kind?: unknown } | null)?.kind) {
    case 'hard-link':
      return 'it is a hard link'
    case 'not-a-plain-file':
      return 'it is not a plain file'
    case 'folder':
      return 'its folder did not pass the managed-folder check'
    case 'unmanaged-home':
      return 'its folder is not a managed home'
    default:
      return 'it is a symlink'
  }
}

export function isManagedFileLinkError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === MANAGED_FILE_IS_A_LINK
}

/** 'ok' when `folder` resolves to itself below the real `root`, 'missing', or why not. */
async function describeFolderBelowRoot(folder: string, root: string): Promise<'ok' | 'missing' | string> {
  const relative = path.relative(root, folder)
  if (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') return `it is outside ${root}`
  let realRoot: string
  let realFolder: string
  try {
    realRoot = await fs.realpath(root)
    realFolder = await fs.realpath(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return `it cannot be resolved (${describeFsError(error)})`
  }
  const expected = relative ? path.join(realRoot, relative) : realRoot
  return realFolder === expected ? 'ok' : `a folder on its way is a symbolic link (it resolves to ${realFolder})`
}

/**
 * Reads a file Batshit keeps under `root` without following any symlink below `root`: its
 * folder must resolve to itself, and the file is opened with O_NOFOLLOW. Null when it does not
 * exist; `ManagedFileLinkError` when it or a folder on its way is a link, or it is not a plain
 * file.
 */
export async function readFileWithoutLinks(filePath: string, root: string): Promise<string | null> {
  const folder = await describeFolderBelowRoot(path.dirname(filePath), root)
  if (folder === 'missing') return null
  if (folder !== 'ok') {
    throw new ManagedFileLinkError(`Batshit did not read ${filePath}: ${folder}.`, 'folder')
  }
  let handle: FileHandle
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new ManagedFileLinkError(
        `Batshit did not read ${filePath}: it is a symbolic link, and Batshit never reads through one.`,
        'symlink'
      )
    }
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) {
      throw new ManagedFileLinkError(`Batshit did not read ${filePath}: it is not a plain file.`, 'not-a-plain-file')
    }
    // BL-163: O_NOFOLLOW stops a symbolic link, not a hard link. A second name for this file
    // can sit in any folder on the same disk, so its content is not Batshit's to merge or
    // show; the caller rebuilds it, and the rename-over write gives the home its own file
    // again without touching the other name.
    if (opened.nlink > 1) {
      throw new ManagedFileLinkError(
        `Batshit did not read ${filePath}: it has another name on disk (a hard link), and Batshit never reads a file another folder can reach.`,
        'hard-link'
      )
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Writes a file Batshit keeps under `root`, atomically and without following a link: a new
 * temp file in the same folder (created exclusively, with `mode`, and handed to `prepareHandle`
 * for ownership while it is still OPEN, so no path is ever chown-ed), renamed over `filePath`. A link at `filePath` is replaced, never followed,
 * and its target is never touched. The folder must resolve to itself below `root`. Without a
 * `mode`, a plain file being replaced keeps its own permissions, as an in-place write would.
 */
export async function writeFileWithoutLinks(
  filePath: string,
  contents: string,
  root: string,
  options: { mode?: number; prepareHandle?: (handle: FileHandle) => Promise<void> } = {}
): Promise<void> {
  const folder = path.dirname(filePath)
  const state = await describeFolderBelowRoot(folder, root)
  if (state !== 'ok') {
    throw new ManagedFileLinkError(
      `Batshit refused to write ${filePath}: ${state === 'missing' ? 'its folder does not exist' : state}.`,
      'folder'
    )
  }
  const tempPath = path.join(
    folder,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  const existing = await fs.lstat(filePath).catch(() => null)
  const mode = options.mode ?? (existing?.isFile() ? existing.mode & 0o777 : undefined)
  const handle = await fs.open(tempPath, 'wx', mode ?? 0o666)
  try {
    try {
      await handle.writeFile(contents, 'utf8')
      if (mode !== undefined) await handle.chmod(mode)
      await options.prepareHandle?.(handle)
    } finally {
      await handle.close()
    }
    if (existing?.isSymbolicLink()) {
      console.warn(
        "[ManagedHome] Replaced a symlink with Batshit's own file; the file it pointed at was not touched",
        { filePath }
      )
    }
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Reads a file of a managed home for SHOWING it (the managed-config viewers): the home must
 * pass the managed-home check and the file is read without following a link. Null when it
 * does not exist.
 */
export async function readManagedHomeFile(
  filePath: string,
  layout: ManagedAgentHomeLayout
): Promise<string | null> {
  const home = path.dirname(filePath)
  try {
    await fs.lstat(home)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const reason = await describeUnmanagedAgentHome(home, layout)
  if (reason !== null) {
    throw new ManagedFileLinkError(
      `Batshit did not show ${filePath}: its folder is not a managed home (${reason}).`,
      'unmanaged-home'
    )
  }
  return readFileWithoutLinks(filePath, layout.root)
}

/** The Codex lane's layout, for `readManagedHomeFile`. */
export const MANAGED_CODEX_HOME_LAYOUT: ManagedAgentHomeLayout = {
  root: MANAGED_CODEX_ROOT_DIR,
  dirName: CODEX_HOME_DIR_NAME,
  cliName: 'Codex',
  userHomes: [USER_CODEX_HOME]
}

/** Reads a managed Codex file to SHOW it (the managed-config viewers); see `readManagedHomeFile`. */
export function readManagedCodexHomeFile(filePath: string) {
  return readManagedHomeFile(filePath, MANAGED_CODEX_HOME_LAYOUT)
}
