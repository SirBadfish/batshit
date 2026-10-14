import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { CODEX_SUBMODEL_CHOICES } from '$lib/data/codex-models'
import {
  installAgentRoutes,
  jsonResponse,
  loadAgentRoute,
  storedAgent,
  type AgentPut
} from '$lib/test-utils/agentPutRoute'

/**
 * BL-910: opening a Primary Codex agent could save. Two `$effect`s of `AgentSettingsPanel`
 * lowered `codexForm.reasoningEffort` from `xhigh` to `high` and `serviceTier` from `fast` to
 * `standard` whenever the saved model was outside the static support sets
 * (`supportsCodexXhighReasoning`, `supportsCodexFastMode`), and they ran on open too: the form
 * changed after it loaded and the Codex autosave sent the change (a load changed what was saved:
 * BL-517, BL-834, BL-835's class). Now opening never changes the form and never saves; a saved
 * value the static sets do not know stays as saved (the server passes `xhigh` through and Codex
 * itself validates it), and picking a model the sets say cannot run it lowers it in that pick,
 * which shows and saves once.
 *
 * Renders the REAL panel. `/api/agents/<id>` goes to the REAL route handler on the default lane's
 * Redis fake. Every model the list holds today supports both settings, so the "pick a model
 * that lacks them" step adds one to the list for this file only (a future list entry).
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

useRedisTestServer()

const USER = 'ss910_user'
const AGENT = 'ss910_agent'
/** A model the static support sets do not know (never in Batshit's list). */
const UNLISTED_MODEL = 'probe-codex-unlisted'
/** A model the list holds in this file that supports neither Extra High nor Fast. */
const LITE_MODEL = { value: 'probe-codex-lite', label: 'Probe Lite' }

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
let puts: AgentPut[] = []
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
  // A future list entry that lacks Extra High and Fast (see the header).
  ;(CODEX_SUBMODEL_CHOICES as unknown as Array<{ value: string; label: string }>).push(LITE_MODEL)
}, 60_000)

afterAll(() => {
  const list = CODEX_SUBMODEL_CHOICES as unknown as Array<{ value: string; label: string }>
  const index = list.findIndex((choice) => choice.value === LITE_MODEL.value)
  if (index >= 0) list.splice(index, 1)
})

beforeEach(() => {
  ensureBrowserStubs()
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

/** Creates the Codex agent with `block` and renders the panel on it, past the autosave debounces. */
async function openPanel(block: Record<string, unknown>) {
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Codex clamp probe',
    agentType: 'cli',
    primary_model_provider: 'codex',
    primary_model_name: 'gpt-6-astra',
    primary_model_connection: { type: 'cli', service: 'codex' },
    codex_settings: block
  } as any)
  const routes = installAgentRoutes({
    agentId: AGENT,
    userId: USER,
    route: routeModule,
    extra: async (path, method) => {
      if (path === '/api/agents' && method === 'GET') return jsonResponse({ agents: [await storedAgent(AGENT)] })
      if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
      if (path === '/api/subagents' && method === 'GET') return jsonResponse({ subagents: [] })
      if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
      if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
      if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
      if (path === '/api/goons') return jsonResponse({ goons: [] })
      if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
      return undefined
    }
  })
  puts = routes.puts
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Codex clamp probe', {}, { timeout: 15_000 })
  await pause(1500)
}

function selectTrigger(current: string) {
  return screen
    .getAllByRole('button', { hidden: true })
    .find((element) => element.hasAttribute('data-select-trigger') && (element.textContent ?? '').trim() === current)
}

/**
 * Picks an option of the select whose visible value is `current`. The popper stays
 * `visibility: hidden` in jsdom (no layout), so its options have no accessible name: they are
 * found hidden and picked by their text.
 */
async function pickSelectOption(current: string, optionText: RegExp) {
  const trigger = selectTrigger(current)
  expect(trigger, `the select showing "${current}"`).toBeTruthy()
  await fireEvent.keyDown(trigger as HTMLElement, { key: 'ArrowDown' })
  await waitFor(() => expect(screen.queryAllByRole('option', { hidden: true }).length).toBeGreaterThan(0))
  const option = screen
    .getAllByRole('option', { hidden: true })
    .find((element) => optionText.test((element.textContent ?? '').trim()))
  expect(option, `an option matching ${optionText}`).toBeTruthy()
  await fireEvent.pointerUp(option as HTMLElement, { pointerType: 'mouse' })
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 8_000 })
  await pause(400)
}

describe('Agent Settings does not lower a saved Codex reasoning effort or speed on open (BL-910)', () => {
  it('a saved Extra High with a model outside the support sets: opening saves nothing and the form still holds it', async () => {
    await openPanel({ ...CODEX_BASE, model: UNLISTED_MODEL, reasoningEffort: 'xhigh' })
    const before = await storedAgent(AGENT)

    expect(puts).toEqual([])
    expect(await storedAgent(AGENT)).toEqual(before)
    expect(before.codex_settings.reasoningEffort).toBe('xhigh')
    // The form still shows the saved value (it was "High" after the effect lowered it).
    expect(selectTrigger('Extra High')).toBeTruthy()
    expect(selectTrigger('High')).toBeUndefined()
  }, 90_000)

  it('a saved Fast tier with a model outside the support sets: opening saves nothing and the form still holds it', async () => {
    // A model that left the list keeps its saved speed: the record is the user's until they change it.
    await openPanel({ ...CODEX_BASE, model: 'gpt-5.4', serviceTier: 'fast' })
    const before = await storedAgent(AGENT)

    expect(puts).toEqual([])
    expect(await storedAgent(AGENT)).toEqual(before)
    expect(before.codex_settings.serviceTier).toBe('fast')
    expect(selectTrigger('Fast')).toBeTruthy()
    expect(selectTrigger('Standard')).toBeUndefined()
  }, 90_000)

  it('an edit of another key sends only that key group: the saved Extra High and Fast stay as they are', async () => {
    await openPanel({ ...CODEX_BASE, model: UNLISTED_MODEL, reasoningEffort: 'xhigh', serviceTier: 'fast' })

    // Another key, through the reasoning select itself is not possible (Extra High is not offered for
    // this model), so change the permissions mode. A mode pick sends the whole permission group
    // (mode, sandbox and approval: BL-919), and nothing outside it.
    const group = screen.getByRole('group', { name: 'Codex permissions mode' })
    await fireEvent.click(within(group).getByRole('radio', { name: /^Agent \(full access\)/ }))
    await waitForPuts(1)

    expect(puts[0].body).toEqual({
      codex_settings: { permissionMode: 'agent_full', sandbox: 'danger-full-access', approval: 'never' }
    })
    expect((await storedAgent(AGENT)).codex_settings).toMatchObject({ reasoningEffort: 'xhigh', serviceTier: 'fast' })
  }, 90_000)

  it('a model supporting both keeps the saved values: picking it sends the model alone', async () => {
    await openPanel({ ...CODEX_BASE, model: UNLISTED_MODEL, reasoningEffort: 'xhigh', serviceTier: 'fast' })

    await pickSelectOption(UNLISTED_MODEL, /^GPT-5\.5$/)
    await waitForPuts(1)

    expect(puts[0].body).toEqual({ codex_settings: { model: 'gpt-5.5' } })
    expect((await storedAgent(AGENT)).codex_settings).toMatchObject({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      serviceTier: 'fast'
    })
  }, 90_000)

  it('the user picks a model that lacks Extra High: the value is lowered in that pick and saved once', async () => {
    await openPanel({ ...CODEX_BASE, model: 'gpt-6-astra', reasoningEffort: 'xhigh' })
    expect(puts).toEqual([])
    expect(selectTrigger('Extra High')).toBeTruthy()

    await pickSelectOption('GPT-6 Astra', /^Probe Lite$/)
    await waitForPuts(1)

    expect(puts[0].body).toEqual({ codex_settings: { model: LITE_MODEL.value, reasoningEffort: 'high' } })
    expect((await storedAgent(AGENT)).codex_settings).toMatchObject({
      model: LITE_MODEL.value,
      reasoningEffort: 'high'
    })
    // The form shows the lowered value, and nothing more is sent.
    expect(selectTrigger('High')).toBeTruthy()
    await pause(1500)
    expect(puts.length).toBe(1)
  }, 90_000)

  it('the user picks a model that lacks Fast: the tier is lowered in that pick and saved once', async () => {
    await openPanel({ ...CODEX_BASE, model: 'gpt-6-astra', serviceTier: 'fast' })
    expect(puts).toEqual([])
    expect(selectTrigger('Fast')).toBeTruthy()

    await pickSelectOption('GPT-6 Astra', /^Probe Lite$/)
    await waitForPuts(1)

    // Standard is the absence of the key: a dropped key goes as null.
    expect(puts[0].body).toEqual({ codex_settings: { model: LITE_MODEL.value, serviceTier: null } })
    const stored = (await storedAgent(AGENT)).codex_settings
    expect(stored.model).toBe(LITE_MODEL.value)
    expect('serviceTier' in stored).toBe(false)
    expect(selectTrigger('Standard')).toBeTruthy()
    await pause(1500)
    expect(puts.length).toBe(1)
  }, 90_000)
})
