import { env } from '$env/dynamic/private'
import type { MCPGateway } from '$lib/types/database'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export const isContainerizedRuntime = (
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): boolean =>
  runtimeEnv.BATSHIT_CONTAINERIZED === '1' ||
  (runtimeEnv === env && process.env.BATSHIT_CONTAINERIZED === '1')

const normalizeBaseUrl = (raw?: string | null): URL | null => {
  const trimmed = raw?.trim()
  if (!trimmed) return null

  try {
    return new URL(trimmed)
  } catch {
    return null
  }
}

const isLoopbackUrl = (raw?: string | null): boolean => {
  const parsed = normalizeBaseUrl(raw)
  return Boolean(parsed && LOOPBACK_HOSTS.has(parsed.hostname))
}

const replaceOrigin = (rawUrl: string, baseUrl: URL): string => {
  const parsed = new URL(rawUrl)
  parsed.protocol = baseUrl.protocol
  parsed.hostname = baseUrl.hostname
  parsed.port = baseUrl.port
  return parsed.toString()
}

const joinUrlPath = (baseUrl: URL, pathname: string): string => {
  const next = new URL(baseUrl.toString())
  next.pathname = pathname
  next.search = ''
  next.hash = ''
  return next.toString().replace(/\/$/, '')
}

const formatRuntimeUrl = (url: URL): string => {
  const formatted = url.toString()
  if (url.pathname === '/' && !url.search && !url.hash) {
    return formatted.replace(/\/$/, '')
  }
  return formatted
}

const canonicalizeHttpLoopbackForNodeRuntime = (rawUrl: string | undefined): string | undefined => {
  if (!rawUrl) return rawUrl

  try {
    const parsed = new URL(rawUrl)
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' ||
        parsed.hostname === '::1' ||
        parsed.hostname === '[::1]')
    ) {
      parsed.hostname = '127.0.0.1'
      return formatRuntimeUrl(parsed)
    }
  } catch {
    return rawUrl
  }

  return rawUrl
}

const BATSHIT_CALLBACK_URL_KEYS = [
  'batshit_frontend_url',
  'batshitFrontendUrl',
  'batshit_sse_endpoint',
  'batshitSseEndpoint',
  'batshit_artifact_complete_url',
  'batshitArtifactCompleteUrl'
] as const

const canonicalizeBatshitCallbackLoopbackForNodeRuntime = <T extends Record<string, any>>(
  payload: T
): T => {
  const next: Record<string, any> = { ...payload }

  for (const key of BATSHIT_CALLBACK_URL_KEYS) {
    if (typeof next[key] === 'string') {
      next[key] = canonicalizeHttpLoopbackForNodeRuntime(next[key])
    }
  }

  return next as T
}

export const resolveRuntimeN8nBaseUrl = (
  savedN8nApiUrl?: string | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string | null => {
  const envConfiguredUrl =
    runtimeEnv.N8N_API_URL?.trim() ||
    runtimeEnv.N8N_URL?.trim() ||
    runtimeEnv.N8N_BASE_URL?.trim()

  if (isContainerizedRuntime(runtimeEnv)) {
    const savedUrl = savedN8nApiUrl?.trim() || null
    const envBase = normalizeBaseUrl(envConfiguredUrl)
    const savedBase = normalizeBaseUrl(savedUrl)

    if (envBase?.hostname === 'n8n') {
      return envConfiguredUrl ?? null
    }

    if (savedUrl && savedBase && !LOOPBACK_HOSTS.has(savedBase.hostname)) {
      return savedUrl
    }

    return envConfiguredUrl || savedUrl || 'http://host.docker.internal:5678'
  }

  return savedN8nApiUrl?.trim() || envConfiguredUrl || null
}

export const rewriteLoopbackUrlForRuntimeBase = (
  rawUrl: string | undefined | null,
  runtimeBaseUrl: string | undefined | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string | undefined => {
  if (!rawUrl) return rawUrl ?? undefined
  if (!isContainerizedRuntime(runtimeEnv)) return rawUrl
  if (!isLoopbackUrl(rawUrl)) return rawUrl

  const base = normalizeBaseUrl(runtimeBaseUrl)
  if (!base) return rawUrl

  try {
    return replaceOrigin(rawUrl, base)
  } catch {
    return rawUrl
  }
}

export const rewriteN8nWebhookUrlForRuntime = (
  rawWebhookUrl: string | undefined | null,
  savedN8nApiUrl?: string | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string | undefined => {
  return rewriteLoopbackUrlForRuntimeBase(
    rawWebhookUrl,
    resolveRuntimeN8nBaseUrl(savedN8nApiUrl, runtimeEnv),
    runtimeEnv
  )
}

export const resolveBrowserN8nWebhookBaseUrl = (
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string | null => {
  if (!isContainerizedRuntime(runtimeEnv)) return null

  const explicitWebhookUrl = runtimeEnv.N8N_WEBHOOK_URL?.trim()
  if (explicitWebhookUrl) return explicitWebhookUrl

  const publicWebhookUrl = runtimeEnv.WEBHOOK_URL?.trim()
  if (publicWebhookUrl) return publicWebhookUrl

  const editorUrl = runtimeEnv.N8N_EDITOR_BASE_URL?.trim()
  if (editorUrl) return editorUrl

  return null
}

export const rewriteN8nWebhookUrlForBrowserRuntime = (
  rawWebhookUrl: string | undefined | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string | undefined => {
  if (!rawWebhookUrl) return rawWebhookUrl ?? undefined
  if (!isContainerizedRuntime(runtimeEnv)) return rawWebhookUrl
  if (!isLoopbackUrl(rawWebhookUrl)) return rawWebhookUrl

  const browserWebhookBase = normalizeBaseUrl(resolveBrowserN8nWebhookBaseUrl(runtimeEnv))
  if (!browserWebhookBase) return rawWebhookUrl

  try {
    return replaceOrigin(rawWebhookUrl, browserWebhookBase)
  } catch {
    return rawWebhookUrl
  }
}

export const rewriteLoopbackUrlToDockerHostForRuntime = (
  rawUrl: string | undefined | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string | undefined => {
  if (!rawUrl) return rawUrl ?? undefined
  if (!isContainerizedRuntime(runtimeEnv)) return rawUrl
  if (!isLoopbackUrl(rawUrl)) return rawUrl

  try {
    const parsed = new URL(rawUrl)
    parsed.hostname = runtimeEnv.BATSHIT_DOCKER_HOST_GATEWAY_HOST?.trim() || 'host.docker.internal'
    return parsed.toString()
  } catch {
    return rawUrl
  }
}

export const shouldUseInternalBatshitCallbacksForN8n = (
  runtimeN8nBaseUrl: string | undefined | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): boolean => {
  if (!isContainerizedRuntime(runtimeEnv)) return false
  const parsed = normalizeBaseUrl(runtimeN8nBaseUrl)
  return parsed?.hostname === 'n8n'
}

export const resolveInternalBatshitCallbackBaseUrl = (
  runtimeN8nBaseUrl: string | undefined | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string | null => {
  if (!shouldUseInternalBatshitCallbacksForN8n(runtimeN8nBaseUrl, runtimeEnv)) {
    return null
  }

  return (
    runtimeEnv.BATSHIT_N8N_CALLBACK_BASE_URL?.trim() ||
    runtimeEnv.BATSHIT_FRONTEND_URL?.trim() ||
    'http://app:3000'
  )
}

export const rewriteBatshitCallbackUrlsForN8nRuntime = <T extends Record<string, any>>(
  payload: T | null | undefined,
  runtimeN8nBaseUrl: string | undefined | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): T | null | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload

  const callbackBase = normalizeBaseUrl(
    resolveInternalBatshitCallbackBaseUrl(runtimeN8nBaseUrl, runtimeEnv)
  )
  if (!callbackBase) {
    return canonicalizeBatshitCallbackLoopbackForNodeRuntime(payload)
  }

  return canonicalizeBatshitCallbackLoopbackForNodeRuntime({
    ...payload,
    batshit_frontend_url: joinUrlPath(callbackBase, ''),
    batshitFrontendUrl: joinUrlPath(callbackBase, ''),
    batshit_sse_endpoint: joinUrlPath(callbackBase, '/api/sse'),
    batshitSseEndpoint: joinUrlPath(callbackBase, '/api/sse'),
    batshit_artifact_complete_url: joinUrlPath(callbackBase, '/api/artifacts/complete'),
    batshitArtifactCompleteUrl: joinUrlPath(callbackBase, '/api/artifacts/complete')
  })
}

export const rewriteN8nGatewayUrlForRuntime = (
  gateway: MCPGateway,
  savedN8nApiUrl?: string | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): MCPGateway => {
  if (
    gateway.type !== 'n8n-mcp-trigger' &&
    gateway.type !== 'n8n-instance-mcp' &&
    gateway.type !== 'n8n-mcp-client'
  ) {
    return gateway
  }

  const rewrittenUrl = rewriteLoopbackUrlForRuntimeBase(
    gateway.url,
    resolveRuntimeN8nBaseUrl(savedN8nApiUrl, runtimeEnv),
    runtimeEnv
  )

  return rewrittenUrl && rewrittenUrl !== gateway.url
    ? { ...gateway, url: rewrittenUrl }
    : gateway
}
