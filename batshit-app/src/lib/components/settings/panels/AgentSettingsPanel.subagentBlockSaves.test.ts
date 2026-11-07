import { useOwnedRedisTestServer } from '$lib/test-utils/ownedRedisTestServer'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { jsonResponse, loadAgentRoute } from '$lib/test-utils/agentPutRoute'
import { TYPED_FILE_TOOLS_REVISION_HEADER } from '$lib/utils/typedFileToolsSave'

/**
 * BL-914, the panel half. The Subagent PUT writes `provider_specific_settings` and
 * `dcmDisplaySettings` KEY BY KEY now (a key or entry sent as `null` is removed; one not sent
 * stays), so every Subagent sender of Agent Settings sends only what changed against a copy it
 * keeps, a dropped key as `null`, the way the Primary Agent's senders do (BL-514, BL-848, BL-855,
 * BL-919):
 * - the core save (`subagentSettingsSavePatch.ts`): `provider_specific_settings` key by key;
 * - the Tool Grid save: `diffMcpSection` against `subagentMcpPersistedValues`.
 * SA-139 R5: the CLI Subagent's Claude section (and its BL-1542 first-form and BL-941 Part S
 * cases) left with that type. A leftover CLI Subagent is still opened below: it writes nothing.
 *
 * Renders the REAL panel. `fetch` sends `/api/subagents/<id>` and `/api/agents/<id>` to the REAL
 * route handlers on the default lane's Redis fake (its twin of the by-path script), so each test
 * sees the body the panel sent and the record after another window's change. "Another window" saves
 * through the real Subagent route with the body a second Settings window would send.
 */

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
// A CLI Subagent's save writes its managed profile folder under the real home: not in a test.
vi.mock('$lib/server/services/cliSubagentProfileSync', () => ({
  syncManagedCliSubagentProfile: vi.fn(async () => ({ written: true })),
  deleteManagedCliSubagentProfile: vi.fn(async () => {}),
  holdManagedCliSubagentProfileFolder: vi.fn(async () => {}),
  planManagedCliSubagentProfileDeletion: vi.fn(async () => null)
}))
vi.mock('$lib/components/settings/agent/AgentMcpDefaultsCard.svelte', async () => ({
  default: (await import('../../mcps/__tests__/AgentMcpDefaultsCardStub.test.svelte')).default
}))

const admission = useOwnedRedisTestServer(redis)
afterAll(async () => {
  // Ordinary CI owns this file's lazy facade too; the packet helper owns its admitted teardown.
  if (process.env.VITEST_USE_REAL_REDIS === 'true' && !admission.ownedLane) await redis.disconnect()
})

const USER = 'ss914p_user'
const AGENT = 'ss914p_agent'
const SUB = 'ss914p_sub'
const SUB_NAME = 'Ss914p Panel Sub'
// A second Subagent, for a save that lands after another Subagent was picked.
const SUB2 = 'ss914p_sub2'
const SUB2_NAME = 'Ss914p Second Sub'

const CLAUDE_BASE = {
  permissionMode: 'acceptEdits',
  includeCoreSystemPrompt: false,
  includeProjectInstructions: true,
  model: 'sonnet',
  alwaysThinkingEnabled: false,
  configScope: 'managed',
  systemPromptMode: 'replace',
  chrome: false,
  addDirs: [] as string[],
  allowedTools: [] as string[],
  disallowedTools: [] as string[],
  configOverrides: [] as unknown[],
  workingDirectoryMode: 'project'
}

const DCM_EMPTY = {
  version: 1,
  groups: {},
  tools: {},
  groupDisplayPreferences: {},
  toolDisplayPreferences: {}
}

/** A CLI Claude Subagent's model fields. */
const CLAUDE_CLI_FIELDS = {
  primary_model_provider: 'claude-cli',
  primary_model_name: 'claude-cli',
  primary_model_connection: { type: 'cli', service: 'claude-cli' }
} as const

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
/** Every Subagent PUT body the panel sent, in order. */
let subagentPuts: Array<{ body: Record<string, any> }> = []
/** The same for the second Subagent (`SUB2`). */
let secondSubagentPuts: Array<{ body: Record<string, any> }> = []
/** Every request that is not a read, to any route: opening a Subagent must leave this empty. */
let writeLog: string[] = []
/** While set, the next Subagent PUT answers 500 without touching the record. */
let failNextSubagentPut = false
/** While set, the next Subagent PUT's BODY is held inside the route, after it read the record. */
let holdNextSubagentBody: Promise<void> | null = null
let savedModels: Record<string, unknown>[] = []
let typedHostFacts = false
const originalFetch = global.fetch

beforeAll(async () => {
  agentRoute = await loadAgentRoute()
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

beforeEach(async () => {
  // 3f6b10c8b moved the agent and Subagent GETs onto Lua reads the default lane's fake cannot run
  // (the GET answered 500). loadAgentRoute installs their read twins as spies, and afterEach's
  // restoreAllMocks removes them, so each case reinstalls them.
  agentRoute = await loadAgentRoute()
  ensureBrowserStubs()
  subagentPuts = []
  secondSubagentPuts = []
  writeLog = []
  typedHostFacts = false
  failNextSubagentPut = false
  holdNextSubagentBody = null
  savedModels = []
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
 * A PUT request whose body is not readable until `hold` settles: the route has read the record
 * and waits for the body, the way a slow browser upload does.
 */
function requestFor(path: string, method: string, body: string | undefined, hold: Promise<void> | null) {
  if (method !== 'PUT' || !hold || body === undefined) {
    return new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? body : undefined })
  }
  const stream = new ReadableStream({
    async start(controller) {
      await hold
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    }
  })
  return new Request(`http://localhost${path}`, { method, body: stream, duplex: 'half' } as RequestInit)
}

function installRoutes() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    if (method !== 'GET') writeLog.push(`${method} ${path}`)

    if (path === '/api/agents' && method === 'GET') {
      const agent = await redis.json.get(`agent:${AGENT}`)
      return jsonResponse({ agents: agent ? [agent] : [] })
    }
    if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
    if (path === `/api/agents/${AGENT}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      const handler = method === 'PUT' ? agentRoute.PUT : agentRoute.GET
      return (await handler({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/subagents' && method === 'GET') {
      const subs = [await redis.json.get(`subagent:${SUB}`), await redis.json.get(`subagent:${SUB2}`)].filter(Boolean)
      return jsonResponse({ subagents: subs })
    }
    if (path === `/api/subagents/${SUB2}`) {
      if (method === 'PUT') secondSubagentPuts.push({ body: JSON.parse(String(init.body)) })
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      const handler = method === 'PUT' ? subagentRoute.PUT : subagentRoute.GET
      return (await handler({ params: { id: SUB2 }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === `/api/subagents/${SUB}`) {
      let hold: Promise<void> | null = null
      if (method === 'PUT') {
        subagentPuts.push({ body: JSON.parse(String(init.body)) })
        if (failNextSubagentPut) {
          failNextSubagentPut = false
          return jsonResponse({ error: 'The Subagent could not be saved just now.' }, 500)
        }
        hold = holdNextSubagentBody
        holdNextSubagentBody = null
      }
      const request = requestFor(path, method, method === 'PUT' ? String(init.body) : undefined, hold)
      const handler = method === 'PUT' ? subagentRoute.PUT : subagentRoute.GET
      return (await handler({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: savedModels })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
    if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
    if (typedHostFacts && path === '/api/native-tools/sandbox/status' && url.includes('hostOnly=1')) {
      return jsonResponse({ typedFileToolsHost: { platform: 'darwin', containerized: false, linuxKernel: null } })
    }
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

function subagentRecord(extra: Record<string, unknown> = {}) {
  return {
    id: SUB,
    user_id: USER,
    displayName: SUB_NAME,
    slug: SUB,
    subagentType: 'api',
    specialty: 'general',
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
    ...extra
  }
}

function cliSubagentRecord(block: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return subagentRecord({ subagentType: 'cli', ...CLAUDE_CLI_FIELDS, ...(block ? { claude_settings: block } : {}), ...extra })
}

async function storedSubagent() {
  return (await redis.json.get(`subagent:${SUB}`)) as Record<string, any>
}

/**
 * Another Settings window saves through the REAL Subagent route with `body`: it is not one of this
 * panel's PUTs (`subagentPuts` does not see it), and the panel's copy is older than the record after.
 */
async function anotherWindowSaves(body: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/subagents/${SUB}`, { method: 'PUT', body: JSON.stringify(body) })
  const response = await subagentRoute.PUT({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)
  expect(response.status).toBe(200)
}

/** Seeds the Subagent (`record`) beside an API probe agent, renders the panel and selects the Subagent. */
async function openSubagent(record: Record<string, unknown>, options: { toolsTab?: boolean; reopen?: boolean } = {}) {
  installRoutes()
  if (!options.reopen) {
    await redis.json.set(`subagent:${SUB}`, '$', record as any)
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    await redis.createAgent({ id: AGENT, user_id: USER, displayName: 'Block probe', agentType: 'api',
      provider_specific_settings: { claude_max_thinking_tokens: 17 } } as any)
  }
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Block probe', {}, { timeout: 15_000 })
  await pause(600)

  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(SUB_NAME, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  await screen.findByDisplayValue(SUB_NAME, {}, { timeout: 15_000 })
  if (options.toolsTab) {
    const tab = screen.getAllByRole('tab').find((element) => /Tools/.test(element.textContent ?? ''))
    expect(tab).toBeTruthy()
    await fireEvent.mouseDown(tab as HTMLElement)
    await fireEvent.click(tab as HTMLElement)
    await waitFor(() => expect(card()).toBeTruthy(), { timeout: 10_000 })
  }
  // Past every autosave debounce, so a save the opening queued would have gone out.
  await pause(1500)
  expect(subagentPuts).toEqual([])
  expect(writeLog).toEqual([])
}

/** Seeds a second Subagent (`record` names its fields; it lists first only by name), before the panel opens. */
async function seedSecondSubagent(record: Record<string, unknown>) {
  await redis.json.set(`subagent:${SUB2}`, '$', { ...subagentRecord(), id: SUB2, slug: SUB2, displayName: SUB2_NAME, ...record } as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB2)
}

/** Picks the second Subagent in the panel's selector. */
async function pickSecondSubagent() {
  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(SUB2_NAME, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  await screen.findByDisplayValue(SUB2_NAME, {}, { timeout: 15_000 })
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(subagentPuts.length).toBe(count), { timeout: 8_000 })
  // Let the save's answer land in the panel before the next step.
  await pause(400)
}

function isInFlightLocked(element: HTMLElement | null) {
  return Boolean(element && (element.matches(':disabled') || element.closest('fieldset:disabled, [inert]')))
}

describe('a Subagent\'s Tool Grid save sends only what changed (BL-914)', () => {
  const OPENED = { defaultMCPGateways: ['gw_a'], defaultMCPToolSelections: ['tool_one'], dcmDisplaySettings: DCM_EMPTY }

  it('a gateway change sends the gateway list alone; display settings another window saved survive', async () => {
    await openSubagent(subagentRecord(OPENED), { toolsTab: true })
    await anotherWindowSaves({
      dcmDisplaySettings: { groups: { 'gw_a::Files': 'hidden' }, groupDisplayPreferences: { 'gw_a::Files': 'use-global' } }
    })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    const record = await storedSubagent()
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.dcmDisplaySettings.groups).toEqual({ 'gw_a::Files': 'hidden' })
  }, 120_000)

  it('a display change sends only the entries it changed; an entry another window saved survives', async () => {
    await openSubagent(subagentRecord(OPENED), { toolsTab: true })
    await anotherWindowSaves({ dcmDisplaySettings: { groups: { 'gw_c::Docs': 'hidden' } } })

    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({
      dcmDisplaySettings: {
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      }
    })
    const record = await storedSubagent()
    expect(record.dcmDisplaySettings.groups).toEqual({ 'gw_c::Docs': 'hidden', 'gw_b::Reading': 'group-only' })
    expect(record.defaultMCPGateways).toEqual(['gw_a'])
  }, 120_000)

  it('taking an entry out of the display settings removes that entry alone; an entry another window saved survives', async () => {
    const held = {
      ...DCM_EMPTY,
      groups: { 'gw_a::Files': 'hidden', 'gw_b::Reading': 'group-only' },
      groupDisplayPreferences: { 'gw_a::Files': 'use-global', 'gw_b::Reading': 'group-only' }
    }
    await openSubagent(subagentRecord({ ...OPENED, dcmDisplaySettings: held }), { toolsTab: true })
    await anotherWindowSaves({ dcmDisplaySettings: { groups: { 'gw_c::Docs': 'hidden' } } })

    await fire(() =>
      card().onDcmDisplaySettingsChange({
        ...held,
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      })
    )

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({
      dcmDisplaySettings: { groups: { 'gw_a::Files': null }, groupDisplayPreferences: { 'gw_a::Files': null } }
    })
    const record = await storedSubagent()
    expect(record.dcmDisplaySettings.groups).toEqual({ 'gw_b::Reading': 'group-only', 'gw_c::Docs': 'hidden' })
    expect(record.dcmDisplaySettings.groupDisplayPreferences).toEqual({ 'gw_b::Reading': 'group-only' })
  }, 120_000)

  it('a Subagent that holds its display settings only under the older name gets the whole block on its first display save', async () => {
    const older = { ...DCM_EMPTY, groups: { 'gw_a::Files': 'hidden' }, groupDisplayPreferences: { 'gw_a::Files': 'use-global' } }
    await openSubagent(subagentRecord({ ...OPENED, dcmDisplaySettings: undefined, dcm_display_settings: older }), {
      toolsTab: true
    })

    await fire(() =>
      card().onDcmDisplaySettingsChange({ ...older, groups: { ...older.groups, 'gw_b::Reading': 'group-only' } })
    )

    await waitForPuts(1)
    // Every entry goes (the older name's included), not just the new one: the new name is written from it.
    expect(subagentPuts[0].body.dcmDisplaySettings.groups).toEqual({ 'gw_a::Files': 'hidden', 'gw_b::Reading': 'group-only' })
    expect((await storedSubagent()).dcmDisplaySettings.groups).toEqual({
      'gw_a::Files': 'hidden',
      'gw_b::Reading': 'group-only'
    })
  }, 120_000)

  it('a second Tool Grid change does not send the first again: the baseline moves to what the last save sent', async () => {
    await openSubagent(subagentRecord(OPENED), { toolsTab: true })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))
    await waitForPuts(2)
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b', 'gw_c']))
    await waitForPuts(3)

    expect(subagentPuts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    expect(subagentPuts[1].body).toEqual({
      dcmDisplaySettings: {
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      }
    })
    expect(subagentPuts[2].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b', 'gw_c'] })
  }, 120_000)

  it('a failed save leaves the baseline as it was: the next change sends the failed one again, with its own', async () => {
    await openSubagent(subagentRecord(OPENED), { toolsTab: true })

    failNextSubagentPut = true
    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitForPuts(1)
    expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a'])

    await fire(() => card().onDcmDisplaySettingsChange({ ...DCM_EMPTY, groups: { 'gw_b::Reading': 'group-only' } }))
    await waitForPuts(2)
    expect(subagentPuts[1].body).toEqual({
      defaultMCPGateways: ['gw_a', 'gw_b'],
      dcmDisplaySettings: {
        groups: { 'gw_b::Reading': 'group-only' },
        groupDisplayPreferences: { 'gw_b::Reading': 'group-only' }
      }
    })
  }, 120_000)

  it('a change that leaves every value as it was sends nothing', async () => {
    await openSubagent(subagentRecord(OPENED), { toolsTab: true })

    await fire(() => card().onGatewaysChange(['gw_a']))
    await pause(1500)

    expect(subagentPuts).toEqual([])
  }, 120_000)
})

describe('a Subagent\'s core save sends provider_specific_settings key by key (BL-914)', () => {
  /** Opens the Access tab's Always Block List editor, which lists `rm -rf *`, and saves `text` in it. */
  async function saveBlockList(text: string) {
    const blockListRow = screen.getByText('rm -rf *').closest('.batshit-settings-muted-panel') as HTMLElement
    await fireEvent.click(within(blockListRow).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('rm -rf *')
    await fireEvent.input(editor, { target: { value: text } })
    await fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
  }

  it('a Work mode pick sends the mode and its command location only; a never-allow list another window saved since survives', async () => {
    await openSubagent(
      subagentRecord({
        provider_specific_settings: {
          nativeTools: { bashAccessMode: 'agent', executionBackend: 'apple_container', bashNeverAllowList: ['rm -rf *'] }
        }
      })
    )
    // Another window saved a new never-allow list after this panel loaded.
    await anotherWindowSaves({ provider_specific_settings: { nativeTools: { bashNeverAllowList: ['sudo *'] } } })

    const group = screen.getByRole('group', { name: 'Subagent Batshit permissions mode' })
    await fireEvent.click(within(group).getByRole('radio', { name: /Plan/ }))

    await waitForPuts(1)
    const sent = subagentPuts[0].body.provider_specific_settings
    expect(Object.keys(sent)).toEqual(['nativeTools'])
    expect(sent.nativeTools.bashAccessMode).toBe('plan')
    expect(typeof sent.nativeTools.executionBackend).toBe('string')
    // The list the form held is not named: the other window's list is not taken back.
    expect('bashNeverAllowList' in sent.nativeTools).toBe(false)
    const nativeTools = (await storedSubagent()).provider_specific_settings.nativeTools
    expect(nativeTools.bashAccessMode).toBe('plan')
    expect(nativeTools.bashNeverAllowList).toEqual(['sudo *'])
  }, 120_000)
})

describe('two saves of one Subagent panel at the same moment both stay (BL-914)', () => {
  it('a Tool Grid edit is blocked during a core save, then saves after that write settles', async () => {
    await openSubagent(
      subagentRecord({ defaultMCPGateways: ['gw_a'], defaultMCPToolSelections: ['tool_one'], dcmDisplaySettings: DCM_EMPTY }),
      { toolsTab: true }
    )
    let release: () => void = () => {}
    holdNextSubagentBody = new Promise<void>((resolve) => {
      release = resolve
    })

    const name = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(name, { target: { value: 'Ss914p Renamed' } })
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await waitFor(() => expect(isInFlightLocked(name)).toBe(true), { timeout: 8_000 })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    expect(subagentPuts).toHaveLength(1)
    expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a'])

    release()
    await waitFor(async () => expect((await storedSubagent()).displayName).toBe('Ss914p Renamed'), { timeout: 8_000 })
    await waitFor(() => expect(isInFlightLocked(name)).toBe(false), { timeout: 8_000 })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    await waitFor(async () => expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), { timeout: 8_000 })

    expect(subagentPuts[0].body).toEqual({ displayName: 'Ss914p Renamed' })
    expect(subagentPuts[1].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    const record = await storedSubagent()
    expect(record.displayName).toBe('Ss914p Renamed')
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(subagentPuts.length).toBe(2)
  }, 120_000)
})

describe('a save that lands after another Subagent was picked leaves the newer Subagent alone (BL-914)', () => {
  it('a Tool Grid save: the second Subagent is not saved because the first one\'s save landed', async () => {
    await seedSecondSubagent({ defaultMCPGateways: ['gw_z'], defaultMCPToolSelections: [], dcmDisplaySettings: DCM_EMPTY })
    await openSubagent(
      subagentRecord({ defaultMCPGateways: ['gw_a'], defaultMCPToolSelections: ['tool_one'], dcmDisplaySettings: DCM_EMPTY }),
      { toolsTab: true }
    )
    let release: () => void = () => {}
    holdNextSubagentBody = new Promise<void>((resolve) => {
      release = resolve
    })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await pickSecondSubagent()
    await pause(300)
    release()
    await waitFor(async () => expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), { timeout: 8_000 })
    await pause(2500)

    expect(secondSubagentPuts).toEqual([])
    expect(((await redis.json.get(`subagent:${SUB2}`)) as Record<string, any>).defaultMCPGateways).toEqual(['gw_z'])
  }, 120_000)
})

describe('text edited while a section save is in flight is not marked saved with it (BL-914)', () => {
  // SA-139 R5: the Claude section of the CLI Subagent left with that type; the rule is held on the
  // API Subagent's Batshit Work mode (a core-form control, saved key by key in `nativeTools`).
  it('a Work mode control is blocked during its save, then a deliberate next edit sends its own key', async () => {
    await openSubagent(
      subagentRecord({ provider_specific_settings: { nativeTools: { bashAccessMode: 'agent', executionBackend: 'apple_container' } } })
    )
    let release: () => void = () => {}
    holdNextSubagentBody = new Promise<void>((resolve) => {
      release = resolve
    })
    const workMode = (label: RegExp) =>
      within(screen.getByRole('group', { name: 'Subagent Batshit permissions mode' })).getByRole('radio', { name: label })

    await fireEvent.click(workMode(/^Plan$/))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(Object.keys(subagentPuts[0].body)).toEqual(['provider_specific_settings'])
    expect(subagentPuts[0].body.provider_specific_settings.nativeTools.bashAccessMode).toBe('plan')
    const agentChoice = workMode(/^Agent$/)
    await waitFor(() => expect(isInFlightLocked(agentChoice)).toBe(true), { timeout: 8_000 })
    // Native activation honors the disabled fieldset, unlike a manually dispatched event.
    agentChoice.click()
    await pause(50)
    expect(workMode(/^Plan$/).getAttribute('aria-checked')).toBe('true')
    expect(subagentPuts).toHaveLength(1)

    release()
    await waitFor(async () => expect((await storedSubagent()).provider_specific_settings.nativeTools.bashAccessMode).toBe('plan'), { timeout: 8_000 })
    await waitFor(() => expect(isInFlightLocked(agentChoice)).toBe(false), { timeout: 8_000 })

    await fireEvent.click(workMode(/^Agent$/))
    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(Object.keys(subagentPuts[1].body)).toEqual(['provider_specific_settings'])
    expect(subagentPuts[1].body.provider_specific_settings.nativeTools.bashAccessMode).toBe('agent')
    expect('bashNeverAllowList' in subagentPuts[1].body.provider_specific_settings.nativeTools).toBe(false)
    await pause(600)
    expect((await storedSubagent()).provider_specific_settings.nativeTools.bashAccessMode).toBe('agent')
    await pause(1500)
    expect(subagentPuts.length).toBe(2)
  }, 120_000)
})

describe('opening a Subagent saves nothing (BL-914: the new baselines are set, never sent)', () => {
  it('a CLI Claude Subagent with a block, a Tool Grid and older keys', async () => {
    await openSubagent(
      cliSubagentRecord({ ...CLAUDE_BASE, permissionMode: 'plan', addDirs: ['/tmp/a'] }, {
        defaultMCPGateways: ['gw_a'],
        defaultMCPToolSelections: ['tool_one'],
        defaultTools: ['cli_x'],
        dcmDisplaySettings: { ...DCM_EMPTY, groups: { 'gw_a::Files': 'hidden' }, groupDisplayPreferences: { 'gw_a::Files': 'use-global' } },
        provider_specific_settings: { claude_model: 'sonnet', nativeTools: { bashNeverAllowList: ['rm -rf *'] } }
      })
    )
    await pause(1500)
    expect(subagentPuts).toEqual([])
    expect(writeLog).toEqual([])
  }, 120_000)

  it('a CLI Claude Subagent with no block yet (only the older provider keys)', async () => {
    await openSubagent(cliSubagentRecord(null, { provider_specific_settings: { claude_model: 'opus' } }))
    await pause(1500)
    expect(subagentPuts).toEqual([])
    expect(writeLog).toEqual([])
  }, 120_000)

  it('a CLI Claude Subagent with a block', async () => {
    await openSubagent(
      cliSubagentRecord({ ...CLAUDE_BASE, alwaysThinkingEnabled: true, maxThinkingTokens: 4000 })
    )
    await pause(1500)
    expect(subagentPuts).toEqual([])
    expect(writeLog).toEqual([])
  }, 120_000)

  it('an API Subagent with a Tool Grid held only under the older display name', async () => {
    const older = { ...DCM_EMPTY, groups: { 'gw_a::Files': 'hidden' }, groupDisplayPreferences: { 'gw_a::Files': 'use-global' } }
    await openSubagent(
      subagentRecord({
        defaultMCPGateways: ['gw_a'],
        defaultMCPToolSelections: ['tool_one'],
        dcm_display_settings: older,
        provider_specific_settings: { temperature: 0.7, nativeTools: { bashAccessMode: 'agent' } }
      }),
      { toolsTab: true }
    )
    await pause(1500)
    expect(subagentPuts).toEqual([])
    expect(writeLog).toEqual([])
  }, 120_000)
})

describe('SA-136 D1: the Subagent\'s own Typed File Tools row (LS-083)', () => {
  // Like the owning typed-choice suite, this guarded save needs the actual conditional-save
  // receipt. The default fake deliberately models no typed acknowledgement or EVAL capability.
  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('saves the Subagent\'s explicit true/false choice, preserves siblings, and refuses the retired inherit intent', async () => {
    typedHostFacts = true
    const siblings = { bashEnabled: true, executionBackend: 'local', artifactRuntimeEnabled: true }
    await openSubagent(
      subagentRecord({ provider_specific_settings: { nativeTools: { ...siblings, typedFileToolsEnabled: false } } }),
      { toolsTab: true }
    )
    expect(card().subjectKind).toBe('subagent')
    expect(card().agentId).toBe(SUB)
    const detail = await subagentRoute.GET({ params: { id: SUB }, locals: { user: { id: USER } } } as any) as Response
    const original = detail.headers.get(TYPED_FILE_TOOLS_REVISION_HEADER)
    expect(original).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(card().getEnableControl('typed_file_tools')).toMatchObject({ checked: false, disabled: false })
    await fire(() => card().getEnableControl('typed_file_tools').onChange(true))
    await waitForPuts(1)
    await waitFor(() => expect(card().mcpSaveState).toBe('saved'), { timeout: 8_000 })
    expect(subagentPuts[0].body.provider_specific_settings).toEqual({ nativeTools: { typedFileToolsEnabled: true } })
    expect(subagentPuts[0].body.expectedTypedFileTools).toBe(original)
    expect((await storedSubagent()).provider_specific_settings.nativeTools).toEqual({ ...siblings, typedFileToolsEnabled: true })
    const savedDetail = await subagentRoute.GET({ params: { id: SUB }, locals: { user: { id: USER } } } as any) as Response
    const saved = savedDetail.headers.get(TYPED_FILE_TOOLS_REVISION_HEADER)
    expect(saved).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(saved).not.toBe(original)
    expect(card().getEnableControl('typed_file_tools')).toMatchObject({ checked: true, disabled: false })
    await fire(() => card().getEnableControl('typed_file_tools').onChange(false))
    await waitForPuts(2)
    await waitFor(() => expect(card().mcpSaveState).toBe('saved'), { timeout: 8_000 })
    expect(subagentPuts[1].body.provider_specific_settings).toEqual({ nativeTools: { typedFileToolsEnabled: false } })
    expect(subagentPuts[1].body.expectedTypedFileTools).toBe(saved)
    expect((await storedSubagent()).provider_specific_settings.nativeTools).toEqual({ ...siblings, typedFileToolsEnabled: false })
    expect(writeLog).toEqual([`PUT /api/subagents/${SUB}`, `PUT /api/subagents/${SUB}`])

    const before = await storedSubagent()
    const current = await subagentRoute.GET({ params: { id: SUB }, locals: { user: { id: USER } } } as any) as Response
    const refusal = await subagentRoute.PUT({ params: { id: SUB }, locals: { user: { id: USER } },
      request: new Request(`http://localhost/api/subagents/${SUB}`, { method: 'PUT', body: JSON.stringify({
        displayName: 'Must not land', provider_specific_settings: { nativeTools: { typedFileToolsEnabled: null } },
        expectedTypedFileTools: current.headers.get(TYPED_FILE_TOOLS_REVISION_HEADER)
      }) }) } as any) as Response
    expect(refusal.status).toBe(400)
    expect((await refusal.json()).error).toBe('Typed File Tools must be explicitly on or off. Nothing was saved.')
    expect(await storedSubagent()).toEqual(before)
    expect(secondSubagentPuts).toEqual([])
    expect(subagentPuts).toHaveLength(2)
  }, 120_000)
})
