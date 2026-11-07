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
