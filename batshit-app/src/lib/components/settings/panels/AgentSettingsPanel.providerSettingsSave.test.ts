import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { chatBarWorkModeSave, presetModelSettings } from '$lib/utils/agentProviderSettings'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'

/**
 * BL-514, the Agent Settings half. An agent's `provider_specific_settings` holds the picked
 * preset's MODEL keys and the agent's OWN keys (`nativeTools`: the Work mode, the Bash
 * never-allow list, ...). The server keeps an own key a save does not name (the non-panel half),
 * so the panel must (1) name a cleared own key as null, (2) keep the own keys in its form when a
 * model is picked or cleared, (3) never save because it opened, (4) send only what the user
 * changed, so an older copy of the form cannot take back a newer chat-bar change, and (5) lay a
 * save over the agents store's copy the way the server does. BL-841: (6) send `nativeTools` field
 * by field, so a never-allow list edit keeps a Work mode chosen in another window's chat bar.
 *
 * Renders the REAL panel. `fetch` sends `/api/agents/<id>` to the REAL route handlers on the
 * default lane's Redis fake (the twin of `redis.updateAgent`'s by-path write); the chat-bar
 * changes go through the REAL agents store, the way `ModelSelector` and `ChatInput` send them.
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

const USER = 'sspanel_user'
const AGENT = 'sspanel_agent'

const WORK_MODE = {
  bashAccessMode: 'plan',
  executionBackend: 'apple_container',
  bashNeverAllowList: ['rm -rf *']
}

type Preset = Record<string, any>

const PRESET_A: Preset = {
  id: 'sspanel_preset_a',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7, maxTokens: 4000 }
}
const PRESET_B: Preset = {
  id: 'sspanel_preset_b',
  provider: 'anthropic',
  modelId: 'claude-probe-b',
  modelName: 'Probe Model B',
  purpose: 'chat',
  connection: { type: 'direct', service: 'anthropic' },
  settings: { temperature: 0.2 }
}
const PRESET_C: Preset = {
  id: 'sspanel_preset_c',
  provider: 'openai',
  modelId: 'gpt-5.5-mini',
  modelName: 'Probe Model C',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 1.1, topP: 0.9 }
}
/** Not a chat model: Agent Settings clears its selection when it opens. */
const PRESET_IMAGE: Preset = {
  id: 'sspanel_preset_image',
  provider: 'openai',
  modelId: 'gpt-image-2',
  modelName: 'Probe Image Model',
  purpose: 'visual',
  connection: { type: 'direct', service: 'openai' },
  settings: { quality: 'high' }
}
const PRESETS = [PRESET_A, PRESET_B, PRESET_C, PRESET_IMAGE]

function agentWithPreset(preset: Preset, providerSettings: Record<string, unknown>) {
  return {
    id: AGENT,
    user_id: USER,
    displayName: 'Panel probe',
    agentType: 'api',
    ...buildPickedPresetModelFields(preset as any),
    primary_model_connection: resolveSavedModelConnection(preset as any),
    provider_specific_settings: providerSettings
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
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

let routeModule: typeof import('../../../../routes/api/agents/[id]/+server')

beforeAll(async () => {
  routeModule = await import('../../../../routes/api/agents/[id]/+server')
}, 60_000)

/** Every PUT body the panel or the store sent, in order, with who sent it. */
let puts: Array<{ body: Record<string, any> }> = []
let agentReads = 0

function installRoutes() {
  puts = []
  agentReads = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]

    if (path === '/api/agents' && method === 'GET') {
      return jsonResponse({ agents: [await redis.json.get(`agent:${AGENT}`)] })
    }
    if (path === `/api/agents/${AGENT}/subagents`) {
      return jsonResponse({ subagents: [] })
    }
    if (path === `/api/agents/${AGENT}`) {
      const request = new Request(`http://localhost${path}`, {
        method,
        body: method === 'PUT' ? String(init.body) : undefined
      })
      if (method === 'PUT') puts.push({ body: JSON.parse(String(init.body)) })
      else agentReads += 1
      const handler = method === 'PUT' ? routeModule.PUT : routeModule.GET
      return (await handler({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/user/saved-models') {
      return jsonResponse({ models: PRESETS })
    }
    if (path === '/api/models') {
      return jsonResponse({ data: { connections: [] } })
    }
    if (path === '/api/settings/api-keys') {
      return jsonResponse({ keys: {} })
    }
    if (path === '/api/goons') {
      return jsonResponse({ goons: [] })
    }
    if (path === '/api/icons/library') {
      return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    }
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

async function stored() {
  return (await redis.json.get(`agent:${AGENT}`)) as Record<string, any>
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Renders the panel and waits until the agent, the saved models and the connections are in. */
async function openPanel() {
  const view = render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Panel probe', {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  // Past the 600 ms autosave debounce, so a save the opening queued would have gone out.
  await pause(900)
  return view
}

async function pickModelInPanel(modelName: string) {
  const trigger = screen.getAllByRole('button').find((button) =>
    /Probe (Image )?Model|Choose a Saved Model/.test(button.textContent ?? '')
  )
  expect(trigger).toBeTruthy()
  await fireEvent.keyDown(trigger as HTMLElement, { key: 'ArrowDown' })
  const option = await screen.findByRole('option', { name: new RegExp(modelName) })
  await fireEvent.pointerUp(option, { pointerType: 'mouse' })
}

function workModeItem(label: 'Plan' | 'Agent') {
  const group = screen.getByRole('group', { name: 'Batshit permissions mode' })
  return within(group).getByRole('radio', { name: new RegExp(`^${label}$`) })
}

async function setWorkModeInPanel(label: 'Plan' | 'Agent') {
  await fireEvent.click(workModeItem(label))
}

async function editDisplayName(value: string) {
  const input = document.getElementById('agent-display') as HTMLInputElement
  await fireEvent.input(input, { target: { value } })
}

/** ChatInput's Work mode save (`handleNativeBashModeSelect`), through the real store. */
async function chatBarWorkMode(mode: string) {
  const current = agentStore.getAgentById(AGENT)?.provider_specific_settings ?? null
  await agentStore.updateAgentSettings(AGENT, { provider_specific_settings: chatBarWorkModeSave(current, mode) } as any)
}

/** Opens the never-allow list editor on the row that shows `shown`, types `text`, and saves. */
async function editNeverAllowList(shown: string, text: string) {
  const blockListRow = screen.getByText(shown).closest('.batshit-settings-muted-panel') as HTMLElement
  await fireEvent.click(within(blockListRow).getByRole('button', { name: /Edit/ }))
  const editor = await screen.findByDisplayValue(shown)
  await fireEvent.input(editor, { target: { value: text } })
  await fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 5_000 })
  // Let the save's answer land in the panel before the next step.
  await pause(50)
}

describe('Agent Settings keeps the agent\'s own provider settings (BL-514, panel half)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    installRoutes()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    agentStore.setAgents([])
  })

  it('(a) picking a model keeps the Work mode and never-allow list in the form: a later Work-mode edit keeps the list', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { temperature: 0.7, maxTokens: 4000, nativeTools: WORK_MODE }) as any)
    await openPanel()
    expect(puts).toEqual([])

    await pickModelInPanel('Probe Model C')
    await waitForPuts(1)
    expect((await stored()).primary_model_preset_id).toBe(PRESET_C.id)
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 1.1, topP: 0.9, nativeTools: WORK_MODE })
    // The form still holds the agent's Work mode after the pick (it showed the default before).
    expect(workModeItem('Plan').getAttribute('aria-checked')).toBe('true')

    await setWorkModeInPanel('Agent')
    await waitForPuts(2)
    const nativeTools = (await stored()).provider_specific_settings.nativeTools
    expect(nativeTools.bashAccessMode).toBe('agent')
    expect(nativeTools.bashNeverAllowList).toEqual(['rm -rf *'])
    expect((await stored()).provider_specific_settings.temperature).toBe(1.1)
    // That save named no display name; the agent list keeps the one it has.
    const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
    expect(within(selector).getAllByTitle('Panel probe').length).toBeGreaterThan(0)
  }, 60_000)

  it('(a) the agents store copy keeps the own keys after a model pick in the panel (the chat bar reads it)', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { temperature: 0.7, maxTokens: 4000, nativeTools: WORK_MODE }) as any)
    await openPanel()

    await pickModelInPanel('Probe Model C')
    await waitForPuts(1)
    expect(agentStore.getAgentById(AGENT)?.provider_specific_settings).toEqual((await stored()).provider_specific_settings)
    expect(agentStore.getAgentById(AGENT)?.provider_specific_settings?.nativeTools).toEqual(WORK_MODE)
  }, 60_000)

  it('(b) a model picked in the chat bar while Agent Settings is open survives the next Agent Settings save', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { temperature: 0.7, maxTokens: 4000, nativeTools: WORK_MODE }) as any)
    await openPanel()

    // The chat-bar picker's save (ModelSelector), through the real store.
    await agentStore.updateAgentSettings(AGENT, {
      ...buildPickedPresetModelFields(PRESET_B as any),
      primary_model_connection: resolveSavedModelConnection(PRESET_B as any),
      provider_specific_settings: presetModelSettings(PRESET_B.settings),
      primary_model_capabilities: null
    } as any)
    expect(puts).toHaveLength(1)
    expect((await stored()).primary_model_preset_id).toBe(PRESET_B.id)

    await editDisplayName('Panel probe renamed')
    await waitForPuts(2)
    const record = await stored()
    expect(record.displayName).toBe('Panel probe renamed')
    expect(record.primary_model_preset_id).toBe(PRESET_B.id)
    expect(record.primary_model_provider).toBe('anthropic')
    expect(record.primary_model_name).toBe('claude-probe-b')
    expect(record.provider_specific_settings).toEqual({ temperature: 0.2, nativeTools: WORK_MODE })
    expect(puts[1].body).toEqual({ displayName: 'Panel probe renamed' })
  }, 60_000)

  it('(b) a Work mode chosen in the chat bar while Agent Settings is open survives the next Agent Settings save', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { temperature: 0.7, maxTokens: 4000, nativeTools: WORK_MODE }) as any)
    await openPanel()

    // ChatInput.handleNativeBashModeSelect's save, through the real store.
    await chatBarWorkMode('agent')
    expect((await stored()).provider_specific_settings.nativeTools.bashAccessMode).toBe('agent')

    await editDisplayName('Panel probe renamed')
    await waitForPuts(2)
    const record = await stored()
    expect(record.displayName).toBe('Panel probe renamed')
    expect(record.provider_specific_settings.nativeTools).toEqual({ ...WORK_MODE, bashAccessMode: 'agent' })
  }, 60_000)

  it('(c) clearing the last native-tool setting in Agent Settings saves the clear', async () => {
    await redis.createAgent(
      agentWithPreset(PRESET_A, { temperature: 0.7, maxTokens: 4000, nativeTools: { bashNeverAllowList: ['rm -rf *'] } }) as any
    )
    await openPanel()

    const blockListRow = screen.getByText('rm -rf *').closest('.batshit-settings-muted-panel') as HTMLElement
    await fireEvent.click(within(blockListRow).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('rm -rf *')
    await fireEvent.input(editor, { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitForPuts(1)
    // BL-841: field by field, so the clear cannot take back a field another window wrote.
    expect(puts[0].body.provider_specific_settings).toEqual({ nativeTools: { bashNeverAllowList: null } })
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 0.7, maxTokens: 4000, nativeTools: {} })
  }, 60_000)

  it('(e) a Work mode chosen in the chat bar while Agent Settings is open survives a never-allow list edit there (BL-841)', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { temperature: 0.7, maxTokens: 4000, nativeTools: WORK_MODE }) as any)
    await openPanel()

    // Another window's chat bar switches to Agent while this panel still shows Plan.
    await chatBarWorkMode('agent')
    expect((await stored()).provider_specific_settings.nativeTools.bashAccessMode).toBe('agent')

    await editNeverAllowList('rm -rf *', 'rm -rf *\ngit push --force')
    await waitForPuts(2)
    expect(puts[1].body).toEqual({
      provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'git push --force'] } }
    })
    expect((await stored()).provider_specific_settings).toEqual({
      temperature: 0.7,
      maxTokens: 4000,
      nativeTools: { ...WORK_MODE, bashAccessMode: 'agent', bashNeverAllowList: ['rm -rf *', 'git push --force'] }
    })
  }, 60_000)

  it('(e) Full access chosen in the chat bar, then Plan picked in a stale Agent Settings: the command location is the sandbox (review fix)', async () => {
    await redis.createAgent(
      agentWithPreset(PRESET_A, { temperature: 0.7, maxTokens: 4000, nativeTools: { ...WORK_MODE, bashAccessMode: 'agent' } }) as any
    )
    await openPanel()

    // Another window's chat bar switches to Full access: the record now runs commands on the Mac.
    await chatBarWorkMode('dangerous')
    expect((await stored()).provider_specific_settings.nativeTools).toMatchObject({ bashAccessMode: 'dangerous', executionBackend: 'local' })

    // This panel still shows Agent in the sandbox; the user picks Plan here.
    await setWorkModeInPanel('Plan')
    await waitForPuts(2)
    expect(puts[1].body.provider_specific_settings.nativeTools).toMatchObject({ bashAccessMode: 'plan', executionBackend: 'apple_container' })
    expect((await stored()).provider_specific_settings.nativeTools).toMatchObject({
      bashAccessMode: 'plan',
      executionBackend: 'apple_container',
      bashNeverAllowList: ['rm -rf *']
    })
  }, 60_000)

  it('(e) a model picked in the chat bar while Agent Settings is open survives a never-allow list edit there (BL-833)', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { temperature: 0.7, maxTokens: 4000, nativeTools: WORK_MODE }) as any)
    await openPanel()

    await agentStore.updateAgentSettings(AGENT, {
      ...buildPickedPresetModelFields(PRESET_B as any),
      primary_model_connection: resolveSavedModelConnection(PRESET_B as any),
      provider_specific_settings: presetModelSettings(PRESET_B.settings),
      primary_model_capabilities: null
    } as any)

    await editNeverAllowList('rm -rf *', 'rm -rf *\ngit push --force')
    await waitForPuts(2)
    const record = await stored()
    expect(record.primary_model_preset_id).toBe(PRESET_B.id)
    expect(record.provider_specific_settings).toEqual({
      temperature: 0.2,
      nativeTools: { ...WORK_MODE, bashNeverAllowList: ['rm -rf *', 'git push --force'] }
    })
  }, 60_000)

  it('(d) opening Agent Settings for an agent whose preset it cannot select saves nothing', async () => {
    await redis.createAgent(agentWithPreset(PRESET_IMAGE, { quality: 'high', nativeTools: WORK_MODE }) as any)
    const before = await stored()
    await openPanel()
    await pause(700)

    expect(puts).toEqual([])
    expect(await stored()).toEqual(before)
    // The picker shows no selection, as it did before; only the save changed.
    expect(screen.getByText('Choose a Saved Model')).toBeTruthy()
  }, 60_000)

  it('(d) after opening with a preset it cannot select, an unrelated edit sends only that edit', async () => {
    await redis.createAgent(agentWithPreset(PRESET_IMAGE, { quality: 'high', nativeTools: WORK_MODE }) as any)
    await openPanel()

    await editDisplayName('Panel probe renamed')
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ displayName: 'Panel probe renamed' })
    const record = await stored()
    expect(record.primary_model_preset_id).toBe(PRESET_IMAGE.id)
    expect(record.provider_specific_settings).toEqual({ quality: 'high', nativeTools: WORK_MODE })
  }, 60_000)
})
