// @vitest-environment node
/** Actual SDK and memory configuration route, synthetic HTTP/key only. */
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('ai'); vi.unmock('@ai-sdk/openai')
vi.mock('$lib/server/services/providers', () => ({ resolveProviderAccess: async () => ({ apiKeys: { openai: 'SYNTHETIC_PAID_KEY' } }) }))
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { memorySearchLaneActive, useMemorySearchTestServer } from '$lib/test-utils/memory-search-server'
import { createMemoryEmbedder, resolvePresetEmbeddingTarget } from '../memoryEmbedder'
import { PUT } from '../../../../../routes/api/memory/config/+server'
if (memorySearchLaneActive()) useMemorySearchTestServer()
else useRedisTestServer()
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const PRESET = 'plan-embedding-fixture', USER = 'plan-embedding-user'
const connection = { id: 'chatgpt-plan:00000000-0000-0000-0000-000000000001', type: 'direct', service: 'chatgpt-plan' }
const paid = { id: PRESET, provider: 'openai', modelId: 'text-embedding-fixture', purpose: 'embedding', connection: { id: 'direct:openai', type: 'direct', service: 'openai' } }
const plan = { ...paid, purpose: 'chat', connection }
const embedding = { lane: 'preset', modelId: 'preset:openai:text-embedding-fixture', preset: { presetId: PRESET, provider: 'openai', modelName: paid.modelId, dims: 2 } } as const

describe('ChatGPT plans cannot fund memory embeddings (BL-1057)', () => {
  it.each([{ ...connection }, { id: 'chatgpt-plan:malformed', type: 'direct' }, { service: 'chatgpt-plan', type: 'direct' }])('rejects the direct resolver for plan connection %j before choosing a paid key', candidate => {
    expect(() => resolvePresetEmbeddingTarget({ presetId: PRESET, snapshot: { provider: 'openai', modelName: paid.modelId }, preset: { ...plan, connection: candidate }, localAiServers: [], apiKeys: { openai: 'SYNTHETIC_PAID_KEY' } })).toThrow('cannot provide memory embeddings')
  })
  it.each([0, 2])('rejects new memory configuration even with caller-supplied dims=%s', async dims => {
    await redis.set(`model:${PRESET}`, plan)
    const http = vi.fn(); vi.stubGlobal('fetch', http)
    const response = await PUT({ locals: { user: { id: USER } }, request: new Request('http://fixture/api/memory/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embedding: { ...embedding, preset: { ...embedding.preset, dims } } }) }) } as any)
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: expect.stringContaining('cannot provide memory embeddings') })
    expect(http).not.toHaveBeenCalled(); expect(await redis.get('batshit:memory_config')).toBeNull()
  })
  it('rejects an already configured/restored plan preset before any request', async () => {
    await redis.set(`model:${PRESET}`, plan)
    const http = vi.fn(); vi.stubGlobal('fetch', http)
    await expect(createMemoryEmbedder(embedding, { userId: USER }).embedQuery('restored fixture')).rejects.toThrow('cannot provide memory embeddings')
    expect(http).not.toHaveBeenCalled()
  })
  it('rechecks a changed/restored preset before reusing a cached paid embedding client', async () => {
    await redis.set(`model:${PRESET}`, paid)
    const http = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer SYNTHETIC_PAID_KEY')
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.25, 0.5] }], usage: { prompt_tokens: 3, total_tokens: 3 } }), { headers: { 'Content-Type': 'application/json' } })
    }); vi.stubGlobal('fetch', http)
    const subject = createMemoryEmbedder(embedding, { userId: USER })
    expect(await subject.embedQuery('explicit paid fixture')).toEqual([0.25, 0.5]); expect(http).toHaveBeenCalledTimes(1)
    await redis.set(`model:${PRESET}`, plan)
    await expect(subject.embedQuery('changed preset fixture')).rejects.toThrow('cannot provide memory embeddings')
    await expect(subject.embedDocuments(['restored preset fixture'])).rejects.toThrow('cannot provide memory embeddings')
    expect(http).toHaveBeenCalledTimes(1)
  })
})
