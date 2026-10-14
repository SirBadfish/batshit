// @vitest-environment node
/**
 * BL-378 Phase 1b §3 and §4: the reader takes schema 2 only as a partial backup, and checks a
 * partial backup's list against its exact archived records and its own files, through BOTH
 * restore preflights (the buffer one and the staged one) and the restore itself. The list adds
 * only refusals and warnings: a partial backup restores as the established destructive replace,
 * so a listed file is missing afterwards even if this computer had it.
 *
 * The archives are real ones, written by the real export route from synthetic records, then
 * edited where a case needs a malformed one. Owned state only: temporary upload, staging and home
 * folders (the restore's skill and voice roots come from the home folder), the default-lane Redis
 * fake, and a stubbed file-service barrier (no batshit-server runs).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { unzipSync, zipSync } from 'fflate/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const nodePath = await import('node:path')
  if (!testHome.current) testHome.current = nodePath.join(real.tmpdir(), `batshit-partial-reader-home-${process.pid}-${Date.now()}`)
  const homedir = () => testHome.current
  return { ...real, homedir, default: { ...real, homedir } }
})

import os from 'node:os'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  auditBackupUploadFiles,
  preflightBackupRestore,
  preflightStagedBackupRestore,
  restoreBackupBundle
} from '$lib/server/services/backupRestoreService'
import { POST as EXPORT } from '../../../../routes/api/admin/backup/export/+server'

useRedisTestServer()

const USER = 'phase1b_reader'
const STAGE_ID = '11111111-2222-4333-8444-5555555555cc'
const INCONSISTENT = "This backup's partial-backup information is inconsistent."
const LIST = "This partial backup's list of missing upload files is invalid:"
let uploadRoot = ''
let stagingRoot = ''

beforeAll(() => {
  expect(os.homedir()).toBe(testHome.current)
})

afterAll(async () => {
  await fs.rm(testHome.current, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.stubEnv('HOME', testHome.current)
  vi.stubEnv('BATSHIT_TOKEN', 'partial-reader-test-token')
  // The restore's file-service barrier is the only call out; nothing else may fetch.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/\/api\/upload\/asset-maintenance\/(begin|end)$/)
    const { token } = JSON.parse(String(init.body))
    return Response.json({ success: true, token, state: url.endsWith('/begin') ? 'created' : 'released', activeOperations: 0 })
  }))
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-partial-reader-uploads-'))
  stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-partial-reader-staging-'))
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_BACKUP_STAGING_DIR', stagingRoot)
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fs.rm(uploadRoot, { recursive: true, force: true })
  await fs.rm(stagingRoot, { recursive: true, force: true })
})

async function writeUploadFile(relativePath: string, content: string) {
  const target = path.join(uploadRoot, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function seedUpload(key: string, relativePath: string, file?: string) {
  await redis.json.set(key, '$', {
    filename: path.basename(relativePath),
    size: file?.length ?? 3,
    storage: 'filesystem',
    relativePath,
    filePath: path.join(uploadRoot, relativePath)
  })
  if (file !== undefined) await writeUploadFile(relativePath, file)
}

/**
 * A real partial backup: one found file, one legacy Base64 upload, one missing file under two
 * alias records and one more missing file; three listed records naming two files.
 */
async function exportPartial() {
  await seedUpload('upload:images:present.png', 'images/present.png', 'here')
  await redis.json.set('upload:images:legacy.png', '$', {
    filename: 'legacy.png',
    uploadType: 'images',
    size: 6,
    base64: Buffer.from('legacy').toString('base64')
  })
  await seedUpload('upload:avatars:a.jpg', 'avatars/a.jpg')
  await seedUpload('upload:avatars:agent:a.jpg', 'avatars/a.jpg')
  await seedUpload('upload:documents:b.txt', 'documents/b.txt')
  await redis.json.set(`user:${USER}:settings`, '$', { theme: 'dark' })
  const check = await auditBackupUploadFiles(USER)
  const acknowledged = check.problems.map(({ key, relativePath, fingerprint }) => ({ key, relativePath, fingerprint }))
  const response = (await EXPORT({
    locals: { user: { id: USER, is_admin: true } },
    request: new Request('http://localhost/api/admin/backup/export', { method: 'POST', body: JSON.stringify({ partial: { acknowledged } }) })
  } as any)) as Response
  expect(response.status).toBe(200)
  return new Uint8Array(await response.arrayBuffer())
}

type Entries = Record<string, Uint8Array>
/** The archive with its manifest (and, if the edit wants, its other entries) changed. */
function rewrite(bytes: Uint8Array, edit: (manifest: any, entries: Entries) => void) {
  const entries = unzipSync(bytes)
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  edit(manifest, entries)
  entries['manifest.json'] = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  return zipSync(entries)
}

function recordEntryName(entries: Entries, key: string) {
  const name = Object.keys(entries).find(
    (entry) => entry.startsWith('redis/records/') && JSON.parse(Buffer.from(entries[entry]).toString('utf8')).key === key
  )
  expect(name, key).toBeTruthy()
  return name!
}

async function stage(bytes: Uint8Array) {
  const storageKey = createHash('sha256').update(STAGE_ID, 'utf8').digest('hex')
  const archivePath = path.join(stagingRoot, `${storageKey}.zip`)
  await fs.rm(archivePath, { force: true })
  await fs.writeFile(archivePath, bytes)
  await fs.writeFile(
    path.join(stagingRoot, `${storageKey}.json`),
    `${JSON.stringify({
      contract: 'batshit-backup-stage/v1',
      stageId: STAGE_ID,
      userId: USER,
      filename: 'batshit-backup.zip',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      stagedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      archivePath
    })}\n`
  )
  return STAGE_ID
}

const PREFLIGHTS = [
  ['the buffer preflight', (bytes: Uint8Array) => preflightBackupRestore(USER, bytes)],
  ['the staged preflight', async (bytes: Uint8Array) => preflightStagedBackupRestore(USER, await stage(bytes))]
] as const

async function outcome(run: Promise<unknown>) {
  try {
    await run
    return 'accepted'
  } catch (error) {
    const { status, message } = error as { status?: number; message?: string }
    return `${status}: ${message}`
  }
}

describe('a partial backup restores only as itself (BL-378 Phase 1b §3, §4)', () => {
  for (const [name, preflight] of PREFLIGHTS) {
    it(`${name} accepts a real partial backup, says "Partial backup" first, and accepts a duplicate path (aliases)`, async () => {
      const summary = await preflight(await exportPartial())
      expect(summary.manifest).toMatchObject({ schemaVersion: 2, completeness: 'partial' })
      expect(summary.fileAssetCount).toBe(2)
      expect(summary.warnings.slice(0, 2)).toEqual([
        'Partial backup: 2 upload files (3 upload records) are not in this backup. After the restore they will be missing here too, even if this computer has them now.',
        'Partial backup: the missing files are avatars/a.jpg, documents/b.txt.'
      ])
      // The established destructive replace still warns as before.
      expect(summary.warnings).toContain('Restore replaces current Batshit data. It does not merge records.')
    })
  }

  it('schema and partial-backup fields must agree, through both preflights (400)', async () => {
    const partial = await exportPartial()
    const cases: Array<[label: string, edit: (manifest: any) => void]> = [
      ['schema 2 without completeness', (manifest) => delete manifest.completeness],
      ['schema 2 without uploads', (manifest) => delete manifest.uploads],
      ['schema 2 that says complete', (manifest) => (manifest.completeness = 'complete')],
      ['schema 1 with the partial section', (manifest) => (manifest.schemaVersion = 1)],
      [
        'schema 1 with only the missing-upload counts',
        (manifest) => {
          manifest.schemaVersion = 1
          delete manifest.completeness
          delete manifest.uploads
        }
      ]
    ]
    for (const [name, preflight] of PREFLIGHTS) {
      const answers: string[] = []
      for (const [label, edit] of cases) answers.push(`${label} -> ${await outcome(preflight(rewrite(partial, edit)))}`)
      expect(answers, name).toEqual(cases.map(([label]) => `${label} -> 400: ${INCONSISTENT}`))
    }
  })

  it('the list must match its records and its archive exactly, through both preflights (400)', async () => {
    const partial = await exportPartial()
    const sample = unzipSync(partial)
    const listed = JSON.parse(Buffer.from(sample['manifest.json']).toString('utf8')).uploads.missing
    expect(listed.map((entry: { key: string }) => entry.key)).toEqual([
      'upload:avatars:a.jpg',
      'upload:avatars:agent:a.jpg',
      'upload:documents:b.txt'
    ])
    const recount = (manifest: any) => {
      manifest.contents.missingUploadRecordCount = manifest.uploads.missing.length
      manifest.contents.missingUploadFileCount = new Set(manifest.uploads.missing.map((entry: any) => entry.relativePath)).size
    }
    const cases: Array<[label: string, edit: (manifest: any, entries: Entries) => void, reason: string]> = [
      ['an empty list', (manifest) => (manifest.uploads.missing = []), 'it must list 1 to 10000 upload records'],
      [
        'a list over 10,000',
        (manifest) => {
          manifest.uploads.missing = Array.from({ length: 10_001 }, (_, index) => ({ ...listed[0], key: `upload:x:${index}` }))
        },
        'it must list 1 to 10000 upload records'
      ],
      ['another uploads field', (manifest) => (manifest.uploads.extra = true), 'uploads must hold only the missing list'],
      [
        'an unknown entry field',
        (manifest) => (manifest.uploads.missing[0].note = 'x'),
        'entry 1 must have exactly key, relativePath, kind, fingerprint, archivedRecordSha256'
      ],
      ['a wrong kind', (manifest) => (manifest.uploads.missing[0].kind = 'unreadable'), 'entry 1\'s kind is not "missing"'],
      [
        'an uppercase hash',
        (manifest) => (manifest.uploads.missing[0].archivedRecordSha256 = manifest.uploads.missing[0].archivedRecordSha256.toUpperCase()),
        "entry 1's hashes are not 64 lowercase hexadecimal characters"
      ],
      ['a duplicate key', (manifest) => manifest.uploads.missing.push({ ...manifest.uploads.missing[2] }), 'upload record upload:documents:b.txt is listed twice'],
      ['an unsafe path', (manifest) => (manifest.uploads.missing[2].relativePath = '../b.txt'), "entry 3's path is not a safe upload path"],
      ['an over-long path', (manifest) => (manifest.uploads.missing[2].relativePath = 'd'.repeat(4097)), "entry 3's path is not 1 to 4096 characters"],
      ['a path with a NUL', (manifest) => (manifest.uploads.missing[2].relativePath = 'documents/b\0.txt'), "entry 3's key or path contains a NUL character"],
      ['a wrong record count', (manifest) => (manifest.contents.missingUploadRecordCount = 4), 'its record and file counts do not match the list'],
      ['a wrong file count', (manifest) => (manifest.contents.missingUploadFileCount = 3), 'its record and file counts do not match the list'],
      [
        'an unknown key',
        (manifest) => (manifest.uploads.missing[2].key = 'upload:documents:nope.txt'),
        'listed upload record upload:documents:nope.txt is not in the archive'
      ],
      [
        'a wrong path',
        (manifest) => (manifest.uploads.missing[2].relativePath = 'documents/other.txt'),
        'listed upload record upload:documents:b.txt does not name the listed file'
      ],
      [
        'a wrong archived-record hash',
        (manifest) => {
          const hash: string = manifest.uploads.missing[2].archivedRecordSha256
          manifest.uploads.missing[2].archivedRecordSha256 = `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`
        },
        'listed upload record upload:documents:b.txt is not the record the backup listed'
      ],
      [
        'an archived record changed after the backup',
        (_manifest, entries) => {
          const name = recordEntryName(entries, 'upload:documents:b.txt')
          const record = JSON.parse(Buffer.from(entries[name]).toString('utf8'))
          record.value.size = 4
          entries[name] = new Uint8Array(Buffer.from(`${JSON.stringify(record)}\n`))
        },
        'listed upload record upload:documents:b.txt is not the record the backup listed'
      ],
      [
        'a listed entry that has a file',
        (manifest, entries) => {
          entries['files/uploads/documents/b.txt'] = new Uint8Array(Buffer.from('xyz'))
          manifest.contents.fileAssetCount += 1
          manifest.contents.fileAssetBytes += 3
        },
        'listed file documents/b.txt is in the archive'
      ],
      [
        'an unlisted hole',
        (manifest) => {
          manifest.uploads.missing = manifest.uploads.missing.slice(0, 2)
          recount(manifest)
        },
        'upload record upload:documents:b.txt has no file in the archive and is not listed'
      ],
      [
        'a missing alias',
        (manifest) => {
          manifest.uploads.missing = manifest.uploads.missing.filter((entry: any) => entry.key !== 'upload:avatars:agent:a.jpg')
          recount(manifest)
        },
        'upload record upload:avatars:agent:a.jpg has no file in the archive and is not listed'
      ]
    ]
    for (const [name, preflight] of PREFLIGHTS) {
      const answers: string[] = []
      for (const [label, edit] of cases) answers.push(`${label} -> ${await outcome(preflight(rewrite(partial, edit)))}`)
      expect(answers, name).toEqual(
        cases.map(([label, , reason]) =>
          // A 10,001-entry list cannot fit the 2 MiB manifest the staged reader reads, so its own
          // size refusal (400) comes first there; the buffer reader reaches the list's bound.
          label === 'a list over 10,000' && name === 'the staged preflight'
            ? `${label} -> 400: Backup entry "manifest.json" is too large to validate safely.`
            : `${label} -> 400: ${LIST} ${reason}.`
        )
      )
    }
  }, 60_000)

  it('restores like any backup: every record back through the normal filePath rewrite, a listed file gone even though this computer had it [B4]', async () => {
    const bytes = await exportPartial()
    // This computer has the listed file now, and one file the backup knows nothing about.
    await writeUploadFile('documents/b.txt', 'local-copy')
    await writeUploadFile('images/local-only.png', 'local-only')

    const result = await restoreBackupBundle(USER, bytes, { confirmReplace: true })
    expect(result).toMatchObject({ restored: true, fileAssetCount: 2 })

    // The established destructive replace: only the backup's files are live afterwards.
    const live: string[] = []
    async function walk(dir: string) {
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.restore-')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else live.push(path.relative(uploadRoot, full))
      }
    }
    await walk(uploadRoot)
    expect(live).toEqual(['images/legacy.png', 'images/present.png'])
    expect(await fs.readFile(path.join(uploadRoot, 'images/present.png'), 'utf8')).toBe('here')

    // Every record is back, listed or not, with today's filePath rewrite and its path kept.
    for (const [key, relativePath] of [
      ['upload:documents:b.txt', 'documents/b.txt'],
      ['upload:avatars:a.jpg', 'avatars/a.jpg'],
      ['upload:avatars:agent:a.jpg', 'avatars/a.jpg'],
      ['upload:images:present.png', 'images/present.png'],
      ['upload:images:legacy.png', 'images/legacy.png']
    ]) {
      expect(await redis.json.get(key), key).toMatchObject({ storage: 'filesystem', relativePath, filePath: path.join(uploadRoot, relativePath) })
    }
    // The restored list is the archive's; restoring it again reads the same partial backup.
    expect((await preflightBackupRestore(USER, bytes)).manifest.completeness).toBe('partial')
  }, 60_000)
})
