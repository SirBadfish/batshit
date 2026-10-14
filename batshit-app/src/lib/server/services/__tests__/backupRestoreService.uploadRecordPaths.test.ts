/**
 * Where the export finds an upload record's file, for the older record shapes no current
 * writer produces (recon-bl1379-1380.md, shapes X1 and X2).
 *
 * BL-1379: a file-backed record with `filePath` but no `relativePath` and no Base64 copy is
 * found where batshit-server serves it from: its `filePath`, when that lies inside the upload
 * folder. The pinned legacy Base64 typed avatar keeps its nested key path.
 *
 * Owned state only: a temporary upload folder (and a temporary folder outside it), the
 * default-lane Redis fake and synthetic records. Nothing is restored; no network call.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { unzipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  BackupRestoreError,
  auditBackupUploadFiles,
  createBackupBundle,
  preflightBackupRestore
} from '../backupRestoreService'

useRedisTestServer()

const USER = 'user-1'
let uploadRoot = ''
let outsideRoot = ''

beforeEach(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-upload-paths-'))
  outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-upload-paths-outside-'))
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('the export and the upload check must not call the network')
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await fs.rm(uploadRoot, { recursive: true, force: true })
  await fs.rm(outsideRoot, { recursive: true, force: true })
})

async function writeFileAt(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  return target
}

function archiveOf(bytes: Uint8Array) {
  const entries = unzipSync(bytes)
  const records = Object.keys(entries)
    .filter((name) => name.startsWith('redis/records/'))
    .map((name) => JSON.parse(Buffer.from(entries[name]).toString('utf8')))
  const uploadFiles = Object.fromEntries(
    Object.keys(entries)
      .filter((name) => name.startsWith('files/uploads/'))
      .map((name) => [name, Buffer.from(entries[name]).toString('utf8')])
  )
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  return { records, uploadFiles, manifest }
}

async function exportError() {
  return createBackupBundle(USER).then(
    () => null,
    (caught: unknown) => caught as BackupRestoreError
  )
}

/** An X1 record: file-backed, `filePath` only (no `relativePath`), no Base64 copy. */
function filePathOnlyAvatar(filename: string, filePath: string) {
  return {
    originalName: filename,
    filename,
    mimetype: 'image/jpeg',
    size: 6,
    uploadType: 'avatars',
    entityType: 'agent',
    entityId: 'agent_a',
    storage: 'filesystem',
    filePath,
    uploadedAt: '2026-04-01T00:00:00.000Z'
  }
}

describe('a filePath-only record is found where the server serves it (BL-1379)', () => {
  it('carries a typed avatar whose file is at the flat path, with its flat alias, as one file', async () => {
    const filePath = await writeFileAt(uploadRoot, 'avatars/agent_a_1.jpg', 'avatar')
    await redis.json.set('upload:avatars:agent:agent_a_1.jpg', '$', filePathOnlyAvatar('agent_a_1.jpg', filePath))
    // The current flat alias of the same file (shape S3), as the avatar owner sweep knows both.
    await redis.json.set('upload:avatars:agent_a_1.jpg', '$', {
      ...filePathOnlyAvatar('agent_a_1.jpg', filePath),
      relativePath: 'avatars/agent_a_1.jpg'
    })

    const check = await auditBackupUploadFiles(USER)
    expect(check).toMatchObject({ fileBackedCount: 2, foundCount: 2, problemCount: 0, exportBlockedMessage: null })

    const { records, uploadFiles, manifest } = archiveOf((await createBackupBundle(USER)).bytes)
    expect(uploadFiles).toEqual({ 'files/uploads/avatars/agent_a_1.jpg': 'avatar' })
    expect(manifest.contents.fileAssetCount).toBe(1)
    const typed = records.find((record) => record.key === 'upload:avatars:agent:agent_a_1.jpg')
    expect(typed.value).toMatchObject({ storage: 'filesystem', relativePath: 'avatars/agent_a_1.jpg' })
    // The archive never carries this computer's absolute path; restore writes the target's own.
    expect(typed.value.filePath).toBeUndefined()
  })

  it('keeps the pinned nested path of a legacy Base64 typed avatar (backupRestoreService.test.ts:395-403, 1426-1435)', async () => {
    await redis.json.set('upload:avatars:agent:legacy-avatar.png', '$', {
      originalName: 'legacy-avatar.png',
      filename: 'legacy-avatar.png',
      mimetype: 'image/png',
      size: 19,
      base64: Buffer.from('legacy-avatar-bytes').toString('base64'),
      uploadType: 'avatars',
      uploadedAt: '2026-05-22T00:00:00.000Z'
    })

    const bytes = (await createBackupBundle(USER)).bytes
    const { records, uploadFiles } = archiveOf(bytes)
    expect(uploadFiles).toEqual({ 'files/uploads/avatars/agent/legacy-avatar.png': 'legacy-avatar-bytes' })
    const legacy = records.find((record) => record.key === 'upload:avatars:agent:legacy-avatar.png')
    expect(legacy.value.base64).toBeUndefined()
    expect(legacy.value).toMatchObject({ storage: 'filesystem', relativePath: 'avatars/agent/legacy-avatar.png' })
    // Restore reads only the archived relativePath, so it places the file at the same nested path.
    await expect(preflightBackupRestore(USER, bytes)).resolves.toMatchObject({ ok: true, fileAssetCount: 1 })
  })

  it('keeps the key path when the record also has a Base64 copy, even with an in-root filePath', async () => {
    const filePath = await writeFileAt(uploadRoot, 'avatars/both.png', 'on-disk')
    await redis.json.set('upload:avatars:agent:both.png', '$', {
      ...filePathOnlyAvatar('both.png', filePath),
      base64: Buffer.from('from-record').toString('base64')
    })

    const { records, uploadFiles } = archiveOf((await createBackupBundle(USER)).bytes)
    expect(uploadFiles).toEqual({ 'files/uploads/avatars/agent/both.png': 'from-record' })
    expect(records.find((record) => record.key === 'upload:avatars:agent:both.png').value.relativePath)
      .toBe('avatars/agent/both.png')
  })

  it('never uses a filePath outside the upload folder: the key path is checked and reported missing', async () => {
    const outside = await writeFileAt(outsideRoot, 'avatars/foreign.jpg', 'foreign')
    const climbing = path.join(uploadRoot, 'avatars', '..', '..', path.basename(outsideRoot), 'avatars', 'foreign.jpg')
    expect(path.resolve(climbing)).toBe(outside)
    await redis.json.set('upload:avatars:agent:foreign.jpg', '$', filePathOnlyAvatar('foreign.jpg', outside))
    await redis.json.set('upload:avatars:agent:climbing.jpg', '$', filePathOnlyAvatar('climbing.jpg', climbing))
    await redis.json.set('upload:avatars:agent:relative.jpg', '$', filePathOnlyAvatar('relative.jpg', 'avatars/relative.jpg'))
    await writeFileAt(uploadRoot, 'avatars/relative.jpg', 'relative')
    // The upload folder itself is not a file inside it.
    await redis.json.set('upload:avatars:agent:root.jpg', '$', filePathOnlyAvatar('root.jpg', uploadRoot))

    const expectedPaths = [
      'avatars/agent/climbing.jpg',
      'avatars/agent/foreign.jpg',
      'avatars/agent/relative.jpg',
      'avatars/agent/root.jpg'
    ]
    const failure = await exportError()
    expect(failure).toBeInstanceOf(BackupRestoreError)
    expect(failure?.status).toBe(409)
    const listed = (failure?.details as { problems: Array<{ relativePath: string; kind: string }> }).problems
    expect(listed.map((problem) => [problem.relativePath, problem.kind])).toEqual(expectedPaths.map((entry) => [entry, 'missing']))

    const check = await auditBackupUploadFiles(USER)
    expect(check.problems.map((problem) => [problem.relativePath, problem.kind])).toEqual(expectedPaths.map((entry) => [entry, 'missing']))
    expect(await fs.readFile(outside, 'utf8')).toBe('foreign')
  })
})

/** A Redis string upload record (shape X2), stored exactly as given. */
async function setStringRecord(key: string, value: string) {
  await redis.execute((client: any) => client.set(key, value))
}

async function readStringRecord(key: string) {
  return redis.execute(async (client: any) => [String(await client.type(key)), await client.get(key)])
}

describe('a file-backed Redis string upload record is reported, never left out silently (BL-1380)', () => {
  it('stops the export and lists the record as unsupported, even though its file is there, and changes nothing', async () => {
    const filePath = await writeFileAt(uploadRoot, 'avatars/string_avatar.png', 'string-avatar')
    const stored = JSON.stringify({
      originalName: 'string_avatar.png',
      filename: 'string_avatar.png',
      mimetype: 'image/png',
      size: 13,
      uploadType: 'avatars',
      storage: 'filesystem',
      relativePath: 'avatars/string_avatar.png',
      filePath
    })
    await setStringRecord('upload:avatars:string_avatar.png', stored)
    // A filePath-only string record is named by the same path rule as an object record (BL-1379).
    const filePathOnly = await writeFileAt(uploadRoot, 'images/old.png', 'old')
    await setStringRecord('upload:images:x:old.png', JSON.stringify({ storage: 'filesystem', filePath: filePathOnly }))

    const failure = await exportError()
    expect(failure).toBeInstanceOf(BackupRestoreError)
    expect(failure?.status).toBe(409)
    // No file was looked for, so the sentence claims no found-of-total count.
    expect(failure?.message).toContain(
      'Backup stopped: 2 uploaded files cannot be backed up (2 unsupported records): ' +
        'avatars/string_avatar.png (unsupported record), images/old.png (unsupported record).'
    )
    expect(failure?.details).toMatchObject({
      code: 'BACKUP_UPLOAD_FILES_UNAVAILABLE',
      counts: { missing: 0, unreadable: 0, notAFile: 0, unsupportedRecord: 2 }
    })

    const check = await auditBackupUploadFiles(USER)
    expect(check).toMatchObject({
      fileBackedCount: 0,
      foundCount: 0,
      problemCount: 2,
      counts: { missing: 0, unreadable: 0, notAFile: 0, unsupportedRecord: 2 },
      exportBlockedMessage: failure?.message
    })
    expect(check.problems.map((problem) => [problem.key, problem.relativePath, problem.kind])).toEqual([
      ['upload:avatars:string_avatar.png', 'avatars/string_avatar.png', 'unsupported-record'],
      ['upload:images:x:old.png', 'images/old.png', 'unsupported-record']
    ])
    expect(check.problems[0].owner.kind).toBe('avatar')

    // No conversion: both records are still the same Redis strings, and both files are untouched.
    expect(await readStringRecord('upload:avatars:string_avatar.png')).toEqual(['string', stored])
    expect((await readStringRecord('upload:images:x:old.png'))[0]).toBe('string')
    expect(await fs.readFile(filePath, 'utf8')).toBe('string-avatar')
  })

  it('reports it without needing the upload folder, so no folder problem hides it', async () => {
    vi.stubEnv('UPLOADS_DIR', path.join(uploadRoot, 'no-such-folder'))
    await setStringRecord('upload:images:gone.png', JSON.stringify({ storage: 'filesystem', relativePath: 'images/gone.png' }))

    const failure = await exportError()
    expect(failure?.status).toBe(409)
    expect(failure?.details).toMatchObject({ counts: { unsupportedRecord: 1 } })
    expect((await auditBackupUploadFiles(USER)).rootProblem).toBeNull()
  })

  // The server serves a named file before any Base64 copy (serveFileBackedUpload), so a copy
  // inside the string does not make its file travel (review SHOULD-1).
  it('reports a string record that names a file even when it also holds a Base64 copy', async () => {
    await writeFileAt(uploadRoot, 'images/both.png', 'on-disk')
    await setStringRecord('upload:images:both.png', JSON.stringify({
      filename: 'both.png',
      uploadType: 'images',
      relativePath: 'images/both.png',
      base64: Buffer.from('in-record').toString('base64')
    }))

    const failure = await exportError()
    expect(failure?.status).toBe(409)
    expect(failure?.details).toMatchObject({ counts: { unsupportedRecord: 1 } })
    expect((await auditBackupUploadFiles(USER)).problems.map((problem) => [problem.relativePath, problem.kind]))
      .toEqual([['images/both.png', 'unsupported-record']])
  })

  it('keeps carrying a string record that names no file, its content inside it, exactly as stored', async () => {
    const withContent = JSON.stringify({
      filename: 'inline.png',
      uploadType: 'images',
      base64: Buffer.from('inline-bytes').toString('base64')
    })
    await setStringRecord('upload:images:inline.png', withContent)
    await setStringRecord('upload:images:note.txt', 'not json at all')
    await setStringRecord('upload:images:meta.json', JSON.stringify({ filename: 'meta.json', note: 'no path' }))

    expect(await auditBackupUploadFiles(USER)).toMatchObject({ problemCount: 0, exportBlockedMessage: null })
    const { records, uploadFiles } = archiveOf((await createBackupBundle(USER)).bytes)
    expect(uploadFiles).toEqual({})
    const byKey = Object.fromEntries(records.map((record) => [record.key, record]))
    expect(byKey['upload:images:inline.png']).toMatchObject({ type: 'string', value: withContent })
    expect(byKey['upload:images:note.txt']).toMatchObject({ type: 'string', value: 'not json at all' })
    expect(byKey['upload:images:meta.json'].type).toBe('string')
  })
})
