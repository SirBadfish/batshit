// Docker's sbx daemon at shutdown (2026-09-21, BL-61): the decision, and the stop against a REAL
// detached daemon process played by a fake `sbx` that keeps the rules measured against sbx v0.43.0
// (`test-fixtures/fake-sbx-daemon.mjs`): `ls --json` starts the daemon when it is not running and
// says `Starting sandboxd daemon...` first; `daemon status --json` names its socket, with its pid
// file beside it; `daemon stop` stops it.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  SBX_DAEMON_RECORD_NAME,
  busySbxSandboxes,
  daemonStartedByRecordedCall,
  decideSbxDaemonStop,
  findSbxOnPath,
  readSbxDaemonRecord,
  resolveSbxDaemonStateDir,
  sbxCallStartedDaemon,
  stopSbxDaemonIfBatshitStartedIt,
  writeSbxDaemonRecord
} from './sbx-daemon-stop.mjs';
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
});

test('the decision: nothing without a record, never another Batshit\'s, never a daemon it did not start', () => {
  const record = { launchedBy: OWNER, callStartedAt: '2026-09-21T13:02:19.600Z', callEndedAt: '2026-09-21T13:02:20.950Z' };
  const ours = { running: true, pid: 31815, startedAtMs: Date.parse('2026-09-21T13:02:20.000Z') };
  const later = { ...ours, startedAtMs: Date.parse('2026-09-21T15:00:00.000Z') };

  assert.deepEqual(decideSbxDaemonStop({ record: null, daemon: ours, owner: OWNER }), { action: 'none' });
  assert.equal(decideSbxDaemonStop({ record: { invalid: true }, daemon: ours, owner: OWNER }).action, 'drop-record');
  assert.deepEqual(decideSbxDaemonStop({ record, daemon: ours, owner: OWNER }), { action: 'check-sandboxes', daemon: ours });
  // Restarted since (by the user, or after a crash): not the one Batshit started.
  assert.equal(decideSbxDaemonStop({ record, daemon: later, owner: OWNER }).action, 'drop-record');
  assert.equal(decideSbxDaemonStop({ record, daemon: { running: false }, owner: OWNER }).action, 'drop-record');

  const native = { ...record, launchedBy: 'native:4242:1758459739000' };
  assert.equal(decideSbxDaemonStop({ record: native, daemon: ours, owner: OWNER }).action, 'keep');
  assert.equal(
    decideSbxDaemonStop({ record: native, daemon: ours, owner: OWNER, ownerIsGone: () => true }).action,
    'check-sandboxes'
  );
  // An unmarked record (a Batshit started without a launcher) is anyone's to stop.
  const { launchedBy: _unused, ...unmarked } = record;
  assert.equal(decideSbxDaemonStop({ record: unmarked, daemon: ours, owner: OWNER }).action, 'check-sandboxes');
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

  assert.deepEqual(result, { action: 'stopped', ok: true, pid });
  assert.equal(alive(pid), false);
  assert.deepEqual(await readdir(stateDir), []);
});

test('a daemon the user started is never stopped: there is no record', async () => {
  await stopDaemonIfRunning();
  const users = await startUsersDaemon();
  const stateDir = await freshStateDir('users');

  const result = await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.deepEqual(result, { action: 'none' });
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
    assert.deepEqual(await stopSbxDaemonIfBatshitStartedIt({ stateDir, owner: OWNER }), { action: 'stopped', ok: true, pid });
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
