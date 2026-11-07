import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { clearRedisTestDatabase, useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { instructionLeaves, readInstructionsSnapshot } from '$lib/server/instructionsGuard'
import { readInstructionsSnapshotTwin } from '$lib/test-utils/agentUpdateScriptTwin'
import { captureSettingsLifecycle } from '$lib/server/services/appActions/settings/lifecycle'
import { MODEL_SELECTION_REVISION_HEADER } from '$lib/appActions/settings/modelSelectionBaseline'
import { CLAUDE_CLI_PRESET_REFUSAL } from '$lib/utils/cliRuntimeIdentity'

/**
 * BL-914: `PUT /api/subagents/[id]` writes each field the body names by path, key by key inside
 * `provider_specific_settings` and `dcmDisplaySettings`, in
 * one step inside Redis (`redis.updateSubagent`, the Subagent twin of BL-768's `updateAgent`).
 * It used to read the record, wait for the request body, lay the body over the record it had
 * read (`{ ...existing, ...body }`) and write the WHOLE record back. Two things were lost:
 * - a partial block erased the keys it did not name, and a stale copy took back another
 *   window's choice inside those blocks;
 * - two saves of different fields that overlapped in time (the core autosave and the Tool Grid
 *   save of one panel): the later write carried the earlier read, one field was lost, and both
 *   answered success.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis` (the script is Lua there); the
 * default lane's fake runs its twin (`test-utils/agentUpdateScriptTwin.ts`). An overlap is
 * deterministic: the first request is held where the route waits for its body (after its read
 * of the record), the second runs to its end, then the first goes on.
 *
 * SA-139 R5 removed the Claude Code CLI Subagent: a body's `claude_settings` is never written, a
 * stored `cli` record is delete-only, and no save syncs a managed CLI profile any more.
 */

// The GET's model-selection read (the base a model save carries) is one EVAL. Real Redis runs it;
// the default lane's fake deliberately has no generic EVAL, so there only the read runs its twin
// (the same double as `agents/[id]/agent-update-route.test.ts`, adc4742d3).
vi.mock('$lib/server/modelSelectionGuard', async importOriginal => {
  const actual = await importOriginal<typeof import('$lib/server/modelSelectionGuard')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return actual
  return { ...actual, readModelSelectionSnapshot: async (_client: unknown, id: string, kind: 'agent' | 'subagent', lifecycle: any, extraPaths: readonly string[] = []) => {
    const { readModelSelectionSnapshotTwin } = await import('$lib/test-utils/agentUpdateScriptTwin')
    const { captureSettingsLifecycle } = await import('$lib/server/services/appActions/settings/lifecycle')
    const { redis } = await import('$lib/server/redis')
    const targetLifecycle = lifecycle ?? captureSettingsLifecycle([`${kind}:${id}`])
    const row = await redis.json.get(`${kind}:${id}`) as Record<string, any> | null
    return readModelSelectionSnapshotTwin(id, kind, row, targetLifecycle, extraPaths)
  } }
})

// Optional packet-owned admission uses the existing harness, never a borrowed allocation.
const ownedRedisRunId = process.env.COOPER_FIXTURE_REDIS_RUN_ID
const ownedRedisDir = process.env.COOPER_FIXTURE_REDIS_DIR
const ownedRedisLane = ownedRedisRunId !== undefined || ownedRedisDir !== undefined
const ownedRedisUrl = 'redis://127.0.0.1:6393/15'
const ownedRedisPreviousPool = process.env.VITEST_POOL_ID
let ownedRedisClient: any
let ownedRedisAdmitted = false
let ownedRedisRetired = false
let ownedRedisAcquisition: Promise<unknown> | undefined
function checkOwnedRedisIntent() {
  if (!ownedRedisLane) return
  if (process.env.VITEST_USE_REAL_REDIS !== 'true' || !ownedRedisRunId || !/^[a-f0-9]{40}$/.test(ownedRedisRunId) ||
      !ownedRedisDir || !path.isAbsolute(ownedRedisDir) || path.normalize(ownedRedisDir) !== ownedRedisDir ||
      ['BATSHIT_REDIS_TEST_URL', 'VITEST_REDIS_URL', 'REDIS_URL'].some(key => process.env[key] !== ownedRedisUrl)) {
    throw new Error('The owned Redis packet needs its fresh run/directory and three exact DB15 URLs before admission.')
  }
}
checkOwnedRedisIntent()
beforeAll(() => { if (ownedRedisLane) process.env.VITEST_POOL_ID = '0' })
async function checkOwnedRedisClient(client: any, empty: boolean) {
  checkOwnedRedisIntent()
  expect(client.isOpen && client.isReady).toBe(true)
  const connection = await client.clientInfo()
  expect(connection.db).toBe(15)
  expect(connection.laddr).toBe('127.0.0.1:6393')
  expect(Number.isSafeInteger(connection.id) && connection.id > 0).toBe(true)
  const server: string = await client.info('server')
  const field = (name: string) => {
    const lines = server.split(/\r?\n/).filter(line => line.startsWith(`${name}:`))
    expect(lines).toHaveLength(1)
    return lines[0].slice(name.length + 1)
  }
  expect(field('run_id')).toBe(ownedRedisRunId)
  expect(field('redis_version')).toBe('8.10.1')
  expect(field('tcp_port')).toBe('6393')
  expect((await client.configGet('dir')).dir).toBe(ownedRedisDir)
  expect((await client.configGet('save')).save).toBe('')
  expect((await client.configGet('appendonly')).appendonly).toBe('no')
  const modules: unknown = await client.sendCommand(['MODULE', 'LIST'])
  if (!Array.isArray(modules) || modules.some(row => !Array.isArray(row))) throw new Error('Owned Redis modules are unreadable.')
  expect(modules.map(row => row[row.indexOf('name') + 1])).toEqual(expect.arrayContaining(['ReJSON', 'search']))
  for (const command of ['JSON.GET', 'FT.SEARCH']) {
    expect(await client.sendCommand(['COMMAND', 'INFO', command])).toEqual([expect.any(Array)])
  }
  expect(await client.sendCommand(['JSON.GET', 'cooper:fixture:admission:missing', '$'])).toBeNull()
  const keyspace: string = await client.info('keyspace')
  expect(keyspace.split(/\r?\n/).filter(line => /^db\d+:/.test(line) && !line.startsWith('db15:'))).toEqual([])
  if (empty) expect(await client.dbSize()).toBe(0)
  return connection.id as number
}
async function admitOwnedRedis({ adminClient, resolvedUrl }: { adminClient: any; resolvedUrl: string }) {
  if (!ownedRedisLane) return
  checkOwnedRedisIntent()
  expect(resolvedUrl).toBe(ownedRedisUrl)
  const adminId = await checkOwnedRedisClient(adminClient, true)
  ownedRedisAcquisition = redis.execute(async (client: any) => {
    ownedRedisClient = client
    if (ownedRedisRetired) { if (client.isOpen) await client.disconnect(); throw new Error('Owned Redis acquisition settled after retirement.') }
    const appId = await checkOwnedRedisClient(client, true)
    if (ownedRedisRetired) { if (client.isOpen) await client.disconnect(); throw new Error('Owned Redis admission settled after retirement.') }
    expect(appId).not.toBe(adminId)
  })
  try {
    await ownedRedisAcquisition
    if (ownedRedisRetired) throw new Error('Owned Redis admission was retired.')
    ownedRedisAdmitted = true
  } catch (error) {
    try { await redis.disconnect() } catch (closeError) {
      throw new AggregateError([error, closeError], 'Owned Redis admission and app closure failed.')
    }
    throw error
  }
}
async function retireOwnedRedis() {
  if (!ownedRedisLane) return
  ownedRedisRetired = true
  const errors: unknown[] = []
  try {
    if (ownedRedisAdmitted && ownedRedisAdmission.isAdmitted() && ownedRedisClient) {
      await checkOwnedRedisClient(ownedRedisClient, false)
      await clearRedisTestDatabase(ownedRedisClient)
    }
  } catch (error) { errors.push(error) }
  finally {
    // Public disconnect acquires no new connection and resets this fixture's facade.
    try { await redis.disconnect() } catch (error) { errors.push(error) }
    if (ownedRedisAcquisition) {
      try { await ownedRedisAcquisition } catch (error) { if (!errors.includes(error)) errors.push(error) }
    }
    if (ownedRedisPreviousPool === undefined) delete process.env.VITEST_POOL_ID
    else process.env.VITEST_POOL_ID = ownedRedisPreviousPool
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Owned Redis cleanup and closure failed.')
}

const ownedRedisAdmission = useRedisTestServer({ beforeCleanupAdmission: admitOwnedRedis })
afterAll(retireOwnedRedis)

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'zu2_user'
const SUB = 'zu2_sub'
const KEY = `subagent:${SUB}`
const OLD_STAMP = '2026-09-28T00:00:00.000Z'

const CLAUDE_BLOCK = { model: 'sonnet', permissionMode: 'default', alwaysThinkingEnabled: false, addDirs: ['/one'] }
const DCM_BLOCK = {
  version: 1,
  groups: { gw_a: 'group-only', gw_b: 'hidden' },
  tools: { 'gw_a::read': 'name-only' },
  groupDisplayPreferences: { gw_a: 'group-only' },
  toolDisplayPreferences: { 'gw_a::read': 'name+hint' }
}
const PROVIDER_BLOCK = { temperature: 0.7, reasoningEffort: 'low', nativeTools: { webSearchEnabled: false, bashAccessMode: 'plan' } }

const RECORD = {
  id: SUB,
  user_id: USER,
  displayName: 'zu2 sub',
  slug: SUB,
  subagentType: 'api',
  specialty: 'general',
  description: 'Writes haiku.',
  system_prompt: 'Answer only in haiku.',
  include_global_prompt: true,
  primary_model_provider: 'openai',
  primary_model_name: 'gpt-5.5',
  primary_model_preset_id: 'zu2_preset',
  primary_model_connection: { type: 'direct', service: 'openai' },
  timeout_seconds: 45,
  avatar: null,
  defaultMCPGateways: ['gw_a'],
  claude_settings: CLAUDE_BLOCK,
  dcmDisplaySettings: DCM_BLOCK,
  provider_specific_settings: PROVIDER_BLOCK,
  created_at: OLD_STAMP,
  updated_at: OLD_STAMP
}

async function seed(record: Record<string, unknown> = {}) {
  await redis.json.set(KEY, '$', { ...RECORD, ...record } as never)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
}

async function stored() {
  return (await redis.json.get(KEY)) as Record<string, any>
}

/**
 * 3698a4293: a save that names the Custom System Prompt (or the global-prompt switch) carries the
 * instructions token of the copy it was made from, as the Settings panel does. A body that names
 * its own `expectedInstructions` is sent as written.
 */
async function withShownInstructions(updates: unknown) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.hasOwn(updates, 'expectedInstructions')) return updates
  const leaves = instructionLeaves(updates as Record<string, unknown>)
  const record = leaves.length ? await redis.json.get(KEY) as Record<string, unknown> | null : null
  if (!record) return updates
  const shown = REAL ? await redis.execute(client => readInstructionsSnapshot(client, SUB, 'subagent', undefined, leaves))
    : readInstructionsSnapshotTwin(SUB, 'subagent', record, captureSettingsLifecycle([KEY]), leaves)
  return { ...updates, expectedInstructions: shown.revisions }
}

/** The PUT, with `beforeBody` run where the route awaits the request body (after its read). */
async function callPut(updates: unknown, beforeBody: () => Promise<void> = async () => {}, user = USER) {
  const { PUT } = await import('./+server')
  const body = await withShownInstructions(updates)
  const request = {
    json: async () => {
      await beforeBody()
      return body
    }
  }
  const response = (await PUT({ params: { id: SUB }, request, locals: { user: { id: user } } } as any)) as Response
  return { status: response.status, body: await response.json() }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * `first` is held after its read of the record, `second` runs to its end, then `first` goes on:
 * the two saves overlap in time, `first`'s read being older than `second`'s write.
 */
async function overlapping(first: Record<string, unknown>, second: Record<string, unknown>) {
  const reached = deferred()
  const release = deferred()
  const firstCall = callPut(first, async () => {
    reached.resolve()
    await release.promise
  })
  await reached.promise
  const secondResult = await callPut(second)
  release.resolve()
  return { first: await firstCall, second: secondResult }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await redis.del(KEY)
  await redis.del(`user:${USER}:subagents`)
})

describe('SA-139 R5: a leftover CLI Subagent is delete-only, and no save makes one', () => {
  const CLAUDE_LEFTOVER = { subagentType: 'cli', primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli',
    primary_model_connection: { type: 'direct', id: 'claude-cli', service: 'claude-cli' }, claude_settings: CLAUDE_BLOCK }
  const CODEX_LEFTOVER = { subagentType: 'cli', primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli',
    primary_model_connection: { type: 'direct', id: 'codex-cli', service: 'codex-cli' }, codex_settings: { model: 'gpt-5.5', permissionMode: 'chat' } }
  const CLAUDE_REFUSAL = { code: 'subagent_type_retired', error: 'Claude Code CLI Subagents were removed from Batshit.',
    details: 'zu2 sub ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.' }
  const CODEX_REFUSAL = { code: 'subagent_type_retired', error: 'Codex CLI Subagents were removed from Batshit.',
    details: 'zu2 sub ran on Codex CLI, which Batshit no longer supports, so it can only be deleted. For ChatGPT models, create a new Subagent with the ChatGPT plan connection or an OpenAI API key.' }
  /** Fields only a CLI Subagent save named; the refusal of a stored `cli` record comes before any of them is read. */
  const CLI_FIELDS = ['subagentType', 'claude_settings', 'codex_settings', 'expectedCliPromotion',
    'primary_model_provider', 'primary_model_name', 'primary_model_connection', 'primary_model_preset_id']

  /** A PUT whose body records every look at a CLI field (a read, an `in` or an own-key check). */
  async function putWatchingCliFields(body: Record<string, unknown>) {
    const looked: string[] = []
    const watch = (name: string | symbol) => { if (typeof name === 'string' && CLI_FIELDS.includes(name)) looked.push(name) }
    const watched = new Proxy({ ...body }, {
      get(target, name, receiver) { watch(name); return Reflect.get(target, name, receiver) },
      has(target, name) { watch(name); return Reflect.has(target, name) },
      getOwnPropertyDescriptor(target, name) { watch(name); return Reflect.getOwnPropertyDescriptor(target, name) }
    })
    const { PUT } = await import('./+server')
    const response = (await PUT({ params: { id: SUB }, request: { json: async () => watched },
      locals: { user: { id: USER } } } as any)) as Response
    return { status: response.status, body: await response.json(), looked }
  }

  it.each([
    ['a Claude Code CLI leftover', CLAUDE_LEFTOVER, CLAUDE_REFUSAL],
    ['a typeless one that names the Claude Code CLI lane', { subagentType: undefined, primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli' }, CLAUDE_REFUSAL],
    ['a Codex CLI leftover', CODEX_LEFTOVER, CODEX_REFUSAL]
  ])('a PUT on %s is refused 409 before any CLI field of its body is read, and nothing is written', async (_name, record, refusal) => {
    await seed(record)
    const before = await stored()
    const update = vi.spyOn(redis, 'updateSubagent')
    const answer = await putWatchingCliFields({ displayName: 'never written', description: 'never written',
      subagentType: 'api', primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli',
      claude_settings: { model: 'opus' }, codex_settings: { model: 'gpt-6' }, expectedCliPromotion: { runtime: 'claude' } })
    expect(answer.status).toBe(409)
    expect(answer.body).toEqual(refusal)
    expect(answer.looked).toEqual([])
    expect(update).not.toHaveBeenCalled()
    expect(await stored()).toEqual(before)
  })

  it('a read of a leftover CLI Subagent is a 200 with its record, while a removed n8n one stays a 410', async () => {
    const { GET } = await import('./+server')
    const read = async () => {
      const response = (await GET({ params: { id: SUB }, locals: { user: { id: USER } } } as any)) as Response
      return { status: response.status, body: await response.json() }
    }
    for (const record of [CLAUDE_LEFTOVER, CODEX_LEFTOVER]) {
      await seed(record)
      const answer = await read()
      expect(answer.status).toBe(200)
      expect(answer.body.subagent).toMatchObject({ id: SUB, displayName: 'zu2 sub', subagentType: 'cli', primary_model_provider: record.primary_model_provider })
    }
    await seed({ subagentType: 'n8n-workflow', webhook_url: 'https://n8n.example/hook' })
    expect(await read()).toMatchObject({ status: 410, body: { code: 'subagent_type_retired' } })
  })

  it('an API Subagent is never made a CLI one: 409, and nothing is written', async () => {
    await seed()
    const before = await stored()
    expect(await callPut({ displayName: 'never written', subagentType: 'cli' })).toMatchObject({ status: 409,
      body: { code: 'subagent_type_retired', error: 'Claude Code CLI Subagents were removed from Batshit.' } })
    expect(await stored()).toEqual(before)
  })

  it.each([
    ['provider', { primary_model_provider: 'claude-cli' }],
    ['model', { primary_model_provider: 'anthropic', primary_model_name: 'claude-cli' }],
    ['connection id', { primary_model_provider: 'anthropic', primary_model_connection: { type: 'direct', id: 'claude-cli' } }],
    ['connection service', { primary_model_provider: 'anthropic', primary_model_connection: { type: 'direct', service: 'anthropic-claude-cli' } }]
  ])('an API Subagent save that names a Claude Code CLI %s is refused 400, and nothing is written', async (_name, change) => {
    await seed()
    const before = await stored()
    expect(await callPut({ displayName: 'never written', ...change })).toEqual({ status: 400, body: { error: CLAUDE_CLI_PRESET_REFUSAL } })
    expect(await stored()).toEqual(before)
  })

  it('a save that still carries a Claude Code CLI check (expectedCliPromotion) is refused 400, and nothing is written', async () => {
    await seed()
    const before = await stored()
    const answer = await callPut({ displayName: 'never written', expectedCliPromotion: { runtime: 'claude' } })
    expect(answer.status).toBe(400)
    expect(answer.body.error).toBe('This save carries a Claude Code CLI check (expectedCliPromotion), and the Claude Code CLI Subagent was removed from Batshit, so nothing was saved. Reload Settings and try again.')
    expect(await stored()).toEqual(before)
  })

  it('a body claude_settings block is never written, while the rest of the save lands', async () => {
    await seed()
    const { status } = await callPut({ description: 'edited', claude_settings: { permissionMode: 'acceptEdits', model: null } })
    expect(status).toBe(200)
    const record = await stored()
    expect(record.description).toBe('edited')
    expect(record.claude_settings).toEqual(CLAUDE_BLOCK)
  })
})

describe('two Subagent saves that overlap in time both stay (BL-914, second condition)', () => {
  const CORE_SAVE = { displayName: 'zu2 renamed', description: 'Writes limericks.' }
  const TOOL_GRID_SAVE = { defaultMCPGateways: ['gw_a', 'gw_b'], defaultMCPToolSelections: ['gw_a::read'] }

  it('the core save and the Tool Grid save of one panel: the field of each is on the record, in both orders', async () => {
    await seed()
    let saved = await overlapping(CORE_SAVE, TOOL_GRID_SAVE)
    expect([saved.first.status, saved.second.status]).toEqual([200, 200])
    let record = await stored()
    expect(record.displayName).toBe('zu2 renamed')
    expect(record.description).toBe('Writes limericks.')
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.defaultMCPToolSelections).toEqual(['gw_a::read'])

    await seed()
    saved = await overlapping(TOOL_GRID_SAVE, CORE_SAVE)
    expect([saved.first.status, saved.second.status]).toEqual([200, 200])
    record = await stored()
    expect(record.displayName).toBe('zu2 renamed')
    expect(record.description).toBe('Writes limericks.')
    expect(record.defaultMCPGateways).toEqual(['gw_a', 'gw_b'])
    expect(record.defaultMCPToolSelections).toEqual(['gw_a::read'])
  }, 30_000)

  it('two saves that each name a different key of ONE block both survive, in both orders', async () => {
    for (const [field, first, second, expected] of [
      [
        'provider_specific_settings',
        { temperature: 0.2 },
        { reasoningEffort: 'high' },
        { ...PROVIDER_BLOCK, temperature: 0.2, reasoningEffort: 'high' }
      ],
      [
        'dcmDisplaySettings',
        { groups: { gw_a: 'hidden' } },
        { groups: { gw_c: 'group+tools+names' }, tools: { 'gw_a::write': 'hidden' } },
        {
          ...DCM_BLOCK,
          groups: { gw_a: 'hidden', gw_b: 'hidden', gw_c: 'group+tools+names' },
          tools: { 'gw_a::read': 'name-only', 'gw_a::write': 'hidden' }
        }
      ]
    ] as const) {
      for (const [early, late] of [[first, second], [second, first]]) {
        await seed()
        const saved = await overlapping({ [field]: early }, { [field]: late })
        expect([field, saved.first.status, saved.second.status]).toEqual([field, 200, 200])
        expect([field, (await stored())[field]]).toEqual([field, expected])
      }
    }
  }, 60_000)

  it('a stale save keeps a choice another window wrote inside the block meanwhile', async () => {
    await seed()
    // SA-139 R5: on `dcmDisplaySettings`, the key-by-key block a Subagent save still writes (it
    // was the Claude Code CLI block, which a save no longer writes).
    const held = await callPut({ dcmDisplaySettings: { compact: true } }, async () => {
      // Another window writes another key of the block, by path, after this save read its copy.
      await redis.json.set(KEY, '$.dcmDisplaySettings.version', 2)
    })
    expect(held.status).toBe(200)
    expect((await stored()).dcmDisplaySettings).toEqual({ ...DCM_BLOCK, version: 2, compact: true })
  })

  it('a stale save of the core form keeps the type fields another save wrote meanwhile (the derived fields are not rewritten)', async () => {
    // SA-139 R5: API is the one live type, so the other save names it and clears the left-over
    // webhook fields; the stale save of the core form must not write them back.
    await seed({ subagentType: 'api', webhook_url: 'https://left.over/hook', webhookUrl: 'https://left.over/hook', workflowName: 'flow' })
    const saved = await overlapping({ description: 'Edited while the type changed.' }, { subagentType: 'api' })
    expect([saved.first.status, saved.second.status]).toEqual([200, 200])
    const record = await stored()
    expect(record.description).toBe('Edited while the type changed.')
    expect(record.subagentType).toBe('api')
    expect('webhook_url' in record).toBe(false)
    expect('webhookUrl' in record).toBe(false)
    expect('workflowName' in record).toBe(false)
  })

  it('answers the record as it is after the write: the other save\'s field is in the answer', async () => {
    await seed()
    const saved = await overlapping({ description: 'first save' }, { defaultMCPGateways: ['gw_z'] })
    expect(saved.first.body.subagent.description).toBe('first save')
    expect(saved.first.body.subagent.defaultMCPGateways).toEqual(['gw_z'])
  })
})

describe('a block the body names only in part keeps the keys it leaves out (BL-914, first condition)', () => {
  it('dcmDisplaySettings: a named key is written, every other key stays', async () => {
    await seed()
    const { status } = await callPut({ dcmDisplaySettings: { version: 2 } })
    expect(status).toBe(200)
    expect((await stored()).dcmDisplaySettings).toEqual({ ...DCM_BLOCK, version: 2 })
  })

  it('a key named null is removed; a list is written whole; the block sent as null is a write of null', async () => {
    // SA-139 R5: on `dcmDisplaySettings`, which a save writes by the same block rule the
    // Claude Code CLI block had.
    await seed({ dcmDisplaySettings: { ...DCM_BLOCK, order: ['/one'] } })
    await callPut({ dcmDisplaySettings: { version: null, order: ['/c', '/d'], chrome: true } })
    let record = await stored()
    const { version: _removed, ...unversioned } = DCM_BLOCK
    expect(record.dcmDisplaySettings).toEqual({ ...unversioned, order: ['/c', '/d'], chrome: true })

    await callPut({ dcmDisplaySettings: null })
    record = await stored()
    expect(record.dcmDisplaySettings).toBeNull()
  })

  it('dcmDisplaySettings: each map entry is written on its own, an entry named null is removed', async () => {
    await seed()
    await callPut({ dcmDisplaySettings: { groups: { gw_b: null, gw_d: 'group-only' }, tools: { 'gw_a::read': 'hidden' }, toolDisplayPreferences: { 'gw_a::read': null } } })
    expect((await stored()).dcmDisplaySettings).toEqual({
      version: 1,
      groups: { gw_a: 'group-only', gw_d: 'group-only' },
      tools: { 'gw_a::read': 'hidden' },
      groupDisplayPreferences: { gw_a: 'group-only' },
      toolDisplayPreferences: {}
    })
  })

  it('provider_specific_settings: key by key, nativeTools field by field; ancestors retain explicit choices', async () => {
    await seed()
    await callPut({ provider_specific_settings: { temperature: null, seed: 7, nativeTools: { webSearchEnabled: true, bashAccessMode: null } } })
    expect((await stored()).provider_specific_settings).toEqual({
      reasoningEffort: 'low',
      seed: 7,
      nativeTools: { webSearchEnabled: true }
    })

    await callPut({ provider_specific_settings: {} })
    expect((await stored()).provider_specific_settings).toEqual({ reasoningEffort: 'low', seed: 7, nativeTools: { webSearchEnabled: true } })

    const before = await stored()
    for (const provider_specific_settings of [null, { nativeTools: null }]) {
      const refusal = await callPut({ description: 'Must not land', provider_specific_settings })
      expect(refusal.status).toBe(400)
      expect(refusal.body.error).toContain('Keep the explicit Typed File Tools choice; clear individual')
      expect(await stored()).toEqual(before)
    }
    const cleared = await callPut({ provider_specific_settings: { reasoningEffort: null, seed: null, nativeTools: { webSearchEnabled: null } } })
    expect(cleared.status).toBe(200)
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: {} })
  })

  it('a block missing on the record is made an object first, and only when a key is set', async () => {
    await seed({ dcmDisplaySettings: 'garbage', provider_specific_settings: undefined })
    await callPut({ dcmDisplaySettings: { version: 2 }, provider_specific_settings: { temperature: 0.1 } })
    const record = await stored()
    expect(record.dcmDisplaySettings).toEqual({ version: 2 })
    expect(record.provider_specific_settings).toEqual({ temperature: 0.1 })

    await seed({ dcmDisplaySettings: undefined })
    await callPut({ dcmDisplaySettings: { version: null } })
    expect('dcmDisplaySettings' in (await stored())).toBe(false)
  })

  it('a block that is neither an object nor null is refused with a 400 and NOTHING of the save is written', async () => {
    for (const field of ['dcmDisplaySettings', 'provider_specific_settings']) {
      for (const bad of ['oops', ['a'], 5, true]) {
        await seed()
        const { status, body } = await callPut({ displayName: 'never written', description: 'never written', [field]: bad })
        expect([field, status]).toEqual([field, 400])
        expect(body.error).toMatch(/must be an object or null/)
        const record = await stored()
        expect(record.displayName).toBe('zu2 sub')
        expect(record.updated_at).toBe(OLD_STAMP)
      }
    }
  })

  it('a key or value with a broken character, or nested more than 64 levels: a 400 before anything is written', async () => {
    const lone = String.fromCharCode(0xd800)
    let deep: unknown = 1
    for (let level = 0; level < 65; level += 1) deep = { a: deep }
    for (const body of [
      { dcmDisplaySettings: { [`order${lone}`]: 'x' } },
      { dcmDisplaySettings: { order: [`/a${lone}`] } },
      { dcmDisplaySettings: { groups: { [`gw${lone}`]: 'hidden' } } },
      { provider_specific_settings: { deep } },
      { defaultMCPGateways: [`gw${lone}`] }
    ]) {
      await seed()
      const { status } = await callPut({ displayName: 'never written', ...body })
      expect([JSON.stringify(Object.keys(body)), status]).toEqual([JSON.stringify(Object.keys(body)), 400])
      expect((await stored()).displayName).toBe('zu2 sub')
    }
  })

  it('a field name that is not a field name is a 400 and nothing is written', async () => {
    await seed()
    const { status, body } = await callPut({ displayName: 'never written', 'bad.name': 1 })
    expect(status).toBe(400)
    expect(body.error).toMatch(/Not a Subagent field name/)
    expect((await stored()).displayName).toBe('zu2 sub')
  })
})

describe('what the route checks before any write is unchanged (BL-914)', () => {
  async function expectRefused(updates: unknown, status: number, matcher: Record<string, unknown> | RegExp, record: Record<string, unknown> = {}) {
    await seed(record)
    const answer = await callPut(updates)
    expect(answer.status).toBe(status)
    if (matcher instanceof RegExp) expect(answer.body.error).toMatch(matcher)
    else expect(answer.body).toMatchObject(matcher)
    const after = await stored()
    expect(after.updated_at).toBe(OLD_STAMP)
    expect(after.displayName).toBe('zu2 sub')
  }

  it('a Subagent of a removed n8n type is never changed (409), whatever the body (SA-139 R2, D14)', async () => {
    for (const stored of [
      { subagentType: 'n8n-subnode' },
      { subagentType: 'n8n-workflow', webhook_url: 'https://n8n.example/hook' },
      { subagentType: undefined, subagent_type: 'batshit' },
      { subagentType: undefined, webhook_url: 'https://n8n.example/typeless' }
    ]) {
      await expectRefused(
        { displayName: 'never written', subagentType: 'api' },
        409,
        { code: 'subagent_type_retired', error: 'zu2 sub uses an n8n Subagent type that Batshit removed, so it does not run. n8n workflows still work as tools. It cannot be changed.' },
        stored
      )
    }
  })

  // SA-139 R2 (review N2): the list hides such a record, and a read by id refuses it the same
  // readable way; another user's record stays a plain 403 (the type is not shown to them).
  it('a read of a Subagent of a removed n8n type is a 410 with the readable refusal', async () => {
    const { GET } = await import('./+server')
    const read = async (user = USER) => {
      const response = (await GET({ params: { id: SUB }, locals: { user: { id: user } } } as any)) as Response
      return { status: response.status, body: await response.json() }
    }
    for (const record of [
      { subagentType: 'n8n-subnode' },
      { subagentType: 'n8n-workflow', webhook_url: 'https://n8n.example/hook' },
      { subagentType: undefined, webhook_url: 'https://n8n.example/typeless' }
    ]) {
      await seed(record)
      expect(await read()).toEqual({ status: 410, body: { code: 'subagent_type_retired',
        error: 'zu2 sub uses an n8n Subagent type that Batshit removed, so it does not run. n8n workflows still work as tools.' } })
      expect((await read('someone-else')).status).toBe(403)
    }
    await seed({ subagentType: 'api' })
    expect((await read()).status).toBe(200)
  })

  it('a request for a removed n8n type is a 400 with its own code, never saved as another type', async () => {
    for (const subagentType of ['n8n-workflow', 'n8n-subnode', ' N8N-Workflow ']) {
      await expectRefused(
        { displayName: 'never written', subagentType },
        400,
        { code: 'subagent_type_retired', error: 'n8n Workflow Subagents were removed from Batshit. n8n workflows still work as tools.' }
      )
    }
  })

  it('a type that is not API is a 400 with its code (SA-139 R5: API is the one live type)', async () => {
    for (const subagentType of ['bogus', '', null, 5]) {
      await expectRefused(
        { displayName: 'never written', subagentType },
        400,
        { code: 'subagent_type_invalid', error: 'The Subagent type must be API.' }
      )
    }
  })

  it('a Call Timeout outside 10 seconds to 24 hours is refused; a blank one removes it; a number is stored', async () => {
    // Delegation limits (2026-10-24): blank means no limit, and the ceiling is 24 hours, not 600 s.
    await expectRefused({ displayName: 'never written', timeout_seconds: 5 }, 400, /Call timeout must be blank \(no limit\) or a whole number of seconds from 10 to 86,400 \(24 hours\)\./)
    await expectRefused({ displayName: 'never written', timeout_seconds: 86_401 }, 400, /from 10 to 86,400/)
    await seed()
    await callPut({ timeout_seconds: '' })
    expect('timeout_seconds' in (await stored())).toBe(false)
    await callPut({ timeout_seconds: 7_200 })
    expect((await stored()).timeout_seconds).toBe(7_200)
    await callPut({ timeout_seconds: null })
    expect('timeout_seconds' in (await stored())).toBe(false)
  })

  it('a Max Tool Steps outside 1 to 10,000 is refused; a blank or null one removes it; a number is stored', async () => {
    await expectRefused({ displayName: 'never written', max_tool_steps: 0 }, 400, /Max tool steps must be blank \(no limit\) or a whole number from 1 to 10,000\./)
    await expectRefused({ displayName: 'never written', max_tool_steps: 2.5 }, 400, /Max tool steps must be/)
    await seed()
    await callPut({ max_tool_steps: 40 })
    expect((await stored()).max_tool_steps).toBe(40)
    await callPut({ max_tool_steps: '' })
    expect('max_tool_steps' in (await stored())).toBe(false)
    await callPut({ max_tool_steps: '12' })
    expect((await stored()).max_tool_steps).toBe(12)
    await callPut({ max_tool_steps: null })
    expect('max_tool_steps' in (await stored())).toBe(false)
  })

  it('an avatar icon reference or fit the picker cannot make is a 400; a valid one is stored, null is kept as null', async () => {
    await expectRefused({ displayName: 'never written', avatar_icon_ref: { bad: true } }, 400, /avatar_icon_ref must be a valid icon picker reference/)
    await expectRefused({ displayName: 'never written', avatar_icon_fit: 'stretch' }, 400, /avatar_icon_fit must be "contain" or "fill"/)
    await seed()
    await callPut({ avatar_icon_fit: 'contain', avatar_icon_ref: null })
    const record = await stored()
    expect(record.avatar_icon_fit).toBe('fill')
    expect(record.avatar_icon_ref).toBeNull()
  })

  it('a Subagent that is not there is a 404, and one that is another user\'s a 403', async () => {
    const gone = await callPut({ displayName: 'x' })
    expect(gone.status).toBe(404)
    expect(gone.body).toEqual({ error: 'Subagent not found' })
    expect(await redis.exists(KEY)).toBe(false)

    await seed()
    const foreign = await callPut({ displayName: 'never written' }, async () => {}, 'zu2_someone_else')
    expect(foreign.status).toBe(403)
    expect((await stored()).displayName).toBe('zu2 sub')
  })

  it('an emptied Custom System Prompt is removed (BL-482); an upload URL is stored in its storage form', async () => {
    await seed()
    await callPut({ system_prompt: '  ', avatar: 'http://localhost:5600/uploads/avatars/zu2.png' })
    const record = await stored()
    expect('system_prompt' in record).toBe(false)
    expect(record.avatar).toBe('/uploads/avatars/zu2.png')
  })
})

describe('a body never writes the fields the route keeps (BL-762, BL-914)', () => {
  it('id, user_id, slug, created_at and a legacy subagent_type in the body change nothing; updated_at is stamped by the save', async () => {
    await seed()
    const { status, body } = await callPut({
      id: 'zu2_other',
      user_id: 'zu2_someone_else',
      slug: 'zu2_hijacked',
      created_at: '2000-01-01T00:00:00.000Z',
      updated_at: '2000-01-01T00:00:00.000Z',
      subagent_type: 'cli',
      description: 'edited'
    })
    expect(status).toBe(200)
    const record = await stored()
    expect(record).toMatchObject({ id: SUB, user_id: USER, slug: SUB, created_at: OLD_STAMP, subagentType: 'api', description: 'edited' })
    expect('subagent_type' in record).toBe(false)
    expect(record.updated_at).not.toBe(OLD_STAMP)
    expect(record.updated_at).not.toBe('2000-01-01T00:00:00.000Z')
    expect(body.subagent.id).toBe(SUB)
  })
})

describe('the type fields are written only when the request names them (BL-914)', () => {
  const LEFT_OVER = { subagentType: 'api', webhook_url: 'https://left.over/hook', webhookUrl: 'https://left.over/hook', workflowName: 'left over' }

  it('a save that names none of them leaves the type and any left-over webhook fields as stored', async () => {
    await seed(LEFT_OVER)
    await callPut({ description: 'edited' })
    expect(await stored()).toMatchObject({ ...LEFT_OVER, description: 'edited' })
  })

  it('naming a type removes the webhook pair, the workflow name and a legacy subagent_type', async () => {
    await seed({ ...LEFT_OVER, subagent_type: 'api' })
    await callPut({ subagentType: 'api' })
    const record = await stored()
    expect(record.subagentType).toBe('api')
    for (const gone of ['webhook_url', 'webhookUrl', 'workflowName', 'subagent_type']) expect(gone in record).toBe(false)
  })

  it('naming a webhook or a workflow name removes the pair and the name: no live type keeps them (SA-139 R2)', async () => {
    for (const body of [{ webhook_url: 'https://n8n.example/hook' }, { webhookUrl: 'https://n8n.example/new' }, { workflowName: 'flow' }]) {
      await seed(LEFT_OVER)
      await callPut(body)
      const record = await stored()
      expect(record.subagentType).toBe('api')
      for (const gone of ['webhook_url', 'webhookUrl', 'workflowName']) expect(gone in record).toBe(false)
    }
  })
})

describe('a Subagent deleted meanwhile (BL-753, BL-914)', () => {
  it('deleted after the route read it, before its script: 404 with the same words, nothing made again', async () => {
    await seed()
    const { status, body } = await callPut({ description: 'edited' }, async () => {
      await redis.sRem(`user:${USER}:subagents`, SUB)
      await redis.del(KEY)
    })
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Subagent not found: it was deleted while this edit was saved.' })
    expect(await redis.exists(KEY)).toBe(false)
  })

  /** Runs `hook` where the route makes its second read of the record (its read-back after the write). */
  async function withReadBackHook(hook: () => Promise<void>, run: () => Promise<void>): Promise<number> {
    const realJson = redis.json
    let reads = 0
    ;(redis as any).json = new Proxy(realJson, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property !== 'get') return typeof value === 'function' ? value.bind(target) : value
        return async (key: string, ...rest: unknown[]) => {
          if (key === KEY) {
            reads += 1
            if (reads === 2) await hook()
          }
          return (value as any).call(target, key, ...rest)
        }
      }
    })
    try {
      await run()
      return reads
    } finally {
      ;(redis as any).json = realJson
    }
  }

  it('deleted right after the script wrote: 404 with the same words', async () => {
    await seed()
    const reads = await withReadBackHook(
      async () => {
        await redis.sRem(`user:${USER}:subagents`, SUB)
        await redis.del(KEY)
      },
      async () => {
        const { status, body } = await callPut({ description: 'edited' })
        expect(status).toBe(404)
        expect(body).toEqual({ error: 'Subagent not found: it was deleted while this edit was saved.' })
      }
    )
    expect(reads).toBe(2)
  })

  it('deleted before the script (and made again by the time of a read-back): the script answered that it wrote nothing, so the route stops with the 404 and reads nothing back', async () => {
    await seed()
    // The route stops at the script's answer (it wrote nothing), so it never makes a read-back.
    const reads = await withReadBackHook(
      async () => {
        await seed({ displayName: 'made again', description: 'the new record' })
      },
      async () => {
        const { status, body } = await callPut({ description: 'edited' }, async () => {
          await redis.sRem(`user:${USER}:subagents`, SUB)
          await redis.del(KEY)
        })
        expect(status).toBe(404)
        expect(body).toEqual({ error: 'Subagent not found: it was deleted while this edit was saved.' })
      }
    )
    expect(reads).toBe(1)
    expect(await redis.exists(KEY)).toBe(false)
  })
})

describe.skipIf(!REAL)('the whole-record write is gone (real Redis)', () => {
  it('the route makes no write of the whole record at $', async () => {
    await seed()
    const execute = redis.execute.bind(redis)
    const wholeWrites: unknown[] = []
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      execute(async (client: any) => {
        const json = new Proxy({}, {
          get(_empty, property) {
            const value = Reflect.get(client.json, property)
            if (property === 'set' || property === 'setIfExists') {
              return async (key: string, path: string, ...rest: unknown[]) => {
                if (key === KEY && path === '$') wholeWrites.push(rest[0])
                return value.call(client.json, key, path, ...rest)
              }
            }
            return typeof value === 'function' ? value.bind(client.json) : value
          }
        })
        const wrapped = new Proxy({}, {
          get(_empty, property) {
            if (property === 'json') return json
            const value = Reflect.get(client, property)
            return typeof value === 'function' ? value.bind(client) : value
          }
        })
        return operation(wrapped)
      })) as any)

    await callPut({ description: 'edited', dcmDisplaySettings: { version: 2 } })
    vi.restoreAllMocks()
    expect(wholeWrites).toEqual([])
    expect((await stored()).dcmDisplaySettings).toEqual({ ...DCM_BLOCK, version: 2 })
  })
})

describe('SA-139 R1: a Subagent save that names the removed Codex CLI', () => {
  const RETIRED = { code: 'codex_cli_retired', error: 'Codex CLI agents were removed from Batshit.',
    details: 'This Subagent runs on Codex CLI, which Batshit no longer supports. Delete it and create a new Subagent.' }
  /** The model-selection base the panel read, as a model save carries it. */
  async function shownModelSelection() {
    const { GET } = await import('./+server')
    const read = (await GET({ params: { id: SUB }, locals: { user: { id: USER } } } as any)) as Response
    const base = read.headers.get(MODEL_SELECTION_REVISION_HEADER)
    expect(base).toMatch(/^sha256:/)
    return base
  }

  // SA-139 R5: a CLI Subagent (and a request for one) is refused by its type first (the
  // `SA-139 R5` cases above); an API Subagent that names Codex CLI keeps R1's refusal.
  it.each([
    ['by provider', { primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli' }],
    ['by connection', { primary_model_provider: 'openai', primary_model_connection: { type: 'direct', id: 'codex-cli', service: 'codex-cli' } }]
  ])('an API Subagent moved onto it %s is refused 409 codex_cli_retired, and nothing is written', async (_name, change) => {
    await seed()
    const before = await stored()
    const expectedModelSelection = await shownModelSelection()
    expect(await callPut({ displayName: 'never written', ...change, expectedModelSelection })).toMatchObject({ status: 409, body: RETIRED })
    expect(await stored()).toEqual(before)
  })

  it('never stores a body codex_settings block, while the rest of the save lands', async () => {
    await seed()
    const { status } = await callPut({ description: 'edited', codex_settings: { model: 'gpt-6' } })
    expect(status).toBe(200)
    const record = await stored()
    expect(record.description).toBe('edited')
    expect('codex_settings' in record).toBe(false)
  })

  it('a leftover Codex CLI Subagent\'s rename that names no model is refused 409 (SA-139 R5: delete only), and its record is not migrated', async () => {
    const leftover = { subagentType: 'cli', primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli',
      codex_settings: { model: 'gpt-5.5', permissionMode: 'chat' } }
    await seed(leftover)
    const before = await stored()
    const { status, body } = await callPut({ displayName: 'leftover renamed', codex_settings: { permissionMode: 'agent_full' } })
    expect(status).toBe(409)
    expect(body).toMatchObject({ code: 'subagent_type_retired', error: 'Codex CLI Subagents were removed from Batshit.' })
    expect(await stored()).toEqual(before)
  })

  it('saves an API Subagent on an OpenAI model whose id contains "codex"', async () => {
    await seed()
    await redis.json.set('model:zu2_gpt_codex', '$', { id: 'zu2_gpt_codex', modelName: 'GPT-5 Codex', provider: 'openai', modelId: 'gpt-5-codex' } as never)
    await redis.sAdd(`user:${USER}:models`, 'zu2_gpt_codex')
    try {
      const expectedModelSelection = await shownModelSelection()
      const { status } = await callPut({ primary_model_preset_id: 'zu2_gpt_codex', primary_model_provider: 'openai',
        primary_model_name: 'gpt-5-codex', expectedModelSelection })
      expect(status).toBe(200)
      expect(await stored()).toMatchObject({ subagentType: 'api', primary_model_preset_id: 'zu2_gpt_codex', primary_model_name: 'gpt-5-codex' })
    } finally {
      await redis.del('model:zu2_gpt_codex')
      await redis.sRem(`user:${USER}:models`, 'zu2_gpt_codex')
    }
  })

  // SA-139 R5 (review B 2a): a body that names only a leftover Claude Code CLI preset's id names no
  // provider or model for the route to check, so the lower writer refuses it.
  it('a save that names only a leftover Claude Code CLI preset id is refused 409, and nothing is written', async () => {
    await seed()
    await redis.json.set('model:zu2_claude_cli', '$', { id: 'zu2_claude_cli', modelName: 'Claude Code CLI', provider: 'anthropic-claude-cli', modelId: 'claude-cli' } as never)
    await redis.sAdd(`user:${USER}:models`, 'zu2_claude_cli')
    try {
      const before = await stored()
      const expectedModelSelection = await shownModelSelection()
      const { status, body } = await callPut({ primary_model_preset_id: 'zu2_claude_cli', expectedModelSelection })
      expect(status).toBe(409)
      expect(body).toMatchObject({ code: 'model_preset_unavailable', error: CLAUDE_CLI_PRESET_REFUSAL })
      expect(await stored()).toEqual(before)
    } finally {
      await redis.del('model:zu2_claude_cli')
      await redis.sRem(`user:${USER}:models`, 'zu2_claude_cli')
    }
  })

  // Review A's delta: the refusal is for a save that names a NEW preset only. A record that already
  // keeps a leftover one (refused at its run) still saves another field and the same id again.
  it('a record that keeps a leftover Claude Code CLI preset still saves another field and the same id again', async () => {
    await seed({ primary_model_preset_id: 'zu2_claude_cli' })
    await redis.json.set('model:zu2_claude_cli', '$', { id: 'zu2_claude_cli', modelName: 'Claude Code CLI', provider: 'anthropic-claude-cli', modelId: 'claude-cli' } as never)
    await redis.sAdd(`user:${USER}:models`, 'zu2_claude_cli')
    try {
      expect((await callPut({ description: 'edited' })).status).toBe(200)
      const expectedModelSelection = await shownModelSelection()
      expect((await callPut({ primary_model_preset_id: 'zu2_claude_cli', expectedModelSelection })).status).toBe(200)
      expect(await stored()).toMatchObject({ description: 'edited', primary_model_preset_id: 'zu2_claude_cli' })
    } finally {
      await redis.del('model:zu2_claude_cli')
      await redis.sRem(`user:${USER}:models`, 'zu2_claude_cli')
    }
  })
})
