import { afterEach, describe, expect, it, vi } from 'vitest'
import * as agents from './agents.svelte'
import { getAgentReasoningSave, saveAgentReasoningControl, waitForAgentReasoningSaves, assertAgentReasoningSaveAcknowledged } from './agentReasoningSaves.svelte'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
import { agentReasoningContext, agentReasoningControlKeys } from '$lib/utils/agentReasoningContext'
import { agentReasoningReadGeneration, preserveNewerReasoningLeaves } from '$lib/utils/agentReasoningReadGuard'

const key = reasoningOverrideKey({ presetId: 'fixture', connection: { type: 'direct', id: 'direct:openai', service: 'openai' }, effectiveModelId: 'gpt-6.1-sol' }, 'effort')
function seed(id: string) {
  const agent = { id, user_id: 'fixture-user', displayName: id, created_at: '', updated_at: '',
    provider_specific_settings: { 'openai.reasoningEffort': 'high', temperature: 0 } }
  agents.setAgents([...agents.getAgents(), agent])
  agents.setCurrentAgentId(id)
  return agent
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function acknowledge(init: RequestInit) {
  const patch = JSON.parse(String(init.body)).model_reasoning_overrides
  const savedKey = Object.keys(patch)[0]
  return Response.json({ success: true, model_reasoning_override: { key: savedKey, selection: patch[savedKey] } })
}
afterEach(() => { vi.unstubAllGlobals(); agents.setAgents([]); agents.setCurrentAgentId(null) })

describe('SA-132 shared acknowledged save owner', () => {
  it('guards the first local Thinking draft even when metadata and the canonical override leaf are absent', async () => {
    const agent = { ...seed('local_first_failed'), agentType: 'api', primary_model_preset_id: 'local', primary_model_name: 'stale-copy',
      primary_model_connection: { type: 'direct' as const, id: 'direct:ollama', service: 'ollama' } }
    agents.updateAgent(agent.id, agent as any)
    const context = agentReasoningContext(agent, { id: 'local', provider: 'qwen', modelId: 'catalog/qwen', effectiveModelId: 'qwen3.5:9b-q4_K_M',
      connection: agent.primary_model_connection, settings: {} } as any)!
    expect(context.binding).toBeNull()
    expect(agentReasoningControlKeys(context)).toEqual([context.keys.thinking])
    const hold = deferred()
    vi.stubGlobal('fetch', vi.fn(async () => { await hold.promise; return Response.json({ error: 'Local Thinking not saved' }, { status: 500 }) }))
    const write = saveAgentReasoningControl(agent.id, context.keys.thinking, { mode: 'value', value: false })
    const rejected = expect(write).rejects.toThrow('Local Thinking not saved')
    await expect(waitForAgentReasoningSaves(agent.id, 1)).rejects.toThrow(/still saving/)
    hold.resolve(); await rejected; await waitForAgentReasoningSaves(agent.id)
    expect(agents.getAgentById(agent.id)?.model_reasoning_overrides).toBeUndefined()
    expect(() => agentReasoningControlKeys(context).forEach(key => assertAgentReasoningSaveAcknowledged(agent.id, key))).toThrow('Local Thinking not saved')
  })

  it('waits for both active API controls and refuses a failed mode even with acknowledged effort', async () => {
    const agent = { ...seed('api_multi_control'), agentType: 'api', primary_model_preset_id: 'claude', primary_model_name: 'claude-sonnet-5-5',
      primary_model_provider: 'anthropic', primary_model_connection: { type: 'direct' as const, id: 'direct:anthropic', service: 'anthropic' } }
    agents.updateAgent(agent.id, agent as any)
    const context = agentReasoningContext(agent)!
    expect(agentReasoningControlKeys(context)).toEqual([context.keys.effort, context.keys.mode])
    const hold = deferred()
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      const patch = JSON.parse(String(init.body)).model_reasoning_overrides
      if (context.keys.mode in patch) { await hold.promise; return Response.json({ error: 'Mode not saved' }, { status: 500 }) }
      return acknowledge(init)
    }))
    await saveAgentReasoningControl(agent.id, context.keys.effort, { mode: 'value', value: 'high' })
    const mode = saveAgentReasoningControl(agent.id, context.keys.mode, { mode: 'value', value: 'adaptive' })
    const rejected = expect(mode).rejects.toThrow('Mode not saved')
    await expect(waitForAgentReasoningSaves(agent.id, 1)).rejects.toThrow(/still saving/)
    hold.resolve(); await rejected; await waitForAgentReasoningSaves(agent.id)
    expect(() => assertAgentReasoningSaveAcknowledged(agent.id, context.keys.effort)).not.toThrow()
    expect(() => agentReasoningControlKeys(context).forEach(key => assertAgentReasoningSaveAcknowledged(agent.id, key))).toThrow('Mode not saved')
  })

  it('Send waits for a Settings/chat save and only its named leaf is persisted', async () => {
    const agent = seed('save_wait')
    const hold = deferred(); const bodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body)); await hold.promise; return acknowledge(init)
    }))
    const write = saveAgentReasoningControl(agent.id, key, { mode: 'value', value: 'max' })
    const admitted = vi.fn()
    const send = waitForAgentReasoningSaves(agent.id).then(() => { assertAgentReasoningSaveAcknowledged(agent.id, key); admitted() })
    await Promise.resolve(); expect(admitted).not.toHaveBeenCalled()
    expect(getAgentReasoningSave(agent.id, key)).toMatchObject({ pending: true })
    hold.resolve(); await Promise.all([write, send])
    expect(bodies).toEqual([{ model_reasoning_overrides: { [key]: { mode: 'value', value: 'max' } } }])
    expect(agents.getAgentById(agent.id)?.provider_specific_settings).toEqual(agent.provider_specific_settings)
    expect(admitted).toHaveBeenCalledOnce()
  })

  it('serializes repeated picks and a late response cannot retarget another model or agent', async () => {
    const first = seed('save_old'); const second = seed('save_new')
    const firstHold = deferred(); const secondHold = deferred(); let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { await (++calls === 1 ? firstHold.promise : secondHold.promise); return acknowledge(init) }))
    const old = saveAgentReasoningControl(first.id, key, { mode: 'value', value: 'low' })
    const newer = saveAgentReasoningControl(first.id, key, { mode: 'value', value: 'max' })
    await Promise.resolve(); await Promise.resolve()
    firstHold.resolve(); await old
    expect(getAgentReasoningSave(first.id, key)).toMatchObject({ selection: { value: 'max' }, pending: true })
    expect(agents.getCurrentAgentId()).toBe(second.id)
    expect(agents.getAgentById(second.id)?.model_reasoning_overrides).toBeUndefined()
    secondHold.resolve(); await newer
    expect(agents.getAgentById(first.id)?.model_reasoning_overrides?.[key]).toEqual({ mode: 'value', value: 'max' })
  })

  it('failed/unknown saves stop the selected control until an explicit successful choice', async () => {
    const agent = seed('save_failure')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network outcome unknown') }))
    await expect(saveAgentReasoningControl(agent.id, key, { mode: 'value', value: 'max' })).rejects.toThrow(/unknown/)
    await waitForAgentReasoningSaves(agent.id)
    expect(() => assertAgentReasoningSaveAcknowledged(agent.id, key)).toThrow(/unknown/)
    expect(() => assertAgentReasoningSaveAcknowledged('another-agent', key)).not.toThrow()
    expect(() => assertAgentReasoningSaveAcknowledged(agent.id, 'another-model')).not.toThrow()
    expect(agents.getAgentById(agent.id)?.model_reasoning_overrides).toBeUndefined()
    const retry = vi.fn(async (_url, init) => init?.method === 'PUT' ? acknowledge(init) : Response.json(agent))
    vi.stubGlobal('fetch', retry)
    await saveAgentReasoningControl(agent.id, key, null)
    expect(() => assertAgentReasoningSaveAcknowledged(agent.id, key)).not.toThrow()
    expect(retry.mock.calls.map(call => call[1]?.method ?? 'GET')).toEqual(['GET', 'PUT'])
  })

  it('an unacknowledged write times out admission without dispatching a send', async () => {
    const agent = seed('save_timeout'); const hold = deferred()
    const fetchMock = vi.fn(async (_url, init) => { await hold.promise; return acknowledge(init) })
    vi.stubGlobal('fetch', fetchMock)
    const write = saveAgentReasoningControl(agent.id, key, { mode: 'provider-default' })
    await expect(waitForAgentReasoningSaves(agent.id, 1)).rejects.toThrow(/still saving/)
    const second = saveAgentReasoningControl(agent.id, key, { mode: 'value', value: 'max' })
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()
    hold.resolve(); await Promise.all([write, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(agents.getAgentById(agent.id)?.model_reasoning_overrides?.[key]).toEqual({ mode: 'value', value: 'max' })
  })

  it('clears a successful overlay so a later authoritative record update can change the visible choice', async () => {
    const agent = seed('save_live_read')
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => acknowledge(init)))
    await saveAgentReasoningControl(agent.id, key, { mode: 'value', value: 'max' })
    expect(getAgentReasoningSave(agent.id, key)).toBeUndefined()
    agents.updateAgent(agent.id, { model_reasoning_overrides: { [key]: { mode: 'value', value: 'low' } } })
    expect(agents.getAgentById(agent.id)?.model_reasoning_overrides?.[key]).toEqual({ mode: 'value', value: 'low' })
  })

  it('a GET started before acknowledgment cannot undo it; a later GET remains authoritative', async () => {
    const agent = seed('save_read_order')
    const hold = deferred()
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { await hold.promise; return acknowledge(init) }))
    const write = saveAgentReasoningControl(agent.id, key, { mode: 'value', value: 'max' })
    const staleRead = agentReasoningReadGeneration(agent.id)
    hold.resolve(); await write
    const current = agents.getAgentById(agent.id)?.model_reasoning_overrides
    const external = { [key]: { mode: 'value' as const, value: 'low' } }
    expect(preserveNewerReasoningLeaves(agent.id, external, current, staleRead)?.[key]).toEqual({ mode: 'value', value: 'max' })
    expect(preserveNewerReasoningLeaves(agent.id, external, current, agentReasoningReadGeneration(agent.id))).toBe(external)
  })

  it('a malformed HTTP200 never acknowledges a choice or starts an automatic replacement write', async () => {
    const agent = seed('save_bad_ack')
    const http = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', http)
    await expect(saveAgentReasoningControl(agent.id, key, { mode: 'value', value: 'max' })).rejects.toThrow(/could not be confirmed/)
    expect(() => assertAgentReasoningSaveAcknowledged(agent.id, key)).toThrow(/could not be confirmed/)
    expect(http).toHaveBeenCalledOnce()
    expect(agents.getAgentById(agent.id)?.model_reasoning_overrides).toBeUndefined()
  })
})
