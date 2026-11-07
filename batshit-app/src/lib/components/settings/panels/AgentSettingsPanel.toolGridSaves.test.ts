import { MCP_SETTINGS_REVISION_HEADER, withoutExpectedMcpSettings } from '$lib/utils/agentSettingsSectionSaves'
import { CLI_GROUP_KEY, cliGroupEnablePatch } from '$lib/utils/cliToolGridEnable'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { subagentStore } from '$lib/stores/subagents.svelte'
import { setUserSettings } from '$lib/stores/userSettings.svelte'
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

// Tool Grid persistence never analyzes audio. Keep unrelated packaged WASM assets out
// of this mounted Settings fixture, including when dependencies resolve from a worktree.
vi.mock('$lib/services/rhubarbWasmLipSync', () => ({
  analyzeGoonLipSyncWithRhubarbWasm: vi.fn(async () => {
    throw new Error('Lip sync is outside this Tool Grid persistence fixture')
  })
}))

// Round 2 (S1): the dead-copies store is the one thing observed; every other export is the real one.
const deadCopies = vi.hoisted(() => ({ refreshAll: vi.fn(async () => {}) }))
vi.mock('$lib/stores/zipDeadCopies.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/zipDeadCopies.svelte')>()),
  refreshAllDeadCopies: deadCopies.refreshAll
}))

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
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
/** The host-only status reads the panel made (BL-2049). */
let sandboxStatusReads: string[] = []
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
  sandboxStatusReads = []
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
  setUserSettings(null)
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
async function openPanel(input: {
  record?: Record<string, unknown>
  otherWindow?: Record<string, unknown>
  /** What `/api/native-tools/sandbox/status` reports as the host (a Mac outside any container by default), that both reads fail, or that they never answer. */
  host?: { platform: string; containerized: boolean } | 'fails' | 'pending'
  /** BL-2049: only the full sandbox probes (not `?hostOnly=1`) fail or never answer; the host-only read keeps `host`. */
  fullProbe?: 'fails' | 'pending'
  /** BL-2049: only the host-only read (`?hostOnly=1`) fails; the full probes keep `host`. */
  hostOnlyFails?: boolean
} = {}) {
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
    extra: async (path, method, init, url) => {
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
      if (path === '/api/native-tools/sandbox/status') {
        const hostOnly = url.includes('hostOnly=1')
        if (hostOnly) sandboxStatusReads.push(url)
        if (input.host === 'fails' || (hostOnly && input.hostOnlyFails)) return jsonResponse({ error: 'Status is down.' }, 500)
        if (input.host === 'pending') return await new Promise<Response>(() => {})
        if (!hostOnly && input.fullProbe === 'fails') return jsonResponse({ error: 'sbx timed out.' }, 500)
        if (!hostOnly && input.fullProbe === 'pending') return await new Promise<Response>(() => {})
        const host = input.host ?? { platform: 'darwin', containerized: false }
        return jsonResponse({ success: true, available: true, supported: true, containerized: host.containerized,
          backend: 'apple_container', policy: 'test', version: 'test', reason: null,
          typedFileToolsHost: { ...host, linuxKernel: null } })
      }
      if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
      if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
      if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
      if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
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
  it('a stale whole gateway change is refused visibly while CLI, display, Zip and the competing gateway choice survive', async () => {
    await openPanel({ otherWindow: OTHER_WINDOW })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))

    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    const record = await storedAgent(AGENT)
    expect(record.defaultMCPGateways).toEqual(OTHER_WINDOW.defaultMCPGateways)
    expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(card().mcpSaveError).toMatch(/changed/)
    expect(Object.keys(puts[0].body.expectedMcpSettings)).toEqual(['defaultMCPGateways'])
    expect(record.defaultTools).toEqual(['cli_y'])
    expect(record.dcmDisplaySettings).toEqual(OTHER_WINDOW.dcmDisplaySettings)
    expect(record.custom_tool_settings).toEqual(OTHER_WINDOW.custom_tool_settings)
    expect(record.zip_ai_view_mode).toBe('inline')
  }, 90_000)

  it('a display change sends only the entries it changed; a gateway list saved in another window survives', async () => {
    await openPanel({ otherWindow: { defaultMCPGateways: ['gw_a', 'gw_c'] } })

    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))

    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({
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
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({
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
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ zip_ai_view_mode: 'appended' })
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
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ zip_ai_view_mode: 'appended' })
    const record = await storedAgent(AGENT)
    expect(record.zip_agent_control_experiment).toBe(true)
    expect(record.zip_agent_control_enabled).toBe(true)
    expect(record.custom_tool_settings).toEqual(OTHER_WINDOW.custom_tool_settings)
  }, 90_000)

  it('a buffer change of a field row sends that field alone; another window\'s other buffer survives', async () => {
    await openPanel({ otherWindow: OTHER_WINDOW })

    await fire(() => card().onNonMcpZipOverrideChange('write_file', { buffer_size: '12' }))

    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ buffer_size_write_file: 12 })
    const record = await storedAgent(AGENT)
    expect(record.buffer_size_write_file).toBe(12)
    expect(record.buffer_size_read_file).toBe(9)
  }, 90_000)

  it('a custom tool row change sends custom_tool_settings whole, and only that; a layout saved in another window survives', async () => {
    await openPanel({ otherWindow: { zip_ai_view_mode: 'inline' } })

    await fire(() => card().onToolZipOverrideChange('tool_r', { buffer_size: '8' }))

    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 8 }] })
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

    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    expect(withoutExpectedMcpSettings(puts[1].body)).toEqual({ zip_ai_view_mode: 'appended' })
    expect(withoutExpectedMcpSettings(puts[2].body)).toEqual({ buffer_size_write_file: 12 })
  }, 90_000)

  it('a second Tool Grid change does not send the first again: the baseline moves to what the last Tool Grid save stored', async () => {
    await openPanel()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))
    await waitForPuts(2)
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b', 'gw_c']))
    await waitForPuts(3)

    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    expect(withoutExpectedMcpSettings(puts[1].body)).toEqual({
      dcmDisplaySettings: {
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      }
    })
    expect(withoutExpectedMcpSettings(puts[2].body)).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b', 'gw_c'] })
  }, 90_000)

  it('an unconfirmed whole-list save keeps the draft and requires an explicit saved read before a new choice', async () => {
    await openPanel()
    failNextPuts = 1
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a'])
    expect(card().defaultMCPGateways).toEqual(['gw_a','gw_b'])
    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))
    await pause(1500)
    expect(puts).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Tool Settings' }))
    await waitFor(() => expect(card().defaultMCPGateways).toEqual(['gw_a']))
    expect(puts).toHaveLength(1)
    await fire(() => card().onGatewaysChange(['gw_a','gw_b']))
    await waitForPuts(2)
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a','gw_b'])
  }, 90_000)

  it('a failed zip save leaves the baseline as it was: the next zip change sends the failed one again, with its own', async () => {
    await openPanel()

    failNextPuts = 1
    await fire(() => card().onZipAiViewModeChange('appended'))
    await waitForPuts(1)
    expect((await storedAgent(AGENT)).zip_ai_view_mode).toBeNull()

    await fire(() => card().onNonMcpZipOverrideChange('write_file', { buffer_size: '12' }))
    await waitForPuts(2)
    expect(withoutExpectedMcpSettings(puts[1].body)).toEqual({ zip_ai_view_mode: 'appended', buffer_size_write_file: 12 })
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
    expect(withoutExpectedMcpSettings(zip!.body)).toEqual(expectedZipClear)
    expect(zip?.body).not.toHaveProperty('zip_agent_control_enabled')
    expect(zip?.body).not.toHaveProperty('zip_agent_control_experiment')
    expect(zip?.body).not.toHaveProperty('zip_tool_notes_enabled')
    const mcp = puts.find((put) => 'defaultMCPGateways' in put.body)
    expect(withoutExpectedMcpSettings(mcp!.body)).toEqual({
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
async function openSubagentTools(beforeSwitch?: () => void, record: Record<string, unknown> = {}) {
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
    updated_at: '2026-09-28T00:00:00.000Z',
    ...record
  } as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
  await openPanel()
  beforeSwitch?.()

  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(SUB_NAME, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  await screen.findByDisplayValue(SUB_NAME, {}, { timeout: 15_000 })
  await openToolsTab()
  await pause(1500)
  expect(subagentPuts).toEqual([])
}

describe('one CLI family choice uses one captured native/display save', () => {
  const hidden = { ...DCM_EMPTY, groups: { [CLI_GROUP_KEY]: 'hidden', 'gw_a::Files': 'group-only' }, groupDisplayPreferences: { [CLI_GROUP_KEY]: 'group+tools+names' }, tools: { unrelated: 'hidden' } }
  it('Subagent Fabric displays unavailable OFF without changing an irrelevant saved ON flag', async () => {
    await openSubagentTools(undefined, { provider_specific_settings: { nativeTools: { batshitToolsEnabled: true } } })
    const fabric = card().getEnableControl('fabric_find')
    expect(fabric.checked).toBe(false)
    expect(fabric.disabled).toBe(true)
    expect(fabric.notice).toBeTruthy()
    await fire(() => fabric.onChange(true))
    await pause(900)
    expect(subagentPuts).toHaveLength(0)
    expect((await redis.json.get(`subagent:${SUB}`) as any).provider_specific_settings.nativeTools.batshitToolsEnabled).toBe(true)
  }, 120_000)
  it('explicit ON restores its retained detail in one PUT, preserves members/siblings, and does not echo autosaves', async () => {
    await openPanel({ record: { provider_specific_settings: { temperature: 0.4, nativeTools: { cliToolsEnabled: false, bashEnabled: false } }, dcmDisplaySettings: hidden } })
    await fire(() => card().getEnableControl('cli_tools').onChange(true, cliGroupEnablePatch(hidden, 'hidden')))
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ provider_specific_settings: { nativeTools: { cliToolsEnabled: true } }, dcmDisplaySettings: { groups: { [CLI_GROUP_KEY]: 'group+tools+names' }, groupDisplayPreferences: { [CLI_GROUP_KEY]: 'group+tools+names' } } })
    expect(await storedAgent(AGENT)).toMatchObject({ defaultTools: ['cli_x'], provider_specific_settings: { temperature: 0.4, nativeTools: { cliToolsEnabled: true, bashEnabled: false } }, dcmDisplaySettings: { groups: { 'gw_a::Files': 'group-only' }, tools: { unrelated: 'hidden' } } })
    await pause(1000)
    expect(puts).toHaveLength(1)
  }, 120_000)

  it('OFF names only native false and keeps every discovery preference and member selection', async () => {
    await openPanel({ record: { provider_specific_settings: { nativeTools: { cliToolsEnabled: true } }, dcmDisplaySettings: hidden } })
    await fire(() => card().getEnableControl('cli_tools').onChange(false, cliGroupEnablePatch(hidden, 'hidden')))
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ provider_specific_settings: { nativeTools: { cliToolsEnabled: false } } })
    expect(await storedAgent(AGENT)).toMatchObject({ defaultTools: ['cli_x'], dcmDisplaySettings: hidden })
  }, 120_000)

  it('promotes the complete viewed legacy block without losing another group or an invalid Basic draft', async () => {
    await openPanel({ record: { provider_specific_settings: { nativeTools: { cliToolsEnabled: false } }, dcmDisplaySettings: null, dcm_display_settings: hidden } })
    // An invalid unrelated draft stays editable and cannot become part of this pair's request.
    const name = screen.getByDisplayValue('Tool grid probe')
    await fireEvent.input(name, { target: { value: '' } })
    await fire(() => card().getEnableControl('cli_tools').onChange(true, cliGroupEnablePatch(hidden, 'hidden')))
    await waitForPuts(1)
    expect(puts[0].body).not.toHaveProperty('displayName')
    expect(puts[0].body.dcmDisplaySettings).toMatchObject({ groups: { 'gw_a::Files': 'group-only', [CLI_GROUP_KEY]: 'group+tools+names' }, tools: { unrelated: 'hidden' } })
    expect((name as HTMLInputElement).value).toBe('')
    await pause(1000)
    expect(puts).toHaveLength(1)
  }, 120_000)

  it('holds an unknown pair without replay; explicit same-read recovery preserves legacy cache shape', async () => {
    await openPanel({ record: { provider_specific_settings: { nativeTools: { cliToolsEnabled: false } }, dcmDisplaySettings: null, dcm_display_settings: hidden } })
    failNextPuts = 1
    await fire(() => card().getEnableControl('cli_tools').onChange(true, cliGroupEnablePatch(hidden, 'hidden')))
    await waitForPuts(1)
    expect(card().getEnableControl('cli_tools').notice).toContain('unconfirmed')
    expect(card().getEnableControl('cli_tools').disabled).toBe(true)
    await fire(() => card().getEnableControl('cli_tools').onRead())
    await waitFor(() => expect(card().getEnableControl('cli_tools').disabled).toBe(false))
    expect(card().getEnableControl('cli_tools').checked).toBe(false)
    expect(card().dcmDisplaySettings).toMatchObject(hidden)
    expect(agentStore.getAgentById(AGENT)?.dcmDisplaySettings).toBeNull()
    expect((agentStore.getAgentById(AGENT) as any)?.dcm_display_settings).toMatchObject(hidden)
    await pause(1000)
    expect(puts).toHaveLength(1)
  }, 120_000)

  it('a CLI acknowledgement does not replay an unchanged unrelated failed Basic draft', async () => {
    await openPanel({ record: { provider_specific_settings: { nativeTools: { cliToolsEnabled: false, webSearchEnabled: true } } } })
    failNextPuts = 1
    const name = screen.getByDisplayValue('Tool grid probe') as HTMLInputElement
    await fireEvent.input(name, { target: { value: 'Unconfirmed name draft' } })
    await waitForPuts(1)
    await fire(() => card().getEnableControl('cli_tools').onChange(true))
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ provider_specific_settings: { nativeTools: { cliToolsEnabled: true } } })
    expect(name.value).toBe('Unconfirmed name draft')
    await pause(1400)
    expect(puts).toHaveLength(2)
    expect((await storedAgent(AGENT)).displayName).toBe('Tool grid probe')
    // Visiting the saved baseline retires the old ACK origin even though it needs no save.
    await fireEvent.input(name, { target: { value: 'Tool grid probe' } })
    await pause(150)
    expect(puts).toHaveLength(2)
    await fireEvent.input(name, { target: { value: 'Unconfirmed name draft' } })
    await waitForPuts(3)
    expect(puts[2].body).toEqual({ displayName: 'Unconfirmed name draft' })
  }, 120_000)

  it('a CLI-only ACK preserves failed MCP intent until an explicit same-value MCP choice', async () => {
    await openPanel({ record: { provider_specific_settings: { nativeTools: { cliToolsEnabled: false } }, dcmDisplaySettings: hidden } })
    failNextPuts = 1
    const dirty = { ...hidden, groups: { ...hidden.groups, 'unowned::Fresh': 'group-only' } }
    await fire(() => card().onDcmDisplaySettingsChange(dirty))
    await waitForPuts(1)
    await fire(() => card().getEnableControl('cli_tools').onChange(true, cliGroupEnablePatch(card().dcmDisplaySettings, 'hidden')))
    await waitForPuts(2)
    await pause(1200)
    expect(puts).toHaveLength(2)
    expect((await storedAgent(AGENT)).dcmDisplaySettings.groups).not.toHaveProperty('unowned::Fresh')
    await fire(() => card().onDcmDisplaySettingsChange({ ...card().dcmDisplaySettings }))
    await waitForPuts(3)
    expect(puts[2].body).toEqual({ dcmDisplaySettings: { groups: { 'unowned::Fresh': 'group-only' }, groupDisplayPreferences: { 'unowned::Fresh': 'group-only' } } })
  }, 120_000)

  it('a Subagent CLI ACK preserves failed Core intent, then a new name edit uses its normal sender', async () => {
    await openSubagentTools(undefined, { provider_specific_settings: { nativeTools: { webSearchEnabled: true } } })
    failNextSubagentPut = true
    const name = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(name, { target: { value: 'Failed Subagent draft' } })
    await waitFor(() => expect(subagentPuts).toHaveLength(1))
    await pause(400)
    await fire(() => card().getEnableControl('cli_tools').onChange(false))
    await waitFor(() => expect(subagentPuts).toHaveLength(2))
    await pause(1400)
    expect(subagentPuts).toHaveLength(2)
    expect((await redis.json.get(`subagent:${SUB}`) as any).displayName).toBe(SUB_NAME)
    // Existing controlled native choices remain deliberate intent even at the same value.
    expect(card().getEnableControl('web_search').checked).toBe(true)
    await fire(() => card().getEnableControl('web_search').onChange(true))
    await waitFor(() => expect(subagentPuts).toHaveLength(3))
    expect(subagentPuts[2].body).toEqual({ displayName: 'Failed Subagent draft' })
    await pause(400)
    await fireEvent.input(name, { target: { value: 'New Subagent intent' } })
    await waitFor(() => expect(subagentPuts).toHaveLength(4))
    expect(subagentPuts[3].body).toEqual({ displayName: 'New Subagent intent' })
  }, 120_000)

  it('a Subagent CLI ACK preserves failed MCP intent until its next explicit MCP choice', async () => {
    await openSubagentTools(undefined, { dcmDisplaySettings: hidden })
    failNextSubagentPut = true
    const dirty = { ...hidden, groups: { ...hidden.groups, 'unowned::Fresh': 'group-only' } }
    await fire(() => card().onDcmDisplaySettingsChange(dirty))
    await waitFor(() => expect(subagentPuts).toHaveLength(1))
    await pause(400)
    await fire(() => card().getEnableControl('cli_tools').onChange(true, cliGroupEnablePatch(card().dcmDisplaySettings, 'hidden')))
    await waitFor(() => expect(subagentPuts).toHaveLength(2))
    await pause(1400)
    expect(subagentPuts).toHaveLength(2)
    expect((await redis.json.get(`subagent:${SUB}`) as any).dcmDisplaySettings.groups).not.toHaveProperty('unowned::Fresh')
    await fire(() => card().onDcmDisplaySettingsChange({ ...card().dcmDisplaySettings }))
    await waitFor(() => expect(subagentPuts).toHaveLength(3))
    expect(subagentPuts[2].body).toEqual({ dcmDisplaySettings: { groups: { 'unowned::Fresh': 'group-only' }, groupDisplayPreferences: { 'unowned::Fresh': 'group-only' } } })
  }, 120_000)

  it('an actual unowned edit while the CLI ACK travels remains a new normal save', async () => {
    await openPanel({ record: { provider_specific_settings: { nativeTools: { cliToolsEnabled: false } } } })
    const routeFetch = global.fetch
    let release!: () => void, wrote = false
    const ack = new Promise<void>(resolve => { release = resolve })
    let first = true
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (first && String(input) === `/api/agents/${AGENT}` && init?.method === 'PUT') { first = false; const response = await routeFetch(input, init); wrote = true; await ack; return response }
      return routeFetch(input, init)
    })
    try {
      await fire(() => card().getEnableControl('cli_tools').onChange(true))
      await waitFor(() => expect(wrote).toBe(true))
      await fireEvent.input(screen.getByDisplayValue('Tool grid probe'), { target: { value: 'Human edit during ACK' } })
      await pause(350)
      expect(puts).toHaveLength(1)
      release()
      await waitForPuts(2)
      expect(puts[1].body).toEqual({ displayName: 'Human edit during ACK' })
    } finally { release() }
  }, 120_000)

  it('rejects an old actor callback and applies a Subagent pair through its own one-request owner', async () => {
    let oldControl: any
    await openSubagentTools(() => { oldControl = card().getEnableControl('cli_tools') })
    await fire(() => oldControl.onChange(true, cliGroupEnablePatch(hidden, 'hidden')))
    expect(puts).toHaveLength(0)
    expect(subagentPuts).toHaveLength(0)
    await fire(() => card().getEnableControl('cli_tools').onChange(false))
    await waitFor(() => expect(subagentPuts).toHaveLength(1))
    expect(subagentPuts[0].body).toEqual({ provider_specific_settings: { nativeTools: { cliToolsEnabled: false } } })
    await waitFor(() => expect(card().getEnableControl('cli_tools').checked).toBe(false))
  }, 120_000)

  it('a newer accepted same-owner Subagent cache prevents an older held pair ACK from replacing it', async () => {
    await openSubagentTools(undefined, { provider_specific_settings: { nativeTools: { cliToolsEnabled: false } }, dcmDisplaySettings: hidden })
    const routeFetch = global.fetch
    let releaseAck!: () => void, releaseRead!: () => void
    const ack = new Promise<void>(resolve => { releaseAck = resolve })
    const read = new Promise<void>(resolve => { releaseRead = resolve })
    let wrote = false, holdReads = false
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (path === `/api/subagents/${SUB}` && init?.method === 'PUT') { const response = await routeFetch(input, init); wrote = true; await ack; return response }
      if (path === `/api/subagents/${SUB}` && (init?.method ?? 'GET') === 'GET' && holdReads) await read
      return routeFetch(input, init)
    })
    try {
      await fire(() => card().getEnableControl('cli_tools').onChange(true, cliGroupEnablePatch(hidden, 'hidden')))
      await waitFor(() => expect(wrote).toBe(true))
      const changed = { ...(await redis.json.get(`subagent:${SUB}`) as any), provider_specific_settings: { nativeTools: { cliToolsEnabled: false } }, dcmDisplaySettings: hidden }
      await redis.json.set(`subagent:${SUB}`, '$', changed)
      holdReads = true
      subagentStore.acceptServerRecord(changed)
      await tick()
      releaseAck()
      await pause(200)
      expect(card().getEnableControl('cli_tools').checked).toBe(false)
      expect(card().dcmDisplaySettings.groups[CLI_GROUP_KEY]).toBe('hidden')
      releaseRead()
      await waitFor(() => expect(card().getEnableControl('cli_tools').disabled).toBe(false))
      expect(subagentPuts).toHaveLength(1)
    } finally { releaseAck(); releaseRead() }
  }, 120_000)
})

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


describe('human Primary whole custom-array concurrency in the mounted panel', () => {
  it('a non-MCP Web Search draft cannot erase a producer-shaped MCP row and stays visible on conflict', async () => {
    const row = { tool_name: 'web_search', buffer_size: 2, auto_zip: false }
    await openPanel({ record: { custom_tool_settings: [row] } })
    const winner = [row, { tool_name: 'C_remote_write', buffer_size: 0, auto_zip: false }]
    const record = await storedAgent(AGENT)
    await redis.json.set(`agent:${AGENT}`, '$', { ...record, custom_tool_settings: winner } as any)
    await fire(() => card().onNonMcpZipOverrideChange('web_search', { buffer_size: '9' }))
    await waitForPuts(1)
    expect(Object.keys(puts[0].body.expectedMcpSettings)).toEqual(['custom_tool_settings'])
    expect(puts[0].body.custom_tool_settings).toContainEqual({ ...row, buffer_size: 9, zip_disabled: false })
    expect((await storedAgent(AGENT)).custom_tool_settings).toEqual(winner)
    expect(card().getNonMcpZipOverride('web_search').buffer_size).toBe('9')
    expect(card().zipSaveError).toMatch(/changed/)
    await pause(1000); expect(puts).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Tool Settings' }))
    await waitFor(() => expect(card().getNonMcpZipOverride('web_search').buffer_size).toBe('2'))
    expect((await storedAgent(AGENT)).custom_tool_settings).toEqual(winner)
    expect(puts).toHaveLength(1)
  }, 90_000)
})


describe('untouched custom-row properties survive a fresh human whole-array edit', () => {
  it('keeps unknown properties and unrelated zero/false rows while changing only Web Search', async () => {
    const rows = [{ tool_name: 'web_search', buffer_size: 2, auto_zip: false, future: { keep: true } },
      { tool_name: 'C_remote_write', buffer_size: 1, zip_threshold: 0, auto_zip: false, future: ['opaque'] }]
    await openPanel({ record: { custom_tool_settings: rows } })
    await fire(() => card().onNonMcpZipOverrideChange('web_search', { buffer_size: '9' }))
    await waitForPuts(1)
    await waitFor(async () => expect((await storedAgent(AGENT)).custom_tool_settings.find((row: any) => row.tool_name === 'web_search').buffer_size).toBe(9))
    const saved = (await storedAgent(AGENT)).custom_tool_settings
    expect(saved.find((row: any) => row.tool_name === 'web_search').future).toEqual({ keep: true })
    expect(saved.find((row: any) => row.tool_name === 'C_remote_write')).toMatchObject(rows[1])
    expect(Object.keys(puts[0].body.expectedMcpSettings)).toEqual(['custom_tool_settings'])
  }, 90000)
})


describe('Human recovery preserves the exact guarded draft until a complete saved read', () => {
  it.each(['missing', 'malformed', 'empty', 'partial'] as const)('keeps BOTH held sections on a %s recovery header while unrelated settings remain readable', async (shape) => {
    await openPanel({ record: { custom_tool_settings: [{ tool_name: 'web_search', buffer_size: 2 }] } })
    failNextPuts = 1
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    await fire(() => card().onNonMcpZipOverrideChange('web_search', { buffer_size: '9' }))
    const saved = await storedAgent(AGENT)
    await redis.json.set(`agent:${AGENT}`, '$', { ...saved, displayName: 'Fresh unrelated name',
      defaultMCPGateways: ['gw_a', 'gw_c'], custom_tool_settings: [{ tool_name: 'web_search', buffer_size: 4 }] } as any)
    const routeFetch = global.fetch
    let invalid = true
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const answer = await routeFetch(input, init)
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (invalid && path === `/api/agents/${AGENT}` && (init?.method ?? 'GET') === 'GET') {
        const headers = new Headers(answer.headers)
        if (shape === 'missing') headers.delete(MCP_SETTINGS_REVISION_HEADER)
        else if (shape === 'malformed') headers.set(MCP_SETTINGS_REVISION_HEADER, '{broken')
        else if (shape === 'empty') headers.set(MCP_SETTINGS_REVISION_HEADER, '{}')
        else {
          const base = JSON.parse(headers.get(MCP_SETTINGS_REVISION_HEADER)!)
          headers.set(MCP_SETTINGS_REVISION_HEADER, JSON.stringify({ defaultMCPGateways: base.defaultMCPGateways }))
        }
        return new Response(await answer.text(), { status: answer.status, headers })
      }
      return answer
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Tool Settings' }))
    await waitFor(() => expect(card().mcpSaveError).toMatch(/could not be read completely/))
    expect(card().zipSaveError).toMatch(/could not be read completely/)
    expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(card().getNonMcpZipOverride('web_search').buffer_size).toBe('9')
    const coreTab = screen.getAllByRole('tab').find(element => /Core/.test(element.textContent ?? ''))!
    await fireEvent.mouseDown(coreTab); await fireEvent.click(coreTab)
    expect(await screen.findByDisplayValue('Fresh unrelated name')).toBeTruthy()
    await openToolsTab()
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b', 'gw_d']))
    await pause(1500)
    expect(puts).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Use Saved Tool Settings' })).toBeTruthy()
    invalid = false
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Tool Settings' }))
    await waitFor(() => expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_c']))
    expect(card().getNonMcpZipOverride('web_search').buffer_size).toBe('4')
    expect(puts).toHaveLength(1)
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_c', 'gw_d']))
    await waitForPuts(2)
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_c', 'gw_d'])
  }, 90_000)

  it.each(['gateways', 'custom-array'] as const)('holds %s after the REAL route saves but its answer is lost, then requires a saved read and new choice', async (kind) => {
    await openPanel({ record: { custom_tool_settings: [{ tool_name: 'web_search', buffer_size: 2 }] } })
    const routeFetch = global.fetch
    let loseAnswer = true
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const answer = await routeFetch(input, init)
      if (loseAnswer && input === `/api/agents/${AGENT}` && init?.method === 'PUT') {
        loseAnswer = false
        expect(answer.ok).toBe(true)
        const actual = await storedAgent(AGENT)
        if (kind === 'gateways') expect(actual.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
        else expect(actual.custom_tool_settings).toContainEqual({ tool_name: 'web_search', buffer_size: 9 })
        throw new TypeError('The actual saved response was lost')
      }
      return answer
    })
    const choose = async (later: boolean) => kind === 'gateways'
      ? fire(() => card().onGatewaysChange(later ? ['gw_a', 'gw_b', 'gw_c'] : ['gw_a', 'gw_b']))
      : fire(() => card().onNonMcpZipOverrideChange('web_search', { buffer_size: later ? '11' : '9' }))
    await choose(false)
    await waitForPuts(1)
    await screen.findByRole('button', { name: 'Use Saved Tool Settings' })
    await choose(true)
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'mcp-settings')
    await pause(1500)
    expect(puts).toHaveLength(1)
    if (kind === 'gateways') expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b', 'gw_c'])
    else expect(card().getNonMcpZipOverride('web_search').buffer_size).toBe('11')
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Tool Settings' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use Saved Tool Settings' })).toBeNull())
    if (kind === 'gateways') expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    else expect(card().getNonMcpZipOverride('web_search').buffer_size).toBe('9')
    expect(puts).toHaveLength(1)
    await choose(true)
    await waitForPuts(2)
    expect(puts[1].body.expectedMcpSettings).not.toEqual(puts[0].body.expectedMcpSettings)
  }, 90_000)

  it('retains a genuine same-route MCP ACK through a later error without inventing an unknown hold', async () => {
    await openPanel()
    const routeFetch = global.fetch
    let followupFails = true
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const answer = await routeFetch(input, init)
      if (followupFails && input === `/api/agents/${AGENT}` && init?.method === 'PUT') {
        followupFails = false
        expect(answer.ok).toBe(true)
        const body = await answer.json()
        expect(body.mcpSettings?.revisions?.defaultMCPGateways).toMatch(/^sha256:/)
        return Response.json({ ...body, error: 'Post-save profile work failed' }, { status: 500 })
      }
      return answer
    })
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    expect(screen.queryByRole('button', { name: 'Use Saved Tool Settings' })).toBeNull()
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b', 'gw_c']))
    await waitForPuts(2)
    expect(puts[1].body.expectedMcpSettings).not.toEqual(puts[0].body.expectedMcpSettings)
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_b', 'gw_c'])
  }, 90_000)
})


describe('a guarded Panel outcome belongs to its captured entity', () => {
  it('retains the Primary unknown hold when its saved answer is lost while a Subagent is selected', async () => {
    await redis.json.set(`subagent:${SUB}`, '$', { id: SUB, user_id: USER, displayName: SUB_NAME, slug: SUB,
      subagentType: 'api', specialty: 'general', defaultMCPGateways: ['gw_a'], defaultMCPToolSelections: ['tool_one'],
      dcmDisplaySettings: DCM_EMPTY, created_at: '2026-09-28T00:00:00.000Z', updated_at: '2026-09-28T00:00:00.000Z' } as any)
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    await openPanel()
    const routeFetch = global.fetch
    let release!: () => void
    const responseGate = new Promise<void>(resolve => { release = resolve })
    let first = true
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const answer = await routeFetch(input, init)
      if (first && input === `/api/agents/${AGENT}` && init?.method === 'PUT') {
        first = false
        expect(answer.ok).toBe(true)
        await responseGate
        throw new TypeError('Saved Primary response lost off selection')
      }
      return answer
    })
    const select = async (name: string) => {
      await fireEvent.keyDown(screen.getByRole('button', { name: 'Select Agents & Subagents' }), { key: 'ArrowDown' })
      const item = await screen.findByText(name, { selector: '.batshit-settings-action-row-title' })
      await fireEvent.click(item.closest('button') as HTMLElement)
      await screen.findByDisplayValue(name, {}, { timeout: 15_000 })
    }
    try {
      await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
      await waitForPuts(1)
      await select(SUB_NAME)
      release()
      await pause(500)
      expect(screen.queryByRole('button', { name: 'Use Saved Tool Settings' })).toBeNull()
      await select('Tool grid probe')
      await screen.findByRole('button', { name: 'Use Saved Tool Settings' })
      await openToolsTab()
      await fire(() => card().onGatewaysChange(['gw_a', 'gw_b', 'gw_c']))
      await pause(1500)
      expect(puts).toHaveLength(1)
      expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    } finally { release() }
  }, 90_000)

  it.each(['layout', 'display'] as const)('does not hold an unrelated %s-only save after a transport failure', async (kind) => {
    await openPanel()
    const routeFetch = global.fetch
    let first = true
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const answer = await routeFetch(input, init)
      if (first && input === `/api/agents/${AGENT}` && init?.method === 'PUT') {
        first = false
        expect(JSON.parse(String(init.body))).not.toHaveProperty('expectedMcpSettings')
        throw new TypeError('Unguarded scalar/display response lost')
      }
      return answer
    })
    if (kind === 'layout') await fire(() => card().onZipAiViewModeChange('appended'))
    else await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_a::Files': 'hidden' } }))
    await waitForPuts(1)
    expect(screen.queryByRole('button', { name: 'Use Saved Tool Settings' })).toBeNull()
    if (kind === 'layout') await fire(() => card().onZipAiViewModeChange('inline'))
    else await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_a::Files': 'group-only' } }))
    await waitForPuts(2)
    expect(puts[1].body).not.toHaveProperty('expectedMcpSettings')
  }, 90_000)
})

/**
 * SA-137 P4a (D11): the agent's own Refreshed File Reads choice (Live File Reads before Round 2) rides the zip save. Use Global Default
 * saves null (the server removes the field), Enabled true, Disabled false; opening saves nothing
 * (`openPanel` asserts no PUT went out past the autosave debounce); only an API Primary agent's
 * card gets the row, and a Subagent's card is mounted with the zip controls hidden.
 */
describe('the agent\'s Refreshed File Reads choice (SA-137 P4a)', () => {
  it('opens as Use Global Default with nothing saved, and tells the card it is an API Primary agent', async () => {
    await openPanel()
    expect(card().liveFileReads).toBe('__inherit__')
    expect(card().subjectKind).toBe('primary')
    expect(card().toolHostScope).toBe('api')
    expect(card().showZipControls).toBe(true)
  }, 90_000)

  it.each([
    [true, 'enabled'],
    [false, 'disabled']
  ] as const)('opens with a saved %s as %s, and saves nothing', async (saved, shown) => {
    await openPanel({ record: { live_file_reads: saved } })
    expect(card().liveFileReads).toBe(shown)
  }, 90_000)

  it('Enabled saves true, and only that field', async () => {
    await openPanel()
    await fire(() => card().onLiveFileReadsChange('enabled'))
    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ live_file_reads: true })
    expect((await storedAgent(AGENT)).live_file_reads).toBe(true)
    expect(card().liveFileReads).toBe('enabled')
  }, 90_000)

  it('Disabled saves an explicit false, and false stays false', async () => {
    await openPanel()
    await fire(() => card().onLiveFileReadsChange('disabled'))
    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ live_file_reads: false })
    expect((await storedAgent(AGENT)).live_file_reads).toBe(false)
  }, 90_000)

  it('Use Global Default saves null, and the server removes the field', async () => {
    await openPanel({ record: { live_file_reads: true } })
    await fire(() => card().onLiveFileReadsChange('__inherit__'))
    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ live_file_reads: null })
    const record = await storedAgent(AGENT)
    expect(Object.hasOwn(record, 'live_file_reads')).toBe(false)
    expect(card().liveFileReads).toBe('__inherit__')
  }, 90_000)

  it('choosing what is already saved sends nothing', async () => {
    await openPanel({ record: { live_file_reads: false } })
    await fire(() => card().onLiveFileReadsChange('disabled'))
    await pause(1500)
    expect(puts).toEqual([])
  }, 90_000)

  it('Reset to global settings clears a saved choice as null, with the field removed', async () => {
    await openPanel({ record: { live_file_reads: false } })
    await fire(() => card().onResetToGlobalSettings())
    await waitFor(() => expect(puts.some((put) => 'live_file_reads' in put.body)).toBe(true), { timeout: 8_000 })
    await pause(1200)
    const zip = puts.find((put) => 'live_file_reads' in put.body)
    expect(zip?.body.live_file_reads).toBeNull()
    expect(Object.hasOwn(await storedAgent(AGENT), 'live_file_reads')).toBe(false)
    expect(card().liveFileReads).toBe('__inherit__')
  }, 90_000)

  it('a Subagent\'s card is mounted as a Subagent with the zip controls hidden and no Refreshed File Reads value', async () => {
    await openSubagentTools()
    await waitFor(() => expect(card().subjectKind).toBe('subagent'), { timeout: 8_000 })
    expect(card().showZipControls).toBe(false)
    expect(card().liveFileReads).toBeUndefined()
    expect(card().onLiveFileReadsChange).toBeUndefined()
  }, 120_000)
})

/**
 * SA-137 Round 2 (R2-2): the panel tells the card why Refreshed File Reads cannot run for this
 * agent now, from the one shared rule (`refreshedFileReadsUnavailableReason`): the form's own Zip
 * view (else the global one), the agent's effective Bash command location and the host facts the
 * sandbox-status response carries. The saved choice is never changed or saved because of it:
 * `openPanel` asserts no PUT went out past the autosave debounce, every case here keeps it so.
 */
describe('why the agent\'s Refreshed File Reads cannot run (Round 2)', () => {
  const reason = () => card().liveFileReadsUnavailableReason as string | null
  const settled = () => waitFor(() => expect(String(reason())).not.toMatch(/^Checking/), { timeout: 8_000 })

  it('is available for an API agent on a Mac with the appended Zip view: no reason, no note, no warning', async () => {
    await openPanel()
    await settled()
    expect(reason()).toBeNull()
    expect(card().liveFileReadsNote).toBeNull()
    expect(card().liveFileReadsWarn).toBe(false)
  }, 90_000)

  it('an agent that uses the inline Zip view says so, keeps its saved choice, and saves nothing', async () => {
    await openPanel({ record: { zip_ai_view_mode: 'inline', live_file_reads: true } })
    await settled()
    expect(reason()).toBe('Refreshed File Reads needs the appended Zip view; this agent uses the inline view, where nothing refreshes.')
    expect(card().liveFileReads).toBe('enabled')
    await pause(1200)
    expect(puts).toEqual([])
    expect((await storedAgent(AGENT)).live_file_reads).toBe(true)
  }, 90_000)

  // N2: a warning only when the setting resolves ON and is unavailable.
  it('is a warning when the agent\'s own choice is on', async () => {
    await openPanel({ record: { zip_ai_view_mode: 'inline', live_file_reads: true } })
    await settled()
    expect(card().liveFileReadsWarn).toBe(true)
  }, 90_000)

  it('is plain when the agent\'s own choice is off, whatever the global value', async () => {
    setUserSettings({ global_zip_settings: { live_file_reads: true } } as any)
    await openPanel({ record: { zip_ai_view_mode: 'inline', live_file_reads: false } })
    await settled()
    expect(reason()).toMatch(/needs the appended Zip view/)
    expect(card().liveFileReadsWarn).toBe(false)
  }, 90_000)

  it('is plain when the agent follows a global value that is off', async () => {
    setUserSettings({ global_zip_settings: { live_file_reads: false } } as any)
    await openPanel({ record: { zip_ai_view_mode: 'inline' } })
    await settled()
    expect(reason()).toMatch(/needs the appended Zip view/)
    expect(card().liveFileReads).toBe('__inherit__')
    expect(card().liveFileReadsWarn).toBe(false)
  }, 90_000)

  it('is plain when the agent follows the factory value: ON, but nobody chose it (D13, 2026-11-04)', async () => {
    await openPanel({ record: { zip_ai_view_mode: 'inline' } })
    await settled()
    expect(reason()).toMatch(/needs the appended Zip view/)
    expect(card().liveFileReads).toBe('__inherit__')
    expect(card().liveFileReadsWarn).toBe(false)
  }, 90_000)

  it('is a warning when the agent follows a global value that is on', async () => {
    setUserSettings({ global_zip_settings: { live_file_reads: true } } as any)
    await openPanel({ record: { zip_ai_view_mode: 'inline' } })
    await settled()
    expect(card().liveFileReadsWarn).toBe(true)
  }, 90_000)

  it('is plain while the host is still being read, and the reason is the checking sentence', async () => {
    await openPanel({ host: 'pending', record: { live_file_reads: true } })
    await waitFor(() => expect(reason()).toBe('Checking whether Refreshed File Reads can run here.'), { timeout: 8_000 })
    expect(card().liveFileReadsWarn).toBe(false)
    expect(card().liveFileReadsNote).toBeNull()
  }, 90_000)

  it('choosing Inline in the same card makes it unavailable at once; the save carries the layout alone, then Appended frees it', async () => {
    await openPanel({ record: { live_file_reads: true } })
    await settled()
    expect(reason()).toBeNull()

    await fire(() => card().onZipAiViewModeChange('inline'))
    expect(reason()).toMatch(/needs the appended Zip view/)
    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ zip_ai_view_mode: 'inline' })
    expect(card().liveFileReads).toBe('enabled')

    await fire(() => card().onZipAiViewModeChange('appended'))
    expect(reason()).toBeNull()
    await waitForPuts(2)
    expect(withoutExpectedMcpSettings(puts[1].body)).toEqual({ zip_ai_view_mode: 'appended' })
    expect((await storedAgent(AGENT)).live_file_reads).toBe(true)
  }, 90_000)

  it('an agent that follows the global Zip view reads it, and the global value reaches the mounted card live', async () => {
    setUserSettings({ global_zip_settings: { zip_ai_view_mode: 'inline' } } as any)
    await openPanel()
    await settled()
    expect(reason()).toMatch(/needs the appended Zip view/)

    setUserSettings({ global_zip_settings: { zip_ai_view_mode: 'appended' } } as any)
    await waitFor(() => expect(reason()).toBeNull(), { timeout: 8_000 })
    await pause(800)
    expect(puts).toEqual([])
  }, 90_000)

  it('in the app container it says so', async () => {
    await openPanel({ host: { platform: 'linux', containerized: true } })
    await settled()
    expect(reason()).toBe('Refreshed File Reads is not available in the app container yet.')
  }, 90_000)

  it('a Sandbox Level that does not mount the host workspace (Docker Sandbox on Linux) says so', async () => {
    await openPanel({ host: { platform: 'linux', containerized: false }, record: { provider_specific_settings: { nativeTools: { bashEnabled: true, executionBackend: 'docker_sandbox' } } } })
    await settled()
    expect(reason()).toBe('Refreshed File Reads is not available with this Sandbox Level yet.')
  }, 90_000)

  // S3: a failed host read must not lock the switch; it is a plain note, and the server re-checks every turn.
  it('when the status reads fail the switch is NOT locked: no reason, a plain note, nothing saved', async () => {
    await openPanel({ host: 'fails', record: { live_file_reads: true } })
    await waitFor(() => expect(card().liveFileReadsNote).toBe('Could not check whether Refreshed File Reads can run here.'), { timeout: 8_000 })
    expect(reason()).toBeNull()
    expect(card().liveFileReadsWarn).toBe(false)
    expect(card().liveFileReads).toBe('enabled')
  }, 90_000)

  // BL-2049: the full probe's `sbx` timeouts run up to 60 s; the switch reads the host facts alone.
  it('while the full sandbox probe never answers, the host-only read settles the switch: available, no note', async () => {
    await openPanel({ fullProbe: 'pending', record: { live_file_reads: true } })
    await settled()
    expect(reason()).toBeNull()
    expect(card().liveFileReadsNote).toBeNull()
    expect(card().liveFileReadsWarn).toBe(false)
    expect(sandboxStatusReads).toEqual(['/api/native-tools/sandbox/status?hostOnly=1'])
  }, 90_000)

  it('while the full sandbox probe never answers, a host-only answer of the app container says so', async () => {
    await openPanel({ fullProbe: 'pending', host: { platform: 'linux', containerized: true } })
    await settled()
    expect(reason()).toBe('Refreshed File Reads is not available in the app container yet.')
  }, 90_000)

  it('a failed full probe does not hide the host-only answer: no note, the switch is available', async () => {
    await openPanel({ fullProbe: 'fails', record: { live_file_reads: true } })
    await settled()
    await pause(300)
    expect(reason()).toBeNull()
    expect(card().liveFileReadsNote).toBeNull()
  }, 90_000)

  it('a failed host-only read is a plain note at once while the full probe is out: the switch is not locked', async () => {
    await openPanel({ hostOnlyFails: true, fullProbe: 'pending', record: { live_file_reads: true } })
    await waitFor(() => expect(card().liveFileReadsNote).toBe('Could not check whether Refreshed File Reads can run here.'), { timeout: 8_000 })
    expect(reason()).toBeNull()
    expect(card().liveFileReadsWarn).toBe(false)
  }, 90_000)

  it('after a failed host-only read, the full probe\'s host facts settle the switch: no note', async () => {
    await openPanel({ hostOnlyFails: true, record: { live_file_reads: true } })
    await settled()
    await waitFor(() => expect(card().liveFileReadsNote).toBeNull(), { timeout: 8_000 })
    expect(reason()).toBeNull()
  }, 90_000)

  it('when the status reads fail, what needs no host still locks it (an inline Zip view), beside the note', async () => {
    await openPanel({ host: 'fails', record: { zip_ai_view_mode: 'inline', live_file_reads: true } })
    await waitFor(() => expect(card().liveFileReadsNote).toBe('Could not check whether Refreshed File Reads can run here.'), { timeout: 8_000 })
    expect(reason()).toMatch(/needs the appended Zip view/)
    expect(card().liveFileReadsWarn).toBe(true)
  }, 90_000)
})

/**
 * Round 2 (S1): the badges' facts say "still current" only while the full availability rule holds,
 * so a landed save of the agent's Zip view asks every chat's facts again, as a change of its
 * Refreshed File Reads choice already does. The Bash location and mode triggers are pinned beside
 * the real Bash controls (`AgentSettingsPanel.typedFileTools.test.ts`).
 */
describe('a Zip view or choice save re-asks the badges\' live-read facts (Round 2, S1)', () => {
  it('a Zip layout save re-asks once, after the save landed', async () => {
    await openPanel()
    deadCopies.refreshAll.mockClear()
    await fire(() => card().onZipAiViewModeChange('inline'))
    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ zip_ai_view_mode: 'inline' })
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
    expect((await storedAgent(AGENT)).zip_ai_view_mode).toBe('inline')
  }, 90_000)

  it('Reset to global settings (it sends the Zip view as null) re-asks', async () => {
    await openPanel({ record: { zip_ai_view_mode: 'inline' } })
    deadCopies.refreshAll.mockClear()
    await fire(() => card().onResetToGlobalSettings())
    await waitFor(() => expect(puts.some((put) => 'zip_ai_view_mode' in put.body)).toBe(true), { timeout: 8_000 })
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalled())
    expect(puts.find((put) => 'zip_ai_view_mode' in put.body)?.body.zip_ai_view_mode).toBeNull()
    // The reset sends its Tool Grid saves too; let every one land so none leaks into the next case.
    await pause(1800)
  }, 90_000)

  it('the Refreshed File Reads choice itself still re-asks', async () => {
    await openPanel()
    deadCopies.refreshAll.mockClear()
    await fire(() => card().onLiveFileReadsChange('enabled'))
    await waitForPuts(1)
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
  }, 90_000)

  it('a save of another zip field (Tool Notes) does not', async () => {
    await openPanel()
    deadCopies.refreshAll.mockClear()
    await fire(() => card().onZipToolNotesChange('disabled'))
    await waitForPuts(1)
    expect(withoutExpectedMcpSettings(puts[0].body)).toEqual({ zip_tool_notes_enabled: false })
    await pause(300)
    expect(deadCopies.refreshAll).not.toHaveBeenCalled()
  }, 90_000)

  it('a refused save re-asks nothing', async () => {
    await openPanel()
    deadCopies.refreshAll.mockClear()
    failNextPuts = 1
    await fire(() => card().onZipAiViewModeChange('inline'))
    await waitForPuts(1)
    await pause(300)
    expect(deadCopies.refreshAll).not.toHaveBeenCalled()
  }, 90_000)
})
