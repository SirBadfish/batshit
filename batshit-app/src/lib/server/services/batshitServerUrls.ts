import { env as privateEnv } from '$env/dynamic/private'

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function resolvePrivateEnvValue(key: string) {
  return privateEnv[key] || process.env[key]
}

function resolvePublicBatshitServerUrl() {
  return process.env.PUBLIC_BATSHIT_SERVER_URL || privateEnv.PUBLIC_BATSHIT_SERVER_URL
}

export function getInternalBatshitServerUrl() {
  return trimTrailingSlash(
    resolvePrivateEnvValue('BATSHIT_SERVER_URL') ||
      resolvePublicBatshitServerUrl() ||
      'http://localhost:5600'
  )
}

/**
 * Service-token headers for server-to-server calls into batshit-server.
 * Every batshit-server `/api` and `/api/v1` route requires this token;
 * browser features reach those routes only through session-authed app proxy
 * routes that attach these headers. Fails loudly when the token is missing —
 * an unauthenticated internal call would be silently rejected downstream.
 */
export function getInternalBatshitServerAuthHeaders(): Record<string, string> {
  const token =
    resolvePrivateEnvValue('BATSHIT_TOKEN') || resolvePrivateEnvValue('MCP_GATEWAY_AUTH_TOKEN')
  if (!token) {
    throw new Error(
      'BATSHIT_TOKEN is not configured; internal batshit-server calls require the service token'
    )
  }
  return { 'x-batshit-service-token': token }
}

export function getInternalBatshitServerApiUrl() {
  return trimTrailingSlash(
    resolvePrivateEnvValue('BATSHIT_SERVER_API_URL') || `${getInternalBatshitServerUrl()}/api/v1`
  )
}

export function getInternalBatshitServerTaskUrl() {
  return `${getInternalBatshitServerApiUrl()}/task/s`
}

export function getPublicBatshitServerUrl() {
  return trimTrailingSlash(
    resolvePublicBatshitServerUrl() ||
      resolvePrivateEnvValue('BATSHIT_SERVER_URL') ||
      'http://localhost:5600'
  )
}

export function rewriteInternalBatshitServerUrlToPublic(rawUrl: string) {
  let parsedRaw: URL
  let parsedInternal: URL
  let parsedPublic: URL

  try {
    parsedRaw = new URL(rawUrl)
    parsedInternal = new URL(getInternalBatshitServerUrl())
    parsedPublic = new URL(getPublicBatshitServerUrl())
  } catch {
    return rawUrl
  }

  if (parsedRaw.origin !== parsedInternal.origin) {
    return rawUrl
  }

  parsedRaw.protocol = parsedPublic.protocol
  parsedRaw.host = parsedPublic.host
  return parsedRaw.toString()
}

export function rewriteInternalBatshitServerUrlsInPayload<T>(value: T): T {
  if (typeof value === 'string') {
    return rewriteInternalBatshitServerUrlToPublic(value) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteInternalBatshitServerUrlsInPayload(item)) as T
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewriteInternalBatshitServerUrlsInPayload(item)
      ])
    ) as T
  }

  return value
}
