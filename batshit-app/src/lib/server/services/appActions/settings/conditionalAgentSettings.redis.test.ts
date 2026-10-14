import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { lstat, open, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { AbortError } from 'redis'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import type { SettingsOwnerContext } from '$lib/appActions/settings/validation'
import { CONDITIONAL_SETTINGS_WRITE_SCRIPT, SETTINGS_SNAPSHOT_PATHS, createConditionalSettingsStore } from './conditionalAgentSettings'

// The default fake has no interpreter for this new script. These assertions must
// run against the real DB14 worker lane after the coordinator releases it; a simulated
// script is not atomicity or RedisJSON wire-shape proof.
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const ID = 'sa122_settings_atomic_probe'
const USER = 'sa122_settings_probe_user'
const KEY = `agent:${ID}`
const STAMP = '2026-10-04T00:00:00.000Z'

interface Allocation {
  schemaVersion: 1
  allocationId: string
  createdAt: string
  host: '127.0.0.1'
  port: number
  database: 14
  runId: string
  receiptPath: string
}

// Supplied only by the later fresh disposable-server allocation. There are no defaults.
async function readAllocation(): Promise<Allocation> {
  const path = process.env.SA122_SETTINGS_REDIS_ALLOCATION
  if (!path || !isAbsolute(path) || basename(path) !== 'settings-redis-allocation.json') {
    throw new Error('Settings Redis admission requires a fresh absolute settings-redis-allocation.json path.')
  }
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Settings Redis allocation must be a regular file.')
  const value = JSON.parse(await readFile(path, 'utf8'))
  const names = ['schemaVersion', 'allocationId', 'createdAt', 'host', 'port', 'database', 'runId', 'receiptPath']
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name)) ||
      value.schemaVersion !== 1 || typeof value.allocationId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.allocationId) ||
      value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 49152 || value.port > 65535 ||
      value.database !== 14 || typeof value.runId !== 'string' || !/^[a-f0-9]{40}$/.test(value.runId) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      Date.now() - Date.parse(value.createdAt) < 0 || Date.now() - Date.parse(value.createdAt) > 30 * 60_000 ||
      typeof value.receiptPath !== 'string' || !isAbsolute(value.receiptPath) ||
      dirname(value.receiptPath) !== dirname(path) || basename(value.receiptPath) !== 'settings-redis-admission.json') {
    throw new Error('Settings Redis allocation is invalid or stale; no fixture authority was admitted.')
  }
  return value
}

function checkUrl(url: string | undefined, allocation: Allocation, database: 15 | 14) {
  if (!url) throw new Error('Settings Redis admission is missing its explicit URL.')
  const parsed = new URL(url)
  if (parsed.protocol !== 'redis:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.hostname !== allocation.host || parsed.port !== String(allocation.port) || parsed.pathname !== `/${database}`) {
    throw new Error('Settings Redis admission URL does not match its owned endpoint and database.')
  }
}

async function connectionEvidence(client: any, allocation: Allocation) {
  if (!client.isOpen || !client.isReady) throw new Error('Settings Redis admission requires a ready connection.')
  const [connection, rawServer, size, missingJson] = await Promise.all([
    client.clientInfo(), client.info('server'), client.dbSize(),
    client.sendCommand(['JSON.GET', 'sa122:settings:admission:missing', '$'])
  ])
  if (!connection || typeof connection !== 'object' || Array.isArray(connection) ||
      !Number.isSafeInteger(connection.id) || connection.id <= 0 || connection.db !== 14 ||
      connection.laddr !== `${allocation.host}:${allocation.port}` || typeof rawServer !== 'string' ||
      size !== 0 || missingJson !== null || !client.isOpen || !client.isReady) {
    throw new Error('Settings Redis admission received a wrong or malformed connection/empty JSON reply.')
  }
  function serverField(name: string) {
    const matches = rawServer.split(/\r?\n/).filter(line => line.startsWith(`${name}:`))
    if (matches.length !== 1) throw new Error('Settings Redis admission received malformed INFO server.')
    return matches[0].slice(name.length + 1)
  }
  const version = serverField('redis_version')
  const runId = serverField('run_id')
  const port = serverField('tcp_port')
  if (version !== '8.10.1' || runId !== allocation.runId || port !== String(allocation.port)) {
    throw new Error('Settings Redis admission server/version differs from its fresh allocation.')
  }
  // Explicit projection: never record client usernames, credentials, unrelated config or records.
  return { client: { id: connection.id as number, database: 14, localAddress: connection.laddr as string },
    server: { version, runId, port: allocation.port }, emptyDatabase: true, missingJsonGet: null }
}

let appClientTouched = false
let suiteClosed = false
let appAdmissionRead: ReturnType<typeof connectionEvidence> | undefined
let appAdmissionSettled = true
let appClosure: Promise<void> | undefined
function closeAppClient(): Promise<void> {
  if (appClosure) return appClosure
  if (!appClientTouched) return Promise.resolve()
  // This suite owns the module service connection in its one-file isolated worker.
  appClosure = (async () => {
    const errors: unknown[] = []
    if (!appAdmissionSettled) {
      // Close an already assigned partial client, then settle lazy acquisition too.
      try { await redis.disconnect() } catch (error) { errors.push(error) }
      try { await appAdmissionRead } catch { /* The admission caller retains its read error. */ }
    }
    try { await redis.disconnect() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Settings Redis app connection close failed.')
    appClientTouched = false
  })().finally(() => { appClosure = undefined })
  return appClosure
}

async function finishReceiptResource(
  phase: 'file' | 'directory', work: () => Promise<void>, close: () => Promise<void>
) {
  const errors: unknown[] = []
  try { await work() } catch (error) { errors.push(error) }
  try { await close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `Settings Redis receipt ${phase} operation and close failed.`)
}

const admission = useRedisTestServer({
  beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
    try {
      const allocation = await readAllocation()
      checkUrl(process.env.BATSHIT_REDIS_TEST_URL, allocation, 15)
      checkUrl(resolvedUrl, allocation, 14)
      checkUrl(process.env.REDIS_URL, allocation, 14)
      const admin = await connectionEvidence(adminClient, allocation)
      if (suiteClosed) throw new Error('Settings Redis admission continued after teardown.')
      appClientTouched = true
      appAdmissionSettled = false
      appAdmissionRead = redis.execute(async client => {
        if (suiteClosed) {
          if (client?.isOpen) await client.disconnect()
          throw new Error('Settings Redis app connection was acquired after teardown.')
        }
        return connectionEvidence(client, allocation)
      })
      let app: Awaited<ReturnType<typeof connectionEvidence>>
      try { app = await appAdmissionRead } finally { appAdmissionSettled = true }
      if (suiteClosed) throw new Error('Settings Redis admission continued after teardown.')
      if (admin.client.id === app.client.id) throw new Error('Settings Redis admission requires both distinct actual client connections.')
      const receipt = {
        schemaVersion: 1, allocationId: allocation.allocationId, recordedAt: new Date().toISOString(),
        requestedUrl: process.env.BATSHIT_REDIS_TEST_URL, resolvedUrl, expectedDatabase: 14, admin, app
      }
      const file = await open(allocation.receiptPath, 'wx', 0o600)
      await finishReceiptResource('file', async () => {
        await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
        await file.sync()
      }, () => file.close())
      // Also sync the new directory entry before releasing fixture/cleanup authority.
      const directory = await open(dirname(allocation.receiptPath), 'r')
      await finishReceiptResource('directory', () => directory.sync(), () => directory.close())
    } catch (error) {
      try { await closeAppClient() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Settings Redis admission and app connection cleanup failed.')
      }
      throw error
    }
  }
})
afterAll(async () => { suiteClosed = true; await closeAppClient() })

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
