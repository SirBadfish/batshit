// The stop-watch as the launcher wires it (BL-1252): the real hidden `stop-watch-handoff` and
// `stop-watch` commands of cli.mjs, with the lane's real shared reader, decision, group reader,
// exact-owner rule and settle, under a temporary HOME. A fake `run app` starts them and is then
// killed the way Pinokio's Stop kills a script's tree. Engines are fake Node processes; nothing
// real is started. Every fake is swept at the end.
//
// Run: node --test pinokio/lib/stop-watch-wiring.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANE_HOST, LANE_PORTS, LANE_LAUNCH_PROFILE_ENV, laneDataPaths, laneDataRoot, laneVoiceRuntimeOwner } from './lane.mjs';
import { observeLaneIdle, startStopWatch } from './stop-watch.mjs';
import { admit, assertNoAdmissionFd, probeAdmissionEntry, releaseAdmission } from './admission.mjs';
import {
  readLocalRuntimeLaunchRecords,
  writeLocalRuntimeLaunchRecordFile
} from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, 'cli.mjs');
const MODULE = resolve(HERE, 'stop-watch.mjs');
const ADMISSION = resolve(HERE, 'admission.mjs');

const FAKE_ENGINE = `
import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], process.pid + '\\n');
setInterval(() => {}, 1000);
`;

// A fake \`run app\`: starts the real hidden handoff command, notes the answer, stays alive.
const FAKE_RUN_APP = `
import { openSync, renameSync, writeFileSync } from 'node:fs';
const [modulePath, cli, home, out] = process.argv.slice(2);
const { startStopWatch } = await import(modulePath);
const logFd = openSync(out + '/stop-watch.log', 'a');
const result = await startStopWatch({
  handoffArgs: [cli, 'stop-watch-handoff'],
  cwd: out,
  env: { PATH: process.env.PATH, HOME: home, BATSHIT_TOKEN: 'must-not-reach-the-watcher' },
  logFd
});
writeFileSync(out + '/run-app.json.tmp', JSON.stringify({ ...result, runApp: process.pid }));
renameSync(out + '/run-app.json.tmp', out + '/run-app.json');
setInterval(() => {}, 1000);
`;

// A fake admitted `run app` (BL-1270): admitted as cli.mjs does, it starts the real hidden handoff
// with the real checkStdio guard, then a fake app child that holds the admission reader as
// descriptor 3. On SIGWINCH (no debugger side effect, unlike SIGUSR1) it closes its own reader (the child then holds it alone); on SIGUSR2 it
// ends that child, but stays alive, so the run (and the watcher) goes on: whoever still holds the
// reader then is the handoff or the watcher.
const FAKE_ADMITTED_RUN_APP = `
import { closeSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [modulePath, admissionPath, cli, home, dataRoot, out] = process.argv.slice(2);
const { startStopWatch } = await import(modulePath);
const { admit, assertNoAdmissionFd, serviceStdio } = await import(admissionPath);
const admission = admit({ role: 'start', label: 'app', dataRoot });
const note = (value) => { writeFileSync(out + '/admitted.tmp', JSON.stringify(value)); renameSync(out + '/admitted.tmp', out + '/admitted.json'); };
if (!admission.ok) { note(admission); process.exit(1); }
const logFd = openSync(out + '/admitted-stop-watch.log', 'a');
const result = await startStopWatch({
  handoffArgs: [cli, 'stop-watch-handoff'],
  cwd: out,
  env: { PATH: process.env.PATH, HOME: home },
  logFd,
  checkStdio: (stdio) => assertNoAdmissionFd(stdio, admission)
});
const app = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'fake-app-child', out], { stdio: serviceStdio(admission, ['ignore', 'ignore', 'ignore']) });
process.on('SIGWINCH', () => { closeSync(admission.fd); writeFileSync(out + '/wrapper-closed', ''); });
process.on('SIGUSR2', () => {
  app.kill('SIGKILL');
  app.once('exit', () => writeFileSync(out + '/released', ''));
});
app.once('spawn', () => note({ ...result, ok: result.ok, admission: admission.path, runApp: process.pid, appChild: app.pid }));
setInterval(() => {}, 1000);
`;

let dir;
let home;
let paths;
const openFds = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'bs-stop-watch-wiring-'));
  home = join(dir, 'home');
  paths = laneDataPaths(laneDataRoot(home));
  mkdirSync(paths.voiceEngines, { recursive: true });
  writeFileSync(join(dir, 'fake-engine.mjs'), FAKE_ENGINE);
  writeFileSync(join(dir, 'run-app.mjs'), FAKE_RUN_APP);
  writeFileSync(join(dir, 'admitted-run-app.mjs'), FAKE_ADMITTED_RUN_APP);
});

// The fakes carry the temporary folder in their command line; the handoff and the watcher this
// file starts carry this worktree's cli.mjs path and a hidden command instead.
function fakesStillRunning() {
  return execFileSync('ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(
      (match) => match && !match[2].startsWith('Z') && (match[3].includes(dir) || match[3].includes(`${CLI} stop-watch`))
    )
    .map((match) => ({ pid: Number(match[1]), command: match[3] }));
}

function listTree(root) {
  return readdirSync(root, { recursive: true }).map(String).sort();
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

async function startEngine(engineId, { stopOnShutdown = true, launchedAt } = {}) {
  const pidFile = join(dir, `${engineId}.pid`);
  const child = spawn(process.execPath, [join(dir, 'fake-engine.mjs'), pidFile], { cwd: dir, detached: true, stdio: 'ignore' });
  child.unref();
  assert.ok(await waitFor(() => existsSync(pidFile)), `${engineId} did not start`);
  await writeLocalRuntimeLaunchRecordFile(paths.voiceEngines, {
    engineId,
    pid: child.pid,
    command: process.execPath,
    args: [join(dir, 'fake-engine.mjs'), pidFile],
    cwd: dir,
    launchedAt: launchedAt ?? new Date().toISOString(),
    stopOnShutdown,
    launchedBy: laneVoiceRuntimeOwner(paths)
  });
  return child.pid;
}

test("the real hidden commands load, watch the run, and settle the lane's engines through its own settle", async (t) => {
  const stopOn = await startEngine('wired-on');
  const keepOn = await startEngine('wired-off', { stopOnShutdown: false });
  // Launched (by its record) after the run ends: only the watcher's guarded stop refuses it; the
  // lane's settle alone would stop it.
  const later = await startEngine('wired-later', { launchedAt: new Date(Date.now() + 60_000).toISOString() });
  const treeBefore = listTree(paths.root);

  const err = openSync(join(dir, 'run-app.err'), 'a');
  openFds.push(err);
  const runApp = spawn(process.execPath, [join(dir, 'run-app.mjs'), MODULE, CLI, home, dir], {
    cwd: dir,
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'ignore', err]
  });
  const resultFile = join(dir, 'run-app.json');
  assert.ok(await waitFor(() => existsSync(resultFile)), 'run app noted no answer');
  const started = JSON.parse(readFileSync(resultFile, 'utf8'));
  assert.equal(started.ok, true, started.reason);
  const logFile = join(dir, 'stop-watch.log');
  // The handshake only proves a process was spawned; this line proves cli.mjs's real watcher ran.
  assert.ok(
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes(`watching (process ${started.watcherPid})`)),
    'the real stop-watch command did not start'
  );
  // The watcher acts on the lane its HOME names. Before the run can end, prove it is this test's
  // temporary one; otherwise end the watcher first, so it can never settle a real lane.
  const watcherEnv = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(started.watcherPid)], { encoding: 'utf8' });
  if (!watcherEnv.includes(` HOME=${home} `) && !watcherEnv.trimEnd().endsWith(` HOME=${home}`)) {
    stopFake(started.watcherPid);
    assert.fail(`the watcher does not run with the test's HOME: ${watcherEnv.slice(0, 300)}`);
  }

  // What the watcher will observe on the lane's real ports.
  const laneIdle = await observeLaneIdle({ host: LANE_HOST, ports: [LANE_PORTS.server, LANE_PORTS.app, LANE_PORTS.redis] });

  // kill-sync 1.0.4's tree mode on run app, as Pinokio's Stop does it.
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
  assert.ok(await waitFor(() => !running(started.watcherPid), 15_000), 'the watcher did not finish');

  const log = readFileSync(logFile, 'utf8');
  assert.match(log, /the run ended/);
  if (laneIdle) {
    assert.ok(await waitFor(() => !running(stopOn)), 'the stop-on engine still runs');
    assert.match(log, /done\./);
  } else {
    // Something on this computer holds a lane port: the watcher must have acted on nothing.
    assert.match(log, /a lane port stayed in use/);
    assert.ok(running(stopOn), 'it stopped an engine while a lane port was in use');
  }
  assert.ok(running(keepOn), 'the keep-running engine was stopped');
  assert.ok(running(later), 'an engine launched after the run ended was stopped');
  // The watcher removes no record, and writes nothing under the lane's data root.
  const pids = (await readLocalRuntimeLaunchRecords(paths.voiceEngines)).map((record) => record.pid).sort();
  assert.deepEqual(pids, [stopOn, keepOn, later].sort());
  assert.deepEqual(listTree(paths.root), treeBefore);

  stopFake(keepOn);
  stopFake(later);
  if (running(stopOn)) stopFake(stopOn);
  // Shown as skipped, so a run with a busy lane port is never read as proof of the settle wiring.
  if (!laneIdle) t.skip('a lane port is in use on this computer: only "nothing was stopped" was proven');
});

test("the app's run starts the watcher before the app, through the hidden handoff", () => {
  const source = readFileSync(CLI, 'utf8');
  const runService = source.slice(source.indexOf('async function runService('), source.indexOf('async function printRedisLogTail('));
  assert.ok(
    runService.indexOf("if (service === 'app') await startAppStopWatch(admission);") >= 0 &&
      runService.indexOf("if (service === 'app') await startAppStopWatch(admission);") < runService.indexOf('startChild('),
    'run app no longer starts the watcher before the app'
  );
  assert.match(source, /handoffArgs: \[cliPath, 'stop-watch-handoff'\]/);
  assert.match(source, /'stop-watch-handoff': async \(\) => \{\n\s+process\.exitCode = await handOffStopWatch\(\{ watcherArgs: \[cliPath, 'stop-watch'\]/);
  assert.match(source, /'stop-watch': runLaneStopWatch/);
});

// kill-sync 1.0.4's tree mode on one root, as Pinokio's Stop does it.
function killSyncTree(root) {
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
  walk(root);
  for (const pid of [...victims, root]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  return victims;
}

test('an admitted run app: its service child holds the admission, the handoff and the watcher hold none (BL-1270)', async () => {
  const err = openSync(join(dir, 'admitted-run-app.err'), 'a');
  openFds.push(err);
  const runApp = spawn(process.execPath, [join(dir, 'admitted-run-app.mjs'), MODULE, ADMISSION, CLI, home, paths.root, dir], {
    cwd: dir,
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'ignore', err]
  });
  const noteFile = join(dir, 'admitted.json');
  // Longer than the handoff's own 5 s limit, so a slow handoff shows its reason, not a timeout here.
  assert.ok(await waitFor(() => existsSync(noteFile), 10_000), 'the admitted run app noted nothing');
  const started = JSON.parse(readFileSync(noteFile, 'utf8'));
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(probeAdmissionEntry(started.admission), 'live');
  const logFile = join(dir, 'admitted-stop-watch.log');
  assert.ok(
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes(`watching (process ${started.watcherPid})`)),
    'the real stop-watch command did not start'
  );
  const watcherEnv = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(started.watcherPid)], { encoding: 'utf8' });
  if (!watcherEnv.includes(` HOME=${home} `) && !watcherEnv.trimEnd().endsWith(` HOME=${home}`)) {
    stopFake(started.watcherPid);
    assert.fail(`the watcher does not run with the test's HOME: ${watcherEnv.slice(0, 300)}`);
  }

  // The wrapper's own reader closed: the service child alone keeps the entry live.
  process.kill(started.runApp, 'SIGWINCH');
  assert.ok(await waitFor(() => existsSync(join(dir, 'wrapper-closed'))), 'the fake run app did not close its reader');
  assert.equal(probeAdmissionEntry(started.admission), 'live', 'the service child does not hold the reader');
  // Then the service child gone, while the run (and the watcher) go on.
  process.kill(started.runApp, 'SIGUSR2');
  assert.ok(await waitFor(() => existsSync(join(dir, 'released'))), 'the fake run app did not end its child');
  assert.ok(running(started.watcherPid), 'the watcher should still wait for the run to end');
  assert.equal(probeAdmissionEntry(started.admission), 'dead', 'the handoff or the watcher holds the admission reader');
  // So a Delete is admitted while the watcher runs (and is released at once).
  const deleting = admit({ role: 'delete', label: 'delete', dataRoot: paths.root });
  assert.equal(deleting.ok, true, deleting.message);
  assert.equal(releaseAdmission(deleting), 'removed');

  const victims = killSyncTree(runApp.pid);
  assert.ok(!victims.includes(started.watcherPid), 'the watcher was inside the killed tree');
  assert.ok(await waitFor(() => !running(started.watcherPid), 15_000), 'the watcher did not finish');
});

test('checkStdio with the real assertNoAdmissionFd refuses a handoff stdio that names the admission reader (BL-1270)', async () => {
  const admission = admit({ role: 'start', label: 'app', dataRoot: join(dir, 'check-stdio-home', '.batshit', 'pinokio') });
  assert.equal(admission.ok, true, admission.message);
  try {
    const guard = (stdio) => assertNoAdmissionFd(stdio, admission);
    const refused = await startStopWatch({
      handoffArgs: [],
      cwd: dir,
      env: process.env,
      logFd: admission.fd,
      checkStdio: guard,
      spawn: () => assert.fail('a handoff was spawned with the admission reader')
    });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /is the admission reader/);

    const logFd = openSync(join(dir, 'check-stdio.log'), 'a');
    openFds.push(logFd);
    let spawned = 0;
    await startStopWatch({
      handoffArgs: [],
      cwd: dir,
      env: process.env,
      logFd,
      checkStdio: guard,
      spawn: () => {
        spawned += 1;
        throw new Error('not spawned in this test');
      }
    });
    assert.equal(spawned, 1, 'an ordinary handoff stdio passes the guard');
  } finally {
    releaseAdmission(admission);
  }
});

test('every cli.mjs command that touches the data root is admitted first, and only the service spawns get the reader (BL-1270)', () => {
  const source = readFileSync(CLI, 'utf8');
  const body = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  const inOrder = (text, first, second) => {
    const a = text.indexOf(first);
    const b = text.indexOf(second);
    assert.ok(a >= 0 && b >= 0 && a < b, `${first} must come before ${second}`);
  };
  inOrder(body('prepareData'), "admitOrFail('start', 'prepare')", 'laneDataPaths(');
  inOrder(body('preflight'), "admitOrFail('start', 'preflight')", 'readSecrets(');
  inOrder(body('runRedis'), "admitOrFail('start', 'redis')", "serviceCommand('redis')");
  // The first admission of any kind comes only after the name check.
  inOrder(body('runService'), 'unknown service', 'admitOrFail(');
  inOrder(body('runService'), "admitOrFail('start', service)", 'startAppStopWatch(admission)');
  inOrder(body('runService'), 'startAppStopWatch(admission)', 'serviceCommand(service)');
  inOrder(body('deleteData'), 'BATSHIT_DELETE_CONFIRM', "admitOrFail('delete', 'delete')");
  inOrder(body('deleteData'), "admitOrFail('delete', 'delete')", 'settleLaneBeforeMaintenance(');
  inOrder(body('deleteData'), 'await rm(paths.root', 'releaseAdmission(admission)');
  for (const name of ['prepareData', 'preflight', 'runRedis', 'runService', 'deleteData']) {
    assert.match(body(name), /\} finally \{\n\s+releaseAdmission\(admission\);\n\s+\}$/, `${name} releases in finally`);
  }
  assert.equal(source.split('serviceStdio(').length - 1, 2, 'only the two service spawns use serviceStdio');
  assert.match(body('runRedis'), /startChild\('database', command, serviceStdio\(admission, \['ignore', 'inherit', 'inherit'\]\)\)/);
  assert.match(body('runService'), /startChild\(service, command, serviceStdio\(admission, \['inherit', 'inherit', 'inherit'\]\)\)/);
  assert.match(body('startAppStopWatch'), /checkStdio: \(stdio\) => assertNoAdmissionFd\(stdio, admission\)/);
  assert.doesNotMatch(source, /admission\.fd/, 'no stdio names the reader directly');
  const hidden = source.slice(source.indexOf("'stop-watch-handoff':"), source.indexOf("'stop-watch': runLaneStopWatch"));
  assert.doesNotMatch(hidden, /admit/, 'the stop-watch handoff takes no admission');
  assert.doesNotMatch(body('runLaneStopWatch'), /admit/, 'the watcher takes no admission');
});

// The real cli.mjs, under a temporary HOME, while this test holds the other role's admission: each
// command refuses with one Error line and exit 1 before it reads or touches the data root. Its PATH
// holds only Node and the system folders, so no sandbox or container command is reachable even if
// a refusal regressed. (preflight stops earlier, at the installed marker of this checkout; its
// placement is pinned in source above.)
test('the real cli.mjs refuses before touching the data root while the other role holds an admission (BL-1270)', () => {
  const cliHome = join(dir, 'cli-home');
  const dataRoot = laneDataRoot(cliHome);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: cliHome };
  const runCli = (args, extra = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
  const errorLines = (result) => `${result.stdout}${result.stderr}`.split('\n').filter((line) => line.startsWith('Error:'));

  // Delete while a Start command holds its admission: refused, and the root keeps every byte.
  mkdirSync(join(dataRoot, 'redis'), { recursive: true });
  writeFileSync(join(dataRoot, 'batshit.env'), 'kept\n');
  const before = listTree(dataRoot);
  const starting = admit({ role: 'start', label: 'redis', dataRoot });
  assert.equal(starting.ok, true, starting.message);
  try {
    const refused = runCli(['delete-data'], { BATSHIT_DELETE_CONFIRM: 'DELETE' });
    assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
    const lines = errorLines(refused);
    assert.equal(lines.length, 1, lines.join(' | '));
    assert.match(lines[0], new RegExp(`^Error: nothing was deleted: Batshit is starting or running: the database \\(started by launcher process ${process.pid}\\)\\. `));
    assert.deepEqual(listTree(dataRoot), before);
    assert.equal(readFileSync(join(dataRoot, 'batshit.env'), 'utf8'), 'kept\n');
  } finally {
    releaseAdmission(starting);
  }

  // Each Start command while Delete holds its admission: refused, and nothing is created.
  rmSync(dataRoot, { recursive: true, force: true });
  const deleting = admit({ role: 'delete', label: 'delete', dataRoot });
  assert.equal(deleting.ok, true, deleting.message);
  try {
    for (const args of [['prepare-data'], ['run', 'redis'], ['run', 'server'], ['run', 'app']]) {
      const result = runCli(args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      assert.deepEqual(
        errorLines(result),
        ["Error: Delete Batshit data is running, so Batshit's data was not touched. Try again after it finishes."],
        args.join(' ')
      );
      assert.equal(existsSync(dataRoot), false, `${args.join(' ')} created the data root`);
    }
  } finally {
    releaseAdmission(deleting);
  }
});

test('the real CLI refuses an invalid launch profile before any data or admission folder is created', () => {
  const cliHome = join(dir, 'profile-home');
  const dataRoot = laneDataRoot(cliHome);
  const refusedProfiles = [['unknown', /Unknown Pinokio launch profile/]];
  if (process.platform !== 'linux') {
    refusedProfiles.push(['windows-wsl', /requires a Linux guest/]);
  }
  for (const [profile, message] of refusedProfiles) {
    const result = spawnSync(process.execPath, [CLI, 'run', 'redis'], {
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: cliHome, [LANE_LAUNCH_PROFILE_ENV]: profile },
      encoding: 'utf8', timeout: 30_000
    });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const lines = `${result.stdout}${result.stderr}`.split('\n').filter((line) => line.startsWith('Error:'));
    assert.equal(lines.length, 1, lines.join(' | '));
    assert.match(lines[0], message);
    assert.equal(existsSync(dataRoot), false);
    assert.equal(existsSync(`${dataRoot}.admission`), false);
  }
});
