import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  attachLocalRuntimeLaunchRecordFile,
  decideLocalRuntimeGroupStop,
  decideLocalRuntimeStop,
  groupLocalRuntimeLaunchRecords,
  launchRecordMatchesCommand,
  localRuntimeProcessGroupFromPs,
  nativeRunIsGone,
  normalizeLocalRuntimeEndpoint,
  parsePsStartTimeUtc,
  readLocalRuntimeLaunchRecords,
  readLocalRuntimeProcessGroup,
  removeLocalRuntimeLaunchRecord,
  removeLocalRuntimeRecordLockIf,
  updateLocalRuntimeLaunchRecord,
  withLocalRuntimeRecordLock,
  writeLocalRuntimeLaunchRecordFile
} from './local-voice-runtime-stop.mjs';

const RUNNING = { pid: 4242, launchedAt: '2026-09-17T08:00:00.000Z' };

test('a record with no saved choice is still stopped', () => {
  // Quitting the packaged Mac app has always stopped every recorded runtime.
  // A record written before "Stop with Batshit" existed must keep doing that.
  assert.equal(decideLocalRuntimeStop({ record: RUNNING, alive: true }).action, 'verify-and-stop');
});

test('Stop with Batshit on stops the runtime', () => {
  assert.equal(
    decideLocalRuntimeStop({ record: { ...RUNNING, stopOnShutdown: true }, alive: true }).action,
    'verify-and-stop'
  );
});

test('Stop with Batshit off leaves the runtime alone', () => {
  const decision = decideLocalRuntimeStop({
    record: { ...RUNNING, stopOnShutdown: false },
    alive: true
  });
  assert.equal(decision.action, 'keep-running');
  assert.match(decision.reason, /Stop with Batshit is off/);
});

test('only an explicit false keeps a runtime alive', () => {
  // A truthy-but-not-true value must not read as "keep running".
  for (const value of [undefined, null, 0, '', 'false']) {
    assert.equal(
      decideLocalRuntimeStop({ record: { ...RUNNING, stopOnShutdown: value }, alive: true }).action,
      'verify-and-stop',
      `stopOnShutdown ${JSON.stringify(value)} should not keep the runtime alive`
    );
  }
});

test('a dead or unusable record is dropped, never killed', () => {
  assert.equal(decideLocalRuntimeStop({ record: RUNNING, alive: false }).action, 'drop-record');
  assert.equal(
    decideLocalRuntimeStop({ record: { invalid: true }, alive: true }).action,
    'drop-record'
  );
  assert.equal(
    decideLocalRuntimeStop({ record: { pid: 0, launchedAt: RUNNING.launchedAt }, alive: true })
      .action,
    'drop-record'
  );
});

test('a shutdown that owns only its own run skips what another Batshit started', () => {
  // The native launcher shares one runtime state root with the packaged Mac
  // app. Ctrl+C in a dev terminal must not kill the packaged app's engines.
  const launcherStarted = Date.parse('2026-09-17T09:00:00.000Z');

  const older = decideLocalRuntimeStop({
    record: { ...RUNNING, launchedAt: '2026-09-17T08:59:59.000Z' },
    alive: true,
    launchedAfterMs: launcherStarted
  });
  assert.equal(older.action, 'keep-running');
  assert.match(older.reason, /another Batshit started it/);

  assert.equal(
    decideLocalRuntimeStop({
      record: { ...RUNNING, launchedAt: '2026-09-17T09:00:01.000Z' },
      alive: true,
      launchedAfterMs: launcherStarted
    }).action,
    'verify-and-stop'
  );

  // An unreadable launch time is not proof this run started it.
  assert.equal(
    decideLocalRuntimeStop({
      record: { pid: 4242 },
      alive: true,
      launchedAfterMs: launcherStarted
    }).action,
    'keep-running'
  );

  // The Mac supervisor owns the whole machine's Batshit runtime, so it passes
  // no window and stops regardless of when the runtime was launched.
  assert.equal(
    decideLocalRuntimeStop({
      record: { ...RUNNING, launchedAt: '2026-09-17T08:59:59.000Z' },
      alive: true
    }).action,
    'verify-and-stop'
  );
});

test('the off switch is checked before the ownership window', () => {
  // Order matters only for the reason text, but the reason is what the user
  // and the supervisor log read.
  const decision = decideLocalRuntimeStop({
    record: { ...RUNNING, stopOnShutdown: false, launchedAt: '2026-01-01T00:00:00.000Z' },
    alive: true,
    launchedAfterMs: Date.parse('2026-09-17T09:00:00.000Z')
  });
  assert.match(decision.reason, /Stop with Batshit is off/);
});

test('pid-reuse matching recognizes the recorded launch and rejects a stranger', () => {
  const record = {
    command: 'node',
    cwd: '/Users/x/.batshit/installs/whisper-cpp-realtime',
    args: ['/Users/x/.batshit/installs/whisper-cpp-realtime/realtime-adapter.mjs']
  };
  assert.equal(
    launchRecordMatchesCommand(
      record,
      'node /Users/x/.batshit/installs/whisper-cpp-realtime/realtime-adapter.mjs -m model.bin'
    ),
    true
  );
  assert.equal(launchRecordMatchesCommand(record, '/usr/bin/python3 -m http.server 9000'), false);
});

test('launch records are read per engine, and a corrupt one is flagged not guessed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  await mkdir(join(root, 'whisper-cpp'), { recursive: true });
  await mkdir(join(root, 'broken'), { recursive: true });
  await writeFile(
    join(root, 'whisper-cpp', '.batshit-local-runtime-launch.json'),
    JSON.stringify({ pid: 11, command: '/bin/whisper-server', stopOnShutdown: false })
  );
  await writeFile(join(root, 'broken', '.batshit-local-runtime-launch.json'), '{not json');

  const records = await readLocalRuntimeLaunchRecords(root);
  const byId = Object.fromEntries(records.map((record) => [record.engineId, record]));

  assert.equal(byId['whisper-cpp'].stopOnShutdown, false);
  assert.equal(byId.broken.invalid, true);
  assert.equal(decideLocalRuntimeStop({ record: byId.broken, alive: true }).action, 'drop-record');

  // A root that does not exist is empty, not a crash: a machine with no local
  // engines must still shut down cleanly.
  assert.deepEqual(await readLocalRuntimeLaunchRecords(join(root, 'missing')), []);
});

// ---- One process, several records (2026-09-18, bug sweep items 12 and 13) ----------------
//
// A process Batshit started can be named by more than one record: engines that share one
// runtime on one port each carry their own choice ("attach" records, `startedBy`), and a
// launch that took an engine's record name while the earlier process still ran moved that
// record aside instead of destroying it. The decision is per process.

const MLX = {
  command: '/Users/x/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
  args: ['--host', '127.0.0.1', '--port', '8012'],
  cwd: '/Users/x/.batshit/installs/chatterbox-turbo',
  launchedAt: '2026-09-17T01:00:03.000Z'
};
const MLX_COMMAND_LINE =
  '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python ' +
  '/Users/x/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server --host 127.0.0.1 --port 8012';

function shared(engineId, extra = {}) {
  return { engineId, pid: 10778, ...MLX, ...extra };
}

test('a shared runtime stops when every engine that uses it says stop', () => {
  const decision = decideLocalRuntimeGroupStop({
    records: [
      shared('chatterbox-turbo'),
      shared('kokoro', { startedBy: 'chatterbox-turbo', stopOnShutdown: true })
    ],
    alive: true,
    commandLines: [MLX_COMMAND_LINE]
  });
  assert.equal(decision.action, 'stop');
  assert.deepEqual(decision.stale, []);
});

test('one engine that says keep running keeps a shared runtime running', () => {
  const decision = decideLocalRuntimeGroupStop({
    records: [
      shared('chatterbox-turbo', { stopOnShutdown: true }),
      shared('kokoro', { startedBy: 'chatterbox-turbo', stopOnShutdown: false })
    ],
    alive: true,
    commandLines: [MLX_COMMAND_LINE]
  });
  assert.equal(decision.action, 'keep-running');
  assert.match(decision.reason, /Stop with Batshit is off for "kokoro"/);
  assert.equal(decision.keptBy, 'kokoro');
  // Kept means kept: both records stay, so the next quit still knows the process.
  assert.deepEqual(decision.stale, []);
});

test('a record whose command no longer matches cannot veto, and is dropped', () => {
  // Its pid was reused by a launch Batshit DID record, so the stale record is not this
  // process's user; its "keep running" must not hold the real launch up.
  const stale = shared('old-engine', {
    command: '/Users/x/.batshit/installs/whisper-cpp/bin/whisper-server',
    args: ['--port', '8077'],
    cwd: '/Users/x/.batshit/installs/whisper-cpp',
    stopOnShutdown: false
  });
  const decision = decideLocalRuntimeGroupStop({
    records: [shared('chatterbox-turbo'), stale],
    alive: true,
    commandLines: [MLX_COMMAND_LINE]
  });
  assert.equal(decision.action, 'stop');
  assert.deepEqual(decision.stale, [stale]);
});

test('a process no record matches is refused, and its records are dropped', () => {
  const records = [shared('chatterbox-turbo')];
  const decision = decideLocalRuntimeGroupStop({
    records,
    alive: true,
    commandLines: ['/usr/bin/python3 -m http.server 8012']
  });
  assert.equal(decision.action, 'refuse');
  assert.match(decision.reason, /pid 10778 no longer matches its launch record/);
  assert.deepEqual(decision.stale, records);
});

test('a live process whose command line could not be read keeps its records and is not killed', () => {
  // `null` means `ps` itself failed (a timeout under load): killing blind is out, and dropping the
  // record would orphan a running engine.
  const records = [shared('chatterbox-turbo')];
  const decision = decideLocalRuntimeGroupStop({ records, alive: true, commandLines: null });
  assert.equal(decision.action, 'unverified');
  assert.deepEqual(decision.stale, []);
});

test('a live pid that leads no process group is a reused pid: refused, its records dropped', () => {
  // `ps` ran fine and the group has no members: the pid now belongs to a process in some other
  // group. Keeping the record would let a later reuse by a group leader (a Terminal job) match.
  const records = [shared('chatterbox-turbo'), shared('kokoro', { startedBy: 'chatterbox-turbo', stopOnShutdown: false })];
  const decision = decideLocalRuntimeGroupStop({ records, alive: true, commandLines: [] });
  assert.equal(decision.action, 'refuse');
  assert.deepEqual(decision.stale, records);
});

test('the group\'s command lines are required, never guessed', () => {
  assert.throws(() => decideLocalRuntimeGroupStop({ records: [shared('chatterbox-turbo')], alive: true }), TypeError);
});

test('a process that is gone drops every record that named it', () => {
  const records = [shared('chatterbox-turbo'), shared('kokoro', { startedBy: 'chatterbox-turbo' })];
  const decision = decideLocalRuntimeGroupStop({ records, alive: false, commandLines: [] });
  assert.equal(decision.action, 'drop-records');
  assert.deepEqual(decision.stale, records);
});

test('the native launcher still leaves a shared runtime another Batshit started', () => {
  // An attach record copies the process's own launch time, so writing it later cannot make
  // the process look like this run's.
  const decision = decideLocalRuntimeGroupStop({
    records: [shared('chatterbox-turbo'), shared('kokoro', { startedBy: 'chatterbox-turbo' })],
    alive: true,
    commandLines: [MLX_COMMAND_LINE],
    launchedAfterMs: Date.parse('2026-09-17T02:00:00.000Z')
  });
  assert.equal(decision.action, 'keep-running');
  assert.match(decision.reason, /another Batshit started it/);
});

test('records group by the process they name; unusable records are set apart', () => {
  const { groups, unusable } = groupLocalRuntimeLaunchRecords([
    shared('chatterbox-turbo'),
    { engineId: 'whisper-cpp', pid: 19339, command: '/bin/whisper-server' },
    shared('kokoro', { startedBy: 'chatterbox-turbo' }),
    { engineId: 'broken', invalid: true },
    { engineId: 'no-pid', command: '/bin/x' }
  ]);
  const byPid = Object.fromEntries(groups.map((group) => [group.pid, group.records.map((r) => r.engineId)]));
  assert.deepEqual(byPid, { 10778: ['chatterbox-turbo', 'kokoro'], 19339: ['whisper-cpp'] });
  assert.deepEqual(unusable.map((record) => record.engineId), ['broken', 'no-pid']);
});

// ---- The leader's start time names the launch (2026-09-21, BL-60) -------------------------
//
// `dots-tts-mf` runs `uvicorn` from a venv built on the python.org framework Python, which
// re-executes itself as `…/Python.app/Contents/MacOS/Python`: its live command line holds no
// recorded path, so every quit refused it and dropped its record, and it ran forever.

const DOTS = {
  engineId: 'dots-tts-mf',
  pid: 10865,
  command: '/Users/x/.batshit/installs/dots-tts-mf/.venv/bin/python',
  args: ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8122'],
  cwd: '/Users/x/.batshit/installs/dots-tts-mf',
  launchedAt: '2026-09-20T09:01:05.212Z'
};
const DOTS_COMMAND_LINE =
  '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python ' +
  '-m uvicorn server:app --host 127.0.0.1 --port 8122';
const DOTS_STARTED_AT = Date.parse('2026-09-20T09:01:05.000Z');

test('an engine whose interpreter re-executed itself is still its launch (BL-60)', () => {
  // The command line alone refuses it: this is what every quit did.
  assert.equal(
    decideLocalRuntimeGroupStop({ records: [DOTS], alive: true, commandLines: [DOTS_COMMAND_LINE] }).action,
    'refuse'
  );
  // Its leader started before its record was written, so it IS the launch.
  const decision = decideLocalRuntimeGroupStop({
    records: [DOTS],
    alive: true,
    commandLines: [DOTS_COMMAND_LINE],
    leaderStartedAtMs: DOTS_STARTED_AT
  });
  assert.equal(decision.action, 'stop');
  assert.deepEqual(decision.stale, []);
});

test('a leader that started after the record was written is a reused pid, whatever its command line', () => {
  const decision = decideLocalRuntimeGroupStop({
    records: [shared('chatterbox-turbo')],
    alive: true,
    commandLines: [MLX_COMMAND_LINE],
    leaderStartedAtMs: Date.parse(MLX.launchedAt) + 1_000
  });
  assert.equal(decision.action, 'refuse');
  assert.match(decision.reason, /started after its launch \(a reused pid\); refused to kill it/);
  assert.deepEqual(decision.stale, [shared('chatterbox-turbo')]);
});

test('an older launch whose pid a newer launch took has no say over it', () => {
  const old = shared('old-engine', { launchedAt: '2026-09-16T00:00:00.000Z', stopOnShutdown: false });
  const decision = decideLocalRuntimeGroupStop({
    records: [shared('chatterbox-turbo'), old],
    alive: true,
    commandLines: [MLX_COMMAND_LINE],
    leaderStartedAtMs: Date.parse(MLX.launchedAt) - 1_000
  });
  assert.equal(decision.action, 'stop');
  assert.deepEqual(decision.stale, [old]);
});

test('a leader that started long before its record was written proves nothing: the command line decides', () => {
  // Every writer records a launch moments after its spawn. A leader a clock set back since could
  // make look older than its record is no proof; neither kills nor refuses on its own.
  const longBefore = Date.parse(DOTS.launchedAt) - 10 * 60_000;
  assert.equal(
    decideLocalRuntimeGroupStop({ records: [DOTS], alive: true, commandLines: [DOTS_COMMAND_LINE], leaderStartedAtMs: longBefore }).action,
    'refuse'
  );
  assert.equal(
    decideLocalRuntimeGroupStop({
      records: [shared('chatterbox-turbo')],
      alive: true,
      commandLines: [MLX_COMMAND_LINE],
      leaderStartedAtMs: Date.parse(MLX.launchedAt) - 10 * 60_000
    }).action,
    'stop'
  );
  // Inside the minute a spawn can take to be recorded, the start time still decides.
  assert.equal(
    decideLocalRuntimeGroupStop({
      records: [DOTS],
      alive: true,
      commandLines: [DOTS_COMMAND_LINE],
      leaderStartedAtMs: Date.parse(DOTS.launchedAt) - 30_000
    }).action,
    'stop'
  );
});

test('with no leader or no launch time, the command line decides as before', () => {
  // Leader gone (its group's other members still run): command match.
  assert.equal(
    decideLocalRuntimeGroupStop({ records: [DOTS], alive: true, commandLines: [DOTS_COMMAND_LINE], leaderStartedAtMs: null }).action,
    'refuse'
  );
  assert.equal(
    decideLocalRuntimeGroupStop({ records: [shared('chatterbox-turbo')], alive: true, commandLines: [MLX_COMMAND_LINE], leaderStartedAtMs: null }).action,
    'stop'
  );
  // A record with no launch time: command match.
  const unmarked = { ...DOTS, launchedAt: undefined };
  assert.equal(
    decideLocalRuntimeGroupStop({ records: [unmarked], alive: true, commandLines: [DOTS_COMMAND_LINE], leaderStartedAtMs: DOTS_STARTED_AT }).action,
    'refuse'
  );
});

test('the Docker operator\'s stricter command match still decides only when the start time cannot', () => {
  const strict = () => false;
  assert.equal(
    decideLocalRuntimeGroupStop({
      records: [DOTS],
      alive: true,
      commandLines: [DOTS_COMMAND_LINE],
      leaderStartedAtMs: DOTS_STARTED_AT,
      matchesCommand: strict
    }).action,
    'stop'
  );
  assert.equal(
    decideLocalRuntimeGroupStop({ records: [DOTS], alive: true, commandLines: [DOTS_COMMAND_LINE], matchesCommand: strict }).action,
    'refuse'
  );
});

test('ps start times are read in the C locale and UTC, and nothing else is guessed', () => {
  assert.equal(parsePsStartTimeUtc('Sun Sep 20 09:01:05 2026'), DOTS_STARTED_AT);
  assert.equal(parsePsStartTimeUtc('Sun Sep  6 09:01:05 2026'), Date.parse('2026-09-06T09:01:05.000Z'));
  assert.equal(parsePsStartTimeUtc('lun. 21 sept. 13:04:39 2026'), null);
  assert.equal(parsePsStartTimeUtc('Sun Foo 20 09:01:05 2026'), null);
  assert.equal(parsePsStartTimeUtc(''), null);
});

test('a group is read from the whole table: its members, and its leader\'s start time only when the pid leads it', () => {
  const table = [
    '  10865 10865 Sun Sep 20 09:01:05 2026     /Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python -m uvicorn server:app',
    '  10870 10865 Sun Sep 20 09:01:07 2026     /bin/sh -c worker',
    '  10871 10871 Sun Sep  6 10:00:00 2026     /usr/bin/other'
  ].join('\n');
  assert.deepEqual(localRuntimeProcessGroupFromPs(table, 10865), {
    commandLines: [
      '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python -m uvicorn server:app',
      '/bin/sh -c worker'
    ],
    leaderStartedAtMs: DOTS_STARTED_AT
  });
  // The leader exited: its group's members remain, and there is no leader to date.
  assert.deepEqual(localRuntimeProcessGroupFromPs(table.split('\n').slice(1).join('\n'), 10865), {
    commandLines: ['/bin/sh -c worker'],
    leaderStartedAtMs: null
  });
  // A pid that leads no group (a reused pid now in another group): no members, no leader.
  assert.deepEqual(localRuntimeProcessGroupFromPs(table, 10870), { commandLines: [], leaderStartedAtMs: null });
});

test('the live reader dates a real group leader, whatever the user\'s language', async () => {
  const before = Date.now();
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = 'fr_FR.UTF-8';
  try {
    await new Promise((done) => setTimeout(done, 200));
    const group = await readLocalRuntimeProcessGroup(child.pid);
    assert.ok(group.commandLines.some((line) => line.includes('setInterval')));
    assert.ok(group.leaderStartedAtMs >= Math.floor(before / 1000) * 1000 - 1000);
    assert.ok(group.leaderStartedAtMs <= Date.now());
  } finally {
    if (previous === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous;
    process.kill(-child.pid, 'SIGKILL');
  }
});

test('a record moved aside for a newer launch is still read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  await mkdir(join(root, 'chatterbox-turbo'), { recursive: true });
  await writeFile(
    join(root, 'chatterbox-turbo', '.batshit-local-runtime-launch.json'),
    JSON.stringify({ pid: 84894, command: MLX.command })
  );
  await writeFile(
    join(root, 'chatterbox-turbo', '.batshit-local-runtime-launch.10778.json'),
    JSON.stringify({ pid: 10778, command: MLX.command })
  );
  await writeFile(join(root, 'chatterbox-turbo', 'unrelated.json'), '{}');

  const records = await readLocalRuntimeLaunchRecords(root);
  assert.deepEqual(records.map((record) => record.pid).sort(), [10778, 84894]);
  assert.ok(records.every((record) => record.engineId === 'chatterbox-turbo'));
  assert.ok(records.some((record) => record.recordPath.endsWith('.batshit-local-runtime-launch.10778.json')));
});

test('a new launch never discards the record of a process that still runs', async () => {
  // The 2026-09-16 orphan: a second Batshit launched chatterbox-turbo again on another port
  // and overwrote the record of the first launch, which was still running. Nothing could stop
  // that first process after that.
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const running = new Set([10778]);
  const isAlive = (pid) => running.has(pid);

  await writeLocalRuntimeLaunchRecordFile(root, { engineId: 'chatterbox-turbo', pid: 10778, ...MLX }, { isAlive });
  await writeLocalRuntimeLaunchRecordFile(
    root,
    { engineId: 'chatterbox-turbo', pid: 84894, ...MLX, args: ['--port', '8010'] },
    { isAlive }
  );

  const dir = join(root, 'chatterbox-turbo');
  assert.deepEqual((await readdir(dir)).sort(), [
    '.batshit-local-runtime-launch.10778.json',
    '.batshit-local-runtime-launch.json'
  ]);
  assert.equal(JSON.parse(await readFile(join(dir, '.batshit-local-runtime-launch.json'), 'utf8')).pid, 84894);
  assert.equal(JSON.parse(await readFile(join(dir, '.batshit-local-runtime-launch.10778.json'), 'utf8')).pid, 10778);

  // A record whose process is gone, or that names the same process, is simply replaced.
  running.clear();
  await writeLocalRuntimeLaunchRecordFile(root, { engineId: 'chatterbox-turbo', pid: 55300, ...MLX }, { isAlive });
  await writeLocalRuntimeLaunchRecordFile(
    root,
    { engineId: 'chatterbox-turbo', pid: 55300, ...MLX, stopOnShutdown: false },
    { isAlive: () => true }
  );
  assert.deepEqual((await readdir(dir)).sort(), [
    '.batshit-local-runtime-launch.10778.json',
    '.batshit-local-runtime-launch.json'
  ]);
  assert.equal(JSON.parse(await readFile(join(dir, '.batshit-local-runtime-launch.json'), 'utf8')).stopOnShutdown, false);
});

test('one listener has one spelling, so engines sharing a port are recognized', () => {
  for (const spelling of ['http://127.0.0.1:8012', 'http://localhost:8012/', 'http://LOCALHOST:8012/v1', 'ws://[::1]:8012']) {
    assert.equal(normalizeLocalRuntimeEndpoint(spelling), 'http://127.0.0.1:8012', spelling);
  }
  assert.notEqual(normalizeLocalRuntimeEndpoint('http://127.0.0.1:8010'), 'http://127.0.0.1:8012');
  assert.equal(normalizeLocalRuntimeEndpoint('http://host.docker.internal:8012'), 'http://host.docker.internal:8012');
  assert.equal(normalizeLocalRuntimeEndpoint('not a url'), null);
  assert.equal(normalizeLocalRuntimeEndpoint('file:///tmp/x'), null);
});

test('an engine that uses a runtime another launch started records its own choice beside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const running = new Set([10778]);
  const isAlive = (pid) => running.has(pid);
  await writeLocalRuntimeLaunchRecordFile(
    root,
    { engineId: 'chatterbox-turbo', pid: 10778, ...MLX, endpoint: 'http://127.0.0.1:8012' },
    { isAlive }
  );

  assert.equal(
    await attachLocalRuntimeLaunchRecordFile(
      root,
      { engineId: 'kokoro', endpoint: 'http://localhost:8012/', stopOnShutdown: false },
      { isAlive }
    ),
    true
  );
  const kokoro = JSON.parse(await readFile(join(root, 'kokoro', '.batshit-local-runtime-launch.json'), 'utf8'));
  assert.deepEqual(
    { pid: kokoro.pid, command: kokoro.command, launchedAt: kokoro.launchedAt, startedBy: kokoro.startedBy, stop: kokoro.stopOnShutdown },
    { pid: 10778, command: MLX.command, launchedAt: MLX.launchedAt, startedBy: 'chatterbox-turbo', stop: false }
  );

  // Nothing Batshit launched serves this endpoint: no record (Connect Existing, a server the
  // user runs). And the engine whose own launch started it needs no attach record.
  assert.equal(
    await attachLocalRuntimeLaunchRecordFile(root, { engineId: 'qwen', endpoint: 'http://127.0.0.1:8013', stopOnShutdown: true }, { isAlive }),
    false
  );
  assert.equal(
    await attachLocalRuntimeLaunchRecordFile(root, { engineId: 'chatterbox-turbo', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true }, { isAlive }),
    false
  );
  // A launch whose process is gone is not something to attach to.
  running.clear();
  assert.equal(
    await attachLocalRuntimeLaunchRecordFile(root, { engineId: 'other', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: true }, { isAlive }),
    false
  );
  assert.deepEqual((await readdir(root)).sort(), ['chatterbox-turbo', 'kokoro']);
});

// ---- Record writes are atomic and serialized (2026-09-18, review of 22aa935de) ------------

test('a record is replaced whole (temp file, then rename), never rewritten in place', async () => {
  // A quit reading a record mid-write used to see half of it. A rename swaps the whole file in
  // at once, which shows as a new file (a new inode) on every write and every update.
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const recordPath = join(root, 'chatterbox-turbo', '.batshit-local-runtime-launch.json');
  const isAlive = () => false;
  await writeLocalRuntimeLaunchRecordFile(root, { engineId: 'chatterbox-turbo', pid: 10778, ...MLX }, { isAlive });
  const first = (await stat(recordPath)).ino;
  await writeLocalRuntimeLaunchRecordFile(root, { engineId: 'chatterbox-turbo', pid: 10778, ...MLX, stopOnShutdown: false }, { isAlive });
  const second = (await stat(recordPath)).ino;
  const [record] = await readLocalRuntimeLaunchRecords(root);
  assert.equal(await updateLocalRuntimeLaunchRecord(record, { stopOnShutdown: true }), true);
  const third = (await stat(recordPath)).ino;

  assert.notEqual(second, first);
  assert.notEqual(third, second);
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).stopOnShutdown, true);
  assert.deepEqual(await readdir(join(root, 'chatterbox-turbo')), ['.batshit-local-runtime-launch.json']);
});

test('changes to one engine\'s records are serialized by its lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const dir = join(root, 'kokoro');
  const order = [];
  const first = withLocalRuntimeRecordLock(dir, async () => {
    order.push('first-in');
    await new Promise((resolve) => setTimeout(resolve, 150));
    order.push('first-out');
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = withLocalRuntimeRecordLock(dir, async () => order.push('second'));
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-in', 'first-out', 'second']);
  // The lock is gone afterwards, and it is never read as a record.
  assert.deepEqual(await readdir(dir), []);
});

test('a writer removes only its own lock, never one a waiter took over', async () => {
  // Review finding (2026-09-18): a writer that ran past the stale age removed, at its end, the
  // lock a waiter had taken over from it.
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const dir = join(root, 'kokoro');
  const lock = join(dir, '.batshit-local-runtime-launch.lock');
  await withLocalRuntimeRecordLock(dir, async () => {
    // A waiter takes the lock over while this work still runs.
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), 'the-waiter');
  });
  assert.equal(await readFile(join(lock, 'owner'), 'utf8'), 'the-waiter');
  assert.deepEqual(await readdir(dir), ['.batshit-local-runtime-launch.lock']);
});

test('a stale lock is taken over, whether its time is far in the past or in the future', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  for (const offsetMs of [-60_000, 60_000]) {
    const dir = join(root, `engine${offsetMs}`);
    const lock = join(dir, '.batshit-local-runtime-launch.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), 'v2:999999999:0:a-writer-that-died');
    const when = new Date(Date.now() + offsetMs);
    await utimes(lock, when, when);
    let ran = false;
    await withLocalRuntimeRecordLock(dir, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    const names = await readdir(dir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^\.batshit-local-runtime-launch\.reaped-/);
  }
});

test('an ownerless or malformed stale lock fails visibly instead of spinning or being deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  for (const [name, owner] of [
    ['ownerless', null],
    ['malformed', 'not-a-process-identity']
  ]) {
    const dir = join(root, name);
    const lock = join(dir, '.batshit-local-runtime-launch.lock');
    await mkdir(lock, { recursive: true });
    if (owner) await writeFile(join(lock, 'owner'), owner);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    let ran = false;

    await assert.rejects(
      withLocalRuntimeRecordLock(dir, async () => {
        ran = true;
      }),
      /has no valid owner; refusing unsafe takeover/
    );
    assert.equal(ran, false);
    assert.ok(await stat(lock));
  }
});

// BL-63: `ps -o lstart=` answers in the user's language unless it runs in C and UTC. This fake
// `ps` answers in English only when both are passed, so a reader that forgets them sees French.
// August, because `Date.parse` happens to read some French months (`sept.`) but not `août`.
const FAKE_PS_STARTED_AT = Date.UTC(2026, 7, 21, 13, 4, 39);
async function withFrenchPs(run) {
  const bin = await mkdtemp(join(tmpdir(), 'batshit-fake-ps-'));
  await writeFile(
    join(bin, 'ps'),
    [
      '#!/bin/sh',
      'if [ "$LC_ALL" = "C" ] && [ "$TZ" = "UTC0" ]; then',
      "  echo 'Fri Aug 21 13:04:39 2026'",
      'else',
      "  echo 'ven. 21 août 13:04:39 2026'",
      'fi',
      ''
    ].join('\n')
  );
  await chmod(join(bin, 'ps'), 0o755);
  const saved = { PATH: process.env.PATH, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ };
  process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ''}`;
  process.env.LC_ALL = 'fr_FR.UTF-8';
  process.env.TZ = 'Europe/Paris';
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(bin, { recursive: true, force: true });
  }
}

test('a stale lock whose owner pid was reused is reaped on a French Mac', async () => {
  // The owner pid is alive (this process) but started at another time: the pid was reused.
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const dir = join(root, 'kokoro');
  const lock = join(dir, '.batshit-local-runtime-launch.lock');
  await mkdir(dir, { recursive: true });
  await writeFile(lock, `v2:${process.pid}:${FAKE_PS_STARTED_AT - 3_600_000}:an-earlier-owner`);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  let ran = false;
  await withFrenchPs(() =>
    withLocalRuntimeRecordLock(dir, async () => {
      ran = true;
    }, { waitMs: 500 })
  );
  assert.equal(ran, true);
  const names = await readdir(dir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^\.batshit-local-runtime-launch\.reaped-/);
});

test('a stale lock whose owner still runs is kept on a French Mac', async () => {
  // Same pid, same start instant: the owner is alive, so its lock is never taken.
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const dir = join(root, 'kokoro');
  const lock = join(dir, '.batshit-local-runtime-launch.lock');
  await mkdir(dir, { recursive: true });
  await writeFile(lock, `v2:${process.pid}:${FAKE_PS_STARTED_AT}:the-live-owner`);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  let ran = false;
  await withFrenchPs(() =>
    assert.rejects(
      withLocalRuntimeRecordLock(dir, async () => {
        ran = true;
      }, { waitMs: 300 }),
      /timed out waiting for the launch record lock/
    )
  );
  assert.equal(ran, false);
  assert.equal(await readFile(lock, 'utf8'), `v2:${process.pid}:${FAKE_PS_STARTED_AT}:the-live-owner`);
});

test('a waiter fails visibly when another dead-owner reaper already claimed the tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const dir = join(root, 'interrupted-reaper');
  const lock = join(dir, '.batshit-local-runtime-launch.lock');
  const owner = 'v2:999999999:0:dead-writer';
  await mkdir(dir, { recursive: true });
  await writeFile(lock, owner);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const hash = createHash('sha256').update(owner).digest('hex').slice(0, 16);
  await link(lock, join(dir, `.batshit-local-runtime-launch.reaped-${hash}`));
  let ran = false;

  await assert.rejects(
    withLocalRuntimeRecordLock(dir, async () => {
      ran = true;
    }, { waitMs: 50 }),
    /has an incomplete prior reap; refusing unsafe takeover/
  );
  assert.equal(ran, false);
  assert.equal(await readFile(lock, 'utf8'), owner);
});

test('a waiter retries while the winning dead-owner reaper is between claim and unlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const dir = join(root, 'paused-reaper');
  const lock = join(dir, '.batshit-local-runtime-launch.lock');
  const owner = 'v2:999999999:0:dead-writer-paused';
  await mkdir(dir, { recursive: true });
  await writeFile(lock, owner);
  const hash = createHash('sha256').update(owner).digest('hex').slice(0, 16);
  await link(lock, join(dir, `.batshit-local-runtime-launch.reaped-${hash}`));
  setTimeout(() => void rm(lock, { force: true }), 30);
  let ran = false;

  await withLocalRuntimeRecordLock(dir, async () => {
    ran = true;
  }, { waitMs: 500 });
  assert.equal(ran, true);
});

test('waiters never evict a live writer whose lock has aged past the stale threshold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const dir = join(root, 'live-writer');
  const lock = join(dir, '.batshit-local-runtime-launch.lock');
  let release;
  let held;
  const heldPromise = new Promise((resolve) => (held = resolve));
  const releasePromise = new Promise((resolve) => (release = resolve));
  let waiterEntered = false;

  const writer = withLocalRuntimeRecordLock(dir, async () => {
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    held();
    await releasePromise;
  });
  await heldPromise;
  const waiter = withLocalRuntimeRecordLock(dir, async () => {
    waiterEntered = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(waiterEntered, false);
  release();
  await Promise.all([writer, waiter]);
  assert.equal(waiterEntered, true);
  assert.deepEqual(await readdir(dir), []);
});

test('taking over a stale lock never removes a fresh one', async () => {
  // Review finding (2026-09-18): two waiters could both judge a dead writer's lock stale; the
  // first removed it and took a fresh one, and the second then removed that.
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const lock = join(root, '.batshit-local-runtime-launch.lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner'), 'the-first-waiter');
  const isStale = async (moved) => Date.now() - (await stat(moved)).mtimeMs > 10_000;
  assert.equal(await removeLocalRuntimeRecordLockIf(lock, isStale), false);
  assert.equal(await readFile(join(lock, 'owner'), 'utf8'), 'the-first-waiter');
  assert.deepEqual(await readdir(root), ['.batshit-local-runtime-launch.lock']);
});

test('a stopper removes a record only if it is still the record it decided on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const isAlive = () => false;
  await writeLocalRuntimeLaunchRecordFile(root, { engineId: 'kokoro', pid: 111, ...MLX, launchedAt: '2026-09-18T01:00:00.000Z' }, { isAlive });
  const [decidedOn] = await readLocalRuntimeLaunchRecords(root);
  // Meanwhile a new launch of the same engine took the record name.
  await writeLocalRuntimeLaunchRecordFile(root, { engineId: 'kokoro', pid: 222, ...MLX, launchedAt: '2026-09-18T02:00:00.000Z' }, { isAlive });

  assert.equal(await removeLocalRuntimeLaunchRecord(decidedOn), false);
  const [kept] = await readLocalRuntimeLaunchRecords(root);
  assert.equal(kept.pid, 222);
  assert.equal(await removeLocalRuntimeLaunchRecord(kept), true);
  assert.deepEqual(await readLocalRuntimeLaunchRecords(root), []);
});

// ---- Which Batshit launched it (2026-09-18, review of 22aa935de) -------------------------
//
// Several Batshits share one state root. A record names the Batshit whose launch started the
// process (`launchedBy`), and a stopper stops only its own; an unmarked record (written before
// this) keeps today's rules.

const MAC = 'mac-app:/Users/x/Library/Application Support/Batshit';
const NATIVE = 'native:4321:1789700000000';

test('a stopper never stops a process another Batshit launched, whatever the choice', () => {
  const decision = decideLocalRuntimeGroupStop({
    records: [shared('chatterbox-turbo', { launchedBy: MAC })],
    alive: true,
    commandLines: [MLX_COMMAND_LINE],
    owner: NATIVE,
    // The native launcher's window: the packaged app launched this AFTER the native lane started.
    launchedAfterMs: Date.parse('2026-09-17T00:00:00.000Z')
  });
  assert.equal(decision.action, 'keep-running');
  assert.match(decision.reason, /another Batshit \(mac-app:.*\) launched it/);
});

test('a stopper stops its own Batshit\'s launches, before or after its window', () => {
  for (const launchedAfterMs of [null, Date.parse('2030-01-01T00:00:00.000Z')]) {
    assert.equal(
      decideLocalRuntimeGroupStop({
        records: [shared('chatterbox-turbo', { launchedBy: NATIVE })],
        alive: true,
        commandLines: [MLX_COMMAND_LINE],
        owner: NATIVE,
        launchedAfterMs
      }).action,
      'stop'
    );
  }
});

test('an unmarked record keeps today\'s rules: the Mac app stops it, the native lane only inside its window', () => {
  const unmarked = [shared('chatterbox-turbo')];
  assert.equal(
    decideLocalRuntimeGroupStop({ records: unmarked, alive: true, commandLines: [MLX_COMMAND_LINE], owner: MAC }).action,
    'stop'
  );
  assert.equal(
    decideLocalRuntimeGroupStop({
      records: unmarked,
      alive: true,
      commandLines: [MLX_COMMAND_LINE],
      owner: NATIVE,
      launchedAfterMs: Date.parse('2026-09-17T02:00:00.000Z')
    }).action,
    'keep-running'
  );
});

test('the Mac app stops what a native run launched only once that run is gone', () => {
  const records = [shared('chatterbox-turbo', { launchedBy: NATIVE })];
  const running = decideLocalRuntimeGroupStop({
    records,
    alive: true,
    commandLines: [MLX_COMMAND_LINE],
    owner: MAC,
    ownerIsGone: () => false
  });
  assert.equal(running.action, 'keep-running');
  assert.equal(
    decideLocalRuntimeGroupStop({ records, alive: true, commandLines: [MLX_COMMAND_LINE], owner: MAC, ownerIsGone: () => true })
      .action,
    'stop'
  );
});

test('a native run is gone when its launcher process is', () => {
  assert.equal(nativeRunIsGone(`native:${process.pid}:1789700000000`), false);
  assert.equal(nativeRunIsGone('native:999999999:1789700000000'), true);
  // Not a native run, or not readable: never treated as gone.
  assert.equal(nativeRunIsGone(MAC), false);
  assert.equal(nativeRunIsGone('native:not-a-pid'), false);
});

test('a lock a crashed writer left behind is broken, so a launch always gets its record', async () => {
  // Without this a launch would wait out the lock, fail to write its record, and leave a
  // runtime nothing could stop: the very orphan the records exist to prevent.
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const lock = join(root, 'kokoro', '.batshit-local-runtime-launch.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner'), 'v2:999999999:0:a-writer-that-died');
  const longAgo = new Date(Date.now() - 60_000);
  await utimes(lock, longAgo, longAgo);

  const startedAt = Date.now();
  await writeLocalRuntimeLaunchRecordFile(root, { engineId: 'kokoro', pid: 42, ...MLX }, { isAlive: () => false });

  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(
    (await readdir(join(root, 'kokoro'))).filter((name) => name.endsWith('.json')),
    ['.batshit-local-runtime-launch.json']
  );
});

test('a writer immediately reaps a fresh lock whose owner is proven dead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-launch-records-'));
  const lock = join(root, 'kokoro', '.batshit-local-runtime-launch.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner'), 'v2:999999999:0:a-writer-that-died');

  const startedAt = Date.now();
  await writeLocalRuntimeLaunchRecordFile(root, { engineId: 'kokoro', pid: 42, ...MLX }, { isAlive: () => false });

  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(
    (await readdir(join(root, 'kokoro'))).filter((name) => name.endsWith('.json')),
    ['.batshit-local-runtime-launch.json']
  );
});
