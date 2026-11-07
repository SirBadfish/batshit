// Existing SA-122 strict per-invocation allocation/client admission, shared by its owning test files only.
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, dirname, isAbsolute } from 'node:path'
import type { redis as service } from '$lib/server/redis'
import type { RedisTestServerOptions } from './redis-memory'

export interface RedisCiServiceOwner {
  kind: 'github-actions-service'
  serviceId: string
  githubRunId: string
  githubRunAttempt: string
  localAddress: string
}

/** A captured current-job container identity, never bare CI=true or a URL-derived grant. */
export function assertRedisCiServiceOwner(value: unknown): Readonly<RedisCiServiceOwner> {
  const owner = value as RedisCiServiceOwner
  const fields = ['kind', 'serviceId', 'githubRunId', 'githubRunAttempt', 'localAddress']
  const address = typeof owner?.localAddress === 'string' ? owner.localAddress.match(/^([^:]+):6379$/) : null
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) ||
      Object.keys(owner).length !== fields.length || fields.some(field => !Object.hasOwn(owner, field)) ||
      owner.kind !== 'github-actions-service' || process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true' ||
      !/^[a-f0-9]{64}$/.test(owner.serviceId) || !/^[1-9][0-9]*$/.test(owner.githubRunId) ||
      !/^[1-9][0-9]*$/.test(owner.githubRunAttempt) || !address || isIP(address[1]) !== 4 ||
      owner.serviceId !== process.env.BATSHIT_REDIS_CI_SERVICE_ID ||
      owner.githubRunId !== process.env.GITHUB_RUN_ID || owner.githubRunAttempt !== process.env.GITHUB_RUN_ATTEMPT) {
    throw new Error('Redis CI allocation does not belong to this Actions service/run attempt.')
  }
  return Object.freeze({ ...owner })
}

export function createSettingsRedisAdmission(redis: Pick<typeof service, 'execute' | 'disconnect'>): {
  beforeCleanupAdmission: NonNullable<RedisTestServerOptions['beforeCleanupAdmission']>
  close(): Promise<void>
} {
interface Allocation {
  schemaVersion: 1 | 2
  allocationId: string
  createdAt: string
  host: '127.0.0.1'
  port: number
  database: 14
  runId: string
  receiptPath: string
  ciOwner?: Readonly<RedisCiServiceOwner>
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
  const names = ['schemaVersion', 'allocationId', 'createdAt', 'host', 'port', 'database', 'runId', 'receiptPath',
    ...(value?.schemaVersion === 2 ? ['ciOwner'] : [])]
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name)) ||
      ![1, 2].includes(value.schemaVersion) || typeof value.allocationId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.allocationId) ||
      value.host !== '127.0.0.1' || !Number.isInteger(value.port) ||
    (value.schemaVersion === 1 ? value.port < 49152 || value.port > 65535 : value.port !== 6379) ||
      value.database !== 14 || typeof value.runId !== 'string' || !/^[a-f0-9]{40}$/.test(value.runId) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      Date.now() - Date.parse(value.createdAt) < 0 || Date.now() - Date.parse(value.createdAt) > 30 * 60_000 ||
      typeof value.receiptPath !== 'string' || !isAbsolute(value.receiptPath) ||
      dirname(value.receiptPath) !== dirname(path) || basename(value.receiptPath) !== 'settings-redis-admission.json') {
    throw new Error('Settings Redis allocation is invalid or stale; no fixture authority was admitted.')
  }
  if (value.schemaVersion === 2) {
    const ciOwner = assertRedisCiServiceOwner(value.ciOwner)
    const parent = await lstat(dirname(path))
    const runnerRoot = process.env.RUNNER_TEMP && await realpath(process.env.RUNNER_TEMP)
    if (!runnerRoot || (dirname(path) !== runnerRoot && !dirname(path).startsWith(runnerRoot + '/')) ||
        await realpath(path) !== path || !parent.isDirectory() || parent.isSymbolicLink() ||
        stat.uid !== process.getuid?.() || parent.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0) {
      throw new Error('Settings CI allocation is not a private current-run temporary file.')
    }
    return Object.freeze({ ...value, ciOwner })
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
      connection.laddr !== (allocation.ciOwner?.localAddress ?? `${allocation.host}:${allocation.port}`) || typeof rawServer !== 'string' ||
      size !== 0 || missingJson !== null || !client.isOpen || !client.isReady) {
    throw new Error('Settings Redis admission received a wrong or malformed connection/empty JSON reply.')
  }
  function serverField(name: string) {
    const matches = rawServer.split(/\r?\n/).filter((line: string) => line.startsWith(`${name}:`))
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

return {
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
  },
  async close() { suiteClosed = true; await closeAppClient() }
}
}
