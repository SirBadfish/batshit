import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { jsonResponse, loadAgentRoute, storedAgent, type AgentPut } from '$lib/test-utils/agentPutRoute'

/**
 * SA-122 A-1y (LS-067/LS-068, BL-1294): the agent saves its own Settings (App Actions) while Agent
 * Settings shows it. Renders the REAL panel; `/api/agents/<id>` goes to the REAL route on the default
 * lane's Redis fake, whose `updateAgent` applies the real memory base compare. The agent's own save
 * is the by-path write its owner makes (`conditionalAgentSettings.ts` runs Lua, real Redis only:
 * the mounted real-Redis proof is `AgentSettingsPanel.agentWriteRefresh.test.ts`); the user channel
 * is a stand-in that hands the panel the event the server publishes.
 *
 * - at rest: the event makes the panel read the agent; it shows the agent's values and saves nothing;
 * - BL-1294: a memory edit whose baseline the agent changed is refused (409) and sent once more on
 *   top of the agent's values, keeping the user's edit; a field both changed keeps the user's value
 *   and says so; a second refusal shows Retry (never a loop), and so does a refusal the record does
 *   not explain; a 400 `memory_base_required` (an older page) is shown;
 * - an edit of another field: the event waits for the panel to come to rest, and that save sends no
 *   memory setting, so it cannot take the agent's change back.
 */

const channel = vi.hoisted(() => ({ listeners: new Set<(event: any) => void>() }))
const toasts = vi.hoisted(() => ({ warning: [] as string[], error: [] as string[] }))

vi.mock('$lib/services/userChannel', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  onUserChannelEvent: (listener: (event: any) => void) => {
    channel.listeners.add(listener)
    return () => channel.listeners.delete(listener)
  }
}))
vi.mock('$lib/components/ui/sonner/settings-toast', async (original) => {
  const actual = await original<Record<string, any>>()
  const toast = Object.assign((...args: unknown[]) => actual.toast(...args), {
    ...actual.toast,
    warning: (message: string) => {
      toasts.warning.push(message)
    },
    error: (message: string, ...rest: unknown[]) => {
      toasts.error.push(message)
      return actual.toast.error(message, ...rest)
    }
  })
  return { ...actual, toast }
})
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
  default: (await import('../../mcps/__tests__/AgentMcpDefaultsCardStub.test.svelte')).default
}))

useRedisTestServer()

const USER = 'a1y_user'
const AGENT = 'a1y_agent'
const NAME = 'Write probe'
const OTHER = 'a1y_other'
const OTHER_NAME = 'Other write probe'
const KEY = `agent:${AGENT}`

const PRESET = {
  id: 'a1y_preset',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
}

const MEMORY = {
  memory_enabled: true,
  memory_linger_turns: 2,
  memory_recall_linger_turns: 3,
  memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 }
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

let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
/** Every PUT the panel sent to the agent, in order, with the status it got. */
let puts: Array<AgentPut & { status?: number }> = []
/** Each agent PUT takes the next of these, in order, before the route runs (the agent saving first). */
let beforePut: Array<() => Promise<void>> = []
/** Each agent PUT takes the next of these: an answer instead of the route (a probe refusal). */
let fakePutAnswers: Array<Response | null> = []
let agentGets = 0
let otherGets = 0
/** While set, the agent's next GET reads the record, then waits for it before answering (a slow first load). */
let holdAgentGet: Promise<void> | null = null
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
}, 60_000)

beforeEach(() => {
  ensureBrowserStubs()
  puts = []
  beforePut = []
  fakePutAnswers = []
  agentGets = 0
  otherGets = 0
  holdAgentGet = null
  toasts.warning = []
  toasts.error = []
  channel.listeners.clear()
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
/** Each case mounts the real panel and waits past autosave debounces: far above the 5 s default. */
// 120 s: the slowest case's own waits (opening, five 10 s waits, pauses) can pass 60 s on a slow machine,
// and a wait should name itself before the case limit does (review NIT).
const SLOW = 120_000

async function routeAgent(id: string, method: string, body: string | undefined) {
  const request = new Request(`http://localhost/api/agents/${id}`, { method, body: method === 'PUT' ? body : undefined })
  const handler = method === 'PUT' ? routeModule.PUT : routeModule.GET
  return (await handler({ params: { id }, request, locals: { user: { id: USER } } } as any)) as Response
}

function installRoutes() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    if (path === `/api/agents/${AGENT}` && method === 'PUT') {
      const entry: AgentPut & { status?: number } = { body: JSON.parse(String(init.body)) }
      puts.push(entry)
      const before = beforePut.shift()
      if (before) await before()
      const fake = fakePutAnswers.shift() ?? null
      const response = fake ?? (await routeAgent(AGENT, 'PUT', String(init.body)))
      entry.status = response.status
      return response
    }
    if (path === `/api/agents/${AGENT}` && method === 'GET') {
      agentGets += 1
      const response = await routeAgent(AGENT, 'GET', undefined)
      const hold = holdAgentGet
      holdAgentGet = null
      if (hold) await hold
      return response
    }
    if (path === `/api/agents/${OTHER}`) {
      if (method === 'GET') otherGets += 1
      return routeAgent(OTHER, method, method === 'PUT' ? String(init.body) : undefined)
    }
    if (path === '/api/agents' && method === 'GET') {
      return jsonResponse({ agents: [await storedAgent(AGENT), await storedAgent(OTHER)] })
    }
    if (path === `/api/agents/${AGENT}/subagents` || path === `/api/agents/${OTHER}/subagents`) return jsonResponse({ subagents: [] })
    if (path === '/api/subagents' && method === 'GET') return jsonResponse({ subagents: [] })
    if (path === '/api/user/saved-models') return jsonResponse({ models: [PRESET] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ goons: [] })
    if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
    if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  }))
}

async function openPanel() {
  await redis.createAgent({
    id: OTHER,
    user_id: USER,
    displayName: OTHER_NAME,
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7 }
  } as any)
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: NAME,
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7 },
    ...MEMORY
  } as any)
  installRoutes()
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue(NAME, {}, { timeout: 15_000 })
  await waitFor(() => expect(budgetInput('Awareness')).toBeTruthy(), { timeout: 10_000 })
  // Past every autosave debounce: opening writes nothing.
  await pause(1500)
  expect(puts).toEqual([])
}

function emit(event: Record<string, unknown>) {
  for (const listener of [...channel.listeners]) listener(event)
}

function budgetInput(label: string) {
  const cell = [...document.querySelectorAll('.memory-budget-cell')].find(
    (element) => element.querySelector('span')?.textContent?.trim() === label
  )
  return (cell?.querySelector('input') ?? null) as HTMLInputElement | null
}

function nameInput() {
  return document.getElementById('agent-display') as HTMLInputElement
}

async function typeBudget(label: string, value: number) {
  const input = budgetInput(label) as HTMLInputElement
  await fireEvent.focusIn(input)
  await fireEvent.input(input, { target: { value: String(value) } })
}

/** The agent's own Settings save, as its owner writes it: by path, then the event the server publishes. */
async function agentSavesBudget(lane: 'on_my_mind' | 'triggers' | 'recalled', value: number) {
  await redis.json.set(KEY, `$.memory_lane_budgets.${lane}`, value as never)
}

function readWaitNote() {
  return document.querySelector('[data-testid="primary-settings-read-wait"]')
}

describe('Agent Settings and the agent saving its own Settings (SA-122 A-1y)', () => {
  it('at rest: the event reads the agent; the panel shows its name and memory and saves nothing', async () => {
    await openPanel()
    const getsAfterOpen = agentGets
    await redis.json.set(KEY, '$.displayName', 'Write probe 2' as never)
    await agentSavesBudget('on_my_mind', 120)

    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'identity' })
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'memory' })

    await waitFor(() => expect(nameInput().value).toBe('Write probe 2'), { timeout: 10_000 })
    await waitFor(() => expect(budgetInput('Awareness')?.value).toBe('120'), { timeout: 10_000 })
    await pause(1500)
    expect(puts).toEqual([])
    expect(agentGets).toBeGreaterThan(getsAfterOpen)

    // One listener per mounted panel, gone with it.
    expect(channel.listeners.size).toBe(1)
    cleanup()
    expect(channel.listeners.size).toBe(0)
  }, SLOW)

  it('a missed event after the live connection came back: the panel reads the agent again', async () => {
    await openPanel()
    await agentSavesBudget('triggers', 220)

    emit({ type: 'reconnected' })

    await waitFor(() => expect(budgetInput('Triggers (STM)')?.value).toBe('220'), { timeout: 10_000 })
    await pause(1000)
    expect(puts).toEqual([])
  }, SLOW)

  it('BL-1294: the user edits Recalled, the agent saved Awareness first: one refusal, one resend, both kept', async () => {
    await openPanel()
    // The agent saves Awareness after the panel read it and before the user's save arrives.
    beforePut.push(() => agentSavesBudget('on_my_mind', 120))

    await typeBudget('Recalled (LTM)', 350)

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 10_000 })
    await waitFor(() => expect(puts[1].status).toBe(200), { timeout: 10_000 })
    expect(puts[0].status).toBe(409)
    expect(puts[0].body.expectedMemory.memory_lane_budgets).toEqual({ on_my_mind: 100, triggers: 200, recalled: 300 })
    expect(puts[1].body.expectedMemory.memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 300 })
    expect(puts[1].body.memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 350 })
    expect((await storedAgent(AGENT)).memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 350 })
    await waitFor(() => expect(budgetInput('Awareness')?.value).toBe('120'))
    expect(budgetInput('Recalled (LTM)')?.value).toBe('350')
    expect(toasts.warning).toEqual([])
    expect(document.querySelector('.batshit-settings-save-status.is-error')).toBeNull()
    await pause(1500)
    expect(puts.length).toBe(2)
  }, SLOW)

  it('both changed Awareness: the user value is kept, saved once more, and the panel says so', async () => {
    await openPanel()
    beforePut.push(() => agentSavesBudget('on_my_mind', 130))

    await typeBudget('Awareness', 150)

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 10_000 })
    await waitFor(() => expect(puts[1].status).toBe(200), { timeout: 10_000 })
    expect((await storedAgent(AGENT)).memory_lane_budgets.on_my_mind).toBe(150)
    expect(toasts.warning).toHaveLength(1)
    expect(toasts.warning[0]).toMatch(/Awareness/)
  }, SLOW)

  it('a second refusal for the same edit shows Retry instead of a third send; Retry reads again and sends once more', async () => {
    await openPanel()
    beforePut.push(() => agentSavesBudget('on_my_mind', 120))
    beforePut.push(() => agentSavesBudget('on_my_mind', 140))

    await typeBudget('Recalled (LTM)', 350)

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 10_000 })
    await waitFor(() => expect(puts[1].status).toBe(409), { timeout: 10_000 })
    await waitFor(() => expect(readWaitNote()?.textContent).toMatch(/changed while you were editing/), { timeout: 10_000 })
    await pause(1500)
    expect(puts.length).toBe(2)

    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(puts.length).toBe(3), { timeout: 10_000 })
    await waitFor(() => expect(puts[2].status).toBe(200), { timeout: 10_000 })
    expect((await storedAgent(AGENT)).memory_lane_budgets).toEqual({ on_my_mind: 140, triggers: 200, recalled: 350 })
  }, SLOW)

  it('a refusal the record does not explain (it still reads as the baseline): Retry is shown, nothing is sent again', async () => {
    await openPanel()
    fakePutAnswers.push(jsonResponse({ error: 'Probe conflict', code: 'memory_settings_changed' }, 409))

    await typeBudget('Recalled (LTM)', 350)

    await waitFor(() => expect(readWaitNote()?.textContent).toMatch(/changed while you were editing/), { timeout: 10_000 })
    await pause(1500)
    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).memory_lane_budgets.recalled).toBe(300)
  }, SLOW)

  it('a memory save the server refuses for want of a base (an older page) is shown, never saved anyway', async () => {
    await openPanel()
    fakePutAnswers.push(
      jsonResponse(
        {
          error: 'This save changes memory settings but does not say which saved values it started from, so nothing was saved. Reload Batshit and try again.',
          code: 'memory_base_required'
        },
        400
      )
    )

    await typeBudget('Recalled (LTM)', 350)

    await waitFor(
      () => expect(document.querySelector('.batshit-settings-save-status.is-error')?.textContent).toMatch(/Reload Batshit/),
      { timeout: 10_000 }
    )
    expect((await storedAgent(AGENT)).memory_lane_budgets.recalled).toBe(300)
  }, SLOW)

  it('an edit of the name while the agent saves its memory: the read waits for rest, and the name save takes nothing back', async () => {
    await openPanel()
    await fireEvent.input(nameInput(), { target: { value: 'Renamed by the user' } })
    await agentSavesBudget('on_my_mind', 120)
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'memory' })

    await waitFor(() => expect(puts.length).toBe(1), { timeout: 10_000 })
    expect(puts[0].body).toEqual({ displayName: 'Renamed by the user' })
    await waitFor(() => expect(budgetInput('Awareness')?.value).toBe('120'), { timeout: 10_000 })
    const record = await storedAgent(AGENT)
    expect(record.displayName).toBe('Renamed by the user')
    expect(record.memory_lane_budgets.on_my_mind).toBe(120)
  }, SLOW)

  it('a memory edit whose save goes out after the user picked another agent: refused, nothing saved, and the panel says so', async () => {
    await openPanel()
    // The save is held on the wire until the user has picked the other agent, so its refusal always
    // answers after the switch, whatever the machine's speed (review NIT).
    let releaseSave: () => void = () => {}
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    beforePut.push(async () => {
      await saveHeld
      await agentSavesBudget('on_my_mind', 120)
    })

    await typeBudget('Recalled (LTM)', 350)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 10_000 })
    const selector = screen.getByRole('button', { name: 'Select Agents & Subagents', hidden: true })
    await fireEvent.keyDown(selector, { key: 'ArrowDown' })
    const item = await screen.findByText(OTHER_NAME, { selector: '.batshit-settings-action-row-title' })
    await fireEvent.click(item.closest('button') as HTMLElement)
    releaseSave()

    await waitFor(() => expect(puts[0]?.status).toBe(409), { timeout: 10_000 })
    await waitFor(() => expect(toasts.error.some((message) => message.includes(NAME) && /not saved/.test(message))).toBe(true), {
      timeout: 10_000
    })
    await pause(1500)
    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 300 })
  }, SLOW)

  it('the agent saves while its first read is still on its way: the panel reads it again and shows the saved name', async () => {
    let release: () => void = () => {}
    holdAgentGet = new Promise<void>((resolve) => {
      release = resolve
    })
    await redis.createAgent({
      id: OTHER,
      user_id: USER,
      displayName: OTHER_NAME,
      agentType: 'api',
      ...buildPickedPresetModelFields(PRESET as any),
      primary_model_connection: resolveSavedModelConnection(PRESET as any)
    } as any)
    await redis.createAgent({
      id: AGENT,
      user_id: USER,
      displayName: NAME,
      agentType: 'api',
      ...buildPickedPresetModelFields(PRESET as any),
      primary_model_connection: resolveSavedModelConnection(PRESET as any),
      ...MEMORY
    } as any)
    installRoutes()
    render((await import('./AgentSettingsPanel.svelte')).default, {
      props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
    })
    // The first read has read the record and waits to answer: its answer predates the agent's save.
    await waitFor(() => expect(agentGets).toBe(1), { timeout: 15_000 })
    await redis.json.set(KEY, '$.displayName', 'Write probe 2' as never)
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'identity' })
    release()

    await waitFor(() => expect(nameInput()?.value).toBe('Write probe 2'), { timeout: 15_000 })
    await pause(1500)
    expect(puts).toEqual([])
  }, SLOW)

  it('another listed agent changed its name: only its list entry is read again', async () => {
    await openPanel()
    const getsAfterOpen = agentGets
    await redis.json.set(`agent:${OTHER}`, '$.displayName', 'Other write probe 2' as never)

    emit({ type: 'agent_settings_changed', agentId: OTHER, family: 'identity' })

    await waitFor(() => expect(otherGets).toBe(1), { timeout: 10_000 })
    await pause(200)
    const selector = screen.getByRole('button', { name: 'Select Agents & Subagents', hidden: true })
    await fireEvent.keyDown(selector, { key: 'ArrowDown' })
    expect(await screen.findByText('Other write probe 2', { selector: '.batshit-settings-action-row-title' })).toBeTruthy()
    expect(nameInput().value).toBe(NAME)
    expect(agentGets).toBe(getsAfterOpen)
    expect(puts).toEqual([])
  }, SLOW)
})
