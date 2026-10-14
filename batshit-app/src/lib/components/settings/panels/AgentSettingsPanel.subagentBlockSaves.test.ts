import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import * as agentStore from '$lib/stores/agents.svelte'
import { jsonResponse } from '$lib/test-utils/agentPutRoute'
import { CODEX_PERMISSION_PRESETS, CODEX_SANDBOX_LABELS } from '$lib/utils/codexRunAccess'

/**
 * BL-914, the panel half. The Subagent PUT writes `codex_settings`, `claude_settings`,
 * `provider_specific_settings` and `dcmDisplaySettings` KEY BY KEY now (a key or entry sent as
 * `null` is removed; one not sent stays), so every Subagent sender of Agent Settings sends only
 * what changed against a copy it keeps, a dropped key as `null`, the way the Primary Agent's
 * senders do (BL-514, BL-848, BL-855, BL-919):
 * - the core save (`subagentSettingsSavePatch.ts`): `provider_specific_settings` key by key;
 * - the Tool Grid save: `diffMcpSection` against `subagentMcpPersistedValues`;
 * - the Codex and Claude sections of a CLI Subagent: `diffAgentBlockWithGroups` against
 *   `subagentCodexPersistedBlock` and `subagentClaudePersistedBlock`.
 *
 * Renders the REAL panel. `fetch` sends `/api/subagents/<id>` and `/api/agents/<id>` to the REAL
 * route handlers on the default lane's Redis fake (its twin of the by-path script), so each test
 * sees the body the panel sent and the record after another window's change. "Another window" saves
 * through the real Subagent route with the body a second Settings window would send.
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

const USER = 'ss914p_user'
const AGENT = 'ss914p_agent'
const SUB = 'ss914p_sub'
const SUB_NAME = 'Ss914p Panel Sub'
// A second Subagent, for a save that lands after another Subagent was picked.
const SUB2 = 'ss914p_sub2'
const SUB2_NAME = 'Ss914p Second Sub'

/** A Codex block as the panel's own defaults leave it: nothing for a save to fill in. */
const CODEX_BASE = {
  permissionMode: 'chat',
  includeProjectInstructions: true,
  model: 'gpt-6-astra',
  streamingEffect: true,
  unifiedExec: true,
  search: true,
  sandbox: 'read-only',
  approval: 'never',
  configScope: 'managed',
  addDirs: [] as string[],
  enableFeatures: [] as string[],
  disableFeatures: [] as string[],
  configOverrides: [] as unknown[],
  workingDirectoryMode: 'project',
  historyPersistence: 'none'
}

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

type Provider = 'codex' | 'claude'

const CLI_SUBAGENT = {
  codex: {
    block: 'codex_settings',
    fields: {
      primary_model_provider: 'codex',
      primary_model_name: 'gpt-6-astra',
      primary_model_connection: { type: 'cli', service: 'codex' }
    }
  },
  claude: {
    block: 'claude_settings',
    fields: {
      primary_model_provider: 'claude-cli',
      primary_model_name: 'claude-cli',
      primary_model_connection: { type: 'cli', service: 'claude-cli' }
    }
  }
} as const

const PRESET_ASTRA = {
  id: 'ss914p_preset_astra',
  provider: 'codex',
  modelId: 'gpt-6-astra',
  modelName: 'Probe Codex Astra',
  purpose: 'chat',
  connection: { type: 'cli', service: 'codex' },
  settings: { codex_model: 'gpt-6-astra' }
}
const PRESET_LUNA = {
  id: 'ss914p_preset_luna',
  provider: 'codex',
  modelId: 'gpt-6-luna',
  modelName: 'Probe Codex Luna',
  purpose: 'chat',
  connection: { type: 'cli', service: 'codex' },
  settings: { codex_model: 'gpt-6-luna' }
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
const originalFetch = global.fetch

beforeAll(async () => {
  agentRoute = await import('../../../../routes/api/agents/[id]/+server')
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

beforeEach(() => {
  ensureBrowserStubs()
  subagentPuts = []
  secondSubagentPuts = []
  writeLog = []
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
    if (path === '/api/goons') return jsonResponse({ goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
    if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
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

function cliSubagentRecord(provider: Provider, block: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  const { block: field, fields } = CLI_SUBAGENT[provider]
  return subagentRecord({ subagentType: 'cli', ...fields, ...(block ? { [field]: block } : {}), ...extra })
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
async function openSubagent(record: Record<string, unknown>, options: { toolsTab?: boolean } = {}) {
  installRoutes()
  await redis.json.set(`subagent:${SUB}`, '$', record as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
  await redis.createAgent({ id: AGENT, user_id: USER, displayName: 'Block probe', agentType: 'api' } as any)
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

/** The Subagent's `permissions mode` toggle of a section (an item by its visible label). */
async function pickPermissionMode(provider: Provider, label: RegExp) {
  const group = screen.getByRole('group', {
    name: provider === 'codex' ? 'Subagent Codex permissions mode' : 'Subagent Claude permissions mode'
  })
  await fireEvent.click(within(group).getByRole('radio', { name: label }))
}

/**
 * Picks an option of the select whose visible value contains `current`. The popper stays
 * `visibility: hidden` in jsdom (no layout), so its options have no accessible name: they are
 * found hidden and picked by their text.
 */
async function pickSelectOption(current: string, optionText: RegExp) {
  const trigger = screen
    .getAllByRole('button', { hidden: true })
    .find((element) => element.hasAttribute('data-select-trigger') && (element.textContent ?? '').includes(current))
  expect(trigger, `the select showing "${current}"`).toBeTruthy()
  await fireEvent.keyDown(trigger as HTMLElement, { key: 'ArrowDown' })
  await waitFor(() => expect(screen.queryAllByRole('option', { hidden: true }).length).toBeGreaterThan(0))
  const option = screen
    .getAllByRole('option', { hidden: true })
    .find((element) => optionText.test((element.textContent ?? '').trim()))
  expect(option, `an option matching ${optionText}`).toBeTruthy()
  await fireEvent.pointerUp(option as HTMLElement, { pointerType: 'mouse' })
}

/** The switch in the row that carries `label` (the nearest ancestor of the text that holds a switch). */
function switchOf(label: string) {
  for (let element = screen.getByText(label) as HTMLElement | null; element; element = element.parentElement) {
    const found = element.querySelector('[role="switch"]')
    if (found) return found as HTMLElement
  }
  throw new Error(`no switch beside "${label}"`)
}

function isInFlightLocked(element: HTMLElement | null) {
  return Boolean(element && (element.matches(':disabled') || element.closest('fieldset:disabled, [inert]')))
}

function sandboxSelectTrigger() {
  const label = screen.getByText('Sandbox Level')
  const trigger = label.closest('.batshit-settings-form-row')?.querySelector('[data-select-trigger]')
  expect(trigger, 'the Subagent Sandbox Level select').toBeTruthy()
  return trigger as HTMLElement
}

function isDisabledControl(element: HTMLElement) {
  return Boolean(
    element.matches(':disabled, [aria-disabled="true"], [data-disabled]') ||
      element.closest('fieldset:disabled, [inert]')
  )
}

function expectCodexFullModeSelected() {
  const group = screen.getByRole('group', { name: 'Subagent Codex permissions mode' })
  const fullMode = within(group).getByRole('radio', { name: /Agent \(full access\)|Batshit Crazy/ })
  expect(fullMode).toHaveAttribute('aria-checked', 'true')
}

/** The three keys of a Codex permission choice, as the record holds them. */
async function storedCodexTrio() {
  const { permissionMode, sandbox, approval } = (await storedSubagent()).codex_settings
  return { permissionMode, sandbox, approval }
}

describe('a CLI Subagent\'s Codex section sends only the keys that changed (BL-914)', () => {
  it('a reasoning pick sends only the reasoning; a model another window chose since survives', async () => {
    await openSubagent(cliSubagentRecord('codex', CODEX_BASE))
    // Another window picked another model after this panel loaded.
    await anotherWindowSaves({ codex_settings: { model: 'gpt-6-sol' } })

    await pickSelectOption('Auto', /^High/)

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    const stored = (await storedSubagent()).codex_settings
    expect(stored.reasoningEffort).toBe('high')
    expect(stored.model).toBe('gpt-6-sol')
  }, 120_000)

  it('a key the form dropped goes as null and is gone from the record: reasoning back to Auto', async () => {
    await openSubagent(cliSubagentRecord('codex', { ...CODEX_BASE, reasoningEffort: 'high' }))

    await pickSelectOption('High', /^Auto/)

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({ codex_settings: { reasoningEffort: null } })
    const stored = (await storedSubagent()).codex_settings
    expect('reasoningEffort' in stored).toBe(false)
    expect(stored.model).toBe('gpt-6-astra')
  }, 120_000)

  it('a mode pick from an older copy sends the whole permission group: no looser sandbox than the screen shows (BL-919)', async () => {
    // Chat mode with the Workspace write sandbox chosen by hand.
    await openSubagent(cliSubagentRecord('codex', { ...CODEX_BASE, sandbox: 'workspace-write' }))
    await anotherWindowSaves({ codex_settings: { permissionMode: 'agent_full', sandbox: 'danger-full-access' } })
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })

    await pickPermissionMode('codex', /^Agent$/)

    await waitForPuts(1)
    // Settings shows Agent with Workspace write.
    expect(subagentPuts[0].body).toEqual({
      codex_settings: { permissionMode: 'agent', sandbox: 'workspace-write', approval: 'never' }
    })
    expect(await storedCodexTrio()).toEqual({ permissionMode: 'agent', sandbox: 'workspace-write', approval: 'never' })
  }, 120_000)

  it('a mode pick sends the Subagent\'s approval too (always never: a Subagent has no approval tie), so an approval another writer left is not kept', async () => {
    await openSubagent(cliSubagentRecord('codex', CODEX_BASE))
    // A writer other than this panel left the record in Agent mode with an approval prompt.
    await anotherWindowSaves({
      codex_settings: { permissionMode: 'agent', sandbox: 'workspace-write', approval: 'on-request' }
    })

    await pickPermissionMode('codex', /^Agent \(full access\)/)

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({
      codex_settings: { permissionMode: 'agent_full', sandbox: 'danger-full-access', approval: 'never' }
    })
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
  }, 120_000)

  it('a change outside the group still goes alone: a reasoning pick leaves another window\'s mode as it is', async () => {
    await openSubagent(cliSubagentRecord('codex', CODEX_BASE))
    await anotherWindowSaves({ codex_settings: { permissionMode: 'agent_full', sandbox: 'danger-full-access' } })

    await pickSelectOption('Auto', /^High/)

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
  }, 120_000)

  it('each later edit sends only its own key: the baseline moves to what the last save sent', async () => {
    await openSubagent(cliSubagentRecord('codex', CODEX_BASE))

    await pickSelectOption('Auto', /^High/)
    await waitForPuts(1)
    await fireEvent.click(switchOf('Allow Codex Web Search'))
    await waitForPuts(2)

    expect(subagentPuts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    expect(subagentPuts[1].body).toEqual({ codex_settings: { search: false } })
    expect(await storedSubagent()).toMatchObject({ codex_settings: { reasoningEffort: 'high', search: false } })
  }, 120_000)

  it('a failed save leaves the baseline as it was: the next edit sends the failed change again, with its own', async () => {
    await openSubagent(cliSubagentRecord('codex', CODEX_BASE))

    failNextSubagentPut = true
    await pickSelectOption('Auto', /^High/)
    await waitForPuts(1)
    expect((await storedSubagent()).codex_settings.reasoningEffort).toBeUndefined()

    await fireEvent.click(switchOf('Allow Codex Web Search'))
    await waitForPuts(2)
    expect(subagentPuts[1].body).toEqual({ codex_settings: { reasoningEffort: 'high', search: false } })
  }, 120_000)

  it('a Subagent with no Codex block yet gets the whole block on its first edit', async () => {
    await openSubagent(cliSubagentRecord('codex', null, { provider_specific_settings: { codex_model: 'gpt-6-luna' } }))

    await pickSelectOption('Auto', /^High/)

    await waitForPuts(1)
    expect(subagentPuts[0].body.codex_settings).toMatchObject({
      model: 'gpt-6-luna',
      reasoningEffort: 'high',
      permissionMode: 'chat',
      configScope: 'managed'
    })
    expect(Object.keys(subagentPuts[0].body.codex_settings).length).toBeGreaterThan(10)
  }, 120_000)
})

describe('a CLI Subagent\'s Claude section sends only the keys that changed (BL-914)', () => {
  it('the thinking budget edited in an older copy sends the switch and the budget together (BL-919)', async () => {
    await openSubagent(cliSubagentRecord('claude', { ...CLAUDE_BASE, alwaysThinkingEnabled: true, maxThinkingTokens: 4000 }))
    // Another window turned thinking Off: the switch and a removed budget.
    await anotherWindowSaves({ claude_settings: { alwaysThinkingEnabled: false, maxThinkingTokens: null } })
    const before = (await storedSubagent()).claude_settings
    expect(before.alwaysThinkingEnabled).toBe(false)
    expect('maxThinkingTokens' in before).toBe(false)

    await fireEvent.input(screen.getByPlaceholderText('1024'), { target: { value: '5000' } })

    await waitForPuts(1)
    // Settings shows thinking On with a budget of 5000: the record must not hold Off with a budget.
    expect(subagentPuts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: true, maxThinkingTokens: 5000 } })
    const stored = (await storedSubagent()).claude_settings
    expect({ alwaysThinkingEnabled: stored.alwaysThinkingEnabled, maxThinkingTokens: stored.maxThinkingTokens }).toEqual({
      alwaysThinkingEnabled: true,
      maxThinkingTokens: 5000
    })
  }, 120_000)

  it('a change outside the thinking pair still goes alone: a mode pick leaves another window\'s thinking Off', async () => {
    await openSubagent(cliSubagentRecord('claude', { ...CLAUDE_BASE, alwaysThinkingEnabled: true, maxThinkingTokens: 4000 }))
    await anotherWindowSaves({ claude_settings: { alwaysThinkingEnabled: false, maxThinkingTokens: null } })

    await pickPermissionMode('claude', /Plan/i)

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({ claude_settings: { permissionMode: 'plan' } })
    const stored = (await storedSubagent()).claude_settings
    expect(stored.alwaysThinkingEnabled).toBe(false)
    expect('maxThinkingTokens' in stored).toBe(false)
  }, 120_000)

  it('turning thinking off removes the budget (a dropped key goes as null)', async () => {
    await openSubagent(cliSubagentRecord('claude', { ...CLAUDE_BASE, alwaysThinkingEnabled: true, maxThinkingTokens: 4000 }))

    await fireEvent.click(switchOf('Always Enable Extended Thinking'))

    await waitForPuts(1)
    expect(subagentPuts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: false, maxThinkingTokens: null } })
    const stored = (await storedSubagent()).claude_settings
    expect(stored.alwaysThinkingEnabled).toBe(false)
    expect('maxThinkingTokens' in stored).toBe(false)
    expect(stored.model).toBe('sonnet')
  }, 120_000)

  it('a Subagent with no Claude block yet gets the whole block on its first edit', async () => {
    await openSubagent(cliSubagentRecord('claude', null, { provider_specific_settings: { claude_model: 'opus' } }))

    await pickPermissionMode('claude', /Plan/i)

    await waitForPuts(1)
    expect(subagentPuts[0].body.claude_settings).toMatchObject({
      model: 'opus',
      permissionMode: 'plan',
      includeProjectInstructions: true,
      configScope: 'managed'
    })
  }, 120_000)
})

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

  it('a model pick on a CLI Subagent sends the model choice and its own seeded key only; another window\'s native-tool settings survive', async () => {
    savedModels = [PRESET_ASTRA, PRESET_LUNA]
    await openSubagent(
      cliSubagentRecord('codex', CODEX_BASE, {
        primary_model_preset_id: PRESET_ASTRA.id,
        provider_specific_settings: { codex_model: 'gpt-6-astra', nativeTools: { bashNeverAllowList: ['rm -rf *'] } }
      })
    )
    await anotherWindowSaves({ provider_specific_settings: { nativeTools: { bashNeverAllowList: ['sudo *'] } } })

    await pickSelectOption('Probe Codex Astra', /Probe Codex Luna/)

    await waitFor(() => expect(subagentPuts.length).toBeGreaterThanOrEqual(2), { timeout: 8_000 })
    await pause(1500)
    const core = subagentPuts.find((put) => 'primary_model_preset_id' in put.body)
    expect(core?.body).toMatchObject({
      primary_model_preset_id: PRESET_LUNA.id,
      primary_model_provider: 'codex',
      provider_specific_settings: { codex_model: 'gpt-6-luna' }
    })
    // Nothing of the block but the seeded key: the native-tool list the other window saved is not named.
    expect(Object.keys(core!.body.provider_specific_settings)).toEqual(['codex_model'])
    const codex = subagentPuts.find((put) => 'codex_settings' in put.body)
    expect(codex?.body).toEqual({ codex_settings: { model: 'gpt-6-luna' } })
    const record = await storedSubagent()
    expect(record.provider_specific_settings).toEqual({
      codex_model: 'gpt-6-luna',
      nativeTools: { bashNeverAllowList: ['sudo *'] }
    })
    expect(record.codex_settings.model).toBe('gpt-6-luna')
    expect(record.primary_model_preset_id).toBe(PRESET_LUNA.id)
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
  it('a Codex save: the second Subagent\'s copy of the block is not replaced by the first one\'s', async () => {
    await seedSecondSubagent(cliSubagentRecord('codex', { ...CODEX_BASE, reasoningEffort: 'low' }, { id: SUB2, slug: SUB2, displayName: SUB2_NAME }))
    await openSubagent(cliSubagentRecord('codex', CODEX_BASE))
    let release: () => void = () => {}
    holdNextSubagentBody = new Promise<void>((resolve) => {
      release = resolve
    })

    await pickSelectOption('Auto', /^High/)
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    // The second Subagent is picked while the first one's save is still on its way.
    await pickSecondSubagent()
    await pause(300)
    release()
    await waitFor(async () => expect((await storedSubagent()).codex_settings.reasoningEffort).toBe('high'), { timeout: 8_000 })
    await pause(2500)

    // The first save landed; nothing was sent for the second Subagent because of it.
    expect(secondSubagentPuts).toEqual([])
    const second = (await redis.json.get(`subagent:${SUB2}`)) as Record<string, any>
    expect(second.codex_settings.reasoningEffort).toBe('low')
    // And the second Subagent's own edit is worked out against its own copy: only its change goes.
    await pickSelectOption('Low', /^High/)
    await waitFor(() => expect(secondSubagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(secondSubagentPuts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
  }, 120_000)

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
  it('a Codex control is blocked during its save, then a deliberate next edit sends its own key', async () => {
    await openSubagent(cliSubagentRecord('codex', CODEX_BASE))
    let release: () => void = () => {}
    holdNextSubagentBody = new Promise<void>((resolve) => {
      release = resolve
    })

    await pickSelectOption('Auto', /^High/)
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    const searchSwitch = switchOf('Allow Codex Web Search')
    await waitFor(() => expect(isInFlightLocked(searchSwitch)).toBe(true), { timeout: 8_000 })
    // Native activation honors the disabled fieldset, unlike a manually dispatched event.
    searchSwitch.click()
    await pause(50)
    expect(searchSwitch.getAttribute('aria-checked')).toBe('true')
    expect(subagentPuts).toHaveLength(1)

    release()
    await waitFor(async () => expect((await storedSubagent()).codex_settings.reasoningEffort).toBe('high'), { timeout: 8_000 })
    await waitFor(() => expect(isInFlightLocked(searchSwitch)).toBe(false), { timeout: 8_000 })

    await fireEvent.click(searchSwitch)
    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(subagentPuts[1].body).toEqual({ codex_settings: { search: false } })
    await pause(600)
    expect(await storedSubagent()).toMatchObject({ codex_settings: { reasoningEffort: 'high', search: false } })
    await pause(1500)
    expect(subagentPuts.length).toBe(2)
  }, 120_000)
})

describe('opening a Subagent saves nothing (BL-914: the new baselines are set, never sent)', () => {
  it('a CLI Codex Subagent with a block, a Tool Grid and older keys', async () => {
    await openSubagent(
      cliSubagentRecord('codex', { ...CODEX_BASE, reasoningEffort: 'high', addDirs: ['/tmp/a'] }, {
        defaultMCPGateways: ['gw_a'],
        defaultMCPToolSelections: ['tool_one'],
        defaultTools: ['cli_x'],
        dcmDisplaySettings: { ...DCM_EMPTY, groups: { 'gw_a::Files': 'hidden' }, groupDisplayPreferences: { 'gw_a::Files': 'use-global' } },
        provider_specific_settings: { codex_model: 'gpt-6-astra', nativeTools: { bashNeverAllowList: ['rm -rf *'] } }
      })
    )
    await pause(1500)
    expect(subagentPuts).toEqual([])
    expect(writeLog).toEqual([])
  }, 120_000)

  it('a CLI Codex Subagent with no block yet (only the older provider keys)', async () => {
    await openSubagent(cliSubagentRecord('codex', null, { provider_specific_settings: { codex_model: 'gpt-6-luna' } }))
    await pause(1500)
    expect(subagentPuts).toEqual([])
    expect(writeLog).toEqual([])
  }, 120_000)

  it('a CLI Claude Subagent with a block', async () => {
    await openSubagent(
      cliSubagentRecord('claude', { ...CLAUDE_BASE, alwaysThinkingEnabled: true, maxThinkingTokens: 4000 })
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

describe('BL-941 Part S: a CLI Subagent shows its saved Codex and Claude access without widening it', () => {
  for (const permissionMode of Object.keys(CODEX_PERMISSION_PRESETS) as Array<keyof typeof CODEX_PERMISSION_PRESETS>) {
    it(`Codex ${permissionMode} with no saved sandbox shows the shared preset and does not fill the record`, async () => {
      await openSubagent(cliSubagentRecord('codex', { permissionMode, model: CODEX_BASE.model }))

      expect(sandboxSelectTrigger().textContent?.trim()).toBe(
        CODEX_SANDBOX_LABELS[CODEX_PERMISSION_PRESETS[permissionMode].sandbox]
      )
      const stored = (await storedSubagent()).codex_settings
      expect(stored.permissionMode).toBe(permissionMode)
      expect(stored).not.toHaveProperty('sandbox')
      expect(buildCodexRuntimeSettings(stored).sandbox).toBe(CODEX_PERMISSION_PRESETS[permissionMode].sandbox)
      expect(subagentPuts).toEqual([])

      if (permissionMode === 'agent_full') {
        expectCodexFullModeSelected()
        expect(isDisabledControl(sandboxSelectTrigger())).toBe(true)
        expect(screen.getByText(/limit the sandbox.*pick Agent/i)).toBeTruthy()
      }
    }, 120_000)
  }

  for (const sandbox of ['read-only', 'workspace-write'] as const) {
    it(`Codex Agent (full) retains its older ${sandbox} sandbox, disables the control, and preserves it on another edit`, async () => {
      await openSubagent(cliSubagentRecord('codex', { permissionMode: 'agent_full', model: CODEX_BASE.model, sandbox }))

      expect(sandboxSelectTrigger().textContent?.trim()).toBe(CODEX_SANDBOX_LABELS[sandbox])
      expectCodexFullModeSelected()
      expect(isDisabledControl(sandboxSelectTrigger())).toBe(true)
      expect(screen.getByTestId('subagent-codex-full-sandbox-note')).toHaveTextContent(
        `This Subagent keeps its saved ${CODEX_SANDBOX_LABELS[sandbox]} Sandbox Level.`
      )
      expect(screen.getByText(/limit the sandbox.*pick Agent/i)).toBeTruthy()
      const stored = (await storedSubagent()).codex_settings
      expect(stored).toMatchObject({ permissionMode: 'agent_full', model: CODEX_BASE.model, sandbox })
      const runtime = buildCodexRuntimeSettings(stored)
      expect(runtime.permissionMode).toBe('agent')
      expect(runtime.sandbox).toBe(sandbox)
      expect(subagentPuts).toEqual([])

      await pickSelectOption('Auto', /^High/)
      await waitForPuts(1)

      expect(subagentPuts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
      expect((await storedSubagent()).codex_settings).toMatchObject({
        permissionMode: 'agent_full',
        sandbox,
        reasoningEffort: 'high'
      })
    }, 120_000)
  }

  it('an older full-mode legacy Codex sandbox stays visible and does not downgrade the mode or write on open', async () => {
    await openSubagent(
      cliSubagentRecord('codex', null, {
        provider_specific_settings: {
          codex_permission_mode: 'agent_full',
          codex_model: 'gpt-6-astra',
          codex_sandbox: 'workspace-write'
        }
      })
    )

    expect(sandboxSelectTrigger().textContent?.trim()).toBe(CODEX_SANDBOX_LABELS['workspace-write'])
    expectCodexFullModeSelected()
    expect(isDisabledControl(sandboxSelectTrigger())).toBe(true)
    expect(screen.getByText(/limit the sandbox.*pick Agent/i)).toBeTruthy()
    const stored = await storedSubagent()
    expect(stored).not.toHaveProperty('codex_settings')
    expect(stored.provider_specific_settings).toMatchObject({
      codex_permission_mode: 'agent_full',
      codex_model: 'gpt-6-astra',
      codex_sandbox: 'workspace-write'
    })
    const runtime = buildCodexRuntimeSettings(stored.provider_specific_settings)
    expect(runtime.permissionMode).toBe('agent')
    expect(runtime.sandbox).toBe('workspace-write')
    expect(subagentPuts).toEqual([])
  }, 120_000)

  for (const permissionMode of ['default', 'chat'] as const) {
    it(`Claude saved ${permissionMode} displays Ask before edits without rewriting the record`, async () => {
      await openSubagent(cliSubagentRecord('claude', { ...CLAUDE_BASE, permissionMode }))

      const group = screen.getByRole('group', { name: 'Subagent Claude permissions mode' })
      expect(within(group).getByRole('radio', { name: 'Ask before edits' })).toHaveAttribute('aria-checked', 'true')
      expect((await storedSubagent()).claude_settings.permissionMode).toBe(permissionMode)
      expect(subagentPuts).toEqual([])
    }, 120_000)
  }

  it('an explicit Claude Plan to Ask before edits choice saves the canonical default value', async () => {
    await openSubagent(cliSubagentRecord('claude', { ...CLAUDE_BASE, permissionMode: 'plan' }))

    await pickPermissionMode('claude', /^Ask before edits$/)
    await waitForPuts(1)

    expect(subagentPuts[0].body).toMatchObject({ claude_settings: { permissionMode: 'default' } })
    expect((await storedSubagent()).claude_settings.permissionMode).toBe('default')
  }, 120_000)

  it.each([
    { name: 'null', sandbox: null, expected: CODEX_PERMISSION_PRESETS.agent.sandbox },
    { name: 'invalid', sandbox: 'future-sandbox-value', expected: 'read-only' as const }
  ])('Codex agent with a $name saved sandbox displays the safe resolved value without rewriting it', async ({ sandbox, expected }) => {
    await openSubagent(cliSubagentRecord('codex', {
      permissionMode: 'agent',
      model: CODEX_BASE.model,
      sandbox
    }))

    expect(sandboxSelectTrigger().textContent?.trim()).toBe(CODEX_SANDBOX_LABELS[expected])
    const stored = (await storedSubagent()).codex_settings
    expect(stored.sandbox).toBe(sandbox)
    const runtime = buildCodexRuntimeSettings(stored)
    expect(runtime.permissionMode).toBe('agent')
    expect(runtime.sandbox).toBe(expected)
    expect(subagentPuts).toEqual([])
  }, 120_000)

  it('a valid structured Codex block takes precedence over a conflicting legacy settings bag', async () => {
    await openSubagent(cliSubagentRecord('codex', {
      permissionMode: 'agent',
      model: CODEX_BASE.model
    }, {
      provider_specific_settings: {
        codex_permission_mode: 'agent_full',
        codex_model: 'gpt-6-luna',
        codex_sandbox: 'danger-full-access'
      }
    }))

    expect(sandboxSelectTrigger().textContent?.trim()).toBe(CODEX_SANDBOX_LABELS[CODEX_PERMISSION_PRESETS.agent.sandbox])
    const stored = await storedSubagent()
    expect(stored.codex_settings).toMatchObject({ permissionMode: 'agent', model: CODEX_BASE.model })
    expect(stored.codex_settings).not.toHaveProperty('sandbox')
    expect(stored.provider_specific_settings).toMatchObject({
      codex_permission_mode: 'agent_full',
      codex_sandbox: 'danger-full-access'
    })
    const runtime = buildCodexRuntimeSettings(stored.codex_settings)
    expect(runtime.permissionMode).toBe('agent')
    expect(runtime.sandbox).toBe(CODEX_PERMISSION_PRESETS.agent.sandbox)
    expect(subagentPuts).toEqual([])
  }, 120_000)
})
