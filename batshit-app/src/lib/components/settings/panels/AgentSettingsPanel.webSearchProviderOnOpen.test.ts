import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'

/**
 * BL-835: opening Agent Settings erased a saved Exa or Perplexity web search choice when its key
 * was not ready. `clearInvalidWebSearchProviderOverrideIfNeeded` removed `webSearchProvider` from
 * the form on open (also when the key status could not be loaded at all), and the autosave sent
 * the removal (BL-517's class: a load must not change what is saved). Now the picker shows the
 * saved choice as unavailable ("Missing API key", the words the model picker uses for a locked
 * connection) and the form keeps it; the choice changes only when the user changes it.
 *
 * Renders the REAL panel. `/api/agents/<id>` goes to the REAL route handler on the default
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

useRedisTestServer()

const USER = 'ss835_user'
const AGENT = 'ss835_agent'

const PRESET = {
  id: 'ss835_preset',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
}

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

beforeAll(async () => {
  agentRoute = await import('../../../../routes/api/agents/[id]/+server')
}, 60_000)

/** What `/api/settings/api-keys` answers: which web search keys are saved (or that it fails). */
let apiKeysAnswer: () => Response

/** Every agent PUT body the panel sent, in order. */
let puts: Array<{ body: Record<string, any> }> = []
let agentReads = 0

function installRoutes() {
  puts = []
  agentReads = 0
  apiKeysAnswer = () => jsonResponse({ keys: {} })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]

    if (path === '/api/agents' && method === 'GET') {
      return jsonResponse({ agents: [await redis.json.get(`agent:${AGENT}`)] })
    }
    if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
    if (path === `/api/agents/${AGENT}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      if (method === 'PUT') puts.push({ body: JSON.parse(String(init.body)) })
      else agentReads += 1
      const handler = method === 'PUT' ? agentRoute.PUT : agentRoute.GET
      return (await handler({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: [PRESET] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return apiKeysAnswer()
    if (path === '/api/goons') return jsonResponse({ goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function stored() {
  return (await redis.json.get(`agent:${AGENT}`)) as Record<string, any>
}

function agentWithNativeTools(nativeTools: Record<string, unknown>) {
  return {
    id: AGENT,
    user_id: USER,
    displayName: 'Panel probe',
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7, nativeTools }
  }
}

/** Renders the panel and waits until the agent and the key status are in, past the autosave debounce. */
async function openPanel() {
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Panel probe', {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  await pause(1500)
}

/** Tools tab, then the Web Search Defaults disclosure, so the provider picker is on screen. */
async function openWebSearchDefaults() {
  const tab = screen.getAllByRole('tab').find((element) => /Tools/.test(element.textContent ?? ''))
  expect(tab).toBeTruthy()
  await fireEvent.mouseDown(tab as HTMLElement)
  await fireEvent.click(tab as HTMLElement)
  const trigger = (await screen.findAllByText('Web Search Defaults'))[0]
  await fireEvent.click(trigger.closest('button') as HTMLElement)
  await screen.findByText('Default Web Search Provider')
}

async function editDisplayName(value: string) {
  const input = document.getElementById('agent-display') as HTMLInputElement
  await fireEvent.input(input, { target: { value } })
}

describe('Agent Settings keeps a saved web search choice whose key is not ready (BL-835)', () => {
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

  it('a saved Exa choice with no Exa key: opening saves nothing, the picker shows it unavailable, the form keeps it', async () => {
    await redis.createAgent(agentWithNativeTools({ webSearchProvider: 'exa', webSearchExaType: 'fast' }) as any)
    const before = await stored()
    await openPanel()

    expect(puts).toEqual([])
    expect(await stored()).toEqual(before)

    await openWebSearchDefaults()
    expect(await screen.findByText('Exa (Missing API key)')).toBeTruthy()
    // It no longer reads as "Use Global Default", which is a different choice.
    expect(screen.queryByText(/^Use Global Default \(DuckDuckGo/)).toBeNull()
  }, 90_000)

  it('a saved Exa choice with no Exa key: an edit of another field sends only that edit and the choice stays saved', async () => {
    await redis.createAgent(agentWithNativeTools({ webSearchProvider: 'exa', webSearchExaType: 'fast' }) as any)
    await openPanel()

    await editDisplayName('Panel probe renamed')
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await pause(200)

    expect(puts[0].body).toEqual({ displayName: 'Panel probe renamed' })
    expect((await stored()).provider_specific_settings.nativeTools).toEqual({
      webSearchProvider: 'exa',
      webSearchExaType: 'fast'
    })
  }, 90_000)

  it('the key status arrives after the agent has loaded: the saved choice is still kept and opening saves nothing', async () => {
    // The other order of the two loads: the agent form is hydrated before the key status lands.
    let answer: (response: Response) => void = () => {}
    const late = new Promise<Response>((resolve) => {
      answer = resolve
    })
    const fetchWithLateKeys = global.fetch
    // @ts-expect-error test override
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.split('?')[0] === '/api/settings/api-keys') return late
      return fetchWithLateKeys(input, init)
    })
    await redis.createAgent(agentWithNativeTools({ webSearchProvider: 'exa' }) as any)
    const before = await stored()
    render((await import('./AgentSettingsPanel.svelte')).default, {
      props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
    })
    await screen.findByDisplayValue('Panel probe', {}, { timeout: 15_000 })
    await pause(1000)
    answer(jsonResponse({ keys: {} }))
    await pause(1500)

    expect(puts).toEqual([])
    expect(await stored()).toEqual(before)
    await openWebSearchDefaults()
    expect(await screen.findByText('Exa (Missing API key)')).toBeTruthy()
  }, 90_000)

  it('a saved Perplexity choice with no Perplexity key: opening saves nothing and the choice stays saved', async () => {
    apiKeysAnswer = () => jsonResponse({ keys: { exa: { status: 'ready' } } })
    await redis.createAgent(agentWithNativeTools({ webSearchProvider: 'perplexity' }) as any)
    const before = await stored()
    await openPanel()

    expect(puts).toEqual([])
    expect(await stored()).toEqual(before)
    await openWebSearchDefaults()
    expect(await screen.findByText('Perplexity (Missing API key)')).toBeTruthy()
  }, 90_000)

  it('the key status cannot be loaded: opening saves nothing, the choice stays saved and is not called unavailable', async () => {
    apiKeysAnswer = () => jsonResponse({ error: 'Failed to fetch API keys' }, 500)
    await redis.createAgent(agentWithNativeTools({ webSearchProvider: 'exa' }) as any)
    const before = await stored()
    await openPanel()

    expect(puts).toEqual([])
    expect(await stored()).toEqual(before)
    await openWebSearchDefaults()
    // Not known to be unavailable: the panel names the load failure instead of guessing.
    expect(await screen.findByText('Exa')).toBeTruthy()
    expect(screen.queryByText('Exa (Missing API key)')).toBeNull()
    expect(await screen.findByText(/Failed to fetch API keys/)).toBeTruthy()
  }, 90_000)

  it('with the Exa key saved the choice shows plainly and opening saves nothing', async () => {
    apiKeysAnswer = () => jsonResponse({ keys: { exa: { status: 'ready' } } })
    await redis.createAgent(agentWithNativeTools({ webSearchProvider: 'exa' }) as any)
    const before = await stored()
    await openPanel()

    expect(puts).toEqual([])
    expect(await stored()).toEqual(before)
    await openWebSearchDefaults()
    expect(await screen.findByText('Exa')).toBeTruthy()
    expect(screen.queryByText('Exa (Missing API key)')).toBeNull()
  }, 90_000)

  it('the choice changes only when the user changes it: picking DuckDuckGo sends that one field', async () => {
    await redis.createAgent(agentWithNativeTools({ webSearchProvider: 'exa', webSearchExaType: 'fast' }) as any)
    await openPanel()
    await openWebSearchDefaults()

    const trigger = (await screen.findByText('Exa (Missing API key)')).closest('button') as HTMLElement
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    // The popper stays `visibility: hidden` in jsdom (no layout), so an option has no accessible
    // name here: find the hidden options and pick by their text.
    await waitFor(() => expect(screen.queryAllByRole('option', { hidden: true }).length).toBeGreaterThan(0))
    const option = screen
      .getAllByRole('option', { hidden: true })
      .find((element) => /^DuckDuckGo/.test(element.textContent?.trim() ?? ''))
    expect(option).toBeTruthy()
    await fireEvent.pointerUp(option as HTMLElement, { pointerType: 'mouse' })

    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    expect(puts[0].body).toEqual({ provider_specific_settings: { nativeTools: { webSearchProvider: 'duckduckgo-html' } } })
    await waitFor(async () => expect((await stored()).provider_specific_settings.nativeTools).toEqual({
      webSearchProvider: 'duckduckgo-html',
      webSearchExaType: 'fast'
    }), { timeout: 5_000 })
  }, 90_000)
})
