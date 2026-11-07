/** SA-134 filesystem boundary proof. Only this suite's disposable roots and fake-lane Redis. */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, zipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { failNextRedisCommand } from '$lib/test-utils/redis-command-failure'
import * as backupService from '../backupRestoreService'
import * as skillRegistry from '../skillRegistry'
import { createAutomaticBackup, recoverAutomaticBackups, readAutomaticBackupLedger, type AutomaticBackupProvenance } from '../automaticBackupStorage'

useRedisTestServer()
const USER = 'automatic-backup-user'
const provenance: AutomaticBackupProvenance = { buildId: 'test-build', dataGeneration: 'migrated-generation', reason: 'scheduled' }
let root = ''
let folder = ''
let ledgerPath = ''
let uploads = ''

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-sa134-storage-')))
  folder = path.join(root, 'backups')
  ledgerPath = path.join(root, 'state', 'ledger.json')
  uploads = path.join(root, 'uploads')
  await fs.mkdir(folder)
  await fs.mkdir(uploads)
  vi.stubEnv('UPLOADS_DIR', uploads)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', path.join(root, 'staging'))
  vi.stubEnv('BATSHIT_RUNTIME_DATA_DIR', path.join(root, 'runtime'))
  vi.stubEnv('BATSHIT_HOME_DIR', path.join(root, 'home'))
  vi.spyOn(skillRegistry, 'getSkillCacheRoot').mockReturnValue(path.join(root, 'home', 'skills'))
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  await redis.json.set(`user:${USER}:settings`, '$', { theme: 'dark', apiToken: 'excluded-secret' })
  await fs.writeFile(path.join(uploads, 'fixture.bin'), 'recoverable upload bytes')
  await redis.json.set('upload:images:fixture.bin', '$', {
    storage: 'filesystem', relativePath: 'fixture.bin', filePath: path.join(uploads, 'fixture.bin'), size: 24
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})
function run(extra: Partial<Parameters<typeof createAutomaticBackup>[0]> = {}) {
  return createAutomaticBackup({ folder, ledgerPath, userId: USER, provenance, ...extra })
}
async function writeModifiedArchive(modify: (entries: Record<string, Uint8Array>) => void) {
  const bytes = (await backupService.createBackupBundle(USER)).bytes
  const entries = unzipSync(bytes)
  modify(entries)
  const archive = path.join(root, 'modified.zip')
  await fs.writeFile(archive, zipSync(entries))
  return archive
}
function changeManifest(entries: Record<string, Uint8Array>, change: (manifest: any) => void) {
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString())
  change(manifest)
  entries['manifest.json'] = Buffer.from(JSON.stringify(manifest))
}

describe('complete automatic archive verification', () => {
  it('reads every real exported entry and retains the ordinary secret exclusion policy', async () => {
    const result = await run()
    const manifest = await backupService.verifyAutomaticBackupArchive(result.receipt.path, USER)
    expect(manifest.contents.fileAssetCount).toBe(1)
    expect(manifest.hostFiles?.notCarried).toEqual([])
    const entries = unzipSync(await fs.readFile(result.receipt.path))
    expect(Buffer.from(entries['files/uploads/fixture.bin']).toString()).toBe('recoverable upload bytes')
    expect(Buffer.from(entries['redis/records/00000001.json']).toString()).not.toContain('excluded-secret')
    expect((await fs.stat(result.receipt.path)).mode & 0o777).toBe(0o600)
  })

  it('rejects an unreadable binary body even when ZIP inventory and sizes still look right', async () => {
    const bytes = Buffer.from((await backupService.createBackupBundle(USER)).bytes)
    // Corrupt the central CRC of the binary upload. Its payload remains decompressible;
    // yauzl size validation alone accepts it, so the new full-body CRC check must refuse.
    const name = Buffer.from('files/uploads/fixture.bin')
    let changed = false
    for (let offset = 0; offset < bytes.length - 46; offset++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) continue
      const length = bytes.readUInt16LE(offset + 28)
      if (bytes.subarray(offset + 46, offset + 46 + length).equals(name)) {
        bytes.writeUInt32LE((bytes.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16)
        changed = true
        break
      }
    }
    expect(changed).toBe(true)
    const archive = path.join(root, 'bad-crc.zip')
    await fs.writeFile(archive, bytes)
    await expect(backupService.verifyAutomaticBackupArchive(archive, USER)).rejects.toThrow(/CRC/)
  })

  it.each(['partial', 'not-carried', 'inventory', 'group-inventory', 'owner', 'missing-file'])("rejects %s as an unattended recovery copy", async (kind) => {
    const archive = await writeModifiedArchive((entries) => {
      if (kind === 'partial') changeManifest(entries, (manifest) => {
        manifest.schemaVersion = 2
        manifest.completeness = 'partial'
        manifest.uploads = { missing: [] }
      })
      if (kind === 'not-carried') changeManifest(entries, (manifest) => { manifest.hostFiles.notCarried.push({ root: 'skills', folder: 'lost', reason: 'missing' }) })
      if (kind === 'inventory') changeManifest(entries, (manifest) => { manifest.contents.fileAssetBytes++ })
      if (kind === 'group-inventory') changeManifest(entries, (manifest) => { manifest.contents.groups[0].recordCount++ })
      if (kind === 'owner') changeManifest(entries, (manifest) => { manifest.source.userId = 'another-user' })
      if (kind === 'missing-file') {
        delete entries['files/uploads/fixture.bin']
        changeManifest(entries, (manifest) => { manifest.contents.fileAssetCount = 0; manifest.contents.fileAssetBytes = 0 })
      }
    })
    await expect(backupService.verifyAutomaticBackupArchive(archive, USER)).rejects.toThrow()
  })

  it('accepts an older recovery copy that carries removed n8n Workflow Subagent thread ids (SA-139 R2)', async () => {
    // The thread ids were backed-up session data until SA-139 R2 removed their only writer. A
    // recovery copy made before that still verifies (counted as its inventory says), and the
    // restore leaves them out; an unknown look-alike key is still refused.
    await redis.sAdd(`user:${USER}:sessions`, 'sess_old')
    await redis.json.set('session:sess_old', '$', { id: 'sess_old', user_id: USER, title: 'Older chat' })
    const inject = (key: string) => writeModifiedArchive((entries) => {
      changeManifest(entries, (manifest) => {
        const index = ++manifest.contents.redisRecordCount
        entries[`redis/records/${String(index).padStart(8, '0')}.json`] = Buffer.from(JSON.stringify({
          key, type: 'string', value: 'f8a11390-7654-4321-8765-123456789abc', ttlSeconds: null, groupId: 'chats'
        }))
        manifest.contents.groups.find((group: { id: string }) => group.id === 'chats').recordCount++
      })
    })
    await expect(backupService.verifyAutomaticBackupArchive(await inject('subagent_thread:sess_old:flow'), USER)).resolves.toBeDefined()
    await expect(backupService.verifyAutomaticBackupArchive(await inject('subagent_threadx:sess_old:flow'), USER)).rejects.toThrow(/unsupported Redis records/)
  })

  it('rejects a truncated archive', async () => {
    const bytes = (await backupService.createBackupBundle(USER)).bytes
    const archive = path.join(root, 'truncated.zip')
    await fs.writeFile(archive, bytes.subarray(0, bytes.length - 20))
    await expect(backupService.verifyAutomaticBackupArchive(archive, USER)).rejects.toThrow(/readable/)
  })

  it('keeps manual export behavior but rejects its actually omitted skill folder for automatic backup', async () => {
    await redis.json.set(`skill:${USER}:sa134-missing-skill`, '$', { id: 'sa134-missing-skill', name: 'Missing skill', source: 'user', is_system: false })
    const manual = await backupService.createBackupBundle(USER)
    expect(manual.manifest.hostFiles?.notCarried).toHaveLength(1)
    const archive = path.join(root, 'manual-with-omission.zip')
    await fs.writeFile(archive, manual.bytes)
    await expect(backupService.verifyAutomaticBackupArchive(archive, USER)).rejects.toThrow(/every supported skill/)
    await expect(run()).rejects.toThrow(/every supported skill/)
    expect(await readAutomaticBackupLedger(ledgerPath)).toBeNull()
    expect(await fs.readdir(folder)).toEqual([])
  })

  it('rejects a real scripts-only skill folder even when the manual exporter lists no omission', async () => {
    const skillFolder = path.join(root, 'home', 'skills', 'sa134-no-main')
    await fs.mkdir(path.join(skillFolder, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(skillFolder, 'scripts', 'helper.js'), 'export const value = 1')
    await redis.json.set(`skill:${USER}:sa134-no-main`, '$', { id: 'sa134-no-main', source: 'user', is_system: false })
    const manual = await backupService.createBackupBundle(USER)
    expect(manual.manifest.hostFiles?.notCarried).toEqual([])
    expect(manual.manifest.contents.hostFileCount).toBe(1)
    await expect(run()).rejects.toThrow(/missing the required file for skill/)
    expect(await fs.readdir(folder)).toEqual([])
  })

  it('rejects missing SKILL.md even if archive totals and no-omission metadata are forged to agree', async () => {
    const skillFolder = path.join(root, 'home', 'skills', 'sa134-valid-skill')
    await fs.mkdir(skillFolder, { recursive: true })
    await fs.writeFile(path.join(skillFolder, 'SKILL.md'), '# Recoverable skill')
    await fs.writeFile(path.join(skillFolder, 'helper.js'), 'export const value = 1')
    await redis.json.set(`skill:${USER}:sa134-valid-skill`, '$', { id: 'sa134-valid-skill', source: 'user', is_system: false })
    const valid = await run()
    await backupService.verifyAutomaticBackupArchive(valid.receipt.path, USER)
    const archive = await writeModifiedArchive((entries) => {
      const main = 'files/host/skills/sa134-valid-skill/SKILL.md'
      const removedBytes = entries[main].length
      delete entries[main]
      changeManifest(entries, (manifest) => {
        manifest.contents.hostFileCount--
        manifest.contents.hostFileBytes -= removedBytes
        manifest.contents.groups.find((group: any) => group.id === 'tools').fileAssetCount--
      })
    })
    await expect(backupService.verifyAutomaticBackupArchive(archive, USER)).rejects.toThrow(/missing the required file for skill/)
  })

  it.each(['batshit:automatic_backup_config', 'batshit:automatic_backup_status'])('excludes instance authority %s and refuses its import', async (key) => {
    await redis.json.set(key, '$', { userId: USER, enabled: true, lastSuccessAt: '2026-10-23T00:00:00.000Z' })
    const exported = await backupService.createBackupBundle(USER)
    const entries = unzipSync(exported.bytes)
    const recordEntries = Object.entries(entries).filter(([name]) => name.startsWith('redis/records/'))
    expect(recordEntries.some(([, bytes]) => JSON.parse(Buffer.from(bytes).toString()).key === key)).toBe(false)
    entries['redis/records/foreign-authority.json'] = Buffer.from(JSON.stringify({ key, type: 'json', value: { enabled: true }, ttlSeconds: null, groupId: 'settings' }))
    changeManifest(entries, (manifest) => { manifest.contents.redisRecordCount++ })
    await expect(backupService.preflightBackupRestore(USER, zipSync(entries))).rejects.toThrow(`Backup contains a key Batshit will not restore: ${key}`)
  })
})

describe('identity-owned publication and retention', () => {
  it('refuses failed SMEMBERS inventory without accepting a new copy or touching the old pair', async () => {
    await redis.execute((client) => client.sAdd(`user:${USER}:sessions`, ['inventory-session']))
    await redis.json.set('session:inventory-session', '$', { user_id: USER, name: 'Source chat' })
    const first = await run()
    const second = await run()
    const failure = failNextRedisCommand('sMembers', new Error('source inventory read failed'))
    try {
      await expect(run()).rejects.toMatchObject({ status: 500, details: { code: 'BACKUP_SOURCE_READ_FAILED', operation: 'SMEMBERS' } })
      expect(failure.failed()).toBe(true)
    } finally { failure.restore() }
    expect((await readAutomaticBackupLedger(ledgerPath))?.backups.map((item) => item.id)).toEqual([second.receipt.id, first.receipt.id])
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
  })

  it('refuses a wrong-type source index for both automatic and manual recovery copies', async () => {
    const first = await run()
    const second = await run()
    await redis.set(`user:${USER}:agents`, 'wrong-type index')
    await expect(run()).rejects.toThrow('wrong Redis type')
    await expect(backupService.createBackupBundle(USER)).rejects.toMatchObject({ status: 500, details: { code: 'BACKUP_SOURCE_READ_FAILED', operation: 'TYPE' } })
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
    expect((await readAutomaticBackupLedger(ledgerPath))?.backups).toHaveLength(2)
  })

  it.each(['unsupported-type', 'invalid-members'] as const)('refuses %s without silently dropping source data', async (fault) => {
    const first = await run()
    const second = await run()
    if (fault === 'invalid-members') await redis.execute((client) => client.sAdd(`user:${USER}:sessions`, ['inventory-session']))
    const execute = redis.execute
    ;(redis as any).execute = async (operation: any) => await execute.call(redis, async (client: any) => {
      const view = new Proxy(Object.create(null), {
        get(_target, property) {
          if (property === 'type' && fault === 'unsupported-type') return async (key: string) => key === `user:${USER}:settings` ? 'stream' : client.type(key)
          if (property === 'sMembers' && fault === 'invalid-members') return async (key: string) => key === `user:${USER}:sessions` ? [false] : client.sMembers(key)
          const value = Reflect.get(client, property, client)
          return typeof value === 'function' ? value.bind(client) : value
        }
      })
      return operation(view)
    })
    try { await expect(run()).rejects.toThrow(fault === 'unsupported-type' ? 'unsupported Redis type' : 'invalid members') }
    finally { (redis as any).execute = execute }
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
    expect((await readAutomaticBackupLedger(ledgerPath))?.backups).toHaveLength(2)
  })

  it('refuses a failed sorted-set DM index read without dropping its persisted messages', async () => {
    const first = await run()
    const second = await run()
    await redis.execute((client) => client.zAdd(`dm_index:${USER}`, [{ value: 'strict-dm', score: 1 }]))
    await redis.json.set('dm:strict-dm', '$', { id: 'strict-dm', text: 'persisted message' })
    const failure = failNextRedisCommand('zRange', new Error('DM index read failed'))
    try {
      await expect(run()).rejects.toMatchObject({ status: 500, details: { code: 'BACKUP_SOURCE_READ_FAILED', operation: 'ZRANGE' } })
      expect(failure.failed()).toBe(true)
    } finally { failure.restore() }
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
    expect((await readAutomaticBackupLedger(ledgerPath))?.backups).toHaveLength(2)
  })

  it('carries legitimate supported expiring data in strict automatic inventory', async () => {
    await redis.execute((client) => client.expire(`user:${USER}:settings`, 120))
    const result = await run()
    const entries = unzipSync(await fs.readFile(result.receipt.path))
    const record = Object.entries(entries).filter(([name]) => name.startsWith('redis/records/'))
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes).toString())).find((item) => item.key === `user:${USER}:settings`)
    expect(record.ttlSeconds).toBeGreaterThan(0)
    expect(record.ttlSeconds).toBeLessThanOrEqual(120)
  })

  it('keeps one, then two, then the latest two while unrelated archives remain untouched', async () => {
    const unrelated = path.join(folder, 'my-important.zip')
    await fs.writeFile(unrelated, 'user bytes')
    const first = await run()
    expect(first.retained.map((item) => item.id)).toEqual([first.receipt.id])
    const second = await run()
    expect(second.retained.map((item) => item.id)).toEqual([second.receipt.id, first.receipt.id])
    const third = await run({ provenance: { ...provenance, reason: 'scheduled-and-update' } })
    expect(third.retained.map((item) => item.id)).toEqual([third.receipt.id, second.receipt.id])
    await expect(fs.stat(first.receipt.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(unrelated, 'utf8')).toBe('user bytes')
    expect(third.cleanupFailures).toEqual([])
    expect((await readAutomaticBackupLedger(ledgerPath))?.pendingPublication).toBeNull()
    expect((await fs.readdir(folder)).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('keeps both completed copies after stream failure, with no temporary file reported as success', async () => {
    const first = await run()
    const second = await run()
    vi.spyOn(backupService, 'createBackupBundleStream').mockResolvedValueOnce({
      stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.error(new Error('injected read failure')) } }),
      filename: 'ignored.zip', manifest: {} as any, missingUploads: null
    })
    await expect(run()).rejects.toThrow('injected read failure')
    for (const receipt of [first.receipt, second.receipt]) await backupService.verifyAutomaticBackupArchive(receipt.path, USER)
    expect((await readAutomaticBackupLedger(ledgerPath))?.backups).toHaveLength(2)
    expect((await fs.readdir(folder)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps both copies if temp creation fails with disk full or the selected folder disappears', async () => {
    const first = await run()
    const second = await run()
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation((async (target, ...args) => {
      if (String(target).startsWith(folder) && String(target).endsWith('.tmp')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return open(target, ...args as Parameters<typeof fs.open> extends [any, ...infer R] ? R : never)
    }) as typeof fs.open)
    await expect(run()).rejects.toThrow('disk full')
    spy.mockRestore()
    await expect(run({ folder: path.join(root, 'missing') })).rejects.toMatchObject({ code: 'ENOENT' })
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
  })

  it('removes its exact full temp after a settled state-volume pending-ledger ENOSPC', async () => {
    const previous = await run()
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation((async (target, ...args) => {
      if (String(target).startsWith(`${ledgerPath}.`) && String(target).endsWith('.tmp')) throw Object.assign(new Error('state volume full'), { code: 'ENOSPC' })
      return open(target, ...args as Parameters<typeof fs.open> extends [any, ...infer R] ? R : never)
    }) as typeof fs.open)
    await expect(run()).rejects.toThrow('state volume full')
    spy.mockRestore()
    expect((await fs.readdir(folder)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect((await readAutomaticBackupLedger(ledgerPath))?.backups.map((item) => item.id)).toEqual([previous.receipt.id])
    expect((await fs.stat(previous.receipt.path)).isFile()).toBe(true)
  })

  it('waits for real stream close failure and preserves both previous copies', async () => {
    const first = await run()
    const second = await run()
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation((async (target, ...args) => {
      const handle = await open(target, ...args as Parameters<typeof fs.open> extends [any, ...infer R] ? R : never)
      if (String(target).startsWith(folder) && String(target).endsWith('.tmp')) {
        const close = handle.close.bind(handle)
        handle.close = async () => { await close(); throw new Error('injected actual close failure') }
      }
      return handle
    }) as typeof fs.open)
    await expect(run()).rejects.toThrow('injected actual close failure')
    expect((await readAutomaticBackupLedger(ledgerPath))?.backups.map((item) => item.id)).toEqual([second.receipt.id, first.receipt.id])
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
  })

  it('journals before no-overwrite publication and reconciles exactly that pending file on retry', async () => {
    const first = await run()
    const second = await run()
    const link = fs.link.bind(fs)
    let pendingPath = ''
    const spy = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('.zip') && !String(destination).includes('.batshit-retire-')) {
        const ledger = await readAutomaticBackupLedger(ledgerPath)
        expect(ledger?.pendingPublication?.temporaryPath).toBe(String(source))
        expect(ledger?.backups).toHaveLength(2)
        pendingPath = String(destination)
        throw new Error('interruption before publication')
      }
      return link(source, destination)
    })
    await expect(run()).rejects.toThrow('interruption before publication')
    spy.mockRestore()
    expect((await readAutomaticBackupLedger(ledgerPath))?.pendingPublication?.receipt.path).toBe(pendingPath)
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
    const result = await run()
    expect(result.retained).toHaveLength(2)
    expect(result.retained.some((item) => item.path === pendingPath)).toBe(true)
    expect((await readAutomaticBackupLedger(ledgerPath))?.pendingPublication).toBeNull()
  })

  it('recovers a published update without exporting twice or retiring the pre-update copy', async () => {
    const previous = await run()
    const exporter = vi.spyOn(backupService, 'createBackupBundleStream')
    const unlink = fs.unlink.bind(fs)
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      if (String(target).startsWith(folder) && String(target).endsWith('.tmp')) throw new Error('crash after final publication')
      return unlink(target)
    })
    await expect(run({ provenance: { ...provenance, reason: 'update' } })).rejects.toThrow('crash after final publication')
    spy.mockRestore()
    const pending = (await readAutomaticBackupLedger(ledgerPath))!.pendingPublication!
    const result = await run({ provenance: { ...provenance, reason: 'update' } })
    expect(exporter).toHaveBeenCalledTimes(1)
    expect(result.receipt.id).toBe(pending.receipt.id)
    expect(result.retained.map((item) => item.id)).toEqual([pending.receipt.id, previous.receipt.id])
    await backupService.verifyAutomaticBackupArchive(previous.receipt.path, USER)
  })

  it('keeps the publication journal and old copies after an active-ledger rename answer is lost', async () => {
    const first = await run()
    const second = await run()
    const rename = fs.rename.bind(fs)
    let writes = 0
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      await rename(source, destination)
      if (String(destination) === ledgerPath && ++writes === 2) throw new Error('ledger rename answer lost')
    })
    await expect(run()).rejects.toThrow('ledger rename answer lost')
    spy.mockRestore()
    const ledger = await readAutomaticBackupLedger(ledgerPath)
    expect(ledger?.pendingPublication).not.toBeNull()
    expect(ledger?.backups).toHaveLength(3)
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
    const exporter = vi.spyOn(backupService, 'createBackupBundleStream')
    const recovered = await run()
    expect(exporter).not.toHaveBeenCalled()
    expect(recovered.receipt.path).toBe(ledger!.pendingPublication!.receipt.path)
    expect(recovered.retained).toHaveLength(2)
  })

  it('settles a recent active receipt with pending publication through recovery only, never another export', async () => {
    const previous = await run()
    const unlink = fs.unlink.bind(fs)
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      if (String(target).startsWith(folder) && String(target).endsWith('.tmp')) throw new Error('interrupted active publication')
      return unlink(target)
    })
    await expect(run({ provenance: { ...provenance, reason: 'update' } })).rejects.toThrow('interrupted active publication')
    spy.mockRestore()
    const pending = (await readAutomaticBackupLedger(ledgerPath))!.pendingPublication!
    expect((await readAutomaticBackupLedger(ledgerPath))!.backups[0].id).toBe(pending.receipt.id)
    const exporter = vi.spyOn(backupService, 'createBackupBundleStream')
    const result = await recoverAutomaticBackups({ folder, ledgerPath, userId: USER })
    expect(exporter).not.toHaveBeenCalled()
    expect(result.receipt?.id).toBe(pending.receipt.id)
    expect(result.retained.map((item) => item.id)).toEqual([pending.receipt.id, previous.receipt.id])
    expect((await readAutomaticBackupLedger(ledgerPath))!.pendingPublication).toBeNull()
  })

  it('does not publish or prune when shutdown arrives during verification', async () => {
    const previous = await run()
    const second = await run()
    const controller = new AbortController()
    const verify = backupService.verifyAutomaticBackupArchive
    vi.spyOn(backupService, 'verifyAutomaticBackupArchive').mockImplementationOnce(async (...args) => {
      const verified = await verify(...args)
      controller.abort(new Error('shutdown requested'))
      return verified
    })
    await expect(run({ signal: controller.signal })).rejects.toThrow('shutdown requested')
    const ledger = await readAutomaticBackupLedger(ledgerPath)
    expect(ledger?.backups.map((item) => item.id)).toEqual([second.receipt.id, previous.receipt.id])
    expect(ledger?.pendingPublication).toBeNull()
    for (const receipt of [previous.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
    expect((await fs.readdir(folder)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves exact pending custody and the old two if shutdown arrives just after publication', async () => {
    const first = await run()
    const second = await run()
    const controller = new AbortController()
    const link = fs.link.bind(fs)
    const spy = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      await link(source, destination)
      controller.abort(new Error('shutdown after publish'))
    })
    await expect(run({ signal: controller.signal })).rejects.toThrow('shutdown after publish')
    spy.mockRestore()
    const ledger = await readAutomaticBackupLedger(ledgerPath)
    expect(ledger?.backups.map((item) => item.id)).toEqual([second.receipt.id, first.receipt.id])
    expect(ledger?.pendingPublication).not.toBeNull()
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
    const recovered = await run()
    expect(recovered.receipt.path).toBe(ledger!.pendingPublication!.receipt.path)
  })

  it('never overwrites a conflicting final filename and leaves the exact pending journal visible', async () => {
    const link = fs.link.bind(fs)
    let conflicting = ''
    const spy = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      conflicting = String(destination)
      await fs.writeFile(destination, 'foreign final file', { flag: 'wx' })
      return link(source, destination)
    })
    await expect(run()).rejects.toMatchObject({ code: 'EEXIST' })
    spy.mockRestore()
    expect(await fs.readFile(conflicting, 'utf8')).toBe('foreign final file')
    expect((await readAutomaticBackupLedger(ledgerPath))?.pendingPublication?.receipt.path).toBe(conflicting)
    await expect(run()).rejects.toThrow(/identity|contents/)
    expect(await fs.readFile(conflicting, 'utf8')).toBe('foreign final file')
  })

  it('keeps a replaced old file instead of deleting by pathname or matching bytes', async () => {
    const first = await run()
    await run()
    const bytes = await fs.readFile(first.receipt.path)
    await fs.unlink(first.receipt.path)
    await fs.writeFile(first.receipt.path, bytes)
    const result = await run()
    expect(result.retained).toHaveLength(2)
    expect(result.cleanupFailures[0].message).toContain('changed')
    expect((await readAutomaticBackupLedger(ledgerPath))?.unavailableReceipts[0].state).toBe('changed')
    expect(createHash('sha256').update(await fs.readFile(first.receipt.path)).digest('hex')).toBe(first.receipt.sha256)
  })

  it('keeps the oldest if the second recovery copy is now missing', async () => {
    const oldest = await run()
    const second = await run()
    await fs.unlink(second.receipt.path)
    const result = await run()
    expect(result.cleanupFailures).toHaveLength(1)
    expect(result.cleanupFailures[0].message).toContain('missing')
    expect(result.retained.map((item) => item.id)).toEqual([result.receipt.id, oldest.receipt.id])
    expect((await readAutomaticBackupLedger(ledgerPath))?.unavailableReceipts[0].state).toBe('missing')
    expect((await fs.stat(oldest.receipt.path)).isFile()).toBe(true)
    await backupService.verifyAutomaticBackupArchive(oldest.receipt.path, USER)
  })

  it('rechecks a retired file after atomic quarantine and restores a raced replacement without overwriting', async () => {
    const first = await run()
    await run()
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(source) === first.receipt.path) {
        await fs.unlink(source)
        await fs.writeFile(source, 'raced user file')
      }
      return rename(source, destination)
    })
    const result = await run()
    spy.mockRestore()
    expect(await fs.readFile(first.receipt.path, 'utf8')).toBe('raced user file')
    expect(result.cleanupFailures[0].message).toContain('preserved')
    const ledger = await readAutomaticBackupLedger(ledgerPath)
    expect(ledger?.backups).toHaveLength(2)
    expect(ledger?.preservedFiles[0].path).toBe(first.receipt.path)
  })

  it('reports cleanup failure honestly and recovers an interrupted exact retirement next run', async () => {
    const first = await run()
    await run()
    const unlink = fs.unlink.bind(fs)
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      if (String(target).includes('.batshit-retire-')) throw new Error('retirement write denied')
      return unlink(target)
    })
    const failedCleanup = await run()
    expect(failedCleanup.retained).toHaveLength(3)
    expect(failedCleanup.cleanupFailures[0].message).toBe('retirement write denied')
    const pending = (await readAutomaticBackupLedger(ledgerPath))?.pendingRetirement
    expect(pending?.receipt.path).toBe(first.receipt.path)
    expect((await fs.stat(pending!.quarantinePath)).isFile()).toBe(true)
    spy.mockRestore()
    const result = await run()
    expect(result.retained).toHaveLength(2)
    expect(result.cleanupFailures).toEqual([])
    expect((await readAutomaticBackupLedger(ledgerPath))?.pendingRetirement).toBeNull()
  })

  it('recovers cleanup without a new backup, including an already-removed archive awaiting folder cleanup', async () => {
    await run()
    const previous = await run()
    const rmdir = fs.rmdir.bind(fs)
    const spy = vi.spyOn(fs, 'rmdir').mockImplementation(async (target) => {
      if (String(target).includes('.batshit-retire-')) throw new Error('empty retirement folder remains')
      return rmdir(target)
    })
    const latest = await run()
    spy.mockRestore()
    expect(latest.retained).toHaveLength(2)
    expect(latest.cleanupFailures).toHaveLength(1)
    expect((await readAutomaticBackupLedger(ledgerPath))?.pendingRetirement?.archiveRemoved).toBe(true)
    const exporter = vi.spyOn(backupService, 'createBackupBundleStream')
    const recovered = await recoverAutomaticBackups({ folder, ledgerPath, userId: USER })
    expect(exporter).not.toHaveBeenCalled()
    expect(recovered.retained.map((item) => item.id)).toEqual([latest.receipt.id, previous.receipt.id])
    expect(recovered.cleanupFailures).toEqual([])
    expect((await readAutomaticBackupLedger(ledgerPath))?.pendingRetirement).toBeNull()
  })

  it('preserves old-folder backups and starts fixed-two retention in the newly chosen folder', async () => {
    const first = await run()
    const second = await run()
    const otherFolder = path.join(root, 'chosen-folder')
    await fs.mkdir(otherFolder)
    await run({ folder: otherFolder })
    await run({ folder: otherFolder })
    const result = await run({ folder: otherFolder })
    expect(result.retained).toHaveLength(2)
    expect(result.preservedFolders).toEqual([{ folder: await fs.realpath(folder), backupCount: 2 }])
    for (const receipt of [first.receipt, second.receipt]) expect((await fs.stat(receipt.path)).isFile()).toBe(true)
  })

  it('preserves the exact old pending paths without old-folder IO when destination changes', async () => {
    const previous = await run()
    const spy = vi.spyOn(fs, 'link').mockRejectedValueOnce(new Error('publication interrupted'))
    await expect(run()).rejects.toThrow('publication interrupted')
    spy.mockRestore()
    const pending = (await readAutomaticBackupLedger(ledgerPath))!.pendingPublication!
    const newFolder = path.join(root, 'new-destination')
    await fs.mkdir(newFolder)
    const result = await run({ folder: newFolder })
    expect(result.retained).toHaveLength(1)
    expect(result.preservedFolders).toEqual([{ folder, backupCount: 1 }])
    const ledger = await readAutomaticBackupLedger(ledgerPath)
    expect(ledger?.pendingPublication).toBeNull()
    expect(ledger?.preservedFiles.map((item) => item.path)).toEqual([pending.receipt.path, pending.temporaryPath])
    expect((await fs.stat(pending.temporaryPath)).isFile()).toBe(true)
    expect((await fs.stat(previous.receipt.path)).isFile()).toBe(true)
  })

  it('refuses recursive input destinations and another owner or malformed ledger', async () => {
    await expect(run({ folder: uploads })).rejects.toThrow(/outside upload/)
    await run()
    await expect(run({ userId: 'other-user' })).rejects.toThrow('another user')
    await fs.writeFile(ledgerPath, '{broken')
    await expect(run()).rejects.toThrow()
    expect((await fs.readdir(folder)).filter((name) => name.endsWith('.zip'))).toHaveLength(1)
  })
})
