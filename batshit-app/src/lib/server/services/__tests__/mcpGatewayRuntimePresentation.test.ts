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

    // The Mac app's gateway listens on 127.0.0.1 only (2026-09-25).
    expect(decorated.url).toBe('http://127.0.0.1:8080/mcp')
    expect(decorated.metadata).toMatchObject({
      runtimeManagedUrl: true,
      runtimeManagedProfile: false,
      runtimeManagedUrlReason: 'mac-app-docker-gateway',
      storedUrl: 'http://localhost:8080/mcp'
    })
  })

  describe('BL-1413: stored presentation flags never pass for the current runtime', () => {
    // What an older card save stored: the containerized presentation, copied into the saved metadata.
    const staleDockerGateway = () =>
      ({
        ...dockerGateway,
        url: 'http://localhost:9999/mcp',
        metadata: {
          dockerProfile: 'work',
          note: 'kept',
          authToken: 'legacy-token',
          runtimeManagedUrl: true,
          runtimeManagedProfile: true,
          storedUrl: 'http://stale.example:1234/mcp',
          runtimeManagedUrlReason: 'containerized-docker-gateway'
        }
      }) as any

    // The card's own checks (GatewayInlineSettingsCards.svelte isRuntimeManagedDocker*).
    const cardLocksUrl = (gateway: any) =>
      gateway.type === 'docker-catalog' && gateway.metadata?.runtimeManagedUrl === true
    const cardLocksProfile = (gateway: any) =>
      gateway.type === 'docker-catalog' && gateway.metadata?.runtimeManagedProfile === true

    it('changes: outside a managed runtime a Docker copy drops all four stored flags, keeps the stored URL and the other keys, and the card is not locked', () => {
      const stored = staleDockerGateway()
      const before = structuredClone(stored)

      const decorated = module.decorateMcpGatewayForRuntime(stored)

      expect(cardLocksUrl(decorated)).toBe(false)
      expect(cardLocksProfile(decorated)).toBe(false)
      expect(decorated.metadata).toStrictEqual({ dockerProfile: 'work', note: 'kept', authToken: 'legacy-token' })
      expect(decorated.url).toBe('http://localhost:9999/mcp')
      expect(decorated).not.toBe(stored)
      expect(stored).toStrictEqual(before)
    })

    it('changes: outside a managed runtime each stored flag alone is dropped', () => {
      for (const key of ['runtimeManagedUrl', 'runtimeManagedProfile', 'storedUrl', 'runtimeManagedUrlReason']) {
        const stored = { ...dockerGateway, metadata: { dockerProfile: 'work', [key]: 'stale' } } as any

        expect(module.decorateMcpGatewayForRuntime(stored).metadata).toStrictEqual({ dockerProfile: 'work' })
        expect(stored.metadata[key]).toBe('stale')
      }
    })

    it('the containerized runtime overlays its own flags and URL; no stored flag or storedUrl survives', () => {
      dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'
      dynamicPrivateEnv.env.DOCKER_MCP_GATEWAY_PORT = '5608'
      const stored = staleDockerGateway()
      stored.metadata.runtimeManagedUrlReason = 'mac-app-docker-gateway'
      stored.metadata.runtimeManagedProfile = false
      const before = structuredClone(stored)

      const decorated = module.decorateMcpGatewayForRuntime(stored)

      expect(decorated.url).toBe('http://host.docker.internal:5608/mcp')
      expect(decorated.metadata).toStrictEqual({
        dockerProfile: 'work',
        note: 'kept',
        authToken: 'legacy-token',
        runtimeManagedUrl: true,
        runtimeManagedProfile: true,
        storedUrl: 'http://localhost:9999/mcp',
        runtimeManagedUrlReason: 'containerized-docker-gateway'
      })
      expect(stored).toStrictEqual(before)
    })

    it('the Mac runtime overlays its own flags (profile editable) over stale containerized ones', () => {
      dynamicPrivateEnv.env.BATSHIT_RUNTIME_OWNER = 'mac-app'
      dynamicPrivateEnv.env.DOCKER_MCP_GATEWAY_PORT = '8080'
      const stored = staleDockerGateway()
      const before = structuredClone(stored)

      const decorated = module.decorateMcpGatewayForRuntime(stored)

      expect(decorated.url).toBe('http://127.0.0.1:8080/mcp')
      expect(decorated.metadata).toStrictEqual({
        dockerProfile: 'work',
        note: 'kept',
        authToken: 'legacy-token',
        runtimeManagedUrl: true,
        runtimeManagedProfile: false,
        storedUrl: 'http://localhost:9999/mcp',
        runtimeManagedUrlReason: 'mac-app-docker-gateway'
      })
      expect(cardLocksProfile(decorated)).toBe(false)
      expect(stored).toStrictEqual(before)
    })

    it('a non-Docker gateway is the stored object itself in every runtime, its keys untouched', () => {
      const custom = {
        id: 'gateway-2',
        name: 'Custom',
        type: 'custom',
        url: 'https://example.test/mcp',
        enabled: true,
        discoveredTools: [],
        metadata: { runtimeManagedUrl: true, storedUrl: 'x', note: 'kept' }
      } as any

      expect(module.decorateMcpGatewayForRuntime(custom)).toBe(custom)
      dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'
      expect(module.decorateMcpGatewayForRuntime(custom)).toBe(custom)
      expect(custom.metadata).toStrictEqual({ runtimeManagedUrl: true, storedUrl: 'x', note: 'kept' })
    })

    it('missing or non-record metadata keeps its contract: as stored outside, an empty record plus the flags inside', () => {
      for (const metadata of [undefined, null, 'text', ['runtimeManagedUrl']]) {
        const stored = { ...dockerGateway, metadata } as any

        delete dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED
        expect(module.decorateMcpGatewayForRuntime(stored)).toBe(stored)

        dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'
        expect(module.decorateMcpGatewayForRuntime(stored).metadata).toStrictEqual({
          runtimeManagedUrl: true,
          runtimeManagedProfile: true,
          storedUrl: 'http://localhost:8080/mcp',
          runtimeManagedUrlReason: 'containerized-docker-gateway'
        })
        expect(stored.metadata).toStrictEqual(metadata)
      }
    })

    it('changes: the browser answer strips the stale flags and then the token, from copies only', () => {
      const stored = staleDockerGateway()
      const before = structuredClone(stored)

      const presented = module.presentMcpGatewayForBrowser(stored)

      expect(presented.metadata).toStrictEqual({ dockerProfile: 'work', note: 'kept' })
      expect(stored).toStrictEqual(before)

      dynamicPrivateEnv.env.BATSHIT_CONTAINERIZED = '1'
      const inContainer = module.presentMcpGatewaysForBrowser([stored])[0]
      expect(inContainer.metadata).not.toHaveProperty('authToken')
      expect(inContainer.metadata).toMatchObject({ runtimeManagedProfile: true, storedUrl: 'http://localhost:9999/mcp' })
      expect(stored).toStrictEqual(before)
    })
  })
})
