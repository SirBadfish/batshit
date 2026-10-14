// The stop-watch (BL-1252 Part 2): it applies each voice engine's "Stop with Batshit" choice as
// soon as a run of this lane ends, instead of at the next Start.
//
// Pinokio's Stop SIGKILLs the launcher's whole process tree and runs nothing else, and since
// BL-1252 Part 1 no engine the app launched is in that tree. So a watcher outside the tree must
// notice the end and stop the engines whose choice says stop. `run app` starts a short-lived
// handoff, which starts the watcher detached and exits, so the watcher's parent becomes launchd or
// init. The watcher holds one end of a pipe whose other end only `run app` holds; that pipe closing
// is the run's end (Pinokio's Stop, its quit, its crash, or the app's own exit).
//
// It decides nothing by itself. The record reader, the shared stop decision, the process-group
// reader, the lane's exact-owner rule, and the settle routine are injected (the launcher passes
// the shared voice module's and the lane's own). What it adds is guarding and timing:
//   - each SIGTERM, and the SIGKILL that may follow it, happens only right after a fresh check:
//     the records naming the process re-read from disk, all no newer than the run's end (the
//     cutoff) and all this lane's, the shared decision still "stop" on a fresh `ps`, and every lane
//     port observed idle;
//   - it removes no launch record. A record of an engine it stopped names a gone process, and the
//     next Start or Delete drops such records, as it drops those of engines Pinokio's tree kill
//     ended. (The shared remover takes the record lock, which creates the engine's folder and can
//     wait longer than this watcher's deadline; a Delete may be removing that very folder.)
//   - one deadline bounds every signal (BL-1266): the time left is measured again right before
//     the SIGTERM and right before the SIGKILL, after every read and observation before it, and a
//     signal is sent only while the time left still covers what must follow it (for the SIGTERM:
//     the grace, the second check and the SIGKILL's own check). A slow read can only lead to a
//     refusal, never to a late signal. Reads themselves are not cut short;
//   - an inventory it cannot fully read stops everything (BL-1264): if the reader reports any record
//     it could not read (marked `invalid` or `unreadable`, or in any state other than present), that
//     unknown record might keep a process running, so no process is signalled at all. This is only
//     as complete as the reader: the shared reader before P-1c reports malformed JSON but skips a
//     file or folder it cannot read at all, while P-1c's reader reports those too. Wire the watcher
//     only with P-1c's reader.
// Port observations are not exclusion. A new Start can bind its ports in the instant between the
// last observation and a signal, and a choice switched off in that instant on a shared runtime is
// not seen; the worst case is that an engine is stopped once and later relaunched cold. These are
// known limits, not something this module closes. The next Start's own settle stays the backstop
// for anything left here.

import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { connect as netConnect, Socket } from 'node:net';

// ---- Timing --------------------------------------------------------------------------------

export const STOP_WATCH_DEADLINE_MS = 30_000;
export const HANDOFF_TIMEOUT_MS = 5_000;
export const PORT_WAIT_MS = 10_000;
export const STOP_GRACE_MS = 2_000;
const POLL_MS = 100;
// The shared voice module's process-group read gives up after 3 s (pinned by the test).
export const SHARED_PS_TIMEOUT_MS = 3_000;
// One port observation: every lane port probed side by side, each bounded (`observeLaneIdle`, the
// only observation `runStopWatch` uses).
export const OBSERVE_TIMEOUT_MS = 500;
// Reading the records has no time limit of its own; the signal boundaries below are measured after
// it, so its real duration is what counts.
// What must still fit after each signal:
//   after the SIGKILL, its check;
//   after the SIGTERM, the grace and the polling that may overrun it, the second check (`ps` and a
//   port observation), and then the SIGKILL's own follow-through.
export const KILL_FOLLOW_THROUGH_MS = 2 * POLL_MS;
export const TERM_FOLLOW_THROUGH_MS =
  STOP_GRACE_MS + POLL_MS + SHARED_PS_TIMEOUT_MS + OBSERVE_TIMEOUT_MS + KILL_FOLLOW_THROUGH_MS;
// Whether to begin a stop at all: the first check (`ps` and a port observation) and the SIGTERM's.
export const STOP_BUDGET_MS = SHARED_PS_TIMEOUT_MS + OBSERVE_TIMEOUT_MS + TERM_FOLLOW_THROUGH_MS;

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export function createDeadline(totalMs, { now = Date.now, startedAt = now() } = {}) {
  const endsAt = startedAt + totalMs;
  return { endsAt, remaining: () => Math.max(0, endsAt - now()) };
}

function oneLine(value) {
  return String(value?.message ?? value).replace(/\s+/g, ' ').trim().slice(0, 240);
}

// ---- Environment -----------------------------------------------------------------------------

// The handoff and the watcher get these and nothing else: PATH (the shared reader runs `ps` by
// name) and HOME (the lane's data root is under it; a disposable lane sets it in Pinokio's
// ENVIRONMENT file). Only the nonsecret fixed Pinokio profile/capability markers also cross;
// the watcher validates them independently. LC_ALL/TZ are fixed. No app secrets or authority.
export const STOP_WATCH_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'BATSHIT_PINOKIO_HOST', 'BATSHIT_PINOKIO_ENGINE_STOP_POLICY', 'BATSHIT_PINOKIO_LAUNCH_PROFILE'
]);

export function stopWatchEnvironment(env) {
  const picked = {};
  for (const key of STOP_WATCH_ENV_KEYS) {
    if (typeof env?.[key] === 'string' && env[key] !== '') picked[key] = env[key];
  }
  return { ...picked, LC_ALL: 'C', TZ: 'UTC0' };
}

// ---- Observing the lane's ports ----------------------------------------------------------------

/**
 * Is anything accepting connections on these ports right now? Connects, never binds, so it can
 * never take a port from a Start that is binding it. A port that refuses is idle; one that accepts,
 * or that answers nothing in time, or any other error, counts as in use. An observation, not a lock.
 */
export async function observeLaneIdle({ host, ports, timeoutMs = OBSERVE_TIMEOUT_MS, connect = netConnect }) {
  const inUse = await Promise.all(
    ports.map(
      (port) =>
        new Promise((resolve) => {
          const socket = connect({ host, port });
          const settle = (busy) => {
            clearTimeout(timer);
            socket.destroy();
            resolve(busy);
          };
          const timer = setTimeout(() => settle(true), timeoutMs);
          socket.once('connect', () => settle(true));
          socket.once('error', (problem) => settle(problem?.code !== 'ECONNREFUSED'));
        })
    )
  );
  return !inUse.includes(true);
}

// ---- Starting it: `run app`'s side -------------------------------------------------------------

// Keeps `run app`'s end of each pipe referenced for the life of `run app`: closing it is the signal.
const heldChannels = new Set();

/**
 * Start the watcher through the handoff and answer `{ ok: true, watcherPid }`, or
 * `{ ok: false, reason }` when it is not known to have started (the caller then prints
 * `degradedStartWarning`). `handoffArgs` runs the handoff command; `logFd` is the stop-watch log,
 * already opened. `checkStdio`, when given, sees the exact `stdio` the handoff gets just before it is
 * spawned, and a throw there means no handoff (BL-1270: no admission descriptor may reach it).
 */
export function startStopWatch({
  execPath = process.execPath,
  handoffArgs,
  cwd,
  env,
  logFd,
  spawn = nodeSpawn,
  timeoutMs = HANDOFF_TIMEOUT_MS,
  checkStdio = () => {}
}) {
  return new Promise((resolve) => {
    let handoff;
    try {
      const stdio = ['ignore', logFd, logFd, 'pipe'];
      // A copy: the hook only looks, and cannot change what is spawned.
      checkStdio(Object.freeze([...stdio]));
      handoff = spawn(execPath, handoffArgs, { cwd, env: stopWatchEnvironment(env), stdio });
    } catch (problem) {
      resolve({ ok: false, reason: oneLine(problem) });
      return;
    }
    const channel = handoff.stdio[3];
    let answer = '';
    let settled = false;
    // `run app` keeps its end in every case where a watcher may exist, so a late watcher still
    // waits for the real end of the run instead of seeing an early one.
    const keepChannel = () => {
      heldChannels.add(channel);
      channel.unref?.();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      keepChannel();
      handoff.kill('SIGKILL');
      finish({ ok: false, reason: `the handoff did not answer within ${timeoutMs / 1000} seconds` });
    }, timeoutMs);
    channel.on('data', (chunk) => {
      answer += chunk;
      const started = /^watcher (\d+)\n/.exec(answer);
      if (started) {
        keepChannel();
        finish({ ok: true, watcherPid: Number(started[1]) });
      } else if (/^failed [^\n]*\n/.test(answer)) {
        channel.destroy();
        finish({ ok: false, reason: answer.slice(7).trim() });
      }
    });
    channel.on('error', () => {});
    handoff.once('error', (problem) => {
      // No handoff process: no watcher can exist. Otherwise (a failed kill) one still may.
      if (handoff.pid === undefined) channel.destroy();
      else keepChannel();
      finish({ ok: false, reason: oneLine(problem) });
    });
    // A handoff that ended without an answer: let anything it wrote just before arrive first.
    handoff.once('exit', (code, signal) => {
      setTimeout(() => {
        if (settled) return;
        keepChannel();
        finish({ ok: false, reason: `the handoff ended without an answer (${code ?? signal})` });
      }, 200);
    });
  });
}

/**
 * The line `run app` prints when the watcher is not known to have started. In such a run the
 * "Stop with Batshit" promise may not be kept at Stop. The next Start or Delete checks again and reports anything it cannot stop.
 * `sanitize` makes text safe for Pinokio's terminal (the lane's `pinokioSafeText`).
 */
export function degradedStartWarning(reason, sanitize) {
  // Only the reason is sanitized (and may be shortened): the promise part is fixed text that
  // Pinokio accepts as it is, so it is never cut off.
  return (
    'Batshit: WARNING: the stop watcher is not confirmed to be running. In this run, engines set to ' +
    `"Stop with Batshit" may NOT be stopped when you press Stop. The next Start or Delete checks again and reports anything it cannot stop. (${sanitize(oneLine(reason))})`
  );
}

/**
 * `run app`'s whole part, before it starts the app: rotate and open the stop-watch log, start the
 * watcher with that descriptor (the handoff and the watcher inherit it; neither opens a path), close
 * this process's copy, and print one line either way. Never throws: a watcher that is not confirmed
 * to run is a printed warning, and the app starts anyway.
 */
export async function startLaneStopWatch({
  logFile,
  previousLogFile,
  rotate,
  handoffArgs,
  cwd,
  env,
  sanitize,
  print,
  openLog = (file) => openSync(file, 'a'),
  start = startStopWatch,
  checkStdio
}) {
  let logFd;
  try {
    await rotate(logFile, previousLogFile);
    logFd = openLog(logFile);
  } catch (problem) {
    print(degradedStartWarning(`its log could not be opened: ${oneLine(problem)}`, sanitize));
    return { ok: false };
  }
  try {
    const started = await start({ handoffArgs, cwd, env, logFd, checkStdio });
    // The handshake proves only that the watcher was spawned, not that it loaded.
    if (started.ok) print(`Batshit: the stop watcher was started (process ${started.watcherPid}).`);
    else print(degradedStartWarning(started.reason, sanitize));
    return started;
  } finally {
    try {
      closeSync(logFd);
    } catch {}
  }
}

// ---- The handoff ---------------------------------------------------------------------------------

/**
 * The handoff's whole job: start the watcher detached, passing on the pipe it got as fd 3, tell
 * `run app` the watcher's pid on that pipe, and answer the exit code (then exit, so the watcher's
 * parent becomes launchd or init).
 */
export function handOffStopWatch({
  execPath = process.execPath,
  watcherArgs,
  cwd,
  env,
  spawn = nodeSpawn,
  channelFd = 3
}) {
  const tell = (line) => {
    try {
      writeSync(channelFd, `${line}\n`);
    } catch {
      // `run app` is gone: nothing is listening, and the watcher will find its pipe closed.
    }
  };
  return new Promise((resolve) => {
    let watcher;
    try {
      watcher = spawn(execPath, watcherArgs, {
        cwd,
        env: stopWatchEnvironment(env),
        detached: true,
        stdio: ['ignore', 1, 2, channelFd]
      });
    } catch (problem) {
      tell(`failed ${oneLine(problem)}`);
      resolve(1);
      return;
    }
    watcher.once('error', (problem) => {
      tell(`failed ${oneLine(problem)}`);
      resolve(1);
    });
    watcher.once('spawn', () => {
      watcher.unref();
      tell(`watcher ${watcher.pid}`);
      resolve(0);
    });
  });
}

// ---- The watcher -----------------------------------------------------------------------------------

/**
 * Wait until the run ends: the pipe on `channelFd` reaches its end because `run app`, its only
 * other holder, is gone. Answers `{ endedAt, how }`; `how` is 'no-channel' when there is no pipe
 * (the watcher was not started by a handoff), and then nothing may be settled.
 */
export function waitForRunEnd({ channelFd = 3, now = Date.now } = {}) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = new Socket({ fd: channelFd, readable: true, writable: false });
    } catch (problem) {
      resolve({ endedAt: now(), how: 'no-channel', detail: oneLine(problem) });
      return;
    }
    let done = false;
    const end = (how) => {
      if (done) return;
      done = true;
      resolve({ endedAt: now(), how });
      socket.destroy();
    };
    socket.on('data', () => {});
    socket.once('end', () => end('end'));
    socket.once('close', () => end('close'));
    socket.once('error', (problem) => end(`error ${problem?.code ?? ''}`.trim()));
  });
}

// A record the watcher may decide with: an object naming a pid, marked neither invalid nor
// unreadable, and in no state other than present. Anything else is unknown: it may name any
// process, with any choice.
function isKnownRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    record.invalid !== true &&
    record.unreadable !== true &&
    (record.state === undefined || record.state === 'present')
  );
}

/**
 * Re-read, right before a signal, everything that decides whether the process may be stopped.
 * Answers `{ stop: true }`, or `{ stop: false, gone, reason }`. `readRecords` answers the lane's
 * whole inventory as a list, unreadable entries included (the shared reader marks them `invalid`;
 * a reader with states marks them with a `state` other than 'present'); this never drops one
 * before deciding.
 */
export function createRevalidate({ cutoffMs, owner, readRecords, isAlive, readGroup, decide, isLaneOwned }) {
  return async function revalidate(pid) {
    const inventory = await readRecords();
    if (!Array.isArray(inventory)) {
      return { stop: false, reason: 'the launch records could not be listed as a whole' };
    }
    const unknown = inventory.filter((record) => !isKnownRecord(record));
    if (unknown.length > 0) {
      // It might be a keep-running record of this very process (an attach record, for one).
      return {
        stop: false,
        reason: `${unknown.length} launch record(s) of this lane could not be read or name no usable process, and any of them may keep it running`
      };
    }
    const records = inventory.filter((record) => record.pid === pid);
    if (records.length === 0) return { stop: false, reason: 'no launch record names it now' };
    if (records.some((record) => !(Date.parse(record.launchedAt) <= cutoffMs))) {
      return { stop: false, reason: 'a record naming it is newer than the run that ended' };
    }
    if (!isAlive(pid)) return { stop: false, gone: true, reason: 'it is no longer running' };
    if (!isLaneOwned(records, owner)) return { stop: false, reason: "a record naming it is not this lane's" };
    const group = await readGroup(pid);
    const decision = decide({
      records,
      alive: true,
      commandLines: group ? group.commandLines : null,
      leaderStartedAtMs: group ? group.leaderStartedAtMs : null,
      owner
    });
    return decision.action === 'stop' ? { stop: true } : { stop: false, reason: decision.reason ?? decision.action };
  };
}

function defaultGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (problem) {
    return problem?.code === 'EPERM';
  }
}

// Answers whether the signal was sent (false: the group is already gone).
function defaultSignalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (problem) {
    if (problem?.code === 'ESRCH') return false;
    throw problem;
  }
}

/**
 * The two hooks the lane's settle calls: `terminate(pid)`, guarded and budgeted (answers `{ ok }`
 * as the settle expects; `left: true` when it did not act), and `removeRecord(record)`, which keeps
 * every record (see the file comment) and answers false.
 */
export function createGuardedEffects({
  deadline,
  revalidate,
  laneIsIdle,
  log,
  groupAlive = defaultGroupAlive,
  signalGroup = defaultSignalGroup,
  wait = sleep,
  graceMs = STOP_GRACE_MS,
  stopBudgetMs = STOP_BUDGET_MS,
  killFollowThroughMs = KILL_FOLLOW_THROUGH_MS,
  termFollowThroughMs = graceMs + POLL_MS + SHARED_PS_TIMEOUT_MS + OBSERVE_TIMEOUT_MS + killFollowThroughMs
}) {
  const left = (pid, reason) => {
    log(`left process group ${pid} as it is: ${reason}.`);
    return { ok: false, left: true, reason };
  };

  async function terminate(pid) {
    if (deadline.remaining() < stopBudgetMs) return left(pid, 'not enough time left; the next Start decides');
    const before = await revalidate(pid);
    if (before.gone) return { ok: true, gone: true };
    if (!before.stop) return left(pid, before.reason);
    if (!(await laneIsIdle())) return left(pid, 'a lane port is in use, so a new Start may be under way');
    // Measured after the reads and the observation above, right before the signal (BL-1266).
    if (deadline.remaining() < termFollowThroughMs) {
      return left(pid, 'the time left no longer covers a stop; the next Start decides');
    }
    if (!signalGroup(pid, 'SIGTERM')) return { ok: true, gone: true };
    const graceEnds = Date.now() + graceMs;
    while (Date.now() < graceEnds) {
      if (!groupAlive(pid)) return { ok: true };
      await wait(POLL_MS);
    }
    if (!groupAlive(pid)) return { ok: true };
    const again = await revalidate(pid);
    if (again.gone) return { ok: true, gone: true };
    if (!again.stop) return left(pid, `asked to stop once, not forced: ${again.reason}`);
    if (!(await laneIsIdle())) return left(pid, 'asked to stop once, not forced: a lane port is in use');
    // Measured again after the second check, right before the signal (BL-1266).
    if (deadline.remaining() < killFollowThroughMs) {
      return left(pid, 'asked to stop once, not forced: the time ran out');
    }
    if (!signalGroup(pid, 'SIGKILL')) return { ok: true };
    await wait(2 * POLL_MS);
    return { ok: !groupAlive(pid), escalated: true };
  }

  async function removeRecord(record) {
    log(`kept the launch record of "${record?.engineId ?? 'unknown'}"; the next Start or Delete drops it once its process is gone.`);
    return false;
  }

  return { terminate, removeRecord };
}

/**
 * After the run's end: wait (bounded) until every lane port is observed idle, then run the settle
 * with the guarded effects. Resolves only once every effect the settle started has finished.
 */
export async function settleAfterRunEnd({
  deadline,
  laneIsIdle,
  settle,
  effects,
  log,
  wait = sleep,
  portWaitMs = PORT_WAIT_MS,
  pollMs = 200,
  // Room for one stop, after the settle's own group read.
  reserveMs = STOP_BUDGET_MS + SHARED_PS_TIMEOUT_MS
}) {
  const waitEnds = Date.now() + Math.max(0, Math.min(portWaitMs, deadline.remaining() - reserveMs));
  while (!(await laneIsIdle())) {
    if (Date.now() >= waitEnds) {
      log('a lane port stayed in use, so nothing was stopped; the next Start decides.');
      return { settled: false, reason: 'ports-held' };
    }
    await wait(pollMs);
  }
  return { settled: true, outcomes: await settle(effects) };
}

/**
 * The watcher, start to end. The dependencies are what it decides with; see the file comment.
 */
export async function runStopWatch({
  channelFd = 3,
  now = Date.now,
  deadlineMs = STOP_WATCH_DEADLINE_MS,
  readRecords,
  isAlive,
  readGroup,
  decide,
  isLaneOwned,
  owner,
  lane,
  settle,
  log,
  effectOptions = {},
  settleOptions = {}
}) {
  if (!owner) throw new TypeError('owner is required: the watcher acts only on its own lane');
  if (!lane?.host || !Array.isArray(lane.ports) || lane.ports.length === 0) {
    throw new TypeError("lane { host, ports } is required: the lane's ports are observed before every effect");
  }
  // Always the connecting observation: it never binds a port, and the stop budget counts on its bound.
  const laneIsIdle = () => observeLaneIdle({ host: lane.host, ports: lane.ports });
  log(`watching (process ${process.pid}).`);
  const end = await waitForRunEnd({ channelFd, now });
  if (end.how === 'no-channel') {
    log(`no pipe from a run to watch (${end.detail}); nothing was done.`);
    return { settled: false, reason: 'no-channel' };
  }
  log(`the run ended (${end.how}); applying "Stop with Batshit".`);
  const deadline = createDeadline(deadlineMs, { now, startedAt: end.endedAt });
  const revalidate = createRevalidate({ cutoffMs: end.endedAt, owner, readRecords, isAlive, readGroup, decide, isLaneOwned });
  const effects = createGuardedEffects({ deadline, revalidate, laneIsIdle, log, ...effectOptions });
  const result = await settleAfterRunEnd({ deadline, laneIsIdle, settle, effects, log, ...settleOptions });
  log('done.');
  return result;
}
