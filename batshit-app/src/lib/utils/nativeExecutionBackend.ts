export type NativeExecutionBackend = 'local' | 'docker_sandbox' | 'apple_container'

export function normalizeNativeExecutionBackend(value: unknown): NativeExecutionBackend | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (
    normalized === 'docker_sandbox' ||
    normalized === 'docker-sandbox' ||
    normalized === 'sandbox' ||
    normalized === 'docker'
  ) {
    return 'docker_sandbox'
  }
  if (
    normalized === 'apple_container' ||
    normalized === 'apple-container' ||
    normalized === 'apple container' ||
    normalized === 'apple'
  ) {
    return 'apple_container'
  }
  if (normalized === 'local') return 'local'
  return null
}

/** The sandbox status fields the unavailable message reads (`/api/native-tools/sandbox/status`). */
export interface SandboxBackendStatusForMessage {
  available?: boolean
  installed?: boolean
  supported?: boolean
}

/**
 * What Agent Settings says when the selected sandbox backend is not available (BL-83), or null
 * when it is. Apple Container is `available` whenever its CLI is installed and answers, started or
 * not: since BL-62 the first sandboxed command starts a stopped system, so "not started yet" is a
 * plain note, not this message. Only a missing CLI, a CLI that does not answer, or a non-Mac make
 * Apple-backed runs fail.
 */
export function sandboxUnavailableMessage(
  backend: NativeExecutionBackend,
  status: SandboxBackendStatusForMessage | null | undefined
): string | null {
  if (status?.available === true) return null
  if (backend !== 'apple_container') {
    return 'Docker Sandbox is not available. Docker-backed Bash runs will fail safely until Docker Sandbox is ready.'
  }
  if (!status) {
    return 'Apple Container is not available. Apple-backed Bash runs will fail safely until it is.'
  }
  if (status.supported === false) {
    return 'Apple Container runs only on a Mac. Apple-backed Bash runs will fail safely here.'
  }
  if (status.installed === false) {
    return 'Apple Container is not installed. Apple-backed Bash runs will fail safely until it is installed.'
  }
  return 'Apple Container is installed but not answering. Apple-backed Bash runs will fail safely until it answers.'
}
