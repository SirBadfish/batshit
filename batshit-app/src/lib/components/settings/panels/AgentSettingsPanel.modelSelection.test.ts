import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentStore from '$lib/stores/agents.svelte'
import * as savedModelsStore from '$lib/stores/savedModels.svelte'
import { buildPickedPresetSelection } from '$lib/utils/modelPresetPick'
import { MODEL_SELECTION_REVISION_HEADER, MODEL_SELECTION_FIELDS, MODEL_SELECTION_IDENTITY_FIELDS } from '$lib/appActions/settings/modelSelectionBaseline'
import { applyAgentProviderSettingsUpdate } from '$lib/utils/agentProviderSettings'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
import { page } from '$app/state'

// The real mounted owner and real stores, with a held HTTP boundary. Server CAS is
// qualified independently on real Redis; these cases pin capture, drafts and refresh.
const channel = vi.hoisted(() => ({ listeners: new Set<(event: any) => void>() }))
vi.mock('$lib/services/userChannel', async original => ({
  ...(await original<Record<string, unknown>>()),
  onUserChannelEvent: (listener: (event: any) => void) => { channel.listeners.add(listener); return () => channel.listeners.delete(listener) }
}))
vi.mock('$lib/components/settings/agent/AgentMcpDefaultsCard.svelte', async () => ({
  default: (await import('../../mcps/__tests__/AgentMcpDefaultsCardStub.test.svelte')).default
}))

const USER = 'selection-user', SUB = 'selection-sub'
let AGENT = 'selection-agent', caseId = 0
const A = { id: 'preset-a', provider: 'openai', modelId: 'model-a', modelName: 'Selection Model A', purpose: 'chat', connection: { type: 'direct', service: 'openai' }, settings: { temperature: 0.7 } }
const B = { ...A, id: 'preset-b', modelId: 'model-b', modelName: 'Selection Model B', settings: { temperature: 0 } }
const C = { ...A, id: 'preset-c', modelId: 'model-c', modelName: 'Selection Model C', unavailableReason: 'This model is no longer listed.' }
const presets = [A, B, C]
// SA-139 R5: a saved Claude Code CLI block, kept on a record as stored data only (no live type
// reads or writes it any more; the CLI Subagent's native model selection cases left with it).
const CLAUDE = { permissionMode: 'default', model: 'sonnet', includeCoreSystemPrompt: false, includeProjectInstructions: true,
  alwaysThinkingEnabled: false, chrome: false, configScope: 'managed', addDirs: [], allowedTools: [], disallowedTools: [],
  configOverrides: [], workingDirectoryMode: 'project' }
// This held HTTP fixture supplies opaque detail tokens. Actual hashing/Lua parity belongs
// to the fixed guard/twin and admitted real-Redis owners, not this mounted proof.
const revision = (row: Record<string, any>) => `sha256:${(row.primary_model_preset_id === A.id ? 'a' : row.primary_model_preset_id === B.id ? 'b' : 'c').repeat(64)}`
let agent: Record<string, any>, subagent: Record<string, any>
let puts: Array<{ kind: string; body: Record<string, any>; status: number }>
let gets: Record<string, number>
let beforePut: (() => void) | null
let unknownNext: boolean
let failReadAfterSave: boolean
let failNextRead: boolean
let holdNextRead: Promise<void> | null
let releaseRead: (() => void) | null
let failNonModelSave: boolean
let connectionPayload: unknown
let connectionReadHold: Promise<void> | null
let releaseConnectionRead: (() => void) | null
let connectionReads: number
const INVALID_CONNECTIONS_TEXT = 'Connection status could not be read. Refresh Saved Models to retry.'
let Panel: typeof import('./AgentSettingsPanel.svelte').default
const pause = (ms = 900) => new Promise(resolve => setTimeout(resolve, ms))
const emit = (event: Record<string, unknown>) => {
  // The real user-channel store owner does this before notifying mounted listeners.
  if (event.type === 'reconnected' || event.type === 'model_presets_changed' || event.family === 'model-selection') void savedModelsStore.refreshStoredSavedModels()
  for (const listener of [...channel.listeners]) listener(event)
}

function answer(payload: unknown, status = 200, row?: Record<string, any>) {
  return Response.json(payload, { status, headers: row ? { [MODEL_SELECTION_REVISION_HEADER]: revision(row) } : {} })
}
function setModel(kind: 'agent' | 'subagent', preset: typeof A) {
  const row = kind === 'agent' ? agent : subagent
  const picked = buildPickedPresetSelection(preset as any)
  for (const key of Object.keys(picked)) if (kind === 'agent' || key !== 'provider_specific_settings' && !key.match(/temperature|tokens|top_|penalty|seed|sequences|effort|capabilities/)) row[key] = picked[key as keyof typeof picked]
}
function browserStubs() {
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null }) })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value() {} })
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value() {} })
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
}
beforeAll(async () => { Panel = (await import('./AgentSettingsPanel.svelte')).default }, 60_000)
beforeEach(() => {
  // Shared Thinking failure state intentionally survives mounts. Each disposable case
  // gets its own agent owner instead of clearing or borrowing another case's state.
  AGENT = `selection-agent-${++caseId}`
  browserStubs()
  channel.listeners.clear()
  agent = { id: AGENT, user_id: USER, displayName: 'Selection Primary', agentType: 'api', ...buildPickedPresetSelection(A as any) }
  subagent = { id: SUB, user_id: USER, displayName: 'Selection Subagent', subagentType: 'api', specialty: 'general', timeout_seconds: 45,
    primary_model_preset_id: A.id, primary_model_provider: A.provider, primary_model_name: A.modelId, primary_model_connection: A.connection }
  puts = []; gets = { agent: 0, subagent: 0 }; beforePut = null; unknownNext = false; failReadAfterSave = false; failNextRead = false
  holdNextRead = null; releaseRead = null
  failNonModelSave = false
  presets.splice(0, presets.length, A, B, C)
  connectionPayload = { data: { connections: [{ id: 'direct:openai', transport: 'direct', status: 'ready', providers: ['openai'] }] } }
  connectionReadHold = null; releaseConnectionRead = null; connectionReads = 0
  agentStore.setAgents([]); savedModelsStore.setSavedModels([])
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    const path = url.split('?')[0], method = init.method ?? 'GET'
    const kind = path === `/api/agents/${AGENT}` ? 'agent' : path === `/api/subagents/${SUB}` ? 'subagent' : null
    if (kind) {
      const row = kind === 'agent' ? agent : subagent
      if (method === 'GET') {
        gets[kind] += 1
        if (holdNextRead) { const held = holdNextRead; holdNextRead = null; await held }
        if (failNextRead) { failNextRead = false; return answer({ error: 'Read unavailable.' }, 500) }
        return answer(kind === 'agent' ? row : { subagent: row }, 200, row)
      }
      if (method === 'PUT') {
        const body = JSON.parse(String(init.body))
        const callback = beforePut; beforePut = null; callback?.()
        const modelWrite = 'primary_model_preset_id' in body
        const status = modelWrite && body.expectedModelSelection !== revision(row) ? 409 : !modelWrite && failNonModelSave ? 500 : unknownNext ? 503 : 200
        puts.push({ kind, body, status })
        if (status === 409) return answer({ code: 'model_selection_settings_changed', error: 'Saved model changed.' }, 409)
        if (status === 500) return answer({ error: 'Non-model save failed.' }, 500)
        const { expectedModelSelection: _requestOnly, ...stored } = body
        if ('provider_specific_settings' in stored) stored.provider_specific_settings = applyAgentProviderSettingsUpdate(row.provider_specific_settings, stored.provider_specific_settings)
        Object.assign(row, stored)
        if (failReadAfterSave) { failReadAfterSave = false; failNextRead = true }
        if (unknownNext) { unknownNext = false; return answer({ code: 'model_selection_save_unconfirmed', error: 'Save unconfirmed.' }, 503) }
        return answer(kind === 'agent' ? row : { subagent: row })
      }
    }
    if (path === '/api/agents') return answer({ agents: [agent] })
    if (path === '/api/subagents') return answer({ subagents: [subagent] })
    if (path.endsWith('/subagents')) return answer({ subagents: [] })
    if (path === '/api/user/saved-models') {
      const models = presets
      const stored = models.map(({ unavailableReason: _reason, reasoningEvidence: _evidence, ...model }: any) => model)
      return answer(url.includes('projection=stored') ? { projection: 'stored', models: stored, total: stored.length, offset: 0, nextOffset: null } : { models })
    }
    if (path === '/api/models') {
      connectionReads += 1
      const response = answer(connectionPayload)
      if (connectionReadHold) await connectionReadHold
      return response
    }
    if (path === '/api/settings/api-keys') return answer({ keys: {} })
    if (path === '/api/goons') return answer({ ownerId: page.data.user.id, goons: [] })
    if (path === '/api/icons/library') return answer({ icons: [], prefs: { favorites: [], recents: [] } })
    if (path === '/api/mcp/gateways') return answer({ gateways: [] })
    if (path === '/api/cli-tools') return answer({ tools: [] })
    return answer({ error: `Unhandled ${method} ${path}` }, 404)
  }))
})
afterEach(async () => { releaseRead?.(); releaseConnectionRead?.(); cleanup(); await waitFor(() => expect(savedModelsStore.getIsLoading()).toBe(false)); vi.restoreAllMocks(); vi.unstubAllGlobals(); agentStore.setAgents([]); savedModelsStore.setSavedModels([]) })

async function openPanel(kind: 'agent' | 'subagent' = 'agent') {
  render(Panel, { props: { data: { user: { id: USER } } as any, initialAgentId: AGENT } })
  await screen.findByDisplayValue('Selection Primary', {}, { timeout: 15_000 })
  await waitFor(() => expect(gets.agent).toBeGreaterThan(0))
  if (kind === 'subagent') {
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Select Agents & Subagents' }), { key: 'ArrowDown' })
    const item = await screen.findByText('Selection Subagent', { selector: '.batshit-settings-action-row-title' })
    await fireEvent.click(item.closest('button')!)
    await screen.findByDisplayValue('Selection Subagent')
    await waitFor(() => expect(gets.subagent).toBeGreaterThan(0))
  }
  await pause()
  expect(puts).toEqual([])
}
function modelTrigger() {
  return screen.getAllByRole('button').find(button => /Selection Model [ABC]|Choose a Saved Model/.test(button.textContent ?? ''))!
}
async function pick(name: string) {
  await fireEvent.keyDown(modelTrigger(), { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: new RegExp(name) }), { pointerType: 'mouse' })
}

describe('mounted model group capture and refresh', () => {
  it.each(['ready', 'locked'] as const)('blocks loading/bad connection metadata with a valid Primary base, keeps sparse edits, and explicitly refreshes to %s', async status => {
    connectionPayload = { data: { connections: {} } }
    connectionReadHold = new Promise<void>(resolve => { releaseConnectionRead = resolve })
    const original = structuredClone(agent), base = revision(agent)
    await openPanel()
    expect(gets.agent).toBeGreaterThan(0)
    expect(screen.queryByTestId('primary-model-selection-notice')).toBeNull()
    expect(modelTrigger()).toBeDisabled()
    expect(modelTrigger().textContent).toContain(A.modelName)
    expect(puts).toEqual([])
    expect(agent).toEqual(original)

    releaseConnectionRead!()
    connectionReadHold = null
    expect(await screen.findByText(INVALID_CONNECTIONS_TEXT)).toBeVisible()
    expect(modelTrigger()).toBeDisabled()
    const before = connectionReads
    await fireEvent.input(document.getElementById('agent-display')!, { target: { value: 'Renamed beside unknown connections' } })
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5_000 })
    expect(puts[0].body).toEqual({ displayName: 'Renamed beside unknown connections' })
    expect(agent.primary_model_preset_id).toBe(A.id)
    expect(modelTrigger().textContent).toContain(A.modelName)
    expect(connectionReads).toBe(before)

    connectionPayload = { data: { connections: [{ id: 'direct:openai', status }] } }
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Saved Models' }))
    await waitFor(() => expect(connectionReads).toBe(before + 1))
    await waitFor(() => expect(screen.queryByText(INVALID_CONNECTIONS_TEXT)).toBeNull())
    await waitFor(() => expect(modelTrigger()).not.toBeDisabled())
    await fireEvent.keyDown(modelTrigger(), { key: 'ArrowDown' })
    const option = await screen.findByRole('option', { name: new RegExp(B.modelName) })
    expect(option.hasAttribute('data-disabled')).toBe(status === 'locked')
    await fireEvent.pointerUp(option, { pointerType: 'mouse' })
    if (status === 'ready') {
      await waitFor(() => expect(puts).toHaveLength(2), { timeout: 5_000 })
      expect(puts[1].body).toMatchObject({ primary_model_preset_id: B.id, expectedModelSelection: base })
    } else {
      await pause()
      expect(puts).toHaveLength(1)
      expect(agent.primary_model_preset_id).toBe(A.id)
    }
    await pause()
    expect(connectionReads).toBe(before + 1)
  }, 30_000)

  it('a held connection refresh cannot admit an option from the already-open Primary menu', async () => {
    await openPanel()
    const original = structuredClone(agent)
    await fireEvent.keyDown(modelTrigger(), { key: 'ArrowDown' })
    const option = await screen.findByRole('option', { name: new RegExp(B.modelName) })
    connectionReadHold = new Promise<void>(resolve => { releaseConnectionRead = resolve })
    const before = connectionReads
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.localAiSettingsUpdated))
    await waitFor(() => expect(connectionReads).toBe(before + 1))
    expect(modelTrigger()).toBeDisabled()
    await fireEvent.pointerUp(option, { pointerType: 'mouse' })
    await pause()
    expect(puts).toEqual([])
    expect(agent).toEqual(original)
    releaseConnectionRead!()
    connectionReadHold = null
    await waitFor(() => expect(modelTrigger()).not.toBeDisabled())
    expect(puts).toEqual([])
  }, 30_000)

  it('unreadable connection metadata does not block an explicit Clear with its valid original base', async () => {
    connectionPayload = {}
    const base = revision(agent)
    await openPanel()
    expect(await screen.findByText(INVALID_CONNECTIONS_TEXT)).toBeVisible()
    const clear = screen.getByRole('button', { name: 'Clear Saved Model', exact: true })
    expect(clear).not.toBeDisabled()
    await fireEvent.click(clear)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5_000 })
    expect(puts[0].body).toMatchObject({ primary_model_preset_id: null, expectedModelSelection: base })
    expect(agent.primary_model_preset_id).toBeNull()
  }, 30_000)

  it('valid empty metadata permits an explicit Primary pick without requiring labels or a success marker', async () => {
    connectionPayload = { data: { connections: [] } }
    await openPanel()
    expect(modelTrigger()).not.toBeDisabled()
    await pick(B.modelName)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5_000 })
    expect(puts[0].body).toMatchObject({ primary_model_preset_id: B.id, expectedModelSelection: `sha256:${'a'.repeat(64)}` })
  }, 30_000)

  it('SA-139: a Claude plan pick saves the same shared preset payload as the chat bar picker', async () => {
    const PLAN = { ...B, provider: 'anthropic', modelId: 'opus', effectiveModelId: 'opus', modelName: 'Selection Claude plan',
      connection: { id: 'claude-plan:local', type: 'direct', service: 'claude-plan' }, settings: { anthropicEffort: 'high' }, pricing: {} }
    presets.splice(1, 1, PLAN as any)
    connectionPayload = { data: { connections: [{ id: 'direct:openai', transport: 'direct', status: 'ready', providers: ['openai'] },
      { id: 'claude-plan:local', transport: 'direct', service: 'claude-plan', status: 'ready', providers: ['anthropic'] }] } }
    await openPanel()
    await pick(PLAN.modelName)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5_000 })
    const { provider_specific_settings: _settings, ...picked } = buildPickedPresetSelection(PLAN as any)
    expect(puts[0].body).toMatchObject({ ...picked, expectedModelSelection: `sha256:${'a'.repeat(64)}` })
    expect(puts[0].body.provider_specific_settings).toMatchObject({ anthropicEffort: 'high', temperature: null })
  }, 30_000)

  it.each([['agent', 'identity'], ['agent', 'connection'], ['subagent', 'identity'], ['subagent', 'connection']] as const)(
    'a malformed %s model %s leaves the mounted panel usable with clear unavailable and no repair PUT', async (kind, field) => {
      const row = kind === 'agent' ? agent : subagent
      if (field === 'identity') row.primary_model_provider = 42
      else row.primary_model_connection = ['unreadable-connection']
      const original = structuredClone(row)
      await openPanel(kind)
      const clear = screen.getByRole('button', { name: 'Clear Saved Model', exact: true })
      expect(clear).toBeDisabled()
      expect(screen.getByText('Saved Model clear is unavailable because the saved model selection is unreadable.')).toBeVisible()
      expect(screen.getByDisplayValue(kind === 'agent' ? 'Selection Primary' : 'Selection Subagent')).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Refresh Saved Models' })).toBeEnabled()
      await fireEvent.click(clear)
      expect(puts).toEqual([])
      expect(row).toEqual(original)
      const name = screen.getByDisplayValue(kind === 'agent' ? 'Selection Primary' : 'Selection Subagent')
      if (kind === 'agent' && field === 'identity') {
        await fireEvent.input(name, { target: { value: 'A deliberate valid name draft' } })
        expect(await screen.findByText('The saved model identity is unreadable. Choose a Saved Model before saving these settings.')).toBeVisible()
        expect(name).toHaveValue('A deliberate valid name draft')
        expect(puts).toEqual([])
        expect(row).toEqual(original)
      }
      await fireEvent.input(name, { target: { value: '' } })
      const reads = gets[kind]
      emit({ type: 'reconnected' })
      await waitFor(() => expect(gets[kind]).toBeGreaterThan(reads))
      expect(name).toHaveValue('')
      expect(clear).toBeDisabled()
      expect(puts).toEqual([])
      expect(row).toEqual(original)
    })
  it('a nonstring Primary connection hint refuses an otherwise valid name draft without coercion, repair or an effect exception', async () => {
    agent.primary_model_connection = { type: 'direct', service: 42 }
    const original = structuredClone(agent)
    await openPanel()
    const name = screen.getByDisplayValue('Selection Primary')
    await fireEvent.input(name, { target: { value: 'A valid connection-refused name draft' } })
    expect(await screen.findByText('The saved model connection is unreadable. Choose a Saved Model before saving these settings.')).toBeVisible()
    expect(name).toHaveValue('A valid connection-refused name draft')
    expect(puts).toEqual([])
    expect(agent).toEqual(original)
  })
  it.each(['agent', 'subagent'] as const)('the actual %s Clear button uses its shown model base and leaves legacy/native/Voice drafts untouched', async kind => {
    const row = kind === 'agent' ? agent : subagent
    Object.assign(row, { model: 'legacy-retained', claude_settings: structuredClone(CLAUDE), voice_profile: { schemaVersion: 2, tts: { providerId: 'browser' } },
      provider_specific_settings: { temperature: 0.7, claude_model: 'literal-legacy', nativeTools: { bashAccessMode: 'plan' } } })
    const original = revision(row), native = structuredClone(row.claude_settings), voice = structuredClone(row.voice_profile)
    await openPanel(kind)
    const clear = screen.getByRole('button', { name: 'Clear Saved Model', exact: true })
    expect(clear).not.toBeDisabled()
    const readsBefore = gets[kind]
    await fireEvent.click(clear)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5000 })
    expect(puts[0].body).toMatchObject({ primary_model_preset_id: null, primary_model_provider: kind === 'agent' ? null : '', primary_model_name: kind === 'agent' ? null : '', primary_model_connection: null, expectedModelSelection: original })
    for (const field of ['model', 'codex_settings', 'claude_settings', 'voice_profile']) expect(puts[0].body).not.toHaveProperty(field)
    expect(row.claude_settings).toEqual(native); expect(row.voice_profile).toEqual(voice); expect(row.model).toBe('legacy-retained')
    expect(row.provider_specific_settings.claude_model).toBe('literal-legacy')
    if (kind === 'subagent') expect(puts[0].body).not.toHaveProperty('provider_specific_settings')
    const notice = kind === 'agent' ? 'primary-model-selection-notice' : 'subagent-model-selection-notice'
    const readWait = kind === 'agent' ? 'primary-settings-read-wait' : 'subagent-settings-read-wait'
    await waitFor(() => expect(gets[kind]).toBeGreaterThan(readsBefore))
    await waitFor(() => {
      expect(screen.queryByTestId(readWait)).toBeNull()
      expect(screen.queryByTestId(notice)).toBeNull()
    })
    await waitFor(() => expect(clear).toBeDisabled())
    emit({ type: 'reconnected' }); await pause()
    expect(puts).toHaveLength(1)
  }, 30000)
  it.each([['agent', 'absent'], ['agent', 'null'], ['subagent', 'absent'], ['subagent', 'null']] as const)(
    'a clean %s raw %s selection stays a no-op beside retained legacy/native data after its actual read', async (kind, state) => {
      const row = kind === 'agent' ? agent : subagent
      for (const field of kind === 'agent' ? MODEL_SELECTION_FIELDS : MODEL_SELECTION_IDENTITY_FIELDS) {
        if (state === 'absent') delete row[field]
        else row[field] = null
      }
      if (state === 'absent') delete row.provider_specific_settings
      else row.provider_specific_settings = null
      row.model = 'legacy-retained'
      row.claude_settings = structuredClone(CLAUDE)
      const original = structuredClone(row)
      await openPanel(kind)
      const notice = kind === 'agent' ? 'primary-model-selection-notice' : 'subagent-model-selection-notice'
      const readWait = kind === 'agent' ? 'primary-settings-read-wait' : 'subagent-settings-read-wait'
      await waitFor(() => {
        expect(screen.queryByTestId(readWait)).toBeNull()
        expect(screen.queryByTestId(notice)).toBeNull()
      })
      const clear = screen.getByRole('button', { name: 'Clear Saved Model', exact: true })
      expect(clear).toBeDisabled()
      await fireEvent.click(clear)
      const reads = gets[kind]
      emit({ type: 'reconnected' })
      await waitFor(() => expect(gets[kind]).toBeGreaterThan(reads))
      await waitFor(() => {
        expect(screen.queryByTestId(readWait)).toBeNull()
        expect(screen.queryByTestId(notice)).toBeNull()
      })
      expect(clear).toBeDisabled()
      expect(puts).toEqual([])
      expect(row).toEqual(original)
    })
  it.each(['agent', 'subagent'] as const)('an actually dirty %s model draft remains clearable and survives a raw-clear background read', async kind => {
    const row = kind === 'agent' ? agent : subagent
    for (const field of kind === 'agent' ? MODEL_SELECTION_FIELDS : MODEL_SELECTION_IDENTITY_FIELDS) delete row[field]
    delete row.provider_specific_settings
    row.model = 'legacy-retained'
    const original = structuredClone(row)
    await openPanel(kind)
    const name = screen.getByDisplayValue(kind === 'agent' ? 'Selection Primary' : 'Selection Subagent')
    await fireEvent.input(name, { target: { value: '' } })
    await pick(B.modelName)
    const clear = screen.getByRole('button', { name: 'Clear Saved Model', exact: true })
    expect(clear).not.toBeDisabled()
    const reads = gets[kind]
    emit({ type: 'reconnected' })
    await waitFor(() => expect(gets[kind]).toBeGreaterThan(reads))
    await waitFor(() => expect(screen.getByTestId(kind === 'agent' ? 'primary-settings-read-wait' : 'subagent-settings-read-wait').textContent).toContain('Your unsaved edits are being kept.'))
    expect(modelTrigger().textContent).toContain(B.modelName)
    expect(name).toHaveValue('')
    expect(clear).not.toBeDisabled()
    expect(puts).toEqual([])
    expect(row).toEqual(original)
  })
  // SA-139 R5: the Claude Code CLI Subagent's preset and native-model cases left with that type;
  // a leftover shows no picker (`AgentSettingsPanel.retiredCliSubagentOpen.test.ts`).
  it('reconnect refreshes the clean model beside an unrelated invalid name draft and keeps an unavailable saved choice selected', async () => {
    await openPanel()
    await fireEvent.input(document.getElementById('agent-display')!, { target: { value: '' } })
    setModel('agent', C)
    const oldGets = gets.agent
    emit({ type: 'reconnected' })
    await waitFor(() => expect(gets.agent).toBeGreaterThan(oldGets))
    await waitFor(() => expect(modelTrigger().textContent).toContain(C.modelName))
    expect((document.getElementById('agent-display') as HTMLInputElement).value).toBe('')
    const notice = screen.getByTestId('primary-settings-read-wait')
    expect(notice.textContent).toContain('Your unsaved edits are being kept.')
    expect(within(notice).queryByRole('button', { name: 'Retry' })).toBeNull()
    await pause()
    expect(puts).toEqual([])
  }, 30_000)
  it('a pure external API Primary voice selection updates mounted locks while preserving an unrelated dirty draft and issuing no save or room call', async () => {
    await openPanel()
    await fireEvent.input(document.getElementById('agent-display')!, { target: { value: '' } })
    const voicePreset = { ...A, id: 'voice-preset', modelName: 'Selected speech-to-speech', modelId: 'gpt-realtime-2',
      voiceSession: { runtime: 'livekit' as const, mode: 'speech-to-speech' as const, providerId: 'openai', supportStatus: 'supported' as const, locksVoiceModeSettings: true } }
    presets.push(voicePreset)
    setModel('agent', voicePreset)
    const before = vi.mocked(fetch).mock.calls.length, oldReads = gets.agent
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'model-selection' })
    await waitFor(() => expect(gets.agent).toBeGreaterThan(oldReads))
    await waitFor(() => expect(screen.getAllByRole('button').some(button => button.textContent?.includes(voicePreset.modelName))).toBe(true))
    await fireEvent.click(screen.getByRole('tab', { name: 'Voice', exact: true }))
    expect(await screen.findByText('Handled by selected speech-to-speech model')).toBeVisible()
    const runtime = screen.getByText('Voice Runtime').closest('.batshit-settings-card-subtle-frame')!
    if (!(runtime instanceof HTMLElement)) throw new Error('The actual Voice Runtime controls are missing.')
    expect(within(runtime).getByRole('button', { name: 'Use Global Default', exact: true })).toBeDisabled()
    expect((document.getElementById('agent-display') as HTMLInputElement).value).toBe('')
    expect(puts).toEqual([])
    const reads = vi.mocked(fetch).mock.calls.slice(before).map(([url]) => String(url))
    expect(reads.some(url => url.includes('projection=stored'))).toBe(true)
    expect(reads).not.toContain('/api/models'); expect(reads).not.toContain('/api/user/saved-models')
    expect(reads.some(url => url.startsWith('/api/voice/'))).toBe(false)
  }, 30_000)
  it('keeps the captured Primary base when another model wins before PUT and never retries the refused choice on reconnect', async () => {
    await openPanel()
    const originalBase = revision(agent)
    beforePut = () => setModel('agent', C)
    await pick(B.modelName)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5000 })
    expect(puts[0]).toMatchObject({ status: 409, body: { expectedModelSelection: originalBase, primary_model_preset_id: B.id } })
    await screen.findByTestId('primary-model-selection-notice')
    emit({ type: 'reconnected' })
    await pause(1200)
    expect(modelTrigger().textContent).toContain(B.modelName)
    expect(puts).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Model' }))
    await waitFor(() => expect(modelTrigger().textContent).toContain(C.modelName))
    await pause()
    expect(puts).toHaveLength(1)
  }, 30_000)
  it('keeps a dirty Primary model group and its old base while allowing an unrelated name edit to save', async () => {
    await openPanel()
    await fireEvent.input(document.getElementById('agent-display')!, { target: { value: '' } })
    await pick(B.modelName)
    setModel('agent', C)
    const oldGets = gets.agent
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'model-selection' })
    await waitFor(() => expect(gets.agent).toBeGreaterThan(oldGets))
    await waitFor(() => expect(screen.getByTestId('primary-model-selection-notice').textContent).toContain('changed while you were editing'))
    expect(modelTrigger().textContent).toContain(B.modelName)
    expect((document.getElementById('agent-display') as HTMLInputElement).value).toBe('')
    await fireEvent.input(document.getElementById('agent-display')!, { target: { value: 'My deliberate name' } })
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5000 })
    expect(puts[0].body).toEqual({ displayName: 'My deliberate name' })
    expect(agent.primary_model_preset_id).toBe(C.id)
    expect(modelTrigger().textContent).toContain(B.modelName)
  }, 30_000)
  it.each(['gateway', 'chatgpt'] as const)('a pure %s refresh retains the unavailable selected preset and dirty draft until deliberate human refresh', async kind => {
    const connection = kind === 'gateway' ? { id: 'vercel-gateway', type: 'vercel-gateway', service: 'vercel' }
      : { id: 'chatgpt-plan:00000000-0000-0000-0000-000000000001', type: 'direct', service: 'chatgpt-plan' }
    const protectedPreset = { ...C, connection, isVercelImport: kind === 'gateway', catalogModelId: 'openai/model-c', effectiveModelId: 'openai/model-c', vercelSourceId: 'openai/model-c',
      unavailableReason: kind === 'gateway' ? 'Vercel AI Gateway no longer lists this model' : 'Reconnect this ChatGPT account in Settings → API Keys on this Mac.' }
    presets.splice(2, 1, protectedPreset)
    const fixtureFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).split('?')[0] === '/api/models'
      ? answer({ data: { connections: [{ id: connection.id, transport: connection.type, service: connection.service, status: 'ready', providers: null }] } }) : fixtureFetch(input, init))
    setModel('agent', protectedPreset)
    await openPanel()
    const name = document.getElementById('agent-display') as HTMLInputElement
    await fireEvent.input(name, { target: { value: '' } })
    await pick(B.modelName)
    expect(modelTrigger().textContent).toContain(B.modelName)
    expect(puts).toEqual([])
    const before = vi.mocked(fetch).mock.calls.length
    emit({ type: 'model_presets_changed' })
    await waitFor(() => expect(savedModelsStore.getIsLoading()).toBe(false))
    expect(savedModelsStore.getSavedModels().find(model => model.id === C.id)?.unavailableReason).toBe(protectedPreset.unavailableReason)
    expect(modelTrigger().textContent).toContain(B.modelName); expect(name.value).toBe('')
    await fireEvent.keyDown(modelTrigger(), { key: 'ArrowDown' })
    const unavailable = await screen.findByRole('option', { name: new RegExp(C.modelName) })
    expect(unavailable).toHaveAttribute('data-disabled')
    await fireEvent.pointerUp(unavailable, { pointerType: 'mouse' })
    expect(modelTrigger().textContent).toContain(B.modelName)
    expect(puts).toEqual([])
    await fireEvent.keyDown(unavailable, { key: 'Escape' })
    const automatic = vi.mocked(fetch).mock.calls.slice(before).map(([url]) => String(url))
    expect(automatic).not.toContain('/api/user/saved-models'); expect(automatic).not.toContain('/api/models')
    const baseFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/user/saved-models'
      ? answer({ models: presets.map(({ unavailableReason: _reason, ...model }: any) => model) }) : baseFetch(input, init))
    await fireEvent.click(screen.getByTitle('Refresh Saved Models'))
    await waitFor(() => expect(savedModelsStore.getSavedModels().find(model => model.id === C.id)?.unavailableReason).toBeUndefined())
    expect(modelTrigger().textContent).toContain(B.modelName); expect(name.value).toBe(''); expect(puts).toEqual([])
    await fireEvent.keyDown(modelTrigger(), { key: 'ArrowDown' })
    const available = await screen.findByRole('option', { name: new RegExp(C.modelName) })
    expect(available).not.toHaveAttribute('data-disabled')
    await fireEvent.pointerUp(available, { pointerType: 'mouse' })
    expect(modelTrigger().textContent).toContain(C.modelName)
    expect(name.value).toBe('')
    expect(puts).toEqual([])
  }, 30000)

  it('A12 copy notification refreshes only the stored list while an unknown model draft/base remains held without replay', async () => {
    await openPanel()
    const originalBase = revision(agent)
    unknownNext = true
    await pick(B.modelName)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5000 })
    await screen.findByTestId('primary-model-selection-notice')
    const copied = { ...A, id: 'a12-visible-copy', modelName: 'A12 new named copy' }
    presets.push(copied)
    const before = vi.mocked(fetch).mock.calls.length
    emit({ type: 'model_presets_changed' })
    await waitFor(() => expect(savedModelsStore.getSavedModels().some(model => model.id === copied.id)).toBe(true))
    expect(modelTrigger().textContent).toContain(B.modelName)
    expect(screen.getByTestId('primary-model-selection-notice').textContent).toContain('unconfirmed')
    expect(puts).toHaveLength(1); expect(puts[0].body.expectedModelSelection).toBe(originalBase)
    const reads = vi.mocked(fetch).mock.calls.slice(before).map(([url]) => String(url))
    expect(reads.some(url => url.includes('projection=stored'))).toBe(true)
    expect(reads).not.toContain('/api/user/saved-models'); expect(reads).not.toContain('/api/models')
  }, 30000)

  it('retains an unconfirmed model command across a later read, with no automatic replay', async () => {
    await openPanel()
    unknownNext = true
    await pick(B.modelName)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5000 })
    await screen.findByText(/This model save is unconfirmed/)
    expect(screen.getByRole('button', { name: 'Clear Saved Model', exact: true })).toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Clear Saved Model', exact: true }))
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'model-selection' })
    await pause(1200)
    expect(puts).toHaveLength(1)
    expect(screen.getByText(/This model save is unconfirmed/)).toBeTruthy()
    expect(screen.queryByText('Your unsaved edits are being kept.')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Model' }))
    await screen.findByText(/An earlier model save remains unconfirmed/)
    await pause()
    expect(puts).toHaveLength(1)
  }, 30_000)
  it('keeps a confirmed save distinct from a failed current read and retries only the read', async () => {
    await openPanel()
    const initialReads = gets.agent
    failReadAfterSave = true
    await pick(B.modelName)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5000 })
    await waitFor(() => expect(gets.agent).toBeGreaterThan(initialReads))
    await waitFor(() => expect(screen.getByTestId('primary-model-selection-notice').textContent).toContain('The model was saved'))
    const readFailure = screen.getByTestId('primary-model-selection-notice')
    expect(within(readFailure).getByRole('button', { name: 'Use Saved Model' })).toBeTruthy()
    expect(screen.queryByText('Your unsaved edits are being kept.')).toBeNull()
    expect(agent.primary_model_preset_id).toBe(B.id)
    await pause()
    expect(puts).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Model' }))
    await waitFor(() => expect(screen.queryByTestId('primary-model-selection-notice')).toBeNull())
    expect(puts).toHaveLength(1)
  }, 30_000)
  it('acquires a Subagent detail base and refuses a held stale pick without rebasing or saving on refresh', async () => {
    await openPanel('subagent')
    const originalBase = revision(subagent)
    beforePut = () => setModel('subagent', C)
    await pick(B.modelName)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5000 })
    expect(puts[0]).toMatchObject({ kind: 'subagent', status: 409, body: { expectedModelSelection: originalBase, primary_model_preset_id: B.id } })
    emit({ type: 'subagent_settings_changed', agentId: SUB, family: 'model-selection' })
    await pause(1200)
    expect(modelTrigger().textContent).toContain(B.modelName)
    expect(puts).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Model' }))
    await waitFor(() => expect(modelTrigger().textContent).toContain(C.modelName))
    expect(puts).toHaveLength(1)
  }, 30_000)
  it('refreshes a clean Subagent model on reconnect beside an unrelated invalid draft', async () => {
    await openPanel('subagent')
    await fireEvent.input(document.getElementById('subagent-display')!, { target: { value: '' } })
    setModel('subagent', C)
    const oldGets = gets.subagent
    emit({ type: 'reconnected' })
    await waitFor(() => expect(gets.subagent).toBeGreaterThan(oldGets))
    await waitFor(() => expect(modelTrigger().textContent).toContain(C.modelName))
    expect((document.getElementById('subagent-display') as HTMLInputElement).value).toBe('')
    const notice = screen.getByTestId('subagent-settings-read-wait')
    expect(notice.textContent).toContain('Your unsaved edits are being kept.')
    expect(within(notice).queryByRole('button', { name: 'Retry' })).toBeNull()
    await pause()
    expect(puts).toEqual([])
  }, 30_000)
  it('keeps genuine pending reads distinct from the deferred-draft information cue', async () => {
    await openPanel()
    await fireEvent.input(document.getElementById('agent-display')!, { target: { value: '' } })
    holdNextRead = new Promise(resolve => { releaseRead = resolve })
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'model-selection' })
    await waitFor(() => expect(screen.getByTestId('primary-settings-read-wait').textContent).toContain('Waiting for saved agent settings'))
    const pending = screen.getByTestId('primary-settings-read-wait')
    expect(within(pending).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(pending.textContent).not.toContain('Your unsaved edits are being kept.')
    releaseRead!()
    await waitFor(() => expect(screen.getByTestId('primary-settings-read-wait').textContent).toContain('Your unsaved edits are being kept.'))
    expect((document.getElementById('agent-display') as HTMLInputElement).value).toBe('')
    await pause(); expect(puts).toEqual([])
    failNextRead = true
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'model-selection' })
    await waitFor(() => expect(screen.getByTestId('primary-settings-read-wait').textContent).toContain('Read unavailable.'))
    expect(within(screen.getByTestId('primary-settings-read-wait')).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText('Your unsaved edits are being kept.')).toBeNull()
    expect(puts).toEqual([])
  }, 30_000)
  it('retains genuine failed non-model save recovery beside a deferred model refresh', async () => {
    await openPanel()
    failNonModelSave = true
    await fireEvent.input(document.getElementById('agent-display')!, { target: { value: 'Unsaved failed name' } })
    await waitFor(() => expect(puts.some(put => put.status === 500)).toBe(true), { timeout: 5000 })
    await pause()
    setModel('agent', C)
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'model-selection' })
    await waitFor(() => expect(modelTrigger().textContent).toContain(C.modelName))
    await pause()
    const waiting = screen.getByTestId('primary-settings-read-wait')
    expect(within(waiting).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText('Your unsaved edits are being kept.')).toBeNull()
    expect((document.getElementById('agent-display') as HTMLInputElement).value).toBe('Unsaved failed name')
    expect(puts.every(put => put.status === 500 && !('primary_model_preset_id' in put.body))).toBe(true)
  }, 30_000)
})
