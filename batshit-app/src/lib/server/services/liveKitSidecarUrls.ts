export type LiveKitSidecarUrlEnv = Record<string, string | undefined>

const DEFAULT_BATSHIT_APP_PORT = '5620'

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function resolveLiveKitSidecarBatshitBaseUrl(
  source: LiveKitSidecarUrlEnv
): string {
  const explicit =
    cleanString(source.LIVEKIT_AGENT_BATSHIT_BASE_URL) ||
    cleanString(source.LIVEKIT_AGENT_BATSHIT_URL) ||
    cleanString(source.BATSHIT_FRONTEND_URL) ||
    cleanString(source.PUBLIC_BASE_URL) ||
    cleanString(source.ORIGIN) ||
    cleanString(source.BATSHIT_APP_URL)

  if (explicit) return explicit.replace(/\/+$/, '')

  const port = cleanString(source.BATSHIT_FRONTEND_PORT) || DEFAULT_BATSHIT_APP_PORT
  return `http://localhost:${port}`
}
