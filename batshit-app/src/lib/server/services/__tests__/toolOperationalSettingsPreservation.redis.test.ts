import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/redis', async () => vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis'))
import { redis } from '$lib/server/redis'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
const USER = 'global_tool_preservation_test'
const key = `user:${USER}:settings`

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('legacy whole settings source/preservation: actual final writer', () => {
  const admission = useSkillSessionRedisTestServer()
  afterEach(async () => { vi.restoreAllMocks(); admission.requireAdmission(); await redis.del(key) })
  async function seed() {
    admission.requireAdmission()
    await redis.execute(client => client.sendCommand(['JSON.SET', key, '$',
      `{"id":"settings_fixture","user_id":"${USER}","created_at":"birth","updated_at":"stamp","displayName":"Keep","admin_settings":{"web_search_default_provider":"exa","unknown":9007199254740993,"agent_browser":{"provider":"kernel","liveViewEnabled":false,"unknown":9007199254740995}},"goons_settings":{"ordinaryLibrary":{"version":"old"},"globalCloset":{"items":{"unknown":9007199254740997}}},"voice_settings":{"privateSibling":"keep"}}`]))
  }
  it('preserves complete unmentioned Admin and unmentioned Closet RAW while returning matching saved globals', async () => {
    await seed()
    const admin = await redis.json.getRaw(key, '$.admin_settings'), closet = await redis.json.getRaw(key, '$.goons_settings.globalCloset')
    const result = await redis.updateUserSettings(USER, { displayName: 'New' })
    expect(await redis.json.getRaw(key, '$.admin_settings')).toBe(admin)
    expect(await redis.json.getRaw(key, '$.goons_settings.globalCloset')).toBe(closet)
    expect(result).toMatchObject({ displayName: 'New', admin_settings: { web_search_default_provider: 'exa', agent_browser: { provider: 'kernel', liveViewEnabled: false } } })
  })
  it('lets a legacy nonoperational Admin update retain current RAW globals omitted by its mounted form', async () => {
    await seed()
    const browser = await redis.json.getRaw(key, '$.admin_settings.agent_browser')
    const closet = await redis.json.getRaw(key, '$.goons_settings.globalCloset')
    const result = await redis.updateUserSettings(USER, { admin_settings: { dcm_schema_hint_required_limit: 4 } })
    expect(await redis.json.getRaw(key, '$.admin_settings.agent_browser')).toBe(browser)
    expect(await redis.json.getRaw(key, '$.goons_settings.globalCloset')).toBe(closet)
    expect(result.admin_settings).toMatchObject({ dcm_schema_hint_required_limit: 4, web_search_default_provider: 'exa', agent_browser: { provider: 'kernel', liveViewEnabled: false } })
  })
  it('rejects old operational/grant payloads and never drops an unconverted inheritance source', async () => {
    await seed(); const before = await redis.json.getRaw(key, '$')
    for (const updates of [{ admin_settings: { web_search_default_provider: 'perplexity' } }, { admin_settings: { agent_browser: {} } }, { global_tool_grid_settings: { typed_file_tools: false } }]) {
      await expect(redis.updateUserSettings(USER, updates as any)).rejects.toMatchObject({ status: 400 })
      expect(await redis.json.getRaw(key, '$')).toBe(before)
    }
    await redis.json.set(key, '$.global_tool_grid_settings', { typed_file_tools: true })
    const unconverted = await redis.json.getRaw(key, '$')
    await expect(redis.updateUserSettings(USER, { displayName: 'Not saved' })).rejects.toMatchObject({ status: 400 })
    expect(await redis.json.getRaw(key, '$')).toBe(unconverted)
  })
  it('refuses a concurrent non-tool library change at full-root CAS instead of restoring old data', async () => {
    await seed(); const original = redis.execute.bind(redis); let raced = false
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => original(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes('TOOL_OPERATIONS_CHANGED') && script.includes("return 'STORED'")) {
          raced = true; await target.json.set(key, '$.goons_settings.ordinaryLibrary.version', 'new')
        }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(redis.updateUserSettings(USER, { displayName: 'Stale' })).rejects.toMatchObject({ code: 'user_settings_changed' })
    expect(raced).toBe(true)
    expect(await redis.json.get(key)).toMatchObject({ displayName: 'Keep', updated_at: 'stamp', goons_settings: { ordinaryLibrary: { version: 'new' } } })
  })
  it('keeps unrelated Admin capture out of preset dependency failure provenance', async () => {
    await seed(); const original = redis.execute.bind(redis); let raced = false
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => original(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes('TOOL_OPERATIONS_CHANGED') && script.includes("return 'STORED'")) { raced = true; await target.json.set(key, '$.admin_settings.unrelated', 'new') }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(redis.updateUserSettings(USER, { admin_settings: { dcm_schema_hint_required_limit: 3 } })).rejects.toMatchObject({ code: 'user_settings_changed' })
    expect(raced).toBe(true)
    expect(await redis.json.get(key)).toMatchObject({ updated_at: 'stamp', admin_settings: { unrelated: 'new' } })
  })

  it('refuses a concurrent public Closet edit before final full-root CAS', async () => {
    await seed(); const original = redis.execute.bind(redis)
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => original(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes('TOOL_OPERATIONS_CHANGED') && script.includes("return 'STORED'")) await target.json.set(key, '$.goons_settings.globalCloset', { items: {}, newer: true })
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(redis.updateUserSettings(USER, { displayName: 'Stale' })).rejects.toMatchObject({ code: 'user_settings_changed' })
    expect(await redis.json.get(key)).toMatchObject({ displayName: 'Keep', updated_at: 'stamp', goons_settings: { globalCloset: { newer: true } } })
  })

  it('admits an intentional public Closet edit only through the actual named patch', async () => {
    await seed()
    const admin = await redis.json.getRaw(key, '$.admin_settings')
    await redis.updateUserSettings(USER, { goons_settings_patch: { globalCloset: { items: {}, edited: true } } })
    expect(await redis.json.getRaw(key, '$.admin_settings')).toBe(admin)
    expect(await redis.json.get(key)).toMatchObject({ goons_settings: { globalCloset: { items: {}, edited: true } } })
  })

  it('refuses an old whole-form Closet copy on an unrelated save before any overwrite', async () => {
    await seed()
    const old = await redis.getUserSettings(USER)
    await redis.json.set(key, '$.goons_settings.globalCloset', { items: {}, newer: true })
    const before = await redis.json.getRaw(key, '$')
    await expect(redis.updateUserSettings(USER, { displayName: 'Stale', goons_settings: old.goons_settings })).rejects.toMatchObject({ code: 'user_settings_changed' })
    expect(await redis.json.getRaw(key, '$')).toBe(before)
  })

  it('forwards only named API intent, preserving a library update after the route early read', async () => {
    await seed(); const method = redis.getUserSettings; let initial = false
    const { RedisService } = await import('$lib/server/redis')
    vi.spyOn(RedisService.prototype, 'getUserSettings').mockImplementation(async function (userId: string) {
      const row = await method.call(this, userId)
      if (!initial) { initial = true; await redis.json.set(key, '$.goons_settings.ordinaryLibrary.version', 'new') }
      return row
    })
    const { POST } = await import('../../../../routes/api/user/settings/+server')
    const response = await POST({ locals: { user: { id: USER } }, request: new Request('http://localhost/api/user/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'New', admin_settings: { dcm_schema_hint_required_limit: 3 } }) }) } as any)
    expect(response.ok).toBe(true)
    expect(await redis.json.get(key)).toMatchObject({ displayName: 'New', goons_settings: { ordinaryLibrary: { version: 'new' } }, admin_settings: { dcm_schema_hint_required_limit: 3, agent_browser: { provider: 'kernel' } } })
  })
  it('merges an existing Voice patch at the lower current source rather than its old route copy', async () => {
    await seed(); const method = redis.getUserSettings; let initial = false
    const { RedisService } = await import('$lib/server/redis')
    vi.spyOn(RedisService.prototype, 'getUserSettings').mockImplementation(async function (userId: string) {
      const row = await method.call(this, userId)
      if (!initial) { initial = true; await redis.json.set(key, '$.voice_settings.privateSibling', 'new') }
      return row
    })
    const { POST } = await import('../../../../routes/api/user/settings/+server')
    const response = await POST({ locals: { user: { id: USER } }, request: new Request('http://localhost/api/user/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice_settings_patch: { goonLipSync: { visemeBlendMs: 60 } } }) }) } as any)
    expect(response.ok).toBe(true)
    expect(await redis.json.get(key)).toMatchObject({ voice_settings: { privateSibling: 'new', goonLipSync: { visemeBlendMs: 60 } } })
  })
  it('creates a new settings record only on a deliberate ordinary write', async () => {
    admission.requireAdmission()
    const result = await redis.updateUserSettings(USER, { displayName: 'First' })
    expect(result).toMatchObject({ user_id: USER, displayName: 'First' })
    expect(await redis.json.get(key)).toMatchObject({ user_id: USER, displayName: 'First' })
  })
})
