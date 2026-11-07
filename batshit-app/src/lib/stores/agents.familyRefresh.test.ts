import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentStore from '$lib/stores/agents.svelte'
import { captureAutoCompactBaseline } from '$lib/appActions/settings/autoCompactBaseline'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'

/**
 * SA-122 A-1y (LS-067/LS-068): when the agent changes its own Settings, the shared agent store reads
 * that agent again and takes only the changed family's fields. Its reads are guarded per agent AND
 * family (Ashe's refinement a): a later identity read never drops an earlier memory read, and only a
 * newer read of the same family drops an older one, whatever order the answers come in.
 */

const AGENT = 'agent-refresh'
const OTHER = 'agent-other'

type Pending = { url: string; method: string; resolve: (record: unknown, status?: number) => void; reject: (error: Error) => void }
let pending: Pending[] = []

function seedStore() {
  agentStore.setAgents([
    {
      id: AGENT,
      user_id: 'user-refresh',
      displayName: 'Probe',
      memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 },
      memoryLaneBudgets: { on_my_mind: 1, triggers: 1, recalled: 1 },
      memory_linger_turns: 2,
      system_prompt: 'Stays as it is.'
    },
    { id: OTHER, user_id: 'user-refresh', displayName: 'Other' }
  ] as any)
}

function agent(id = AGENT): any {
  return agentStore.getAgentById(id)
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    user_id: 'user-refresh',
    displayName: 'Probe',
    memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 },
    memory_linger_turns: 2,
    system_prompt: 'Changed on the server, not by this family.',
    ...overrides
  }
}

beforeEach(() => {
  pending = []
  seedStore()
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      pending.push({
        url,
        method: init?.method ?? 'GET',
        resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
        reject
      })
    })
  ))
})

describe('provider-settings live refresh (BL-1876)', () => {
  const settings = { temperature: 0.4, nativeTools: { batshitToolsEnabled: true, webSearchEnabled: false } }
  beforeEach(() => {
    agentStore.updateAgent(AGENT, { agentType: 'api', provider_specific_settings: structuredClone(settings) })
  })

  it('adopts the saved tool flags without changing unrelated fields or selecting another agent', async () => {
    agentStore.setCurrentAgentId(OTHER)
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    pending[0].resolve(record({ agentType: 'api', displayName: 'Not this family', provider_specific_settings: {
      temperature: 0.8, nativeTools: { batshitToolsEnabled: false }
    } }))
    await done
    expect(agent().provider_specific_settings).toEqual({ temperature: 0.4, nativeTools: { batshitToolsEnabled: false } })
    expect(agent().displayName).toBe('Probe')
    expect(agent().memory_linger_turns).toBe(2)
    expect(agentStore.getCurrentAgentId()).toBe(OTHER)
    expect(pending.map(request => request.method)).toEqual(['GET'])
  })

  it('coalesces events during a read and never installs its superseded answer', async () => {
    const first = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    expect(pending).toHaveLength(1)
    pending[0].resolve(record({ agentType: 'api', provider_specific_settings: { nativeTools: { batshitToolsEnabled: false } } }))
    await first
    expect(agent().provider_specific_settings).toEqual(settings)
    expect(pending).toHaveLength(2)
    pending[1].resolve(record({ agentType: 'api', provider_specific_settings: { nativeTools: { batshitToolsEnabled: true } } }))
    await vi.waitFor(() => expect(agent().provider_specific_settings).toEqual({ temperature: 0.4, nativeTools: { batshitToolsEnabled: true } }))
    expect(pending).toHaveLength(2)
  })

  it('waits for the local provider write before one queued read, without replaying the PUT', async () => {
    const save = agentStore.updateAgentSettings(AGENT, { provider_specific_settings: { nativeTools: { batshitToolsEnabled: false } } })
    expect(pending.map(request => request.method)).toEqual(['PUT'])
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    expect(pending).toHaveLength(1)
    expect(agent().provider_specific_settings.nativeTools.batshitToolsEnabled).toBe(false)
    pending[0].resolve({ success: true })
    await save
    expect(pending.map(request => request.method)).toEqual(['PUT', 'GET'])
    pending[1].resolve(record({ agentType: 'api', provider_specific_settings: { ...settings, nativeTools: { batshitToolsEnabled: false } } }))
    await vi.waitFor(() => expect(agent().provider_specific_settings.nativeTools.batshitToolsEnabled).toBe(false))
    expect(pending.filter(request => request.method === 'PUT')).toHaveLength(1)
  })

  it.each(['update', 'list'] as const)('rejects an old read after a same-value newer local %s installation', async (installation) => {
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    if (installation === 'update') agentStore.updateAgent(AGENT, { provider_specific_settings: structuredClone(settings) })
    else agentStore.setAgents(JSON.parse(JSON.stringify(agentStore.getAgents())))
    pending[0].resolve(record({ agentType: 'api', provider_specific_settings: { nativeTools: { batshitToolsEnabled: false } } }))
    await done
    expect(agent().provider_specific_settings).toEqual(settings)
    expect(pending).toHaveLength(2)
    pending[1].resolve(record({ agentType: 'api', provider_specific_settings: settings }))
    await vi.waitFor(() => expect(agent().provider_specific_settings).toEqual(settings))
  })

  it('the actual list loader invalidates an older provider read even when its saved provider values are equal', async () => {
    const first = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    const rows = JSON.parse(JSON.stringify(agentStore.getAgents()))
    const listing = agentStore.loadAgents('user-refresh')
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1].resolve({ agents: rows })
    await listing
    pending[0].resolve(record({ agentType: 'api', provider_specific_settings: { nativeTools: { batshitToolsEnabled: false } } }))
    await first
    expect(agent().provider_specific_settings).toEqual(settings)
    expect(pending).toHaveLength(3)
    pending[2].resolve(record({ agentType: 'api', provider_specific_settings: settings }))
    await vi.waitFor(() => expect(agent().provider_specific_settings).toEqual(settings))
  })

  it('a later tool-family installation does not own model parameters and an older model answer cannot undo its tool flags', async () => {
    const modelRead = agentStore.refreshAgentFieldsFromServer(AGENT, 'model-selection')
    const toolRead = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    pending[1].resolve(record({ agentType: 'api', provider_specific_settings: { temperature: 0.4, nativeTools: { batshitToolsEnabled: false } } }))
    await toolRead
    expect(agent().provider_specific_settings).toEqual({ temperature: 0.4, nativeTools: { batshitToolsEnabled: false } })
    pending[0].resolve(record({ agentType: 'api', provider_specific_settings: { temperature: 0.2, nativeTools: { batshitToolsEnabled: true } } }))
    await modelRead
    expect(agent().provider_specific_settings).toEqual({ temperature: 0.2, nativeTools: { batshitToolsEnabled: false } })
  })

  it('keeps CLI model mirrors with their model-selection owner while refreshing the tool projection', async () => {
    agentStore.updateAgent(AGENT, { agentType: 'cli', provider_specific_settings: { ...settings, claude_model: 'model-b' } })
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    pending[0].resolve(record({ agentType: 'cli', provider_specific_settings: {
      temperature: 0.8, claude_model: 'other-b', nativeTools: { batshitToolsEnabled: false }
    } }))
    await done
    expect(agent().provider_specific_settings).toEqual({ temperature: 0.4, claude_model: 'model-b', nativeTools: { batshitToolsEnabled: false } })
  })

  it('an event received during an unconfirmed save reads current values afterward and never replays the save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = agentStore.updateAgentSettings(AGENT, { provider_specific_settings: { nativeTools: { batshitToolsEnabled: false } } })
    const refused = expect(save).rejects.toThrow('Failed to update agent in database')
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    pending[0].resolve({ error: 'Reply lost after saving' }, 503)
    await refused
    expect(pending.map(request => request.method)).toEqual(['PUT', 'GET'])
    pending[1].resolve(record({ agentType: 'api', provider_specific_settings: { ...settings, nativeTools: { batshitToolsEnabled: false } } }))
    await vi.waitFor(() => expect(agent().provider_specific_settings.nativeTools.batshitToolsEnabled).toBe(false))
    expect(pending.filter(request => request.method === 'PUT')).toHaveLength(1)
  })

  it.each([
    { id: OTHER }, { user_id: 'foreign-user' }, { agentType: 'cli' }, { provider_specific_settings: [] }
  ])('retains the confirmed copy for a wrong-owner/type or unreadable answer: %j', async (change) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    pending[0].resolve(record({ agentType: 'api', provider_specific_settings: { nativeTools: { batshitToolsEnabled: false } }, ...change }))
    await done
    expect(agent().provider_specific_settings).toEqual(settings)
    expect(pending).toHaveLength(1)
  })

  it('keeps failed reads visible to the error owner without polling; a later event can recover or clear the block', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    pending[0].resolve({ error: 'Unavailable' }, 503)
    await failed
    expect(agent().provider_specific_settings).toEqual(settings)
    expect(warn).toHaveBeenCalledOnce()
    expect(pending).toHaveLength(1)
    const next = agentStore.refreshAgentFieldsFromServer(AGENT, 'provider-settings')
    pending[1].resolve(record({ agentType: 'api' }))
    await next
    expect(agent().provider_specific_settings).toEqual({ temperature: 0.4 })
    expect(pending.map(request => request.method)).toEqual(['GET', 'GET'])
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('native model callers retain their original read before optimistic changes (BL1787)', () => {
  it.each([
    { model_reasoning_overrides: { [reasoningOverrideKey({ presetId: null, connection: { type: 'direct', id: 'claude-cli', service: 'claude-cli' }, effectiveModelId: 'claude-opus-5-5' }, 'effort')]: { mode: 'value', value: 'high' } } },
    { claude_settings: { permissionMode: 'acceptEdits', chrome: true } },
    { claude_settings: { model: undefined, permissionMode: 'default' } },
    { claude_settings: { alwaysThinkingEnabled: true } }
  ])('keeps sparse reasoning/group payloads outside native model intent: %j', async change => {
    agentStore.updateAgent(AGENT, { agentType: 'cli', primary_model_provider: 'anthropic-claude-cli' })
    const save = agentStore.updateAgentSettings(AGENT, change as any)
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body))).toEqual(JSON.parse(JSON.stringify(change)))
    pending[0].resolve({ success: true })
    await save
    if (pending[1]) pending[1].resolve(record({ agentType: 'cli', primary_model_provider: 'anthropic-claude-cli' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1)
  })

  it('does not add a native basis requirement to an API-only save', async () => {
    agentStore.updateAgent(AGENT, { agentType: 'api', claude_settings: { model: 'old' } } as any)
    const save = agentStore.updateAgentSettings(AGENT, { claude_settings: { model: 'new' } } as any)
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body))).toEqual({ claude_settings: { model: 'new' } })
    pending[0].resolve({ success: true })
    await save
    if (pending[1]) pending[1].resolve(record({ agentType: 'api', claude_settings: { model: 'new' } }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
})

describe('the agent store reads a changed family again (SA-122 A-1y)', () => {
  it('A7 captures a detached fixed common baseline without advanced values and preserves raw parent distinctions', () => {
    const token = `sha256:${'a'.repeat(64)}`
    const row = { id: AGENT, agentType: 'api', auto_compact_settings: { mode: 'ask', prompt: 'Private advanced draft', modelPresetId: 'Private preset' } }
    const baseline = captureAutoCompactBaseline(row, token)!
    row.auto_compact_settings.mode = 'off'
    expect(baseline).toEqual({ id: AGENT, type: 'api', token, group: { parent: 'object', mode: 'ask' } })
    expect(Object.isFrozen(baseline)).toBe(true)
    expect(Object.isFrozen(baseline.group)).toBe(true)
    expect(captureAutoCompactBaseline({ id: AGENT, agentType: 'api' }, token)?.group).toEqual({ parent: 'absent' })
    expect(captureAutoCompactBaseline({ id: AGENT, agentType: 'api', auto_compact_settings: null }, token)?.group).toEqual({ parent: 'null' })
    for (const block of [false, [], { mode: null }, { triggerMode: 'bad' }, { remainingTokens: '1000' }, { remainingTokens: 1000.5 }]) {
      expect(captureAutoCompactBaseline({ id: AGENT, agentType: 'api', auto_compact_settings: block }, token)).toBeNull()
    }
    expect(captureAutoCompactBaseline({ ...row, agentType: 'other' }, token)).toBeNull()
    // SA-139 R4: a leftover of the retired cli Primary type is never a live Auto Compact subject.
    expect(captureAutoCompactBaseline({ ...row, agentType: 'cli' }, token)).toBeNull()
    expect(captureAutoCompactBaseline(row, 'invalid')).toBeNull()
  })
  it('A7 Auto Compact refresh keeps unrelated state and rejects a read older than a same-value local whole-block write', async () => {
    agentStore.updateAgent(AGENT, { agentType: 'api', auto_compact_settings: { mode: 'off' } } as any)
    const read = agentStore.refreshAgentFieldsFromServer(AGENT, 'auto-compact')
    pending[0].resolve(record({ agentType: 'api', auto_compact_settings: { mode: 'ask', prompt: 'Stored prompt' }, displayName: 'Ignored' }))
    await read
    expect(agent()).toMatchObject({ auto_compact_settings: { mode: 'ask', prompt: 'Stored prompt' }, displayName: 'Probe' })
    const stale = agentStore.refreshAgentFieldsFromServer(AGENT, 'auto-compact')
    agentStore.updateAgent(AGENT, { auto_compact_settings: agent().auto_compact_settings })
    pending[1].resolve(record({ agentType: 'api', auto_compact_settings: { mode: 'off' } }))
    await stale
    expect(agent().auto_compact_settings.mode).toBe('ask')
    const absent = agentStore.refreshAgentFieldsFromServer(AGENT, 'auto-compact')
    pending[2].resolve(record({ agentType: 'api' }))
    await absent
    expect(Object.hasOwn(agent(), 'auto_compact_settings')).toBe(false)
  })
  it('A7 keeps request-only original Auto Compact tokens out of the store and drains one pending refresh after stale refusal without replay', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    agentStore.updateAgent(AGENT, { agentType: 'api', auto_compact_settings: { mode: 'off' } } as any)
    const expectedAutoCompact = `sha256:${'b'.repeat(64)}`
    const save = agentStore.updateAgentSettings(AGENT, { auto_compact_settings: { mode: 'ask' } as any, expectedAutoCompact })
    const refused = expect(save).rejects.toMatchObject({ code: 'auto_compact_settings_changed', status: 409 })
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body)).expectedAutoCompact).toBe(expectedAutoCompact)
    expect(agent().expectedAutoCompact).toBeUndefined()
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'auto-compact')
    expect(pending).toHaveLength(1)
    pending[0].resolve({ code: 'auto_compact_settings_changed' }, 409)
    await refused
    expect(pending).toHaveLength(2)
    pending[1].resolve(record({ agentType: 'api', auto_compact_settings: null }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent().auto_compact_settings).toBeNull()
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1)
  })
  it('instructions refresh preserves exact null/absence and unrelated fields, and rejects a read over a local instruction choice', async () => {
    const read = agentStore.refreshAgentFieldsFromServer(AGENT, 'instructions')
    pending[0].resolve(record({ system_prompt: null, include_global_prompt: false, displayName: 'Do not copy' }))
    await read
    expect(agent()).toMatchObject({ system_prompt: null, include_global_prompt: false, displayName: 'Probe' })
    const stale = agentStore.refreshAgentFieldsFromServer(AGENT, 'instructions')
    agentStore.updateAgent(AGENT, { system_prompt: 'Newer local choice' })
    pending[1].resolve(record({ system_prompt: 'Stale' }))
    await stale
    expect(agent().system_prompt).toBe('Newer local choice')
    const clear = agentStore.refreshAgentFieldsFromServer(AGENT, 'instructions')
    pending[2].resolve({ id: AGENT, user_id: 'user-refresh', displayName: 'Ignored' })
    await clear
    expect(Object.hasOwn(agent(), 'system_prompt')).toBe(false)
    expect(Object.hasOwn(agent(), 'include_global_prompt')).toBe(false)
  })
  it('defers instructions invalidation during an actual write and reads once after known409 without replay', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const expectedInstructions = { customPrompt: `sha256:${'a'.repeat(64)}` }
    const save = agentStore.updateAgentSettings(AGENT, { system_prompt: 'Held draft', expectedInstructions })
    const rejected = expect(save).rejects.toMatchObject({ status: 409 })
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'instructions')
    expect(pending).toHaveLength(1)
    expect((agent() as any).expectedInstructions).toBeUndefined()
    pending[0].resolve({ code: 'instructions_settings_changed', error: 'Changed' }, 409)
    await rejected
    expect(pending).toHaveLength(2)
    pending[1].resolve(record({ system_prompt: 'Remote text', include_global_prompt: null }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent()).toMatchObject({ system_prompt: 'Remote text', include_global_prompt: null })
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1)
  })
  it('does not install an older instructions read over a newer accepted same-value mounted save', async () => {
    const read = agentStore.refreshAgentFieldsFromServer(AGENT, 'instructions')
    agentStore.updateAgent(AGENT, { system_prompt: 'Stays as it is.' })
    pending[0].resolve(record({ system_prompt: 'Older remote value' }))
    await read
    expect(agent().system_prompt).toBe('Stays as it is.')
  })
  it('reads current model once after a known409 even when no publication was observed, without replaying its PUT', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    agentStore.updateAgent(AGENT, { primary_model_preset_id: 'a' })
    const save = agentStore.updateAgentSettings(AGENT, { primary_model_preset_id: 'b', expectedModelSelection: `sha256:${'a'.repeat(64)}` })
    const rejected = expect(save).rejects.toMatchObject({ status: 409 })
    pending[0].resolve({ code: 'model_selection_settings_changed' }, 409)
    await rejected
    expect(pending).toHaveLength(2)
    pending[1].resolve(record({ primary_model_preset_id: 'c' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent().primary_model_preset_id).toBe('c')
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1)
  })
  it('refreshes all model copies and model provider keys while preserving native settings and unrelated fields', async () => {
    agentStore.updateAgent(AGENT, { primary_model_temperature: 0.8, primary_model_capabilities: { vision: true },
      provider_specific_settings: { oldModel: true, nativeTools: { mode: 'plan' } } } as any)
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'model-selection')
    pending[0].resolve(record({ primary_model_preset_id: 'new', primary_model_temperature: 0,
      provider_specific_settings: { newModel: false, nativeTools: { mode: 'dangerous' } } }))
    await done
    expect(agent()).toMatchObject({ primary_model_preset_id: 'new', primary_model_temperature: 0,
      provider_specific_settings: { newModel: false, nativeTools: { mode: 'plan' } }, system_prompt: 'Stays as it is.' })
    expect(agent().primary_model_capabilities).toBeUndefined()
    expect(agent().provider_specific_settings.oldModel).toBeUndefined()
  })
  it('does not install a model read over a newer local model choice', async () => {
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'model-selection')
    agentStore.updateAgent(AGENT, { primary_model_preset_id: 'newer' })
    pending[0].resolve(record({ primary_model_preset_id: 'stale' }))
    await done
    expect(agent().primary_model_preset_id).toBe('newer')
  })
  it('keeps in-flight optimistic model intent over an older read, then refreshes only after the known save settles', async () => {
    const older = agentStore.refreshAgentFieldsFromServer(AGENT, 'model-selection')
    const save = agentStore.updateAgentSettings(AGENT, { primary_model_preset_id: 'picked', expectedModelSelection: `sha256:${'a'.repeat(64)}` })
    expect(agent().primary_model_preset_id).toBe('picked')
    expect((agent() as any).expectedModelSelection).toBeUndefined()
    await agentStore.refreshAgentFieldsFromServer(AGENT, 'model-selection')
    expect(pending).toHaveLength(2)
    pending[0].resolve(record({ primary_model_preset_id: 'old' }))
    await older
    expect(agent().primary_model_preset_id).toBe('picked')
    pending[1].resolve({ success: true })
    await save
    expect(pending).toHaveLength(3)
    pending[2].resolve(record({ primary_model_preset_id: 'picked', primary_model_temperature: 0 }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent()).toMatchObject({ primary_model_preset_id: 'picked', primary_model_temperature: 0 })
  })
  it('identity: takes displayName only; memory and every other field stay as they were', async () => {
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    expect(pending.map((call) => call.url)).toEqual([`/api/agents/${AGENT}`])
    pending[0].resolve(record({ displayName: 'Probe 2', memory_linger_turns: 7 }))
    await done

    expect(agent()).toMatchObject({ displayName: 'Probe 2', memory_linger_turns: 2, system_prompt: 'Stays as it is.' })
  })

  it('memory: takes every stored memory name; a name the record no longer holds is cleared', async () => {
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')
    pending[0].resolve(record({ memory_lane_budgets: { on_my_mind: 120, triggers: 200, recalled: 300 }, displayName: 'Not this family' }))
    await done

    expect(agent().memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 300 })
    expect(agent().memoryLaneBudgets).toBeUndefined()
    expect(agent().displayName).toBe('Probe')
    expect(agent().system_prompt).toBe('Stays as it is.')
  })

  it('a memory read and an identity read whose answers come back in reverse order: both land', async () => {
    const memory = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')
    const identity = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    expect(pending).toHaveLength(2)

    // The later identity read answers first; the earlier memory read must not be dropped for it.
    pending[1].resolve(record({ displayName: 'Probe 2' }))
    await identity
    pending[0].resolve(record({ displayName: 'Probe 2', memory_lane_budgets: { on_my_mind: 120, triggers: 200, recalled: 300 } }))
    await memory

    expect(agent().displayName).toBe('Probe 2')
    expect(agent().memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 300 })
  })

  it('two memory reads whose answers come back in reverse order: the newer read wins, the older answer is dropped', async () => {
    const older = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')
    const newer = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')

    pending[1].resolve(record({ memory_lane_budgets: { on_my_mind: 130, triggers: 200, recalled: 300 } }))
    await newer
    pending[0].resolve(record({ memory_lane_budgets: { on_my_mind: 120, triggers: 200, recalled: 300 } }))
    await older

    expect(agent().memory_lane_budgets).toEqual({ on_my_mind: 130, triggers: 200, recalled: 300 })
  })

  it('reads of two agents are independent', async () => {
    const first = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    const second = agentStore.refreshAgentFieldsFromServer(OTHER, 'identity')
    pending[1].resolve({ id: OTHER, displayName: 'Other 2' })
    await second
    pending[0].resolve(record({ displayName: 'Probe 2' }))
    await first

    expect(agent().displayName).toBe('Probe 2')
    expect(agent(OTHER).displayName).toBe('Other 2')
  })

  it('a failed read, or an answer for another agent, changes nothing and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    pending[0].resolve({ error: 'Agent not found' }, 404)
    await failed
    const wrong = agentStore.refreshAgentFieldsFromServer(AGENT, 'identity')
    pending[1].resolve({ id: OTHER, displayName: 'Wrong agent' })
    await wrong
    const thrown = agentStore.refreshAgentFieldsFromServer(AGENT, 'memory')
    pending[2].reject(new Error('offline'))
    await thrown

    expect(agent().displayName).toBe('Probe')
    expect(agent().memory_lane_budgets).toEqual({ on_my_mind: 100, triggers: 200, recalled: 300 })
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('an agent this tab has not loaded is not read', async () => {
    await agentStore.refreshAgentFieldsFromServer('agent-unknown', 'identity')
    expect(pending).toHaveLength(0)
  })

  it('retention refresh adopts both CLI leaves literally and clears an absent partner without changing model or name', async () => {
    agentStore.updateAgent(AGENT, { agentType: 'cli', show_reasoning: false, preserve_reasoning: true, primary_model_name: 'claude-cli' } as any)
    const done = agentStore.refreshAgentFieldsFromServer(AGENT, 'retention')
    pending[0].resolve(record({ show_reasoning: null, preserve_reasoning: false, displayName: 'Not identity', primary_model_name: 'Not model' }))
    await done
    expect(agent()).toMatchObject({ show_reasoning: null, preserve_reasoning: false, displayName: 'Probe', primary_model_name: 'claude-cli' })
    const clear = agentStore.refreshAgentFieldsFromServer(AGENT, 'retention')
    pending[1].resolve(record({ show_reasoning: false }))
    await clear
    expect(agent().show_reasoning).toBe(false)
    expect(agent().preserve_reasoning).toBeUndefined()
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options || !('method' in options) || options.method === 'GET')).toBe(true)
  })
})
