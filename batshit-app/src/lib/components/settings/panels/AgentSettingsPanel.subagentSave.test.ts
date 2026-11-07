import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { loadAgentRoute } from '$lib/test-utils/agentPutRoute'

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

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`]),
  // A CLI Subagent's native save stages its managed Claude profile; never the real home here.
  prepareManagedClaudeSubagentProfile: vi.fn(async () => {})
}))

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
let puts: Array<{ body: Record<string, any>; settled: boolean; status?: number }> = []
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
        const response = (await handler({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
        if (receipt) (receipt as typeof puts[number]).status = response.status
        return response
      } finally {
        if (receipt) receipt.settled = true
      }
    }
    if (path === '/api/user/saved-models') return jsonResponse({ models: [PRESET_CHAT, PRESET_IMAGE] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
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

  beforeEach(async () => {
    agentRoute = await loadAgentRoute()
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

  it('the real Subagent route keeps an ordinary API native DTO token-free and never stores a codex_settings or claude_settings block', async () => {
    await seed()
    const response = await subagentRoute.PUT({ params: { id: SUB }, locals: { user: { id: USER } },
      request: new Request(`http://localhost/api/subagents/${SUB}`, { method: 'PUT', body: JSON.stringify({
        codex_settings: { permissionMode: 'chat', model: 'custom-codex' }, claude_settings: { permissionMode: 'default', model: 'custom-claude' }
      }) }) } as any)
    expect(response.status).toBe(200)
    const record = await redis.json.get(`subagent:${SUB}`) as Record<string, unknown>
    expect(record).toMatchObject({ subagentType: 'api' })
    // SA-139 R1: Codex CLI was removed; a body's `codex_settings` is dropped, never stored.
    expect(record).not.toHaveProperty('codex_settings')
    // SA-139 R5: the Claude Code CLI Subagent was removed too; a body's `claude_settings` is dropped.
    expect(record).not.toHaveProperty('claude_settings')
  })
  // SA-139 R5: the CLI Subagent's native-only model save (and its model-selection publish) left
  // with that type; a PUT on a leftover is refused before any write (the route's own tests).

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
    expect(puts[2].body).toEqual({ include_global_prompt: true, expectedInstructions: { includeGlobalPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } })

    const record = await storedSubagent()
    expect(record).toMatchObject({
      displayName: 'Ss844 Renamed',
      timeout_seconds: 60,
      include_global_prompt: true,
      system_prompt: 'Answer only in haiku.'
    })
  }, 120_000)

  it('delegation limits: a 24-hour Call Timeout and Max Tool Steps each save only their own field', async () => {
    await seed()
    await openSubagent()

    // Decision 4: up to 24 hours; the panel says the limit the way a person reads it.
    await typeTimeout('86400')
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ timeout_seconds: 86_400 })
    expect(await screen.findByText('24 hours')).toBeTruthy()
    // Blank is no limit, and says so.
    expect((document.getElementById('subagent-timeout') as HTMLInputElement).placeholder).toBe('No limit')

    // Decision 3: an optional per-Subagent tool-step limit.
    const steps = document.getElementById('subagent-max-tool-steps') as HTMLInputElement
    expect(steps.placeholder).toBe('No limit')
    await fireEvent.input(steps, { target: { value: '25' } })
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ max_tool_steps: 25 })

    await fireEvent.input(steps, { target: { value: '' } })
    await waitForPuts(3)
    expect(puts[2].body).toEqual({ max_tool_steps: null })
    const record = await storedSubagent()
    expect(record.timeout_seconds).toBe(86_400)
    expect(record).not.toHaveProperty('max_tool_steps')
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
    // SA-139 R2: the form has no workflow URL any more. A stale one left on an API record is ignored,
    // so opening the Subagent changes nothing the save would send.
    await seed({ webhook_url: 'https://n8n.example.com/webhook/stale', webhookUrl: 'https://n8n.example.com/webhook/stale' })
    const before = await storedSubagent()
    await openSubagent()

    expect(puts).toEqual([])
    expect(await storedSubagent()).toEqual(before)
  }, 120_000)
})

describe('a Subagent save that lands keeps what was typed while it was in flight (BL-844, review fix)', () => {
  const originalFetch = global.fetch

  beforeEach(async () => {
    agentRoute = await loadAgentRoute()
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
    expect(puts[0].body).toEqual({ system_prompt: 'Answer in limericks.', expectedInstructions: { customPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } })

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
    expect(puts[0].body).toEqual({ system_prompt: 'Answer in limericks.', expectedInstructions: { customPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } })
    expect((await storedSubagent()).system_prompt).toBe('Answer in limericks.')
    // The form holds the saved prompt: the editor opens on it, and no second save follows.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5_000 })
    await openEditor()
    expect(await screen.findByDisplayValue('Answer in limericks.')).toBeTruthy()
    await pause(1500)
    expect(puts.length).toBe(1)
  }, 120_000)

  // SA-139 R5: the `cli` half left; a leftover CLI Subagent shows no Instructions tab.
  it.each(['api'])('keeps a %s Subagent prompt draft on original-base conflict without replaying', async subagentType => {
    await seed({ subagentType })
    await openSubagent()
    const instructionsTab = screen.getAllByRole('tab').find(element => /Instructions/.test(element.textContent ?? ''))!
    await fireEvent.mouseDown(instructionsTab); await fireEvent.click(instructionsTab)
    const promptRow = screen.getAllByText('Custom System Prompt').map(element => element.closest('.batshit-settings-form-row') as HTMLElement | null).find(row => row?.closest('details[name="subagent-instructions-cards"]'))!
    await fireEvent.click(within(promptRow).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('Answer only in haiku.') as HTMLTextAreaElement
    await fireEvent.input(editor, { target: { value: '  Keep my draft.  ' } })
    await changeElsewhere({ system_prompt: 'Remote instructions.' })
    await fireEvent.click(within(editor.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: /Save Changes/ }))
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ system_prompt: 'Keep my draft.', expectedInstructions: { customPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } })
    await waitFor(() => expect(screen.getByTestId('subagent-instructions-notice').textContent).toContain('not saved'), { timeout: 8_000 })
    expect(editor.value).toBe('  Keep my draft.  ')
    expect((await storedSubagent()).system_prompt).toBe('Remote instructions.')
    await pause(1000)
    expect(puts).toHaveLength(1)
  }, 120_000)

  it('keeps an actually saved Subagent prompt unconfirmed after the route loses its postwrite read and returns404 (BL-1668)', async () => {
    await seed()
    await openSubagent()
    const instructionsTab = screen.getAllByRole('tab').find(element => /Instructions/.test(element.textContent ?? ''))!
    await fireEvent.mouseDown(instructionsTab); await fireEvent.click(instructionsTab)
    const promptRow = screen.getAllByText('Custom System Prompt').map(element => element.closest('.batshit-settings-form-row') as HTMLElement | null).find(row => row?.closest('details[name="subagent-instructions-cards"]'))!
    await fireEvent.click(within(promptRow).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('Answer only in haiku.') as HTMLTextAreaElement
    await fireEvent.input(editor, { target: { value: '  Keep the issued draft.  ' } })
    const actualUpdate = vi.isMockFunction(redis.updateSubagent) ? vi.mocked(redis.updateSubagent).getMockImplementation()! : redis.updateSubagent.bind(redis)
    const actualGet = vi.isMockFunction(redis.json.get) ? vi.mocked(redis.json.get).getMockImplementation()! : redis.json.get.bind(redis.json)
    const updateSpy = vi.spyOn(redis, 'updateSubagent')
    const getSpy = vi.spyOn(redis.json, 'get')
    let missPostwriteRead = false
    let committedPrompt: unknown
    await updateSpy.withImplementation(async (...args) => {
      const saved = await actualUpdate(...args)
      if (args[0] === SUB && Object.hasOwn(args[1], 'system_prompt')) {
        committedPrompt = ((await actualGet(`subagent:${SUB}`)) as Record<string, unknown>).system_prompt
        expect(committedPrompt).toBe('Keep the issued draft.')
        missPostwriteRead = true
      }
      return saved
    }, async () => {
      await getSpy.withImplementation(async (...args) => {
        if (missPostwriteRead && args[0] === `subagent:${SUB}`) { missPostwriteRead = false; return null }
        return actualGet(...args)
      }, async () => {
        const save = within(editor.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: /Save Changes/ })
        await fireEvent.click(save)
        await waitForPuts(1)
        expect(committedPrompt).toBe('Keep the issued draft.')
        expect(puts[0].status).toBe(404)
        expect(screen.getByTestId('subagent-instructions-notice').textContent).toContain('unconfirmed')
        expect(editor.value).toBe('  Keep the issued draft.  ')
        expect((await actualGet(`subagent:${SUB}`) as Record<string, unknown>).system_prompt).toBe('Keep the issued draft.')
        await fireEvent.click(save)
        await pause(1000)
        expect(puts).toHaveLength(1)
        expect(screen.getByTestId('subagent-instructions-notice').textContent).toContain('unconfirmed')
      })
    })
  }, 120_000)

  it('drains a Subagent instructions readback after a held GET while a later invalid core draft blocks the at-rest fallback (BL-1670)', async () => {
    await seed()
    await openSubagent()
    const openEditor = async (text: string) => {
      const tab = screen.getAllByRole('tab').find(element => /Instructions/.test(element.textContent ?? ''))!
      await fireEvent.mouseDown(tab); await fireEvent.click(tab)
      const row = screen.getAllByText('Custom System Prompt').map(element => element.closest('.batshit-settings-form-row') as HTMLElement | null).find(row => row?.closest('details[name="subagent-instructions-cards"]'))!
      await fireEvent.click(within(row).getByRole('button', { name: /Edit/ }))
      const editor = await screen.findByDisplayValue(text) as HTMLTextAreaElement
      return { editor, save: within(editor.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: /Save Changes/ }) }
    }
    let releasePut = () => {}
    let releaseRead = () => {}
    holdNextSubagentPut = new Promise<void>(resolve => { releasePut = resolve })
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const originalGet = subagentRoute.GET
    let readCaptured = false
    let capturedPrompt: unknown
    const getSpy = vi.spyOn(subagentRoute, 'GET').mockImplementationOnce(async event => {
      const response = await originalGet(event)
      capturedPrompt = (await response.clone().json()).subagent.system_prompt
      readCaptured = true
      await readGate
      return response
    })
    try {
      const { editor, save } = await openEditor('Answer only in haiku.')
      await fireEvent.input(editor, { target: { value: 'Answer in limericks.' } })
      await fireEvent.click(save)
      await waitFor(() => expect(puts).toHaveLength(1), { timeout: 8_000 })
      // An edit queued after the admitted save must survive its older landing.
      await fireEvent.input(document.getElementById('subagent-display')!, { target: { value: '' } })
      const notice = await screen.findByTestId('subagent-settings-read-wait')
      await fireEvent.click(within(notice).getByRole('button', { name: /Retry/, hidden: true }))
      await waitFor(() => expect(readCaptured).toBe(true), { timeout: 8_000 })
      expect(capturedPrompt).toBe('Answer only in haiku.')
      releasePut()
      await waitForPuts(1)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5_000 })
      releaseRead()
      await waitFor(() => expect(screen.queryByText('Loading subagent…')).toBeNull(), { timeout: 8_000 })
      const reopened = await openEditor('Answer in limericks.')
      expect((document.getElementById('subagent-display') as HTMLInputElement).value).toBe('')
      expect(puts).toHaveLength(1)
      // Subagent manual saves validate its whole core form. Deliberately return the
      // unrelated name to its original value; that correction itself writes nothing.
      await fireEvent.click(within(reopened.editor.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: /Cancel/ }))
      await fireEvent.input(document.getElementById('subagent-display')!, { target: { value: SUB_NAME } })
      const next = await openEditor('Answer in limericks.')
      await fireEvent.input(next.editor, { target: { value: 'Answer in couplets.' } })
      await fireEvent.click(next.save)
      await waitForPuts(2)
      expect(puts[1].body).toEqual({ system_prompt: 'Answer in couplets.', expectedInstructions: { customPrompt: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } })
      expect(puts[1].body.expectedInstructions.customPrompt).not.toBe(puts[0].body.expectedInstructions.customPrompt)
      expect(await storedSubagent()).toMatchObject({ displayName: SUB_NAME, system_prompt: 'Answer in couplets.' })
    } finally {
      releasePut(); releaseRead(); getSpy.mockRestore()
    }
  }, 120_000)
})
