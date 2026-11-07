import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { loadAgentRoute } from '$lib/test-utils/agentPutRoute'

/**
 * SA-139 R2 (D14 UI sweep): the n8n Workflow Subagent type is removed, and its Settings markers go
 * with it. Renders the REAL panel with the REAL `GET /api/subagents` route on the default lane's
 * Redis fake, so a stored record of the removed type is proven to stay out of the selector.
 *
 * SA-139 R6 (D16): one Subagent kind. The open menu labels every Subagent row by role, the
 * selected Subagent names no type, and the create dialog has no type choice (a Subagent is
 * created as `api`).
 */

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))

useRedisTestServer()

const USER = 'r2sweep_user'
const AGENT = 'r2sweep_agent'
const LIVE = { id: 'r2sweep_api', displayName: 'Sweep API Helper', subagentType: 'api' }
const LIVE_CLI = { id: 'r2sweep_cli', displayName: 'Sweep CLI Helper', subagentType: 'cli' }
const RETIRED = {
  id: 'r2sweep_flow',
  displayName: 'Sweep Old Workflow',
  subagentType: 'n8n-workflow',
  webhookUrl: 'http://localhost:5678/webhook/flow'
}

let agentRoute: Awaited<ReturnType<typeof loadAgentRoute>>
let listRoute: typeof import('../../../../routes/api/subagents/+server')
let agentReads = 0

beforeAll(async () => {
  listRoute = await import('../../../../routes/api/subagents/+server')
}, 60_000)

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
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
      value: class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
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

let writes: Array<{ method: string; path: string; body: any }> = []

function installRoutes() {
  agentReads = 0
  writes = []
  // @ts-expect-error test override
  global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    if (method !== 'GET') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      writes.push({ method, path, body })
      if (path === '/api/subagents' && method === 'POST') {
        // Store it, as the real route would, so the panel's read of the new Subagent finds it.
        const record = { ...body, user_id: USER, slug: body.id, created_at: '2026-10-28T00:00:00.000Z', updated_at: '2026-10-28T00:00:00.000Z' }
        await redis.json.set(`subagent:${body.id}`, '$', record)
        await redis.sAdd(`user:${USER}:subagents`, body.id)
        return jsonResponse({ subagent: record }, 201)
      }
      return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
    }
    if (path === '/api/agents' && method === 'GET') {
      const agent = await redis.json.get(`agent:${AGENT}`)
      return jsonResponse({ agents: agent ? [agent] : [] })
    }
    if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
    if (path === `/api/agents/${AGENT}` && method === 'GET') {
      agentReads += 1
      return (await agentRoute.GET({ params: { id: AGENT }, request: new Request(`http://localhost${path}`),
        locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/subagents' && method === 'GET') {
      return (await listRoute.GET({ locals: { user: { id: USER } } } as any)) as Response
    }
    if (path.startsWith('/api/subagents/') && method === 'GET') {
      const id = path.slice('/api/subagents/'.length)
      return jsonResponse({ subagent: await redis.json.get(`subagent:${id}`) })
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
}

async function seed() {
  for (const record of [LIVE, LIVE_CLI, RETIRED]) {
    await redis.json.set(`subagent:${record.id}`, '$', {
      ...record, user_id: USER, slug: record.id, specialty: 'general',
      created_at: '2026-10-26T00:00:00.000Z', updated_at: '2026-10-26T00:00:00.000Z'
    } as any)
    await redis.sAdd(`user:${USER}:subagents`, record.id)
  }
  await redis.createAgent({ id: AGENT, user_id: USER, displayName: 'Sweep probe', agentType: 'api' } as any)
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function openMenu() {
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Sweep probe', {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  await pause(600)
  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(LIVE.displayName, { selector: '.batshit-settings-action-row-title' })
  return item.closest('[role="menu"]') as HTMLElement
}

describe('SA-139 R2: Settings shows no n8n Workflow Subagent type', () => {
  const originalFetch = global.fetch

  beforeEach(async () => {
    agentRoute = await loadAgentRoute()
    ensureBrowserStubs()
    installRoutes()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seed()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    agentStore.setAgents([])
  })

  // SA-139 R6 (D16): one Subagent kind, so every Subagent row (a leftover CLI one included) carries
  // the role pill "Subagent", never a type.
  it('the open menu lists the Subagents with the role pill and leaves the removed n8n type out', async () => {
    const menu = await openMenu()
    const title = { selector: '.batshit-settings-action-row-title' }
    const pill = (name: string) => within(menu).getByText(name, title).parentElement
      ?.querySelector('.batshit-settings-agent-type-pill')?.textContent?.trim()
    expect(pill(LIVE.displayName)).toBe('Subagent')
    expect(pill(LIVE_CLI.displayName)).toBe('Subagent')
    expect(within(menu).queryAllByText(/^(API|CLI) Subagent$/)).toHaveLength(0)
    expect(within(menu).queryAllByText(RETIRED.displayName)).toHaveLength(0)
    expect(menu.textContent ?? '').not.toMatch(/n8n|Workflow/i)
  }, 60_000)

  it('the selected Subagent names no type, and the panel names no n8n Subagent type anywhere', async () => {
    const menu = await openMenu()
    const item = within(menu).getByText(LIVE.displayName, { selector: '.batshit-settings-action-row-title' })
    await fireEvent.click(item.closest('button') as HTMLElement)
    await screen.findByDisplayValue(LIVE.displayName, {}, { timeout: 15_000 })
    expect(screen.queryByText('Subagent Type:')).toBeNull()
    const identity = screen.getByText('Subagent ID:').closest('.batshit-settings-identity-meta-row') as HTMLElement
    expect(identity.textContent ?? '').not.toMatch(/\b(API|CLI)\b|Subagent Type/)
    expect(document.body.textContent ?? '').not.toMatch(/n8n Workflow Subagent|n8n Subnode|Production Webhook URL/)
    // Review A's pin: opening a live Subagent, then a leftover CLI one, sends no write (display only).
    await pause(1200)
    expect(writes).toEqual([])
    const menuAgain = await (async () => {
      await fireEvent.keyDown(screen.getByRole('button', { name: 'Select Agents & Subagents' }), { key: 'ArrowDown' })
      const title = await screen.findByText(LIVE_CLI.displayName, { selector: '.batshit-settings-action-row-title' })
      return title
    })()
    await fireEvent.click(menuAgain.closest('button') as HTMLElement)
    await screen.findByTestId('subagent-retired-type-notice', {}, { timeout: 15_000 })
    await pause(1200)
    expect(writes).toEqual([])
  }, 60_000)

  it('SA-139 R6: in Assigned Subagents a live Subagent has no type badge; a leftover CLI one says Removed Type and is off', async () => {
    await openMenu()
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    const card = screen.getByText('Assigned Subagents').closest('details, [data-slot="card"], section') as HTMLElement
    if (card?.tagName === 'DETAILS' && !(card as HTMLDetailsElement).open) await fireEvent.click(within(card).getByText('Assigned Subagents'))
    const row = (name: string) => within(card).getByText(name).closest('.batshit-settings-toggle-row') as HTMLElement
    expect(within(row(LIVE.displayName)).queryAllByText(/^(API|CLI|Removed Type)$/)).toHaveLength(0)
    expect(within(row(LIVE_CLI.displayName)).getByText('Removed Type')).toBeTruthy()
    expect(within(row(LIVE_CLI.displayName)).getByRole('switch')).toHaveProperty('disabled', true)
    expect(within(card).queryByText(RETIRED.displayName)).toBeNull()
  }, 60_000)

  it('SA-139 R6: the create dialog has no Subagent type choice, and a Subagent is created as api', async () => {
    await openMenu()
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await fireEvent.click(screen.getByRole('button', { name: /Create New Agent/ }))
    const dialog = await screen.findByRole('dialog')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Subagent' }))
    expect(within(dialog).queryByText('Subagent Type')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /^(API|CLI)$/ })).toBeNull()
    expect(writes).toEqual([])
    await fireEvent.input(within(dialog).getByLabelText('Display Name'), { target: { value: 'Fresh Helper' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(writes.filter((write) => write.path === '/api/subagents')).toHaveLength(1))
    expect(writes[0].body).toMatchObject({ displayName: 'Fresh Helper', subagentType: 'api' })
  }, 60_000)
})
