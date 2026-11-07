import { originalModelSelectionCut } from './appActions/settings/modelSelectionAdapter'
import { managedSettingsStore } from './appActions/settings/managedStore'
import { captureModelPresetCopySource, prepareModelPresetCopy, modelPresetCopyPlan, createModelPresetCopy, readCreatedModelPresetSelection, finishModelPresetCopy } from './modelPresetSelectionOwner'
// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import type { SavedModel } from '$lib/types/savedModels'
import { apiKeyService } from '$lib/services/apiKey.server'
import { readOwnedModelPresetDependency, readOwnedModelPresetSelection, readModelPresetStorage, mutateModelPresetStorage, MUTATE_MODEL_PRESET_SCRIPT, readModelPresetSelectionChoices } from './modelPresetSelectionOwner'
import { acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle, withSettingsRecordReplacement, withSettingsRestoreFence } from './appActions/settings/lifecycle'
import { DELETE, GET } from '../../../routes/api/user/saved-models/+server'
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const strictAdmission = createSettingsRedisAdmission(redis)
useRedisTestServer({ beforeCleanupAdmission: strictAdmission.beforeCleanupAdmission })
afterAll(() => strictAdmission.close())
afterAll(async () => { if (REAL) await redis.disconnect() })
const user = 'preset-owner-real'
let sequence = 0
const nextId = () => `a3_preset_real_${++sequence}`
const model = (id: string, extra: Partial<SavedModel> = {}): SavedModel => ({ id, modelName: 'Fixture chat', modelId: 'fixture-model', provider: 'openai', effectiveModelId: 'fixture-model', purpose: 'chat', pricing: {}, settings: { temperature: 0, customFalse: false }, connection: { id: 'direct:openai', type: 'direct', service: 'openai' }, createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z', ...extra })
async function create(id: string, extra: Partial<SavedModel> = {}) { const preset = model(id, extra); expect(await withSettingsRecordReplacement(`model:${id}`, () => mutateModelPresetStorage(user, id, '', 'create', preset))).toBe('SAVED'); return preset }
const remove = (id: string) => DELETE({ locals: { user: { id: user } }, url: new URL(`http://localhost/api/user/saved-models?id=${id}`) } as any)
describe.runIf(REAL)('A3 actual Redis preset ownership, physical writes and replacement custody', () => {
  it('creates/indexes once, rejects duplicate creation, and deletes only an owned unchanged original', async () => { const id = nextId(); await create(id); const before = await readModelPresetStorage(user, id); expect(before.present).toBe(true); expect(before.raw).toBe(await redis.json.getRaw(`model:${id}`, '$'))
    expect(await withSettingsRecordReplacement(`model:${id}`, () => mutateModelPresetStorage(user, id, '', 'create', model(id)))).toBe('EXISTS')
    await redis.sRem(`user:${user}:models`, id); expect((await remove(id)).status).toBe(404); expect(await redis.get(`model:${id}`)).not.toBeNull()
    await redis.sAdd(`user:${user}:models`, id); expect((await remove(id)).status).toBe(200); expect(await redis.get(`model:${id}`)).toBeNull(); expect(await redis.sismember(`user:${user}:models`, id)).toBeFalsy() })
  it('retains actual stored key/preset preimages, safe choices and zero/false values without provider calls', async () => { const id = nextId(); await create(id); await apiKeyService.store('openai', 'fixture-only-api-key', user)
    const source = await readOwnedModelPresetSelection(user, id); expect(source.preset.settings).toEqual({ temperature: 0, customFalse: false }); expect(source.checks.find(check => check.key === apiKeyService.storedKeyName('openai', user))?.paths).toEqual([['$', await redis.json.getRaw(apiKeyService.storedKeyName('openai', user), '$')]])
    const choices = await readModelPresetSelectionChoices(user, { text: 'fixture', limit: 1 }); expect(choices).toMatchObject({ total: 1, matching: 1, nextOffset: null }); expect(JSON.stringify(choices)).not.toMatch(/fixture-only-api-key|encrypted|https?:|headers/) })
  it('an identical update invalidates its original lifecycle and raw text conflict preserves a newer replacement', async () => { const id = nextId(); const preset = await create(id); const source = await readOwnedModelPresetDependency(user, id); const original = await readModelPresetStorage(user, id)
    expect(await withSettingsRecordReplacement(`model:${id}`, () => mutateModelPresetStorage(user, id, original.raw, 'update', preset))).toBe('SAVED'); expect(() => assertSettingsLifecycle(source.lifecycle)).toThrow()
    await redis.json.set(`model:${id}`, '$.modelName', 'New replacement')
    expect(await withSettingsRecordReplacement(`model:${id}`, () => mutateModelPresetStorage(user, id, original.raw, 'delete'))).toBe('CONFLICT'); expect((await redis.get(`model:${id}`)).modelName).toBe('New replacement') })
  it('actual GET backfill replaces only its captured owned original and advances lifecycle', async () => { const id = nextId(); await create(id, { purpose: undefined, effectiveModelId: undefined }); await redis.set('vercel:model_catalog:v1', { models: [{ id: 'openai/fixture-model', provider: 'openai', name: 'fixture-model', displayName: 'Fixture', features: {}, tags: [], purpose: 'chat', source: 'vercel' }], fetchedAt: new Date().toISOString() })
    const source = await readOwnedModelPresetDependency(user, id); const response = await GET({ locals: { user: { id: user } } } as any); expect(response.status).toBe(200); expect((await redis.get(`model:${id}`)).purpose).toBe('chat'); expect(() => assertSettingsLifecycle(source.lifecycle)).toThrow() })
  it('a held assignment drains before reference scan and a new assignment cannot enter replacement', async () => { const id = nextId(); await create(id); const lease = acquireSettingsMutation(captureSettingsLifecycle([`model:${id}`])); const pending = remove(id)
    await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${id}`])).toThrow()); expect(() => acquireSettingsMutation({ epoch: '', records: [[`model:${id}`, '']] })).toThrow()
    await redis.json.set('agent:a3-held-reference', '$', { id: 'a3-held-reference', user_id: user, agentType: 'api', displayName: 'Writer', primary_model_preset_id: id }); await redis.sAdd(`user:${user}:agents`, 'a3-held-reference'); lease.settle()
    expect((await pending).status).toBe(409); expect(await redis.get(`model:${id}`)).not.toBeNull() })
  it('preflights a wrong index type before writing and does not delete a preset which lost owned membership at physical issue', async () => { const id = nextId(); const preset = model(id); await redis.set(`user:${user}:models`, 'wrong type')
    await expect(withSettingsRecordReplacement(`model:${id}`, () => mutateModelPresetStorage(user, id, '', 'create', preset))).rejects.toMatchObject({ uncertain: false }); expect(await redis.get(`model:${id}`)).toBeNull()
    await redis.del(`user:${user}:models`); await create(id); const original = await readModelPresetStorage(user, id); await redis.sRem(`user:${user}:models`, id)
    expect(await withSettingsRecordReplacement(`model:${id}`, () => mutateModelPresetStorage(user, id, original.raw, 'delete'))).toBe('MISSING'); expect(await redis.get(`model:${id}`)).not.toBeNull() })
  it('retains actual answer-loss custody after a real delete and refuses replay/restore', async () => { const id = nextId(); await create(id); const original = await readModelPresetStorage(user, id); const implementation = redis.execute.bind(redis)
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => implementation(client => operation(new Proxy(client, { get(target, property) { if (property === 'eval') return async (script: string, options: any) => { const answer = await target.eval(script, options); if (script === MUTATE_MODEL_PRESET_SCRIPT) throw new Error('Lost answer after actual issue'); return answer }; const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member } }))))
    try { await expect(withSettingsRecordReplacement(`model:${id}`, () => mutateModelPresetStorage(user, id, original.raw, 'delete'))).rejects.toMatchObject({ status: 503, uncertain: true }) } finally { spy.mockRestore() }
    expect(await redis.get(`model:${id}`)).toBeNull(); await expect(withSettingsRecordReplacement(`model:${id}`, async () => 'replay')).rejects.toThrow('unknown'); await expect(withSettingsRestoreFence(async () => 'restore')).rejects.toThrow('unknown') })
})


// SA-139 R5: an API preset copied onto an API Primary (it was a Claude Code CLI preset on a CLI
// Primary; a copy of one is now refused, and a CLI target's native cut and old-preset source went
// with that lane).
describe.runIf(REAL)('A12 actual conditional copy and publication handoff', () => {
  afterEach(() => vi.restoreAllMocks())
  async function planned() {
    const id = nextId()
    await apiKeyService.store('openai', 'fixture-only-api-key', user)
    await create(id, { settings: { temperature: 0.1, inherited: { zero: 0, off: false } } })
    const original = await redis.json.getRaw(`model:${id}`, '$')
    const plan = prepareModelPresetCopy(await captureModelPresetCopySource(user, id), { sourcePresetId: id, copyName: `A12 named ${id}`, parameters: [{ name: 'temperature', op: 'set', value: 0.4 }] })
    const authority = { key: `a12_copy_authority:${id}`, paths: [['$.generation', '[1]']] as Array<[string, string]> }
    await redis.json.set(authority.key, '$', { generation: 1 })
    const targetId = `a12_target_${id}`, targetPresetId = `a12_old_target_${id}`
    await create(targetPresetId, { settings: { temperature: 0.2 } })
    await redis.json.set(`agent:${targetId}`, '$', { id: targetId, user_id: user, agentType: 'api', created_at: '2026-10-18', primary_model_preset_id: targetPresetId,
      primary_model_provider: 'openai', primary_model_name: 'fixture-model', primary_model_connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
      claude_settings: { permissionMode: 'plan', model: 'original-target-alias', alwaysThinkingEnabled: false } })
    await redis.sAdd(`user:${user}:agents`, targetId)
    const target = await managedSettingsStore.readSelection(targetId, 'primary')
    const targets = [originalModelSelectionCut('agent', targetId, target)]
    return { id, original, plan, targetId, targetPresetId, copyId: modelPresetCopyPlan(plan).candidate.id, admission: { authority, targets, deadlineAt: Date.now() + 30000, check() {} } }
  }
  it('creates one owned named copy and supplies the genuine post-replacement source without changing original/private siblings', async () => {
    const f = await planned()
    try {
      await createModelPresetCopy(f.plan, f.admission)
      const source = await readCreatedModelPresetSelection(f.plan, 'api')
      expect(source.preset).toMatchObject({ id: f.copyId, settings: { temperature: 0.4, inherited: { zero: 0, off: false } } })
      expect(await redis.json.getRaw(`model:${f.id}`, '$')).toBe(f.original)
      expect(await redis.sismember(`user:${user}:models`, f.copyId)).toBeTruthy()
      expect(modelPresetCopyPlan(f.plan).outcome).toMatchObject({ creation: 'saved', source: 'confirmed' })
      await expect(createModelPresetCopy(f.plan, f.admission)).rejects.toThrow('replayed')
      await expect(readCreatedModelPresetSelection(structuredClone(f.plan), 'api')).rejects.toThrow('unavailable')
    } finally { finishModelPresetCopy(f.plan, 'blocked') }
  })
  // SA-139 R5: the created Claude Code CLI source's C2 planning went with the CLI selection stack.
  it('drains accepted destination custody before the strict active-reference population cut', async () => {
    const f = await planned(), pendingUse = acquireSettingsMutation(captureSettingsLifecycle([`model:${f.copyId}`]))
    const createFlight = createModelPresetCopy(f.plan, f.admission)
    try {
      await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${f.copyId}`])).toThrow())
      await redis.json.set('agent:a12_dangling', '$', { id: 'a12_dangling', user_id: user, agentType: 'api', primary_model_preset_id: f.copyId })
      await redis.sAdd(`user:${user}:agents`, 'a12_dangling')
      pendingUse.settle()
      await expect(createFlight).rejects.toMatchObject({ code: 'MODEL_PRESET_REFERENCE_CHANGED' })
      expect(await redis.get(`model:${f.copyId}`)).toBeNull()
      expect(modelPresetCopyPlan(f.plan).outcome.creation).toBe('not_requested')
    } finally { pendingUse.settle(); finishModelPresetCopy(f.plan, 'blocked') }
  })
  it.each(['missing', 'foreign', 'oversize'] as const)('a %s indexed reference row refuses creation instead of being filtered away', async invalid => {
    const f = await planned()
    await redis.sAdd(`user:${user}:agents`, 'a12_bad_population')
    if (invalid !== 'missing') await redis.json.set('agent:a12_bad_population', '$', { id: 'a12_bad_population', user_id: invalid === 'foreign' ? 'foreign-owner' : user, agentType: 'api', ...(invalid === 'oversize' ? { unknown: 'x'.repeat(131073) } : {}) })
    try {
      await expect(createModelPresetCopy(f.plan, f.admission)).rejects.toMatchObject({ code: 'MODEL_PRESET_REFERENCE_UNAVAILABLE' })
      expect(await redis.get(`model:${f.copyId}`)).toBeNull()
      expect(modelPresetCopyPlan(f.plan).outcome.creation).toBe('not_requested')
    } finally { finishModelPresetCopy(f.plan, 'blocked') }
  })
  it('an already-ended creation deadline cannot issue NX/index publication', async () => {
    const f = await planned(), originalExecute = redis.execute.bind(redis)
    let copyIssues = 0
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => originalExecute(client => operation(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script === MUTATE_MODEL_PRESET_SCRIPT) copyIssues++
        return target.eval(script, options)
      }
      const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
    } }))))
    try {
      await expect(createModelPresetCopy(f.plan, { ...f.admission, deadlineAt: Date.now() - 1 })).rejects.toMatchObject({
        name: 'ModelPresetStorageError', code: 'MODEL_PRESET_UNAVAILABLE', status: 500, uncertain: false,
        message: 'The model preset change was not issued.'
      })
      expect(copyIssues).toBe(0)
      expect(await redis.get(`model:${f.copyId}`)).toBeNull()
      expect(await redis.sismember(`user:${user}:models`, f.copyId)).toBeFalsy()
      expect(modelPresetCopyPlan(f.plan).outcome).toMatchObject({ creation: 'not_requested', assignment: 'blocked', reason: 'copy_not_created' })
    } finally { spy.mockRestore(); finishModelPresetCopy(f.plan, 'blocked') }
  })
  // SA-139 R5: an API target's cut has no CLI native block and no old-preset source (those races went with the CLI lane).
  it.each(['source', 'authority', 'population', 'target-provider-keys'] as const)('compares the final %s cut atomically before NX/index publication', async race => {
    const f = await planned(), originalExecute = redis.execute.bind(redis)
    let intercepted = false
    vi.spyOn(redis, 'execute').mockImplementation(operation => originalExecute(client => operation(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (!intercepted && script === MUTATE_MODEL_PRESET_SCRIPT && options.arguments[4]) {
          intercepted = true
          if (race === 'source') await target.json.set(`model:${f.id}`, '$.settings.temperature', 0.9)
          if (race === 'authority') await target.json.set(f.admission.authority.key, '$.generation', 2)
          if (race === 'target-provider-keys') await target.json.set(`agent:${f.targetId}`, '$.provider_specific_settings', { temperature: 0.25 })
          if (race === 'population') { await target.json.set('subagent:a12_new_reference', '$', { id: 'a12_new_reference', user_id: user, subagentType: 'api', primary_model_preset_id: f.copyId }); await target.sAdd(`user:${user}:subagents`, 'a12_new_reference') }
        }
        return target.eval(script, options)
      }
      const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
    } }))))
    try {
      await expect(createModelPresetCopy(f.plan, f.admission)).rejects.toThrow('Nothing was copied')
      expect(intercepted).toBe(true); expect(await redis.get(`model:${f.copyId}`)).toBeNull()
      expect(await redis.sismember(`user:${user}:models`, f.copyId)).toBeFalsy()
      expect(modelPresetCopyPlan(f.plan).outcome.creation).toBe('not_requested')
      for (const key of [`agent:${f.targetId}`, `model:${f.targetPresetId}`]) {
        const raw = await originalExecute(client => client.sendCommand(['JSON.GET', key])) as string
        expect(await withSettingsRecordReplacement(key, () => originalExecute(client => client.sendCommand(['JSON.SET', key, '$', raw])))).toBe('OK')
      }
    } finally { finishModelPresetCopy(f.plan, 'blocked') }
  })
  it('keeps the original cut immutable and allows unrelated name/native-control changes during destination drain without clobbering them', async () => {
    const f = await planned(), lease = acquireSettingsMutation(captureSettingsLifecycle([`model:${f.copyId}`]))
    expect(Object.isFrozen(f.admission.targets[0].guard.raw)).toBe(true)
    const running = createModelPresetCopy(f.plan, f.admission)
    void running.catch(() => {})
    try {
      await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${f.copyId}`])).toThrow())
      await redis.json.set(`agent:${f.targetId}`, '$.displayName', 'Human newer name')
      await redis.json.set(`agent:${f.targetId}`, '$.claude_settings.alwaysThinkingEnabled', true)
      lease.settle(); await running
      expect(modelPresetCopyPlan(f.plan).outcome.creation).toBe('saved')
      expect(await redis.get(`agent:${f.targetId}`)).toMatchObject({ displayName: 'Human newer name', primary_model_preset_id: f.targetPresetId,
        claude_settings: { model: 'original-target-alias', permissionMode: 'plan', alwaysThinkingEnabled: true } })
    } finally { lease.settle(); await running.catch(() => undefined); finishModelPresetCopy(f.plan, 'blocked') }
  }, 30000)
  it('does not adopt an identical replacement after known creation and retains the named orphan fact', async () => {
    const f = await planned()
    await createModelPresetCopy(f.plan, f.admission)
    const replacement = withSettingsRecordReplacement(`model:${f.copyId}`, async () => {})
    try {
      await expect(readCreatedModelPresetSelection(f.plan, 'api')).rejects.toThrow()
      expect(modelPresetCopyPlan(f.plan).outcome).toMatchObject({ creation: 'saved', source: 'unavailable' })
    } finally { finishModelPresetCopy(f.plan, 'blocked'); await replacement }
    await expect(readCreatedModelPresetSelection(f.plan, 'api')).rejects.toThrow('handoff')
  })
  // SA-139 R5: an API target's cut holds no old-preset source, so only the target itself is replaced here.
  it.each(['target'] as const)('refuses raw-identical %s replacement completed during destination drain before issuing a copy', async kind => {
    const f = await planned(), lease = acquireSettingsMutation(captureSettingsLifecycle([`model:${f.copyId}`]))
    const key = kind === 'target' ? `agent:${f.targetId}` : `model:${f.targetPresetId}`
    const raw = await redis.execute(client => client.sendCommand(['JSON.GET', key])) as string
    const running = createModelPresetCopy(f.plan, f.admission)
    void running.catch(() => {})
    try {
      await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${f.copyId}`])).toThrow())
      await withSettingsRecordReplacement(key, () => redis.execute(client => client.sendCommand(['JSON.SET', key, '$', raw])))
      expect(await redis.execute(client => client.sendCommand(['JSON.GET', key]))).toBe(raw)
      lease.settle()
      await expect(running).rejects.toMatchObject({ code: 'SETTINGS_LIFECYCLE_CHANGED' })
      expect(await redis.get(`model:${f.copyId}`)).toBeNull()
      expect(await redis.sismember(`user:${user}:models`, f.copyId)).toBeFalsy()
      expect(modelPresetCopyPlan(f.plan).outcome.creation).toBe('not_requested')
    } finally { lease.settle(); await running.catch(() => undefined); finishModelPresetCopy(f.plan, 'blocked') }
  })
  it.each(['target'] as const)('holds raw-identical %s replacement through actual known create issue, then retains the named copy on later target conflict', async kind => {
    const f = await planned(), originalExecute = redis.execute.bind(redis)
    const key = kind === 'target' ? `agent:${f.targetId}` : `model:${f.targetPresetId}`
    const raw = await originalExecute(client => client.sendCommand(['JSON.GET', key])) as string
    const originalLife = kind === 'target' ? f.admission.targets[0].lifecycle
      : f.admission.targets[0].sources.find(source => source.lifecycle.records.some(([record]) => record === key))!.lifecycle
    let release!: () => void, entered = false, replaced = false
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(redis, 'execute').mockImplementation(operation => originalExecute(client => operation(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script === MUTATE_MODEL_PRESET_SCRIPT && options.arguments[4]) { entered = true; await held }
        return target.eval(script, options)
      }
      const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
    } }))))
    const running = createModelPresetCopy(f.plan, f.admission)
    void running.catch(() => {})
    let replacement: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      replacement = withSettingsRecordReplacement(key, async () => {
        replaced = true
        return originalExecute(client => client.sendCommand(['JSON.SET', key, '$', raw]))
      })
      void replacement.catch(() => {})
      await vi.waitFor(() => expect(() => captureSettingsLifecycle([key])).toThrow())
      expect(replaced).toBe(false)
      release(); await running; await replacement
      expect(replaced).toBe(true)
      expect(await originalExecute(client => client.sendCommand(['JSON.GET', key]))).toBe(raw)
      expect(() => assertSettingsLifecycle(originalLife)).toThrow()
      finishModelPresetCopy(f.plan, 'blocked')
      expect(modelPresetCopyPlan(f.plan).outcome).toMatchObject({ presetId: f.copyId, name: `A12 named ${f.id}`, creation: 'saved', assignment: 'blocked' })
      expect(await redis.get(`model:${f.copyId}`)).not.toBeNull()
    } finally { release(); await running.catch(() => undefined); await replacement?.catch(() => undefined); finishModelPresetCopy(f.plan, 'blocked') }
  })
  it('lost actual creation answer retains unknown custody and refuses replay rather than rereading/adopting the existing row', async () => {
    const f = await planned(), originalExecute = redis.execute.bind(redis)
    let creates = 0, entered = false, release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    // SA-139 R5: the target alone (an API target's cut holds no old-preset source).
    const keys = [`agent:${f.targetId}`]
    const originals = await Promise.all(keys.map(key => originalExecute(client => client.sendCommand(['JSON.GET', key])) as Promise<string>))
    const replaced = new Set<string>(), replacements: Promise<unknown>[] = []
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => originalExecute(client => operation(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        const copy = script === MUTATE_MODEL_PRESET_SCRIPT && options.arguments[4]
        if (copy) { entered = true; await held }
        const result = await target.eval(script, options)
        if (copy) { creates += 1; throw new Error('Lost actual create answer') }
        return result
      }
      const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
    } }))))
    const running = createModelPresetCopy(f.plan, f.admission)
    void running.catch(() => {})
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      keys.forEach((key, index) => {
        const replacement = withSettingsRecordReplacement(key, async () => {
          replaced.add(key)
          return originalExecute(client => client.sendCommand(['JSON.SET', key, '$', originals[index]]))
        })
        void replacement.catch(() => {}); replacements.push(replacement)
      })
      await vi.waitFor(() => keys.forEach(key => expect(() => captureSettingsLifecycle([key])).toThrow()))
      expect(replaced.size).toBe(0)
      release()
      await expect(running).rejects.toMatchObject({ uncertain: true })
      for (const replacement of replacements) await expect(replacement).rejects.toThrow('unknown')
      expect(replaced.size).toBe(0)
    } finally { release(); await running.catch(() => undefined); await Promise.allSettled(replacements); spy.mockRestore() }
    expect(await redis.get(`model:${f.copyId}`)).not.toBeNull()
    expect(modelPresetCopyPlan(f.plan).outcome).toMatchObject({ creation: 'unknown', assignment: 'blocked' })
    await expect(readCreatedModelPresetSelection(f.plan, 'api')).rejects.toThrow('handoff')
    await expect(createModelPresetCopy(f.plan, f.admission)).rejects.toThrow('replayed')
    for (const key of [...keys, `model:${f.id}`, `model:${f.copyId}`]) {
      await expect(withSettingsRecordReplacement(key, async () => {})).rejects.toThrow('unknown')
    }
    for (const [index, key] of keys.entries()) expect(await originalExecute(client => client.sendCommand(['JSON.GET', key]))).toBe(originals[index])
    expect(creates).toBe(1)
  })
})
