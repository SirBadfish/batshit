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
import { link, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import {
  resolveLocalVoiceRuntimeLaunchRecordPath,
  resolveLocalVoiceRuntimeStateDir,
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
}

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

async function readRecordFile(recordPath: string): Promise<StoredLocalVoiceRuntimeLaunchRecord | null> {
  const raw = await readFile(recordPath, 'utf8').catch(() => '')
  if (!raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return { ...(parsed as LocalVoiceRuntimeLaunchRecord), recordPath }
  } catch {
    return null
  }
}

async function readEngineRecords(engineDir: string, engineId: string) {
  const names = (await readdir(engineDir).catch(() => [] as string[]))
    .filter((name) => LAUNCH_RECORD_NAME_PATTERN.test(name))
    .sort()
  const records: StoredLocalVoiceRuntimeLaunchRecord[] = []
  for (const name of names) {
    const record = await readRecordFile(path.join(engineDir, name))
    if (record) records.push({ engineId, ...record })
  }
  return records
}

/** The engine's current record (the one its latest launch wrote), or null. */
export async function readLocalRuntimeLaunchRecord(
  engineId: string
): Promise<StoredLocalVoiceRuntimeLaunchRecord | null> {
  return readRecordFile(resolveLocalVoiceRuntimeLaunchRecordPath(engineId))
}

/** Every launch record, moved-aside ones included: one engine's, or every engine's. */
export async function listLocalRuntimeLaunchRecords(
  engineId?: string
): Promise<StoredLocalVoiceRuntimeLaunchRecord[]> {
  if (engineId) return readEngineRecords(resolveLocalVoiceRuntimeStateDir(engineId), engineId)
  const root = resolveVoiceRuntimeStateRoot()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const records: StoredLocalVoiceRuntimeLaunchRecord[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      records.push(...(await readEngineRecords(path.join(root, entry.name), entry.name)))
    }
  }
  return records
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
  const { recordPath: _path, ...clean } = contents as StoredLocalVoiceRuntimeLaunchRecord
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

/**
 * Write an engine's current launch record, stamped with this registry. An earlier record whose
 * process is still running is moved aside under its pid, never overwritten (rule 1 above).
 */
export async function writeLocalRuntimeLaunchRecord(
  record: LocalVoiceRuntimeLaunchRecord & { engineId: string; pid: number }
): Promise<void> {
  const recordPath = resolveLocalVoiceRuntimeLaunchRecordPath(record.engineId)
  const stamped = { ...record, registry: await resolveVoiceRuntimeRegistryIdentity() }
  await withLocalRuntimeRecordLock(path.dirname(recordPath), async () => {
    const previous = await readRecordFile(recordPath)
    if (previous && previous.pid !== record.pid && isLocalRuntimeProcessAlive(previous.pid)) {
      await rename(
        recordPath,
        path.join(path.dirname(recordPath), `.batshit-local-runtime-launch.${previous.pid}.json`)
      )
    }
    await writeRecordAtomically(recordPath, stamped)
  })
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
    const current = await readRecordFile(record.recordPath)
    if (!current || !sameLaunch(current, record)) return false
    await writeRecordAtomically(record.recordPath, { ...current, ...changes })
    return true
  })
}

/**
 * Set one engine's "Stop with Batshit" choice in every record it has (its current launch, any
 * launch moved aside, an attach record), reading them afresh under its folder's lock: a launch
 * that moved a record aside or wrote a new one meanwhile is seen as it is now, never written
 * back over. Answers whether anything changed and whether any of its records names a live process.
 */
export async function setLocalRuntimeStopChoice(
  engineId: string,
  stopOnShutdown: boolean
): Promise<{ changed: boolean; live: boolean }> {
  const dir = resolveLocalVoiceRuntimeStateDir(engineId)
  if (!(await stat(dir).catch(() => null))) return { changed: false, live: false }
  return withLocalRuntimeRecordLock(dir, async () => {
    const records = await listLocalRuntimeLaunchRecords(engineId)
    let changed = false
    for (const record of records) {
      if (record.stopOnShutdown === stopOnShutdown) continue
      await writeRecordAtomically(record.recordPath, { ...record, stopOnShutdown })
      changed = true
    }
    return { changed, live: records.some((record) => isLocalRuntimeProcessAlive(record.pid)) }
  })
}

/** Remove a stored record, only if its file still holds that same launch. */
async function removeLocalRuntimeLaunchRecord(record: StoredLocalVoiceRuntimeLaunchRecord) {
  return withLocalRuntimeRecordLock(path.dirname(record.recordPath), async () => {
    const current = await readRecordFile(record.recordPath)
    if (!current || !sameLaunch(current, record)) return false
    await rm(record.recordPath, { force: true })
    return true
  })
}

/** An engine as the prune sees it: its id, base URL, and whether it has a launch recipe. */
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
  for (const record of await listLocalRuntimeLaunchRecords()) {
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
 * Record that `engineId` uses a runtime another engine's launch started (rule 2 above).
 *
 * Returns true when an attach record was written. False means there was nothing to attach
 * to: no live Batshit launch record serves this endpoint (so Batshit did not start whatever
 * answers there), or this engine's own launch started it and its own record already speaks.
 */
export async function attachLocalRuntimeLaunchRecord(options: {
  engineId: string
  endpoint: string | null | undefined
  stopOnShutdown: boolean
}): Promise<boolean> {
  const endpoint = normalizeLocalRuntimeEndpoint(options.endpoint)
  if (!endpoint) return false

  const starters = (await listLocalRuntimeLaunchRecords())
    .filter(
      (record) =>
        !record.startedBy &&
        normalizeLocalRuntimeEndpoint(record.endpoint) === endpoint &&
        isLocalRuntimeProcessAlive(record.pid)
    )
    .sort((left, right) => Date.parse(right.launchedAt ?? '') - Date.parse(left.launchedAt ?? ''))
  const starter = starters[0]
  if (!starter || typeof starter.pid !== 'number' || !starter.engineId) return false
  if (starter.engineId === options.engineId) return false

  await writeLocalRuntimeLaunchRecord({
    engineId: options.engineId,
    pid: starter.pid,
    command: starter.command,
    args: starter.args,
    cwd: starter.cwd,
    logPath: starter.logPath,
    launchedAt: starter.launchedAt,
    ...(starter.launchedBy ? { launchedBy: starter.launchedBy } : {}),
    endpoint,
    startedBy: starter.engineId,
    stopOnShutdown: options.stopOnShutdown
  })
  return true
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
 */
export async function stopDeletedEngineRuntimes(
  engineId: string,
  deletingEngineIds: ReadonlySet<string> = new Set([engineId])
): Promise<DeletedEngineRuntimeStop> {
  const result: DeletedEngineRuntimeStop = { stopped: [], keptForOtherEngines: [], notStopped: [] }
  const all = await listLocalRuntimeLaunchRecords()
  for (const record of all.filter((entry) => entry.engineId === engineId && !entry.startedBy)) {
    const pid = record.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue
    if (!isLocalRuntimeProcessAlive(pid) || result.stopped.includes(pid)) continue
    if (all.some((other) => other.pid === pid && other.engineId && !deletingEngineIds.has(other.engineId))) {
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

/** The Batshit this process is, as its launcher named it (see `launchedBy`), or undefined. */
export function resolveVoiceRuntimeLaunchOwner(): string | undefined {
  const owner = process.env.BATSHIT_VOICE_RUNTIME_OWNER?.trim()
  return owner ? owner : undefined
}
