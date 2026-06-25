import { env } from '$env/dynamic/private'
import { logger } from '$lib/utils/logger'

const DEFAULT_GATEWAY_URL = 'http://localhost:8080'
const DEFAULT_CONTAINER_GATEWAY_URL = 'http://host.docker.internal:8080'
const DEFAULT_CONTAINER_PROXY_PATH = '/api/mcp/gateway/proxy'
const CONTAINER_HOST_GATEWAY = 'host.docker.internal'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

const urlFromPort = (rawPort?: string, host = 'localhost'): string | undefined => {
  const port = rawPort?.trim()
  if (!port || !/^\d+$/.test(port)) {
    return undefined
  }

  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return undefined
  }

  return `http://${host}:${numericPort}`
}

const normalizeBaseUrl = (
  raw?: string,
  fallback = DEFAULT_GATEWAY_URL,
  options: { containerized?: boolean } = {}
): string => {
  if (!raw) {
    return fallback
  }

  try {
    const url = new URL(raw)
    if (options.containerized && LOOPBACK_HOSTS.has(url.hostname)) {
      url.hostname = CONTAINER_HOST_GATEWAY
    }
    const origin = `${url.protocol}//${url.host}`
    return origin.replace(/\/+$/, '')
  } catch {
    return raw.replace(/\/+$/, '') || fallback
  }
}

export const resolveDockerGatewayBaseUrl = (
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string => {
  const containerized = runtimeEnv.BATSHIT_CONTAINERIZED === '1'
  const fallback =
    containerized ? DEFAULT_CONTAINER_GATEWAY_URL : DEFAULT_GATEWAY_URL
  const portHost = containerized ? CONTAINER_HOST_GATEWAY : 'localhost'

  return normalizeBaseUrl(
    urlFromPort(runtimeEnv.DOCKER_MCP_GATEWAY_PORT, portHost) ||
      runtimeEnv.DOCKER_MCP_GATEWAY_URL ||
      runtimeEnv.DOCKER_MCP_URL ||
      runtimeEnv.MCP_GATEWAY_URL ||
      runtimeEnv.PUBLIC_DOCKER_MCP_GATEWAY_URL,
    fallback,
    { containerized }
  )
}

export const getDockerGatewayBaseUrl = (): string =>
  resolveDockerGatewayBaseUrl(env)

export const shouldUseDockerGatewayProxy = (
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): boolean => {
  if (runtimeEnv.BATSHIT_CONTAINERIZED !== '1') return false
  const disabled = runtimeEnv.DOCKER_MCP_GATEWAY_PROXY_DISABLED?.trim().toLowerCase()
  return !['1', 'true', 'yes', 'on'].includes(disabled ?? '')
}

const getContainerProxyBaseUrl = (
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string => {
  const explicit = runtimeEnv.DOCKER_MCP_GATEWAY_PROXY_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const port = runtimeEnv.PORT?.trim() || '3000'
  return `http://127.0.0.1:${port}${DEFAULT_CONTAINER_PROXY_PATH}`
}

export const buildDockerGatewayUpstreamUrl = (
  path = '/mcp',
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string => {
  const base = resolveDockerGatewayBaseUrl(runtimeEnv)
  if (!path) {
    return base
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalizedPath}`
}

export const buildDockerGatewayUrl = (
  path = '/mcp',
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string => {
  if (shouldUseDockerGatewayProxy(runtimeEnv)) {
    const proxyBase = getContainerProxyBaseUrl(runtimeEnv)
    if (!path) return proxyBase
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    return `${proxyBase}${normalizedPath}`
  }

  return buildDockerGatewayUpstreamUrl(path, runtimeEnv)
}

export const getDockerGatewayAuthToken = (): string | undefined =>
  env.MCP_GATEWAY_AUTH_TOKEN ||
  env.DOCKER_MCP_AUTH_TOKEN ||
  env.DOCKER_MCP_GATEWAY_TOKEN

const logOnce = (() => {
  let done = false
  return (token?: string) => {
    if (done) return
    done = true
    const masked = token ? `${token.slice(0,4)}…${token.slice(-4)}` : 'missing'
    logger.debug(`[DockerGatewayConfig] Using MCP token (env): ${masked}`)
  }
})()

type HeadersInitLike =
  | Headers
  | Record<string, string>
  | Array<[string, string]>
  | undefined

const normalizeHeaders = (headers?: HeadersInitLike): Record<string, string> => {
  if (!headers) {
    return {}
  }

  if (headers instanceof Headers) {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
      record[key] = value
    })
    return record
  }

  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((acc, [key, value]) => {
      acc[key] = value
      return acc
    }, {})
  }

  return { ...headers }
}

export const buildDockerGatewayHeaders = (
  headers?: HeadersInitLike
): Record<string, string> => {
  const normalized = normalizeHeaders(headers)
  const token = getDockerGatewayAuthToken()
  logOnce(token)

  if (
    token &&
    !normalized.Authorization &&
    !normalized.authorization
  ) {
    normalized.Authorization = `Bearer ${token}`
  }

  return normalized
}
