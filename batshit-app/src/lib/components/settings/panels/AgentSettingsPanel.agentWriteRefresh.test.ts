import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { jsonResponse, loadAgentRoute, storedAgent } from '$lib/test-utils/agentPutRoute'

/**
 * SA-122 A-1y: the ONE mounted, model-free proof of the mounted Settings refresh (LS-067/LS-068) and
 * BL-1294 on REAL Redis (Ashe Q3: bounded evidence; no browser, no model). Real only: the agent's own
 * save is the real owner's Lua script.
 *
 * Real: the Agents panel (jsdom), `/api/agents/<id>` (route, `redis.updateAgent` and its memory
 * guard), the agent's own save through `executeAgentSettingsAction` (the function the five fixed
 * Fabric controls call; B1 proves the send, broker and Fabric chain above it) and its
 * `publishUserEvent`, the user-channel module and the shared agent store. The bridge: a real Redis
 * subscriber on this user's channel hands each published message to the user channel's own handler,
 * where the live hub would. The hub itself is a stand-in.
 *
 * 1. at rest: the agent renames itself; the panel's name field and the agent store's label show it,
 *    and the panel saves nothing;
 * 2. BL-1294: the user edits Recalled while the agent saves Awareness (the user's save is held on
 *    the wire until the agent's save is in): one refusal, one resend, both values kept, no toast;
 * 3. the same field: the user's Awareness wins, saved once more, with one toast naming it.
 */

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'

const hub = vi.hoisted(() => ({ onEvent: null as null | ((text: string) => void) }))
const toasts = vi.hoisted(() => ({ warning: [] as string[] }))

vi.mock('$lib/services/liveHub/liveHubClient', () => ({
  subscribeLive: (_target: unknown, handlers: { onEvent: (text: string) => void; onStatus?: (status: string) => void }) => {
    hub.onEvent = handlers.onEvent
    handlers.onStatus?.('open')
    return { state: () => 'open', unsubscribe: () => { hub.onEvent = null } }
  }
}))
vi.mock('$lib/components/ui/sonner/settings-toast', async (original) => {
  const actual = await original<Record<string, any>>()
  const toast = Object.assign((...args: unknown[]) => actual.toast(...args), {
    ...actual.toast,
    warning: (message: string) => {
      toasts.warning.push(message)
    }
  })
  return { ...actual, toast }
})
vi.mock('$lib/server/services/codexProfileManager', () => ({
  syncAgentCodexProfiles: vi.fn(async () => {}),
  deleteAgentCodexConfig: vi.fn(async () => {}),
  buildAgentProfileId: (id: string) => `batshit_agent_${id}`
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
vi.mock('$lib/components/settings/agent/AgentMcpDefaultsCard.svelte', async () => ({
  default: (await import('../../mcps/__tests__/AgentMcpDefaultsCardStub.test.svelte')).default
}))

useRedisTestServer()

const USER = 'a1y_proof_user'
const AGENT = 'a1y_proof_agent'
const NAME = 'Proof probe'
const PRESET = {
  id: 'a1y_proof_preset',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
}
const OWNER = { actor: { kind: 'agent' as const, userId: USER, actingAgentId: AGENT }, check() {} }

let subscriber: ReturnType<typeof createClient> | null = null
let stopChannel: () => void = () => {}
let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
let puts: Array<{ body: Record<string, any>; status?: number }> = []
let putGates: Array<Promise<void>> = []
const originalFetch = global.fetch

function ensureBrowserStubs() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.hasPointerCapture !== 'function') {
    Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
    Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: () => {} })
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: () => {} })
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Each case mounts the real panel and waits past autosave debounces: far above the 5 s default. */
// 120 s: a case's own waits can pass 60 s on a slow machine; a wait should name itself first.
const SLOW = 120_000

async function routeAgent(method: string, body: string | undefined) {
  const request = new Request(`http://localhost/api/agents/${AGENT}`, { method, body: method === 'PUT' ? body : undefined })
  const handler = method === 'PUT' ? routeModule.PUT : routeModule.GET
  return (await handler({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
}

function installRoutes() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    if (path === `/api/agents/${AGENT}` && method === 'PUT') {
      const entry: { body: Record<string, any>; status?: number } = { body: JSON.parse(String(init.body)) }
      puts.push(entry)
      const gate = putGates.shift()
      if (gate) await gate
      const response = await routeAgent('PUT', String(init.body))
      entry.status = response.status
      return response
    }
    if (path === `/api/agents/${AGENT}` && method === 'GET') return routeAgent('GET', undefined)
    if (path === '/api/agents' && method === 'GET') return jsonResponse({ agents: [await storedAgent(AGENT)] })
    if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
    if (path === '/api/subagents' && method === 'GET') return jsonResponse({ subagents: [] })
    if (path === '/api/user/saved-models') return jsonResponse({ models: [PRESET] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ goons: [] })
    if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
    if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  }))
}

/** Holds the panel's next agent PUT on the wire (before the route runs) until `release()`. */
function holdNextPut() {
  let release: () => void = () => {}
  putGates.push(new Promise<void>((resolve) => { release = resolve }))
  return () => release()
}

function budgetInput(label: string) {
  const cell = [...document.querySelectorAll('.memory-budget-cell')].find(
    (element) => element.querySelector('span')?.textContent?.trim() === label
  )
  return (cell?.querySelector('input') ?? null) as HTMLInputElement | null
}

function nameInput() {
  return document.getElementById('agent-display') as HTMLInputElement
}

async function typeBudget(label: string, value: number) {
  const input = budgetInput(label) as HTMLInputElement
  await fireEvent.focusIn(input)
  await fireEvent.input(input, { target: { value: String(value) } })
}

/** The agent's own save, through the real adapter and owner (real Lua), which publishes the event. */
async function agentSaves(family: 'memory' | 'identity', changes: Record<string, unknown>) {
  const { ownAgentSettings } = await import('$lib/server/services/appActions/settings/server')
  const { executeAgentSettingsAction } = await import('$lib/server/services/appActions/settingsAdapter')
  const read = family === 'memory'
    ? await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)
    : await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)
  const result = await executeAgentSettingsAction(
    { userId: USER, agentId: AGENT, abortSignal: new AbortController().signal },
    family === 'memory' ? 'settings.agent.memory.update' : 'settings.agent.identity.update',
    { subjectAgentId: AGENT, expectedRevision: read.revision, changes }
  )
  expect(result).toMatchObject({ status: 'completed', saved: 'saved', readback: 'verified' })
}

async function openPanel() {
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: NAME,
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7 },
    memory_enabled: true,
    memory_linger_turns: 2,
    memory_recall_linger_turns: 3,
    memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 }
  } as any)
  installRoutes()
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue(NAME, {}, { timeout: 15_000 })
  await waitFor(() => expect(budgetInput('Awareness')).toBeTruthy(), { timeout: 10_000 })
  await pause(1500)
  expect(puts).toEqual([])
}

describe.skipIf(!REAL)('mounted Settings refresh after the agent saves its own Settings (SA-122 A-1y, real Redis)', () => {
  beforeAll(async () => {
    routeModule = await loadAgentRoute()
    const { getUserChannel } = await import('$lib/server/ssePublisher')
    subscriber = createClient({ url: process.env.REDIS_URL })
    await subscriber.connect()
    await subscriber.subscribe(getUserChannel(USER), (message) => hub.onEvent?.(message))
  }, 60_000)

  afterAll(async () => {
    await subscriber?.quit()
    subscriber = null
  })

  beforeEach(async () => {
    ensureBrowserStubs()
    puts = []
    putGates = []
    toasts.warning = []
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startUserChannel } = await import('$lib/services/userChannel')
    stopChannel = startUserChannel(USER)
  })

  afterEach(async () => {
    cleanup()
    stopChannel()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    global.fetch = originalFetch
    agentStore.setAgents([])
    await redis.del(`agent:${AGENT}`)
  })

  it('1. at rest: the agent renames itself; the panel and the agent store show it, and the panel saves nothing', async () => {
    await openPanel()
    // The panel's own read also updates the store, so the store's refresh is observed itself
    // (a pass-through spy: the user channel calls the real one through this module).
    const storeRefresh = vi.spyOn(agentStore, 'refreshAgentFieldsFromServer')

    await agentSaves('identity', { displayName: 'Proof probe 2' })

    await waitFor(() => expect(nameInput().value).toBe('Proof probe 2'), { timeout: 10_000 })
    await waitFor(() => expect(storeRefresh).toHaveBeenCalledWith(AGENT, 'identity'), { timeout: 10_000 })
    await storeRefresh.mock.results[0].value
    expect(agentStore.getAgentById(AGENT)?.displayName).toBe('Proof probe 2')
    await pause(1500)
    expect(puts).toEqual([])
    expect((await storedAgent(AGENT)).displayName).toBe('Proof probe 2')
  }, SLOW)

  it('2. BL-1294: Recalled edited while the agent saves Awareness: one refusal, one resend, both kept, no toast', async () => {
    await openPanel()
    const release = holdNextPut()

    await typeBudget('Recalled (LTM)', 350)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 10_000 })
    await agentSaves('memory', { onMyMind: 120 })
    release()

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 10_000 })
    await waitFor(() => expect(puts[1].status).toBe(200), { timeout: 10_000 })
    expect(puts[0].status).toBe(409)
    expect(puts[1].body.memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 350 })
    expect((await storedAgent(AGENT)).memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 350 })
    await waitFor(() => expect(budgetInput('Awareness')?.value).toBe('120'), { timeout: 10_000 })
    expect(budgetInput('Recalled (LTM)')?.value).toBe('350')
    expect(toasts.warning).toEqual([])
    await pause(1500)
    expect(puts.length).toBe(2)
  }, SLOW)

  it('3. the same field: the user value of Awareness wins, saved once more, and the panel says so once', async () => {
    await openPanel()
    const release = holdNextPut()

    await typeBudget('Awareness', 150)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 10_000 })
    await agentSaves('memory', { onMyMind: 130 })
    release()

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 10_000 })
    await waitFor(() => expect(puts[1].status).toBe(200), { timeout: 10_000 })
    expect(puts[0].status).toBe(409)
    expect((await storedAgent(AGENT)).memory_lane_budgets.on_my_mind).toBe(150)
    expect(toasts.warning).toHaveLength(1)
    expect(toasts.warning[0]).toMatch(/Awareness/)
  }, SLOW)
})
