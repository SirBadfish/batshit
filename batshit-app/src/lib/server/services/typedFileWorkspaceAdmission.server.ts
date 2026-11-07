import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { env } from '$env/dynamic/private'

const configured = (name: keyof typeof env) => (env[name] ?? process.env[name])?.trim()

/** Filesystem authority belongs to the app workspace mount, not the operator namespace setting. */
export function typedAppWorkspaceRoot(): string {
  const value = configured('BATSHIT_WORKSPACE_CONTAINER_PATH') || '/workspace'
  if (!path.posix.isAbsolute(value) || value.includes('\0')) throw new Error('The app workspace mount must be an absolute folder.')
  return path.posix.normalize(value)
}

/** Operator namespace only; it never selects which app files may be accessed. */
export function typedContainerWorkspaceRoot(): string {
  const value = configured('BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT') || '/workspace'
  if (!path.posix.isAbsolute(value) || value.includes('\0')) throw new Error('The operator container namespace must be an absolute folder.')
  return path.posix.normalize(value)
}

export function typedHostWorkspaceRoot(): string {
  const value = configured('BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT')
  if (!value || !path.posix.isAbsolute(value) || value.includes('\0')) {
    throw new Error('Docker Sandbox needs a configured host bind workspace; a private Docker workspace volume cannot be mapped to the host sandbox.')
  }
  return path.posix.normalize(value)
}

export interface TypedContainerWorkspacePlan {
  workspaceRoot: string
  cwd: string
  realRoot: string
  realCwd: string
}

export const pathWithinTypedWorkspace = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** The primitive's actual plan, checked before helper admission for Local and Docker alike. */
export async function assertTypedContainerWorkspace(plan: TypedContainerWorkspacePlan, backend?: string): Promise<void> {
  const configuredRoot = typedAppWorkspaceRoot()
  if (backend === 'docker_sandbox' && typedContainerWorkspaceRoot() !== configuredRoot) {
    throw new Error('Docker Sandbox operator namespace must match the actual app workspace mount.')
  }
  const realMountRoot = await realpath(configuredRoot)
  if (!pathWithinTypedWorkspace(path.resolve(plan.workspaceRoot), configuredRoot) ||
      !pathWithinTypedWorkspace(path.resolve(plan.cwd), configuredRoot) ||
      !pathWithinTypedWorkspace(plan.realRoot, realMountRoot) ||
      !pathWithinTypedWorkspace(plan.realCwd, realMountRoot) ||
      !pathWithinTypedWorkspace(plan.realCwd, plan.realRoot)) {
    throw new Error('Typed file tools must stay inside the app container workspace and its admitted project folder.')
  }
}
