import { useOwnedRedisTestServer } from '$lib/test-utils/ownedRedisTestServer'
import { MCP_SETTINGS_FIELDS } from '$lib/utils/agentSettingsSectionSaves'
import { mcpSettingsReadPaths, makeMcpSettingsSnapshot } from '$lib/server/agentRecordUpdate'
import { instructionLeaves, readInstructionsSnapshot } from '$lib/server/instructionsGuard'
import { readInstructionsSnapshotTwin } from '$lib/test-utils/agentUpdateScriptTwin'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import { redis } from '$lib/server/redis'
import { buildAgentMemoryRecordFields, resolveAgentMemorySettingsDraft } from '$lib/utils/memoryControl'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
import { planAgentRecordUpdate } from '$lib/server/agentRecordUpdate'
import { agentTypeSnapshotOf, runAgentUpdateScriptTwin } from '$lib/test-utils/agentUpdateScriptTwin'
import { captureSettingsLifecycle, withSettingsRecordReplacement, withSettingsRestoreFence } from '$lib/server/services/appActions/settings/lifecycle'
import { namesModelSelection, readModelSelectionSnapshot } from '$lib/server/modelSelectionGuard'
import type { AgentUpdateOptions } from '$lib/server/agentRecordUpdate'
import { CONFIGURED_TTS_READ_PATHS, configuredTtsSnapshotFromDetail, readConfiguredTtsSnapshot } from '$lib/server/configuredTtsGuard'

/**
 * BL-768: `redis.updateAgent` writes only the fields its caller passed, each by path, in one step
 * inside Redis. It used to read the whole agent record, lay the update over it, and write the
 * whole record back in a second round trip, so two saves of one agent at the same moment (Agent
 * Settings and the chat bar's model picker, two tabs, `memoryRecall.ts`'s by-path stamp) took back
 * each other's fields with no word. `provider_specific_settings` is written key by key, and its
 * `nativeTools` field by field (BL-841).
 *
 * Real Redis 8 under `npm run test:redis` (a Lua script there); the default lane's fake twin under
 * plain `npm test`. The gap tests need the real client and run on the real lane only.
 */

// A present allocation, even empty/malformed, must use the strict owned-proof admission.
const strictAdmission = Object.hasOwn(process.env, 'SA122_SETTINGS_REDIS_ALLOCATION')
  ? createSettingsRedisAdmission(redis) : null
const admission = useOwnedRedisTestServer(redis, { beforeCleanupAdmission: strictAdmission?.beforeCleanupAdmission ?? (async ({ adminClient, resolvedUrl }) => {
  const database = Number(new URL(resolvedUrl).pathname.slice(1))
  expect(Number.isInteger(database) && database > 0).toBe(true)
  expect((await adminClient.clientInfo()).db).toBe(database)
}) })

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
afterAll(async () => {
  try {
    if (REAL && admission.isAdmitted()) {
      admission.requireAdmission()
      await redis.execute(client => client.del(['model:zaupd_preset_a', 'model:zaupd_preset_b', `user:${USER}:models`]))
    }
  } finally {
    if (strictAdmission) await strictAdmission.close()
    else if (REAL && !admission.ownedLane) await redis.disconnect()
  }
})
const USER = 'zaupd_user'
const AGENT = 'zaupd_agent'
const KEY = `agent:${AGENT}`
const OLD_STAMP = '2026-09-27T09:00:00.000Z'

async function seed(record: Record<string, unknown> = {}) {
  if (REAL) admission.requireAdmission()
  for (const id of ['zaupd_preset_a', 'zaupd_preset_b']) {
    await redis.json.set(`model:${id}`, '$', { id, modelName: id, modelId: id, provider: 'openai', settings: {},
      connection: { id: 'direct:openai', type: 'direct', service: 'openai' }, createdAt: OLD_STAMP, updatedAt: OLD_STAMP })
    await redis.sAdd(`user:${USER}:models`, id)
  }
  await redis.json.set(KEY, '$', {
    id: AGENT,
    user_id: USER,
    displayName: 'Probe',
    agentType: 'api',
    created_at: OLD_STAMP,
    updated_at: OLD_STAMP,
    primary_model_preset_id: 'zaupd_preset_a',
    primary_model_temperature: 1.2,
    provider_specific_settings: {
      temperature: 1.2,
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] }
    },
    ...record
  } as never)
}

/** A legitimate model save now carries the original atomic detail-read base (A3).
 * Capture once before entering the writer; the gap hooks below intercept only mutation EVALs. */
async function saveAgent(id: string, updates: Parameters<typeof redis.updateAgent>[1], options: AgentUpdateOptions = {}) {
  if (updates.voice_profile !== undefined && options.expectedTtsSelection === undefined) {
    const record = await redis.json.get(`agent:${id}`)
    const shown = REAL ? await redis.execute(client => readConfiguredTtsSnapshot(client, id)) :
      configuredTtsSnapshotFromDetail(id, record, CONFIGURED_TTS_READ_PATHS.map(path => agentTypeSnapshotOf(record, [path])), captureSettingsLifecycle([`agent:${id}`]))
    options = { ...options, expectedTtsSelection: shown.revision }
  }
  const leaves = instructionLeaves(updates as Record<string, unknown>)
  if (leaves.length && options.expectedInstructions === undefined) {
    const shown = REAL ? await redis.execute(client => readInstructionsSnapshot(client, id, 'agent', undefined, leaves)) :
      readInstructionsSnapshotTwin(id, 'agent', await redis.json.get(`agent:${id}`), captureSettingsLifecycle([`agent:${id}`]), leaves)
    options = { ...options, expectedInstructions: shown.revisions }
  }
  // SA-139 R5: a model save carries the API model-selection base only (the CLI native model
  // tokens went with the Claude Code CLI Subagent).
  if (REAL && options.expectedModelSelection === undefined && namesModelSelection('agent', updates as Record<string, unknown>)) {
    const shown = await redis.execute(client => readModelSelectionSnapshot(client, id, 'agent'))
    return redis.updateAgent(id, updates, { ...options, expectedModelSelection: shown.revision })
  }
  return redis.updateAgent(id, updates, options)
}

async function stored() {
  return (await redis.json.get(KEY)) as any
}

afterEach(async () => {
  vi.restoreAllMocks()
  if (!REAL || admission.isAdmitted()) await redis.del(KEY)
})

describe('BL-1702 immutable Primary record metadata', () => {
  it('the planner never emits metadata mutations while retaining the owned stamp and ordinary fields', () => {
    const now = '2026-10-18T12:00:00.000Z'
    const plan = planAgentRecordUpdate({ updates: {
      id: 'replacement-id', user_id: 'replacement-owner', created_at: '2099-01-01T00:00:00.000Z',
      updated_at: 'caller-stamp', displayName: 'Allowed rename'
    }, now })
    expect(plan.ops.filter(op => ['id', 'user_id', 'created_at'].includes(op.field))).toEqual([])
    expect(plan.ops).toContainEqual({ op: 'set', field: 'displayName', value: 'Allowed rename' })
    expect(plan.ops.filter(op => op.field === 'updated_at')).toEqual([{ op: 'set', field: 'updated_at', value: now }])
  })

  it.each([
    { id: 'replacement-id', user_id: 'replacement-owner', created_at: '2099-01-01T00:00:00.000Z' },
    { id: null, user_id: null, created_at: null }
  ])('the direct writer preserves metadata for attempted values %j and still saves an ordinary edit', async metadata => {
    await seed()
    const before = await stored()
    await redis.updateAgent(AGENT, { ...metadata, displayName: 'Allowed rename', updated_at: 'caller-stamp' } as never)
    const record = await stored()
    expect(record).toEqual({ ...before, displayName: 'Allowed rename', updated_at: expect.any(String) })
    expect(record.updated_at).not.toBe('caller-stamp')
    expect(record.updated_at).not.toBe(OLD_STAMP)
    expect(await redis.exists('agent:replacement-id')).toBe(false)
  })
})

describe('updateAgent writes only the fields it was given (BL-768)', () => {
  it('BL-1683 treats ordinary nullable cleanup differently from an explicit whole-voice delete', async () => {
    const voice = { tts: { providerId: 'browser', voiceId: 'system' }, stt: { future: [0] } }
    await seed({ voice_profile: voice })
    await saveAgent(AGENT, { displayName: 'Only this name' })
    expect((await stored()).voice_profile).toEqual(voice)
    await expect(redis.updateAgent(AGENT, { voice_profile: null } as never)).rejects.toMatchObject({ code: 'tts_selection_base_required' })
    await saveAgent(AGENT, { voice_profile: null } as never)
    expect((await stored()).voice_profile).toBeUndefined()
  })
  it('SA-132: concurrent reasoning leaves and unrelated agent settings survive; inherit removes only its leaf', async () => {
    await seed()
    const identity = { presetId: 'fixture', connection: { type: 'direct' as const, id: 'direct:openai', service: 'openai' }, effectiveModelId: 'gpt-6.1-sol' }
    const first = reasoningOverrideKey(identity, 'effort')
    const second = reasoningOverrideKey({ ...identity, presetId: 'another-preset' }, 'effort')
    await Promise.all([
      saveAgent(AGENT, { model_reasoning_overrides: { [first]: { mode: 'value', value: 'max' } } } as any),
      saveAgent(AGENT, { model_reasoning_overrides: { [second]: { mode: 'provider-default' } } } as any),
      saveAgent(AGENT, { displayName: 'Kept', provider_specific_settings: { 'openai.reasoningEffort': 'high' } } as any)
    ])
    expect((await stored()).model_reasoning_overrides).toEqual({ [first]: { mode: 'value', value: 'max' }, [second]: { mode: 'provider-default' } })
    expect((await stored()).provider_specific_settings).toMatchObject({ 'openai.reasoningEffort': 'high', nativeTools: { bashAccessMode: 'plan' } })
    await saveAgent(AGENT, { model_reasoning_overrides: { [first]: null } } as any)
    expect((await stored()).model_reasoning_overrides).toEqual({ [second]: { mode: 'provider-default' } })
    expect((await stored()).displayName).toBe('Kept')
  })

  it('SA-132: malformed identities and bulk edits are refused before any sibling write', async () => {
    await seed()
    const before = await stored()
    await expect(saveAgent(AGENT, { displayName: 'Must not land', model_reasoning_overrides: { unsafe: { mode: 'value', value: 'high' } } } as any)).rejects.toThrow(/identity/)
    expect(await stored()).toEqual(before)
  })
  it('writes the named fields and the stamp; every other field stays', async () => {
    await seed({ memory_last_interaction_at: '2026-09-27T10:00:00.000Z', voice_profile: { tts: { providerId: 'x' } } })

    await saveAgent(AGENT, { displayName: 'Renamed', system_prompt: 'Be brief.' } as any)

    const record = await stored()
    expect(record).toMatchObject({
      id: AGENT,
      user_id: USER,
      displayName: 'Renamed',
      system_prompt: 'Be brief.',
      agentType: 'api',
      created_at: OLD_STAMP,
      primary_model_preset_id: 'zaupd_preset_a',
      memory_last_interaction_at: '2026-09-27T10:00:00.000Z',
      voice_profile: { tts: { providerId: 'x' } }
    })
    expect(record.updated_at).not.toBe(OLD_STAMP)
  })

  it('writes provider_specific_settings key by key: a key not passed stays, a null key is removed', async () => {
    await seed()

    await saveAgent(AGENT, {
      provider_specific_settings: { temperature: null, reasoningEffort: 'low', 'openai.store': false }
    } as any)

    expect((await stored()).provider_specific_settings).toEqual({
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] },
      reasoningEffort: 'low',
      'openai.store': false
    })
  })

  it('makes provider_specific_settings an object first when it is missing or null', async () => {
    await seed({ provider_specific_settings: null })
    await saveAgent(AGENT, { provider_specific_settings: { claude_permission_mode: 'plan' } } as any)
    expect((await stored()).provider_specific_settings).toEqual({ claude_permission_mode: 'plan' })

    await seed({ provider_specific_settings: undefined })
    await saveAgent(AGENT, { provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } } } as any)
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: { bashAccessMode: 'agent' } })
  })

  it('writes nativeTools field by field: a field not named stays, a field named null is removed (BL-841)', async () => {
    await seed({ provider_specific_settings: { temperature: 1.2, nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'], webSearchProvider: 'exa', webSearchEnabled: true } } })
    const before = await stored()
    await expect(saveAgent(AGENT, { displayName: 'Must not land', provider_specific_settings: { nativeTools: { webSearchProvider: null } } } as any))
      .rejects.toMatchObject({ status: 400, message: 'webSearchProvider is now a global tool option in Admin. Nothing was saved.' })
    expect(await stored()).toEqual(before)

    await saveAgent(AGENT, {
      provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'git push --force'], executionBackend: 'docker', webSearchEnabled: null } }
    } as any)

    expect((await stored()).provider_specific_settings).toEqual({
      temperature: 1.2,
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *', 'git push --force'], executionBackend: 'docker', webSearchProvider: 'exa' }
    })
  })

  it('makes nativeTools an object first when it is missing or not an object; a save of removals only adds nothing', async () => {
    await seed({ provider_specific_settings: { temperature: 1.2 } })
    await saveAgent(AGENT, { provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } } } as any)
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 1.2, nativeTools: { bashAccessMode: 'agent' } })

    await seed({ provider_specific_settings: { nativeTools: 'not an object' } })
    await saveAgent(AGENT, { provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } } } as any)
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: { bashAccessMode: 'agent' } })

    await seed({ provider_specific_settings: { temperature: 1.2 } })
    await saveAgent(AGENT, { provider_specific_settings: { nativeTools: { bashNeverAllowList: null } } } as any)
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 1.2 })
  })

  it('the last field named null leaves an empty native block; its ancestor cannot erase explicit choices', async () => {
    await seed()
    await saveAgent(AGENT, { provider_specific_settings: { nativeTools: { bashAccessMode: null, bashNeverAllowList: null } } } as any)
    expect((await stored()).provider_specific_settings).toEqual({ temperature: 1.2, nativeTools: {} })

    const before = await stored()
    await expect(saveAgent(AGENT, { displayName: 'Must not land', provider_specific_settings: { nativeTools: null } } as any))
      .rejects.toMatchObject({ status: 400, message: 'Keep the explicit Typed File Tools choice; clear individual tool settings instead. Nothing was saved.' })
    expect(await stored()).toEqual(before)
  })

  it('a null on a nullable field removes it, and a nullable field stored as null goes too; others store null', async () => {
    await seed({ goon_id: null, description: 'kept?' })

    await saveAgent(AGENT, { primary_model_temperature: null, description: null } as any)

    const record = await stored()
    expect('primary_model_temperature' in record).toBe(false)
    expect('goon_id' in record).toBe(false)
    expect('description' in record).toBe(true)
    expect(record.description).toBeNull()
  })

  it('the whole provider block cannot erase explicit choices; named individual leaves still clear', async () => {
    await seed()
    const before = await stored()
    await expect(saveAgent(AGENT, { displayName: 'Must not land', provider_specific_settings: null } as any))
      .rejects.toMatchObject({ status: 400, message: 'Keep the explicit Typed File Tools choice; clear individual provider settings instead. Nothing was saved.' })
    expect(await stored()).toEqual(before)
    await saveAgent(AGENT, { provider_specific_settings: { temperature: null, nativeTools: { bashAccessMode: null, bashNeverAllowList: null } } } as any)
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: {} })
  })

  it('canonicalizes the type: writes agentType and removes the legacy type fields', async () => {
    await seed({ agentType: undefined, batshitMode: 'cli', mode: 'vercel-native', agent_type: 'batshit' })

    await saveAgent(AGENT, { displayName: 'Typed' } as any)

    const record = await stored()
    expect(record.agentType).toBe('cli')
    for (const legacy of ['batshitMode', 'batshit_mode', 'mode', 'agent_type', 'n8nImplementation']) {
      expect(legacy in record).toBe(false)
    }
  })

  it('stamps updated_at itself, over a value the caller passed', async () => {
    await seed()
    await saveAgent(AGENT, { updated_at: '2000-01-01T00:00:00.000Z' } as any)
    const stamp = (await stored()).updated_at
    expect(stamp).not.toBe('2000-01-01T00:00:00.000Z')
    expect(stamp).not.toBe(OLD_STAMP)
  })

  it('an agent that is gone: throws "Agent not found" and does not recreate it', async () => {
    await expect(saveAgent(AGENT, { displayName: 'Ghost' } as any)).rejects.toThrow('Agent not found')
    expect(await redis.exists(KEY)).toBe(false)
  })

  it('refuses a field name that is not an agent field name, writing nothing', async () => {
    await seed()
    await expect(saveAgent(AGENT, { 'provider_specific_settings.nativeTools': 1 } as any)).rejects.toThrow(
      'Not an agent field name'
    )
    expect((await stored()).updated_at).toBe(OLD_STAMP)
  })
})

// SA-139 R4: the BL-1542 first CLI model promotion of a Primary left with the Claude Code CLI
// Primary lane (`updateAgent` refuses a promotion guard); a CLI Subagent's promotion stays.

/** What Agent Settings sends as a memory save's base: the stored settings, as its form reads and writes them. */
function memoryBaseOf(record: unknown) {
  return buildAgentMemoryRecordFields(resolveAgentMemorySettingsDraft(record))
}

const MEMORY = {
  memory_enabled: true,
  memory_linger_turns: 2,
  memory_recall_linger_turns: 3,
  memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 300 }
}

describe('a save of the memory settings writes only while its base is what is saved (BL-1294)', () => {
  it('a base that matches: the whole memory group is written', async () => {
    await seed(MEMORY)
    const base = memoryBaseOf(await stored())

    await saveAgent(
      AGENT,
      { ...base, memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 350 } } as any,
      { expectedMemory: base }
    )

    const record = await stored()
    expect(record.memory_lane_budgets).toEqual({ on_my_mind: 100, triggers: 200, recalled: 350 })
    expect(record.updated_at).not.toBe(OLD_STAMP)
  })

  it('a base the agent changed meanwhile: a 409 memory_settings_changed, and nothing is written', async () => {
    await seed(MEMORY)
    const base = memoryBaseOf(await stored())
    // The agent saves its own On My Mind budget (App Actions writes it by path).
    await redis.json.set(KEY, '$.memory_lane_budgets.on_my_mind', 120 as never)

    await expect(
      saveAgent(
        AGENT,
        { ...base, memory_lane_budgets: { on_my_mind: 100, triggers: 200, recalled: 350 } } as any,
        { expectedMemory: base }
      )
    ).rejects.toMatchObject({ status: 409, code: 'memory_settings_changed' })

    const record = await stored()
    expect(record.memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 300 })
    expect(record.updated_at).toBe(OLD_STAMP)
  })

  it('compares by value: the older camelCase names, and absent fields, match the base the form built from them', async () => {
    await seed({ memoryLaneBudgets: { on_my_mind: 40, triggers: 50, recalled: 60 }, memoryLingerTurns: 4 })
    const base = memoryBaseOf(await stored())

    await saveAgent(AGENT, { ...base, memory_recall_linger_turns: 5 } as any, { expectedMemory: base })

    const record = await stored()
    expect(record.memory_recall_linger_turns).toBe(5)
    expect(record.memory_lane_budgets).toEqual({ on_my_mind: 40, triggers: 50, recalled: 60 })
  })

  it('a base that differs in a field the agent cannot write (memory on or off) is refused too', async () => {
    await seed(MEMORY)
    const base = memoryBaseOf(await stored())
    await redis.json.set(KEY, '$.memory_enabled', false as never)

    await expect(
      saveAgent(AGENT, { ...base, memory_linger_turns: 6 } as any, { expectedMemory: base })
    ).rejects.toMatchObject({ status: 409, code: 'memory_settings_changed' })
    expect((await stored()).memory_linger_turns).toBe(2)
  })

  it('the compare keeps every value the agent may write: no admitted value is clamped or defaulted into another', async () => {
    // The agent's owner admits integer budgets 0-20000 and linger turns 0-8 (validator and Lua). The
    // compare normalizes both sides through the form's resolvers; if their ranges ever differed, two
    // different stored values could compare equal and a stale group would pass.
    const { validateMemoryChanges } = await import('$lib/appActions/settings/validation')
    const { CONDITIONAL_SETTINGS_WRITE_SCRIPT } = await import('$lib/server/services/appActions/settings/conditionalAgentSettings')
    for (const value of [0, 1, 19_999, 20_000]) {
      expect(memoryBaseOf({ memory_lane_budgets: { on_my_mind: value, triggers: value, recalled: value } }).memory_lane_budgets)
        .toEqual({ on_my_mind: value, triggers: value, recalled: value })
      expect(validateMemoryChanges({ onMyMind: value, triggers: value, recalled: value })).toEqual({ onMyMind: value, triggers: value, recalled: value })
    }
    for (let value = 0; value <= 8; value += 1) {
      expect(memoryBaseOf({ memory_linger_turns: value, memory_recall_linger_turns: value })).toMatchObject({
        memory_linger_turns: value,
        memory_recall_linger_turns: value
      })
      expect(validateMemoryChanges({ triggerLingerTurns: value, recallLingerTurns: value })).toEqual({ triggerLingerTurns: value, recallLingerTurns: value })
    }
    expect(() => validateMemoryChanges({ onMyMind: 20_001 })).toThrow()
    expect(() => validateMemoryChanges({ triggerLingerTurns: 9 })).toThrow()
    expect(() => validateMemoryChanges({ recalled: -1 })).toThrow()
    expect(CONDITIONAL_SETTINGS_WRITE_SCRIPT).toContain("and 8 or 20000")
  })

  it('a save with no base is written as before: the memory guard is for memory saves only', async () => {
    await seed(MEMORY)
    await redis.json.set(KEY, '$.memory_lane_budgets.on_my_mind', 120 as never)

    await saveAgent(AGENT, { displayName: 'Renamed' } as any)

    const record = await stored()
    expect(record.displayName).toBe('Renamed')
    expect(record.memory_lane_budgets.on_my_mind).toBe(120)
  })
})

/**
 * Wrap the Redis client each `execute` hands out so that "another writer" changes the agent inside
 * updateAgent: right after its first read of the record (the old code's gap between its read and
 * its write), or else right before its script runs. It stamps a field by path (as
 * `memoryRecall.ts` does) and changes the Work mode inside `provider_specific_settings.nativeTools`.
 * Every whole-record write of the agent is counted.
 */
function interleaveAnotherWriter() {
  const execute = redis.execute.bind(redis)
  let wroteBetween = false
  const wholeRecordWrites: unknown[] = []
  vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
    execute(async (client: any) => {
      const writeBetween = async () => {
        if (wroteBetween) return
        wroteBetween = true
        await client.json.set(KEY, '$.memory_last_interaction_at', '2026-09-28T12:00:00.000Z')
        await client.json.set(KEY, '$.provider_specific_settings.nativeTools', {
          bashAccessMode: 'plan',
          bashNeverAllowList: ['rm -rf *', 'git push --force']
        })
      }
      const target = client.json
      // Empty proxy targets: the client's own properties are read-only, which a proxy may not change.
      const json = new Proxy({}, {
        get(_empty, property) {
          const value = Reflect.get(target, property)
          if (property === 'get') {
            return async (key: string, options?: unknown) => {
              const answer = await value.call(target, key, options)
              if (key === KEY) await writeBetween()
              return answer
            }
          }
          if (property === 'set') {
            return async (key: string, path: string, ...rest: unknown[]) => {
              if (key === KEY && path === '$') wholeRecordWrites.push(rest[0])
              return value.call(target, key, path, ...rest)
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const wrapped = new Proxy({}, {
        get(_empty, property) {
          if (property === 'json') return json
          if (property === 'eval') {
            return async (script: string, options: { keys?: string[] }) => {
              if (options?.keys?.[0] === KEY && script.includes('local guard = ARGV[5]')) await writeBetween()
              return client.eval(script, options)
            }
          }
          const value = Reflect.get(client, property)
          return typeof value === 'function' ? value.bind(client) : value
        }
      })
      return operation(wrapped)
    })) as any)
  return { wholeRecordWrites, wroteBetween: () => wroteBetween }
}

describe.skipIf(!REAL)('a change written while updateAgent runs survives (BL-768, real Redis)', () => {
  it("the chat bar's model pick keeps a Work-mode change and a stamp another writer made meanwhile", async () => {
    await seed()
    const probe = interleaveAnotherWriter()

    // What the chat-bar picker sends for a preset with no temperature.
    await saveAgent(AGENT, {
      primary_model_preset_id: 'zaupd_preset_b',
      primary_model_temperature: null,
      provider_specific_settings: { temperature: null }
    } as any)

    const record = await stored()
    expect(probe.wroteBetween()).toBe(true)
    expect(probe.wholeRecordWrites).toEqual([])
    expect(record.primary_model_preset_id).toBe('zaupd_preset_b')
    expect('primary_model_temperature' in record).toBe(false)
    expect(record.memory_last_interaction_at).toBe('2026-09-28T12:00:00.000Z')
    expect(record.provider_specific_settings).toEqual({
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *', 'git push --force'] }
    })
  })

  it('a never-allow list edit keeps a Work mode written into nativeTools meanwhile (BL-841)', async () => {
    await seed({ provider_specific_settings: { temperature: 1.2, nativeTools: { bashAccessMode: 'agent', bashNeverAllowList: ['rm -rf *'] } } })
    const execute = redis.execute.bind(redis)
    let wroteBetween = false
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      execute(async (client: any) => {
        const wrapped = new Proxy({}, {
          get(_empty, property) {
            if (property === 'eval') {
              return async (script: string, options: { keys?: string[] }) => {
                if (options?.keys?.[0] === KEY && !wroteBetween) {
                  wroteBetween = true
                  // The chat bar in another window switches to Plan, by path.
                  await client.json.set(KEY, '$.provider_specific_settings.nativeTools.bashAccessMode', 'plan')
                }
                return client.eval(script, options)
              }
            }
            const value = Reflect.get(client, property)
            return typeof value === 'function' ? value.bind(client) : value
          }
        })
        return operation(wrapped)
      })) as any)

    // What Agent Settings sends for a never-allow list edit (BL-841): only that field.
    await saveAgent(AGENT, {
      provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'git push --force'] } }
    } as any)

    expect(wroteBetween).toBe(true)
    expect((await stored()).provider_specific_settings).toEqual({
      temperature: 1.2,
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *', 'git push --force'] }
    })
  })

  it('an agent deleted after the read and before the script is not made again', async () => {
    await seed()
    const execute = redis.execute.bind(redis)
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      execute(async (client: any) => {
        const wrapped = new Proxy({}, {
          get(_empty, property) {
            if (property === 'eval') {
              return async (script: string, options: { keys?: string[] }) => {
                if (options?.keys?.[0] === KEY) await client.del(KEY)
                return client.eval(script, options)
              }
            }
            const value = Reflect.get(client, property)
            return typeof value === 'function' ? value.bind(client) : value
          }
        })
        return operation(wrapped)
      })) as any)

    await expect(saveAgent(AGENT, { displayName: 'Ghost' } as any)).rejects.toThrow('Agent not found')
    expect(await redis.exists(KEY)).toBe(false)
  })

  it('an Agent Settings save keeps a field another writer stamped meanwhile', async () => {
    await seed()
    const probe = interleaveAnotherWriter()

    await saveAgent(AGENT, { displayName: 'Saved from Settings', system_prompt: 'New prompt.' } as any)

    const record = await stored()
    expect(probe.wroteBetween()).toBe(true)
    expect(probe.wholeRecordWrites).toEqual([])
    expect(record.displayName).toBe('Saved from Settings')
    expect(record.memory_last_interaction_at).toBe('2026-09-28T12:00:00.000Z')
    expect(record.provider_specific_settings.nativeTools.bashNeverAllowList).toEqual(['rm -rf *', 'git push --force'])
  })
})

// Built from char codes: an escape typed into this file would land as the raw character.
const TAB = String.fromCharCode(9)
const LINE_BREAK = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)
const LONE_SURROGATE = String.fromCharCode(0xd800)
const NUL = String.fromCharCode(0)
const WHOLE_EMOJI = String.fromCodePoint(0x1f600)

/** Settings key names a user can type or paste as a Custom Parameter name. */
const ODD_KEYS = [
  'top_p.v2',
  'say "hi"',
  `path${BACKSLASH}to`,
  'arr[0]',
  'x]y',
  'two words',
  `tab${TAB}here`,
  `line${LINE_BREAK}break`,
  `quote${BACKSLASH}"mix`,
  '"]',
  `x${BACKSLASH}`,
  "']",
  '"].agentType["',
  `nul${NUL}char`,
  `smile${WHOLE_EMOJI}`,
  // An empty name: RedisJSON 8.10.1 takes `[""]` as a path like any other (see the test below).
  '',
  // A normal key, never the prototype (the twin used to set the prototype with it).
  '__proto__'
]

function nested(levels: number): unknown {
  let value: unknown = 1
  for (let level = 0; level < levels; level += 1) value = { a: value }
  return value
}

describe('a settings key with any characters is stored under its exact name (review item 2)', () => {
  it('writes and removes keys with a dot, a quote, a backslash, brackets, a space, a tab and a line break', async () => {
    await seed()

    await saveAgent(AGENT, {
      provider_specific_settings: Object.fromEntries(ODD_KEYS.map((key, index) => [key, index]))
    } as any)

    const record = await stored()
    const block = record.provider_specific_settings
    expect(Object.keys(block).sort()).toEqual(['nativeTools', 'temperature', ...ODD_KEYS].sort())
    ODD_KEYS.forEach((key, index) => {
      expect(Object.prototype.hasOwnProperty.call(block, key)).toBe(true)
      expect(block[key]).toBe(index)
    })
    // The injection-shaped name stayed a name: the type and every other field are as they were.
    expect(record.agentType).toBe('api')
    expect(record.displayName).toBe('Probe')

    await saveAgent(AGENT, {
      provider_specific_settings: Object.fromEntries(ODD_KEYS.map((key) => [key, null]))
    } as any)

    expect(Object.keys((await stored()).provider_specific_settings).sort()).toEqual(['nativeTools', 'temperature'])
  })
})

describe('an empty name is an ordinary name: RedisJSON 8.10.1 accepts ["" ] for set, type and delete (BL-860)', () => {
  it('writes and removes an empty key or entry id in every shape the plan builds, and the twin agrees', async () => {
    await seed({ claude_settings: { model: 'sonnet' }, dcmDisplaySettings: { version: 1, groups: { gw_a: 'hidden' } } })

    await saveAgent(AGENT, {
      provider_specific_settings: { '': 'p', nativeTools: { '': 'n' } },
      claude_settings: { '': 'c' },
      dcmDisplaySettings: { groups: { '': 'hidden' } }
    } as any)

    let record = await stored()
    expect(record.provider_specific_settings).toEqual({
      '': 'p',
      temperature: 1.2,
      nativeTools: { '': 'n', bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] }
    })
    expect(record.claude_settings).toEqual({ model: 'sonnet', '': 'c' })
    expect(record.dcmDisplaySettings).toEqual({ version: 1, groups: { gw_a: 'hidden', '': 'hidden' } })

    await saveAgent(AGENT, {
      provider_specific_settings: { '': null, nativeTools: { '': null } },
      claude_settings: { '': null },
      dcmDisplaySettings: { groups: { '': null } }
    } as any)

    record = await stored()
    expect(record.provider_specific_settings).toEqual({
      temperature: 1.2,
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] }
    })
    expect(record.claude_settings).toEqual({ model: 'sonnet' })
    expect(record.dcmDisplaySettings).toEqual({ version: 1, groups: { gw_a: 'hidden' } })
  })
})

describe('a nativeTools field with any characters is stored under its exact name (BL-841)', () => {
  it('writes and removes fields with a dot, a quote, a backslash, brackets and a line break', async () => {
    await seed()

    await saveAgent(AGENT, {
      provider_specific_settings: { nativeTools: Object.fromEntries(ODD_KEYS.map((key, index) => [key, index])) }
    } as any)

    const record = await stored()
    const nativeTools = record.provider_specific_settings.nativeTools
    expect(Object.keys(nativeTools).sort()).toEqual(['bashAccessMode', 'bashNeverAllowList', ...ODD_KEYS].sort())
    ODD_KEYS.forEach((key, index) => {
      expect(Object.prototype.hasOwnProperty.call(nativeTools, key)).toBe(true)
      expect(nativeTools[key]).toBe(index)
    })
    expect(record.agentType).toBe('api')
    expect(record.provider_specific_settings.temperature).toBe(1.2)

    await saveAgent(AGENT, {
      provider_specific_settings: { nativeTools: Object.fromEntries(ODD_KEYS.map((key) => [key, null])) }
    } as any)

    expect((await stored()).provider_specific_settings.nativeTools).toEqual({ bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] })
  })
})

/**
 * BL-848 and BL-855: `claude_settings` and `dcmDisplaySettings` are written field by field, each
 * key (and each entry of a `dcmDisplaySettings` map) at its own path, so two saves that each name
 * one key both survive. Before, each was written whole at `$.<field>`, and the save that landed
 * last took back the other's key.
 */
const CLAUDE_BLOCK = { model: 'sonnet', permissionMode: 'default', alwaysThinkingEnabled: false, addDirs: ['/a'] }
const DCM_BLOCK = {
  version: 1,
  groups: { gw_a: 'group-only', gw_b: 'hidden' },
  tools: { 'gw_a::read': 'name-only' },
  groupDisplayPreferences: { gw_a: 'group-only' },
  toolDisplayPreferences: { 'gw_a::read': 'name+hint' }
}
const BLOCKS_RECORD = { claude_settings: CLAUDE_BLOCK, dcmDisplaySettings: DCM_BLOCK }

/** Runs the two saves one after the other, in each order, from a fresh record; answers the block each order left. */
async function savesInBothOrders(
  field: string,
  saveA: Record<string, unknown>,
  saveB: Record<string, unknown>
): Promise<unknown[]> {
  const blocks: unknown[] = []
  for (const [first, second] of [[saveA, saveB], [saveB, saveA]]) {
    await seed(BLOCKS_RECORD)
    await saveAgent(AGENT, first as any)
    await saveAgent(AGENT, second as any)
    blocks.push((await stored())[field])
  }
  return blocks
}

describe('claude_settings and dcmDisplaySettings are written field by field (BL-848, BL-855)', () => {
  it('two saves that each name one claude_settings key both survive, in both orders', async () => {
    const [aThenB, bThenA] = await savesInBothOrders(
      'claude_settings',
      { claude_settings: { permissionMode: 'plan' } },
      { claude_settings: { model: 'opus' } }
    )
    const expected = { ...CLAUDE_BLOCK, permissionMode: 'plan', model: 'opus' }
    expect(aThenB).toEqual(expected)
    expect(bThenA).toEqual(expected)
  })

  it('two saves that each name one entry of a dcmDisplaySettings map both survive, in both orders', async () => {
    const [aThenB, bThenA] = await savesInBothOrders(
      'dcmDisplaySettings',
      { dcmDisplaySettings: { groups: { gw_a: 'hidden' }, tools: { 'gw_a::write': 'hidden' } } },
      { dcmDisplaySettings: { groups: { gw_c: 'group+tools+names' } } }
    )
    const expected = {
      ...DCM_BLOCK,
      groups: { gw_a: 'hidden', gw_b: 'hidden', gw_c: 'group+tools+names' },
      tools: { 'gw_a::read': 'name-only', 'gw_a::write': 'hidden' }
    }
    expect(aThenB).toEqual(expected)
    expect(bThenA).toEqual(expected)
  })

  it('a save of one field of the block leaves every other agent field, and the other block, as they were', async () => {
    await seed(BLOCKS_RECORD)
    await saveAgent(AGENT, { claude_settings: { model: 'opus' } } as any)
    const record = await stored()
    expect(record.claude_settings).toEqual({ ...CLAUDE_BLOCK, model: 'opus' })
    expect(record.dcmDisplaySettings).toEqual(DCM_BLOCK)
    expect(record.provider_specific_settings).toEqual({
      temperature: 1.2,
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] }
    })
    expect(record.displayName).toBe('Probe')
  })

  it('a key named null is removed, a key not named stays, and a list or nested value is written whole', async () => {
    await seed(BLOCKS_RECORD)

    await saveAgent(AGENT, {
      claude_settings: { model: null, addDirs: ['/c'], configOverrides: [{ key: 'theme', value: 'dark' }], allowedTools: ['Read'] }
    } as any)

    const record = await stored()
    expect(record.claude_settings).toEqual({ permissionMode: 'default', alwaysThinkingEnabled: false, addDirs: ['/c'],
      configOverrides: [{ key: 'theme', value: 'dark' }], allowedTools: ['Read'] })
  })

  it('a partial block makes the block an object first when it is missing, null, or not an object', async () => {
    for (const record of [{}, { claude_settings: null }, { claude_settings: 'garbage' }, { claude_settings: ['x'] }]) {
      await seed(record)
      await saveAgent(AGENT, { claude_settings: { model: 'opus' } } as any)
      expect((await stored()).claude_settings).toEqual({ model: 'opus' })
    }
  })

  it('the block sent as null is a whole write of null; a save of removals or of {} creates nothing', async () => {
    await seed(BLOCKS_RECORD)
    await saveAgent(AGENT, { claude_settings: null, dcmDisplaySettings: null } as any)
    let record = await stored()
    expect(record.claude_settings).toBeNull()
    expect(record.dcmDisplaySettings).toBeNull()

    for (const removals of [{ model: null }, {}]) {
      await seed()
      await saveAgent(AGENT, { claude_settings: removals, dcmDisplaySettings: { groups: { gw_a: null } } } as any)
      record = await stored()
      expect('claude_settings' in record).toBe(false)
      expect('dcmDisplaySettings' in record).toBe(false)
    }

    await seed({ claude_settings: null })
    await saveAgent(AGENT, { claude_settings: {} } as any)
    expect((await stored()).claude_settings).toBeNull()

    await seed({ claude_settings: CLAUDE_BLOCK })
    await saveAgent(AGENT, { claude_settings: {} } as any)
    expect((await stored()).claude_settings).toEqual(CLAUDE_BLOCK)
  })

  it('dcmDisplaySettings: version at its own key, each map entry by path, an entry named null removed', async () => {
    await seed(BLOCKS_RECORD)

    await saveAgent(AGENT, {
      dcmDisplaySettings: {
        version: 1,
        groups: { gw_b: null, gw_d: 'group-only' },
        tools: { 'gw_a::read': 'hidden' },
        toolDisplayPreferences: { 'gw_a::read': null }
      }
    } as any)

    expect((await stored()).dcmDisplaySettings).toEqual({
      version: 1,
      groups: { gw_a: 'group-only', gw_d: 'group-only' },
      tools: { 'gw_a::read': 'hidden' },
      groupDisplayPreferences: { gw_a: 'group-only' },
      toolDisplayPreferences: {}
    })
  })

  it('dcmDisplaySettings: a map sent whole is written entry by entry, and one sent null is removed', async () => {
    await seed(BLOCKS_RECORD)
    await saveAgent(AGENT, { dcmDisplaySettings: { groups: { gw_a: 'hidden' } } } as any)
    expect((await stored()).dcmDisplaySettings.groups).toEqual({ gw_a: 'hidden', gw_b: 'hidden' })

    await saveAgent(AGENT, { dcmDisplaySettings: { groups: null, tools: {} } } as any)
    const block = (await stored()).dcmDisplaySettings
    expect('groups' in block).toBe(false)
    expect(block.tools).toEqual({ 'gw_a::read': 'name-only' })
  })

  it('dcmDisplaySettings: the block and a map are made objects first, and only when an entry is set', async () => {
    await seed()
    await saveAgent(AGENT, { dcmDisplaySettings: { groups: { gw_a: 'hidden' } } } as any)
    expect((await stored()).dcmDisplaySettings).toEqual({ groups: { gw_a: 'hidden' } })

    await seed({ dcmDisplaySettings: { version: 1, groups: 'garbage', tools: null } })
    await saveAgent(AGENT, { dcmDisplaySettings: { groups: { gw_a: 'hidden' }, tools: { t: 'hidden' } } } as any)
    expect((await stored()).dcmDisplaySettings).toEqual({ version: 1, groups: { gw_a: 'hidden' }, tools: { t: 'hidden' } })

    await seed({ dcmDisplaySettings: { version: 1, groups: 'garbage' } })
    await saveAgent(AGENT, { dcmDisplaySettings: { groups: { gw_a: null } } } as any)
    expect((await stored()).dcmDisplaySettings).toEqual({ version: 1, groups: 'garbage' })
  })

  it('a key or a map entry with any characters is stored under its exact name', async () => {
    await seed(BLOCKS_RECORD)

    await saveAgent(AGENT, {
      claude_settings: Object.fromEntries(ODD_KEYS.map((key, index) => [key, index])),
      dcmDisplaySettings: { groups: Object.fromEntries(ODD_KEYS.map((key, index) => [key, `mode ${index}`])) }
    } as any)

    let record = await stored()
    expect(Object.keys(record.claude_settings).sort()).toEqual([...Object.keys(CLAUDE_BLOCK), ...ODD_KEYS].sort())
    expect(Object.keys(record.dcmDisplaySettings.groups).sort()).toEqual([...Object.keys(DCM_BLOCK.groups), ...ODD_KEYS].sort())
    ODD_KEYS.forEach((key, index) => {
      expect(Object.prototype.hasOwnProperty.call(record.claude_settings, key)).toBe(true)
      expect(record.claude_settings[key]).toBe(index)
      expect(record.dcmDisplaySettings.groups[key]).toBe(`mode ${index}`)
    })
    expect(record.agentType).toBe('api')

    await saveAgent(AGENT, {
      claude_settings: Object.fromEntries(ODD_KEYS.map((key) => [key, null])),
      dcmDisplaySettings: { groups: Object.fromEntries(ODD_KEYS.map((key) => [key, null])) }
    } as any)

    record = await stored()
    expect(record.claude_settings).toEqual(CLAUDE_BLOCK)
    expect(record.dcmDisplaySettings.groups).toEqual(DCM_BLOCK.groups)
  })
})

describe.skipIf(!REAL)('two saves of one block written at the same moment both survive (BL-848, BL-855, real Redis)', () => {
  /** Runs one save right before the script of the other save, then lets that script run; each save takes each place. */
  async function racingSaves(
    field: string,
    saveA: Record<string, unknown>,
    saveB: Record<string, unknown>
  ): Promise<unknown[]> {
    const blocks: unknown[] = []
    for (const [inner, outer] of [[saveB, saveA], [saveA, saveB]]) {
      await seed(BLOCKS_RECORD)
      const probe = changeBeforeEachScript(async () => {
        await saveAgent(AGENT, inner as any)
      })
      await saveAgent(AGENT, outer as any)
      vi.restoreAllMocks()
      expect(probe.changes()).toBe(1)
      blocks.push((await stored())[field])
    }
    return blocks
  }

  it('a Claude mode save and a model save', async () => {
    const [bLandsFirst, aLandsFirst] = await racingSaves(
      'claude_settings',
      { claude_settings: { permissionMode: 'plan' } },
      { claude_settings: { model: 'opus' } }
    )
    expect(bLandsFirst).toEqual({ ...CLAUDE_BLOCK, permissionMode: 'plan', model: 'opus' })
    expect(aLandsFirst).toEqual({ ...CLAUDE_BLOCK, permissionMode: 'plan', model: 'opus' })
  })

  it('a group save and another group save, one of them removing an entry', async () => {
    const [bLandsFirst, aLandsFirst] = await racingSaves(
      'dcmDisplaySettings',
      { dcmDisplaySettings: { groups: { gw_a: 'hidden' } } },
      { dcmDisplaySettings: { groups: { gw_b: null, gw_c: 'group-only' } } }
    )
    const expected = { ...DCM_BLOCK, groups: { gw_a: 'hidden', gw_c: 'group-only' } }
    expect(bLandsFirst).toEqual(expected)
    expect(aLandsFirst).toEqual(expected)
  })
})

describe('a save is checked before anything is written, and a refused one is a 400 (review items 2 and 6)', () => {
  async function expectRefusedUntouched(updates: Record<string, unknown>, message: RegExp) {
    await seed()
    await expect(saveAgent(AGENT, { displayName: 'Half saved', ...updates } as any)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(message)
    })
    const record = await stored()
    expect(record.displayName).toBe('Probe')
    expect(record.updated_at).toBe(OLD_STAMP)
    expect(record.provider_specific_settings).toEqual({
      temperature: 1.2,
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] }
    })
  }

  it('a setting name with a broken character (half of an emoji): refused, and the message says what to change', async () => {
    await expectRefusedUntouched(
      { provider_specific_settings: { temperature: 0.5, [`knob${LONE_SURROGATE}`]: 1 } },
      /broken character[\s\S]*Custom Parameter name/
    )
  })

  it('a broken character inside a setting value or a nested name: refused', async () => {
    await expectRefusedUntouched({ provider_specific_settings: { stop: `end${LONE_SURROGATE}` } }, /broken character/)
    await expectRefusedUntouched({ provider_specific_settings: { extra: { [`k${LONE_SURROGATE}`]: 1 } } }, /broken character/)
  })

  it('a value nested deeper than 64 levels: refused (Redis refuses 128 halfway through, or skips 126 without a word)', async () => {
    await expectRefusedUntouched({ provider_specific_settings: { temperature: 0.5, deep: nested(65) } }, /64 levels/)
    await expectRefusedUntouched({ provider_specific_settings: { temperature: 0.5, deep: nested(130) } }, /64 levels/)
    await expectRefusedUntouched({ voice_profile: nested(126) }, /64 levels/)
  })

  it('a value nested exactly 64 levels deep is saved', async () => {
    await seed()
    await saveAgent(AGENT, { provider_specific_settings: { deep: nested(64) } } as any)
    expect((await stored()).provider_specific_settings.deep).toEqual(nested(64))
  })

  it('a provider_specific_settings that is not an object or null: refused', async () => {
    await expectRefusedUntouched({ provider_specific_settings: 'oops' }, /provider_specific_settings must be an object or null/)
    await expectRefusedUntouched({ provider_specific_settings: [1, 2] }, /provider_specific_settings must be an object or null/)
  })

  it('a nativeTools that is not an object or null: refused (BL-841)', async () => {
    await expectRefusedUntouched({ provider_specific_settings: { nativeTools: 'plan' } }, /nativeTools[\s\S]*must be an object or null/)
    await expectRefusedUntouched({ provider_specific_settings: { nativeTools: ['plan'] } }, /nativeTools[\s\S]*must be an object or null/)
  })

  it('a nativeTools field name or value with a broken character, or a value too deep: refused (BL-841)', async () => {
    await expectRefusedUntouched({ provider_specific_settings: { nativeTools: { [`mode${LONE_SURROGATE}`]: 'plan' } } }, /broken character/)
    await expectRefusedUntouched({ provider_specific_settings: { nativeTools: { bashNeverAllowList: [`rm${LONE_SURROGATE}`] } } }, /broken character/)
    await expectRefusedUntouched({ provider_specific_settings: { nativeTools: { deep: nested(65) } } }, /64 levels/)
  })

  it('a field name that is not an agent field name: refused with a 400', async () => {
    await expectRefusedUntouched({ 'bad.name': 1 }, /Not an agent field name/)
  })

  async function expectBlockRefusedUntouched(updates: Record<string, unknown>, message: RegExp) {
    await seed(BLOCKS_RECORD)
    await expect(saveAgent(AGENT, { displayName: 'Half saved', ...updates } as any)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(message)
    })
    const record = await stored()
    expect(record.displayName).toBe('Probe')
    expect(record.updated_at).toBe(OLD_STAMP)
    expect(record.claude_settings).toEqual(CLAUDE_BLOCK)
    expect(record.dcmDisplaySettings).toEqual(DCM_BLOCK)
  }

  it('a claude_settings or dcmDisplaySettings that is not an object or null: refused, and the other block of the save is not written (BL-848, BL-855)', async () => {
    for (const field of ['claude_settings', 'dcmDisplaySettings']) {
      for (const bad of ['oops', ['a'], 5, true]) {
        await expectBlockRefusedUntouched(
          { ...(field === 'claude_settings' ? { dcmDisplaySettings: { groups: { gw_c: 'hidden' } } } : { claude_settings: { model: 'opus' } }), [field]: bad },
          new RegExp(`${field}[\\s\\S]*must be an object or null`)
        )
      }
    }
  })

  it('a dcmDisplaySettings map that is not an object or null: refused (BL-855)', async () => {
    for (const bad of ['oops', ['a'], 5, true]) {
      await expectBlockRefusedUntouched({ dcmDisplaySettings: { groups: { gw_a: 'hidden' }, tools: bad } }, /"tools"[\s\S]*must be an object or null/)
    }
  })

  it('a key, entry name or value with a broken character, or a value too deep: refused (BL-848, BL-855)', async () => {
    await expectBlockRefusedUntouched({ claude_settings: { [`model${LONE_SURROGATE}`]: 'opus' } }, /broken character/)
    await expectBlockRefusedUntouched({ claude_settings: { addDirs: [`/a${LONE_SURROGATE}`] } }, /broken character/)
    await expectBlockRefusedUntouched({ claude_settings: { deep: nested(65) } }, /64 levels/)
    await expectBlockRefusedUntouched({ dcmDisplaySettings: { groups: { [`gw${LONE_SURROGATE}`]: 'hidden' } } }, /broken character/)
    await expectBlockRefusedUntouched({ dcmDisplaySettings: { groups: { gw_a: `hid${LONE_SURROGATE}` } } }, /broken character/)
    await expectBlockRefusedUntouched({ dcmDisplaySettings: { tools: { gw_a: nested(65) } } }, /64 levels/)
  })
})

describe('an agent key that is not a JSON record answers as Redis does (review item 3)', () => {
  it("a string key: RedisJSON's wrong-type error (not \"Agent not found\"), and the key is left as it is", async () => {
    await redis.set(KEY, 'plain text')
    await expect(saveAgent(AGENT, { displayName: 'X' } as any)).rejects.toThrow(/Existing key has wrong Redis type/)
    expect(await redis.readAgentRecordStorage(AGENT)).toEqual({ type: 'string', raw: 'plain text' })
  })
})

/**
 * Another writer changes the agent right before updateAgent's script runs (after its read of the
 * type fields): `change` runs before each of the first `times` scripts on this agent. Records the
 * arguments and actual KEYS of every script call, for the twin parity test.
 */
function changeBeforeEachScript(change: (client: any) => Promise<void>, times = 1) {
  const execute = redis.execute.bind(redis)
  let changes = 0
  const scriptCalls: string[][] = []
  const scriptKeys: string[][] = []
  vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
    execute(async (client: any) => {
      const wrapped = new Proxy({}, {
        get(_empty, property) {
          if (property === 'eval') {
            return async (script: string, options: { keys?: string[]; arguments?: string[] }) => {
              if (options?.keys?.[0] === KEY && script.includes('local guard = ARGV[5]')) {
                scriptCalls.push([...(options.arguments ?? [])])
                scriptKeys.push([...options.keys])
                if (changes < times) {
                  changes += 1
                  await change(client)
                }
              }
              return client.eval(script, options)
            }
          }
          const value = Reflect.get(client, property)
          return typeof value === 'function' ? value.bind(client) : value
        }
      })
      return operation(wrapped)
    })) as any)
  return { changes: () => changes, scriptCalls, scriptKeys }
}

describe.skipIf(!REAL)('a type change written while updateAgent runs survives (review item 1, real Redis)', () => {
  const toCli = async (client: any) => {
    await client.json.set(KEY, '$.agentType', 'cli')
  }

  it('a save that names no type field (the Subagent assignment) keeps an API to CLI change made meanwhile', async () => {
    await seed()
    const probe = changeBeforeEachScript(toCli)

    await saveAgent(AGENT, { assigned_subagent_ids: ['zaupd_sub'], assignedSubagents: ['zaupd_sub'] } as any)

    const record = await stored()
    expect(probe.changes()).toBe(1)
    expect(record.agentType).toBe('cli')
    expect(record.assigned_subagent_ids).toEqual(['zaupd_sub'])
  })

  it('a model save keeps its original A3 base and refuses after a concurrent type change', async () => {
    await seed()
    const before = await stored()
    const probe = changeBeforeEachScript(toCli)

    await expect(saveAgent(AGENT, { primary_model_provider: 'openai', primary_model_name: 'gpt-5' } as any))
      .rejects.toMatchObject({ status: 409, code: 'model_selection_settings_changed' })

    expect(probe.changes()).toBe(1)
    expect(await stored()).toEqual({ ...before, agentType: 'cli' })
  })

  it('a legacy record: the canonical type written meanwhile stays, and the legacy fields go', async () => {
    await seed({ agentType: undefined, batshitMode: 'direct', mode: 'vercel-native' })
    const probe = changeBeforeEachScript(toCli)

    await saveAgent(AGENT, { displayName: 'Typed' } as any)

    const record = await stored()
    expect(probe.changes()).toBe(1)
    expect(record.agentType).toBe('cli')
    expect('batshitMode' in record).toBe(false)
    expect('mode' in record).toBe(false)
  })

  it('a legacy record whose type field changes meanwhile: the save works the type out again from what is stored', async () => {
    await seed({ agentType: undefined, batshitMode: 'direct' })
    const probe = changeBeforeEachScript(async (client) => {
      await client.json.set(KEY, '$.batshitMode', 'cli')
    })

    await saveAgent(AGENT, { displayName: 'Typed again' } as any)

    const record = await stored()
    expect(probe.changes()).toBe(1)
    expect(probe.scriptCalls.length).toBe(2)
    expect(record.displayName).toBe('Typed again')
    expect(record.agentType).toBe('cli')
    expect('batshitMode' in record).toBe(false)
  })

  it('a type that changes before every try: nothing is written and the save says so', async () => {
    await seed({ agentType: undefined, batshitMode: 'direct' })
    let flip = false
    changeBeforeEachScript(async (client) => {
      flip = !flip
      await client.json.set(KEY, '$.batshitMode', flip ? 'cli' : 'direct')
    }, 10)

    await expect(saveAgent(AGENT, { displayName: 'Never' } as any)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/kept changing/)
    })

    const record = await stored()
    expect(record.displayName).toBe('Probe')
    expect(record.updated_at).toBe(OLD_STAMP)
  })

  it('a save that passes agentType writes it (a deliberate type change is the last word), whatever is stored', async () => {
    await seed()
    const probe = changeBeforeEachScript(toCli)

    await saveAgent(AGENT, { agentType: 'api' } as any)

    expect((await stored()).agentType).toBe('api')
    // Written as passed: no comparison with the type fields, so no second try.
    expect(probe.scriptCalls.length).toBe(1)
  })

  it('a canonical stored type is left alone: a model change made meanwhile does not make the save try again', async () => {
    await seed({ agentType: 'cli', primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'claude-a' })
    const probe = changeBeforeEachScript(async (client) => {
      await client.json.set(KEY, '$.primary_model_name', 'claude-b')
    })

    await saveAgent(AGENT, { displayName: 'Still CLI' } as any)

    const record = await stored()
    expect(probe.scriptCalls.length).toBe(1)
    expect(record.agentType).toBe('cli')
    expect(record.primary_model_name).toBe('claude-b')
  })
})

describe.skipIf(!REAL)('a memory change written after the base compare and before the script is caught by the script (BL-1294, real Redis)', () => {
  const newBudgets = { on_my_mind: 100, triggers: 200, recalled: 350 }

  it('the agent saves On My Mind in that gap: the script answers MEMORY_CHANGED, the next compare refuses, nothing of the save is written', async () => {
    await seed(MEMORY)
    const base = memoryBaseOf(await stored())
    const probe = changeBeforeEachScript(async (client) => {
      await client.json.set(KEY, '$.memory_lane_budgets.on_my_mind', 120)
    })

    await expect(
      saveAgent(AGENT, { ...base, memory_lane_budgets: newBudgets } as any, { expectedMemory: base })
    ).rejects.toMatchObject({ status: 409, code: 'memory_settings_changed' })

    const record = await stored()
    expect(probe.changes()).toBe(1)
    expect(probe.scriptCalls.length).toBe(1)
    expect(record.memory_lane_budgets).toEqual({ on_my_mind: 120, triggers: 200, recalled: 300 })
    expect(record.updated_at).toBe(OLD_STAMP)
  })

  it('a text change that keeps every value (an older name beside the canonical one): the script refuses once, the next try writes', async () => {
    await seed(MEMORY)
    const base = memoryBaseOf(await stored())
    const probe = changeBeforeEachScript(async (client) => {
      // The resolvers read the canonical name first, so this changes no value the form shows.
      await client.json.set(KEY, '$.memoryLaneBudgets', { on_my_mind: 1, triggers: 1, recalled: 1 })
    })

    await saveAgent(AGENT, { ...base, memory_lane_budgets: newBudgets } as any, { expectedMemory: base })

    expect(probe.scriptCalls.length).toBe(2)
    expect((await stored()).memory_lane_budgets).toEqual(newBudgets)
  })

  it('the type guard still works beside it: a legacy type changed in the gap is worked out again and the memory save lands', async () => {
    await seed({ ...MEMORY, agentType: undefined, batshitMode: 'direct' })
    const base = memoryBaseOf(await stored())
    const probe = changeBeforeEachScript(async (client) => {
      await client.json.set(KEY, '$.batshitMode', 'cli')
    })

    await saveAgent(AGENT, { ...base, memory_lane_budgets: newBudgets } as any, { expectedMemory: base })

    const record = await stored()
    expect(probe.scriptCalls.length).toBe(2)
    expect(record.agentType).toBe('cli')
    expect('batshitMode' in record).toBe(false)
    expect(record.memory_lane_budgets).toEqual(newBudgets)
  })

  it("the default lane's twin answers the same arguments the same way, with the memory guard", async () => {
    const { runAgentUpdateScriptTwin } = await import('$lib/test-utils/agentUpdateScriptTwin')
    await seed(MEMORY)
    const before = await stored()
    const base = memoryBaseOf(before)
    const probe = changeBeforeEachScript(async () => {}, 0)

    await saveAgent(AGENT, { ...base, memory_lane_budgets: newBudgets } as any, { expectedMemory: base })
    vi.restoreAllMocks()

    expect(probe.scriptCalls.length).toBe(1)
    expect(probe.scriptCalls[0][4]).not.toBe('')
    const twin = runAgentUpdateScriptTwin(before, probe.scriptCalls[0])
    expect(twin.answer).toBe('OK')
    expect(twin.record).toEqual(await stored())

    const moved = runAgentUpdateScriptTwin({ ...before, memory_linger_turns: 7 }, probe.scriptCalls[0])
    expect(moved.answer).toBe('MEMORY_CHANGED')
  })
})

describe.skipIf(!REAL)("the default lane's twin applies the real script's arguments the same way (review item 3, real Redis)", () => {
  it('matches valid sparse-write arguments and retains rejected malformed model sources', async () => {
    const { runAgentUpdateScriptTwin } = await import('$lib/test-utils/agentUpdateScriptTwin')
    const cases: Array<{ record: Record<string, unknown>; updates: Record<string, unknown>; refusal?: { status: number; code?: string; message?: string } }> = [
      {
        record: {},
        updates: {
          displayName: 'Twin',
          description: null,
          primary_model_temperature: null,
          provider_specific_settings: { ...Object.fromEntries(ODD_KEYS.map((key, index) => [key, { index }])), temperature: null }
        }
      },
      { record: { provider_specific_settings: 'not an object', goon_id: null }, updates: { provider_specific_settings: { knob: 1 } } },
      { record: { agentType: undefined, batshitMode: 'cli', mode: 'vercel-native' }, updates: { system_prompt: 'x' } },
      // The retained preset is API-only; changing the target type cannot make it a CLI source.
      // SA-139 R4/R5: the lower writer never stores a retired Primary type, before any other rule.
      { record: {}, updates: { agentType: 'cli', provider_specific_settings: null }, refusal: { status: 400,
        message: 'A retired Primary Agent type (Claude Code CLI, Codex CLI or n8n) cannot be saved. Nothing was saved.' } },
      { record: {}, updates: { agentType: 'cli', primary_model_preset_id: 'zaupd_preset_a' }, refusal: { status: 400,
        message: 'A retired Primary Agent type (Claude Code CLI, Codex CLI or n8n) cannot be saved. Nothing was saved.' } },
      { record: {}, updates: { agentType: 'n8n' }, refusal: { status: 400,
        message: 'A retired Primary Agent type (Claude Code CLI, Codex CLI or n8n) cannot be saved. Nothing was saved.' } },
      // BL-841: nativeTools field by field, odd field names, removals, and a block that is not an object.
      {
        record: {},
        updates: {
          provider_specific_settings: {
            nativeTools: { ...Object.fromEntries(ODD_KEYS.map((key, index) => [key, [index]])), bashNeverAllowList: null, executionBackend: 'docker' }
          }
        }
      },
      { record: { provider_specific_settings: { nativeTools: 'odd' } }, updates: { provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } } } },
      { record: { provider_specific_settings: { temperature: 1 } }, updates: { provider_specific_settings: { nativeTools: { bashAccessMode: null } } } },
      { record: {}, updates: { provider_specific_settings: { nativeTools: null } }, refusal: { status: 400,
        message: 'Keep the explicit Typed File Tools choice; clear individual tool settings instead. Nothing was saved.' } },
      // BL-848, BL-855: the two blocks field by field: odd names, removals, lists, and blocks that are not objects.
      {
        record: { claude_settings: { model: 'a', addDirs: ['/x'], permissionMode: 'plan' } },
        updates: { claude_settings: { model: null, addDirs: ['/y'], ...Object.fromEntries(ODD_KEYS.map((key, index) => [key, [index]])) } }
      },
      { record: { claude_settings: 'odd' }, updates: { claude_settings: { permissionMode: 'plan' } } },
      { record: {}, updates: { claude_settings: { model: null } } },
      { record: {}, updates: { claude_settings: {} } },
      { record: { claude_settings: { b: 2 } }, updates: { claude_settings: { b: null } } },
      { record: { claude_settings: { a: 1 } }, updates: { claude_settings: null } },
      {
        record: { dcmDisplaySettings: { version: 1, groups: { a: 'x' }, tools: { t: 'y' } } },
        updates: {
          dcmDisplaySettings: {
            version: 1,
            groups: { ...Object.fromEntries(ODD_KEYS.map((key, index) => [key, `mode ${index}`])), a: null },
            tools: { t2: 'n' },
            toolDisplayPreferences: null
          }
        }
      },
      { record: { dcmDisplaySettings: 'odd' }, updates: { dcmDisplaySettings: { groups: { a: 'hidden' } } } },
      { record: { dcmDisplaySettings: { version: 1, groups: 'odd', tools: null } }, updates: { dcmDisplaySettings: { groups: { a: 'hidden' }, tools: { b: 'hidden' } } } },
      { record: { dcmDisplaySettings: { version: 1, groups: 'odd' } }, updates: { dcmDisplaySettings: { groups: { a: null } } } },
      { record: {}, updates: { dcmDisplaySettings: { groups: { a: null } } } }
    ]
    for (const { record, updates, refusal } of cases) {
      await seed(record)
      const before = await stored()
      // Retain actual original source/index records before the physical write. The twin's
      // __members adapter holds the real SMEMBERS result, never the guard's expected member.
      const originalDependencies: Record<string, Record<string, unknown>> = {
        'model:zaupd_preset_a': await redis.json.get('model:zaupd_preset_a') as Record<string, unknown>,
        'model:zaupd_preset_b': await redis.json.get('model:zaupd_preset_b') as Record<string, unknown>,
        [`user:${USER}:models`]: { __members: await redis.sMembers(`user:${USER}:models`) }
      }
      expect(originalDependencies['model:zaupd_preset_a']).toMatchObject({ id: 'zaupd_preset_a' })
      expect(originalDependencies['model:zaupd_preset_b']).toMatchObject({ id: 'zaupd_preset_b' })
      const probe = changeBeforeEachScript(async () => {}, 0)
      if (typeof record.provider_specific_settings === 'string') {
        // A3 refuses this malformed model source; it is not an automatic repair path.
        await expect(redis.updateAgent(AGENT, updates as any, { expectedModelSelection: `sha256:${'0'.repeat(64)}` }))
          .rejects.toMatchObject({ status: 409, code: 'model_selection_settings_changed' })
        vi.restoreAllMocks()
        expect(probe.scriptCalls).toHaveLength(0)
        expect(await stored()).toEqual(before)
        continue
      }
      if (refusal) {
        await expect(saveAgent(AGENT, updates as any)).rejects.toMatchObject(refusal)
        vi.restoreAllMocks()
        expect(probe.scriptCalls).toHaveLength(0)
        expect(await stored()).toEqual(before)
        continue
      }
      await saveAgent(AGENT, updates as any)
      vi.restoreAllMocks()
      expect(probe.scriptCalls.length).toBe(1)
      expect(probe.scriptKeys).toHaveLength(1)
      expect(probe.scriptKeys[0][0]).toBe(KEY)
      const dependencies: Record<number, Record<string, unknown>> = Object.create(null)
      for (const [index, key] of probe.scriptKeys[0].entries()) {
        if (index === 0) continue
        expect(Object.hasOwn(originalDependencies, key)).toBe(true)
        dependencies[index + 1] = originalDependencies[key]
      }
      const twin = runAgentUpdateScriptTwin(before, probe.scriptCalls[0], undefined, dependencies)
      expect(twin.answer).toBe('OK')
      expect(twin.record).toEqual(await stored())
    }
  })

  it('a path escape RedisJSON refuses (a JSON.stringify line break) is refused by the twin too', async () => {
    const { parseAgentRecordPath } = await import('$lib/test-utils/agentUpdateScriptTwin')
    await seed()
    const stringified = `$.provider_specific_settings[${JSON.stringify(`line${LINE_BREAK}break`)}]`
    await expect(redis.json.set(KEY, stringified, 1 as never)).rejects.toThrow(/expected one of the following/)
    expect(() => parseAgentRecordPath(stringified)).toThrow(/Error occurred at position/)
    const escapedOnlyQuoteAndBackslash = `$.provider_specific_settings["line${LINE_BREAK}break ${BACKSLASH}"q${BACKSLASH}${BACKSLASH}"]`
    await redis.json.set(KEY, escapedOnlyQuoteAndBackslash, 1 as never)
    const expectedKey = `line${LINE_BREAK}break "q${BACKSLASH}`
    expect((await stored()).provider_specific_settings[expectedKey]).toBe(1)
    expect(parseAgentRecordPath(escapedOnlyQuoteAndBackslash)).toEqual({ field: 'provider_specific_settings', key: expectedKey })
  })
})


describe.runIf(REAL)('C3 actual fixed source/save and preset mapping boundary', () => {
  beforeEach(async () => { const os = await import('node:os'); const { randomUUID } = await import('node:crypto'); vi.stubEnv('BATSHIT_AGENT_RUNTIME_ROOT', `${os.tmpdir()}/c3-real-source-${randomUUID()}`) })
  afterEach(async () => { if (admission.isAdmitted()) { await redis.del(`user:${USER}:agents`); await redis.del(`subagent:${AGENT}`) } vi.unstubAllEnvs() })
  async function interceptNativeIssue(kind: 'agent' | 'subagent', change?: (client: any) => Promise<void>) {
    const execute = redis.execute.bind(redis), calls: string[][] = []
    vi.spyOn(redis, 'execute').mockImplementation((async operation => execute(client => operation(new Proxy(client, {
      get(target, property) {
        if (property === 'eval') return async (script: string, command: { keys: string[]; arguments: string[] }) => {
          if (command.keys[0] === `${kind}:${AGENT}` && script.includes(kind === 'agent' ? 'local guard = ARGV[5]' : 'local modelSelection = cjson.decode(ARGV[3])')) {
            calls.push([...command.arguments]); if (calls.length === 1) await change?.(client)
          }
          return client.eval(script, command)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })))) as typeof redis.execute)
    return calls
  }
  it.each(['', '__proto__', 'constructor'])('actual nativeTools member %j saves and removes its exact name without a MODEL token', async key => {
    await seed()
    const before = await stored(), calls = await interceptNativeIssue('agent')
    await redis.updateAgent(AGENT, { provider_specific_settings: { nativeTools: Object.fromEntries([[key, 'owned value']]) } } as never)
    expect(calls).toHaveLength(1)
    expect(calls[0][4]).toBe('')
    const saved = await stored()
    expect(saved).toEqual({ ...before, updated_at: expect.any(String), provider_specific_settings: {
      ...before.provider_specific_settings, nativeTools: { ...before.provider_specific_settings.nativeTools, ...Object.fromEntries([[key, 'owned value']]) }
    } })
    expect(Object.hasOwn(saved.provider_specific_settings.nativeTools, key)).toBe(true)
    await redis.updateAgent(AGENT, { provider_specific_settings: { nativeTools: Object.fromEntries([[key, null]]) } } as never)
    expect(calls).toHaveLength(2)
    expect(calls[1][4]).toBe('')
    expect(await stored()).toEqual({ ...before, updated_at: expect.any(String) })
    expect(Object.hasOwn((await stored()).provider_specific_settings.nativeTools, key)).toBe(false)
  })
  // SA-139 R4/R5: the native Claude model fence, the CLI selection seed and the CLI profile stage
  // left with the Claude Code CLI Primary (R4) and Subagent (R5) lanes; their cases went with them.
  it('updates an unrelated sparse field without requiring the retired profile mapping of a dangling preset', async () => {
    await seed({ agentType: 'api', primary_model_preset_id: 'missing-preset',
      claude_settings: { permissionMode: 'default', profileId: 'batshit_agent_legacy', keep: 'value' },
      provider_specific_settings: { nativeTools: { bashAccessMode: 'plan' }, temperature: 0.2 } })
    const before = await stored()
    await redis.updateAgent(AGENT, { claude_settings: { model: 'preserved-data' } } as never)
    const after = await stored()
    expect(after).toEqual({ ...before, updated_at: expect.any(String),
      claude_settings: { ...before.claude_settings, model: 'preserved-data' } })
  })
  it('saves a model preset with its owned raw postimage and preserves its index', async () => {
    await seed()
    const preset = { id: 'zaupd_preset_a', modelName: 'API fixture', modelId: 'fixture-model', provider: 'openai',
      settings: { temperature: 0.2, custom: false }, connection: { id: 'direct:openai', type: 'direct', service: 'openai' } }
    await redis.json.set('model:zaupd_preset_a', '$', preset as never)
    const owner = await import('$lib/server/services/modelPresetSelectionOwner')
    const before = await owner.readModelPresetStorage(USER, preset.id), beforeIndex = (await redis.sMembers(`user:${USER}:models`)).sort()
    const next = { ...preset, settings: { ...preset.settings, temperature: 0.7 } }
    expect(await withSettingsRecordReplacement(`model:${preset.id}`, () => owner.mutateModelPresetStorage(USER, preset.id, before.raw, 'update', next as never))).toBe('SAVED')
    const after = await owner.readModelPresetStorage(USER, preset.id)
    expect(after.preset).toEqual(next)
    expect(after.raw).not.toBe(before.raw)
    expect(after.present).toBe(true)
    expect((await redis.sMembers(`user:${USER}:models`)).sort()).toEqual(beforeIndex)
  })
  it('refuses a concurrent model preset change at the actual compare-and-save', async () => {
    await seed()
    const preset = { id: 'zaupd_preset_a', modelName: 'API fixture', modelId: 'fixture-model', provider: 'openai',
      settings: { temperature: 0.2 }, connection: { id: 'direct:openai', type: 'direct', service: 'openai' } }
    await redis.json.set('model:zaupd_preset_a', '$', preset as never)
    const owner = await import('$lib/server/services/modelPresetSelectionOwner')
    const before = await owner.readModelPresetStorage(USER, preset.id)
    const client = await redis.execute(async value => value), evaluate = client.eval.bind(client)
    let issues = 0
    vi.spyOn(client, 'eval').mockImplementation((async (script: string, command: any) => {
      if (script === owner.MUTATE_MODEL_PRESET_SCRIPT) {
        issues++
        await client.json.set('model:zaupd_preset_a', '$.settings.temperature', 0.9)
      }
      return evaluate(script, command)
    }) as never)
    const answer = await withSettingsRecordReplacement(`model:${preset.id}`, () => owner.mutateModelPresetStorage(USER, preset.id, before.raw,
      'update', { ...preset, settings: { temperature: 0.7 } } as never))
    expect(answer).toBe('CONFLICT')
    expect(issues).toBe(1)
    expect((await owner.readModelPresetStorage(USER, preset.id)).preset?.settings).toEqual({ temperature: 0.9 })
    expect(await redis.sismember(`user:${USER}:models`, preset.id)).toBeTruthy()
  })
})

// SA-139 R4: the P3b human CLI reasoning pair guard left with the Claude Code CLI Primary lane.

describe('human Primary MCP whole-field original bases', () => {
  async function shown(leaves = [...MCP_SETTINGS_FIELDS]) {
    const lifecycle = captureSettingsLifecycle([KEY]), paths = mcpSettingsReadPaths(leaves), row = await stored()
    const raw = REAL ? (await redis.execute(client => readModelSelectionSnapshot(client, AGENT, 'agent', lifecycle, paths, { typeFenceOnly: true, reportProjection: true }))).extraRaw :
      paths.map(path => agentTypeSnapshotOf(row, [path]))
    return makeMcpSettingsSnapshot(AGENT, paths, raw, lifecycle, leaves)
  }
  // The default twin uses its actual stored row. Real cases use the real atomic
  // read and existing strict admitted client, never a synthetic positive token.
  const readShown = () => shown()
  it('missing original leaf metadata refuses the whole mixed request before its ordinary sibling write', async () => {
    await seed({ defaultMCPGateways: ['A'], custom_tool_settings: [] })
    const before = await stored()
    await expect(redis.updateAgent(AGENT, { defaultMCPGateways: ['A','C'], displayName: 'Must not land' })).rejects.toMatchObject({ status: 400, code: 'mcp_settings_base_required' })
    expect(await stored()).toEqual(before)
  })
  it.each(['non-mcp-after-mcp', 'mcp-after-non-mcp'] as const)('refuses the stale FULL custom array in both directions: %s', async direction => {
    // Skill Read's retired row is intentionally removed on writes. Use the live native
    // Bash row so the FULL-array stale-write oracle retains its opaque future fields.
    const initial = [{ tool_name: 'bash_execute', buffer_size: 0, auto_zip: false, future: { keep: true } }, { tool_name: 'unrelated', zip_threshold: 0 }]
    await seed({ custom_tool_settings: initial })
    const before = await readShown()
    const winner = direction === 'non-mcp-after-mcp' ? [...initial, { tool_name: 'C_remote_write', buffer_size: 3 }] :
      [{ ...initial[0], buffer_size: 8 }, initial[1]]
    await redis.updateAgent(AGENT, { custom_tool_settings: winner } as never, { expectedMcpSettings: { custom_tool_settings: before.revisions.custom_tool_settings! } })
    const actualWinner = await stored()
    const stale = direction === 'non-mcp-after-mcp' ? [{ ...initial[0], buffer_size: 9 }, initial[1]] : [...initial, { tool_name: 'C_remote_write', buffer_size: 5 }]
    await expect(redis.updateAgent(AGENT, { custom_tool_settings: stale, displayName: 'Must not land' } as never,
      { expectedMcpSettings: { custom_tool_settings: before.revisions.custom_tool_settings! } })).rejects.toMatchObject({ status: 409, code: 'mcp_settings_changed' })
    expect(await stored()).toEqual(actualWinner)
    expect((await stored()).custom_tool_settings).toEqual(winner)
  })
  it('returns the SAME acknowledged postimage/base before a later read or sibling save and never persists metadata', async () => {
    await seed({ defaultMCPGateways: ['A'], custom_tool_settings: [{ tool_name: 'unrelated', buffer_size: 0, auto_zip: false }] })
    const before = await readShown()
    let ack: Parameters<NonNullable<AgentUpdateOptions['onMcpSettingsSaved']>>[0] | undefined
    await redis.updateAgent(AGENT, { defaultMCPGateways: ['A','C'] }, { expectedMcpSettings: { defaultMCPGateways: before.revisions.defaultMCPGateways! }, onMcpSettingsSaved(value) { ack = value } })
    expect(ack?.values).toEqual({ defaultMCPGateways: ['A','C'] })
    expect(Object.keys(ack!.revisions)).toEqual(['defaultMCPGateways'])
    expect(ack?.revisions.defaultMCPGateways).not.toBe(before.revisions.defaultMCPGateways)
    const atAck = structuredClone(ack)
    await redis.json.set(KEY, '$.defaultMCPGateways', ['A','C','D'])
    expect(ack).toEqual(atAck)
    expect(await stored()).not.toHaveProperty('expectedMcpSettings')
  })
})


describe.runIf(REAL)('human MCP final actual EVAL guard', () => {
  it('refuses a producer-shaped MCP row arriving after the human read but before its non-MCP array write', async () => {
    const initial = [{ tool_name: 'skill_read', buffer_size: 0, auto_zip: false }]
    await seed({ custom_tool_settings: initial })
    const paths = mcpSettingsReadPaths(['custom_tool_settings']), life = captureSettingsLifecycle([KEY])
    const shown = await redis.execute(client => readModelSelectionSnapshot(client, AGENT, 'agent', life, paths, { typeFenceOnly: true, reportProjection: true }))
    const base = makeMcpSettingsSnapshot(AGENT, paths, shown.extraRaw, life, ['custom_tool_settings'])
    const winner = [...initial, { tool_name: 'C_remote_write', buffer_size: 3 }]
    const execute = redis.execute.bind(redis)
    let issued = 0
    vi.spyOn(redis, 'execute').mockImplementation(operation => execute(client => {
      const wrap = (target: typeof client): typeof client => new Proxy(target, { get(current, key) {
        if (key === 'withAbortSignal') return (signal: AbortSignal) => wrap(current.withAbortSignal(signal))
        if (key === 'eval') return async (script: string, command: { keys: string[]; arguments: string[] }) => {
          if (command.keys[0] === KEY && script.includes("return 'MCP_SETTINGS_CHANGED'") && JSON.parse(command.arguments[4] || '{}').mcpSettings) {
            issued++
            if (issued === 1) await current.json.set(KEY, '$.custom_tool_settings', winner)
          }
          return current.eval(script, command)
        }
        const value = Reflect.get(current, key, current)
        return typeof value === 'function' ? value.bind(current) : value
      } })
      return operation(wrap(client))
    }))
    await expect(redis.updateAgent(AGENT, { displayName: 'Must not land', custom_tool_settings: [{ ...initial[0], buffer_size: 9 }] } as never,
      { expectedMcpSettings: base.revisions })).rejects.toMatchObject({ code: 'mcp_settings_changed', status: 409 })
    expect(issued).toBe(1)
    expect(await stored()).toMatchObject({ displayName: 'Probe', updated_at: OLD_STAMP, custom_tool_settings: winner })
  })
})

// SA-139 R5: no save carries a Claude Code CLI promotion any more (the `cliPromotion` option R4
// refused on a Primary went with the Claude Code CLI Subagent, its last user).
