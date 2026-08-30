import os from 'node:os'
import { env } from '$env/dynamic/private'

/**
 * Effective default native execution (sandbox) backend for this Batshit runtime.
 *
 * Single source of truth shared by native tool dispatch (nativeTools.ts), the
 * server-side prompt compiler (databaseRedis.server.ts), and the user-settings
 * route, which exposes the current runtime default to Settings.
 *
 * Containerized installs always sandbox via Docker; native installs default to
 * Apple Container on macOS and Docker Sandbox elsewhere.
 */
export function resolveDefaultNativeExecutionBackend(): 'docker_sandbox' | 'apple_container' {
  if (env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_CONTAINERIZED === '1') {
    return 'docker_sandbox'
  }
  return os.platform() === 'darwin' ? 'apple_container' : 'docker_sandbox'
}
