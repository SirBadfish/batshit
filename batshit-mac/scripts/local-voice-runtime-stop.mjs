// "Stop with Batshit" — the decision, in one place, for every shutdown path.
//
// Detached local voice runtimes (BYO engines, the native LiveKit server, the
// LiveKit sidecar) write a launch record on every spawn under
// `<voice runtime state root>/<engineId>/.batshit-local-runtime-launch.json`.
// The Mac runtime supervisor reads those records on app quit; the native
// launcher reads them on its own teardown; the Docker host operator keeps the
// same records in its own folder for what IT started. None of them can read
// Redis, so the record is how the user's per-engine choice reaches them.
//
// One process can be named by more than one record (2026-09-18):
// - engines that share one runtime on one port each carry their own choice in
//   their own record (an "attach" record: `startedBy` names the engine whose
//   launch started the process, and every process field is copied from it);
// - a launch that needs an engine's record name while the process that record
//   names still runs moves that record aside to `.batshit-local-runtime-launch.
//   <pid>.json` instead of overwriting it. Overwriting is how a second Batshit's
//   launch of `chatterbox-turbo` left the first one's `mlx_audio.server`
//   running for days with nothing left that could stop it.
// So the decision is per PROCESS: `decideLocalRuntimeGroupStop` sees every
// record that names it.
//
// The logic lives here rather than inline in a launcher so a test can MUTATE it
// instead of only pinning its source text.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const LOCAL_RUNTIME_LAUNCH_RECORD_NAME = '.batshit-local-runtime-launch.json';
const LAUNCH_RECORD_NAME_PATTERN = /^\.batshit-local-runtime-launch(?:\.(\d+))?\.json$/;

/** `.batshit-local-runtime-launch.json`, or one moved aside as `.<pid>.json`. */
export function isLocalRuntimeLaunchRecordName(name) {
  return LAUNCH_RECORD_NAME_PATTERN.test(name);
}

/** Where a still-running launch's record goes when a newer launch needs the name. */
export function movedAsideLaunchRecordName(pid) {
  return `.batshit-local-runtime-launch.${pid}.json`;
}

/**
 * Does one live process-group member look like the process this record
 * launched?
 *
 * cwd matters: shell-style launches record a bare command ("npm"), but every
 * process in the runtime's tree carries the absolute install path in its argv.
 */
export function launchRecordMatchesCommand(record, commandLine) {
  const absoluteCandidates = [
    record.command,
    record.cwd,
    ...(Array.isArray(record.args) ? record.args : [])
  ].filter((value) => typeof value === 'string' && value.startsWith('/'));
  if (absoluteCandidates.some((candidate) => commandLine.includes(candidate))) return true;
  const base = typeof record.command === 'string' ? record.command.split('/').pop() : '';
  return Boolean(base) && commandLine.includes(base);
}

/**
 * Is the live group leader the process this record's launch started (2026-09-21, BL-60)?
 *
 * A record's `launchedAt` is written after its spawn, and a pid is only reused once its process is
 * gone, so a leader that started no later than `launchedAt` IS that launch's process, whatever its
 * command line says now, and a leader that started later is a reused pid. The command line cannot
 * say this reliably: the python.org framework Python re-executes itself as
 * `…/Python.framework/…/Python.app/Contents/MacOS/Python`, so a venv engine's live command line
 * holds neither the recorded venv path nor the install folder, and every quit refused to stop
 * `dots-tts-mf` and dropped its record, which left it running forever. `ps` prints start times in
 * whole seconds, rounded down, so a real leader never reads as later than its record.
 *
 * Every writer records the launch moments after its spawn, so a leader that started more than
 * `LAUNCH_RECORD_WRITE_WINDOW_MS` before `launchedAt` is outside what a launch can explain (a
 * clock set back since the record was written, say): the start time then proves nothing, and
 * the command match decides. Null too when either time is unknown (the pid leads no group, or
 * the record has no launch time).
 */
export const LAUNCH_RECORD_WRITE_WINDOW_MS = 60_000;

export function launchRecordNamesLeader(record, leaderStartedAtMs) {
  if (typeof leaderStartedAtMs !== 'number' || !Number.isFinite(leaderStartedAtMs)) return null;
  const launchedAtMs = Date.parse(record?.launchedAt ?? '');
  if (!Number.isFinite(launchedAtMs)) return null;
  if (leaderStartedAtMs > launchedAtMs) return false;
  if (leaderStartedAtMs < launchedAtMs - LAUNCH_RECORD_WRITE_WINDOW_MS) return null;
  return true;
}

const PS_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const PS_START_TIME = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * A `ps -o lstart=` time printed in the C locale and UTC (`Mon Sep 21 13:04:39 2026`, the day
 * padded with a space), as epoch ms; null for anything else. Read any other way, `ps` prints it in
 * the user's language (`lun. 21 sept.`) and local time, which is ambiguous for an hour each autumn.
 */
export function parsePsStartTimeUtc(value) {
  const match = PS_START_TIME.exec(String(value ?? '').trim());
  if (!match || !(match[1] in PS_MONTHS)) return null;
  const ms = Date.UTC(Number(match[6]), PS_MONTHS[match[1]], Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isFinite(ms) ? ms : null;
}

// `pid=,pgid=,lstart=,command=` in the C locale: the start time is always five fields.
const PS_GROUP_ROW = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

/**
 * One process group, as a stopper needs it, from one whole-table `ps` (see `readLocalRuntimeProcessGroup`):
 * the live members' command lines, and the leader's start time when `pgid` still leads its own
 * group (else null: the leader is gone, or the pid now belongs to a process in another group).
 */
export function localRuntimeProcessGroupFromPs(stdout, pgid) {
  const commandLines = [];
  let leaderStartedAtMs = null;
  for (const line of String(stdout ?? '').split('\n')) {
    const match = PS_GROUP_ROW.exec(line);
    if (!match || Number(match[2]) !== pgid) continue;
    commandLines.push(match[4]);
    if (Number(match[1]) === pgid) leaderStartedAtMs = parsePsStartTimeUtc(match[3]);
  }
  return { commandLines, leaderStartedAtMs };
}

/**
 * Read one process group for `decideLocalRuntimeGroupStop`, or null when `ps` itself failed.
 * Read from the WHOLE table: `ps -g` exits 1 for a group with no members, the same as a failed
 * `ps`, and "no members" is what a reused pid looks like, so the two must stay apart.
 */
export async function readLocalRuntimeProcessGroup(pgid) {
  const stdout = await new Promise((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,pgid=,lstart=,command='],
      {
        timeout: 3_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' }
      },
      (error, output) => resolve(error ? null : String(output))
    );
  });
  return stdout === null ? null : localRuntimeProcessGroupFromPs(stdout, pgid);
}

/**
 * Should this shutdown stop this runtime, as far as ONE record can say?
 *
 * `stopOnShutdown` absent means STOP. Quitting the packaged Mac app has always
 * stopped every recorded local runtime, so a record written before the setting
 * existed has to keep behaving that way; only an explicit `false` keeps an
 * engine running.
 *
 * `launchedAfterMs` is for a shutdown that owns only part of the machine. The
 * native launcher shares one runtime state root with the packaged Mac app, so
 * it stops only what its own run started — otherwise Ctrl+C in a dev terminal
 * would kill the engines a running packaged app is using.
 *
 * `verify-and-stop` is a candidate, not a verdict: the caller still has to see
 * a live group member whose command matches, or the pid has been reused and
 * nothing may be killed. A shutdown path decides a whole process with
 * `decideLocalRuntimeGroupStop`, which applies this to every record naming it.
 */
export function decideLocalRuntimeStop({ record, alive, launchedAfterMs = null }) {
  if (!record || record.invalid) {
    return { action: 'drop-record', reason: 'launch record was invalid' };
  }
  if (!Number.isInteger(record.pid) || record.pid <= 0) {
    return { action: 'drop-record', reason: 'launch record has no usable pid' };
  }
  if (!alive) {
    return { action: 'drop-record', reason: 'was not running' };
  }
  if (record.stopOnShutdown === false) {
    return { action: 'keep-running', reason: 'Stop with Batshit is off for this engine' };
  }
  if (launchedAfterMs !== null) {
    const launchedAt = Date.parse(record.launchedAt ?? '');
    if (!Number.isFinite(launchedAt) || launchedAt < launchedAfterMs) {
      return {
        action: 'keep-running',
        reason: 'another Batshit started it, so this shutdown does not own it'
      };
    }
  }
  return { action: 'verify-and-stop' };
}

/**
 * Records grouped by the process they name (a detached runtime leads its own
 * process group, so the launch pid is also the group id). A record that cannot
 * name a process at all is set apart for the caller to drop.
 */
export function groupLocalRuntimeLaunchRecords(records) {
  const groups = new Map();
  const unusable = [];
  for (const record of records) {
    if (!record || record.invalid || !Number.isInteger(record.pid) || record.pid <= 0) {
      unusable.push(record);
      continue;
    }
    if (!groups.has(record.pid)) groups.set(record.pid, []);
    groups.get(record.pid).push(record);
  }
  return {
    groups: [...groups.entries()].map(([pid, grouped]) => ({ pid, records: grouped })),
    unusable
  };
}

function engineList(records) {
  return records.map((record) => `"${record.engineId}"`).join(', ');
}

/**
 * Should this shutdown stop this ONE process, given every record that names it?
 *
 * - `alive` is whether the process (or the group it leads) still exists.
 *   `commandLines` are the group's live members' command lines, read by the
 *   caller from a `ps` of the WHOLE process table, or `null` when that `ps`
 *   itself failed. The two must never be confused: an empty list means `ps`
 *   worked and nothing leads-or-belongs-to this group, which is exactly what a
 *   reused pid looks like (it now belongs to a process in some other group), so
 *   the records are dropped; only a failed `ps` keeps them as unverified.
 *   (`ps -g` cannot tell the two apart: it exits 1 for an empty group.)
 * - The pid-reuse guard comes first, per record: a record that does not name the
 *   live process is stale (the pid now belongs to something else), is dropped,
 *   and has no say. No matching record at all means Batshit refuses to kill.
 *   The guard is the leader's start time first (2026-09-21, BL-60): with
 *   `leaderStartedAtMs` from `readLocalRuntimeProcessGroup`, a record whose
 *   `launchedAt` the leader did not start after names this process, whatever its
 *   command line says now, and one the leader started after is stale (see
 *   `launchRecordNamesLeader`). The command match decides only a record with no
 *   launch time, or a group whose leader is gone (`leaderStartedAtMs` null).
 * - A process shared by several engines stops only if EVERY engine that uses it
 *   says stop (absent means stop). One explicit "keep running" keeps it, and
 *   keeps every record, so the next quit still knows the process.
 *
 * `stale` lists the records the caller removes; on `stop` it also removes every
 * other record in the group once the process is gone.
 *
 * Which Batshit launched it (2026-09-18): a record may name it (`launchedBy`,
 * the same on every record of one process). A stopper passes its own `owner`
 * and never stops a process another Batshit launched, whatever the engines
 * chose; its own launches are its own before or after `launchedAfterMs`. An
 * unmarked record (written before launches were marked) keeps the old rules:
 * the Mac supervisor (no window) stops it, and the native launcher only inside
 * its window. `ownerIsGone(launchedBy)` lets the Mac supervisor stop what a
 * native run launched once that run's launcher is gone (see `nativeRunIsGone`),
 * so a native lane killed hard does not leave engines nothing ever stops.
 *
 * `matchesCommand` is that command match. The Mac supervisor and the native
 * launcher trust the app that wrote their records and use
 * `launchRecordMatchesCommand`; the Docker host operator, whose records carry
 * launch args from the less trusted app container, passes a stricter one. The
 * start-time test needs no such care: every record's pid and `launchedAt` come
 * from the spawn of whoever wrote it, never from the app container.
 */
export function decideLocalRuntimeGroupStop({
  records,
  alive,
  commandLines,
  leaderStartedAtMs = null,
  launchedAfterMs = null,
  matchesCommand = launchRecordMatchesCommand,
  owner = null,
  ownerIsGone = () => false
}) {
  if (commandLines === undefined) {
    throw new TypeError(
      "commandLines is required: the group members' command lines, or null when ps failed"
    );
  }
  const pid = records[0]?.pid;
  if (!alive) {
    return { action: 'drop-records', reason: 'was not running', stale: [...records] };
  }
  if (commandLines === null) {
    // `ps` itself failed or timed out, so the group's command lines are
    // unknown. Killing blind is out, and dropping the record would leave a
    // running engine that nothing can ever stop again.
    return {
      action: 'unverified',
      reason: `could not read pid ${pid}'s command line, so it was left running with its launch record`,
      stale: []
    };
  }

  const matching = records.filter((record) => {
    const namesLeader = launchRecordNamesLeader(record, leaderStartedAtMs);
    if (namesLeader !== null) return namesLeader;
    return commandLines.some((line) => matchesCommand(record, line));
  });
  const stale = records.filter((record) => !matching.includes(record));
  if (!matching.length) {
    const reused = records.some((record) => launchRecordNamesLeader(record, leaderStartedAtMs) === false);
    return {
      action: 'refuse',
      reason: reused
        ? `pid ${pid} now belongs to a process that started after its launch (a reused pid); refused to kill it`
        : `pid ${pid} no longer matches its launch record (likely pid reuse); refused to kill it`,
      stale: [...records]
    };
  }

  const launchedBy =
    (matching.find((record) => !record.startedBy) ?? matching[0]).launchedBy ?? null;
  if (launchedBy && owner && launchedBy !== owner && !ownerIsGone(launchedBy)) {
    return {
      action: 'keep-running',
      reason: `another Batshit (${launchedBy}) launched it, so this shutdown does not own it`,
      stale
    };
  }
  // Marked as this Batshit's (or a gone run's) launch: its own, before or after any window.
  const window = launchedBy && owner ? null : launchedAfterMs;
  const decisions = matching.map((record) => ({
    record,
    decision: decideLocalRuntimeStop({ record, alive: true, launchedAfterMs: window })
  }));
  const keeping =
    decisions.find(({ record }) => record.stopOnShutdown === false) ??
    decisions.find(({ decision }) => decision.action === 'keep-running');
  if (keeping) {
    const reason =
      keeping.record.stopOnShutdown === false && matching.length > 1
        ? `Stop with Batshit is off for "${keeping.record.engineId}", which shares it with ${engineList(
            matching.filter((record) => record !== keeping.record)
          )}`
        : keeping.decision.reason;
    return { action: 'keep-running', reason, keptBy: keeping.record.engineId, stale };
  }
  return { action: 'stop', stale };
}

/**
 * Is the native launcher run that `launchedBy` names gone? A native run is
 * `native:<launcher pid>:<start ms>`; it is gone when that pid no longer
 * exists. Anything else, or anything unreadable, is never treated as gone.
 */
export function nativeRunIsGone(launchedBy) {
  const match = /^native:(\d+):\d+$/.exec(typeof launchedBy === 'string' ? launchedBy : '');
  if (!match) return false;
  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

/** Every launch record under one voice-runtime state root, moved-aside ones included. */
export async function readLocalRuntimeLaunchRecords(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const names = (await readdir(join(root, entry.name)).catch(() => []))
      .filter(isLocalRuntimeLaunchRecordName)
      .sort();
    for (const name of names) {
      const recordPath = join(root, entry.name, name);
      const raw = await readFile(recordPath, 'utf8').catch(() => '');
      if (!raw) continue;
      try {
        records.push({ engineId: entry.name, ...JSON.parse(raw), recordPath });
      } catch {
        records.push({ engineId: entry.name, invalid: true, recordPath });
      }
    }
  }
  return records;
}

/** Is this process, or the process group it leads, still running? */
export function isLocalRuntimeProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  for (const target of [pid, -pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      if (error?.code === 'EPERM') return true;
    }
  }
  return false;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * One spelling per listener (`http://127.0.0.1:8012`), so engines configured as
 * `http://localhost:8012/` and `http://127.0.0.1:8012` are known to share one
 * runtime. Twin of `normalizeLocalRuntimeEndpoint` in the app's
 * `voiceRuntimeLaunchRecords.ts`.
 */
export function normalizeLocalRuntimeEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  const protocol =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase();
  const host = LOOPBACK_HOSTS.has(hostname) ? '127.0.0.1' : hostname;
  const port = parsed.port || (protocol === 'https:' ? '443' : '80');
  return `${protocol}//${host}:${port}`;
}

// ---- Changing records: atomic, serialized, and identity-checked (2026-09-18) --------------
//
// Several processes change one engine's record folder: the app (a launch, the toggle sync, an
// attach), the stoppers (removing what they stopped), and the Docker operator. Every change
// happens under the folder's lock (an atomic mkdir), every write is a temp file renamed into
// place, so a quit never reads half a record, and a remove or update re-reads the record first,
// so nobody deletes or overwrites a newer launch's record by mistake (a toggle save racing a
// launch used to be able to write the old record back over the new one). The app keeps a
// TypeScript twin of these rules in `voiceRuntimeLaunchRecords.ts`.

const RECORD_LOCK_NAME = '.batshit-local-runtime-launch.lock';
const RECORD_LOCK_TOMBSTONE_PREFIX = '.batshit-local-runtime-launch.reaped-';
// The lock folder holds one file naming its holder, so a writer removes only its own lock.
const RECORD_LOCK_OWNER_FILE = 'owner';
// A lock older than this was left by a writer that died holding it (a change takes milliseconds).
const RECORD_LOCK_STALE_MS = 10_000;
const RECORD_LOCK_WAIT_MS = RECORD_LOCK_STALE_MS + 5_000;
const FALLBACK_PROCESS_STARTED_AT_MS =
  Math.floor((Date.now() - process.uptime() * 1_000) / 1_000) * 1_000;
let currentProcessStartedAtPromise = null;

/**
 * A lock is stale when its time is more than the stale age from now, either way: a clock that
 * moved back leaves a lock in the future, which would otherwise block every writer.
 */
function recordLockIsStale(info, now = Date.now()) {
  return Math.abs(now - info.mtimeMs) > RECORD_LOCK_STALE_MS;
}

/**
 * Remove the lock only when it is the one the caller means (bug sweep review, 2026-09-18). Two
 * waiters could both judge a dead writer's lock stale: the first removed it and took a fresh one,
 * and the second then removed that. And a writer that merely ran past the stale age could be
 * displaced while still working. Stale takeover now requires process-identity proof and uses a
 * retained owner-specific tombstone; this helper handles the live owner's ordinary release.
 */
export async function removeLocalRuntimeRecordLockIf(lockPath, isTheOne) {
  const aside = `${lockPath}.aside-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (await isTheOne(aside)) {
    await rm(aside, { recursive: true, force: true });
    return true;
  }
  // Another writer's lock: put it back. Production never displaces a live owner, and stale
  // takeover uses an owner-specific tombstone, so no contender can take the name in this gap.
  await rename(aside, lockPath).catch(() => rm(aside, { recursive: true, force: true }));
  return false;
}

async function recordLockOwner(lockDir) {
  const info = await stat(lockDir).catch(() => null);
  if (!info) return null;
  return readFile(info.isDirectory() ? join(lockDir, RECORD_LOCK_OWNER_FILE) : lockDir, 'utf8').catch(
    () => null
  );
}

function parseRecordLockOwner(owner) {
  const current = /^v2:(\d+):(\d+):/.exec(owner ?? '');
  if (current) return { pid: Number(current[1]), startedAt: Number(current[2]) };
  // Locks from the first serialized-record implementation carried `pid-random`.
  const legacy = /^(\d+)-/.exec(owner ?? '');
  return legacy ? { pid: Number(legacy[1]), startedAt: null } : null;
}

// Read in C and UTC like `readLocalRuntimeProcessGroup` (BL-63): in the user's language
// (`ven. 21 août`) `Date.parse` cannot read it, and a reused owner pid could never be reaped.
// Owners written before this still compare: both readings name the same instant.
async function processStartedAt(pid) {
  const stdout = await new Promise((resolve) => {
    execFile(
      'ps',
      ['-p', String(pid), '-o', 'lstart='],
      { timeout: 3_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } },
      (error, output) => resolve(error ? null : String(output).trim())
    );
  });
  return stdout ? parsePsStartTimeUtc(stdout) : null;
}

async function currentProcessStartedAt() {
  currentProcessStartedAtPromise ??= processStartedAt(process.pid).then(
    (startedAt) => startedAt ?? FALLBACK_PROCESS_STARTED_AT_MS
  );
  return currentProcessStartedAtPromise;
}

/** True only with positive proof that the process which wrote this owner is gone or reused. */
async function recordLockOwnerIsGone(lockDir) {
  const parsed = parseRecordLockOwner(await recordLockOwner(lockDir));
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false;
  try {
    process.kill(parsed.pid, 0);
  } catch (error) {
    return error?.code === 'ESRCH';
  }
  if (parsed.startedAt === null) return false;
  const actualStartedAt = await processStartedAt(parsed.pid);
  return actualStartedAt !== null && Math.abs(actualStartedAt - parsed.startedAt) > 1_500;
}

async function recordLockOwnerPidIsAbsent(lockDir) {
  const parsed = parseRecordLockOwner(await recordLockOwner(lockDir));
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false;
  try {
    process.kill(parsed.pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

/**
 * Reap a proven-dead lock into its deterministic retained tombstone. New file locks use a
 * hard-link claim; legacy nonempty-directory locks retain the rename protocol.
 */
async function reapStaleLocalRuntimeRecordLock(lockPath) {
  const expectedOwner = await recordLockOwner(lockPath);
  const info = await stat(lockPath).catch(() => null);
  if (!expectedOwner || !info || !(await recordLockOwnerIsGone(lockPath))) {
    return false;
  }
  const ownerHash = createHash('sha256').update(expectedOwner).digest('hex').slice(0, 16);
  const tombstonePath = join(dirname(lockPath), `${RECORD_LOCK_TOMBSTONE_PREFIX}${ownerHash}`);
  if (info.isFile()) {
    try {
      await link(lockPath, tombstonePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    const [canonicalInfo, tombstoneInfo] = await Promise.all([
      stat(lockPath).catch(() => null),
      stat(tombstonePath).catch(() => null)
    ]);
    if (
      canonicalInfo &&
      tombstoneInfo &&
      canonicalInfo.dev === tombstoneInfo.dev &&
      canonicalInfo.ino === tombstoneInfo.ino &&
      (await recordLockOwner(tombstonePath)) === expectedOwner &&
      (await recordLockOwnerIsGone(tombstonePath))
    ) {
      await unlink(lockPath);
      return true;
    }
    return false;
  }
  try {
    await rename(lockPath, tombstonePath);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code ?? '')) return false;
    throw error;
  }
  const movedOwner = await recordLockOwner(tombstonePath);
  const movedInfo = await stat(tombstonePath).catch(() => null);
  if (
    movedOwner === expectedOwner &&
    movedInfo &&
    (await recordLockOwnerIsGone(tombstonePath))
  ) {
    return true;
  }
  await rename(tombstonePath, lockPath).catch(() => {});
  return false;
}

async function staleRecordLockHasClaimedTombstone(lockPath, owner) {
  const ownerHash = createHash('sha256').update(owner).digest('hex').slice(0, 16);
  const tombstonePath = join(dirname(lockPath), `${RECORD_LOCK_TOMBSTONE_PREFIX}${ownerHash}`);
  const [canonicalInfo, tombstoneInfo] = await Promise.all([
    stat(lockPath).catch(() => null),
    stat(tombstonePath).catch(() => null)
  ]);
  return Boolean(
    canonicalInfo?.isFile() &&
      tombstoneInfo?.isFile() &&
      canonicalInfo.dev === tombstoneInfo.dev &&
      canonicalInfo.ino === tombstoneInfo.ino
  );
}

async function releaseLocalRuntimeRecordLock(lockPath, owner) {
  const info = await stat(lockPath).catch(() => null);
  if (!info) return false;
  if (info.isDirectory()) {
    return removeLocalRuntimeRecordLockIf(
      lockPath,
      async (moved) => (await recordLockOwner(moved)) === owner
    );
  }
  const ownerHash = createHash('sha256').update(owner).digest('hex').slice(0, 16);
  const releasePath = `${lockPath}.release-${ownerHash}`;
  try {
    await link(lockPath, releasePath);
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes(error?.code ?? '')) return false;
    throw error;
  }
  const [canonicalInfo, releaseInfo, releaseOwner] = await Promise.all([
    stat(lockPath).catch(() => null),
    stat(releasePath).catch(() => null),
    recordLockOwner(releasePath)
  ]);
  const ownsCanonical = Boolean(
    canonicalInfo &&
      releaseInfo &&
      canonicalInfo.dev === releaseInfo.dev &&
      canonicalInfo.ino === releaseInfo.ino &&
      releaseOwner === owner
  );
  if (ownsCanonical) await unlink(lockPath);
  await rm(releasePath, { force: true });
  return ownsCanonical;
}

/** Run `work` holding the engine folder's record lock. */
export async function withLocalRuntimeRecordLock(engineDir, work, options = {}) {
  await mkdir(engineDir, { recursive: true });
  const lockPath = join(engineDir, RECORD_LOCK_NAME);
  const owner = `v2:${process.pid}:${await currentProcessStartedAt()}:${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + (options.waitMs ?? RECORD_LOCK_WAIT_MS);
  for (;;) {
    const candidatePath = `${lockPath}.candidate-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(candidatePath, owner, { encoding: 'utf8', flag: 'wx' });
      await link(candidatePath, lockPath);
      await rm(candidatePath, { force: true });
      break;
    } catch (error) {
      await rm(candidatePath, { force: true });
      if (error?.code !== 'EEXIST') throw error;
      const info = await stat(lockPath).catch(() => null);
      let blockedOwner = null;
      if (info) {
        const existingOwner = await recordLockOwner(lockPath);
        blockedOwner = existingOwner;
        const parsedOwner = parseRecordLockOwner(existingOwner);
        if (!existingOwner) {
          // The owner can release between our first stat and owner read. Reinspect the exact
          // generation before diagnosing a malformed lock; a normal release is a retry.
          const currentInfo = await stat(lockPath).catch(() => null);
          if (!currentInfo || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) continue;
        }
        if (parsedOwner && (await recordLockOwnerPidIsAbsent(lockPath))) {
          if (await reapStaleLocalRuntimeRecordLock(lockPath)) continue;
        } else if (recordLockIsStale(info) && !parsedOwner) {
          throw new Error(
            `stale launch record lock in ${engineDir} has no valid owner; refusing unsafe takeover`
          );
        } else if (recordLockIsStale(info) && parsedOwner) {
          if (await reapStaleLocalRuntimeRecordLock(lockPath)) continue;
        }
      }
      if (Date.now() > deadline) {
        if (blockedOwner && (await staleRecordLockHasClaimedTombstone(lockPath, blockedOwner))) {
          throw new Error(
            `stale launch record lock in ${engineDir} has an incomplete prior reap; refusing unsafe takeover`
          );
        }
        throw new Error(`timed out waiting for the launch record lock in ${engineDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
  }
  try {
    return await work();
  } finally {
    await releaseLocalRuntimeRecordLock(lockPath, owner);
  }
}

async function writeRecordAtomically(recordPath, contents) {
  const temp = join(
    dirname(recordPath),
    `.batshit-local-runtime-launch.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  const { recordPath: _path, ...clean } = contents;
  try {
    await writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    await rename(temp, recordPath);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readRecordAt(recordPath) {
  const raw = await readFile(recordPath, 'utf8').catch(() => null);
  if (raw === null) return { missing: true };
  try {
    return { record: JSON.parse(raw) };
  } catch {
    return { invalid: true };
  }
}

// The same launch: same process, same launch time, same role (own launch or attach).
function sameLaunch(left, right) {
  return (
    left.pid === right.pid &&
    (left.launchedAt ?? null) === (right.launchedAt ?? null) &&
    (left.startedBy ?? null) === (right.startedBy ?? null)
  );
}

/**
 * Write an engine's launch record without ever discarding one whose process
 * still runs: that earlier record is moved aside under its pid. A record whose
 * process is gone, or that names the same process, is simply replaced.
 */
export async function writeLocalRuntimeLaunchRecordFile(
  root,
  record,
  { isAlive = isLocalRuntimeProcessAlive } = {}
) {
  const dir = join(root, record.engineId);
  const recordPath = join(dir, LOCAL_RUNTIME_LAUNCH_RECORD_NAME);
  await withLocalRuntimeRecordLock(dir, async () => {
    const { record: previous } = await readRecordAt(recordPath);
    if (
      previous &&
      Number.isInteger(previous.pid) &&
      previous.pid > 0 &&
      previous.pid !== record.pid &&
      isAlive(previous.pid)
    ) {
      await rename(recordPath, join(dir, movedAsideLaunchRecordName(previous.pid)));
    }
    await writeRecordAtomically(recordPath, record);
  });
  return recordPath;
}

/**
 * Remove a record a stopper decided on, only if its file still holds that same
 * launch (or, for a corrupt record, is still corrupt). Answers whether it did.
 */
export async function removeLocalRuntimeLaunchRecord(record) {
  return withLocalRuntimeRecordLock(dirname(record.recordPath), async () => {
    const current = await readRecordAt(record.recordPath);
    if (current.missing) return false;
    if (record.invalid ? !current.invalid : !current.record || !sameLaunch(current.record, record)) {
      return false;
    }
    await rm(record.recordPath, { force: true });
    return true;
  });
}

/**
 * Change fields of a record in place (a new "Stop with Batshit" choice), only if
 * its file still holds that same launch. Answers whether it did.
 */
export async function updateLocalRuntimeLaunchRecord(record, changes) {
  return withLocalRuntimeRecordLock(dirname(record.recordPath), async () => {
    const current = await readRecordAt(record.recordPath);
    if (!current.record || !sameLaunch(current.record, record)) return false;
    await writeRecordAtomically(record.recordPath, { ...current.record, ...changes });
    return true;
  });
}

/**
 * Record that `engineId` uses a runtime another engine's launch started, with
 * its OWN "Stop with Batshit" choice (an attach record: the process fields and
 * launch time copied from the starter's record, `startedBy` naming it). Found
 * by endpoint among the live launch records under `root`. Returns false, and
 * writes nothing, when no live launch serves that endpoint (Batshit did not
 * start whatever answers there) or when this engine's own launch started it.
 *
 * Twin of `attachLocalRuntimeLaunchRecord` in the app's
 * `voiceRuntimeLaunchRecords.ts`; the Docker host operator uses this one.
 */
export async function attachLocalRuntimeLaunchRecordFile(
  root,
  { engineId, endpoint, stopOnShutdown },
  { isAlive = isLocalRuntimeProcessAlive } = {}
) {
  const target = normalizeLocalRuntimeEndpoint(endpoint);
  if (!target) return false;
  const starter = (await readLocalRuntimeLaunchRecords(root))
    .filter(
      (record) =>
        !record.invalid &&
        !record.startedBy &&
        normalizeLocalRuntimeEndpoint(record.endpoint) === target &&
        isAlive(record.pid)
    )
    .sort((left, right) => Date.parse(right.launchedAt ?? '') - Date.parse(left.launchedAt ?? ''))[0];
  if (!starter || starter.engineId === engineId) return false;

  await writeLocalRuntimeLaunchRecordFile(
    root,
    {
      engineId,
      pid: starter.pid,
      command: starter.command,
      args: starter.args,
      cwd: starter.cwd,
      logPath: starter.logPath,
      launchedAt: starter.launchedAt,
      ...(starter.launchedBy ? { launchedBy: starter.launchedBy } : {}),
      endpoint: target,
      startedBy: starter.engineId,
      stopOnShutdown
    },
    { isAlive }
  );
  return true;
}
