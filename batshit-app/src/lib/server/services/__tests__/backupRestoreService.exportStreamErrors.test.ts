// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { unzipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  beginBackupRestoreMaintenance,
  encodeNotCarriedHeader,
  enterBackupRestoreHttpRequest,
  type BackupRestoreError
} from '$lib/server/services/backupRestoreService'
import { POST as EXPORT } from '../../../../routes/api/admin/backup/export/+server'

/**
 * BL-1387: the streaming export must fail through its own error, never crash, when an upload file
 * the check found cannot be read. `streamedEntry` used `source.pipe(deflate)`, which forwards no
 * source error, and the file stream had no `error` listener, so an open or read error escaped as
 * an uncaught exception and the download never ended. Now the file and the deflate stream are
 * joined by `pipeline` before the first yield, and every way out of the entry ends both.
 *
 * This drives the REAL Admin export route and the REAL zip stream over an owned temporary upload
 * folder and the default lane's Redis fake. The file streams are the real `fs` and `zlib` ones;
 * the test only wraps their constructors to watch them, and injects each failure at the file
 * system: a mode-000 file, a file removed just before it is opened, a read that fails after the
 * first 64 KiB, and a file that shrinks before it is opened.
 *
 * BL-1390: the client already has its 200 when the stream fails, so the error never reaches it.
 * The export logs one `[backup-export]` line per failure, where the response body pulls the zip
 * stream: the entry's zip path, the status, the system code and the sentence, never `details`
 * (the absolute path). A cancelled download is not a failure and logs nothing, though it reaches
 * the zip generator as an error.
 *
 * BL-1401: a restore waits for running HTTP work through the restore gate, and the export's
 * request lets go of it when the route returns its Response, long before the files are read. So
 * the export holds the gate itself until its stream is over and its files are closed. The hook's
 * hold is taken here exactly as `backupRestoreMaintenanceHandler` takes it (importing the hooks
 * module would start the app's background work), and a restore is started as its route starts
 * one: its own request's hold, then `beginBackupRestoreMaintenance`. Nothing is replaced.
 */

const tracked = vi.hoisted(() => ({
  reads: [] as Array<{ path: string; stream: import('node:fs').ReadStream }>,
  deflates: [] as Array<import('node:zlib').DeflateRaw>,
  /** Runs synchronously just before the file at this path is opened for the zip. */
  beforeOpen: new Map<string, () => void>(),
  /** The file at this path reads its first chunk, then every later read fails with EIO. */
  failSecondReadOf: null as string | null,
  /** The file at this path reads its first chunk; its second read waits until `readGate.open()`. */
  holdSecondReadOf: null as string | null,
  readGate: null as null | { opened: Promise<void>; open: () => void; waiting: boolean }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const createReadStream = ((file: Parameters<typeof actual.createReadStream>[0], options?: any) => {
    const filePath = String(file)
    tracked.beforeOpen.get(filePath)?.()
    let streamOptions = options
    if (tracked.failSecondReadOf === filePath || tracked.holdSecondReadOf === filePath) {
      const hold = tracked.holdSecondReadOf === filePath
      let reads = 0
      streamOptions = {
        ...(options && typeof options === 'object' ? options : {}),
        fs: {
          open: actual.open,
          close: actual.close,
          read: (...args: Parameters<typeof actual.read>) => {
            reads += 1
            if (reads === 1) return (actual.read as (...rest: unknown[]) => void)(...args)
            if (hold) {
              const gate = tracked.readGate!
              gate.waiting = true
              void gate.opened.then(() => (actual.read as (...rest: unknown[]) => void)(...args))
              return
            }
            const callback = args[args.length - 1] as (error: Error) => void
            process.nextTick(callback, Object.assign(new Error('EIO: i/o error, read (injected by the BL-1387 test)'), { code: 'EIO' }))
          }
        }
      }
    }
    const stream = actual.createReadStream(file, streamOptions)
    tracked.reads.push({ path: filePath, stream })
    return stream
  }) as typeof actual.createReadStream
  return { ...actual, default: { ...actual, createReadStream }, createReadStream }
})

// BL-1401: the real service, with the route's header encoder watched so one case can make the
// route fail after the stream exists. Every other export is the real one, with its real state.
vi.mock('$lib/server/services/backupRestoreService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/backupRestoreService')>()
  return { ...actual, encodeNotCarriedHeader: vi.fn(actual.encodeNotCarriedHeader) }
})

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  const createDeflateRaw = ((options?: import('node:zlib').ZlibOptions) => {
    const stream = actual.createDeflateRaw(options)
    tracked.deflates.push(stream)
    return stream
  }) as typeof actual.createDeflateRaw
  return { ...actual, default: { ...actual, createDeflateRaw }, createDeflateRaw }
})

useRedisTestServer()

const USER = 'bl1387_user'
const RELATIVE_PATH = 'documents/bl1387-notes.txt'
const ZIP_PATH = `files/uploads/${RELATIVE_PATH}`
const STREAM_FAILED = `Backup failed while streaming "${RELATIVE_PATH}".`
const END_OF_CENTRAL_DIRECTORY = Buffer.from([0x50, 0x4b, 0x05, 0x06])

let uploadRoot: string
let previousUploadsDir: string | undefined
let errorLog: MockInstance<typeof console.error>
/** Run after each test, in order: stop what the test left running (BL-1401). */
const cleanups: Array<() => unknown> = []

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Base64 text of random bytes: it compresses, but not to almost nothing, so it spans many chunks. */
function compressibleText(size: number) {
  return Buffer.from(randomBytes(Math.ceil((size * 3) / 4)).toString('base64').slice(0, size), 'utf8')
}

/** One file-backed upload record and its file, in the owned upload folder. */
async function seedUpload(bytes: Buffer) {
  return seedUploadAt(RELATIVE_PATH, bytes)
}

async function seedUploadAt(relativePath: string, bytes: Buffer) {
  const filePath = path.join(uploadRoot, relativePath)
  const filename = path.basename(relativePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, bytes)
  await redis.json.set(`upload:documents:${filename}`, '$', {
    filename,
    originalName: filename,
    mimetype: 'text/plain',
    size: bytes.length,
    uploadType: 'documents',
    uploadedAt: '2026-10-11T18:00:00.000Z',
    storage: 'filesystem',
    relativePath,
    filePath
  })
  return filePath
}

async function exportThroughRoute() {
  const response = (await EXPORT({
    locals: { user: { id: USER, is_admin: true } },
    request: new Request('http://localhost/api/admin/backup/export', { method: 'POST', body: '{}' })
  } as any)) as Response
  expect(response.status).toBe(200)
  expect(response.body).toBeTruthy()
  return response
}

/**
 * Reads the download to its end, or to its error, as SvelteKit's response writer does. With
 * `parkAt`, it first reads only until the export has opened that file, then stops reading for
 * `parkMs`, so the open fails while nobody reads the download. (The generator then usually
 * waits for the file's first compressed bytes: the tiny header and name chunks are already
 * buffered. The fix attaches the pipeline before the header yield too, so the same holds there.)
 */
async function drain(
  body: ReadableStream<Uint8Array>,
  park?: { parkAt: string; parkMs: number; inspect: () => unknown }
) {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let parked: unknown = null
  try {
    if (park) {
      while (!tracked.reads.some((read) => read.path === park.parkAt)) {
        const { done, value } = await reader.read()
        if (done) return { bytes: Buffer.concat(chunks), error: null as unknown, parked }
        chunks.push(value)
      }
      await pause(park.parkMs)
      parked = park.inspect()
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { bytes: Buffer.concat(chunks), error: null as unknown, parked }
      chunks.push(value)
    }
  } catch (error) {
    return { bytes: Buffer.concat(chunks), error, parked }
  }
}

function fileStream(filePath: string) {
  const entry = tracked.reads.find((read) => read.path === filePath)
  expect(entry, `the export opened ${filePath}`).toBeTruthy()
  return entry!.stream
}

/** The file stream is closed (its descriptor released) and its deflate stream is destroyed. */
async function expectBothStreamsEnded(filePath: string) {
  const source = fileStream(filePath)
  await vi.waitFor(() => expect(source.closed).toBe(true), { timeout: 5_000 })
  expect(source.destroyed).toBe(true)
  expect(tracked.deflates.length).toBe(1)
  await vi.waitFor(() => expect(tracked.deflates[0].destroyed).toBe(true), { timeout: 5_000 })
  return source
}

function expectStreamingFailure(result: { bytes: Buffer; error: unknown; parked: unknown }, code: string, status = 500) {
  const error = result.error as BackupRestoreError
  expect(error, 'the download ends with an error, not a finished file').toBeTruthy()
  expect(error).toMatchObject({ name: 'BackupRestoreError', status })
  if (status === 500) {
    expect(error.message).toBe(STREAM_FAILED)
    expect(String(error.details)).toContain(code)
  }
  // Not a finished archive: the end-of-central-directory record is never written.
  expect(result.bytes.includes(END_OF_CENTRAL_DIRECTORY)).toBe(false)
}

/** The export's own failure lines (BL-1390); the route logs only errors before the response. */
function exportDiagnostics() {
  return errorLog.mock.calls.filter(([first]) => typeof first === 'string' && first.startsWith('[backup-export]'))
}

/** Exactly one line for the failure, naming the upload's zip entry; no path, no error object. */
function expectOneDiagnostic(expected: { status: number; code: string | null; error: string }) {
  const lines = exportDiagnostics()
  expect(lines).toEqual([['[backup-export] failed after the download began:', { entry: ZIP_PATH, ...expected }]])
  const logged = JSON.stringify(lines)
  expect(logged).not.toContain(uploadRoot)
  expect(logged).not.toContain(path.basename(uploadRoot))
}

/**
 * BL-1401: the hook's hold, as `backupRestoreMaintenanceHandler` (hooks.server.ts) takes it: from
 * admission until the handler has returned its Response.
 */
async function throughHook<T>(handler: () => Promise<T>): Promise<T> {
  const releaseRequest = enterBackupRestoreHttpRequest()
  expect(releaseRequest, 'the hook admits the request').toBeTruthy()
  try {
    return await handler()
  } finally {
    releaseRequest!()
  }
}

/** The upload files the export opened, those still open, and its deflate streams still open. */
function openFiles() {
  const relative = (read: (typeof tracked.reads)[number]) => path.relative(uploadRoot, read.path)
  return {
    opened: tracked.reads.map(relative),
    open: tracked.reads.filter((read) => !read.stream.closed).map(relative),
    deflatesOpen: tracked.deflates.filter((deflate) => !deflate.closed).length
  }
}

/**
 * A restore, started as its route starts one: its own request holds the gate (the hook), then
 * maintenance begins, which waits until no other work holds the gate, or refuses after 30 s
 * (its route then answers, and its request lets go). Getting through is the moment the
 * replacement could start; `openAtStart` is what the export still had open at that moment.
 * Nothing is replaced.
 */
function startRestore() {
  const releaseRestoreRequest = enterBackupRestoreHttpRequest()
  expect(releaseRestoreRequest, 'the hook admits the restore request').toBeTruthy()
  const restore = {
    started: false,
    refused: null as BackupRestoreError | null,
    openAtStart: null as ReturnType<typeof openFiles> | null,
    settled: Promise.resolve()
  }
  let endMaintenance: (() => void) | null = null
  restore.settled = beginBackupRestoreMaintenance().then(
    (end) => {
      endMaintenance = end
      restore.openAtStart = openFiles()
      restore.started = true
    },
    (error: BackupRestoreError) => {
      restore.refused = error
      // The route answers the refusal, and the hook lets go of its request.
      releaseRestoreRequest!()
    }
  )
  cleanups.push(async () => {
    await restore.settled
    endMaintenance?.()
    releaseRestoreRequest!()
  })
  return restore
}

/**
 * Nothing holds the restore gate any more: a restore gets through at once. When something still
 * holds it, this waits for that restore's own 30 s refusal (which turns maintenance off again)
 * before failing, so one failure does not make every later test fail too.
 */
async function expectGateFree() {
  const releaseRequest = enterBackupRestoreHttpRequest()
  expect(releaseRequest, 'no restore is left running').toBeTruthy()
  const restore = beginBackupRestoreMaintenance().then((end) => {
    end()
    return 'through'
  })
  const outcome = await Promise.race([restore, pause(2_000).then(() => 'still held')])
  if (outcome !== 'through') await restore.catch(() => undefined)
  releaseRequest!()
  expect(outcome, 'no export still holds the restore gate').toBe('through')
}

/** Reads until the export has read some of the file at this path; the rest stays unread. */
async function readInto(reader: ReadableStreamDefaultReader<Uint8Array>, filePath: string) {
  for (;;) {
    const { done } = await reader.read()
    expect(done).toBe(false)
    const opened = tracked.reads.find((read) => read.path === filePath)
    if (opened && opened.stream.bytesRead > 0) return
  }
}

/** Reads the rest of the download: null at its end, or the error it ended with. */
async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) return null
    }
  } catch (error) {
    return error
  }
}

beforeEach(async () => {
  previousUploadsDir = process.env.UPLOADS_DIR
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bl1387-export-'))
  process.env.UPLOADS_DIR = uploadRoot
  tracked.reads.length = 0
  tracked.deflates.length = 0
  tracked.beforeOpen.clear()
  tracked.failSecondReadOf = null
  tracked.holdSecondReadOf = null
  tracked.readGate = null
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  // The export reads local files and Redis only: any network call is a bug.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('BL-1387 export must not call the network')
  }))
})

afterEach(async () => {
  vi.useRealTimers()
  tracked.readGate?.open()
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    // BL-1401: every export, finished, failed or cancelled, has let go of the restore gate.
    await expectGateFree()
  } finally {
    vi.mocked(encodeNotCarriedHeader).mockReset()
    errorLog.mockRestore()
    vi.unstubAllGlobals()
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR
    else process.env.UPLOADS_DIR = previousUploadsDir
    await fs.chmod(path.join(uploadRoot, RELATIVE_PATH), 0o600).catch(() => undefined)
    await fs.rm(uploadRoot, { recursive: true, force: true })
  }
  // A held gate can need a cleanup's 30 s refusal and then the check's own: the first failure
  // stays the reported one, and this teardown never runs into the next test.
}, 70_000)

describe('streaming export: an upload the check found but the export cannot read (BL-1387)', () => {
  it.skipIf(process.getuid?.() === 0)('a found file that cannot be opened (mode 000) ends the download with the export error, even while nobody reads', async () => {
    const filePath = await seedUpload(compressibleText(512 * 1024))
    await fs.chmod(filePath, 0o000)

    const response = await exportThroughRoute()
    // Read until the export opens this file, then nobody reads for a while: the open fails while
    // nobody reads the download.
    const result = await drain(response.body!, {
      parkAt: filePath,
      parkMs: 200,
      inspect: () => (fileStream(filePath).errored as NodeJS.ErrnoException | null)?.code ?? null
    })

    // The open had already failed before anyone read on: the error arrived while nobody read.
    expect(result.parked).toBe('EACCES')
    expectStreamingFailure(result, 'EACCES')
    await expectBothStreamsEnded(filePath)
    expectOneDiagnostic({ status: 500, code: 'EACCES', error: STREAM_FAILED })
  }, 15_000)

  it('a file removed after the check, just before it is opened, ends the download with the export error', async () => {
    const filePath = await seedUpload(compressibleText(512 * 1024))
    tracked.beforeOpen.set(filePath, () => rmSync(filePath))

    const result = await drain((await exportThroughRoute()).body!)

    expectStreamingFailure(result, 'ENOENT')
    await expectBothStreamsEnded(filePath)
    expectOneDiagnostic({ status: 500, code: 'ENOENT', error: STREAM_FAILED })
  }, 15_000)

  it('a read that fails midway ends the download with the export error, after some of the file was written', async () => {
    const bytes = compressibleText(1024 * 1024)
    const filePath = await seedUpload(bytes)
    tracked.failSecondReadOf = filePath

    const result = await drain((await exportThroughRoute()).body!)

    expectStreamingFailure(result, 'EIO')
    const source = await expectBothStreamsEnded(filePath)
    expect(source.bytesRead).toBe(64 * 1024)
    expectOneDiagnostic({ status: 500, code: 'EIO', error: STREAM_FAILED })
  }, 15_000)

  it('keeps the existing classification: a file that shrinks before it is read is "changed" (409)', async () => {
    const filePath = await seedUpload(compressibleText(256 * 1024))
    tracked.beforeOpen.set(filePath, () => writeFileSync(filePath, 'shorter now'))

    const result = await drain((await exportThroughRoute()).body!)

    const changed = `Backup file "${RELATIVE_PATH}" changed while the export was running. Try the export again.`
    expectStreamingFailure(result, '', 409)
    expect((result.error as Error).message).toBe(changed)
    await expectBothStreamsEnded(filePath)
    expectOneDiagnostic({ status: 409, code: null, error: changed })
  }, 15_000)

  it('an ordinary export still writes the whole file and a finished zip, and ends both streams', async () => {
    const bytes = compressibleText(512 * 1024)
    const filePath = await seedUpload(bytes)

    const result = await drain((await exportThroughRoute()).body!)

    expect(result.error).toBeNull()
    expect(result.bytes.includes(END_OF_CENTRAL_DIRECTORY)).toBe(true)
    const entries = unzipSync(new Uint8Array(result.bytes))
    expect(Buffer.from(entries[ZIP_PATH]).equals(bytes)).toBe(true)
    expect(entries['manifest.json']).toBeTruthy()
    const source = await expectBothStreamsEnded(filePath)
    expect(source.bytesRead).toBe(bytes.length)
    expect(exportDiagnostics()).toEqual([])
  }, 15_000)

  // A plain cancel reaches the zip generator as an AbortError, and a cancel with an error (as
  // SvelteKit's writer does on a response error) as that error; the file entry's catch wraps
  // either into "Backup failed while streaming". Neither is a failure of the export, so neither
  // is logged (BL-1390).
  it.each([
    ['a plain cancel, as a closed tab does', undefined],
    ['a cancel with an error', new Error('socket closed by the client (BL-1390 test)')]
  ])('a cancelled download (%s) stops reading the file and closes it, with no error left behind and nothing logged', async (_name, reason) => {
    const size = 6 * 1024 * 1024
    const filePath = await seedUpload(compressibleText(size))

    const response = await exportThroughRoute()
    const reader = response.body!.getReader()
    // Read until the export is inside this file's entry, then cancel, as a closed tab does.
    for (;;) {
      const { done } = await reader.read()
      expect(done).toBe(false)
      const opened = tracked.reads.find((read) => read.path === filePath)
      if (opened && opened.stream.bytesRead > 0) break
    }
    await reader.cancel(reason)

    const source = await expectBothStreamsEnded(filePath)
    expect(source.bytesRead).toBeLessThan(size)
    await pause(100)
    expect(exportDiagnostics()).toEqual([])
  }, 15_000)
})

describe('the export holds the restore gate until its stream is over and its files are closed (BL-1401)', () => {
  const FIRST = 'documents/bl1401-first.txt'
  const SECOND = 'documents/bl1401-second.txt'
  const FIRST_SIZE = 2 * 1024 * 1024
  const SECOND_SIZE = 1024 * 1024
  const NOTHING_OPEN = (opened: string[]) => ({ opened, open: [], deflatesOpen: 0 })

  /**
   * Two uploads, exported through the route behind the hook's hold, which has ended when this
   * returns. Nobody reads yet, so the export waits inside the first file and has not opened the
   * second. `prepareSecond` runs before the export starts.
   */
  async function startTwoFileExport(prepareSecond?: (secondPath: string) => Promise<void> | void) {
    const firstPath = await seedUploadAt(FIRST, compressibleText(FIRST_SIZE))
    const secondPath = await seedUploadAt(SECOND, compressibleText(SECOND_SIZE))
    await prepareSecond?.(secondPath)
    const response = await throughHook(() => exportThroughRoute())
    const reader = response.body!.getReader()
    cleanups.push(() => reader.cancel().catch(() => undefined))
    return { firstPath, secondPath, reader }
  }

  it('a restore started after the route answered waits while the export still has files to read, and gets through once the export ended with every file closed', async () => {
    const { firstPath, secondPath, reader } = await startTwoFileExport()
    await readInto(reader, firstPath)

    const restore = startRestore()
    await pause(200)
    // The route answered long ago; the export has not even opened its second file.
    expect(restore.started).toBe(false)
    expect(tracked.reads.some((read) => read.path === secondPath)).toBe(false)

    expect(await readToEnd(reader)).toBeNull()
    await restore.settled
    expect(restore.started).toBe(true)
    // Both files were read and closed before the restore could replace anything.
    expect(restore.openAtStart).toEqual(NOTHING_OPEN([FIRST, SECOND]))
    expect(fileStream(secondPath).bytesRead).toBe(SECOND_SIZE)
    expect(exportDiagnostics()).toEqual([])
  }, 30_000)

  const secondFileFailures: Array<[string, string, (secondPath: string) => Promise<void> | void]> = [
    ['is removed just before it is opened', 'ENOENT', (secondPath) => void tracked.beforeOpen.set(secondPath, () => rmSync(secondPath))],
    ['fails a read midway', 'EIO', (secondPath) => void (tracked.failSecondReadOf = secondPath)]
  ]
  if (process.getuid?.() !== 0) {
    secondFileFailures.unshift(['cannot be opened (mode 000)', 'EACCES', (secondPath) => fs.chmod(secondPath, 0o000)])
  }

  it.each(secondFileFailures)('an export whose second file %s lets a waiting restore through only after it closed its files (%s)', async (_how, code, prepareSecond) => {
    const { firstPath, reader } = await startTwoFileExport(prepareSecond)
    cleanups.push(() => fs.chmod(path.join(uploadRoot, SECOND), 0o600).catch(() => undefined))
    await readInto(reader, firstPath)

    const restore = startRestore()
    await pause(200)
    expect(restore.started).toBe(false)

    expect(await readToEnd(reader)).toMatchObject({ name: 'BackupRestoreError', status: 500 })
    await restore.settled
    expect(restore.started).toBe(true)
    expect(restore.openAtStart).toEqual(NOTHING_OPEN([FIRST, SECOND]))
    // BL-1390 unchanged: one line for the failure.
    expect(exportDiagnostics()).toEqual([
      [
        '[backup-export] failed after the download began:',
        { entry: `files/uploads/${SECOND}`, status: 500, code, error: `Backup failed while streaming "${SECOND}".` }
      ]
    ])
  }, 30_000)

  it.each([
    ['a plain cancel', undefined],
    ['a cancel with an error', new Error('socket closed by the client (BL-1401 test)')]
  ])('a download stopped inside the first file (%s) lets a waiting restore through only after the export closed it', async (_name, reason) => {
    const { firstPath, reader } = await startTwoFileExport()
    await readInto(reader, firstPath)

    const restore = startRestore()
    await pause(200)
    expect(restore.started).toBe(false)

    await reader.cancel(reason)
    await restore.settled
    expect(restore.started).toBe(true)
    expect(restore.openAtStart).toEqual(NOTHING_OPEN([FIRST]))
    expect(exportDiagnostics()).toEqual([])
  }, 30_000)

  it('a download cancelled before anything was read (the export still at its first, in-memory entries) holds the gate until the cancel, then lets a waiting restore through', async () => {
    const { reader } = await startTwoFileExport()

    const restore = startRestore()
    await pause(200)
    expect(restore.started).toBe(false)

    await reader.cancel()
    await restore.settled
    expect(restore.started).toBe(true)
    // The stream pulled once when it was made, so the export had started, but it opened no file.
    expect(restore.openAtStart).toEqual(NOTHING_OPEN([]))
    expect(exportDiagnostics()).toEqual([])
  }, 30_000)

  it('a route that fails after the stream exists cancels it, so the hold ends and no file stays open', async () => {
    await seedUploadAt(FIRST, compressibleText(1024))
    vi.mocked(encodeNotCarriedHeader).mockClear()
    vi.mocked(encodeNotCarriedHeader).mockImplementationOnce(() => {
      throw new Error('header failure injected by the BL-1401 test')
    })

    const response = await throughHook(
      async () =>
        (await EXPORT({
          locals: { user: { id: USER, is_admin: true } },
          request: new Request('http://localhost/api/admin/backup/export', { method: 'POST', body: '{}' })
        } as any)) as Response
    )
    expect(response.status).toBe(500)
    expect(encodeNotCarriedHeader).toHaveBeenCalledTimes(1)

    const restore = startRestore()
    expect(await Promise.race([restore.settled.then(() => 'through'), pause(2_000).then(() => 'still waiting')])).toBe('through')
    expect(restore.started).toBe(true)
    expect(restore.openAtStart).toEqual(NOTHING_OPEN([]))
  }, 30_000)

  it('a download cancelled while a file read is still in flight keeps the restore waiting until that read finished and the file closed', async () => {
    let open!: () => void
    tracked.readGate = { opened: new Promise<void>((resolve) => (open = resolve)), open: () => open(), waiting: false }
    const firstPath = path.join(uploadRoot, FIRST)
    tracked.holdSecondReadOf = firstPath
    const { reader } = await startTwoFileExport()

    // Read until the download has nothing more to give: the export waits on the held file read.
    const reading = (async () => {
      for (;;) {
        const { done } = await reader.read()
        if (done) return
      }
    })()
    await vi.waitFor(() => expect(tracked.readGate!.waiting).toBe(true))
    const restore = startRestore()

    await reader.cancel(new Error('client went away during a read (BL-1401 test)'))
    await reading
    await pause(200)
    // The read is still in flight, so the file cannot be closed yet, and the export still holds the gate.
    expect(restore.started).toBe(false)
    expect(fileStream(firstPath).closed).toBe(false)

    tracked.readGate!.open()
    await restore.settled
    expect(restore.started).toBe(true)
    expect(restore.openAtStart).toEqual(NOTHING_OPEN([FIRST]))
    expect(exportDiagnostics()).toEqual([])
  }, 30_000)

  it('an export that fails before it streams (an upload file is missing) lets go of the gate at once', async () => {
    const firstPath = await seedUploadAt(FIRST, compressibleText(1024))
    await fs.rm(firstPath)

    const response = await throughHook(
      async () =>
        (await EXPORT({
          locals: { user: { id: USER, is_admin: true } },
          request: new Request('http://localhost/api/admin/backup/export', { method: 'POST', body: '{}' })
        } as any)) as Response
    )
    expect(response.status).toBe(409)

    const restore = startRestore()
    await restore.settled
    expect(restore.started).toBe(true)
    expect(tracked.reads).toEqual([])
  }, 30_000)

  it("an export that reaches its work while a restore drains is refused with the hook's words, opens nothing, and lets that restore through", async () => {
    await seedUploadAt(FIRST, compressibleText(1024))
    let restore!: ReturnType<typeof startRestore>
    const response = (await throughHook(async () => {
      // The restore begins after the hook admitted this export, so it waits for this request.
      restore = startRestore()
      await pause(50)
      expect(restore.started).toBe(false)
      return (await EXPORT({
        locals: { user: { id: USER, is_admin: true } },
        request: new Request('http://localhost/api/admin/backup/export', { method: 'POST', body: '{}' })
      } as any)) as Response
    })) as Response
    cleanups.push(() => response.body?.cancel().catch(() => undefined))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'Batshit is finishing a backup restore. Try again after the app reloads.' })
    await restore.settled
    expect(restore.started).toBe(true)
    expect(tracked.reads).toEqual([])
  }, 30_000)

  it('a stalled export makes a restore refuse after 30 seconds as before, replacing nothing, and new work is let in again', async () => {
    const { firstPath, reader } = await startTwoFileExport()
    await readInto(reader, firstPath)

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const restore = startRestore()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(restore.started).toBe(false)
    expect(restore.refused).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    await restore.settled
    vi.useRealTimers()

    expect(restore.started).toBe(false)
    expect(restore.refused).toMatchObject({
      status: 409,
      message: 'Restore is waiting for active Batshit work to finish. Stop the current task and try again.'
    })
    // Admission is back, and the export streams on, untouched.
    const releaseRequest = enterBackupRestoreHttpRequest()
    expect(releaseRequest).toBeTruthy()
    releaseRequest!()
    expect(fileStream(firstPath).closed).toBe(false)

    expect(await readToEnd(reader)).toBeNull()
    const next = startRestore()
    await next.settled
    expect(next.started).toBe(true)
    expect(next.openAtStart).toEqual(NOTHING_OPEN([FIRST, SECOND]))
  }, 30_000)
})
