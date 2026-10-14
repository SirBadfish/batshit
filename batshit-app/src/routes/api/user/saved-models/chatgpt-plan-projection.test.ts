// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const host = vi.hoisted(() => ({ ready: true, accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }))
vi.mock('$lib/server/services/chatgptPlanHost', () => ({
  chatgptPlanAccounts: () => host.ready ? [{ id: host.accountId, state: 'ready' }] : [],
  getChatgptPlanRuntime: vi.fn()
}))
vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  fetchVercelModelCatalog: vi.fn(async () => ({ models: [{ id: 'openai/gpt-6-astra', provider: 'openai', name: 'gpt-6-astra', contextWindow: 999, maxOutputTokens: 999, pricing: { input: 99 }, features: {}, tags: [], source: 'vercel' }], fetchedAt: 'fixture' })),
  findVercelCatalogEntry: vi.fn(), findVercelCatalogEntryById: vi.fn()
}))
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { GET } from './+server'
import { loadRuntimeModelPreset } from '$lib/server/services/runtimeModelPreset'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { modelAllowsImageInput } from '$lib/server/services/modelInputCapabilities'
useRedisTestServer()
const user = 'plan-projection-user'
beforeEach(() => { host.ready = true })
it.each([false, undefined])('uses one known-slug capability rule in GET and runtime without changing Redis; vision=%s', async vision => {
  const existing = { id: 'plan-projection', modelName: 'My plan', provider: 'openai', modelId: 'gpt-6-astra', effectiveModelId: 'gpt-6-astra', connection: { id: `chatgpt-plan:${host.accountId}`, type: 'direct', service: 'chatgpt-plan' }, pricing: {}, settings: { textVerbosity: 'low' }, capabilities: vision === false ? { vision: false } : {}, contextWindow: 23456 }
  await redis.set(`model:${existing.id}`, existing)
  await redis.sAdd(`user:${user}:models`, existing.id)
  const write = vi.spyOn(redis.json, 'setIfExists')
  const answer = await GET({ locals: { user: { id: user } } } as any)
  expect(answer.status).toBe(200)
  const model = (await answer.json()).models[0]
  expect(model).toMatchObject({ ...existing, capabilities: { vision: vision === false ? false : true, image: false }, publishedMetadata: { modelId: existing.modelId, verifiedAt: '2026-10-01', contextWindow: 1_050_000 } })
  const runtime = resolveRuntimeModelSelection({ preset: await loadRuntimeModelPreset(existing.id, 'primary') })
  expect(runtime.capabilities).toEqual(model.capabilities)
  expect(modelAllowsImageInput(runtime.capabilities)).toBe(vision !== false)
  expect(model.unavailableReason).toBeUndefined()
  expect(await redis.get(`model:${existing.id}`)).toEqual(existing)
  expect(write).not.toHaveBeenCalled()
  host.ready = false
  const disconnected = (await (await GET({ locals: { user: { id: user } } } as any)).json()).models[0]
  expect(disconnected.unavailableReason).toMatch(/Reconnect/)
  expect(disconnected.contextWindow).toBe(23456)
  expect(await redis.get(`model:${existing.id}`)).toEqual(existing)
  write.mockRestore()
})
