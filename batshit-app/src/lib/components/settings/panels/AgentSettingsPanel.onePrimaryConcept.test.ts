import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { loadAgentRoute } from '$lib/test-utils/agentPutRoute'

/**
 * SA-139 R3 (decision 2, decision 16, D14 UI sweep): Agent Settings offers one Primary agent.
 * Renders the REAL panel against the default lane's Redis fake and the real agent and Subagent
 * GET routes, and proves: the Settings menu labels a Primary row by its role ("Primary Agent"), never by
 * an API/CLI type, in the open menu and the selected trigger; an agent's identity row names no
 * type; the create dialog has no type choice, and opening it saves nothing.
 *
 * SA-139 R4 (D14): the Claude Code CLI Primary lane is retired. A stored `cli` Primary opens with
 * the one retired line (the Claude Code sentence, or the Codex sentence for a Codex-named record),
 * no Claude Code CLI sections, and Delete as its one action, and opening or editing it saves
 * nothing. The create dialog has no older-lane switch: a new Primary is always `agentType: 'api'`.
 */

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))

useRedisTestServer()

const USER = 'r3one_user'
const API_AGENT = { id: 'r3one_api', displayName: 'Sol One', agentType: 'api' }
const OLD_LANE_AGENT = {
  id: 'r3one_cli',
  displayName: 'Bram Old',
  agentType: 'cli',
  primary_model_provider: 'anthropic-claude-cli',
  primary_model_name: 'claude-cli',
  primary_model_connection: { type: 'direct', id: 'claude-cli', service: 'anthropic-claude-cli' }
}
/** A `cli` leftover whose provider and connection name the Codex CLI lane R1 removed. */
const CODEX_LEFTOVER = {
  id: 'r3one_codex',
  displayName: 'Cora Old',
  agentType: 'cli',
  primary_model_provider: 'openai-codex',
  primary_model_name: 'gpt-5.5',
  primary_model_connection: { type: 'direct', id: 'codex-cli', service: 'openai-codex' }
}
const CLAUDE_RETIRED_SENTENCE = 'This agent ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted.'
const CODEX_RETIRED_SENTENCE = 'This agent ran on Codex CLI, which Batshit no longer supports, so it can only be deleted.'
const SUBAGENT = { id: 'r3one_helper', displayName: 'One Helper', subagentType: 'api' }

let agentRoute: Awaited<ReturnType<typeof loadAgentRoute>>
let listRoute: typeof import('../../../../routes/api/subagents/+server')
let agentReads = 0
let writes: Array<{ method: string; path: string; body: any }> = []

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
      if (path === '/api/agents' && method === 'POST') {
        // Store it, as the real route would, so the panel's read of the new agent finds it.
        await redis.createAgent({ ...body, user_id: USER } as any)
        return jsonResponse(await redis.json.get(`agent:${body.id}`), 201)
      }
      return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
    }
    if (path === '/api/agents') {
      const agents = []
      for (const id of await redis.sMembers(`user:${USER}:agents`)) agents.push(await redis.json.get(`agent:${id}`))
      return jsonResponse({ agents })
    }
    const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(path)
    if (agentMatch) {
      agentReads += 1
      return (await agentRoute.GET({ params: { id: agentMatch[1] }, request: new Request(`http://localhost${path}`),
        locals: { user: { id: USER } } } as any)) as Response
    }
    if (/^\/api\/agents\/[^/]+\/subagents$/.test(path)) return jsonResponse({ subagents: [] })
    if (path === '/api/subagents') return (await listRoute.GET({ locals: { user: { id: USER } } } as any)) as Response
    if (path.startsWith('/api/subagents/')) {
      return jsonResponse({ subagent: await redis.json.get(`subagent:${path.slice('/api/subagents/'.length)}`) })
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
  await redis.createAgent({ ...API_AGENT, user_id: USER } as any)
  await redis.createAgent({ ...OLD_LANE_AGENT, user_id: USER } as any)
  await redis.createAgent({ ...CODEX_LEFTOVER, user_id: USER } as any)
  await redis.json.set(`subagent:${SUBAGENT.id}`, '$', {
    ...SUBAGENT, user_id: USER, slug: SUBAGENT.id, specialty: 'general',
    created_at: '2026-10-27T00:00:00.000Z', updated_at: '2026-10-27T00:00:00.000Z'
  } as any)
  await redis.sAdd(`user:${USER}:subagents`, SUBAGENT.id)
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderPanel(initialAgentId: string, displayName: string) {
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId }
  })
  await screen.findByDisplayValue(displayName, {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  await pause(600)
}

/** The pill beside a row's title in the Settings menu (or its selected trigger), or null. */
function pillOf(title: HTMLElement): string | null {
  const row = title.parentElement as HTMLElement
  return row.querySelector('.batshit-settings-agent-type-pill')?.textContent?.trim() ?? null
}

describe('SA-139 R3: one Primary concept in Agent Settings', () => {
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

  it('the Settings menu labels Primary rows by role ("Primary Agent"), never by an API/CLI type, open and selected', async () => {
    await renderPanel(OLD_LANE_AGENT.id, OLD_LANE_AGENT.displayName)
    const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
    const titleSelector = { selector: '.batshit-settings-action-row-title' }
    // Selected: the older-lane agent's trigger shows the role, not "CLI".
    expect(pillOf(within(selector).getByText(OLD_LANE_AGENT.displayName, titleSelector))).toBe('Primary Agent')

    await fireEvent.keyDown(selector, { key: 'ArrowDown' })
    const subagentTitle = await screen.findByText(SUBAGENT.displayName, titleSelector)
    const menu = subagentTitle.closest('[role="menu"]') as HTMLElement
    for (const agent of [API_AGENT, OLD_LANE_AGENT]) {
      expect(pillOf(within(menu).getByText(agent.displayName, titleSelector))).toBe('Primary Agent')
    }
    // SA-139 R6 (D16): a Subagent row carries the role pill too, never a type.
    expect(pillOf(subagentTitle)).toBe('Subagent')
    const pills = [...menu.querySelectorAll('.batshit-settings-agent-type-pill')].map((pill) => pill.textContent?.trim())
    expect(pills).not.toContain('API')
    expect(pills).not.toContain('CLI')
  }, 60_000)

  it('an agent names no type; only an older-lane agent names the older Claude Code CLI lane', async () => {
    await renderPanel(API_AGENT.id, API_AGENT.displayName)
    expect(screen.queryByText('Agent Type:')).toBeNull()
    expect(screen.queryByText('Lane:')).toBeNull()
    expect(document.querySelector('.batshit-settings-identity-meta-row')?.textContent ?? '').not.toMatch(/\b(API|CLI)\b/)
    expect(screen.queryByText(/Primary Agents can only call/)).toBeNull()
    expect(writes).toEqual([])
  }, 60_000)

  it.each([
    { agent: OLD_LANE_AGENT, sentence: CLAUDE_RETIRED_SENTENCE, other: CODEX_RETIRED_SENTENCE },
    { agent: CODEX_LEFTOVER, sentence: CODEX_RETIRED_SENTENCE, other: CLAUDE_RETIRED_SENTENCE }
  ])('SA-139 R4: a leftover cli Primary ($agent.displayName) opens with the one retired line, no Claude Code CLI sections, Delete available, and saves nothing', async ({ agent, sentence, other }) => {
    await renderPanel(agent.id, agent.displayName)
    const notices = screen.getAllByTestId('primary-retired-type-notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].textContent).toContain(sentence)
    expect(notices[0].textContent).not.toContain(other)
    // No Claude Code CLI section of a Primary remains, and no older-lane label.
    expect(screen.queryByRole('group', { name: 'Claude permissions mode' })).toBeNull()
    for (const label of ['Use Project CLAUDE.md When Found', 'Always Enable Extended Thinking', 'Thinking Token Budget', 'Enable Chrome Integration']) {
      expect(screen.queryByText(label)).toBeNull()
    }
    expect(screen.queryByText('Lane:')).toBeNull()
    expect(screen.queryByText(/Older Claude Code CLI/)).toBeNull()

    // Delete is its one action, and it is available.
    await fireEvent.click(screen.getByRole('button', { name: 'Delete Primary Agent' }))
    const paragraph = await screen.findByText(/This saved record uses a Primary Agent type that Batshit removed/)
    const disclosure = paragraph.closest('.batshit-settings-delete-content-inner') as HTMLElement
    expect(within(disclosure).getByRole('button', { name: 'Delete Primary Agent' })).not.toBeDisabled()

    // Opening it saves nothing, and an edit is refused rather than saved.
    await fireEvent.input(document.getElementById('agent-display') as HTMLInputElement, { target: { value: `${agent.displayName} edited` } })
    await pause(1500)
    expect(writes).toEqual([])
  }, 60_000)

  it('SA-139 R4: the create dialog offers one Primary agent with no lane switch; a plain create sends agentType api', async () => {
    await renderPanel(API_AGENT.id, API_AGENT.displayName)
    await fireEvent.click(screen.getByRole('button', { name: /Create New Agent/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('Primary Agent Type')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /API agent|CLI agent/ })).toBeNull()
    // The older-lane opt-in left with the lane.
    expect(within(dialog).queryByRole('switch', { name: /Older Claude Code CLI Lane/ })).toBeNull()
    expect(within(dialog).queryByText(/Older Claude Code CLI/)).toBeNull()
    expect(writes).toEqual([])
    await fireEvent.input(within(dialog).getByLabelText('Display Name'), { target: { value: 'Fresh One' } })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(writes.filter((write) => write.path === '/api/agents')).toHaveLength(1))
    expect(writes[0].body).toMatchObject({ displayName: 'Fresh One', agentType: 'api' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }, 60_000)
})
