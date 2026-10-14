import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import BatshitSidebarHarness from '../batshit-sidebar/batshit-sidebar.harness.test.svelte'
import * as agentStore from '$lib/stores/agents.svelte'
import { appActionObservation } from '$lib/appActions/owners'

// Mount the real sidebar, AgentSelector, SettingsPanel and AgentSettingsPanel.
// Only the unrelated Goon editor is replaced by the existing guarded-draft fixture.
vi.mock('$lib/components/settings/panels/GoonsSettingsPanel.svelte', async () => ({
  default: (await import('$lib/appActions/SettingsOwner.fixture.svelte')).default
}))
vi.mock('$lib/services/userChannel', () => ({
  startUserChannel: vi.fn(() => () => {}),
  onUserChannelEvent: vi.fn(() => () => {})
}))

let releaseAgents: () => void
let initialAgentsSettled: boolean
let agentReads: number
let writes: string[]
let unrouted: string[]

const sheets = () => document.querySelectorAll('.batshit-settings-sheet')
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' }
})

// Warm the real lazy chunk before timing the user flow, as the shared component
// harness recommends for heavy dynamic imports.
beforeAll(async () => { await import('../settings/panels/AgentSettingsPanel.svelte') }, 60_000)

beforeEach(() => {
  agentStore.setAgents([])
  agentStore.setCurrentAgentId(null)
  agentReads = 0
  initialAgentsSettled = false
  writes = []
  unrouted = []
  const gate = new Promise<void>(resolve => { releaseAgents = resolve })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false
  }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = url.split('?')[0]
    const method = init.method ?? 'GET'
    if (method !== 'GET') writes.push(`${method} ${path}`)
    if (path === '/api/agents') {
      if (++agentReads === 1) {
        await gate
        initialAgentsSettled = true
      }
      return json({ agents: [] })
    }
    if (path === '/api/groups') return json({ groups: [] })
    if (path === '/api/subagents') return json({ subagents: [] })
    if (path === '/api/folders' || path === '/api/projects') return json([])
    if (path === '/api/sessions') return json([])
    if (path === '/api/goons') return json({ goons: [] })
    if (path === '/api/user/saved-models') return json({ models: [] })
    if (path === '/api/models') return json({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return json({ keys: {} })
    if (path === '/api/icons/library') return json({ icons: [], prefs: { favorites: [], recents: [] } })
    if (path === '/api/voice/profiles') return json({ profiles: [] })
    if (path === '/api/voice/providers') return json({ providers: [] })
    if (path === '/api/compatibility-matrix') return json({})
    if (path === '/api/native-tools/n8n/runtime' || path === '/api/native-tools/agent-browser/runtime' || path === '/api/native-tools/sandbox/status') {
      return json({ installed: false, running: false })
    }
    unrouted.push(`${method} ${path}`)
    return new Response(JSON.stringify({ error: `Unrouted: ${method} ${path}` }), { status: 404 })
  }))
})

afterEach(async () => {
  releaseAgents()
  await tick()
})

// Testing Library's shared cleanup destroys the real lazy panels after each case.
// Keep their route stubs through that teardown rather than restoring real fetch
// while an asynchronous onMount continuation is still draining.
afterAll(() => {
  vi.unstubAllGlobals()
  agentStore.setAgents([])
  agentStore.setCurrentAgentId(null)
})

async function mount(finished = true) {
  render(BatshitSidebarHarness, { props: {
    withAgentSelector: true,
    data: { user: { id: 'settings-init-user' }, userSettings: {
      onboarding_settings: finished ? { setup_skipped_at: '2026-10-13T10:00:00Z' } : {}
    } }
  } })
  await waitFor(() => expect(agentReads).toBe(1))
}

async function settleInitialization() {
  releaseAgents()
  await waitFor(() => expect(initialAgentsSettled).toBe(true))
  // Drain the actual Promise.all/load continuation and Svelte's sheet effects.
  await tick()
  await tick()
}

describe('AgentSelector empty-agent initialization (BL-1481)', () => {
  it('uses one Settings sheet for automatic creation and a later sidebar Open settings, then cancels, closes and reopens normally', async () => {
    await mount()
    await settleInitialization()
    const create = await screen.findByRole('dialog', { name: 'Create Primary Agent or Subagent' })
    expect(sheets()).toHaveLength(1)
    await fireEvent.click(screen.getByTestId('open-settings-button'))
    expect(sheets()).toHaveLength(1)
    await fireEvent.click(within(create).getByRole('button', { name: 'Cancel', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create Primary Agent or Subagent' })).toBeNull())
    expect(sheets()).toHaveLength(1)
    const close = screen.getAllByRole('button', { name: 'Close settings' }).at(-1)!
    await fireEvent.click(close)
    await waitFor(() => expect(sheets()).toHaveLength(0))
    await fireEvent.click(screen.getByTestId('open-settings-button'))
    await screen.findByRole('button', { name: 'Create Primary Agent', exact: true })
    expect(sheets()).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: 'Create Primary Agent or Subagent' })).toBeNull()
    expect(writes).toEqual([])
    expect(unrouted).toEqual([])
  }, 30_000)

  it('does not open another sheet or automatic Create over Settings opened before the empty-agent load finishes', async () => {
    await mount()
    await fireEvent.click(screen.getByTestId('open-settings-button'))
    await screen.findByRole('button', { name: 'Create Primary Agent', exact: true })
    expect(sheets()).toHaveLength(1)
    await settleInitialization()
    expect(sheets()).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: 'Create Primary Agent or Subagent' })).toBeNull()
    expect(appActionObservation().settings).toMatchObject({ open: true, tab: 'agents' })
    expect(writes).toEqual([])
    expect(unrouted).toEqual([])
  }, 30_000)

  it('keeps an early human tab and its draft when empty-agent initialization finishes', async () => {
    await mount()
    window.dispatchEvent(new CustomEvent('batshit:open-settings', { detail: { tab: '3d-goons' } }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Make Goon draft' }))
    const draft = screen.getByRole('textbox', { name: 'Goon fixture draft' })
    await fireEvent.input(draft, { target: { value: 'Human draft\nstays exact' } })
    await settleInitialization()
    expect(sheets()).toHaveLength(1)
    expect(appActionObservation().settings).toMatchObject({ open: true, tab: '3d-goons', dirty: true, pendingHumanAction: false })
    expect(screen.getByRole('textbox', { name: 'Goon fixture draft' })).toBe(draft)
    expect(draft).toHaveValue('Human draft\nstays exact')
    expect(screen.queryByRole('dialog', { name: 'Create Primary Agent or Subagent' })).toBeNull()
    expect(writes).toEqual([])
    expect(unrouted).toEqual([])
  }, 30_000)

  it('leaves unfinished first-run onboarding in charge instead of automatically opening agent creation', async () => {
    await mount(false)
    await settleInitialization()
    expect(sheets()).toHaveLength(0)
    expect(screen.queryByRole('dialog', { name: 'Create Primary Agent or Subagent' })).toBeNull()
    expect(writes).toEqual([])
    expect(unrouted).toEqual([])
  }, 30_000)
})
