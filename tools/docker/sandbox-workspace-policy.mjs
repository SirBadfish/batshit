// Host-only workspace admission shared by the read-only typed-tool handshake and actual sbx
// preparation. Configuration is trusted operator state; request roots are comparison claims.
import os from 'node:os'
import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import custody from '../../batshit-server/server/src/utils/macCustodyPaths.cjs'
import homePolicy from '../../batshit-app/src/lib/server/services/sandboxHomePolicy.json' with { type: 'json' }
import { sbxWorkspaceMounts } from './sbx-cli.mjs'

const { assertCredentialMountsSafe, credentialCustodyRoots, resolveExistingPath } = custody
const ADMISSION_KEYS = ['v', 'workspaceRoot', 'cwd', 'expectedContainerRoot', 'expectedHostRoot']

function pathText(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > 4096 ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a bounded path string.`)
  }
  return value
}

function absoluteHostPath(value, label) {
  pathText(value, label)
  if (!path.isAbsolute(value)) throw new Error(`${label} must name an absolute host folder.`)
  return path.resolve(value)
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function containerPath(value, containerRoot, label) {
  pathText(value, label)
  if (!path.posix.isAbsolute(value) || value.includes('\\')) {
    throw new Error(`${label} must be an absolute container path under ${containerRoot}.`)
  }
  const normalized = path.posix.normalize(value)
  const relative = path.posix.relative(containerRoot, normalized)
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error(`${label} must be under ${containerRoot}; received ${value}.`)
  }
  return normalized
}

/** Exact versioned handshake input, never an override of operator configuration. */
export function validateWorkspaceAdmissionRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== ADMISSION_KEYS.length ||
      !ADMISSION_KEYS.every((key) => Object.hasOwn(value, key)) || value.v !== 1) {
    throw new Error('Workspace admission requires exactly v:1, workspaceRoot, cwd, expectedContainerRoot and expectedHostRoot.')
  }
  for (const key of ADMISSION_KEYS.slice(1)) pathText(value[key], key)
  return value
}

/** The known host credential stores, including the normal Mac app even for a Docker operator. */
function credentialViews(environment) {
  const views = [environment]
  if (process.platform === 'darwin') {
    const mac = { ...environment, BATSHIT_RUNTIME_OWNER: 'mac-app', BATSHIT_CONTAINERIZED: '0', BATSHIT_RUNTIME_ENV: '' }
    views.push(mac)
    // A configured review/alternate app must not unprotect the normal app's default store.
    if (environment.BATSHIT_MAC_DATA_DIR) views.push({ ...mac, BATSHIT_MAC_DATA_DIR: '' })
  }
  return views
}

function protectedHostRoots(environment) {
  const shared = path.join(os.homedir(), '.batshit')
  const configured = environment.BATSHIT_HOME_DIR?.trim() || environment.BATSHIT_HOST_RUNTIME_ROOT?.trim()
  const home = configured ? absoluteHostPath(configured, 'Batshit sandbox home') : shared
  const runtime = environment.BATSHIT_AGENT_RUNTIME_ROOT?.trim()
  const agents = path.join(runtime ? absoluteHostPath(runtime, 'Batshit agent runtime root') : home, 'agents')
  const external = environment.BATSHIT_SANDBOX_PROTECTED_HOME_DIR?.trim()
  const homes = [home, shared, ...(external ? [absoluteHostPath(external, 'Protected Batshit home')] : [])]
  const roots = [agents, ...homes.flatMap((root) => homePolicy.protectedDirs.map((name) => path.join(root, name)))]
  for (const view of credentialViews(environment)) {
    // Metadata of known credential paths only: no credential content or arbitrary tree scan.
    assertCredentialMountsSafe(view)
    roots.push(...credentialCustodyRoots(view))
  }
  return [...new Set(roots)]
}

/** Missing protected leaves still resolve through aliased parents; non-ENOENT never falls back. */
export async function assertHostSandboxMountsSafe(mounts, environment = process.env) {
  const actualMounts = await Promise.all(mounts.map(async (mount) => {
    const resolved = await realpath(mount)
    if (!(await stat(resolved)).isDirectory()) throw new Error('Sandbox mount source must be an existing directory.')
    return resolved
  }))
  for (const protectedRoot of protectedHostRoots(environment)) {
    const resolved = resolveExistingPath(protectedRoot)
    if ([protectedRoot, resolved].some((root) => actualMounts.some((mount) => inside(mount, root) || inside(root, mount)))) {
      throw new Error('Sandbox workspace exposes managed agent homes, credential storage or protected runtime/Pinokio data.')
    }
  }
}

async function directory(value, label) {
  const resolved = await realpath(value)
  if (!(await stat(resolved)).isDirectory()) throw new Error(`${label} is not a directory.`)
  return resolved
}

/**
 * Canonical host mapping. The handshake forbids the legacy host-namespace shortcut; actual
 * execution retains it for existing callers, but every path still gets the same strict policy.
 */
export async function resolveOperatorWorkspaceMapping({
  operatorRoot,
  containerRoot: configuredContainerRoot,
  hostRoot: configuredHostRootRaw,
  workspaceRoot,
  cwd,
  expectedContainerRoot,
  expectedHostRoot,
  containerNamespaceOnly = false,
  environment = process.env
}) {
  const containerRoot = path.posix.normalize(pathText(configuredContainerRoot, 'Configured container root'))
  if (!path.posix.isAbsolute(containerRoot) || containerRoot.includes('\\')) throw new Error('Configured container workspace root must be an absolute POSIX path.')
  if (typeof configuredHostRootRaw !== 'string' || !configuredHostRootRaw.trim()) {
    throw new Error('Docker Sandbox operator requires BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT or BATSHIT_WORKSPACE_MOUNT so /workspace can map to a real host directory.')
  }
  const configuredHostRoot = path.resolve(operatorRoot, pathText(configuredHostRootRaw, 'Configured host root'))
  if (containerNamespaceOnly && (expectedContainerRoot !== containerRoot || expectedHostRoot !== configuredHostRoot)) {
    throw new Error('Workspace admission configuration does not match the operator\'s trusted container/host roots.')
  }
  const hostRoot = await directory(configuredHostRoot, 'Sandbox host workspace root')
  const requestedWorkspaceRoot = workspaceRoot || containerRoot
  const requestedCwd = cwd || requestedWorkspaceRoot
  const mapOne = async (value, label) => {
    pathText(value, label)
    // Preserve the existing execution contract too: request paths use the POSIX namespace,
    // including on Windows. A native drive path never becomes a new accepted shortcut.
    if (!path.posix.isAbsolute(value)) throw new Error(`${label} must be an absolute path inside ${containerRoot}.`)
    let mapped
    if (!containerNamespaceOnly && path.isAbsolute(value) && inside(path.resolve(value), hostRoot)) {
      mapped = path.resolve(value)
    } else {
      const normalized = containerPath(value, containerRoot, label)
      mapped = path.resolve(hostRoot, path.posix.relative(containerRoot, normalized))
    }
    const resolved = await directory(mapped, label)
    if (!inside(resolved, hostRoot)) throw new Error(`${label} maps outside the sandbox host workspace root.`)
    return resolved
  }
  const hostWorkspaceRoot = await mapOne(requestedWorkspaceRoot, 'workspaceRoot')
  const hostCwd = await mapOne(requestedCwd, 'cwd')
  if (!inside(hostCwd, hostWorkspaceRoot)) throw new Error('cwd must stay inside workspaceRoot after host workspace mapping.')
  await assertHostSandboxMountsSafe(sbxWorkspaceMounts({ workspaceRoot: hostWorkspaceRoot }), environment)
  return { requestedWorkspaceRoot, requestedCwd, containerRoot, configuredHostRoot, hostRoot, hostWorkspaceRoot, hostCwd }
}
