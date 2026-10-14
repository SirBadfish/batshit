// Docker's `sbx` daemon: stopped at shutdown when Batshit's own call started it (2026-09-21, BL-61).
//
// Most `sbx` commands start Docker's background daemon (`sbx daemon start`, one per user) when it
// is not running, and say so first (`Starting sandboxd daemon...`, on stderr on a Mac, on stdout on
// Windows). Batshit asks `sbx` for the Docker Sandbox status whenever Agent Settings or Admin
// opens, so a Batshit that never ran a sandbox still started the daemon, and nothing ever stopped
// it: on Josh's Mac it ran 28 hours after the packaged app started it, and macOS 27 counted it
// against Batshit's Dock icon ("Running in Background") the whole time.
//
// Whoever ran the call that started it writes a record: which Batshit it is, when that call began
// and ended, and the `sbx` it ran (`writeSbxDaemonRecord`; the app keeps a TypeScript twin in
// `sbxDaemonRecord.ts`). At shutdown `stopSbxDaemonIfBatshitStartedIt` stops the daemon only when
// - the record names this Batshit (or no Batshit, or a native run that is gone), the same
//   ownership rule as the voice launch records;
// - the daemon this user's `sbx` talks to (its `daemon status` socket, and the pid file beside it)
//   started inside that call's window, so it is the one Batshit started, not one the user started
//   later or a daemon that restarted; and
// - no sandbox is running (a stopped sandbox keeps its state and needs no daemon).
// It stops it the official way, `sbx daemon stop`. A daemon the user started was never recorded,
// so no Batshit ever stops it.
//
// What is not known is kept (2026-10-10, BL-1255/1256/1257). A record that cannot be read (any error
// but "no such file", empty, not JSON) stays; only sbx's own `stopped` proves the daemon is gone; a
// status, `ps`, time, or sandbox list Batshit cannot read keeps the record and the daemon. With
// `ownerPolicy: 'exact'` (the Pinokio lane) only a record naming exactly this owner is acted on. A
// stop or a removal happens only while the record on disk is still the generation that was read.
//
// The Mac runtime supervisor, the native launcher, the Docker host operator, and the Pinokio launcher
// import this file.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import { nativeRunIsGone, parsePsStartTimeUtc, withLocalRuntimeRecordLock } from './local-voice-runtime-stop.mjs';

export const SBX_DAEMON_RECORD_NAME = '.batshit-sbx-daemon-launch.json';

// Every call and wait a stop makes is bounded, so a stuck `sbx` costs a quit seconds. The worst case
// is all of them one after another (daemon status, the daemon's start time from `ps`, `ls`,
// `daemon stop`, the wait for it to go); the native launcher's cap must exceed it (
// pinned by its test). The `ls` may use what the first two leave unused (BL-193): the first one
// after hours idle took longer than 4 s, and a quit then left the daemon running.
export const SBX_CALL_TIMEOUT_MS = 4_000;
export const SBX_PS_TIMEOUT_MS = 3_000;
export const SBX_DAEMON_STOP_TIMEOUT_MS = 6_000;
export const SBX_DAEMON_GONE_TIMEOUT_MS = 3_000;
export const SBX_DAEMON_STOP_WORST_CASE_MS =
  2 * SBX_CALL_TIMEOUT_MS + SBX_PS_TIMEOUT_MS + SBX_DAEMON_STOP_TIMEOUT_MS + SBX_DAEMON_GONE_TIMEOUT_MS;
// The record folder's lock (the voice launch records' own, `withLocalRuntimeRecordLock`) protects a
// record generation from a cooperating writer or remover between a stop's decision and its effect
// (BL-1257). A stop waits for it at most this long, and the wait comes out of the stop's one budget
// above, never on top of it: what the wait leaves must still hold the effect, or the stop keeps.
export const SBX_RECORD_LOCK_WAIT_MS = 3_000;

const DAEMON_STARTED_LINE = /^Starting sandboxd daemon/i;
// Where a packaged app's children look for `sbx` when the record's own path has gone.
const FALLBACK_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ''
  );
}

/**
 * Did this `sbx` call start the daemon? sbx says so on the first line of its own output, before
 * anything a sandboxed command prints, so a command that prints the same words does not count.
 */
export function sbxCallStartedDaemon(stderr, stdout) {
  return DAEMON_STARTED_LINE.test(firstLine(stderr)) || DAEMON_STARTED_LINE.test(firstLine(stdout));
}

function expandHomePath(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** Where a Batshit's record lives: `BATSHIT_SBX_DAEMON_STATE_DIR`, else `~/.batshit/runtime/sbx-daemon`. */
export function resolveSbxDaemonStateDir(configured) {
  if (typeof configured === 'string' && configured.trim()) return resolve(expandHomePath(configured.trim()));
  return join(homedir(), '.batshit', 'runtime', 'sbx-daemon');
}

/**
 * The `sbx` a caller's PATH finds, as PATH names it (`/opt/homebrew/bin/sbx`, not the Homebrew
 * cellar folder behind it, so the record survives an upgrade), or null.
 */
export function findSbxOnPath(pathValue = process.env.PATH) {
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'sbx');
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Record that a call which ran from `callStartedAt` to `callEndedAt` started the daemon. */
export async function writeSbxDaemonRecord(stateDir, { launchedBy = null, callStartedAt, callEndedAt, sbxPath = null }) {
  const record = {
    ...(launchedBy ? { launchedBy } : {}),
    callStartedAt: new Date(callStartedAt).toISOString(),
    callEndedAt: new Date(callEndedAt).toISOString(),
    ...(sbxPath ? { sbxPath } : {})
  };
  await mkdir(stateDir, { recursive: true });
  const recordPath = join(stateDir, SBX_DAEMON_RECORD_NAME);
  const temp = join(stateDir, `${SBX_DAEMON_RECORD_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  // Under the folder's record lock, so a stop never decides on one generation and acts on another.
  await withLocalRuntimeRecordLock(stateDir, async () => {
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await rename(temp, recordPath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  });
  return record;
}

/** The record, `{ invalid: true }` when it cannot be read as one, or null when there is none. */
export async function readSbxDaemonRecord(stateDir) {
  const read = await readSbxDaemonRecordState(stateDir);
  if (read.state === 'absent') return null;
  if (read.state === 'unknown') return { invalid: true, reason: read.reason };
  return read.record;
}

/**
 * The record as one generation (BL-1256): `{ state: 'absent' }` only when there is no file
 * (`ENOENT`); `{ state: 'unknown', reason }` when it cannot be read as a record (any other error,
 * not a file, empty, not JSON, not an object), so nobody may treat it as gone; or `{ state:
 * 'present', record, generation }`, where `generation` (device, inode, and a digest of the bytes,
 * all from one open file) is what a later effect checks it still acts on.
 */
export async function readSbxDaemonRecordState(stateDir) {
  return readRecordFileState(join(stateDir, SBX_DAEMON_RECORD_NAME));
}

async function readRecordFileState(recordPath) {
  let handle;
  try {
    handle = await open(recordPath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unknown', reason: `its record could not be opened (${error?.code ?? error?.message ?? error})` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { state: 'unknown', reason: 'its record is not a file' };
    const bytes = await handle.readFile();
    const text = bytes.toString('utf8');
    if (!text.trim()) return { state: 'unknown', reason: 'its record is empty' };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { state: 'unknown', reason: 'its record could not be read' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'unknown', reason: 'its record could not be read' };
    }
    const generation = { dev: info.dev, ino: info.ino, sha256: createHash('sha256').update(bytes).digest('hex') };
    return { state: 'present', record: parsed, generation };
  } catch (error) {
    return { state: 'unknown', reason: `its record could not be read (${error?.code ?? error?.message ?? error})` };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Is the record on disk still the generation that was admitted? */
export function sameRecordGeneration(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino && left.sha256 === right.sha256;
}

/**
 * Did the recorded call start this daemon? It started while the call ran. `ps` dates a process to
 * the whole second, rounded down, so the window opens at the second the call began.
 */
export function daemonStartedByRecordedCall(record, daemon) {
  const window = recordedCallWindow(record);
  if (!window || !Number.isFinite(daemon?.startedAtMs)) return false;
  return daemon.startedAtMs >= window.from && daemon.startedAtMs <= window.to;
}

/**
 * The recorded call's window `{ from, to }` (from rounded down to its second), or null when the
 * record's times are missing, unreadable, or out of order (BL-1255): then nothing can be proven about
 * which daemon the call started.
 */
export function recordedCallWindow(record) {
  const from = Date.parse(record?.callStartedAt ?? '');
  const to = Date.parse(record?.callEndedAt ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return { from: Math.floor(from / 1000) * 1000, to };
}

/**
 * The sandboxes an `sbx ls --json` lists as anything but stopped. The list starts at the first
 * line that opens a JSON object, after any daemon-start lines. Throws when it cannot be read.
 */
export function busySbxSandboxes(stdout) {
  const text = String(stdout ?? '');
  const start = text.search(/^\s*\{/m);
  if (start < 0) throw new Error('sbx ls --json printed no JSON');
  const parsed = JSON.parse(text.slice(start));
  // A list that is not there is not an empty list (BL-1255): `{}` or `"sandboxes": null` proves nothing.
  if (!Array.isArray(parsed?.sandboxes)) throw new Error('sbx ls --json printed no sandbox list');
  return parsed.sandboxes
    .filter((sandbox) => String(sandbox?.status ?? '').toLowerCase() !== 'stopped')
    .map((sandbox) => String(sandbox?.name ?? '?'));
}

/**
 * Is this record this Batshit's to act on? `legacy` (the Mac supervisor, the native launcher, the
 * Docker operator): its own, unmarked, or a native run's that is gone. `exact` (the Pinokio lane,
 * BL-1257): only a record that names exactly this owner; an unmarked or another owner's never is.
 */
export function sbxDaemonRecordIsOurs(record, owner = null, ownerIsGone = () => false, ownerPolicy = 'legacy') {
  if (ownerPolicy === 'exact') return Boolean(owner) && record.launchedBy === owner;
  return !record.launchedBy || !owner || record.launchedBy === owner || ownerIsGone(record.launchedBy);
}

function notOursReason(record) {
  return record.launchedBy ? `another Batshit (${record.launchedBy}) started it` : 'its record names no Batshit';
}

/**
 * Should this shutdown stop the daemon, given the record and the daemon this user's `sbx` talks to
 * (`{ running: false }`, or `{ running: true, pid, startedAtMs }`)? `check-sandboxes` is a
 * candidate, not a verdict: the caller still lists sandboxes first.
 */
export function decideSbxDaemonStop({ record, daemon, owner = null, ownerIsGone = () => false, ownerPolicy = 'legacy' }) {
  if (!record) return { action: 'none', verdict: 'absent' };
  // An unreadable record is kept (BL-1256): it may name a daemon still running.
  if (record.invalid) return { action: 'keep', verdict: 'unknown', reason: record.reason ?? 'its record could not be read' };
  if (!sbxDaemonRecordIsOurs(record, owner, ownerIsGone, ownerPolicy)) {
    return { action: 'keep', verdict: 'not-ours', reason: notOursReason(record) };
  }
  if (!daemon || daemon.error) {
    return { action: 'keep', verdict: 'unknown', reason: `it could not be checked: ${daemon?.error ?? 'no answer'}` };
  }
  // Only sbx's own "stopped" proves the daemon is gone (BL-1255).
  if (daemon.running === false) {
    return { action: 'drop-record', verdict: 'gone', reason: 'the daemon Batshit started is no longer running' };
  }
  const window = recordedCallWindow(record);
  if (!window) return { action: 'keep', verdict: 'unknown', reason: 'its record has no readable call time' };
  if (!Number.isFinite(daemon.startedAtMs)) {
    return { action: 'keep', verdict: 'unknown', reason: "the daemon's start time could not be read" };
  }
  if (daemon.startedAtMs < window.from || daemon.startedAtMs > window.to) {
    return {
      action: 'drop-record',
      verdict: 'gone',
      reason: 'the daemon running now started at another time, so it is not the one Batshit started'
    };
  }
  return { action: 'check-sandboxes', daemon };
}

// A timed-out call is killed outright: the sbx client can ignore SIGTERM (measured 28.9 s for
// `sbx exec`), and a quit must never wait on it.
function run(command, args, timeoutMs, env) {
  return new Promise((done) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env },
      (error, stdout, stderr) => done({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
    );
  });
}

// The recorded `sbx` first, then whatever PATH finds (with Homebrew's folders added: a packaged
// app's PATH often lacks them).
async function runSbx(record, args, timeoutMs) {
  const env = { ...process.env, PATH: [process.env.PATH, ...FALLBACK_PATH_DIRS].filter(Boolean).join(delimiter) };
  const commands = [...new Set([isAbsolute(record.sbxPath ?? '') ? record.sbxPath : null, 'sbx'].filter(Boolean))];
  let last = null;
  for (const command of commands) {
    last = await run(command, args, timeoutMs, env);
    if (last.error?.code !== 'ENOENT') return last;
  }
  return last;
}

function failureText(result) {
  return (result.stderr || result.stdout || result.error?.message || 'no output').trim().split('\n').pop();
}

// The daemon's start time, or `{ error }` (BL-1255): a `ps` that failed, timed out, found no such
// process, or printed a time Batshit cannot read proves nothing about the daemon, so it is never
// read as "not running".
async function processStartedAtUtc(pid) {
  const result = await run('ps', ['-o', 'lstart=', '-p', String(pid)], SBX_PS_TIMEOUT_MS, {
    ...process.env,
    LC_ALL: 'C',
    TZ: 'UTC0'
  });
  if (!result.ok) return { error: `ps could not read the daemon's start time (${failureText(result)})` };
  const startedAtMs = parsePsStartTimeUtc(result.stdout);
  return startedAtMs === null ? { error: 'ps printed a start time Batshit cannot read' } : { startedAtMs };
}

/**
 * The daemon this user's `sbx` talks to: `daemon status` (which never starts one) names its
 * socket, and the daemon writes its pid beside it. `{ running: false }`, `{ running: true, pid,
 * startedAtMs }`, or `{ error }` when it cannot be told.
 */
async function locateSbxDaemon(record, timeoutMs) {
  const status = await runSbx(record, ['daemon', 'status', '--json'], timeoutMs);
  if (!status.ok) return { error: `sbx daemon status failed (${failureText(status)})` };
  let parsed;
  try {
    parsed = JSON.parse(status.stdout.slice(Math.max(0, status.stdout.indexOf('{'))));
  } catch {
    return { error: 'sbx daemon status printed something Batshit cannot read' };
  }
  // Only sbx's own "stopped" is a daemon that is not running (BL-1255); any other word is unknown.
  if (parsed?.status === 'stopped') return { running: false };
  if (parsed?.status !== 'running') return { error: `sbx daemon status said "${String(parsed?.status)}"` };
  if (typeof parsed.socket !== 'string' || !parsed.socket) return { error: 'sbx daemon status named no socket' };
  const pid = Number((await readFile(join(dirname(parsed.socket), 'sandboxd.pid'), 'utf8').catch(() => '')).trim());
  if (!Number.isInteger(pid) || pid <= 0) return { error: "the daemon's pid file could not be read" };
  const started = await processStartedAtUtc(pid);
  return started.error ? { error: started.error } : { running: true, pid, startedAtMs: started.startedAtMs };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
  return true;
}

/**
 * How long the stop's `sbx ls --json` may take (BL-193): what the stop's budget leaves at `nowMs`
 * once `daemon stop` and the wait for the daemon to go are set aside, and never less than a call's
 * own bound. The daemon status and `ps` before it are bounded, so the whole stop still fits
 * `SBX_DAEMON_STOP_WORST_CASE_MS` (for the defaults): about 11 s when they answer at once and the
 * record lock was free, less by however long the stop waited for the lock (BL-1257).
 */
export function sbxListTimeoutMs(deadline, nowMs, callTimeoutMs, stopTimeoutMs, goneTimeoutMs) {
  return Math.max(callTimeoutMs, deadline - nowMs - stopTimeoutMs - goneTimeoutMs);
}

// A stop that found its record changed under it keeps everything for the next shutdown (BL-1257).
const RECORD_CHANGED = 'its record changed while it was being checked, so it is kept for the next shutdown';
// A stop whose budget no longer holds the effect's own bounds keeps everything (BL-1257).
const OUT_OF_TIME = 'too little of the stop\'s time was left to stop it safely, so it is kept for the next shutdown';
// Stopped, but the record changed before it could be removed: the newer record is kept (BL-1257).
const STOPPED_RECORD_CHANGED = 'it was stopped, but its record changed before it could be removed, so the record is kept';

/**
 * Run `work` only while the record on disk is still the admitted generation (BL-1257): answers
 * `{ held: false }` when it changed, disappeared, or cannot be read, else `{ held: true, value }`.
 */
async function whileSbxRecordGenerationHolds(stateDir, generation, work) {
  const current = await readSbxDaemonRecordState(stateDir);
  if (current.state !== 'present' || !sameRecordGeneration(current.generation, generation)) return { held: false };
  return { held: true, value: await work() };
}

/**
 * Stop the daemon if this Batshit's call started it and nothing needs it. Answers what happened, as
 * `action` (`none`, `drop-record`, `keep`, `stopped`; `ok: false` only when a stop was tried and the
 * daemon did not go) and as `verdict`, which says whether its record can be forgotten (BL-1255):
 * - `absent`: there is no record (`ENOENT`);
 * - `gone`: sbx says the daemon is stopped, or the one running started at another time than the
 *   recorded call (both times readable); the record is removed;
 * - `stopped`: stopped with `sbx daemon stop` and seen gone; the record is removed;
 * - `kept`: something runs in it, or the stop did not take; the record stays;
 * - `not-ours`: another Batshit's (or, with `ownerPolicy: 'exact'`, any record not naming exactly
 *   this owner); nothing is called or changed;
 * - `unknown`: the record could not be read, a probe failed or answered something unreadable, or the
 *   record changed while it was checked; the record stays.
 * An effect (a stop, or removing the record) happens only while the record is still the generation
 * that was admitted. Every `sbx` call is bounded, so a stuck `sbx` costs a quit seconds, never minutes.
 */
export async function stopSbxDaemonIfBatshitStartedIt({
  stateDir,
  owner = null,
  ownerIsGone = nativeRunIsGone,
  ownerPolicy = 'legacy',
  callTimeoutMs = SBX_CALL_TIMEOUT_MS,
  stopTimeoutMs = SBX_DAEMON_STOP_TIMEOUT_MS,
  goneTimeoutMs = SBX_DAEMON_GONE_TIMEOUT_MS,
  lockWaitMs = SBX_RECORD_LOCK_WAIT_MS
}) {
  if (ownerPolicy === 'exact' && !owner) throw new TypeError('an exact owner policy needs an owner');
  const deadline = Date.now() + 2 * callTimeoutMs + SBX_PS_TIMEOUT_MS + stopTimeoutMs + goneTimeoutMs;
  // Without an effect to protect, no lock: nothing there, unreadable, or not this Batshit's.
  const first = await readSbxDaemonRecordState(stateDir);
  if (first.state === 'absent') return { action: 'none', verdict: 'absent' };
  if (first.state === 'unknown') return { action: 'keep', verdict: 'unknown', reason: first.reason };
  if (!sbxDaemonRecordIsOurs(first.record, owner, ownerIsGone, ownerPolicy)) {
    return { action: 'keep', verdict: 'not-ours', reason: notOursReason(first.record) };
  }
  // A record of this Batshit's: the whole decision and every effect happen under the folder's record
  // lock, reading the record again once it is held, so no cooperating writer or remover can replace it
  // in between (BL-1257). A lock that is busy past the wait, or one that cannot be taken safely (no
  // valid owner, an unfinished reap), keeps everything, and says so.
  let locked = false;
  try {
    return await withLocalRuntimeRecordLock(
      stateDir,
      () => {
        locked = true;
        return settleOwnedSbxRecord({ stateDir, owner, ownerIsGone, ownerPolicy, deadline, callTimeoutMs, stopTimeoutMs, goneTimeoutMs });
      },
      { waitMs: Math.max(0, Math.min(lockWaitMs, deadline - Date.now() - stopTimeoutMs - goneTimeoutMs)) }
    );
  } catch (error) {
    const what = locked ? 'it could not be settled' : 'its record could not be locked';
    return { action: 'keep', verdict: 'unknown', reason: `${what} (${error?.message ?? error})` };
  }
}

// Under the record lock: read, decide, and act on one generation. Every probe is bounded, and the
// effect (the stop, the wait for the daemon to go, the removal) runs only when what is left of the
// stop's one budget still holds its own bounds.
async function settleOwnedSbxRecord({ stateDir, owner, ownerIsGone, ownerPolicy, deadline, callTimeoutMs, stopTimeoutMs, goneTimeoutMs }) {
  const recordPath = join(stateDir, SBX_DAEMON_RECORD_NAME);
  const read = await readSbxDaemonRecordState(stateDir);
  if (read.state === 'absent') return { action: 'none', verdict: 'absent' };
  if (read.state === 'unknown') return { action: 'keep', verdict: 'unknown', reason: read.reason };
  const { record, generation } = read;
  if (!sbxDaemonRecordIsOurs(record, owner, ownerIsGone, ownerPolicy)) {
    return { action: 'keep', verdict: 'not-ours', reason: notOursReason(record) };
  }
  const daemon = await locateSbxDaemon(record, callTimeoutMs);
  const decision = decideSbxDaemonStop({ record, daemon, owner, ownerIsGone, ownerPolicy });
  if (decision.action === 'drop-record') {
    const removal = await whileSbxRecordGenerationHolds(stateDir, generation, () => rm(recordPath, { force: true }));
    return removal.held ? decision : { action: 'keep', verdict: 'unknown', reason: RECORD_CHANGED };
  }
  if (decision.action !== 'check-sandboxes') return decision;

  if (deadline - Date.now() - stopTimeoutMs - goneTimeoutMs < callTimeoutMs) {
    return { action: 'keep', verdict: 'unknown', pid: daemon.pid, reason: OUT_OF_TIME };
  }
  const listed = await runSbx(
    record,
    ['ls', '--json'],
    sbxListTimeoutMs(deadline, Date.now(), callTimeoutMs, stopTimeoutMs, goneTimeoutMs)
  );
  if (!listed.ok) {
    return { action: 'keep', verdict: 'unknown', pid: daemon.pid, reason: `its sandboxes could not be listed (${failureText(listed)})` };
  }
  let busy;
  try {
    busy = busySbxSandboxes(listed.stdout);
  } catch (error) {
    return { action: 'keep', verdict: 'unknown', pid: daemon.pid, reason: `its sandbox list could not be read (${error.message})` };
  }
  if (busy.length) {
    return { action: 'keep', verdict: 'kept', pid: daemon.pid, reason: `a sandbox is still running (${busy.join(', ')})` };
  }
  if (deadline - Date.now() < stopTimeoutMs + goneTimeoutMs) {
    return { action: 'keep', verdict: 'unknown', pid: daemon.pid, reason: OUT_OF_TIME };
  }

  // A writer that does not take the lock (an older Batshit) could still have replaced it: check once more.
  const effect = await whileSbxRecordGenerationHolds(stateDir, generation, async () => {
    const stopped = await runSbx(record, ['daemon', 'stop'], stopTimeoutMs);
    const gone = await waitGone(daemon.pid, goneTimeoutMs);
    // The record is removed only if it is still the admitted one, read again just before.
    const removed = gone ? await whileSbxRecordGenerationHolds(stateDir, generation, () => rm(recordPath, { force: true })) : null;
    return { stopped, gone, removed };
  });
  if (!effect.held) return { action: 'keep', verdict: 'unknown', pid: daemon.pid, reason: RECORD_CHANGED };
  if (effect.value.removed?.held === false) {
    return { action: 'keep', verdict: 'unknown', pid: daemon.pid, reason: STOPPED_RECORD_CHANGED };
  }
  if (!effect.value.gone) {
    const detail = effect.value.stopped.ok ? 'it was still running after `sbx daemon stop`' : failureText(effect.value.stopped);
    return { action: 'keep', ok: false, verdict: 'kept', pid: daemon.pid, reason: `it did not stop (${detail})` };
  }
  return { action: 'stopped', ok: true, verdict: 'stopped', pid: daemon.pid };
}
