import os from 'node:os'
import path from 'node:path'
import { env } from '$env/dynamic/private'
import type { TypedFileToolsHost } from '$lib/utils/typedFileToolsGrant'
import { normalizeContainerizedDockerSandboxDriver } from '$lib/utils/dockerSandboxDriver'

/** Runtime facts only: no helper, sandbox, service or process is started by this status read. */
export function readTypedFileToolsHost(): TypedFileToolsHost {
  const platform = os.platform()
  const containerized = env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_CONTAINERIZED === '1' ||
    env.BATSHIT_RUNTIME_ENV === 'docker' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
  const configured = (name: keyof typeof env) => (env[name] ?? process.env[name])?.trim()
  const url = configured('BATSHIT_DOCKER_SANDBOX_OPERATOR_URL') || configured('BATSHIT_RUNTIME_ADDON_OPERATOR_URL')
  const token = configured('BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN') || configured('BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN')
  const hostRoot = configured('BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT')
  const containerRoot = configured('BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT') || '/workspace'
  const appRoot = configured('BATSHIT_WORKSPACE_CONTAINER_PATH') || '/workspace'
  let operatorUrlValid = false
  try { const parsed = new URL(url || ''); operatorUrlValid = ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password } catch {}
  return {
    platform,
    containerized,
    linuxKernel: platform === 'linux' ? os.release() : null,
    ...(containerized ? { dockerSandboxOperatorConfigured: Boolean(operatorUrlValid && token && hostRoot && path.posix.isAbsolute(hostRoot) && path.posix.isAbsolute(containerRoot) && path.posix.isAbsolute(appRoot) && path.posix.normalize(containerRoot) === path.posix.normalize(appRoot) && normalizeContainerizedDockerSandboxDriver(configured('BATSHIT_NATIVE_DOCKER_SANDBOX_DRIVER')) === 'operator') } : {})
  }
}
