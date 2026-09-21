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
// The Mac runtime supervisor, the native launcher, and the Docker host operator import this file.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import { nativeRunIsGone, parsePsStartTimeUtc } from './local-voice-runtime-stop.mjs';

export const SBX_DAEMON_RECORD_NAME = '.batshit-sbx-daemon-launch.json';

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
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(temp, recordPath);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return record;
}

/** The record, `{ invalid: true }` when it cannot be read as one, or null when there is none. */
export async function readSbxDaemonRecord(stateDir) {
  const raw = await readFile(join(stateDir, SBX_DAEMON_RECORD_NAME), 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

// Remove the record only if it is still the one decided on: another Batshit may have written a
// newer one meanwhile (the daemon stopped and its call started a fresh one).
async function removeSbxDaemonRecordIf(stateDir, record) {
  const current = await readSbxDaemonRecord(stateDir);
  if (!current) return false;
  if (!record.invalid && current.callStartedAt !== record.callStartedAt) return false;
  await rm(join(stateDir, SBX_DAEMON_RECORD_NAME), { force: true });
  return true;
}

/**
 * Did the recorded call start this daemon? It started while the call ran. `ps` dates a process to
 * the whole second, rounded down, so the window opens at the second the call began.
 */
export function daemonStartedByRecordedCall(record, daemon) {
  const from = Date.parse(record?.callStartedAt ?? '');
  const to = Date.parse(record?.callEndedAt ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(daemon?.startedAtMs)) return false;
  return daemon.startedAtMs >= Math.floor(from / 1000) * 1000 && daemon.startedAtMs <= to;
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
  const sandboxes = Array.isArray(parsed?.sandboxes) ? parsed.sandboxes : [];
  return sandboxes
    .filter((sandbox) => String(sandbox?.status ?? '').toLowerCase() !== 'stopped')
    .map((sandbox) => String(sandbox?.name ?? '?'));
}

/** Is this record this Batshit's to act on: its own, unmarked, or a native run's that is gone? */
export function sbxDaemonRecordIsOurs(record, owner = null, ownerIsGone = () => false) {
  return !record.launchedBy || !owner || record.launchedBy === owner || ownerIsGone(record.launchedBy);
}

/**
 * Should this shutdown stop the daemon, given the record and the daemon this user's `sbx` talks to
 * (`{ running: false }`, or `{ running: true, pid, startedAtMs }`)? `check-sandboxes` is a
 * candidate, not a verdict: the caller still lists sandboxes first.
 */
export function decideSbxDaemonStop({ record, daemon, owner = null, ownerIsGone = () => false }) {
  if (!record) return { action: 'none' };
  if (record.invalid) return { action: 'drop-record', reason: 'its record could not be read' };
  if (!sbxDaemonRecordIsOurs(record, owner, ownerIsGone)) {
    return { action: 'keep', reason: `another Batshit (${record.launchedBy}) started it` };
  }
  if (!daemon?.running) return { action: 'drop-record', reason: 'the daemon Batshit started is no longer running' };
  if (!daemonStartedByRecordedCall(record, daemon)) {
    return { action: 'drop-record', reason: 'the daemon running now started later, so Batshit did not start it' };
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

async function processStartedAtUtc(pid) {
  const result = await run('ps', ['-o', 'lstart=', '-p', String(pid)], 3_000, {
    ...process.env,
    LC_ALL: 'C',
    TZ: 'UTC0'
  });
  return result.ok ? parsePsStartTimeUtc(result.stdout) : null;
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
  if (parsed?.status !== 'running') return { running: false };
  if (typeof parsed.socket !== 'string' || !parsed.socket) return { error: 'sbx daemon status named no socket' };
  const pid = Number((await readFile(join(dirname(parsed.socket), 'sandboxd.pid'), 'utf8').catch(() => '')).trim());
  if (!Number.isInteger(pid) || pid <= 0) return { error: "the daemon's pid file could not be read" };
  const startedAtMs = await processStartedAtUtc(pid);
  return startedAtMs === null ? { running: false } : { running: true, pid, startedAtMs };
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
 * Stop the daemon if this Batshit's call started it and nothing needs it. Answers what happened:
 * `none` (no record), `drop-record` (the daemon it names is gone or is not that one; record
 * removed), `keep` (another Batshit's, a sandbox is running, or it could not be checked; the record
 * stays for the next shutdown), or `stopped`. `ok: false` only when a stop was tried and the daemon
 * did not go. Every `sbx` call is bounded, so a stuck `sbx` costs a quit seconds, never minutes.
 */
export async function stopSbxDaemonIfBatshitStartedIt({
  stateDir,
  owner = null,
  ownerIsGone = nativeRunIsGone,
  callTimeoutMs = 4_000,
  stopTimeoutMs = 6_000,
  goneTimeoutMs = 3_000
}) {
  const record = await readSbxDaemonRecord(stateDir);
  if (!record) return { action: 'none' };
  // An unreadable record, or another Batshit's, costs no `sbx` call at all.
  if (record.invalid || !sbxDaemonRecordIsOurs(record, owner, ownerIsGone)) {
    const decision = decideSbxDaemonStop({ record, daemon: null, owner, ownerIsGone });
    if (decision.action === 'drop-record') await removeSbxDaemonRecordIf(stateDir, record);
    return decision;
  }
  const daemon = await locateSbxDaemon(record, callTimeoutMs);
  if (daemon.error) return { action: 'keep', reason: `it could not be checked: ${daemon.error}` };
  const decision = decideSbxDaemonStop({ record, daemon, owner, ownerIsGone });
  if (decision.action === 'drop-record') {
    await removeSbxDaemonRecordIf(stateDir, record);
    return decision;
  }

  const listed = await runSbx(record, ['ls', '--json'], callTimeoutMs);
  if (!listed.ok) {
    return { action: 'keep', pid: daemon.pid, reason: `its sandboxes could not be listed (${failureText(listed)})` };
  }
  let busy;
  try {
    busy = busySbxSandboxes(listed.stdout);
  } catch (error) {
    return { action: 'keep', pid: daemon.pid, reason: `its sandbox list could not be read (${error.message})` };
  }
  if (busy.length) {
    return { action: 'keep', pid: daemon.pid, reason: `a sandbox is still running (${busy.join(', ')})` };
  }

  const stopped = await runSbx(record, ['daemon', 'stop'], stopTimeoutMs);
  if (!(await waitGone(daemon.pid, goneTimeoutMs))) {
    const detail = stopped.ok ? 'it was still running after `sbx daemon stop`' : failureText(stopped);
    return { action: 'keep', ok: false, pid: daemon.pid, reason: `it did not stop (${detail})` };
  }
  await removeSbxDaemonRecordIf(stateDir, record);
  return { action: 'stopped', ok: true, pid: daemon.pid };
}
