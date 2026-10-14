import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'

/**
 * BL-844: a Subagent save sent its whole form. The Subagent record can change after Settings
 * opened (another tab, an agent tool, a second Settings window), and the next edit of any field
 * took those changes back, because `buildSubagentPayload` named every field. The Primary Agent
 * form has sent only what changed since BL-514: the panel keeps the Subagent form as it loaded
 * or last saved (`subagentPersistedForm`) and sends `buildSubagentSettingsSavePatch` against it.
 *
 * Renders the REAL panel. `/api/subagents/<id>` goes to the REAL route handler on the default
 * lane's Redis fake (it writes each field the body names by path, BL-914: a field the body does
 * not name keeps its stored value, and `provider_specific_settings` is written key by key).
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

useRedisTestServer()

const USER = 'ss844_user'
const AGENT = 'ss844_agent'
const SUB = 'ss844_sub'
const SUB_NAME = 'Ss844 Panel Sub'

type Preset = Record<string, any>

const PRESET_CHAT: Preset = {
  id: 'ss844_preset_chat',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Chat Model',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
}
/** Not a chat model: the Subagent picker cannot select it (BL-834). */
const PRESET_IMAGE: Preset = {
  id: 'ss844_preset_image',
  provider: 'openai',
  modelId: 'gpt-image-2',
  modelName: 'Probe Image Model',
  purpose: 'visual',
  connection: { type: 'direct', service: 'openai' },
  settings: { quality: 'high' }
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

let agentRoute: typeof import('../../../../routes/api/agents/[id]/+server')
let subagentRoute: typeof import('../../../../routes/api/subagents/[id]/+server')

beforeAll(async () => {
  agentRoute = await import('../../../../routes/api/agents/[id]/+server')
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

/** Every Subagent PUT body the panel sent, in order. */
let puts: Array<{ body: Record<string, any>; settled: boolean }> = []
let agentReads = 0
/** While set, the next Subagent PUT answers this status without touching the record. */
let failNextSubagentPut: { status: number; error: string } | null = null
/** While set, the next Subagent PUT waits for it before it reaches the route (a slow round trip). */
let holdNextSubagentPut: Promise<void> | null = null

function installRoutes() {
  puts = []
  agentReads = 0
  failNextSubagentPut = null
  holdNextSubagentPut = null
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]

    if (path === '/api/agents' && method === 'GET') {
      const agent = await redis.json.get(`agent:${AGENT}`)
      return jsonResponse({ agents: agent ? [agent] : [] })
    }
    if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
    if (path === `/api/agents/${AGENT}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      if (method !== 'PUT') agentReads += 1
      const handler = method === 'PUT' ? agentRoute.PUT : agentRoute.GET
      return (await handler({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/subagents' && method === 'GET') {
      const sub = await redis.json.get(`subagent:${SUB}`)
      return jsonResponse({ subagents: sub ? [sub] : [] })
    }
    if (path === `/api/subagents/${SUB}`) {
      const receipt = method === 'PUT' ? { body: JSON.parse(String(init.body)), settled: false } : null
      if (receipt) puts.push(receipt)
      try {
        if (method === 'PUT') {
          if (failNextSubagentPut) {
            const failure = failNextSubagentPut
            failNextSubagentPut = null
            return jsonResponse({ error: failure.error }, failure.status)
          }
          if (holdNextSubagentPut) {
            const gate = holdNextSubagentPut
            holdNextSubagentPut = null
            await gate
          }
        }
        const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
        const handler = method === 'PUT' ? subagentRoute.PUT : subagentRoute.GET
        return (await handler({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
      } finally {
        if (receipt) receipt.settled = true
      }
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: [PRESET_CHAT, PRESET_IMAGE] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function probeAgent() {
  return {
    id: AGENT,
    user_id: USER,
    displayName: 'Panel probe',
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET_CHAT as any),
    primary_model_connection: resolveSavedModelConnection(PRESET_CHAT as any),
    provider_specific_settings: { temperature: 0.7 }
  }
}

function subagentRecord(extra: Record<string, unknown> = {}) {
  return {
    id: SUB,
    user_id: USER,
    displayName: SUB_NAME,
    slug: SUB,
    subagentType: 'api',
    specialty: 'general',
    system_prompt: 'Answer only in haiku.',
    include_global_prompt: false,
    timeout_seconds: 45,
    ...buildPickedPresetModelFields(PRESET_CHAT as any),
    primary_model_connection: resolveSavedModelConnection(PRESET_CHAT as any),
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    ...extra
  }
}

async function seed(extra: Record<string, unknown> = {}) {
  await redis.json.set(`subagent:${SUB}`, '$', subagentRecord(extra) as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
  await redis.createAgent(probeAgent() as any)
}

async function storedSubagent() {
  return (await redis.json.get(`subagent:${SUB}`)) as Record<string, any>
}

/** A change made to the record after Settings opened: another tab, an agent tool. */
async function changeElsewhere(changes: Record<string, unknown>) {
  const record = await storedSubagent()
  await redis.json.set(`subagent:${SUB}`, '$', { ...record, ...changes, updated_at: new Date().toISOString() } as any)
}

/** Renders the panel on the probe agent, picks the Subagent, and waits past the autosave debounces. */
async function openSubagent() {
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Panel probe', {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  await pause(600)

  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(SUB_NAME, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  await screen.findByDisplayValue(SUB_NAME, {}, { timeout: 15_000 })
  await pause(1500)
}

async function typeName(from: string, to: string) {
  await fireEvent.input(screen.getByDisplayValue(from), { target: { value: to } })
}

async function typeTimeout(value: string) {
  const input = document.getElementById('subagent-timeout') as HTMLInputElement
  await fireEvent.input(input, { target: { value } })
}

async function toggleGlobalPrompt() {
  const row = screen
    .getByText('Include Global Custom Prompt', { selector: '.batshit-settings-parent-label' })
    .closest('.batshit-settings-toggle-row') as HTMLElement
  await fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement)
}

async function waitForPuts(count: number) {
  await waitFor(() => {
    expect(puts.length).toBe(count)
    expect(puts.every((receipt) => receipt.settled)).toBe(true)
  }, { timeout: 8_000 })
  // Let the save's answer land in the panel before the next step.
  await pause(400)
}

describe('a Subagent save sends only what the user changed (BL-844)', () => {
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

  it('a rename sends only the name, and a change made to the Subagent elsewhere after Settings opened survives it', async () => {
    await seed()
    await openSubagent()
    expect(puts).toEqual([])

    // A second window (or an agent tool) changes the timeout and the prompt after this panel opened.
    await changeElsewhere({ timeout_seconds: 90, system_prompt: 'Answer only in limericks.' })

    await typeName(SUB_NAME, 'Ss844 Renamed')
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ displayName: 'Ss844 Renamed' })
    const record = await storedSubagent()
    expect(record.displayName).toBe('Ss844 Renamed')
    expect(record.timeout_seconds).toBe(90)
    expect(record.system_prompt).toBe('Answer only in limericks.')
  }, 120_000)

  it('waits for a held save to finish before observing its stored result (BL-1238)', async () => {
    await seed()
    await openSubagent()
    await changeElsewhere({ timeout_seconds: 90, system_prompt: 'Answer only in limericks.' })

    let release!: () => void
    holdNextSubagentPut = new Promise<void>((resolve) => { release = resolve })
    let completed = false
    let completion: Promise<void> | undefined
    try {
      await typeName(SUB_NAME, 'Ss844 Held Rename')
      await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
      completion = waitForPuts(1).then(() => { completed = true })
      // Beyond the old helper's 400ms pause, the real route is still held.
      await pause(600)
      expect(completed).toBe(false)
      expect((await storedSubagent()).displayName).toBe(SUB_NAME)
    } finally {
      release()
      await completion
      // Drain the actual route even when the original helper fails this regression.
      await waitFor(async () => expect((await storedSubagent()).displayName).toBe('Ss844 Held Rename'), { timeout: 8_000 })
    }

    expect(puts[0].body).toEqual({ displayName: 'Ss844 Held Rename' })
    expect(await storedSubagent()).toMatchObject({
      displayName: 'Ss844 Held Rename',
      timeout_seconds: 90,
      system_prompt: 'Answer only in limericks.'
    })
  }, 120_000)

  it('each later edit sends only its own field: the baseline moves to what the last save stored', async () => {
    await seed()
    await openSubagent()

    await typeName(SUB_NAME, 'Ss844 Renamed')
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ displayName: 'Ss844 Renamed' })

    await typeTimeout('60')
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ timeout_seconds: 60 })

    await toggleGlobalPrompt()
    await waitForPuts(3)
    expect(puts[2].body).toEqual({ include_global_prompt: true })

    const record = await storedSubagent()
    expect(record).toMatchObject({
      displayName: 'Ss844 Renamed',
      timeout_seconds: 60,
      include_global_prompt: true,
      system_prompt: 'Answer only in haiku.'
    })
  }, 120_000)

  it('a failed save leaves the baseline as it was: the next edit sends the failed change again, with its own', async () => {
    await seed()
    await openSubagent()

    failNextSubagentPut = { status: 500, error: 'The Subagent could not be saved just now.' }
    await typeName(SUB_NAME, 'Ss844 Renamed')
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ displayName: 'Ss844 Renamed' })
    expect((await storedSubagent()).displayName).toBe(SUB_NAME)
    // The panel's usual visible error.
    expect(await screen.findByText(/The Subagent could not be saved just now\./)).toBeTruthy()

    await typeTimeout('60')
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ displayName: 'Ss844 Renamed', timeout_seconds: 60 })
    expect(await storedSubagent()).toMatchObject({ displayName: 'Ss844 Renamed', timeout_seconds: 60 })
  }, 120_000)

  it('a saved model the picker cannot select: an edit of another field carries no model keys (BL-834)', async () => {
    await seed({
      ...buildPickedPresetModelFields(PRESET_IMAGE as any),
      primary_model_connection: resolveSavedModelConnection(PRESET_IMAGE as any)
    })
    const before = await storedSubagent()
    await openSubagent()
    expect(puts).toEqual([])

    await typeName(SUB_NAME, 'Ss844 Renamed')
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ displayName: 'Ss844 Renamed' })
    const record = await storedSubagent()
    expect(record.primary_model_preset_id).toBe(PRESET_IMAGE.id)
    expect(record.primary_model_name).toBe(before.primary_model_name)
    expect(record.primary_model_provider).toBe(before.primary_model_provider)
    expect(record.primary_model_connection).toEqual(before.primary_model_connection)
  }, 120_000)

  it('emptying the last native-tool setting names that field as null, and the record keeps no native-tool settings (BL-914: the route writes key by key, so {} would remove nothing)', async () => {
    await seed({ provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *'] } } })
    await openSubagent()

    // Access tab: the Subagent's Always Block List, emptied in its editor.
    const blockListRow = screen.getByText('rm -rf *').closest('.batshit-settings-muted-panel') as HTMLElement
    await fireEvent.click(within(blockListRow).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('rm -rf *')
    await fireEvent.input(editor, { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ provider_specific_settings: { nativeTools: { bashNeverAllowList: null } } })
    expect((await storedSubagent()).provider_specific_settings).toEqual({ nativeTools: {} })
  }, 120_000)

  it('a Subagent whose form differs from its record only where the save does not see it saves nothing on open', async () => {
    // An API Subagent keeps no workflow URL: the form empties a stale one on open, which changes
    // the form's signature but nothing the save would send.
    await seed({ webhook_url: 'https://n8n.example.com/webhook/stale', webhookUrl: 'https://n8n.example.com/webhook/stale' })
    const before = await storedSubagent()
    await openSubagent()

    expect(puts).toEqual([])
    expect(await storedSubagent()).toEqual(before)
  }, 120_000)
})

describe('a Subagent save that lands keeps what was typed while it was in flight (BL-844, review fix)', () => {
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

  /**
   * Types `first`, waits until its save is on the wire (held), types `second` during the round
   * trip, and lets the save land. Returns the field, with the second save (built from `second`)
   * still waiting in its 700 ms debounce.
   */
  async function typeDuringASave(first: string, second: string) {
    await seed()
    await openSubagent()
    let release: () => void = () => {}
    holdNextSubagentPut = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(input, { target: { value: first } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ displayName: first })

    await fireEvent.input(input, { target: { value: second } })
    release()
    // The save landed (the record holds `first`), and the second save has not fired yet.
    await waitFor(async () => expect((await storedSubagent()).displayName).toBe(first), { timeout: 8_000 })
    await pause(200)
    expect(puts.length).toBe(1)
    return input
  }

  it('the field still shows the text typed during the round trip, and the next save sends exactly that text', async () => {
    const input = await typeDuringASave('Ss844 R', 'Ss844 R!')

    expect(input.value).toBe('Ss844 R!')
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ displayName: 'Ss844 R!' })
    await pause(400)
    expect((await storedSubagent()).displayName).toBe('Ss844 R!')
    expect(input.value).toBe('Ss844 R!')
    // Nothing else follows: the form equals what was saved.
    await pause(1200)
    expect(puts.length).toBe(2)
  }, 120_000)

  it('typing on after the save landed adds to the text that was typed during it: no character is lost', async () => {
    const input = await typeDuringASave('Ss844 R', 'Ss844 R!')

    // The user keeps typing at the end of what the field shows.
    await fireEvent.input(input, { target: { value: `${input.value}?` } })

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ displayName: 'Ss844 R!?' })
    await pause(400)
    expect((await storedSubagent()).displayName).toBe('Ss844 R!?')
    expect(input.value).toBe('Ss844 R!?')
  }, 120_000)

  it('a change made elsewhere during the round trip shows in the form once nothing is left unsaved', async () => {
    await seed()
    await openSubagent()
    let release: () => void = () => {}
    holdNextSubagentPut = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'Ss844 R' } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    // Another window changes the timeout while the save is in flight, and nothing more is typed here.
    await changeElsewhere({ timeout_seconds: 90 })
    release()

    await waitFor(() => expect((document.getElementById('subagent-timeout') as HTMLInputElement).value).toBe('90'), {
      timeout: 8_000
    })
    expect(input.value).toBe('Ss844 R')
    await pause(1500)
    // Picking the record up is not an edit: nothing is sent for it.
    expect(puts.length).toBe(1)
  }, 120_000)

  it('a prompt saved from its editor while a name was being typed: both are in the form, and only the name is saved after', async () => {
    await seed()
    await openSubagent()

    const instructionsTab = screen.getAllByRole('tab').find((element) => /Instructions/.test(element.textContent ?? ''))
    await fireEvent.mouseDown(instructionsTab as HTMLElement)
    await fireEvent.click(instructionsTab as HTMLElement)
    const promptRow = screen
      .getAllByText('Custom System Prompt')
      .map((element) => element.closest('.batshit-settings-form-row') as HTMLElement | null)
      .find((row) => row && row.closest('details[name="subagent-instructions-cards"]'))
    await fireEvent.click(within(promptRow!).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('Answer only in haiku.')
    await fireEvent.input(editor, { target: { value: 'Answer in limericks.' } })
    const dialog = editor.closest('[role="dialog"]') as HTMLElement
    const saveButton = within(dialog)
      .getAllByRole('button')
      .find((button) => /^Save/.test((button.textContent ?? '').trim()))

    let release: () => void = () => {}
    holdNextSubagentPut = new Promise<void>((resolve) => {
      release = resolve
    })
    await fireEvent.click(saveButton as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ system_prompt: 'Answer in limericks.' })

    // A name typed during the prompt's round trip: the form is not clean when the prompt lands.
    const nameInput = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: 'Ss844 R' } })
    release()

    // The name goes on its own: the prompt is in the form, so it is no difference from the baseline.
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ displayName: 'Ss844 R' })
    await pause(400)
    const record = await storedSubagent()
    expect(record.displayName).toBe('Ss844 R')
    expect(record.system_prompt).toBe('Answer in limericks.')
    expect(nameInput.value).toBe('Ss844 R')
    await pause(1200)
    expect(puts.length).toBe(2)
  }, 120_000)

  it('a prompt saved from its editor is in the form afterwards, and nothing is saved for it again', async () => {
    await seed()
    await openSubagent()

    const instructionsTab = screen.getAllByRole('tab').find((element) => /Instructions/.test(element.textContent ?? ''))
    expect(instructionsTab).toBeTruthy()
    await fireEvent.mouseDown(instructionsTab as HTMLElement)
    await fireEvent.click(instructionsTab as HTMLElement)
    const openEditor = async () => {
      const promptRow = screen
        .getAllByText('Custom System Prompt')
        .map((element) => element.closest('.batshit-settings-form-row') as HTMLElement | null)
        .find((row) => row && row.closest('details[name="subagent-instructions-cards"]'))
      expect(promptRow).toBeTruthy()
      await fireEvent.click(within(promptRow!).getByRole('button', { name: /Edit/ }))
    }
    await openEditor()
    const editor = await screen.findByDisplayValue('Answer only in haiku.')
    await fireEvent.input(editor, { target: { value: 'Answer in limericks.' } })
    const dialog = editor.closest('[role="dialog"]') as HTMLElement
    const saveButton = within(dialog)
      .getAllByRole('button')
      .find((button) => /^Save/.test((button.textContent ?? '').trim()))
    await fireEvent.click(saveButton as HTMLElement)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ system_prompt: 'Answer in limericks.' })
    expect((await storedSubagent()).system_prompt).toBe('Answer in limericks.')
    // The form holds the saved prompt: the editor opens on it, and no second save follows.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5_000 })
    await openEditor()
    expect(await screen.findByDisplayValue('Answer in limericks.')).toBeTruthy()
    await pause(1500)
    expect(puts.length).toBe(1)
  }, 120_000)
})
