import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { jsonResponse, loadAgentRoute, storedAgent, type AgentPut } from '$lib/test-utils/agentPutRoute'
import { INSTRUCTIONS_REVISION_HEADER } from '$lib/appActions/settings/instructionsBaseline'

/**
 * BL-912, BL-942: a Primary Agent save and a newer read of the same agent. `hydrateAgent` reads the
 * agent and puts the record into the sections; its triggers are a switch away and back, the
 * `initialAgentId` effect (the shown agent read again without a reset: this suite's stand-in for
 * Refresh, whose `refreshCurrentAgent` has no caller) and the read a landing asks for. A read can
 * answer with a record older than a save that waits, travels, or lands during the read; a landing
 * that moved the baseline under a form holding that older record made the section's effect send the
 * older value back (BL-912), and a read that put the record over typed text lost the text (BL-942).
 *
 * The rules (Faye's simple design, BRIEF-2): each read raises `agentHydrationRequestId` and each save
 * carries the value from when its payload was built (S1); a landing with the same value does what it
 * always did (S2); a landing with another value moves nothing of the form, the baseline, or the
 * signature and asks for a read when the panel is at rest (S3); a read of the agent the forms already
 * hold replaces a section only while it is at rest: its form equals its baseline and no save of it is
 * queued or on its way, including the prompt, CLI tools and multiline editor saves (S4, S5); the
 * asked read runs when the panel comes to rest (S6); a second PUT of an equal change is harmless and
 * is counted, not stopped (S7).
 *
 * Renders the REAL panel. `/api/agents/<id>` goes to the REAL route handler on the default lane's
 * Redis fake. `holdNextPut()` holds a PUT's ANSWER after the route wrote (the real route writes,
 * runs two profile syncs, then answers); with `{ beforeWrite: true }` the PUT also waits before the
 * route runs (the request is still on the wire), so a read in that window sees the older record.
 * `holdNextGet()` holds the answer of the agent's next GET after it read the record; `failNextGets`
 * makes the next GETs answer 500. `seedSubagent()` gives the agent a Subagent to assign: the
 * assignment routes are then the REAL ones.
 * SA-139 R4: the CLI Primary's Claude section left with its lane; its cases went with it, and the
 * surviving rules (Tool Approval, the 30-second save wait, a failed deferred read) run on API
 * sections.
 */

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
vi.mock('$lib/components/settings/agent/AgentMcpDefaultsCard.svelte', async () => ({
  default: (await import('../../mcps/__tests__/AgentMcpDefaultsCardStub.test.svelte')).default
}))

useRedisTestServer()

const USER = 'ss912_user'
const AGENT = 'ss912_agent'
const NAME = 'Read probe'
const OTHER = 'ss912_other'
const OTHER_NAME = 'Other read probe'
const SUBA = 'ss912_suba'
const SUBA_NAME = 'Ss912 Assignable Sub'

const PRESET = {
  id: 'ss912_preset',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
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

let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
/** Every PUT the panel sent to the agent, in order. */
let puts: AgentPut[] = []
/** Every PUT the panel sent to the OTHER agent. */
let otherPuts: AgentPut[] = []
/** Each agent PUT takes the next of these, in order. */
let gates: Gate[] = []
/** While above zero, the next agent PUTs answer 500 without writing. */
let failNextPuts = 0
/** What happened to the agent, in order. */
let events: string[] = []
let rendered: ReturnType<typeof render> | null = null
/** While set, the next answer to the agent's GET waits for it AFTER the record was read. */
let holdNextGetAnswer: Promise<void> | null = null
/** While above zero, the next answers to the agent's GET are 500 (a read that fails). */
let failNextGets = 0
/** Set by `seedSubagent()`: the Subagent list and the agent's assignment routes are real. */
let subagentSeeded = false
/** Every body the panel posted to the agent's assignment route. */
let assignmentPosts: Array<{ body: Record<string, any> }> = []
let assignmentRoute: typeof import('../../../../routes/api/agents/[id]/subagents/+server')
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
  assignmentRoute = await import('../../../../routes/api/agents/[id]/subagents/+server')
}, 60_000)

beforeEach(() => {
  ensureBrowserStubs()
  puts = []
  otherPuts = []
  gates = []
  failNextPuts = 0
  events = []
  holdNextGetAnswer = null
  failNextGets = 0
  subagentSeeded = false
  assignmentPosts = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  global.fetch = originalFetch
  agentStore.setAgents([])
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const card = () => (globalThis as any).__mcpCardProps as Record<string, any>

async function drainCallbacksUntil(predicate: () => boolean | Promise<boolean>, description: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    await tick()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(1)
    if (await predicate()) return
  }
  throw new Error(`Timed out waiting for ${description}`)
}

/**
 * Holds the next agent PUT that is not held yet: its ANSWER waits after the route wrote, until
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

/** Holds the answer of the agent's next GET (after it read the record) until `answer()`. */
function holdNextGet() {
  let answer: () => void = () => {}
  holdNextGetAnswer = new Promise<void>((resolve) => {
    answer = resolve
  })
  return () => answer()
}

async function routeAgent(id: string, method: string, body: string | undefined) {
  const request = new Request(`http://localhost/api/agents/${id}`, { method, body: method === 'PUT' ? body : undefined })
  const handler = method === 'PUT' ? routeModule.PUT : routeModule.GET
  return (await handler({ params: { id }, request, locals: { user: { id: USER } } } as any)) as Response
}

function installRoutes() {
  // Each case restores spies. Reinstall the existing atomic GET snapshot twin for
  // this HTTP fixture, as installAgentRoutes does, before any detail route runs.
  const routeReady = loadAgentRoute()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    await routeReady
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]

    if (path === `/api/agents/${AGENT}` && method === 'PUT') {
      puts.push({ body: JSON.parse(String(init.body)) })
      if (failNextPuts > 0) {
        failNextPuts -= 1
        return jsonResponse({ error: 'Probe refusal' }, 500)
      }
      const gate = gates.shift() ?? null
      if (gate?.write) {
        events.push('put-recorded')
        await gate.write
      }
      const response = await routeAgent(AGENT, 'PUT', String(init.body))
      events.push('put-written')
      if (gate) await gate.answer
      events.push('put-answered')
      return response
    }
    if (path === `/api/agents/${AGENT}` && method === 'GET') {
      if (failNextGets > 0) {
        failNextGets -= 1
        events.push('get-failed')
        const gate = holdNextGetAnswer
        holdNextGetAnswer = null
        if (gate) {
          events.push('get-failure-held')
          await gate
        }
        events.push('get-failed-answered')
        return jsonResponse({ error: 'Probe read refusal' }, 500)
      }
      const response = await routeAgent(AGENT, 'GET', undefined)
      const gate = holdNextGetAnswer
      holdNextGetAnswer = null
      if (gate) {
        events.push('get-read')
        await gate
      }
      events.push('get-answered')
      return response
    }
    if (path === `/api/agents/${OTHER}`) {
      if (method === 'PUT') otherPuts.push({ body: JSON.parse(String(init.body)) })
      return routeAgent(OTHER, method, method === 'PUT' ? String(init.body) : undefined)
    }
    if (path === '/api/agents' && method === 'GET') {
      return jsonResponse({ agents: [await storedAgent(AGENT), await storedAgent(OTHER)] })
    }
    if (subagentSeeded && path === `/api/agents/${AGENT}/subagents`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'POST' ? String(init.body) : undefined })
      if (method !== 'POST') return (await assignmentRoute.GET({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
      assignmentPosts.push({ body: JSON.parse(String(init.body)) })
      const gate = gates.shift() ?? null
      if (gate?.write) await gate.write
      const response = (await assignmentRoute.POST({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
      events.push('assignment-written')
      if (gate) await gate.answer
      return response
    }
    if (path === `/api/agents/${AGENT}/subagents` || path === `/api/agents/${OTHER}/subagents`) {
      return jsonResponse({ subagents: [] })
    }
    if (path === '/api/subagents' && method === 'GET') {
      return jsonResponse({ subagents: subagentSeeded ? [await redis.json.get(`subagent:${SUBA}`)] : [] })
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: [PRESET] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
    if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
    if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

/** Creates the agent and the OTHER agent (to switch away and back), renders the panel on the agent. */
async function openPanel(extra: Record<string, unknown> = {}, otherExtra: Record<string, unknown> = {}) {
  await redis.createAgent({
    id: OTHER,
    user_id: USER,
    displayName: OTHER_NAME,
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7 },
    ...otherExtra
  } as any)
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: NAME,
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7 },
    ...extra
  } as any)
  installRoutes()
  rendered = render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue(NAME, {}, { timeout: 15_000 })
  // Past every autosave debounce: opening writes nothing.
  await pause(1500)
  expect(puts).toEqual([])
  expect(otherPuts).toEqual([])
}

function nameInput() {
  return document.getElementById('agent-display') as HTMLInputElement
}

/** Gives the agent an API Subagent to assign (call before `openPanel`). */
async function seedSubagent() {
  await redis.json.set(`subagent:${SUBA}`, '$', {
    id: SUBA,
    user_id: USER,
    displayName: SUBA_NAME,
    slug: SUBA,
    subagentType: 'api',
    specialty: 'general',
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z'
  } as any)
  await redis.sAdd(`user:${USER}:subagents`, SUBA)
  subagentSeeded = true
}

async function openAccessTab() {
  const tab = screen.getAllByRole('tab').find((element) => /Access/.test(element.textContent ?? ''))
  expect(tab).toBeTruthy()
  await fireEvent.mouseDown(tab as HTMLElement)
  await fireEvent.click(tab as HTMLElement)
  await waitFor(() => expect(assignmentSwitch()).toBeTruthy(), { timeout: 10_000 })
}

/** The assignment switch of the Subagent `SUBA_NAME` in Access. */
function assignmentSwitch() {
  const label = [...document.querySelectorAll('.batshit-settings-parent-label')].find(
    (element) => (element.textContent ?? '').trim() === SUBA_NAME
  )
  return (label?.closest('.batshit-settings-toggle-row')?.querySelector('[role="switch"]') ?? null) as HTMLElement | null
}

async function storedAssignedIds() {
  return ((await storedAgent(AGENT)).assigned_subagent_ids ?? []) as string[]
}

async function switchTo(name: string) {
  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents', hidden: true })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(name, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
}

/** Switches away and back, and waits until the agent's own GET has answered into the form. */
async function switchAwayAndBack(expectedName = NAME) {
  await switchTo(OTHER_NAME)
  await waitFor(() => expect(nameInput().value).toBe(OTHER_NAME), { timeout: 15_000 })
  await switchTo(expectedName)
  await waitFor(() => expect(nameInput().value).toBe(expectedName), { timeout: 15_000 })
  await waitFor(() => expect(screen.queryByText('Loading agent details…')).toBeNull(), { timeout: 8_000 })
}

/** The shown agent is read again without a reset (the `initialAgentId` prop goes away and back). */
async function readShownAgentAgain(waitForAnswer = true) {
  const answeredBefore = events.filter((event) => event === 'get-answered').length
  await rendered!.rerender({ initialAgentId: null })
  await rendered!.rerender({ initialAgentId: AGENT })
  if (!waitForAnswer) return
  await waitFor(() => expect(events.filter((event) => event === 'get-answered').length).toBeGreaterThan(answeredBefore), {
    timeout: 8_000
  })
  await pause(300)
}

function selectShowing(text: string) {
  return screen
    .getAllByRole('button', { hidden: true })
    .find((element) => element.hasAttribute('data-select-trigger') && (element.textContent ?? '').trim() === text)
}

function isReadWaitLocked(element: HTMLElement | null) {
  return Boolean(element && (element.matches(':disabled') || element.closest('fieldset:disabled, [inert]')))
}

/** The switch in the row that carries `label` (the nearest ancestor of the text that holds a switch). */
function switchOf(label: string) {
  for (let element = screen.getByText(label) as HTMLElement | null; element; element = element.parentElement) {
    const found = element.querySelector('[role="switch"]')
    if (found) return found as HTMLElement
  }
  throw new Error(`no switch beside "${label}"`)
}

async function openToolsTab() {
  const tab = screen.getAllByRole('tab').find((element) => /Tools/.test(element.textContent ?? ''))
  expect(tab).toBeTruthy()
  await fireEvent.mouseDown(tab as HTMLElement)
  await fireEvent.click(tab as HTMLElement)
  await waitFor(() => expect(card()).toBeTruthy(), { timeout: 10_000 })
}

/** The editor sheet for the row that shows `preview`, opened, with its textarea and Save button. */
async function openEditorOfRow(preview: string, draft: string) {
  const row = screen
    .getAllByText(preview)
    .map((element) => element.closest('.batshit-settings-muted-panel') as HTMLElement | null)
    .find((element) => element)
  await fireEvent.click(within(row!).getByRole('button', { name: /Edit/ }))
  const editor = await screen.findByDisplayValue(draft)
  const dialog = editor.closest('[role="dialog"]') as HTMLElement
  const save = within(dialog)
    .getAllByRole('button')
    .find((button) => /^Save/.test((button.textContent ?? '').trim())) as HTMLElement
  return { editor, save }
}

/** The agent's Custom System Prompt editor, opened; its textarea and Save button. */
async function openPromptEditor(current: string) {
  const label = screen.getByText('Custom System Prompt', { selector: 'label' })
  const row = label.closest('.batshit-settings-form-row') as HTMLElement
  await fireEvent.click(within(row).getByRole('button', { name: /Edit/ }))
  const editor = await screen.findByDisplayValue(current)
  const dialog = editor.closest('[role="dialog"]') as HTMLElement
  const save = within(dialog)
    .getAllByRole('button')
    .find((button) => /^Save/.test((button.textContent ?? '').trim())) as HTMLElement
  return { editor, save }
}

describe('a Primary section save that lands after the agent was read again (BL-912)', () => {
  it('the Tool Grid, a switch away and back: no PUT takes the gateways back, and the card shows them after the deferred read', async () => {
    await openPanel({ defaultMCPGateways: ['gw_a'], defaultMCPToolSelections: [] })
    await openToolsTab()
    const put = holdNextPut({ beforeWrite: true })
    card().onGatewaysChange(['gw_a', 'gw_b'])
    await tick()
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({
      defaultMCPGateways: ['gw_a', 'gw_b'],
      expectedMcpSettings: {
        defaultMCPGateways: JSON.parse((await routeAgent(AGENT, 'GET', undefined)).headers.get('x-batshit-mcp-settings-revisions') ?? 'null').defaultMCPGateways
      }
    })

    await switchAwayAndBack()
    await openToolsTab()
    expect(card().defaultMCPGateways).toEqual(['gw_a'])

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_b']), {
      timeout: 8_000
    })
    put.answer()
    await pause(2500)

    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(card().defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
  }, 120_000)

  it('the zip section, a switch away and back: no PUT takes the choice back, and the card shows it after the deferred read', async () => {
    await openPanel()
    await openToolsTab()
    const put = holdNextPut({ beforeWrite: true })
    card().onZipAiViewModeChange('appended')
    await tick()
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ zip_ai_view_mode: 'appended' })

    await switchAwayAndBack()
    await openToolsTab()
    expect(card().zipAiViewMode).not.toBe('appended')

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).zip_ai_view_mode).toBe('appended'), { timeout: 8_000 })
    put.answer()
    await pause(2500)

    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).zip_ai_view_mode).toBe('appended')
    expect(card().zipAiViewMode).toBe('appended')
  }, 120_000)
})

describe('the saves the old at-rest check could not see, during a read (BL-912, S5)', () => {
  it('the CLI tools save: a read of the shown agent answers while it is on its way and leaves the list alone; the deferred read shows the saved list', async () => {
    await openPanel()
    await openToolsTab()
    const put = holdNextPut({ beforeWrite: true })
    card().onCliToolIdsChange(['cli_x'])
    await tick()
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ defaultTools: ['cli_x'] })

    // The record still holds the older list when the read reads it.
    await readShownAgentAgain()
    const keptDuringRead = [...card().defaultCliToolIds]

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).defaultTools).toEqual(['cli_x']), { timeout: 8_000 })
    put.answer()
    await pause(2500)

    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).defaultTools).toEqual(['cli_x'])
    expect(card().defaultCliToolIds).toEqual(['cli_x'])
    expect(keptDuringRead).toEqual(['cli_x'])
  }, 120_000)

  it('the prompt save: it lands while a read of the older record is on its way; that older answer does not put the older prompt back', async () => {
    await openPanel({ system_prompt: 'Answer in haiku.' })
    // BL-1670: this unrelated invalid draft prevents the all-sections-at-rest
    // fallback, so the held read's finally must drain the prompt's own readback.
    await fireEvent.input(nameInput(), { target: { value: '' } })
    const put = holdNextPut({ beforeWrite: true })
    const { editor, save } = await openPromptEditor('Answer in haiku.')
    await fireEvent.input(editor, { target: { value: 'Answer in limericks.' } })
    await fireEvent.click(save)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ system_prompt: 'Answer in limericks.', expectedInstructions: { customPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } })

    // The shown agent is read again; its GET reads the older prompt, and its answer is slow.
    const answer = holdNextGet()
    await readShownAgentAgain(false)
    await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).system_prompt).toBe('Answer in limericks.'), {
      timeout: 8_000
    })
    put.answer()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5_000 })
    await pause(500)
    answer()
    await pause(2500)

    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).system_prompt).toBe('Answer in limericks.')
    const reopened = await openPromptEditor('Answer in limericks.')
    expect(reopened.editor).toBeTruthy()
    expect(nameInput().value).toBe('')
    await fireEvent.input(reopened.editor, { target: { value: 'Answer in couplets.' } })
    await fireEvent.click(reopened.save)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ system_prompt: 'Answer in couplets.', expectedInstructions: { customPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } })
    expect(puts[1].body.expectedInstructions.customPrompt).not.toBe(puts[0].body.expectedInstructions.customPrompt)
    await waitFor(async () => expect((await storedAgent(AGENT)).system_prompt).toBe('Answer in couplets.'), { timeout: 8_000 })
    expect(nameInput().value).toBe('')
    expect((await storedAgent(AGENT)).displayName).toBe(NAME)
  }, 120_000)

  it('a multiline editor save: a read answers while it is on its way and a name is typed; after both land the saved list is on screen', async () => {
    await openPanel({ provider_specific_settings: { temperature: 0.7, nativeTools: { bashNeverAllowList: ['rm -rf *'] } } })
    const listPut = holdNextPut({ beforeWrite: true })
    const { editor, save } = await openEditorOfRow('rm -rf *', 'rm -rf *')
    await fireEvent.input(editor, { target: { value: 'rm -rf *\nterraform destroy' } })
    await fireEvent.click(save)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })

    await readShownAgentAgain()

    // A name is typed; its save is written and its answer waits.
    const namePut = holdNextPut()
    await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ displayName: `${NAME} R` })
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })

    // The editor's save writes and lands first, then the name's.
    listPut.write()
    await waitFor(
      async () =>
        expect((await storedAgent(AGENT)).provider_specific_settings.nativeTools.bashNeverAllowList).toEqual([
          'rm -rf *',
          'terraform destroy'
        ]),
      { timeout: 8_000 }
    )
    listPut.answer()
    await pause(400)
    namePut.answer()
    await pause(2500)

    expect(puts.length).toBe(2)
    const record = await storedAgent(AGENT)
    expect(record.displayName).toBe(`${NAME} R`)
    expect(record.provider_specific_settings.nativeTools.bashNeverAllowList).toEqual(['rm -rf *', 'terraform destroy'])
    expect(nameInput().value).toBe(`${NAME} R`)
    expect(screen.getAllByText('2 rules').length).toBeGreaterThan(0)
  }, 120_000)
})

describe('BL-979: edits stay blocked while a same-entity read is deferred', () => {
  it('a failed Primary GET preserves an API Display Reasoning draft without changing independent retention', async () => {
    await openPanel({ show_reasoning: true, preserve_reasoning: true })
    const original = await storedAgent(AGENT)
    expect(original).toMatchObject({ show_reasoning: true, preserve_reasoning: true })
    const answersBefore = events.filter((event) => event === 'get-answered').length

    failNextGets = 1
    await readShownAgentAgain(false)
    await waitFor(() => expect(events).toContain('get-failed'), { timeout: 8_000 })
    const notice = await screen.findByTestId('primary-settings-read-wait')
    expect(notice.textContent).toContain('Probe read refusal')

    // The setting remains locally editable after a failed physical GET. The new API retention
    // path is independent; an old Preserve flag is neither mapped nor overwritten.
    await fireEvent.click(switchOf('Display Reasoning'))
    await waitFor(() => expect(switchOf('Display Reasoning').getAttribute('aria-checked')).toBe('false'))
    expect(screen.queryByText('Preserve Reasoning In Chat History')).toBeNull()
    await pause(900)
    expect(puts).toEqual([])
    expect((await storedAgent(AGENT))).toMatchObject({ show_reasoning: true, preserve_reasoning: true })

    await fireEvent.click(within(notice).getByRole('button', { name: /Retry/ }))
    await waitFor(
      () => expect(events.filter((event) => event === 'get-answered').length).toBeGreaterThan(answersBefore),
      { timeout: 8_000 }
    )
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ show_reasoning: false })
    await waitFor(async () => expect((await storedAgent(AGENT)).show_reasoning).toBe(false), { timeout: 8_000 })
    expect((await storedAgent(AGENT))).toMatchObject({ show_reasoning: false, preserve_reasoning: true })
    expect(switchOf('Display Reasoning').getAttribute('aria-checked')).toBe('false')
    expect(puts).toHaveLength(1)
  }, 120_000)

  it('keeps per-agent retention in Core and preserves it through Tool Grid reset', async () => {
    await openPanel({ show_reasoning: true, api_reasoning_retention: 'whiteboard', whiteboard_budget_tokens: 1750, show_whiteboard: false, defaultTools: ['cli_x'] })
    expect(screen.getByRole('button', { name: 'Reasoning Retention' }).textContent).toContain('Whiteboard Only')
    expect(screen.getByRole('button', { name: 'Display Whiteboard' }).textContent).toContain('Disabled')
    expect((screen.getByRole('spinbutton', { name: 'Whiteboard Budget (estimated tokens)' }) as HTMLInputElement).value).toBe('1750')
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Reasoning Retention' }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Whiteboard + Preserved Reasoning' }), { pointerType: 'mouse' })
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ api_reasoning_retention: 'both' })
    await waitFor(async () => expect((await storedAgent(AGENT)).api_reasoning_retention).toBe('both'), { timeout: 8_000 })
    await openToolsTab()
    expect(card()).not.toHaveProperty('retentionControls')
    card().onResetToGlobalSettings()
    await waitFor(() => expect(puts.slice(1).some((put) => put.body.defaultTools === null)).toBe(true), { timeout: 8_000 })
    await pause(900)
    for (const put of puts.slice(1)) {
      expect(put.body).not.toHaveProperty('api_reasoning_retention')
      expect(put.body).not.toHaveProperty('whiteboard_budget_tokens')
      expect(put.body).not.toHaveProperty('show_whiteboard')
    }
    expect(await storedAgent(AGENT)).toMatchObject({ show_reasoning: true, api_reasoning_retention: 'both', whiteboard_budget_tokens: 1750, show_whiteboard: false })
  }, 120_000)

  it.each(['CLI tools', 'prompt editor', 'multiline editor'] as const)(
    '%s cannot start a new Primary save while the shown-agent GET answer is pending',
    async (writer) => {
      await openPanel({
        system_prompt: 'Answer in haiku.',
        provider_specific_settings: { temperature: 0.7, nativeTools: { bashNeverAllowList: ['rm -rf *'] } }
      })

      let attempt: () => Promise<void>
      let originalRecord: Record<string, any>
      let localDraft: HTMLTextAreaElement | HTMLInputElement | undefined
      if (writer === 'CLI tools') {
        await openToolsTab()
        attempt = async () => { card().onCliToolIdsChange(['cli_x']) }
        originalRecord = await storedAgent(AGENT)
      } else if (writer === 'prompt editor') {
        const { editor, save } = await openPromptEditor('Answer in haiku.')
        await fireEvent.input(editor, { target: { value: 'Answer in limericks.' } })
        localDraft = editor
        attempt = async () => { await fireEvent.click(save) }
        originalRecord = await storedAgent(AGENT)
      } else {
        const { editor, save } = await openEditorOfRow('rm -rf *', 'rm -rf *')
        await fireEvent.input(editor, { target: { value: 'rm -rf *\nterraform destroy' } })
        localDraft = editor
        attempt = async () => { await fireEvent.click(save) }
        originalRecord = await storedAgent(AGENT)
      }

      const answer = holdNextGet()
      await readShownAgentAgain(false)
      await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })
      const noticeVisible = Boolean(screen.queryByTestId('primary-settings-read-wait'))
      const localTypingAvailable = !isReadWaitLocked(nameInput())

      try { await attempt() } catch { /* a gated editor may report its read-wait refusal here */ }
      await pause(1200)
      const noNewPut = puts.length === 0
      answer()
      await waitFor(() => screen.queryByText('Loading agent details…') === null, { timeout: 8_000 })
      await pause(1000)

      expect(noNewPut).toBe(true)
      expect(puts).toEqual([])
      expect(noticeVisible).toBe(true)
      expect(localTypingAvailable).toBe(true)
      if (localDraft) expect(localDraft.value).toBe(writer === 'prompt editor' ? 'Answer in limericks.' : 'rm -rf *\nterraform destroy')
      const stored = await storedAgent(AGENT)
      expect(stored.system_prompt).toBe(originalRecord.system_prompt)
      expect(stored.provider_specific_settings).toEqual(originalRecord.provider_specific_settings)
      expect(stored.defaultTools).toEqual(originalRecord.defaultTools)
    },
    120_000
  )

  it('an invalid required-name draft stays editable across a same-agent read and saves after correction', async () => {
    await openPanel()
    const savedName = (await storedAgent(AGENT)).displayName
    await fireEvent.input(nameInput(), { target: { value: '' } })
    await waitFor(() => expect(screen.getByText(/Display name is required\./)).toBeTruthy(), { timeout: 8_000 })
    await pause(1200)
    expect(puts).toEqual([])
    expect((await storedAgent(AGENT)).displayName).toBe(savedName)

    const answer = holdNextGet()
    await readShownAgentAgain(false)
    await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })
    expect(nameInput().value).toBe('')
    expect((await storedAgent(AGENT)).displayName).toBe(savedName)

    answer()
    await waitFor(() => screen.queryByText('Loading agent details…') === null, { timeout: 8_000 })
    await pause(500)

    // No save owns this draft, so read waiting leaves the field editable. Correcting it can send
    // the owned name field and settle the deferred read without losing the draft.
    expect(nameInput().value).toBe('')
    expect(isReadWaitLocked(nameInput())).toBe(false)
    expect(puts).toEqual([])
    expect((await storedAgent(AGENT)).displayName).toBe(savedName)

    const repairedName = `${NAME} Repaired`
    await fireEvent.input(nameInput(), { target: { value: repairedName } })
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 8_000 })
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(repairedName), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ displayName: repairedName })
    expect(otherPuts).toEqual([])
    expect(puts).toHaveLength(1)
  }, 120_000)

  it('an already-open Tool Approval portal cannot capture while its own save and a same-agent GET are held', async () => {
    // SA-139 R4: Tool Approval belongs to an API Primary Agent (the CLI Primary's lane left).
    await openPanel()
    const renamed = `${NAME} Held`
    const put = holdNextPut({ beforeWrite: true })

    await fireEvent.input(nameInput(), { target: { value: renamed } })
    const approvalTrigger = selectShowing('Never') as HTMLElement | undefined
    expect(approvalTrigger).toBeTruthy()
    await fireEvent.keyDown(approvalTrigger as HTMLElement, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.queryAllByRole('option', { hidden: true }).length).toBeGreaterThan(0))
    const onRequestOption = screen
      .getAllByRole('option', { hidden: true })
      .find((element) => /On Failure/.test((element.textContent ?? '').trim()))
    expect(onRequestOption).toBeTruthy()

    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ displayName: renamed })
    expect(isReadWaitLocked(nameInput())).toBe(true)
    const answer = holdNextGet()
    await readShownAgentAgain(false)
    await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })
    expect(screen.getByTestId('primary-settings-read-wait')).toBeTruthy()

    // The Select.Content is portalled outside the disabled fieldset, so the already-open option
    // reaches its real callback and proves the server-side capture guard as well as fieldset state.
    await fireEvent.pointerUp(onRequestOption as HTMLElement, { pointerType: 'mouse' })
    await pause(900)
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({ displayName: renamed })
    expect(approvalTrigger?.textContent).toContain('Never')
    expect((await storedAgent(AGENT)).displayName).toBe(NAME)
    expect((await storedAgent(AGENT)).tool_approval_mode).not.toBe('all')

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(renamed), { timeout: 8_000 })
    put.answer()
    answer()
    await waitFor(() => screen.queryByTestId('primary-settings-read-wait') === null, { timeout: 8_000 })
    // S7 permits the section's exact equal automatic echo after the read. Wait for its response
    // before the next test resets the request ledger; every body must remain the name-only patch.
    await waitFor(() => events.filter((event) => event === 'put-answered').length === puts.length, { timeout: 8_000 })
    await pause(900)

    expect(puts.length).toBeGreaterThanOrEqual(1)
    expect(puts.length).toBeLessThanOrEqual(2)
    expect(puts.every(({ body }) => JSON.stringify(body) === JSON.stringify({ displayName: renamed }))).toBe(true)
    expect((await storedAgent(AGENT)).displayName).toBe(renamed)
    expect((await storedAgent(AGENT)).tool_approval_mode).not.toBe('all')
    expect(otherPuts).toEqual([])
  }, 120_000)

  it('a save that stays on the wire shows Retry after 30 seconds without recapturing, then settles into a fresh read', async () => {
    // SA-139 R4: the held save is the basic name save (the CLI Primary's Claude section left).
    await openPanel()
    const renamed = `${NAME} Held`
    // BL-1031: Redis dispatches writes with setImmediate; only the deadline clock is fake.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const put = holdNextPut({ beforeWrite: true })
    const readsBefore = events.filter((event) => event === 'get-answered').length

    try {
      await fireEvent.input(nameInput(), { target: { value: renamed } })
      await vi.advanceTimersByTimeAsync(1_000)
      await drainCallbacksUntil(() => puts.length === 1, 'the held name PUT')
      expect(puts[0].body).toEqual({ displayName: renamed })

      await drainCallbacksUntil(() => Boolean(screen.queryByTestId('primary-settings-read-wait')), 'the owned-save wait')
      const capturesBeforeDeadline = puts.length
      const bodiesBeforeDeadline = puts.map((entry) => entry.body)

      await vi.advanceTimersByTimeAsync(31_000)
      const notice = screen.getByTestId('primary-settings-read-wait')
      expect(within(notice).getByRole('button', { name: /Retry/ })).toBeTruthy()
      expect(notice.textContent).toMatch(/30 seconds|unknown.*save|timed|timeout/i)
      expect(isReadWaitLocked(nameInput())).toBe(true)
      expect(puts).toHaveLength(capturesBeforeDeadline)
      expect(puts.map((entry) => entry.body)).toEqual(bodiesBeforeDeadline)
      expect((await storedAgent(AGENT)).displayName).toBe(NAME)

      put.write()
      await drainCallbacksUntil(async () => (await storedAgent(AGENT)).displayName === renamed, 'the held name write')
      put.answer()
      await drainCallbacksUntil(
        () => events.filter((event) => event === 'get-answered').length > readsBefore,
        'the deferred fresh read'
      )
      await drainCallbacksUntil(() => !screen.queryByTestId('primary-settings-read-wait'), 'read-wait recovery')

      expect(new Set(puts.map((entry) => JSON.stringify(entry.body))).size).toBe(1)
      expect((await storedAgent(AGENT)).displayName).toBe(renamed)
      expect(isReadWaitLocked(nameInput())).toBe(false)
      expect(nameInput().value).toBe(renamed)
    } finally {
      // Release this case's owned barriers even if an assertion fails.
      put.write()
      put.answer()
      try {
        if (puts.length) await drainCallbacksUntil(() => events.includes('put-answered'), 'owned request cleanup')
      } finally {
        vi.useRealTimers()
      }
    }
  }, 120_000)
})

describe('the deferred read waits for every saver (BL-912, S5 and S6)', () => {
  it('a same-agent surface is locked while a Tool Grid save is on the wire', async () => {
    await openPanel()
    await openToolsTab()
    const gridPut = holdNextPut({ beforeWrite: true })
    card().onGatewaysChange(['gw_b'])
    await tick()
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    await switchAwayAndBack()

    expect(isReadWaitLocked(nameInput())).toBe(true)
    expect(puts).toEqual([{ body: {
      defaultMCPGateways: ['gw_b'],
      expectedMcpSettings: {
        defaultMCPGateways: JSON.parse((await routeAgent(AGENT, 'GET', undefined)).headers.get('x-batshit-mcp-settings-revisions') ?? 'null').defaultMCPGateways
      }
    } }])
    gridPut.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_b']), { timeout: 8_000 })
    gridPut.answer()
    await waitFor(() => events.filter((event) => event === 'put-answered').length === 1, { timeout: 8_000 })
    await waitFor(() => screen.queryByTestId('primary-settings-read-wait') === null, { timeout: 8_000 })
    await pause(400)

    expect(puts).toHaveLength(1)
    expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['gw_b'])
  }, 120_000)
})

describe('typing during the read a landing asked for (BL-942)', () => {
  it('the typed text stays in the form when the read answers, and it is saved', async () => {
    await openPanel()
    const namePut = holdNextPut({ beforeWrite: true })
    await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    await switchAwayAndBack()
    expect(nameInput().value).toBe(NAME)

    // The save writes and lands; the read it asks for reads the record, and its answer is held.
    const answer = holdNextGet()
    namePut.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })
    namePut.answer()
    await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })

    // The user types while that GET is on its way.
    await fireEvent.input(nameInput(), { target: { value: `${NAME} typed` } })
    answer()
    await pause(300)
    expect(nameInput().value).toBe(`${NAME} typed`)

    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} typed`), { timeout: 8_000 })
    await pause(2500)
    expect(nameInput().value).toBe(`${NAME} typed`)
    expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} typed`)
    expect(puts.at(-1)?.body).toEqual({ displayName: `${NAME} typed` })
  }, 120_000)
})

describe('the whole-list savers, a switch away and back while the save travels (BL-912)', () => {
  it('the CLI tools list: nothing takes it back, the record holds it, and the card shows it after the deferred read', async () => {
    await openPanel()
    await openToolsTab()
    const put = holdNextPut({ beforeWrite: true })
    card().onCliToolIdsChange(['cli_x'])
    await tick()
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ defaultTools: ['cli_x'] })

    // The read of another agent and back fills every section from the record, which holds no list yet.
    await switchAwayAndBack()
    await openToolsTab()
    expect(card().defaultCliToolIds).toEqual([])

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).defaultTools).toEqual(['cli_x']), { timeout: 8_000 })
    put.answer()
    await pause(2500)

    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).defaultTools).toEqual(['cli_x'])
    expect(card().defaultCliToolIds).toEqual(['cli_x'])
  }, 120_000)

  it('the Subagent assignment: nothing takes it back, the record holds it, and the switch shows it after the deferred read', async () => {
    await seedSubagent()
    await openPanel()
    await openAccessTab()
    expect(assignmentSwitch()!.getAttribute('aria-checked')).toBe('false')
    const post = holdNextPut({ beforeWrite: true })

    await fireEvent.click(assignmentSwitch() as HTMLElement)
    await waitFor(() => expect(assignmentPosts.length).toBe(1), { timeout: 8_000 })
    expect(assignmentPosts[0].body).toEqual({ subagentIds: [SUBA] })

    await switchAwayAndBack()
    await openAccessTab()
    expect(assignmentSwitch()!.getAttribute('aria-checked')).toBe('false')

    post.write()
    await waitFor(async () => expect(await storedAssignedIds()).toEqual([SUBA]), { timeout: 8_000 })
    post.answer()
    await pause(2500)

    expect(assignmentPosts.length).toBe(1)
    expect(puts).toEqual([])
    expect(await storedAssignedIds()).toEqual([SUBA])
    expect(assignmentSwitch()!.getAttribute('aria-checked')).toBe('true')
  }, 120_000)
})

describe('a prompt save and the reads around it (BL-912, the third review)', () => {
  it('sends the editor opening token after a newer read, keeps a conflict draft and never auto-replays it', async () => {
    await openPanel({ system_prompt: 'Opening prose.' })
    const opening = JSON.parse((await routeAgent(AGENT, 'GET', undefined)).headers.get(INSTRUCTIONS_REVISION_HEADER)!)
    const { editor, save } = await openPromptEditor('Opening prose.')
    await fireEvent.input(editor, { target: { value: 'My kept draft.' } })
    await redis.json.set(`agent:${AGENT}`, '$', { ...await storedAgent(AGENT), system_prompt: 'Remote prose.' })
    await readShownAgentAgain()
    expect(editor.value).toBe('My kept draft.')
    await fireEvent.click(save)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ system_prompt: 'My kept draft.', expectedInstructions: { customPrompt: opening.customPrompt } })
    await waitFor(() => expect(screen.getByTestId('primary-instructions-notice').textContent).toContain('not saved'), { timeout: 8_000 })
    await pause(1000)
    expect((await storedAgent(AGENT)).system_prompt).toBe('Remote prose.')
    expect(editor.value).toBe('My kept draft.')
    await fireEvent.click(save)
    await pause(300)
    expect(puts).toHaveLength(1)
  }, 120_000)

  it('an inclusion-only draft uses its original independent token and waits for a deliberate current choice after conflict', async () => {
    await openPanel({ system_prompt: 'Prompt stays.', include_global_prompt: true })
    const opening = JSON.parse((await routeAgent(AGENT, 'GET', undefined)).headers.get(INSTRUCTIONS_REVISION_HEADER)!)
    const instructionsTab = screen.getAllByRole('tab').find(element => /Instructions/.test(element.textContent ?? ''))!
    await fireEvent.mouseDown(instructionsTab); await fireEvent.click(instructionsTab)
    const row = screen.getByText('Include Global Custom Prompt').closest('.batshit-settings-toggle-row')!
    const toggle = within(row as HTMLElement).getByRole('switch')
    const put = holdNextPut({ beforeWrite: true })
    await fireEvent.click(toggle)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 8_000 })
    await redis.json.set(`agent:${AGENT}`, '$', { ...await storedAgent(AGENT), system_prompt: 'Independent new prompt.', include_global_prompt: null })
    put.write(); put.answer()
    await waitFor(() => expect(screen.getByTestId('primary-instructions-notice').textContent).toContain('not saved'), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ include_global_prompt: false, expectedInstructions: { includeGlobalPrompt: opening.includeGlobalPrompt } })
    await pause(1000)
    expect(puts).toHaveLength(1)
    expect(await storedAgent(AGENT)).toMatchObject({ include_global_prompt: null, system_prompt: 'Independent new prompt.' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Instructions', exact: true }))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'), { timeout: 8_000 })
    await fireEvent.click(toggle)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 8_000 })
    expect(puts[1].body.expectedInstructions).toEqual({ includeGlobalPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
    expect(puts[1].body.expectedInstructions.includeGlobalPrompt).not.toBe(opening.includeGlobalPrompt)
  }, 120_000)

  it('a prompt save is blocked during a read while its typed draft stays in the editor', async () => {
    await openPanel({ system_prompt: 'Answer in haiku.' })
    const { editor, save } = await openPromptEditor('Answer in haiku.')
    await fireEvent.input(editor, { target: { value: 'Answer in limericks.' } })

    // The shown agent is read again; its GET reads the older prompt, and its answer is slow.
    const answer = holdNextGet()
    await readShownAgentAgain(false)
    await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })

    // The read blocks this capture. The draft remains in the editor for an explicit retry.
    await fireEvent.click(save)
    await pause(500)
    expect(puts).toEqual([])
    expect(editor.value).toBe('Answer in limericks.')
    expect(screen.getByRole('dialog')).toBeTruthy()
    await pause(500)

    answer()
    await waitFor(() => screen.queryByTestId('primary-settings-read-wait') === null, { timeout: 8_000 })
    expect(editor.value).toBe('Answer in limericks.')
    await pause(2500)

    expect(puts).toEqual([])
    expect((await storedAgent(AGENT)).system_prompt).toBe('Answer in haiku.')
    expect(editor.value).toBe('Answer in limericks.')
    expect(agentStore.getAgentById(AGENT)?.system_prompt).toBe('Answer in haiku.')
  }, 120_000)

  it('an instructions save that lands after a switch away and back (an older landing) keeps the prompt behind the saved-instructions notice until its readback lands, then shows the saved text and sends nothing more', async () => {
    await openPanel({ system_prompt: 'Answer in haiku.' })
    const put = holdNextPut({ beforeWrite: true })
    const { editor, save } = await openPromptEditor('Answer in haiku.')
    await fireEvent.input(editor, { target: { value: 'Answer in limericks.' } })
    await fireEvent.click(save)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })

    // The other agent and back: the record still holds the older prompt when it is read.
    await switchAwayAndBack()

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).system_prompt).toBe('Answer in limericks.'), {
      timeout: 8_000
    })
    // The read that the older landing asks for reads the record; its answer is slow.
    const answer = holdNextGet()
    put.answer()
    await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })

    // Since 3698a4293 a known instructions save holds the editor until its readback lands: the
    // notice asks to read the saved instructions while that read is on its way.
    expect(screen.getByTestId('primary-instructions-notice').textContent).toContain('Read the saved instructions')

    answer()
    // The readback landed: the notice is gone and the prompt shows the saved text.
    await waitFor(() => expect(screen.queryByTestId('primary-instructions-notice')).toBeNull(), { timeout: 8_000 })
    expect((await openPromptEditor('Answer in limericks.')).editor).toBeTruthy()
    await pause(1500)
    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).system_prompt).toBe('Answer in limericks.')
  }, 120_000)
})

describe('a deferred read that fails (BL-912, S6)', () => {
  it('a failed read preserves the last confirmed form values and sends nothing', async () => {
    // SA-139 R4: the section save is the zip choice (the CLI Primary's Claude section left).
    await openPanel()
    await openToolsTab()
    const put = holdNextPut({ beforeWrite: true })
    card().onZipAiViewModeChange('appended')
    await tick()
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ zip_ai_view_mode: 'appended' })

    await switchAwayAndBack()
    await openToolsTab()
    expect(card().zipAiViewMode).not.toBe('appended')

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).zip_ai_view_mode).toBe('appended'), {
      timeout: 8_000
    })
    // The landing is an older one: it asks for a read, and that read fails.
    failNextGets = 1
    const readsBefore = events.filter((event) => event === 'get-answered').length
    put.answer()
    await waitFor(() => expect(events).toContain('get-failed'), { timeout: 8_000 })
    await pause(2500)

    // Failure keeps the last confirmed values; it neither retries on its own nor sends a save.
    expect(nameInput().value).toBe(NAME)
    expect(events.filter((event) => event === 'get-answered').length).toBe(readsBefore)
    expect(events.filter((event) => event === 'get-failed').length).toBe(1)
    expect(puts.length).toBe(1)
    expect(otherPuts).toEqual([])
    const record = await storedAgent(AGENT)
    expect(record.zip_ai_view_mode).toBe('appended')
    expect(record.displayName).toBe(NAME)
  }, 120_000)
})

describe('a failed Primary basic autosave (BL-936)', () => {
  it('shows its error, keeps the unsaved draft and baseline, and raises no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await openPanel()
      failNextPuts = 1
      await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
      await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
      await waitFor(() => expect(screen.queryAllByText(/Probe refusal/).length).toBeGreaterThan(0), { timeout: 8_000 })
      // Settlement alone must not queue another save or erase the failed draft/error.
      await pause(2500)
      expect(unhandled).toEqual([])
      expect(puts.map((entry) => entry.body)).toEqual([{ displayName: `${NAME} R` }])
      expect((await storedAgent(AGENT)).displayName).toBe(NAME)
      expect(nameInput().value).toBe(`${NAME} R`)
      expect(screen.queryAllByText(/Probe refusal/).length).toBeGreaterThan(0)

    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 120_000)
})

describe('guards on a Primary Agent (green on the old code too)', () => {
  it('the panel is pointed at another agent without a reset while a basic save is on its way: every section shows the other agent, and nothing is saved for it', async () => {
    await openPanel()
    const put = holdNextPut({ beforeWrite: true })
    await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })

    await rendered!.rerender({ initialAgentId: OTHER })
    await waitFor(() => expect(nameInput().value).toBe(OTHER_NAME), { timeout: 15_000 })

    put.write()
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })
    put.answer()
    await pause(2500)
    expect(nameInput().value).toBe(OTHER_NAME)
    expect(otherPuts).toEqual([])
    expect((await storedAgent(OTHER)).displayName).toBe(OTHER_NAME)
  }, 120_000)

  // SA-139 R4: these two ran on the CLI Primary's Claude section; the save rules they guard serve
  // every section, so they now run on the zip section.
  it('guard (no guard against a second send): the same zip edit on agent A and then on agent B: both are stored', async () => {
    await openPanel()
    await openToolsTab()
    const put = holdNextPut()
    card().onZipAiViewModeChange('appended')
    await tick()
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })

    await switchTo(OTHER_NAME)
    await waitFor(() => expect(nameInput().value).toBe(OTHER_NAME), { timeout: 15_000 })
    await waitFor(() => expect(screen.queryByText('Loading agent details…')).toBeNull(), { timeout: 8_000 })
    await openToolsTab()
    card().onZipAiViewModeChange('appended')
    await tick()

    await waitFor(() => expect(otherPuts.length).toBe(1), { timeout: 8_000 })
    expect(otherPuts[0].body).toEqual({ zip_ai_view_mode: 'appended' })
    put.answer()
    await pause(2500)
    expect((await storedAgent(OTHER)).zip_ai_view_mode).toBe('appended')
    expect((await storedAgent(AGENT)).zip_ai_view_mode).toBe('appended')
    expect(otherPuts.length).toBe(1)
  }, 120_000)

  it('guard: a zip save that failed, then a switch away and back, then the same value again: it is sent and stored', async () => {
    await openPanel()
    await openToolsTab()
    failNextPuts = 1
    card().onZipAiViewModeChange('appended')
    await tick()
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    await pause(1500)
    expect((await storedAgent(AGENT)).zip_ai_view_mode).not.toBe('appended')

    await switchAwayAndBack()
    await openToolsTab()
    expect(card().zipAiViewMode).not.toBe('appended')
    card().onZipAiViewModeChange('appended')
    await tick()
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ zip_ai_view_mode: 'appended' })
    await pause(1500)
    expect((await storedAgent(AGENT)).zip_ai_view_mode).toBe('appended')
  }, 120_000)
})
