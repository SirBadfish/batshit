import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModelSelector from './ModelSelector.svelte'
import * as agents from '$lib/stores/agents.svelte'
import * as models from '$lib/stores/savedModels.svelte'
import { MODEL_SELECTION_REVISION_HEADER } from '$lib/appActions/settings/modelSelectionBaseline'
import { buildPickedPresetSelection } from '$lib/utils/modelPresetPick'
import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'

const notices = vi.hoisted(() => ({ errors: [] as string[] }))
const channel = vi.hoisted(() => ({ listeners: new Set<(event: any) => void>() }))
vi.mock('$lib/services/userChannel', async original => ({ ...(await original<Record<string, unknown>>()),
  onUserChannelEvent: (listener: (event: any) => void) => { channel.listeners.add(listener); return () => channel.listeners.delete(listener) } }))
vi.mock('svelte-sonner', async original => {
  const actual = await original<Record<string, any>>()
  return { ...actual, toast: { ...actual.toast, error: (text: string) => notices.errors.push(text) } }
})
const A = { id: 'a', provider: 'openai', modelId: 'model-a', modelName: 'Menu Model A', purpose: 'chat', connection: { type: 'direct', service: 'openai' }, settings: {} }
const B = { ...A, id: 'b', modelId: 'model-b', modelName: 'Menu Model B' }
const C = { ...A, id: 'c', modelId: 'model-c', modelName: 'Menu Model C' }
const revision = (row: Record<string, any>) => `sha256:${String(row.primary_model_preset_id).repeat(64)}`
let row: Record<string, any>, puts: Record<string, any>[], detailReads: number, unknown: boolean
let available: Array<Record<string, any>>
let releaseRead: (() => void) | null, holdRead: Promise<void> | null
let releasePut: (() => void) | null, holdPut: Promise<void> | null
let connectionHolds: Promise<void>[], releaseConnections: Array<() => void>, connectionReads: number
let connectionPayload: unknown
const pause = () => new Promise(resolve => setTimeout(resolve, 500))
beforeEach(() => {
  notices.errors = []; puts = []; detailReads = 0; unknown = false; releaseRead = null; holdRead = null
  releasePut = null; holdPut = null
  channel.listeners.clear(); connectionHolds = []; releaseConnections = []; connectionReads = 0
  connectionPayload = { data: { connections: [{ id: 'direct:openai', transport: 'direct', status: 'ready', providers: ['openai'] },
    { id: 'claude-cli', transport: 'direct', status: 'locked', providers: ['anthropic-claude-cli'], requiresApiKey: false }] } }
  available = [A, B, C]
  row = { id: 'menu-agent', user_id: 'menu-owner', displayName: 'Menu agent', agentType: 'api', ...buildPickedPresetSelection(A as any), primary_model_capabilities: { vision: true } }
  agents.setAgents([row as any]); agents.setCurrentAgentId(row.id); models.setSavedModels([])
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null }) })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value() {} })
  Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value() {} })
  Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]
    if (path === '/api/user/saved-models') return Response.json(String(input).includes('projection=stored')
      ? { projection: 'stored', models: available, total: available.length, offset: 0, nextOffset: null } : { models: available })
    if (path === '/api/models') {
      connectionReads += 1
      const response = Response.json(connectionPayload)
      const held = connectionHolds.shift(); if (held) await held
      return response
    }
    if (path === `/api/agents/${row.id}`) {
      if (init.method !== 'PUT') {
        detailReads += 1
        const response = Response.json(row, { headers: { [MODEL_SELECTION_REVISION_HEADER]: revision(row) } })
        if (holdRead) { const held = holdRead; holdRead = null; await held }
        return response
      }
      const body = JSON.parse(String(init.body)); puts.push(body)
      if (holdPut) { const held = holdPut; holdPut = null; await held }
      if (body.expectedModelSelection !== revision(row)) return Response.json({ code: 'model_selection_settings_changed', error: 'Saved model changed.' }, { status: 409 })
      const { expectedModelSelection: _base, ...stored } = body
      Object.assign(row, stored)
      return unknown ? Response.json({ code: 'model_selection_save_unconfirmed' }, { status: 503 }) : Response.json({ success: true })
    }
    return Response.json({ error: `Unhandled ${path}` }, { status: 404 })
  }))
})
afterEach(() => { releaseRead?.(); releasePut?.(); releaseConnections.forEach(release => release()); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); agents.setAgents([]); agents.setCurrentAgentId(null); models.setSavedModels([]) })
async function open() {
  await fireEvent.keyDown(screen.getByTestId('model-selector'), { key: 'ArrowDown' })
  await waitFor(() => expect(detailReads).toBeGreaterThan(0))
}
const item = (name: string) => screen.getByText(name).closest('[role="menuitem"]')!
describe('the mounted chat model picker owns its shown base', () => {
  it('SA-139: a Claude plan preset is locked with its reason, then picked with the shared preset payload once ready', async () => {
    const PLAN = { id: 'plan', provider: 'anthropic', modelId: 'opus', effectiveModelId: 'opus', modelName: 'Menu Claude plan', purpose: 'chat',
      connection: { id: 'claude-plan:local', type: 'direct', service: 'claude-plan' }, settings: { anthropicEffort: 'high' }, pricing: {} }
    available = [A, PLAN]
    const plan = (status: 'ready' | 'locked') => ({ id: 'claude-plan:local', transport: 'direct', service: 'claude-plan', providers: ['anthropic'], status,
      ...(status === 'locked' ? { lockedReason: 'Claude plan replies are not available in this Batshit build yet.' } : {}) })
    connectionPayload = { data: { connections: [{ id: 'direct:openai', transport: 'direct', status: 'ready', providers: ['openai'] }, plan('locked')] } }
    const saved = structuredClone(row)
    render(ModelSelector, { props: {} })
    await open()
    await waitFor(() => expect(screen.queryByText('Loading connection status…')).toBeNull())
    expect(item(PLAN.modelName).getAttribute('aria-disabled')).toBe('true')
    await fireEvent.click(item(PLAN.modelName))
    await pause()
    expect(puts).toEqual([])
    expect(row).toEqual(saved)

    // The connection's live event (LS-007) refreshes the open menu without a reload.
    connectionPayload = { data: { connections: [{ id: 'direct:openai', transport: 'direct', status: 'ready', providers: ['openai'] }, plan('ready')] } }
    dispatchModelConnectionsUpdated('api-keys')
    await waitFor(() => expect(connectionReads).toBe(2))
    await waitFor(() => expect(item(PLAN.modelName).getAttribute('aria-disabled')).not.toBe('true'))
    await fireEvent.click(item(PLAN.modelName))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toMatchObject({ ...buildPickedPresetSelection(PLAN as any), expectedModelSelection: revision(saved) })
    expect(puts[0]).toMatchObject({ primary_model_connection: PLAN.connection, primary_model_provider: 'anthropic', primary_model_name: 'opus',
      primary_model_temperature: null, provider_specific_settings: { anthropicEffort: 'high' } })

    // And back: a sign-out reported by the same event locks it again, still without a reload.
    connectionPayload = { data: { connections: [{ id: 'direct:openai', transport: 'direct', status: 'ready', providers: ['openai'] }, plan('locked')] } }
    dispatchModelConnectionsUpdated('api-keys')
    await waitFor(() => expect(connectionReads).toBe(3))
    await open()
    const planRow = () => screen.getAllByText(PLAN.modelName).map(node => node.closest('[role="menuitem"]')).find(Boolean)!
    await waitFor(() => expect(planRow().getAttribute('aria-disabled')).toBe('true'))
    expect(puts).toHaveLength(1)
  })

  it.each(['ready', 'locked'] as const)('blocks malformed connections with a valid agent base, retains the saved choice, and recovers to %s once on reopen', async status => {
    connectionPayload = { data: { connections: {} } }
    connectionHolds = [new Promise<void>(resolve => { releaseConnections.push(resolve) })]
    const saved = structuredClone(row)
    render(ModelSelector, { props: {} })
    await open()
    await waitFor(() => expect(screen.queryByText('Reading saved model selection…')).toBeNull())
    releaseConnections[0]()
    await waitFor(() => expect(screen.queryByText('Loading connection status…')).toBeNull())
    expect(detailReads).toBe(1)
    expect(item(B.modelName).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('Connection status could not be read. Close and reopen this menu to retry.')).toBeTruthy()
    await fireEvent.click(item(B.modelName))
    await pause()
    expect(connectionReads).toBe(1)
    expect(puts).toEqual([])
    expect(row).toEqual(saved)
    expect(agents.getCurrentAgent()).toMatchObject(saved)
    expect(screen.getByTestId('model-selector').textContent).toContain(A.modelName)

    connectionPayload = { data: { connections: [{ id: 'direct:openai', status }] } }
    await fireEvent.keyDown(screen.getByRole('menu', { hidden: true }), { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('model-selector').getAttribute('aria-expanded')).toBe('false'))
    await open()
    await waitFor(() => expect(connectionReads).toBe(2))
    await waitFor(() => expect(screen.queryByText('Loading connection status…')).toBeNull())
    expect(screen.queryByText('Connection status could not be read. Close and reopen this menu to retry.')).toBeNull()
    expect(item(B.modelName).getAttribute('aria-disabled') === 'true').toBe(status === 'locked')
    expect(puts).toEqual([])
    expect(row).toEqual(saved)
    expect(agents.getCurrentAgent()).toMatchObject(saved)

    await fireEvent.keyDown(screen.getByRole('menu', { hidden: true }), { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('model-selector').getAttribute('aria-expanded')).toBe('false'))
    await open()
    await pause()
    expect(connectionReads).toBe(2)
    if (status === 'ready') {
      await fireEvent.click(item(B.modelName))
      await waitFor(() => expect(puts).toHaveLength(1))
      expect(puts[0]).toMatchObject({ primary_model_preset_id: B.id, expectedModelSelection: revision(saved) })
    } else {
      await fireEvent.click(item(B.modelName))
      expect(puts).toEqual([])
      expect(row).toEqual(saved)
    }
  })

  it('uses only the central pure stored refresh after a selection event, without a catalog/account read or model replay', async () => {
    render(ModelSelector, { props: {} })
    await open()
    await waitFor(() => expect(item(B.modelName).getAttribute('aria-disabled')).not.toBe('true'))
    const before = vi.mocked(fetch).mock.calls.length
    // The unchanged channel owner starts the one pure read before notifying listeners.
    const stored = models.refreshStoredSavedModels()
    channel.listeners.forEach(listener => listener({ type: 'agent_settings_changed', agentId: row.id, family: 'model-selection' }))
    await stored
    const urls = vi.mocked(fetch).mock.calls.slice(before).map(([url]) => String(url))
    expect(urls).toHaveLength(1); expect(urls[0]).toContain('projection=stored')
    expect(puts).toEqual([])
  })
  it('reconnect cannot publish a held old connection answer; one later human reopen waits for current metadata before a pick', async () => {
    connectionHolds = [0, 1].map(() => new Promise<void>(resolve => { releaseConnections.push(resolve) }))
    render(ModelSelector, { props: {} })
    await open()
    await waitFor(() => expect(connectionReads).toBe(1))
    channel.listeners.forEach(listener => listener({ type: 'reconnected' }))
    expect(connectionReads).toBe(1)
    await fireEvent.keyDown(screen.getByRole('menu', { hidden: true }), { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('model-selector').getAttribute('aria-expanded')).toBe('false'))
    await open()
    releaseConnections[0]()
    await waitFor(() => expect(connectionReads).toBe(2))
    expect(item(B.modelName).getAttribute('aria-disabled')).toBe('true')
    expect(puts).toEqual([])
    releaseConnections[1]()
    await waitFor(() => expect(item(B.modelName).getAttribute('aria-disabled')).not.toBe('true'))
    await fireEvent.click(item(B.modelName))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toMatchObject({ primary_model_preset_id: B.id, expectedModelSelection: `sha256:${'a'.repeat(64)}` })
  })
  it('drains one deferred external event after a held stale PUT409 and shows the current model without reopening', async () => {
    render(ModelSelector, { props: {} })
    await open()
    await waitFor(() => expect(item(B.modelName).getAttribute('aria-disabled')).not.toBe('true'))
    holdPut = new Promise(resolve => { releasePut = resolve })
    await fireEvent.click(item(B.modelName))
    await waitFor(() => expect(puts).toHaveLength(1))
    Object.assign(row, buildPickedPresetSelection(C as any))
    const before = detailReads
    await agents.refreshAgentFieldsFromServer(row.id, 'model-selection')
    expect(detailReads).toBe(before)
    releasePut!()
    await waitFor(() => expect(notices.errors.join(' ')).toContain('was not saved'))
    await waitFor(() => expect(agents.getCurrentAgent()?.primary_model_preset_id).toBe(C.id))
    expect(screen.getByTestId('model-selector').textContent).toContain(C.modelName)
    expect(detailReads).toBe(before + 1)
    await pause(); expect(puts).toHaveLength(1)
  })
  it('waits for its detail read and keeps the menu-open base when a later external model wins', async () => {
    holdRead = new Promise(resolve => { releaseRead = resolve })
    render(ModelSelector, { props: {} })
    await open()
    expect(item(B.modelName).getAttribute('aria-disabled')).toBe('true')
    releaseRead!()
    await waitFor(() => expect(item(B.modelName).getAttribute('aria-disabled')).not.toBe('true'))
    Object.assign(row, buildPickedPresetSelection(C as any))
    agents.updateAgent(row.id, { ...row })
    await fireEvent.click(item(B.modelName))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toMatchObject({ expectedModelSelection: `sha256:${'a'.repeat(64)}`, primary_model_preset_id: B.id, primary_model_capabilities: null })
    await waitFor(() => expect(notices.errors.join(' ')).toContain('was not saved'))
    expect(row.primary_model_preset_id).toBe(C.id)
    expect(agents.getCurrentAgent()?.primary_model_preset_id).toBe(C.id)
    await pause()
    expect(puts).toHaveLength(1)
  })
  it('does not replay an unconfirmed choice; reopening reads the current row and clears no newer capabilities by fallback', async () => {
    render(ModelSelector, { props: {} })
    await open()
    await waitFor(() => expect(item(B.modelName).getAttribute('aria-disabled')).not.toBe('true'))
    unknown = true
    await fireEvent.click(item(B.modelName))
    await waitFor(() => expect(notices.errors.join(' ')).toContain('unconfirmed'))
    expect(puts[0].primary_model_capabilities).toBeNull()
    await open()
    await waitFor(() => expect(detailReads).toBe(2))
    await pause()
    expect(puts).toHaveLength(1)
    expect(agents.getCurrentAgent()?.primary_model_preset_id).toBe(B.id)
  })
})
