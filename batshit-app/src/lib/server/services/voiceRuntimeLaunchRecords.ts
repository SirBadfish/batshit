/**
 * Launch records: how a local voice runtime Batshit started stays stoppable.
 *
 * Every detached spawn writes `<voice runtime state root>/<engineId>/.batshit-local-runtime-launch.json`
 * (pid, command, args, cwd, the user's "Stop with Batshit" choice). The Mac runtime supervisor
 * and the native launcher stop runtimes from these files at shutdown, because neither can read
 * Redis; the decision itself is `batshit-mac/scripts/local-voice-runtime-stop.mjs`.
 *
 * Two rules live here (2026-09-18, bug sweep item 12):
 *
 * 1. **A launch never discards the record of a process that still runs.** Several Batshits share
 *    one state root (the packaged Mac app, the source-checkout launcher, worktree dev lanes), and a record
 *    was keyed by engine id alone, so a second launch of the same engine (another Batshit's
 *    registry naming another port, or a changed port) overwrote the record of a process that
 *    was still running. Nothing could stop that process again: on 2026-09-16 a native lane's
 *    `chatterbox-turbo` on 8012 lost its record to the packaged app's launch of the same engine
 *    on 8010 and ran on for days. The earlier record is now moved aside as
 *    `.batshit-local-runtime-launch.<pid>.json`, which every shutdown path reads. The Mac
 *    package keeps a plain-JavaScript twin of this rule for the Docker host operator.
 * 2. **Engines that share one runtime each carry their own choice.** One `mlx_audio.server` on
 *    one port can serve several engines; only the engine whose launch started it had a record.
 *    Another engine that uses the same endpoint gets an "attach" record: the process fields
 *    copied from the starter's record (its launch time included, so the native launcher's
 *    ownership window still reads the process's real launch), `startedBy` naming the starter,
 *    and its OWN `stopOnShutdown`. The shutdown decision then stops that process only if every
 *    engine that uses it says stop. An endpoint that no live Batshit launch record serves gets
 *    no record at all: Batshit did not start it (Connect Existing, a server the user runs), so
 *    it must never stop it.
 * 3. **Every change is atomic and serialized** (review of 22aa935de). Changes to one engine's
 *    folder happen under its record lock (an atomic mkdir, shared with the stoppers and the
 *    Docker operator through the Mac package's twin), and every write is a temp file renamed
 *    into place: a quit never reads half a record, and a toggle save that raced a launch can no
 *    longer write the old record back over the new one.
 * 4. **A record names the registry that wrote it** (`registry`, a hash of the Redis the app uses,
 *    credentials left out). Several Batshits with different registries share the state root, so
 *    clean-up (`pruneLocalRuntimeLaunchRecords`) only ever touches its own registry's records:
 *    an attach record goes when its engine is deleted or no longer uses that endpoint, and a
 *    deleted engine's own launch loses its "keep running", so nothing runs on with no switch.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { link, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import {
  resolveLocalVoiceRuntimeLaunchRecordPath,
  resolveLocalVoiceRuntimeStateDir,
  resolveOperatorVoiceStateRoot,
  resolveVoiceRuntimeStateRoot
} from '$lib/server/services/voiceLocalRuntimePaths'

export type LocalVoiceRuntimeLaunchRecord = {
  engineId?: string
  pid?: number
  command?: string
  args?: string[]
  cwd?: string
  logPath?: string
  launchedAt?: string
  stopOnShutdown?: boolean
  /** The listener this process serves, normalized (`http://127.0.0.1:8012`). */
  endpoint?: string
  /** On an attach record only: the engine whose launch started this process. */
  startedBy?: string
  /** The registry (a hash of the app's Redis) whose Batshit wrote this record. */
  registry?: string
  /**
   * Which Batshit launched the process (`BATSHIT_VOICE_RUNTIME_OWNER`, given to the app by the Mac
   * supervisor or the source-checkout launcher); every record of one process carries the same value, and each
   * stopper stops only its own Batshit's launches. Absent on records written before 2026-09-18.
   */
  launchedBy?: string
}

export type StoredLocalVoiceRuntimeLaunchRecord = LocalVoiceRuntimeLaunchRecord & {
  recordPath: string
  unreadable?: undefined
}

/**
 * A launch record, or the folder that holds records, that could not be read (BL-1264 in the shared
 * module, BL-1268 here): the same shape as `readLocalRuntimeLaunchRecords`' unreadable entries.
 * `recordPath` is the file or folder; `engineId` is null when the state root itself could not be
 * read. It may name a process that still runs, so nothing writes over it, removes it, or stops a
 * process it could be the "keep running" of.
 */
export type UnreadableLocalVoiceRuntimeLaunchRecord = {
  engineId: string | null
  unreadable: true
  invalid: true
  reason: string
  recordPath: string
}

export type LocalVoiceRuntimeLaunchRecordEntry =
  | StoredLocalVoiceRuntimeLaunchRecord
  | UnreadableLocalVoiceRuntimeLaunchRecord

const LAUNCH_RECORD_NAME_PATTERN = /^\.batshit-local-runtime-launch(?:\.(\d+))?\.json$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * One spelling per listener, so two engines configured as `http://localhost:8012/` and
 * `http://127.0.0.1:8012` are recognized as using the same runtime.
 */
export function normalizeLocalRuntimeEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  const protocol =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol
  if (protocol !== 'http:' && protocol !== 'https:') return null
  const hostname = parsed.hostname.toLowerCase()
  const host = LOOPBACK_HOSTS.has(hostname) ? '127.0.0.1' : hostname
  const port = parsed.port || (protocol === 'https:' ? '443' : '80')
  return `${protocol}//${host}:${port}`
}

/** Is this process, or the process group it leads, still running? */
export function isLocalRuntimeProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  for (const target of [pid, -pid]) {
    try {
      process.kill(target, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EPERM') return true
    }
  }
  return false
}

function errorCode(error: unknown): string {
  const failure = error as NodeJS.ErrnoException | null
  return failure?.code ?? failure?.message ?? String(error)
}

function unreadableEntry(
  engineId: string | null,
  recordPath: string,
  reason: string
): UnreadableLocalVoiceRuntimeLaunchRecord {
  return { engineId, unreadable: true, invalid: true, reason, recordPath }
}

type RecordFileState =
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string }
  | { state: 'record'; record: LocalVoiceRuntimeLaunchRecord }

/**
 * One launch record file, read once. Twin of `readLocalRuntimeLaunchRecordFileState` in
 * `local-voice-runtime-stop.mjs`, with the same reasons (BL-1268): only "no such file" is absent;
 * any other read error (a folder in its place, no permission, an I/O error), an empty file,
 * malformed JSON and anything but a JSON object is unreadable.
 */
async function readRecordFileState(recordPath: string): Promise<RecordFileState> {
  let raw: string
  try {
    raw = await readFile(recordPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'absent' }
    return { state: 'unreadable', reason: `the launch record ${recordPath} could not be read (${errorCode(error)})` }
  }
  let parsed: unknown
  try {
    parsed = raw.trim() ? JSON.parse(raw) : undefined
  } catch {
    return { state: 'unreadable', reason: `the launch record ${recordPath} is not valid JSON` }
  }
  if (parsed === undefined) return { state: 'unreadable', reason: `the launch record ${recordPath} is empty` }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'unreadable', reason: `the launch record ${recordPath} is not a JSON object` }
  }
  return { state: 'record', record: parsed as LocalVoiceRuntimeLaunchRecord }
}

async function readEngineRecords(
  engineDir: string,
  engineId: string
): Promise<LocalVoiceRuntimeLaunchRecordEntry[]> {
  let names: string[]
  try {
    names = await readdir(engineDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    return [unreadableEntry(engineId, engineDir, `the folder ${engineDir} could not be read (${errorCode(error)})`)]
  }
  const records: LocalVoiceRuntimeLaunchRecordEntry[] = []
  for (const name of names.filter((entry) => LAUNCH_RECORD_NAME_PATTERN.test(entry)).sort()) {
    const recordPath = path.join(engineDir, name)
    const current = await readRecordFileState(recordPath)
    if (current.state === 'absent') continue
    if (current.state === 'unreadable') {
      records.push(unreadableEntry(engineId, recordPath, current.reason))
      continue
    }
    // Only this reader says what could not be read: a record's own `unreadable` or `invalid` field
    // (Batshit never writes one) is not a verdict. The shared module's twin does the same.
    const { unreadable: _unreadable, invalid: _invalid, ...fields } = current.record as LocalVoiceRuntimeLaunchRecord & {
      unreadable?: unknown
      invalid?: unknown
    }
    records.push({ engineId, ...fields, recordPath })
  }
  return records
}

/**
 * Every launch record, moved-aside ones included: one engine's, or every engine's. A root, engine
 * folder or record that could not be read is an unreadable entry, never left out (BL-1268): a
 * caller that acts on the list keeps it, and never writes over it.
 */
export async function listLocalRuntimeLaunchRecords(
  engineId?: string
): Promise<LocalVoiceRuntimeLaunchRecordEntry[]> {
  if (engineId) return readEngineRecords(resolveLocalVoiceRuntimeStateDir(engineId), engineId)
  return readRecordsRoot(resolveVoiceRuntimeStateRoot(), 'the voice engine records folder')
}

/** Every engine folder's records under one records root; reads only. */
async function readRecordsRoot(root: string, what: string): Promise<LocalVoiceRuntimeLaunchRecordEntry[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    return [unreadableEntry(null, root, `${what} ${root} could not be read (${errorCode(error)})`)]
  }
  const records: LocalVoiceRuntimeLaunchRecordEntry[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      records.push(...(await readEngineRecords(path.join(root, entry.name), entry.name)))
    }
  }
  return records
}

function isReadable(entry: LocalVoiceRuntimeLaunchRecordEntry): entry is StoredLocalVoiceRuntimeLaunchRecord {
  return entry.unreadable !== true
}

const RECORD_LOCK_NAME = '.batshit-local-runtime-launch.lock'
const RECORD_LOCK_TOMBSTONE_PREFIX = '.batshit-local-runtime-launch.reaped-'
// The lock folder holds one file naming its holder, so a writer removes only its own lock.
const RECORD_LOCK_OWNER_FILE = 'owner'
// A lock older than this was left by a writer that died holding it (a change takes milliseconds).
const RECORD_LOCK_STALE_MS = 10_000
const RECORD_LOCK_WAIT_MS = RECORD_LOCK_STALE_MS + 5_000
const FALLBACK_PROCESS_STARTED_AT_MS =
  Math.floor((Date.now() - process.uptime() * 1_000) / 1_000) * 1_000
let currentProcessStartedAtPromise: Promise<number> | null = null

/**
 * A lock is stale when its time is more than the stale age from now, either way: a clock that
 * moved back leaves a lock in the future, which would otherwise block every writer.
 */
function recordLockIsStale(info: { mtimeMs: number }, now = Date.now()): boolean {
  return Math.abs(now - info.mtimeMs) > RECORD_LOCK_STALE_MS
}

/**
 * Remove the lock only when it is the one the caller means (bug sweep review, 2026-09-18). Two
 * waiters could both judge a dead writer's lock stale: the first removed it and took a fresh one,
 * and the second then removed that. And a writer that merely ran past the stale age could be
 * displaced while still working. Stale takeover now happens only after process-identity proof and
 * through a retained owner-specific tombstone; this helper handles the live owner's ordinary
 * release. The operator and the Mac supervisor use the same rule (`local-voice-runtime-stop.mjs`).
 */
export async function removeLocalRuntimeRecordLockIf(
  lockPath: string,
  isTheOne: (movedLockPath: string) => Promise<boolean>
): Promise<boolean> {
  const aside = `${lockPath}.aside-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await rename(lockPath, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
  if (await isTheOne(aside)) {
    await rm(aside, { recursive: true, force: true })
    return true
  }
  // Another writer's lock: put it back. Production never displaces a live owner, and stale
  // takeover uses an owner-specific tombstone, so no contender can take the name in this gap.
  await rename(aside, lockPath).catch(() => rm(aside, { recursive: true, force: true }))
  return false
}

async function recordLockOwner(lockDir: string): Promise<string | null> {
  const info = await stat(lockDir).catch(() => null)
  if (!info) return null
  return readFile(info.isDirectory() ? path.join(lockDir, RECORD_LOCK_OWNER_FILE) : lockDir, 'utf8').catch(
    () => null
  )
}

function parseRecordLockOwner(owner: string | null) {
  const current = /^v2:(\d+):(\d+):/.exec(owner ?? '')
  if (current) return { pid: Number(current[1]), startedAt: Number(current[2]) }
  // Locks from the first serialized-record implementation carried `pid-random`.
  const legacy = /^(\d+)-/.exec(owner ?? '')
  return legacy ? { pid: Number(legacy[1]), startedAt: null } : null
}

// Read in C and UTC like `readProcessGroup` (BL-63): in the user's language (`ven. 21 août`)
// `Date.parse` cannot read it, and a reused owner pid could never be reaped. Owners written
// before this still compare: both readings name the same instant.
async function processStartedAt(pid: number): Promise<number | null> {
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      'ps',
      ['-p', String(pid), '-o', 'lstart='],
      { timeout: 3_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } },
      (error, output) => resolve(error ? null : String(output).trim())
    )
  })
  return stdout ? parsePsStartTimeUtc(stdout) : null
}

async function currentProcessStartedAt(): Promise<number> {
  currentProcessStartedAtPromise ??= processStartedAt(process.pid).then(
    (startedAt) => startedAt ?? FALLBACK_PROCESS_STARTED_AT_MS
  )
  return currentProcessStartedAtPromise
}

/** True only with positive proof that the process which wrote this owner is gone or reused. */
async function recordLockOwnerIsGone(lockDir: string): Promise<boolean> {
  const parsed = parseRecordLockOwner(await recordLockOwner(lockDir))
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false
  try {
    process.kill(parsed.pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
  }
  if (parsed.startedAt === null) return false
  const actualStartedAt = await processStartedAt(parsed.pid)
  return actualStartedAt !== null && Math.abs(actualStartedAt - parsed.startedAt) > 1_500
}

async function recordLockOwnerPidIsAbsent(lockDir: string): Promise<boolean> {
  const parsed = parseRecordLockOwner(await recordLockOwner(lockDir))
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false
  try {
    process.kill(parsed.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
  }
}

/**
 * Reap one proven-dead stale lock. Every dead owner has one deterministic retained tombstone.
 * New file locks use a hard-link claim, so a late waiter cannot replace that tombstone or unlink
 * a fresh successor. Legacy nonempty-directory locks retain the rename protocol.
 */
async function reapStaleLocalRuntimeRecordLock(lockPath: string): Promise<boolean> {
  const expectedOwner = await recordLockOwner(lockPath)
  const info = await stat(lockPath).catch(() => null)
  if (!expectedOwner || !info || !(await recordLockOwnerIsGone(lockPath))) {
    return false
  }
  const ownerHash = createHash('sha256').update(expectedOwner).digest('hex').slice(0, 16)
  const tombstonePath = path.join(path.dirname(lockPath), `${RECORD_LOCK_TOMBSTONE_PREFIX}${ownerHash}`)
  if (info.isFile()) {
    try {
      // Hard-linking is the filesystem compare-and-swap: it cannot replace an existing
      // tombstone, and canonical stays occupied until this proven-dead generation is claimed.
      await link(lockPath, tombstonePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return false
      if (code === 'EEXIST') return false
      throw error
    }
    const [canonicalInfo, tombstoneInfo] = await Promise.all([
      stat(lockPath).catch(() => null),
      stat(tombstonePath).catch(() => null)
    ])
    if (
      canonicalInfo &&
      tombstoneInfo &&
      canonicalInfo.dev === tombstoneInfo.dev &&
      canonicalInfo.ino === tombstoneInfo.ino &&
      (await recordLockOwner(tombstonePath)) === expectedOwner &&
      (await recordLockOwnerIsGone(tombstonePath))
    ) {
      await unlink(lockPath)
      return true
    }
    return false
  }
  try {
    await rename(lockPath, tombstonePath)
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
      return false
    }
    throw error
  }
  const movedOwner = await recordLockOwner(tombstonePath)
  const movedInfo = await stat(tombstonePath).catch(() => null)
  if (
    movedOwner === expectedOwner &&
    movedInfo &&
    (await recordLockOwnerIsGone(tombstonePath))
  ) {
    return true
  }
  // The path changed between inspection and rename. Put it back only if nobody acquired the
  // canonical name; production ownership rules make this defensive branch unreachable.
  await rename(tombstonePath, lockPath).catch(() => {})
  return false
}

async function staleRecordLockHasClaimedTombstone(lockPath: string, owner: string): Promise<boolean> {
  const ownerHash = createHash('sha256').update(owner).digest('hex').slice(0, 16)
  const tombstonePath = path.join(path.dirname(lockPath), `${RECORD_LOCK_TOMBSTONE_PREFIX}${ownerHash}`)
  const [canonicalInfo, tombstoneInfo] = await Promise.all([
    stat(lockPath).catch(() => null),
    stat(tombstonePath).catch(() => null)
  ])
  return Boolean(
    canonicalInfo?.isFile() &&
      tombstoneInfo?.isFile() &&
      canonicalInfo.dev === tombstoneInfo.dev &&
      canonicalInfo.ino === tombstoneInfo.ino
  )
}

async function releaseLocalRuntimeRecordLock(lockPath: string, owner: string): Promise<boolean> {
  const info = await stat(lockPath).catch(() => null)
  if (!info) return false
  if (info.isDirectory()) {
    return removeLocalRuntimeRecordLockIf(
      lockPath,
      async (moved) => (await recordLockOwner(moved)) === owner
    )
  }
  const ownerHash = createHash('sha256').update(owner).digest('hex').slice(0, 16)
  const releasePath = `${lockPath}.release-${ownerHash}`
  try {
    await link(lockPath, releasePath)
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException)?.code ?? '')) return false
    throw error
  }
  const [canonicalInfo, releaseInfo, releaseOwner] = await Promise.all([
    stat(lockPath).catch(() => null),
    stat(releasePath).catch(() => null),
    recordLockOwner(releasePath)
  ])
  const ownsCanonical = Boolean(
    canonicalInfo &&
      releaseInfo &&
      canonicalInfo.dev === releaseInfo.dev &&
      canonicalInfo.ino === releaseInfo.ino &&
      releaseOwner === owner
  )
  if (ownsCanonical) await unlink(lockPath)
  await rm(releasePath, { force: true })
  return ownsCanonical
}

/** Run `work` holding the engine folder's record lock (rule 3 above). */
export async function withLocalRuntimeRecordLock<T>(
  engineDir: string,
  work: () => Promise<T>,
  options: { waitMs?: number } = {}
): Promise<T> {
  await mkdir(engineDir, { recursive: true })
  const lockPath = path.join(engineDir, RECORD_LOCK_NAME)
  const owner = `v2:${process.pid}:${await currentProcessStartedAt()}:${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + (options.waitMs ?? RECORD_LOCK_WAIT_MS)
  for (;;) {
    const candidatePath = `${lockPath}.candidate-${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      await writeFile(candidatePath, owner, { encoding: 'utf8', flag: 'wx' })
      // The candidate is complete before the atomic claim. `link` never replaces an existing
      // file or directory, including an ownerless lock left by an older Batshit.
      await link(candidatePath, lockPath)
      await rm(candidatePath, { force: true })
      break
    } catch (error) {
      await rm(candidatePath, { force: true })
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      const info = await stat(lockPath).catch(() => null)
      let blockedOwner: string | null = null
      if (info) {
        const existingOwner = await recordLockOwner(lockPath)
        blockedOwner = existingOwner
        const parsedOwner = parseRecordLockOwner(existingOwner)
        if (!existingOwner) {
          // The owner can release between our first stat and owner read. Reinspect the exact
          // generation before diagnosing a malformed lock; a normal release is a retry.
          const currentInfo = await stat(lockPath).catch(() => null)
          if (!currentInfo || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) continue
        }
        if (parsedOwner && (await recordLockOwnerPidIsAbsent(lockPath))) {
          if (await reapStaleLocalRuntimeRecordLock(lockPath)) continue
        } else if (recordLockIsStale(info) && !parsedOwner) {
          throw new Error(
            `stale launch record lock in ${engineDir} has no valid owner; refusing unsafe takeover`
          )
        } else if (recordLockIsStale(info) && parsedOwner) {
          if (await reapStaleLocalRuntimeRecordLock(lockPath)) continue
        }
      }
      if (Date.now() > deadline) {
        if (blockedOwner && (await staleRecordLockHasClaimedTombstone(lockPath, blockedOwner))) {
          throw new Error(
            `stale launch record lock in ${engineDir} has an incomplete prior reap; refusing unsafe takeover`
          )
        }
        throw new Error(`timed out waiting for the launch record lock in ${engineDir}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      continue
    }
  }
  try {
    return await work()
  } finally {
    await releaseLocalRuntimeRecordLock(lockPath, owner)
  }
}

async function writeRecordAtomically(recordPath: string, contents: LocalVoiceRuntimeLaunchRecord) {
  const temp = path.join(
    path.dirname(recordPath),
    `.batshit-local-runtime-launch.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  const { recordPath: _path, unreadable: _unreadable, ...clean } = contents as StoredLocalVoiceRuntimeLaunchRecord
  try {
    await writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    await rename(temp, recordPath)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

// The same launch: same process, same launch time, same role (own launch or attach).
function sameLaunch(left: LocalVoiceRuntimeLaunchRecord, right: LocalVoiceRuntimeLaunchRecord) {
  return (
    left.pid === right.pid &&
    (left.launchedAt ?? null) === (right.launchedAt ?? null) &&
    (left.startedBy ?? null) === (right.startedBy ?? null)
  )
}

/**
 * The identity of the registry this Batshit uses: a hash of its Redis host, port, and database,
 * with credentials left out, so it names the registry without revealing where or how to reach it.
 */
export async function resolveVoiceRuntimeRegistryIdentity(): Promise<string> {
  const url = resolveRedisConnectionUrl({
    REDIS_URL: await getRuntimeEnv('REDIS_URL'),
    REDIS_HOST: await getRuntimeEnv('REDIS_HOST'),
    REDIS_PORT: await getRuntimeEnv('REDIS_PORT'),
    REDIS_DB: await getRuntimeEnv('REDIS_DB')
  })
  let where = url
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const host = LOOPBACK_HOSTS.has(hostname) ? '127.0.0.1' : hostname
    where = `${host}:${parsed.port || '6379'}/${parsed.pathname.replace(/^\/+/, '') || '0'}`
  } catch {
    // Not a URL: hash it as it is (a hash never reveals it).
  }
  return `redis-${createHash('sha256').update(where).digest('hex').slice(0, 16)}`
}

// Never tells the user to remove the file while the engine it may name still runs (Ashe,
// 2026-10-11). The same words as `local-voice-runtime-stop.mjs`.
function unreadableLaunchRecordWriteError(reason: string): Error {
  return new Error(
    `${reason}. Batshit did not write over it: it may belong to a voice engine that is still running. Once that engine has stopped (restarting the computer stops it), repair or remove the file and try again.`
  )
}

// BL-1275: a readable record already at the moved-aside name names the same process too, maybe
// with another Batshit's choice ("keep running"); renaming over it would erase that choice. Both
// records are kept. It names the runtime that holds the process, so the user knows what to stop.
// The same words as `local-voice-runtime-stop.mjs`.
function movedAsideCollisionError(
  recordPath: string,
  asidePath: string,
  previous: LocalVoiceRuntimeLaunchRecord
): Error {
  const runtime = previous.startedBy || previous.engineId || 'another engine'
  const by = previous.launchedBy ? `, started by ${previous.launchedBy}` : ''
  return new Error(
    `${asidePath} already holds a launch record for process ${previous.pid} (the runtime of engine "${runtime}"${by}), so Batshit did not move ${recordPath} onto it: both records are kept. Try again once that runtime has stopped (restarting the computer stops it).`
  )
}

/**
 * Write an engine's current launch record, stamped with this registry. An earlier record whose
 * process is still running is moved aside under its pid, never overwritten (rule 1 above). A
 * record that cannot be read, the current one or the moved-aside name a running previous launch
 * would take, is never written over (BL-1267): this throws and the file stays, because it may name
 * a process that still runs. Nor is a readable record at that moved-aside name renamed over
 * (BL-1275): this throws and both records stay. The launch then fails; its caller stops the runtime it could not
 * record (on macOS and Linux, BL-1252 Part 1's launcher, which lands with this rule).
 */
export async function writeLocalRuntimeLaunchRecord(
  record: LocalVoiceRuntimeLaunchRecord & { engineId: string; pid: number }
): Promise<void> {
  const recordPath = resolveLocalVoiceRuntimeLaunchRecordPath(record.engineId)
  const stamped = { ...record, registry: await resolveVoiceRuntimeRegistryIdentity() }
  await withLocalRuntimeRecordLock(path.dirname(recordPath), () => writeLaunchRecordLocked(recordPath, stamped))
}

// The body of `writeLocalRuntimeLaunchRecord`, for a caller that already holds the folder's lock.
// The current record is moved aside first when its process still runs and it is another launch
// (another pid), or the same process recorded by ANOTHER registry (BL-1286): each registry's record
// of a process carries that registry's own choice, so it is kept beside, never replaced. A record
// with no registry is not this registry's (its owner cannot be established). Only this registry's
// own record of the same process is replaced in place.
async function writeLaunchRecordLocked(
  recordPath: string,
  stamped: LocalVoiceRuntimeLaunchRecord & { engineId: string; pid: number; registry: string }
): Promise<void> {
  const current = await readRecordFileState(recordPath)
  if (current.state === 'unreadable') throw unreadableLaunchRecordWriteError(current.reason)
  const previous = current.state === 'record' ? current.record : null
  if (
    previous &&
    isLocalRuntimeProcessAlive(previous.pid) &&
    (previous.pid !== stamped.pid || previous.registry !== stamped.registry)
  ) {
    const asidePath = path.join(path.dirname(recordPath), `.batshit-local-runtime-launch.${previous.pid}.json`)
    const aside = await readRecordFileState(asidePath)
    if (aside.state === 'unreadable') throw unreadableLaunchRecordWriteError(aside.reason)
    if (aside.state === 'record') throw movedAsideCollisionError(recordPath, asidePath, previous)
    await rename(recordPath, asidePath)
  }
  await writeRecordAtomically(recordPath, stamped)
}

/**
 * Change fields of a stored record, only if its file still holds that same launch (it may have
 * been moved aside, replaced, or removed since it was read). Answers whether it did.
 */
export async function updateLocalRuntimeLaunchRecord(
  record: StoredLocalVoiceRuntimeLaunchRecord,
  changes: Partial<LocalVoiceRuntimeLaunchRecord>
): Promise<boolean> {
  return withLocalRuntimeRecordLock(path.dirname(record.recordPath), async () => {
    const current = await readRecordFileState(record.recordPath)
    if (current.state !== 'record' || !sameLaunch(current.record, record)) return false
    await writeRecordAtomically(record.recordPath, { ...current.record, ...changes })
    return true
  })
}

/**
 * Set one engine's "Stop with Batshit" choice in every record THIS registry wrote for it (its
 * current launch, any launch moved aside, an attach record), reading them afresh under its
 * folder's lock: a launch that moved a record aside or wrote a new one meanwhile is seen as it is
 * now, never written back over. Another registry's record (another Batshit on this computer with
 * the same engine id), or one with no registry, is that Batshit's own choice and is never written
 * (BL-1286). A record that could not be read is left as it is (BL-1268) and its reason returned in
 * `unreadable`. Answers whether anything changed and whether any of THIS registry's readable
 * records names a live process, so another registry's live record never stands in for this
 * registry's own attachment.
 */
export async function setLocalRuntimeStopChoice(
  engineId: string,
  stopOnShutdown: boolean
): Promise<{ changed: boolean; live: boolean; unreadable: string[] }> {
  const dir = resolveLocalVoiceRuntimeStateDir(engineId)
  try {
    await stat(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { changed: false, live: false, unreadable: [] }
    return { changed: false, live: false, unreadable: [`the folder ${dir} could not be read (${errorCode(error)})`] }
  }
  const registry = await resolveVoiceRuntimeRegistryIdentity()
  return withLocalRuntimeRecordLock(dir, async () => {
    const entries = await listLocalRuntimeLaunchRecords(engineId)
    const records = entries.filter(isReadable).filter((record) => record.registry === registry)
    let changed = false
    for (const record of records) {
      if (record.stopOnShutdown === stopOnShutdown) continue
      await writeRecordAtomically(record.recordPath, { ...record, stopOnShutdown })
      changed = true
    }
    return {
      changed,
      live: records.some((record) => isLocalRuntimeProcessAlive(record.pid)),
      unreadable: entries.flatMap((entry) => (entry.unreadable ? [entry.reason] : []))
    }
  })
}

/** Remove a stored record, only if its file still holds that same launch (never an unreadable one). */
async function removeLocalRuntimeLaunchRecord(record: StoredLocalVoiceRuntimeLaunchRecord) {
  return withLocalRuntimeRecordLock(path.dirname(record.recordPath), async () => {
    const current = await readRecordFileState(record.recordPath)
    if (current.state !== 'record' || !sameLaunch(current.record, record)) return false
    await rm(record.recordPath, { force: true })
    return true
  })
}

/** An engine as the prune sees it: its id, base URL, and whether it has a launch recipe. */
export type VerifiedRuntimeUse =
  | { outcome: 'recorded' }
  | { outcome: 'own' }
  | { outcome: 'external' }
  | { outcome: 'unrecordable'; reason: string }

/**
 * Record that this Batshit uses a process it found already serving `endpoint` (BL-1298): an
 * attach record beside the launch that started it, holding this Batshit's own choice, so that
 * launch's Batshit cannot stop or restart it unseen. Verified against the live `listeners` (and
 * the process groups they are in), never adopted from a port alone:
 * - no Batshit record names a listener: "external" (Batshit did not start it; nothing recorded,
 *   never owned);
 * - this Batshit's own launch of `engineId` names it, or its attachment already holds this
 *   choice: "own";
 * - another Batshit's launch, or one of unknown owner, of that address: its attach record is
 *   written (R-1l): "recorded";
 * - a Batshit record names it but no attach can be written (its launch records no address, as
 *   launches before 2026-10-11 did; the moved-aside name is taken; a record cannot be read):
 *   "unrecordable", and the caller refuses to use the process rather than use it unrecorded.
 */
export async function recordVerifiedRuntimeUse(options: {
  engineId: string
  endpoint: string
  stopOnShutdown: boolean
  listeners: readonly number[]
}): Promise<VerifiedRuntimeUse> {
  const endpoint = normalizeLocalRuntimeEndpoint(options.endpoint)
  if (!endpoint || options.listeners.length === 0) return { outcome: 'external' }
  const { unreadable, naming, ours } = await readRuntimeUse(options.engineId, options.listeners)
  if (unreadable.length > 0) return { outcome: 'unrecordable', reason: unreadable.join('; ') }
  if (naming.length === 0) return { outcome: 'external' }
  if (ours.some((entry) => !entry.startedBy)) return { outcome: 'own' }
  try {
    const written = await attachLocalRuntimeLaunchRecord({
      engineId: options.engineId,
      endpoint: options.endpoint,
      stopOnShutdown: options.stopOnShutdown,
      listeners: options.listeners
    })
    if (written) return { outcome: 'recorded' }
  } catch (error) {
    return { outcome: 'unrecordable', reason: error instanceof Error ? error.message : String(error) }
  }
  if (ours.length > 0) return { outcome: 'own' }
  return {
    outcome: 'unrecordable',
    reason: `process ${naming[0].pid} was started by another Batshit (${naming.map((entry) => entry.recordPath).join(', ')}), and its launch record carries no address for ${endpoint}, so this Batshit cannot record that it uses it`
  }
}

/** The records of `engineId` that name a listener or its process group, read only. */
async function readRuntimeUse(engineId: string, listeners: readonly number[]) {
  const registry = await resolveVoiceRuntimeRegistryIdentity()
  const candidates = new Set<number>([...listeners, ...(await readProcessGroupIds(listeners))])
  const entries = await listLocalRuntimeLaunchRecords()
  const unreadable = entries.flatMap((entry) =>
    entry.unreadable && (entry.engineId === null || entry.engineId === engineId) ? [entry.reason] : []
  )
  const naming = entries.filter(isReadable).filter((entry) => typeof entry.pid === 'number' && candidates.has(entry.pid))
  const ours = naming.filter((entry) => entry.registry === registry && entry.engineId === engineId)
  return { unreadable, naming, ours }
}

/**
 * Read only: does this Batshit hold a record of the process at `listeners` that it uses? Another
 * Batshit's relaunch writes over this one's dead attach, so a use recorded once can become
 * unrecorded until this Batshit records it again; this lets the caller say so (BL-1298).
 * "external": no Batshit record names it; "recorded": this registry has one; "unrecorded": only
 * another Batshit's (or an unknown owner's) does; "unreadable": a record in its folder cannot be read.
 */
export async function readRuntimeUseState(
  engineId: string,
  listeners: readonly number[]
): Promise<'external' | 'recorded' | 'unrecorded' | 'unreadable'> {
  if (listeners.length === 0) return 'external'
  const { unreadable, naming, ours } = await readRuntimeUse(engineId, listeners)
  if (unreadable.length > 0) return 'unreadable'
  if (naming.length === 0) return 'external'
  return ours.length > 0 ? 'recorded' : 'unrecorded'
}

export type OwnLaunchCheck =
  | { verified: true; record: StoredLocalVoiceRuntimeLaunchRecord }
  | { verified: false; refusal: 'unknown' | 'foreign' | 'unreadable' | 'unverified' | 'unaddressed'; reason: string }

/**
 * Is what answers at `endpoint` (its live `listeners`) this Batshit's own current launch of
 * `engineId` (BL-1311)? For a runtime that serves only the Batshit that launched it (the LiveKit
 * agent sidecar), nothing else counts as ready. This registry's own LAUNCH record (not an attach)
 * must name a listener or its process group, record this address, and the live process must still
 * be that launch (the pid-reuse guard). Otherwise the caller refuses it visibly, never stops or adopts it:
 * - "unknown": no Batshit record names it (a worker someone else started; whom it serves cannot be
 *   told from outside);
 * - "foreign": only records of another Batshit, an unknown owner, or an attach name it;
 * - "unreadable": a record in its folder, or the records folder, cannot be read;
 * - "unverified": this Batshit's launch record names it, but the process is no longer that launch;
 * - "unaddressed": it IS this Batshit's own current launch, but its record carries no address, or
 *   another one (launched before records carried it, or since the port changed). The caller may
 *   restart it on the user's request, through the sole-ownership stop, so the new launch records it.
 */
export async function verifyOwnLaunchServes(options: {
  engineId: string
  endpoint: string
  listeners: readonly number[]
}): Promise<OwnLaunchCheck> {
  const endpoint = normalizeLocalRuntimeEndpoint(options.endpoint)
  const { unreadable, naming, ours } = await readRuntimeUse(options.engineId, options.listeners)
  if (unreadable.length > 0) return { verified: false, refusal: 'unreadable', reason: unreadable.join('; ') }
  if (options.listeners.length === 0 || naming.length === 0) {
    return { verified: false, refusal: 'unknown', reason: 'no launch record of this Batshit names the process answering there' }
  }
  const own = ours
    .filter((entry) => !entry.startedBy)
    .sort((left, right) => Date.parse(right.launchedAt ?? '') - Date.parse(left.launchedAt ?? ''))[0]
  if (!own) {
    return {
      verified: false,
      refusal: 'foreign',
      reason: `it was started by another Batshit (${naming.map((entry) => entry.recordPath).join(', ')})`
    }
  }
  const pid = own.pid as number
  const group = await readProcessGroup(pid)
  if (group === null) {
    return { verified: false, refusal: 'unverified', reason: `Batshit could not read process ${pid}'s command line to confirm it is its own launch` }
  }
  const isThisLaunch =
    launchRecordNamesLeader(own, group.leaderStartedAtMs) ??
    group.commandLines.some((line) => launchRecordMatchesCommand(own, line))
  if (!isThisLaunch) {
    return { verified: false, refusal: 'unverified', reason: `process ${pid} is no longer the one Batshit launched (its process id was reused)` }
  }
  if (!endpoint || normalizeLocalRuntimeEndpoint(own.endpoint) !== endpoint) {
    return {
      verified: false,
      refusal: 'unaddressed',
      reason: `this Batshit's own launch record of it (${own.recordPath}) records no address, or another one, so Batshit cannot confirm it serves ${endpoint ?? options.endpoint}`
    }
  }
  return { verified: true, record: own }
}

export type LocalRuntimeEngineRef = {
  id: string
  baseUrl?: string | null
  localRuntime?: { launch?: { command?: string } | null } | null
}

/**
 * Bring this registry's records in line with its engines (rule 4 above). Called after every
 * registry write (a delete or a base URL change from any writer) and on every native boot:
 * - an attach record goes when its engine is gone, lost its recipe, or uses another endpoint;
 * - a deleted engine's own launch keeps its record (the process still runs, so a stopper must
 *   still find it) but loses a saved "keep running", which no switch could change any more.
 * Records another registry wrote are never touched.
 */
export async function pruneLocalRuntimeLaunchRecords(
  engines: LocalRuntimeEngineRef[]
): Promise<{ removed: string[]; released: string[] }> {
  const registry = await resolveVoiceRuntimeRegistryIdentity()
  const byId = new Map(
    engines
      .filter((engine) => engine.localRuntime?.launch?.command)
      .map((engine) => [engine.id, engine] as const)
  )
  const removed: string[] = []
  const released: string[] = []
  for (const record of (await listLocalRuntimeLaunchRecords()).filter(isReadable)) {
    if (record.registry !== registry || !record.engineId) continue
    const engine = byId.get(record.engineId)
    if (record.startedBy) {
      const stillUsed =
        engine &&
        normalizeLocalRuntimeEndpoint(engine.baseUrl) === normalizeLocalRuntimeEndpoint(record.endpoint)
      if (!stillUsed && (await removeLocalRuntimeLaunchRecord(record))) removed.push(record.recordPath)
    } else if (!engine && record.stopOnShutdown === false) {
      if (await updateLocalRuntimeLaunchRecord(record, { stopOnShutdown: undefined })) {
        released.push(record.recordPath)
      }
    }
  }
  return { removed, released }
}

/**
 * Record that `engineId` uses a runtime another engine's launch started (rule 2 above), or
 * another Batshit's launch of this same engine id (BL-1293: that Batshit's record holds only its
 * own choice).
 *
 * Returns true when an attach record was written. False means there was nothing to attach
 * to: no live Batshit launch record serves this endpoint (so Batshit did not start whatever
 * answers there), or this Batshit's own launch of this engine started it and its own record
 * already speaks, or this registry's attachment to that process already holds this choice.
 */
export async function attachLocalRuntimeLaunchRecord(options: {
  engineId: string
  endpoint: string | null | undefined
  stopOnShutdown: boolean
  /**
   * The live processes listening at `endpoint` (BL-1298). When given, the starter must name one of
   * them or the process group one is in, so a record whose pid now belongs to something else is
   * never attached to.
   */
  listeners?: readonly number[]
}): Promise<boolean> {
  const endpoint = normalizeLocalRuntimeEndpoint(options.endpoint)
  if (!endpoint) return false
  const listening = options.listeners
    ? new Set<number>([...options.listeners, ...(await readProcessGroupIds(options.listeners))])
    : null

  const starters = (await listLocalRuntimeLaunchRecords())
    .filter(isReadable)
    .filter(
      (record) =>
        !record.startedBy &&
        normalizeLocalRuntimeEndpoint(record.endpoint) === endpoint &&
        isLocalRuntimeProcessAlive(record.pid) &&
        (listening === null || (typeof record.pid === 'number' && listening.has(record.pid)))
    )
    .sort((left, right) => Date.parse(right.launchedAt ?? '') - Date.parse(left.launchedAt ?? ''))
  const starter = starters[0]
  if (!starter || typeof starter.pid !== 'number' || !starter.engineId) return false
  const registry = await resolveVoiceRuntimeRegistryIdentity()
  // This Batshit's own launch of this very engine already carries its choice (the switch writes
  // it). Another Batshit's launch of the same engine id, or one of unknown owner, does not: this
  // Batshit records its own attachment beside it, so its choice is kept and counts (BL-1293).
  if (starter.engineId === options.engineId && starter.registry === registry) return false
  const starterPid = starter.pid
  const starterEngineId = starter.engineId
  const starterLaunchedAt = starter.launchedAt ?? null

  const recordPath = resolveLocalVoiceRuntimeLaunchRecordPath(options.engineId)
  const dir = path.dirname(recordPath)
  return withLocalRuntimeRecordLock(dir, async () => {
    // This registry's own attachment to this very process, wherever it lies now (current or moved
    // aside), is refreshed in place: only its choice changes (BL-1275, BL-1286). Taking the
    // current name again would move another record aside for nothing, and a later launch would
    // then find that aside name taken. The record must name this very launch of the process (pid AND
    // launch time, as `sameLaunch` does): an older attachment whose pid a newer launch took is not
    // it, and the writer below records the new launch instead. Ownership and identity are checked
    // again on the file as it is now.
    const isThisAttachment = (candidate: LocalVoiceRuntimeLaunchRecord) =>
      candidate.registry === registry &&
      candidate.startedBy === starterEngineId &&
      candidate.pid === starterPid &&
      (candidate.launchedAt ?? null) === starterLaunchedAt &&
      normalizeLocalRuntimeEndpoint(candidate.endpoint) === endpoint
    for (const entry of await readEngineRecords(dir, options.engineId)) {
      if (!isReadable(entry) || !isThisAttachment(entry)) continue
      const now = await readRecordFileState(entry.recordPath)
      if (now.state !== 'record' || !isThisAttachment(now.record)) continue
      if (now.record.stopOnShutdown === options.stopOnShutdown) return false
      await writeRecordAtomically(entry.recordPath, { ...now.record, stopOnShutdown: options.stopOnShutdown })
      return true
    }
    // A refusal here (an aside name taken or unreadable) throws to the caller and stops nothing:
    // the runtime is another engine's launch, which keeps running.
    await writeLaunchRecordLocked(recordPath, {
      engineId: options.engineId,
      pid: starterPid,
      command: starter.command,
      // Never a secret the starter's record still holds, from before BL-1332 (and never more than the
      // paths the identity check reads).
      args: launchArgsForAttach(starter.args),
      cwd: starter.cwd,
      logPath: starter.logPath,
      launchedAt: starter.launchedAt,
      ...(starter.launchedBy ? { launchedBy: starter.launchedBy } : {}),
      endpoint,
      startedBy: starterEngineId,
      stopOnShutdown: options.stopOnShutdown,
      registry
    })
    return true
  })
}

// ---- Stopping a deleted engine's runtime ("Delete local files too") ------------------------

const DELETE_STOP_GRACE_MS = 2_000

/**
 * Does one live process-group member look like the process this record launched? Twin of
 * `launchRecordMatchesCommand` in `batshit-mac/scripts/local-voice-runtime-stop.mjs`: absolute
 * command, cwd, or argument paths in the command line, else the command's base name.
 */
function launchRecordMatchesCommand(record: LocalVoiceRuntimeLaunchRecord, commandLine: string) {
  const absolute = [record.command, record.cwd, ...(Array.isArray(record.args) ? record.args : [])].filter(
    (value): value is string => typeof value === 'string' && value.startsWith('/')
  )
  if (absolute.some((candidate) => commandLine.includes(candidate))) return true
  const base = typeof record.command === 'string' ? record.command.split('/').pop() : ''
  return Boolean(base) && commandLine.includes(base as string)
}

// Launch flags whose value is a secret: LiveKit's `--keys` ("key: secret") and `--config-body` (a
// YAML config that can hold `keys:`), with one or two dashes, the value next or after "=".
const SECRET_LAUNCH_FLAGS = new Set(['keys', 'config-body'])

/**
 * The args an attach copies from the launch it uses (BL-1332). First every secret flag and its
 * value is dropped, so a secret that looks like a path is never left to the path filter. Then only
 * absolute paths are kept, in POSIX or Windows form: all any identity check reads
 * (`launchRecordMatchesCommand` takes "/" paths, the Docker operator's `path.isAbsolute` ones,
 * which on Windows include `C:\…`). Twin of `launchArgsForAttach` in
 * `batshit-mac/scripts/local-voice-runtime-stop.mjs`.
 */
export function launchArgsForAttach(args: unknown): string[] | undefined {
  if (!Array.isArray(args)) return undefined
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (typeof arg !== 'string') continue
    const flag = /^--?([^=]+)(=[\s\S]*)?$/.exec(arg)
    if (flag && SECRET_LAUNCH_FLAGS.has(flag[1])) {
      if (flag[2] === undefined) index += 1 // its value is the next arg
      continue
    }
    if (path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg)) kept.push(arg)
  }
  return kept
}

/**
 * Is the live group leader the process this record's launch started? Twin of
 * `launchRecordNamesLeader` in `local-voice-runtime-stop.mjs` (2026-09-21, BL-60): `launchedAt` is
 * written after the spawn and a pid is only reused once its process is gone, so a leader that
 * started no later than it IS that launch's process, whatever its command line says now (a
 * python.org framework Python re-executes itself as `…/Python.app/Contents/MacOS/Python`, which
 * holds none of the recorded paths). A leader that started more than a minute before the record
 * is outside what a launch can explain (a clock set back since), so the start time proves nothing
 * there. Null in that case and when either time is unknown: fall back to the command.
 */
const LAUNCH_RECORD_WRITE_WINDOW_MS = 60_000

export function launchRecordNamesLeader(
  record: LocalVoiceRuntimeLaunchRecord,
  leaderStartedAtMs: number | null
): boolean | null {
  if (typeof leaderStartedAtMs !== 'number' || !Number.isFinite(leaderStartedAtMs)) return null
  const launchedAtMs = Date.parse(record.launchedAt ?? '')
  if (!Number.isFinite(launchedAtMs)) return null
  if (leaderStartedAtMs > launchedAtMs) return false
  if (leaderStartedAtMs < launchedAtMs - LAUNCH_RECORD_WRITE_WINDOW_MS) return null
  return true
}

const PS_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
}
const PS_START_TIME = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/
const PS_GROUP_ROW = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/

/** A `ps -o lstart=` time printed in the C locale and UTC, as epoch ms, or null. */
export function parsePsStartTimeUtc(value: string): number | null {
  const match = PS_START_TIME.exec(value.trim())
  if (!match || !(match[1] in PS_MONTHS)) return null
  const ms = Date.UTC(
    Number(match[6]),
    PS_MONTHS[match[1]],
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  )
  return Number.isFinite(ms) ? ms : null
}

/**
 * A process group's live members' command lines, and its leader's start time when the pid still
 * leads its own group, or null when `ps` itself failed. Twin of `readLocalRuntimeProcessGroup`.
 * Read from the whole table: `ps -g` exits 1 for an empty group, which is what a reused pid looks
 * like. `ps` prints `lstart` in the user's language and time zone, so it runs in C and UTC.
 */
async function readProcessGroup(
  pgid: number
): Promise<{ commandLines: string[]; leaderStartedAtMs: number | null } | null> {
  // Called here, not wrapped at import, so a test that stubs child_process for spawn only can
  // still import this module.
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,pgid=,lstart=,command='],
      {
        timeout: 3_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' }
      },
      (error, output) => resolve(error ? null : String(output))
    )
  })
  if (stdout === null) return null
  const commandLines: string[] = []
  let leaderStartedAtMs: number | null = null
  for (const line of stdout.split('\n')) {
    const match = PS_GROUP_ROW.exec(line)
    if (!match || Number(match[2]) !== pgid) continue
    commandLines.push(match[4])
    if (Number(match[1]) === pgid) leaderStartedAtMs = parsePsStartTimeUtc(match[3])
  }
  return { commandLines, leaderStartedAtMs }
}

/** The process groups `pids` are in, from the whole process table; none when `ps` failed. */
async function readProcessGroupIds(pids: readonly number[]): Promise<number[]> {
  if (pids.length === 0) return []
  const stdout = await new Promise<string | null>((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,pgid='], { timeout: 3_000, maxBuffer: 16 * 1024 * 1024 }, (error, output) =>
      resolve(error ? null : String(output))
    )
  })
  if (stdout === null) return []
  const groups = new Set<number>()
  for (const line of stdout.split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    if (pids.includes(pid) && Number.isInteger(pgid) && pgid > 0) groups.add(pgid)
  }
  return [...groups]
}

function processGroupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function terminateProcessGroup(pgid: number): Promise<boolean> {
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return true
  }
  const deadline = Date.now() + DELETE_STOP_GRACE_MS
  while (Date.now() < deadline) {
    if (!processGroupAlive(pgid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return true
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  return !processGroupAlive(pgid)
}

export type DeletedEngineRuntimeStop = {
  stopped: number[]
  /** Still used by an engine that is not being deleted: left running, and still recorded there. */
  keptForOtherEngines: number[]
  notStopped: Array<{ pid: number; reason: string }>
  /**
   * Launch records that could not be read and could name this engine's process (BL-1268). While
   * there is one, nothing was stopped, and the caller keeps the files and the records.
   */
  unreadable: Array<{ recordPath: string; reason: string }>
}

/**
 * Before "Delete local files too" removes an engine's files and launch records, stop what the
 * engine's own launches still run: otherwise the process runs on from a deleted folder and no
 * shutdown path can ever stop it again. The shared-runtime rule holds (a process another engine
 * that is not being deleted still uses keeps running; that engine's attach record keeps naming
 * it), and so does the pid-reuse guard (a pid whose leader started after the record's launch, or,
 * with no leader, whose group no longer matches the record, is not this engine's process and is
 * left alone). A process that could not be checked or stopped is reported, and the caller keeps
 * the files and the record.
 *
 * A record that could not be read (BL-1268) stops nothing and keeps the files when it could name
 * this engine's process: one in this engine's own folder (or a state root that could not be read),
 * which may be a launch of it that still runs and would itself be deleted with the folder; or, while
 * this engine still runs a launch of its own, one of an engine that is not being deleted, which may
 * be that engine's attach record to it. One of another engine being deleted with it has no say (its
 * own deletion reports it).
 */
export async function stopDeletedEngineRuntimes(
  engineId: string,
  deletingEngineIds: ReadonlySet<string> = new Set([engineId])
): Promise<DeletedEngineRuntimeStop> {
  const result: DeletedEngineRuntimeStop = { stopped: [], keptForOtherEngines: [], notStopped: [], unreadable: [] }
  const registry = await resolveVoiceRuntimeRegistryIdentity()
  const entries = await listLocalRuntimeLaunchRecords()
  const all = entries.filter(isReadable)
  // Only this Batshit's launches of the engine (BL-1289). Another Batshit on this computer can run
  // an engine with the same id from the same folders; it did not delete it, so its launch keeps
  // running, and a record with no registry (owner unknown) is never treated as this one's.
  const own = all.filter((entry) => entry.engineId === engineId && !entry.startedBy && entry.registry === registry)
  const runsOwnLaunch = own.some((record) => isLocalRuntimeProcessAlive(record.pid))
  for (const entry of entries) {
    if (!entry.unreadable) continue
    const mayNameIt =
      entry.engineId === null ||
      entry.engineId === engineId ||
      (runsOwnLaunch && !deletingEngineIds.has(entry.engineId))
    if (mayNameIt) result.unreadable.push({ recordPath: entry.recordPath, reason: entry.reason })
  }
  if (result.unreadable.length > 0) return result
  for (const record of own) {
    const pid = record.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue
    if (!isLocalRuntimeProcessAlive(pid) || result.stopped.includes(pid)) continue
    // Another engine that is not being deleted, or any record another Batshit wrote, still uses it.
    const usedElsewhere = all.some(
      (other) =>
        other.pid === pid &&
        Boolean(other.engineId) &&
        (other.registry !== registry || !deletingEngineIds.has(other.engineId as string))
    )
    if (usedElsewhere) {
      result.keptForOtherEngines.push(pid)
      continue
    }
    const group = await readProcessGroup(pid)
    if (group === null) {
      result.notStopped.push({ pid, reason: `could not read pid ${pid}'s command line to confirm it is this engine` })
      continue
    }
    const isThisLaunch =
      launchRecordNamesLeader(record, group.leaderStartedAtMs) ??
      group.commandLines.some((line) => launchRecordMatchesCommand(record, line))
    if (!isThisLaunch) continue
    if (await terminateProcessGroup(pid)) result.stopped.push(pid)
    else result.notStopped.push({ pid, reason: `pid ${pid} did not stop after SIGKILL` })
  }
  return result
}

export type DeletedEngineFilesRemoval =
  | { removed: true; installRootRemoved: boolean; stateRootRemoved: boolean }
  | { removed: false; sharedRecordPaths: string[]; unreadable: string[] }

/**
 * "Delete local files too", the files (BL-1289). The install folder (`installs/<id>`) and the
 * engine's state folder are shared by every Batshit on this computer that keeps the default folders
 * (the packaged Mac app, native source launches, worktree lanes). So the decision is made under the engine
 * folder's record lock, which every cooperating writer takes before it writes a record, on the
 * records as they are now:
 * - a record another Batshit wrote, or one with no registry (owner unknown), or one that cannot be
 *   read means the folders are not this Batshit's alone; so does a record in another engine's
 *   folder (of any Batshit) that names a running launch of this one, an attach to a runtime that
 *   still runs from these files; and so does a live record of the Docker host operator's, read
 *   from its own folder and never changed, of this engine id or naming a path in these folders, or
 *   one of its records that cannot be read (BL-1292). Then nothing is removed except this
 *   registry's own records whose process is gone, and the caller says what was kept and why;
 * - otherwise the install folder and the state folder's contents are removed (the lock last, by
 *   its release), and the empty folder after it, unless a writer has used it meanwhile.
 * A Batshit that has this engine installed but never launched it leaves no record, so it cannot be
 * seen here.
 */
export async function removeDeletedEngineFiles(
  engineId: string,
  installRoot: string
): Promise<DeletedEngineFilesRemoval> {
  const registry = await resolveVoiceRuntimeRegistryIdentity()
  const dir = resolveLocalVoiceRuntimeStateDir(engineId)
  const stateRootExisted = await stat(dir).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  )
  const outcome = await withLocalRuntimeRecordLock(dir, async (): Promise<DeletedEngineFilesRemoval> => {
    const entries = await readEngineRecords(dir, engineId)
    const unreadable = entries.flatMap((entry) => (entry.unreadable ? [entry.reason] : []))
    const shared = entries.filter((entry) => isReadable(entry) && entry.registry !== registry)
    // A running launch of this engine another engine still uses: that engine's attach record is in
    // its own folder. The process runs from these files, so they stay with it. Only launches: an
    // attach record here names another engine's runtime, which runs from that engine's files.
    const runningOwn = new Set(
      entries
        .filter(isReadable)
        .filter((entry) => !entry.startedBy && entry.registry === registry && isLocalRuntimeProcessAlive(entry.pid))
        .map((entry) => entry.pid)
    )
    if (runningOwn.size > 0) {
      for (const entry of await listLocalRuntimeLaunchRecords()) {
        if (isReadable(entry) && entry.engineId !== engineId && runningOwn.has(entry.pid)) shared.push(entry)
      }
    }
    // What the Docker host operator started (BL-1292) can run from these same folders: it keeps
    // the records in its own folder, which Batshit only reads (never its lock, never a write). A
    // live one of this engine id, or one whose command, folder, log or argument paths lie in these
    // folders, keeps them; one that cannot be read keeps them too, since it could be either.
    const folders = [
      ...new Set(
        (await Promise.all([installRoot, dir].map(async (target) => [path.resolve(target), await realpath(target).catch(() => path.resolve(target))]))).flat()
      )
    ]
    const inFolders = (value: unknown) =>
      typeof value === 'string' && path.isAbsolute(value) && folders.some((folder) => value === folder || value.startsWith(`${folder}${path.sep}`))
    for (const entry of await readRecordsRoot(resolveOperatorVoiceStateRoot(), "the Docker host operator's voice records folder")) {
      if (!isReadable(entry)) {
        unreadable.push(entry.reason)
        continue
      }
      if (!isLocalRuntimeProcessAlive(entry.pid)) continue
      const named = [entry.command, entry.cwd, entry.logPath, ...(Array.isArray(entry.args) ? entry.args : [])]
      if (entry.engineId === engineId || named.some(inFolders)) shared.push(entry)
    }
    if (unreadable.length > 0 || shared.length > 0) {
      for (const entry of entries) {
        if (!isReadable(entry) || entry.registry !== registry || isLocalRuntimeProcessAlive(entry.pid)) continue
        await rm(entry.recordPath, { force: true })
      }
      return { removed: false, sharedRecordPaths: shared.map((entry) => entry.recordPath), unreadable }
    }
    const installRootExisted = await stat(installRoot).then(
      () => true,
      () => false
    )
    await rm(installRoot, { recursive: true, force: true })
    for (const name of await readdir(dir)) {
      // The lock and its bookkeeping (a waiter's candidate, a release, a reap tombstone) stay: a
      // waiting writer may be using one right now. The lock goes with its release.
      if (name.startsWith(RECORD_LOCK_NAME) || name.startsWith(RECORD_LOCK_TOMBSTONE_PREFIX)) continue
      await rm(path.join(dir, name), { recursive: true, force: true })
    }
    return { removed: true, installRootRemoved: installRootExisted, stateRootRemoved: stateRootExisted }
  })
  if (!outcome.removed) return outcome
  // A writer that took the lock after this one may have used the folder: then it stays, and the
  // result does not say it went.
  const folderGone = await rmdir(dir).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') return true
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false
      throw error
    }
  )
  return { ...outcome, stateRootRemoved: outcome.stateRootRemoved && folderGone }
}

export type SolelyOwnedRestartStop =
  | { stopped: true; record: StoredLocalVoiceRuntimeLaunchRecord }
  | { stopped: false; refusal: 'not-started'; pids: number[] }
  | { stopped: false; refusal: 'shared'; pid: number; recordPaths: string[] }
  | { stopped: false; refusal: 'unreadable'; reasons: string[] }
  | { stopped: false; refusal: 'unverified'; pid: number; reason: string }

/**
 * Stop a running launch for a restart only when this Batshit alone owns it (BL-1296). A restart
 * that stops a process several Batshits share would take it down under the others, whatever they
 * chose. Decided under `engineId`'s record lock, on every record as it is then:
 * - this registry's own launch record of `engineId` (not an attach) must name one of `pids` (the
 *   live processes found by the caller) or the process group one of them is in: `not-started` when no record names it, `shared` when only
 *   records of another Batshit, an unknown owner or an attach do;
 * - no other record may name that process: another Batshit's, one with no registry (owner
 *   unknown), or any attach (another engine uses it): `shared`;
 * - a record that cannot be read could be any of those: `unreadable`;
 * - the live process must still be that launch (the pid-reuse guard of the delete stop: its leader
 *   started by the launch time, else its command line names the launch), or a reused pid could be
 *   anyone's, another Batshit's whose records are elsewhere included: `unverified`.
 * Only then `stop(record)` runs, still under the lock, so no cooperating writer records a use of
 * that process in this folder between the decision and the signal. A refusal signals nothing and
 * changes no record; the caller says why.
 */
export async function stopSolelyOwnedLaunchForRestart(
  engineId: string,
  pids: readonly number[],
  stop: (record: StoredLocalVoiceRuntimeLaunchRecord) => Promise<void>
): Promise<SolelyOwnedRestartStop> {
  const registry = await resolveVoiceRuntimeRegistryIdentity()
  return withLocalRuntimeRecordLock(path.dirname(resolveLocalVoiceRuntimeLaunchRecordPath(engineId)), async () => {
    const entries = await listLocalRuntimeLaunchRecords()
    const reasons = entries.flatMap((entry) => (entry.unreadable ? [entry.reason] : []))
    if (reasons.length > 0) return { stopped: false, refusal: 'unreadable', reasons }
    const readable = entries.filter(isReadable)
    // A listener can be a child of the launch (the LiveKit sidecar's worker under its tsx launcher),
    // and a launch record names the group leader: a listener's process group counts as well.
    const candidates = new Set<number>([...pids, ...(await readProcessGroupIds(pids))])
    const naming = readable.filter((entry) => typeof entry.pid === 'number' && candidates.has(entry.pid))
    const own = naming
      .filter((entry) => entry.engineId === engineId && !entry.startedBy && entry.registry === registry)
      .sort((left, right) => Date.parse(right.launchedAt ?? '') - Date.parse(left.launchedAt ?? ''))[0]
    if (!own) {
      // Recorded, but not as this Batshit's own launch: another Batshit (or an owner unknown) has it.
      return naming.length > 0
        ? { stopped: false, refusal: 'shared', pid: naming[0].pid as number, recordPaths: naming.map((entry) => entry.recordPath) }
        : { stopped: false, refusal: 'not-started', pids: [...pids] }
    }
    const others = readable.filter((entry) => entry.pid === own.pid && entry.recordPath !== own.recordPath)
    if (others.length > 0) {
      return { stopped: false, refusal: 'shared', pid: own.pid as number, recordPaths: others.map((entry) => entry.recordPath) }
    }
    const pid = own.pid as number
    const group = await readProcessGroup(pid)
    if (group === null) {
      return { stopped: false, refusal: 'unverified', pid, reason: `Batshit could not read process ${pid}'s command line to confirm it is its own launch` }
    }
    const isThisLaunch =
      launchRecordNamesLeader(own, group.leaderStartedAtMs) ??
      group.commandLines.some((line) => launchRecordMatchesCommand(own, line))
    if (!isThisLaunch) {
      return { stopped: false, refusal: 'unverified', pid, reason: `process ${pid} is no longer the one Batshit launched (its process id was reused)` }
    }
    await stop(own)
    return { stopped: true, record: own }
  })
}

/** The Batshit this process is, as its launcher named it (see `launchedBy`), or undefined. */
export function resolveVoiceRuntimeLaunchOwner(): string | undefined {
  const owner = process.env.BATSHIT_VOICE_RUNTIME_OWNER?.trim()
  return owner ? owner : undefined
}
