import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import { readModelSelectionSnapshot, ModelSelectionSaveUnconfirmedError, READ_MODEL_SELECTION_SCRIPT, modelSelectionTypePaths,
  prepareModelSelectionClear, assertModelSelectionClear } from './modelSelectionGuard'
import { readModelSelectionSnapshotTwin, agentTypeSnapshotOf } from '$lib/test-utils/agentUpdateScriptTwin'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { readOwnedModelPresetDependency } from './services/modelPresetSelectionOwner'
import { withSettingsRecordReplacement, withSettingsRestoreFence } from './services/appActions/settings/lifecycle'
import { buildPickedPresetSelection } from '$lib/utils/modelPresetPick'
import { buildAgentProviderSettingsPatch } from '$lib/utils/agentProviderSettings'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { planModelSelectionCandidate } from './services/appActions/settings/modelSelectionAdapter'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const actual = await vi.importActual<typeof import('./redis')>('./redis')
const { redis } = actual
const strictAdmission = createSettingsRedisAdmission(redis)
useRedisTestServer({ beforeCleanupAdmission: strictAdmission.beforeCleanupAdmission })
afterAll(() => strictAdmission.close())
afterAll(async () => { if (REAL) await redis.disconnect() })
const user = 'a3_guard_owner'
const targetId = 'a3_guard_target'
const sourceId = 'a3_guard_source'
const targetKey = `agent:${targetId}`
const preset = { id: sourceId, modelName: 'Owned API', modelId: 'claude-sonnet-4-6', provider: 'anthropic',
  connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' }, purpose: 'chat', settings: { temperature: 0, custom: false },
  pricing: {}, createdAt: '2026-10-17', updatedAt: '2026-10-17' } as any
async function basis(kind: 'agent' | 'subagent' = 'agent') { return redis.execute(client => readModelSelectionSnapshot(client, targetId, kind)) }
async function write(overrides: Record<string, unknown> = {}, expected?: string, mutation?: any) {
  const row = await redis.json.get(targetKey) as Record<string, unknown>
  const picked = buildPickedPresetSelection(preset)
  return redis.updateAgent(targetId, { ...picked, provider_specific_settings: buildAgentProviderSettingsPatch(row.provider_specific_settings, picked.provider_specific_settings), ...overrides },
    { expectedModelSelection: expected ?? (await basis()).revision, ...(mutation ? { modelSelectionMutation: mutation } : {}) })
}
function interceptIssue(callback: (client: any) => Promise<void>, lose = false) {
  const execute = redis.execute.bind(redis)
  let issued = 0
  const spy = vi.spyOn(redis, 'execute').mockImplementation(async (operation: any) => execute(async client => operation(new Proxy(client, {
    get(object, key) {
      if (key === 'eval') return async (script: string, options: any) => {
        if ((script.includes("local guard = ARGV[5]") || script.includes('local modelSelection = cjson.decode(ARGV[3])')) && script.includes('MODEL_SELECTION_CHANGED')) {
          issued++; await callback(client)
          const answer = await client.eval(script, options)
          if (lose) throw new Error('actual answer deliberately lost after issue')
          return answer
        }
        return client.eval(script, options)
      }
      const value = Reflect.get(object, key, object)
      return typeof value === 'function' ? value.bind(object) : value
    }
  }))))
  return { restore: () => spy.mockRestore(), issued: () => issued }
}

describe('fixed native-only model evidence without a native or Redis process', () => {
  it.each(['absent', 'null', 'empty'] as const)('keeps a genuine already-clear %s legacy/inferred Primary plan empty', async state => {
    // SA-139 R4/R5: a legacy record that infers the retired `cli` type holds no selection to clear (delete only).
    for (const [typeFields, type] of [[{ agent_type: 'api' }, 'api'], [{ mode: 'vercel-native' }, 'api'], [{}, 'api']] as const) {
      const row = { id: targetId, user_id: user, created_at: 'original', ...typeFields,
        ...(state === 'absent' ? {} : { primary_model_preset_id: state === 'null' ? null : '', primary_model_provider: state === 'null' ? null : '',
          primary_model_name: state === 'null' ? null : '', primary_model_connection: null }),
        primary_model_temperature: null, provider_specific_settings: null, voice_profile: null }
      const client = { eval: vi.fn(async () => { const cut = readModelSelectionSnapshotTwin(targetId, 'agent', row)
        return ['OK', JSON.stringify([row]), JSON.stringify(cut.paths), JSON.stringify(cut.providerKeys ?? []), ...cut.raw] }) }
      const original = await readModelSelectionSnapshot(client, targetId, 'agent'), before = structuredClone(original.record)
      const plan = prepareModelSelectionClear(original, 'agent')
      expect(plan.updates).toEqual({})
      expect(() => assertModelSelectionClear(plan.clear, original, plan.updates, 'agent')).not.toThrow()
      expect(original.record).toEqual(before)
      expect(normalizePrimaryAgentType(original.record)).toBe(type)
    }
  })
  it('refuses to plan a clear for a legacy record that infers the retired cli type (SA-139 R4/R5: delete only)', async () => {
    const row = { id: targetId, user_id: user, primary_model_preset_id: 'old', primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli',
      primary_model_connection: { id: 'codex-cli', type: 'direct', service: 'openai-codex' } }
    const client = { eval: vi.fn(async () => { const cut = readModelSelectionSnapshotTwin(targetId, 'agent', row)
      return ['OK', JSON.stringify([row]), JSON.stringify(cut.paths), JSON.stringify(cut.providerKeys ?? []), ...cut.raw] }) }
    const original = await readModelSelectionSnapshot(client, targetId, 'agent')
    expect(normalizePrimaryAgentType(original.record)).toBe('cli')
    expect(() => prepareModelSelectionClear(original, 'agent')).toThrow('The saved model selection changed')
  })
  it.each(['agent', 'subagent'] as const)('requires the genuine original %s read/clear plan and refuses clone, changed intent and newer cuts', async kind => {
    let row: Record<string, unknown> = { id: targetId, user_id: user, [kind === 'agent' ? 'agentType' : 'subagentType']: 'api', primary_model_preset_id: 'original', primary_model_name: 'old',
      primary_model_provider: 'openai', primary_model_connection: { type: 'direct', service: 'openai' }, model: 'legacy', voice_profile: null }
    const client = { eval: vi.fn(async () => { const twin = readModelSelectionSnapshotTwin(targetId, kind, row)
      return ['OK', JSON.stringify([row]), JSON.stringify(twin.paths), JSON.stringify(twin.providerKeys ?? []), ...twin.raw] }) }
    const original = await readModelSelectionSnapshot(client, targetId, kind)
    const plan = prepareModelSelectionClear(original, kind)
    expect(() => prepareModelSelectionClear(structuredClone(original), kind)).toThrow()
    expect(() => prepareModelSelectionClear(original, kind === 'agent' ? 'subagent' : 'agent')).toThrow()
    expect(() => assertModelSelectionClear(structuredClone(plan.clear), original, plan.updates, kind)).toThrow()
    expect(() => assertModelSelectionClear(plan.clear, original, { ...plan.updates, primary_model_name: 'new caller value' }, kind)).toThrow()
    expect(() => assertModelSelectionClear(plan.clear, original, plan.updates, kind)).not.toThrow()
    row = { ...row, primary_model_name: 'newer' }
    const newer = await readModelSelectionSnapshot(client, targetId, kind)
    expect(() => assertModelSelectionClear(plan.clear, newer, plan.updates, kind)).toThrow()
    expect(plan.updates).not.toHaveProperty('voice_profile'); expect(plan.updates).not.toHaveProperty('model')
  })
  // SA-139 R5: the optional CLI selection read (`includeCli`, the native program cut and its preset
  // invalidation) went with the Claude Code CLI Subagent; its cases went with it.
  it.each(['agent', 'subagent'] as const)('a type-fence read reads only the original %s type/owner inputs', async kind => {
    const typeField = kind === 'agent' ? 'agentType' : 'subagentType'
    const row = { id: targetId, user_id: user, created_at: 'incarnation', [typeField]: 'api',
      provider_specific_settings: 'unused-unreadable-provider-bag', claude_settings: ['unused'], privatePrompt: 'PRIVATE_UNUSED' }
    const client = { eval: vi.fn(async (script: string, command: { keys: string[]; arguments: string[] }) => {
      expect(script).toBe(READ_MODEL_SELECTION_SCRIPT)
      expect(command.keys).toEqual([`${kind}:${targetId}`])
      // SA-139 R5: the fifth argument (the CLI native program cut) went with the Claude Code CLI Subagent.
      expect(command.arguments.slice(1)).toEqual(['type-fence', '[]', 'projection'])
      const paths = JSON.parse(command.arguments[0])
      expect(paths).toEqual(modelSelectionTypePaths(kind))
      return ['OK', '[{}]', JSON.stringify(paths), '[]', ...paths.map((path: string) => agentTypeSnapshotOf(row, [path]))]
    }) }
    const snapshot = await readModelSelectionSnapshot(client, targetId, kind, undefined, [], { typeFenceOnly: true, reportProjection: true })
    expect(client.eval).toHaveBeenCalledOnce()
    expect(snapshot).toMatchObject({ record: { id: targetId, user_id: user, created_at: 'incarnation', [typeField]: 'api' } })
    expect(snapshot).not.toHaveProperty('providerKeys')
    expect(snapshot).not.toHaveProperty('cli')
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_UNUSED')
    expect(snapshot.paths).not.toContain('$.provider_specific_settings')
  })
})

describe.runIf(REAL)('actual model selection group and existing record issue owner', () => {
  beforeEach(async () => {
    await redis.json.set(targetKey, '$', { id: targetId, user_id: user, agentType: 'api', displayName: 'Keep name', created_at: '2026-10-17',
      primary_model_provider: 'old', primary_model_name: 'old', primary_model_capabilities: { vision: true },
      provider_specific_settings: { oldParameter: 8, nativeTools: { bashEnabled: false }, codex_model: 'retain' }, untouched: 11 })
    await redis.json.set(`model:${sourceId}`, '$', preset)
    await redis.sAdd(`user:${user}:models`, sourceId)
  })
  it('uses the allocated 8.10.1 JSON/Search server and an actual nonzero harness database', async () => {
    await redis.execute(async client => {
      const server = await client.info('server'); const modules = JSON.stringify(await client.moduleList()); const info = await client.clientInfo()
      expect(server).toContain('redis_version:8.10.1')
      const url = new URL(process.env.BATSHIT_REDIS_TEST_URL ?? process.env.VITEST_REDIS_URL!)
      expect(server).toContain(`tcp_port:${url.port || '6379'}`)
      if (process.env.BATSHIT_A3_REDIS_PID) expect(server).toContain(`process_id:${process.env.BATSHIT_A3_REDIS_PID}`)
      if (process.env.BATSHIT_A3_REDIS_RUN_ID) expect(server).toContain(`run_id:${process.env.BATSHIT_A3_REDIS_RUN_ID}`)
      expect(modules).toContain('ReJSON'); expect(modules).toContain('search'); expect(info.db).toBeGreaterThan(0)
    })
  })
  it('preserves own native siblings and zero/false while clearing prior unknown capabilities at actual runtime read', async () => {
    const before = await basis()
    await redis.updateAgent(targetId, { provider_specific_settings: { nativeTools: { bashAccessMode: 'plan' } } } as any)
    expect((await basis()).revision).toBe(before.revision)
    await write({}, before.revision)
    const row = await redis.json.get(targetKey) as any
    expect(row).toMatchObject({ displayName: 'Keep name', untouched: 11, primary_model_temperature: 0, primary_model_capabilities: null,
      provider_specific_settings: { custom: false, temperature: 0, codex_model: 'retain', nativeTools: { bashEnabled: false, bashAccessMode: 'plan' } } })
    expect(row.provider_specific_settings).not.toHaveProperty('oldParameter')
    expect(resolveRuntimeModelSelection({ preset, capabilities: row.primary_model_capabilities }).capabilities).toBeNull()
  })
  it('refuses held stale human base and new model-owned provider keys without touching unrelated fields', async () => {
    const before = await basis()
    await redis.updateAgent(targetId, { provider_specific_settings: { newModelParameter: 9 } } as any, { expectedModelSelection: before.revision })
    await expect(write({ displayName: 'Must not land' }, before.revision)).rejects.toMatchObject({ status: 409, code: 'model_selection_settings_changed' })
    expect(await redis.json.get(targetKey)).toMatchObject({ displayName: 'Keep name', provider_specific_settings: { newModelParameter: 9 } })
  })
  it('retains raw precision and quoted/backslash provider-key preimages, and refuses malformed provider containers', async () => {
    await redis.execute(client => client.sendCommand(['JSON.SET', targetKey, '$.primary_model_temperature', '9007199254740993']))
    const precise = await basis()
    await redis.execute(client => client.sendCommand(['JSON.SET', targetKey, '$.primary_model_temperature', '9007199254740992']))
    expect((await basis()).revision).not.toBe(precise.revision)
    await redis.json.set(targetKey, '$.provider_specific_settings', { 'quoted"slash\\key': 0, nativeTools: { bashEnabled: false } })
    const quoted = await basis(); await write({}, quoted.revision)
    expect((await redis.json.get(targetKey) as any).provider_specific_settings).not.toHaveProperty('quoted"slash\\key')
    await redis.json.set(targetKey, '$.provider_specific_settings', [])
    await expect(basis()).rejects.toMatchObject({ status: 409 })
  })
  it.each(['target', 'membership', 'preset', 'authority'] as const)('checks final %s raw preimages inside actual EVAL', async changed => {
    const before = await basis(); const source = await readOwnedModelPresetDependency(user, sourceId)
    await redis.json.set('agent:a3_authority', '$', { generation: 'old' })
    const mutation = { source, check() {}, authority: { key: 'agent:a3_authority', paths: [['$.generation', '["old"]']] } }
    const hook = interceptIssue(async client => {
      if (changed === 'target') await client.json.set(targetKey, '$.agentType', 'cli')
      if (changed === 'membership') await client.sRem(`user:${user}:models`, sourceId)
      if (changed === 'preset') await client.json.set(`model:${sourceId}`, '$.settings.temperature', 0.9)
      if (changed === 'authority') await client.json.set('agent:a3_authority', '$.generation', 'new')
    })
    try { await expect(write({ displayName: 'Must not land' }, before.revision, mutation)).rejects.toMatchObject({ status: 409 }); expect(hook.issued()).toBe(1) }
    finally { hook.restore() }
    expect((await redis.json.get(targetKey) as any).displayName).toBe('Keep name')
  })
  it('fences identical preset replacement and Stop before issue without a new target write', async () => {
    const before = await basis(); const source = await readOwnedModelPresetDependency(user, sourceId)
    await withSettingsRecordReplacement(`model:${sourceId}`, async () => { await redis.json.set(`model:${sourceId}`, '$', preset) })
    await expect(write({}, before.revision, { source, check() {} })).rejects.toMatchObject({ status: 409 })
    const current = await readOwnedModelPresetDependency(user, sourceId)
    const signal = AbortSignal.abort()
    await expect(write({}, before.revision, { source: current, signal, check() {} })).rejects.toMatchObject({ status: 409 })
    expect((await redis.json.get(targetKey) as any).primary_model_name).toBe('old')
    await expect(withSettingsRecordReplacement(`model:${sourceId}`, async () => 'released')).resolves.toBe('released')
  })
  it('records a known save synchronously before caller readback work starts', async () => {
    const source = await readOwnedModelPresetDependency(user, sourceId); const onSaved = vi.fn()
    await write({}, undefined, { source, check() {}, onSaved })
    expect(onSaved).toHaveBeenCalledOnce()
    expect((await redis.json.get(targetKey) as any).primary_model_preset_id).toBe(sourceId)
  })
  it('writes only four API Subagent identities and retains native/provider/legacy fields', async () => {
    const row = { id: targetId, user_id: user, subagentType: 'api', created_at: '2026-10-17', model: 'legacy-retained',
      provider_specific_settings: { own: 1 }, claude_settings: { model: 'native-retained' }, untouched: 2 }
    await redis.json.set(`subagent:${targetId}`, '$', row)
    const before = await basis('subagent'); const picked = buildPickedPresetSelection(preset)
    await redis.updateSubagent(targetId, { primary_model_preset_id: sourceId, primary_model_connection: picked.primary_model_connection,
      primary_model_name: picked.primary_model_name, primary_model_provider: picked.primary_model_provider }, { expectedModelSelection: before.revision })
    const after = await redis.json.get(`subagent:${targetId}`) as any
    expect(after).toMatchObject({ ...row, primary_model_preset_id: sourceId })
    expect(after).not.toHaveProperty('primary_model_temperature')
  })
  // SA-139 R5: the first-form CLI Subagent issue went with the Claude Code CLI Subagent.
  // SA-139 R4/R5: a leftover `cli` Primary or Subagent is delete-only, so only the API owners clear a selection.
  it.each([['agent', 'api'], ['subagent', 'api']] as const)('clears a missing saved preset through the real %s/%s owner while preserving native, legacy and raw-null siblings', async (kind, type) => {
    const id = `a3_missing_clear_${kind}_${type}`, key = `${kind}:${id}`
    const row = { id, user_id: user, created_at: 'original', [kind === 'agent' ? 'agentType' : 'subagentType']: type,
      primary_model_preset_id: `absent_${id}`, primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'old', primary_model_connection: { id: 'claude-cli', type: 'direct', service: 'anthropic-claude-cli' },
      primary_model_temperature: 0, primary_model_seed: null, model: 'legacy-retained', voice_profile: null, goon_id: null,
      provider_specific_settings: { temperature: 0, flag: false, claude_model: 'legacy-native', nativeTools: { bashAccessMode: 'plan' } },
      claude_settings: { permissionMode: 'plan', model: 'explicit-native', alwaysThinkingEnabled: true, maxThinkingTokens: 4096 } }
    await redis.json.set(key, '$', row)
    const original = await redis.execute(client => readModelSelectionSnapshot(client, id, kind))
    const plan = prepareModelSelectionClear(original, kind), onSaved = vi.fn()
    const options = { expectedModelSelection: original.revision, modelSelectionMutation: { clear: plan.clear, check() {}, onSaved } }
    if (kind === 'agent') await redis.updateAgent(id, plan.updates, options)
    else expect(await redis.updateSubagent(id, plan.updates, options)).toBe(true)
    const after = await redis.json.get(key) as Record<string, any>
    expect(after).toMatchObject({ primary_model_preset_id: '', primary_model_name: '', primary_model_provider: '', primary_model_connection: null,
      claude_settings: row.claude_settings, model: row.model, voice_profile: null, goon_id: null })
    expect(onSaved).toHaveBeenCalledOnce()
    if (kind === 'agent') {
      expect(after).not.toHaveProperty('primary_model_temperature')
      expect(after).toHaveProperty('primary_model_seed', null)
      expect(after.provider_specific_settings).toEqual({ claude_model: 'legacy-native', nativeTools: { bashAccessMode: 'plan' } })
    } else expect(after).toMatchObject({ primary_model_temperature: 0, primary_model_seed: null, provider_specific_settings: row.provider_specific_settings })
  })
  it.each(['empty', 'null'] as const)('the real ordinary human %s clear requires its original header, detaches a missing mapping and preserves unrelated raw nulls', async representation => {
    const id = `a3_human_missing_clear_${representation}`, key = `agent:${id}`
    // SA-139 R4/R5: an API agent (a leftover `cli` one is delete-only and holds no selection to clear).
    await redis.json.set(key, '$', { id, user_id: user, agentType: 'api', primary_model_preset_id: 'absent_human_preset', primary_model_name: 'old',
      primary_model_provider: 'openai', primary_model_connection: { id: 'direct:openai', type: 'direct', service: 'openai' }, voice_profile: null, goon_id: null, provider_specific_settings: null,
      model: 'legacy-kept', claude_settings: { permissionMode: 'plan', model: 'native-kept', alwaysThinkingEnabled: true } })
    const original = await redis.execute(client => readModelSelectionSnapshot(client, id, 'agent'))
    const empty = representation === 'null' ? null : ''
    const clear = { primary_model_preset_id: empty, primary_model_name: empty, primary_model_provider: empty, primary_model_connection: null, provider_specific_settings: {} }
    await expect(redis.updateAgent(id, clear)).rejects.toMatchObject({ code: 'model_selection_base_required' })
    await redis.updateAgent(id, clear, { expectedModelSelection: original.revision })
    const after = await redis.json.get(key)
    expect(after).toMatchObject({ primary_model_name: empty, primary_model_provider: empty, primary_model_connection: null,
      agentType: 'api', voice_profile: null, goon_id: null, provider_specific_settings: null, model: 'legacy-kept', claude_settings: { permissionMode: 'plan', model: 'native-kept', alwaysThinkingEnabled: true } })
    if (representation === 'null') expect(after).not.toHaveProperty('primary_model_preset_id')
    else expect(after).toHaveProperty('primary_model_preset_id', '')
  })
  it.each(['absent', 'null'] as const)('server-owned selection preserves the original %s provider container and raw-null siblings when no model keys need writing', async state => {
    const id = `a3_container_${state}`, key = `agent:${id}`
    await redis.json.set(key, '$', { id, user_id: user, agentType: 'api', voice_profile: null, goon_id: null, ...(state === 'null' ? { provider_specific_settings: null } : {}) })
    await redis.json.set(`model:${sourceId}`, '$.settings', {})
    const original = await redis.execute(client => readModelSelectionSnapshot(client, id, 'agent'))
    const source = await readOwnedModelPresetDependency(user, sourceId)
    const updates = planModelSelectionCandidate('agent', original, source.preset)
    expect(updates).not.toHaveProperty('provider_specific_settings')
    await redis.updateAgent(id, updates, { expectedModelSelection: original.revision, modelSelectionMutation: { source, check() {} } })
    const after = await redis.json.get(key) as Record<string, unknown>
    expect(after).toMatchObject({ voice_profile: null, goon_id: null, primary_model_preset_id: sourceId })
    expect(Object.hasOwn(after, 'provider_specific_settings')).toBe(state === 'null')
    if (state === 'null') expect(after.provider_specific_settings).toBeNull()
  })
  it('ordinary nonclear writes retain the historical null normalization behavior', async () => {
    await redis.json.set(targetKey, '$.voice_profile', null)
    await redis.json.set(targetKey, '$.goon_id', null)
    await redis.updateAgent(targetId, { displayName: 'Ordinary human edit' })
    const after = await redis.json.get(targetKey) as Record<string, unknown>
    expect(after).not.toHaveProperty('voice_profile'); expect(after).not.toHaveProperty('goon_id')
  })
  it.each(['Stop', 'deadline', 'target', 'authority'] as const)('clear retains the actual %s fence despite having no destination source', async changed => {
    const id = `a3_clear_fence_${changed}`, key = `agent:${id}`, authority = `a3_clear_authority_${changed}`
    await redis.json.set(key, '$', { id, user_id: user, agentType: 'api', primary_model_preset_id: sourceId, primary_model_name: 'old', voice_profile: null })
    await redis.json.set(authority, '$', { generation: 1 })
    const original = await redis.execute(client => readModelSelectionSnapshot(client, id, 'agent')), plan = prepareModelSelectionClear(original, 'agent')
    const hook = interceptIssue(async client => {
      if (changed === 'target') await client.json.set(key, '$.primary_model_name', 'newer')
      if (changed === 'authority') await client.json.set(authority, '$.generation', 2)
    })
    try {
      await expect(redis.updateAgent(id, plan.updates, { expectedModelSelection: original.revision, modelSelectionMutation: { clear: plan.clear, check() {},
        ...(changed === 'Stop' ? { signal: AbortSignal.abort() } : {}), deadlineAt: Date.now() + (changed === 'deadline' ? -1 : 30000),
        authority: { key: authority, paths: [['$.generation', '[1]']] } } })).rejects.toMatchObject({ status: 409 })
      expect(hook.issued()).toBe(changed === 'Stop' || changed === 'deadline' ? 0 : 1)
      expect(await redis.json.get(key)).toMatchObject({ primary_model_preset_id: sourceId, voice_profile: null })
    } finally { hook.restore() }
  })
  it('the missing mapping must still be absent at the actual clear EVAL', async () => {
    const id = 'a3_absence_issue_race', key = `agent:${id}`, missing = `absent_${id}`
    await redis.json.set(key, '$', { id, user_id: user, agentType: 'api', primary_model_preset_id: missing, primary_model_name: 'old' })
    const original = await redis.execute(client => readModelSelectionSnapshot(client, id, 'agent')), plan = prepareModelSelectionClear(original, 'agent')
    const hook = interceptIssue(async client => { await client.json.set(`model:${missing}`, '$', { ...preset, id: missing }) })
    try { await expect(redis.updateAgent(id, plan.updates, { expectedModelSelection: original.revision, modelSelectionMutation: { clear: plan.clear, check() {} } })).rejects.toMatchObject({ status: 409 }); expect(hook.issued()).toBe(1) }
    finally { hook.restore() }
    expect(await redis.json.get(key)).toMatchObject({ primary_model_preset_id: missing, primary_model_name: 'old' })
  })
  it.each(['foreign', 'wrong-id', 'wrong-type'] as const)('refuses to clear through an invalid old preset (%s) without changing the target', async invalid => {
    const id = `a3_bad_clear_${invalid}`, key = `agent:${id}`, old = `a3_old_${invalid}`, modelKey = `model:${old}`
    await redis.json.set(key, '$', { id, user_id: user, agentType: 'api', primary_model_preset_id: old, primary_model_name: 'old' })
    if (invalid === 'wrong-type') await redis.execute(client => client.set(modelKey, 'not-json'))
    else await redis.json.set(modelKey, '$', { ...preset, id: invalid === 'wrong-id' ? 'different-id' : old })
    if (invalid !== 'foreign') await redis.sAdd(`user:${user}:models`, old)
    try {
      const original = await redis.execute(client => readModelSelectionSnapshot(client, id, 'agent'))
      const plan = prepareModelSelectionClear(original, 'agent')
      await expect(redis.updateAgent(id, plan.updates, { expectedModelSelection: original.revision,
        modelSelectionMutation: { clear: plan.clear, check() {} } })).rejects.toMatchObject({ code: 'model_selection_settings_changed' })
      expect(await redis.json.get(key)).toMatchObject({ primary_model_preset_id: old, primary_model_name: 'old' })
    } finally { await redis.del(key); await redis.del(modelKey); await redis.sRem(`user:${user}:models`, old) }
  })
  it('an issued clear answer loss retains target and genuinely absent old-source custody', async () => {
    const id = 'a3_unknown_missing_clear', key = `agent:${id}`, missing = `absent_${id}`
    await redis.json.set(key, '$', { id, user_id: user, agentType: 'api', primary_model_preset_id: missing, primary_model_name: 'old' })
    const original = await redis.execute(client => readModelSelectionSnapshot(client, id, 'agent')), plan = prepareModelSelectionClear(original, 'agent')
    const hook = interceptIssue(async () => {}, true)
    try { await expect(redis.updateAgent(id, plan.updates, { expectedModelSelection: original.revision, modelSelectionMutation: { clear: plan.clear, check() {} } })).rejects.toBeInstanceOf(ModelSelectionSaveUnconfirmedError) }
    finally { hook.restore() }
    for (const owner of [key, `model:${missing}`]) await expect(withSettingsRecordReplacement(owner, async () => 'must not enter')).rejects.toThrow('unknown')
    expect(await redis.json.get(key)).toMatchObject({ primary_model_preset_id: '' })
    expect(await redis.json.get(`model:${missing}`)).toBeNull()
    expect(hook.issued()).toBe(1)
  })
  it('retains issued answer loss as unknown, holds replacement and never replays', async () => {
    const before = await basis(); const hook = interceptIssue(async () => {}, true)
    try { await expect(write({}, before.revision)).rejects.toBeInstanceOf(ModelSelectionSaveUnconfirmedError); expect(hook.issued()).toBe(1) }
    finally { hook.restore() }
    expect((await redis.json.get(targetKey) as any).primary_model_preset_id).toBe(sourceId)
    await expect(withSettingsRecordReplacement(`model:${sourceId}`, async () => {})).rejects.toMatchObject({ status: 409 })
    expect(hook.issued()).toBe(1)
  })
})
