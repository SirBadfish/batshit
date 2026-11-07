import { getModelPresetAvailability } from '$lib/utils/modelPresetAvailability'
import * as savedModels from '$lib/stores/savedModels.svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
import { setUserSettings } from '$lib/stores/userSettings.svelte'
import type { LiveSubscriptionHandlers, LiveTarget } from '$lib/services/liveHub/liveHubClient'

/**
 * The user channel over the live hub (2026-09-18): one subscription per tab, however many
 * components hold it, applied to the sidebar's stores and handed to every listener.
 */

const toolOperations = vi.hoisted(() => ({ refresh: vi.fn(async () => null), owner: vi.fn() }))
vi.mock('$lib/stores/toolOperationalSettings.svelte', () => ({ refreshToolOperationsSource: toolOperations.refresh, setToolOperationsOwner: toolOperations.owner }))

const hub = vi.hoisted(() => ({ subscriptions: [] as any[] }))
const stores = vi.hoisted(() => ({
  agents: [] as Array<{ id: string }>,
  subagents: [] as Array<{ id: string }>,
  upsertSession: vi.fn(),
  patchSessionFromServer: vi.fn(),
  deleteSession: vi.fn(),
  applyServerRunStatus: vi.fn(),
  resetRunState: vi.fn(),
  applyDmInboxChanged: vi.fn(),
  refreshAgentFieldsFromServer: vi.fn(async () => {}),
  refreshSubagentModelSelectionFromServer: vi.fn(async () => {}),
  refreshSubagentInstructionsFromServer: vi.fn(async () => {}),
  refreshSubagentProviderSettingsFromServer: vi.fn(async () => {})
}))

vi.mock('$lib/services/liveHub/liveHubClient', () => ({
  subscribeLive: vi.fn((target: LiveTarget, handlers: LiveSubscriptionHandlers) => {
    const subscription = {
      target,
      handlers,
      current: 'pending',
      unsubscribed: false,
      state: () => subscription.current,
      unsubscribe: () => {
        subscription.unsubscribed = true
      }
    }
    hub.subscriptions.push(subscription)
    return subscription
  })
}))
vi.mock('$lib/stores/session.svelte', () => ({
  upsertSession: stores.upsertSession,
  patchSessionFromServer: stores.patchSessionFromServer,
  deleteSession: stores.deleteSession
}))
vi.mock('$lib/stores/chatRunRegistry.svelte', () => ({
  applyServerRunStatus: stores.applyServerRunStatus,
  resetRunState: stores.resetRunState
}))
vi.mock('$lib/stores/dmInbox.svelte', () => ({
  applyDmInboxChanged: stores.applyDmInboxChanged
}))
vi.mock('$lib/stores/agents.svelte', () => ({
  getAgents: () => stores.agents,
  refreshAgentFieldsFromServer: stores.refreshAgentFieldsFromServer
}))
vi.mock('$lib/stores/subagents.svelte', () => ({
  subagentStore: { get subagents() { return stores.subagents } },
  refreshSubagentIdentityFromServer: vi.fn(async () => {}),
  refreshSubagentModelSelectionFromServer: stores.refreshSubagentModelSelectionFromServer,
  refreshSubagentInstructionsFromServer: stores.refreshSubagentInstructionsFromServer,
  refreshSubagentProviderSettingsFromServer: stores.refreshSubagentProviderSettingsFromServer
}))

import {
  isUserChannelConnected,
  onUserChannelEvent,
  startUserChannel,
  stopUserChannel
} from './userChannel'

afterEach(async () => { stopUserChannel(); await vi.waitFor(() => expect(savedModels.getIsLoading()).toBe(false)); vi.unstubAllGlobals() })

describe('user channel over the live hub', () => {
  beforeEach(() => {
    stopUserChannel()
    hub.subscriptions.length = 0
    vi.clearAllMocks()
    stores.agents = []; stores.subagents = []
    setUserSettings({})
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ projection: 'stored', models: [], total: 0, offset: 0, nextOffset: null })))
  })

  it('refreshes global tool options on their value-free event and reconnect, and drops the owner on logout', () => {
    startUserChannel('josh')
    expect(toolOperations.owner).toHaveBeenLastCalledWith('josh')
    const { handlers } = hub.subscriptions[0]
    handlers.onEvent(JSON.stringify({ type: 'user_settings_changed', family: 'tool-operations' }))
    expect(toolOperations.refresh).toHaveBeenCalledOnce()
    handlers.onEvent(JSON.stringify({ type: 'user_settings_changed', family: 'unrelated' }))
    expect(toolOperations.refresh).toHaveBeenCalledOnce()
    handlers.onStatus('open'); handlers.onStatus('down'); handlers.onStatus('open')
    expect(toolOperations.refresh).toHaveBeenCalledTimes(2)
    stopUserChannel()
    expect(toolOperations.owner).toHaveBeenLastCalledWith(null)
  })

  it('refreshes Subagent tool facts on their value-free event and catches up after reconnect', () => {
    stores.subagents = [{ id: 'child' }]
    startUserChannel('owner')
    const { handlers } = hub.subscriptions[0]
    handlers.onEvent(JSON.stringify({ type: 'subagent_settings_changed', agentId: 'child', family: 'provider-settings' }))
    expect(stores.refreshSubagentProviderSettingsFromServer).toHaveBeenCalledWith('child')
    handlers.onStatus('open'); handlers.onStatus('down'); handlers.onStatus('open')
    expect(stores.refreshSubagentProviderSettingsFromServer).toHaveBeenCalledTimes(2)
  })

  it('holds one user subscription for every holder and lets go with the last one', () => {
    const releaseSidebar = startUserChannel('josh')
    const releaseDialog = startUserChannel('josh')
    expect(hub.subscriptions).toHaveLength(1)
    expect(hub.subscriptions[0].target).toEqual({ scope: 'user' })

    releaseSidebar()
    expect(hub.subscriptions[0].unsubscribed).toBe(false)
    releaseDialog()
    expect(hub.subscriptions[0].unsubscribed).toBe(true)
  })

  it('applies events to the stores and hands them to every listener', () => {
    startUserChannel('josh')
    const heard: unknown[] = []
    const stop = onUserChannelEvent((event) => heard.push(event))
    const { handlers } = hub.subscriptions[0]

    handlers.onEvent(JSON.stringify({ type: 'session_created', session: { id: 'chat-9' } }))
    handlers.onEvent(JSON.stringify({ type: 'session_run_status', sessionId: 'chat-9', status: 'running' }))
    handlers.onEvent(JSON.stringify({ type: 'session_messages_changed', sessionId: 'chat-9', reason: 'message_deleted' }))
    handlers.onEvent('not json')

    expect(stores.upsertSession).toHaveBeenCalledWith({ id: 'chat-9' })
    expect(stores.applyServerRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'chat-9', status: 'running' })
    )
    expect(heard.map((event: any) => event.type)).toEqual([
      'session_created',
      'session_run_status',
      'session_messages_changed'
    ])
    stop()
  })

  it('drops a chat deleted in another tab from the sidebar, with its run state (2026-09-18)', () => {
    // Nothing told a tab that a chat it listed was gone: it stayed in the sidebar (and on
    // screen) until that tab reloaded. The server now says so once the chat is swept.
    startUserChannel('josh')
    const heard: unknown[] = []
    const stop = onUserChannelEvent((event) => heard.push(event))
    const { handlers } = hub.subscriptions[0]

    handlers.onEvent(JSON.stringify({ type: 'session_deleted', sessionId: 'chat-9' }))
    handlers.onEvent(JSON.stringify({ type: 'session_deleted' }))

    expect(stores.deleteSession).toHaveBeenCalledTimes(1)
    expect(stores.deleteSession).toHaveBeenCalledWith('chat-9')
    expect(stores.resetRunState).toHaveBeenCalledWith('chat-9')
    // The chat page hears it too: it forgets the chat's messages and its live connection.
    expect(heard).toContainEqual({ type: 'session_deleted', sessionId: 'chat-9' })
    stop()
  })

  it('an agent that changed its own Settings: the agent store reads that family again, and listeners hear it (SA-122 A-1y)', () => {
    startUserChannel('josh')
    const heard: unknown[] = []
    const stop = onUserChannelEvent((event) => heard.push(event))
    const { handlers } = hub.subscriptions[0]

    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'mcp-settings' }))
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'provider-settings' }))
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'memory' }))
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'identity' }))
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'retention' }))
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'model-selection' }))
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'instructions' }))
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'auto-compact' }))
    handlers.onEvent(JSON.stringify({ type: 'subagent_settings_changed', agentId: 'subagent-7', family: 'instructions' }))
    handlers.onEvent(JSON.stringify({ type: 'subagent_settings_changed', agentId: 'subagent-7', family: 'model-selection' }))
    // Malformed: no agent, an unknown family. The store reads nothing for them.
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', family: 'memory' }))
    handlers.onEvent(JSON.stringify({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'voice' }))

    expect(stores.refreshAgentFieldsFromServer.mock.calls).toEqual([
      ['agent-7', 'mcp-settings'],
      ['agent-7', 'provider-settings'],
      ['agent-7', 'memory'],
      ['agent-7', 'identity'],
      ['agent-7', 'retention'],
      ['agent-7', 'model-selection'],
      ['agent-7', 'instructions'],
      ['agent-7', 'auto-compact']
    ])
    expect(heard).toContainEqual({ type: 'agent_settings_changed', agentId: 'agent-7', family: 'memory' })
    expect(stores.refreshSubagentModelSelectionFromServer).toHaveBeenCalledExactlyOnceWith('subagent-7')
    expect(stores.refreshSubagentInstructionsFromServer).toHaveBeenCalledExactlyOnceWith('subagent-7')
    stop()
  })

  it('reports connected only while the hub says the subscription is open', () => {
    startUserChannel('josh')
    expect(isUserChannelConnected()).toBe(false)
    hub.subscriptions[0].current = 'open'
    expect(isUserChannelConnected()).toBe(true)
    hub.subscriptions[0].current = 'down'
    expect(isUserChannelConnected()).toBe(false)
  })

  it('refreshes both instructions families after reconnect with no values or writes in the channel', () => {
    stores.agents = [{ id: 'primary' }]; stores.subagents = [{ id: 'sub' }]
    startUserChannel('josh')
    const { handlers } = hub.subscriptions[0]
    handlers.onStatus('open')
    expect(stores.refreshAgentFieldsFromServer).not.toHaveBeenCalled()
    handlers.onStatus('open')
    expect(stores.refreshAgentFieldsFromServer).toHaveBeenCalledWith('primary', 'mcp-settings')
    expect(stores.refreshAgentFieldsFromServer).toHaveBeenCalledWith('primary', 'provider-settings')
    expect(stores.refreshAgentFieldsFromServer).toHaveBeenCalledWith('primary', 'instructions')
    expect(stores.refreshAgentFieldsFromServer).toHaveBeenCalledWith('primary', 'auto-compact')
    expect(stores.refreshSubagentInstructionsFromServer).toHaveBeenCalledExactlyOnceWith('sub')
  })

  it('tells its listeners when the server added the channel again, not on the first open (BL-382)', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ settings: {} })))
    startUserChannel('josh')
    const heard: unknown[] = []
    const stop = onUserChannelEvent((event) => heard.push(event))
    const { handlers } = hub.subscriptions[0]

    handlers.onStatus('open')
    expect(heard).toEqual([])
    handlers.onStatus('down')
    handlers.onStatus('open')
    expect(heard).toEqual([{ type: 'reconnected' }])
    // A tab the hub took back after a silence hears a second `open` with no `down`.
    handlers.onStatus('open')
    expect(heard).toEqual([{ type: 'reconnected' }, { type: 'reconnected' }])
    stop()
  })

  it('never takes a `reconnected` from the server (it is this tab\'s own signal)', () => {
    startUserChannel('josh')
    const heard: unknown[] = []
    const stop = onUserChannelEvent((event) => heard.push(event))
    hub.subscriptions[0].handlers.onEvent(JSON.stringify({ type: 'reconnected' }))
    expect(heard).toEqual([])
    stop()
  })

  it('starts over for a different user', () => {
    startUserChannel('josh')
    startUserChannel('someone-else')
    expect(hub.subscriptions).toHaveLength(2)
    expect(hub.subscriptions[0].unsubscribed).toBe(true)
    expect(hub.subscriptions[1].unsubscribed).toBe(false)
  })
  it('bridges value-free skill changes and a real reconnect to mounted slash-command consumers', () => {
    const refreshed = vi.fn()
    window.addEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, refreshed)
    const release = startUserChannel('josh')
    try {
      const { handlers } = hub.subscriptions[0]
      handlers.onStatus('open')
      expect(refreshed).not.toHaveBeenCalled()
      handlers.onEvent(JSON.stringify({ type: 'slash_commands_changed' }))
      expect(refreshed).toHaveBeenCalledTimes(1)
      expect((refreshed.mock.calls[0][0] as CustomEvent).detail).toEqual({ source: 'unknown' })
      handlers.onStatus('open')
      expect(refreshed).toHaveBeenCalledTimes(2)
      handlers.onEvent(JSON.stringify({ type: 'reconnected' }))
      expect(refreshed).toHaveBeenCalledTimes(2)
    } finally { window.removeEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, refreshed); release() }
  })

})


describe('A12 stored-list read ownership through the user channel', () => {
  const original = { id: 'old', modelName: 'Old', provider: 'openai', modelId: 'fixture', settings: { temperature: 0 } } as any
  const copied = { ...original, id: 'copy', modelName: 'Named copy' }
  const page = (models: any[]) => Response.json({ projection: 'stored', models, total: models.length, offset: 0, nextOffset: null })
  afterEach(async () => { stopUserChannel(); await vi.waitFor(() => expect(savedModels.getIsLoading()).toBe(false)); vi.unstubAllGlobals() })
  it.each(['success', 'failure'] as const)('queues one post-event pure read and rejects an older ordinary %s', async finish => {
    startUserChannel('read-owner')
    savedModels.setSavedModels([original])
    let release!: (response: Response) => void
    const old = new Promise<Response>(resolve => { release = resolve })
    const fetcher = vi.fn().mockImplementationOnce(() => old).mockResolvedValue(page([original, copied]))
    vi.stubGlobal('fetch', fetcher)
    const ordinary = savedModels.loadSavedModels()
    hub.subscriptions.at(-1).handlers.onEvent(JSON.stringify({ type: 'model_presets_changed' }))
    try { expect(fetcher).toHaveBeenCalledTimes(1) }
    finally { release(finish === 'success' ? Response.json({ models: [original] }) : new Response('unavailable', { status: 500 })) }
    await ordinary
    await vi.waitFor(() => expect(savedModels.getSavedModels().map(row => row.id)).toEqual(['old', 'copy']))
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/user/saved-models', '/api/user/saved-models?projection=stored&offset=0'])
    expect(savedModels.getReadError()).toBeNull()
  })
  it.each(['upsert', 'remove', 'set'] as const)('retains same-owner copy demand after a known local %s invalidates the event read', async writer => {
    startUserChannel(`event-read-local-${writer}`)
    const removed = { ...original, id: 'removed', modelName: 'Known removed' }
    const local = { ...original, modelName: 'Known newer A2' }
    const remoteCopy = { ...original, id: 'remote-copy', modelName: 'Remote named copy' }
    savedModels.setSavedModels(writer === 'remove' ? [original, removed] : [original])
    const fresh = writer === 'remove' ? [original, remoteCopy] : [local, remoteCopy]
    let release!: (response: Response) => void
    const held = new Promise<Response>(resolve => { release = resolve })
    const fetcher = vi.fn().mockImplementationOnce(() => held).mockResolvedValue(page(fresh))
    vi.stubGlobal('fetch', fetcher)
    hub.subscriptions.at(-1).handlers.onEvent(JSON.stringify({ type: 'model_presets_changed' }))
    try {
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
      if (writer === 'upsert') savedModels.upsertSavedModel(local)
      else if (writer === 'remove') savedModels.removeSavedModel(removed.id)
      else savedModels.setSavedModels([local])
      expect(savedModels.getSavedModels().find(row => row.id === 'old')?.modelName).toBe(writer === 'remove' ? 'Old' : 'Known newer A2')
    } finally { release(page([original, removed, remoteCopy])) }
    await vi.waitFor(() => expect(savedModels.getSavedModels().map(row => row.id).sort()).toEqual(['old', 'remote-copy']))
    expect(savedModels.getSavedModels().find(row => row.id === 'old')?.modelName).toBe(writer === 'remove' ? 'Old' : 'Known newer A2')
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/user/saved-models?projection=stored&offset=0', '/api/user/saved-models?projection=stored&offset=0'])
    expect(savedModels.getReadError()).toBeNull()
  })

  it('retains last-good data and explicit error on a partial projection failure; local saves and owner changes supersede late reads', async () => {
    startUserChannel('projection-owner'); savedModels.setSavedModels([original])
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ projection: 'stored', models: [copied], total: 2, offset: 0, nextOffset: null })))
    expect(await savedModels.refreshStoredSavedModels()).toBe(false)
    expect(savedModels.getSavedModels()).toEqual([original]); expect(savedModels.getReadError()).toContain('last good')
    let release!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const delayed = savedModels.refreshStoredSavedModels()
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      const prior = savedModels.beginSavedModelsRead()
      startUserChannel('different-owner')
      expect(prior.install([original])).toBe(false); prior.finish()
      savedModels.upsertSavedModel(copied)
    } finally { release?.(page([original])) }
    expect(await delayed).toBe(false)
    await vi.waitFor(() => expect(savedModels.getIsLoading()).toBe(false))
    expect(savedModels.getSavedModels().map(row => row.id)).toEqual(['copy'])
    expect(fetcher).toHaveBeenCalledTimes(1)

  })
  it.each(['gateway', 'chatgpt'] as const)('stored %s refresh retains negative identity-bound observations; changed identity stays unknown until an actual ordinary read', async kind => {
    startUserChannel(`availability-${kind}`)
    const connection = kind === 'gateway' ? { id: 'vercel-gateway', type: 'vercel-gateway', service: 'vercel' }
      : { id: 'chatgpt-plan:00000000-0000-0000-0000-000000000001', type: 'direct', service: 'chatgpt-plan' }
    const reason = kind === 'gateway' ? 'Vercel AI Gateway no longer lists this model' : 'Reconnect this ChatGPT account in Settings → API Keys on this Mac.'
    const negative = { ...original, id: 'unavailable', provider: 'openai', modelId: 'fixture', purpose: 'chat', connection, pricing: {}, createdAt: '2026-10-18', updatedAt: '2026-10-18',
      catalogModelId: 'openai/fixture', effectiveModelId: 'openai/fixture', vercelSourceId: 'openai/fixture', isVercelImport: kind === 'gateway',
      unavailableReason: reason, reasoningEvidence: { status: 'unsupported', reason: 'Held exact-identity display evidence' } }
    let ordinaryRows: any[] = [negative]
    const { unavailableReason: _reason, reasoningEvidence: _evidence, ...raw } = negative
    let storedRows: any[] = [{ ...raw, modelName: 'Renamed stored model' }]
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes('projection=stored') ? page(storedRows) : Response.json({ models: ordinaryRows }))
    vi.stubGlobal('fetch', fetcher)
    const availability = (model: any) => getModelPresetAvailability({ model, agentType: 'api', connectionOptions: [{ id: model.connection.id, transport: model.connection.type as 'direct' | 'vercel-gateway', service: model.connection.service, label: 'Otherwise ready', status: 'ready', providers: null }] })
    await savedModels.loadSavedModels()
    expect(await savedModels.refreshStoredSavedModels()).toBe(true)
    const retained = savedModels.getSavedModels()[0]
    expect(retained.modelName).toBe('Renamed stored model'); expect(retained.unavailableReason).toBe(reason)
    expect(retained.reasoningEvidence).toEqual(negative.reasoningEvidence)
    expect(availability(retained)).toMatchObject({ disabled: true, disabledBecause: 'unlisted', reason })
    storedRows = kind === 'gateway' ? [{ ...raw, modelId: 'different-model', effectiveModelId: 'openai/different-model', catalogModelId: 'openai/different-model', vercelSourceId: 'openai/different-model' }]
      : [{ ...raw, connection: { ...connection, id: 'chatgpt-plan:00000000-0000-0000-0000-000000000002' } }]
    expect(await savedModels.refreshStoredSavedModels()).toBe(true)
    const changed = savedModels.getSavedModels()[0]
    expect(changed.unavailableReason).toContain('Availability is unconfirmed'); expect(changed.unavailableReason).not.toBe(reason)
    expect(changed.reasoningEvidence?.status).toBe('unknown'); expect(availability(changed).disabled).toBe(true)
    const automatic = fetcher.mock.calls.slice(1).map(([url]) => String(url))
    expect(automatic).toEqual(['/api/user/saved-models?projection=stored&offset=0', '/api/user/saved-models?projection=stored&offset=0'])
    ordinaryRows = [{ ...storedRows[0], reasoningEvidence: { status: 'supported', reason: 'New deliberate ordinary read' } }]
    await savedModels.loadSavedModels()
    expect(savedModels.getSavedModels()[0].unavailableReason).toBeUndefined()
    expect(availability(savedModels.getSavedModels()[0]).disabled).toBe(false)
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain('/api/models')
  })

})


describe('MCP source notifications carry invalidation only', () => {
  it('hands a value-free source identity to mounted listeners without a setting write or source adoption', () => {
    vi.clearAllMocks()
    const fetcher = vi.fn(async () => Response.json({}))
    vi.stubGlobal('fetch', fetcher)
    stores.agents = []; stores.subagents = []
    startUserChannel('josh')
    const heard: unknown[] = []
    const stop = onUserChannelEvent(event => heard.push(event))
    try {
      hub.subscriptions.at(-1).handlers.onEvent(JSON.stringify({ type: 'mcp_gateway_source_changed', gatewayId: 'held-source' }))
      expect(heard).toEqual([{ type: 'mcp_gateway_source_changed', gatewayId: 'held-source' }])
      expect(stores.refreshAgentFieldsFromServer).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    } finally { stop() }
  })
})
