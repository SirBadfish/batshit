// @vitest-environment node
/** Required source reads must settle before manual archive publication or original-data moves.
 * Uses the existing Redis harness and original restore/staging/barrier fixture shapes. The local
 * client view only injects malformed replies and a later (rollback-capture) command failure,
 * which failNextRedisCommand cannot target. No service, controller, account or install is created.
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { failNextRedisCommand } from '$lib/test-utils/redis-command-failure'
import {
  createBackupBundle,
  createBackupBundleStream,
  preflightBackupRestore,
  preflightStagedBackupRestore,
  restoreBackupBundle,
  restoreStagedBackup
} from '../backupRestoreService'
import { POST as exportRoute } from '../../../../routes/api/admin/backup/export/+server'

vi.mock('../zipDefaultsSweep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../zipDefaultsSweep')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return actual
  return { ...actual, sweepOldZipDefaults: async () => ({ status: 'already-complete', records: 0, rows: 0, fields: 0, changed: [] }) }
})

useRedisTestServer()
const SOURCE = 'inventory-source'
const TARGET = 'inventory-target'
const SOURCE_SETTINGS = `user:${SOURCE}:settings`
const TARGET_SETTINGS = `user:${TARGET}:settings`
const SOURCE_SESSIONS = `user:${SOURCE}:sessions`
const TARGET_SESSIONS = `user:${TARGET}:sessions`
const SOURCE_DM_INDEX = `dm_index:${SOURCE}`
const TARGET_DM_INDEX = `dm_index:${TARGET}`
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
let root = ''
let uploadRoot = ''
let stagingRoot = ''
let archive: Uint8Array

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-source-inventory-'))
  uploadRoot = path.join(root, 'uploads')
  stagingRoot = path.join(root, 'staging')
  await fs.mkdir(uploadRoot)
  await fs.mkdir(stagingRoot)
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', stagingRoot)
  vi.stubEnv('BATSHIT_HOME_DIR', path.join(root, 'home'))
  vi.stubEnv('BATSHIT_RUNTIME_OWNER', 'native')
  vi.stubEnv('BATSHIT_TOKEN', 'source-inventory-owned-fixture-token')
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/\/api\/upload\/asset-maintenance\/(begin|end)$/)
    const { token } = JSON.parse(String(init.body))
    return Response.json({ success: true, token, state: url.endsWith('/begin') ? 'created' : 'released', activeOperations: 0 })
  }))
  await redis.json.set(SOURCE_SETTINGS, '$', { user_id: SOURCE, theme: 'incoming' })
  await redis.sAdd(SOURCE_SESSIONS, 'incoming-chat')
  await redis.json.set('session:incoming-chat', '$', { user_id: SOURCE, title: 'Incoming chat' })
  await redis.execute(async (client) => client.zAdd(SOURCE_DM_INDEX, [{ value: 'incoming-dm', score: 1 }]))
  await redis.json.set('dm:incoming-dm', '$', { userId: SOURCE, text: 'Incoming message' })
  await fs.writeFile(path.join(uploadRoot, 'fixture.bin'), 'incoming file')
  await redis.json.set('upload:images:fixture.bin', '$', { storage: 'filesystem', relativePath: 'fixture.bin', filePath: path.join(uploadRoot, 'fixture.bin') })
  archive = (await createBackupBundle(SOURCE)).bytes
  await redis.json.set(TARGET_SETTINGS, '$', { user_id: TARGET, theme: 'original' })
  await redis.sAdd(TARGET_SESSIONS, 'current-chat')
  await redis.json.set('session:current-chat', '$', { user_id: TARGET, title: 'Current chat' })
  await redis.execute(async (client) => client.zAdd(TARGET_DM_INDEX, [{ value: 'current-dm', score: 1 }]))
  await redis.json.set('dm:current-dm', '$', { userId: TARGET, text: 'Current message' })
  await fs.writeFile(path.join(uploadRoot, 'fixture.bin'), 'original file')
  await fs.writeFile(path.join(uploadRoot, 'keep.txt'), 'original sibling')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})

async function stage() {
  const stageId = randomUUID()
  const key = createHash('sha256').update(stageId).digest('hex')
  await fs.writeFile(path.join(stagingRoot, `${key}.zip`), archive)
  await fs.writeFile(path.join(stagingRoot, `${key}.json`), JSON.stringify({
    contract: 'batshit-backup-stage/v1', stageId, userId: TARGET, filename: 'source-inventory.zip',
    bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'),
    stagedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
  }))
  return stageId
}
async function originalDataIsIntact() {
  expect(await redis.json.get(TARGET_SETTINGS)).toEqual({ user_id: TARGET, theme: 'original' })
  expect(await redis.json.get('session:current-chat')).toEqual({ user_id: TARGET, title: 'Current chat' })
  expect(await fs.readFile(path.join(uploadRoot, 'fixture.bin'), 'utf8')).toBe('original file')
  expect(await fs.readFile(path.join(uploadRoot, 'keep.txt'), 'utf8')).toBe('original sibling')
}
function decodedRecords(bytes: Uint8Array) {
  return Object.entries(unzipSync(bytes)).filter(([name]) => name.startsWith('redis/records/'))
    .map(([, value]) => JSON.parse(Buffer.from(value).toString()))
}
/** Raw-client injection works on both harness lanes, retaining the real command for other keys. */
function commandView(command: string, replacement: (args: unknown[], calls: number, normal: () => Promise<any>) => Promise<any>) {
  const [head, method] = command.includes('.') ? command.split('.', 2) : [null, command]
  const original = redis.execute
  let calls = 0
  const view = (source: any, atMethod: boolean): any => new Proxy(Object.create(null), {
    get(_target, property) {
      const value = Reflect.get(source, property, source)
      if (atMethod && property === method && typeof value === 'function') {
        return async (...args: unknown[]) => replacement(args, ++calls, () => value.apply(source, args))
      }
      if (!atMethod && property === head && value && typeof value === 'object') return view(value, true)
      return typeof value === 'function' ? value.bind(source) : value
    }
  })
  ;(redis as any).execute = async (operation: (client: any) => Promise<any>) => await original.call(redis, async (client: any) => operation(view(client, head === null)))
  return { restore: () => { (redis as any).execute = original }, calls: () => calls }
}
function sourceFailure(operation?: string) {
  return { name: 'BackupRestoreError', status: 500, details: { code: 'BACKUP_SOURCE_READ_FAILED', ...(operation ? { operation } : {}) } }
}

describe('required source inventory for manual exports', () => {
  for (const command of ['sMembers', 'zRange', 'type', 'exists', 'keys', 'json.get', 'ttl']) {
    it.each(['buffer', 'route'] as const)(`refuses a failed ${command} read before %s publication`, async (entrypoint) => {
      const failure = failNextRedisCommand(command, new Error('injected source failure'))
      try {
        if (entrypoint === 'buffer') await expect(createBackupBundle(SOURCE)).rejects.toMatchObject(sourceFailure())
        else {
          const response = await exportRoute({
            locals: { user: { id: SOURCE, is_admin: true } },
            request: new Request('http://127.0.0.1/api/admin/backup/export', { method: 'POST', body: '{}' })
          } as any)
          expect(response.status).toBe(500)
          expect(await response.json()).toMatchObject({ details: { code: 'BACKUP_SOURCE_READ_FAILED' } })
          expect(response.headers.get('content-type')).not.toContain('application/zip')
        }
        expect(failure.failed()).toBe(true)
      } finally { failure.restore() }
      await originalDataIsIntact()
    })
  }

  it('does not permit the old explicit false strictInventory marker to suppress a read failure', async () => {
    const failure = failNextRedisCommand('sMembers', new Error('injected source failure'))
    try { await expect(createBackupBundleStream(SOURCE, { strictInventory: false })).rejects.toMatchObject(sourceFailure('SMEMBERS')) }
    finally { failure.restore() }
  })

  it.each(['set', 'zset'] as const)('refuses a wrong-type %s index instead of treating it as empty', async (type) => {
    const key = type === 'set' ? SOURCE_SESSIONS : SOURCE_DM_INDEX
    await redis.execute(async (client) => { await client.del(key); await client.set(key, 'wrong type') })
    await expect(createBackupBundle(SOURCE)).rejects.toMatchObject(sourceFailure('TYPE'))
  })

  it('refuses a sparse first index reply even when its later record read would be dense', async () => {
    let reads = 0
    const fault = commandView('sMembers', async (args, _calls, normal) => args[0] === SOURCE_SESSIONS && ++reads === 1 ? new Array(1) : normal())
    try {
      await expect(createBackupBundle(SOURCE)).rejects.toMatchObject(sourceFailure('SMEMBERS'))
      expect(reads).toBe(1)
    } finally { fault.restore() }
  })

  it.each([
    ['sMembers', SOURCE_SESSIONS, [false]],
    ['zRange', SOURCE_DM_INDEX, { member: 'incoming-dm' }],
    ['exists', SOURCE_SETTINGS, true],
    ['keys', `project:${SOURCE}:*`, 'not-an-array'],
    ['type', SOURCE_SETTINGS, 'stream'],
    ['ttl', SOURCE_SETTINGS, '120'],
    ['json.get', SOURCE_SETTINGS, { nested: undefined }],
    ['json.get', SOURCE_SETTINGS, Number.NaN],
    ['json.get', SOURCE_SETTINGS, 1n]
  ] as const)('refuses an invalid %s reply for %s', async (command, key, reply) => {
    const fault = commandView(command, async (args, _calls, normal) => args[0] === key ? reply : normal())
    try { await expect(createBackupBundle(SOURCE)).rejects.toMatchObject(sourceFailure()) }
    finally { fault.restore() }
  })

  it('keeps true missing optional indexes, JSON null/scalars/empty roots and positive TTLs readable', async () => {
    for (const value of [null, true, 4, 'text', [], {}, ['one']]) {
      await redis.json.set(SOURCE_SETTINGS, '$', value)
      const exported = await createBackupBundle(SOURCE)
      expect(decodedRecords(exported.bytes).find((record) => record.key === SOURCE_SETTINGS).value).toEqual(value)
    }
    await redis.execute(async (client) => { await client.del(SOURCE_SESSIONS); await client.expire(SOURCE_SETTINGS, 120) })
    const exported = await createBackupBundle(SOURCE)
    const record = decodedRecords(exported.bytes).find((item) => item.key === SOURCE_SETTINGS)
    expect(record.ttlSeconds).toBeGreaterThan(0)
    expect(record.ttlSeconds).toBeLessThanOrEqual(120)
    expect(decodedRecords(exported.bytes).some((item) => item.key === SOURCE_SESSIONS)).toBe(false)
  })

  it('refuses a still-present TTL0 instead of exporting it as persistent', async () => {
    const fault = commandView('ttl', async (args, _calls, normal) => args[0] === SOURCE_SETTINGS ? 0 : normal())
    try { await expect(createBackupBundle(SOURCE)).rejects.toMatchObject(sourceFailure('TTL')) }
    finally { fault.restore() }
    expect(await redis.json.get(SOURCE_SETTINGS)).toEqual({ user_id: SOURCE, theme: 'incoming' })
  })

  it('skips a TTL0 row only when a fresh TYPE confirms true absence', async () => {
    let expired = false
    const ttl = commandView('ttl', async (args, _calls, normal) => { if (args[0] === SOURCE_SETTINGS) { expired = true; return 0 }; return normal() })
    const type = commandView('type', async (args, _calls, normal) => args[0] === SOURCE_SETTINGS && expired ? 'none' : normal())
    try { expect(decodedRecords((await createBackupBundle(SOURCE)).bytes).some((record) => record.key === SOURCE_SETTINGS)).toBe(false) }
    finally { type.restore(); ttl.restore() }
  })
})

describe('restore source reads settle before original-data changes', () => {
  it.runIf(REAL_REDIS_LANE)('preserves an actual ReJSON-RL JSON-null migration marker and legacy memory without rerunning', async () => {
    const { ensureMemoryMediaMigration } = await import('../memory/memoryMediaMigration')
    const { MEMORY_MEDIA_MIGRATION_KEY } = await import('../memory/memoryKeys')
    const key = 'memory:source_inventory_agent:legacy'
    const legacy = { id: 'legacy', user_id: TARGET, agent_id: 'source_inventory_agent', clip_ids: ['missing-owned-fixture-clip'], provenance: [{ note: 'Keep exact legacy value' }] }
    const before = await redis.execute(async (client) => {
      await client.sendCommand(['JSON.SET', MEMORY_MEDIA_MIGRATION_KEY, '$', 'null'])
      await client.json.set(key, '$', legacy)
      expect(await client.type(MEMORY_MEDIA_MIGRATION_KEY)).toBe('ReJSON-RL')
      return [await client.sendCommand(['JSON.GET', MEMORY_MEDIA_MIGRATION_KEY]), await client.sendCommand(['JSON.GET', key])]
    })
    await expect(ensureMemoryMediaMigration()).rejects.toThrow('migration receipt is unreadable or unsupported')
    const after = await redis.execute(async (client) => {
      expect(await client.type(MEMORY_MEDIA_MIGRATION_KEY)).toBe('ReJSON-RL')
      return [await client.sendCommand(['JSON.GET', MEMORY_MEDIA_MIGRATION_KEY]), await client.sendCommand(['JSON.GET', key])]
    })
    expect(after).toEqual(before)
    expect(after[0]).toBe('null')
    expect(await redis.json.get(key)).toEqual(legacy)
  })

  for (const command of ['sMembers', 'zRange', 'type', 'exists', 'keys', 'json.get', 'ttl']) {
    it.each(['buffer', 'staged'] as const)(`refuses a failed ${command} read in the %s preflight`, async (entrypoint) => {
      const stageId = entrypoint === 'staged' ? await stage() : ''
      const failure = failNextRedisCommand(command, new Error('injected current-state read failure'))
      try {
        await expect(entrypoint === 'buffer' ? preflightBackupRestore(TARGET, archive) : preflightStagedBackupRestore(TARGET, stageId)).rejects.toMatchObject(sourceFailure())
        expect(failure.failed()).toBe(true)
      } finally { failure.restore() }
      await originalDataIsIntact()
    })
  }

  for (const [command, key, operation] of [['sMembers', TARGET_SESSIONS, 'SMEMBERS'], ['json.get', TARGET_SETTINGS, 'JSON.GET']] as const) {
  it.each(['buffer', 'staged'] as const)(`refuses a later rollback ${operation} failure before the first original move through %s restore`, async (entrypoint) => {
    const stageId = entrypoint === 'staged' ? await stage() : ''
    const renamedOriginals: string[] = []
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.dirname(String(from)) === uploadRoot && !path.basename(String(from)).startsWith('.restore-')) renamedOriginals.push(String(from))
      return rename(from, to)
    })
    let reads = 0
    const fault = commandView(command, async (args, _calls, normal) => {
      if (args[0] === key && ++reads === 2) throw new Error('later rollback inventory read failed')
      return normal()
    })
    try {
      await expect(entrypoint === 'buffer' ? restoreBackupBundle(TARGET, archive, { confirmReplace: true }) : restoreStagedBackup(TARGET, stageId, { confirmReplace: true })).rejects.toMatchObject(sourceFailure(operation))
      expect(reads).toBe(2)
    } finally { fault.restore() }
    expect(renamedOriginals).toEqual([])
    await originalDataIsIntact()
  })
  }

  it.each(['buffer', 'staged'] as const)('refuses an unrepresentable current TTL0 before %s restore moves data', async (entrypoint) => {
    const stageId = entrypoint === 'staged' ? await stage() : ''
    const fault = commandView('ttl', async (args, _calls, normal) => args[0] === TARGET_SETTINGS ? 0 : normal())
    try {
      await expect(entrypoint === 'buffer' ? restoreBackupBundle(TARGET, archive, { confirmReplace: true }) : restoreStagedBackup(TARGET, stageId, { confirmReplace: true })).rejects.toMatchObject(sourceFailure('TTL'))
    } finally { fault.restore() }
    await originalDataIsIntact()
  })

  it.each(['buffer', 'staged'] as const)('counts and preserves an incoming exact-key collision absent from current indexes through %s', async (entrypoint) => {
    const original = { user_id: TARGET, oldOpaqueData: { retired: true }, title: 'Unindexed original' }
    const sibling = { user_id: TARGET, title: 'Unrelated orphan remains' }
    await redis.json.set('session:incoming-chat', '$', original)
    await redis.json.set('session:unrelated-orphan', '$', sibling)
    const stageId = entrypoint === 'staged' ? await stage() : ''
    const preview = entrypoint === 'buffer' ? await preflightBackupRestore(TARGET, archive) : await preflightStagedBackupRestore(TARGET, stageId)
    expect(preview.requiresDestructiveConfirmation).toBe(true)
    let failed = false
    const fault = commandView('json.set', async (args, _calls, normal) => {
      if (args[0] === TARGET_SETTINGS && !failed) { failed = true; throw new Error('later incoming write failed') }
      return normal()
    })
    try {
      await expect(entrypoint === 'buffer' ? restoreBackupBundle(TARGET, archive, { confirmReplace: true }) : restoreStagedBackup(TARGET, stageId, { confirmReplace: true })).rejects.toThrow('later incoming write failed')
      expect(failed).toBe(true)
    } finally { fault.restore() }
    expect(await redis.json.get('session:incoming-chat')).toEqual(original)
    expect(await redis.json.get('session:unrelated-orphan')).toEqual(sibling)
    await originalDataIsIntact()
  })

  it('does not discover current keys again after an original upload was moved', async () => {
    let originalsMoved = false
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('.restore-journal.json')) {
        const phase = JSON.parse(await fs.readFile(from, 'utf8')).phase
        if (phase === 'redis-complete') originalsMoved = false
      }
      await rename(from, to)
      if (path.dirname(String(from)) === uploadRoot && !path.basename(String(from)).startsWith('.restore-')) originalsMoved = true
    })
    const fault = commandView('keys', async (_args, _calls, normal) => {
      if (originalsMoved) throw new Error('discovery after original move is forbidden')
      return normal()
    })
    try { await expect(restoreBackupBundle(TARGET, archive, { confirmReplace: true })).resolves.toMatchObject({ restored: true }) }
    finally { fault.restore() }
    expect(await fs.readFile(path.join(uploadRoot, 'fixture.bin'), 'utf8')).toBe('incoming file')
  })
})
