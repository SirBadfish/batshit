import { env } from '$env/dynamic/private'

/** Which lookup step produced the resolved CLI executable. */
export type CliResolutionSource = 'env' | 'managed' | 'path' | 'well-known' | 'not-found'

export interface CliExecutableResolution {
  executable: string
  source: CliResolutionSource
  managedVersion?: string
}

/** The folder Docker Compose commands shown to the user run from, when the env names one. */
export function resolveDockerComposeWorkingDirectory(
  sourceEnv: Record<string, string | undefined> = env
): string | undefined {
  const candidates = [
    sourceEnv.BATSHIT_DOCKER_PROJECT_DIR,
    sourceEnv.BATSHIT_COMPOSE_PROJECT_DIR,
    sourceEnv.BATSHIT_WORKSPACE_MOUNT
  ]

  for (const candidate of candidates) {
    const value = unwrapEnvPath(candidate)
    if (value) return value
  }

  return undefined
}

function unwrapEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined
  }
  return trimmed
}
