// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/services/memory/memoryIndex', () => ({
  getMemoryConfig: vi.fn(), getMemoryIndexMeta: vi.fn(), setMemoryConfig: vi.fn()
}))
vi.mock('$lib/server/services/modelPresetSelectionOwner', () => ({ readOwnedModelPresetDependency: vi.fn() }))
vi.mock('$lib/server/services/memory/memoryEmbedder', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/server/services/memory/memoryEmbedder')>(),
  detectPresetEmbeddingDims: vi.fn()
}))

import { getMemoryConfig, getMemoryIndexMeta, setMemoryConfig } from '$lib/server/services/memory/memoryIndex'
import { canonicalEmbeddingModelId, DEFAULT_MEMORY_EMBEDDING_CONFIG, detectPresetEmbeddingDims, resolvePresetEmbeddingTarget } from '$lib/server/services/memory/memoryEmbedder'
import { readOwnedModelPresetDependency } from '$lib/server/services/modelPresetSelectionOwner'
import { PresetReferenceWriteError } from '$lib/server/services/modelPresetReferenceGuard'
import { PUT } from './+server'

const builtin = { ...DEFAULT_MEMORY_EMBEDDING_CONFIG }
const preset = { lane: 'preset', modelId: 'preset:openai:fixture', preset: { presetId: 'fixture', dims: 3 } }

async function put(body: unknown, signedIn = true, raw = false) {
  return PUT({
    locals: { user: signedIn ? { id: 'config-route-test' } : undefined },
    request: new Request('http://fixture/api/memory/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: raw ? String(body) : JSON.stringify(body)
    })
  } as Parameters<typeof PUT>[0])
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(getMemoryConfig).mockResolvedValue({ embedding: builtin, schema_version: 1 })
  vi.mocked(getMemoryIndexMeta).mockResolvedValue(null)
  // Preserve the writer's real pure validation while replacing its physical storage.
  vi.mocked(setMemoryConfig).mockImplementation(async embedding => {
    canonicalEmbeddingModelId(embedding)
    return { embedding, schema_version: 1 }
  })
  vi.mocked(readOwnedModelPresetDependency).mockResolvedValue({
    preset: { provider: 'openai', modelId: 'fixture', connection: { service: 'openai' } }
  } as Awaited<ReturnType<typeof readOwnedModelPresetDependency>>)
})
afterEach(() => vi.restoreAllMocks())

describe('memory config PUT failure classification (BL-1890)', () => {
  it('requires sign-in before saving', async () => {
    expect((await put({ embedding: builtin }, false)).status).toBe(401)
    expect(setMemoryConfig).not.toHaveBeenCalled()
  })

  it.each(['{', '{}'])('keeps malformed/missing input as 400 (%s)', async body => {
    expect((await put(body, true, true)).status).toBe(400)
    expect(setMemoryConfig).not.toHaveBeenCalled()
  })

  it.each([
    { lane: 'builtin', modelId: 'not-a-builtin' },
    { lane: 'local-ai', modelId: 'legacy', localAi: { baseUrl: 'http://fixture' } },
    { lane: 'api', modelId: 'legacy', api: { provider: 'openai' } }
  ])('keeps invalid %s embedding configuration as 400', async embedding => {
    const response = await put({ embedding })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.any(String) })
    expect(getMemoryIndexMeta).not.toHaveBeenCalled()
  })

  it('keeps the ChatGPT-plan funding refusal as 400 without probing or saving', async () => {
    vi.mocked(readOwnedModelPresetDependency).mockResolvedValue({
      preset: { provider: 'openai', modelId: 'fixture', connection: { service: 'chatgpt-plan' } }
    } as Awaited<ReturnType<typeof readOwnedModelPresetDependency>>)
    const response = await put({ embedding: preset })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.stringContaining('cannot provide memory embeddings') })
    expect(detectPresetEmbeddingDims).not.toHaveBeenCalled()
    expect(setMemoryConfig).not.toHaveBeenCalled()
  })

  it.each(['invalid', 'changed', 'unavailable', 'unknown'] as const)('preserves the explicit %s status, code and message', async kind => {
    const error = new PresetReferenceWriteError(kind)
    vi.mocked(setMemoryConfig).mockRejectedValue(error)
    const response = await put({ embedding: builtin })
    expect(response.status).toBe(error.status)
    expect(await response.json()).toEqual({ error: error.message, code: error.code })
  })

  it('reports an untyped storage failure as 500 with its message and code', async () => {
    vi.mocked(setMemoryConfig).mockRejectedValue(Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET' }))
    const response = await put({ embedding: builtin })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Storage unavailable', code: 'ECONNRESET' })
  })

  it('reports a failed saved-key read as 500 before saving', async () => {
    vi.mocked(getMemoryConfig).mockRejectedValue(new Error('Saved config unavailable'))
    const response = await put({ embedding: { lane: 'local-ai', modelId: 'legacy', localAi: { apiKey: '***' } } })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Saved config unavailable' })
    expect(setMemoryConfig).not.toHaveBeenCalled()
  })

  it('reports a failed dimension probe as 500 without saving', async () => {
    vi.mocked(detectPresetEmbeddingDims).mockRejectedValue(new Error('Embedding service unavailable'))
    const response = await put({ embedding: { ...preset, preset: { presetId: 'fixture' } } })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Embedding service unavailable' })
    expect(setMemoryConfig).not.toHaveBeenCalled()
  })

  it.each([
    { provider: 'openai', connection: { type: 'openrouter' }, message: 'no embeddings endpoint' },
    { provider: 'openai', connection: { type: 'vercel-gateway' }, message: 'no embeddings endpoint' },
    { provider: 'unsupported', connection: { type: 'direct' }, message: 'has no embeddings path' },
    { provider: 'ollama', connection: { type: 'direct' }, message: 'no base URL configured' },
    { provider: 'openai', connection: { type: 'direct' }, message: 'API key' }
  ])('keeps known probe setup refusal as 400: $provider/$message', async ({ provider, connection, message }) => {
    const saved = { provider, modelId: 'fixture', connection }
    vi.mocked(readOwnedModelPresetDependency).mockResolvedValue({ preset: saved } as Awaited<ReturnType<typeof readOwnedModelPresetDependency>>)
    // Exercise the real pure resolver used inside the probe, without keys/network.
    vi.mocked(detectPresetEmbeddingDims).mockImplementation(async base => {
      resolvePresetEmbeddingTarget({ presetId: base.presetId, snapshot: base, preset: saved, localAiServers: [], apiKeys: {} })
      return 3
    })
    const response = await put({ embedding: { ...preset, preset: { presetId: 'fixture' } } })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.stringContaining(message) })
    expect(setMemoryConfig).not.toHaveBeenCalled()
  })

  it('does not label a readback failure after a completed save as invalid input or replay the save', async () => {
    vi.mocked(getMemoryIndexMeta).mockRejectedValue(new Error('Index metadata unavailable'))
    const response = await put({ embedding: builtin })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Index metadata unavailable' })
    expect(setMemoryConfig).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful save response', async () => {
    const response = await put({ embedding: builtin })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ embedding: builtin, indexMeta: null })
    expect(setMemoryConfig).toHaveBeenCalledTimes(1)
  })
})
