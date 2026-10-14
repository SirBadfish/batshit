// @vitest-environment node
/**
 * BL-378 Phase 1b §2a: ONE table decides every refusal of a partial backup, through the REAL
 * Admin export route. Reasons that apply together are all named in one answer, whose status is
 * the first matching row: 1a body over 2 MiB 413 (read through a byte cap before parsing); 1 a
 * malformed `partial` option 400; 2 the upload root 500 (its own error); 3 an unreadable file 500;
 * 4 not a file, an unsupported record, or a list over 10,000 records 409; 5 a stale
 * acknowledgement (new missing record, new alias, changed fingerprint) 409; 6 everything missing
 * without the second confirmation 409; 7 a manifest a restore could not read 400. A refusal never
 * becomes a partial archive and never carries the summary header.
 *
 * Owned state only: a temporary upload folder, the default-lane Redis fake and synthetic records.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Review SMALL 1: a file that appears between two aliases' checks of one path. Only `stat` of a
 * path named here answers ENOENT once; every other call is the real one.
 */
const statRace = vi.hoisted(() => ({ enoentOnceFor: new Set<string>() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const stat = (async (target: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
    if (statRace.enoentOnceFor.delete(String(target))) {
      throw Object.assign(new Error(`ENOENT: injected by the test, stat '${String(target)}'`), { code: 'ENOENT' })
    }
    return (actual.stat as (...args: unknown[]) => ReturnType<typeof actual.stat>)(target, ...rest)
  }) as typeof actual.stat
  return { ...actual, default: { ...actual, stat }, stat }
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { auditBackupUploadFiles } from '$lib/server/services/backupRestoreService'
import { UPLOAD_PROBLEM_LIST_LIMIT, uploadRecordFingerprint } from '$lib/server/services/backupUploadInspection'
import {
  BACKUP_EXPORT_REQUEST_MAX_BYTES,
  BACKUP_PARTIAL_ENTRY_LIMIT,
  BACKUP_PARTIAL_STRING_MAX,
  parseMissingUploadsSummary
} from '$lib/utils/backupPartialSummary'
import { POST as EXPORT } from '../../../../routes/api/admin/backup/export/+server'

useRedisTestServer()

const USER = 'phase1b_refusals'
const FINGERPRINT = 'f'.repeat(64)
let uploadRoot = ''
const lockedDirs: string[] = []

beforeEach(async () => {
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-partial-refusals-'))
  vi.stubEnv('UPLOADS_DIR', uploadRoot)
  vi.stubEnv('BATSHIT_CONTAINERIZED', '')
  vi.stubEnv('BATSHIT_RUNTIME_ENV', '')
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('the export must not call the network')
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  statRace.enoentOnceFor.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of lockedDirs.splice(0)) await fs.chmod(dir, 0o700).catch(() => undefined)
  await fs.rm(uploadRoot, { recursive: true, force: true })
})

async function seedUpload(key: string, relativePath: string, file?: string) {
  await redis.json.set(key, '$', {
    filename: path.basename(relativePath),
    size: 3,
    storage: 'filesystem',
    relativePath,
    filePath: path.join(uploadRoot, relativePath)
  })
  if (file !== undefined) {
    await fs.mkdir(path.dirname(path.join(uploadRoot, relativePath)), { recursive: true })
    await fs.writeFile(path.join(uploadRoot, relativePath), file)
  }
}

/** Many missing records at once, through one client (the fake lane is fast this way). */
async function seedManyMissing(count: number, name: (index: number) => string) {
  await redis.execute(async (client: any) => {
    for (let index = 0; index < count; index += 1) {
      const relativePath = `images/${name(index)}`
      await client.json.set(`upload:images:${name(index)}`, '$', { size: 3, storage: 'filesystem', relativePath })
    }
  })
}

async function acknowledgeCheck() {
  const check = await auditBackupUploadFiles(USER)
  return check.problems.map(({ key, relativePath, fingerprint }) => ({ key, relativePath, fingerprint }))
}

async function post(init: RequestInit) {
  const response = (await EXPORT({
    locals: { user: { id: USER, is_admin: true } },
    request: new Request('http://localhost/api/admin/backup/export', { method: 'POST', ...init })
  } as any)) as Response
  const isZip = response.headers.get('Content-Type') === 'application/zip'
  return {
    status: response.status,
    isZip,
    body: isZip ? null : await response.json(),
    summary: response.headers.get('X-Batshit-Backup-Missing-Uploads'),
    response
  }
}

async function postJson(body: unknown) {
  return post({ body: JSON.stringify(body) })
}

/** A refusal: a JSON answer, never an archive, never a summary. */
function expectRefused(answer: Awaited<ReturnType<typeof post>>, status: number) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  expect(answer.isZip).toBe(false)
  expect(answer.summary).toBeNull()
}

describe('row 1a: the body is read through a 2 MiB byte cap before it is parsed (413)', () => {
  it('refuses a body over the cap, declared or chunked, and reads no further', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    // Valid JSON once parsed (trailing spaces), so only the byte count can refuse it.
    const over = `{"includeSecrets":false}${' '.repeat(BACKUP_EXPORT_REQUEST_MAX_BYTES)}`
    const raw = await post({ body: over })
    expectRefused(raw, 413)
    expect(raw.body).toEqual({ error: 'That backup request is too large.', details: { limitBytes: BACKUP_EXPORT_REQUEST_MAX_BYTES } })

    // A declared length over the cap is refused before a byte is read.
    const declared = await post({ body: '{}', headers: { 'Content-Length': String(BACKUP_EXPORT_REQUEST_MAX_BYTES + 1) } })
    expectRefused(declared, 413)

    // Chunked: no Content-Length, so only the streamed count can refuse it.
    let pulled = 0
    let cancelled = false
    const chunk = new Uint8Array(256 * 1024).fill(0x20)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 64) controller.close()
        else controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      }
    })
    const chunked = await post({ body: stream, duplex: 'half' } as RequestInit)
    expectRefused(chunked, 413)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(64)
  })

  it('a body of exactly 2 MiB is read and parsed as before', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    const head = '{"includeSecrets":false}'
    const exact = `${head}${' '.repeat(BACKUP_EXPORT_REQUEST_MAX_BYTES - head.length)}`
    expect(Buffer.byteLength(exact)).toBe(BACKUP_EXPORT_REQUEST_MAX_BYTES)
    const answer = await post({ body: exact })
    expect(answer.status).toBe(200)
    await answer.response.body?.cancel()
  })

  it('comes before every later row: an oversized body with a missing upload folder is 413, not 500', async () => {
    vi.stubEnv('UPLOADS_DIR', path.join(uploadRoot, 'no-such-folder'))
    await seedUpload('upload:images:gone.png', 'images/gone.png')
    expectRefused(await post({ body: `{}${' '.repeat(BACKUP_EXPORT_REQUEST_MAX_BYTES)}` }), 413)
  })
})

describe('row 1: a malformed partial option is 400, before anything is read', () => {
  const entry = { key: 'upload:images:a.png', relativePath: 'images/a.png', fingerprint: FINGERPRINT }
  const cases: Array<[label: string, partial: unknown, reason: string]> = [
    ['null', null, 'partial must be an object'],
    ['an array', [entry], 'partial must be an object'],
    ['an unknown field', { acknowledged: [entry], skip: true }, 'unknown field "skip"'],
    ['confirmAllMissing false', { acknowledged: [entry], confirmAllMissing: false }, 'confirmAllMissing may only be true'],
    ['confirmAllMissing "yes"', { acknowledged: [entry], confirmAllMissing: 'yes' }, 'confirmAllMissing may only be true'],
    ['no acknowledged list', {}, `acknowledged must list 1 to ${BACKUP_PARTIAL_ENTRY_LIMIT} upload records`],
    ['an empty list', { acknowledged: [] }, `acknowledged must list 1 to ${BACKUP_PARTIAL_ENTRY_LIMIT} upload records`],
    ['an entry that is text', { acknowledged: ['upload:images:a.png'] }, 'entry 1 must be an object'],
    ['an extra field', { acknowledged: [{ ...entry, kind: 'missing' }] }, 'entry 1 must have exactly key, relativePath and fingerprint'],
    ['a missing field', { acknowledged: [{ key: entry.key, relativePath: entry.relativePath }] }, 'entry 1 must have exactly key, relativePath and fingerprint'],
    ['a key of the wrong type', { acknowledged: [{ ...entry, key: 7 }] }, `entry 1's key must be an upload record key of at most ${BACKUP_PARTIAL_STRING_MAX} characters`],
    ['a key that is not an upload key', { acknowledged: [{ ...entry, key: 'user:x:settings' }] }, `entry 1's key must be an upload record key of at most ${BACKUP_PARTIAL_STRING_MAX} characters`],
    ['a bare upload prefix', { acknowledged: [{ ...entry, key: 'upload:' }] }, `entry 1's key must be an upload record key of at most ${BACKUP_PARTIAL_STRING_MAX} characters`],
    ['an empty path', { acknowledged: [{ ...entry, relativePath: '' }] }, `entry 1's relativePath must be 1 to ${BACKUP_PARTIAL_STRING_MAX} characters`],
    ['a path that climbs out', { acknowledged: [{ ...entry, relativePath: '../a.png' }] }, "entry 1's relativePath is not a safe upload path"],
    ['an absolute path', { acknowledged: [{ ...entry, relativePath: '/etc/passwd' }] }, "entry 1's relativePath is not a safe upload path"],
    ['an empty path part', { acknowledged: [{ ...entry, relativePath: 'images//a.png' }] }, "entry 1's relativePath is not a safe upload path"],
    ['a backslash path', { acknowledged: [{ ...entry, relativePath: 'images\\a.png' }] }, "entry 1's relativePath is not a safe upload path"],
    ['an uppercase fingerprint', { acknowledged: [{ ...entry, fingerprint: 'F'.repeat(64) }] }, "entry 1's fingerprint must be 64 lowercase hexadecimal characters"],
    ['a short fingerprint', { acknowledged: [{ ...entry, fingerprint: 'f'.repeat(63) }] }, "entry 1's fingerprint must be 64 lowercase hexadecimal characters"],
    ['a key with a NUL', { acknowledged: [{ ...entry, key: 'upload:images:a\0.png' }] }, "entry 1's key or path contains a NUL character"],
    ['a path with a NUL', { acknowledged: [{ ...entry, relativePath: 'images/a\0.png' }] }, "entry 1's key or path contains a NUL character"],
    ['a duplicate key', { acknowledged: [entry, { ...entry, relativePath: 'images/b.png' }] }, 'upload record upload:images:a.png is listed twice']
  ]

  it('names what is wrong, for every malformed shape, even when the upload folder is missing too', async () => {
    vi.stubEnv('UPLOADS_DIR', path.join(uploadRoot, 'no-such-folder'))
    await seedUpload('upload:images:a.png', 'images/a.png')
    const answers: string[] = []
    for (const [label, partial] of cases) {
      const answer = await postJson({ partial })
      answers.push(`${label} -> ${answer.status} ${answer.body?.error}`)
      expect(answer.summary).toBeNull()
    }
    expect(answers).toEqual(cases.map(([label, , reason]) => `${label} -> 400 The partial backup request is not valid: ${reason}.`))
  })

  it('measures keys and paths in UTF-16 code units up to 4,096, and lists up to 10,000 entries', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    // Each accepted entry names a record that does not exist, so it ends "gone": a complete backup.
    const cjk = `images/${'漢'.repeat(BACKUP_PARTIAL_STRING_MAX - 'images/'.length)}`
    const astral = `images/${'😀'.repeat((BACKUP_PARTIAL_STRING_MAX - 'images/'.length - 1) / 2)}x`
    const longKey = `upload:${'k'.repeat(BACKUP_PARTIAL_STRING_MAX - 'upload:'.length)}`
    expect([cjk.length, astral.length, longKey.length]).toEqual([4096, 4096, 4096])
    expect(Buffer.byteLength(cjk)).toBe(7 + 3 * 4089)
    const accepted = await postJson({
      partial: {
        acknowledged: [
          { key: 'upload:images:cjk', relativePath: cjk, fingerprint: FINGERPRINT },
          { key: 'upload:images:astral', relativePath: astral, fingerprint: FINGERPRINT },
          { key: longKey, relativePath: 'images/long.png', fingerprint: FINGERPRINT }
        ]
      }
    })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(parseMissingUploadsSummary(accepted.summary)).toMatchObject({ completeness: 'complete', goneRecords: 3 })
    await accepted.response.body?.cancel()

    for (const [label, change] of [
      ['path', { relativePath: `${cjk}漢` }],
      ['astral path', { relativePath: `${astral.slice(0, -1)}😀` }],
      ['key', { key: `${longKey}k` }]
    ] as const) {
      const answer = await postJson({ partial: { acknowledged: [{ key: 'upload:images:x', relativePath: 'images/x', fingerprint: FINGERPRINT, ...change }] } })
      expect(answer.status, label).toBe(400)
    }

    const many = Array.from({ length: BACKUP_PARTIAL_ENTRY_LIMIT }, (_, index) => ({
      key: `upload:images:g${index}`,
      relativePath: `images/g${index}`,
      fingerprint: FINGERPRINT
    }))
    const atLimit = await postJson({ partial: { acknowledged: many } })
    expect(atLimit.status).toBe(200)
    expect(parseMissingUploadsSummary(atLimit.summary)).toMatchObject({ goneRecords: BACKUP_PARTIAL_ENTRY_LIMIT })
    await atLimit.response.body?.cancel()
    const overLimit = await postJson({
      partial: { acknowledged: [...many, { key: 'upload:images:one-more', relativePath: 'images/one-more', fingerprint: FINGERPRINT }] }
    })
    expect(overLimit.status).toBe(400)
  }, 60_000)
})

describe('rows 2 to 6: one refusal names every reason; its status is the first matching row', () => {
  it('row 2: a missing or non-folder upload root keeps its own 500, whatever the acknowledgement says', async () => {
    await seedUpload('upload:images:gone.png', 'images/gone.png')
    const acknowledged = await acknowledgeCheck()
    await seedUpload('upload:images:new.png', 'images/new.png')

    vi.stubEnv('UPLOADS_DIR', path.join(uploadRoot, 'no-such-folder'))
    const missingRoot = await postJson({ partial: { acknowledged } })
    expectRefused(missingRoot, 500)
    expect(missingRoot.body.details).toMatchObject({ code: 'BACKUP_UPLOAD_ROOT_UNAVAILABLE', rootProblem: { kind: 'root-missing' } })

    const notAFolder = path.join(uploadRoot, 'a-file')
    await fs.writeFile(notAFolder, 'x')
    vi.stubEnv('UPLOADS_DIR', notAFolder)
    const fileRoot = await postJson({ partial: { acknowledged } })
    expectRefused(fileRoot, 500)
    expect(fileRoot.body.details).toMatchObject({ code: 'BACKUP_UPLOAD_ROOT_UNAVAILABLE', rootProblem: { kind: 'root-not-directory' } })
  })

  it.skipIf(process.getuid?.() === 0)('row 3 wins: unreadable, not a file and a new missing record together are one 500 naming all three', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    await seedUpload('upload:images:gone.png', 'images/gone.png')
    const acknowledged = await acknowledgeCheck()
    await seedUpload('upload:images:new.png', 'images/new.png')
    await fs.mkdir(path.join(uploadRoot, 'images/folder.png'), { recursive: true })
    await seedUpload('upload:images:folder.png', 'images/folder.png')
    const locked = path.join(uploadRoot, 'locked')
    await fs.mkdir(locked)
    await seedUpload('upload:locked:x.png', 'locked/x.png')
    await fs.chmod(locked, 0o000)
    lockedDirs.push(locked)

    const answer = await postJson({ partial: { acknowledged } })
    expectRefused(answer, 500)
    expect(answer.body.details).toMatchObject({
      code: 'BACKUP_PARTIAL_REFUSED',
      reasons: ['unreadable', 'not-a-file', 'new-missing'],
      unacknowledged: [{ key: 'upload:images:new.png', relativePath: 'images/new.png' }]
    })
    expect(answer.body.error).toBe(
      'Partial backup refused: 1 upload file cannot be read (locked/x.png); 1 upload file is not a file (images/folder.png); ' +
        '1 missing upload record was not in the acknowledged list (images/new.png). Nothing was exported. ' +
        'Run Check Upload Files again and decide from its new list.'
    )
  })

  it('row 4: not a file, or an unsupported record, refuses with 409', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    await seedUpload('upload:images:gone.png', 'images/gone.png')
    const acknowledged = await acknowledgeCheck()

    await fs.mkdir(path.join(uploadRoot, 'images/folder.png'), { recursive: true })
    await seedUpload('upload:images:folder.png', 'images/folder.png')
    const notAFile = await postJson({ partial: { acknowledged } })
    expectRefused(notAFile, 409)
    expect(notAFile.body.details.reasons).toEqual(['not-a-file'])
    await redis.del('upload:images:folder.png')

    await redis.execute((client: any) =>
      client.set('upload:images:string.png', JSON.stringify({ storage: 'filesystem', relativePath: 'images/string.png' }))
    )
    const unsupported = await postJson({ partial: { acknowledged } })
    expectRefused(unsupported, 409)
    expect(unsupported.body.details.reasons).toEqual(['unsupported-record'])
    expect(unsupported.body.error).toContain('1 upload record is stored in a form a backup cannot carry (images/string.png)')
  })

  it('row 4: a problem list over 10,000 records cannot be acknowledged whole (409)', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    await seedManyMissing(UPLOAD_PROBLEM_LIST_LIMIT + 1, (index) => `m${String(index).padStart(5, '0')}.png`)
    const check = await auditBackupUploadFiles(USER)
    expect(check.truncated).toBe(true)
    const acknowledged = check.problems.map(({ key, relativePath, fingerprint }) => ({ key, relativePath, fingerprint }))
    expect(acknowledged).toHaveLength(BACKUP_PARTIAL_ENTRY_LIMIT)

    const answer = await postJson({ partial: { acknowledged } })
    expectRefused(answer, 409)
    expect(answer.body.details.reasons).toEqual(['truncated', 'new-missing'])
  }, 120_000)

  it('row 5: a changed fingerprint or path refuses with 409; nothing is read twice to excuse it', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    await seedUpload('upload:images:edited.png', 'images/edited.png')
    await seedUpload('upload:images:moved.png', 'images/moved.png')
    const acknowledged = await acknowledgeCheck()
    // The record changed after the check: its fingerprint no longer matches the acknowledgement.
    const edited = (await redis.json.get('upload:images:edited.png')) as Record<string, unknown>
    await redis.json.set('upload:images:edited.png', '$', { ...edited, size: 4 })
    const stale = acknowledged.map((entry) => (entry.key === 'upload:images:moved.png' ? { ...entry, relativePath: 'images/elsewhere.png' } : entry))

    const answer = await postJson({ partial: { acknowledged: stale } })
    expectRefused(answer, 409)
    expect(answer.body.details).toMatchObject({
      reasons: ['changed'],
      changed: [
        { key: 'upload:images:edited.png', relativePath: 'images/edited.png' },
        { key: 'upload:images:moved.png', relativePath: 'images/moved.png' }
      ]
    })
    expect(answer.body.error).toContain('2 acknowledged upload records changed since the check (images/edited.png, images/moved.png)')
    // The fingerprint the check now gives is the one the export compared against.
    const fresh = await redis.json.get('upload:images:edited.png')
    expect((await acknowledgeCheck()).find((entry) => entry.key === 'upload:images:edited.png')?.fingerprint).toBe(
      uploadRecordFingerprint('upload:images:edited.png', fresh)
    )
  })

  it('row 6: everything missing needs the second confirmation (409); a stale list beside it is named too', async () => {
    await seedUpload('upload:images:a.png', 'images/a.png')
    await seedUpload('upload:images:b.png', 'images/b.png')
    const acknowledged = await acknowledgeCheck()

    const unconfirmed = await postJson({ partial: { acknowledged } })
    expectRefused(unconfirmed, 409)
    expect(unconfirmed.body.details.reasons).toEqual(['all-missing-unconfirmed'])
    expect(unconfirmed.body.error).toContain(`none of the 2 upload files Batshit expects are in ${uploadRoot}, and that was not confirmed`)

    await seedUpload('upload:images:c.png', 'images/c.png')
    const both = await postJson({ partial: { acknowledged } })
    expectRefused(both, 409)
    expect(both.body.details.reasons).toEqual(['new-missing', 'all-missing-unconfirmed'])

    const confirmed = await postJson({ partial: { acknowledged: await acknowledgeCheck(), confirmAllMissing: true } })
    expect(confirmed.status).toBe(200)
    expect(parseMissingUploadsSummary(confirmed.summary)).toMatchObject({ completeness: 'partial', missingFiles: 3 })
    await confirmed.response.body?.cancel()
  })

  it('a file that appears between two aliases\' checks makes the path listed and carried: 409, never a contradictory archive', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    // Two alias records of one path whose file is there; the first check of it (record order:
    // the typed key first) misses it once, as if the file appeared just after.
    await seedUpload('upload:avatars:agent:r.jpg', 'avatars/r.jpg', 'pic')
    await seedUpload('upload:avatars:r.jpg', 'avatars/r.jpg')
    const filePath = path.join(uploadRoot, 'avatars/r.jpg')
    statRace.enoentOnceFor.add(filePath)
    const acknowledged = await acknowledgeCheck()
    expect(acknowledged.map((entry) => entry.key)).toEqual(['upload:avatars:agent:r.jpg'])

    statRace.enoentOnceFor.add(filePath)
    const answer = await postJson({ partial: { acknowledged } })
    expectRefused(answer, 409)
    expect(answer.body.error).toBe('Upload file "avatars/r.jpg" changed while the export was running. Try the export again.')
    expect(statRace.enoentOnceFor.size).toBe(0)
  })

  it('a refusal writes nothing', async () => {
    await seedUpload('upload:images:a.png', 'images/a.png')
    const acknowledged = await acknowledgeCheck()
    const before = await redis.execute(async (client: any) => JSON.stringify([(await client.keys('*')).sort(), await client.json.get('upload:images:a.png')]))
    expectRefused(await postJson({ partial: { acknowledged } }), 409)
    const after = await redis.execute(async (client: any) => JSON.stringify([(await client.keys('*')).sort(), await client.json.get('upload:images:a.png')]))
    expect(after).toBe(before)
    expect(await fs.readdir(uploadRoot)).toEqual([])
  })
})

describe('row 7: a partial manifest a restore could not read is refused with the reader\'s 400', () => {
  it('refuses a list that would make manifest.json larger than 2 MiB, though the request fit', async () => {
    await seedUpload('upload:images:present.png', 'images/present.png', 'abc')
    await seedManyMissing(7_000, (index) => `missing-file-${String(index).padStart(5, '0')}.png`)
    const acknowledged = await acknowledgeCheck()
    const body = JSON.stringify({ partial: { acknowledged } })
    expect(Buffer.byteLength(body)).toBeLessThan(BACKUP_EXPORT_REQUEST_MAX_BYTES)

    const answer = await post({ body })
    expectRefused(answer, 400)
    expect(answer.body.error).toMatch(
      /^This partial backup's manifest\.json would be \d+ bytes, over the 2097152 bytes a restore reads, because its list of missing upload files is too long\./
    )
  }, 120_000)
})
