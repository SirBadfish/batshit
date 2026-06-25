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
