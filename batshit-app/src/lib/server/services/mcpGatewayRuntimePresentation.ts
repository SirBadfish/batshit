import { env } from '$env/dynamic/private'
import type { MCPGateway } from '$lib/types/database'
import { buildDockerGatewayUpstreamUrl } from './dockerGatewayConfig'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The keys this presenter sets; a stored copy (older card saves sent them back) is never current. */
const RUNTIME_PRESENTATION_KEYS = [
  'runtimeManagedUrl',
  'runtimeManagedProfile',
  'storedUrl',
  'runtimeManagedUrlReason'
] as const

/** A new record without those keys; `metadata` itself is not changed. */
const withoutRuntimePresentation = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const rest = { ...metadata }
  for (const key of RUNTIME_PRESENTATION_KEYS) delete rest[key]
  return rest
}

/**
 * BL-1413: a Docker gateway's presentation comes only from the runtime this server is in. Stored
 * presentation keys are left out of the returned copy (the stored record is not changed), so a record
 * restored onto a source checkout is not shown as runtime-managed; a stored `storedUrl` is never read.
 */
export const decorateMcpGatewayForRuntime = (gateway: MCPGateway): MCPGateway => {
  if (gateway.type !== 'docker-catalog') {
    return gateway
  }

  const containerized = env.BATSHIT_CONTAINERIZED === '1'
  const macRuntime = env.BATSHIT_RUNTIME_OWNER === 'mac-app'
  if (!containerized && !macRuntime) {
    const metadata = gateway.metadata
    if (!isRecord(metadata) || !RUNTIME_PRESENTATION_KEYS.some((key) => key in metadata)) return gateway
    return { ...gateway, metadata: withoutRuntimePresentation(metadata) }
  }

  return {
    ...gateway,
    url: buildDockerGatewayUpstreamUrl('/mcp'),
    metadata: {
      ...(isRecord(gateway.metadata) ? withoutRuntimePresentation(gateway.metadata) : {}),
      runtimeManagedUrl: true,
      runtimeManagedProfile: containerized,
      storedUrl: gateway.url,
      runtimeManagedUrlReason: containerized
        ? 'containerized-docker-gateway'
        : 'mac-app-docker-gateway'
    }
  }
}

export const decorateMcpGatewaysForRuntime = (gateways: MCPGateway[]): MCPGateway[] =>
  gateways.map(decorateMcpGatewayForRuntime)

/**
 * BL-1398: a COPY without `metadata.authToken` (a legacy token of any gateway type) for a browser
 * response. No screen reads it; the stored record keeps it for the token migration and the server
 * consumers (profile headers, discovery), which read Redis, never a response.
 */
export const redactGatewaySecretsForBrowser = (gateway: MCPGateway): MCPGateway => {
  if (!isRecord(gateway.metadata) || !('authToken' in gateway.metadata)) return gateway
  const { authToken: _token, ...metadata } = gateway.metadata
  return { ...gateway, metadata }
}

/** What a gateway route answers: the runtime presentation, then the browser redaction. */
export const presentMcpGatewayForBrowser = (gateway: MCPGateway): MCPGateway =>
  redactGatewaySecretsForBrowser(decorateMcpGatewayForRuntime(gateway))

export const presentMcpGatewaysForBrowser = (gateways: MCPGateway[]): MCPGateway[] =>
  gateways.map(presentMcpGatewayForBrowser)
