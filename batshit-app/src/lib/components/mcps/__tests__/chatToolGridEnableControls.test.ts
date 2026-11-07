import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/svelte'
import { CLI_GROUP_KEY, cliGroupEnablePatch, applyCliDcmPatch } from '$lib/utils/cliToolGridEnable'
import { applyAgentProviderSettingsUpdate } from '$lib/utils/agentProviderSettings'
import * as agents from '$lib/stores/agents.svelte'
import { createChatToolGridEnableControls } from '../chatToolGridEnableControls.svelte'

const REV = `sha256:${'a'.repeat(64)}`
const NEXT = `sha256:${'b'.repeat(64)}`
const makeAgent = (id = 'native-grid', native: Record<string, unknown> = {}) => ({
  id, user_id: 'grid-owner', created_at: 'original-birth', agentType: 'api', displayName: id,
  provider_specific_settings: { temperature: 0.3, nativeTools: { typedFileToolsEnabled: false, bashEnabled: true, executionBackend: 'local', webSearchEnabled: true, ...native } }
})
const json = (value: unknown, status = 200, revision = REV) => new Response(JSON.stringify(value), { status, headers: { 'x-batshit-typed-file-tools-revision': revision } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const cleanups: Array<() => void> = []

function setup(options: { agent?: ReturnType<typeof makeAgent> & { dcmDisplaySettings?: any; dcm_display_settings?: any }; hostFails?: boolean; put?: (body: any) => Promise<Response>; read?: () => Promise<Response> } = {}) {
  const original: ReturnType<typeof makeAgent> & { dcmDisplaySettings?: any; dcm_display_settings?: any } = options.agent ?? makeAgent()
  agents.setAgents([original as any])
  agents.setCurrentAgentId(original.id)
  let persisted = structuredClone(original)
  let hostFails = options.hostFails ?? false
  let readRevision = REV
  const puts: any[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('hostOnly=1')) return hostFails ? json({ error: 'offline' }, 503) : json({ typedFileToolsHost: { platform: 'darwin', containerized: false, linuxKernel: null } })
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); puts.push(body)
      if (options.put) return options.put(body)
      if (body.dcmDisplaySettings) persisted = { ...persisted, dcmDisplaySettings: applyCliDcmPatch(persisted.dcmDisplaySettings ?? persisted.dcm_display_settings, body.dcmDisplaySettings) }
      persisted = { ...persisted, provider_specific_settings: applyAgentProviderSettingsUpdate(persisted.provider_specific_settings, body.provider_specific_settings) as any }
      return json({ success: true, ...(body.expectedTypedFileTools ? { typedFileTools: { revision: NEXT, value: body.provider_specific_settings.nativeTools.typedFileToolsEnabled } } : {}) })
    }
    return options.read ? options.read() : json(persisted, 200, readRevision)
  })
  vi.stubGlobal('fetch', fetchMock)
  const refresh = vi.fn((id: string) => { void agents.refreshAgentFieldsFromServer(id, 'provider-settings') })
  const controller = createChatToolGridEnableControls({
    getAgent: () => agents.getAgentById(agents.getCurrentAgentId() ?? ''),
    readState: agents.getAgentProviderSettingsReadState,
    refresh,
    cliSnapshot: () => { const row = agents.getAgentById(agents.getCurrentAgentId() ?? '') as any; return row?.dcmDisplaySettings ?? row?.dcm_display_settings },
    installCli: (owner, patch, record) => {
      const row = agents.getAgentById(owner.id) as any
      if (row) agents.updateAgent(owner.id, record && record.dcmDisplaySettings == null && record.dcm_display_settings != null
        ? { ...row, dcm_display_settings: applyCliDcmPatch(row.dcm_display_settings, patch) }
        : { dcmDisplaySettings: applyCliDcmPatch(row.dcmDisplaySettings ?? row.dcm_display_settings, patch) })
    },
    install: (owner, fields) => {
      const current = agents.getAgentById(owner.id)
      if (!current || current.user_id !== owner.user_id || current.created_at !== owner.created_at || current.agentType !== owner.agentType) return
      agents.updateAgent(owner.id, { provider_specific_settings: applyAgentProviderSettingsUpdate(current.provider_specific_settings, { nativeTools: fields }) })
    }
  })
  cleanups.push(() => controller.dispose())
  controller.sync()
  return { controller, puts, fetchMock, refresh, original, setHostFails(value: boolean) { hostFails = value }, setRevision(value: string) { readRevision = value }, setPersisted(value: typeof original) { persisted = value } }
}
async function ready(controller: ReturnType<typeof createChatToolGridEnableControls>) {
  await waitFor(() => expect(controller.control('typed_file_tools')?.disabled).toBe(false))
}
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); agents.setAgents([]); agents.setCurrentAgentId(null); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('compact Tool Grid native choices use the selected agent and existing save contract', () => {
  it('reads without saves and sends only the selected native leaf, preserving provider siblings', async () => {
    const { controller, puts } = setup()
    await ready(controller)
    expect(puts).toEqual([])
    controller.control('web_search')!.onChange(false)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]).toEqual({ provider_specific_settings: { nativeTools: { webSearchEnabled: false } } })
    await waitFor(() => expect(controller.control('web_search')?.checked).toBe(false))
    expect(agents.getAgentById('native-grid')?.provider_specific_settings).toMatchObject({ temperature: 0.3, nativeTools: { typedFileToolsEnabled: false, bashEnabled: true, executionBackend: 'local' } })
  })

  it('keeps original typed grant token and advances only a matching actual acknowledgement', async () => {
    const { controller, puts } = setup()
    await ready(controller)
    controller.control('typed_file_tools')!.onChange(true)
    await waitFor(() => expect(controller.control('typed_file_tools')?.checked).toBe(true))
    await waitFor(() => expect(controller.control('typed_file_tools')?.disabled).toBe(false))
    expect(puts[0]).toEqual({ expectedTypedFileTools: REV, provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true } } })
    controller.control('typed_file_tools')!.onChange(false)
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1].expectedTypedFileTools).toBe(NEXT)
  })

  it.each([
    [409, 'typed_file_tools_changed', 'not saved'],
    [400, 'typed_file_tools_base_required', 'not saved'],
    [409, 'other_conflict', 'unconfirmed'],
    [404, undefined, 'unconfirmed'],
    [200, undefined, 'unconfirmed']
  ])('classifies status %s with owning code %s without replaying', async (status, code, notice) => {
    const { controller, puts } = setup({ put: async () => json({ code }, status) })
    await ready(controller)
    controller.control('typed_file_tools')!.onChange(true)
    await waitFor(() => expect(controller.control('typed_file_tools')?.notice).toContain(notice))
    expect(controller.control('typed_file_tools')?.checked).toBe(true)
    expect(controller.control('typed_file_tools')?.disabled).toBe(true)
    controller.sync()
    controller.control('typed_file_tools')!.onChange(false)
    expect(puts).toHaveLength(1)
  })

  it('an old selected-agent callback cannot write after the user picks another agent', async () => {
    const { controller, puts } = setup()
    await ready(controller)
    const oldControl = controller.control('web_search')!
    agents.addAgent(makeAgent('other-agent') as any)
    agents.setCurrentAgentId('other-agent')
    controller.sync()
    oldControl.onChange(false)
    expect(puts).toEqual([])
  })

  it('a clean live Typed File Tools change gets a fresh original base without writing', async () => {
    const { controller, puts, setPersisted, setRevision, original } = setup()
    await ready(controller)
    const next = makeAgent(original.id, { typedFileToolsEnabled: true })
    setPersisted(next)
    setRevision(NEXT)
    agents.updateAgent(original.id, { provider_specific_settings: next.provider_specific_settings })
    controller.sync()
    await waitFor(() => expect(controller.control('typed_file_tools')?.disabled).toBe(false))
    expect(controller.control('typed_file_tools')?.checked).toBe(true)
    expect(puts).toEqual([])
    controller.control('typed_file_tools')!.onChange(false)
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].expectedTypedFileTools).toBe(NEXT)
  })

  it('malformed native settings never become an empty confirmed recovery read', async () => {
    const { controller, setPersisted, original, puts } = setup()
    await ready(controller)
    setPersisted({ ...original, provider_specific_settings: { nativeTools: 'malformed' } } as any)
    controller.control('typed_file_tools')!.onRead!()
    await waitFor(() => expect(controller.control('typed_file_tools')?.notice).toContain('not a valid'))
    expect(agents.getAgentById(original.id)?.provider_specific_settings?.nativeTools.bashEnabled).toBe(true)
    expect(puts).toEqual([])
  })

  it('an older ACK cannot overwrite a newer remotely refreshed same-leaf value', async () => {
    const put = deferred<Response>()
    const { controller, refresh, setPersisted, original } = setup({ put: () => put.promise })
    await ready(controller)
    controller.control('web_search')!.onChange(false)
    const latest = makeAgent()
    setPersisted(latest)
    // This real store owner installs via agents.map, without changing its write generation.
    const generation = agents.getAgentProviderSettingsReadState(original.id).generation
    const before = agents.getAgentById(original.id)
    await agents.refreshAgentFieldsFromServer(original.id, 'provider-settings')
    expect(agents.getAgentById(original.id)).not.toBe(before)
    expect(agents.getAgentProviderSettingsReadState(original.id).generation).toBe(generation)
    put.resolve(json({ success: true }))
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(original.id))
    expect(agents.getAgentById(original.id)?.provider_specific_settings?.nativeTools.webSearchEnabled).toBe(true)
  })

  it('a superseded clean initial detail read follows the newer accepted store without a write', async () => {
    const oldRead = deferred<Response>()
    const latest = makeAgent('native-grid', { typedFileToolsEnabled: true })
    let reads = 0
    const { controller, puts, original } = setup({ read: () => ++reads === 1 ? oldRead.promise : Promise.resolve(json(latest, 200, NEXT)) })
    await agents.refreshAgentFieldsFromServer(original.id, 'provider-settings')
    oldRead.resolve(json(original))
    await waitFor(() => expect(controller.control('typed_file_tools')?.reading).toBe(false))
    controller.sync()
    await ready(controller)
    expect(reads).toBe(3)
    expect(controller.control('typed_file_tools')?.checked).toBe(true)
    expect(controller.control('typed_file_tools')?.notice).toBe('')
    expect(puts).toEqual([])
  })

  it('recovering one unknown choice leaves another unknown native draft intact', async () => {
    const { controller, puts } = setup({ put: async () => json({ error: 'unconfirmed' }, 503) })
    await ready(controller)
    controller.control('web_search')!.onChange(false)
    await waitFor(() => expect(controller.control('web_search')?.notice).toContain('unconfirmed'))
    controller.control('agent_browser_actions')!.onChange(false)
    await waitFor(() => expect(puts).toHaveLength(2))
    await waitFor(() => expect(controller.control('agent_browser_actions')?.notice).toContain('unconfirmed'))
    await waitFor(() => expect(controller.control('agent_browser_actions')?.reading).toBe(false))
    controller.control('web_search')!.onRead!()
    await waitFor(() => expect(controller.control('web_search')?.checked).toBe(true))
    expect(controller.control('agent_browser_actions')?.checked).toBe(false)
    expect(controller.control('agent_browser_actions')?.disabled).toBe(true)
    expect(puts).toHaveLength(2)
  })

  it('a failed host read is honest and explicit saved-choice recovery retries it', async () => {
    const { controller, puts, setHostFails, fetchMock } = setup({ hostFails: true })
    await waitFor(() => expect(controller.control('typed_file_tools')?.notice).toContain('Could not check'))
    expect(controller.control('typed_file_tools')?.disabled).toBe(true)
    setHostFails(false)
    controller.control('typed_file_tools')!.onRead!()
    await ready(controller)
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('hostOnly=1'))).toHaveLength(2)
    expect(puts).toEqual([])
  })
})


describe('compact single CLI pair save', () => {
  const hidden = { version: 1, groups: { [CLI_GROUP_KEY]: 'hidden', other: 'group-only' }, tools: { member: 'hidden' }, groupDisplayPreferences: { [CLI_GROUP_KEY]: 'group+tools+names' } }
  it('a travelling acknowledgement installs the captured pair, never a later-mutated companion object', async () => {
    const gate = deferred<Response>()
    const { controller, puts } = setup({ put: async () => gate.promise })
    await ready(controller)
    const companion = cliGroupEnablePatch(hidden, 'hidden')!
    controller.control('cli_tools')!.onChange(true, companion)
    await waitFor(() => expect(puts).toHaveLength(1))
    companion.groups![CLI_GROUP_KEY] = 'hidden'
    gate.resolve(json({ success: true }))
    await waitFor(() => expect(controller.control('cli_tools')?.disabled).toBe(false))
    expect((agents.getAgentById('native-grid') as any).dcmDisplaySettings.groups[CLI_GROUP_KEY]).toBe('group+tools+names')
  })
  it('ON sends one combined request and preserves legacy display siblings; OFF changes native only', async () => {
    const { controller, puts } = setup({ agent: { ...makeAgent('native-grid', { cliToolsEnabled: false }), dcm_display_settings: hidden } })
    await ready(controller)
    controller.control('cli_tools')!.onChange(true, cliGroupEnablePatch(hidden, 'hidden'))
    await waitFor(() => expect(controller.control('cli_tools')?.disabled).toBe(false))
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ provider_specific_settings: { nativeTools: { cliToolsEnabled: true } }, dcmDisplaySettings: { groups: { other: 'group-only', [CLI_GROUP_KEY]: 'group+tools+names' }, tools: { member: 'hidden' } } })
    controller.control('cli_tools')!.onChange(false)
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toEqual({ provider_specific_settings: { nativeTools: { cliToolsEnabled: false } } })
  })
  it('holds malformed ACK then adopts both leaves only on explicit GET, preserving legacy cache shape', async () => {
    const { controller, puts } = setup({ agent: { ...makeAgent('native-grid', { cliToolsEnabled: false }), dcm_display_settings: hidden }, put: async () => json({}) })
    await ready(controller)
    controller.control('cli_tools')!.onChange(true, cliGroupEnablePatch(hidden, 'hidden'))
    await waitFor(() => expect(controller.control('cli_tools')?.notice).toContain('unconfirmed'))
    expect(controller.cliHeld).toBe(true)
    expect(controller.control('web_search')?.disabled).toBe(true)
    controller.control('cli_tools')!.onRead!()
    await waitFor(() => expect(controller.control('cli_tools')?.disabled).toBe(false))
    expect(controller.control('cli_tools')?.checked).toBe(false)
    expect((agents.getAgentById('native-grid') as any).dcmDisplaySettings).toBeUndefined()
    expect((agents.getAgentById('native-grid') as any).dcm_display_settings).toMatchObject(hidden)
    expect(puts).toHaveLength(1)
  })
  it('rejects a stale same-actor callback after a newer accepted record', async () => {
    const { controller, puts } = setup()
    await ready(controller)
    const old = controller.control('cli_tools')!
    const current = agents.getAgentById('native-grid')!
    agents.updateAgent(current.id, { provider_specific_settings: { ...current.provider_specific_settings, nativeTools: { ...current.provider_specific_settings?.nativeTools, cliToolsEnabled: false } } })
    old.onChange(true, cliGroupEnablePatch(hidden, 'hidden'))
    expect(puts).toHaveLength(0)
  })
})
