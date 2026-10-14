import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'

/**
 * BL-834: opening a Subagent changed its form and saved the change.
 *
 * `syncSelectedModelFromSubagent` cleared the Subagent's model, preset, and connection when the
 * saved preset could not be selected (an image model, a voice-session model on a non-API
 * Subagent), so the form differed from the copy it loaded and the autosave stored the cleared
 * model with no click from the user. The Primary Agent twin was fixed in BL-514: the preset-
 * selection sync only decides what the picker shows, and opening Settings never saves.
 *
 * Renders the REAL panel. `/api/subagents/<id>` goes to the REAL route handler on the default
 * lane's Redis fake.
 */

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
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

useRedisTestServer()

const USER = 'ss834_user'
const AGENT = 'ss834_agent'
const SUB = 'ss834_sub'

type Preset = Record<string, any>

const PRESET_CHAT: Preset = {
  id: 'ss834_preset_chat',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Chat Model',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
}
/** Not a chat model: the Subagent picker cannot select it. */
const PRESET_IMAGE: Preset = {
  id: 'ss834_preset_image',
  provider: 'openai',
  modelId: 'gpt-image-2',
  modelName: 'Probe Image Model',
  purpose: 'visual',
  connection: { type: 'direct', service: 'openai' },
  settings: { quality: 'high' }
}
/** The saved-models list the panel loads: it does not hold the preset the second Subagent names. */
const PRESETS = [PRESET_CHAT, PRESET_IMAGE]

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

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

let agentRoute: typeof import('../../../../routes/api/agents/[id]/+server')
let subagentRoute: typeof import('../../../../routes/api/subagents/[id]/+server')

beforeAll(async () => {
  agentRoute = await import('../../../../routes/api/agents/[id]/+server')
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

/** Every write the panel sent, in order. */
let sent: Array<{ method: string; path: string; body: Record<string, any> | null }> = []
let agentReads = 0

function installRoutes() {
  sent = []
  agentReads = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    if (method !== 'GET') sent.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null })

    if (path === '/api/agents' && method === 'GET') {
      const agent = await redis.json.get(`agent:${AGENT}`)
      return jsonResponse({ agents: agent ? [agent] : [] })
    }
    if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
    if (path === `/api/agents/${AGENT}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      if (method !== 'PUT') agentReads += 1
      const handler = method === 'PUT' ? agentRoute.PUT : agentRoute.GET
      return (await handler({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/subagents' && method === 'GET') {
      const sub = await redis.json.get(`subagent:${SUB}`)
      return jsonResponse({ subagents: sub ? [sub] : [] })
    }
    if (path === `/api/subagents/${SUB}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      const handler = method === 'PUT' ? subagentRoute.PUT : subagentRoute.GET
      return (await handler({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: PRESETS })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function probeAgent() {
  return {
    id: AGENT,
    user_id: USER,
    displayName: 'Panel probe',
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET_CHAT as any),
    primary_model_connection: resolveSavedModelConnection(PRESET_CHAT as any),
    provider_specific_settings: { temperature: 0.7 }
  }
}

/** An API Subagent that names `preset` (or one the list does not hold). */
function subagentRecord(preset: Preset) {
  return {
    id: SUB,
    user_id: USER,
    displayName: 'Ss834 Panel Sub',
    slug: SUB,
    subagentType: 'api',
    specialty: 'general',
    timeout_seconds: 45,
    ...buildPickedPresetModelFields(preset as any),
    primary_model_connection: resolveSavedModelConnection(preset as any),
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  }
}

/** Renders the panel on the probe agent, picks the Subagent, and waits past the autosave debounce. */
async function openSubagent() {
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Panel probe', {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  await pause(600)

  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText('Ss834 Panel Sub', { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  await screen.findByDisplayValue('Ss834 Panel Sub', {}, { timeout: 15_000 })
  // Past the autosave debounces, so a save the opening queued would have gone out.
  await pause(1200)
}

async function editSubagentName(value: string) {
  const input = screen.getByDisplayValue('Ss834 Panel Sub') as HTMLInputElement
  await fireEvent.input(input, { target: { value } })
}

const subagentPuts = () => sent.filter((entry) => entry.method === 'PUT' && entry.path === `/api/subagents/${SUB}`)

async function storedSubagent() {
  return (await redis.json.get(`subagent:${SUB}`)) as Record<string, any>
}

const MODEL_FIELDS = [
  'primary_model_preset_id',
  'primary_model_provider',
  'primary_model_name',
  'primary_model_connection'
] as const

function modelFieldsOf(record: Record<string, any>) {
  return Object.fromEntries(MODEL_FIELDS.map((key) => [key, record[key] ?? null]))
}

describe('opening a Subagent never changes or saves its model (BL-834)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    installRoutes()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    agentStore.setAgents([])
  })

  it('a preset the picker cannot select: opening saves nothing, the picker shows no selection, the saved model stays', async () => {
    await redis.json.set(`subagent:${SUB}`, '$', subagentRecord(PRESET_IMAGE) as any)
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    await redis.createAgent(probeAgent() as any)
    const before = await storedSubagent()
    expect(before.primary_model_preset_id).toBe(PRESET_IMAGE.id)

    await openSubagent()

    expect(subagentPuts()).toEqual([])
    expect(await storedSubagent()).toEqual(before)
    // The picker shows no selection, as it did before; only the clearing and its save are gone.
    expect(screen.getByText('Choose a Saved Model')).toBeTruthy()
  }, 90_000)

  it('a preset the picker cannot select: an edit of another field leaves the saved model as it was', async () => {
    await redis.json.set(`subagent:${SUB}`, '$', subagentRecord(PRESET_IMAGE) as any)
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    await redis.createAgent(probeAgent() as any)
    const before = await storedSubagent()

    await openSubagent()
    await editSubagentName('Ss834 Panel Sub renamed')
    // The rename is on the record (the write on open, on the old code, came before it).
    await waitFor(async () => expect((await storedSubagent()).displayName).toBe('Ss834 Panel Sub renamed'), {
      timeout: 5_000
    })
    await pause(200)

    const record = await storedSubagent()
    expect(record.displayName).toBe('Ss834 Panel Sub renamed')
    expect(modelFieldsOf(record)).toEqual(modelFieldsOf(before))
    expect(record.primary_model_preset_id).toBe(PRESET_IMAGE.id)
    // Every write the panel made kept the model fields it loaded (none cleared them).
    for (const put of subagentPuts()) {
      if ('primary_model_preset_id' in (put.body ?? {})) {
        expect(put.body!.primary_model_preset_id).toBe(PRESET_IMAGE.id)
      }
      if ('primary_model_name' in (put.body ?? {})) {
        expect(put.body!.primary_model_name).toBe(PRESET_IMAGE.modelId)
      }
    }
  }, 90_000)

  it('regression guard, not a proof of the fix (green on the old code too): a preset the loaded list does not hold never cleared the model; opening saves nothing and the saved model stays', async () => {
    const missing: Preset = {
      id: 'ss834_preset_gone',
      provider: 'openai',
      modelId: 'gpt-gone',
      modelName: 'Gone',
      purpose: 'chat',
      connection: { type: 'direct', service: 'openai' },
      settings: {}
    }
    await redis.json.set(`subagent:${SUB}`, '$', subagentRecord(missing) as any)
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    await redis.createAgent(probeAgent() as any)
    const before = await storedSubagent()

    await openSubagent()

    expect(subagentPuts()).toEqual([])
    expect(await storedSubagent()).toEqual(before)
  }, 90_000)
})
