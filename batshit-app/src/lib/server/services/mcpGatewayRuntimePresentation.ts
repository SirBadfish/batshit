import { env } from '$env/dynamic/private'
import type { MCPGateway } from '$lib/types/database'
import { buildDockerGatewayUpstreamUrl } from './dockerGatewayConfig'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const decorateMcpGatewayForRuntime = (gateway: MCPGateway): MCPGateway => {
  if (gateway.type !== 'docker-catalog') {
    return gateway
  }

  const containerized = env.BATSHIT_CONTAINERIZED === '1'
  const macRuntime = env.BATSHIT_RUNTIME_OWNER === 'mac-app'
  if (!containerized && !macRuntime) {
    return gateway
  }

  return {
    ...gateway,
    url: buildDockerGatewayUpstreamUrl('/mcp'),
    metadata: {
      ...(isRecord(gateway.metadata) ? gateway.metadata : {}),
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
