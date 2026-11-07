import { readAutoCompactSnapshot } from '$lib/server/autoCompactGuard'
// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { setImmediate as nextTurn } from 'node:timers/promises'
vi.mock('$lib/server/redis', async () => vi.importActual('$lib/server/redis'))
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'
import { setMemoryConfig } from './memory/memoryIndex'
import { MEMORY_CONFIG_KEY } from './memory/memoryKeys'
import { createSubjectPopulation } from './subjectPopulation'
import { captureSettingsLifecycle, withSettingsRecordReplacement, withSettingsRestoreFence } from './appActions/settings/lifecycle'
import { DELETE } from '../../../routes/api/user/saved-models/+server'
import { PUT as saveMemoryRoute } from '../../../routes/api/memory/config/+server'
import * as referenceScan from './modelPresetReferences'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
  const url = new URL(resolvedUrl)
  const info = await adminClient.info('server')
  expect(info).toContain('redis_version:8.10.1')
  expect(info).toContain(`tcp_port:${url.port || '6379'}`)
  if (process.env.BATSHIT_BL1654_REDIS_PID) expect(info).toContain(`process_id:${process.env.BATSHIT_BL1654_REDIS_PID}`)
  if (process.env.BATSHIT_BL1654_REDIS_RUN_ID) expect(info).toContain(`run_id:${process.env.BATSHIT_BL1654_REDIS_RUN_ID}`)
  expect(JSON.stringify(await adminClient.moduleList())).toMatch(/ReJSON/)
  expect(JSON.stringify(await adminClient.moduleList())).toMatch(/search/)
  expect((await adminClient.clientInfo()).db).toBe(Number(url.pathname.slice(1)))
  expect(Number(url.pathname.slice(1))).toBeGreaterThan(0)
} })
afterEach(() => vi.restoreAllMocks())
const user = 'bl1654_owner'
let sequence = 0
const next = (label: string) => `bl1654_${label}_${++sequence}`
const models = `user:${user}:models`
const service = new ArtifactsService()
afterAll(async () => { if (REAL) { await redis.disconnect(); await (service as any).redis.disconnect() } })
const config = (presetId: string) => ({ mode: 'basic', primary: { source: 'preset', presetId } }) as any
const embedding = (presetId: string) => ({ lane: 'preset', modelId: 'preset:openai:fixture',
  preset: { presetId, provider: 'openai', modelName: 'fixture', dims: 3 } }) as any
/** Existing human whole-block caller now carries its original common group base. */
async function updateAgentWithOriginalCompactBase(id: string, updates: any) {
  const snapshot = updates.auto_compact_settings !== undefined ? await redis.execute(client => readAutoCompactSnapshot(client, id, user, undefined, false)) : undefined
  return redis.updateAgent(id, updates, snapshot ? { expectedAutoCompact: snapshot.revision } : undefined)
}
const compact = (presetId: string) => ({ modelMode: 'preset', modelPresetId: presetId, enabled: false })
const window = (presetId: string) => ({ summary_model_mode: 'preset', summary_model_preset_id: presetId })
async function preset(id = next('preset'), owner = user) {
  await redis.json.set(`model:${id}`, '$', { id, modelName: 'Fixture', modelId: 'fixture', provider: 'openai', settings: {}, purpose: 'utility',
    connection: { id: 'direct:openai', type: 'direct', service: 'openai' }, createdAt: '2026-10-17', updatedAt: '2026-10-17' })
  await redis.sAdd(`user:${owner}:models`, id)
  return id
}
const remove = (id: string, owner = user) => DELETE({ locals: { user: { id: owner } }, url: new URL(`http://localhost/api/user/saved-models?id=${id}`) } as any)
async function subject(id = next('agent'), extra: any = {}) {
  await redis.json.set(`agent:${id}`, '$', { id, user_id: user, agentType: 'api', displayName: 'Keep', created_at: '2026-10-17', untouched: { zero: 0, off: false }, ...extra })
  await redis.sAdd(`user:${user}:agents`, id)
  return id
}
async function artifact(presetId?: string) {
  return service.create(user, { name: next('artifact'), content: '<div>Fixture</div>', metadata: { enforce_batshit_artifact_structure: false },
    ...(presetId ? { model_config: config(presetId) } : {}) })
}
type Family = 'primary' | 'duplicate' | 'subagent' | 'compact' | 'window' | 'global' | 'settings-carry' | 'embedding' | 'artifact-create' | 'artifact-update' | 'artifact-carry'
async function writer(family: Family, presetId: string) {
  if (family === 'primary' || family === 'duplicate') {
    const id = next(family)
    const source = family === 'duplicate' ? await subject(next('original'), { primary_model_preset_id: presetId }) : null
    const record = source ? await redis.json.get(`agent:${source}`) as any : { user_id: user, agentType: 'api', displayName: 'New' }
    return { key: `agent:${id}`, run: () => redis.createAgent({ ...record, id, primary_model_preset_id: presetId }), marker: (script: string) => script.includes("if ARGV[5] ~= 'create'") }
  }
  if (family === 'subagent') {
    const id = next('subagent')
    return { key: `subagent:${id}`, run: () => withSettingsRecordReplacement(`subagent:${id}`, () => redis.execute(client => createSubjectPopulation(client,
      { kind: 'subagent', mode: 'create', userId: user, subjectId: id, record: { id, user_id: user, subagentType: 'api', primary_model_preset_id: presetId } }))),
    marker: (script: string) => script.includes("if ARGV[5] ~= 'create'") }
  }
  if (family === 'compact' || family === 'window') {
    const id = await subject()
    return { key: `agent:${id}`, run: () => updateAgentWithOriginalCompactBase(id, family === 'compact' ? { auto_compact_settings: compact(presetId) } : { memory_window: window(presetId) } as any),
      marker: (script: string) => script.includes('local guard = ARGV[5]') }
  }
  if (family === 'global' || family === 'settings-carry') {
    await redis.json.set(`user:${user}:settings`, '$', { id: 'settings', user_id: user, displayName: 'Keep', ui_settings: { retained: false },
      ...(family === 'settings-carry' ? { global_auto_compact_settings: compact(presetId) } : {}) })
    return { key: `user:${user}:settings`, run: () => family === 'global' ? redis.updateUserSettings(user, { global_auto_compact_settings: compact(presetId) }) : redis.saveUserSettings(user, { changed: true }),
      marker: (script: string) => script.includes('customGoonUploadsAvailable(ARGV[2])') }
  }
  if (family === 'embedding') return { key: MEMORY_CONFIG_KEY, run: () => setMemoryConfig(embedding(presetId), { userId: user }),
    marker: (script: string) => script.includes("'$.embedding', ARGV[2]") }
  if (family === 'artifact-create') return { key: '', run: () => artifact(presetId), marker: (script: string) => script.includes('presetReferencesAvailable(ARGV[2])') }
  const record = await artifact(family === 'artifact-carry' ? presetId : undefined)
  return { key: `artifact:${record.id}`, run: () => service.update(record.id, user, family === 'artifact-carry' ? { name: 'Renamed' } : { model_config: config(presetId) }),
    marker: (script: string) => script.includes('local access = cjson.decode(ARGV[4])') }
}
/** Reuse the actual client/owner; delay only the finite command under examination. */
async function intercept(marker: (script: string) => boolean, before?: (client: any) => Promise<void>, lose = false) {
  const client = await (redis as any).getClient()
  const artifactClient = await (service as any).redis.getClient()
  let count = 0
  const proxy = (client: any) => new Proxy(client, { get(target, property) {
    if (property === 'eval') return async (script: string, options: any) => {
      if (marker(script)) {
        count++
        if (count === 1) await before?.(client)
        const result = await client.eval(script, options)
        if (lose && count === 1) throw new Error('Fixture lost the actual issued answer')
        return result
      }
      return client.eval(script, options)
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const spy = vi.spyOn(redis as any, 'getClient').mockResolvedValue(proxy(client))
  const artifactSpy = vi.spyOn((service as any).redis, 'getClient').mockResolvedValue(proxy(artifactClient))
  return { count: () => count, restore: () => { spy.mockRestore(); artifactSpy.mockRestore() } }
}

describe.runIf(REAL)('BL-1654 real preset deletion versus actual reference population', () => {
  it.each<Family>(['primary', 'duplicate', 'subagent', 'compact', 'window', 'global', 'settings-carry', 'embedding', 'artifact-create', 'artifact-update', 'artifact-carry'])(
    '%s holds its reference mutation through physical persistence before DELETE scans', async family => {
      const id = await preset(); const owner = await writer(family, id)
      const scan = vi.spyOn(referenceScan, 'findModelPresetReferences')
      let deletion: Promise<Response> | undefined
      const held = await intercept(owner.marker, async () => {
        deletion = remove(id)
        await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${id}`])).toThrow())
        let settled = false; void deletion.then(() => { settled = true }); await nextTurn(); expect(settled).toBe(false)
        expect(scan).not.toHaveBeenCalled()
      })
      await owner.run(); held.restore()
      expect((await deletion!).status).toBe(409)
      expect(await redis.json.get(`model:${id}`)).not.toBeNull()
      expect(held.count()).toBe(1)
      expect(scan).toHaveBeenCalledTimes(1)
    })

  it.each<Family>(['primary', 'subagent', 'compact', 'window', 'global', 'embedding', 'artifact-create', 'artifact-update'])(
    '%s rechecks membership at final physical issue before any target write', async family => {
      const id = await preset(); const owner = await writer(family, id)
      const before = owner.key ? await redis.json.getRaw(owner.key, '$') : null
      const indexes = { agents: await redis.sMembers(`user:${user}:agents`), subagents: await redis.sMembers(`user:${user}:subagents`), artifacts: await redis.sMembers(`user:${user}:artifacts`) }
      const held = await intercept(owner.marker, async client => { await client.sRem(models, id) })
      await expect(owner.run()).rejects.toMatchObject({ status: 409, code: 'MODEL_PRESET_REFERENCE_CHANGED' }); held.restore()
      if (owner.key) expect(await redis.json.getRaw(owner.key, '$')).toBe(before)
      expect(await redis.sMembers(`user:${user}:agents`)).toEqual(indexes.agents)
      expect(await redis.sMembers(`user:${user}:subagents`)).toEqual(indexes.subagents)
      expect(await redis.sMembers(`user:${user}:artifacts`)).toEqual(indexes.artifacts)
    })

  it('refuses a newly activated missing/foreign source but preserves unchanged historical references and permits clear', async () => {
    const missing = next('missing'); const foreign = await preset(next('foreign'), 'bl1654_other')
    for (const id of [missing, foreign]) {
      const agent = await subject()
      await expect(updateAgentWithOriginalCompactBase(agent, { auto_compact_settings: compact(id) } as any)).rejects.toMatchObject({ status: 400 })
      await redis.json.set(`user:${user}:settings`, '$', { id: 'settings', user_id: user, displayName: 'Old', global_auto_compact_settings: compact(id), ui_settings: { zero: 0, off: false } })
      await redis.updateUserSettings(user, { displayName: 'New' })
      expect(await redis.getUserSettings(user)).toMatchObject({ global_auto_compact_settings: compact(id), ui_settings: { zero: 0, off: false } })
      const old = await artifact()
      await redis.json.set(`artifact:${old.id}`, '$.model_config', config(id))
      await service.update(old.id, user, { name: 'Keep broken choice' })
      expect((await redis.json.get(`artifact:${old.id}`) as any).model_config.primary.presetId).toBe(id)
      await service.update(old.id, user, { model_config: null, model: null })
      await redis.updateUserSettings(user, { global_auto_compact_settings: null })
      expect((await redis.getUserSettings(user))?.global_auto_compact_settings).toBeNull()
    }
    await redis.updateUserSettings(user, { global_auto_compact_settings: { modelMode: 'current', modelPresetId: missing } })
    await expect(redis.updateUserSettings(user, { global_auto_compact_settings: compact(missing) })).rejects.toMatchObject({ status: 400 })
  })

  it('an unrelated stale whole save cannot resurrect a reference cleared by another actual settings writer', async () => {
    const id = await preset(); const owner = await writer('settings-carry', id)
    const held = await intercept(owner.marker, async () => { await redis.updateUserSettings(user, { global_auto_compact_settings: null }) })
    await expect(owner.run()).rejects.toMatchObject({ status: 409 }); held.restore()
    expect((await redis.getUserSettings(user))?.global_auto_compact_settings).toBeNull()
  })

  it('requires owned membership for a transferred or newly activated role even when the same invalid ID was stored elsewhere', async () => {
    for (const id of [next('missing_role'), await preset(next('foreign_role'), 'bl1654_other')]) {
      const target = await subject(next('role_transfer'), { auto_compact_settings: compact(id) })
      const before = await redis.json.getRaw(`agent:${target}`, '$')
      await expect(updateAgentWithOriginalCompactBase(target, { auto_compact_settings: null, memory_window: window(id) } as any)).rejects.toMatchObject({ status: 400 })
      expect(await redis.json.getRaw(`agent:${target}`, '$')).toBe(before)
      await updateAgentWithOriginalCompactBase(target, { auto_compact_settings: null } as any)
      expect((await redis.json.get(`agent:${target}`) as any).auto_compact_settings).toBeNull()
    }
    const id = await preset(); const target = await subject(next('owned_role'), { auto_compact_settings: compact(id) })
    await updateAgentWithOriginalCompactBase(target, { auto_compact_settings: null, memory_window: window(id) } as any)
    expect((await redis.json.get(`agent:${target}`) as any).memory_window.summary_model_preset_id).toBe(id)
  })

  it.each(['missing', 'foreign'] as const)('Artifact final admission rejects a same-ID visual-to-primary transfer after source becomes %s', async state => {
    const id = await preset(); const saved = await artifact()
    await redis.json.set(`artifact:${saved.id}`, '$.model_config', { mode: 'advanced', primary: { source: 'auto' }, visual: { source: 'preset', presetId: id } })
    const before = await redis.json.getRaw(`artifact:${saved.id}`, '$')
    // The existing early Artifact check sees an owned preset. Its physical snapshot then
    // observes source loss; a prior reference in another role must not admit the new role.
    const original = (service as any).enforceKnownModelPresets.bind(service)
    const held = vi.spyOn(service as any, 'enforceKnownModelPresets').mockImplementationOnce(async (...args: any[]) => {
      await original(...args)
      const client = await (service as any).redis.getClient()
      await client.sRem(models, id)
      if (state === 'missing') await client.del(`model:${id}`)
      else await client.sAdd('user:bl1654_other:models', id)
    })
    await expect(service.update(saved.id, user, { model_config: config(id) })).rejects.toMatchObject({ status: 400, code: 'MODEL_PRESET_REFERENCE_INVALID' })
    held.mockRestore()
    expect(await redis.json.getRaw(`artifact:${saved.id}`, '$')).toBe(before)
  })

  it('preserves literal historical Artifact roles on omitted saves and refuses literal or active-leaf changes', async () => {
    const missing = next('literal_missing'); const saved = await artifact()
    const raw = `{"mode":"advanced","primary":{"source":"auto"},"vision":{"source":"preset","presetId":" ${missing} "},"audio":{"source":"preset","presetId":9007199254740993},"keep":{"zero":0,"off":false}}`
    await redis.execute(client => client.sendCommand(['JSON.SET', `artifact:${saved.id}`, '$.model_config', raw]))
    const before = await redis.json.getRaw(`artifact:${saved.id}`, '$.model_config')
    await service.update(saved.id, user, { name: 'Keep exact historical config' })
    expect(await redis.json.getRaw(`artifact:${saved.id}`, '$.model_config')).toBe(before)
    await service.update(saved.id, user, { model: null })
    expect(await redis.json.getRaw(`artifact:${saved.id}`, '$.model_config')).toBe(before)
    const target = await subject(next('literal_agent'), { auto_compact_settings: compact(` ${missing} `) })
    await expect(updateAgentWithOriginalCompactBase(target, { auto_compact_settings: compact(missing) } as any)).rejects.toMatchObject({ status: 400 })
    await updateAgentWithOriginalCompactBase(target, { auto_compact_settings: { enabled: true, modelMode: 'preset', modelPresetId: ` ${missing} ` } } as any)
    expect((await redis.json.get(`agent:${target}`) as any).auto_compact_settings.modelPresetId).toBe(` ${missing} `)
    const legacy = await subject(next('literal_window'), { memoryWindow: window(missing) })
    await expect(updateAgentWithOriginalCompactBase(legacy, { memory_window: window(missing) } as any)).rejects.toMatchObject({ status: 400 })
    await updateAgentWithOriginalCompactBase(legacy, { memoryWindow: null } as any)
    await service.update(saved.id, user, { model_config: null, model: null })
  })

  it.each(['compact', 'window'] as const)('%s refuses a pre-issue same-ID replacement and drains an issued write before actual createAgent', async family => {
    const id = await preset(); const owner = await writer(family, id)
    const target = owner.key.slice('agent:'.length)
    const replacement = { id: target, user_id: user, agentType: 'api' as const, displayName: 'Successor',
      auto_compact_settings: null, memory_window: null }
    const preIssue = await intercept(script => script.includes('BATSHIT_PRESET_REFERENCE_SNAPSHOT_V1'), async () => { await redis.createAgent(replacement as any) })
    await expect(owner.run()).rejects.toMatchObject({ status: 409, code: 'SETTINGS_LIFECYCLE_CHANGED' }); preIssue.restore()
    expect(await redis.json.get(owner.key)).toMatchObject({ displayName: 'Successor', auto_compact_settings: null, memory_window: null })
    const active = await writer(family, id); const activeTarget = active.key.slice('agent:'.length)
    let replacing: Promise<unknown> | undefined; let passed = false
    const issued = await intercept(active.marker, async () => {
      replacing = redis.createAgent({ ...replacement, id: activeTarget }).then(() => { passed = true })
      await vi.waitFor(() => expect(() => captureSettingsLifecycle([active.key])).toThrow())
      await nextTurn(); expect(passed).toBe(false)
    })
    await active.run(); issued.restore(); await replacing
    expect(passed).toBe(true)
    expect(await redis.json.get(active.key)).toMatchObject({ displayName: 'Successor', auto_compact_settings: null, memory_window: null })
    expect(issued.count()).toBe(1)
  })

  it('retains original no-preset Artifact create, update and read owners during an active restore', async () => {
    const saved = await artifact(); const withPreset = await artifact(await preset()); const target = await subject()
    const client = await (service as any).redis.getClient()
    await withSettingsRestoreFence(async () => {
      const created = await artifact(); expect(created.user_id).toBe(user)
      expect((await (service as any).readWriteSnapshot(client, saved.id)).record.id).toBe(saved.id)
      await service.update(saved.id, user, { name: 'No preset owner retained' })
      await service.update(withPreset.id, user, { model_config: null, model: null })
      await expect(service.update(saved.id, user, { agent_allowlist: [target] })).rejects.toMatchObject({ code: 'ARTIFACT_GRANT_STALE' })
      await expect(service.create(user, { name: next('restore_grant'), content: '<div/>', agent_allowlist: [target], metadata: { enforce_batshit_artifact_structure: false } })).rejects.toMatchObject({ code: 'ARTIFACT_GRANT_STALE' })
      await expect(service.update('missing_artifact', user, { name: 'Missing' })).rejects.toMatchObject({ status: 404 })
      await expect(service.update(saved.id, user, { model_config: config(await preset()) })).rejects.toMatchObject({ status: 409 })
    })
  })

  it('Artifact creation keeps the preset lease through index publication after a known record save', async () => {
    const id = await preset(); const client = await (service as any).redis.getClient()
    const scan = vi.spyOn(referenceScan, 'findModelPresetReferences')
    let deletion: Promise<Response> | undefined
    const proxy = new Proxy(client, { get(target, property) {
      if (property === 'sAdd') return async (key: string, value: any) => {
        if (key === `user:${user}:artifacts`) {
          expect(await client.json.get(`artifact:${value}`)).not.toBeNull()
          expect(await client.sIsMember(key, value)).toBe(0)
          deletion = remove(id)
          await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${id}`])).toThrow())
          expect(scan).not.toHaveBeenCalled()
        }
        return client.sAdd(key, value)
      }
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value
    } })
    const spy = vi.spyOn((service as any).redis, 'getClient').mockResolvedValue(proxy)
    const created = await artifact(id); spy.mockRestore()
    expect((await deletion!).status).toBe(409)
    expect(await redis.sismember(`user:${user}:artifacts`, created.id)).toBeTruthy()
  })

  it('an admitted replacement or restore cannot be adopted from a later source read', async () => {
    const id = await preset(); const owner = await writer('compact', id)
    const client = await (redis as any).getClient()
    let crossed = false
    const proxy = new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (!crossed && script.includes('BATSHIT_PRESET_REFERENCE_SNAPSHOT_V1')) {
          crossed = true
          await withSettingsRecordReplacement(`model:${id}`, async () => {})
        }
        return client.eval(script, options)
      }
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value
    } })
    const spy = vi.spyOn(redis as any, 'getClient').mockResolvedValue(proxy)
    await expect(owner.run()).rejects.toMatchObject({ status: 409 }); spy.mockRestore()
    const other = await preset(); const nextOwner = await writer('compact', other); crossed = false
    const restoreProxy = new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (!crossed && script.includes('BATSHIT_PRESET_REFERENCE_SNAPSHOT_V1')) { crossed = true; await withSettingsRestoreFence(async () => {}) }
        return client.eval(script, options)
      }
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value
    } })
    const restoreSpy = vi.spyOn(redis as any, 'getClient').mockResolvedValue(restoreProxy)
    await expect(nextOwner.run()).rejects.toMatchObject({ status: 409 }); restoreSpy.mockRestore()
  })

  it('fences the captured subject payload even if its caller record changes during the initial read', async () => {
    const original = await preset(); const substituted = await preset(); const target = next('captured')
    const key = `agent:${target}`
    const record = { id: target, user_id: user, primary_model_preset_id: original }
    const client = await (redis as any).getClient()
    let replacing: Promise<unknown> | undefined
    let passed = false
    let passedDuringWrite: boolean | undefined
    const proxy = new Proxy(client, { get(object, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (options.keys[0] === key && options.keys.length === 1) record.primary_model_preset_id = substituted
        if (options.keys[0] === key && script.includes("if ARGV[5] ~= 'create'")) {
          replacing = withSettingsRecordReplacement(`model:${original}`, async () => { passed = true })
          await nextTurn()
          passedDuringWrite = passed
        }
        return client.eval(script, options)
      }
      const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
    } })
    const spy = vi.spyOn(redis as any, 'getClient').mockResolvedValue(proxy)
    await withSettingsRecordReplacement(key, () => redis.execute(owner => createSubjectPopulation(owner,
      { userId: user, subjectId: target, kind: 'primary', mode: 'create', record })))
    spy.mockRestore(); await replacing
    expect(passedDuringWrite).toBe(false)
    expect(await redis.json.get(key)).toMatchObject({ primary_model_preset_id: original })
  })

  it.each(['agent', 'settings', 'memory', 'artifact'] as const)('%s binds the reference proof and persisted nested payload across caller mutation', async kind => {
    const original = await preset(); const substituted = await preset()
    let input: any
    let run: () => Promise<any>
    let readSaved: (result: any) => Promise<any>
    let mutate: () => void
    let marker: (script: string) => boolean
    if (kind === 'agent') {
      const target = await subject(); input = { auto_compact_settings: compact(original) }
      run = () => updateAgentWithOriginalCompactBase(target, input)
      readSaved = async () => (await redis.json.get(`agent:${target}`) as any).auto_compact_settings.modelPresetId
      mutate = () => { input.auto_compact_settings.modelPresetId = substituted }
      marker = script => script.includes('local guard = ARGV[5]')
    } else if (kind === 'settings') {
      input = { global_auto_compact_settings: compact(original) }
      run = () => redis.updateUserSettings(user, input)
      readSaved = async () => (await redis.getUserSettings(user) as any).global_auto_compact_settings.modelPresetId
      mutate = () => { input.global_auto_compact_settings.modelPresetId = substituted }
      marker = script => script.includes('customGoonUploadsAvailable(ARGV[2])')
    } else if (kind === 'memory') {
      input = embedding(original)
      run = () => setMemoryConfig(input, { userId: user })
      readSaved = async () => (await redis.json.get(MEMORY_CONFIG_KEY) as any).embedding.preset.presetId
      mutate = () => { input.preset.presetId = substituted }
      marker = script => script.includes("'$.embedding', ARGV[2]")
    } else {
      input = { name: next('nested'), content: '<div>Fixture</div>', model_config: config(original), metadata: { enforce_batshit_artifact_structure: false } }
      run = () => service.create(user, input)
      readSaved = async result => (await redis.json.get(`artifact:${result.id}`) as any).model_config.primary.presetId
      mutate = () => { input.model_config.primary.presetId = substituted }
      marker = script => script.includes('presetReferencesAvailable(ARGV[2])')
    }
    const clients = [await (redis as any).getClient(), await (service as any).redis.getClient()]
    let mutated = false; let replacementPassed = false; let passedDuringWrite: boolean | undefined; let replacing: Promise<unknown> | undefined
    const proxy = (client: any) => new Proxy(client, { get(object, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (!mutated && options.keys[0] === `model:${original}`) { mutated = true; mutate() }
        if (marker(script)) {
          replacing = withSettingsRecordReplacement(`model:${original}`, async () => { replacementPassed = true })
          await nextTurn(); passedDuringWrite = replacementPassed
        }
        return client.eval(script, options)
      }
      const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
    } })
    const spies = [vi.spyOn(redis as any, 'getClient').mockResolvedValue(proxy(clients[0])),
      vi.spyOn((service as any).redis, 'getClient').mockResolvedValue(proxy(clients[1]))]
    const result = await run()
    for (const spy of spies) spy.mockRestore()
    await replacing
    expect(mutated).toBe(true)
    expect(passedDuringWrite).toBe(false)
    expect(await readSaved(result)).toBe(original)
  })

  it('checks expiry and the legacy memoryWindow source while preserving unrelated sparse siblings', async () => {
    const id = await preset(); const agent = await subject(next('legacy'), { memory_window: { summary_model_mode: 'current' }, memoryWindow: window(id) })
    const held = await intercept(script => script.includes('local guard = ARGV[5]'), async client => {
      await client.json.set(`agent:${agent}`, '$.memoryWindow', window('changed'))
    })
    await expect(updateAgentWithOriginalCompactBase(agent, { memory_window: null } as any)).rejects.toMatchObject({ status: 409 }); held.restore()
    expect(await redis.json.get(`agent:${agent}`)).toMatchObject({ memory_window: { summary_model_mode: 'current' }, untouched: { zero: 0, off: false } })
    const expired = await preset(); const owner = await writer('compact', expired)
    const expiry = await intercept(owner.marker, async client => { await client.pExpire(`model:${expired}`, 1); await new Promise(resolve => setTimeout(resolve, 10)) })
    await expect(owner.run()).rejects.toMatchObject({ status: 409 }); expiry.restore()
    const valid = await preset(); const sibling = await writer('compact', valid)
    const unchanged = await intercept(sibling.marker, async client => { await client.json.set(sibling.key, '$.untouched', { zero: 0, off: false, later: true }) })
    await sibling.run(); unchanged.restore()
    expect(await redis.json.get(sibling.key)).toMatchObject({ untouched: { zero: 0, off: false, later: true } })
  })

  it('the authenticated Memory route carries its original preset through preparation and preserves config siblings', async () => {
    const id = await preset()
    await redis.json.set(MEMORY_CONFIG_KEY, '$', { embedding: { lane: 'builtin', modelId: 'builtin:embeddinggemma-300m' }, schema_version: 1, keep: { zero: 0, off: false } })
    const response = await saveMemoryRoute({ locals: { user: { id: user } }, request: new Request('http://localhost/api/memory/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ embedding: embedding(id) }) }) } as any)
    expect(response.status).toBe(200)
    expect(await redis.json.get(MEMORY_CONFIG_KEY)).toMatchObject({ keep: { zero: 0, off: false }, embedding: { preset: { presetId: id } } })
    const held = await intercept(script => script.includes("'$.embedding', ARGV[2]"), async client => { await client.json.set(`model:${id}`, '$.provider', 'changed') })
    const refused = await saveMemoryRoute({ locals: { user: { id: user } }, request: new Request('http://localhost/api/memory/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ embedding: embedding(id) }) }) } as any)
    held.restore(); expect(refused.status).toBe(409)
    expect((await redis.json.get(MEMORY_CONFIG_KEY) as any).embedding.preset.provider).toBe('openai')
  })

  it('retains actual answer-loss and record-saved/index-unknown custody without replay or foreign authority', async () => {
    for (const family of ['primary', 'compact', 'global', 'embedding', 'artifact-update'] as Family[]) {
      const id = await preset(); const owner = await writer(family, id)
      const lost = await intercept(owner.marker, undefined, true)
      await expect(owner.run()).rejects.toMatchObject({ status: 503 }); lost.restore(); expect(lost.count()).toBe(1)
      await expect(withSettingsRecordReplacement(`model:${id}`, async () => 'delete')).rejects.toThrow('unknown')
      if (family === 'compact') await expect(redis.createAgent({ id: owner.key.slice('agent:'.length), user_id: user, agentType: 'api', displayName: 'Must not replace' })).rejects.toThrow('unknown')
    }
    const id = await preset(); const client = await (service as any).redis.getClient(); let recordSaved = false
    const proxy = new Proxy(client, { get(target, property) {
      if (property === 'sAdd') return async (key: string, value: any) => {
        const result = await client.sAdd(key, value)
        if (key === `user:${user}:artifacts`) { recordSaved = (await client.json.get(`artifact:${value}`)) !== null; throw new Error('Lost index publication answer') }
        return result
      }
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value
    } })
    const spy = vi.spyOn((service as any).redis, 'getClient').mockResolvedValue(proxy)
    await expect(artifact(id)).rejects.toMatchObject({ status: 503, details: { record: 'saved', indexPublication: 'unknown' } }); spy.mockRestore()
    expect(recordSaved).toBe(true)
    await expect(withSettingsRecordReplacement(`model:${id}`, async () => 'delete')).rejects.toThrow('unknown')
    const foreign = await preset(next('foreign_unknown'), 'bl1654_other')
    await redis.json.set(`user:${user}:settings`, '$', { user_id: user, global_auto_compact_settings: compact(foreign) })
    const carry = await intercept(script => script.includes('customGoonUploadsAvailable(ARGV[2])'), undefined, true)
    await expect(redis.updateUserSettings(user, { displayName: 'Keep' })).rejects.toMatchObject({ status: 503 }); carry.restore()
    expect((await remove(foreign, 'bl1654_other')).status).toBe(200)
    await expect(withSettingsRestoreFence(async () => 'restore')).rejects.toThrow('unknown')
  })

  it('retains no-preset Artifact owners under global unknown authority without admitting new references', async () => {
    // A fresh module context is the existing isolation boundary for intentionally permanent
    // unknown custody. The original suite owners remain untouched; no reset API is invented.
    vi.resetModules()
    const lifecycle = await import('./appActions/settings/lifecycle')
    const { ArtifactsService: FreshArtifactsService } = await import('$lib/server/artifacts/artifactsService')
    const { redis: freshRedis } = await import('$lib/server/redis')
    const fresh = new FreshArtifactsService()
    try {
      const saved = await fresh.create(user, { name: next('unknown_no_preset'), content: '<div/>', metadata: { enforce_batshit_artifact_structure: false } })
      const id = await preset(); const target = await subject()
      await lifecycle.withSettingsRestoreFence(async () => { lifecycle.acquireSettingsRestoreMutation().unknown() })
      expect(lifecycle.settingsRestoreAuthorityUncertain()).toBe(true)
      const client = await (fresh as any).redis.getClient()
      expect((await (fresh as any).readWriteSnapshot(client, saved.id)).record.id).toBe(saved.id)
      await fresh.update(saved.id, user, { name: 'Original unrelated save allowed' })
      await fresh.create(user, { name: next('unknown_create'), content: '<div/>', metadata: { enforce_batshit_artifact_structure: false } })
      await expect(fresh.update(saved.id, user, { agent_allowlist: [target] })).rejects.toMatchObject({ code: 'ARTIFACT_GRANT_STALE' })
      await expect(fresh.update(saved.id, user, { model_config: config(id) })).rejects.toMatchObject({ status: 409, code: 'MODEL_PRESET_REFERENCE_CHANGED' })
    } finally { await (fresh as any).redis.disconnect(); await freshRedis.disconnect() }
  })
})
