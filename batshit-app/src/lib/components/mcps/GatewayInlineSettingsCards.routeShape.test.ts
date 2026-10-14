/**
 * BL-1377: Gateway Settings sends only the fields this form owns. The REAL card is mounted with the
 * gateway as the REAL route presents it (runtime fields included), and its PUT goes to the REAL
 * route and service over the shared fake store, so the test sees what is stored. Only the CLI
 * profile syncs, discovery and the profile file writer are stand-ins (no real env file is touched).
 *
 * - Containerized: the profile and the URL belong to the runtime; a name edit sends neither, so the
 *   containerized profile check never runs and the edit is saved.
 * - Mac app: the URL belongs to the runtime (not sent; the stored URL stays); the profile is this
 *   form's and goes with every settings save, the same one included (the file repair path).
 * - Neither: the URL edit and the profile are sent; nothing else of `metadata` is.
 * Every other stored field stays as it was (the route merges onto the stored record).
 *
 * Cases titled "changes:" were red with the card at `8eb19a61c` (it echoed the browser `metadata`
 * and the runtime URL).
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('svelte-sonner', () => ({ toast }))
const profileSync = vi.hoisted(() => ({
  codex: vi.fn(async () => undefined),
  claude: vi.fn(async () => ({}))
}))
const writer = vi.hoisted(() => vi.fn(async (_profile: string) => undefined))
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: profileSync.codex }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: profileSync.claude }))
vi.mock('$lib/server/services/workflowDiscovery', () => ({
  workflowDiscovery: { discoverDirectMCPClients: vi.fn(async () => []) }
}))
vi.mock('$lib/server/services/dockerGatewayProfileConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/dockerGatewayProfileConfig')>()),
  writeDockerMcpProfileEnv: writer
}))

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { presentMcpGatewayForBrowser } from '$lib/server/services/mcpGatewayRuntimePresentation'
import type { MCPGateway } from '$lib/types/database'
import { GET as getRoute, PUT as putRoute } from '../../../routes/api/mcp/gateways/[id]/+server'
import GatewayInlineSettingsCards from './GatewayInlineSettingsCards.svelte'
import { resetGatewaySaveStateForTest } from './gatewaySaveState'

const USER = 'bl1377_user'
const REGISTRY = `mcp_gateways:${USER}`
const STORED_URL = 'http://localhost:8080/mcp'

type Sent = { id: string; body: any; status: number }
let sent: Sent[]
let warnSpy: ReturnType<typeof vi.spyOn>
const savedEnv: Record<string, string | undefined> = {}

function routeEvent(id: string, init?: RequestInit) {
  return {
    request: new Request(`http://localhost/api/mcp/gateways/${id}`, init),
    locals: { user: { id: USER } },
    params: { id },
    url: new URL(`http://localhost/api/mcp/gateways/${id}`)
  } as any
}

async function storedGateway(id: string): Promise<any> {
  const registry = (await redis.json.get(REGISTRY)) as { gateways: any[] }
  return registry.gateways.find((gateway) => gateway.id === id)
}

/** The gateway as `GET /api/mcp/gateways/[id]` presents it to the browser. */
async function presented(id: string): Promise<MCPGateway> {
  const stored = await mcpGatewayService.get(USER, id)
  return presentMcpGatewayForBrowser(stored!)
}

async function mount(gateway: MCPGateway) {
  const view = render(GatewayInlineSettingsCards, { props: { gateway, userId: USER, onGatewayUpdated: vi.fn() } })
  await waitFor(() => expect(view.container.querySelector(`#gateway-name-${gateway.id}`)).toBeTruthy())
  return view
}

function field(container: HTMLElement, selector: string) {
  const element = container.querySelector(selector) as HTMLInputElement | null
  if (!element) throw new Error(`no field ${selector}`)
  return element
}

async function editAndWaitForTheSave(container: HTMLElement, selector: string, value: string) {
  await fireEvent.input(field(container, selector), { target: { value } })
  await waitFor(() => expect(sent).toHaveLength(1), { timeout: 3000 })
}

function setEnv(name: 'BATSHIT_CONTAINERIZED' | 'BATSHIT_RUNTIME_OWNER', value: string) {
  env[name] = value
}

describe.runIf(process.env.VITEST_USE_REAL_REDIS !== 'true')('BL-1377: Gateway Settings sends only the fields it owns', () => {
  beforeEach(async () => {
    ;(redis as any).__resetTestStore()
    resetGatewaySaveStateForTest()
    vi.clearAllMocks()
    for (const name of ['BATSHIT_CONTAINERIZED', 'BATSHIT_RUNTIME_OWNER'] as const) {
      savedEnv[name] = env[name]
      delete env[name]
    }
    sent = []
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/settings/api-keys')) return Response.json({ success: true, keys: {} })
        if (url.includes('/tools')) return Response.json({ mcps: [] })
        if (url.startsWith('/api/mcp/gateways/')) {
          const id = decodeURIComponent(url.split('/api/mcp/gateways/')[1].split('?')[0])
          if (init?.method === 'PUT') {
            const response = (await putRoute(routeEvent(id, { method: 'PUT', body: init.body }))) as Response
            sent.push({ id, body: JSON.parse(String(init.body)), status: response.status })
            return response
          }
          return (await getRoute(routeEvent(id))) as Response
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`)
      })
    )
    await mcpGatewayService.create(USER, {
      id: 'gw-d',
      name: 'Docker MCP Gateway',
      type: 'docker-catalog',
      url: STORED_URL,
      enabled: true,
      created_at: '2026-10-11T00:00:00.000Z',
      metadata: { dockerProfile: 'default', note: 'kept' }
    } as any)
    await mcpGatewayService.create(USER, {
      id: 'gw-c',
      name: 'Remote Search',
      type: 'custom',
      url: 'https://search.example.com/mcp',
      authKeyName: 'search_key',
      enabled: true,
      created_at: '2026-10-11T00:00:00.000Z',
      metadata: { note: 'kept' }
    } as any)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    warnSpy.mockRestore()
    for (const name of ['BATSHIT_CONTAINERIZED', 'BATSHIT_RUNTIME_OWNER'] as const) {
      if (savedEnv[name] === undefined) delete env[name]
      else env[name] = savedEnv[name]
    }
  })

  it('changes: containerized: a name edit sends no URL and no metadata, so the profile check never runs and the edit is saved', async () => {
    setEnv('BATSHIT_CONTAINERIZED', '1')
    const gateway = await presented('gw-d')
    expect(gateway.metadata?.runtimeManagedProfile).toBe(true)
    const view = await mount(gateway)

    await editAndWaitForTheSave(view.container, '#gateway-name-gw-d', 'Docker Renamed')

    expect(sent[0].status).toBe(200)
    expect(sent[0].body).toEqual({ name: 'Docker Renamed', icon_ref: sent[0].body.icon_ref })
    const stored = await storedGateway('gw-d')
    expect(stored.name).toBe('Docker Renamed')
    expect(stored.url).toBe(STORED_URL)
    expect(stored.metadata).toEqual({ dockerProfile: 'default', note: 'kept' })
    expect(writer).not.toHaveBeenCalled()
  })

  it('changes: Mac app: the runtime URL is not sent and the stored URL stays; the profile goes even unchanged; no runtime field is stored', async () => {
    setEnv('BATSHIT_RUNTIME_OWNER', 'mac-app')
    const gateway = await presented('gw-d')
    expect(gateway.metadata?.runtimeManagedUrl).toBe(true)
    expect(gateway.metadata?.runtimeManagedProfile).toBe(false)
    const view = await mount(gateway)

    await editAndWaitForTheSave(view.container, '#gateway-name-gw-d', 'Docker Renamed')

    expect(sent[0].status).toBe(200)
    expect(sent[0].body).not.toHaveProperty('url')
    expect(sent[0].body.metadata).toEqual({ dockerProfile: 'default' })
    const stored = await storedGateway('gw-d')
    expect(stored.name).toBe('Docker Renamed')
    expect(stored.url).toBe(STORED_URL)
    expect(stored.metadata).toEqual({ dockerProfile: 'default', note: 'kept' })
    expect(writer.mock.calls).toEqual([['default']])
  })

  it('changes: no runtime ownership: the URL edit is sent and saved, metadata carries only the profile, other keys stay', async () => {
    const view = await mount(await presented('gw-d'))

    await editAndWaitForTheSave(view.container, '#gateway-url-gw-d', 'http://localhost:9090/mcp')

    expect(sent[0].status).toBe(200)
    expect(sent[0].body.url).toBe('http://localhost:9090/mcp')
    expect(sent[0].body.metadata).toEqual({ dockerProfile: 'default' })
    const stored = await storedGateway('gw-d')
    expect(stored.url).toBe('http://localhost:9090/mcp')
    expect(stored.metadata).toEqual({ dockerProfile: 'default', note: 'kept' })
  })

  it('a custom source sends its URL and auth key and no metadata; its stored metadata stays', async () => {
    const view = await mount(await presented('gw-c'))

    await editAndWaitForTheSave(view.container, '#gateway-url-gw-c', 'https://search.example.com/v2/mcp')

    expect(sent[0].status).toBe(200)
    expect(sent[0].body).not.toHaveProperty('metadata')
    expect(sent[0].body.authKeyName).toBe('search_key')
    const stored = await storedGateway('gw-c')
    expect(stored.url).toBe('https://search.example.com/v2/mcp')
    expect(stored.authKeyName).toBe('search_key')
    expect(stored.metadata).toEqual({ note: 'kept' })
  })
})
