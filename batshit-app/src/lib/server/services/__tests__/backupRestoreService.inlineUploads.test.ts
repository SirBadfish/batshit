// @vitest-environment node
/**
 * BL-2401: an upload kept in Redis (its content inside its record, no file named) needs no file
 * in a backup. batshit-server keeps every Advanced/Blender Goon package's `avatar.json` that way
 * (`storeRedisUploadAsset`, `upload:goon_guided_manifests:*` with `textContent`), and the
 * automatic backup verifier used the raw record's path rule, whose fallback to the key's path
 * invented a file for it, so every automatic backup of an instance with such a Goon failed.
 * Every archive-side reader now asks one rule (`archivedUploadFilePath`): the export's file
 * inventory, the upload check, the verifier and the restore agree. A file-backed upload whose
 * file is missing is still refused, by the export and by the verifier.
 *
 * Real automatic backups (`createAutomaticBackup`, the export stream and the verifier) and real
 * restores. Owned state only: temporary upload, staging, backup and home folders, the
 * default-lane Redis fake, synthetic records, and a stubbed file-service barrier (no
 * batshit-server runs). No other network call, no model call.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { unzipSync, zipSync } from 'fflate/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testHome = vi.hoisted(() => ({ current: '', previous: process.env.BATSHIT_HOME_DIR }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const nodePath = await import('node:path')
  if (!testHome.current) testHome.current = nodePath.join(real.tmpdir(), `batshit-inline-uploads-home-${process.pid}-${Date.now()}`)
  process.env.BATSHIT_HOME_DIR = nodePath.join(testHome.current, '.batshit')
  const homedir = () => testHome.current
  return { ...real, homedir, default: { ...real, homedir } }
})

import os from 'node:os'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  BackupRestoreError,
  auditBackupUploadFiles,
  createBackupBundle,
  restoreBackupBundle,
  verifyAutomaticBackupArchive
} from '../backupRestoreService'
import { createAutomaticBackup, type AutomaticBackupProvenance } from '../automaticBackupStorage'

useRedisTestServer()

const USER = 'bl2401_user'
const provenance: AutomaticBackupProvenance = { buildId: 'test-build', dataGeneration: 'migrated-generation', reason: 'scheduled' }
const STAMP = '1780103225558'
const MANIFEST_KEY = `upload:goon_guided_manifests:${STAMP}_Kiriko-Main_avatar.json`
const MANIFEST_KEY_PATH = `goon_guided_manifests/${STAMP}_Kiriko-Main_avatar.json`
const VRM_KEY = `upload:goons:${STAMP}_Kiriko-Main_avatar.vrm`
const VRM_PATH = `goons/${STAMP}_Kiriko-Main_avatar.vrm`
const PACKAGE_KEY = `upload:goon_guided_packages:${STAMP}_Kiriko-Main.bgoon`
const PACKAGE_PATH = `goon_guided_packages/${STAMP}_Kiriko-Main.bgoon`
const MANIFEST_TEXT = JSON.stringify({ schema: 'batshit-guided-goon', name: 'Kiriko', outfit: { pieces: [], presets: [] } })

let root = ''
let uploadRoot = ''
let folder = ''
let ledgerPath = ''

beforeAll(() => {
  expect(os.homedir()).toBe(testHome.current)
})

afterAll(async () => {
  if (testHome.previous === undefined) delete process.env.BATSHIT_HOME_DIR
  else process.env.BATSHIT_HOME_DIR = testHome.previous
  await fs.rm(testHome.current, { recursive: true, force: true })
})

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-bl2401-')))
  uploadRoot = path.join(root, 'uploads')
  folder = path.join(root, 'backups')
  ledgerPath = path.join(root, 'state', 'ledger.json')
  await fs.mkdir(uploadRoot)
  await fs.mkdir(folder)
  await fs.mkdir(path.join(root, 'staging'))
  vi.stubEnv('HOME', testHome.current)
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', path.join(root, 'staging'))
  vi.stubEnv('BATSHIT_RUNTIME_DATA_DIR', path.join(root, 'runtime'))
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.stubEnv('BATSHIT_TOKEN', 'bl2401-test-token')
  // The restore's file-service barrier is the only call out; nothing else may fetch.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/\/api\/upload\/asset-maintenance\/(begin|end)$/)
    const { token } = JSON.parse(String(init.body))
    return Response.json({ success: true, token, state: url.endsWith('/begin') ? 'created' : 'released', activeOperations: 0 })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await redis.json.set(`user:${USER}:settings`, '$', { user_id: USER, theme: 'dark' })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

/** The record `storeRedisUploadAsset` writes for an Advanced/Blender package's avatar.json. */
function manifestRecord(extra: Record<string, unknown> = {}) {
  return {
    originalName: 'avatar.json',
    mimetype: 'application/json',
    size: Buffer.byteLength(MANIFEST_TEXT),
    uploadType: 'goon_guided_manifests',
    uploadedAt: '2026-10-20T12:00:00.000Z',
    textContent: MANIFEST_TEXT,
    ...extra
  }
}

/** A file-backed upload as `storeFilesystemUploadAsset` writes it; `content: null` leaves no file. */
async function seedFileUpload(key: string, relativePath: string, content: string | null) {
  const filePath = path.join(uploadRoot, relativePath)
  if (content !== null) {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content)
  }
  await redis.json.set(key, '$', {
    originalName: path.basename(relativePath),
    mimetype: 'application/octet-stream',
    size: content?.length ?? 4,
    uploadType: relativePath.split('/')[0],
    uploadedAt: '2026-10-20T12:00:00.000Z',
    storage: 'filesystem',
    relativePath,
    filePath
  })
}

function run() {
  return createAutomaticBackup({ folder, ledgerPath, userId: USER, provenance })
}

async function failureOf(promise: Promise<unknown>) {
  return promise.then(() => null, (caught: unknown) => caught as BackupRestoreError)
}

async function readArchive(file: string) {
  const entries = unzipSync(await fs.readFile(file))
  const records = Object.keys(entries)
    .filter((name) => name.startsWith('redis/records/'))
    .map((name) => JSON.parse(Buffer.from(entries[name]).toString('utf8')))
  const uploadFiles = Object.fromEntries(
    Object.keys(entries)
      .filter((name) => name.startsWith('files/uploads/'))
      .map((name) => [name.slice('files/uploads/'.length), Buffer.from(entries[name]).toString('utf8')])
  )
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  const clips = manifest.contents.groups.find((group: { id: string }) => group.id === 'clips')
  return { records, byKey: Object.fromEntries(records.map((record) => [record.key, record])), uploadFiles, manifest, clips }
}

async function deleteKeys(...keys: string[]) {
  await redis.execute((client: any) => client.del(keys))
}

async function restoreFrom(file: string) {
  return restoreBackupBundle(USER, await fs.readFile(file), { confirmReplace: true })
}

describe('an upload kept in Redis needs no file in a backup (BL-2401)', () => {
  it('backs up a Goon package manifest kept in Redis: the record and its text travel, no file is counted, and it restores as it was', async () => {
    await redis.json.set(MANIFEST_KEY, '$', manifestRecord())

    const result = await run()
    const archive = await readArchive(result.receipt.path)
    // Exactly as stored: no relativePath, storage marker or filePath was added, and its text is whole.
    expect(archive.byKey[MANIFEST_KEY]).toMatchObject({ type: 'json', groupId: 'clips' })
    expect(archive.byKey[MANIFEST_KEY].value).toEqual(manifestRecord())
    expect(archive.uploadFiles).toEqual({})
    expect(archive.manifest.contents).toMatchObject({ fileAssetCount: 0, fileAssetBytes: 0 })
    expect(archive.clips).toMatchObject({ recordCount: 1, fileAssetCount: 0 })
    // The upload check agrees: it is not a file-backed upload, so it is no problem either.
    expect(await auditBackupUploadFiles(USER)).toMatchObject({ fileBackedCount: 0, problemCount: 0, exportBlockedMessage: null })

    await deleteKeys(MANIFEST_KEY)
    expect(await restoreFrom(result.receipt.path)).toMatchObject({ restored: true, fileAssetCount: 0 })
    expect(await redis.json.get(MANIFEST_KEY)).toEqual(manifestRecord())
    // No file appears for it: batshit-server serves it from its text, as before the backup.
    await expect(fs.stat(path.join(uploadRoot, 'goon_guided_manifests'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('carries a legacy Base64 upload as its decoded file, as before, and restores it file-backed', async () => {
    // `storeRedisUploadAsset`'s other branch (no current caller): the payload is a Base64 copy.
    // The export decodes it into a file (the legacy normalization), so the archive does need that file.
    const key = `upload:documents:${STAMP}_notes.bin`
    const relativePath = `documents/${STAMP}_notes.bin`
    const bytes = 'legacy binary bytes'
    await redis.json.set(key, '$', {
      originalName: 'notes.bin',
      mimetype: 'application/octet-stream',
      size: bytes.length,
      uploadType: 'documents',
      uploadedAt: '2026-10-20T12:00:00.000Z',
      base64: Buffer.from(bytes).toString('base64')
    })

    const result = await run()
    const archive = await readArchive(result.receipt.path)
    expect(archive.uploadFiles).toEqual({ [relativePath]: bytes })
    expect(archive.byKey[key].value).toMatchObject({ storage: 'filesystem', relativePath, size: bytes.length })
    expect(archive.byKey[key].value).not.toHaveProperty('base64')
    expect(archive.manifest.contents).toMatchObject({ fileAssetCount: 1, fileAssetBytes: bytes.length })
    expect(archive.clips).toMatchObject({ recordCount: 1, fileAssetCount: 1 })

    await deleteKeys(key)
    expect(await restoreFrom(result.receipt.path)).toMatchObject({ restored: true, fileAssetCount: 1 })
    expect(await redis.json.get(key)).toMatchObject({
      storage: 'filesystem',
      relativePath,
      filePath: path.join(uploadRoot, relativePath)
    })
    expect(await fs.readFile(path.join(uploadRoot, relativePath), 'utf8')).toBe(bytes)
  })

  it('still refuses a file-backed upload whose file is missing, in the export and in the verifier', async () => {
    await redis.json.set(MANIFEST_KEY, '$', manifestRecord())
    await seedFileUpload(VRM_KEY, VRM_PATH, null)

    // The run: the export's one upload inspection stops it before any byte streams (BL-378).
    const failure = await failureOf(run())
    expect(failure).toBeInstanceOf(BackupRestoreError)
    expect(failure?.status).toBe(409)
    expect(failure?.message).toContain('Backup stopped: 1 uploaded file cannot be backed up (1 missing; 0 of 1 found in')
    expect(failure?.message).toContain(VRM_PATH)
    expect(failure?.message).not.toContain('goon_guided_manifests')
    expect(await fs.readdir(folder)).toEqual([])

    // The verifier: an archive without a file-backed record's file is refused with its own message.
    await seedFileUpload(VRM_KEY, VRM_PATH, 'vrm-bytes')
    const entries = unzipSync((await createBackupBundle(USER)).bytes)
    expect(Object.keys(entries)).toContain(`files/uploads/${VRM_PATH}`)
    delete entries[`files/uploads/${VRM_PATH}`]
    const tampered = path.join(root, 'without-vrm.zip')
    await fs.writeFile(tampered, zipSync(entries))
    await expect(verifyAutomaticBackupArchive(tampered, USER)).rejects.toThrow(
      `Automatic backup is missing the file for ${VRM_KEY}.`
    )
  })

  it('backs up and restores a mixed instance: the Goon files from disk, its manifest from Redis', async () => {
    await seedFileUpload(VRM_KEY, VRM_PATH, 'vrm-bytes')
    await seedFileUpload(PACKAGE_KEY, PACKAGE_PATH, 'package-bytes')
    await redis.json.set(MANIFEST_KEY, '$', manifestRecord())

    const result = await run()
    const archive = await readArchive(result.receipt.path)
    expect(archive.uploadFiles).toEqual({ [VRM_PATH]: 'vrm-bytes', [PACKAGE_PATH]: 'package-bytes' })
    expect(archive.manifest.contents).toMatchObject({
      fileAssetCount: 2,
      fileAssetBytes: 'vrm-bytes'.length + 'package-bytes'.length
    })
    expect(archive.clips).toMatchObject({ recordCount: 3, fileAssetCount: 2 })
    expect(archive.byKey[MANIFEST_KEY].value).toEqual(manifestRecord())
    expect(await auditBackupUploadFiles(USER)).toMatchObject({ fileBackedCount: 2, foundCount: 2, problemCount: 0 })

    await deleteKeys(VRM_KEY, PACKAGE_KEY, MANIFEST_KEY)
    await fs.rm(path.join(uploadRoot, 'goons'), { recursive: true })
    await fs.rm(path.join(uploadRoot, 'goon_guided_packages'), { recursive: true })
    expect(await restoreFrom(result.receipt.path)).toMatchObject({ restored: true, fileAssetCount: 2 })
    expect(await redis.json.get(MANIFEST_KEY)).toEqual(manifestRecord())
    for (const [key, relativePath, content] of [[VRM_KEY, VRM_PATH, 'vrm-bytes'], [PACKAGE_KEY, PACKAGE_PATH, 'package-bytes']]) {
      expect(await redis.json.get(key)).toMatchObject({ storage: 'filesystem', relativePath, filePath: path.join(uploadRoot, relativePath) })
      expect(await fs.readFile(path.join(uploadRoot, relativePath), 'utf8')).toBe(content)
    }
    await expect(fs.stat(path.join(uploadRoot, 'goon_guided_manifests'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('one rule for every record shape that keeps its content in Redis (BL-2401)', () => {
  // batshit-server serves a record's file only when the record names one (relativePath, else
  // filePath); otherwise it serves the record's text first. A marker or a Base64 copy beside the
  // text changes neither, so the backup keeps such a record exactly as stored and needs no file.
  it.each([
    ['a storage mode marker', { storageMode: 'local' }],
    ['a filesystem storage marker', { storage: 'filesystem' }],
    ['a Base64 copy beside it', { base64: Buffer.from('other bytes').toString('base64') }]
  ])('a text upload with %s and no file named needs no file, and restores as it was', async (_label, extra) => {
    await redis.json.set(MANIFEST_KEY, '$', manifestRecord(extra))

    const result = await run()
    const archive = await readArchive(result.receipt.path)
    expect(archive.byKey[MANIFEST_KEY].value).toEqual(manifestRecord(extra))
    expect(archive.uploadFiles).toEqual({})
    expect(archive.clips).toMatchObject({ recordCount: 1, fileAssetCount: 0 })

    await deleteKeys(MANIFEST_KEY)
    await restoreFrom(result.receipt.path)
    expect(await redis.json.get(MANIFEST_KEY)).toEqual(manifestRecord(extra))
  })

  it('a text upload that names a file is served from that file, so its text does not excuse a missing file', async () => {
    const filePath = path.join(uploadRoot, MANIFEST_KEY_PATH)
    await redis.json.set(MANIFEST_KEY, '$', manifestRecord({ storage: 'filesystem', relativePath: MANIFEST_KEY_PATH, filePath }))

    const failure = await failureOf(run())
    expect(failure?.status).toBe(409)
    expect(failure?.message).toContain(MANIFEST_KEY_PATH)

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'from-disk')
    const archive = await readArchive((await run()).receipt.path)
    expect(archive.uploadFiles).toEqual({ [MANIFEST_KEY_PATH]: 'from-disk' })
    expect(archive.clips).toMatchObject({ recordCount: 1, fileAssetCount: 1 })
  })

  it('a Redis string upload record that names no file needs no file in an automatic backup either', async () => {
    const stored = JSON.stringify({ originalName: 'note.txt', mimetype: 'text/plain', uploadType: 'documents', textContent: 'inline note' })
    await redis.execute((client: any) => client.set('upload:documents:note.txt', stored))

    const archive = await readArchive((await run()).receipt.path)
    expect(archive.byKey['upload:documents:note.txt']).toMatchObject({ type: 'string', value: stored })
    expect(archive.uploadFiles).toEqual({})
    expect(archive.clips).toMatchObject({ recordCount: 1, fileAssetCount: 0 })
  })
})
