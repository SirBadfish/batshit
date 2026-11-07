import path from 'node:path'
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { clearRedisTestDatabase, useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-844, BL-914: the route contract the Subagent form's changed-fields save relies on
 * (`subagentSettingsSavePatch.ts`). The PUT writes each field the body names by path (BL-914,
 * `redis.updateSubagent`), so a body that names one field keeps every other stored field, so a
 * change made to the Subagent elsewhere survives a save that did not name it. A block is written
 * KEY BY KEY: `provider_specific_settings` and
 * `dcmDisplaySettings` keep the keys the body does not name, and a key (or a `dcmDisplaySettings`
 * map entry) sent as `null` is removed. `{}` names nothing, so a block the user emptied is sent as
 * `null` for each key it had. Provider/native ancestors cannot be cleared wholesale because that
 * would erase explicit tool choices. SA-139 R5: a body's `claude_settings` (the removed Claude Code
 * CLI Subagent's block) is never written, like R1's `codex_settings`.
 * The overlapping-save and every-block tests are in `subagent-update-by-path.test.ts`.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis`; the default lane's RedisJSON
 * fake under plain `npm test`.
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

const ownedRedisAdmission = useRedisTestServer({ beforeCleanupAdmission: admitOwnedRedis })
afterAll(retireOwnedRedis)

const USER = 'ss844_route_user'
const SUB = 'ss844_route_sub'

const RECORD = {
  id: SUB,
  user_id: USER,
  displayName: 'ss844 route sub',
  slug: SUB,
  subagentType: 'api',
  specialty: 'general',
  system_prompt: 'Answer only in haiku.',
  include_global_prompt: true,
  primary_model_provider: 'openai',
  primary_model_name: 'gpt-5.5',
  primary_model_preset_id: 'ss844_preset',
  primary_model_connection: { type: 'direct', service: 'openai' },
  timeout_seconds: 45,
  avatar: null,
  provider_specific_settings: { temperature: 0.7, nativeTools: { webSearchEnabled: false } },
  created_at: '2026-09-28T00:00:00.000Z',
  updated_at: '2026-09-28T00:00:00.000Z'
}

async function seed() {
  await redis.json.set(`subagent:${SUB}`, '$', RECORD as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
}

async function callPut(updates: Record<string, unknown>) {
  const { PUT } = await import('./+server')
  const request = new Request(`http://localhost/api/subagents/${SUB}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })
  const response = (await PUT({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
  return { status: response.status, body: await response.json() }
}

async function stored() {
  return (await redis.json.get(`subagent:${SUB}`)) as Record<string, any>
}

describe('a Subagent save that names only some fields (BL-844)', () => {
  it('keeps every field it does not name, whatever another window changed since', async () => {
    await seed()
    // Another window changes the timeout and the prompt after this copy was taken.
    await redis.json.set(`subagent:${SUB}`, '$', { ...RECORD, timeout_seconds: 90, system_prompt: 'Answer in limericks.' } as any)

    const { status } = await callPut({ displayName: 'ss844 renamed' })

    expect(status).toBe(200)
    const record = await stored()
    expect(record.displayName).toBe('ss844 renamed')
    expect(record.timeout_seconds).toBe(90)
    expect(record.system_prompt).toBe('Answer in limericks.')
    expect(record.primary_model_preset_id).toBe('ss844_preset')
    expect(record.primary_model_connection).toEqual({ type: 'direct', service: 'openai' })
    expect(record.include_global_prompt).toBe(true)
    expect(record.provider_specific_settings).toEqual(RECORD.provider_specific_settings)
  }, 30_000)

  it('writes provider_specific_settings key by key: a key the body does not name stays, a key named null is removed', async () => {
    await seed()

    await callPut({ provider_specific_settings: { nativeTools: { webSearchEnabled: true }, seed: 7, temperature: null } })

    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: { webSearchEnabled: true }, seed: 7 })
  }, 30_000)

  // SA-139 R5: the Claude Code CLI Subagent was removed. A body claude_settings is never written;
  // a leftover block stays as it was (no migration), and the rest of the save lands.
  it('never writes a body claude_settings block, and leaves a stored one as it was', async () => {
    await seed()
    const leftover = { model: 'opus', permissionMode: 'plan', addDirs: ['/one'] }
    await redis.json.set(`subagent:${SUB}`, '$', { ...RECORD, claude_settings: leftover } as any)

    const { status } = await callPut({ claude_settings: { permissionMode: 'acceptEdits' }, displayName: 'ss844 renamed' })

    expect(status).toBe(200)
    const record = await stored()
    expect(record.displayName).toBe('ss844 renamed')
    expect(record.claude_settings).toEqual(leftover)
  }, 30_000)

  // SA-139 R1: Codex CLI was removed. A body codex_settings is never written; a leftover block
  // stays as it was (no migration), and the rest of the save lands.
  it('never writes a body codex_settings block, and leaves a stored one as it was', async () => {
    await seed()
    const leftover = { model: 'gpt-5.5', reasoningEffort: 'high', addDirs: ['/one'] }
    await redis.json.set(`subagent:${SUB}`, '$', { ...RECORD, codex_settings: leftover } as any)

    const { status } = await callPut({ codex_settings: { model: 'gpt-6-sol' }, displayName: 'ss844 renamed' })

    expect(status).toBe(200)
    const record = await stored()
    expect(record.displayName).toBe('ss844 renamed')
    expect(record.codex_settings).toEqual(leftover)
  }, 30_000)

  it('an empty block names nothing; ancestors preserve explicit tool choices and individual null leaves clear', async () => {
    await seed()

    await callPut({ displayName: 'ss844 renamed' })
    expect((await stored()).provider_specific_settings).toEqual(RECORD.provider_specific_settings)

    await callPut({ provider_specific_settings: {} })
    expect((await stored()).provider_specific_settings).toEqual(RECORD.provider_specific_settings)

    const before = await stored()
    for (const provider_specific_settings of [{ temperature: null, nativeTools: null }, null]) {
      const refusal = await callPut({ displayName: 'Must not land', provider_specific_settings })
      expect(refusal.status).toBe(400)
      expect(refusal.body.error).toContain('Keep the explicit Typed File Tools choice; clear individual')
      expect(await stored()).toEqual(before)
    }
    const cleared = await callPut({ provider_specific_settings: { temperature: null, nativeTools: { webSearchEnabled: null } } })
    expect(cleared.status).toBe(200)
    expect((await stored()).provider_specific_settings).toEqual({ nativeTools: {} })
  }, 30_000)
})
