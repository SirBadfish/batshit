// @vitest-environment node
import './presetStorageScriptDouble'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { acquireSettingsMutation, captureSettingsLifecycle, withSettingsRecordReplacement } from '$lib/server/services/appActions/settings/lifecycle'
vi.mock('$lib/server/services/providers', () => ({ ProviderManager: { createForUser: vi.fn() } }))
vi.mock('$lib/server/services/vercelModelCatalog', () => ({ fetchVercelModelCatalog: vi.fn(), findVercelCatalogEntry: vi.fn(), findVercelCatalogEntryById: vi.fn() }))
useRedisTestServer()
const { DELETE } = await import('./+server')
const user = 'owner-bl1648'
let sequence = 0; let id: string
const preset = () => ({ id, modelName: 'Owned preset', provider: 'openai', modelId: 'fixture', settings: {} })
const remove = () => DELETE({ locals: { user: { id: user } }, url: new URL(`http://localhost/api/user/saved-models?id=${id}`) } as any)
beforeEach(async () => { id = `preset_bl1648_${++sequence}`; await redis.set(`model:${id}`, preset()); await redis.sAdd(`user:${user}:models`, id) })
describe('BL1648 owned preset deletion and model-assignment replacement fence', () => {
  it('cannot delete another user preset even though its key exists', async () => {
    await redis.sRem(`user:${user}:models`, id)
    const response = await remove()
    expect(response.status).toBe(404)
    expect(await redis.get(`model:${id}`)).toEqual(preset())
  })
  it('refuses a raw-identical replacement during its original read', async () => {
    const original = vi.mocked(redis.get).getMockImplementation()!
    const read = vi.spyOn(redis, 'get').mockImplementationOnce(async key => {
      const answer = await original(key)
      await withSettingsRecordReplacement(`model:${id}`, async () => {})
      return answer
    })
    try { expect((await remove()).status).toBe(409) } finally { read.mockRestore() }
    expect(await redis.get(`model:${id}`)).toEqual(preset())
  })
  it('drains an admitted model assignment then sees its saved reference', async () => {
    const lease = acquireSettingsMutation(captureSettingsLifecycle([`model:${id}`]))
    const pending = remove()
    await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${id}`])).toThrow())
    await redis.createAgent({ id: 'new-reference', user_id: user, agentType: 'api', displayName: 'Writer', primary_model_preset_id: id } as any)
    lease.settle()
    expect((await pending).status).toBe(409)
    expect(await redis.get(`model:${id}`)).not.toBeNull()
  })
  it('never adopts a newer raw preset after waiting for an earlier assignment to settle', async () => {
    const lease = acquireSettingsMutation(captureSettingsLifecycle([`model:${id}`]))
    const pending = remove()
    await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${id}`])).toThrow())
    await redis.set(`model:${id}`, { ...preset(), modelName: 'Newer replacement' })
    lease.settle()
    const response = await pending
    expect(response.status).toBe(409)
    expect((await redis.get(`model:${id}`)).modelName).toBe('Newer replacement')
    await expect(withSettingsRecordReplacement(`model:${id}`, async () => 'settled')).resolves.toBe('settled')
  })
})
