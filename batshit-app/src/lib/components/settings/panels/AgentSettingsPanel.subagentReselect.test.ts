import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { subagentStore } from '$lib/stores/subagents.svelte'
import { jsonResponse, loadAgentRoute } from '$lib/test-utils/agentPutRoute'

/**
 * BL-955, BL-915: a Subagent save and a newer read of the same Subagent. A save is built from the
 * form, waits out its debounce, travels, and lands. In between, the panel can read the Subagent
 * again: a pick of another Subagent and back (`selectEditableSubagent`, from the panel's list, which
 * does not hold the change until the save's answer puts the saved record into the store), or a
 * store refresh (the list effect). That read puts the older copy into the form and the baseline;
 * the landing then moved the baseline to the saved change under a form that did not hold it, and
 * the section's effect sent the OLD value back.
 *
 * The rules (Faye's simple design, BRIEF-2): each read that replaces the Subagent's section forms
 * raises the Subagent's read counter, and each save carries the counter's value from the moment its
 * payload was built (S1). A landing with the same value and the same Subagent does what it always
 * did (S2). A landing with another value moves nothing of the form, the baseline, or the signature
 * and asks for a read when the panel is at rest (S3). A read replaces a section only while the
 * section is at rest: its form equals its baseline and no save of it is queued or on its way (S4,
 * S5). The asked read runs when the panel comes to rest (S6). There is no guard against a second
 * send: a read that leaves a busy section alone can make its effect queue an equal change again,
 * which is harmless (S7); each test counts those PUTs.
 *
 * Renders the REAL panel. `fetch` sends `/api/subagents/<id>` to the REAL route handler on the
 * default lane's Redis fake, so each test reads the STORED record. `holdNextPut()` holds a PUT's
 * ANSWER after the route wrote the record (the flight of the real route, which answers after its
 * profile syncs); with `{ beforeWrite: true }` the PUT also waits before the route runs (the request
 * is still on the wire), so a read in that window sees the older record.
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

useRedisTestServer()

const USER = 'ss955_user'
const AGENT = 'ss955_agent'
const SUB = 'ss955_sub'
const SUB_NAME = 'Ss955 Panel Sub'
const SUB2 = 'ss955_sub2'
const SUB2_NAME = 'Ss955 Second Sub'

const DCM_EMPTY = {
  version: 1,
  groups: {},
  tools: {},
  groupDisplayPreferences: {},
  toolDisplayPreferences: {}
}

/**
 * SA-139 R5: the CLI Subagent's Claude section that several cases used as their section save left
 * with that type. They use the API Subagent's own controls instead: the Tool Grid (a section with
 * its own effect-driven save) and the Batshit Work mode (a single-choice group of the core form).
 */
const TOOL_GRID = { defaultMCPGateways: ['gw_a'], defaultMCPToolSelections: ['tool_one'], dcmDisplaySettings: DCM_EMPTY }
const WORK_MODE_AGENT = {
  provider_specific_settings: { nativeTools: { bashAccessMode: 'agent', executionBackend: 'apple_container' } }
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

type Gate = { write: Promise<void> | null; answer: Promise<void> }
type ReadGate = { id: string; answer: Promise<void>; release: () => void }
type SubagentReadSnapshot = { id: string; record: Record<string, any> }

let subagentRoute: typeof import('../../../../routes/api/subagents/[id]/+server')
let agentRoute: Awaited<ReturnType<typeof loadAgentRoute>>
/** Every PUT body the panel sent for the Subagent under test, in order. */
let subagentPuts: Array<{ body: Record<string, any> }> = []
let subagentPutStatuses: Array<{ id: string; status: number }> = []
/** The same for the second Subagent. */
let secondSubagentPuts: Array<{ body: Record<string, any> }> = []
/** Every request that is not a read: opening a Subagent must leave it empty. */
let writeLog: string[] = []
/** Each Subagent PUT (of either Subagent) takes the next of these, in order. */
let gates: Gate[] = []
let subagentReadGates: ReadGate[] = []
let failedSubagentGets = new Map<string, number>()
let subagentGetEvents: string[] = []
let subagentGetSnapshots: SubagentReadSnapshot[] = []
/** While above zero, the next Subagent PUTs answer 500 without writing. */
let failNextPuts = 0
const originalFetch = global.fetch
let rendered: ReturnType<typeof render> | null = null

beforeAll(async () => {
  agentRoute = await loadAgentRoute()
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

beforeEach(async () => {
  // 3f6b10c8b moved the agent and Subagent GETs onto Lua reads the default lane's fake cannot run.
  // loadAgentRoute installs their read twins as spies, and afterEach's restoreAllMocks removes them,
  // so each case reinstalls them.
  agentRoute = await loadAgentRoute()
  ensureBrowserStubs()
  subagentPuts = []
  subagentPutStatuses = []
  secondSubagentPuts = []
  writeLog = []
  gates = []
  subagentReadGates = []
  failedSubagentGets = new Map()
  subagentGetEvents = []
  subagentGetSnapshots = []
  failNextPuts = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const gate of subagentReadGates) gate.release()
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

/** A Subagent PUT: recorded, then (if held) waits on the wire, the REAL route writes, then (if held) the answer waits. */
async function routeSubagentPut(id: string, body: string, log: Array<{ body: Record<string, any> }>) {
  log.push({ body: JSON.parse(body) })
  if (failNextPuts > 0) {
    failNextPuts -= 1
    return jsonResponse({ error: 'Probe refusal' }, 500)
  }
  const gate = gates.shift() ?? null
  if (gate?.write) await gate.write
  const request = new Request(`http://localhost/api/subagents/${id}`, { method: 'PUT', body })
  const response = (await subagentRoute.PUT({ params: { id }, request, locals: { user: { id: USER } } } as any)) as Response
  subagentPutStatuses.push({ id, status: response.status })
  if (gate) await gate.answer
  return response
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
    if (path === `/api/subagents/${SUB}` && method === 'PUT') return routeSubagentPut(SUB, String(init.body), subagentPuts)
    if (path === `/api/subagents/${SUB}` && method === 'GET') {
      const failures = failedSubagentGets.get(SUB) ?? 0
      if (failures > 0) {
        failedSubagentGets.set(SUB, failures - 1)
        subagentGetEvents.push(`failed:${SUB}`)
        return jsonResponse({ error: 'Probe subagent read refusal' }, 500)
      }
      const response = (await subagentRoute.GET({ params: { id: SUB }, locals: { user: { id: USER } } } as any)) as Response
      subagentGetEvents.push(`read:${SUB}`)
      const payload = await response.clone().json()
      subagentGetSnapshots.push({ id: SUB, record: payload.subagent })
      const gateIndex = subagentReadGates.findIndex((gate) => gate.id === SUB)
      if (gateIndex >= 0) {
        const [gate] = subagentReadGates.splice(gateIndex, 1)
        await gate.answer
      }
      subagentGetEvents.push(`answered:${SUB}`)
      return response
    }
    if (path === `/api/subagents/${SUB2}` && method === 'GET') {
      return (await subagentRoute.GET({ params: { id: SUB2 }, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === `/api/subagents/${SUB2}` && method === 'PUT') {
      return routeSubagentPut(SUB2, String(init.body), secondSubagentPuts)
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
    if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

/**
 * Holds the next Subagent PUT that is not held yet: its ANSWER waits after the route wrote, until
 * `answer()`. With `beforeWrite`, the PUT also waits before the route runs, until `write()`.
 */
function holdNextPut(options: { beforeWrite?: boolean } = {}) {
  let write: () => void = () => {}
  let answer: () => void = () => {}
  gates.push({
    write: options.beforeWrite
      ? new Promise<void>((resolve) => {
          write = resolve
        })
      : null,
    answer: new Promise<void>((resolve) => {
      answer = resolve
    })
  })
  return { write: () => write(), answer: () => answer() }
}

function holdNextSubagentGet(id = SUB) {
  let release = () => {}
  const answer = new Promise<void>((resolve) => { release = resolve })
  subagentReadGates.push({ id, answer, release })
  return { release }
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

async function storedSubagent() {
  return (await redis.json.get(`subagent:${SUB}`)) as Record<string, any>
}

async function storedSecondSubagent() {
  return (await redis.json.get(`subagent:${SUB2}`)) as Record<string, any>
}

/** Another Settings window saves through the REAL Subagent route (not one of this panel's PUTs). */
async function anotherWindowSaves(body: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/subagents/${SUB}`, { method: 'PUT', body: JSON.stringify(body) })
  const response = await subagentRoute.PUT({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)
  expect(response.status).toBe(200)
}

/** Seeds the second Subagent (an API Subagent unless `extra` says otherwise) before the panel opens. */
async function seedSecondSubagent(extra: Record<string, unknown> = {}) {
  await redis.json.set(`subagent:${SUB2}`, '$', { ...subagentRecord(), id: SUB2, slug: SUB2, displayName: SUB2_NAME, ...extra } as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB2)
}

/** Picks the Subagent named `name` in the panel's selector and waits until its form shows. */
async function pickSubagent(name: string) {
  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(name, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  await screen.findByDisplayValue(name, {}, { timeout: 15_000 })
}

async function openToolsTab() {
  const tab = screen.getAllByRole('tab').find((element) => /Tools/.test(element.textContent ?? ''))
  expect(tab).toBeTruthy()
  await fireEvent.mouseDown(tab as HTMLElement)
  await fireEvent.click(tab as HTMLElement)
  await waitFor(() => expect(card()).toBeTruthy(), { timeout: 10_000 })
}

/** Seeds the Subagent (`record`) and the second one, renders the panel and selects the Subagent. */
async function openSubagent(
  record: Record<string, unknown>,
  options: { toolsTab?: boolean; second?: Record<string, unknown> } = {}
) {
  installRoutes()
  await seedSecondSubagent(options.second)
  await redis.json.set(`subagent:${SUB}`, '$', record as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
  await redis.createAgent({ id: AGENT, user_id: USER, displayName: 'Reselect probe', agentType: 'api' } as any)
  rendered = render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Reselect probe', {}, { timeout: 15_000 })
  await pause(600)
  await pickSubagent(SUB_NAME)
  if (options.toolsTab) await openToolsTab()
  // Past every autosave debounce, so a save the opening queued would have gone out.
  await pause(1500)
  expect(subagentPuts).toEqual([])
  expect(writeLog).toEqual([])
}

function isReadWaitLocked(element: HTMLElement | null) {
  return Boolean(element && (element.matches(':disabled') || element.closest('fieldset:disabled, [inert]')))
}

/** Clicks `element` unless the read wait locks it; true when the click went through. */
async function tryReadWaitClick(element: HTMLElement) {
  if (isReadWaitLocked(element)) return false
  await fireEvent.click(element)
  return true
}

/** The shown Subagent's Batshit Work mode choice (an item of its single-choice group, by label). */
function workModeRadio(label: RegExp) {
  const group = screen.getByRole('group', { name: 'Subagent Batshit permissions mode' })
  return within(group).getByRole('radio', { name: label })
}

/** A Subagent record's saved Work mode. */
function workModeOf(record: Record<string, any> | null | undefined) {
  return record?.provider_specific_settings?.nativeTools?.bashAccessMode
}

async function storedWorkMode(read: () => Promise<Record<string, any>> = storedSubagent) {
  return workModeOf(await read())
}

/** A Work mode save names only the native tools block, with the mode (and its command location, BL-914). */
function expectWorkModeSave(body: Record<string, any>, mode: string) {
  expect(Object.keys(body)).toEqual(['provider_specific_settings'])
  expect(Object.keys(body.provider_specific_settings)).toEqual(['nativeTools'])
  expect(body.provider_specific_settings.nativeTools.bashAccessMode).toBe(mode)
}

/** How many PUT bodies repeat an earlier body exactly (S7's harmless second sends of an equal change). */
function equalRepeats(puts: Array<{ body: Record<string, any> }>) {
  const seen = new Set<string>()
  let repeats = 0
  for (const put of puts) {
    const key = JSON.stringify(put.body)
    if (seen.has(key)) repeats += 1
    seen.add(key)
  }
  return repeats
}

/** The text of every save status the panel shows right now (a status is in the DOM only while it has something to say). */
function saveStatusTexts() {
  return [...document.querySelectorAll('.batshit-settings-save-status')].map((element) => (element.textContent ?? '').trim())
}

/** The Instructions tab's Custom System Prompt editor of the shown Subagent, opened on `current`: its textarea and Save button. */
async function openPromptEditor(current: string) {
  const instructionsTab = screen.getAllByRole('tab').find((element) => /Instructions/.test(element.textContent ?? ''))
  expect(instructionsTab).toBeTruthy()
  await fireEvent.mouseDown(instructionsTab as HTMLElement)
  await fireEvent.click(instructionsTab as HTMLElement)
  const promptRow = screen
    .getAllByText('Custom System Prompt')
    .map((element) => element.closest('.batshit-settings-form-row') as HTMLElement | null)
    .find((row) => row && row.closest('details[name="subagent-instructions-cards"]'))
  expect(promptRow).toBeTruthy()
  await fireEvent.click(within(promptRow!).getByRole('button', { name: /Edit/ }))
  const editor = await screen.findByDisplayValue(current)
  const dialog = editor.closest('[role="dialog"]') as HTMLElement
  const save = within(dialog)
    .getAllByRole('button')
    .find((button) => /^Save/.test((button.textContent ?? '').trim())) as HTMLElement
  return { editor, save }
}

describe('a Subagent save that lands after the user picked another Subagent and back (BL-955)', () => {
  // SA-139 R5: the CLI Subagent's Claude section case left with that type; the Tool Grid and the
  // core form below hold the same rule.
  it('the Tool Grid: no PUT takes the gateways back, the record holds them, and the card shows them after the deferred read', async () => {
    await openSubagent(
      subagentRecord({ defaultMCPGateways: ['gw_a'], defaultMCPToolSelections: ['tool_one'], dcmDisplaySettings: DCM_EMPTY }),
      { toolsTab: true }
    )
    const put = holdNextPut()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ defaultMCPGateways: ['gw_a', 'gw_b'] })
    await waitFor(async () => expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), {
      timeout: 8_000
    })

    await pickSubagent(SUB2_NAME)
    await pickSubagent(SUB_NAME)
    await openToolsTab()
    expect(card().defaultMCPGateways).toEqual(['gw_a'])

    put.answer()
    await pause(2500)

    expect(subagentPuts.length).toBe(1)
    expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
  }, 120_000)

  it('the core form, with an edit of another field after the pick: the new name is not taken back, and both are stored and shown', async () => {
    await openSubagent(subagentRecord({ timeout_seconds: 30 }))
    const put = holdNextPut()

    await fireEvent.input(screen.getByDisplayValue(SUB_NAME), { target: { value: 'Ss955 Renamed' } })
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ displayName: 'Ss955 Renamed' })
    await waitFor(async () => expect((await storedSubagent()).displayName).toBe('Ss955 Renamed'), { timeout: 8_000 })

    await pickSubagent(SUB2_NAME)
    await pickSubagent(SUB_NAME)
    // The user changes the timeout on the form the pick brought (it shows the older name). That
    // save is on its way too; the two answers come in the order of the writes.
    const timeoutPut = holdNextPut()
    const timeout = document.getElementById('subagent-timeout') as HTMLInputElement
    await fireEvent.input(timeout, { target: { value: '90' } })
    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(subagentPuts[1].body).toEqual({ timeout_seconds: 90 })
    await waitFor(async () => expect((await storedSubagent()).timeout_seconds).toBe(90), { timeout: 8_000 })

    put.answer()
    await pause(400)
    timeoutPut.answer()
    await pause(2500)

    expect(subagentPuts.filter((entry) => entry.body.displayName === SUB_NAME)).toEqual([])
    expect(subagentPuts.length).toBe(2)
    const record = await storedSubagent()
    expect(record.displayName).toBe('Ss955 Renamed')
    expect(record.timeout_seconds).toBe(90)
    expect(screen.getByDisplayValue('Ss955 Renamed')).toBeTruthy()
    expect((document.getElementById('subagent-timeout') as HTMLInputElement).value).toBe('90')
  }, 120_000)

  it('guard (green on the old code too: the store record of the landing passes the list effect\'s core guard first): the core form with no edit after the pick', async () => {
    await openSubagent(subagentRecord())
    const put = holdNextPut()

    await fireEvent.input(screen.getByDisplayValue(SUB_NAME), { target: { value: 'Ss955 Renamed' } })
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await waitFor(async () => expect((await storedSubagent()).displayName).toBe('Ss955 Renamed'), { timeout: 8_000 })

    await pickSubagent(SUB2_NAME)
    await pickSubagent(SUB_NAME)

    put.answer()
    await pause(2500)

    expect(subagentPuts.length).toBe(1)
    expect((await storedSubagent()).displayName).toBe('Ss955 Renamed')
    expect(screen.getByDisplayValue('Ss955 Renamed')).toBeTruthy()
  }, 120_000)
})

describe('a store refresh while a Subagent section save is pending (BL-915)', () => {
  // SA-139 R5: these held the rule on the CLI Subagent's Claude section, which left with that type;
  // the Tool Grid is the API Subagent's section with its own effect-driven save.
  it('the Tool Grid, the save queued at a refresh that carries another window\'s Tool Grid change: the refresh leaves the section alone; the record holds both changes, and the card shows both', async () => {
    await openSubagent(subagentRecord(TOOL_GRID), { toolsTab: true })
    const put = holdNextPut()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    // Within the debounce: another window renames the Subagent and changes its tool selections, and
    // the store is refreshed. The core form is at rest, so the refresh passes its guard.
    await anotherWindowSaves({ displayName: 'Ss915 Renamed Elsewhere', defaultMCPToolSelections: ['tool_one', 'tool_two'] })
    await subagentStore.load()
    expect(subagentPuts).toEqual([])
    await screen.findByDisplayValue('Ss915 Renamed Elsewhere', {}, { timeout: 8_000 })
    const keptDuringRefresh = JSON.stringify(card().defaultMCPGateways) === JSON.stringify(['gw_a', 'gw_b'])

    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await waitFor(async () => expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), {
      timeout: 8_000
    })
    put.answer()
    await pause(2500)

    expect(subagentPuts.map((entry) => entry.body)).toEqual([{ defaultMCPGateways: ['gw_a', 'gw_b'] }])
    const record = await storedSubagent()
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.defaultMCPToolSelections).toEqual(['tool_one', 'tool_two'])
    expect(record.displayName).toBe('Ss915 Renamed Elsewhere')
    expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    // The deferred read ran once the section came to rest: the other window's change is on the card.
    expect(card().defaultMCPToolSelections).toEqual(['tool_one', 'tool_two'])
    expect(keptDuringRefresh).toBe(true)
  }, 120_000)

  it('a cached-list refresh during an unresolved PUT applies the accepted one-save rule', async () => {
    await openSubagent(subagentRecord(TOOL_GRID), { toolsTab: true })
    const first = holdNextPut({ beforeWrite: true })

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await anotherWindowSaves({ displayName: 'Ss915 Renamed Elsewhere' })
    await subagentStore.load()
    await screen.findByDisplayValue('Ss915 Renamed Elsewhere', {}, { timeout: 8_000 })
    const keptDuringRefresh = JSON.stringify(card().defaultMCPGateways) === JSON.stringify(['gw_a', 'gw_b'])

    // Past the debounce of anything the refresh queued; then the first PUT writes and answers.
    await pause(1500)
    first.write()
    await waitFor(async () => expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), {
      timeout: 8_000
    })
    first.answer()
    await pause(2500)

    // This is a list refresh while the same change is already unresolved; the final decision
    // accepts one save, while true stale-detail reads still retain their separate S7 echo test.
    expect(subagentPuts.map((entry) => entry.body)).toEqual([{ defaultMCPGateways: ['gw_a', 'gw_b'] }])
    expect(equalRepeats(subagentPuts)).toBe(0)
    expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect((await storedSubagent()).displayName).toBe('Ss915 Renamed Elsewhere')
    expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(keptDuringRefresh).toBe(true)
  }, 120_000)

  it('the Tool Grid, the save queued at the refresh: nothing takes the gateways back, and the card shows them', async () => {
    await openSubagent(subagentRecord(TOOL_GRID), { toolsTab: true })
    const put = holdNextPut()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await anotherWindowSaves({ displayName: 'Ss915 Renamed Elsewhere' })
    await subagentStore.load()
    expect(subagentPuts).toEqual([])
    await screen.findByDisplayValue('Ss915 Renamed Elsewhere', {}, { timeout: 8_000 })
    const keptDuringRefresh = JSON.stringify(card().defaultMCPGateways) === JSON.stringify(['gw_a', 'gw_b'])

    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await waitFor(async () => expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), {
      timeout: 8_000
    })
    put.answer()
    await pause(2500)

    expect(subagentPuts.map((entry) => entry.body)).toEqual([{ defaultMCPGateways: ['gw_a', 'gw_b'] }])
    expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(keptDuringRefresh).toBe(true)
  }, 120_000)
})

describe('the reviews\' orders on a Subagent, with the simple rules (BL-955)', () => {
  // SA-139 R5: these two held the rules on the CLI Subagent's Claude permissions mode; the API
  // Subagent's Batshit Work mode is the same kind of control (a single-choice group).
  it('a Subagent group remains read-only during its save and preserves the pending value', async () => {
    await openSubagent(subagentRecord(WORK_MODE_AGENT))
    const x = holdNextPut({ beforeWrite: true })

    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    const group = screen.getByRole('group', { name: 'Subagent Batshit permissions mode' })
    expect(isReadWaitLocked(group as HTMLElement)).toBe(true)
    // Native activation honors the disabled fieldset, unlike a manually dispatched event.
    workModeRadio(/^Agent$/).click()
    await tick()
    expect(subagentPuts).toHaveLength(1)
    expect(workModeRadio(/^Plan$/).getAttribute('aria-checked')).toBe('true')
    x.write()
    await waitFor(async () => expect(await storedWorkMode()).toBe('plan'), { timeout: 8_000 })
    x.answer()
    await waitFor(() => expect(screen.queryByTestId('subagent-settings-read-wait')).toBeNull(), { timeout: 8_000 })
    await waitFor(() => expect(isReadWaitLocked(workModeRadio(/^Agent$/))).toBe(false), { timeout: 8_000 })
    await pause(2500)

    expect(subagentPuts).toHaveLength(1)
    expectWorkModeSave(subagentPuts[0].body, 'plan')
    expect(await storedWorkMode()).toBe('plan')
    expect(workModeRadio(/^Plan$/).getAttribute('aria-checked')).toBe('true')
  }, 120_000)

  it('guard (no guard against a second send): a save of one Subagent is on its way; the same change on a second Subagent with an equal form is saved for the second', async () => {
    await openSubagent(subagentRecord(WORK_MODE_AGENT), { second: WORK_MODE_AGENT })
    const put = holdNextPut()

    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await pickSubagent(SUB2_NAME)
    // Every Subagent pick reads the Subagent (3f6b10c8b); the form is read-only until that read lands.
    await waitFor(() => expect(isReadWaitLocked(workModeRadio(/^Plan$/))).toBe(false), { timeout: 8_000 })
    await fireEvent.click(workModeRadio(/^Plan$/))

    await waitFor(() => expect(secondSubagentPuts.length).toBe(1), { timeout: 8_000 })
    expectWorkModeSave(secondSubagentPuts[0].body, 'plan')
    put.answer()
    await pause(2500)
    expect(await storedWorkMode(storedSecondSubagent)).toBe('plan')
    expect(await storedWorkMode()).toBe('plan')
    // The first Subagent's landing touched nothing of the second one it no longer showed.
    expect(workModeRadio(/^Plan$/).getAttribute('aria-checked')).toBe('true')
    expect(secondSubagentPuts.length).toBe(1)
  }, 120_000)
})

describe('a Subagent save that lands after the user picked another Subagent and stayed there (BL-955, the third review, must-fix 2)', () => {
  it('core: the status does not read "Saving subagent..." after the pick nor after the landing; the record holds the name and the shown Subagent is untouched', async () => {
    await openSubagent(subagentRecord())
    const put = holdNextPut()

    await fireEvent.input(screen.getByDisplayValue(SUB_NAME), { target: { value: 'Ss955 Renamed' } })
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ displayName: 'Ss955 Renamed' })
    await waitFor(async () => expect((await storedSubagent()).displayName).toBe('Ss955 Renamed'), { timeout: 8_000 })
    // The status shows while this save travels (proves the probe sees it).
    expect(saveStatusTexts()).toContain('Saving subagent...')

    await pickSubagent(SUB2_NAME)
    expect(saveStatusTexts()).not.toContain('Saving subagent...')

    put.answer()
    await pause(1200)

    expect(saveStatusTexts()).not.toContain('Saving subagent...')
    expect(subagentPuts.length).toBe(1)
    expect((await storedSubagent()).displayName).toBe('Ss955 Renamed')
    expect(secondSubagentPuts).toEqual([])
    expect(screen.getByDisplayValue(SUB2_NAME)).toBeTruthy()
  }, 120_000)

  it('the Tool Grid: the card is not told "saving" after the pick nor after the landing; the record holds the gateways', async () => {
    await openSubagent(
      subagentRecord({ defaultMCPGateways: ['gw_a'], defaultMCPToolSelections: ['tool_one'], dcmDisplaySettings: DCM_EMPTY }),
      { toolsTab: true }
    )
    const put = holdNextPut()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await waitFor(async () => expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), {
      timeout: 8_000
    })
    expect(card().mcpSaveState).toBe('saving')

    await pickSubagent(SUB2_NAME)
    await openToolsTab()
    expect(card().mcpSaveState).not.toBe('saving')

    put.answer()
    await pause(1200)

    expect(card().mcpSaveState).not.toBe('saving')
    expect(subagentPuts.length).toBe(1)
    expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(secondSubagentPuts).toEqual([])
  }, 120_000)
})

describe('a Subagent save that no read came between lands as "Saved" (BL-955, the third review, must-fix 3)', () => {
  it('guard (green on the old code too: no read came between, so the landing was current there as well): a Custom System Prompt saved from its editor with no other edit shows "Saved" at the landing, and the form holds the prompt', async () => {
    await openSubagent(subagentRecord({ system_prompt: 'Answer only in haiku.' }))
    const put = holdNextPut()

    const { editor, save } = await openPromptEditor('Answer only in haiku.')
    await fireEvent.input(editor, { target: { value: 'Answer in limericks.' } })
    await fireEvent.click(save)
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    // 3698a4293: an instructions save carries the saved-instructions token it was made against.
    expect(subagentPuts[0].body).toEqual({
      system_prompt: 'Answer in limericks.',
      expectedInstructions: { customPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }
    })
    await waitFor(async () => expect((await storedSubagent()).system_prompt).toBe('Answer in limericks.'), {
      timeout: 8_000
    })
    expect(saveStatusTexts()).toContain('Saving subagent...')

    // The answer puts the saved record into the store; the store-refresh effect reads it first.
    put.answer()
    await waitFor(() => expect(saveStatusTexts()).toContain('Saved'), { timeout: 1_500 })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5_000 })
    expect(subagentPuts.length).toBe(1)
    // Since 3698a4293 a known instructions save holds the prompt editor until its readback answers.
    await waitFor(() => expect(subagentGetEvents.at(-1)).toBe(`answered:${SUB}`), { timeout: 8_000 })
    await waitFor(() => expect(screen.queryByTestId('subagent-instructions-notice')).toBeNull(), { timeout: 8_000 })
    expect((await openPromptEditor('Answer in limericks.')).editor).toBeTruthy()
  }, 120_000)

  // SA-139 R5: this guard held the rule on the CLI Subagent's Claude section; the Tool Grid holds it now.
  it('guard (the refresh replaces the core form, so the Tool Grid effect builds its payload again after it): a store refresh while the Tool Grid save is queued: the card reads "saved", and the record holds both changes', async () => {
    await openSubagent(subagentRecord(TOOL_GRID), { toolsTab: true })
    const put = holdNextPut()

    await fire(() => card().onGatewaysChange(['gw_a', 'gw_b']))
    // Within the debounce: another window renames the Subagent, and the store is refreshed. The
    // core form is at rest, so the refresh passes its guard and reads the record.
    await anotherWindowSaves({ displayName: 'Ss915 Renamed Elsewhere' })
    await subagentStore.load()
    await screen.findByDisplayValue('Ss915 Renamed Elsewhere', {}, { timeout: 8_000 })

    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await waitFor(async () => expect((await storedSubagent()).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), {
      timeout: 8_000
    })
    put.answer()
    await waitFor(() => expect(card().mcpSaveState).toBe('saved'), { timeout: 1_500 })

    expect(subagentPuts.map((entry) => entry.body)).toEqual([{ defaultMCPGateways: ['gw_a', 'gw_b'] }])
    const record = await storedSubagent()
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.displayName).toBe('Ss915 Renamed Elsewhere')
    expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
  }, 120_000)
})

describe('a store refresh while a Subagent handler save is on its way (BL-955, the third review, must-fix 3)', () => {
  it('guard (green on the old code too: a CLI list save has no baseline to move): the CLI tools list is on the wire when the store is refreshed: the refresh leaves the counter alone, so the save lands as "Saved", and the record holds the list and the other window\'s rename', async () => {
    await openSubagent(subagentRecord(), { toolsTab: true })
    const put = holdNextPut()

    await fire(() => card().onCliToolIdsChange(['cli_x']))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ defaultTools: ['cli_x'] })
    await waitFor(async () => expect((await storedSubagent()).defaultTools).toEqual(['cli_x']), { timeout: 8_000 })
    expect(card().mcpSaveState).toBe('saving')

    // Another window renames the Subagent and the store is refreshed: the core form is at rest, so
    // the list effect reads the record; a handler save has no effect that sends it again.
    await anotherWindowSaves({ displayName: 'Ss915 Renamed Elsewhere' })
    await subagentStore.load()
    await screen.findByDisplayValue('Ss915 Renamed Elsewhere', {}, { timeout: 8_000 })

    put.answer()
    await waitFor(() => expect(card().mcpSaveState).toBe('saved'), { timeout: 1_500 })

    await pause(1500)
    expect(subagentPuts.length).toBe(1)
    const record = await storedSubagent()
    expect(record.defaultTools).toEqual(['cli_x'])
    expect(record.displayName).toBe('Ss915 Renamed Elsewhere')
    expect(card().defaultCliToolIds).toEqual(['cli_x'])
  }, 120_000)
})

describe('the Subagent CLI tools list, a pick away and back while its save travels (BL-955)', () => {
  it('nothing takes the list back, the record holds it, and the card shows it after the deferred read', async () => {
    await openSubagent(subagentRecord(), { toolsTab: true })
    const put = holdNextPut()

    await fire(() => card().onCliToolIdsChange(['cli_x']))
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ defaultTools: ['cli_x'] })
    await waitFor(async () => expect((await storedSubagent()).defaultTools).toEqual(['cli_x']), { timeout: 8_000 })

    // Another Subagent and back: the list is read again from the panel's list, which does not hold it yet.
    await pickSubagent(SUB2_NAME)
    await pickSubagent(SUB_NAME)
    await openToolsTab()
    expect(card().defaultCliToolIds).toEqual([])

    put.answer()
    await pause(2500)

    expect(subagentPuts.length).toBe(1)
    expect((await storedSubagent()).defaultTools).toEqual(['cli_x'])
    expect(card().defaultCliToolIds).toEqual(['cli_x'])
    expect(secondSubagentPuts).toEqual([])
  }, 120_000)
})

// SA-139 R5: 'guards on a Subagent: a Claude save with no read in between' left with the CLI
// Subagent's Claude section; the Tool Grid's own key-by-key case is in
// `AgentSettingsPanel.subagentBlockSaves.test.ts` ("a second Tool Grid change does not send the first again").

describe('BL-979: a Subagent section stays locked while a reselect read is waiting', () => {
  // SA-139 R5: held on the API Subagent's Batshit Work mode (the Claude permissions mode left).
  it('a pending permission-mode choice cannot be replaced by a second mode edit after pick-away/back', async () => {
    await openSubagent(subagentRecord(WORK_MODE_AGENT))
    const first = holdNextPut({ beforeWrite: true })
    const second = holdNextPut({ beforeWrite: true })

    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(subagentPuts).toHaveLength(1), { timeout: 8_000 })
    expectWorkModeSave(subagentPuts[0].body, 'plan')

    await pickSubagent(SUB2_NAME)
    await pickSubagent(SUB_NAME)
    const noticeVisible = Boolean(screen.queryByTestId('subagent-settings-read-wait'))
    const agentChoice = workModeRadio(/^Agent$/)
    const locked = isReadWaitLocked(agentChoice)

    // The reselected form is read from the older record. A mode edit on it would be sent before
    // the pending Plan choice lands and take it back.
    const secondEditBlocked = !(await tryReadWaitClick(agentChoice))
    if (!secondEditBlocked) {
      await waitFor(() => expect(subagentPuts).toHaveLength(2), { timeout: 8_000 })
      expectWorkModeSave(subagentPuts[1].body, 'agent')
    }

    first.write()
    await waitFor(async () => expect(await storedWorkMode()).toBe('plan'), { timeout: 8_000 })
    first.answer()
    if (!secondEditBlocked) {
      second.write()
      await waitFor(async () => expect(await storedWorkMode()).toBe('agent'), { timeout: 8_000 })
      second.answer()
    }
    await pause(2500)

    expect(subagentPuts).toHaveLength(1)
    expect(noticeVisible).toBe(true)
    expect(locked).toBe(true)
    expect(secondEditBlocked).toBe(true)
    expect(await storedWorkMode()).toBe('plan')
  }, 120_000)
})

describe('BL-979: Subagent GET failures and late answers stay with their requested entity', () => {
  // SA-139 R5: these carried their pending save on the CLI Subagent's Claude section (a fixture
  // vehicle); they carry it on the API Subagent's Batshit Work mode now.
  it('an A read failure does not leak to a healthy B before Retry', async () => {
    await openSubagent(subagentRecord(WORK_MODE_AGENT), { second: WORK_MODE_AGENT })
    const put = holdNextPut()
    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(subagentPuts).toHaveLength(1), { timeout: 8_000 })
    await waitFor(async () => expect(await storedWorkMode()).toBe('plan'), { timeout: 8_000 })

    await pickSubagent(SUB2_NAME)
    // Every Subagent pick reads the Subagent (3f6b10c8b): the failing read is set before the pick
    // back to A, so A's own read is the one that fails.
    failedSubagentGets.set(SUB, 1)
    await pickSubagent(SUB_NAME)
    put.answer()
    await waitFor(() => expect(subagentGetEvents).toContain(`failed:${SUB}`), { timeout: 8_000 })
    await screen.findByTestId('subagent-settings-read-wait')

    await pickSubagent(SUB2_NAME)
    // B's own pick-time read (3f6b10c8b) shows the waiting note until it lands; A's error never shows.
    expect(screen.queryByText('Probe subagent read refusal')).toBeNull()
    await waitFor(() => expect(screen.queryByTestId('subagent-settings-read-wait')).toBeNull(), { timeout: 8_000 })
    expect(screen.queryByText('Probe subagent read refusal')).toBeNull()
    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(secondSubagentPuts).toHaveLength(1), { timeout: 8_000 })
    await waitFor(() => expect(subagentPutStatuses).toContainEqual({ id: SUB2, status: 200 }), { timeout: 8_000 })
    await waitFor(async () => expect(await storedWorkMode(storedSecondSubagent)).toBe('plan'), { timeout: 8_000 })
    expectWorkModeSave(secondSubagentPuts[0].body, 'plan')
    expect(subagentPuts).toHaveLength(1)
    expect(await storedWorkMode()).toBe('plan')
  }, 120_000)

  it('a failed A read can Retry, and then a healthy B has no A error and saves normally', async () => {
    await openSubagent(subagentRecord(WORK_MODE_AGENT), { second: WORK_MODE_AGENT })
    const put = holdNextPut()

    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(subagentPuts).toHaveLength(1), { timeout: 8_000 })
    await waitFor(async () => expect(await storedWorkMode()).toBe('plan'), { timeout: 8_000 })

    await pickSubagent(SUB2_NAME)
    // Every Subagent pick reads the Subagent (3f6b10c8b): the failing read is set before the pick
    // back to A, so A's own read is the one that fails.
    failedSubagentGets.set(SUB, 1)
    await pickSubagent(SUB_NAME)
    put.answer()
    await waitFor(() => expect(subagentGetEvents).toContain(`failed:${SUB}`), { timeout: 8_000 })
    const failedNotice = await screen.findByTestId('subagent-settings-read-wait')
    expect(failedNotice.textContent).toContain('Probe subagent read refusal')
    const retry = within(failedNotice).getByRole('button', { name: /Retry/ })
    await fireEvent.click(retry)
    await waitFor(() => expect(subagentGetEvents).toContain(`answered:${SUB}`), { timeout: 8_000 })
    await waitFor(() => expect(workModeRadio(/^Plan$/).getAttribute('aria-checked')).toBe('true'), { timeout: 8_000 })
    expect(screen.queryByText('Probe subagent read refusal')).toBeNull()
    expect(workModeOf(subagentStore.subagents.find((item) => item.id === SUB))).toBe('plan')

    await pickSubagent(SUB2_NAME)
    expect(screen.queryByText('Probe subagent read refusal')).toBeNull()
    // B's own pick-time read (3f6b10c8b) shows the waiting note until it lands.
    await waitFor(() => expect(screen.queryByTestId('subagent-settings-read-wait')).toBeNull(), { timeout: 8_000 })
    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(secondSubagentPuts).toHaveLength(1), { timeout: 8_000 })
    await waitFor(() => expect(subagentPutStatuses).toContainEqual({ id: SUB2, status: 200 }), { timeout: 8_000 })
    await waitFor(async () => expect(await storedWorkMode(storedSecondSubagent)).toBe('plan'), { timeout: 8_000 })

    expectWorkModeSave(secondSubagentPuts[0].body, 'plan')
    expect(subagentPutStatuses).toContainEqual({ id: SUB2, status: 200 })
    expect(await storedWorkMode(storedSecondSubagent)).toBe('plan')
    expect(await storedWorkMode()).toBe('plan')
    expect(subagentPuts).toHaveLength(1)
  }, 120_000)

  it('a late A GET after A→B→A cannot replace the newer shared-cache record', async () => {
    await openSubagent(subagentRecord(WORK_MODE_AGENT))
    const put = holdNextPut()
    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(subagentPuts).toHaveLength(1), { timeout: 8_000 })
    await waitFor(async () => expect(await storedWorkMode()).toBe('plan'), { timeout: 8_000 })

    await pickSubagent(SUB2_NAME)
    await pickSubagent(SUB_NAME)
    const lateGet = holdNextSubagentGet(SUB)
    put.answer()
    await waitFor(() => expect(subagentGetEvents).toContain(`read:${SUB}`), { timeout: 8_000 })
    expect(subagentGetSnapshots[subagentGetSnapshots.length - 1]?.record.displayName).toBe(SUB_NAME)

    // A second pick-away/back invalidates the GET already in flight; a newer shared-list read then
    // installs a visible record before that stale response is released.
    await pickSubagent(SUB2_NAME)
    await pickSubagent(SUB_NAME)
    const newerName = 'A newer from the shared list'
    await anotherWindowSaves({ displayName: newerName })
    await subagentStore.load()
    await screen.findByDisplayValue(newerName, {}, { timeout: 8_000 })

    lateGet.release()
    await waitFor(() => expect(subagentGetEvents).toContain(`answered:${SUB}`), { timeout: 8_000 })
    await pause(300)

    expect((document.getElementById('subagent-display') as HTMLInputElement).value).toBe(newerName)
    expect(subagentStore.subagents.find((item) => item.id === SUB)?.displayName).toBe(newerName)
    expect((await storedSubagent()).displayName).toBe(newerName)
    expect(await storedWorkMode()).toBe('plan')
    expect(subagentPuts).toHaveLength(1)
    expect(secondSubagentPuts).toEqual([])
  }, 120_000)

  it('a Retry GET that read before a held A write cannot keep its old snapshot after the write lands', async () => {
    await openSubagent(subagentRecord(WORK_MODE_AGENT))
    const put = holdNextPut({ beforeWrite: true })
    const staleGet = holdNextSubagentGet(SUB)

    await fireEvent.click(workModeRadio(/^Plan$/))
    await waitFor(() => expect(subagentPuts).toHaveLength(1), { timeout: 8_000 })
    const readNotice = await screen.findByTestId('subagent-settings-read-wait')
    await fireEvent.click(within(readNotice).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(subagentGetEvents).toContain(`read:${SUB}`), { timeout: 8_000 })
    expect(workModeOf(subagentGetSnapshots.at(-1)?.record)).toBe('agent')
    expect(await storedWorkMode()).toBe('agent')

    const readsBeforePostWrite = subagentGetSnapshots.length
    put.write()
    await waitFor(async () => expect(await storedWorkMode()).toBe('plan'), { timeout: 8_000 })
    put.answer()
    await waitFor(() => expect(subagentPuts).toHaveLength(1), { timeout: 8_000 })

    staleGet.release()
    await waitFor(
      () => expect(subagentGetSnapshots.length).toBeGreaterThan(readsBeforePostWrite),
      { timeout: 8_000 }
    )
    await waitFor(async () => expect(await storedWorkMode()).toBe('plan'), { timeout: 8_000 })
    await waitFor(() => expect(workModeRadio(/^Plan$/).getAttribute('aria-checked')).toBe('true'), { timeout: 8_000 })

    // Every Subagent pick reads it too (3f6b10c8b), so the list also holds the opening pick's read and
    // its length is not fixed. The latest read, after the write, shows the written mode, and every
    // 'agent' read (the stale Retry read among them) came before the first 'plan' read.
    await waitFor(() => expect(workModeOf(subagentGetSnapshots.at(-1)?.record)).toBe('plan'), { timeout: 8_000 })
    const modes = subagentGetSnapshots.map(({ record }) => workModeOf(record))
    expect(modes.lastIndexOf('agent')).toBeLessThan(modes.indexOf('plan'))
    await waitFor(() => expect(workModeOf(subagentStore.subagents.find((item) => item.id === SUB))).toBe('plan'), { timeout: 8_000 })
    expect(subagentPuts.length).toBeGreaterThanOrEqual(1)
    expect(subagentPuts.length).toBeLessThanOrEqual(2)
    for (const put of subagentPuts) {
      expectWorkModeSave(put.body, 'plan')
    }
    expect(secondSubagentPuts).toEqual([])
  }, 120_000)
})
