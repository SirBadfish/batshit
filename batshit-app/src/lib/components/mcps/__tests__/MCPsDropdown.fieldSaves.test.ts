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
 * BL-855, the chat bar's Tools menu. Its two saves send only what the user changed, against the
 * values the menu last knew (the agent as it hydrated, then after each save): a gateway toggle
 * sends `defaultMCPGateways` alone, a display change only the entries it changed, a CLI tool pick
 * `defaultTools` alone, a zip change only the zip fields it changed and `custom_tool_settings`
 * only when a custom tool row changed. Before, the menu sent the gateways, the display settings
 * and the CLI tools together whole, and the zip fields with `custom_tool_settings` whole, so a
 * menu holding an older copy than the record (another window saved since) took back a gateway,
 * tool, display or zip choice it never touched.
 *
 * Renders the REAL menu with the card that holds the grid replaced by a stand-in that hands the
 * test the card's callbacks (the menu's own save code is what runs). `fetch` sends
 * `/api/agents/<id>` to the REAL route on the default lane's Redis fake, so each test sees the
 * body the browser sent and the record after another window's change.
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
vi.mock('$lib/components/settings/agent/AgentMcpDefaultsCard.svelte', async () => ({
  default: (await import('./AgentMcpDefaultsCardStub.test.svelte')).default
}))

useRedisTestServer()

const USER = 'mcpfs_user'
const AGENT = 'mcpfs_agent'

const GATEWAYS = ['gw_a', 'gw_b', 'gw_c'].map((id) => ({ id, type: 'stdio', name: id.toUpperCase(), enabled: true }))

const DCM_EMPTY = {
  version: 1,
  groups: {},
  tools: {},
  groupDisplayPreferences: {},
  toolDisplayPreferences: {}
}

/** What the menu's copy of the agent holds (older than the record below). */
const STALE = {
  defaultMCPGateways: ['gw_a'],
  defaultTools: ['cli_x'],
  dcmDisplaySettings: DCM_EMPTY,
  custom_tool_settings: [] as unknown[],
  zip_agent_control_enabled: null as boolean | null,
  zip_ai_view_mode: null as string | null
}

/** What another window saved since: a different CLI tool list, a display choice, zip choices. */
const OTHER_WINDOW = {
  defaultTools: ['cli_y'],
  dcmDisplaySettings: {
    ...DCM_EMPTY,
    groups: { 'gw_a::Files': 'hidden' },
    groupDisplayPreferences: { 'gw_a::Files': 'use-global' }
  },
  custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 4 }],
  zip_ai_view_mode: 'inline'
}

let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
let puts: AgentPut[] = []
let failNextPuts = 0
let failNextGatewayFetches = 0
let heldPut: Promise<void> | null = null
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
}, 60_000)

beforeEach(() => {
  failNextPuts = 0
  failNextGatewayFetches = 0
  heldPut = null
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

/**
 * The record in Redis holds the stale values with `otherWindow` laid over them; the menu's store
 * copy holds the stale values only (with `staleOverrides`).
 */
async function openMenu(
  input: {
    otherWindow?: Record<string, unknown>
    staleOverrides?: Record<string, unknown>
    /** False: the gateway list fails to load, so the menu shows its error and no card. */
    expectCard?: boolean
  } = {}
) {
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Tools probe',
    agentType: 'api',
    ...STALE,
    ...(input.otherWindow ?? {})
  } as any)
  const record = await storedAgent(AGENT)
  agentStore.setAgents([{ ...record, ...STALE, ...(input.staleOverrides ?? {}) } as any])
  agentStore.setCurrentAgentId(AGENT)
  const routes = installAgentRoutes({
    agentId: AGENT,
    userId: USER,
    route: routeModule,
    failPutsWith: () => {
      if (failNextPuts > 0) {
        failNextPuts -= 1
        return 500
      }
      return null
    },
    holdPuts: () => {
      const gate = heldPut
      heldPut = null
      return gate
    },
    extra: (path) => {
      if (path === '/api/mcp/gateways') {
        if (failNextGatewayFetches > 0) {
          failNextGatewayFetches -= 1
          return jsonResponse({ error: 'Probe outage' }, 500)
        }
        return jsonResponse({ gateways: GATEWAYS })
      }
      if (path.startsWith('/api/mcp/gateways/') && path.endsWith('/tools')) return jsonResponse({ mcps: [] })
      if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
      return undefined
    }
  })
  puts = routes.puts
  const MCPsDropdown = (await import('../MCPsDropdown.svelte')).default
  render(MCPsDropdown, { props: { userId: USER } })
  if (input.expectCard === false) {
    await waitFor(() => expect(screen.getByText(/Failed to load gateways/)).toBeTruthy(), { timeout: 15_000 })
  } else {
    await waitFor(() => expect(card()).toBeTruthy(), { timeout: 15_000 })
  }
  // Past anything opening the menu would save: it must save nothing.
  await pause(400)
  expect(puts).toEqual([])
}

/** The card's own toggle of one gateway: its list with that gateway added or taken out. */
async function toggleGateway(id: string) {
  const next = new Set<string>(card().defaultMCPGateways)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  await fire(() => card().onGatewaysChange(Array.from(next)))
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 5_000 })
  await pause(60)
}

async function waitForRecord(read: (record: Record<string, any>) => unknown, expected: unknown) {
  await waitFor(async () => expect(read(await storedAgent(AGENT))).toEqual(expected), { timeout: 5_000 })
}

describe('the Tools menu sends only the MCP settings the user changed (BL-855)', () => {
  it('a gateway toggle sends the gateway list alone; CLI tools and display settings saved in another window survive', async () => {
    await openMenu({ otherWindow: OTHER_WINDOW })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    await waitForRecord((record) => record.defaultMCPGateways, ['gw_a', 'gw_b'])
    const record = await storedAgent(AGENT)
    expect(record.defaultTools).toEqual(['cli_y'])
    expect(record.dcmDisplaySettings).toEqual(OTHER_WINDOW.dcmDisplaySettings)
  }, 60_000)

  it('a display change sends only the entries it changed; a gateway list saved in another window survives', async () => {
    await openMenu({ otherWindow: { defaultMCPGateways: ['gw_a', 'gw_c'] } })

    await fire(() =>
      card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } })
    )

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      dcmDisplaySettings: {
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      }
    })
    await waitForRecord((record) => record.dcmDisplaySettings?.groups, { 'gw_b::Reading': 'group-only' })
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_c'])
  }, 60_000)

  it('a display change keeps an entry another window saved (entry by entry)', async () => {
    await openMenu({ otherWindow: OTHER_WINDOW })

    await fire(() =>
      card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } })
    )

    await waitForPuts(1)
    await waitForRecord((record) => record.dcmDisplaySettings?.groups, {
      'gw_a::Files': 'hidden',
      'gw_b::Reading': 'group-only'
    })
  }, 60_000)

  it('taking an entry out of the display settings removes that entry alone', async () => {
    const held = {
      ...DCM_EMPTY,
      groups: { 'gw_a::Files': 'hidden', 'gw_b::Reading': 'group-only' },
      groupDisplayPreferences: { 'gw_a::Files': 'use-global', 'gw_b::Reading': 'group-only' }
    }
    await openMenu({ staleOverrides: { dcmDisplaySettings: held }, otherWindow: { dcmDisplaySettings: held } })

    await fire(() =>
      card().onDcmDisplaySettingsChange({
        ...held,
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      })
    )

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      dcmDisplaySettings: {
        groups: { 'gw_a::Files': null },
        groupDisplayPreferences: { 'gw_a::Files': null }
      }
    })
    await waitForRecord((record) => record.dcmDisplaySettings?.groups, { 'gw_b::Reading': 'group-only' })
  }, 60_000)

  it('a CLI tool pick sends the tool list alone', async () => {
    await openMenu({ otherWindow: { defaultMCPGateways: ['gw_a', 'gw_c'] } })

    await fire(() => card().onCliToolIdsChange(['cli_x', 'cli_z']))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultTools: ['cli_x', 'cli_z'] })
    await waitForRecord((record) => record.defaultTools, ['cli_x', 'cli_z'])
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_c'])
  }, 60_000)

  it('a second change does not send the first again', async () => {
    await openMenu()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    await fire(() => card().onCliToolIdsChange(['cli_x', 'cli_z']))
    await waitForPuts(2)

    expect(puts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    expect(puts[1].body).toEqual({ defaultTools: ['cli_x', 'cli_z'] })
  }, 60_000)

  it('a change that leaves every value as it was sends nothing', async () => {
    await openMenu()

    await fire(() => card().onGatewaysChange(['gw_a']))
    await fire(() => card().onCliToolIdsChange(['cli_x']))
    await fire(() => card().onDcmDisplaySettingsChange(DCM_EMPTY))
    await pause(500)

    expect(puts).toEqual([])
  }, 60_000)

  it('an agent with no display settings yet: a gateway toggle creates no display block; a display change creates it', async () => {
    await openMenu({ staleOverrides: { dcmDisplaySettings: null }, otherWindow: { dcmDisplaySettings: null } })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    expect((await storedAgent(AGENT)).dcmDisplaySettings ?? null).toBeNull()

    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, tools: { 'gw_a::read': 'hidden' } }))
    await waitForPuts(2)
    expect(puts[1].body).toEqual({
      dcmDisplaySettings: {
        tools: { 'gw_a::read': 'hidden' },
        toolDisplayPreferences: { 'gw_a::read': 'inherit' }
      }
    })
  }, 60_000)

  it('an agent that holds its display settings only under the older name gets the whole block on its first save', async () => {
    const older = { ...DCM_EMPTY, groups: { 'gw_a::Files': 'hidden' } }
    await openMenu({
      staleOverrides: { dcmDisplaySettings: null, dcm_display_settings: older },
      otherWindow: { dcmDisplaySettings: null, dcm_display_settings: older }
    })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))

    await waitForPuts(1)
    expect(puts[0].body.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(puts[0].body.dcmDisplaySettings).toMatchObject({
      version: 1,
      groups: { 'gw_a::Files': 'hidden' }
    })
  }, 60_000)

  it('a failed save keeps nothing: the same change is sent again, and an unrelated one does not carry it', async () => {
    await openMenu()
    failNextPuts = 1

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    // The store rolled the copy back, and the menu with it.
    await waitFor(() => expect(card().defaultMCPGateways).toEqual(['gw_a']), { timeout: 5_000 })

    await fire(() =>
      card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } })
    )
    await waitForPuts(2)
    expect(Object.keys(puts[1].body)).toEqual(['dcmDisplaySettings'])

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(3)
    expect(puts[2].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    await waitForRecord((record) => record.defaultMCPGateways, ['gw_a', 'gw_b'])
  }, 60_000)
})

describe('the gateway list a save sends is the saved list plus the user\'s own toggles (BL-855 review)', () => {
  const DISABLED_KEPT = { defaultMCPGateways: ['gw_a', 'gw_off'] }

  it('a saved gateway that is disabled (not in the list the menu loads) is shown out, and a CLI tool pick sends no gateway list', async () => {
    await openMenu({ staleOverrides: DISABLED_KEPT, otherWindow: DISABLED_KEPT })
    // Display only: the menu shows the gateways it can load.
    expect(card().defaultMCPGateways).toEqual(['gw_a'])

    await fire(() => card().onCliToolIdsChange(['cli_x', 'cli_z']))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultTools: ['cli_x', 'cli_z'] })
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_off'])
  }, 60_000)

  it('a display change sends no gateway list either', async () => {
    await openMenu({ staleOverrides: DISABLED_KEPT, otherWindow: DISABLED_KEPT })

    await fire(() =>
      card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } })
    )

    await waitForPuts(1)
    expect(Object.keys(puts[0].body)).toEqual(['dcmDisplaySettings'])
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_off'])
  }, 60_000)

  it('a toggle of another gateway adds or takes out only that gateway; the disabled one stays in the saved list', async () => {
    await openMenu({ staleOverrides: DISABLED_KEPT, otherWindow: DISABLED_KEPT })

    await toggleGateway('gw_b')
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_off', 'gw_b'] })
    await waitForRecord((record) => record.defaultMCPGateways, ['gw_a', 'gw_off', 'gw_b'])

    await toggleGateway('gw_a')
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ defaultMCPGateways: ['gw_off', 'gw_b'] })
    await waitForRecord((record) => record.defaultMCPGateways, ['gw_off', 'gw_b'])
  }, 60_000)

  it('a gateway list that fails to load leaves the saved selection shown, and a later pick sends no gateway list', async () => {
    failNextGatewayFetches = 1
    await openMenu({ expectCard: false })

    // The error state shows; nothing was saved, and Retry loads the list.
    await fireEvent.click(screen.getByRole('button', { name: /Retry/, hidden: true }))
    await waitFor(() => expect(card()).toBeTruthy(), { timeout: 15_000 })
    expect(card().defaultMCPGateways).toEqual(['gw_a'])

    await fire(() => card().onCliToolIdsChange(['cli_x', 'cli_z']))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultTools: ['cli_x', 'cli_z'] })
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a'])
  }, 60_000)

  it('clearing every display entry removes only the entries this tab knew; an entry another window saved since survives', async () => {
    const known = {
      ...DCM_EMPTY,
      groups: { 'gw_a::Files': 'hidden' },
      groupDisplayPreferences: { 'gw_a::Files': 'use-global' }
    }
    const otherWindowsEntry = {
      ...known,
      groups: { ...known.groups, 'gw_c::Other': 'group-only' },
      groupDisplayPreferences: { ...known.groupDisplayPreferences, 'gw_c::Other': 'group-only' }
    }
    await openMenu({ staleOverrides: { dcmDisplaySettings: known }, otherWindow: { dcmDisplaySettings: otherWindowsEntry } })

    await fire(() => card().onDcmDisplaySettingsChange(DCM_EMPTY))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      dcmDisplaySettings: {
        groups: { 'gw_a::Files': null },
        groupDisplayPreferences: { 'gw_a::Files': null }
      }
    })
    await waitForRecord((record) => record.dcmDisplaySettings?.groups, { 'gw_c::Other': 'group-only' })
  }, 60_000)
})

describe('the baseline after a save (BL-855 review)', () => {
  it('a save that resolves after a newer read of the agent does not put its older values back as the baseline', async () => {
    await openMenu()
    let release: () => void = () => {}
    heldPut = new Promise<void>((resolve) => {
      release = resolve
    })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    // Meanwhile the agents store takes another surface's CLI tool choice (this window's Agent Settings).
    agentStore.updateAgent(AGENT, { defaultTools: ['cli_y'] })
    await waitFor(() => expect(card().defaultCliToolIds).toEqual(['cli_y']), { timeout: 5_000 })
    release()
    await waitFor(() => expect(card().mcpSaveState).toBe('saved'), { timeout: 5_000 })

    await fire(() =>
      card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } })
    )
    await waitForPuts(2)
    expect(Object.keys(puts[1].body)).toEqual(['dcmDisplaySettings'])
  }, 60_000)

  it('a save the read of the agent does not re-run for (the same CLI tools in another order) still becomes the baseline', async () => {
    const tools = { defaultTools: ['cli_a', 'cli_b'] }
    await openMenu({ staleOverrides: tools, otherWindow: tools })

    await fire(() => card().onCliToolIdsChange(['cli_b', 'cli_a']))
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ defaultTools: ['cli_b', 'cli_a'] })
    await waitFor(() => expect(card().mcpSaveState).toBe('saved'), { timeout: 5_000 })

    await toggleGateway('gw_b')
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
  }, 60_000)
})

describe('the Tools menu sends only the zip settings the user changed (BL-855)', () => {
  // SA-129 DL-06 (BL-1484): the parked zip control permission has no control here, and a zip
  // save never names its hidden experiment key or the ignored legacy key: both stay as stored.
  it('offers no zip permission control, and a zip save leaves the hidden keys alone', async () => {
    const parkedOn = { zip_agent_control_experiment: true, zip_agent_control_enabled: true }
    await openMenu({ staleOverrides: parkedOn, otherWindow: { ...OTHER_WINDOW, ...parkedOn } })
    expect(card().onZipAgentControlChange).toBeUndefined()
    expect(card().zipAgentControlEnabled).toBeUndefined()

    await fire(() => card().onNonMcpZipOverrideChange('read_file', { buffer_size: '9' }))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ buffer_size_read_file: 9 })
    await waitForRecord((record) => record.buffer_size_read_file, 9)
    const record = await storedAgent(AGENT)
    expect(record.zip_agent_control_experiment).toBe(true)
    expect(record.zip_agent_control_enabled).toBe(true)
    expect(record.zip_ai_view_mode).toBe('inline')
    expect(record.custom_tool_settings).toEqual(OTHER_WINDOW.custom_tool_settings)
  }, 60_000)

  it('a layout change sends that field alone', async () => {
    await openMenu()

    await fire(() => card().onZipAiViewModeChange('appended'))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ zip_ai_view_mode: 'appended' })
  }, 60_000)

  it('putting a zip field back to inherit is sent as null (a real value)', async () => {
    await openMenu({ staleOverrides: { zip_ai_view_mode: 'inline' }, otherWindow: { zip_ai_view_mode: 'inline' } })

    await fire(() => card().onZipAiViewModeChange('__inherit__'))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ zip_ai_view_mode: null })
    await waitForRecord((record) => record.zip_ai_view_mode ?? null, null)
  }, 60_000)

  it('a custom tool row change sends the custom tool list (whole, it is one value) and no other zip field', async () => {
    await openMenu({ otherWindow: { zip_ai_view_mode: 'inline' } })

    await fire(() => card().onToolZipOverrideChange('tool_x', { buffer_size: '7' }))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ custom_tool_settings: [{ tool_name: 'tool_x', buffer_size: 7 }] })
    await waitForRecord((record) => record.custom_tool_settings, [{ tool_name: 'tool_x', buffer_size: 7 }])
    expect((await storedAgent(AGENT)).zip_ai_view_mode).toBe('inline')
  }, 60_000)

  it('a Read File row change sends its own fields alone (no other row, no permission, no custom tool list)', async () => {
    await openMenu({ otherWindow: OTHER_WINDOW })

    await fire(() => card().onNonMcpZipOverrideChange('read_file', { buffer_size: '9' }))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ buffer_size_read_file: 9 })
    await waitForRecord((record) => record.buffer_size_read_file, 9)
    const record = await storedAgent(AGENT)
    expect(record.custom_tool_settings).toEqual(OTHER_WINDOW.custom_tool_settings)
    expect(record.zip_ai_view_mode).toBe('inline')
  }, 60_000)

  it('a Read File auto zip change sends that one field', async () => {
    await openMenu()

    await fire(() => card().onNonMcpZipOverrideChange('read_file', { auto_zip: 'enabled' }))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ auto_zip_read_file: true })
  }, 60_000)

  it('two zip changes inside the debounce go out as one save of both fields, and nothing else', async () => {
    await openMenu()

    await fire(() => card().onNonMcpZipOverrideChange('read_file', { buffer_size: '9' }))
    await fire(() => card().onZipAiViewModeChange('appended'))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ buffer_size_read_file: 9, zip_ai_view_mode: 'appended' })
    await pause(400)
    expect(puts).toHaveLength(1)
  }, 60_000)

  it('a second zip change does not send the first again', async () => {
    await openMenu()

    await fire(() => card().onNonMcpZipOverrideChange('read_file', { buffer_size: '9' }))
    await waitForPuts(1)
    await fire(() => card().onZipAiViewModeChange('appended'))
    await waitForPuts(2)

    expect(puts[0].body).toEqual({ buffer_size_read_file: 9 })
    expect(puts[1].body).toEqual({ zip_ai_view_mode: 'appended' })
  }, 60_000)

  it('a zip change put back before the save goes out sends nothing', async () => {
    await openMenu()

    await fire(() => card().onZipAiViewModeChange('appended'))
    await fire(() => card().onZipAiViewModeChange('__inherit__'))
    await pause(700)

    expect(puts).toEqual([])
  }, 60_000)

  it('a failed zip save is sent again by the same change', async () => {
    await openMenu()
    failNextPuts = 1

    await fire(() => card().onZipAiViewModeChange('appended'))
    await waitForPuts(1)
    await waitFor(() => expect(card().zipAiViewMode).toBe('__inherit__'), { timeout: 5_000 })

    await fire(() => card().onZipAiViewModeChange('appended'))
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ zip_ai_view_mode: 'appended' })
    await waitForRecord((record) => record.zip_ai_view_mode, 'appended')
  }, 60_000)
})
