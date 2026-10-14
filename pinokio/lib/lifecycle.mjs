// What a Start must settle before and while Batshit's processes come up: the order the lane's
// ports are proven idle in, the lane's own voice engines left running by an earlier start
// (BL-343), and the moment the database is ready (BL-363). Kept out of cli.mjs, which runs a
// command when it is imported, so the tests can drive each step against real temporary processes.
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { open, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { LANE_HOST, LANE_PORTS } from './lane.mjs';

import {
  decideLocalRuntimeGroupStop,
  groupLocalRuntimeLaunchRecords,
  holdLocalRuntimeStopsForUnreadableRecords,
  isLocalRuntimeProcessAlive,
  readLocalRuntimeLaunchRecords,
  readLocalRuntimeProcessGroup,
  removeLocalRuntimeLaunchRecord
} from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs';

// ---- The lane's ports ---------------------------------------------------------------------
//
// The database comes last: Batshit's own leftover Redis is shut down only once the file server's
// and the app's ports are proven idle, so a lane whose app still runs never loses its database.
export const LANE_PORT_CHECKS = Object.freeze([
  ['file server', LANE_PORTS.server],
  ['app', LANE_PORTS.app],
  ['database', LANE_PORTS.redis]
]);

// The app's resolveVoiceRuntimeRegistryIdentity normalizes the fixed lane REDIS_URL to
// host:port/database, without credentials, then stamps this digest. sharedLaneEnv pins DB0.
// A record's folder and copied starter launchedBy are not the attaching registry's custody.
export const LANE_VOICE_RUNTIME_REGISTRY =
  `redis-${createHash('sha256').update(`${LANE_HOST}:${LANE_PORTS.redis}/0`).digest('hex').slice(0, 16)}`;

/**
 * Prove every lane port idle, in LANE_PORT_CHECKS order. `stopOwnLeftoverRedis` answers whether
 * what holds the database port was this lane's own Redis, now stopped; `busy(name, port)` returns
 * the error thrown for a port something else holds.
 */
export async function proveLanePortsIdle({ isFree, stopOwnLeftoverRedis, busy }) {
  for (const [name, port] of LANE_PORT_CHECKS) {
    if (await isFree(port)) continue;
    if (port === LANE_PORTS.redis && (await stopOwnLeftoverRedis())) continue;
    throw busy(name, port);
  }
}

/**
 * Everything `preflight` settles before Start runs anything: the lane's ports proven idle (which
 * may stop this lane's own leftover Redis, last), and only then this lane's leftover voice
 * engines. Nothing is stopped while a port another program holds makes Start fail.
 */
export async function settleBeforeStart({
  isFree,
  stopOwnLeftoverRedis,
  busy,
  stopLeftoverEngines,
  stopLeftoverServices = async () => []
}) {
  await proveLanePortsIdle({ isFree, stopOwnLeftoverRedis, busy });
  await stopLeftoverEngines();
  // Never blocks Start: what could not be stopped was reported, and its record is kept (BL-1249).
  await stopLeftoverServices();
}

/**
 * What Delete Batshit data settles before it deletes anything: every lane port idle (a database
 * still running is refused, never stopped, so nothing is lost), then this lane's leftover voice
 * engines stopped as at Start. Answers the engines that still run and may be this lane's: they run
 * from the data root's installs and only its records name them, so deleting it under them would
 * leave them running with nothing that can ever stop them.
 */
export async function settleBeforeDelete({ isFree, busy, stopLeftoverEngines, stopLeftoverServices = async () => [] }) {
  await proveLanePortsIdle({ isFree, stopOwnLeftoverRedis: async () => false, busy });
  const engines = enginesBlockingDelete(await stopLeftoverEngines());
  // A service this lane started that still runs, cannot be checked, or did not stop holds Delete up
  // too: its record is the only thing that lets a Batshit stop it later (BL-1249).
  return [...engines, ...servicesBlockingDelete(await stopLeftoverServices())];
}

// Kept by Stop with Batshit, unverified, unstoppable, unchecked, or named by a record that could not
// be read (BL-1264). Another Batshit's process, or a reused pid, is not this lane's, so its record in
// this lane's folder does not hold up a delete.
const DELETE_BLOCKING_RESULTS = new Set(['kept-by-choice', 'unverified', 'still-running', 'unchecked', 'unreadable']);

export function enginesBlockingDelete(results) {
  return results.filter((entry) => DELETE_BLOCKING_RESULTS.has(entry.result));
}

/** Why Delete refused for these engines, and what to do, in words that never stop a Pinokio step. */
export function describeEnginesBlockingDelete(engines, { engineStopPolicy = 'per-engine' } = {}) {
  const parts = [];
  const unknown = engines.filter((entry) => entry.recordIssue === 'no-process-id');
  const custody = engines.filter((entry) => entry.recordIssue === 'registry-custody');
  const running = engines.filter((entry) => entry.result !== 'unreadable' && !entry.recordIssue);
  const unreadable = engines.filter((entry) => entry.result === 'unreadable');
  if (running.length > 0) {
    const one = running.length === 1;
    const retry = engineStopPolicy === 'all-owned'
      ? 'Windows Pinokio stops only engines it can prove this install owns. A launch record it could not check stays in place. Restart the computer to end the guest engines, then delete again.'
      : 'Where Stop with Batshit is off, click Start, turn it on for that engine in Batshit, press Stop, then delete again. An engine Batshit could not check or stop stops when you restart the computer.';
    parts.push(
      `${running.map((entry) => entry.label).join(', ')} ${one ? 'is' : 'are'} still running (the lines above say why), and deleting Batshit's data would leave ${one ? 'it' : 'them'} running with nothing that can stop ${one ? 'it' : 'them'}. ${retry}`
    );
  }
  if (unreadable.length > 0) {
    const one = unreadable.length === 1;
    const where = unreadable.map((entry) => pinokioSafeText(entry.recordPath)).join(', ');
    parts.push(
      `${one ? 'a voice engine launch record' : `${unreadable.length} voice engine launch records`} could not be read (${where}), and ${one ? 'it' : 'they'} may name an engine that still runs from Batshit's data. Restart the computer (that stops every engine Batshit started), remove ${one ? 'that file or folder' : 'those files or folders'} yourself, then delete again.`
    );
  }
  if (unknown.length > 0) {
    const one = unknown.length === 1;
    const where = unknown.map((entry) => entry.recordPath).join(', ');
    parts.push(
      `${one ? 'a voice engine launch record names' : `${unknown.length} voice engine launch records name`} no usable process (${where}), so Batshit cannot prove the engines have ended. No voice engine was stopped and no launch record was removed. Once you have confirmed the engines have ended (restarting the computer ends the guest engines), repair or remove ${one ? 'that file' : 'those files'}, then delete again. Restarting alone does not repair the record.`
    );
  }
  if (custody.length > 0) {
    const where = custody.flatMap((entry) => entry.recordPaths).join(', ');
    parts.push(
      `voice registry ownership could not be confirmed for ${custody.map((entry) => entry.label).join(', ')} (${where}). A record belongs to another or unknown Batshit registry, so the whole group and its launch records were left as they were. Delete remains blocked until that record ownership is resolved.`
    );
  }
  return parts.join(' ');
}

// ---- Voice engines an earlier start left running (BL-343) ---------------------------------
//
// Pinokio's Stop kills the script's process tree and runs nothing else, so the voice engines the
// app launched (detached, in their own process groups) keep running. The lane cannot stop them at
// Stop; it stops them at the next Start, after preflight has proven every lane port idle, so no
// Batshit of this lane is running that could still be using them. The decision is the one the Mac
// app's supervisor and the native launcher use (`local-voice-runtime-stop.mjs`): the pid-reuse
// guard (the group leader's start time, then its command line), "Stop with Batshit" off keeps an
// engine, a failed `ps` leaves it running with its record. One rule is stricter here: the lane
// stops only processes its own app marked as launched by this lane (`launchedBy`, the lane's
// BATSHIT_VOICE_RUNTIME_OWNER), never an unmarked one. The lane has stamped every launch since its
// first release, so an unmarked record in its folder was not written by it.

const SIGTERM_GRACE_MS = 2_000;
const POLL_MS = 100;

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// SIGTERM to the whole group, a short grace, then SIGKILL: the native launcher's teardown.
export async function terminateProcessGroup(pgid, { graceMs = SIGTERM_GRACE_MS } = {}) {
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return { ok: true, escalated: false };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return { ok: true, escalated: false };
    await sleep(POLL_MS);
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    if (error?.code === 'ESRCH') return { ok: true, escalated: true };
  }
  await sleep(POLL_MS * 2);
  return { ok: !groupAlive(pgid), escalated: true };
}

function describe(problem) {
  return problem?.message ?? String(problem);
}

function engineLabel(records) {
  const starter = records.find((record) => !record.startedBy) ?? records[0];
  const others = records.filter((record) => record !== starter).map((record) => `"${record.engineId}"`);
  return `voice engine "${starter.engineId}"${others.length ? ` (shared with ${others.join(', ')})` : ''}`;
}

// The lane's exact-owner rule: it claims a process only when every record naming it carries this
// lane's own mark. Exported so the stop-watch applies the same rule instead of a copy.
export function recordsAreLaneOwned(records, owner) {
  return records.length > 0 && records.every((record) => record.launchedBy === owner);
}

// The durable launch profile changes Redis persistence only. The Windows launcher opts its
// owned Linux guest into this separate engine policy; the profile grants no stop authority.
export function resolvePinokioEngineStopPolicy({ env = process.env, platform = process.platform } = {}) {
  const host = env.BATSHIT_PINOKIO_HOST;
  const policy = env.BATSHIT_PINOKIO_ENGINE_STOP_POLICY;
  if (host === undefined && policy === undefined) return 'per-engine';
  if (platform !== 'linux' || host !== 'windows-wsl' || policy !== 'all-owned') {
    throw new TypeError('Windows voice engine stopping requires Linux, BATSHIT_PINOKIO_HOST=windows-wsl and BATSHIT_PINOKIO_ENGINE_STOP_POLICY=all-owned.');
  }
  return 'all-owned';
}

function validateEngineStopPolicy(engineStopPolicy, platform) {
  if (engineStopPolicy !== 'per-engine' && engineStopPolicy !== 'all-owned') {
    throw new TypeError('Unknown Pinokio voice engine stop policy.');
  }
  if (engineStopPolicy === 'all-owned' && platform !== 'linux') {
    throw new TypeError('The all-owned Pinokio voice engine stop policy requires Linux.');
  }
}

// Reuse the shared PID/group proof, overriding choices only for a wholly lane-owned group and
// only in memory. Return original record identities so existing guarded removal stays intact.
export function decideLaneVoiceRuntimeGroupStop(inputs, { engineStopPolicy = 'per-engine', platform = process.platform } = {}) {
  validateEngineStopPolicy(engineStopPolicy, platform);
  if (engineStopPolicy !== 'all-owned') return decideLocalRuntimeGroupStop(inputs);
  if (!inputs.owner || !recordsAreLaneOwned(inputs.records, inputs.owner)) {
    return { action: 'keep-running', reason: 'a record naming it is not this Pinokio install\'s own launch', stale: [] };
  }
  if (inputs.records.some((record) => record.registry !== LANE_VOICE_RUNTIME_REGISTRY)) {
    return { action: 'keep-running', reason: 'a record naming it belongs to another or unknown voice registry, so its choice and records are kept', stale: [] };
  }
  const records = inputs.records.map((record) => ({ ...record, stopOnShutdown: true }));
  const decision = decideLocalRuntimeGroupStop({ ...inputs, records });
  return { ...decision, stale: decision.stale.map((record) => inputs.records[records.indexOf(record)]) };
}

// One process, with every record that names it. Answers what was done and its label:
// gone | refused (a reused pid, not this lane's) | unverified (`ps` failed) | kept-by-choice (Stop
// with Batshit off) | not-ours (another Batshit's, or unmarked) | still-running | stopped. The pass
// adds `unreadable` (a record it could not read) and `held` (a process left unchecked because one
// was unreadable; the unreadable record itself holds Delete up).
async function settleLeftoverEngine({ pid, records }, { owner, say, engineStopPolicy, platform, isAlive, readGroup, terminate, removeRecord }) {
  const alive = isAlive(pid);
  const group = alive ? await readGroup(pid) : { commandLines: [], leaderStartedAtMs: null };
  const decision = decideLaneVoiceRuntimeGroupStop({
    records,
    alive,
    commandLines: group ? group.commandLines : null,
    leaderStartedAtMs: group ? group.leaderStartedAtMs : null,
    owner
  }, { engineStopPolicy, platform });
  // A stale record names no process of this lane (it is gone, or its pid was reused): failing to
  // remove it is reported, and the next start tries again.
  for (const record of decision.stale) {
    await removeRecord(record).catch((problem) =>
      say(`could not remove a stale launch record of voice engine "${record.engineId}" (${describe(problem)}).`)
    );
  }
  const live = records.filter((record) => !decision.stale.includes(record));
  const ours = recordsAreLaneOwned(live, owner);
  const label = engineLabel(live.length ? live : records);

  if (decision.action === 'drop-records') return { result: 'gone', label };
  if (decision.action === 'refuse') {
    say(`did not stop ${label}: ${decision.reason}.`);
    return { result: 'refused', label };
  }
  if (decision.action === 'unverified' || decision.action === 'keep-running') {
    // An attachment copies the starter's launcher mark but carries its attaching registry.
    // This lane may still own the starter and its files, so unknown registry custody must hold
    // whole-root Delete too; "not ours" would erase the records under that shared process.
    if (engineStopPolicy === 'all-owned' && decision.action === 'keep-running' && ours &&
        live.some((record) => record.registry !== LANE_VOICE_RUNTIME_REGISTRY)) {
      say(`left ${label} and its launch records as they were: ${decision.reason}.`);
      return {
        result: 'unchecked', label, recordIssue: 'registry-custody',
        recordPaths: live.map((record) => record.recordPath), reason: decision.reason
      };
    }
    say(`left ${label} running: ${decision.reason}.`);
    // A keep-running decision without `keptBy` is another Batshit's launch.
    if (!ours || (decision.action === 'keep-running' && !decision.keptBy)) return { result: 'not-ours', label };
    return { result: decision.action === 'unverified' ? 'unverified' : 'kept-by-choice', label };
  }
  // The shared decision stops an unmarked launch (the Mac supervisor's rule for records written
  // before launches were marked); this lane claims a process only when every record naming it
  // carries this lane's own mark.
  if (!ours) {
    say(`left ${label} running: its record does not say this Pinokio install launched it.`);
    return { result: 'not-ours', label };
  }
  const stopped = await terminate(pid);
  if (!stopped.ok) {
    say(`could not stop ${label} (process group ${pid}); it is still running.`);
    return { result: 'still-running', label };
  }
  say(`stopped ${label}, left running by an earlier start (process group ${pid}).`);
  for (const record of live) {
    // Its process is gone, so the next start drops a record that could not be removed now.
    await removeRecord(record).catch((problem) =>
      say(`could not remove the launch record of voice engine "${record.engineId}" (${describe(problem)}).`)
    );
  }
  return { result: 'stopped', label };
}

/**
 * Stop this lane's own voice engines that an earlier start left running. Call it only after every
 * lane port is proven idle. Never throws for one engine's trouble: each is reported and the start
 * goes on, leaving that engine as it was.
 */
export async function stopLeftoverVoiceEngines({
  stateRoot,
  owner,
  say,
  engineStopPolicy = 'per-engine',
  platform = process.platform,
  isAlive = isLocalRuntimeProcessAlive,
  readGroup = readLocalRuntimeProcessGroup,
  terminate = terminateProcessGroup,
  removeRecord = removeLocalRuntimeLaunchRecord
}) {
  if (!owner) throw new TypeError('owner is required: the lane stops only its own launches');
  validateEngineStopPolicy(engineStopPolicy, platform);
  const { groups, unusable, unreadable } = groupLocalRuntimeLaunchRecords(await readLocalRuntimeLaunchRecords(stateRoot));
  const deps = { owner, say, engineStopPolicy, platform, isAlive, readGroup, terminate, removeRecord };
  // A record that could not be read may name an engine of this lane that still runs: it is left as
  // it is, said, and holds Delete up (BL-1264). It never holds Start up.
  const unreadableOutcomes = unreadable.map((record) => {
    say(`${pinokioSafeText(record.reason)}; left it, and any voice engine it names, as they are.`);
    return {
      pid: null,
      result: 'unreadable',
      label: record.engineId ? `voice engine "${record.engineId}"` : 'the voice engines',
      reason: record.reason,
      recordPath: record.recordPath
    };
  });
  // One record that could not be read hides who uses which process: it could be another engine's
  // "keep running" for a process a readable record says to stop. So nothing is stopped and no record
  // is removed in this pass; every record stays for the next one (BL-1264).
  // In the owned Windows guest, a record naming no usable process is unknown too. Preserve it
  // and hold the pass, matching the watcher's whole-inventory guard rather than guessing.
  const unknownOutcomes = engineStopPolicy === 'all-owned' ? unusable.map((record) => {
    sayInPieces(say, `left the launch record of voice engine "${record.engineId}" (${record.recordPath}) as it is: it names no usable process. Once the engines have ended, repair or remove that file; restarting alone does not repair it.`);
    return { pid: null, result: 'unchecked', recordIssue: 'no-process-id', label: `voice engine "${record.engineId}"`, recordPath: record.recordPath };
  }) : [];
  if (unreadableOutcomes.length > 0 || unknownOutcomes.length > 0) {
    if (groups.length > 0 || unusable.length > 0) {
      // The shared words: the engines stop first, then the file is repaired or removed.
      sayInPieces(say, unreadable.length > 0
        ? `${holdLocalRuntimeStopsForUnreadableRecords(unreadable).reason}; the next Start settles them.`
        : 'a launch record names no usable process; left every voice engine and launch record as they are.');
    }
    const held = groups.map(({ pid, records }) => ({ pid, result: 'held', label: engineLabel(records) }));
    return [...unreadableOutcomes, ...unknownOutcomes, ...held];
  }
  await Promise.all(
    unusable.map((record) =>
      removeRecord(record).catch((problem) =>
        say(`could not remove the unusable launch record of voice engine "${record.engineId}" (${describe(problem)}).`)
      )
    )
  );
  const outcomes = await Promise.all(
    groups.map((group) =>
      settleLeftoverEngine(group, deps).catch((problem) => {
        say(`could not check the voice engine in process group ${group.pid} (${describe(problem)}); left it as it was.`);
        return { result: 'unchecked', label: `the voice engine in process group ${group.pid}` };
      })
    )
  );
  return groups.map((group, index) => ({ pid: group.pid, ...outcomes[index] }));
}

// ---- Sandbox services an earlier start left running (BL-1249) ----------------------------
//
// The app can start two per-user services that are not in Pinokio's process tree, so Pinokio's Stop
// never ends them: Docker's sbx daemon (any `sbx` call starts it; `nativeTools.ts` records the call)
// and Apple's container system (`container system start` registers a launchd LaunchAgent;
// `appleContainerSandbox.ts` records it). Each record names the Batshit that made the call
// (`launchedBy`) and the call's time window, in this lane's own state folders. The shared stops
// (`sbx-daemon-stop.mjs`, `apple-container-system-stop.mjs`, as the Mac supervisor and the native
// launcher use them) stop a service only when it started inside that window and nothing runs in it.
// Their legacy ownership rule is wider than this lane may use (an unmarked record, no owner, or a gone
// native run all count as theirs), so the lane calls them with `ownerPolicy: 'exact'`: inside the shared
// stop, only a record naming exactly this lane's owner is acted on, and every effect happens only while
// the record is still the generation it admitted. An unreadable, unmarked, or another Batshit's record
// is never acted on, and only a verdict of absent, gone, stopped, or not-ours lets Delete go on. Apple's sweep of this lane's own leftover sandboxes
// (labelled with this owner's digest) runs only here, after every lane port is proven idle, so the
// app that used them is down. Nothing here writes a new file: the only records are the app's own.

const SANDBOX_SERVICES = [
  {
    key: 'sbx',
    label: "Docker's sbx daemon",
    module: '../../batshit-mac/scripts/sbx-daemon-stop.mjs',
    recordName: 'SBX_DAEMON_RECORD_NAME',
    readState: 'readSbxDaemonRecordState',
    stop: 'stopSbxDaemonIfBatshitStartedIt',
    stateDir: (paths) => paths.sbxDaemon,
    platforms: null,
    sweepOwnSandboxes: false,
    check: 'check it with "sbx daemon status" and stop it with "sbx daemon stop" once no sandbox needs it'
  },
  {
    key: 'apple-container',
    label: "Apple's container system",
    module: '../../batshit-mac/scripts/apple-container-system-stop.mjs',
    recordName: 'APPLE_CONTAINER_SYSTEM_RECORD_NAME',
    readState: 'readAppleContainerSystemRecordState',
    stop: 'stopAppleContainerSystemIfBatshitStartedIt',
    stateDir: (paths) => paths.appleContainer,
    platforms: ['darwin'],
    sweepOwnSandboxes: true,
    check: 'check it with "container system status" and stop it with "container system stop" once no container needs it'
  }
];

const REASON_LIMIT = 240;

/**
 * Text from outside the launcher (a CLI's last error line) made safe for Pinokio's terminal: one
 * line, at most REASON_LIMIT characters, and never the words that make Pinokio stop a step.
 */
export function pinokioSafeText(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(error):/gi, '$1 -')
    .replace(/(errno) /gi, '$1=');
  // Cut after the rewrite: cutting can never make those words, and the rewrite can lengthen.
  return flat.length > REASON_LIMIT ? `${flat.slice(0, REASON_LIMIT - 1)}…` : flat;
}

// A line longer than pinokioSafeText keeps is said in pieces, each made safe, so its end (what to
// do, in a safe order) is never cut off.
function sayInPieces(say, text) {
  let piece = '';
  for (const word of String(text ?? '').replace(/\s+/g, ' ').trim().split(' ')) {
    if (piece && piece.length + 1 + word.length > 200) {
      say(pinokioSafeText(piece));
      piece = word;
    } else {
      piece = piece ? `${piece} ${word}` : word;
    }
  }
  if (piece) say(pinokioSafeText(piece));
}

const never = () => false;

function isRecordFolderBookkeeping(name) {
  return (name.startsWith('.batshit-local-runtime-launch.') && !name.endsWith('.json')) || name.endsWith('.tmp');
}
const LISTED_NAMES = 5;

// Sandbox names for one line: each made safe, at most LISTED_NAMES, then how many more.
function nameList(names) {
  const safe = names.map(pinokioSafeText);
  const more = safe.length - LISTED_NAMES;
  return more > 0 ? `${safe.slice(0, LISTED_NAMES).join(', ')} and ${more} more` : safe.join(', ');
}

// One service, settled by its shared stop with `ownerPolicy: 'exact'`: the shared stop reads the
// record, admits only one naming exactly this lane's owner, and answers a verdict (BL-1255/1257).
// Answers { service, label, result, blocksDelete, ... } for Start's report and Delete's decision.
async function settleSandboxService(service, { paths, owner, say, load }) {
  const stateDir = service.stateDir(paths);
  const base = { service: service.key, label: service.label, check: service.check };
  let shared;
  try {
    shared = await load(service.module);
  } catch (problem) {
    // This checkout lacks the shared stop, so a record there can be neither read nor acted on. Only a
    // folder that is positively missing or empty holds nothing (BL-1256).
    const why = pinokioSafeText(describe(problem));
    let entries;
    try {
      entries = await readdir(stateDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...base, result: 'none', blocksDelete: false };
      say(`could not check ${service.label}: the launcher's stop for it did not load (${why}), and ${pinokioSafeText(stateDir)} could not be read (${pinokioSafeText(error?.code ?? error?.message)}).`);
      return { ...base, result: 'unknown', blocksDelete: true, reason: 'its folder could not be read', recordPath: stateDir };
    }
    // The record lock's own files (the lock, its candidates, releases and tombstones) and a writer's
    // leftover temp file are bookkeeping, not records.
    if (entries.filter((name) => !isRecordFolderBookkeeping(name)).length === 0) return { ...base, result: 'none', blocksDelete: false };
    say(`could not check ${service.label}: the launcher's stop for it did not load (${why}); the files in ${pinokioSafeText(stateDir)} are kept.`);
    return { ...base, result: 'unknown', blocksDelete: true, reason: 'the launcher could not read its record', recordPath: stateDir };
  }
  const recordPath = join(stateDir, shared[service.recordName]);
  let outcome;
  try {
    outcome = await shared[service.stop]({
      stateDir,
      owner,
      ownerIsGone: never,
      ownerPolicy: 'exact',
      ...(service.sweepOwnSandboxes ? { removeOwnSandboxes: true } : {})
    });
  } catch (problem) {
    const reason = pinokioSafeText(describe(problem));
    // With no record at all, only this owner's sandboxes were being looked for, and nobody could list them.
    const read = await shared[service.readState](stateDir).catch(() => ({ state: 'unknown' }));
    if (read.state === 'absent') {
      say(
        service.sweepOwnSandboxes
          ? `could not look for Apple Container sandboxes an earlier start left running: ${reason}.`
          : `could not check ${service.label} (${reason}); it has no record here, so nothing this lane started is known to run in it.`
      );
      return { ...base, result: 'none', blocksDelete: false };
    }
    say(`could not check ${service.label} (${reason}); its record is kept for the next start.`);
    return { ...base, result: 'unknown', blocksDelete: true, reason, recordPath };
  }
  const sandboxes = outcome?.sandboxes;
  if (sandboxes?.removed?.length) {
    say(`removed the Apple Container sandboxes an earlier start left running: ${nameList(sandboxes.removed)}.`);
  }
  const stillRunning = sandboxes?.notRemoved ?? [];
  if (stillRunning.length) {
    say(`could not remove the Apple Container sandboxes an earlier start left running (${nameList(stillRunning)}): ${pinokioSafeText(sandboxes.reason)}.`);
  } else if (sandboxes?.reason) {
    say(`could not look for Apple Container sandboxes an earlier start left running: ${pinokioSafeText(sandboxes.reason)}.`);
  }
  const sandboxFields = stillRunning.length ? { sandboxesNotRemoved: stillRunning } : {};
  const reason = pinokioSafeText(outcome?.reason ?? `an unexpected answer (${outcome?.action ?? 'none'})`);

  // Only these verdicts let Delete forget the record: nothing there, proven gone, stopped, or not this lane's.
  switch (outcome?.verdict) {
    case 'absent':
      return { ...base, result: 'none', blocksDelete: stillRunning.length > 0, ...sandboxFields };
    case 'gone':
      return { ...base, result: 'gone', blocksDelete: stillRunning.length > 0, ...sandboxFields };
    case 'stopped':
      say(`stopped ${service.label}, which an earlier start of this Batshit started.`);
      return { ...base, result: 'stopped', blocksDelete: stillRunning.length > 0, ...sandboxFields };
    case 'not-ours':
      say(`left ${service.label} alone: ${reason}, not this Pinokio install.`);
      return { ...base, result: 'not-ours', blocksDelete: stillRunning.length > 0, ...sandboxFields };
    case 'kept': {
      const result = outcome?.ok === false ? 'did-not-stop' : 'kept';
      say(`left ${service.label} running: ${reason}; its record is kept for the next start.`);
      return { ...base, result, blocksDelete: true, reason, recordPath, ...sandboxFields };
    }
    default:
      // `unknown`, or an answer without a verdict: never read as safe to forget.
      say(`could not settle ${service.label}: ${reason}; its record is kept for the next start.`);
      return { ...base, result: 'unknown', blocksDelete: true, reason, recordPath, ...sandboxFields };
  }
}

/**
 * Settle the sandbox services this lane's app started that an earlier start left running. Call it
 * only after every lane port is proven idle. Never throws: each service's trouble is reported, its
 * record kept, and it is counted as unknown.
 */
export async function settleLeftoverSandboxServices({
  paths,
  owner,
  say,
  platform = process.platform,
  load = (specifier) => import(specifier)
}) {
  if (!owner) throw new TypeError('owner is required: the lane acts only on its own records');
  const services = SANDBOX_SERVICES.filter((service) => !service.platforms || service.platforms.includes(platform));
  return Promise.all(
    services.map((service) =>
      settleSandboxService(service, { paths, owner, say, load }).catch((problem) => {
        const reason = pinokioSafeText(describe(problem));
        say(`could not check ${service.label} (${reason}); its record, if any, is kept.`);
        return {
          service: service.key,
          label: service.label,
          check: service.check,
          result: 'unknown',
          blocksDelete: true,
          reason,
          recordPath: service.stateDir(paths)
        };
      })
    )
  );
}

export function servicesBlockingDelete(outcomes) {
  return outcomes.filter((entry) => entry.blocksDelete);
}

/** Delete's refusal for the services that hold it up, each with what the user can do. */
export function describeServicesBlockingDelete(blockers) {
  return blockers
    .map((entry) => {
      const parts = [];
      if (entry.result === 'kept' || entry.result === 'did-not-stop' || entry.result === 'unknown') {
        const state = entry.result === 'unknown' ? 'could not be checked' : 'was not stopped';
        const record = entry.recordPath ? pinokioSafeText(entry.recordPath) : null;
        parts.push(
          `${entry.label}, which a record says this Batshit started, ${state} (${entry.reason}), and deleting Batshit's data now would leave nothing that can stop it: ${entry.check}, then delete again.` +
            (record
              ? ` If you want it kept running for your own use, or you are sure it is not running, remove ${record} first; Batshit will then never stop it.`
              : '')
        );
      }
      if (entry.sandboxesNotRemoved?.length) {
        parts.push(
          `Apple Container sandboxes this Batshit created could not be removed (${nameList(entry.sandboxesNotRemoved)}): remove them with "container delete --force <name>", then delete again.`
        );
      }
      return parts.join(' ');
    })
    .join(' ');
}

// ---- The database is ready (BL-363) -------------------------------------------------------
//
// Pinokio 8.2 moves to the next Start step when a step's `on` event matches, and it matches only
// against the last 300 characters of the terminal output at each batch it reads
// (`pinokiod/kernel/shells.js`: `liveEventBuffer = (liveEventBuffer + chunk).slice(-300)`). Redis
// prints a few hundred more characters right after "Ready to accept connections" (an auth warning
// and its search index scans), so on a busy computer the ready line could leave that window in the
// same batch and Start waited forever after the database came up. Now Redis writes its log to a
// file, and `run redis` asks Redis itself: when its own process (INFO's process_id) answers PING
// with PONG, which a Redis still loading its data does not, `run redis` prints REDIS_READY_LINE and
// nothing after it, so the line Start waits for is always the last thing in the window.

export const REDIS_READY_LINE = 'Batshit: the database is ready.';

function encodeCommand(args) {
  return `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`;
}

/** One RESP reply from the front of `buffer`: `{ ok, text }`, or null while it is incomplete. */
export function parseRedisReply(buffer) {
  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd < 0) return null;
  const kind = String.fromCharCode(buffer[0]);
  const line = buffer.subarray(1, lineEnd).toString('utf8');
  if (kind === '+' || kind === ':') return { ok: true, text: line };
  if (kind === '-') return { ok: false, text: line };
  if (kind === '$') {
    const length = Number(line);
    if (length < 0) return { ok: true, text: null };
    const start = lineEnd + 2;
    if (buffer.length < start + length + 2) return null;
    return { ok: true, text: buffer.subarray(start, start + length).toString('utf8') };
  }
  return { ok: false, text: `unexpected reply type "${kind}"` };
}

/** Send one command to a Redis on loopback; answers its reply, or null when none came. */
export function askRedis({ host, port, args, timeoutMs = 1_000 }) {
  return new Promise((resolveReply) => {
    let received = Buffer.alloc(0);
    let finished = false;
    const socket = createConnection({ host, port });
    const finish = (reply) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolveReply(reply);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once('error', () => finish(null));
    socket.once('close', () => finish(null));
    socket.once('connect', () => socket.write(encodeCommand(args)));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      const reply = parseRedisReply(received);
      if (reply) finish(reply);
    });
  });
}

/** The pid in an `INFO server` reply, or null. */
export function redisProcessId(infoText) {
  const match = /^process_id:(\d+)\r?$/m.exec(infoText ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * Wait until the Redis process `pid` answers PONG on `host:port`. Answers true when it does, false
 * when `exited` (a promise that settles when that process ends) settles first. A Redis that is
 * still loading answers LOADING, and another program that answers on the port is not `pid`: both
 * keep the wait going. `onSlow` is called once after `slowMs`, then every `slowRepeatMs`.
 */
export async function waitForOwnRedis({
  host,
  port,
  pid,
  exited,
  intervalMs = 200,
  slowMs = 10_000,
  slowRepeatMs = 60_000,
  onSlow = () => {}
}) {
  let hasExited = false;
  exited.then(
    () => (hasExited = true),
    () => (hasExited = true)
  );
  const startedAt = Date.now();
  let nextSlowAt = startedAt + slowMs;
  while (!hasExited) {
    const pong = await askRedis({ host, port, args: ['PING'] });
    if (pong?.ok && pong.text === 'PONG') {
      const info = await askRedis({ host, port, args: ['INFO', 'server'] });
      if (info?.ok && redisProcessId(info.text) === pid) return !hasExited;
    }
    if (Date.now() >= nextSlowAt) {
      onSlow();
      nextSlowAt = Date.now() + slowRepeatMs;
    }
    await Promise.race([sleep(intervalMs), exited.catch(() => {})]);
  }
  return false;
}

/**
 * `run redis` after the spawn: the ready line once `waitReady` says Redis's own process answers,
 * and nothing after it while Redis runs; when Redis ends, the end of its log, then one Error line
 * (Pinokio stops the step on it). Answers the exit code for the launcher.
 */
export async function superviseRedis({ exited, waitReady, print, printLogTail }) {
  if (!(await waitReady())) {
    const code = await exited;
    await printLogTail();
    print(`Error: Batshit's database stopped before it was ready (exit code ${code}). The lines above say why.`);
    return code === 0 ? 1 : code;
  }
  print(REDIS_READY_LINE);
  const code = await exited;
  if (code !== 0) {
    await printLogTail();
    print(`Error: Batshit's database stopped (exit code ${code}). The lines above say why.`);
  }
  return code;
}

/** Keep the previous start's Redis log as `previous`, so each start's log is its own. */
export async function rotateLog(file, previous) {
  try {
    await rename(file, previous);
  } catch (problem) {
    if (problem?.code !== 'ENOENT') throw problem;
  }
}

/** The last lines of a log file (at most `maxBytes` of it), or [] when there is none. */
export async function logTail(file, { maxLines = 20, maxBytes = 8_192 } = {}) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) return [];
  const handle = await open(file, 'r');
  try {
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim());
    // A read that starts mid-file starts mid-line: drop the partial first line.
    if (length < info.size) lines.shift();
    return lines.slice(-maxLines);
  } finally {
    await handle.close();
  }
}
