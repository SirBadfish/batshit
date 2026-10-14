// Docker's sbx daemon at shutdown (2026-09-21, BL-61): the decision, and the stop against a REAL
// detached daemon process played by a fake `sbx` that keeps the rules measured against sbx v0.43.0
// (`test-fixtures/fake-sbx-daemon.mjs`): `ls --json` starts the daemon when it is not running and
// says `Starting sandboxd daemon...` first; `daemon status --json` names its socket, with its pid
// file beside it; `daemon stop` stops it.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  SBX_CALL_TIMEOUT_MS,
  SBX_DAEMON_GONE_TIMEOUT_MS,
  SBX_DAEMON_RECORD_NAME,
  SBX_DAEMON_STOP_TIMEOUT_MS,
  SBX_DAEMON_STOP_WORST_CASE_MS,
  busySbxSandboxes,
  daemonStartedByRecordedCall,
  decideSbxDaemonStop,
  findSbxOnPath,
  readSbxDaemonRecord,
  readSbxDaemonRecordState,
  recordedCallWindow,
  resolveSbxDaemonStateDir,
  sameRecordGeneration,
  sbxCallStartedDaemon,
  sbxListTimeoutMs,
  stopSbxDaemonIfBatshitStartedIt,
  writeSbxDaemonRecord
} from './sbx-daemon-stop.mjs';
import { withLocalRuntimeRecordLock } from './local-voice-runtime-stop.mjs';
import { installFakeSbxDaemon } from './test-fixtures/fake-sbx-daemon.mjs';

const execFileAsync = promisify(execFile);
const OWNER = 'mac-app:/Users/x/Library/Application Support/Batshit';

test('a call started the daemon only when sbx says so first, before any command output', () => {
  assert.equal(sbxCallStartedDaemon('Starting sandboxd daemon...\n', '{"sandboxes":[]}'), true);
  // The Windows build says it on stdout, three times, ahead of the JSON.
  assert.equal(sbxCallStartedDaemon('', 'Starting sandboxd daemon...\r\nStarting sandboxd daemon...\r\n{}'), true);
  // A sandboxed command that prints the same words is not sbx starting a daemon.
  assert.equal(sbxCallStartedDaemon('npm warn\nStarting sandboxd daemon...\n', 'hello\n'), false);
  assert.equal(sbxCallStartedDaemon('', '{"sandboxes":[]}'), false);
});

test('only a daemon that started while the recorded call ran is the one it started', () => {
  const record = { callStartedAt: '2026-09-21T13:02:19.600Z', callEndedAt: '2026-09-21T13:02:20.950Z' };
  const at = (iso) => ({ startedAtMs: Date.parse(iso) });
  // `ps` dates a process to the second, rounded down: 13:02:19 counts for a call begun at :19.6.
  assert.equal(daemonStartedByRecordedCall(record, at('2026-09-21T13:02:19.000Z')), true);
  assert.equal(daemonStartedByRecordedCall(record, at('2026-09-21T13:02:20.000Z')), true);
  assert.equal(daemonStartedByRecordedCall(record, at('2026-09-21T13:02:18.000Z')), false);
  assert.equal(daemonStartedByRecordedCall(record, at('2026-09-21T13:02:21.000Z')), false);
  assert.equal(daemonStartedByRecordedCall({}, at('2026-09-21T13:02:20.000Z')), false);
});

test('a sandbox that is anything but stopped keeps the daemon', () => {
  const listed = 'Starting sandboxd daemon...\n' + JSON.stringify({
    sandboxes: [
      { name: 'batshit-a', status: 'stopped' },
      { name: 'mine', status: 'running' },
      { name: 'batshit-b', status: 'creating' }
    ]
  });
  assert.deepEqual(busySbxSandboxes(listed), ['mine', 'batshit-b']);
  assert.deepEqual(busySbxSandboxes('{"sandboxes":[]}'), []);
  assert.throws(() => busySbxSandboxes('ERROR: Not authenticated to Docker'));
  // A list that is not there is not an empty list (BL-1255).
  assert.throws(() => busySbxSandboxes('{}'), /no sandbox list/);
  assert.throws(() => busySbxSandboxes('{"sandboxes":null}'), /no sandbox list/);
  assert.throws(() => busySbxSandboxes('{"sandboxes":{"name":"x"}}'), /no sandbox list/);
});

test('the decision: nothing without a record, never another Batshit\'s, never a daemon it did not start', () => {
  const record = { launchedBy: OWNER, callStartedAt: '2026-09-21T13:02:19.600Z', callEndedAt: '2026-09-21T13:02:20.950Z' };
  const ours = { running: true, pid: 31815, startedAtMs: Date.parse('2026-09-21T13:02:20.000Z') };
  const later = { ...ours, startedAtMs: Date.parse('2026-09-21T15:00:00.000Z') };

  assert.deepEqual(decideSbxDaemonStop({ record: null, daemon: ours, owner: OWNER }), { action: 'none', verdict: 'absent' });
  // An unreadable record is kept (BL-1256): it may name a daemon still running.
  assert.deepEqual(
    pick(decideSbxDaemonStop({ record: { invalid: true }, daemon: ours, owner: OWNER })),
    { action: 'keep', verdict: 'unknown' }
  );
  assert.deepEqual(decideSbxDaemonStop({ record, daemon: ours, owner: OWNER }), { action: 'check-sandboxes', daemon: ours });
  // Restarted since (by the user, or after a crash): not the one Batshit started.
  assert.deepEqual(pick(decideSbxDaemonStop({ record, daemon: later, owner: OWNER })), { action: 'drop-record', verdict: 'gone' });
  assert.deepEqual(pick(decideSbxDaemonStop({ record, daemon: { running: false }, owner: OWNER })), { action: 'drop-record', verdict: 'gone' });

  const native = { ...record, launchedBy: 'native:4242:1758459739000' };
  assert.equal(decideSbxDaemonStop({ record: native, daemon: ours, owner: OWNER }).action, 'keep');
  assert.equal(
    decideSbxDaemonStop({ record: native, daemon: ours, owner: OWNER, ownerIsGone: () => true }).action,
    'check-sandboxes'
  );
  // An unmarked record (a Batshit started without a launcher) is anyone's to stop, under the legacy rule.
  const { launchedBy: _unused, ...unmarked } = record;
  assert.equal(decideSbxDaemonStop({ record: unmarked, daemon: ours, owner: OWNER }).action, 'check-sandboxes');
});

const pick = (result) => ({ action: result.action, verdict: result.verdict });

test('what cannot be known is kept: a failed probe, an unreadable time, a daemon start time it cannot read (BL-1255)', () => {
  const record = { launchedBy: OWNER, callStartedAt: '2026-09-21T13:02:19.600Z', callEndedAt: '2026-09-21T13:02:20.950Z' };
  const ours = { running: true, pid: 31815, startedAtMs: Date.parse('2026-09-21T13:02:20.000Z') };
  for (const daemon of [null, { error: 'sbx daemon status said "degraded"' }, { error: "ps could not read the daemon's start time" }, { ...ours, startedAtMs: Number.NaN }]) {
    assert.deepEqual(pick(decideSbxDaemonStop({ record, daemon, owner: OWNER })), { action: 'keep', verdict: 'unknown' }, JSON.stringify(daemon));
  }
  for (const times of [{}, { callStartedAt: 'yesterday', callEndedAt: record.callEndedAt }, { callStartedAt: record.callEndedAt, callEndedAt: record.callStartedAt }]) {
    const bad = { launchedBy: OWNER, ...times };
    assert.equal(recordedCallWindow(bad), null);
    assert.deepEqual(pick(decideSbxDaemonStop({ record: bad, daemon: ours, owner: OWNER })), { action: 'keep', verdict: 'unknown' }, JSON.stringify(times));
    // With the daemon proven stopped, an unreadable time no longer matters: nothing runs.
    assert.deepEqual(pick(decideSbxDaemonStop({ record: bad, daemon: { running: false }, owner: OWNER })), { action: 'drop-record', verdict: 'gone' });
  }
});

test('the exact owner policy acts only on a record naming exactly this owner (BL-1257)', () => {
  const ours = { running: true, pid: 31815, startedAtMs: Date.parse('2026-09-21T13:02:20.000Z') };
  const times = { callStartedAt: '2026-09-21T13:02:19.600Z', callEndedAt: '2026-09-21T13:02:20.950Z' };
  const exact = { owner: OWNER, ownerIsGone: () => true, ownerPolicy: 'exact' };
  assert.equal(decideSbxDaemonStop({ record: { launchedBy: OWNER, ...times }, daemon: ours, ...exact }).action, 'check-sandboxes');
  for (const launchedBy of [undefined, 'native:4242:1758459739000', `${OWNER}/`, 'mac-app:/elsewhere']) {
    const record = { ...(launchedBy ? { launchedBy } : {}), ...times };
    assert.deepEqual(pick(decideSbxDaemonStop({ record, daemon: ours, ...exact })), { action: 'keep', verdict: 'not-ours' }, String(launchedBy));
  }
  assert.match(decideSbxDaemonStop({ record: { ...times }, daemon: ours, ...exact }).reason, /its record names no Batshit/);
});

test('the state folder defaults under ~/.batshit/runtime and honors an override', () => {
  assert.match(resolveSbxDaemonStateDir(undefined), /\/\.batshit\/runtime\/sbx-daemon$/);
  assert.equal(resolveSbxDaemonStateDir('/tmp/x/sbx-daemon'), '/tmp/x/sbx-daemon');
});

// ---- Against a real detached daemon ---------------------------------------------------------

const sandbox = await mkdtemp(join(tmpdir(), 'batshit-sbx-daemon-stop-'));
const daemons = new Set();
const fake = await installFakeSbxDaemon(sandbox);
const SBX = fake.sbx;
Object.assign(process.env, fake.env);
// The fake comes first on PATH for the whole file, ahead of the fallback folders that hold Docker's
// real CLI: a broken runner (or a mutation run) must never reach the real `sbx`.
process.env.PATH = `${fake.binDir}${delimiter}${process.env.PATH ?? ''}`;

test.after(async () => {
  for (const pid of daemons) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await rm(sandbox, { recursive: true, force: true });
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function daemonPid() {
  const pid = await fake.daemonPid();
  if (pid) daemons.add(pid);
  return pid;
}

async function stopDaemonIfRunning() {
  await execFileAsync(SBX, ['daemon', 'stop']).catch(() => {});
}

// What the app does: run a call, and when its output says it started the daemon, record it.
async function callThatStartsTheDaemon(stateDir, launchedBy = OWNER, sbxPath = SBX) {
  const callStartedAt = Date.now();
  const { stdout, stderr } = await execFileAsync(SBX, ['ls', '--json']);
  const callEndedAt = Date.now();
  assert.equal(sbxCallStartedDaemon(stderr, stdout), true);
  await writeSbxDaemonRecord(stateDir, { launchedBy, callStartedAt, callEndedAt, sbxPath });
  return daemonPid();
}

async function startUsersDaemon() {
  const users = spawn(SBX, ['daemon', 'start'], { detached: true, stdio: 'ignore' });
  users.unref();
  daemons.add(users.pid);
  for (let tries = 0; tries < 50 && (await fake.daemonPid()) !== users.pid; tries += 1) {
    await new Promise((done) => setTimeout(done, 50));
  }
  return users.pid;
}

async function freshStateDir(name) {
  const dir = join(sandbox, 'state', name);
  await mkdir(dir, { recursive: true });
  return dir;
}

test('the sbx a PATH finds is recorded as PATH names it', async () => {
  assert.equal(findSbxOnPath(`/nonexistent${delimiter}${fake.binDir}`), SBX);
  assert.equal(findSbxOnPath('/nonexistent'), null);
});

test('quitting stops the daemon its own call started, with sbx daemon stop, and drops the record', async () => {
  await stopDaemonIfRunning();
  await fake.setSandboxes([{ name: 'batshit-idle', status: 'stopped' }]);
  const stateDir = await freshStateDir('ours');
  const pid = await callThatStartsTheDaemon(stateDir);
  assert.equal(alive(pid), true);

  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.deepEqual(result, { action: 'stopped', ok: true, verdict: 'stopped', pid });
  assert.equal(alive(pid), false);
  assert.deepEqual(await readdir(stateDir), []);
});

test('a daemon the user started is never stopped: there is no record', async () => {
  await stopDaemonIfRunning();
  const users = await startUsersDaemon();
  const stateDir = await freshStateDir('users');

  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.deepEqual(result, { action: 'none', verdict: 'absent' });
  assert.equal(alive(users), true);
  await stopDaemonIfRunning();
});

test('a record from an earlier call never stops a daemon that started since', async () => {
  await stopDaemonIfRunning();
  const stateDir = await freshStateDir('restarted');
  const hourAgo = Date.now() - 3_600_000;
  await writeSbxDaemonRecord(stateDir, { launchedBy: OWNER, callStartedAt: hourAgo, callEndedAt: hourAgo + 1_000, sbxPath: SBX });
  const users = await startUsersDaemon();

  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.equal(result.action, 'drop-record');
  assert.equal(alive(users), true);
  assert.equal(await readSbxDaemonRecord(stateDir), null);
  await stopDaemonIfRunning();
});

test('a running sandbox keeps the daemon, and its record stays for the next quit', async () => {
  await stopDaemonIfRunning();
  await fake.setSandboxes([{ name: 'someone-elses', status: 'running' }]);
  const stateDir = await freshStateDir('busy');
  const pid = await callThatStartsTheDaemon(stateDir);

  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /a sandbox is still running \(someone-elses\)/);
  assert.equal(alive(pid), true);
  assert.deepEqual(await readdir(stateDir), [SBX_DAEMON_RECORD_NAME]);

  // Once nothing runs, the next quit stops it.
  await fake.setSandboxes([{ name: 'someone-elses', status: 'stopped' }]);
  assert.equal((await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER })).action, 'stopped');
  assert.equal(alive(pid), false);
});

test('another running Batshit\'s daemon is left alone, without calling sbx', async () => {
  await stopDaemonIfRunning();
  await fake.setSandboxes([]);
  const stateDir = await freshStateDir('theirs');
  const pid = await callThatStartsTheDaemon(stateDir, `native:${process.pid}:1758459739000`, '/nonexistent/sbx');

  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /another Batshit/);
  assert.equal(alive(pid), true);
  await stopDaemonIfRunning();
});

test('when the recorded sbx has gone (an upgrade moved it), the one PATH finds is used', async () => {
  await stopDaemonIfRunning();
  await fake.setSandboxes([]);
  const stateDir = await freshStateDir('moved');
  const pid = await callThatStartsTheDaemon(stateDir, OWNER, '/nonexistent/old-cellar/sbx');
  const originalPath = process.env.PATH;
  process.env.PATH = `${fake.binDir}${delimiter}${originalPath ?? ''}`;
  try {
    assert.deepEqual(await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER }), { action: 'stopped', ok: true, verdict: 'stopped', pid });
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(alive(pid), false);
});

test('an sbx that never answers costs the quit seconds, never minutes', async () => {
  const stuckBin = join(sandbox, 'stuck-bin');
  await mkdir(stuckBin, { recursive: true });
  const stuck = join(stuckBin, 'sbx');
  // Ignores SIGTERM, as the sbx client does for about 29 s.
  await writeFile(stuck, `#!${process.execPath}\nprocess.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)\n`);
  await chmod(stuck, 0o755);
  const stateDir = await freshStateDir('stuck');
  await writeSbxDaemonRecord(stateDir, { launchedBy: OWNER, callStartedAt: Date.now(), callEndedAt: Date.now(), sbxPath: stuck });

  const startedAt = Date.now();
  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, callTimeoutMs: 500 });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /could not be checked/);
  assert.ok(Date.now() - startedAt < 3_000, `took ${Date.now() - startedAt} ms`);
  assert.deepEqual(await readdir(stateDir), [SBX_DAEMON_RECORD_NAME]);
});

// BL-193: the first `sbx ls --json` after hours idle took longer than a call's 4 s and was killed, so
// a quit left the daemon a dev lane had started running; a minute later the whole stop took 4.4 s.
// The list now gets what the stop's own budget leaves once the stop and the wait for the daemon to go
// are set aside, never less than a call's bound, so the whole stop still fits the worst case the
// native launcher waits for.
test('the list gets what the stop\'s budget leaves, never less than a call\'s bound', () => {
  const startedAt = 1_000_000;
  const deadline = startedAt + SBX_DAEMON_STOP_WORST_CASE_MS;
  // The daemon status and `ps` answered at once: about 11 s for the list.
  assert.equal(
    sbxListTimeoutMs(deadline, startedAt + 100, SBX_CALL_TIMEOUT_MS, SBX_DAEMON_STOP_TIMEOUT_MS, SBX_DAEMON_GONE_TIMEOUT_MS),
    10_900
  );
  // They took their whole bounds: the list keeps a call's own bound, and the total stays the worst case.
  const late = startedAt + SBX_CALL_TIMEOUT_MS + 3_000;
  assert.equal(sbxListTimeoutMs(deadline, late, SBX_CALL_TIMEOUT_MS, SBX_DAEMON_STOP_TIMEOUT_MS, SBX_DAEMON_GONE_TIMEOUT_MS), SBX_CALL_TIMEOUT_MS);
  assert.equal(late - startedAt + SBX_CALL_TIMEOUT_MS + SBX_DAEMON_STOP_TIMEOUT_MS + SBX_DAEMON_GONE_TIMEOUT_MS, SBX_DAEMON_STOP_WORST_CASE_MS);
  // A kill that lands late never shortens the list below a call's bound.
  assert.equal(sbxListTimeoutMs(deadline, late + 500, SBX_CALL_TIMEOUT_MS, SBX_DAEMON_STOP_TIMEOUT_MS, SBX_DAEMON_GONE_TIMEOUT_MS), SBX_CALL_TIMEOUT_MS);
});

test('a slow first list after idle still gets its answer, and the daemon Batshit started is stopped', async () => {
  await stopDaemonIfRunning();
  await fake.setSandboxes([{ name: 'batshit-idle', status: 'stopped' }]);
  const stateDir = await freshStateDir('slow-list');
  const pid = await callThatStartsTheDaemon(stateDir);
  // Slower than a call's bound (1 s here), well inside what the budget leaves for it.
  await fake.setLsDelay(2_500);
  try {
    const result = await stopSbxDaemonIfBatshitStartedIt({
      stateDir,
      owner: OWNER,
      callTimeoutMs: 1_000,
      stopTimeoutMs: 3_000,
      goneTimeoutMs: 2_000
    });

    assert.deepEqual(result, { action: 'stopped', ok: true, verdict: 'stopped', pid });
    assert.equal(alive(pid), false);
  } finally {
    await fake.setLsDelay(null);
  }
});

test('a list that never answers still ends inside the stop\'s budget, and the daemon stays', async () => {
  await stopDaemonIfRunning();
  await fake.setSandboxes([]);
  const stateDir = await freshStateDir('stuck-list');
  const pid = await callThatStartsTheDaemon(stateDir);
  await fake.setLsDelay(60_000);
  try {
    const callTimeoutMs = 500;
    const stopTimeoutMs = 1_000;
    const goneTimeoutMs = 500;
    const startedAt = Date.now();
    const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, callTimeoutMs, stopTimeoutMs, goneTimeoutMs });
    const took = Date.now() - startedAt;

    assert.equal(result.action, 'keep');
    assert.match(result.reason, /its sandboxes could not be listed/);
    // The budget: two calls, the `ps` bound (3 s), the stop, and the wait, one after another.
    assert.ok(took < 2 * callTimeoutMs + 3_000 + stopTimeoutMs + goneTimeoutMs, `took ${took} ms`);
    assert.equal(alive(pid), true);
  } finally {
    await fake.setLsDelay(null);
    await stopDaemonIfRunning();
  }
});


// ---- What is not known is kept, and an effect acts only on the admitted record (BL-1255/1256/1257) ----
//
// Real record files on disk, and small one-off fake `sbx` scripts (never Docker's) that answer one
// way and, when asked, replace the record while the stop is checking: between the stop's own read and
// its effect. Each logs its calls, so a test can prove no `daemon stop` was asked for.

async function recordFile(stateDir, content) {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, SBX_DAEMON_RECORD_NAME);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

// A process that stands in for the daemon: detached, alive, its start time readable by `ps`.
async function standInDaemon() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  daemons.add(child.pid);
  return child.pid;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((done) => child.once('exit', done));
  return child.pid;
}

let oneOffCount = 0;
// A one-off fake sbx: `status` is what `daemon status --json` says (its pid file names `pid`), `ls` is
// what `ls --json` prints, and `replace` ({ at: 'status' | 'ls' | 'stop', content, inPlace }) rewrites the
// record at `recordPath` just before that answer: a new file renamed over it, as every writer does, or
// with `inPlace` the same file rewritten. With `stopKills`, `daemon stop` kills the process its pid file names.
async function oneOffSbx({ status = 'running', pid = 0, ls = '{"sandboxes":[]}', replace = null, recordPath = null, stopKills = false }) {
  oneOffCount += 1;
  const dir = join(sandbox, `one-off-${oneOffCount}`);
  await mkdir(join(dir, 'sandboxd'), { recursive: true });
  const pidFile = join(dir, 'sandboxd', 'sandboxd.pid');
  await writeFile(pidFile, String(pid));
  const calls = join(dir, 'calls.log');
  const script = join(dir, 'sbx');
  await writeFile(
    script,
    `#!${process.execPath}
const fs = require('fs')
const args = process.argv.slice(2).join(' ')
fs.appendFileSync(${JSON.stringify(calls)}, args + '\\n')
const replace = ${JSON.stringify(replace)}
const recordPath = ${JSON.stringify(recordPath)}
function replaceRecord(at) {
  if (!replace || replace.at !== at) return
  // In place keeps the file (same inode): only its bytes say it changed.
  if (replace.inPlace) return fs.writeFileSync(recordPath, replace.content)
  fs.writeFileSync(recordPath + '.replacement.tmp', replace.content)
  fs.renameSync(recordPath + '.replacement.tmp', recordPath)
}
if (args === 'daemon status --json') {
  replaceRecord('status')
  console.log(JSON.stringify({ status: ${JSON.stringify(status)}, socket: ${JSON.stringify(join(dir, 'sandboxd', 'sandboxd.sock'))} }))
} else if (args === 'ls --json') {
  replaceRecord('ls')
  console.log(${JSON.stringify(ls)})
} else if (args === 'daemon stop') {
  replaceRecord('stop')
  if (${JSON.stringify(stopKills)}) {
    try { process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8')), 'SIGKILL') } catch {}
    console.log('fake: daemon stopped')
  } else {
    console.log('fake: daemon stop asked, and ignored')
  }
} else {
  process.exit(2)
}
`
  );
  await chmod(script, 0o755);
  return {
    sbx: script,
    setPid: (value) => writeFile(pidFile, String(value)),
    calls: async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  };
}

// A call window around now, so a stand-in started inside it reads as the daemon that call started.
function windowAroundNow() {
  return { callStartedAt: new Date(Date.now() - 2_000).toISOString(), callEndedAt: new Date(Date.now() + 5_000).toISOString() };
}

test('the record reader: only "no such file" is absent; anything unreadable is unknown, never gone (BL-1256)', async () => {
  const base = await freshStateDir('reader');
  assert.deepEqual(await readSbxDaemonRecordState(join(base, 'none')), { state: 'absent' });
  assert.equal(await readSbxDaemonRecord(join(base, 'none')), null);

  const cases = {
    directory: async (dir) => mkdir(join(dir, SBX_DAEMON_RECORD_NAME), { recursive: true }),
    unreadable: async (dir) => chmod(await recordFile(dir, { launchedBy: OWNER }), 0o000),
    empty: async (dir) => recordFile(dir, ''),
    whitespace: async (dir) => recordFile(dir, '  \n'),
    malformed: async (dir) => recordFile(dir, '{ "launchedBy": '),
    array: async (dir) => recordFile(dir, '[1, 2]'),
    string: async (dir) => recordFile(dir, '"text"')
  };
  for (const [name, make] of Object.entries(cases)) {
    const dir = join(base, name);
    await mkdir(dir, { recursive: true });
    await make(dir);
    const read = await readSbxDaemonRecordState(dir);
    assert.equal(read.state, 'unknown', name);
    assert.match(read.reason, /record/, name);
    assert.equal((await readSbxDaemonRecord(dir)).invalid, true, name);
    await chmod(join(dir, SBX_DAEMON_RECORD_NAME), 0o755);
  }

  const dir = join(base, 'present');
  const path = await recordFile(dir, { launchedBy: OWNER, callStartedAt: 'a', callEndedAt: 'b' });
  const first = await readSbxDaemonRecordState(dir);
  assert.equal(first.state, 'present');
  assert.equal(first.record.launchedBy, OWNER);
  assert.equal(first.generation.ino, (await stat(path)).ino);
  assert.equal(sameRecordGeneration(first.generation, (await readSbxDaemonRecordState(dir)).generation), true);
  // The same bytes renamed over it are another generation: a replacement is never the admitted record.
  await writeFile(`${path}.tmp`, await readFile(path));
  await rename(`${path}.tmp`, path);
  assert.equal(sameRecordGeneration(first.generation, (await readSbxDaemonRecordState(dir)).generation), false);
});

test('an unreadable record is kept, untouched, and no sbx is asked (BL-1256)', async () => {
  const makers = {
    directory: async (dir) => mkdir(join(dir, SBX_DAEMON_RECORD_NAME), { recursive: true }),
    empty: async (dir) => recordFile(dir, ''),
    malformed: async (dir) => recordFile(dir, '{ nope')
  };
  for (const [name, make] of Object.entries(makers)) {
    const stateDir = await freshStateDir(`unreadable-${name}`);
    await make(stateDir);
    const before = await readdir(stateDir);
    for (const ownerPolicy of ['legacy', 'exact']) {
      const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy });
      assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' }, `${name} ${ownerPolicy}`);
    }
    assert.deepEqual(await readdir(stateDir), before, name);
  }
});

test('a daemon status other than running or stopped, or a ps that cannot date the daemon, keeps everything (BL-1255)', async () => {
  let stateDir = await freshStateDir('status-degraded');
  let fakeSbx = await oneOffSbx({ status: 'degraded' });
  let path = await recordFile(stateDir, { launchedBy: OWNER, ...windowAroundNow(), sbxPath: fakeSbx.sbx });
  let before = await readFile(path, 'utf8');
  let result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /sbx daemon status said "degraded"/);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await fakeSbx.calls(), ['daemon status --json']);

  stateDir = await freshStateDir('ps-cannot-date');
  fakeSbx = await oneOffSbx({ status: 'running', pid: await deadPid() });
  path = await recordFile(stateDir, { launchedBy: OWNER, ...windowAroundNow(), sbxPath: fakeSbx.sbx });
  before = await readFile(path, 'utf8');
  result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /ps could not read the daemon's start time/);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await fakeSbx.calls(), ['daemon status --json']);
});

test('a sandbox list without a list keeps the daemon and its record (BL-1255)', async () => {
  for (const [index, ls] of ['{}', '{"sandboxes":null}'].entries()) {
    const stateDir = await freshStateDir(`no-list-${index}`);
    const fakeSbx = await oneOffSbx({ status: 'running', ls });
    const times = windowAroundNow();
    const pid = await standInDaemon();
    await fakeSbx.setPid(pid);
    const path = await recordFile(stateDir, { launchedBy: OWNER, ...times, sbxPath: fakeSbx.sbx });
    const before = await readFile(path, 'utf8');
    const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });
    assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' }, ls);
    assert.match(result.reason, /no sandbox list/);
    assert.equal(alive(pid), true);
    assert.deepEqual(await fakeSbx.calls(), ['daemon status --json', 'ls --json']);
    assert.equal(await readFile(path, 'utf8'), before);
  }
});

test('the exact owner policy never acts on an unmarked record, where the legacy rule would (BL-1257)', async () => {
  const stateDir = await freshStateDir('exact-unmarked');
  const fakeSbx = await oneOffSbx({ status: 'running' });
  const times = windowAroundNow();
  const pid = await standInDaemon();
  await fakeSbx.setPid(pid);
  const path = await recordFile(stateDir, { ...times, sbxPath: fakeSbx.sbx });
  const before = await readFile(path, 'utf8');

  const exact = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  assert.deepEqual(pick(exact), { action: 'keep', verdict: 'not-ours' });
  assert.deepEqual(await fakeSbx.calls(), [], 'not one sbx call for a record that is not this owner\'s');
  assert.equal(await readFile(path, 'utf8'), before);

  // The legacy rule (the Mac supervisor's) still treats an unmarked record as anyone's.
  const legacy = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, goneTimeoutMs: 200 });
  assert.ok((await fakeSbx.calls()).includes('daemon stop'));
  assert.deepEqual(pick(legacy), { action: 'keep', verdict: 'kept' }, 'the stand-in ignores the stop, so it did not go');

  await assert.rejects(stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: '', ownerPolicy: 'exact' }), /needs an owner/);
});

test('a record replaced while the stop checks is never stopped on or removed: unmarked, malformed, or same times (BL-1257)', async () => {
  const replacements = {
    unmarked: (times) => JSON.stringify({ ...times }),
    malformed: () => '{ "launchedBy": ',
    'same-times': (times) => JSON.stringify({ launchedBy: OWNER, ...times, note: 'a newer call with the same times' })
  };
  for (const [name, replacementFor] of Object.entries(replacements)) {
    for (const ownerPolicy of ['legacy', 'exact']) {
      const stateDir = await freshStateDir(`replaced-${name}-${ownerPolicy}`);
      const recordPath = join(stateDir, SBX_DAEMON_RECORD_NAME);
      const times = windowAroundNow();
      const replacement = replacementFor(times);
      const fakeSbx = await oneOffSbx({ status: 'running', replace: { at: 'ls', content: replacement }, recordPath });
      const pid = await standInDaemon();
      await fakeSbx.setPid(pid);
      await recordFile(stateDir, { launchedBy: OWNER, ...times, sbxPath: fakeSbx.sbx });

      const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy });

      assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' }, `${name} ${ownerPolicy}`);
      assert.match(result.reason, /record changed while it was being checked/);
      assert.deepEqual(await fakeSbx.calls(), ['daemon status --json', 'ls --json'], `${name} ${ownerPolicy}: no stop on a replaced record`);
      assert.equal(alive(pid), true);
      assert.equal(await readFile(recordPath, 'utf8'), replacement, `${name} ${ownerPolicy}: the replacement survives`);
    }
  }
});

test('a record rewritten in place (the same file, new bytes) while the stop checks is never acted on (BL-1257)', async () => {
  const stateDir = await freshStateDir('rewritten-in-place');
  const recordPath = join(stateDir, SBX_DAEMON_RECORD_NAME);
  const times = windowAroundNow();
  const replacement = JSON.stringify({ launchedBy: OWNER, ...times, note: 'rewritten in place' });
  const fakeSbx = await oneOffSbx({ status: 'running', replace: { at: 'ls', content: replacement, inPlace: true }, recordPath });
  const pid = await standInDaemon();
  await fakeSbx.setPid(pid);
  await recordFile(stateDir, { launchedBy: OWNER, ...times, sbxPath: fakeSbx.sbx });
  const inode = (await stat(recordPath)).ino;

  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });

  assert.equal((await stat(recordPath)).ino, inode, 'the fixture kept the same file');
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.deepEqual(await fakeSbx.calls(), ['daemon status --json', 'ls --json']);
  assert.equal(alive(pid), true);
  assert.equal(await readFile(recordPath, 'utf8'), replacement);
});

test('a record replaced while sbx reports the daemon stopped is not removed; one left alone is (BL-1257)', async () => {
  const old = { launchedBy: OWNER, callStartedAt: new Date(Date.now() - 60_000).toISOString(), callEndedAt: new Date(Date.now() - 59_000).toISOString() };
  let stateDir = await freshStateDir('drop-replaced');
  let recordPath = join(stateDir, SBX_DAEMON_RECORD_NAME);
  const replacement = JSON.stringify({ launchedBy: OWNER, ...windowAroundNow(), note: 'newer' });
  let fakeSbx = await oneOffSbx({ status: 'stopped', replace: { at: 'status', content: replacement }, recordPath });
  await recordFile(stateDir, { ...old, sbxPath: fakeSbx.sbx });
  let result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.equal(await readFile(recordPath, 'utf8'), replacement, 'the newer record survives');

  stateDir = await freshStateDir('drop-plain');
  fakeSbx = await oneOffSbx({ status: 'stopped' });
  await recordFile(stateDir, { ...old, sbxPath: fakeSbx.sbx });
  result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  assert.deepEqual(pick(result), { action: 'drop-record', verdict: 'gone' });
  assert.deepEqual(await readdir(stateDir), []);
});

// ---- The record lock: one generation from decision to effect (BL-1257) -------------------------------
//
// The voice launch records' own lock (`withLocalRuntimeRecordLock`), held here by the test the way a
// cooperating writer or another stopper holds it.

const LOCK_NAME = '.batshit-local-runtime-launch.lock';

function holdLock(stateDir, ms, during = async () => {}) {
  let held;
  const acquired = new Promise((done) => (held = done));
  const released = withLocalRuntimeRecordLock(stateDir, async () => {
    held();
    await during();
    await new Promise((done) => setTimeout(done, ms));
  });
  return { acquired, released };
}

async function ownedRecordWithStandIn(name, extra = {}) {
  const stateDir = await freshStateDir(name);
  const fakeSbx = await oneOffSbx({ status: 'running', ...extra });
  const times = windowAroundNow();
  const pid = await standInDaemon();
  await fakeSbx.setPid(pid);
  const path = await recordFile(stateDir, { launchedBy: OWNER, ...times, sbxPath: fakeSbx.sbx });
  return { stateDir, fakeSbx, pid, path, times };
}

test('a record lock held past the wait keeps everything, asks no sbx, and leaves the lock to its owner', async () => {
  const { stateDir, fakeSbx, pid, path } = await ownedRecordWithStandIn('lock-busy');
  const before = await readFile(path, 'utf8');
  const holder = holdLock(stateDir, 1_200);
  await holder.acquired;
  const startedAt = Date.now();
  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact', lockWaitMs: 300 });
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /its record could not be locked \(timed out/);
  assert.ok(Date.now() - startedAt < 1_000, 'it waited only its own bound');
  assert.deepEqual(await fakeSbx.calls(), [], 'nothing is probed or stopped without the lock');
  assert.equal(alive(pid), true);
  assert.equal(await readFile(path, 'utf8'), before);
  await holder.released;
  assert.deepEqual(await readdir(stateDir), [SBX_DAEMON_RECORD_NAME], 'no lock left behind');
});

test('a lock with no valid owner is never taken over: the stop keeps everything and says why', async () => {
  const { stateDir, fakeSbx, path } = await ownedRecordWithStandIn('lock-ownerless');
  const lockPath = join(stateDir, LOCK_NAME);
  await writeFile(lockPath, 'not an owner');
  const old = new Date(Date.now() - 60_000);
  const { utimes } = await import('node:fs/promises');
  await utimes(lockPath, old, old);
  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact', lockWaitMs: 300 });
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /no valid owner; refusing unsafe takeover/);
  assert.equal(await readFile(lockPath, 'utf8'), 'not an owner', 'the lock is left as it was');
  assert.deepEqual(await fakeSbx.calls(), []);
  assert.ok(await readFile(path, 'utf8'));
});

test('a record a cooperating writer changes while the stop waits for the lock is read again, never acted on as it was', async () => {
  // Replaced by an unmarked record: under the exact policy it is not this owner's any more.
  let { stateDir, fakeSbx, pid } = await ownedRecordWithStandIn('lock-replaced');
  const unmarked = JSON.stringify({ ...windowAroundNow() });
  let holder = holdLock(stateDir, 200, async () => {
    await writeFile(join(stateDir, `${SBX_DAEMON_RECORD_NAME}.tmp`), unmarked);
    await rename(join(stateDir, `${SBX_DAEMON_RECORD_NAME}.tmp`), join(stateDir, SBX_DAEMON_RECORD_NAME));
  });
  await holder.acquired;
  let result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  await holder.released;
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'not-ours' });
  assert.deepEqual(await fakeSbx.calls(), []);
  assert.equal(alive(pid), true);
  assert.equal(await readFile(join(stateDir, SBX_DAEMON_RECORD_NAME), 'utf8'), unmarked);

  // Removed while the stop waited: there is nothing left to act on.
  ({ stateDir, fakeSbx, pid } = await ownedRecordWithStandIn('lock-removed'));
  holder = holdLock(stateDir, 200, async () => rm(join(stateDir, SBX_DAEMON_RECORD_NAME)));
  await holder.acquired;
  result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  await holder.released;
  assert.deepEqual(pick(result), { action: 'none', verdict: 'absent' });
  assert.deepEqual(await fakeSbx.calls(), []);
  assert.equal(alive(pid), true);
});

test('a writer waits for a stop\'s lock, then writes its record whole', async () => {
  const stateDir = await freshStateDir('writer-waits');
  const holder = holdLock(stateDir, 400);
  await holder.acquired;
  const startedAt = Date.now();
  await writeSbxDaemonRecord(stateDir, { launchedBy: OWNER, callStartedAt: Date.now(), callEndedAt: Date.now(), sbxPath: SBX });
  assert.ok(Date.now() - startedAt >= 300, `wrote after ${Date.now() - startedAt} ms, inside the lock`);
  await holder.released;
  assert.equal((await readSbxDaemonRecord(stateDir)).launchedBy, OWNER);
  assert.deepEqual(await readdir(stateDir), [SBX_DAEMON_RECORD_NAME]);
});

test('a lock wait that leaves too little time for a safe stop keeps everything before any effect, inside the budget', async () => {
  const { stateDir, fakeSbx, pid, path } = await ownedRecordWithStandIn('out-of-time');
  const before = await readFile(path, 'utf8');
  // Budget: 2 x 1 s calls + the 3 s ps bound + 1 s stop + 0.5 s wait = 6.5 s. The lock is free at
  // about 4.4 s, which leaves less than the stop, the wait, and one call (2.5 s).
  const holder = holdLock(stateDir, 4_400);
  await holder.acquired;
  const startedAt = Date.now();
  const result = await stopSbxDaemonIfBatshitStartedIt({
    stateDir,
    owner: OWNER,
    ownerPolicy: 'exact',
    callTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    goneTimeoutMs: 500,
    lockWaitMs: 4_800
  });
  const took = Date.now() - startedAt;
  await holder.released;
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /too little of the stop's time was left/);
  assert.deepEqual(await fakeSbx.calls(), ['daemon status --json'], 'no list, no stop');
  assert.ok(took < 6_500, `took ${took} ms, inside the stop's one budget`);
  assert.equal(alive(pid), true);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('a record replaced while `daemon stop` runs is never removed, though the daemon went (BL-1257)', async () => {
  const stateDir = await freshStateDir('replaced-during-stop');
  const recordPath = join(stateDir, SBX_DAEMON_RECORD_NAME);
  const times = windowAroundNow();
  const replacement = JSON.stringify({ launchedBy: OWNER, ...times, note: 'written while the daemon stopped' });
  const fakeSbx = await oneOffSbx({ status: 'running', replace: { at: 'stop', content: replacement }, recordPath, stopKills: true });
  const pid = await standInDaemon();
  await fakeSbx.setPid(pid);
  await recordFile(stateDir, { launchedBy: OWNER, ...times, sbxPath: fakeSbx.sbx });

  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });

  assert.deepEqual(await fakeSbx.calls(), ['daemon status --json', 'ls --json', 'daemon stop']);
  assert.equal(alive(pid), false, 'the daemon was stopped');
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /it was stopped, but its record changed before it could be removed/);
  assert.equal(await readFile(recordPath, 'utf8'), replacement, 'the newer record survives');
});

test('a failure inside the locked check is reported as such, not as a lock it could not take', async () => {
  const stateDir = await freshStateDir('settle-throws');
  const fakeSbx = await oneOffSbx({ status: 'running' });
  await recordFile(stateDir, { launchedBy: 'native:1:1', ...windowAroundNow(), sbxPath: fakeSbx.sbx });
  let asked = 0;
  // Legacy policy: a gone native run's record is this Batshit's. The second ask (under the lock) fails.
  const ownerIsGone = () => {
    asked += 1;
    if (asked > 1) throw new Error('the owner check failed');
    return true;
  };
  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER, ownerIsGone });
  assert.equal(asked, 2);
  assert.deepEqual(pick(result), { action: 'keep', verdict: 'unknown' });
  assert.equal(result.reason, 'it could not be settled (the owner check failed)');
  assert.deepEqual(await readdir(stateDir), [SBX_DAEMON_RECORD_NAME], 'the record stays, and the lock was released');
});
