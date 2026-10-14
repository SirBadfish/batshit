// The stop-watch (BL-1252 Part 2) with real processes: fake Node engines that lead their own groups,
// launch records written and read by the real shared voice module, and a fake `run app` whose tree
// is killed the way Pinokio's Stop kills it. Every fake is swept at the end; none may outlive it.
//
// Run: node --test pinokio/lib/stop-watch.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDeadline,
  createGuardedEffects,
  createRevalidate,
  degradedStartWarning,
  KILL_FOLLOW_THROUGH_MS,
  observeLaneIdle,
  settleAfterRunEnd,
  SHARED_PS_TIMEOUT_MS,
  startLaneStopWatch,
  startStopWatch,
  STOP_BUDGET_MS,
  stopWatchEnvironment
} from './stop-watch.mjs';
import {
  decideLaneVoiceRuntimeGroupStop,
  LANE_VOICE_RUNTIME_REGISTRY,
  recordsAreLaneOwned
} from './lifecycle.mjs';
import {
  decideLocalRuntimeGroupStop,
  isLocalRuntimeProcessAlive,
  readLocalRuntimeLaunchRecords,
  readLocalRuntimeProcessGroup,
  updateLocalRuntimeLaunchRecord,
  writeLocalRuntimeLaunchRecordFile
} from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, 'stop-watch.mjs');
const SHARED = resolve(HERE, '..', '..', 'batshit-mac', 'scripts', 'local-voice-runtime-stop.mjs');
const OWNER = 'pinokio:/stop-watch-test-lane';

// A fake engine: notes its pid, then runs until stopped ('ignore-term' makes SIGTERM do nothing).
const FAKE_ENGINE = `
import { appendFileSync } from 'node:fs';
const [pidFile, mode] = process.argv.slice(2);
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
appendFileSync(pidFile, process.pid + '\\n');
setInterval(() => {}, 1000);
`;

// A fake \`run app\`: starts the watcher through the real handoff, notes the answer (atomically),
// optionally starts a long-lived child of its own afterwards, and stays alive.
const FAKE_RUN_APP = `
import { openSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [modulePath, dir, tag, mode, stateRoot, portsJson] = process.argv.slice(2);
const { startStopWatch } = await import(modulePath);
const logFd = openSync(dir + '/' + tag + '.log', 'a');
const result = await startStopWatch({
  handoffArgs: [dir + '/handoff.mjs', modulePath, dir, tag, stateRoot, portsJson],
  cwd: dir,
  env: { PATH: process.env.PATH, HOME: dir, BATSHIT_TOKEN: 'must-not-reach-the-watcher' },
  logFd
});
let childPid = null;
if (mode === 'with-child') {
  // Started after the watcher, as node build is: it must not hold run app's end of the pipe.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', dir + '/' + tag + '-child'], { detached: true, stdio: 'ignore' });
  child.unref();
  childPid = child.pid;
}
writeFileSync(dir + '/' + tag + '.json.tmp', JSON.stringify({ ...result, runApp: process.pid, childPid }));
renameSync(dir + '/' + tag + '.json.tmp', dir + '/' + tag + '.json');
setInterval(() => {}, 1000);
`;

// The handoff command, as the launcher will run it.
const FAKE_HANDOFF = `
const [modulePath, dir, tag, stateRoot, portsJson] = process.argv.slice(2);
const { handOffStopWatch } = await import(modulePath);
process.exit(await handOffStopWatch({ watcherArgs: [dir + '/watcher.mjs', modulePath, dir, tag, stateRoot, portsJson], cwd: dir, env: process.env }));
`;

// The watcher command: the real runStopWatch, with the real shared voice module and a stand-in for
// the lane's settle (the real one is the launcher's stopLeftoverVoiceEngines, wired in later).
const FAKE_WATCHER = `
import { appendFileSync } from 'node:fs';
const [modulePath, dir, tag, stateRoot, portsJson] = process.argv.slice(2);
const { runStopWatch } = await import(modulePath);
const shared = await import(${JSON.stringify(SHARED)});
const note = (entry) => appendFileSync(dir + '/' + tag + '-watcher.jsonl', JSON.stringify(entry) + '\\n');
note({ event: 'environment', keys: Object.keys(process.env).filter((key) => key !== '__CF_USER_TEXT_ENCODING').sort() });
const result = await runStopWatch({
  owner: ${JSON.stringify(OWNER)},
  readRecords: () => shared.readLocalRuntimeLaunchRecords(stateRoot),
  isAlive: shared.isLocalRuntimeProcessAlive,
  readGroup: shared.readLocalRuntimeProcessGroup,
  decide: shared.decideLocalRuntimeGroupStop,
  isLaneOwned: (records, owner) => records.every((record) => record.launchedBy === owner),
  // Stand-ins for the lane's three ports: closed ports on this computer, so they observe as idle.
  lane: { host: '127.0.0.1', ports: JSON.parse(portsJson) },
  settle: async ({ terminate, removeRecord }) => {
    const { groups } = shared.groupLocalRuntimeLaunchRecords(await shared.readLocalRuntimeLaunchRecords(stateRoot));
    return Promise.all(groups.map(async ({ pid, records }) => {
      const stopped = await terminate(pid);
      if (stopped.ok) for (const record of records) await removeRecord(record);
      return { pid, ...stopped };
    }));
  },
  log: (line) => note({ event: 'log', line })
});
note({ event: 'result', settled: result.settled });
`;

let dir;
let closedPorts = [];
const openFds = [];

// A port nothing listens on: bound once by this test to learn a free number, then released.
async function closedPort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

before(async () => {
  closedPorts = [await closedPort(), await closedPort(), await closedPort()];
  dir = mkdtempSync(join(tmpdir(), 'bs-stop-watch-'));
  for (const [name, text] of [
    ['fake-engine.mjs', FAKE_ENGINE],
    ['run-app.mjs', FAKE_RUN_APP],
    ['handoff.mjs', FAKE_HANDOFF],
    ['watcher.mjs', FAKE_WATCHER]
  ]) {
    writeFileSync(join(dir, name), text);
  }
});

// Every process whose command line names this test's folder: the fakes, and only them.
function fakesStillRunning() {
  return execFileSync('ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match) => match && !match[2].startsWith('Z') && match[3].includes(dir))
    .map((match) => ({ pid: Number(match[1]), command: match[3] }));
}

after(() => {
  const survivors = fakesStillRunning();
  for (const { pid } of survivors) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {}
    }
  }
  for (const fd of openFds) {
    try {
      closeSync(fd);
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
  // Engines a test meant to survive are stopped by each test itself; anything left here leaked.
  assert.deepEqual(survivors, [], 'a fake outlived its test');
});

function running(pid) {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return stat.length > 0 && !stat.startsWith('Z');
  } catch {
    return false;
  }
}

function parentOf(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

async function waitFor(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return check();
}

function stopFake(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {}
  }
}

// Start a detached fake engine (its own group), then write its launch record after its birth.
async function startEngine(engineId, { root, stopOnShutdown = true, launchedBy = OWNER, mode = 'stay' }) {
  const pidFile = join(dir, `${engineId}.pid`);
  const child = spawn(process.execPath, [join(dir, 'fake-engine.mjs'), pidFile, mode], {
    cwd: dir,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  assert.ok(await waitFor(() => existsSync(pidFile)), `${engineId} did not start`);
  await writeLocalRuntimeLaunchRecordFile(root, {
    engineId,
    pid: child.pid,
    command: process.execPath,
    args: [join(dir, 'fake-engine.mjs'), pidFile, mode],
    cwd: dir,
    launchedAt: new Date().toISOString(),
    stopOnShutdown,
    ...(launchedBy ? { launchedBy } : {})
  });
  return child.pid;
}

async function recordsOf(root, pid) {
  return (await readLocalRuntimeLaunchRecords(root)).filter((record) => record.pid === pid);
}

function effectsFor(
  root,
  { cutoffMs = Date.now(), idle = () => true, deadline = createDeadline(30_000), wait, graceMs = 300, readRecords } = {}
) {
  const revalidate = createRevalidate({
    cutoffMs,
    owner: OWNER,
    readRecords: readRecords ?? (() => readLocalRuntimeLaunchRecords(root)),
    isAlive: isLocalRuntimeProcessAlive,
    readGroup: readLocalRuntimeProcessGroup,
    decide: decideLocalRuntimeGroupStop,
    isLaneOwned: (records, owner) => records.every((record) => record.launchedBy === owner)
  });
  return createGuardedEffects({
    deadline,
    revalidate,
    laneIsIdle: async () => idle(),
    log: () => {},
    graceMs,
    ...(wait ? { wait } : {})
  });
}

// Run the fake `run app` and answer what it noted once its watcher has left its tree.
async function startRunApp(tag, mode, root) {
  const err = openSync(join(dir, `${tag}.err`), 'a');
  openFds.push(err);
  const runApp = spawn(process.execPath, [join(dir, 'run-app.mjs'), MODULE, dir, tag, mode, root, JSON.stringify(closedPorts)], {
    cwd: dir,
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'ignore', err]
  });
  const resultFile = join(dir, `${tag}.json`);
  assert.ok(await waitFor(() => existsSync(resultFile)), 'run app noted no answer');
  const started = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(started.ok, true, started.reason);
  // Once the handoff has exited, the watcher's parent is launchd or init, never run app.
  const handoffGone = () =>
    !fakesStillRunning().some(({ command }) => command.includes('handoff.mjs') && command.includes(` ${tag} `));
  assert.ok(await waitFor(handoffGone), 'the handoff did not exit');
  assert.notEqual(parentOf(started.watcherPid), runApp.pid);
  if (process.platform === 'darwin') assert.equal(parentOf(started.watcherPid), 1);
  return { runApp, started };
}

function watcherNotes(tag) {
  return readFileSync(join(dir, `${tag}-watcher.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('the watcher gets only paths and the dedicated nonsecret Pinokio policy markers, with fixed locale/time zone', () => {
  assert.deepEqual(
    stopWatchEnvironment({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/lane',
      BATSHIT_PINOKIO_HOST: 'windows-wsl',
      BATSHIT_PINOKIO_LAUNCH_PROFILE: 'windows-wsl',
      BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'all-owned',
      BATSHIT_TOKEN: 'secret',
      ENCRYPTION_KEY: 'secret',
      NODE_OPTIONS: '--require /tmp/x.js',
      TMPDIR: '/tmp',
      LANG: 'fr_FR.UTF-8'
    }),
    { PATH: '/usr/bin:/bin', HOME: '/Users/lane', BATSHIT_PINOKIO_HOST: 'windows-wsl', BATSHIT_PINOKIO_LAUNCH_PROFILE: 'windows-wsl', BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'all-owned', LC_ALL: 'C', TZ: 'UTC0' }
  );
});

test("after Pinokio's tree kill of run app, the handed-off watcher stops the lane's stop-on engine and keeps the rest", async () => {
  const root = join(dir, 'voice-engines-tree');
  const stopOn = await startEngine('watched-on', { root });
  const keepOn = await startEngine('watched-off', { root, stopOnShutdown: false });
  const { runApp, started } = await startRunApp('tree', 'plain', root);

  // kill-sync 1.0.4's tree mode, as Pinokio 8.2's Stop runs it on the step's shell.
  const children = new Map();
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
    const match = /\s*(\d+)\s*(\d+)/.exec(line);
    if (match) children.set(Number(match[2]), [...(children.get(Number(match[2])) ?? []), Number(match[1])]);
  }
  const victims = [];
  const walk = (pid) => {
    for (const kid of children.get(pid) ?? []) {
      victims.push(kid);
      walk(kid);
    }
  };
  walk(runApp.pid);
  for (const pid of [...victims, runApp.pid]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  assert.ok(!victims.includes(started.watcherPid), 'the watcher was inside the killed tree');

  assert.ok(await waitFor(() => !running(stopOn), 10_000), 'the stop-on engine still runs');
  assert.ok(await waitFor(() => !running(started.watcherPid), 10_000), 'the watcher did not finish');
  assert.ok(running(keepOn), 'the keep-running engine was stopped');
  // Records stay: the stopped engine's now names a gone process, for the next Start to drop.
  assert.equal((await recordsOf(root, stopOn)).length, 1);
  assert.equal((await recordsOf(root, keepOn)).length, 1);

  const notes = watcherNotes('tree');
  assert.deepEqual(notes.find((entry) => entry.event === 'environment').keys, ['HOME', 'LC_ALL', 'PATH', 'TZ']);
  assert.equal(notes.find((entry) => entry.event === 'result').settled, true);
  stopFake(keepOn);
});

test("a child run app starts after the watcher does not hold the pipe, so run app's own end is the run's end", async () => {
  const root = join(dir, 'voice-engines-child');
  const stopOn = await startEngine('child-case-on', { root });
  const { runApp, started } = await startRunApp('child', 'with-child', root);
  assert.ok(running(started.childPid));

  // Only run app dies; the child it started lives on.
  process.kill(runApp.pid, 'SIGKILL');

  assert.ok(await waitFor(() => !running(stopOn), 10_000), 'the watcher never saw the run end');
  assert.ok(await waitFor(() => !running(started.watcherPid), 10_000));
  assert.ok(running(started.childPid));
  stopFake(started.childPid);
});

test("a guarded stop acts only on the lane's own stop-on engine, from records it reads again, and removes no record", async () => {
  const root = join(dir, 'voice-engines-guarded');
  const own = await startEngine('own-on', { root });
  const off = await startEngine('own-off', { root, stopOnShutdown: false });
  const foreign = await startEngine('foreign-on', { root, launchedBy: 'mac-app:/somewhere-else' });
  const unmarked = await startEngine('unmarked-on', { root, launchedBy: null });
  const effects = effectsFor(root);

  assert.equal((await effects.terminate(own)).ok, true);
  assert.ok(await waitFor(() => !running(own)));
  const [ownRecord] = await recordsOf(root, own);
  assert.equal(await effects.removeRecord(ownRecord), false);
  assert.equal((await recordsOf(root, own)).length, 1);

  for (const [pid, what] of [[off, 'keep-running'], [foreign, 'foreign'], [unmarked, 'unmarked']]) {
    const outcome = await effects.terminate(pid);
    assert.equal(outcome.ok, false, `${what} engine was acted on`);
    assert.equal(outcome.left, true);
    assert.ok(running(pid), `${what} engine was stopped`);
    stopFake(pid);
  }
});

test('nothing newer than the run that ended is stopped', async () => {
  const root = join(dir, 'voice-engines-newer');
  const later = await startEngine('newer-than-cutoff', { root });

  const outcome = await effectsFor(root, { cutoffMs: Date.now() - 60_000 }).terminate(later);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /newer than the run/);
  assert.ok(running(later));
  stopFake(later);
});

test('a lane port observed in use means no signal', async () => {
  const root = join(dir, 'voice-engines-busy');
  const pid = await startEngine('port-busy', { root });

  const outcome = await effectsFor(root, { idle: () => false }).terminate(pid);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /lane port is in use/);
  assert.ok(running(pid));
  stopFake(pid);
});

test('a SIGTERM that did not end it is forced only after a fresh check still says stop', async () => {
  const root = join(dir, 'voice-engines-stubborn');
  const stubborn = await startEngine('stubborn-on', { root, mode: 'ignore-term' });
  assert.equal((await effectsFor(root).terminate(stubborn)).escalated, true);
  assert.ok(await waitFor(() => !running(stubborn)));

  // The choice is switched to off while the SIGTERM grace runs: no SIGKILL follows.
  const switched = await startEngine('switched-off', { root, mode: 'ignore-term' });
  let switchedOnce = false;
  const wait = async (ms) => {
    if (!switchedOnce) {
      switchedOnce = true;
      const [record] = await recordsOf(root, switched);
      assert.equal(await updateLocalRuntimeLaunchRecord(record, { stopOnShutdown: false }), true);
    }
    await new Promise((done) => setTimeout(done, ms));
  };
  const changed = await effectsFor(root, { wait }).terminate(switched);
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /asked to stop once, not forced/);

  // A lane port seen in use at the second check: no SIGKILL either.
  const portLater = await startEngine('port-later', { root, mode: 'ignore-term' });
  let observations = 0;
  const busyLater = await effectsFor(root, { idle: () => ++observations === 1 }).terminate(portLater);
  assert.equal(busyLater.ok, false);
  assert.match(busyLater.reason, /not forced: a lane port is in use/);

  await new Promise((done) => setTimeout(done, 300));
  assert.ok(running(switched), 'it was forced after its choice changed');
  assert.ok(running(portLater), 'it was forced while a port was in use');
  stopFake(switched);
  stopFake(portLater);
});

test('all-owned watcher revalidation preserves a foreign OFF attachment even with the starter launcher owner copied', async () => {
  const starter = {
    engineId: 'own-starter', pid: 101, command: '/engine', launchedAt: '2026-10-12T10:00:00Z',
    launchedBy: OWNER, registry: LANE_VOICE_RUNTIME_REGISTRY, stopOnShutdown: true
  };
  const foreignAttach = {
    ...starter, engineId: 'foreign-off-attach', startedBy: starter.engineId,
    registry: 'redis-another-registry', stopOnShutdown: false
  };
  let inventory = [starter, foreignAttach];
  const before = JSON.stringify(inventory);
  const revalidate = createRevalidate({
    cutoffMs: Date.parse('2026-10-12T10:01:00Z'), owner: OWNER,
    readRecords: async () => inventory, isAlive: () => true,
    readGroup: async () => ({ commandLines: ['/engine'], leaderStartedAtMs: Date.parse('2026-10-12T09:59:59Z') }),
    decide: (inputs) => decideLaneVoiceRuntimeGroupStop(inputs, { engineStopPolicy: 'all-owned', platform: 'linux' }),
    isLaneOwned: recordsAreLaneOwned
  });
  const signals = [];
  let groupAlive = true;
  const effects = createGuardedEffects({
    deadline: createDeadline(60_000), revalidate, laneIsIdle: async () => true, log: () => {}, graceMs: 0,
    signalGroup: (_pid, signal) => { signals.push(signal); groupAlive = false; return true; },
    groupAlive: () => groupAlive
  });
  assert.equal((await revalidate(starter.pid)).stop, false);
  assert.equal((await effects.terminate(starter.pid)).ok, false);
  assert.deepEqual(signals, []);
  assert.equal(JSON.stringify(inventory), before);
  assert.equal(await effects.removeRecord(foreignAttach), false);

  inventory = [starter, { ...foreignAttach, registry: LANE_VOICE_RUNTIME_REGISTRY }];
  assert.equal((await revalidate(starter.pid)).stop, true, 'same-registry own OFF attachment may force');
  assert.equal((await effects.terminate(starter.pid)).ok, true);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(inventory[1].stopOnShutdown, false, 'no saved choice is changed');

  // An attachment arriving between the first signal and escalation must be revalidated too.
  signals.length = 0;
  groupAlive = true;
  const guardedAgain = createGuardedEffects({
    deadline: createDeadline(60_000), revalidate, laneIsIdle: async () => true, log: () => {}, graceMs: 0,
    signalGroup: (_pid, signal) => { signals.push(signal); inventory = [starter, foreignAttach]; return true; },
    groupAlive: () => groupAlive
  });
  const outcome = await guardedAgain.terminate(starter.pid);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /not forced:.*another or unknown voice registry/);
  assert.deepEqual(signals, ['SIGTERM'], 'the foreign registry prevents SIGKILL');
  assert.equal(JSON.stringify(inventory), before);
});

test('a stop whose worst case does not fit in the time left is not started', async () => {
  const root = join(dir, 'voice-engines-late');
  const pid = await startEngine('late-in-the-deadline', { root });

  const outcome = await effectsFor(root, { deadline: createDeadline(1_000) }).terminate(pid);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /not enough time left/);
  assert.ok(running(pid));
  stopFake(pid);
});

// BL-1266: the time left is measured again right before each signal, after the reads and the port
// observation before it. A clock the test moves stands in for a read or an observation that ran
// long; the entry check passes each time, so only the boundary checks can refuse.
for (const [effect, slowStep] of [
  ['SIGTERM', 'record read'],
  ['SIGTERM', 'port observation'],
  ['SIGKILL', 'record read'],
  ['SIGKILL', 'port observation']
]) {
  test(`a ${slowStep} that runs long right before the ${effect} means no ${effect}`, async () => {
    const root = join(dir, `voice-engines-late-${effect}-${slowStep.replace(' ', '-')}`);
    // Before a SIGKILL, the engine must outlast its SIGTERM.
    const pid = await startEngine(`late-${effect}-${slowStep.replace(' ', '-')}`, {
      root,
      mode: effect === 'SIGKILL' ? 'ignore-term' : 'stay'
    });
    let clock = 0;
    const deadline = createDeadline(STOP_BUDGET_MS, { now: () => clock, startedAt: 0 });
    // The step's first run comes before the SIGTERM, its second before the SIGKILL.
    const slowRun = effect === 'SIGTERM' ? 1 : 2;
    // Before the SIGTERM, leave less than its follow-through (with the test's 300 ms grace);
    // before the SIGKILL, less than the SIGKILL's.
    const lateBy = effect === 'SIGTERM' ? STOP_BUDGET_MS - 4_000 : STOP_BUDGET_MS - KILL_FOLLOW_THROUGH_MS / 2;
    let reads = 0;
    let observations = 0;
    const effects = effectsFor(root, {
      deadline,
      readRecords: async () => {
        const records = await readLocalRuntimeLaunchRecords(root);
        if (slowStep === 'record read' && ++reads === slowRun) clock += lateBy;
        return records;
      },
      idle: () => {
        if (slowStep === 'port observation' && ++observations === slowRun) clock += lateBy;
        return true;
      }
    });

    const outcome = await effects.terminate(pid);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.left, true);
    assert.match(outcome.reason, effect === 'SIGTERM' ? /no longer covers a stop/ : /not forced: the time ran out/);
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(running(pid), `the ${effect} was sent after the time ran out`);
    assert.equal((await recordsOf(root, pid)).length, 1, 'its record was not kept');
    stopFake(pid);
  });
}

// BL-1264: an inventory with any record the reader could not read stops every signal, because
// that record may be a keep-running attach record of the very process (or of any other).
test('a launch record that cannot be read means no signal for any process of the lane', async () => {
  const root = join(dir, 'voice-engines-partial');
  const pid = await startEngine('readable-stop-on', { root });
  // A record file the shared reader cannot parse, beside the readable one.
  const brokenDir = join(root, 'unreadable-attach');
  await mkdir(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, '.batshit-local-runtime-launch.json'), '{"pid": 1, "stopOnShutdown": fal');

  const outcome = await effectsFor(root).terminate(pid);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /could not be read/);

  // The same through a reader that answers states, as P-1c's may: any state but present is unknown,
  // even when some of its fields were recovered (here: a keep-running attach record of this pid).
  const [readable] = await recordsOf(root, pid);
  const withState = await effectsFor(root, {
    readRecords: async () => [
      readable,
      {
        engineId: 'unreadable-attach',
        state: 'unreadable',
        pid,
        launchedAt: readable.launchedAt,
        launchedBy: OWNER,
        stopOnShutdown: false
      }
    ]
  }).terminate(pid);
  assert.equal(withState.ok, false);
  assert.match(withState.reason, /could not be read/);

  // A reader that marks an entry unreadable (P-1c's marks read errors that way), fields recovered.
  const markedUnreadable = await effectsFor(root, {
    readRecords: async () => [
      readable,
      { engineId: 'unreadable-attach', unreadable: true, pid, launchedAt: readable.launchedAt, launchedBy: OWNER, stopOnShutdown: false }
    ]
  }).terminate(pid);
  assert.equal(markedUnreadable.ok, false);
  assert.match(markedUnreadable.reason, /could not be read/);

  // A reader that does not answer a list at all.
  const notAList = await effectsFor(root, {
    readRecords: async () => ({ records: await readLocalRuntimeLaunchRecords(root) })
  }).terminate(pid);
  assert.equal(notAList.ok, false);
  assert.match(notAList.reason, /could not be listed/);

  await new Promise((done) => setTimeout(done, 300));
  assert.ok(running(pid), 'it was signalled despite an unreadable record');
  assert.equal((await recordsOf(root, pid)).length, 1);
  stopFake(pid);
});

// Pins the shared reader the watcher must be wired with (P-1c, BL-1264): a record file it cannot
// open at all is reported, not skipped. The reader before P-1c skipped it, and the watcher then
// signalled a process whose keep-running record it never saw.
test('a launch record file that cannot be opened at all is reported by the shared reader, so nothing is signalled', async () => {
  const root = join(dir, 'voice-engines-chmod');
  const pid = await startEngine('chmod-stop-on', { root });
  const [readable] = await recordsOf(root, pid);
  // A keep-running attach record of the same process, then made unreadable.
  const lockedDir = join(root, 'locked-attach');
  await mkdir(lockedDir, { recursive: true });
  const locked = join(lockedDir, '.batshit-local-runtime-launch.json');
  writeFileSync(
    locked,
    JSON.stringify({ ...readable, engineId: 'locked-attach', startedBy: 'chmod-stop-on', stopOnShutdown: false, recordPath: undefined })
  );
  chmodSync(locked, 0o000);
  try {
    const outcome = await effectsFor(root).terminate(pid);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /could not be read/);
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(running(pid), 'it was signalled although a record it could not read may keep it running');
  } finally {
    chmodSync(locked, 0o644);
    stopFake(pid);
  }
});

test("run app's part never throws: a log it cannot open, or a handoff that fails, prints the warning", async () => {
  const printed = [];
  const plain = (text) => text.replace(/\b(error|errno)\b/gi, 'problem');
  const noFolder = await startLaneStopWatch({
    logFile: join(dir, 'no-such-folder', 'stop-watch.log'),
    previousLogFile: join(dir, 'no-such-folder', 'stop-watch.previous.log'),
    rotate: async () => {},
    handoffArgs: [],
    cwd: dir,
    env: process.env,
    sanitize: plain,
    print: (line) => printed.push(line),
    start: async () => assert.fail('started without a log')
  });
  assert.equal(noFolder.ok, false);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /may NOT be stopped when you press Stop/);
  assert.match(printed[0], /its log could not be opened/);

  printed.length = 0;
  let openedFd;
  const failed = await startLaneStopWatch({
    logFile: join(dir, 'helper.log'),
    previousLogFile: join(dir, 'helper.previous.log'),
    rotate: async () => {},
    handoffArgs: [],
    cwd: dir,
    env: process.env,
    sanitize: plain,
    print: (line) => printed.push(line),
    openLog: (file) => (openedFd = openSync(file, 'a')),
    start: async ({ logFd }) => {
      assert.equal(logFd, openedFd);
      return { ok: false, reason: 'Error: spawn /nonexistent ENOENT and a very long tail '.padEnd(400, 'x') };
    }
  });
  assert.equal(failed.ok, false);
  assert.equal(printed.length, 1, 'no warning was printed for the failed handoff');
  const warning = printed[0];
  // The promise text is whole even when the reason is long; only the reason is made safe.
  assert.match(warning, /^Batshit: WARNING: the stop watcher is not confirmed to be running\. In this run, engines set to "Stop with Batshit" may NOT be stopped when you press Stop\. The next Start or Delete checks again and reports anything it cannot stop\. \(/);
  assert.doesNotMatch(warning, /error:|errno /i);
  // run app's own copy of the log descriptor is closed; the children keep theirs.
  assert.throws(() => fstatSync(openedFd), { code: 'EBADF' });

  printed.length = 0;
  const started = await startLaneStopWatch({
    logFile: join(dir, 'helper.log'),
    previousLogFile: join(dir, 'helper.previous.log'),
    rotate: async () => {},
    handoffArgs: [],
    cwd: dir,
    env: process.env,
    sanitize: plain,
    print: (line) => printed.push(line),
    start: async () => ({ ok: true, watcherPid: 4242 })
  });
  assert.equal(started.ok, true);
  assert.deepEqual(printed, ['Batshit: the stop watcher was started (process 4242).']);
});

test('the settle runs only once every port is idle, and its result comes after every effect it started', async () => {
  const held = await settleAfterRunEnd({
    deadline: createDeadline(30_000),
    laneIsIdle: async () => false,
    settle: async () => assert.fail('settled while a port was held'),
    effects: {},
    log: () => {},
    portWaitMs: 300,
    pollMs: 50
  });
  assert.deepEqual(held, { settled: false, reason: 'ports-held' });

  const finished = [];
  const result = await settleAfterRunEnd({
    deadline: createDeadline(30_000),
    laneIsIdle: async () => true,
    effects: {},
    log: () => {},
    settle: async () =>
      Promise.all(
        [150, 50].map(async (ms) => {
          await new Promise((done) => setTimeout(done, ms));
          finished.push(ms);
          return ms;
        })
      )
  });
  assert.deepEqual(finished.sort(), [150, 50].sort());
  assert.deepEqual(result, { settled: true, outcomes: [150, 50] });
});

test('a port observation connects and never binds: a listening port is in use, a closed one is idle', async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const listening = server.address().port;
  const closed = await closedPort();
  try {
    assert.equal(await observeLaneIdle({ host: '127.0.0.1', ports: [listening, closed] }), false);
    assert.equal(await observeLaneIdle({ host: '127.0.0.1', ports: [closed] }), true);
    // The listener is undisturbed by the observation.
    assert.equal(server.listening, true);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('when the watcher cannot start, run app gets the reason and a warning that the promise is not kept', async () => {
  const logFd = openSync(join(dir, 'degraded.log'), 'a');
  openFds.push(logFd);
  writeFileSync(
    join(dir, 'failing-handoff.mjs'),
    `const { handOffStopWatch } = await import(${JSON.stringify(MODULE)});\n` +
      `process.exit(await handOffStopWatch({ execPath: '/nonexistent/node', watcherArgs: [], cwd: ${JSON.stringify(dir)}, env: process.env }));\n`
  );
  const failed = await startStopWatch({ handoffArgs: [join(dir, 'failing-handoff.mjs')], cwd: dir, env: process.env, logFd });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /ENOENT/);

  const noHandoff = await startStopWatch({ execPath: '/nonexistent/node', handoffArgs: [], cwd: dir, env: process.env, logFd });
  assert.equal(noHandoff.ok, false);

  const warning = degradedStartWarning(failed.reason, (text) => text.replace(/\b(error|errno)\b/gi, 'problem'));
  assert.match(warning, /may NOT be stopped when you press Stop/);
  assert.doesNotMatch(warning, /error:|errno /i);
});

test('checkStdio sees the exact handoff stdio, and a throw there starts no handoff (BL-1270)', async () => {
  const seen = [];
  const spawned = [];
  const fakeSpawn = (...args) => {
    spawned.push(args);
    throw new Error('not spawned in this test');
  };
  const refused = await startStopWatch({
    handoffArgs: ['handoff.mjs'],
    cwd: dir,
    env: process.env,
    logFd: 7,
    spawn: fakeSpawn,
    checkStdio: (stdio) => {
      seen.push([...stdio]);
      throw new Error('the admission descriptor reached the handoff');
    }
  });
  assert.deepEqual(seen, [['ignore', 7, 7, 'pipe']]);
  assert.deepEqual(spawned, [], 'a refused stdio starts nothing');
  assert.deepEqual(refused, { ok: false, reason: 'the admission descriptor reached the handoff' });

  // Passing, it lets the same stdio through to the spawn.
  await startStopWatch({ handoffArgs: ['handoff.mjs'], cwd: dir, env: process.env, logFd: 7, spawn: fakeSpawn, checkStdio: () => {} });
  assert.deepEqual(spawned.map(([, , options]) => options.stdio), [['ignore', 7, 7, 'pipe']]);

  // startLaneStopWatch hands it on.
  let handed;
  await startLaneStopWatch({
    logFile: join(dir, 'check-stdio.log'),
    previousLogFile: join(dir, 'check-stdio.previous.log'),
    rotate: async () => {},
    handoffArgs: [],
    cwd: dir,
    env: process.env,
    sanitize: (text) => text,
    print: () => {},
    checkStdio: 'the hook',
    start: async (options) => {
      handed = options.checkStdio;
      return { ok: true, watcherPid: 1 };
    }
  });
  assert.equal(handed, 'the hook');
});

test("the stop budget's ps time matches the shared voice module's own limit", () => {
  const source = readFileSync(SHARED, 'utf8');
  assert.match(source, /'ps',\s*\['-A', '-o', 'pid=,pgid=,lstart=,command='\],\s*\{\s*timeout: 3_000,/);
  assert.equal(SHARED_PS_TIMEOUT_MS, 3_000);
});
