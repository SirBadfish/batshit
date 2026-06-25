import { beforeEach, describe, expect, it, vi } from 'vitest'

const dynamicPrivateEnv = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>
}))

vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)

describe('mcpGatewayRuntimePresentation', () => {
  let module: typeof import('../mcpGatewayRuntimePresentation')

  beforeEach(async () => {
    for (const key of Object.keys(dynamicPrivateEnv.env)) {
      delete dynamicPrivateEnv.env[key]
    }
    module = await import('../mcpGatewayRuntimePresentation')
  })

  const dockerGateway = {
    id: 'gateway-1',
    name: 'Docker MCP Gateway',
    type: 'docker-catalog',
    url: 'http://localhost:8080/mcp',
    enabled: true,
    discoveredTools: [],
    metadata: { dockerProfile: 'batshit' }
  } as any

  it('leaves source-checkout Docker gateway rows editable', () => {
    const decorated = module.decorateMcpGatewayForRuntime(dockerGateway)

    expect(decorated).toBe(dockerGateway)
  })

  it('decorates Docker runtime rows with the container-reachable URL and locks profile editing', () => {
    dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'
    dynamicPrivateEnv.env.DOCKER_MCP_GATEWAY_PORT = '5608'

    const decorated = module.decorateMcpGatewayForRuntime(dockerGateway)

    expect(decorated.url).toBe('http://host.docker.internal:5608/mcp')
    expect(decorated.metadata).toMatchObject({
      runtimeManagedUrl: true,
      runtimeManagedProfile: true,
      runtimeManagedUrlReason: 'containerized-docker-gateway',
      storedUrl: 'http://localhost:8080/mcp'
    })
  })

  it('decorates Mac runtime rows with the Mac-owned URL while keeping profile editing available', () => {
    dynamicPrivateEnv.env.BATSHIT_RUNTIME_OWNER = 'mac-app'
    dynamicPrivateEnv.env.DOCKER_MCP_GATEWAY_PORT = '8080'

    const decorated = module.decorateMcpGatewayForRuntime(dockerGateway)

    expect(decorated.url).toBe('http://localhost:8080/mcp')
    expect(decorated.metadata).toMatchObject({
      runtimeManagedUrl: true,
      runtimeManagedProfile: false,
      runtimeManagedUrlReason: 'mac-app-docker-gateway',
      storedUrl: 'http://localhost:8080/mcp'
    })
  })
})
