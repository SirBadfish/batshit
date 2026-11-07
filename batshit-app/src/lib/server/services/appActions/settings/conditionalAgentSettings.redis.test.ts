import type { AdapterContext } from '../managementTypes'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import { readAutoCompactSnapshot, type AutoCompactSnapshot } from '$lib/server/autoCompactGuard'
import { planAutoCompactChanges } from './autoCompactAdapter'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { AbortError } from 'redis'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import type { SettingsOwnerContext } from '$lib/appActions/settings/validation'
import { CONDITIONAL_SETTINGS_WRITE_SCRIPT, SETTINGS_SNAPSHOT_PATHS, planMcpTarget, createConditionalSettingsStore } from './conditionalAgentSettings'
import { readInstructionsSnapshot, type InstructionsKind, type InstructionsLeaf, type InstructionsSnapshot } from '$lib/server/instructionsGuard'
import { readModelSelectionSnapshot } from '$lib/server/modelSelectionGuard'
import { buildSubagentWrites } from '$lib/server/subagentRecordUpdate'
import { INSTRUCTION_LIMITS } from '$lib/appActions/settings/instructionPreferences'
import { MEMORY_WINDOW_MODE_PATHS } from '$lib/appActions/settings/memoryPreferences'
import { createInstructionTextPages, readInstructionTextSnapshot } from './instructionTextSnapshot'
import { planInstructionsChanges } from './instructionAdapter'
import { captureSettingsLifecycle, withSettingsRecordReplacement, withSettingsRestoreFence } from './lifecycle'
import { createSettingsReportSnapshot } from './report'

// The default fake has no interpreter for this new script. These assertions must
// run against the real DB14 worker lane after the coordinator releases it; a simulated
// script is not atomicity or RedisJSON wire-shape proof.
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const ID = 'sa122_settings_atomic_probe'
const USER = 'sa122_settings_probe_user'
const KEY = `agent:${ID}`
const STAMP = '2026-10-04T00:00:00.000Z'

const strictAdmission = createSettingsRedisAdmission(redis)
const admission = useRedisTestServer({ beforeCleanupAdmission: strictAdmission.beforeCleanupAdmission })
afterAll(() => strictAdmission.close())

const store = createConditionalSettingsStore(operation => redis.execute(operation), error => error instanceof AbortError)
async function seed(memory_lane_budgets: unknown = { on_my_mind: 2000, triggers: 1200, recalled: 2400, unknownSibling: 'keep' }, extra: Record<string, unknown> = {}) {
  admission.requireAdmission()
  await redis.json.set(KEY, '$', {
    id: ID, user_id: USER, agentType: 'api', displayName: 'Probe', memory_enabled: false,
    memory_lane_budgets, memory_linger_turns: 2, memory_recall_linger_turns: 2,
    memory_window: { floor_tokens: 1234 }, provider_specific_settings: { nativeTools: { bashAccessMode: 'plan' } },
    updated_at: STAMP, ...extra
  })
}
async function record() { return await redis.json.get(KEY) }

function fixtureOwnerContext(): SettingsOwnerContext {
  // Fixture authority for this owned record only. This is not route/session
  // authentication, consent, or an originating API/managed Stop proof.
  const signal = new AbortController().signal
  const deadlineAt = Date.now() + 5000
  return {
    actor: { kind: 'agent', userId: USER, actingAgentId: ID }, signal, deadlineAt,
    check() {
      admission.requireAdmission()
      if (signal.aborted || Date.now() >= deadlineAt) throw new Error('Settings fixture invocation is no longer admitted.')
    }
  }
}

describe.runIf(REAL)('conditional Settings owner: real RedisJSON atomicity', () => {
  afterEach(async () => { if (admission.isAdmitted()) await redis.del(KEY) })

  it.each(['canonical', 'legacy'] as const)('A8 sets only both automatic modes in the actual %s source, preserving all siblings', async source => {
    const window = { floor_mode: 'custom', floor_tokens: 64000, ceiling_headroom_mode: 'custom', ceiling_headroom_tokens: 20000,
      nap_threshold_percent: 75, idle_gap_hours: 12, summary_model_mode: 'preset', summary_model_preset_id: 'historical-summary', unknown: { keep: true } }
    await seed(undefined, source === 'canonical' ? { memory_window: window, memoryWindow: { floor_mode: 'custom', inactive: true } }
      : { memory_window: null, memoryWindow: window })
    const before = await store.read(ID)
    expect(before.memoryWindowParents).toEqual(source === 'canonical' ? ['object', 'object'] : ['null', 'object'])
    expect(await store.write(ID, USER, 'memory', before, { windowMode: 'auto', recalled: 0 })).toBe('OK')
    const after = await record(), field = source === 'canonical' ? 'memory_window' : 'memoryWindow'
    expect(after[field]).toEqual({ ...window, floor_mode: 'auto', ceiling_headroom_mode: 'auto' })
    expect(after.memory_lane_budgets.recalled).toBe(0)
    if (source === 'legacy') expect(after.memory_window).toBeNull()
    else expect(after.memoryWindow).toEqual({ floor_mode: 'custom', inactive: true })
  })
  it.each(['x'.repeat(10000), { malformed: true }])('A8 preserves a malformed inactive alias without making its sentinel an impossible raw guard', async inactive => {
    await seed(undefined, { memory_window: { floor_mode: 'custom', ceiling_headroom_mode: 'auto', floor_tokens: 64000 }, memoryWindow: { floor_mode: inactive, unknown: 'keep' } })
    const before = await store.read(ID)
    // SA-139 R4 dropped the CLI Primary `$.preserve_reasoning` slot, so the mode slots are found by path, not position.
    const modeIndices = MEMORY_WINDOW_MODE_PATHS.map(path => SETTINGS_SNAPSHOT_PATHS.indexOf(path))
    expect(before.raw[SETTINGS_SNAPSHOT_PATHS.indexOf('$.memoryWindow.floor_mode')]).toContain('invalid_saved_memory_mode')
    // Actual former wire arguments reproduced the impossible inactive raw CAS.
    const previousExpected = [0,1,2,4,5,6,7,8,9,10,11,...modeIndices].map(index => [SETTINGS_SNAPSHOT_PATHS[index], before.raw[index]])
    expect(await redis.execute(client => client.eval(CONDITIONAL_SETTINGS_WRITE_SCRIPT, { keys: [KEY],
      arguments: [ID, USER, JSON.stringify(previousExpected), 'memory', JSON.stringify({ windowMode: 'auto' }), JSON.stringify(STAMP), 'primary', '[]', '', JSON.stringify(before.memoryWindowParents), '', ''] }))).toBe('CONFLICT')
    expect((await record()).memory_window.floor_mode).toBe('custom')
    expect(await store.write(ID, USER, 'memory', before, { windowMode: 'auto' })).toBe('OK')
    expect(await record()).toMatchObject({ memory_window: { floor_mode: 'auto', floor_tokens: 64000 }, memoryWindow: { floor_mode: inactive, unknown: 'keep' } })
  })
  it.each([{ floor_mode: { malformed: true }, keep: 'active' }, ['malformed-container']])('A8 keeps malformed active window data independent from disable and delivered budgets', async active => {
    await seed(undefined, { memory_enabled: true, memory_window: active })
    const before = await store.read(ID)
    expect(await store.write(ID, USER, 'memory', before, { enabled: false, recalled: 0 })).toBe('OK')
    expect(await record()).toMatchObject({ memory_enabled: false, memory_lane_budgets: { recalled: 0 }, memory_window: active })
  })
  it.each(['$.memory_enabled', '$.memoryEnabled', '$.memory_window.floor_mode', '$.memory_window'] as const)('A8 refuses an actual changed dependency %s before any write', async path => {
    await seed(undefined, { memory_window: { floor_mode: 'custom', ceiling_headroom_mode: 'custom', keep: 7 } })
    const before = await store.read(ID)
    await redis.json.set(KEY, path, path.includes('enabled') || path.includes('Enabled') ? true : path.endsWith('floor_mode') ? 'auto' : null)
    const changed = await record()
    expect(await store.write(ID, USER, 'memory', before, { enabled: false, windowMode: 'auto' })).toBe('CONFLICT')
    expect(await record()).toEqual(changed)
  })
  it('A8 reads configuration without endpoint/key disclosure and compares original source at physical issue', async () => {
    await seed()
    const config = { lane: 'local-ai', modelId: 'configured', localAi: { baseUrl: 'http://127.0.0.1:19000/v1', modelName: 'embedding', dims: 384, apiKey: 'legacy-key-must-stay' } }
    await redis.json.set('batshit:memory_config', '$', { embedding: config, keep: true })
    const ready = await store.readMemoryReadiness!()
    expect(ready.status).toBe('configuration-ready')
    expect(JSON.stringify(ready)).not.toMatch(/19000|legacy-key|baseUrl|modelName/)
    const before = await store.read(ID)
    const context = { memoryEnableSource: { source: ready.source, check() {} } }
    await redis.json.set('batshit:memory_config', '$.embedding.localAi.baseUrl', 'http://127.0.0.1:19001/v1')
    expect(await store.write(ID, USER, 'memory', before, { enabled: true, recalled: 0 }, undefined, new AbortController().signal, Date.now() + 5000, context)).toBe('MEMORY_SOURCE_CHANGED')
    expect(await record()).toMatchObject({ memory_enabled: false, memory_lane_budgets: { recalled: 2400 }, updated_at: STAMP })
    const current = await store.readMemoryReadiness!()
    expect(await store.write(ID, USER, 'memory', before, { enabled: true }, undefined, new AbortController().signal, Date.now() + 5000,
      { memoryEnableSource: { source: current.source, check() {} } })).toBe('OK')
    expect(await record()).toMatchObject({ memory_enabled: true })
    expect(await redis.json.get('batshit:memory_config')).toEqual({ embedding: { ...config, localAi: { ...config.localAi, baseUrl: 'http://127.0.0.1:19001/v1' } }, keep: true })
  })
  it('A8 keeps unprepared/malformed config independent from disable and automatic-window writes', async () => {
    await seed(undefined, { memory_enabled: true, memory_window: { floor_mode: 'custom', ceiling_headroom_mode: 'custom', floor_tokens: 12345 } })
    await redis.json.set('batshit:memory_config', '$', { embedding: { lane: 'unknown', modelId: '' } })
    expect((await store.readMemoryReadiness!()).status).toBe('configuration-unavailable')
    const before = await store.read(ID)
    expect(await store.write(ID, USER, 'memory', before, { enabled: false, windowMode: 'auto' })).toBe('OK')
    expect(await record()).toMatchObject({ memory_enabled: false, memory_window: { floor_mode: 'auto', ceiling_headroom_mode: 'auto', floor_tokens: 12345 } })
    expect(await store.write(ID, USER, 'memory', await store.read(ID), { enabled: true })).toBe('MEMORY_READINESS_REQUIRED')
  })
  it('A8 keeps fallback/source shape bounded and never replaces malformed configuration with factory state', async () => {
    for (const value of [null, {}, { embedding: null }, { embedding: { lane: '', modelId: '' } }]) {
      await redis.json.set('batshit:memory_config', '$', value)
      expect(await store.readMemoryReadiness!()).toMatchObject({ status: 'preparation-required', builtinModelId: 'builtin:embeddinggemma-300m' })
      expect(await redis.json.get('batshit:memory_config')).toEqual(value)
    }
    for (const value of [[], { embedding: [] }, { embedding: { lane: 0, modelId: '' } }, { embedding: { lane: 'invalid', modelId: null } },
      { embedding: { lane: 'local-ai', modelId: 'configured', localAi: { baseUrl: 'x'.repeat(4097), modelName: 'model', dims: 384 } } }]) {
      await redis.json.set('batshit:memory_config', '$', value)
      expect(await store.readMemoryReadiness!()).toMatchObject({ status: 'configuration-unavailable', source: '' })
      expect(await redis.json.get('batshit:memory_config')).toEqual(value)
    }
  })

  it('reads the actual raw JSONPath arrays and writes only one budget member', async () => {
    await seed()
    const before = await store.read(ID)
    expect(JSON.parse(before.raw[5])).toEqual([{ on_my_mind: 2000, triggers: 1200, recalled: 2400, unknownSibling: 'keep' }])
    expect(await store.write(ID, USER, 'memory', before, { onMyMind: 900 })).toBe('OK')
    const after = await record()
    expect(after.memory_lane_budgets).toEqual({ on_my_mind: 900, triggers: 1200, recalled: 2400, unknownSibling: 'keep' })
    expect(after.memory_enabled).toBe(false)
    expect(after.provider_specific_settings.nativeTools.bashAccessMode).toBe('plan')
    expect(after.memory_window.floor_tokens).toBe(1234)
    expect(after.updated_at).not.toBe(STAMP)
  })
  it('preserves an unrelated sibling edit made after the snapshot', async () => {
    await seed(); const before = await store.read(ID)
    await redis.json.set(KEY, '$.memory_window.floor_tokens', 9999)
    await redis.json.set(KEY, '$.displayName', 'New human name')
    expect(await store.write(ID, USER, 'memory', before, { triggerLingerTurns: 3, onMyMind: 900 })).toBe('OK')
    const after = await record()
    expect(after.memory_window.floor_tokens).toBe(9999)
    expect(after.displayName).toBe('New human name')
    expect(after.memory_lane_budgets.unknownSibling).toBe('keep')
    expect(after.memory_linger_turns).toBe(3)
  })
  it('refuses a changed budget sibling with no partial target/timestamp writes', async () => {
    await seed(); const before = await store.read(ID)
    await redis.json.set(KEY, '$.memory_lane_budgets.triggers', 1800)
    expect(await store.write(ID, USER, 'memory', before, { onMyMind: 900, triggerLingerTurns: 3 })).toBe('CONFLICT')
    const after = await record()
    expect(after.memory_lane_budgets.on_my_mind).toBe(2000)
    expect(after.memory_lane_budgets.triggers).toBe(1800)
    expect(after.memory_linger_turns).toBe(2)
    expect(after.updated_at).toBe(STAMP)
  })
  it('preflights every member before writing any of a multi-field request', async () => {
    await seed(); const before = await store.read(ID); const original = await record()
    expect(await store.write(ID, USER, 'memory', before, { onMyMind: 900, triggerLingerTurns: 3, recalled: -1 })).toBe('INVALID_CHANGES')
    expect(await record()).toEqual(original)
    expect(await store.write(ID, USER, 'memory', before, { onMyMind: 900, path: '$.memory_enabled' } as never)).toBe('INVALID_CHANGES')
    expect(await record()).toEqual(original)
  })
  it('rejects an invalid timestamp before any target or budget-parent mutation', async () => {
    await seed(null); const before = await store.read(ID); const original = await record()
    const expected = [0, 1, 2, 5, 6, 7, 8, 9, 10].map(index => [SETTINGS_SNAPSHOT_PATHS[index], before.raw[index]])
    const answer = await redis.execute(client => client.eval(CONDITIONAL_SETTINGS_WRITE_SCRIPT, {
      keys: [KEY], arguments: [ID, USER, JSON.stringify(expected), 'memory', JSON.stringify({ onMyMind: 900, triggerLingerTurns: 3 }), '[1]']
    }))
    expect(answer).toBe('INVALID_TIMESTAMP')
    expect(await record()).toEqual(original)
  })
  it('refuses malformed and legacy-only budget parents before linger or timestamp writes', async () => {
    await seed([]); let before = await store.read(ID); let original = await record()
    expect(await store.write(ID, USER, 'memory', before, { onMyMind: 900, triggerLingerTurns: 3 })).toBe('INVALID_BUDGET_SHAPE')
    expect(await record()).toEqual(original)
    await seed(null, { memoryLaneBudgets: { on_my_mind: 8000, triggers: 4000, recalled: 6000 } })
    before = await store.read(ID); original = await record()
    expect(await store.write(ID, USER, 'memory', before, { onMyMind: 900, triggerLingerTurns: 3 })).toBe('LEGACY_BUDGETS')
    expect(await record()).toEqual(original)
  })
  it('rechecks current ownership/type and never recreates a deleted agent', async () => {
    await seed(); let before = await store.read(ID)
    await redis.json.set(KEY, '$.user_id', 'another-user'); let original = await record()
    expect(await store.write(ID, USER, 'identity', before, { displayName: 'Changed' })).toBe('FORBIDDEN')
    expect(await record()).toEqual(original)
    await seed(); before = await store.read(ID)
    await redis.json.set(KEY, '$.agentType', 'n8n'); original = await record()
    expect(await store.write(ID, USER, 'identity', before, { displayName: 'Changed' })).toBe('UNSUPPORTED_PRIMARY')
    expect(await record()).toEqual(original)
    await redis.del(KEY)
    expect(await store.write(ID, USER, 'identity', before, { displayName: 'Changed' })).toBe('MISSING')
    expect(await record()).toBeNull()
  })
  it('saves trimmed displayName through the exposed owner and preserves unrelated fields and ownership', async () => {
    await seed()
    const { ownAgentSettings } = await import('./server')
    const before = await ownAgentSettings.readIdentity({ subjectAgentId: ID }, fixtureOwnerContext())
    expect(before.values).toEqual({ displayName: 'Probe' })
    // A real sibling edit after the identity read must survive the narrow save.
    await redis.json.set(KEY, '$.memory_window.floor_tokens', 4321)
    const beforeSave = await record()
    const saved = await ownAgentSettings.updateIdentity({
      subjectAgentId: ID, expectedRevision: before.revision, changes: { displayName: '  Renamed probe  ' }
    }, fixtureOwnerContext())
    expect(saved).toMatchObject({ status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown' })
    expect(saved.current).toMatchObject({ subjectAgentId: ID, values: { displayName: 'Renamed probe' } })
    expect(saved.current?.revision).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(saved.current?.revision).not.toBe(before.revision)
    expect(saved.inverse).toEqual({ subjectAgentId: ID, expectedRevision: saved.current?.revision, changes: { displayName: 'Probe' } })
    const after = await record()
    expect(after).toEqual({ ...beforeSave, displayName: 'Renamed probe', updated_at: expect.any(String) })
    expect(after).toMatchObject({ id: ID, user_id: USER, agentType: 'api', memory_enabled: false,
      memory_window: { floor_tokens: 4321 }, provider_specific_settings: { nativeTools: { bashAccessMode: 'plan' } } })
    expect(after.updated_at).not.toBe(STAMP)
    expect(new Date(after.updated_at).toISOString()).toBe(after.updated_at)
    expect(await ownAgentSettings.readIdentity({ subjectAgentId: ID }, fixtureOwnerContext())).toEqual(saved.current)
  })
  it('applies a generated memory inverse on its current revision and refuses it after an intervening revision', async () => {
    await seed()
    const { ownAgentSettings } = await import('./server')
    const before = await ownAgentSettings.readMemory({ subjectAgentId: ID }, fixtureOwnerContext())
    const saved = await ownAgentSettings.updateMemory({
      subjectAgentId: ID, expectedRevision: before.revision, changes: { onMyMind: 900, triggerLingerTurns: 3 }
    }, fixtureOwnerContext())
    expect(saved).toMatchObject({ status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown' })
    expect(saved.inverse).toEqual({ subjectAgentId: ID, expectedRevision: saved.current?.revision,
      changes: { onMyMind: 2000, triggerLingerTurns: 2 } })
    expect(saved.current?.revision).not.toBe(before.revision)
    await redis.json.set(KEY, '$.displayName', 'Human sibling name')
    await redis.json.set(KEY, '$.memory_window.floor_tokens', 9999)
    const beforeInverse = await record()
    expect((await ownAgentSettings.readMemory({ subjectAgentId: ID }, fixtureOwnerContext())).revision).toBe(saved.inverse?.expectedRevision)
    // Replay the exact returned payload, not a reconstructed unconditional setter.
    const restored = await ownAgentSettings.updateMemory(saved.inverse, fixtureOwnerContext())
    expect(restored).toMatchObject({ status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown' })
    expect(restored.current?.values).toEqual(before.values)
    expect(restored.current?.memoryEnabled).toBe(false)
    expect(restored.current?.revision).toBe(before.revision)
    const afterInverse = await record()
    expect(afterInverse).toEqual({ ...beforeInverse,
      memory_lane_budgets: { ...beforeInverse.memory_lane_budgets, on_my_mind: 2000 },
      memory_linger_turns: 2, updated_at: expect.any(String) })
    expect(new Date(afterInverse.updated_at).toISOString()).toBe(afterInverse.updated_at)

    const second = await ownAgentSettings.updateMemory({
      subjectAgentId: ID, expectedRevision: restored.current!.revision, changes: { onMyMind: 1100 }
    }, fixtureOwnerContext())
    expect(second).toMatchObject({ status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown' })
    expect(second.inverse).toEqual({ subjectAgentId: ID, expectedRevision: second.current?.revision, changes: { onMyMind: 2000 } })
    await redis.json.set(KEY, '$.memory_lane_budgets.triggers', 1800)
    const intervened = await record()
    expect((await ownAgentSettings.readMemory({ subjectAgentId: ID }, fixtureOwnerContext())).revision).not.toBe(second.inverse?.expectedRevision)
    const refused = await ownAgentSettings.updateMemory(second.inverse, fixtureOwnerContext())
    expect(refused).toEqual({ status: 'blocked', reason: 'revision_conflict', saved: 'not_requested',
      readback: 'not_requested', visible: 'unchanged' })
    expect(await record()).toEqual(intervened)
    expect(intervened).toMatchObject({ id: ID, user_id: USER, agentType: 'api', displayName: 'Human sibling name',
      memory_enabled: false, memory_lane_budgets: { on_my_mind: 1100, triggers: 1800, recalled: 2400, unknownSibling: 'keep' },
      memory_linger_turns: 2, memory_window: { floor_tokens: 9999 } })
  })
})

const SUB_ID = `${ID}_sub`
const SUB_KEY = `subagent:${SUB_ID}`
const INSTRUCTION_KINDS = ['agent', 'subagent'] as const
const instructionId = (kind: InstructionsKind) => kind === 'agent' ? ID : SUB_ID
const instructionKey = (kind: InstructionsKind) => `${kind}:${instructionId(kind)}`
const instructionIndex = (kind: InstructionsKind) => `user:${USER}:${kind === 'agent' ? 'agents' : 'subagents'}`
async function seedInstructions(kind: InstructionsKind = 'agent', extra: Record<string, unknown> = {}) {
  admission.requireAdmission()
  const values = { created_at: STAMP, system_prompt: 'Original custom instructions', include_global_prompt: false, ...extra }
  if (kind === 'agent') await seed(undefined, values)
  else await redis.json.set(SUB_KEY, '$', { id: SUB_ID, user_id: USER, subagentType: 'api', displayName: 'Subagent probe',
    provider_specific_settings: { nativeTools: { bashAccessMode: 'plan' } }, updated_at: STAMP, ...values })
  await redis.sAdd(instructionIndex(kind), instructionId(kind))
  await redis.sAdd(instructionIndex(kind), 'untouched_index_member')
}
async function instructionsBase(kind: InstructionsKind, leaves?: readonly InstructionsLeaf[]) {
  admission.requireAdmission()
  return redis.execute(client => readInstructionsSnapshot(client, instructionId(kind), kind, undefined, leaves))
}
async function saveInstructions(kind: InstructionsKind, writes: Record<string, unknown>, expected?: InstructionsSnapshot['revisions']) {
  admission.requireAdmission()
  if (kind === 'agent') return redis.updateAgent(ID, writes as never, { expectedInstructions: expected })
  return redis.updateSubagent(SUB_ID, writes, { expectedInstructions: expected })
}
async function instructionRecord(kind: InstructionsKind) { return redis.json.get(instructionKey(kind)) }
async function boundedInstructions(options: { includeText: boolean; prompt?: boolean }) {
  admission.requireAdmission()
  return readInstructionTextSnapshot({ kind: 'primary', id: ID }, USER,
    (script, args) => redis.execute(client => client.eval(script, args)), options)
}
async function jsonCommandCalls(command: 'get' | 'type' | 'strlen' = 'get') {
  admission.requireAdmission()
  return redis.execute(async client => {
    const line = (await client.info('commandstats')).split(/\r?\n/).find(value => value.toLowerCase().startsWith(`cmdstat_json.${command}:`))
    const calls = line?.match(/(?:^|[:,])calls=([0-9]+)(?:,|$)/)?.[1]
    if (calls === undefined || !Number.isSafeInteger(Number(calls))) throw new Error(`The admitted Redis JSON.${command.toUpperCase()} command counter is unavailable for this bounded proof.`)
    return Number(calls)
  })
}

describe.runIf(REAL)('A6 instructions: actual bounded reads and ordinary guarded writers', () => {
  afterEach(async () => {
    if (admission.isAdmitted()) for (const key of [KEY, SUB_KEY, instructionIndex('agent'), instructionIndex('subagent')]) await redis.del(key)
  })

  it('pins Unicode JSON.TYPE/STRLEN wire units and strips prompt/raw/hash from actual report pages', async () => {
    const prompt = 'A🌊é'
    await seedInstructions('agent', { system_prompt: prompt })
    const shapes = await redis.execute(async client => ({ type: await client.sendCommand(['JSON.TYPE', KEY, '$.system_prompt']),
      length: await client.sendCommand(['JSON.STRLEN', KEY, '$.system_prompt']), absent: await client.sendCommand(['JSON.TYPE', KEY, '$.missing_prompt']) }))
    expect(shapes).toEqual({ type: ['string'], length: [Buffer.byteLength(prompt, 'utf8')], absent: [] })
    expect(Buffer.byteLength(prompt, 'utf8')).not.toBe(prompt.length)
    const metadata = await boundedInstructions({ includeText: false })
    expect(metadata.customPrompt).toEqual({ stored: 'set', codeUnits: prompt.length, utf8Bytes: Buffer.byteLength(prompt, 'utf8'), read: 'available' })
    expect(metadata.text).toBeUndefined(); expect(metadata.record).not.toHaveProperty('system_prompt')
    expect(metadata.raw.some(([path]) => path === '$.system_prompt')).toBe(false)
    expect(metadata.promptPreimage).toMatch(/^sha256:[a-f0-9]{64}$/)
    const subject = { kind: 'primary' as const, id: ID }
    const summary = await createSettingsReportSnapshot({ ownerUserId: USER, digest: 'a'.repeat(64), entries: [{ subject, status: 'available', type: 'api' }], excluded: [] },
      { focus: ['agent.instructions'], detail: 'summary' }, { userId: USER, canRead: () => true, check: () => admission.requireAdmission() },
      { read: async () => ({ ...metadata.record, __instructionMetadata: metadata.customPrompt, promptPreimage: metadata.promptPreimage }) })
    const wire = JSON.stringify(summary.page())
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(8192)
    expect(wire).not.toContain(prompt); expect(wire).not.toContain('system_prompt'); expect(wire).not.toContain('promptPreimage'); expect(wire).not.toContain(metadata.promptPreimage!)
    const explicit = await boundedInstructions({ includeText: true })
    expect(explicit.text).toBe(prompt); expect(explicit.promptPreimage).toBe(metadata.promptPreimage)
    expect(explicit.raw.find(([path]) => path === '$.system_prompt')?.[1]).toBe(await redis.json.getRaw(KEY, '$.system_prompt'))
    const page = createInstructionTextPages(explicit, { reservedBytes: 1024 }).page()
    expect(page.text).toBe(prompt); expect(JSON.stringify(page)).not.toContain(explicit.promptPreimage!)
  })

  it('keeps the exact read-byte boundary atomic and omits prompt commands when prompt is disabled', async () => {
    const exact = '🌊'.repeat(INSTRUCTION_LIMITS.readSnapshotBytes / 4)
    await seedInstructions('agent', { system_prompt: exact })
    let calls = await jsonCommandCalls()
    const readable = await boundedInstructions({ includeText: false })
    const boundedCalls = await jsonCommandCalls() - calls
    expect(readable.customPrompt).toEqual({ stored: 'set', codeUnits: exact.length, utf8Bytes: INSTRUCTION_LIMITS.readSnapshotBytes, read: 'available' })
    await redis.json.set(KEY, '$.system_prompt', `${exact}x`)
    calls = await jsonCommandCalls()
    const oversizeTypesBefore = await jsonCommandCalls('type'), oversizeLengthsBefore = await jsonCommandCalls('strlen')
    const oversize = await boundedInstructions({ includeText: true })
    const oversizeCalls = await jsonCommandCalls() - calls
    const oversizeTypes = await jsonCommandCalls('type') - oversizeTypesBefore, oversizeLengths = await jsonCommandCalls('strlen') - oversizeLengthsBefore
    expect(oversize.customPrompt).toEqual({ stored: 'set', codeUnits: null, utf8Bytes: INSTRUCTION_LIMITS.readSnapshotBytes + 1, read: 'too_large' })
    expect(oversize.text).toBeUndefined(); expect(oversize.promptPreimage).toBeUndefined()
    expect(oversize.raw.some(([path]) => path === '$.system_prompt')).toBe(false)
    expect(boundedCalls).toBe(oversizeCalls + 1)
    calls = await jsonCommandCalls()
    const disabledTypesBefore = await jsonCommandCalls('type'), disabledLengthsBefore = await jsonCommandCalls('strlen')
    const disabled = await boundedInstructions({ includeText: false, prompt: false })
    expect(await jsonCommandCalls() - calls).toBe(oversizeCalls)
    expect(await jsonCommandCalls('type') - disabledTypesBefore).toBe(oversizeTypes - 1)
    expect(await jsonCommandCalls('strlen') - disabledLengthsBefore).toBe(oversizeLengths - 1)
    expect(disabled.customPrompt).toBeUndefined(); expect(disabled.text).toBeUndefined(); expect(disabled.promptPreimage).toBeUndefined()
    expect(disabled.raw.some(([path]) => path === '$.system_prompt')).toBe(false)
  })

  it('does not pull malformed large prompt, inclusion or identity values through raw JSON reads', async () => {
    await seedInstructions('agent', { system_prompt: { nested: 'x'.repeat(INSTRUCTION_LIMITS.readSnapshotBytes + 1) }, include_global_prompt: 'x'.repeat(INSTRUCTION_LIMITS.readSnapshotBytes + 1) })
    let calls = await jsonCommandCalls()
    const invalid = await boundedInstructions({ includeText: false })
    expect(await jsonCommandCalls() - calls).toBe(4)
    expect(invalid.customPrompt).toMatchObject({ stored: 'invalid', read: 'unavailable' })
    expect(invalid.record.include_global_prompt).toEqual({ invalid: true })
    expect(invalid.raw.some(([path]) => path === '$.system_prompt' || path === '$.include_global_prompt')).toBe(false)
    await redis.json.set(KEY, '$.id', 'x'.repeat(1025))
    calls = await jsonCommandCalls()
    await expect(boundedInstructions({ includeText: true })).rejects.toThrow('instruction_text_unavailable')
    // The other three fixed metadata strings are bounded; the oversized identity is never fetched.
    expect(await jsonCommandCalls() - calls).toBe(3)
  })

  it('requires each named ordinary writer base and refuses stale leaves without sibling or index effects', async () => {
    for (const kind of INSTRUCTION_KINDS) {
      await seedInstructions(kind)
      const base = await instructionsBase(kind), original = await instructionRecord(kind), index = await redis.sMembers(instructionIndex(kind))
      await expect(saveInstructions(kind, { system_prompt: 'no base', displayName: 'No partial name' })).rejects.toMatchObject({ status: 400, code: 'instructions_base_required' })
      await expect(saveInstructions(kind, { include_global_prompt: true }, { customPrompt: base.revisions.customPrompt })).rejects.toMatchObject({ status: 400, code: 'instructions_base_required' })
      expect(await instructionRecord(kind)).toEqual(original)
      await redis.json.set(instructionKey(kind), '$.system_prompt', 'Concurrent saved instructions')
      const changed = await instructionRecord(kind)
      await expect(saveInstructions(kind, { system_prompt: 'stale', displayName: 'No partial name' }, { customPrompt: base.revisions.customPrompt }))
        .rejects.toMatchObject({ status: 409, code: 'instructions_settings_changed' })
      expect(await instructionRecord(kind)).toEqual(changed)
      expect((await redis.sMembers(instructionIndex(kind))).sort()).toEqual(index.sort())
      expect(changed.updated_at).toBe(STAMP)
      const inclusion = await instructionsBase(kind, ['includeGlobalPrompt'])
      await redis.json.set(instructionKey(kind), '$.include_global_prompt', true)
      const inclusionChanged = await instructionRecord(kind)
      await expect(saveInstructions(kind, { include_global_prompt: false, displayName: 'No partial name' }, inclusion.revisions))
        .rejects.toMatchObject({ status: 409, code: 'instructions_settings_changed' })
      expect(await instructionRecord(kind)).toEqual(inclusionChanged)
      expect((await redis.sMembers(instructionIndex(kind))).sort()).toEqual(index.sort())
    }
  })

  it('holds only requested leaves so unrelated custom text and inclusion changes both survive', async () => {
    for (const kind of INSTRUCTION_KINDS) {
      await seedInstructions(kind)
      const inclusion = await instructionsBase(kind, ['includeGlobalPrompt'])
      expect(inclusion.paths).not.toContain('$.system_prompt'); expect(inclusion.revisions.customPrompt).toBeUndefined()
      await redis.json.set(instructionKey(kind), '$.system_prompt', 'New unrelated custom text')
      await saveInstructions(kind, { include_global_prompt: true }, inclusion.revisions)
      expect(await instructionRecord(kind)).toMatchObject({ system_prompt: 'New unrelated custom text', include_global_prompt: true })
      const custom = await instructionsBase(kind, ['customPrompt'])
      expect(custom.paths).not.toContain('$.include_global_prompt'); expect(custom.revisions.includeGlobalPrompt).toBeUndefined()
      await redis.json.set(instructionKey(kind), '$.include_global_prompt', false)
      await saveInstructions(kind, { system_prompt: 'Next custom text' }, custom.revisions)
      expect(await instructionRecord(kind)).toMatchObject({ system_prompt: 'Next custom text', include_global_prompt: false,
        provider_specific_settings: { nativeTools: { bashAccessMode: 'plan' } } })
    }
  })

  it('preserves Primary absent/null/URL storage and Subagent trimmed/delete/null inclusion rules', async () => {
    await seedInstructions('agent')
    await redis.execute(client => client.sendCommand(['JSON.DEL', KEY, '$.system_prompt']))
    const absent = await instructionsBase('agent', ['customPrompt'])
    expect(absent.raw[absent.paths.indexOf('$.system_prompt')]).toBe('[]')
    await saveInstructions('agent', { system_prompt: null }, absent.revisions)
    const nulled = await instructionsBase('agent', ['customPrompt'])
    expect(nulled.raw[nulled.paths.indexOf('$.system_prompt')]).toBe('[null]')
    expect(nulled.revisions.customPrompt).not.toBe(absent.revisions.customPrompt)
    const url = 'https://fixture.invalid/uploads/a6/instructions.txt?source=fixture#part'
    await saveInstructions('agent', { system_prompt: url }, nulled.revisions)
    expect((await instructionRecord('agent')).system_prompt).toBe('/uploads/a6/instructions.txt?source=fixture#part')
    const primaryInclusion = await instructionsBase('agent', ['includeGlobalPrompt'])
    await saveInstructions('agent', { include_global_prompt: null }, primaryInclusion.revisions)
    expect((await instructionRecord('agent')).include_global_prompt).toBeNull()
    await seedInstructions('subagent')
    const entry = { subject: { kind: 'subagent' as const, id: SUB_ID }, status: 'available' as const, type: 'api' as const }
    let base = await instructionsBase('subagent')
    const plan = planInstructionsChanges(entry, base.record, { customPrompt: '  trimmed custom\n ', includeGlobalPrompt: null })
    await saveInstructions('subagent', { ...plan.updates }, base.revisions)
    expect(await instructionRecord('subagent')).toMatchObject({ system_prompt: 'trimmed custom', include_global_prompt: null })
    base = await instructionsBase('subagent', ['customPrompt'])
    const writes = buildSubagentWrites({ body: { system_prompt: ' \n ' }, nextType: 'api' })
    await saveInstructions('subagent', writes, base.revisions)
    expect(await instructionRecord('subagent')).not.toHaveProperty('system_prompt')
    expect((await instructionRecord('subagent')).include_global_prompt).toBeNull()
  })

  it('rechecks named raw leaves inside each final actual EVAL before any sibling or timestamp op', async () => {
    for (const kind of INSTRUCTION_KINDS) {
      for (const leaf of ['customPrompt', 'includeGlobalPrompt'] as const) {
        await seedInstructions(kind)
        const base = await instructionsBase(kind, [leaf]), client = await redis.execute(async value => value), actual = client.eval.bind(client)
        const original = await instructionRecord(kind), index = await redis.sMembers(instructionIndex(kind))
        const field = leaf === 'customPrompt' ? 'system_prompt' : 'include_global_prompt', concurrent = leaf === 'customPrompt' ? 'Changed at physical issue' : true
        let intercepted = false
        const spy = vi.spyOn(client, 'eval').mockImplementation((async (script: string, options: any) => {
          if (!intercepted && options.keys[0] === instructionKey(kind) && script.includes('local namesInstructions = false')) {
            intercepted = true
            await client.sendCommand(['JSON.SET', instructionKey(kind), `$.${field}`, JSON.stringify(concurrent)])
          }
          return actual(script, options)
        }) as never)
        try {
          await expect(saveInstructions(kind, { [field]: leaf === 'customPrompt' ? 'Must refuse' : true, displayName: 'No partial sibling' }, base.revisions))
            .rejects.toMatchObject({ status: 409, code: 'instructions_settings_changed' })
        } finally { spy.mockRestore() }
        expect(intercepted).toBe(true)
        expect(await instructionRecord(kind)).toEqual({ ...original, [field]: concurrent })
        expect((await redis.sMembers(instructionIndex(kind))).sort()).toEqual(index.sort())
        await expect(withSettingsRecordReplacement(instructionKey(kind), async () => 'known refusal settled')).resolves.toBe('known refusal settled')
      }
    }
  })

  it('refuses original instruction bases after identical same-ID replacement and restore lifecycle changes', async () => {
    for (const kind of INSTRUCTION_KINDS) {
      await seedInstructions(kind)
      let base = await instructionsBase(kind, ['customPrompt'])
      const original = await instructionRecord(kind)
      await withSettingsRecordReplacement(instructionKey(kind), async () => { await redis.json.set(instructionKey(kind), '$', original) })
      await expect(saveInstructions(kind, { system_prompt: 'stale incarnation' }, base.revisions)).rejects.toMatchObject({ status: 409, code: 'instructions_settings_changed' })
      expect(await instructionRecord(kind)).toEqual(original)
      base = await instructionsBase(kind, ['customPrompt'])
      await withSettingsRestoreFence(async () => {})
      await expect(saveInstructions(kind, { system_prompt: 'stale restore' }, base.revisions)).rejects.toMatchObject({ status: 409, code: 'instructions_settings_changed' })
      expect(await instructionRecord(kind)).toEqual(original)
    }
  })

  it('keeps report-projection model raw guards/revisions identical while excluding an oversized prompt and the root GET', async () => {
    const oversized = '🌊'.repeat(INSTRUCTION_LIMITS.readSnapshotBytes / 4 + 1)
    await seedInstructions('agent', { system_prompt: oversized, unrelated_text: 'private-bystander',
      primary_model_provider: 'anthropic', primary_model_name: 'fixture-model', primary_model_preset_id: null,
      provider_specific_settings: { temperature: 0, top_p: 0.5, nativeTools: { bashAccessMode: 'plan' } } })
    const lifecycle = captureSettingsLifecycle([KEY])
    const beforeCalls = await jsonCommandCalls()
    const full = await redis.execute(client => readModelSelectionSnapshot(client, ID, 'agent', lifecycle, ['$.displayName']))
    const betweenCalls = await jsonCommandCalls()
    const projection = await redis.execute(client => readModelSelectionSnapshot(client, ID, 'agent', lifecycle, ['$.displayName'], { reportProjection: true }))
    const afterCalls = await jsonCommandCalls()
    expect(beforeCalls).toBeLessThan(betweenCalls)
    expect(betweenCalls - beforeCalls).toBe(afterCalls - betweenCalls + 1)
    expect(projection.paths).toEqual(full.paths); expect(projection.raw).toEqual(full.raw); expect(projection.providerKeys).toEqual(full.providerKeys)
    expect(projection.revision).toBe(full.revision); expect(projection.extraRaw).toEqual(full.extraRaw)
    expect(full.record.system_prompt).toBe(oversized)
    expect(projection.record).not.toHaveProperty('system_prompt'); expect(projection.record).not.toHaveProperty('unrelated_text'); expect(projection.record).not.toHaveProperty('displayName')
    expect(projection.record.provider_specific_settings).toEqual({ temperature: 0, top_p: 0.5 })
    expect(projection.providerKeys).toEqual(['temperature', 'top_p'])
    expect(JSON.stringify(projection)).not.toContain('private-bystander'); expect(JSON.stringify(projection)).not.toContain(oversized)
    expect(projection.paths).not.toContain('$.system_prompt'); expect(projection.paths).not.toContain('$')
  })
})


describe.runIf(REAL)('A7 fixed common Auto Compact actual Redis owner', () => {
  afterEach(async () => { if (admission.isAdmitted()) { await redis.del(KEY); await redis.del(`user:${USER}:settings`) } })
  const entry = { subject: { kind: 'primary' as const, id: ID }, status: 'available' as const, type: 'api' as const }
  const snapshot = () => redis.execute(client => readAutoCompactSnapshot(client, ID, USER))
  async function managed(before: AutoCompactSnapshot, changes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const plan = planAutoCompactChanges(entry, before.record, changes)
    await redis.updateAgent(ID, {}, { expectedAutoCompact: before.revision, autoCompactMutation: { target: before, changes: plan.changes,
      globalFields: plan.globalFields, check() { admission.requireAdmission() }, signal: new AbortController().signal, deadlineAt: Date.now()+5000,
      authority: { key: KEY, paths: [['$.user_id', JSON.stringify([USER])]] }, ...extra } })
  }
  it('A7 bounds malformed common leaves and never pulls advanced siblings into its snapshot', async () => {
    await seed(undefined, { auto_compact_settings: { mode: 'ask', triggerMode: 'smart', remainingTokens: null, prompt: 'SECRET'.repeat(200000), future: { keep: true } } })
    const before = await snapshot()
    expect(JSON.stringify(before)).not.toContain('SECRET'); expect(JSON.stringify(before)).not.toContain('future')
    await redis.json.set(KEY, '$.auto_compact_settings.mode', 'x'.repeat(200000))
    const invalid = await snapshot()
    expect(JSON.stringify(invalid).length).toBeLessThan(10000)
    expect(() => planAutoCompactChanges(entry, invalid.record, { mode: 'off' })).toThrow()
  })
  it('A7 writes requested children only and preserves advanced/unknown siblings and null storage', async () => {
    const advanced = { modelMode: 'preset', modelPresetId: 'retained', promptMode: 'custom', prompt: 'private exact', future: { keep: ['raw'] } }
    await seed(undefined, { auto_compact_settings: { ...advanced, mode: 'ask', triggerMode: 'remaining_tokens', remainingTokens: 2500 } })
    await managed(await snapshot(), { remainingTokens: null })
    expect((await record()).auto_compact_settings).toEqual({ ...advanced, mode: 'ask', triggerMode: 'remaining_tokens', remainingTokens: null })
    await redis.json.set(KEY, '$.auto_compact_settings', null)
    await managed(await snapshot(), { mode: 'off' })
    expect((await record()).auto_compact_settings).toEqual({ mode: 'off' })
  })
  it('A7 requires the original human group base and rejects stale whole-block interleavings before any write', async () => {
    await seed(undefined, { auto_compact_settings: { mode: 'ask', prompt: 'old advanced' } })
    const before = await snapshot(), original = await redis.json.getRaw(KEY, '$')
    await expect(redis.updateAgent(ID, { auto_compact_settings: { mode: 'off' } } as never)).rejects.toMatchObject({ status: 400, code: 'auto_compact_base_required' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(original)
    await managed(before, { mode: 'auto' })
    await expect(redis.updateAgent(ID, { displayName: 'must not change', auto_compact_settings: { mode: 'ask', prompt: 'dirty advanced' } } as never,
      { expectedAutoCompact: before.revision })).rejects.toMatchObject({ status: 409, code: 'auto_compact_settings_changed' })
    expect((await record()).displayName).toBe('Probe'); expect((await record()).auto_compact_settings).toEqual({ mode: 'auto', prompt: 'old advanced' })
    const fresh = await snapshot()
    await redis.updateAgent(ID, { auto_compact_settings: { mode: 'auto', prompt: 'human new advanced' } } as never, { expectedAutoCompact: fresh.revision })
    expect((await record()).auto_compact_settings.prompt).toBe('human new advanced')
  })
  it('A7 final script compares inherited globals but ignores unused advanced and explicit global dependencies', async () => {
    await seed(undefined, { auto_compact_settings: { mode: 'inherit', triggerMode: 'inherit' } })
    await redis.json.set(`user:${USER}:settings`, '$', { global_auto_compact_settings: { mode: 'ask', triggerMode: 'remaining_tokens', remainingTokens: 4000, prompt: 'global private' } })
    const before = await snapshot()
    await redis.json.set(`user:${USER}:settings`, '$.global_auto_compact_settings.remainingTokens', 5000)
    await expect(managed(before, { mode: 'auto' })).rejects.toMatchObject({ code: 'auto_compact_settings_changed' })
    expect((await record()).auto_compact_settings.mode).toBe('inherit')
    const current = await snapshot()
    await redis.json.set(`user:${USER}:settings`, '$.global_auto_compact_settings.prompt', 'unrelated global prompt')
    await managed(current, { mode: 'off', triggerMode: 'smart' })
    const explicit = await snapshot()
    await redis.json.set(`user:${USER}:settings`, '$.global_auto_compact_settings.remainingTokens', 6000)
    await managed(explicit, { mode: 'ask' })
    expect((await record()).auto_compact_settings).toMatchObject({ mode: 'ask', triggerMode: 'smart' })
  })
  it('A7 original lifecycle, physical deadline and current Stop refuse without known-save callbacks', async () => {
    await seed(undefined, { auto_compact_settings: { mode: 'ask' } })
    const before = await snapshot(), saved = vi.fn(), raw = await redis.json.getRaw(KEY, '$')
    await expect(managed(before, { mode: 'auto' }, { deadlineAt: Date.now()-1, onSaved: saved })).rejects.toMatchObject({ code: 'auto_compact_settings_changed' })
    const stopped = new AbortController(); stopped.abort()
    await expect(managed(before, { mode: 'auto' }, { signal: stopped.signal, onSaved: saved })).rejects.toMatchObject({ code: 'auto_compact_settings_changed' })
    await withSettingsRecordReplacement(KEY, async () => {})
    await expect(managed(before, { mode: 'auto' }, { onSaved: saved })).rejects.toThrow()
    expect(saved).not.toHaveBeenCalled(); expect(await redis.json.getRaw(KEY, '$')).toBe(raw)
  })
  it('A7 final physical EVAL refuses an authority race and Redis-time expiry after client admission', async () => {
    await seed(undefined, { auto_compact_settings: { mode: 'ask' } })
    const actor = 'agent:a7_physical_actor', client = await redis.execute(async value => value)
    await redis.json.set(actor, '$', { generation: 1 })
    const before = await snapshot(), original = await redis.json.getRaw(KEY, '$'), onSaved = vi.fn()
    const actualAbort = client.withAbortSignal.bind(client)
    let raced = false
    const race = vi.spyOn(client, 'withAbortSignal').mockImplementation(((signal: AbortSignal) => {
      const command = actualAbort(signal)
      return { eval: async (script: string, options: any) => {
        if (!raced && script.includes('local guard = ARGV[5]')) { raced = true; await client.json.set(actor, '$.generation', 2) }
        return command.eval(script, options)
      } }
    }) as never)
    try { await expect(managed(before, { mode: 'auto' }, { authority: { key: actor, paths: [['$.generation', '[1]']] }, onSaved })).rejects.toMatchObject({ code: 'auto_compact_settings_changed' }) }
    finally { race.mockRestore() }
    expect(raced).toBe(true); expect(onSaved).not.toHaveBeenCalled(); expect(await redis.json.getRaw(KEY, '$')).toBe(original)
    let delayed = false
    const late = vi.spyOn(client, 'withAbortSignal').mockImplementation(((signal: AbortSignal) => {
      const command = actualAbort(signal)
      return { eval: async (script: string, options: any) => {
        if (!delayed && script.includes('local guard = ARGV[5]')) { delayed = true; await new Promise(resolve => setTimeout(resolve, 75)) }
        return command.eval(script, options)
      } }
    }) as never)
    try { await expect(managed(before, { mode: 'auto' }, { deadlineAt: Date.now()+50, authority: { key: actor, paths: [['$.generation', '[2]']] }, onSaved })).rejects.toMatchObject({ code: 'auto_compact_settings_changed' }) }
    finally { late.mockRestore(); await redis.del(actor) }
    expect(delayed).toBe(true); expect(onSaved).not.toHaveBeenCalled(); expect(await redis.json.getRaw(KEY, '$')).toBe(original)
  })

})

// Actual fixed target EVAL/JSON ACK proof under the SAME strict pre-cleanup
// admission. Fixture authority below is not route consent or a P5 certificate.
describe.runIf(REAL)('MCP prerequisite fixed target storage owner', () => {
  afterEach(async () => {
    if (!admission.isAdmitted()) return
    for (const key of [KEY, `mcp_gateways:${USER}`, `mcp_test_reference:${USER}`, `user:${USER}:settings`]) await redis.del(key)
  })
  async function mcpFixture() {
    await seed(undefined, { created_at: STAMP, defaultMCPGateways: ['A'], default_mcp_gateways: ['inactive'],
      custom_tool_settings: [{ tool_name: 'remote_tool', buffer_size: 8, auto_zip: true, future: { keep: true } },
        { tool_name: 'unrelated', buffer_size: 0, zip_threshold: 9, auto_zip: false }], buffer_size: 20 })
    const sourceKey = `mcp_gateways:${USER}`, keyRef = `mcp_test_reference:${USER}`, globalKey = `user:${USER}:settings`
    await redis.json.set(sourceKey, '$', { gateways: [{ id: 'C', type: 'custom', name: 'Source', slug: 'source', url: 'https://source.example/mcp', enabled: true, created_at: STAMP }] })
    await redis.json.set(keyRef, '$', { encrypted: 'fixture-encrypted-raw', iv: 'i', authTag: 't' })
    await redis.json.set(globalKey, '$', { global_zip_settings: { zip_threshold: 77, auto_zip_all_other_tools: false }, sibling: 'keep' })
    const policy = defaultAppActionsPolicy(); policy.enabled = true; policy.management.mcpManagement = 'allow'; policy.protected.contextManagement = 'allow'
    await redis.json.set(KEY, '$.app_action_policy', { generation: 1, policy })
    const raw = await redis.json.getRaw(KEY, '$.app_action_policy'), keyRaw = await redis.json.getRaw(keyRef, '$'), sourceRaw = await redis.json.getRaw(sourceKey, '$.gateways[0]')
    if (!raw || !keyRaw || !sourceRaw) throw new Error('The owned MCP fixture cuts are unavailable.')
    const stop = new AbortController()
    const adapter: AdapterContext = { admission: { actor: { userId: USER, kind: 'native', id: ID, generation: 1, label: 'Fixture Primary' }, policy,
      fence: { key: KEY, paths: [['$.app_action_policy', raw]], lifecycle: captureSettingsLifecycle([KEY]) }, signal: stop.signal },
      signal: stop.signal, deadlineAt: Date.now() + 10000, assertCurrent() { admission.requireAdmission(); stop.signal.throwIfAborted() }, async refreshAuthority() {} }
    const fences = [{ key: keyRef, paths: [['$', keyRaw] as const] }, { key: sourceKey, paths: [['$.gateways[0]', sourceRaw] as const] }]
    return { adapter, sourceKey, keyRef, globalKey, fences, stop }
  }
  it('uses actual ACK postimages, preserving membership and row siblings plus false/zero', async () => {
    const f = await mcpFixture(), before = await store.readMcpTarget!(USER, { kind: 'primary', id: ID }, 'remote_tool')
    const plan = planMcpTarget(before, { subject: { kind: 'primary', id: ID }, gatewayId: 'C', membership: 'enable', zip: { toolName: 'remote_tool', autoZip: false, zipThreshold: 0 } })
    const onSaved = vi.fn(), beforeIssue = vi.fn()
    const ack = await store.writeMcpTarget!(plan, f.adapter, f.fences, { gatewayId: 'C', createdAt: STAMP }, beforeIssue, onSaved)
    expect(beforeIssue).toHaveBeenCalledOnce(); expect(onSaved).toHaveBeenCalledWith(ack, 'saved')
    expect(store.readMcpTargetResult!(ack).raw).toEqual((await store.readMcpTarget!(USER, plan.subject, 'remote_tool')).raw)
    expect(await record()).toMatchObject({ defaultMCPGateways: ['A','C'], default_mcp_gateways: ['inactive'], custom_tool_settings: [
      { tool_name: 'remote_tool', buffer_size: 8, zip_threshold: 0, auto_zip: false, future: { keep: true } }, { tool_name: 'unrelated', buffer_size: 0, zip_threshold: 9, auto_zip: false }],
      provider_specific_settings: { nativeTools: { bashAccessMode: 'plan' } } })
    expect(await redis.json.get(f.globalKey)).toMatchObject({ sibling: 'keep', global_zip_settings: { zip_threshold: 77 } })
    expect(() => store.readMcpTargetResult!(structuredClone(ack))).toThrow('actual MCP target acknowledgement')
    await expect(store.writeMcpTarget!(structuredClone(plan), f.adapter, f.fences, { gatewayId: 'C', createdAt: STAMP }, () => {}, () => {})).rejects.toThrow('held MCP target')
  })
  it('retains a real known target save when the SAME EVAL postimage exceeds the readable bound', async () => {
    const f = await mcpFixture()
    // Preimage is readable. Adding the requested row makes the actual EVAL's
    // returned row array too large; no ACK or postimage is manufactured here.
    await redis.json.set(KEY, '$.custom_tool_settings', [{ tool_name: 'unrelated', future: 'x'.repeat(262080) }])
    const before = await store.readMcpTarget!(USER, { kind: 'primary', id: ID }, 'remote_tool')
    const plan = planMcpTarget(before, { subject: { kind: 'primary', id: ID }, gatewayId: 'C', membership: 'enable', zip: { toolName: 'remote_tool', autoZip: false, zipThreshold: 0 } })
    const onSaved = vi.fn(), refused = vi.fn()
    await expect(store.writeMcpTarget!(plan, f.adapter, f.fences, { gatewayId: 'C', createdAt: STAMP }, () => {}, onSaved, refused)).rejects.toThrow('acknowledged but its postimage is unavailable')
    expect(onSaved).toHaveBeenCalledWith(undefined, 'saved'); expect(refused).not.toHaveBeenCalled()
    expect((await record()).defaultMCPGateways).toEqual(['A','C'])
    expect((await record()).custom_tool_settings).toContainEqual({ tool_name: 'remote_tool', auto_zip: false, zip_threshold: 0 })
    await expect(withSettingsRecordReplacement(KEY, async () => 'settled-known-target')).resolves.toBe('settled-known-target')
  })
  it.each(['target-sibling','source','key','policy','global'] as const)('refuses a real %s race with no partial target/timestamp writes', async race => {
    const f = await mcpFixture(), before = await store.readMcpTarget!(USER, { kind: 'primary', id: ID }, 'remote_tool')
    const plan = planMcpTarget(before, { subject: { kind: 'primary', id: ID }, gatewayId: 'C', membership: 'enable', zip: { toolName: 'remote_tool', mode: 'auto' } })
    if (race === 'target-sibling') await redis.json.set(KEY, '$.custom_tool_settings[1].zip_threshold', 123)
    if (race === 'source') await redis.json.set(f.sourceKey, '$.gateways[0].url', 'https://changed.example/mcp')
    if (race === 'key') await redis.json.set(f.keyRef, '$.encrypted', 'changed-raw')
    if (race === 'policy') await redis.json.set(KEY, '$.app_action_policy.generation', 2)
    if (race === 'global') await redis.json.set(f.globalKey, '$.global_zip_settings.zip_threshold', 78)
    const unchanged = await record(), onSaved = vi.fn(), refused = vi.fn()
    await expect(store.writeMcpTarget!(plan, f.adapter, f.fences, { gatewayId: 'C', createdAt: STAMP }, () => {}, onSaved, refused)).rejects.toThrow('mcp_target_conflict')
    expect(onSaved).not.toHaveBeenCalled(); expect(refused).toHaveBeenCalledOnce(); expect(await record()).toEqual(unchanged)
  })
  it('refuses an unrepresentable unowned row sibling instead of rounding it in a whole-array update', async () => {
    await mcpFixture()
    const literal = '[{"tool_name":"remote_tool","auto_zip":false,"unowned_large":9007199254740993},{"tool_name":"sibling","keep":true}]'
    await redis.execute(client => client.sendCommand(['JSON.SET', KEY, '$.custom_tool_settings', literal]))
    const original = await redis.json.getRaw(KEY, '$.custom_tool_settings')
    const before = await store.readMcpTarget!(USER, { kind: 'primary', id: ID }, 'remote_tool')
    expect(() => planMcpTarget(before, { subject: { kind: 'primary', id: ID }, gatewayId: 'C', membership: 'enable', zip: { toolName: 'remote_tool', autoZip: true } })).toThrow('literal representation')
    expect(await redis.json.getRaw(KEY, '$.custom_tool_settings')).toBe(original)
    expect((await record()).defaultMCPGateways).toEqual(['A'])
  })
  it('removes an absent source structurally and reports no-op without a dummy write', async () => {
    const f = await mcpFixture()
    await redis.del(f.sourceKey)
    const before = await store.readMcpTarget!(USER, { kind: 'primary', id: ID })
    const plan = planMcpTarget(before, { subject: { kind: 'primary', id: ID }, gatewayId: 'missing', membership: 'disable' })
    const original = await record(), observed = vi.fn()
    const ack = await store.writeMcpTarget!(plan, f.adapter, [], { gatewayId: 'missing', createdAt: null }, () => {}, observed)
    expect(observed).toHaveBeenCalledWith(ack, 'not_requested'); expect(await record()).toEqual(original)
    expect(store.readMcpTargetResult!(ack).saved).toBe('not_requested')
  })
})
