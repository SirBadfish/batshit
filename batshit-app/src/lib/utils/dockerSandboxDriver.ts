export type ContainerizedDockerSandboxDriver = 'operator' | 'local-cli' | 'disabled'

/** One pure decision for the native adapter and typed-tool configuration facts. */
export function normalizeContainerizedDockerSandboxDriver(value: unknown): ContainerizedDockerSandboxDriver {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'local-cli') return 'local-cli'
  if (['disabled', 'disable', 'off', 'none', 'unavailable'].includes(raw)) return 'disabled'
  return 'operator'
}
