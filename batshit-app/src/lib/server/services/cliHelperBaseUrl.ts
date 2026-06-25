import { env } from '$env/dynamic/private'

const DEFAULT_NATIVE_BASE_URL = 'http://localhost:5620'
const DEFAULT_CONTAINER_BASE_URL = 'http://127.0.0.1:3000'

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const clean = (value?: string | null): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimTrailingSlash(trimmed) : null
}

export function resolveCliHelperBatshitBaseUrl(
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string {
  const explicit =
    clean(runtimeEnv.BATSHIT_CLI_HELPER_BASE_URL) ||
    clean(runtimeEnv.BATSHIT_INTERNAL_APP_URL)
  if (explicit) return explicit

  if (runtimeEnv.BATSHIT_CONTAINERIZED === '1') {
    const port = clean(runtimeEnv.PORT)
    return port ? `http://127.0.0.1:${port}` : DEFAULT_CONTAINER_BASE_URL
  }

  return (
    clean(runtimeEnv.BATSHIT_FRONTEND_URL) ||
    clean(runtimeEnv.PUBLIC_BASE_URL) ||
    clean(runtimeEnv.ORIGIN) ||
    DEFAULT_NATIVE_BASE_URL
  )
}
