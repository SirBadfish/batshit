/**
 * SA-134 V4: actual source startup -> migrations -> update consumer -> verified archives.
 * Opt-in Mac proof using the existing owned memory-search Redis harness and the existing
 * apiSurfaceAuth file-service child pattern. No provider, account bootstrap or package.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { unzipSync } from 'fflate/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { memorySearchLaneActive, useMemorySearchTestServer } from '$lib/test-utils/memory-search-server'

const control = vi.hoisted(() => ({ buildVersion: 'fixture-old-build' }))
vi.mock('$app/env', () => ({
  browser: false, building: false, dev: false,
  get version() { return control.buildVersion }
}))

const enabled = process.env.SA134_LIVE_BACKUP_UPDATE === '1' && memorySearchLaneActive() && process.platform === 'darwin'
const PORT = 5641
const ORIGIN = `http://127.0.0.1:${PORT}`
const USER = 'sa134_fixture_user'
const AGENT = 'sa134_fixture_agent'
const MEMORY = `memory:${AGENT}:legacy_memory`
const UPLOAD = 'upload:images:sa134-legacy.png'
const MARKER = 'batshit:memory_media_migration:v1'
const SERVER_ROOT = path.resolve(process.cwd(), '../batshit-server/server')
const execFileAsync = promisify(execFile)
let root = ''
let child: ChildProcess | null = null
type Boot = {
  hooks: typeof import('../../../../../hooks.server')
  service: typeof import('../../automaticBackupService')
  config: typeof import('../../automaticBackupConfig')
  storage: typeof import('../../automaticBackupStorage')
  archive: typeof import('../../backupRestoreService')
  migration: typeof import('../memoryMediaMigration')
  shutdown: typeof import('../../runtimeShutdown')
  redisModule: typeof import('$lib/server/redis')
  auth: typeof import('$lib/services/auth.server')
}
let active: Boot | null = null
const serviceToken = randomBytes(32).toString('hex')
const encryptionKey = randomBytes(32).toString('hex')

async function requireFreeFileServicePort() {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(PORT, '127.0.0.1', () => probe.close((error) => error ? reject(error) : resolve()))
  })
}

// Register before the Redis harness: a busy fixed lane or a source env file refuses
// before either fixture service starts. Inspect presence only, never read its values.
beforeAll(async () => {
  if (!enabled) return
  await requireFreeFileServicePort()
  try {
    await fs.lstat(path.join(SERVER_ROOT, '.env'))
    throw new Error('The V4 fixture requires a file-service worktree with no .env file.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-sa134-update-')))
  const home = path.join(root, 'home')
  const overrides = {
    HOME: home, BATSHIT_HOME_DIR: path.join(home, '.batshit'),
    BATSHIT_AGENT_RUNTIME_ROOT: path.join(home, '.batshit'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    BATSHIT_MANAGED_INSTALLS_ROOT: path.join(root, 'installs'),
    BATSHIT_VOICE_RUNTIME_STATE_ROOT: path.join(root, 'runtime', 'voice-engines'),
    BATSHIT_SBX_DAEMON_STATE_DIR: path.join(root, 'runtime', 'sbx-daemon'),
    BATSHIT_APPLE_CONTAINER_STATE_DIR: path.join(root, 'runtime', 'apple-container'),
    BATSHIT_RUNTIME_DATA_DIR: path.join(root, 'runtime'),
    UPLOADS_DIR: path.join(root, 'uploads'), BATSHIT_BACKUP_STAGING_DIR: path.join(root, 'staging'),
    BATSHIT_LOG_DIR: path.join(root, 'logs'), BATSHIT_SERVER_LOG_DIR: path.join(root, 'logs'),
    SESSION_STORAGE_PATH: path.join(root, 'sessions'), SESSIONS_DIR: path.join(root, 'sessions'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    XDG_CACHE_HOME: path.join(root, 'cache'), HF_HOME: path.join(root, 'cache', 'huggingface'),
    TRANSFORMERS_CACHE: path.join(root, 'cache', 'transformers'),
    BATSHIT_DOWNLOADS_DIR: path.join(root, 'downloads'),
    BATSHIT_SERVER_URL: ORIGIN, BATSHIT_SERVER_API_URL: `${ORIGIN}/api/v1`,
    PUBLIC_BATSHIT_SERVER_URL: ORIGIN,
    BATSHIT_DISABLE_SCHEDULERS: '1', BATSHIT_CONTAINERIZED: '', BATSHIT_RUNTIME_ENV: '',
    BATSHIT_RUNTIME_OWNER: 'native', BATSHIT_TOKEN: serviceToken, ENCRYPTION_KEY: encryptionKey
  }
  for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value)
  for (const folder of ['home', 'runtime', 'uploads', 'staging', 'logs', 'sessions', 'tmp', 'cache', 'downloads']) {
    await fs.mkdir(path.join(root, folder), { recursive: true })
  }
  console.info(`[SA134 V4 fixture] root=${root}; file-service=${ORIGIN}; Redis uses the existing harness's owned ephemeral port.`)
})

const harness = useMemorySearchTestServer()

async function stopAppRound() {
  if (!active) return
  await active.shutdown.closeRegisteredRuntimeResources('SA134 fixture round finished')
  await active.redisModule.disconnectAllRedisServices()
  await active.auth.authService.disconnect()
  active = null
}

async function loadBoot(buildVersion: string): Promise<Boot> {
  await stopAppRound()
  vi.restoreAllMocks()
  vi.resetModules()
  control.buildVersion = buildVersion
  const { env } = await import('$env/dynamic/private')
  Object.assign(env, {
    NODE_ENV: 'production', BATSHIT_TOKEN: serviceToken, ENCRYPTION_KEY: encryptionKey,
    BATSHIT_DISABLE_SCHEDULERS: '1', REDIS_URL: harness.url(), VERCEL: undefined,
    BATSHIT_CONTAINERIZED: '', BATSHIT_RUNTIME_ENV: '', BATSHIT_RUNTIME_OWNER: 'native'
  })
  const modules = {
    hooks: await import('../../../../../hooks.server'),
    service: await import('../../automaticBackupService'),
    config: await import('../../automaticBackupConfig'),
    storage: await import('../../automaticBackupStorage'),
    archive: await import('../../backupRestoreService'),
    migration: await import('../memoryMediaMigration'),
    shutdown: await import('../../runtimeShutdown'),
    redisModule: await import('$lib/server/redis'),
    auth: await import('$lib/services/auth.server')
  }
  active = modules
  return modules
}

async function startActualFileService() {
  await requireFreeFileServicePort()
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TZ: 'UTC',
      NODE_ENV: 'production', PORT: String(PORT), BATSHIT_SERVER_HOST: '127.0.0.1',
      ENABLE_HTTPS: 'false', HTTPS_ONLY: 'false', BATSHIT_REDIS_REQUIRED: 'true',
      REDIS_URL: harness.url(), BATSHIT_TOKEN: serviceToken,
      UPLOADS_DIR: path.join(root, 'uploads'), BATSHIT_BACKUP_STAGING_DIR: path.join(root, 'staging'),
      SESSION_STORAGE_PATH: path.join(root, 'sessions'), SESSIONS_DIR: path.join(root, 'sessions'),
      CONFIG_PATH: path.join(root, 'fixture-server-config.json'),
      BATSHIT_SERVER_LOG_DIR: path.join(root, 'logs'), BATSHIT_HTTP_LOGS: 'false', LOG_LEVEL: 'error'
    },
    stdio: ['ignore', 'ignore', 'ignore']
  })
  const owned = child
  const deadline = Date.now() + 20_000
  for (;;) {
    if (owned.exitCode !== null || owned.signalCode !== null) throw new Error('The owned file-service child exited before healthy startup.')
    try {
      const response = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1_000) })
      const health = await response.json()
      if (response.ok && health.ok === true && health.service === 'batshit-server' && health.checks?.redis === true) break
    } catch { /* The real owner does not listen until its storage migration completes. */ }
    if (Date.now() >= deadline) throw new Error('The owned file service did not become healthy within its existing fixture bound.')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const listener = await execFileAsync('lsof', ['-nP', '-a', '-p', String(owned.pid), `-iTCP:${PORT}`, '-sTCP:LISTEN'])
  expect(listener.stdout).toMatch(new RegExp(`\\b${owned.pid}\\b`))
  expect(owned.exitCode).toBeNull()
}

async function stopActualFileService() {
  const owned = child
  if (!owned) return
  child = null
  if (owned.exitCode !== null || owned.signalCode !== null) return
  const ended = new Promise<void>((resolve) => owned.once('exit', () => resolve()))
  owned.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL')
  }, 4_000)
  await ended
  clearTimeout(timer)
}

function archiveRecords(entries: Record<string, Uint8Array>) {
  return Object.entries(entries).filter(([name]) => name.startsWith('redis/records/'))
    .map(([, value]) => JSON.parse(Buffer.from(value).toString()))
}
async function hashFile(file: string) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

describe.runIf(enabled)('SA134 migrated source data through genuine startup and update backup (owned Redis DB0)', () => {
  beforeAll(async () => {
    expect(await harness.adminClient().info('server')).toMatch(/^redis_version:8\.10\.1\r?$/m)
    const commands = await harness.adminClient().sendCommand(['COMMAND', 'INFO', 'JSON.GET', 'FT.CREATE']) as unknown[][]
    expect(commands.map((command) => String(command?.[0]).toLowerCase())).toEqual(['json.get', 'ft.create'])
  })

  afterAll(async () => {
    await stopAppRound()
    await stopActualFileService()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  it('preserves old readable copies through failed/pending migration, captures actual migrated bytes once, and preserves the pair after ENOSPC', async () => {
    const admin = harness.adminClient()
    const pixels = await sharp({ create: { width: 40, height: 24, channels: 4, background: '#406080' } }).png().toBuffer()
    const legacyMemory = {
      id: 'legacy_memory', agent_id: AGENT, user_id: USER, lane: 'ltm', content: 'A legacy image memory',
      gist: 'Image', clip_ids: ['legacy_clip'], importance: 5, embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      provenance: [{ session_id: 'fixture_history', source: 'agent' }], schema_version: 1
    }
    await admin.set('user:admin', USER)
    await admin.sAdd('users:all', USER)
    await admin.json.set(`user:${USER}:settings`, '$', { theme: 'dark' })
    await admin.sAdd(`user:${USER}:agents`, AGENT)
    await admin.json.set(`agent:${AGENT}`, '$', { id: AGENT, user_id: USER, name: 'Fixture agent', agent_type: 'api' })
    await admin.sAdd(`user:${USER}:clips`, 'legacy_clip')
    await admin.json.set(`clip:${USER}:legacy_clip`, '$', {
      id: 'legacy_clip', user_id: USER, filename: 'legacy.png', mimeType: 'image/png', clipType: 'image',
      localBase64: pixels.toString('base64'), created_at: new Date().toISOString()
    })
    await admin.json.set(MEMORY, '$', legacyMemory)
    await admin.json.set(UPLOAD, '$', { uploadType: 'images', filename: 'sa134-legacy.png', mimetype: 'image/png', size: pixels.length, base64: pixels.toString('base64') })
    await admin.json.set('batshit:memory_config', '$', {
      schema_version: 1, embedding: { lane: 'local-ai', modelId: 'local-ai:fixture',
        localAi: { baseUrl: 'http://127.0.0.1:9/v1', modelName: 'fixture', dims: 8 } }
    })

    let app = await loadBoot('fixture-old-build')
    // Both writers reach the existing actual Lua compare-and-set from the same
    // original revision before either EVAL is released. No fake Lua result.
    const actualExecute = app.redisModule.redis.execute.bind(app.redisModule.redis)
    const issuedBases: string[] = []
    const casReplies: unknown[] = []
    let releaseCas!: () => void
    const casGate = new Promise<void>((resolve) => { releaseCas = resolve })
    const script = app.config.SAVE_AUTOMATIC_BACKUP_CONFIG
    const executeSpy = vi.spyOn(app.redisModule.redis, 'execute').mockImplementation((operation: any) => actualExecute((client: any) => operation(
      new Proxy({}, { get(_target, property) {
        if (property === 'eval') return async (source: string, args: { keys: string[]; arguments: string[] }) => {
          if (source !== script) return client.eval(source, args)
          issuedBases.push(args.arguments[0])
          await casGate
          const result = await client.eval(source, args)
          casReplies.push(result)
          return result
        }
        const value = client[property]
        return typeof value === 'function' ? value.bind(client) : value
      } })
    )))
    const concurrent = Promise.allSettled([
      app.config.saveAutomaticBackupConfig(USER, { expectedRevision: 'none', enabled: false, cadence: 'daily', folder: null, afterUpdates: false }),
      app.config.saveAutomaticBackupConfig(USER, { expectedRevision: 'none', enabled: false, cadence: 'weekly', folder: null, afterUpdates: true })
    ])
    try {
      await vi.waitFor(() => expect(issuedBases).toHaveLength(2))
    } finally { releaseCas() }
    const decisions = await concurrent
    executeSpy.mockRestore()
    expect(issuedBases).toEqual(['', ''])
    expect(casReplies.sort()).toEqual([0, 1])
    expect(decisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(decisions.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await admin.json.get(`user:${USER}:settings`)).toEqual({ theme: 'dark' })
    const winningConfig = await app.config.readAutomaticBackupConfig(USER)
    await app.config.saveAutomaticBackupConfig(USER, {
      expectedRevision: winningConfig.revision, enabled: true, cadence: 'daily', folder: null, afterUpdates: true
    })
    const paths = app.config.automaticBackupPaths()
    const old = await app.storage.createAutomaticBackup({ userId: USER, folder: paths.defaultFolder, ledgerPath: paths.ledgerPath,
      provenance: { buildId: 'sveltekit:fixture-old-build', dataGeneration: 'fixture-pre-migration', reason: 'scheduled' } })
    const previous = await app.storage.createAutomaticBackup({ userId: USER, folder: paths.defaultFolder, ledgerPath: paths.ledgerPath,
      provenance: { buildId: 'sveltekit:fixture-old-build', dataGeneration: 'fixture-pre-migration', reason: 'scheduled' } })
    const originalPair = [previous.receipt, old.receipt]
    const oldHashes = await Promise.all(originalPair.map((receipt) => hashFile(receipt.path)))
    for (const receipt of originalPair) await app.archive.verifyAutomaticBackupArchive(receipt.path, USER)
    const beforeEntries = unzipSync(await fs.readFile(previous.receipt.path))
    expect(archiveRecords(beforeEntries).find((record) => record.key === MEMORY).value.clip_ids).toEqual(['legacy_clip'])

    // A real Redis WRONGTYPE at the migration's raw JSON.GET must not certify
    // completion. The original readable archives predate this owned fault.
    await admin.del(MEMORY)
    await admin.set(MEMORY, 'fixture wrong-type read failure')
    app = await loadBoot('fixture-failed-build')
    const failedStart = vi.spyOn(app.service, 'startAutomaticBackupScheduler')
    await app.hooks.ensureStartupIntegrityPass()
    await vi.waitFor(async () => expect((await app.service.getAutomaticBackupView(USER)).startup.error).toContain('memoryMedia'))
    await app.service.runAutomaticBackupSweep()
    expect(failedStart).not.toHaveBeenCalled()
    expect(await admin.exists(MARKER)).toBe(0)
    expect((await app.storage.readAutomaticBackupLedger(paths.ledgerPath))!.backups.map((receipt) => receipt.id)).toEqual(originalPair.map((receipt) => receipt.id))
    expect(await Promise.all(originalPair.map((receipt) => hashFile(receipt.path)))).toEqual(oldHashes)

    await admin.del(MEMORY)
    await admin.json.set(MEMORY, '$', legacyMemory)
    await startActualFileService()
    const migratedUpload = await admin.json.get(UPLOAD) as any
    expect(migratedUpload.base64).toBeUndefined()
    expect(migratedUpload.storage).toBe('filesystem')
    expect(await fs.readFile(migratedUpload.filePath)).toEqual(pixels)

    app = await loadBoot('fixture-new-build')
    const actualMigration = app.migration.ensureMemoryMediaMigration
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const migrationCall = vi.spyOn(app.migration, 'ensureMemoryMediaMigration').mockImplementationOnce(async () => {
      await held
      return actualMigration()
    })
    const disabledScheduler = vi.spyOn(app.service, 'startAutomaticBackupScheduler')
    await app.hooks.ensureStartupIntegrityPass()
    expect(migrationCall).toHaveBeenCalledTimes(1)
    expect((await app.service.getAutomaticBackupView(USER)).startup.ready).toBe(false)
    await app.service.runAutomaticBackupSweep()
    expect(disabledScheduler).not.toHaveBeenCalled()
    expect((await app.storage.readAutomaticBackupLedger(paths.ledgerPath))!.backups.map((receipt) => receipt.id)).toEqual(originalPair.map((receipt) => receipt.id))
    release()
    await vi.waitFor(async () => expect((await app.service.getAutomaticBackupView(USER)).startup.ready).toBe(true))
    expect(disabledScheduler).not.toHaveBeenCalled() // unrelated schedulers and this timer are explicitly OFF
    await app.service.runAutomaticBackupSweep()
    const success = (await app.storage.readAutomaticBackupLedger(paths.ledgerPath))!
    expect(success.backups).toHaveLength(2)
    const updated = success.backups[0]
    expect(updated.provenance).toMatchObject({ buildId: 'sveltekit:fixture-new-build', reason: 'update' })
    expect(updated.provenance.dataGeneration).toMatch(/^startup-v1:[a-f0-9]{64}$/)
    expect(success.backups[1].id).toBe(previous.receipt.id)
    expect(await hashFile(previous.receipt.path)).toBe(oldHashes[0])
    await app.archive.verifyAutomaticBackupArchive(updated.path, USER)
    await app.archive.verifyAutomaticBackupArchive(previous.receipt.path, USER)
    const updatedEntries = unzipSync(await fs.readFile(updated.path))
    const migratedMemory = archiveRecords(updatedEntries).find((record) => record.key === MEMORY).value
    expect(migratedMemory.clip_ids).toBeUndefined()
    expect(migratedMemory.media).toHaveLength(1)
    const mediaFile = `memory-media/${migratedMemory.media[0].filename}`
    expect(Buffer.from(updatedEntries[`files/uploads/${mediaFile}`])).toEqual(await fs.readFile(path.join(root, 'uploads', mediaFile)))
    expect(Buffer.from(updatedEntries['files/uploads/images/sa134-legacy.png'])).toEqual(pixels)

    // A fresh source boot on the same artifact consumes persisted receipts; it
    // must not treat that restart as another update or create another archive.
    app = await loadBoot('fixture-new-build')
    await app.hooks.ensureStartupIntegrityPass()
    await vi.waitFor(async () => expect((await app.service.getAutomaticBackupView(USER)).startup.ready).toBe(true))
    await app.service.runAutomaticBackupSweep()
    expect((await app.storage.readAutomaticBackupLedger(paths.ledgerPath))!.backups.map((receipt) => receipt.id)).toEqual(success.backups.map((receipt) => receipt.id))

    app = await loadBoot('fixture-next-build')
    await app.hooks.ensureStartupIntegrityPass()
    await vi.waitFor(async () => expect((await app.service.getAutomaticBackupView(USER)).startup.ready).toBe(true))
    const open = fs.open.bind(fs)
    const failure = vi.spyOn(fs, 'open').mockImplementation((async (target, ...args) => {
      if (String(target).startsWith(paths.defaultFolder + path.sep) && String(target).endsWith('.tmp')) {
        throw Object.assign(new Error('fixture ENOSPC'), { code: 'ENOSPC' })
      }
      return open(target, ...args as Parameters<typeof fs.open> extends [any, ...infer R] ? R : never)
    }) as typeof fs.open)
    await app.service.runAutomaticBackupSweep()
    failure.mockRestore()
    expect((await app.service.getAutomaticBackupView(USER)).error).toBe('fixture ENOSPC')
    const afterFailure = (await app.storage.readAutomaticBackupLedger(paths.ledgerPath))!
    expect(afterFailure.backups).toEqual(success.backups)
    for (const receipt of afterFailure.backups) {
      expect(await hashFile(receipt.path)).toBe(receipt.sha256)
      await app.archive.verifyAutomaticBackupArchive(receipt.path, USER)
    }
    expect((await fs.readdir(paths.defaultFolder)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  }, 60_000)
})
