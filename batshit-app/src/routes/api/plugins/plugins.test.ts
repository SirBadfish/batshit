import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), global: vi.fn(), agent: vi.fn(), publish: vi.fn() }))
vi.mock('$lib/server/services/agentPlugins', () => ({
  AgentPluginError: class extends Error { constructor(public code: string, message: string, public status = 409, public outcome = 'not_written') { super(message) } },
  listAgentPlugins: mocks.list, pluginDescriptor: (value: unknown) => value,
  setAgentPluginGlobalAccess: mocks.global, setAgentPluginAgentAccess: mocks.agent,
  getAgentPlugin: vi.fn(), removeAgentPlugin: vi.fn(), registerAgentPlugin: vi.fn()
}))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent: mocks.publish }))
// These tests exercise route admission/envelopes; physical writes have actual Redis proof.
vi.mock('$lib/server/services/agentPluginImport', () => ({ removeImportedAgentPlugin: vi.fn() }))
import { GET } from './+server'
import { PUT as globalPUT } from './[id]/+server'
import { PUT as agentPUT } from './[id]/agent-access/+server'
import { AgentPluginError } from '$lib/server/services/agentPlugins'
const plugin = { id: 'batshit', name: 'Batshit', builtIn: true, description: '', version: '1', skills: [], enabled_for_all_agents: false, enabled_agent_ids: [], revision: 'one' }
const event = (body: unknown, authorized = true) => ({ params: { id: 'batshit' }, locals: { user: authorized ? { id: 'owner' } : null }, request: new Request('http://localhost/api/plugins/batshit', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) }) as never
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([plugin]); mocks.global.mockResolvedValue({ plugin, changed: true }); mocks.agent.mockResolvedValue({ plugin, changed: true }) })
describe('human plugin management routes', () => {
  it('requires a signed-in browser for reads and both access mutations', async () => {
    expect((await GET(event(null, false))).status).toBe(401)
    expect((await globalPUT(event({ enabled_for_all_agents: true }, false))).status).toBe(401)
    expect((await agentPUT(event({ agentId: 'one', enabled: true }, false))).status).toBe(401)
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.global).not.toHaveBeenCalled(); expect(mocks.agent).not.toHaveBeenCalled()
  })
  it('lists the complete descriptor envelope and visibly refuses unavailable reads', async () => {
    expect(await (await GET(event(null))).json()).toEqual({ plugins: [plugin] })
    mocks.list.mockRejectedValue(new AgentPluginError('PLUGIN_UNAVAILABLE', 'Unreadable group'))
    const response = await GET(event(null)); expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
  })
  it('rejects extra, missing and malformed global fields before calling the writer', async () => {
    for (const value of [{}, { enabled_for_all_agents: 1 }, { enabled_for_all_agents: true, enabled_agent_ids: [] }]) expect((await globalPUT(event(value))).status).toBe(400)
    expect(mocks.global).not.toHaveBeenCalled()
  })
  it('changes only the requested global field and notifies mounted consumers after a confirmed change', async () => {
    const response = await globalPUT(event({ enabled_for_all_agents: false }))
    expect(await response.json()).toEqual({ plugin, changed: true })
    expect(mocks.global).toHaveBeenCalledWith('owner', 'batshit', false)
    expect(mocks.publish).toHaveBeenCalledWith('owner', { type: 'plugin_access_changed', pluginId: 'batshit' })
  })
  it('accepts exactly one actor toggle and refuses bulk/global fields', async () => {
    expect((await agentPUT(event({ agentId: 'A-B', enabled: true }))).status).toBe(200)
    expect(mocks.agent).toHaveBeenCalledWith('owner', 'batshit', 'A-B', true)
    mocks.agent.mockClear()
    for (const body of [{ agentId: 'one', enabled: true, enabled_for_all_agents: true }, { agentId: 'one', enabled: 'true' }, { agentId: 1, enabled: false }]) expect((await agentPUT(event(body))).status).toBe(400)
    expect(mocks.agent).not.toHaveBeenCalled()
  })
  it('returns global-on conflicts as known no-write and lost replies as explicit unknown without a success event', async () => {
    mocks.agent.mockRejectedValue(new AgentPluginError('PLUGIN_GLOBAL_ACCESS', 'Disable global first'))
    expect((await agentPUT(event({ agentId: 'one', enabled: true }))).status).toBe(409)
    mocks.global.mockRejectedValue(new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Lost reply', 503, 'unknown' as never))
    const response = await globalPUT(event({ enabled_for_all_agents: true }))
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'PLUGIN_SAVE_UNKNOWN', outcome: 'unknown' })
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
