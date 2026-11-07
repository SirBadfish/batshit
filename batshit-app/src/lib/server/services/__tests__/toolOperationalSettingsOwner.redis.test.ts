import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/redis', async () => vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis'))
import { redis } from '$lib/server/redis'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { readToolOperationsSnapshot, saveToolOperationalSettings } from '$lib/server/toolOperationalSettingsOwner'
import { withSettingsRecordReplacement } from '../appActions/settings/lifecycle'
const USER = 'global_tool_operations_test'
const key = `user:${USER}:settings`

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('finite global Web/AB settings original source: actual Redis', () => {
  const admission = useSkillSessionRedisTestServer()
  afterEach(async () => { vi.restoreAllMocks(); admission.requireAdmission(); await redis.del(key) })
  const read = () => redis.execute(client => readToolOperationsSnapshot(client, USER))
  async function seed(admin: Record<string, unknown> = {}) {
    admission.requireAdmission()
    await redis.json.set(key, '$', { id: 'settings_fixture', user_id: USER, created_at: 'birth', updated_at: 'stamp', displayName: 'Keep', admin_settings: admin })
    return read()
  }
  it('distinguishes positive absence from failed/malformed reads without creating a settings record', async () => {
    admission.requireAdmission()
    const absent = await read()
    expect(absent.exists).toBe(false); expect(absent.values.webSearchProvider).toBe('duckduckgo-html')
    expect(await redis.exists(key)).toBe(false)
    await redis.json.set(key, '$', null)
    await expect(read()).rejects.toMatchObject({ code: 'tool_operations_changed' })
    await redis.json.set(key, '$', { user_id: USER, admin_settings: [] })
    await expect(read()).rejects.toMatchObject({ code: 'tool_operations_changed' })
  })
  it('creates only on explicit save and returns a same-command resolved receipt', async () => {
    admission.requireAdmission(); const before = await read()
    const saved = await saveToolOperationalSettings(USER, before.revision, { webSearchProvider: 'exa', agentBrowser: { liveViewEnabled: false, provider: 'browserbase', timeoutMs: 9000 } })
    expect(saved.exists).toBe(true); expect(saved.revision).not.toBe(before.revision)
    expect(saved.values).toMatchObject({ webSearchProvider: 'exa', agentBrowser: { liveViewEnabled: false, provider: 'browserbase', timeoutMs: 9000 } })
    expect(await redis.json.get(key)).toMatchObject({ user_id: USER, admin_settings: { web_search_default_provider: 'exa', agent_browser: { liveViewEnabled: false, provider: 'browserbase', timeoutMs: 9000 } } })
  })
  it('writes finite leaves preserving unrelated root/Admin/Browser raw precision and real false', async () => {
    await seed()
    await redis.execute(client => client.sendCommand(['JSON.SET', key, '$.admin_settings', '{"unknown":9007199254740993,"agent_browser":{"unknown":9007199254740995,"liveViewEnabled":false,"provider":"local"}}']))
    const before = await read()
    await saveToolOperationalSettings(USER, before.revision, { webSearchExaSearchType: 'neural', agentBrowser: { timeoutMs: 6000, extraFlags: ['--one', '--two'] } })
    expect(await redis.json.getRaw(key, '$.admin_settings.unknown')).toBe('[9007199254740993]')
    expect(await redis.json.getRaw(key, '$.admin_settings.agent_browser.unknown')).toBe('[9007199254740995]')
    expect(await redis.json.get(key)).toMatchObject({ displayName: 'Keep', admin_settings: { agent_browser: { liveViewEnabled: false, provider: 'local', timeoutMs: 6000 } } })
  })
  it('resets only owned fields, removes matching Web aliases and preserves unknown Browser siblings', async () => {
    const before = await seed({ webSearchDefaultProvider: 'perplexity', web_search_default_provider: 'exa', agent_browser: { provider: 'kernel', unknown: 'keep' } })
    const result = await saveToolOperationalSettings(USER, before.revision, { webSearchProvider: null, agentBrowser: null })
    expect(result.values.webSearchProvider).toBe('duckduckgo-html'); expect(result.values.agentBrowser.provider).toBe('local')
    expect(await redis.json.get(key)).toMatchObject({ admin_settings: { agent_browser: { unknown: 'keep' } } })
    expect(await redis.json.getRaw(key, '$.admin_settings.webSearchDefaultProvider')).toBe('[]')
  })
  it('refuses stale original choices and same-id replacement before any save', async () => {
    const before = await seed({ web_search_default_provider: 'exa' })
    await redis.json.set(key, '$.admin_settings.web_search_default_provider', 'perplexity')
    await expect(saveToolOperationalSettings(USER, before.revision, { webSearchProvider: 'duckduckgo-html' })).rejects.toMatchObject({ code: 'tool_operations_changed' })
    const current = await read(); await withSettingsRecordReplacement(key, async () => {})
    await expect(saveToolOperationalSettings(USER, current.revision, { webSearchProvider: 'duckduckgo-html' })).rejects.toMatchObject({ code: 'tool_operations_changed' })
    expect(await redis.json.get(key)).toMatchObject({ updated_at: 'stamp', admin_settings: { web_search_default_provider: 'perplexity' } })
  })
  it('checks its original group again at physical issue and preserves a newer external preference', async () => {
    const before = await seed({ agent_browser: { provider: 'local' } }); const original = redis.execute.bind(redis); let changed = false
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => original(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes('-- batshit-global-tool-operations-write-v1')) { changed = true; await target.json.set(key, '$.admin_settings.agent_browser.provider', 'kernel') }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(saveToolOperationalSettings(USER, before.revision, { webSearchProvider: 'exa' })).rejects.toMatchObject({ code: 'tool_operations_changed' })
    expect(changed).toBe(true)
    expect(await redis.json.get(key)).toMatchObject({ updated_at: 'stamp', admin_settings: { agent_browser: { provider: 'kernel' } } })
    expect(await redis.json.getRaw(key, '$.admin_settings.web_search_default_provider')).toBe('[]')
  })
  it('rejects unknown grants, malformed enum shapes and invalid ranges before writing', async () => {
    const before = await seed()
    for (const change of [{ webSearchEnabled: true }, { webSearchProvider: ['exa'] }, { agentBrowser: { provider: ['kernel'] } }, { agentBrowser: { cdpPort: 0 } }]) {
      await expect(saveToolOperationalSettings(USER, before.revision, change)).rejects.toMatchObject({ status: 400 })
    }
    expect(await redis.json.get(key)).toMatchObject({ updated_at: 'stamp', admin_settings: {} })
  })
  it('uses the existing signed-in settings route with a fixed private snapshot and original-base patch', async () => {
    await seed({ agent_browser: { provider: 'local', unknown: 'not in DTO' } })
    const route = await import('../../../../routes/api/user/settings/+server')
    const event = { locals: { user: { id: USER } }, url: new URL('http://localhost/api/user/settings?toolOperations=1') }
    const response = await route.GET(event as any)
    expect(response.ok).toBe(true)
    const body = await response.json()
    expect(body.toolOperations.values.agentBrowser.provider).toBe('local')
    expect(body.toolOperations.values.agentBrowser).not.toHaveProperty('unknown')
    expect(body.toolOperations).not.toHaveProperty('raw')
    const request = () => new Request('http://localhost/api/user/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedToolOperations: body.toolOperations.revision, tool_operations_patch: { agentBrowser: { provider: 'kernel' } } }) })
    const saved = await route.POST({ ...event, request: request() } as any)
    expect(saved.ok).toBe(true)
    expect((await saved.json()).toolOperations.values.agentBrowser.provider).toBe('kernel')
    const stale = await route.POST({ ...event, request: request() } as any)
    expect(stale.status).toBe(409); expect((await stale.json()).code).toBe('tool_operations_changed')
  })
  it('keeps the new fixed route unavailable to unsigned callers and refuses mixed legacy intent', async () => {
    await seed(); const source = await read(); const route = await import('../../../../routes/api/user/settings/+server')
    expect((await route.GET({ locals: {}, url: new URL('http://localhost/api/user/settings?toolOperations=1') } as any)).status).toBe(401)
    const request = new Request('http://localhost/api/user/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedToolOperations: source.revision, tool_operations_patch: { webSearchProvider: 'exa' }, admin_settings: {} }) })
    const response = await route.POST({ locals: { user: { id: USER } }, request } as any)
    expect(response.status).toBe(400)
    expect(await redis.json.get(key)).toMatchObject({ updated_at: 'stamp', admin_settings: {} })
  })

  it.each(['absent', 'old'] as const)('refuses a correctly-sized but contradictory %s mandatory postimage', async mode => {
    const before = await seed({ web_search_default_provider: 'perplexity' }); const original = redis.execute.bind(redis)
    const issued = vi.fn()
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => original(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes('-- batshit-global-tool-operations-write-v1')) { issued(); return ['STORED', mode === 'absent' ? before.raw.map(() => '[]') : [...before.raw]] }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(saveToolOperationalSettings(USER, before.revision, { webSearchProvider: 'exa' })).rejects.toMatchObject({ code: 'tool_operations_save_unconfirmed', outcome: 'unknown' })
    expect(issued).toHaveBeenCalledOnce()
  })

  it.each(['OK', 'malformed', 'partial', 'throw'] as const)('holds %s issued uncertainty without inventing a saved receipt', async mode => {
    const before = await seed(); const original = redis.execute.bind(redis); const issued = vi.fn()
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => original(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes('-- batshit-global-tool-operations-write-v1')) {
          issued(); if (mode === 'throw') throw new Error('Reply lost')
          return mode === 'OK' ? 'STORED' : mode === 'partial' ? ['PARTIAL', 1] : ['STORED', []]
        }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(saveToolOperationalSettings(USER, before.revision, { webSearchProvider: 'exa' })).rejects.toMatchObject({ code: 'tool_operations_save_unconfirmed', outcome: mode === 'partial' ? 'partial' : 'unknown' })
    expect(issued).toHaveBeenCalledOnce()
  })
})
