import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { unzipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The default file lane adapts only the Redis snapshot reply. It exercises
// actual collection/classification/archive code, not atomic Lua execution.
vi.mock('../backupHairSnapshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backupHairSnapshot')>()
  return { ...original, readHairBackupSnapshot: async (client: any) => {
    if (process.env.VITEST_USE_REAL_REDIS === 'true') return original.readHairBackupSnapshot(client)
    const { fakeHairSnapshotAnswer } = await import('./fixtures/hairSnapshotFake')
    return original.readHairBackupSnapshot({ eval: () => fakeHairSnapshotAnswer(client) })
  } }
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  BackupRestoreError,
  auditBackupUploadFiles,
  createBackupBundle,
  createBackupBundleStream
} from '../backupRestoreService'
import { uploadRecordFingerprint } from '../backupUploadInspection'
import { describeUploadOwners } from '../backupUploadOwners'

// BL-378: the export names every problem upload in one error, and the read-only Admin check
// lists the same problems with their current owners. Neither writes anything.

useRedisTestServer()

const USER = 'user-1'
let uploadRoot: string
let previousUploadsDir: string | undefined

async function seedUpload(uploadType: string, filename: string, extra: Record<string, unknown> = {}) {
  const relativePath = `${uploadType}/${filename}`
  const value = {
    filename,
    originalName: filename,
    mimetype: 'application/octet-stream',
    size: 3,
    uploadType,
    uploadedAt: '2026-10-11T00:00:00.000Z',
    storage: 'filesystem',
    relativePath,
    filePath: path.join(uploadRoot, relativePath),
    ...extra
  }
  const key = `upload:${uploadType}:${filename}`
  await redis.json.set(key, '$', value)
  return { key, value, relativePath }
}

async function writeUploadFile(relativePath: string) {
  await fs.mkdir(path.dirname(path.join(uploadRoot, relativePath)), { recursive: true })
  await fs.writeFile(path.join(uploadRoot, relativePath), 'abc')
}

/** Every Redis key with its type and value, for zero-write checks. */
async function snapshotRedis() {
  return redis.execute(async (client: any) => {
    const keys = (await client.keys('*')).sort()
    const out: Array<[string, string, string]> = []
    for (const key of keys) {
      const type = String(await client.type(key))
      const value =
        type === 'set' ? (await client.sMembers(key)).sort()
          : type === 'string' ? await client.get(key)
            : await client.json.get(key)
      out.push([key, type, JSON.stringify(value)])
    }
    return out
  })
}

async function snapshotTree(dir: string) {
  const out: string[] = []
  async function walk(current: string) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const stat = await fs.lstat(full)
      out.push(`${path.relative(dir, full)} ${stat.size} ${stat.mtimeMs}`)
      if (entry.isDirectory()) await walk(full)
    }
  }
  await walk(dir)
  return out
}

/** One problem of each owner family, plus one present file. */
async function seedMixedProblems() {
  const present = await seedUpload('images', '1700_present.png')
  await writeUploadFile(present.relativePath)

  const clip = await seedUpload('images', '1700_cat.png')
  await redis.json.set(`clip:${USER}:clip_1`, '$', {
    id: 'clip_1',
    filename: 'cat.png',
    storageMode: 'local',
    localUrl: '/uploads/images/1700_cat.png',
    tunnelPath: '/uploads/images/1700_cat.png'
  })

  await redis.json.set('agent:agent_a', '$', {
    id: 'agent_a',
    name: 'Ada',
    avatar: '/uploads/avatars/agent_agent_a_1700000000000.jpg'
  })
  const memoryImage = await seedUpload('memory-media', 'agent_a/mem_b/media_c.png')
  await redis.json.set('memory:agent_a:mem_b', '$', {
    id: 'mem_b',
    agent_id: 'agent_a',
    lane: 'awareness',
    media_mode: 'always',
    is_superseded: 'n',
    media: [{ id: 'media_c', filename: 'agent_a/mem_b/media_c.png' }]
  })

  const avatar = await seedUpload('avatars', 'agent_agent_a_1700000000000.jpg')
  await redis.del(avatar.key)
  const avatarKey = 'upload:avatars:agent:agent_agent_a_1700000000000.jpg'
  await redis.json.set(avatarKey, '$', { ...avatar.value, entityType: 'agent', entityId: 'agent_a' })

  const scene = await seedUpload('goon_scenes', 'sky.jpg')

  const goonVrm = await seedUpload('goons', 'bat.vrm')
  await redis.sAdd(`user:${USER}:goons`, 'g1')
  await redis.json.set('goon:g1', '$', {
    id: 'g1',
    user_id: USER,
    name: 'Bat',
    files: { vrm: { filename: 'bat.vrm', url: '/uploads/goons/bat.vrm' } }
  })

  const unknown = await seedUpload('mystery', 'thing.bin')

  return { clip, memoryImage, avatarKey, scene, goonVrm, unknown }
}

beforeEach(async () => {
  previousUploadsDir = process.env.UPLOADS_DIR
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bl378-audit-'))
  process.env.UPLOADS_DIR = uploadRoot
  // The check and the error are local reads: any network call is a bug.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('BL-378 upload check must not call the network')
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR
  else process.env.UPLOADS_DIR = previousUploadsDir
  await fs.chmod(path.join(uploadRoot, 'images'), 0o755).catch(() => undefined)
  await fs.rm(uploadRoot, { recursive: true, force: true })
})

describe('export upload problems (BL-378)', () => {
  it('keeps actual Clip-borrowed raw Hair bytes in Check Upload Files and both export paths', async () => {
    const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    const filename = `1700000000000_00000000-0000-4000-8000-000000000001_${sha256}.obj`
    const upload = await seedUpload('goon_hair_imports', filename, { sha256,
      hairImportSource: { sha256, stagedAt: '2026-10-12T00:00:00.000Z' } })
    await writeUploadFile(upload.relativePath)
    await redis.sAdd(`user:${USER}:clips`, 'borrower')
    await redis.json.set(`clip:${USER}:borrower`, '$', { id: 'borrower',
      thumbnailUrl: `/uploads/%67oon_hair_imports/${filename}`, content: 'no ownership in prose' })
    const before = await snapshotRedis()
    expect(await auditBackupUploadFiles(USER)).toMatchObject({ fileBackedCount: 1, foundCount: 1, problemCount: 0 })
    const archive = await createBackupBundle(USER)
    expect(Buffer.from(unzipSync(archive.bytes)[`files/uploads/${upload.relativePath}`]).toString()).toBe('abc')
    const streamed = await createBackupBundleStream(USER)
    const chunks: Uint8Array[] = []
    const reader = streamed.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    expect(Buffer.from(unzipSync(Buffer.concat(chunks))[`files/uploads/${upload.relativePath}`]).toString()).toBe('abc')
    expect(await snapshotRedis()).toEqual(before)
    // Removing the positive borrower restores the existing raw-staging omission.
    await redis.del(`clip:${USER}:borrower`)
    expect(await auditBackupUploadFiles(USER)).toMatchObject({ fileBackedCount: 0, problemCount: 0 })
  })

  it('stops with one 409 that names every missing upload, before any byte streams', async () => {
    const seeded = await seedMixedProblems()

    const error = await createBackupBundle(USER).then(
      () => null,
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(BackupRestoreError)
    const failure = error as BackupRestoreError
    expect(failure.status).toBe(409)
    // The sentence names the first five in record order and counts the rest; details list all.
    expect(failure.message).toContain('6 uploaded files cannot be backed up (6 missing; 1 of 7 found in')
    expect(failure.message).toContain(', and 1 more.')
    const listed = (failure.details as { problems: Array<{ key: string; relativePath: string }> }).problems
    // Record order: the export's keys, sorted as collectCandidateKeys sorts them.
    expect(listed.map((problem) => problem.key)).toEqual(
      [
        seeded.clip.key,
        seeded.memoryImage.key,
        seeded.avatarKey,
        seeded.scene.key,
        seeded.goonVrm.key,
        seeded.unknown.key
      ].sort((left, right) => left.localeCompare(right))
    )
    for (const problem of listed.slice(0, 5)) expect(failure.message).toContain(problem.relativePath)
    expect(failure.message).not.toContain(listed[5].relativePath)
    expect(failure.details).toMatchObject({
      code: 'BACKUP_UPLOAD_FILES_UNAVAILABLE',
      uploadRoot,
      fileBackedCount: 7,
      foundCount: 1,
      problemCount: 6,
      counts: { missing: 6, unreadable: 0, notAFile: 0 },
      truncated: false
    })

    await expect(createBackupBundleStream(USER)).rejects.toMatchObject({ status: 409, message: failure.message })
  })

  it.skipIf(process.getuid?.() === 0)('answers 500 for an unreadable upload and never calls it missing (BL-1373)', async () => {
    const held = await seedUpload('images', '1700_held.png')
    await writeUploadFile(held.relativePath)
    await fs.chmod(path.join(uploadRoot, 'images'), 0o000)

    await expect(createBackupBundle(USER)).rejects.toMatchObject({
      status: 500,
      details: { counts: { missing: 0, unreadable: 1, notAFile: 0 } }
    })
    const audit = await auditBackupUploadFiles(USER)
    expect(audit.problems).toMatchObject([{ key: held.key, kind: 'unreadable', code: 'EACCES' }])
    expect(audit.exportBlockedMessage).not.toContain('missing')
  })

  it('backs up an instance with no file-backed uploads without an uploads folder', async () => {
    const absent = path.join(uploadRoot, 'never-created')
    process.env.UPLOADS_DIR = absent
    await redis.json.set(`user:${USER}:settings`, '$', { id: `settings_${USER}`, user_id: USER })

    const bundle = await createBackupBundle(USER)

    expect(bundle.manifest.contents.fileAssetCount).toBe(0)
    await expect(fs.stat(absent)).rejects.toMatchObject({ code: 'ENOENT' })
    const audit = await auditBackupUploadFiles(USER)
    expect(audit).toMatchObject({ fileBackedCount: 0, problemCount: 0, rootProblem: null, exportBlockedMessage: null })
  })

  it('stops with a 500 naming the folder when file-backed uploads exist but the folder is gone', async () => {
    await seedUpload('images', '1700_cat.png')
    const absent = path.join(uploadRoot, 'moved-away')
    process.env.UPLOADS_DIR = absent

    await expect(createBackupBundle(USER)).rejects.toMatchObject({
      status: 500,
      details: { code: 'BACKUP_UPLOAD_ROOT_UNAVAILABLE', rootProblem: { kind: 'root-missing' } }
    })
    const audit = await auditBackupUploadFiles(USER)
    expect(audit.rootProblem).toEqual({ kind: 'root-missing', code: 'ENOENT' })
    expect(audit.problems).toEqual([])
  })

  it('keeps the legacy Base64 copy as the fallback for an upload with no file', async () => {
    await redis.json.set('upload:images:legacy.png', '$', {
      filename: 'legacy.png',
      uploadType: 'images',
      mimetype: 'image/png',
      base64: Buffer.from('abc').toString('base64')
    })

    const bundle = await createBackupBundle(USER)

    const entries = unzipSync(bundle.bytes)
    expect(Buffer.from(entries['files/uploads/images/legacy.png']).toString()).toBe('abc')
    const audit = await auditBackupUploadFiles(USER)
    expect(audit).toMatchObject({ problemCount: 0, legacyCopyCount: 1, uploadFolderFoundNothing: false })
  })

  // BL-1388: a wrong folder on an instance that also has one legacy copy still gets the hint,
  // in the export's sentence and in the check's answer the card shows it from.
  it('says the folder had none of the files even beside a legacy copy, in the export and the check alike', async () => {
    await redis.json.set('upload:images:legacy.png', '$', {
      filename: 'legacy.png',
      uploadType: 'images',
      mimetype: 'image/png',
      base64: Buffer.from('abc').toString('base64')
    })
    await seedUpload('images', '1700_gone.png')

    const audit = await auditBackupUploadFiles(USER)
    expect(audit).toMatchObject({ foundCount: 0, legacyCopyCount: 1, problemCount: 1, uploadFolderFoundNothing: true })
    expect(audit.exportBlockedMessage).toContain(
      ' None of the files were found (1 older upload is saved inside its record and does not need the folder): ' +
        'if the upload folder moved, or a drive or Docker volume is not connected, fix that first.'
    )
    await expect(createBackupBundle(USER)).rejects.toMatchObject({ status: 409, message: audit.exportBlockedMessage })

    // Once one file is found, the folder is not the problem.
    const present = await seedUpload('images', '1700_present.png')
    await writeUploadFile(present.relativePath)
    const after = await auditBackupUploadFiles(USER)
    expect(after).toMatchObject({ foundCount: 1, uploadFolderFoundNothing: false })
    expect(after.exportBlockedMessage).not.toContain('None of the files were found')
  })
})

describe('Admin upload check (BL-378)', () => {
  it('lists the export’s problems with current owners and writes nothing', async () => {
    const seeded = await seedMixedProblems()
    const redisBefore = await snapshotRedis()
    const treeBefore = await snapshotTree(uploadRoot)

    const exportError = (await createBackupBundle(USER).catch((caught: unknown) => caught)) as BackupRestoreError
    const audit = await auditBackupUploadFiles(USER)

    expect(await snapshotRedis()).toEqual(redisBefore)
    expect(await snapshotTree(uploadRoot)).toEqual(treeBefore)
    expect(fetch).not.toHaveBeenCalled()

    expect(audit.exportBlockedMessage).toBe(exportError.message)
    expect(audit).toMatchObject({ fileBackedCount: 7, foundCount: 1, problemCount: 6, problemFileCount: 6, truncated: false })

    const byKey = new Map(audit.problems.map((problem) => [problem.key, problem]))
    expect(byKey.get(seeded.clip.key)?.owner).toMatchObject({ kind: 'clip', state: 'found', label: 'Clip "cat.png".', urgent: false })
    expect(byKey.get(seeded.memoryImage.key)?.owner).toMatchObject({
      kind: 'memory-media',
      state: 'found',
      urgent: true,
      label: 'Image of memory mem_b of Ada.'
    })
    expect(byKey.get(seeded.memoryImage.key)?.owner.repair).toContain('standing Awareness image')
    expect(byKey.get(seeded.avatarKey)?.owner).toMatchObject({ kind: 'avatar', state: 'found', label: 'Picture of Ada.' })
    expect(byKey.get(seeded.scene.key)?.owner).toMatchObject({ kind: 'goon-scene', state: 'not-found' })
    expect(byKey.get(seeded.scene.key)?.owner.repair).toContain('BL-1025')
    expect(byKey.get(seeded.goonVrm.key)?.owner).toMatchObject({ kind: 'goon', state: 'found' })
    expect(byKey.get(seeded.goonVrm.key)?.owner.label).toContain('Goon Bat current VRM')
    expect(byKey.get(seeded.unknown.key)?.owner).toMatchObject({ kind: 'unknown', state: 'not-found' })

    expect(byKey.get(seeded.clip.key)?.fingerprint).toBe(uploadRecordFingerprint(seeded.clip.key, seeded.clip.value))
  })

  it('finds your profile picture after a restore renamed your user id but not the file', async () => {
    const key ='upload:avatars:user:user_source-user_1700000000000.jpg'
    await redis.json.set(key, '$', {
      filename: 'user_source-user_1700000000000.jpg',
      uploadType: 'avatars',
      storage: 'filesystem',
      relativePath: 'avatars/user_source-user_1700000000000.jpg',
      size: 3
    })
    await redis.json.set(`user:${USER}:settings`, '$', {
      user_id: USER,
      avatar: '/uploads/avatars/user_source-user_1700000000000.jpg'
    })

    const audit = await auditBackupUploadFiles(USER)

    expect(audit.problems.find((problem) => problem.key === key)?.owner).toMatchObject({
      kind: 'avatar',
      state: 'found',
      label: 'Your profile picture.'
    })
  })

  it('marks a failed owner lookup as failed, never as not found, and still lists the rest', async () => {
    const clip = await seedUpload('images', '1700_cat.png')
    // A stray % in one Clip URL makes the Clip family lookup throw (decodeURIComponent).
    await redis.json.set(`clip:${USER}:clip_bad`, '$', { id: 'clip_bad', localUrl: '/uploads/images/bad%E0%A4%A.png' })
    const memoryImage = await seedUpload('memory-media', 'agent_a/mem_b/media_c.png')
    await redis.json.set('memory:agent_a:mem_b', '$', {
      id: 'mem_b',
      lane: 'fact',
      media: [{ id: 'media_c', filename: 'agent_a/mem_b/media_c.png' }]
    })

    const audit = await auditBackupUploadFiles(USER)
    const owners = Object.fromEntries(audit.problems.map((problem) => [problem.key, problem.owner]))

    expect(owners[clip.key]).toMatchObject({ kind: 'clip', state: 'lookup-failed' })
    expect(owners[clip.key].label).toContain('URI malformed')
    expect(owners[memoryImage.key]).toMatchObject({ kind: 'memory-media', state: 'found', urgent: false })
  })

  it('turns a failed read into lookup-failed rows but lets a coding error surface', async () => {
    const failingRead = (error: Error) => ({
      type: async () => { throw error },
      get: async () => null,
      keys: async () => [],
      sMembers: async () => [],
      json: { get: async () => null }
    })
    const keys = ['upload:memory-media:agent_a/mem_b/media_c.png']

    const owners = await describeUploadOwners(failingRead(new Error('Socket closed unexpectedly')), USER, keys)
    expect(owners.get(keys[0])).toMatchObject({ kind: 'memory-media', state: 'lookup-failed' })
    expect(owners.get(keys[0])?.label).toContain('Socket closed unexpectedly')

    await expect(describeUploadOwners(failingRead(new TypeError('x is not a function')), USER, keys)).rejects.toThrow(TypeError)
  })

  it('never claims an owner it cannot see now', async () => {
    const orphanClip = await seedUpload('images', '1700_orphan.png')
    const orphanMemory = await seedUpload('memory-media', 'agent_z/mem_y/media_x.png')
    const orphanAvatar = await seedUpload('avatars', 'agent_agent_gone_1700000000000.jpg')
    await redis.del(orphanAvatar.key)
    await redis.json.set('upload:avatars:agent:agent_agent_gone_1700000000000.jpg', '$', orphanAvatar.value)

    const audit = await auditBackupUploadFiles(USER)
    const owners = Object.fromEntries(audit.problems.map((problem) => [problem.key, problem.owner]))

    expect(owners[orphanClip.key]).toMatchObject({ kind: 'clip', state: 'not-found' })
    expect(owners[orphanClip.key].label).toContain('does not prove the file is unused')
    expect(owners[orphanMemory.key]).toMatchObject({ kind: 'memory-media', state: 'not-found', urgent: false })
    expect(owners['upload:avatars:agent:agent_agent_gone_1700000000000.jpg']).toMatchObject({ kind: 'avatar', state: 'not-found' })
    for (const owner of Object.values(owners)) {
      expect(owner.repair).not.toMatch(/delete (this|the) record/i)
    }
  })
})
