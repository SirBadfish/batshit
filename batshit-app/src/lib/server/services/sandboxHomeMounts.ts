import { getBatshitHomeDir, getDefaultBatshitHomeDir, getManagedAgentRootDir } from './batshitHome'
import path from 'node:path'
import { lstat, mkdir, realpath } from 'node:fs/promises'

// Shared with the standalone Docker host operator. Runtime launch records and
// Pinokio's data/secrets belong to the host, never an in-app sandbox (BL-368).
import policy from './sandboxHomePolicy.json'
import { macCustodyRoots } from './macCustodyPaths'
export const SANDBOX_BATSHIT_WRITABLE_DIRS: readonly string[] = Object.freeze(policy.writableDirs)
export const SANDBOX_BATSHIT_PROTECTED_DIRS: readonly string[] = Object.freeze(policy.protectedDirs)
export const SANDBOX_MOUNT_VERSION = policy.mountVersion

export function batshitHomeSandboxMountPaths(batshitHome: string, sharedHome = batshitHome): string[] {
  return SANDBOX_BATSHIT_WRITABLE_DIRS.map((name) =>
    path.join(policy.laneOwnedDirs.includes(name) ? batshitHome : sharedHome, name)
  )
}

function externalProtectedHome(): string[] {
  const configured = process.env.BATSHIT_SANDBOX_PROTECTED_HOME_DIR?.trim()
  if (!configured) return []
  if (!path.isAbsolute(configured)) throw new Error('BATSHIT_SANDBOX_PROTECTED_HOME_DIR must name an absolute folder.')
  return [path.resolve(configured)]
}

export function sandboxProtectedHomeRoots(batshitHome = getBatshitHomeDir(), sharedHome = getDefaultBatshitHomeDir()): string[] {
  return [...new Set([
    ...[batshitHome, sharedHome, ...externalProtectedHome()].flatMap((root) => SANDBOX_BATSHIT_PROTECTED_DIRS.map((name) => path.join(root, name))),
    getManagedAgentRootDir(),
    ...macCustodyRoots()
  ])]
}

/** Preserve normal sandbox names; a custom layout must not reuse their old mounts. */
export function sandboxHomeMountIdentity(): string {
  const home = getBatshitHomeDir()
  const shared = getDefaultBatshitHomeDir()
  const agents = getManagedAgentRootDir()
  const protectedHome = externalProtectedHome()
  const custody = macCustodyRoots()
  return home === shared && agents === path.join(shared, 'agents') && protectedHome.length === 0 && custody.length === 0 ? '' : JSON.stringify([home, shared, agents, ...protectedHome, ...custody])
}

/** Make the explicit mount sources, refusing links in the source path. */
export async function ensureBatshitHomeSandboxMountPaths(
  batshitHome = getBatshitHomeDir(),
  sharedHome = batshitHome === getBatshitHomeDir() ? getDefaultBatshitHomeDir() : batshitHome
): Promise<string[]> {
  await mkdir(batshitHome, { recursive: true })
  const home = await realpath(batshitHome)
  if (home !== path.resolve(batshitHome)) {
    throw new Error('Batshit sandbox home is a link; refusing writable mounts.')
  }
  if (sharedHome !== batshitHome) {
    await mkdir(sharedHome, { recursive: true })
    if (await realpath(sharedHome) !== path.resolve(sharedHome)) {
      throw new Error('Batshit shared sandbox home is a link; refusing writable mounts.')
    }
  }
  const mounts = batshitHomeSandboxMountPaths(home, sharedHome)
  for (const mount of mounts) {
    const entry = await lstat(mount).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (entry?.isSymbolicLink()) {
      throw new Error(`Batshit sandbox mount is a link: ${mount}`)
    }
    if (!entry) await mkdir(mount, { recursive: true })
    if (!(await lstat(mount)).isDirectory() || (await realpath(mount)) !== mount) {
      throw new Error(`Batshit sandbox mount is not a direct folder: ${mount}`)
    }
  }
  return mounts
}
