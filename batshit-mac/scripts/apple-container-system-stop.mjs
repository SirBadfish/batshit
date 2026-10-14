// Apple's container system: stopped at shutdown when Batshit's own call started it (2026-09-22,
// BL-62 part 2).
//
// Batshit's Apple Container sandboxes need Apple's container system: `container system start`
// registers `container-apiserver` with launchd, and the apiserver runs its network and image plugins
// (all LaunchAgents in this user's launchd domain, one system per user). Batshit starts it when its
// first sandboxed command finds it stopped (the app, inside its sandbox lifecycle gate), and
// Runtime Doctor's Start button can. Nothing stopped it again: the apiserver and its vmnet plugins
// ran until logout.
//
// Whoever ran that `system start` writes a record: which Batshit it is, when the call began and
// ended, and the `container` it ran (`writeAppleContainerSystemRecord`; the app keeps a TypeScript
// twin in `appleContainerSystemRecord.ts`). At shutdown `stopAppleContainerSystemIfBatshitStartedIt`
// stops the system only when
// - the record names this Batshit (or no Batshit, or a native run that is gone), the ownership rule
//   of the voice launch records and of Docker's sbx daemon (BL-61);
// - the registration running now is the one that call made. `system start` writes
//   `<appRoot>/apiserver/apiserver.plist` and registers it (and a second `system start` on a running
//   system still rewrites the file), so the plist's modification time is when the system was last
//   started, and it must fall inside the recorded call. BL-61's rule for the sbx daemon, the process
//   started inside the call, does not fit: launchd starts `container-apiserver` again on demand (it
//   serves a Mach service), so after one relaunch the process is newer than Batshit's start while
//   the registration is still Batshit's, and that system would never be stopped. Only another
//   `system start` rewrites the plist, and after one the system is not Batshit's;
// - no container runs, anyone's: `container system stop` stops every container before it
//   deregisters, the user's too. A Batshit sandbox that another process is still starting (Apple
//   lists it `stopped` with no `startedDate` for about a second) counts as running while its
//   `batshit.created-at` stamp is recent.
// It stops it the official way, `container system stop`, and checks that the system is
// unregistered after. A system the user started was never recorded, so no Batshit ever stops it.
//
// Before that decision it removes the sandboxes this Batshit left running (2026-09-25, BL-149), when
// its caller knows the app is down (`removeOwnSandboxes`): an app that did not stop may still be
// running a command in one. A quit in the middle of a chat run never gets that run's cleanup, and the
// app's prune removes only dead sandboxes, so the run's sandbox ran on, and kept the system up, until
// the chat's next turn. Every sandbox the app creates carries `batshit.owner=<digest of this
// Batshit's owner>` (the app's `appleContainerSandbox.ts` twins the label), and the quit deletes the
// Batshit-named ones carrying its own, whether or not the system is its to stop. Another Batshit's
// sandbox, an older unlabelled one, and a user's container are never touched, and they keep the
// system running.
//
// What is not known is kept (2026-10-10, BL-1255/1256/1257). A record that cannot be read (any error
// but "no such file", empty, not JSON) stays; only Apple's own `unregistered` proves the system is
// gone; a status, registration time, record time, or list Batshit cannot read keeps the record and the
// system. With `ownerPolicy: 'exact'` (the Pinokio lane) only a record naming exactly this owner is
// acted on. A stop or a removal happens only while the record on disk is still the generation read.
//
// The Mac runtime supervisor, the native launcher, and the Pinokio launcher import this file.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { nativeRunIsGone, withLocalRuntimeRecordLock } from './local-voice-runtime-stop.mjs';

export const APPLE_CONTAINER_SYSTEM_RECORD_NAME = '.batshit-apple-container-system.json';

// Apple's installer puts `container` here; a packaged app's children often lack it on PATH.
const FALLBACK_PATH_DIRS = ['/usr/local/bin'];
const SANDBOX_NAME_PREFIX = 'batshit-apple-sandbox-';
const CREATED_AT_LABEL = 'batshit.created-at';
// The Batshit that created a sandbox (BL-149), as `appleContainerOwnerLabelValue` writes it.
export const APPLE_CONTAINER_OWNER_LABEL = 'batshit.owner';
// Every `container` call a stop makes is bounded, so a stuck CLI costs a quit seconds. The worst case
// is three calls (status, list, the status after) and the stop itself; the native launcher's cap
// must exceed it (pinned by its test). The removal of this Batshit's own sandboxes
// runs inside that budget: its `delete` gets what is left once the stop and the status after it are
// set aside (about 8 s when the first two calls answer at once; Apple's forced delete of a running
// container waits up to 5 s for it to stop).
export const APPLE_CONTAINER_CALL_TIMEOUT_MS = 4_000;
// With no container running (checked first) Apple's `system stop` pings, deregisters, and returns
// in about a second; 10 s is its bound.
export const APPLE_CONTAINER_SYSTEM_STOP_TIMEOUT_MS = 10_000;
export const APPLE_CONTAINER_STOP_WORST_CASE_MS = 3 * APPLE_CONTAINER_CALL_TIMEOUT_MS + APPLE_CONTAINER_SYSTEM_STOP_TIMEOUT_MS;
// The record folder's lock (the voice launch records' own, `withLocalRuntimeRecordLock`) protects a
// record generation from a cooperating writer or remover between a stop's decision and its effect
// (BL-1257). A stop waits for it at most this long, and the wait comes out of the stop's one budget
// above, never on top of it: what the wait leaves must still hold the effect, or the stop keeps.
export const APPLE_CONTAINER_RECORD_LOCK_WAIT_MS = 3_000;
// The app's own rule (`appleContainerSandbox.ts`): a create times out after 90 s, so a sandbox that
// never started and was created longer ago than this is dead.
const NEVER_STARTED_DEAD_AFTER_MS = 10 * 60_000;

function expandHomePath(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/**
 * The owner label's value for a Batshit (`BATSHIT_VOICE_RUNTIME_OWNER`: `mac-app:<data folder>` or
 * `native:<launcher pid>:<start ms>`), or null for none. A digest, because Apple's CLI splits a label
 * at `=` and rejects a third part (0.12.3 `Parser.labels`), and a data folder may hold one. The app's
 * `appleContainerSandbox.ts` writes the same value on every create.
 */
export function appleContainerOwnerLabelValue(owner) {
  const text = String(owner ?? '').trim();
  return text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : null;
}

/** The entries a `container list --all --format json` printed. Throws when the output is not a list. */
function parseAppleContainerList(stdout) {
  const text = String(stdout ?? '').trim();
  const parsed = JSON.parse(text.slice(Math.max(0, text.indexOf('['))));
  if (!Array.isArray(parsed)) throw new Error('container list printed no list');
  return parsed;
}

const entryId = (entry) => String(entry?.configuration?.id ?? entry?.id ?? '');

/**
 * This Batshit's own sandboxes in a `container list --all --format json`, in any state: the
 * Batshit-named ones whose owner label is this owner's. Throws when the output is not a list.
 */
export function appleContainerSandboxesOwnedBy(stdout, owner) {
  const value = appleContainerOwnerLabelValue(owner);
  const entries = parseAppleContainerList(stdout);
  if (!value) return [];
  return entries
    .filter((entry) => entryId(entry).startsWith(SANDBOX_NAME_PREFIX) && entry?.configuration?.labels?.[APPLE_CONTAINER_OWNER_LABEL] === value)
    .map(entryId);
}

/** Where the record lives: `BATSHIT_APPLE_CONTAINER_STATE_DIR`, else `~/.batshit/runtime/apple-container`. */
export function resolveAppleContainerStateDir(configured) {
  if (typeof configured === 'string' && configured.trim()) return resolve(expandHomePath(configured.trim()));
  return join(homedir(), '.batshit', 'runtime', 'apple-container');
}

/** The `container` a caller's PATH finds, as PATH names it, or null. */
export function findContainerOnPath(pathValue = process.env.PATH) {
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'container');
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Record that a `system start` which ran from `callStartedAt` to `callEndedAt` started the system. */
export async function writeAppleContainerSystemRecord(
  stateDir,
  { launchedBy = null, callStartedAt, callEndedAt, containerPath = null }
) {
  const record = {
    ...(launchedBy ? { launchedBy } : {}),
    callStartedAt: new Date(callStartedAt).toISOString(),
    callEndedAt: new Date(callEndedAt).toISOString(),
    ...(containerPath ? { containerPath } : {})
  };
  await mkdir(stateDir, { recursive: true });
  const recordPath = join(stateDir, APPLE_CONTAINER_SYSTEM_RECORD_NAME);
  const temp = join(stateDir, `${APPLE_CONTAINER_SYSTEM_RECORD_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
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
export async function readAppleContainerSystemRecord(stateDir) {
  const read = await readAppleContainerSystemRecordState(stateDir);
  if (read.state === 'absent') return null;
  if (read.state === 'unknown') return { invalid: true, reason: read.reason };
  return read.record;
}

/**
 * The record as one generation (BL-1256): `{ state: 'absent' }` only when there is no file
 * (`ENOENT`); `{ state: 'unknown', reason }` when it cannot be read as a record (any other error,
 * not a file, empty, not JSON, not an object), so nobody may treat it as gone; or `{ state:
 * 'present', record, generation }`, where `generation` (device, inode, and a digest of the bytes,
 * all from one open file) is what a later effect checks it still acts on. The sbx stop keeps the
 * same reader for its own record.
 */
export async function readAppleContainerSystemRecordState(stateDir) {
  const recordPath = join(stateDir, APPLE_CONTAINER_SYSTEM_RECORD_NAME);
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

function sameRecordGeneration(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino && left.sha256 === right.sha256;
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
async function whileAppleRecordGenerationHolds(stateDir, generation, work) {
  const current = await readAppleContainerSystemRecordState(stateDir);
  if (current.state !== 'present' || !sameRecordGeneration(current.generation, generation)) return { held: false };
  return { held: true, value: await work() };
}

/**
 * Did the recorded call make the registration running now? Its plist was written while the call
 * ran. A file system that keeps whole seconds dates the write to its second, rounded down, so the
 * window opens at the second the call began.
 */
export function registeredByRecordedCall(record, registeredAtMs) {
  const window = recordedStartWindow(record);
  if (!window || !Number.isFinite(registeredAtMs)) return false;
  return registeredAtMs >= window.from && registeredAtMs <= window.to;
}

/**
 * The recorded `system start` call's window `{ from, to }` (from rounded down to its second), or null
 * when the record's times are missing, unreadable, or out of order (BL-1255): then nothing can be
 * proven about whose registration runs.
 */
export function recordedStartWindow(record) {
  const from = Date.parse(record?.callStartedAt ?? '');
  const to = Date.parse(record?.callEndedAt ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return { from: Math.floor(from / 1000) * 1000, to };
}

/**
 * The containers a `container list --all --format json` shows as busy: any not stopped (running,
 * stopping, or a state it cannot name), and a Batshit sandbox still starting. Throws when the
 * output is not a list.
 */
export function busyAppleContainers(stdout, nowMs = Date.now()) {
  return parseAppleContainerList(stdout)
    .filter((entry) => {
      const status = String(entry?.status ?? entry?.state ?? '').toLowerCase();
      if (status !== 'stopped') return true;
      if (!entryId(entry).startsWith(SANDBOX_NAME_PREFIX)) return false;
      if (entry.startedDate !== null && entry.startedDate !== undefined) return false;
      const createdAt = Number(entry?.configuration?.labels?.[CREATED_AT_LABEL]);
      return Number.isFinite(createdAt) && nowMs - createdAt <= NEVER_STARTED_DEAD_AFTER_MS;
    })
    .map((entry) => entryId(entry) || '?');
}

/**
 * Is this record this Batshit's to act on? `legacy` (the Mac supervisor, the native launcher): its
 * own, unmarked, or a native run's that is gone. `exact` (the Pinokio lane, BL-1257): only a record
 * that names exactly this owner; an unmarked or another owner's never is.
 */
export function appleContainerSystemRecordIsOurs(record, owner = null, ownerIsGone = () => false, ownerPolicy = 'legacy') {
  if (ownerPolicy === 'exact') return Boolean(owner) && record.launchedBy === owner;
  return !record.launchedBy || !owner || record.launchedBy === owner || ownerIsGone(record.launchedBy);
}

function notOursReason(record) {
  return record.launchedBy ? `another Batshit (${record.launchedBy}) started it` : 'its record names no Batshit';
}

/**
 * Should this shutdown stop the system, given the record and the system as `system status` finds it
 * (`{ state: 'unregistered' }`, `{ state: 'not-running' }` when registered but not answering, or
 * `{ state: 'running', registeredAtMs }`)? `check-containers` is a candidate, not a verdict: the
 * caller still lists the containers first.
 */
export function decideAppleContainerSystemStop({ record, system, owner = null, ownerIsGone = () => false, ownerPolicy = 'legacy' }) {
  if (!record) return { action: 'none', verdict: 'absent' };
  // An unreadable record is kept (BL-1256): it may name a system still running.
  if (record.invalid) return { action: 'keep', verdict: 'unknown', reason: record.reason ?? 'its record could not be read' };
  if (!appleContainerSystemRecordIsOurs(record, owner, ownerIsGone, ownerPolicy)) {
    return { action: 'keep', verdict: 'not-ours', reason: notOursReason(record) };
  }
  if (!system || system.error) {
    return { action: 'keep', verdict: 'unknown', reason: `it could not be checked: ${system?.error ?? 'no answer'}` };
  }
  // Only Apple's own "unregistered" proves the system is gone.
  if (system.state === 'unregistered') {
    return { action: 'drop-record', verdict: 'gone', reason: 'it is no longer running' };
  }
  if (system.state !== 'running') {
    return { action: 'keep', verdict: 'unknown', reason: 'it does not answer, so its containers cannot be checked' };
  }
  // Without the registration's time, whose registration runs cannot be told: keep it, and the record.
  if (system.registrationError) {
    return { action: 'keep', verdict: 'unknown', reason: `it could not be checked: ${system.registrationError}` };
  }
  if (!recordedStartWindow(record)) {
    return { action: 'keep', verdict: 'unknown', reason: 'its record has no readable call time' };
  }
  if (!Number.isFinite(system.registeredAtMs)) {
    return { action: 'keep', verdict: 'unknown', reason: "the registration's time could not be read" };
  }
  if (!registeredByRecordedCall(record, system.registeredAtMs)) {
    return {
      action: 'drop-record',
      verdict: 'gone',
      reason: 'it was started again since, so the system running now is not the one Batshit started'
    };
  }
  return { action: 'check-containers' };
}

// A timed-out call is killed outright: a quit must never wait on a stuck CLI.
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

// The recorded `container` first, then whatever PATH finds (with Apple's install folder added).
async function runContainer(record, args, timeoutMs, fallbackPathDirs = FALLBACK_PATH_DIRS) {
  const env = { ...process.env, PATH: [process.env.PATH, ...fallbackPathDirs].filter(Boolean).join(delimiter) };
  const commands = [...new Set([isAbsolute(record?.containerPath ?? '') ? record.containerPath : null, 'container'].filter(Boolean))];
  let last = null;
  for (const command of commands) {
    last = await run(command, args, timeoutMs, env);
    if (last.error?.code !== 'ENOENT') return last;
  }
  return last;
}

function failureText(result) {
  if (result.error?.killed || result.error?.signal) return 'it did not answer in time';
  return (result.stderr || result.stdout || result.error?.message || 'no output').trim().split('\n').pop();
}

/**
 * The system as `container system status --format json` reports it (a status check never starts
 * anything): `{ state: 'unregistered' }`, `{ state: 'not-running' }`, `{ state: 'running',
 * registeredAtMs }` from its plist, or `{ error }` when it cannot be told (`absent` too when there
 * is no `container` to run). The CLI exits 1 for the first two and still prints the JSON. A running
 * system whose registration cannot be read is `{ state: 'running', registrationError }`: its
 * containers can still be listed, and its stop is not decided.
 */
async function readAppleContainerSystem(container, timeoutMs) {
  const status = await container(['system', 'status', '--format', 'json'], timeoutMs);
  if (status.error?.killed || status.error?.signal || status.error?.code === 'ENOENT') {
    return {
      error: `container system status failed (${failureText(status)})`,
      ...(status.error?.code === 'ENOENT' ? { absent: true } : {})
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(status.stdout.slice(Math.max(0, status.stdout.indexOf('{'))));
  } catch {
    return { error: 'container system status printed something Batshit cannot read' };
  }
  if (parsed?.status === 'unregistered') return { state: 'unregistered' };
  if (parsed?.status !== 'running') return { state: 'not-running' };
  if (typeof parsed.appRoot !== 'string' || !parsed.appRoot) {
    return { state: 'running', registrationError: 'container system status named no app root' };
  }
  const plist = join(parsed.appRoot, 'apiserver', 'apiserver.plist');
  const info = await stat(plist).catch(() => null);
  if (!info) return { state: 'running', registrationError: `the apiserver registration ${plist} could not be read` };
  return { state: 'running', registeredAtMs: info.mtimeMs };
}

/**
 * How long the quit's `delete` of this Batshit's sandboxes may take: what the stop's budget leaves at
 * `nowMs` once the stop and the status after it are set aside. At least 1 ms, because `execFile`
 * reads 0 as no limit at all.
 */
export function appleContainerSweepTimeoutMs(deadline, nowMs, callTimeoutMs, stopTimeoutMs) {
  return Math.max(1, deadline - nowMs - stopTimeoutMs - callTimeoutMs);
}

/**
 * Delete the sandboxes this Batshit left running (BL-149), found in `listed` (the stop's one
 * `container list`), within `budgetMs`. Answers null when there is nothing to say, or `{ removed,
 * notRemoved?, reason? }`, or `{ reason }` when they could not be looked for. `delete` prints each id
 * it deleted, so a partial failure is told apart per sandbox.
 */
async function removeOwnAppleContainerSandboxes(container, listed, owner, timeoutMs) {
  if (!listed.ok) return { reason: `its containers could not be listed (${failureText(listed)})` };
  let own;
  try {
    own = appleContainerSandboxesOwnedBy(listed.stdout, owner);
  } catch (error) {
    return { reason: `its container list could not be read (${error.message})` };
  }
  if (!own.length) return null;
  const deleted = await container(['delete', '--force', ...own], timeoutMs);
  const printed = new Set(deleted.stdout.split('\n').map((line) => line.trim()));
  const removed = deleted.ok ? own : own.filter((id) => printed.has(id));
  const notRemoved = own.filter((id) => !removed.includes(id));
  return notRemoved.length ? { removed, notRemoved, reason: failureText(deleted) } : { removed };
}

/**
 * Stop the system if this Batshit's call started it and nothing runs in it. Answers what happened, as
 * `action` (`none`, `drop-record`, `keep`, `stopped`; `ok: false` only when a stop was tried and the
 * system is still registered, or a sandbox of this Batshit's could not be removed) and as `verdict`,
 * which says whether its record can be forgotten (BL-1255):
 * - `absent`: there is no record (`ENOENT`);
 * - `gone`: Apple says the system is unregistered, or the registration running now was made at
 *   another time than the recorded call (both times readable); the record is removed;
 * - `stopped`: stopped with `container system stop` and seen unregistered; the record is removed;
 * - `kept`: a container runs in it, or the stop did not take; the record stays;
 * - `not-ours`: another Batshit's (or, with `ownerPolicy: 'exact'`, any record not naming exactly
 *   this owner); the system is never stopped and the record never changed;
 * - `unknown`: the record could not be read, a probe failed or answered something unreadable, or the
 *   record changed while it was checked; the record stays.
 * A stop or a removal happens only while the record is still the generation that was admitted. Every
 * `container` call is bounded, and the whole stop fits `APPLE_CONTAINER_STOP_WORST_CASE_MS` (for the
 * defaults), so a stuck CLI costs a quit seconds, never minutes.
 *
 * First, with an owner and `removeOwnSandboxes` (the caller knows its app is down, so no command of
 * it still runs in one), it removes the sandboxes this Batshit left running (BL-149), whoever started
 * the system: `sandboxes: { removed, notRemoved?, reason? }` says what it did, and is left out when
 * there was nothing of this Batshit's to remove. Without it, a running sandbox of this Batshit's
 * keeps the system, as any running container does. The sweep goes by the sandboxes' owner label,
 * never by the record.
 */
export async function stopAppleContainerSystemIfBatshitStartedIt({
  stateDir,
  owner = null,
  ownerIsGone = nativeRunIsGone,
  ownerPolicy = 'legacy',
  removeOwnSandboxes = false,
  callTimeoutMs = APPLE_CONTAINER_CALL_TIMEOUT_MS,
  stopTimeoutMs = APPLE_CONTAINER_SYSTEM_STOP_TIMEOUT_MS,
  fallbackPathDirs = FALLBACK_PATH_DIRS,
  now = Date.now,
  lockWaitMs = APPLE_CONTAINER_RECORD_LOCK_WAIT_MS
}) {
  if (ownerPolicy === 'exact' && !owner) throw new TypeError('an exact owner policy needs an owner');
  const deadline = Date.now() + 3 * callTimeoutMs + stopTimeoutMs;
  const options = { stateDir, owner, ownerIsGone, ownerPolicy, removeOwnSandboxes, callTimeoutMs, stopTimeoutMs, fallbackPathDirs, now, deadline };
  // Without an effect on the record to protect, no lock: nothing there, unreadable, or not this
  // Batshit's (its own sandboxes may still be swept: that goes by their label, never by the record).
  const first = await readAppleContainerSystemRecordState(stateDir);
  if (!(first.state === 'present' && appleContainerSystemRecordIsOurs(first.record, owner, ownerIsGone, ownerPolicy))) {
    return settleAppleContainerSystem(first, options);
  }
  // A record of this Batshit's: the whole decision and every effect happen under the folder's record
  // lock, reading the record again once it is held, so no cooperating writer or remover can replace it
  // in between (BL-1257). A lock that is busy past the wait, or one that cannot be taken safely (no
  // valid owner, an unfinished reap), keeps everything, and says so.
  let locked = false;
  try {
    return await withLocalRuntimeRecordLock(
      stateDir,
      async () => {
        locked = true;
        return settleAppleContainerSystem(await readAppleContainerSystemRecordState(stateDir), options);
      },
      { waitMs: Math.max(0, Math.min(lockWaitMs, deadline - Date.now() - stopTimeoutMs - callTimeoutMs)) }
    );
  } catch (error) {
    const what = locked ? 'it could not be settled' : 'its record could not be locked';
    return { action: 'keep', verdict: 'unknown', reason: `${what} (${error?.message ?? error})` };
  }
}

// One read of the record, decided and acted on: the sweep of this Batshit's own sandboxes, then the
// system. Called under the record lock whenever the record is this Batshit's.
async function settleAppleContainerSystem(
  read,
  { stateDir, owner, ownerIsGone, ownerPolicy, removeOwnSandboxes, callTimeoutMs, stopTimeoutMs, fallbackPathDirs, now, deadline }
) {
  const record = read.state === 'present' ? read.record : read.state === 'unknown' ? { invalid: true, reason: read.reason } : null;
  const generation = read.state === 'present' ? read.generation : null;
  const recordIsOurs = read.state === 'present' && appleContainerSystemRecordIsOurs(record, owner, ownerIsGone, ownerPolicy);
  const sweeping = removeOwnSandboxes === true && appleContainerOwnerLabelValue(owner) !== null;
  // No record of this Batshit's and no owner to look for sandboxes by: no `container` call at all,
  // and an unreadable or another Batshit's record is never removed.
  if (!recordIsOurs && !sweeping) {
    return decideAppleContainerSystemStop({ record, system: null, owner, ownerIsGone, ownerPolicy });
  }
  // The recorded `container` only for a record of this Batshit's.
  const container = (args, timeoutMs) => runContainer(recordIsOurs ? record : null, args, timeoutMs, fallbackPathDirs);
  const system = await readAppleContainerSystem(container, callTimeoutMs);

  let listed = null;
  let sandboxes = null;
  if (sweeping && system.state === 'running') {
    listed = await container(['list', '--all', '--format', 'json'], callTimeoutMs);
    // The stop and the status after it keep their own bounds; the delete gets the rest.
    const sweepTimeoutMs = appleContainerSweepTimeoutMs(deadline, Date.now(), callTimeoutMs, stopTimeoutMs);
    sandboxes = await removeOwnAppleContainerSandboxes(container, listed, owner, sweepTimeoutMs);
  } else if (sweeping && system.state === 'not-running') {
    sandboxes = { reason: 'this Batshit\'s sandboxes could not be looked for: the system is registered but does not answer' };
  } else if (sweeping && system.error && !system.absent) {
    sandboxes = { reason: `this Batshit's sandboxes could not be looked for: ${system.error}` };
  }

  const decision = await stopAppleContainerSystemIfOurs({
    stateDir,
    record,
    generation,
    recordIsOurs,
    system,
    listed,
    removed: sandboxes?.removed ?? [],
    container,
    owner,
    ownerIsGone,
    ownerPolicy,
    callTimeoutMs,
    stopTimeoutMs,
    now,
    deadline
  });
  if (!sandboxes) return decision;
  return { ...decision, ...(sandboxes.notRemoved?.length ? { ok: false } : {}), sandboxes };
}

// The system part of the stop, once the system has been read (and, with an owner, listed and swept).
async function stopAppleContainerSystemIfOurs({
  stateDir,
  record,
  generation,
  recordIsOurs,
  system,
  listed,
  removed,
  container,
  owner,
  ownerIsGone,
  ownerPolicy,
  callTimeoutMs,
  stopTimeoutMs,
  now,
  deadline
}) {
  // No record, an unreadable one, or another Batshit's: decided without the system, never removed.
  if (!recordIsOurs) return decideAppleContainerSystemStop({ record, system: null, owner, ownerIsGone, ownerPolicy });
  const recordPath = join(stateDir, APPLE_CONTAINER_SYSTEM_RECORD_NAME);
  const decision = decideAppleContainerSystemStop({ record, system, owner, ownerIsGone, ownerPolicy });
  if (decision.action === 'drop-record') {
    const removal = await whileAppleRecordGenerationHolds(stateDir, generation, () => rm(recordPath, { force: true }));
    return removal.held ? decision : { action: 'keep', verdict: 'unknown', reason: RECORD_CHANGED };
  }
  if (decision.action !== 'check-containers') return decision;

  // One list per stop: the sweep's, when there was one.
  const list = listed ?? (await container(['list', '--all', '--format', 'json'], callTimeoutMs));
  if (!list.ok) {
    return { action: 'keep', verdict: 'unknown', reason: `its containers could not be listed (${failureText(list)})` };
  }
  let busy;
  try {
    busy = busyAppleContainers(list.stdout, now()).filter((id) => !removed.includes(id));
  } catch (error) {
    return { action: 'keep', verdict: 'unknown', reason: `its container list could not be read (${error.message})` };
  }
  if (busy.length) {
    return { action: 'keep', verdict: 'kept', reason: `a container is still running (${busy.join(', ')})` };
  }
  if (deadline - Date.now() < stopTimeoutMs + callTimeoutMs) {
    return { action: 'keep', verdict: 'unknown', reason: OUT_OF_TIME };
  }

  // A writer that does not take the lock (an older Batshit) could still have replaced it: check once more.
  const effect = await whileAppleRecordGenerationHolds(stateDir, generation, async () => {
    const stopped = await container(['system', 'stop'], stopTimeoutMs);
    const after = await readAppleContainerSystem(container, callTimeoutMs);
    // The record is removed only if it is still the admitted one, read again just before.
    const removed =
      after.state === 'unregistered'
        ? await whileAppleRecordGenerationHolds(stateDir, generation, () => rm(recordPath, { force: true }))
        : null;
    return { stopped, after, removed };
  });
  if (!effect.held) return { action: 'keep', verdict: 'unknown', reason: RECORD_CHANGED };
  if (effect.value.removed?.held === false) return { action: 'keep', verdict: 'unknown', reason: STOPPED_RECORD_CHANGED };
  const { stopped, after } = effect.value;
  if (after.state !== 'unregistered') {
    const detail = !stopped.ok
      ? failureText(stopped)
      : after.error ?? 'it was still registered after `container system stop`';
    return { action: 'keep', ok: false, verdict: after.error ? 'unknown' : 'kept', reason: `it did not stop (${detail})` };
  }
  return { action: 'stopped', ok: true, verdict: 'stopped' };
}
