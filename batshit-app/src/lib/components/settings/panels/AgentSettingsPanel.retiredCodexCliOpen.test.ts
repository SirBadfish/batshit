import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { loadAgentRoute } from '$lib/test-utils/agentPutRoute'

/**
 * SA-139 R1 (D14, mounted check): Codex CLI was removed and a stored Codex CLI Primary or
 * Subagent is not migrated. Opening one in Agent Settings must write NOTHING: no hydration, sync
 * or autosave may turn the leftover record into something else (or strip its old block) without
 * a click from the user.
 *
 * Renders the REAL panel (the harness of `AgentSettingsPanel.subagentModelOnOpen.test.ts`).
 * `/api/agents/<id>` and `/api/subagents/<id>` go to the REAL route handlers on the default
 * lane's Redis fake, and every non-GET request the panel sends is recorded.
 */

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))

useRedisTestServer()

const USER = 'r1codex_user'
const PROBE = 'r1codex_probe'
const CODEX_AGENT = 'r1codex_agent'
const CODEX_SUB = 'r1codex_sub'

/** What a Codex CLI record from before R1 carries: the provider, the connection and its old block. */
const LEFTOVER_CODEX_FIELDS = {
  primary_model_provider: 'openai-codex',
  primary_model_name: 'gpt-5.1-codex',
  primary_model_connection: { id: 'codex-cli', service: 'openai-codex', type: 'direct' },
  codex_settings: { permissionMode: 'chat', includeProjectInstructions: true, model: 'gpt-5.1-codex' }
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
let subagentRoute: typeof import('../../../../routes/api/subagents/[id]/+server')

beforeAll(async () => {
  agentRoute = await import('../../../../routes/api/agents/[id]/+server')
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

/** Every non-GET request the panel sent, in order. */
let sent: Array<{ method: string; path: string; body: Record<string, any> | null }> = []
const agentReads = new Map<string, number>()

function installRoutes(agentIds: string[]) {
  sent = []
  agentReads.clear()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    if (method !== 'GET') sent.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null })

    if (path === '/api/agents' && method === 'GET') {
      const agents = []
      for (const id of agentIds) {
        const agent = await redis.json.get(`agent:${id}`)
        if (agent) agents.push(agent)
      }
      return jsonResponse({ agents })
    }
    for (const id of agentIds) {
      if (path === `/api/agents/${id}/subagents`) return jsonResponse({ subagents: [] })
      if (path === `/api/agents/${id}`) {
        const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
        if (method !== 'PUT') agentReads.set(id, (agentReads.get(id) ?? 0) + 1)
        const handler = method === 'PUT' ? agentRoute.PUT : agentRoute.GET
        return (await handler({ params: { id }, request, locals: { user: { id: USER } } } as any)) as Response
      }
    }
    if (path === '/api/subagents' && method === 'GET') {
      const sub = await redis.json.get(`subagent:${CODEX_SUB}`)
      return jsonResponse({ subagents: sub ? [sub] : [] })
    }
    if (path === `/api/subagents/${CODEX_SUB}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      const handler = method === 'PUT' ? subagentRoute.PUT : subagentRoute.GET
      return (await handler({ params: { id: CODEX_SUB }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Writes to an agent or Subagent record (the paths this check owns). */
const recordWrites = () => sent.filter((entry) => /^\/api\/(agents|subagents)(\/|$)/.test(entry.path))

async function stored(key: string) {
  return (await redis.json.get(key)) as Record<string, any>
}

async function openPanelOn(agentId: string, displayName: string) {
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: agentId }
  })
  await screen.findByDisplayValue(displayName, {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads.get(agentId) ?? 0).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
}

describe('SA-139 R1: opening a leftover Codex CLI record in Agent Settings writes nothing', () => {
  const originalFetch = global.fetch

  beforeEach(async () => {
    agentRoute = await loadAgentRoute()
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    agentStore.setAgents([])
  })

  it('a leftover Codex CLI Primary: no write after hydration settles, and the record stays as it was', async () => {
    installRoutes([CODEX_AGENT])
    await redis.createAgent({
      id: CODEX_AGENT,
      user_id: USER,
      displayName: 'Rook leftover',
      agentType: 'cli',
      ...LEFTOVER_CODEX_FIELDS
    } as any)
    const before = await stored(`agent:${CODEX_AGENT}`)

    await openPanelOn(CODEX_AGENT, 'Rook leftover')
    // Past the autosave debounces, so a save the opening queued would have gone out.
    await pause(1800)

    expect(recordWrites()).toEqual([])
    // Nor any other write at all.
    expect(sent).toEqual([])
    expect(await stored(`agent:${CODEX_AGENT}`)).toEqual(before)
  }, 90_000)

  it('a leftover Codex CLI Subagent: no write after hydration settles, and the record stays as it was', async () => {
    installRoutes([PROBE])
    await redis.createAgent({ id: PROBE, user_id: USER, displayName: 'Panel probe', agentType: 'api' } as any)
    await redis.json.set(`subagent:${CODEX_SUB}`, '$', {
      id: CODEX_SUB,
      user_id: USER,
      displayName: 'Rook leftover sub',
      slug: CODEX_SUB,
      subagentType: 'cli',
      specialty: 'general',
      timeout_seconds: 45,
      ...LEFTOVER_CODEX_FIELDS,
      created_at: '2026-09-28T00:00:00.000Z',
      updated_at: '2026-09-28T00:00:00.000Z'
    } as any)
    await redis.sAdd(`user:${USER}:subagents`, CODEX_SUB)
    const before = await stored(`subagent:${CODEX_SUB}`)

    await openPanelOn(PROBE, 'Panel probe')
    await pause(600)
    const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
    await fireEvent.keyDown(selector, { key: 'ArrowDown' })
    const item = await screen.findByText('Rook leftover sub', { selector: '.batshit-settings-action-row-title' })
    await fireEvent.click(item.closest('button') as HTMLElement)
    await screen.findByDisplayValue('Rook leftover sub', {}, { timeout: 15_000 })
    // Past the autosave debounces, so a save the opening queued would have gone out.
    await pause(1800)

    expect(recordWrites()).toEqual([])
    // Nor any other write at all.
    expect(sent).toEqual([])
    expect(await stored(`subagent:${CODEX_SUB}`)).toEqual(before)
  }, 90_000)
})
