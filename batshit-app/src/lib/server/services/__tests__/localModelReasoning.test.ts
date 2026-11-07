// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ servers: vi.fn(), key: vi.fn() }))
vi.mock('../localAiServers', () => ({ listLocalAiServers: state.servers, resolveLocalAiRuntimeBaseUrl: (value: string) => value.replace('localhost', 'host.docker.internal') }))
vi.mock('../localProgramApiKeys', () => ({ readLocalProgramApiKey: state.key }))
import { captureAgentLocalReasoning, qualifyOllamaReasoningMetadata, readLocalModelReasoning } from '../localModelReasoning'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
const identity = { presetId: 'fixture', connection: { type: 'direct' as const, id: 'direct:ollama', service: 'ollama' }, effectiveModelId: 'qwen3.5:9b-q4_K_M' }
const show = { capabilities: ['completion', 'vision', 'tools', 'thinking'], thinking: { values: [false, true], default: true },
  modelfile: 'PRIVATE_MODELFILE', template: 'PRIVATE_TEMPLATE', system: 'PRIVATE_SYSTEM', license: 'PRIVATE_LICENSE' }
beforeEach(() => { state.servers.mockReset(); state.key.mockReset(); state.servers.mockResolvedValue([{ id: 'ollama', enabled: true, baseUrl: 'http://localhost:11434' }]); state.key.mockResolvedValue('fixture-local-key') })
afterEach(() => vi.unstubAllGlobals())
describe('P6 one selected filtered Ollama read', () => {
  it('reads one version and one nonverbose exact show with saved auth/Docker URL and filters private fields', async () => {
    const http = vi.fn(async (url: string) => Response.json(url.endsWith('/api/version') ? { version: '0.40.3' } : show))
    vi.stubGlobal('fetch', http)
    const value = await readLocalModelReasoning('owner', identity)
    expect(value.contract).toMatchObject({ status: 'verified', effectiveModelId: identity.effectiveModelId, runtimeVersion: '0.40.3', adapterVersion: '4.0.1', thinking: { values: [false, true], default: true } })
    expect(value.connectionKey).toMatch(/^[a-f0-9]{64}$/)
    expect(http.mock.calls.map(call => call[0])).toEqual(['http://host.docker.internal:11434/api/version', 'http://host.docker.internal:11434/api/show'])
    expect(JSON.parse(String((http.mock.calls[1] as any)[1].body))).toEqual({ model: identity.effectiveModelId, verbose: false })
    expect(new Headers((http.mock.calls[1] as any)[1].headers).get('authorization')).toBe('Bearer fixture-local-key')
    const serialized = JSON.stringify(value.contract)
    for (const forbidden of ['PRIVATE_', 'modelfile', 'template', 'system', 'license', 'fixture-local-key', value.connectionKey]) expect(serialized).not.toContain(forbidden)
  })
  it.each([
    null, {}, { capabilities: ['thinking'] }, { ...show, model: 'another-model' },
    { ...show, thinking: { values: ['low', 'high'], default: 'low' } },
    { ...show, thinking: { values: [false, false], default: false } },
    { ...show, thinking: { values: [false, true] } },
    { ...show, thinking: { values: [0, 1], default: 1 } }
  ])('keeps absent/mismatched/named metadata unverified', value => {
    const result = qualifyOllamaReasoningMetadata(identity.effectiveModelId, '0.40.3', value)
    expect(result.status).toBe('unverified'); expect(result).not.toHaveProperty('thinking')
  })
  it('requires actual runtime/adapter evidence rather than model-name inference', () => {
    expect(qualifyOllamaReasoningMetadata(identity.effectiveModelId, undefined, show).status).toBe('unverified')
    expect(qualifyOllamaReasoningMetadata(identity.effectiveModelId, '0.40.3', show, '4.0.2').status).toBe('unverified')
    expect(qualifyOllamaReasoningMetadata('an-unfamiliar-thinking-model', '0.40.3', show).status).toBe('verified')
  })
  it('does not probe disabled or mismatched connections and preserves failed-read intent', async () => {
    const http = vi.fn(async () => { throw new Error('PRIVATE_SYSTEM') }); vi.stubGlobal('fetch', http)
    state.servers.mockResolvedValue([{ id: 'ollama', enabled: false, baseUrl: 'http://localhost:11434' }])
    expect((await readLocalModelReasoning('owner', identity)).contract.status).toBe('unverified')
    expect(http).not.toHaveBeenCalled(); expect(state.key).not.toHaveBeenCalled()
    expect((await readLocalModelReasoning('owner', { ...identity, connection: { ...identity.connection, id: 'direct:custom' } })).contract.status).toBe('unverified')
    state.servers.mockResolvedValue([{ id: 'ollama', enabled: true, baseUrl: 'http://localhost:11434' }])
    const failed = await readLocalModelReasoning('owner', identity)
    expect(failed.contract.status).toBe('unverified'); expect(JSON.stringify(failed)).not.toContain('PRIVATE_SYSTEM')
  })
  it('adds no metadata reads for inherited settings or an independent preset/key', async () => {
    const args = { preset: { id: identity.presetId, modelId: 'catalog/qwen-local', effectiveModelId: identity.effectiveModelId, connection: identity.connection, settings: { ollamaThink: true } } as any }
    expect(await captureAgentLocalReasoning('owner', args, {})).toBeUndefined()
    const other = reasoningOverrideKey({ ...identity, presetId: 'child' }, 'thinking')
    expect(await captureAgentLocalReasoning('owner', args, { [other]: { mode: 'value', value: true } })).toBeUndefined()
    expect(state.servers).not.toHaveBeenCalled()
    const http = vi.fn(async (url: string) => Response.json(url.endsWith('/api/version') ? { version: '0.40.3' } : show))
    vi.stubGlobal('fetch', http)
    const key = reasoningOverrideKey(identity, 'thinking')
    const captured = await captureAgentLocalReasoning('owner', args, { [key]: { mode: 'value', value: false } })
    expect(captured?.contract.effectiveModelId).toBe(identity.effectiveModelId)
    expect(http).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String((http.mock.calls[1] as any)[1].body)).model).toBe(identity.effectiveModelId)
  })
})
