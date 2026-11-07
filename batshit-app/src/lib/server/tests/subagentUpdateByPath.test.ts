import path from 'node:path'
import { afterEach, describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { clearRedisTestDatabase, useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { readInstructionsSnapshotTwin } from '$lib/test-utils/agentUpdateScriptTwin'
import { instructionLeaves, readInstructionsSnapshot } from '$lib/server/instructionsGuard'
import { namesModelSelection, readModelSelectionSnapshot } from '$lib/server/modelSelectionGuard'
import { captureSettingsLifecycle } from '$lib/server/services/appActions/settings/lifecycle'
import {
  SUBAGENT_KEPT_FIELDS,
  buildSubagentWrites,
  deriveSubagentTypeWrites,
  planSubagentRecordUpdate
} from '$lib/server/subagentRecordUpdate'

/**
 * BL-914: `redis.updateSubagent` writes only the fields its caller passed to a Subagent record,
 * each by path, in one step inside Redis (`UPDATE_SUBAGENT_FIELDS_SCRIPT`), under the rules the
 * agent update has had since BL-768 (they share `planRecordFieldOps` and the ops loop). The route
 * (`routes/api/subagents/[id]/subagent-update-by-path.test.ts`) has the overlapping-save and
 * partial-block tests; this file holds the plan, the script, and the default lane's twin.
 *
 * Real Redis 8 under `npm run test:redis` (a Lua script there); the default lane's fake twin under
 * plain `npm test`. The parity tests need the real client and run on the real lane only.
 */

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

const ownedRedisAdmission = useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
  await admitOwnedRedis({ adminClient, resolvedUrl })
  const database = Number(new URL(resolvedUrl).pathname.slice(1))
  expect(Number.isInteger(database) && database > 0).toBe(true)
  expect((await adminClient.clientInfo()).db).toBe(database)
} })
afterAll(retireOwnedRedis)

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'zsu_user'
const SUB = 'zsu_sub'
const KEY = `subagent:${SUB}`
const OLD_STAMP = '2026-09-28T09:00:00.000Z'
const NOW = '2026-09-29T09:00:00.000Z'

async function seed(record: Record<string, unknown> = {}) {
  await redis.json.set(KEY, '$', {
    id: SUB,
    user_id: USER,
    displayName: 'Probe',
    slug: SUB,
    subagentType: 'api',
    created_at: OLD_STAMP,
    updated_at: OLD_STAMP,
    claude_settings: { model: 'sonnet', permissionMode: 'default' },
    provider_specific_settings: { temperature: 1.2, nativeTools: { bashAccessMode: 'plan' } },
    ...record
  } as never)
}

async function stored() {
  return (await redis.json.get(KEY)) as any
}

afterEach(async () => {
  vi.restoreAllMocks()
  await redis.del(KEY)
})

describe('the plan of a Subagent update (BL-914)', () => {
  it('a field is one set op, the stamp is the last op, and undefined names nothing', () => {
    const { ops } = planSubagentRecordUpdate({ writes: { displayName: 'A', description: undefined, defaultMCPGateways: ['gw'] }, now: NOW })
    expect(ops).toEqual([
      { op: 'set', field: 'displayName', value: 'A' },
      { op: 'set', field: 'defaultMCPGateways', value: ['gw'] },
      { op: 'set', field: 'updated_at', value: NOW }
    ])
  })

  it('id, user_id, slug, created_at and updated_at are never written, whatever the writes name', () => {
    const writes = Object.fromEntries([...SUBAGENT_KEPT_FIELDS].map((field) => [field, 'x']))
    expect(planSubagentRecordUpdate({ writes: { ...writes, displayName: 'A' }, now: NOW }).ops).toEqual([
      { op: 'set', field: 'displayName', value: 'A' },
      { op: 'set', field: 'updated_at', value: NOW }
    ])
  })

  it('a null removes only the fields that name it; every other field stores the null', () => {
    const { ops } = planSubagentRecordUpdate({
      writes: { system_prompt: null, timeout_seconds: null, webhook_url: null, description: null, primary_model_preset_id: null },
      now: NOW
    })
    expect(ops).toEqual([
      { op: 'delete', field: 'system_prompt' },
      { op: 'delete', field: 'timeout_seconds' },
      { op: 'delete', field: 'webhook_url' },
      { op: 'set', field: 'description', value: null },
      { op: 'set', field: 'primary_model_preset_id', value: null },
      { op: 'set', field: 'updated_at', value: NOW }
    ])
  })

  it('the blocks are written key by key, an entry of a Tool Grid map on its own', () => {
    const { ops } = planSubagentRecordUpdate({
      writes: {
        claude_settings: { model: 'opus', permissionMode: null },
        provider_specific_settings: { temperature: null, nativeTools: { bashAccessMode: 'agent' } },
        dcmDisplaySettings: { groups: { gw_a: 'hidden' } }
      },
      now: NOW
    })
    expect(ops).toEqual([
      { op: 'ensureObject', field: 'claude_settings' },
      { op: 'set', field: 'claude_settings', key: 'model', value: 'opus' },
      { op: 'delete', field: 'claude_settings', key: 'permissionMode' },
      { op: 'ensureObject', field: 'provider_specific_settings' },
      { op: 'delete', field: 'provider_specific_settings', key: 'temperature' },
      { op: 'ensureObject', field: 'provider_specific_settings', key: 'nativeTools' },
      { op: 'set', field: 'provider_specific_settings', key: 'nativeTools', subkey: 'bashAccessMode', value: 'agent' },
      { op: 'ensureObject', field: 'dcmDisplaySettings' },
      { op: 'ensureObject', field: 'dcmDisplaySettings', key: 'groups' },
      { op: 'set', field: 'dcmDisplaySettings', key: 'groups', subkey: 'gw_a', value: 'hidden' },
      { op: 'set', field: 'updated_at', value: NOW }
    ])
  })

  it('a field name that is not a field name is refused with a 400', () => {
    expect(() => planSubagentRecordUpdate({ writes: { 'bad.name': 1 }, now: NOW })).toThrow(
      expect.objectContaining({ status: 400, message: expect.stringContaining('Not a Subagent field name') })
    )
  })
})

describe('the type fields a save writes (BL-914)', () => {
  const derive = (body: Record<string, unknown>, nextType: any) => deriveSubagentTypeWrites({ body, nextType })

  it('a body that names none of them writes none', () => {
    expect(derive({ description: 'x', system_prompt: 'y' }, 'api')).toEqual({})
    expect(derive({}, 'cli')).toEqual({})
  })

  it('naming any type field removes the webhook pair and the workflow name; the type is written only when named', () => {
    // SA-139 R2: no live type keeps a webhook or a workflow name since the n8n Workflow
    // Subagent was removed, so a named webhook or workflow name is a removal, never a write.
    expect(derive({ subagentType: 'cli' }, 'cli')).toEqual({
      subagentType: 'cli', subagent_type: null, webhook_url: null, webhookUrl: null, workflowName: null
    })
    expect(derive({ webhook_url: 'https://x' }, 'api')).toEqual({ webhook_url: null, webhookUrl: null, workflowName: null })
    expect(derive({ webhookUrl: 'https://y' }, 'api')).toEqual({ webhook_url: null, webhookUrl: null, workflowName: null })
    expect(derive({ workflowName: 'flow' }, 'cli')).toEqual({ webhook_url: null, webhookUrl: null, workflowName: null })
  })

  it('buildSubagentWrites keeps the body\'s other fields, drops the kept and type fields, and normalizes as the route did', () => {
    const writes = buildSubagentWrites({
      body: {
        id: 'x', user_id: 'x', slug: 'x', created_at: 'x', updated_at: 'x', subagent_type: 'cli',
        displayName: 'A', system_prompt: '  ', timeout_seconds: '', avatar_icon_fit: 'contain', avatar_icon_ref: null,
        claude_settings: { model: 'opus' }
      },
      nextType: 'api'
    })
    expect(writes).toEqual({
      displayName: 'A', system_prompt: null, timeout_seconds: null, avatar_icon_fit: 'fill', avatar_icon_ref: null,
      claude_settings: { model: 'opus' }
    })
  })

  it('buildSubagentWrites: a prompt with text and a timeout number are written as they are; a bad icon reference is a 400', () => {
    expect(buildSubagentWrites({ body: { system_prompt: 'Be brief.', timeout_seconds: 90 }, nextType: 'api' })).toEqual({
      system_prompt: 'Be brief.', timeout_seconds: 90
    })
    expect(() => buildSubagentWrites({ body: { avatar_icon_ref: { nope: 1 } }, nextType: 'api' })).toThrow(
      expect.objectContaining({ status: 400 })
    )
  })
})

describe('updateSubagent writes only the fields it was given (BL-914)', () => {
  it('writes the named fields and the stamp; every other field stays', async () => {
    await seed({ system_prompt: 'Keep me.', defaultMCPGateways: ['gw'] })
    expect(await redis.updateSubagent(SUB, { displayName: 'Renamed', description: 'New.' })).toBe(true)
    const record = await stored()
    expect(record).toMatchObject({
      id: SUB, user_id: USER, slug: SUB, created_at: OLD_STAMP, displayName: 'Renamed', description: 'New.',
      system_prompt: 'Keep me.', defaultMCPGateways: ['gw'], subagentType: 'api'
    })
    expect(record.updated_at).not.toBe(OLD_STAMP)
  })

  it('writes each block key by key: a key not named stays, a null key is removed, a block or map is made an object first', async () => {
    await seed({ dcmDisplaySettings: { version: 1, groups: { gw_a: 'group-only' } } })
    await redis.updateSubagent(SUB, {
      claude_settings: { model: null, alwaysThinkingEnabled: true },
      provider_specific_settings: { temperature: null, seed: 3, nativeTools: { webSearchEnabled: true } },
      dcmDisplaySettings: { groups: { gw_b: 'hidden' }, tools: { t: 'hidden' } }
    })
    const record = await stored()
    expect(record.claude_settings).toEqual({ permissionMode: 'default', alwaysThinkingEnabled: true })
    expect(record.provider_specific_settings).toEqual({ seed: 3, nativeTools: { bashAccessMode: 'plan', webSearchEnabled: true } })
    expect(record.dcmDisplaySettings).toEqual({ version: 1, groups: { gw_a: 'group-only', gw_b: 'hidden' }, tools: { t: 'hidden' } })

    await seed({ claude_settings: null })
    await redis.updateSubagent(SUB, { claude_settings: { model: 'opus' } })
    expect((await stored()).claude_settings).toEqual({ model: 'opus' })
  })

  it('provider ancestors cannot erase explicit tool choices; individual leaves clear, while the other two blocks become null', async () => {
    await seed({ claude_settings: { model: 'x' }, dcmDisplaySettings: { version: 1 } })
    const before = await stored()
    for (const provider_specific_settings of [null, { nativeTools: null }]) {
      await expect(redis.updateSubagent(SUB, { displayName: 'Must not land', provider_specific_settings }))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining('Keep the explicit Typed File Tools choice; clear individual') })
      expect(await stored()).toEqual(before)
    }
    await redis.updateSubagent(SUB, { provider_specific_settings: { temperature: null, nativeTools: { bashAccessMode: null } } })
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: {} })
    await redis.updateSubagent(SUB, { claude_settings: null, dcmDisplaySettings: null })
    const record = await stored()
    expect(record.provider_specific_settings).toEqual({ nativeTools: {} })
    expect(record.claude_settings).toBeNull()
    expect(record.dcmDisplaySettings).toBeNull()
  })

  it('a field of SUBAGENT_REMOVES_ON_NULL sent as null is removed; any other stores the null', async () => {
    await seed({ system_prompt: 'x', timeout_seconds: 30, webhook_url: 'u', webhookUrl: 'u', workflowName: 'w', subagent_type: 'api', description: 'd' })
    // 3698a4293: removing the Custom System Prompt carries the instructions token of the copy it was made from.
    const shown = REAL ? await redis.execute(client => readInstructionsSnapshot(client, SUB, 'subagent', undefined, ['customPrompt']))
      : readInstructionsSnapshotTwin(SUB, 'subagent', await stored(), captureSettingsLifecycle([KEY]), ['customPrompt'])
    await redis.updateSubagent(SUB, {
      system_prompt: null, timeout_seconds: null, webhook_url: null, webhookUrl: null, workflowName: null, subagent_type: null, description: null
    }, { expectedInstructions: shown.revisions })
    const record = await stored()
    for (const gone of ['system_prompt', 'timeout_seconds', 'webhook_url', 'webhookUrl', 'workflowName', 'subagent_type']) {
      expect(gone in record).toBe(false)
    }
    expect(record.description).toBeNull()
  })

  it('id, user_id, slug, created_at and updated_at in the writes change nothing (the stamp is the save\'s own)', async () => {
    await seed()
    await redis.updateSubagent(SUB, {
      id: 'x', user_id: 'x', slug: 'x', created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z', displayName: 'A'
    })
    const record = await stored()
    expect(record).toMatchObject({ id: SUB, user_id: USER, slug: SUB, created_at: OLD_STAMP, displayName: 'A' })
    expect(record.updated_at).not.toBe(OLD_STAMP)
    expect(record.updated_at).not.toBe('2000-01-01T00:00:00.000Z')
  })

  it('a Subagent that is gone: answers false and does not make it again', async () => {
    expect(await redis.updateSubagent(SUB, { displayName: 'Ghost' })).toBe(false)
    expect(await redis.exists(KEY)).toBe(false)
  })

  it("a key that is not a JSON record answers as Redis does: RedisJSON's wrong-type error, the key left as it is", async () => {
    await redis.set(KEY, 'plain text')
    await expect(redis.updateSubagent(SUB, { displayName: 'X' })).rejects.toThrow(/Existing key has wrong Redis type/)
    expect(await redis.get(KEY)).toBe('plain text')
  })

  it('a refused save is a 400 and writes nothing, the fields of the same save included', async () => {
    const lone = String.fromCharCode(0xd800)
    let deep: unknown = 1
    for (let level = 0; level < 65; level += 1) deep = { a: deep }
    for (const writes of [
      { claude_settings: 'oops' },
      { dcmDisplaySettings: { tools: 'oops' } },
      { provider_specific_settings: ['a'] },
      { claude_settings: { [`k${lone}`]: 1 } },
      { provider_specific_settings: { deep } },
      { description: `half${lone}` },
      { 'bad.name': 1 }
    ]) {
      await seed()
      await expect(redis.updateSubagent(SUB, { displayName: 'Half saved', ...writes })).rejects.toMatchObject({ status: 400 })
      const record = await stored()
      expect(record.displayName).toBe('Probe')
      expect(record.updated_at).toBe(OLD_STAMP)
    }
  })

  it('a settings key with any characters is stored under its exact name, and removed by it', async () => {
    const odd = ['top_p.v2', 'say "hi"', `path${String.fromCharCode(92)}to`, 'arr[0]', '"]', '', '__proto__']
    await seed()
    await redis.updateSubagent(SUB, {
      claude_settings: Object.fromEntries(odd.map((key, index) => [key, index])),
      dcmDisplaySettings: { groups: Object.fromEntries(odd.map((key, index) => [key, `mode ${index}`])) }
    })
    let record = await stored()
    odd.forEach((key, index) => {
      expect(Object.prototype.hasOwnProperty.call(record.claude_settings, key)).toBe(true)
      expect(record.claude_settings[key]).toBe(index)
      expect(record.dcmDisplaySettings.groups[key]).toBe(`mode ${index}`)
    })
    expect(record.subagentType).toBe('api')
    await redis.updateSubagent(SUB, {
      claude_settings: Object.fromEntries(odd.map((key) => [key, null])),
      dcmDisplaySettings: { groups: Object.fromEntries(odd.map((key) => [key, null])) }
    })
    record = await stored()
    expect(record.claude_settings).toEqual({ model: 'sonnet', permissionMode: 'default' })
    expect(record.dcmDisplaySettings.groups).toEqual({})
  })
})

// SA-139 R5: the BL-1542 CLI promotion guard (a Claude Code CLI Subagent's first form save) went
// with that Subagent type; its default-lane and real-script cases were removed with it.
describe.skipIf(!REAL)('updateSubagent against the real script (real Redis)', () => {
  /** Runs `change` at the actual serialized-ops mutation, after all readonly preparation.
   * Every Subagent mutation carries its server-owned updated_at op; snapshot reads carry paths.
   * An unexpected producer shape leaves the probe unreached rather than moving the race early. */
  function beforeScript(change: (client: any) => Promise<void>) {
    const execute = redis.execute.bind(redis)
    const scriptCalls: string[][] = []
    const scriptKeys: string[][] = []
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      execute(async (client: any) => {
        const wrapped = new Proxy({}, {
          get(_empty, property) {
            if (property === 'eval') {
              return async (script: string, options: { keys?: string[]; arguments?: string[] }) => {
                let ops: unknown
                try { ops = JSON.parse(options.arguments?.[0] ?? '') } catch {}
                if (options?.keys?.[0] === KEY && Array.isArray(ops) && ops.every(Array.isArray) &&
                    ops.some(op => op[0] === 'set' && op[1] === '$.updated_at')) {
                  scriptCalls.push([...(options.arguments ?? [])])
                  scriptKeys.push([...(options.keys ?? [])])
                  await change(client)
                }
                const answer = await client.eval(script, options)
                return answer
              }
            }
            const value = Reflect.get(client, property, client)
            return typeof value === 'function' ? value.bind(client) : value
          },
          has(_empty, property) { return property in client }
        })
        return operation(wrapped)
      })) as any)
    return { scriptCalls, scriptKeys }
  }

  it('a change written by another writer right before the script survives: only the named paths are written', async () => {
    await seed()
    beforeScript(async (client) => {
      await client.json.set(KEY, '$.claude_settings.model', 'opus')
      await client.json.set(KEY, '$.description', 'written meanwhile')
      await client.json.set(KEY, '$.subagentType', 'cli')
    })
    await redis.updateSubagent(SUB, { claude_settings: { alwaysThinkingEnabled: true }, displayName: 'Saved' })
    const record = await stored()
    expect(record.claude_settings).toEqual({ model: 'opus', permissionMode: 'default', alwaysThinkingEnabled: true })
    expect(record.description).toBe('written meanwhile')
    expect(record.subagentType).toBe('cli')
    expect(record.displayName).toBe('Saved')
  })

  it('a Subagent deleted after the plan and before the script is not made again', async () => {
    await seed()
    beforeScript(async (client) => {
      await client.del(KEY)
    })
    expect(await redis.updateSubagent(SUB, { displayName: 'Ghost' })).toBe(false)
    vi.restoreAllMocks()
    expect(await redis.exists(KEY)).toBe(false)
  })

  it('many saves of different keys at the same moment all land', async () => {
    await seed({ claude_settings: {} })
    const names = Array.from({ length: 24 }, (_, index) => `key${index}`)
    const answers = await Promise.all(names.map((name, index) => redis.updateSubagent(SUB, { claude_settings: { [name]: index } })))
    expect(answers.every(Boolean)).toBe(true)
    const block = (await stored()).claude_settings
    expect(Object.keys(block).sort()).toEqual([...names].sort())
  })

  it("the default lane's twin applies the real script's argument the same way: odd keys, removals, null blocks, blocks that are not objects, the stamp", async () => {
    const { runSubagentUpdateScriptTwin } = await import('$lib/test-utils/agentUpdateScriptTwin')
    const odd = ['top_p.v2', 'say "hi"', `path${String.fromCharCode(92)}to`, 'arr[0]', '"]', '', '__proto__']
    const cases: Array<{ record: Record<string, unknown>; writes: Record<string, unknown>; refusal?: 400; repairWrites?: Record<string, unknown> }> = [
      { record: {}, writes: { displayName: 'Twin', description: null, system_prompt: null, timeout_seconds: null } },
      {
        record: {},
        writes: {
          provider_specific_settings: { ...Object.fromEntries(odd.map((key, index) => [key, { index }])), temperature: null },
          claude_settings: Object.fromEntries(odd.map((key, index) => [key, [index]]))
        }
      },
      // The provider-only patch proves the lower Lua/twin's container repair. (SA-139 R5: the
      // Claude Code CLI native model write that was refused beside it here went with that lane.)
      { record: { provider_specific_settings: 'not an object', claude_settings: null }, writes: { provider_specific_settings: { knob: 1 } } },
      { record: {}, writes: { provider_specific_settings: null, claude_settings: null, dcmDisplaySettings: null }, refusal: 400,
        repairWrites: { provider_specific_settings: { temperature: null, nativeTools: { bashAccessMode: null } }, claude_settings: null, dcmDisplaySettings: null } },
      { record: { provider_specific_settings: { nativeTools: 'odd' } }, writes: { provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } } } },
      { record: { provider_specific_settings: { temperature: 1 } }, writes: { provider_specific_settings: { nativeTools: { bashAccessMode: null } } } },
      { record: { dcmDisplaySettings: { version: 1, groups: { a: 'x' }, tools: { t: 'y' } } }, writes: { dcmDisplaySettings: { version: 1, groups: { ...Object.fromEntries(odd.map((key, index) => [key, `mode ${index}`])), a: null }, tools: { t2: 'n' }, toolDisplayPreferences: null } } },
      { record: { dcmDisplaySettings: 'odd' }, writes: { dcmDisplaySettings: { groups: { a: 'hidden' } } } },
      { record: { dcmDisplaySettings: { version: 1, groups: 'odd', tools: null } }, writes: { dcmDisplaySettings: { groups: { a: 'hidden' }, tools: { b: 'hidden' } } } },
      { record: {}, writes: { dcmDisplaySettings: { groups: { a: null } }, claude_settings: {} } },
      // The type rule's writes: removals of the pair and the legacy type, then a type alone.
      { record: { subagentType: 'cli', webhook_url: 'u', webhookUrl: 'u', workflowName: 'w', subagent_type: 'cli' }, writes: { subagentType: 'api', subagent_type: null, webhook_url: null, webhookUrl: null, workflowName: null } },
      { record: {}, writes: { subagentType: 'api', subagent_type: null } }
    ]
    for (const vector of cases) {
      const { record, writes: originalWrites, refusal, repairWrites } = vector
      await seed(record)
      const before = await stored()
      if (refusal) {
        const refusalProbe = beforeScript(async () => {})
        await expect(redis.updateSubagent(SUB, originalWrites)).rejects.toMatchObject({ status: refusal,
          message: expect.stringContaining('Keep the explicit Typed File Tools choice') })
        expect(refusalProbe.scriptCalls).toHaveLength(0)
        expect(await stored()).toEqual(before)
        vi.restoreAllMocks()
      }
      const writes = repairWrites ?? originalWrites
      const leaves = instructionLeaves(writes)
      const expectedInstructions = leaves.length
        ? (await redis.execute(client => readInstructionsSnapshot(client, SUB, 'subagent', undefined, leaves))).revisions
        : undefined
      const expectedModelSelection = namesModelSelection('subagent', writes)
        ? (await redis.execute(client => readModelSelectionSnapshot(client, SUB, 'subagent'))).revision
        : undefined
      const probe = beforeScript(async () => {})
      try { expect(await redis.updateSubagent(SUB, writes, { expectedInstructions, expectedModelSelection })).toBe(true) }
      catch (cause) { throw new Error(`Parity vector: ${JSON.stringify({ record, writes })}`, { cause }) }
      vi.restoreAllMocks()
      expect(probe.scriptCalls.length).toBe(1)
      const twin = runSubagentUpdateScriptTwin(before, probe.scriptCalls[0])
      expect(twin.record).toEqual(await stored())
    }
  })
})
