import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { setUserSettings } from '$lib/stores/userSettings.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { loadAgentRoute } from '$lib/test-utils/agentPutRoute'
import type { TypedFileToolsHost } from '$lib/utils/typedFileToolsGrant'

/** Real mounted panel + existing route harness. Real Redis lane proves actual original-base saves;
 * the default fake does not establish the new Lua/ACK contract. */

// Round 2 (S1): the dead-copies store is the one thing observed; every other export is the real one.
const deadCopies = vi.hoisted(() => ({ refreshAll: vi.fn(async () => {}) }))
vi.mock('$lib/stores/zipDeadCopies.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/zipDeadCopies.svelte')>()),
  refreshAllDeadCopies: deadCopies.refreshAll
}))

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
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

useSkillSessionRedisTestServer()

const USER = 'typedrow_user'
const AGENT = 'typedrow_agent'
const SUB = 'typedrow_subagent'
const SUB_NAME = 'Typed Child'

type Preset = Record<string, any>

const PRESET_A: Preset = {
  id: 'typedrow_preset_a',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7, maxTokens: 4000 }
}
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
let puts: Array<{ body: Record<string, any>; path?: string }> = []
let agentReads = 0
/** BL-2049: the full sandbox probes (not `?hostOnly=1`) never answer, as when `sbx` hangs. */
let fullProbePending = false
let sandboxHost: TypedFileToolsHost = { platform: 'darwin', containerized: false, linuxKernel: null }

function installRoutes() {
  puts = []
  agentReads = 0
  fullProbePending = false
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
    if (path === '/api/subagents' && method === 'GET') {
      const row = await redis.json.get(`subagent:${SUB}`)
      return jsonResponse({ subagents: row ? [row] : [] })
    }
    if (path === `/api/subagents/${SUB}`) {
      const route = await import('../../../../routes/api/subagents/[id]/+server')
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      if (method === 'PUT') puts.push({ body: JSON.parse(String(init.body)), path })
      return (await (method === 'PUT' ? route.PUT : route.GET)({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/native-tools/sandbox/status') {
      if (fullProbePending && !url.includes('hostOnly=1')) return await new Promise<Response>(() => {})
      return jsonResponse({ success: true, available: true, supported: true, containerized: false,
        backend: url.includes('apple_container') ? 'apple_container' : 'docker_sandbox',
        policy: 'test', version: 'test', reason: null,
        typedFileToolsHost: sandboxHost })
    }
    if (path === '/api/user/saved-models') {
      return jsonResponse({ models: [PRESET_A] })
    }
    if (path === '/api/models') {
      return jsonResponse({ data: { connections: [] } })
    }
    if (path === '/api/settings/api-keys') {
      return jsonResponse({ keys: {} })
    }
    if (path === '/api/goons') {
      return jsonResponse({ ownerId: 'josh', goons: [] })
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

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 5_000 })
  // Let the save's answer land in the panel before the next step.
  await pause(50)
}

describe('Agent Settings: the Typed File Tools row (SA-136 P4)', () => {
  const originalFetch = global.fetch

  beforeEach(async () => {
    sandboxHost = { platform: 'darwin', containerized: false, linuxKernel: null }
    if (process.env.VITEST_USE_REAL_REDIS === 'true') {
      await redis.json.set(`model:${PRESET_A.id}`, '$', PRESET_A)
      await redis.sAdd(`user:${USER}:models`, PRESET_A.id)
      await redis.del(`subagent:${SUB}`)
      await redis.del(`user:${USER}:subagents`)
    }
    routeModule = await loadAgentRoute()
    ensureBrowserStubs()
    installRoutes()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    global.fetch = originalFetch
    agentStore.setAgents([])
    setUserSettings(null)
  })

  async function openToolsTab() {
    await fireEvent.click(screen.getByRole('tab', { name: 'Tools', exact: true }))
    const batshit = await screen.findByText('Batshit Tools', { selector: '.batshit-settings-tool-grid-name' })
    await fireEvent.click(batshit)
    return await screen.findByTestId('typed-file-tools-enable', {}, { timeout: 5_000 })
  }

  async function choose(name: string) {
    const checkbox = await screen.findByTestId('typed-file-tools-enable')
    if ((checkbox.getAttribute('aria-checked') === 'true') !== (name === 'Enabled')) await fireEvent.click(checkbox)
  }

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('moves grants into one Enable column and preserves blank file cells', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
    const real = global.fetch
    global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input).split('?')[0]
      if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
      if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
      return real(input, init)
    }) as typeof fetch
    await openPanel(); await openToolsTab()
    expect(screen.getAllByRole('checkbox', { name: 'Enable Bash' })).toHaveLength(1)
    expect(screen.getByRole('checkbox', { name: 'Enable Typed File Tools' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('Agent Browser Extra CLI Flags')).toBeNull()
    const read = await screen.findByText('Read File', { selector: '.batshit-settings-tool-grid-name' })
    expect(read.closest('tr')?.querySelectorAll('td')[1]?.querySelector('[role="checkbox"]')).toBeNull()
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Web Search' }))
    await waitForPuts(1)
    expect(puts[0].body.provider_specific_settings).toEqual({ nativeTools: { webSearchEnabled: false } })
    expect((await stored()).provider_specific_settings.nativeTools.webSearchEnabled).toBe(false)
    expect(await screen.findByRole('checkbox', { name: 'Enable Typed File Tools' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Enable MCP Tools' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Enable CLI Tools' })).toBeTruthy()
  }, 60_000)

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('keeps an explicit choice independent of old globals and saves both boolean choices with original bases', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
    setUserSettings({ global_tool_grid_settings: { typed_file_tools: true } } as any)
    await openPanel()
    const trigger = await openToolsTab()
    expect(trigger).toHaveAttribute('aria-checked', 'false')
    expect(puts).toEqual([])
    setUserSettings({ global_tool_grid_settings: { typed_file_tools: false } } as any)
    await waitFor(() => expect(screen.getByTestId('typed-file-tools-enable')).toHaveAttribute('aria-checked', 'false'))
    await choose('Enabled')
    await waitForPuts(1)
    expect(puts[0].body.provider_specific_settings).toEqual({ nativeTools: { typedFileToolsEnabled: true } })
    expect(puts[0].body.expectedTypedFileTools).toMatch(/^sha256:/)
    expect((await stored()).provider_specific_settings.nativeTools).toEqual({ bashEnabled: true, executionBackend: 'local', typedFileToolsEnabled: true, artifactRuntimeEnabled: true })
    await choose('Disabled')
    await waitForPuts(2)
    expect(puts[1].body.provider_specific_settings).toEqual({ nativeTools: { typedFileToolsEnabled: false } })
    expect(puts[1].body.expectedTypedFileTools).not.toBe(puts[0].body.expectedTypedFileTools)
    expect((await stored()).provider_specific_settings.nativeTools).toEqual({ bashEnabled: true, executionBackend: 'local', typedFileToolsEnabled: false, artifactRuntimeEnabled: true })
    expect(await stored()).not.toHaveProperty('expectedTypedFileTools')
  }, 60_000)

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('blocks a missing original header and recovers by reading without a hydration PUT', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
    const real = global.fetch; let omit = true
    // Only this owned detail response loses its request-only metadata.
    global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const result = await real(input, init)
      if (String(input).split('?')[0] === `/api/agents/${AGENT}` && (init.method ?? 'GET') === 'GET' && omit) result.headers.delete('x-batshit-typed-file-tools-revision')
      return result
    }) as typeof fetch
    await openPanel(); const trigger = await openToolsTab()
    expect(trigger.hasAttribute('disabled') || trigger.getAttribute('data-disabled') !== null).toBe(true)
    expect(puts).toEqual([])
    omit = false
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Choice' }))
    await waitFor(() => expect(screen.getByTestId('typed-file-tools-enable').hasAttribute('disabled') || screen.getByTestId('typed-file-tools-enable').getAttribute('data-disabled') !== null).toBe(false))
    await pause(900); expect(puts).toEqual([])
    await choose('Enabled'); await waitForPuts(1)
    expect((await stored()).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(true)
  }, 60_000)

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('keeps a conflicted choice and unrelated dirty name until deliberate group recovery', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
    await openPanel(); await openToolsTab()
    await redis.json.set(`agent:${AGENT}`, '$.provider_specific_settings.nativeTools.typedFileToolsEnabled', true)
    await choose('Enabled'); await waitForPuts(1)
    await screen.findByText('The saved choice changed. Your draft was not saved.')
    const name = screen.getByDisplayValue('Panel probe')
    await fireEvent.input(name, { target: { value: '' } })
    await pause(900); expect(puts).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Choice' }))
    await waitFor(() => expect(screen.queryByText('The saved choice changed. Your draft was not saved.')).toBeNull())
    expect((name as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('typed-file-tools-enable')).toHaveAttribute('aria-checked', 'true')
    await pause(900); expect(puts).toHaveLength(1)
  }, 60_000)

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('keeps a lost receipt unknown, reads explicitly and sends only a later deliberate choice', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
    const real = global.fetch; let drop = true
    global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const result = await real(input, init)
      if (String(input).split('?')[0] === `/api/agents/${AGENT}` && (init.method ?? 'GET') === 'PUT' && drop) { drop = false; return jsonResponse({ error: 'Lost saved receipt' }, 503) }
      return result
    }) as typeof fetch
    await openPanel(); await openToolsTab(); await choose('Enabled'); await waitForPuts(1)
    await screen.findByText('This choice is unconfirmed. Your draft is kept.')
    expect((await stored()).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Choice' }))
    await screen.findByText('An earlier save remains unconfirmed.')
    await pause(900); expect(puts).toHaveLength(1)
    await choose('Disabled'); await waitForPuts(2)
    expect(puts[1].body.expectedTypedFileTools).not.toBe(puts[0].body.expectedTypedFileTools)
    expect((await stored()).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(false)
  }, 60_000)

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('preserves the in-flight source and permits a new choice only after its saved receipt', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
    const real = global.fetch; let release!: () => void, received!: () => void, first = true
    const held = new Promise<void>(resolve => { release = resolve }), saved = new Promise<void>(resolve => { received = resolve })
    global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const result = await real(input, init)
      if (String(input).split('?')[0] === `/api/agents/${AGENT}` && (init.method ?? 'GET') === 'PUT' && first) { first = false; received(); await held }
      return result
    }) as typeof fetch
    try {
      await openPanel(); await openToolsTab(); await choose('Enabled'); await saved
      expect((screen.getByTestId('typed-file-tools-enable').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
      expect(puts).toHaveLength(1)
      expect(screen.getByTestId('typed-file-tools-enable')).toHaveAttribute('aria-checked', 'true')
    } finally { release() }
    await waitFor(() => expect((screen.getByTestId('typed-file-tools-enable').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false))
    await choose('Disabled')
    await waitForPuts(2)
    expect(puts.map(row => row.body.provider_specific_settings.nativeTools.typedFileToolsEnabled)).toEqual([true, false])
    expect(puts[1].body.expectedTypedFileTools).not.toBe(puts[0].body.expectedTypedFileTools)
    expect((await stored()).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(false)
  }, 60_000)

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('owns Subagent detail bases and receipts separately from the Primary form', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
    await redis.json.set(`subagent:${SUB}`, '$', { id: SUB, user_id: USER, displayName: SUB_NAME, subagentType: 'api', created_at: 'child-birth',
      ...buildPickedPresetModelFields(PRESET_A as any), provider_specific_settings: { nativeTools: { bashEnabled: true, executionBackend: 'local', typedFileToolsEnabled: false } } })
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    await openPanel()
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Select Agents & Subagents' }), { key: 'ArrowDown' })
    const item = await screen.findByText(SUB_NAME, { selector: '.batshit-settings-action-row-title' })
    await fireEvent.click(item.closest('button') as HTMLElement)
    await screen.findByDisplayValue(SUB_NAME)
    await pause(900); await openToolsTab()
    expect(puts).toEqual([])
    expect(screen.getByTestId('typed-file-tools-enable')).toHaveAttribute('aria-checked', 'false')
    await choose('Enabled'); await waitForPuts(1)
    expect(puts[0].path).toBe(`/api/subagents/${SUB}`)
    expect(puts[0].body.expectedTypedFileTools).toMatch(/^sha256:/)
    expect((await redis.json.get(`subagent:${SUB}`) as any).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(true)
    await choose('Disabled'); await waitForPuts(2)
    expect(puts[1].body.expectedTypedFileTools).not.toBe(puts[0].body.expectedTypedFileTools)
    expect((await redis.json.get(`subagent:${SUB}`) as any).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(false)
    expect((await stored()).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(false)
  }, 60_000)

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('classifies the existing Subagent co-save no-write code as conflict instead of unknown', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
    await redis.json.set(`subagent:${SUB}`, '$', { id: SUB, user_id: USER, displayName: SUB_NAME, subagentType: 'api', created_at: 'child-birth',
      ...buildPickedPresetModelFields(PRESET_A as any), provider_specific_settings: { nativeTools: { bashEnabled: true, executionBackend: 'local', typedFileToolsEnabled: false } } })
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    const real = global.fetch
    // HTTP classifier discriminator only. Actual compound atomic refusal is proved by the backend suite.
    global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).split('?')[0] === `/api/subagents/${SUB}` && (init.method ?? 'GET') === 'PUT') {
        puts.push({ body: JSON.parse(String(init.body)), path: `/api/subagents/${SUB}` })
        return jsonResponse({ error: 'Saved instructions changed. Nothing was saved.', code: 'instructions_settings_changed' }, 409)
      }
      return real(input, init)
    }) as typeof fetch
    await openPanel()
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Select Agents & Subagents' }), { key: 'ArrowDown' })
    const item = await screen.findByText(SUB_NAME, { selector: '.batshit-settings-action-row-title' })
    await fireEvent.click(item.closest('button') as HTMLElement)
    await screen.findByDisplayValue(SUB_NAME); await pause(900); await openToolsTab()
    await choose('Enabled'); await waitForPuts(1)
    expect(puts[0].body.provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(true)
    await waitFor(() => expect(screen.queryByText('The saved choice changed. Your draft was not saved.') || screen.queryByText('This choice is unconfirmed. Your draft is kept.')).toBeTruthy())
    expect(screen.queryByText('This choice is unconfirmed. Your draft is kept.')).toBeNull()
    expect(screen.queryByText('The saved choice changed. Your draft was not saved.')).toBeTruthy()
    expect((await redis.json.get(`subagent:${SUB}`) as any).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(false)
    await pause(900); expect(puts).toHaveLength(1)
  }, 60_000)

  it('admits the qualified Apple mount while keeping Docker Sandbox unavailable', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'apple_container', typedFileToolsEnabled: true } }) as any)
    await openPanel()
    await openToolsTab()
    await waitFor(() => expect(screen.queryByText('Checking typed file tools availability.')).toBeNull())
    expect(screen.queryByText('Typed file tools are not qualified with this Sandbox Level yet.')).toBeNull()
    expect(screen.queryByText('Needs the Bash Tool.')).toBeNull()
  }, 60_000)

  // BL-2049 (review: the same stall beside the Refreshed File Reads switch): the row reads the host
  // facts alone (`?hostOnly=1`), so a hanging `sbx` probe never leaves it checking.
  it('settles from the host facts alone while the full sandbox probe never answers', async () => {
    fullProbePending = true
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'apple_container', typedFileToolsEnabled: true } }) as any)
    await openPanel()
    await openToolsTab()
    await waitFor(() => expect(screen.queryByText('Checking typed file tools availability.')).toBeNull(), { timeout: 8_000 })
    expect(screen.queryByText('Typed file tools are not qualified with this Sandbox Level yet.')).toBeNull()
  }, 60_000)

  it('Dangerous Local and default Apple mode both follow the same qualified Mac host facts', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, bashAccessMode: 'dangerous', typedFileToolsEnabled: true } }) as any)
    const view = await openPanel()
    await openToolsTab()
    await waitFor(() => expect(screen.queryByText('Checking typed file tools availability.')).toBeNull())
    expect(screen.queryByText('Typed file tools are not qualified with this Sandbox Level yet.')).toBeNull()
    view.unmount()
    agentStore.setAgents([])
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, bashAccessMode: 'agent', typedFileToolsEnabled: true } }) as any)
    await openPanel()
    await openToolsTab()
    await waitFor(() => expect(screen.queryByText('Checking typed file tools availability.')).toBeNull())
    expect(screen.queryByText('Typed file tools are not qualified with this Sandbox Level yet.')).toBeNull()
  }, 60_000)

  it('offers qualified native Mac Docker without changing the saved grant during hydration', async () => {
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'docker_sandbox', typedFileToolsEnabled: true } }) as any)
    await openPanel()
    await openToolsTab()
    await waitFor(() => expect(screen.queryByText('Checking typed file tools availability.')).toBeNull())
    expect(screen.queryByText('Typed file tools are not qualified with this Sandbox Level yet.')).toBeNull()
    expect(puts).toEqual([])
  }, 60_000)

  it.each([
    { backend: 'local', configured: false, available: true },
    { backend: 'docker_sandbox', configured: true, available: true },
    { backend: 'docker_sandbox', configured: false, available: false }
  ])('uses app-container server facts for $backend, operator configured $configured', async ({ backend, configured, available }) => {
    sandboxHost = { platform: 'linux', containerized: true, linuxKernel: '7.0.14-linuxkit', dockerSandboxOperatorConfigured: configured }
    await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: backend, typedFileToolsEnabled: true } }) as any)
    await openPanel()
    await openToolsTab()
    await waitFor(() => expect(screen.queryByText('Checking typed file tools availability.')).toBeNull())
    const reason = 'Typed file tools with Docker Sandbox need the configured host operator and a host bind workspace.'
    if (available) expect(screen.queryByText(reason)).toBeNull()
    else expect(await screen.findByText(reason)).toBeTruthy()
    expect(puts).toEqual([])
  }, 60_000)

  // SA-139 R5: the Claude Code CLI Subagent's disabled typed-file row and its sentence left with
  // that type; a leftover shows no Tools tab (`AgentSettingsPanel.retiredCliSubagentOpen.test.ts`).

  // Round 2 (S1): Refreshed File Reads is available only while the agent's type, Bash command
  // location and permissions mode allow it (the one shared rule), and the badges' facts say "still
  // current" only while it holds. So a save that moves the location or the mode asks every chat's
  // facts again, once it has landed; a save of anything else the panel sends does not.
  describe('a Bash location or mode save re-asks the badges\' live-read facts (Round 2, S1)', () => {
    async function openBashTools() {
      await openPanel()
      await openToolsTab()
      deadCopies.refreshAll.mockClear()
    }

    it('the Permissions Mode choice (it sets the mode and the command location) re-asks after the save lands', async () => {
      await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, bashAccessMode: 'agent', executionBackend: 'apple_container' } }) as any)
      await openBashTools()

      await fireEvent.click(screen.getByRole('radio', { name: /Batshit Crazy/ }))
      await waitForPuts(1)

      expect(puts[0].body.provider_specific_settings.nativeTools).toMatchObject({ bashAccessMode: 'dangerous', executionBackend: 'local' })
      await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
      // The server already holds the new location when the facts are asked again.
      expect((await stored()).provider_specific_settings.nativeTools).toMatchObject({ bashAccessMode: 'dangerous', executionBackend: 'local' })
    })

    it('the Sandbox Level choice alone re-asks', async () => {
      await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, bashAccessMode: 'agent', executionBackend: 'apple_container' } }) as any)
      await openBashTools()

      await fireEvent.keyDown(screen.getByText('Apple Container (Mac default)', { selector: '.truncate' }).closest('button') as HTMLElement, { key: 'ArrowDown' })
      await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Local machine (least safe)', exact: true }), { pointerType: 'mouse' })
      await waitForPuts(1)

      expect(puts[0].body.provider_specific_settings.nativeTools).toMatchObject({ executionBackend: 'local' })
      expect(puts[0].body.provider_specific_settings.nativeTools).not.toHaveProperty('bashAccessMode')
      await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
    })

    it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('a Typed File Tools choice (nothing the rule reads) does not re-ask', async () => {
      await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, executionBackend: 'local' } }) as any)
      await openBashTools()

      await choose('Enabled')
      await waitForPuts(1)
      await pause(300)

      expect((await stored()).provider_specific_settings.nativeTools.typedFileToolsEnabled).toBe(true)
      expect(deadCopies.refreshAll).not.toHaveBeenCalled()
    }, 60_000)

    it('a save that fails re-asks nothing (the record did not change)', async () => {
      await redis.createAgent(agentWithPreset(PRESET_A, { nativeTools: { bashEnabled: true, bashAccessMode: 'agent', executionBackend: 'apple_container' } }) as any)
      await openBashTools()
      const real = global.fetch
      // @ts-expect-error test override
      global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.split('?')[0] === `/api/agents/${AGENT}` && (init.method ?? 'GET').toUpperCase() === 'PUT') {
          puts.push({ body: JSON.parse(String(init.body)) })
          return jsonResponse({ error: 'Probe refusal' }, 500)
        }
        return real(input, init)
      })

      await fireEvent.click(screen.getByRole('radio', { name: /Batshit Crazy/ }))
      await waitForPuts(1)
      await pause(300)

      expect(deadCopies.refreshAll).not.toHaveBeenCalled()
      global.fetch = real
    })
  })
})
