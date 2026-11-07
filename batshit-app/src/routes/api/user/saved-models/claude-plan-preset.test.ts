import './presetStorageScriptDouble'
// @vitest-environment node
/** SA-139 P1 (D12, V1): Claude plan presets save only what Claude Code honors; reads never rewrite them. */
import { describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  fetchVercelModelCatalog: vi.fn(async () => ({ models: [{ id: 'anthropic/claude-opus-5-5', provider: 'anthropic', name: 'claude-opus-5-5', contextWindow: 1_000_000, pricing: { input: 5, output: 25 }, features: {}, tags: [], source: 'vercel' }], fetchedAt: 'fixture' })),
  findVercelCatalogEntry: vi.fn(), findVercelCatalogEntryById: vi.fn()
}))
// The display read never starts the real Claude Code in a unit test; its own tests are `claudePlanReadiness.test.ts`.
const display = vi.hoisted(() => ({ read: vi.fn(async () => ({ state: 'unavailable', code: 'runtime_unavailable', installed: true,
  reason: 'Claude plan replies are not available in this Batshit build yet. Choose another connection for this agent.' })) }))
vi.mock('$lib/server/services/claudePlanReadiness', () => ({ readClaudePlanDisplayStatus: display.read }))
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { GET, POST } from './+server'

useRedisTestServer()
const user = 'claude-plan-preset-user'
const connection = { id: 'claude-plan:local', type: 'direct', service: 'claude-plan' }
const post = (body: Record<string, unknown>) => POST({ locals: { user: { id: user } },
  request: new Request('http://test/api/user/saved-models', { method: 'POST', body: JSON.stringify(body) }) } as any)

describe('Claude plan presets', () => {
  it('saves the model and effort only, with no price, catalog identity or output budget', async () => {
    const answer = await post({ modelName: '', provider: 'anthropic', modelId: 'claude-opus-5-5', connection, purpose: 'chat',
      pricing: { input: 5, output: 25 }, catalogModelId: 'anthropic/claude-opus-5-5', contextWindow: 1_000_000,
      settings: { anthropicEffort: 'high', temperature: null }, capabilities: { vision: true } })
    expect(answer.status).toBe(200)
    const { model } = await answer.json()
    expect(model).toMatchObject({ modelName: 'Opus 5.5 (Claude Plan)', provider: 'anthropic', modelId: 'claude-opus-5-5', effectiveModelId: 'claude-opus-5-5',
      connection: { ...connection, useDeveloperPrefix: false }, purpose: 'chat', pricing: {}, contextWindow: 1_000_000,
      settings: { anthropicEffort: 'high', temperature: null }, capabilities: { vision: true, streaming: true, tools: true, audio: false, image: false } })
    expect(model.catalogModelId).toBeUndefined()
    expect(model.enrichment).toBeUndefined()
    expect(await redis.get(`model:${model.id}`)).toMatchObject({ connection: { id: 'claude-plan:local' }, settings: { anthropicEffort: 'high' } })
  })

  it('saves Thinking only where Claude Code can turn it off', async () => {
    const saved = await post({ modelName: 'Plan Opus 4.6', provider: 'anthropic', modelId: 'claude-opus-4-6', connection, pricing: {}, settings: { claudePlanThinking: false, anthropicEffort: 'low' } })
    expect(saved.status).toBe(200)
    expect((await saved.json()).model.settings).toEqual({ claudePlanThinking: false, anthropicEffort: 'low' })
    const refused = await post({ modelName: 'Plan Opus 5.5', provider: 'anthropic', modelId: 'claude-opus-5-5', connection, pricing: {}, settings: { claudePlanThinking: false } })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'setting_unsupported' })
  })

  it('keeps image input on, whatever the payload says, so attachments are never refused (Faye S1)', async () => {
    const { model } = await (await post({ modelName: 'Plan vision', provider: 'anthropic', modelId: 'opus', connection, pricing: {}, settings: {},
      capabilities: { vision: false, image: true } })).json()
    expect(model.capabilities).toMatchObject({ vision: true, image: false })
    const { modelAllowsImageInput } = await import('$lib/server/services/modelInputCapabilities')
    expect(modelAllowsImageInput(model.capabilities)).toBe(true)
  })

  it('saves CLI default as its own model id', async () => {
    const { model } = await (await post({ modelName: 'Plan default', provider: 'anthropic', modelId: 'default', connection, pricing: {}, settings: {} })).json()
    expect(model).toMatchObject({ modelName: 'Plan default', modelId: 'default', effectiveModelId: 'default' })
  })

  it('refuses unsupported settings, models and identities with a readable 409 and writes nothing', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ settings: { temperature: 0.4 } }, 'setting_unsupported'],
      [{ settings: { maxTokens: 0 } }, 'setting_unsupported'],
      [{ settings: { anthropicEffort: 'ultra' } }, 'setting_unsupported'],
      [{ settings: { nativeTools: { workMode: 'plan' } } }, 'setting_unsupported'],
      [{ modelId: 'claude-3-opus' }, 'model_unavailable'],
      [{ purpose: 'utility' }, 'consumer_unsupported'],
      [{ connection: { type: 'direct', service: 'claude-plan' } }, 'connection_invalid'],
      [{ connection: { type: 'direct', id: 'claude-plan:local', service: 'anthropic' } }, 'connection_invalid'],
      [{ connection: { type: 'direct', id: 'direct:claude-plan' } }, 'connection_invalid']
    ]
    for (const [overrides, code] of cases) {
      const answer = await post({ modelName: 'Refused', provider: 'anthropic', modelId: 'opus', connection, pricing: {}, settings: {}, ...overrides })
      expect(answer.status).toBe(409)
      expect(await answer.json()).toMatchObject({ code })
    }
    expect(await redis.sMembers(`user:${user}:models`)).toEqual([])
  })

  it('a read reports why it cannot run now and never rewrites the stored preset, restored or not', async () => {
    const restored = { id: 'restored-plan', modelName: 'Restored', provider: 'anthropic', modelId: 'opus', connection, pricing: {},
      settings: { anthropicEffort: 'max', temperature: 0.7 }, catalogModelId: 'stale/catalog-row' }
    await redis.set(`model:${restored.id}`, restored)
    await redis.sAdd(`user:${user}:models`, restored.id)
    const write = vi.spyOn(redis.json, 'setIfExists')
    const answer = await GET({ locals: { user: { id: user } } } as any)
    expect(answer.status).toBe(200)
    const [model] = (await answer.json()).models
    expect(model).toMatchObject({ ...restored, reasoningEvidence: { status: 'unknown' } })
    expect(model.unavailableReason).toMatch(/not available in this Batshit build yet/)
    expect(display.read).toHaveBeenCalledTimes(1)
    expect(await redis.get(`model:${restored.id}`)).toEqual(restored)
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
  })
})
