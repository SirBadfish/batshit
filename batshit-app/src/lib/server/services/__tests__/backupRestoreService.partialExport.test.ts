// @vitest-environment node
/**
 * BL-378 Phase 1b: the partial backup, through the REAL Admin export route and the REAL zip
 * stream. The user acknowledges the exact missing records the upload check listed (key, path and
 * the record's fingerprint); the export re-checks its own snapshot at action time and writes a
 * schema 2 archive that lists them, or an ordinary schema 1 archive when nothing is missing any
 * more, and says how every acknowledged entry ended in one bounded header.
 *
 * Owned state only: a temporary upload folder, the default-lane Redis fake and synthetic records.
 * Nothing is restored; no network call.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { unzipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { auditBackupUploadFiles } from '$lib/server/services/backupRestoreService'
import { archivedRecordSha256 } from '$lib/server/services/backupUploadInspection'
import { parseMissingUploadsSummary, type BackupPartialRequest } from '$lib/utils/backupPartialSummary'
import { POST as EXPORT } from '../../../../routes/api/admin/backup/export/+server'

useRedisTestServer()

const USER = 'phase1b_user'
const END_OF_CENTRAL_DIRECTORY = Buffer.from([0x50, 0x4b, 0x05, 0x06])
let uploadRoot = ''

beforeEach(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-partial-export-'))
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('the export must not call the network')
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fs.chmod(uploadRoot, 0o700).catch(() => undefined)
  await fs.rm(uploadRoot, { recursive: true, force: true })
})

/** A current file-backed upload record (shape S3); its file is written only when asked. */
async function seedUpload(key: string, relativePath: string, options: { file?: string; extra?: Record<string, unknown> } = {}) {
  const value = {
    filename: path.basename(relativePath),
    originalName: path.basename(relativePath),
    mimetype: 'application/octet-stream',
    size: options.file?.length ?? 3,
    uploadedAt: '2026-10-11T00:00:00.000Z',
    storage: 'filesystem',
    relativePath,
    filePath: path.join(uploadRoot, relativePath),
    ...options.extra
  }
  await redis.json.set(key, '$', value)
  if (options.file !== undefined) await writeUploadFile(relativePath, options.file)
  return value
}

async function writeUploadFile(relativePath: string, content: string) {
  const target = path.join(uploadRoot, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  return target
}

/** A legacy Redis/Base64 upload (shape S1): its bytes travel inside the record. */
async function seedLegacyUpload(key: string, content: string) {
  await redis.json.set(key, '$', {
    filename: key.split(':').pop(),
    uploadType: key.split(':')[1],
    size: content.length,
    base64: Buffer.from(content).toString('base64'),
    uploadedAt: '2026-05-01T00:00:00.000Z'
  })
}

/** The acknowledgement the card sends: every problem row of the check, exactly as listed. */
async function acknowledgeCheck(): Promise<BackupPartialRequest['acknowledged']> {
  const check = await auditBackupUploadFiles(USER)
  expect(check.problems.every((problem) => problem.kind === 'missing')).toBe(true)
  return check.problems.map(({ key, relativePath, fingerprint }) => ({ key, relativePath, fingerprint }))
}

async function exportResponse(body: unknown) {
  return (await EXPORT({
    locals: { user: { id: USER, is_admin: true } },
    request: new Request('http://localhost/api/admin/backup/export', { method: 'POST', body: JSON.stringify(body) })
  } as any)) as Response
}

/** A finished export: the archive's manifest, records and upload files, and the route's headers. */
async function exportArchive(body: unknown) {
  const response = await exportResponse(body)
  expect(response.status, await peekError(response)).toBe(200)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const entries = unzipSync(bytes)
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  const records = Object.keys(entries)
    .filter((name) => name.startsWith('redis/records/'))
    .sort()
    .map((name) => JSON.parse(Buffer.from(entries[name]).toString('utf8')))
  const uploadFiles = Object.fromEntries(
    Object.keys(entries)
      .filter((name) => name.startsWith('files/uploads/'))
      .map((name) => [name.slice('files/uploads/'.length), Buffer.from(entries[name]).toString('utf8')])
  )
  return {
    manifest,
    records,
    uploadFiles,
    filename: /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? '',
    schemaHeader: response.headers.get('X-Batshit-Backup-Schema'),
    summaryHeader: response.headers.get('X-Batshit-Backup-Missing-Uploads')
  }
}

async function peekError(response: Response) {
  if (response.status === 200) return ''
  return JSON.stringify(await response.clone().json().catch(() => null))
}

async function refusal(body: unknown) {
  const response = await exportResponse(body)
  return { status: response.status, body: await response.json(), summaryHeader: response.headers.get('X-Batshit-Backup-Missing-Uploads') }
}

/** Every Redis key with its type and value, and every file under the upload folder. */
async function snapshotState() {
  const keys = await redis.execute(async (client: any) => {
    const out: string[] = []
    for (const key of (await client.keys('*')).sort()) {
      const type = String(await client.type(key))
      const value = type === 'string' ? await client.get(key) : type === 'set' ? (await client.sMembers(key)).sort() : await client.json.get(key)
      out.push(`${key} ${type} ${JSON.stringify(value)}`)
    }
    return out
  })
  const files: string[] = []
  async function walk(current: string) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const stat = await fs.lstat(full)
      files.push(`${path.relative(uploadRoot, full)} ${stat.size} ${stat.mtimeMs}`)
      if (entry.isDirectory()) await walk(full)
    }
  }
  await walk(uploadRoot)
  return { keys, files }
}

describe('a partial backup lists exactly the acknowledged missing records (BL-378 Phase 1b)', () => {
  it('writes schema 2 with a PARTIAL name, both counts, the archived record hashes and the summary header, and writes nothing', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', { file: 'here' })
    await seedUpload('upload:images:gone_a.png', 'images/gone_a.png')
    await seedUpload('upload:documents:gone_b.txt', 'documents/gone_b.txt')
    const acknowledged = await acknowledgeCheck()
    expect(acknowledged.map((entry) => entry.key)).toEqual(['upload:documents:gone_b.txt', 'upload:images:gone_a.png'])
    const before = await snapshotState()

    const archive = await exportArchive({ includeSecrets: false, partial: { acknowledged } })

    expect(archive.filename).toMatch(/^batshit-backup-PARTIAL-\d{4}-\d{2}-\d{2}T\d{6}Z\.zip$/)
    expect(archive.schemaHeader).toBe('2')
    expect(archive.manifest).toMatchObject({
      schemaVersion: 2,
      completeness: 'partial',
      compatibility: { minSchemaVersion: 2, maxSchemaVersion: 2, restoreMode: 'fresh-or-destructive-replace' },
      contents: { fileAssetCount: 1, missingUploadRecordCount: 2, missingUploadFileCount: 2 }
    })
    expect(archive.uploadFiles).toEqual({ 'images/present.png': 'here' })
    const byKey = new Map(archive.records.map((record) => [record.key, record]))
    expect(archive.manifest.uploads.missing).toEqual(
      acknowledged.map((entry) => ({
        ...entry,
        kind: 'missing',
        // The hash of the record exactly as the archive holds it.
        archivedRecordSha256: archivedRecordSha256(byKey.get(entry.key))
      }))
    )
    // Every listed record travels; only its file does not.
    for (const entry of acknowledged) expect(byKey.get(entry.key)?.value).toMatchObject({ storage: 'filesystem', relativePath: entry.relativePath })
    expect(parseMissingUploadsSummary(archive.summaryHeader)).toEqual({
      completeness: 'partial',
      missingFiles: 2,
      missingRecords: 2,
      foundAgainFiles: 0,
      goneRecords: 0,
      otherRecords: 0
    })
    expect(await snapshotState()).toEqual(before)
  })

  it('two alias records of one path are one file and two records; both must be acknowledged [A3]', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', { file: 'here' })
    // An avatar under both key forms names one file (avatarOwnerSweep.js knows both).
    await seedUpload('upload:avatars:agent_a_1.jpg', 'avatars/agent_a_1.jpg')
    await seedUpload('upload:avatars:agent:agent_a_1.jpg', 'avatars/agent_a_1.jpg')
    const acknowledged = await acknowledgeCheck()
    expect(acknowledged.map((entry) => entry.relativePath)).toEqual(['avatars/agent_a_1.jpg', 'avatars/agent_a_1.jpg'])

    // One alias alone is not enough: the other is a missing record nobody acknowledged.
    const oneAlias = await refusal({ partial: { acknowledged: acknowledged.slice(0, 1) } })
    expect(oneAlias.status).toBe(409)
    expect(oneAlias.body.details).toMatchObject({ code: 'BACKUP_PARTIAL_REFUSED', reasons: ['new-missing'] })
    expect(oneAlias.summaryHeader).toBeNull()

    const archive = await exportArchive({ partial: { acknowledged } })
    expect(archive.manifest.contents).toMatchObject({ missingUploadRecordCount: 2, missingUploadFileCount: 1 })
    expect(archive.manifest.uploads.missing.map((entry: { key: string }) => entry.key)).toEqual(acknowledged.map((entry) => entry.key))
    expect(parseMissingUploadsSummary(archive.summaryHeader)).toMatchObject({ missingFiles: 1, missingRecords: 2 })
  })

  it('an alias that appears after the check is new information and refuses [A3]', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', { file: 'here' })
    await seedUpload('upload:avatars:agent_b_1.jpg', 'avatars/agent_b_1.jpg')
    const acknowledged = await acknowledgeCheck()
    await seedUpload('upload:avatars:agent:agent_b_1.jpg', 'avatars/agent_b_1.jpg')

    const answer = await refusal({ partial: { acknowledged } })
    expect(answer.status).toBe(409)
    expect(answer.body.details).toMatchObject({
      reasons: ['new-missing'],
      unacknowledged: [{ key: 'upload:avatars:agent:agent_b_1.jpg', relativePath: 'avatars/agent_b_1.jpg' }]
    })
    expect(answer.body.error).toContain('1 missing upload record was not in the acknowledged list (avatars/agent_b_1.jpg)')
  })
})

describe('what changed since the check decides the archive and the sentence ([A2] [B3])', () => {
  it('a found-again file is carried and not listed; the rest stay listed', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', { file: 'here' })
    await seedUpload('upload:images:back.png', 'images/back.png')
    await seedUpload('upload:images:still.png', 'images/still.png')
    const acknowledged = await acknowledgeCheck()
    await writeUploadFile('images/back.png', 'returned')

    const archive = await exportArchive({ partial: { acknowledged } })
    expect(archive.manifest.schemaVersion).toBe(2)
    expect(archive.uploadFiles).toEqual({ 'images/back.png': 'returned', 'images/present.png': 'here' })
    expect(archive.manifest.uploads.missing.map((entry: { key: string }) => entry.key)).toEqual(['upload:images:still.png'])
    expect(parseMissingUploadsSummary(archive.summaryHeader)).toEqual({
      completeness: 'partial',
      missingFiles: 1,
      missingRecords: 1,
      foundAgainFiles: 1,
      goneRecords: 0,
      otherRecords: 0
    })
  })

  it('when nothing is missing any more it writes an ordinary schema 1 backup, never schema 2 with an empty list', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', { file: 'here' })
    await seedUpload('upload:images:back.png', 'images/back.png')
    await seedUpload('upload:images:deleted.png', 'images/deleted.png')
    await seedUpload('upload:images:legacy-now.png', 'images/legacy-now.png')
    const acknowledged = await acknowledgeCheck()
    await writeUploadFile('images/back.png', 'returned')
    await redis.del('upload:images:deleted.png')
    // The record changed another way: it now carries its bytes inside itself (a legacy copy).
    await redis.json.set('upload:images:legacy-now.png', '$', {
      filename: 'legacy-now.png',
      uploadType: 'images',
      size: 6,
      base64: Buffer.from('inside').toString('base64')
    })

    const archive = await exportArchive({ partial: { acknowledged } })
    expect(archive.filename).toMatch(/^batshit-backup-\d{4}-\d{2}-\d{2}T\d{6}Z\.zip$/)
    expect(archive.schemaHeader).toBe('1')
    expect(archive.manifest.schemaVersion).toBe(1)
    expect(archive.manifest.compatibility).toEqual({ minSchemaVersion: 1, maxSchemaVersion: 1, restoreMode: 'fresh-or-destructive-replace' })
    for (const field of ['completeness', 'uploads']) expect(Object.hasOwn(archive.manifest, field), field).toBe(false)
    for (const field of ['missingUploadRecordCount', 'missingUploadFileCount']) {
      expect(Object.hasOwn(archive.manifest.contents, field), field).toBe(false)
    }
    expect(archive.uploadFiles).toEqual({
      'images/back.png': 'returned',
      'images/legacy-now.png': 'inside',
      'images/present.png': 'here'
    })
    expect(parseMissingUploadsSummary(archive.summaryHeader)).toEqual({
      completeness: 'complete',
      missingFiles: 0,
      missingRecords: 0,
      foundAgainFiles: 1,
      goneRecords: 1,
      otherRecords: 1
    })
  })

  it('every acknowledged record gone: a complete backup whose summary says gone, never found again', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', { file: 'here' })
    await seedUpload('upload:images:a.png', 'images/a.png')
    await seedUpload('upload:images:b.png', 'images/b.png')
    const acknowledged = await acknowledgeCheck()
    await redis.del('upload:images:a.png')
    await redis.del('upload:images:b.png')

    const archive = await exportArchive({ partial: { acknowledged } })
    expect(archive.manifest.schemaVersion).toBe(1)
    expect(parseMissingUploadsSummary(archive.summaryHeader)).toEqual({
      completeness: 'complete',
      missingFiles: 0,
      missingRecords: 0,
      foundAgainFiles: 0,
      goneRecords: 2,
      otherRecords: 0
    })
  })
})

describe('legacy Base64 copies: files and records are counted apart ([B1] [B2])', () => {
  it('mixed: one found, one legacy, one missing file under two aliases', async () => {
    await seedUpload('upload:images:p1.png', 'images/p1.png', { file: 'disk' })
    await seedLegacyUpload('upload:images:p2.png', 'legacy')
    await seedUpload('upload:avatars:p3.jpg', 'avatars/p3.jpg')
    await seedUpload('upload:avatars:agent:p3.jpg', 'avatars/p3.jpg')
    const acknowledged = await acknowledgeCheck()

    // Something was found, so no all-missing confirmation is needed.
    const archive = await exportArchive({ partial: { acknowledged } })
    expect(archive.manifest.contents).toMatchObject({ fileAssetCount: 2, missingUploadRecordCount: 2, missingUploadFileCount: 1 })
    expect(archive.uploadFiles).toEqual({ 'images/p1.png': 'disk', 'images/p2.png': 'legacy' })
    expect(parseMissingUploadsSummary(archive.summaryHeader)).toMatchObject({ missingFiles: 1, missingRecords: 2 })
  })

  it('mixed with nothing found: refused without the second confirmation; with it, the archive holds only the legacy file', async () => {
    await seedLegacyUpload('upload:images:p2.png', 'legacy')
    await seedUpload('upload:avatars:p3.jpg', 'avatars/p3.jpg')
    await seedUpload('upload:avatars:agent:p3.jpg', 'avatars/p3.jpg')
    const check = await auditBackupUploadFiles(USER)
    // The card's second box says how many older files the archive would hold: files, not records.
    expect(check).toMatchObject({ uploadFolderFoundNothing: true, legacyCopyCount: 1, legacyCopyFileCount: 1 })
    const acknowledged = await acknowledgeCheck()

    const unconfirmed = await refusal({ partial: { acknowledged } })
    expect(unconfirmed.status).toBe(409)
    expect(unconfirmed.body.details.reasons).toEqual(['all-missing-unconfirmed'])
    expect(unconfirmed.body.error).toContain(`none of the 1 upload file Batshit expects is in ${uploadRoot}, and that was not confirmed`)

    const archive = await exportArchive({ partial: { acknowledged, confirmAllMissing: true } })
    expect(archive.uploadFiles).toEqual({ 'images/p2.png': 'legacy' })
    expect(archive.manifest.contents).toMatchObject({ fileAssetCount: 1, missingUploadRecordCount: 2, missingUploadFileCount: 1 })
  })

  it('Base64-only survivors: with the missing records gone, an ordinary backup; the all-missing rule never runs', async () => {
    await seedLegacyUpload('upload:images:p2.png', 'legacy')
    await seedUpload('upload:avatars:p3.jpg', 'avatars/p3.jpg')
    await seedUpload('upload:avatars:agent:p3.jpg', 'avatars/p3.jpg')
    const acknowledged = await acknowledgeCheck()
    await redis.del('upload:avatars:p3.jpg')
    await redis.del('upload:avatars:agent:p3.jpg')

    // No confirmAllMissing, although nothing is found in the folder: nothing is missing now.
    const archive = await exportArchive({ partial: { acknowledged } })
    expect(archive.manifest.schemaVersion).toBe(1)
    expect(archive.uploadFiles).toEqual({ 'images/p2.png': 'legacy' })
    expect(parseMissingUploadsSummary(archive.summaryHeader)).toMatchObject({ completeness: 'complete', goneRecords: 2 })
  })

  it('distinct counts: three missing records naming two files, beside one legacy record', async () => {
    await seedUpload('upload:images:found.png', 'images/found.png', { file: 'disk' })
    await seedLegacyUpload('upload:images:legacy.png', 'legacy')
    await seedUpload('upload:avatars:x.jpg', 'avatars/x.jpg')
    await seedUpload('upload:avatars:agent:x.jpg', 'avatars/x.jpg')
    await seedUpload('upload:documents:y.txt', 'documents/y.txt')
    const acknowledged = await acknowledgeCheck()
    expect(acknowledged).toHaveLength(3)

    const archive = await exportArchive({ partial: { acknowledged } })
    expect(archive.manifest.contents).toMatchObject({ missingUploadRecordCount: 3, missingUploadFileCount: 2, fileAssetCount: 2 })
    expect(parseMissingUploadsSummary(archive.summaryHeader)).toMatchObject({ missingFiles: 2, missingRecords: 3 })
    // The legacy record is neither a missing record nor a found file.
    expect(archive.manifest.uploads.missing.map((entry: { key: string }) => entry.key)).not.toContain('upload:images:legacy.png')
  })
})

describe('a found file that fails while streaming fails the partial export; no catch turns it into a listed file [A4]', () => {
  async function seedAndAnswer() {
    await seedUpload('upload:images:present.png', 'images/present.png', { file: 'here' })
    await seedUpload('upload:images:missing.png', 'images/missing.png')
    const acknowledged = await acknowledgeCheck()
    const response = await exportResponse({ partial: { acknowledged } })
    expect(response.status).toBe(200)
    return response
  }

  async function readFailure(response: Response) {
    const reader = response.body!.getReader()
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return { error: null as unknown, bytes: Buffer.concat(chunks) }
        chunks.push(value)
      }
    } catch (error) {
      return { error, bytes: Buffer.concat(chunks) }
    }
  }

  it('removed after the inspection: the download ends with an error, no zip, no new list entry', async () => {
    const response = await seedAndAnswer()
    await fs.rm(path.join(uploadRoot, 'images/present.png'))
    const result = await readFailure(response)
    expect(result.error).toMatchObject({ name: 'BackupRestoreError', status: 500, message: 'Backup failed while streaming "images/present.png".' })
    expect(result.bytes.includes(END_OF_CENTRAL_DIRECTORY)).toBe(false)
    // The manifest, with its list, is the archive's last entry: its local header (whose name is
    // stored uncompressed) was never written.
    expect(result.bytes.includes(Buffer.from('manifest.json'))).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('mode 000 after the inspection: the same clean failure', async () => {
    const response = await seedAndAnswer()
    await fs.chmod(path.join(uploadRoot, 'images/present.png'), 0o000)
    const result = await readFailure(response)
    expect(result.error).toMatchObject({ name: 'BackupRestoreError', status: 500 })
    expect(String((result.error as { details?: unknown }).details)).toContain('EACCES')
    expect(result.bytes.includes(END_OF_CENTRAL_DIRECTORY)).toBe(false)
  })
})

describe('a complete export is unchanged [A5]', () => {
  it('schema 1, compatibility 1 to 1, header 1, no partial fields and no summary header', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', { file: 'here' })
    const archive = await exportArchive({ includeSecrets: false })
    expect(archive.schemaHeader).toBe('1')
    expect(archive.summaryHeader).toBeNull()
    expect(archive.filename).toMatch(/^batshit-backup-\d{4}-\d{2}-\d{2}T\d{6}Z\.zip$/)
    expect(archive.manifest.schemaVersion).toBe(1)
    expect(archive.manifest.compatibility).toEqual({ minSchemaVersion: 1, maxSchemaVersion: 1, restoreMode: 'fresh-or-destructive-replace' })
    expect(Object.keys(archive.manifest)).toEqual([
      'schemaVersion',
      'app',
      'createdAt',
      'source',
      'options',
      'contents',
      'secrets',
      'hostFiles',
      'externalReferences',
      'compatibility'
    ])
    expect(Object.keys(archive.manifest.contents)).toEqual([
      'redisRecordCount',
      'fileAssetCount',
      'fileAssetBytes',
      'hostFileCount',
      'hostFileBytes',
      'groups'
    ])
  })
})
