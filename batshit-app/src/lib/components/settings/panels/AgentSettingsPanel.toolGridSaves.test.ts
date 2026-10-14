import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import {
  installAgentRoutes,
  jsonResponse,
  loadAgentRoute,
  storedAgent,
  type AgentPut
} from '$lib/test-utils/agentPutRoute'

/**
 * BL-855, the Agent Settings half. The Primary Agent's Tool Grid save sent `defaultMCPGateways`,
 * `defaultMCPToolSelections` and `dcmDisplaySettings` together whole, and its zip save sent every
 * zip field with `custom_tool_settings` whole, from the copy the panel loaded. A gateway, tool,
 * display or zip choice made since (the chat bar's Tools menu, a second Settings window) was
 * taken back by the next change of anything else. The panel keeps each section as it was loaded
 * or last saved and sends only what differs from it: the lists whole when they differ, the display
 * settings entry by entry (`diffAgentBlock`), each zip field on its own and `custom_tool_settings`
 * whole only when a custom tool row differs. A failed save leaves the baseline as it was.
 *
 * A Subagent's Tool Grid save sends the same partial body to the Subagent route (BL-914: it writes
 * `dcmDisplaySettings` entry by entry): the full Subagent coverage is
 * `AgentSettingsPanel.subagentBlockSaves.test.ts`, and one pin sits near the end of this file.
 *
 * Renders the REAL panel with the card that holds the grid replaced by a stand-in that hands the
 * test the card's callbacks (the panel's own save code is what runs). `fetch` sends
 * `/api/agents/<id>` and `/api/subagents/<id>` to the REAL routes on the default lane's Redis fake.
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
vi.mock('$lib/components/settings/agent/AgentMcpDefaultsCard.svelte', async () => ({
  default: (await import('../../mcps/__tests__/AgentMcpDefaultsCardStub.test.svelte')).default
}))

useRedisTestServer()

const USER = 'sstg_user'
const AGENT = 'sstg_agent'
const SUB = 'sstg_sub'
const SUB_NAME = 'Sstg Panel Sub'

const DCM_EMPTY = {
  version: 1,
  groups: {},
  tools: {},
  groupDisplayPreferences: {},
  toolDisplayPreferences: {}
}

/** What the record holds when the panel opens. */
const OPENED = {
  defaultMCPGateways: ['gw_a'],
  defaultMCPToolSelections: ['tool_one'],
  defaultTools: ['cli_x'],
  dcmDisplaySettings: DCM_EMPTY,
  custom_tool_settings: [] as unknown[],
  zip_agent_control_enabled: null as boolean | null,
  zip_ai_view_mode: null as string | null
}

/** What another window saved since. */
const OTHER_WINDOW = {
  defaultMCPGateways: ['gw_a', 'gw_c'],
  defaultTools: ['cli_y'],
  dcmDisplaySettings: {
    ...DCM_EMPTY,
    groups: { 'gw_a::Files': 'hidden' },
    groupDisplayPreferences: { 'gw_a::Files': 'use-global' }
  },
  custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 4 }],
  zip_ai_view_mode: 'inline',
  buffer_size_read_file: 9
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

let agentRoute: Awaited<ReturnType<typeof loadAgentRoute>>
let subagentRoute: typeof import('../../../../routes/api/subagents/[id]/+server')
let puts: AgentPut[] = []
let subagentPuts: Array<{ body: Record<string, any> }> = []
let failNextPuts = 0
/** While set, the next Subagent PUT waits for it before it reaches the route (a slow round trip). */
let holdNextSubagentPut: Promise<void> | null = null
/** While set, the next Subagent PUT answers 500 without touching the record. */
let failNextSubagentPut = false
const originalFetch = global.fetch

beforeAll(async () => {
  agentRoute = await loadAgentRoute()
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

beforeEach(() => {
  ensureBrowserStubs()
  failNextPuts = 0
  holdNextSubagentPut = null
  failNextSubagentPut = false
  subagentPuts = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  global.fetch = originalFetch
  agentStore.setAgents([])
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const card = () => (globalThis as any).__mcpCardProps as Record<string, any>

async function fire(action: () => void) {
  action()
  await tick()
}

async function openToolsTab() {
  const tab = screen.getAllByRole('tab').find((element) => /Tools/.test(element.textContent ?? ''))
  expect(tab).toBeTruthy()
  await fireEvent.mouseDown(tab as HTMLElement)
  await fireEvent.click(tab as HTMLElement)
  await waitFor(() => expect(card()).toBeTruthy(), { timeout: 10_000 })
}

/**
 * Creates the agent (`record`: what is stored when the panel opens), renders the panel on it, and
 * opens the Tools tab. Whatever `otherWindow` names is saved AFTER the panel loaded.
 */
async function openPanel(input: { record?: Record<string, unknown>; otherWindow?: Record<string, unknown> } = {}) {
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Tool grid probe',
    agentType: 'api',
    ...OPENED,
    ...(input.record ?? {})
  } as any)
  const routes = installAgentRoutes({
    agentId: AGENT,
    userId: USER,
    route: agentRoute,
    failPutsWith: () => {
      if (failNextPuts > 0) {
        failNextPuts -= 1
        return 500
      }
      return null
    },
    extra: async (path, method, init) => {
      if (path === '/api/agents' && method === 'GET') return jsonResponse({ agents: [await storedAgent(AGENT)] })
      if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
      if (path === '/api/subagents' && method === 'GET') {
        const sub = await redis.json.get(`subagent:${SUB}`)
        return jsonResponse({ subagents: sub ? [sub] : [] })
      }
      if (path === `/api/subagents/${SUB}`) {
        if (method === 'PUT') {
          subagentPuts.push({ body: JSON.parse(String(init.body)) })
          if (failNextSubagentPut) {
            failNextSubagentPut = false
            return jsonResponse({ error: 'The Subagent could not be saved just now.' }, 500)
          }
          if (holdNextSubagentPut) {
            const gate = holdNextSubagentPut
            holdNextSubagentPut = null
            await gate
          }
        }
        const request = new Request(`http://localhost${path}`, {
          method,
          body: method === 'PUT' ? String(init.body) : undefined
        })
        const handler = method === 'PUT' ? subagentRoute.PUT : subagentRoute.GET
        return (await handler({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
      }
      if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
      if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
      if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
      if (path === '/api/goons') return jsonResponse({ goons: [] })
      if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
      if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
      if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
      return undefined
    }
  })
  puts = routes.puts
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Tool grid probe', {}, { timeout: 15_000 })
  await openToolsTab()
  // Past the autosave debounces, so a save the opening queued would have gone out.
  await pause(1500)
  expect(puts).toEqual([])
  if (input.otherWindow) {
    const record = await storedAgent(AGENT)
    await redis.json.set(`agent:${AGENT}`, '$', { ...record, ...input.otherWindow } as any)
  }
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 8_000 })
  // Let the save's answer land in the panel before the next step.
  await pause(400)
}

describe('Agent Settings sends only the Tool Grid values the user changed (BL-855)', () => {
  it('a gateway change sends the gateway list alone; CLI tools, display settings and zip choices saved in another window survive', async () => {
    await openPanel({ otherWindow: OTHER_WINDOW })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    const record = await storedAgent(AGENT)
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.defaultTools).toEqual(['cli_y'])
    expect(record.dcmDisplaySettings).toEqual(OTHER_WINDOW.dcmDisplaySettings)
    expect(record.custom_tool_settings).toEqual(OTHER_WINDOW.custom_tool_settings)
    expect(record.zip_ai_view_mode).toBe('inline')
  }, 90_000)

  it('a display change sends only the entries it changed; a gateway list saved in another window survives', async () => {
    await openPanel({ otherWindow: { defaultMCPGateways: ['gw_a', 'gw_c'] } })

    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      dcmDisplaySettings: {
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      }
    })
    const record = await storedAgent(AGENT)
    expect(record.dcmDisplaySettings.groups).toEqual({ 'gw_b::Reading': 'group-only' })
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_c'])
    // The agents store copy (the chat bar's Tools menu reads it) took the entries over the block it held.
    expect(agentStore.getAgentById(AGENT)?.dcmDisplaySettings).toEqual({
      ...DCM_EMPTY,
      groups: { 'gw_b::Reading': 'group-only' },
      groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
    })
  }, 90_000)

  it('a display change keeps an entry another window saved (entry by entry)', async () => {
    await openPanel({ otherWindow: OTHER_WINDOW })

    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))

    await waitForPuts(1)
    expect((await storedAgent(AGENT)).dcmDisplaySettings.groups).toEqual({
      'gw_a::Files': 'hidden',
      'gw_b::Reading': 'group-only'
    })
  }, 90_000)

  it('taking an entry out of the display settings removes that entry alone (a dropped key goes as null)', async () => {
    const held = {
      ...DCM_EMPTY,
      groups: { 'gw_a::Files': 'hidden', 'gw_b::Reading': 'group-only' },
      groupDisplayPreferences: { 'gw_a::Files': 'use-global', 'gw_b::Reading': 'group-only' }
    }
    await openPanel({ record: { dcmDisplaySettings: held } })

    await fire(() =>
      card().onDcmDisplaySettingsChange({
        ...held,
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      })
    )

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      dcmDisplaySettings: { groups: { 'gw_a::Files': null }, groupDisplayPreferences: { 'gw_a::Files': null } }
    })
    expect((await storedAgent(AGENT)).dcmDisplaySettings.groups).toEqual({ 'gw_b::Reading': 'group-only' })
  }, 90_000)

  it('an agent that holds its display settings only under the older name gets the whole block on its first display save', async () => {
    const older = { ...DCM_EMPTY, groups: { 'gw_a::Files': 'hidden' }, groupDisplayPreferences: { 'gw_a::Files': 'use-global' } }
    await openPanel({ record: { dcmDisplaySettings: undefined, dcm_display_settings: older } })

    await fire(() =>
      card().onDcmDisplaySettingsChange({ ...older, groups: { ...older.groups, 'gw_b::Reading': 'group-only' } })
    )

    await waitForPuts(1)
    // Every entry goes (the older name's included), not just the new one: the new name is written from it.
    expect(puts[0].body.dcmDisplaySettings.groups).toEqual({ 'gw_a::Files': 'hidden', 'gw_b::Reading': 'group-only' })
    expect((await storedAgent(AGENT)).dcmDisplaySettings.groups).toEqual({
      'gw_a::Files': 'hidden',
      'gw_b::Reading': 'group-only'
    })
  }, 90_000)

  it('a zip layout change sends that field alone; a custom tool row and a buffer saved in another window survive', async () => {
    await openPanel({ otherWindow: { ...OTHER_WINDOW, zip_ai_view_mode: null } })

    await fire(() => card().onZipAiViewModeChange('appended'))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ zip_ai_view_mode: 'appended' })
    const record = await storedAgent(AGENT)
    expect(record.zip_ai_view_mode).toBe('appended')
    expect(record.custom_tool_settings).toEqual(OTHER_WINDOW.custom_tool_settings)
    expect(record.buffer_size_read_file).toBe(9)
  }, 90_000)

  // SA-129 DL-06 (BL-1484): the parked zip control permission has no control, and a zip save
  // never names its hidden experiment key or the ignored legacy key, so both stay as stored.
  it('offers no zip permission control, and a zip save leaves the hidden keys alone', async () => {
    await openPanel({ record: { zip_agent_control_experiment: true, zip_agent_control_enabled: true }, otherWindow: OTHER_WINDOW })
    expect(card().onZipAgentControlChange).toBeUndefined()
    expect(card().zipAgentControlEnabled).toBeUndefined()

    await fire(() => card().onZipAiViewModeChange('appended'))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ zip_ai_view_mode: 'appended' })
    const record = await storedAgent(AGENT)
    expect(record.zip_agent_control_experiment).toBe(true)
    expect(record.zip_agent_control_enabled).toBe(true)
    expect(record.custom_tool_settings).toEqual(OTHER_WINDOW.custom_tool_settings)
  }, 90_000)

  it('a buffer change of a field row sends that field alone; another window\'s other buffer survives', async () => {
    await openPanel({ otherWindow: OTHER_WINDOW })

    await fire(() => card().onNonMcpZipOverrideChange('write_file', { buffer_size: '12' }))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ buffer_size_write_file: 12 })
    const record = await storedAgent(AGENT)
    expect(record.buffer_size_write_file).toBe(12)
    expect(record.buffer_size_read_file).toBe(9)
  }, 90_000)

  it('a custom tool row change sends custom_tool_settings whole, and only that; a layout saved in another window survives', async () => {
    await openPanel({ otherWindow: { zip_ai_view_mode: 'inline' } })

    await fire(() => card().onToolZipOverrideChange('tool_r', { buffer_size: '8' }))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 8 }] })
    const record = await storedAgent(AGENT)
    expect(record.custom_tool_settings).toEqual([{ tool_name: 'tool_r', buffer_size: 8 }])
    expect(record.zip_ai_view_mode).toBe('inline')
  }, 90_000)

  it('each later change sends only its own field: the baseline moves to what the last save stored', async () => {
    await openPanel()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    await fire(() => card().onZipAiViewModeChange('appended'))
    await waitForPuts(2)
    await fire(() => card().onNonMcpZipOverrideChange('write_file', { buffer_size: '12' }))
    await waitForPuts(3)

    expect(puts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    expect(puts[1].body).toEqual({ zip_ai_view_mode: 'appended' })
    expect(puts[2].body).toEqual({ buffer_size_write_file: 12 })
  }, 90_000)

  it('a second Tool Grid change does not send the first again: the baseline moves to what the last Tool Grid save stored', async () => {
    await openPanel()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))
    await waitForPuts(2)
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b', 'gw_c']))
    await waitForPuts(3)

    expect(puts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    expect(puts[1].body).toEqual({
      dcmDisplaySettings: {
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      }
    })
    expect(puts[2].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b', 'gw_c'] })
  }, 90_000)

  it('a failed save leaves the baseline as it was: the next change sends the failed one again, with its own', async () => {
    await openPanel()

    failNextPuts = 1
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a'])

    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))
    await waitForPuts(2)
    expect(puts[1].body).toEqual({
      defaultMCPGateways: ['gw_a', 'gw_b'],
      dcmDisplaySettings: {
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      }
    })
  }, 90_000)

  it('a failed zip save leaves the baseline as it was: the next zip change sends the failed one again, with its own', async () => {
    await openPanel()

    failNextPuts = 1
    await fire(() => card().onZipAiViewModeChange('appended'))
    await waitForPuts(1)
    expect((await storedAgent(AGENT)).zip_ai_view_mode).toBeNull()

    await fire(() => card().onNonMcpZipOverrideChange('write_file', { buffer_size: '12' }))
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ zip_ai_view_mode: 'appended', buffer_size_write_file: 12 })
  }, 90_000)

  it('Reset to global settings sends only the values that were set, each as null or removed', async () => {
    await openPanel({
      record: {
        defaultMCPGateways: ['gw_a', 'gw_b'],
        zip_ai_view_mode: 'inline',
        buffer_size_read_file: 9,
        dcmDisplaySettings: { ...DCM_EMPTY, groups: { 'gw_a::Files': 'hidden' }, groupDisplayPreferences: { 'gw_a::Files': 'use-global' } }
      }
    })

    // BL-1032: real creation supplies granular overrides that the minimal in-memory fixture
    // omits. Reset clears all existing choices, including each auto/disabled pair.
    const before = await storedAgent(AGENT)
    const expectedZipClear: Record<string, null> = { zip_ai_view_mode: null, buffer_size_read_file: null }
    for (const kind of ['read_file', 'write_file', 'edit_file', 'execute_command', 'list_files', 'all_other_tools']) {
      for (const prefix of ['buffer_size', 'zip_threshold', 'auto_zip', 'zip_disabled']) {
        const key = `${prefix}_${kind}`
        if (before[key] != null) expectedZipClear[key] = null
      }
      if (before[`auto_zip_${kind}`] != null) expectedZipClear[`zip_disabled_${kind}`] = null
    }

    await fire(() => card().onResetToGlobalSettings())

    await waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(2), { timeout: 8_000 })
    await pause(1200)
    const zip = puts.find((put) => 'zip_ai_view_mode' in put.body)
    expect(zip?.body).toEqual(expectedZipClear)
    expect(zip?.body).not.toHaveProperty('zip_agent_control_enabled')
    expect(zip?.body).not.toHaveProperty('zip_agent_control_experiment')
    expect(zip?.body).not.toHaveProperty('zip_tool_notes_enabled')
    const mcp = puts.find((put) => 'defaultMCPGateways' in put.body)
    expect(mcp?.body).toEqual({
      defaultMCPGateways: [],
      defaultMCPToolSelections: [],
      dcmDisplaySettings: { groups: { 'gw_a::Files': null }, groupDisplayPreferences: { 'gw_a::Files': null } }
    })
    await waitFor(async () => {
      const saved = await storedAgent(AGENT)
      for (const key of Object.keys(expectedZipClear)) expect(saved[key] == null, key).toBe(true)
      expect(saved.defaultMCPGateways).toEqual([])
    }, { timeout: 8_000 })
    const record = await storedAgent(AGENT)
    expect(record.dcmDisplaySettings.groups).toEqual({})
    expect(record.defaultMCPGateways).toEqual([])
    expect(record.displayName).toBe(before.displayName)
    // Inherited nulls are canonically removed on a save; their effective setting stays inherited.
    expect(record.zip_agent_control_enabled ?? null).toBe(before.zip_agent_control_enabled ?? null)
    expect(record.zip_tool_notes_enabled ?? null).toBe(before.zip_tool_notes_enabled ?? null)
  }, 90_000)

  it('opening saves nothing, and a change that leaves every value as it was sends nothing', async () => {
    await openPanel()

    await fire(() => card().onGatewaysChange(['gw_a']))
    await fire(() => card().onZipAiViewModeChange('__inherit__'))
    await pause(1500)

    expect(puts).toEqual([])
  }, 90_000)
})

/** Seeds an API Subagent, renders the panel, selects the Subagent and opens its Tools tab. */
async function openSubagentTools() {
  await redis.json.set(`subagent:${SUB}`, '$', {
    id: SUB,
    user_id: USER,
    displayName: SUB_NAME,
    slug: SUB,
    subagentType: 'api',
    specialty: 'general',
    defaultMCPGateways: ['gw_a'],
    defaultMCPToolSelections: ['tool_one'],
    dcmDisplaySettings: DCM_EMPTY,
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  } as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
  await openPanel()

  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(SUB_NAME, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  await screen.findByDisplayValue(SUB_NAME, {}, { timeout: 15_000 })
  await openToolsTab()
  await pause(1500)
  expect(subagentPuts).toEqual([])
}

describe('a Subagent\'s Tool Grid save sends only what changed too (BL-914: the Subagent route writes the display settings entry by entry)', () => {
  it('a gateway change on a Subagent sends its gateway list alone', async () => {
    await openSubagentTools()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))

    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    expect(puts).toEqual([])
  }, 120_000)
})

describe('a Subagent Tool Grid save that lands leaves an unsaved core edit alone (BL-844, re-review fix)', () => {
  it('a Tool Grid save landing while a name is typed but not saved: the name stays in the field, and the next save sends exactly it', async () => {
    await openSubagentTools()
    let release: () => void = () => {}
    holdNextSubagentPut = new Promise<void>((resolve) => {
      release = resolve
    })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })

    // A core field is typed while the Tool Grid save is in flight; its own save waits in its debounce.
    const nameInput = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: 'Sstg R' } })
    release()

    await waitFor(
      async () => expect(((await redis.json.get(`subagent:${SUB}`)) as any).defaultMCPGateways).toEqual(['gw_a', 'gw_b']),
      { timeout: 8_000 }
    )
    await pause(200)
    expect(subagentPuts.length).toBe(1)
    expect(nameInput.value).toBe('Sstg R')

    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(subagentPuts[1].body).toEqual({ displayName: 'Sstg R' })
    await pause(500)
    const record = (await redis.json.get(`subagent:${SUB}`)) as any
    expect(record.displayName).toBe('Sstg R')
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(nameInput.value).toBe('Sstg R')
    await pause(1200)
    expect(subagentPuts.length).toBe(2)
  }, 120_000)
})

describe('a Subagent Tool Grid or CLI tools change leaves the error of a failed core save on screen (BL-844, third re-review fix)', () => {
  /** A core save fails: the name typed stays unsaved, its error is on screen. */
  async function failACoreSave() {
    await openSubagentTools()
    failNextSubagentPut = true
    const nameInput = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: 'Sstg R' } })
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ displayName: 'Sstg R' })
    expect(await screen.findByText(/could not be saved just now/)).toBeTruthy()
    return nameInput
  }

  async function expectFailedNameStillUnsaved(nameInput: HTMLInputElement) {
    await pause(1500)
    // The section save worked and sent only its own fields; the failed name is still in the field,
    // was not marked as saved, its error is still on screen, and the status does not read Saved.
    expect(subagentPuts.length).toBe(2)
    expect(subagentPuts[1].body).not.toHaveProperty('displayName')
    expect(nameInput.value).toBe('Sstg R')
    expect(((await redis.json.get(`subagent:${SUB}`)) as any).displayName).toBe(SUB_NAME)
    expect(screen.getByText(/could not be saved just now/)).toBeTruthy()
    expect(screen.queryByText('Saved')).toBeNull()

    // The next core edit sends the failed name again, with its own change, and the error goes.
    await fireEvent.input(document.getElementById('subagent-timeout') as HTMLInputElement, { target: { value: '60' } })
    await waitFor(() => expect(subagentPuts.length).toBe(3), { timeout: 8_000 })
    expect(subagentPuts[2].body).toEqual({ displayName: 'Sstg R', timeout_seconds: 60 })
    await waitFor(() => expect(screen.queryByText(/could not be saved just now/)).toBeNull(), { timeout: 5_000 })
    expect(await screen.findByText('Saved')).toBeTruthy()
  }

  it('a Tool Grid change after a failed core save: the error stays, the text stays, and the next core edit resends it', async () => {
    const nameInput = await failACoreSave()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(subagentPuts[1].body.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])

    await expectFailedNameStillUnsaved(nameInput)
  }, 120_000)

  it('a CLI tools change after a failed core save: the error stays, the text stays, and the next core edit resends it', async () => {
    const nameInput = await failACoreSave()

    await fire(() => card().onCliToolIdsChange(['cli_x']))
    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(subagentPuts[1].body).toEqual({ defaultTools: ['cli_x'] })

    await expectFailedNameStillUnsaved(nameInput)
  }, 120_000)

  it('a Tool Grid save landing while a name waits for its save: the status does not read Saved, and it does once the name is saved', async () => {
    await openSubagentTools()
    let release: () => void = () => {}
    holdNextSubagentPut = new Promise<void>((resolve) => {
      release = resolve
    })
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })

    await fireEvent.input(screen.getByDisplayValue(SUB_NAME), { target: { value: 'Sstg R' } })
    release()
    await waitFor(
      async () => expect(((await redis.json.get(`subagent:${SUB}`)) as any).defaultMCPGateways).toEqual(['gw_a', 'gw_b']),
      { timeout: 8_000 }
    )
    await pause(200)

    // The gateway save is in, the name is still waiting: nothing is saved yet as far as the name goes.
    expect(subagentPuts.length).toBe(1)
    expect(screen.queryByText('Saved')).toBeNull()

    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(subagentPuts[1].body).toEqual({ displayName: 'Sstg R' })
    expect(await screen.findByText('Saved')).toBeTruthy()
  }, 120_000)
})
