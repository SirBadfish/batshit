import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import * as savedModelsStore from '$lib/stores/savedModels.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { jsonResponse, loadAgentRoute, storedAgent } from '$lib/test-utils/agentPutRoute'
import { AUTO_COMPACT_REVISION_HEADER } from '$lib/appActions/settings/autoCompactBaseline'
import { CONFIGURED_TTS_REVISION_HEADER } from '$lib/appActions/settings/configuredTtsBaseline'

/**
 * SA-122 A-1y: the ONE mounted, model-free proof of the mounted Settings refresh (LS-067/LS-068) and
 * BL-1294 on REAL Redis (Ashe Q3: bounded evidence; no browser, no model). Real only: the agent's own
 * save is the real owner's Lua script.
 *
 * Real: the Agents panel (jsdom), `/api/agents/<id>` (route, `redis.updateAgent` and its memory
 * guard), the agent's own save through `executeAgentSettingsAction` (the function the five fixed
 * Fabric controls call; B1 proves the send, broker and Fabric chain above it) and its
 * `publishUserEvent`, the user-channel module and the shared agent store. The bridge: a real Redis
 * subscriber on this user's channel hands each published message to the user channel's own handler,
 * where the live hub would. The hub itself is a stand-in.
 *
 * 1. at rest: the agent renames itself; the panel's name field and the agent store's label show it,
 *    and the panel saves nothing;
 * 2. BL-1294: the user edits Recalled while the agent saves Awareness (the user's save is held on
 *    the wire until the agent's save is in): one refusal, one resend, both values kept, no toast;
 * 3. the same field: the user's Awareness wins, saved once more, with one toast naming it.
 */

// This mounted owner proof substitutes only unsupported Vitest topology. The
// native exact actor/risk/approval path is separately proved by managed-settings-parity.
vi.mock('$lib/server/services/appActions/runtime', async original => ({
  ...await original<typeof import('$lib/server/services/appActions/runtime')>(), requireAppActionTopology() {}
}))

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'

const hub = vi.hoisted(() => ({
  onEvent: null as null | ((text: string) => void),
  onStatus: null as null | ((status: string) => void),
  open: false,
  dropped: 0
}))
const toasts = vi.hoisted(() => ({ warning: [] as string[] }))

vi.mock('$lib/services/liveHub/liveHubClient', () => ({
  subscribeLive: (_target: unknown, handlers: { onEvent: (text: string) => void; onStatus?: (status: string) => void }) => {
    hub.onEvent = handlers.onEvent
    hub.onStatus = status => { hub.open = status === 'open'; handlers.onStatus?.(status) }
    hub.onStatus('open')
    return { state: () => hub.open ? 'open' : 'down', unsubscribe: () => { hub.onEvent = null; hub.onStatus = null; hub.open = false } }
  }
}))
vi.mock('$lib/components/ui/sonner/settings-toast', async (original) => {
  const actual = await original<Record<string, any>>()
  const toast = Object.assign((...args: unknown[]) => actual.toast(...args), {
    ...actual.toast,
    warning: (message: string) => {
      toasts.warning.push(message)
    }
  })
  return { ...actual, toast }
})
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

const strictAdmission = createSettingsRedisAdmission(redis)
useRedisTestServer({ beforeCleanupAdmission: strictAdmission.beforeCleanupAdmission })
afterAll(() => strictAdmission.close())

const USER = 'a1y_proof_user'
const AGENT = 'a1y_proof_agent'
const NAME = 'Proof probe'
const PRESET = {
  id: 'a1y_proof_preset',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
}
const OWNER = { actor: { kind: 'agent' as const, userId: USER, actingAgentId: AGENT }, check() {} }

let subscriber: ReturnType<typeof createClient> | null = null
let stopChannel: () => void = () => {}
let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
let puts: Array<{ body: Record<string, any>; status?: number }> = []
let putGates: Array<Promise<void>> = []
let loseNextCompactPutReply = false
const originalFetch = global.fetch

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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Each case mounts the real panel and waits past autosave debounces: far above the 5 s default. */
// 120 s: a case's own waits can pass 60 s on a slow machine; a wait should name itself first.
const SLOW = 120_000

async function routeAgent(method: string, body: string | undefined) {
  const request = new Request(`http://localhost/api/agents/${AGENT}`, { method, body: method === 'PUT' ? body : undefined })
  const handler = method === 'PUT' ? routeModule.PUT : routeModule.GET
  return (await handler({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
}

function installRoutes(models = [PRESET]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    if (path === `/api/agents/${AGENT}` && method === 'PUT') {
      const entry: { body: Record<string, any>; status?: number } = { body: JSON.parse(String(init.body)) }
      puts.push(entry)
      const gate = putGates.shift()
      if (gate) await gate
      const response = await routeAgent('PUT', String(init.body))
      if (loseNextCompactPutReply && response.ok && 'expectedAutoCompact' in entry.body) {
        loseNextCompactPutReply = false
        entry.status = 503
        return jsonResponse({ code: 'auto_compact_save_unconfirmed', error: 'Unable to confirm the Auto Compact save.' }, 503)
      }
      entry.status = response.status
      return response
    }
    if (path === `/api/agents/${AGENT}` && method === 'GET') {
      return routeAgent('GET', undefined)
    }
    if (path === '/api/agents' && method === 'GET') return jsonResponse({ agents: [await storedAgent(AGENT)] })
    if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
    if (path === '/api/subagents' && method === 'GET') return jsonResponse({ subagents: [] })
    if (path === '/api/user/saved-models') {
      const requestUrl = new URL(url, 'http://localhost')
      if (requestUrl.searchParams.get('projection') === 'stored') {
        const { GET } = await import('../../../../routes/api/user/saved-models/+server')
        return GET({ url: requestUrl, locals: { user: { id: USER } } } as any)
      }
      return jsonResponse({ models })
    }
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/voice/profiles') return jsonResponse({ profiles: [] })
    if (path.startsWith('/api/voice/voices')) return jsonResponse({ voices: [] })
    if (path === '/api/voice/providers') return jsonResponse({ providers: [
      { id: 'browser', label: 'Browser', type: 'browser', ready: true, supports: { tts: true, stt: true, listVoices: false, clone: false, streaming: false, styles: false, emotions: false } },
      { id: 'google', label: 'Google Gemini', type: 'cloud', ready: false, supports: { tts: true, stt: true, listVoices: false, clone: false, streaming: false, styles: false, emotions: false } }
    ] })
    if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
    if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
    if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  }))
}

/** Holds the panel's next agent PUT on the wire (before the route runs) until `release()`. */
function holdNextPut() {
  let release: () => void = () => {}
  putGates.push(new Promise<void>((resolve) => { release = resolve }))
  return () => release()
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

/** The agent's own save, through the real adapter and owner (real Lua), which publishes the event. */
async function agentSaves(family: 'memory' | 'identity', changes: Record<string, unknown>) {
  const { ownAgentSettings } = await import('$lib/server/services/appActions/settings/server')
  const { executeAgentSettingsAction } = await import('$lib/server/services/appActions/settingsAdapter')
  const read = family === 'memory'
    ? await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)
    : await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)
  const result = await executeAgentSettingsAction(
    { userId: USER, agentId: AGENT, abortSignal: new AbortController().signal },
    family === 'memory' ? 'settings.agent.memory.update' : 'settings.agent.identity.update',
    { subjectAgentId: AGENT, expectedRevision: read.revision, changes }
  )
  expect(result).toMatchObject({ status: 'completed', saved: 'saved', readback: 'verified' })
}

let apiRequest = 0
/** Actual scoped native control/conditional owner and publisher; no provider/model call. */
async function agentSavesApi(semanticId: 'agent.reasoning.presentation' | 'agent.reasoning.retention' | 'agent.context.auto-compact' | 'agent.memory.preferences' | 'agent.voice.tts-selection' | 'agent.model.selection' | 'agent.model.preset-copy', changes: Record<string, unknown>) {
  const { nativePolicyResponse, saveNativePolicy } = await import('$lib/server/services/appActions/settings/authority')
  const { defaultAppActionsPolicy } = await import('$lib/appActions/settings/managementContract')
  const { useControl } = await import('$lib/server/services/fabricRegistry')
  const baseline = await nativePolicyResponse(USER, AGENT)
  if (!baseline.policy.enabled) {
    const policy = defaultAppActionsPolicy()
    policy.enabled = true
    policy.protected.contextManagement = 'allow'
    policy.protected.memorySettings = 'allow'
    await saveNativePolicy(USER, AGENT, { expectedGeneration: baseline.generation, expectedSubjectRevision: baseline.subjectRevision, policy })
  }
  const sessionId = 'a1y_retention_session'
  if (!(await redis.exists(`session:${sessionId}`))) await redis.createSession({ id: sessionId, user_id: USER, agent_id: AGENT, title: 'Scoped retention fixture' } as any)
  const controller = new AbortController()
  const context = { userId: USER, agentId: AGENT, sessionId, actorType: 'in-process' as const, abortSignal: controller.signal }
  const report = await useControl({ ...context, controlId: 'sys.app_settings.native.report', input: {
    focus: [semanticId], ...(semanticId === 'agent.model.preset-copy' ? { detail: 'choices', query: { sourcePresetId: changes.sourcePresetId } } : {})
  } })
  if (!report.success) throw new Error(JSON.stringify(report.error))
  const page = report.result as any
  const saved = await useControl({ ...context, controlId: 'sys.app_settings.native.change', input: {
    op: 'change', requestId: `${page.bootNamespace}:ui-api-${++apiRequest}`, reportId: page.reportId, semanticId, changes
  } })
  if (!saved.success) throw new Error(JSON.stringify(saved.error))
  expect(saved).toMatchObject({ success: true, result: { status: 'completed', outcomes: [{ saved: 'saved', readback: 'verified' }] } })
  return saved.result as any
}
function modelTrigger() {
  return screen.getAllByRole('button').find(button => /Probe Model [AB]|Choose a Saved Model/.test(button.textContent ?? ''))!
}
async function pickModel(name: string) {
  await fireEvent.keyDown(modelTrigger(), { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: new RegExp(name) }), { pointerType: 'mouse' })
}
function fetchedUrlsSince(offset: number) {
  return vi.mocked(fetch).mock.calls.slice(offset).map(([input]) =>
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
}
function expectPureModelRefresh(urls: string[]) {
  expect(urls.some(url => url.startsWith('/api/user/saved-models?projection=stored&offset='))).toBe(true)
  expect(urls).not.toContain('/api/user/saved-models')
  expect(urls.some(url => /^\/api\/(models|.*accounts)(?:[/?]|$)/.test(url))).toBe(false)
}
function whiteboardBudget() { return screen.getByRole('spinbutton', { name: 'Whiteboard Budget (estimated tokens)' }) as HTMLInputElement }
function compactRow(label: string) {
  return [...document.querySelectorAll('.batshit-settings-form-row')].find(element =>
    element.querySelector('.batshit-settings-form-label, .batshit-settings-child-label')?.textContent?.trim() === label)!
}
function compactSelect(label: string) { return compactRow(label).querySelector('.batshit-settings-form-control button') as HTMLButtonElement }
function compactThreshold() { return compactRow('Trigger').querySelector('input') as HTMLInputElement }
async function pickCompact(label: string, option: string) {
  await fireEvent.keyDown(compactSelect(label), { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: option, exact: true }), { pointerType: 'mouse' })
}
async function compactToken() { return (await routeAgent('GET', undefined)).headers.get(AUTO_COMPACT_REVISION_HEADER) }
function ttsProviderButton() {
  const block = [...document.querySelectorAll('.batshit-settings-card-subtle-frame')].find(element =>
    element.querySelector('p.batshit-settings-form-label')?.textContent?.trim() === 'Text-to-Speech (TTS)')
  return block?.querySelector('.batshit-settings-form-control button') as HTMLButtonElement
}
async function openVoiceControls() {
  await fireEvent.click(screen.getByRole('tab', { name: 'Voice', exact: true }))
  const summary = screen.getByText('Voice Mode (Input/STT + TTS)', { exact: true }).closest('summary')!
  if (!summary.closest('details')?.open) await fireEvent.click(summary)
  await waitFor(() => expect(ttsProviderButton()).toBeTruthy())
}

async function openPanel(preferences: Record<string, unknown> = {}, additionalPresets: Array<typeof PRESET> = []) {
  const modelFields = {
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7 }
  }
  // The API fixture selects this same preset from the mounted saved-model list.
  // Reference-population admission also requires its real owned storage/membership.
  await redis.json.set(`model:${PRESET.id}`, '$', PRESET)
  await redis.sAdd(`user:${USER}:models`, PRESET.id)
  for (const preset of additionalPresets) {
    await redis.json.set(`model:${preset.id}`, '$', preset)
    await redis.sAdd(`user:${USER}:models`, preset.id)
  }
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: NAME,
    agentType: 'api',
    ...modelFields,
    memory_enabled: true,
    memory_linger_turns: 2,
    memory_recall_linger_turns: 3,
    memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 },
    ...preferences
  } as any)
  installRoutes([PRESET, ...additionalPresets])
  const mounted = render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue(NAME, {}, { timeout: 15_000 })
  await waitFor(() => expect(budgetInput('Awareness')).toBeTruthy(), { timeout: 10_000 })
  await pause(1500)
  expect(puts).toEqual([])
  return mounted
}

describe.skipIf(!REAL)('mounted Settings refresh after the agent saves its own Settings (SA-122 A-1y, real Redis)', () => {
  beforeAll(async () => {
    routeModule = await loadAgentRoute()
    const { getUserChannel } = await import('$lib/server/ssePublisher')
    subscriber = createClient({ url: process.env.REDIS_URL })
    await subscriber.connect()
    await subscriber.subscribe(getUserChannel(USER), (message) => {
      if (hub.open) hub.onEvent?.(message)
      else hub.dropped += 1
    })
  }, 60_000)

  afterAll(async () => {
    await subscriber?.quit()
    subscriber = null
  })

  beforeEach(async () => {
    ensureBrowserStubs()
    puts = []
    putGates = []
    loseNextCompactPutReply = false
    toasts.warning = []
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startUserChannel } = await import('$lib/services/userChannel')
    stopChannel = startUserChannel(USER)
  })

  afterEach(async () => {
    cleanup()
    stopChannel()
    await waitFor(() => expect(savedModelsStore.getIsLoading()).toBe(false))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    global.fetch = originalFetch
    agentStore.setAgents([])
    savedModelsStore.setSavedModels([])
    await redis.del(`agent:${AGENT}`)
    await redis.del(`model:${PRESET.id}`)
    await redis.sRem(`user:${USER}:models`, PRESET.id)
  })

  it('A3 actual model selection and missed Clear follow the mounted clean model beside an invalid name without autosave', async () => {
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    await apiKeyService.store('openai', 'sk-' + 'x'.repeat(48), USER)
    const next = { ...PRESET, id: 'a1y_model_b', modelName: 'Probe Model B', modelId: 'gpt-4.1' }
    await openPanel({}, [next])
    await fireEvent.input(nameInput(), { target: { value: '' } })
    const firstFetch = vi.mocked(fetch).mock.calls.length
    await agentSavesApi('agent.model.selection', { presetId: next.id })
    await waitFor(() => expect(modelTrigger().textContent).toContain(next.modelName), { timeout: 10000 })
    await waitFor(() => expect(agentStore.getAgentById(AGENT)?.primary_model_preset_id).toBe(next.id))
    expect((await storedAgent(AGENT)).primary_model_preset_id).toBe(next.id)
    expect(nameInput().value).toBe('')
    hub.onStatus?.('down')
    const dropped = hub.dropped
    await agentSavesApi('agent.model.selection', { clear: true })
    await waitFor(() => expect(hub.dropped).toBeGreaterThan(dropped))
    expect(modelTrigger().textContent).toContain(next.modelName)
    hub.onStatus?.('open')
    await waitFor(() => expect(modelTrigger().textContent).toContain('Choose a Saved Model'), { timeout: 10000 })
    await waitFor(() => expect(agentStore.getAgentById(AGENT)?.primary_model_preset_id).toBe(''))
    expect((await storedAgent(AGENT)).primary_model_preset_id).toBe('')
    await waitFor(() => expect(savedModelsStore.getIsLoading()).toBe(false))
    await pause(1500)
    expectPureModelRefresh(fetchedUrlsSince(firstFetch))
    expect(nameInput().value).toBe('')
    expect(puts).toEqual([])
  }, SLOW)

  it('A12 actual copy and assignment refresh the stored list and target while preserving a different mounted model and name draft', async () => {
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    await apiKeyService.store('openai', 'sk-' + 'x'.repeat(48), USER)
    const draft = { ...PRESET, id: 'a1y_model_draft', modelName: 'Probe Model B', modelId: 'gpt-4.1' }
    await openPanel({}, [draft])
    await fireEvent.input(nameInput(), { target: { value: '' } })
    await pickModel(draft.modelName)
    expect(modelTrigger().textContent).toContain(draft.modelName)
    const source = await redis.json.getRaw(`model:${PRESET.id}`, '$')
    const firstFetch = vi.mocked(fetch).mock.calls.length
    const result = await agentSavesApi('agent.model.preset-copy', { sourcePresetId: PRESET.id, copyName: 'V4 named copy',
      parameters: [{ name: 'maxTokens', op: 'set', value: 2048 }] })
    expect(result.presetCopyOutcome).toMatchObject({ creation: 'saved', source: 'confirmed', assignment: 'finished' })
    const copyId = result.presetCopyOutcome.presetId as string
    expect(await redis.json.get(`model:${copyId}`)).toMatchObject({ modelName: 'V4 named copy', settings: { temperature: 0.7, maxTokens: 2048 } })
    expect(await redis.sismember(`user:${USER}:models`, copyId)).toBe(true)
    expect(await redis.json.getRaw(`model:${PRESET.id}`, '$')).toBe(source)
    expect((await storedAgent(AGENT)).primary_model_preset_id).toBe(copyId)
    await waitFor(() => expect(savedModelsStore.getSavedModels().some(model => model.id === copyId)).toBe(true), { timeout: 10000 })
    await waitFor(() => expect(agentStore.getAgentById(AGENT)?.primary_model_preset_id).toBe(copyId), { timeout: 10000 })
    await waitFor(() => expect(screen.getByTestId('primary-model-selection-notice').textContent).toContain('changed while you were editing'), { timeout: 10000 })
    await waitFor(() => expect(savedModelsStore.getIsLoading()).toBe(false))
    await pause(1500)
    expectPureModelRefresh(fetchedUrlsSince(firstFetch))
    expect(modelTrigger().textContent).toContain(draft.modelName)
    expect(nameInput().value).toBe('')
    expect(puts).toEqual([])
  }, SLOW)

  it('A10 clean reply voice follows beside an invalid draft and a missed selection follows reconnect without autosave', async () => {
    await openPanel({ voice_profile: { tts: { providerId: 'google', voiceId: 'Kore' }, stt: { providerId: 'browser' }, voiceSessionRuntime: 'direct' } })
    await fireEvent.input(nameInput(), { target: { value: '' } })
    await openVoiceControls()
    await agentSavesApi('agent.voice.tts-selection', { selection: 'provider', providerId: 'browser', modelId: null, voiceId: null })
    await waitFor(() => expect(ttsProviderButton().textContent).toContain('Browser'), { timeout: 10000 })
    expect(nameInput().value).toBe('')
    expect((await storedAgent(AGENT)).voice_profile.stt).toEqual({ providerId: 'browser' })
    hub.onStatus?.('down')
    await agentSavesApi('agent.voice.tts-selection', { selection: 'inherit' })
    hub.onStatus?.('open')
    await waitFor(() => expect(ttsProviderButton().textContent).toContain('Use Global Default'), { timeout: 10000 })
    await pause(1500)
    expect(puts).toEqual([])
    expect(nameInput().value).toBe('')
  }, SLOW)

  it('A10 keeps the queued whole-voice original base and requires an explicit saved selection after conflict', async () => {
    await openPanel({ voice_profile: { tts: { providerId: 'google', voiceId: 'Kore' }, stt: { providerId: 'browser' } } })
    await openVoiceControls()
    const original = (await routeAgent('GET', undefined)).headers.get(CONFIGURED_TTS_REVISION_HEADER)
    const release = holdNextPut()
    await fireEvent.keyDown(ttsProviderButton(), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Browser', exact: true }), { pointerType: 'mouse' })
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 10000 })
    expect(puts[0].body.expectedTtsSelection).toBe(original)
    await agentSavesApi('agent.voice.tts-selection', { selection: 'inherit' })
    expect(puts[0].body.expectedTtsSelection).toBe(original)
    release()
    await waitFor(() => expect(puts[0].status).toBe(409), { timeout: 10000 })
    await waitFor(() => expect(screen.getByTestId('tts-selection-notice').textContent).toContain('changed while you were editing'))
    await pause(1500); expect(puts).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Reply Voice', exact: true }))
    await waitFor(() => expect(ttsProviderButton().textContent).toContain('Use Global Default'))
    await pause(1500); expect(puts).toHaveLength(1)
  }, SLOW)

  it('BL-1688 drains a known TTS save after an older held GET beside a later invalid Basic draft', async () => {
    const mounted = await openPanel({ voice_profile: { tts: { providerId: 'google', voiceId: 'Kore' }, stt: { providerId: 'browser' } } })
    await openVoiceControls()
    const originalToken = (await routeAgent('GET', undefined)).headers.get(CONFIGURED_TTS_REVISION_HEADER)
    const releasePut = holdNextPut()
    let releaseRead = () => {}
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const originalGet = routeModule.GET
    let capturedRead = false
    const getSpy = vi.spyOn(routeModule, 'GET').mockImplementationOnce(async event => {
      const response = await originalGet(event)
      expect((await response.clone().json()).voice_profile.tts.providerId).toBe('google')
      capturedRead = true; await readGate; return response
    })
    try {
      await fireEvent.keyDown(ttsProviderButton(), { key: 'ArrowDown' })
      await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Browser', exact: true }), { pointerType: 'mouse' })
      await waitFor(() => expect(puts).toHaveLength(1), { timeout: 10000 })
      const originalPayload = structuredClone(puts[0].body)
      expect(originalPayload.expectedTtsSelection).toBe(originalToken)
      await fireEvent.click(screen.getByRole('tab', { name: 'Core', exact: true }))
      await fireEvent.input(nameInput(), { target: { value: '' } })
      await mounted.rerender({ initialAgentId: null }); await mounted.rerender({ initialAgentId: AGENT })
      await waitFor(() => expect(capturedRead).toBe(true), { timeout: 10000 })
      releasePut()
      await waitFor(() => expect(puts[0].status).toBe(200), { timeout: 10000 })
      releaseRead()
      await openVoiceControls()
      await waitFor(() => expect(ttsProviderButton()).not.toBeDisabled(), { timeout: 10000 })
      expect(ttsProviderButton().textContent).toContain('Browser')
      await fireEvent.click(screen.getByRole('tab', { name: 'Core', exact: true }))
      expect(nameInput().value).toBe('')
      await pause(1500); expect(puts).toHaveLength(1)
      expect(puts[0].body).toEqual(originalPayload)
      await fireEvent.input(nameInput(), { target: { value: NAME } })
      await pause(1000); expect(puts).toHaveLength(1)
      const freshToken = (await routeAgent('GET', undefined)).headers.get(CONFIGURED_TTS_REVISION_HEADER)
      expect(freshToken).not.toBe(originalToken)
      await openVoiceControls()
      await fireEvent.keyDown(ttsProviderButton(), { key: 'ArrowDown' })
      await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Use Global Default', exact: true }), { pointerType: 'mouse' })
      await waitFor(() => expect(puts[1]?.status).toBe(200), { timeout: 10000 })
      expect(puts[1].body.expectedTtsSelection).toBe(freshToken)
    } finally { releasePut(); releaseRead(); getSpy.mockRestore() }
  }, SLOW)
  it.each([
    { state: 'locked', code: 'tts_speech_to_speech_locked' },
    { state: 'unavailable', code: 'tts_model_selection_unavailable' }
  ])('A10 exact409 $code is known no-save, retains the draft and never replays', async ({ state }) => {
    await openPanel({ voice_profile: { tts: { providerId: 'google', voiceId: 'Kore' }, stt: { providerId: 'browser' } } })
    await openVoiceControls()
    const release = holdNextPut()
    try {
      await fireEvent.keyDown(ttsProviderButton(), { key: 'ArrowDown' })
      await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Browser', exact: true }), { pointerType: 'mouse' })
      await waitFor(() => expect(puts).toHaveLength(1), { timeout: 10000 })
      if (state === 'locked') await redis.json.set(`model:${PRESET.id}`, '$.modelId', 'gpt-realtime-2')
      else await redis.del(`model:${PRESET.id}`)
      release()
      await waitFor(() => expect(puts[0].status).toBe(409), { timeout: 10000 })
      await waitFor(() => expect(screen.getByTestId('tts-selection-notice').textContent).toContain('Your draft was not saved'), { timeout: 10000 })
      expect(screen.getByTestId('tts-selection-notice').textContent).not.toContain('unconfirmed')
      expect(ttsProviderButton().textContent).toContain('Browser')
      expect((await storedAgent(AGENT)).voice_profile.tts.providerId).toBe('google')
      await pause(1500); expect(puts).toHaveLength(1)
    } finally { release() }
  }, SLOW)

  it('A8 clean automatic modes follow beside an invalid draft, and a missed disable follows reconnect without autosave', async () => {
    await openPanel({ memory_window: { floor_mode: 'custom', floor_tokens: 64000, ceiling_headroom_mode: 'custom', ceiling_headroom_tokens: 20000, nap_threshold_percent: 75, idle_gap_hours: 12, summary_model_mode: 'inherit' } })
    await fireEvent.input(nameInput(), { target: { value: '' } })
    await agentSavesApi('agent.memory.preferences', { windowMode: 'auto' })
    await waitFor(() => expect([...document.querySelectorAll('.memory-window-select')].slice(0, 2).every(button => button.textContent?.includes('Automatic'))).toBe(true), { timeout: 10000 })
    expect(nameInput().value).toBe('')
    expect(agentStore.getAgentById(AGENT)?.memory_window).toMatchObject({ floor_mode: 'auto', floor_tokens: 64000, ceiling_headroom_tokens: 20000, nap_threshold_percent: 75, idle_gap_hours: 12 })
    hub.onStatus?.('down'); const dropped = hub.dropped
    await agentSavesApi('agent.memory.preferences', { enabled: false })
    await waitFor(() => expect(hub.dropped).toBeGreaterThan(dropped))
    expect(screen.getByTestId('agent-memory-enabled-toggle').getAttribute('aria-checked')).toBe('true')
    hub.onStatus?.('open')
    await waitFor(() => expect(screen.getByTestId('agent-memory-enabled-toggle').getAttribute('aria-checked')).toBe('false'), { timeout: 10000 })
    expect(nameInput().value).toBe('')
    await pause(1500); expect(puts).toEqual([])
  }, SLOW)

  it('A8 preserves a dirty custom floor choice and uses the refreshed original Memory base for its later deliberate save', async () => {
    await openPanel({ memory_window: { floor_mode: 'custom', floor_tokens: 64000, ceiling_headroom_mode: 'custom', ceiling_headroom_tokens: 20000, summary_model_mode: 'current' } })
    await fireEvent.input(nameInput(), { target: { value: '' } })
    const line = () => [...document.querySelectorAll('.memory-window-line')].find(element => element.querySelector('span')?.textContent?.trim() === 'Floor')!
    await fireEvent.input(line().querySelector('input')!, { target: { value: '65000' } })
    await agentSavesApi('agent.memory.preferences', { windowMode: 'auto' })
    await waitFor(() => expect(toasts.warning.some(message => message.includes('Infinite Session Window'))).toBe(true), { timeout: 10000 })
    expect(line().querySelector('button')?.textContent).toContain('Custom tokens')
    expect((line().querySelector('input') as HTMLInputElement).value).toBe('65000')
    expect(nameInput().value).toBe(''); await pause(1500); expect(puts).toEqual([])
    await fireEvent.input(nameInput(), { target: { value: 'Retained Memory draft' } })
    await waitFor(() => expect(puts[0]?.status).toBe(200), { timeout: 10000 })
    expect(puts[0].body).toMatchObject({ expectedMemory: { memory_window: { floor_mode: 'auto', ceiling_headroom_mode: 'auto', floor_tokens: 64000 } }, memory_window: { floor_mode: 'custom', floor_tokens: 65000, ceiling_headroom_mode: 'auto', summary_model_mode: 'current' } })
    await pause(1500); expect(puts).toHaveLength(1)
  }, SLOW)

  it('A8 keeps the captured Memory base on an in-flight human save, then reconciles one known conflict from that base', async () => {
    await openPanel({ memory_window: { floor_mode: 'custom', floor_tokens: 64000, ceiling_headroom_mode: 'custom', ceiling_headroom_tokens: 20000 } })
    const release = holdNextPut()
    await typeBudget('Recalled (LTM)', 350)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 10000 })
    expect(puts[0].body.expectedMemory.memory_window.floor_mode).toBe('custom')
    await agentSavesApi('agent.memory.preferences', { windowMode: 'auto' })
    expect(puts[0].body.expectedMemory.memory_window.floor_mode).toBe('custom')
    release()
    await waitFor(() => expect(puts[1]?.status).toBe(200), { timeout: 10000 })
    expect(puts[0].status).toBe(409)
    expect(puts[1].body).toMatchObject({ expectedMemory: { memory_window: { floor_mode: 'auto', floor_tokens: 64000 } }, memory_window: { floor_mode: 'auto', ceiling_headroom_mode: 'auto', floor_tokens: 64000 }, memory_lane_budgets: { recalled: 350 } })
    await pause(1500); expect(puts).toHaveLength(2)
  }, SLOW)

  it('1. at rest: the agent renames itself; the panel and the agent store show it, and the panel saves nothing', async () => {
    await openPanel()
    // The panel's own read also updates the store, so the store's refresh is observed itself
    // (a pass-through spy: the user channel calls the real one through this module).
    const storeRefresh = vi.spyOn(agentStore, 'refreshAgentFieldsFromServer')

    await agentSaves('identity', { displayName: 'Proof probe 2' })

    await waitFor(() => expect(nameInput().value).toBe('Proof probe 2'), { timeout: 10_000 })
    await waitFor(() => expect(storeRefresh).toHaveBeenCalledWith(AGENT, 'identity'), { timeout: 10_000 })
    await storeRefresh.mock.results[0].value
    expect(agentStore.getAgentById(AGENT)?.displayName).toBe('Proof probe 2')
    await pause(1500)
    expect(puts).toEqual([])
    expect((await storedAgent(AGENT)).displayName).toBe('Proof probe 2')
  }, SLOW)

  it('2. BL-1294: Recalled edited while the agent saves Awareness: one refusal, one resend, both kept, no toast', async () => {
    await openPanel()
    const release = holdNextPut()

    await typeBudget('Recalled (LTM)', 350)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 10_000 })
    await agentSaves('memory', { onMyMind: 120 })
    release()

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 10_000 })
    await waitFor(() => expect(puts[1].status).toBe(200), { timeout: 10_000 })
    expect(puts[0].status).toBe(409)
    expect(puts[1].body.memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 350 })
    expect((await storedAgent(AGENT)).memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 350 })
    await waitFor(() => expect(budgetInput('Awareness')?.value).toBe('120'), { timeout: 10_000 })
    expect(budgetInput('Recalled (LTM)')?.value).toBe('350')
    expect(toasts.warning).toEqual([])
    await pause(1500)
    expect(puts.length).toBe(2)
  }, SLOW)

  it('3. the same field: the user value of Awareness wins, saved once more, and the panel says so once', async () => {
    await openPanel()
    const release = holdNextPut()

    await typeBudget('Awareness', 150)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 10_000 })
    await agentSaves('memory', { onMyMind: 130 })
    release()

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 10_000 })
    await waitFor(() => expect(puts[1].status).toBe(200), { timeout: 10_000 })
    expect(puts[0].status).toBe(409)
    expect((await storedAgent(AGENT)).memory_lane_budgets.on_my_mind).toBe(150)
    expect(toasts.warning).toHaveLength(1)
    expect(toasts.warning[0]).toMatch(/Awareness/)
  }, SLOW)
  it('P3a API retention and display refresh the actual mounted panel/store without an event-triggered save', async () => {
    await openPanel()
    const storeRefresh = vi.spyOn(agentStore, 'refreshAgentFieldsFromServer')
    await agentSavesApi('agent.reasoning.retention', { mode: 'both', whiteboardBudgetTokens: 1750 })
    await agentSavesApi('agent.reasoning.presentation', { displayWhiteboard: false })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reasoning Retention' }).textContent).toContain('Whiteboard + Preserved Reasoning'), { timeout: 10_000 })
    await waitFor(() => expect(whiteboardBudget().value).toBe('1750'), { timeout: 10_000 })
    expect(screen.getByRole('button', { name: 'Display Whiteboard' }).textContent).toContain('Disabled')
    await waitFor(() => expect(storeRefresh).toHaveBeenCalledWith(AGENT, 'retention'), { timeout: 10_000 })
    expect(agentStore.getAgentById(AGENT)).toMatchObject({ api_reasoning_retention: 'both', whiteboard_budget_tokens: 1750, show_whiteboard: false })
    await pause(1500)
    expect(puts).toEqual([])
  }, SLOW)

  it('A7 follows common Auto Compact beside an invalid draft and after reconnect, with zero hydration saves', async () => {
    await openPanel({ auto_compact_settings: { mode: 'off', triggerMode: 'remaining_tokens', remainingTokens: 50000, modelMode: 'current', promptMode: 'custom', prompt: 'Keep this advanced prompt' } })
    await agentSavesApi('agent.context.auto-compact', { mode: 'ask', remainingTokens: 45000 })
    await waitFor(() => expect(compactThreshold().value).toBe('45000'), { timeout: 10_000 })
    expect(compactSelect('Auto Compact').textContent).toContain('Ask first')
    await pause(1000)
    expect(puts).toEqual([])
    await fireEvent.input(nameInput(), { target: { value: '' } })
    await agentSavesApi('agent.context.auto-compact', { mode: 'ask', remainingTokens: 42000 })
    await waitFor(() => expect(compactSelect('Auto Compact').textContent).toContain('Ask first'), { timeout: 10_000 })
    expect(compactThreshold().value).toBe('42000')
    expect(nameInput().value).toBe('')
    expect(agentStore.getAgentById(AGENT)?.auto_compact_settings).toMatchObject({ mode: 'ask', remainingTokens: 42000, prompt: 'Keep this advanced prompt' })
    hub.onStatus?.('down')
    const dropped = hub.dropped
    await agentSavesApi('agent.context.auto-compact', { remainingTokens: 39000 })
    await waitFor(() => expect(hub.dropped).toBeGreaterThan(dropped))
    expect(compactThreshold().value).toBe('42000')
    hub.onStatus?.('open')
    await waitFor(() => expect(compactThreshold().value).toBe('39000'), { timeout: 10_000 })
    expect(nameInput().value).toBe('')
    await pause(1500)
    expect(puts).toEqual([])
  }, SLOW)

  it('A7 clean common fields follow while an advanced draft is retained, and its later whole save carries the new common base', async () => {
    await openPanel({ auto_compact_settings: { mode: 'off', triggerMode: 'remaining_tokens', remainingTokens: 50000, modelMode: 'inherit', promptMode: 'inherit' } })
    await fireEvent.input(nameInput(), { target: { value: '' } })
    await pickCompact('Compact Model', 'Current chat model')
    await agentSavesApi('agent.context.auto-compact', { mode: 'ask', remainingTokens: 42000 })
    await waitFor(() => expect(compactThreshold().value).toBe('42000'), { timeout: 10_000 })
    expect(compactSelect('Compact Model').textContent).toContain('Current chat model')
    expect(nameInput().value).toBe('')
    await pause(1500)
    expect(puts).toEqual([])
    const refreshedToken = await compactToken()
    await fireEvent.input(nameInput(), { target: { value: 'Advanced draft retained' } })
    await waitFor(() => expect(puts[0]?.status).toBe(200), { timeout: 10_000 })
    expect(puts[0].body).toMatchObject({ expectedAutoCompact: refreshedToken, auto_compact_settings: { mode: 'ask', remainingTokens: 42000, modelMode: 'current' } })
    expect(await storedAgent(AGENT)).toMatchObject({ auto_compact_settings: { mode: 'ask', remainingTokens: 42000, modelMode: 'current' } })
    await pause(1500)
    expect(puts).toHaveLength(1)
  }, SLOW)

  it('A7 keeps dirty common and advanced fields on a changed common base without rebasing or replaying them', async () => {
    await openPanel({ auto_compact_settings: { mode: 'off', triggerMode: 'remaining_tokens', remainingTokens: 50000, modelMode: 'inherit', promptMode: 'inherit' } })
    await fireEvent.input(nameInput(), { target: { value: '' } })
    await pickCompact('Compact Model', 'Current chat model')
    await fireEvent.input(compactThreshold(), { target: { value: '60000' } })
    await agentSavesApi('agent.context.auto-compact', { remainingTokens: 70000 })
    await waitFor(() => expect(screen.getByTestId('auto-compact-notice').textContent).toContain('changed while you were editing'), { timeout: 10_000 })
    expect(compactThreshold().value).toBe('60000')
    expect(compactSelect('Compact Model').textContent).toContain('Current chat model')
    await pause(1500)
    expect(puts).toEqual([])
    await fireEvent.input(nameInput(), { target: { value: 'Unrelated name retained' } })
    await waitFor(() => expect(puts[0]?.status).toBe(200), { timeout: 10_000 })
    expect(puts[0].body).not.toHaveProperty('auto_compact_settings')
    expect(puts[0].body).not.toHaveProperty('expectedAutoCompact')
    expect(compactThreshold().value).toBe('60000')
    expect(await storedAgent(AGENT)).toMatchObject({ auto_compact_settings: { remainingTokens: 70000, modelMode: 'inherit' } })
    await pause(1500)
    expect(puts).toHaveLength(1)
  }, SLOW)

  it('A7 captures the original pending whole-block token and payload before an agent write, then refuses it once without replay', async () => {
    await openPanel({ auto_compact_settings: { mode: 'off', triggerMode: 'remaining_tokens', remainingTokens: 50000, modelMode: 'current', promptMode: 'inherit' } })
    const originalToken = await compactToken()
    const release = holdNextPut()
    await fireEvent.input(compactThreshold(), { target: { value: '60000' } })
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 10_000 })
    const originalPayload = structuredClone(puts[0].body)
    expect(originalPayload.expectedAutoCompact).toBe(originalToken)
    try {
      await agentSavesApi('agent.context.auto-compact', { mode: 'ask', remainingTokens: 70000 })
      expect(puts[0].body).toEqual(originalPayload)
      expect(compactThreshold().value).toBe('60000')
    } finally { release() }
    await waitFor(() => expect(puts[0].status).toBe(409), { timeout: 10_000 })
    await pause(1500)
    expect(puts).toHaveLength(1)
    expect(compactThreshold().value).toBe('60000')
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Auto Compact', exact: true }))
    await waitFor(() => expect(compactThreshold().value).toBe('70000'), { timeout: 10_000 })
    await pause(1500)
    expect(puts).toHaveLength(1)
    await fireEvent.input(compactThreshold(), { target: { value: '85000' } })
    await waitFor(() => expect(puts[1]?.status).toBe(200), { timeout: 10_000 })
    expect(puts[1].body.expectedAutoCompact).not.toBe(originalToken)
  }, SLOW)

  it('A7 drains a known Compact save readback after an older held GET beside a later invalid Basic draft', async () => {
    const mounted = await openPanel({ auto_compact_settings: { mode: 'off', triggerMode: 'remaining_tokens', remainingTokens: 50000, modelMode: 'current', promptMode: 'inherit' } })
    const originalToken = await compactToken()
    const releasePut = holdNextPut()
    let releaseRead = () => {}
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const originalGet = routeModule.GET
    let capturedRead = false
    let capturedThreshold: unknown
    const getSpy = vi.spyOn(routeModule, 'GET').mockImplementationOnce(async event => {
      const response = await originalGet(event)
      capturedThreshold = (await response.clone().json()).auto_compact_settings.remainingTokens
      capturedRead = true
      await readGate
      return response
    })
    try {
      await fireEvent.input(compactThreshold(), { target: { value: '60000' } })
      // This later invalid edit does not change the already captured valid Compact save.
      await fireEvent.input(nameInput(), { target: { value: '' } })
      await waitFor(() => expect(puts).toHaveLength(1), { timeout: 10_000 })
      const originalPayload = structuredClone(puts[0].body)
      expect(originalPayload).toMatchObject({ expectedAutoCompact: originalToken, auto_compact_settings: { remainingTokens: 60000 } })
      expect(originalPayload).not.toHaveProperty('displayName')

      // The existing prop seam starts a same-entity read without replacing the forms.
      // Its response captures A before the held valid PUT saves B and lands as older.
      await mounted.rerender({ initialAgentId: null })
      await mounted.rerender({ initialAgentId: AGENT })
      await waitFor(() => expect(capturedRead).toBe(true), { timeout: 10_000 })
      expect(capturedThreshold).toBe(50000)
      releasePut()
      await waitFor(() => expect(puts[0].status).toBe(200), { timeout: 10_000 })
      expect(await storedAgent(AGENT)).toMatchObject({ displayName: NAME, auto_compact_settings: { remainingTokens: 60000 } })
      releaseRead()

      // The invalid name prevents the all-sections-at-rest fallback. The Compact
      // readback itself must reconcile its known save and release this card.
      await waitFor(() => expect(compactThreshold()).not.toBeDisabled(), { timeout: 10_000 })
      expect(compactThreshold().value).toBe('60000')
      expect(nameInput().value).toBe('')
      expect(puts[0].body).toEqual(originalPayload)
      await pause(1500)
      expect(puts).toHaveLength(1)

      // Returning the unrelated draft to its original value is not another save.
      await fireEvent.input(nameInput(), { target: { value: NAME } })
      await pause(1000)
      expect(puts).toHaveLength(1)
      const freshToken = await compactToken()
      expect(freshToken).not.toBe(originalToken)
      await fireEvent.input(compactThreshold(), { target: { value: '70000' } })
      await waitFor(() => expect(puts[1]?.status).toBe(200), { timeout: 10_000 })
      expect(puts[1].body).toMatchObject({ expectedAutoCompact: freshToken, auto_compact_settings: { remainingTokens: 70000 } })
      expect(await storedAgent(AGENT)).toMatchObject({ displayName: NAME, auto_compact_settings: { remainingTokens: 70000 } })
    } finally {
      releasePut(); releaseRead(); getSpy.mockRestore()
    }
  }, SLOW)

  it('A7 an issued unconfirmed whole save stays unknown after current read and never replays automatically', async () => {
    await openPanel({ auto_compact_settings: { mode: 'off', triggerMode: 'remaining_tokens', remainingTokens: 50000, modelMode: 'current', promptMode: 'inherit' } })
    loseNextCompactPutReply = true
    await fireEvent.input(compactThreshold(), { target: { value: '60000' } })
    await waitFor(() => expect(puts[0]?.status).toBe(503), { timeout: 10_000 })
    expect(await storedAgent(AGENT)).toMatchObject({ auto_compact_settings: { remainingTokens: 60000 } })
    expect(screen.getByTestId('auto-compact-notice').textContent).toContain('unconfirmed')
    hub.onStatus?.('open')
    await pause(1500)
    expect(screen.getByTestId('auto-compact-notice').textContent).toContain('unconfirmed')
    expect(puts).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Auto Compact', exact: true }))
    await waitFor(() => expect(compactThreshold()).not.toBeDisabled(), { timeout: 10_000 })
    expect(screen.getByTestId('auto-compact-notice').textContent).toContain('earlier Auto Compact save remains unconfirmed')
    await pause(1500)
    expect(puts).toHaveLength(1)
  }, SLOW)
  it('P3a API remote retention preserves a same-field numeric draft and unrelated in-flight name save', async () => {
    await openPanel({ api_reasoning_retention: 'whiteboard', whiteboard_budget_tokens: 1500 })
    const release = holdNextPut()
    const field = whiteboardBudget()
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: '2250' } })
    // The user has not blurred/committed the numeric draft. Their separate name save is held.
    await fireEvent.input(nameInput(), { target: { value: 'User name kept' } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 10_000 })
    try {
      await agentSavesApi('agent.reasoning.retention', { mode: 'both', whiteboardBudgetTokens: 2500 })
      await pause(300)
      expect(whiteboardBudget().value).toBe('2250')
      expect(nameInput().value).toBe('User name kept')
      expect(puts).toHaveLength(1)
    } finally { release() }
    await waitFor(() => expect(puts[0].status).toBe(200), { timeout: 10_000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reasoning Retention' }).textContent).toContain('Whiteboard + Preserved Reasoning'), { timeout: 10_000 })
    expect(whiteboardBudget().value).toBe('2250')
    expect(await storedAgent(AGENT)).toMatchObject({ displayName: 'User name kept', api_reasoning_retention: 'both', whiteboard_budget_tokens: 2500 })
    await pause(1500)
    expect(puts).toHaveLength(1)
  }, SLOW)

  it('human MCP whole-list conflict keeps the mounted dirty choice through real publication/readback and requires explicit current-value recovery', async () => {
    await openPanel({ defaultMCPGateways: ['A'], custom_tool_settings: [] })
    await fireEvent.click(screen.getByRole('tab', { name: 'Tools', exact: true }))
    const card = () => (globalThis as any).__mcpCardProps as Record<string, any>
    await waitFor(() => expect(card()?.defaultMCPGateways).toEqual(['A']))
    const release = holdNextPut()
    try {
      card().onGatewaysChange(['A','B'])
      await waitFor(() => expect(puts).toHaveLength(1), { timeout: 8000 })
      const original = puts[0].body.expectedMcpSettings.defaultMCPGateways
      const shown = await routeAgent('GET', undefined)
      const { MCP_SETTINGS_REVISION_HEADER, readMcpSettingsRevisions } = await import('$lib/utils/agentSettingsSectionSaves')
      const base = readMcpSettingsRevisions(shown.headers.get(MCP_SETTINGS_REVISION_HEADER))!
      // A second genuine human route write, not an unimplemented subject producer.
      const winner = await routeAgent('PUT', JSON.stringify({ defaultMCPGateways: ['A','C'], expectedMcpSettings: { defaultMCPGateways: base.defaultMCPGateways } }))
      expect(winner.status).toBe(200)
      await waitFor(() => expect(agentStore.getAgentById(AGENT)?.defaultMCPGateways).toEqual(['A','C']))
      expect(card().defaultMCPGateways).toEqual(['A','B'])
      release()
      await waitFor(() => expect(puts[0].status).toBe(409), { timeout: 8000 })
      expect(puts[0].body.expectedMcpSettings.defaultMCPGateways).toBe(original)
      expect(card().defaultMCPGateways).toEqual(['A','B'])
      await waitFor(() => expect(card().mcpSaveError).toMatch(/changed/))
      expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['A','C'])
      await pause(1200); expect(puts).toHaveLength(1)
      await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Tool Settings' }))
      await waitFor(() => expect(card().defaultMCPGateways).toEqual(['A','C']))
      expect(puts).toHaveLength(1)
      card().onGatewaysChange(['A','C','B'])
      await waitFor(() => expect(puts).toHaveLength(2), { timeout: 8000 })
      await waitFor(() => expect(puts[1].status).toBe(200))
      expect(puts[1].body.expectedMcpSettings.defaultMCPGateways).not.toBe(original)
      expect((await storedAgent(AGENT)).defaultMCPGateways).toEqual(['A','C','B'])
    } finally { release() }
  }, SLOW)

})
