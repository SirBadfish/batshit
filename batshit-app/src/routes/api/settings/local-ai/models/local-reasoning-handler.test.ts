import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ agent: vi.fn(), preset: vi.fn(), read: vi.fn() }))
vi.mock('$lib/server/redis', () => ({ redis: { get: state.agent } }))
vi.mock('$lib/server/services/runtimeModelPreset', () => ({ loadRuntimeModelPreset: state.preset }))
vi.mock('$lib/server/services/localModelReasoning', () => ({ readLocalModelReasoning: state.read,
  isOllamaReasoningIdentity: (identity: any) => identity.connection.id === 'direct:ollama' && identity.connection.service === 'ollama' && identity.connection.type === 'direct' }))
vi.mock('$lib/server/services/localAiModelManagement', () => ({ isManageableProgram: () => true }))
import { GET } from './+server'
const connection = { type: 'direct', id: 'direct:ollama', service: 'ollama' }
const contract = { version: 1, status: 'verified', connectionId: 'direct:ollama', effectiveModelId: 'exact-model', adapterVersion: '4.0.1', runtimeVersion: '0.40.3', checkedAt: '2026-10-15', thinking: { values: [false, true], default: true } }
function event(user = 'owner') { const request = new Request('http://localhost/api/settings/local-ai/models?mode=reasoning&program=ollama&agentId=agent'); return { url: new URL(request.url), request, locals: { user: user ? { id: user } : null } } as any }
beforeEach(() => { vi.clearAllMocks(); state.agent.mockResolvedValue({ id: 'agent', user_id: 'owner', agentType: 'api', primary_model_preset_id: 'preset' }); state.preset.mockResolvedValue({ id: 'preset', provider: 'qwen', modelId: 'catalog/qwen-local', effectiveModelId: 'exact-model', connection, settings: {} }); state.read.mockResolvedValue({ contract, connectionKey: 'PRIVATE_CONNECTION_KEY' }) })
describe('owned Local AI reasoning-only read route', () => {
  it('requires session ownership and the actual selected API transport before metadata', async () => {
    expect((await GET(event(''))).status).toBe(401)
    expect((await GET(event('foreign'))).status).toBe(404)
    state.agent.mockResolvedValue({ id: 'agent', user_id: 'owner', agentType: 'cli', primary_model_preset_id: 'preset' })
    expect((await GET(event())).status).toBe(409)
    expect(state.read).not.toHaveBeenCalled()
  })
  it('does not expose the server envelope/key and reads only the selected model', async () => {
    const response = await GET(event()), body = await response.json()
    expect(response.status).toBe(200); expect(body.reasoning.contract).toEqual(contract)
    expect(JSON.stringify(body)).not.toContain('PRIVATE_CONNECTION_KEY')
    expect(state.read).toHaveBeenCalledWith('owner', { presetId: 'preset', connection, effectiveModelId: 'exact-model' }, expect.any(AbortSignal))
    expect(state.read).toHaveBeenCalledTimes(1)
    expect(state.agent).toHaveBeenCalledWith('agent:agent')
  })
  it('refuses a requested Ollama read when the saved selection uses another connection', async () => {
    state.preset.mockResolvedValue({ id: 'preset', modelId: 'exact-model', connection: { type: 'direct', id: 'direct:lmstudio', service: 'lmstudio' } })
    expect((await GET(event())).status).toBe(409); expect(state.read).not.toHaveBeenCalled()
  })
})
