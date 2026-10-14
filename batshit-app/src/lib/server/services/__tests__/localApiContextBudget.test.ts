import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ servers: vi.fn(), key: vi.fn(), get: vi.fn() }))
vi.mock('../localAiServers', () => ({ listLocalAiServers: mocks.servers,
  resolveLocalAiRuntimeBaseUrl: (url: string) => url }))
vi.mock('../localProgramApiKeys', () => ({ readLocalProgramApiKey: mocks.key }))
vi.mock('$lib/server/redis', () => ({ redis: { get: mocks.get } }))
import { resolveApiContextBudget } from '../localApiContextBudget'
import { clearLocalRuntimeContextCache, readLocalRuntimeContextEvidence } from '../localRuntimeContext'
import { resolveAgentBudgetSettings } from '../contextTokenPreview'
import { summarizeContextUsage } from '$lib/utils/tokenPanel'

beforeEach(() => {
  clearLocalRuntimeContextCache()
  vi.clearAllMocks()
  mocks.key.mockResolvedValue(null)
  mocks.servers.mockResolvedValue([{ id: 'koboldcpp', enabled: true, baseUrl: 'http://host-a' }])
})
afterEach(() => vi.unstubAllGlobals())

function probe(provider: 'koboldcpp' | 'ollama', loaded = 16384) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(
    url.endsWith('/version') ? { admin: 0, router: false, llm: true }
      : provider === 'koboldcpp' ? { value: loaded }
        : { models: loaded ? [{ name: 'qwen:latest', context_length: loaded }] : [] }
  )))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('shared local send/preview/meter context budget', () => {
  it('uses the Kobold loaded ceiling in preview and meter, even with a different preset model id', async () => {
    probe('koboldcpp')
    const preset = { id: 'saved', provider: 'koboldcpp', modelId: 'old-model', contextWindow: 64000 }
    mocks.get.mockResolvedValue(preset)
    const agent = { id: 'agent', user_id: 'user', primary_model_preset_id: 'saved' }
    const actual = await resolveApiContextBudget({ userId: 'user', providerId: 'koboldcpp',
      modelId: 'old-model', presetContextWindow: 64000 })
    const preview = await resolveAgentBudgetSettings(agent)
    expect(actual.contextLimit).toBe(16384)
    expect(preview.contextLimit).toBe(actual.contextLimit)
    expect(preview.localContext?.source).toBe('loaded')
    expect(JSON.stringify(preview.localContext)).not.toContain('http')
    const meter = summarizeContextUsage({ messages: [], snapshots: [], activeModel: preset as any,
      agent: agent as any, liveContextLimit: preview.contextLimit,
      liveLocalContext: preview.localContext })
    expect(meter.contextLimit).toBe(16384)
    expect(meter.detail).toContain('reported a loaded context')
  })

  it('keeps a smaller preset in preview and meter while provenance names the actual loaded allocation', async () => {
    probe('koboldcpp')
    const preset = { id: 'saved', provider: 'koboldcpp', modelId: 'qwen', contextWindow: 8192 }
    mocks.get.mockResolvedValue(preset)
    const agent = { id: 'agent', user_id: 'user', primary_model_preset_id: 'saved' }
    const actual = await resolveApiContextBudget({ userId: 'user', providerId: 'koboldcpp',
      modelId: 'qwen', presetContextWindow: 8192 })
    const preview = await resolveAgentBudgetSettings(agent)
    expect(actual.contextLimit).toBe(8192)
    expect(actual.loadedContextWindow).toBe(16384)
    expect(preview.contextLimit).toBe(actual.contextLimit)
    expect(preview.localContext?.source).toBe('loaded')
    expect(preview.localContext?.note).toContain('16,384')
    expect(preview.localContext?.note).toContain('smaller preset limit of 8,192')
    const meter = summarizeContextUsage({ messages: [], snapshots: [], activeModel: preset as any,
      agent: agent as any, liveContextLimit: preview.contextLimit, liveLocalContext: preview.localContext })
    expect(meter.contextLimit).toBe(8192)
    expect(meter.detail).toContain('16,384')
    expect(meter.detail).toContain('8,192')
  })

  it('reports the native request separately from a smaller planning cap', async () => {
    probe('ollama', 131072)
    mocks.servers.mockResolvedValue([{ id: 'ollama', enabled: true, baseUrl: 'http://host-a' }])
    const actual = await resolveApiContextBudget({ userId: 'user', providerId: 'ollama',
      modelId: 'qwen:latest', presetContextWindow: 4096, requestedContextWindow: 8192 })
    expect(actual.contextLimit).toBe(4096)
    expect(actual.loadedContextWindow).toBe(131072)
    expect(actual.evidence?.source).toBe('requested')
    expect(actual.evidence?.note).toContain('asked to use 8,192')
    expect(actual.evidence?.note).toContain('smaller preset limit of 4,096')
    expect(actual.evidence?.note).not.toContain('131,072')
  })

  it('maps the real preset Ollama context request before planning the preview', async () => {
    probe('ollama', 131072)
    mocks.servers.mockResolvedValue([{ id: 'ollama', enabled: true, baseUrl: 'http://host-a' }])
    mocks.get.mockResolvedValue({ id: 'saved', provider: 'ollama', modelId: 'qwen:latest',
      contextWindow: 64000, connection: { type: 'direct', service: 'ollama' }, settings: { ollamaNumCtx: 8192 } })
    const preview = await resolveAgentBudgetSettings({ user_id: 'user', primary_model_preset_id: 'saved' })
    expect(preview.contextLimit).toBe(8192)
    expect(preview.localContext?.source).toBe('requested')
    const actual = await resolveApiContextBudget({ userId: 'user', providerId: 'ollama',
      modelId: 'qwen:latest', presetContextWindow: 64000, requestedContextWindow: 8192 })
    expect(actual.contextLimit).toBe(preview.contextLimit)
  })

  it('leaves known-but-unloaded context unknown and labels unsupported providers as a preset estimate', async () => {
    probe('ollama', 0)
    mocks.servers.mockResolvedValue([{ id: 'ollama', enabled: true, baseUrl: 'http://host-a' }])
    const unloaded = await resolveApiContextBudget({ userId: 'user', providerId: 'ollama',
      modelId: 'qwen:latest', presetContextWindow: 64000 })
    expect(unloaded.contextLimit).toBeNull()
    expect(unloaded.evidence?.source).toBe('unknown-until-loaded')
    const unsupported = await resolveApiContextBudget({ userId: 'user', providerId: 'vllm',
      modelId: 'qwen', presetContextWindow: 64000 })
    expect(unsupported.contextLimit).toBe(64000)
    expect(unsupported.evidence?.note).toContain('saved preset estimate')
  })

  it('never reuses a denominator for an expired reading or a changed provider/model', async () => {
    probe('koboldcpp')
    const result = await resolveApiContextBudget({ userId: 'user', providerId: 'koboldcpp',
      modelId: 'qwen', presetContextWindow: 64000 })
    const base = { messages: [], snapshots: [], agent: null,
      activeModel: { provider: 'koboldcpp', modelId: 'qwen', contextWindow: 64000 } as any,
      liveContextLimit: 16384, liveLocalContext: result.evidence }
    expect(summarizeContextUsage({ ...base, now: result.evidence!.expiresAt - 1 }).contextLimit).toBe(16384)
    expect(summarizeContextUsage({ ...base, now: result.evidence!.expiresAt }).contextLimit).toBeNull()
    expect(summarizeContextUsage({ ...base, activeModel: { ...base.activeModel, modelId: 'new' } }).contextLimit).toBeNull()
    expect(summarizeContextUsage({ ...base, liveLocalContext: null }).contextLimit).toBeNull()
  })

  it('scopes native reading cache to user, endpoint, credential and exact Ollama model', async () => {
    const fetchMock = probe('ollama')
    const input = { providerId: 'ollama', modelId: 'qwen:latest', baseUrl: 'http://host-a', userId: 'one', apiKey: 'test-key' }
    await readLocalRuntimeContextEvidence(input)
    await readLocalRuntimeContextEvidence(input)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer test-key' } })
    expect((await readLocalRuntimeContextEvidence({ ...input, modelId: 'other' }))?.reading).toBeNull()
    for (const change of [{ userId: 'two' }, { baseUrl: 'http://host-b' }, { apiKey: 'changed-key' }]) {
      await readLocalRuntimeContextEvidence({ ...input, ...change })
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('surfaces a saved-server read failure rather than inventing default endpoint evidence', async () => {
    const fetchMock = probe('koboldcpp')
    mocks.servers.mockRejectedValue(new Error('saved servers unavailable'))
    await expect(resolveApiContextBudget({ userId: 'user', providerId: 'koboldcpp',
      modelId: 'qwen', presetContextWindow: 64000 })).rejects.toThrow('saved servers unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
