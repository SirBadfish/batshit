// The Mac supervisor's Apple Container system step (2026-09-22, BL-62 part 2), through the fake
// `container` (`test-fixtures/fake-apple-container.mjs`). The decision has its own tests
// (`apple-container-system-stop.test.mjs`); this file proves the supervisor acts on it with its own
// owner and record folder, logs what it did, and records a start its Start button made.
// Its own file because the supervisor fixes its log/data folders when it is imported, and a test
// must never write into Josh's real `~/Library/Logs/Batshit/supervisor.log` or `~/.batshit`.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sandbox = await mkdtemp(join(tmpdir(), 'batshit-supervisor-apple-container-stop-'));
process.env.BATSHIT_MAC_LOG_DIR = join(sandbox, 'logs');
process.env.BATSHIT_MAC_DATA_DIR = join(sandbox, 'data');
process.env.BATSHIT_MAC_CACHE_DIR = join(sandbox, 'cache');
// The recorder's fallback folder, so nothing here can reach the real ~/.batshit.
process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = join(sandbox, 'default-state');

const { batshitAppIsDown, startAppleContainer, stopAppleContainerSystemStartedByThisApp, stopService } = await import(
  './mac-runtime-supervisor.mjs'
);
const { readAppleContainerSystemRecord, writeAppleContainerSystemRecord } = await import('./apple-container-system-stop.mjs');
const { installFakeAppleContainer } = await import('./test-fixtures/fake-apple-container.mjs');

const fake = await installFakeAppleContainer(sandbox);
Object.assign(process.env, fake.env);
// The fake first on PATH, ahead of the folder that holds Apple's real CLI.
process.env.PATH = `${fake.binDir}${delimiter}${process.env.PATH ?? ''}`;
const THIS_APP = `mac-app:${join(sandbox, 'data')}`;

test.after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function stateFolder(name) {
  const dir = join(sandbox, 'state', name);
  await mkdir(dir, { recursive: true });
  return { dir, env: { get: (key) => (key === 'BATSHIT_APPLE_CONTAINER_STATE_DIR' ? dir : undefined) } };
}

async function startAs(dir, launchedBy) {
  const callStartedAt = Date.now();
  await execFileAsync(fake.container, ['system', 'start']);
  await writeAppleContainerSystemRecord(dir, { launchedBy, callStartedAt, callEndedAt: Date.now(), containerPath: fake.container });
}

async function supervisorLog() {
  return readFile(join(sandbox, 'logs', 'supervisor.log'), 'utf8').catch(() => '');
}

test('quitting the app stops the system its own call started, and says so in its log', async () => {
  await fake.reset();
  const { dir, env } = await stateFolder('ours');
  await startAs(dir, THIS_APP);

  const result = await stopAppleContainerSystemStartedByThisApp(env);

  assert.deepEqual(result, { action: 'stopped', ok: true, verdict: 'stopped' });
  assert.equal(await fake.registered(), false);
  assert.deepEqual(await readdir(dir), []);
  assert.match(await supervisorLog(), /Stopped Apple's container system, which this Batshit started\./);
});

// BL-149: a quit in the middle of a chat run left that run's sandbox running, and so the system.
// Batshit App's stop answered that it stopped the app (`stopService`).
const APP_STOPPED = { skipped: false, ok: true, pid: 4242, escalated: false };
const ownSandbox = (id, owner) => ({
  status: 'running',
  configuration: { id, labels: { 'batshit.owner': createHash('sha256').update(owner).digest('hex').slice(0, 16) } },
  startedDate: 1
});

test('quitting the app removes the sandboxes it left running, then stops its system, and says both', async () => {
  await fake.reset();
  const { dir, env } = await stateFolder('sweep');
  await startAs(dir, THIS_APP);
  const chat = 'batshit-apple-sandbox-josh-s1a2b3c4d-0f1e2d3c4b';
  await fake.setContainers([ownSandbox(chat, THIS_APP)]);

  const result = await stopAppleContainerSystemStartedByThisApp(env, { appStop: APP_STOPPED });

  assert.deepEqual(result, { action: 'stopped', ok: true, verdict: 'stopped', sandboxes: { removed: [chat] } });
  assert.deepEqual(await fake.deletedContainers(), [chat]);
  const log = await supervisorLog();
  assert.match(log, new RegExp(`Removed the Apple Container sandboxes this Batshit left running: ${chat}\\.`));
  assert.match(log, /Stopped Apple's container system, which this Batshit started\./);
  assert.ok(log.indexOf('Removed the Apple Container sandboxes') < log.lastIndexOf("Stopped Apple's container system"));
});

test('a sandbox the app could not remove fails its quit step, and the log names it', async () => {
  await fake.reset();
  const { dir, env } = await stateFolder('sweep-fails');
  await startAs(dir, THIS_APP);
  const chat = 'batshit-apple-sandbox-josh-s5e6f7a8b-0f1e2d3c4b';
  await fake.setContainers([ownSandbox(chat, THIS_APP)]);
  await fake.setDeleteFails(true);
  try {
    const result = await stopAppleContainerSystemStartedByThisApp(env, { appStop: APP_STOPPED });

    assert.equal(result.ok, false);
    assert.equal(await fake.registered(), true);
    assert.match(
      await supervisorLog(),
      new RegExp(`Could not remove the Apple Container sandboxes this Batshit left running \\(${chat}\\): .*failed to delete`)
    );
  } finally {
    await fake.setDeleteFails(false);
  }
});

// Review finding 1: the Apple step runs whatever the app's stop answered. An app with no pid file, one
// whose pid no longer matches its launch record, or one that survived SIGKILL may still be running a
// command in its sandbox, so its sandboxes are left alone and keep the system, as before BL-149.
test('the app is down only when its stop stopped it or found it not running', () => {
  assert.equal(batshitAppIsDown({ skipped: false, ok: true, pid: 4242, escalated: false }), true);
  assert.equal(batshitAppIsDown({ skipped: true, notRunning: true, reason: 'Batshit App was not running.' }), true);
  assert.equal(batshitAppIsDown({ skipped: true, reason: 'Batshit App has no pid file.' }), false);
  assert.equal(batshitAppIsDown({ skipped: true, reason: 'Batshit App pid 4242 no longer matches its launch metadata (likely pid reuse); refused to kill it.', pid: 4242 }), false);
  assert.equal(batshitAppIsDown({ skipped: false, ok: false, pid: 4242, error: 'Batshit App process group did not stop.' }), false);
  // A stop step that threw (`containedStopStep`).
  assert.equal(batshitAppIsDown({ ok: false, error: 'boom' }), false);
  assert.equal(batshitAppIsDown(null), false);
});

test('the app stop says so when the app was not running, and not when it has no pid file', async () => {
  const dir = join(sandbox, 'service');
  await mkdir(dir, { recursive: true });
  const definition = { label: 'Batshit App', pidFile: join(dir, 'app.pid'), metaFile: join(dir, 'app.meta.json') };
  assert.equal((await stopService(definition)).notRunning, undefined);

  const gone = (await execFileAsync('/bin/sh', ['-c', 'echo $$'])).stdout.trim();
  await writeFile(definition.pidFile, `${gone}\n`);
  const result = await stopService(definition);
  assert.equal(result.skipped, true);
  assert.equal(result.notRunning, true);
  assert.equal(batshitAppIsDown(result), true);
});

test('with the app not known to be down, its sandbox is left alone, keeps the system, and the log gives the reason', async () => {
  await fake.reset();
  const { dir, env } = await stateFolder('sweep-app-alive');
  await startAs(dir, THIS_APP);
  const chat = 'batshit-apple-sandbox-josh-s9d8c7b6a-0f1e2d3c4b';
  await fake.setContainers([ownSandbox(chat, THIS_APP)]);

  const result = await stopAppleContainerSystemStartedByThisApp(env, {
    appStop: { skipped: true, reason: 'Batshit App has no pid file.' }
  });

  assert.deepEqual(result, { action: 'keep', verdict: 'kept', reason: `a container is still running (${chat})` });
  assert.deepEqual(await fake.deletedContainers(), []);
  assert.equal(await fake.registered(), true);
  // Review follow-up: the words are the app stop's own, not "did not stop cleanly" for every case.
  const log = await supervisorLog();
  assert.match(log, /Left this Batshit's Apple Container sandboxes for their chats' next turn: Batshit App has no pid file\./);
  assert.doesNotMatch(log, /did not stop cleanly/);

  await stopAppleContainerSystemStartedByThisApp(env, {
    appStop: { skipped: false, ok: false, pid: 4242, error: 'Batshit App process group did not stop.' }
  });
  assert.match(await supervisorLog(), /Left this Batshit's Apple Container sandboxes for their chats' next turn: Batshit App process group did not stop\./);
  // A stop step that answered nothing at all.
  await stopAppleContainerSystemStartedByThisApp(env);
  assert.match(await supervisorLog(), /Left this Batshit's Apple Container sandboxes for their chats' next turn: Batshit App's stop gave no answer\./);
  assert.deepEqual(await fake.deletedContainers(), []);
});

test('the app leaves a system a running native lane started, and its record', async () => {
  await fake.reset();
  const { dir, env } = await stateFolder('native-live');
  // This test process stands in for a native launcher that is still running.
  await startAs(dir, `native:${process.pid}:1758459739000`);

  const result = await stopAppleContainerSystemStartedByThisApp(env);

  assert.equal(result.action, 'keep');
  assert.equal(await fake.registered(), true);
  assert.notEqual(await readAppleContainerSystemRecord(dir), null);
  assert.match(await supervisorLog(), /Left Apple's container system running: another Batshit/);
});

test('the app stops a system whose native lane is gone', async () => {
  await fake.reset();
  const { dir, env } = await stateFolder('native-gone');
  const gone = (await execFileAsync('/bin/sh', ['-c', 'echo $$'])).stdout.trim();
  await startAs(dir, `native:${gone}:1758459739000`);

  assert.equal((await stopAppleContainerSystemStartedByThisApp(env)).action, 'stopped');
  assert.equal(await fake.registered(), false);
});

test('Runtime Doctor\'s Start records this app\'s start where the quit reads it', async () => {
  // The real recorder, with a start played in memory: the record only has to name this app and
  // the call. Nothing here runs the stop on it (its `container` is the real CLI's path).
  // Apple's own stopped answer (healthy, not running), then running.
  const states = [
    { supported: true, healthy: true, systemRunning: false },
    { supported: true, healthy: true, systemRunning: true }
  ];
  const commands = [];
  const result = await startAppleContainer({
    readStatus: async () => states.shift(),
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      return { ok: true, stdout: '', stderr: '' };
    }
  });

  assert.equal(result.ok, true);
  // BL-129: Apple's start never gets to ask for a kernel on stdin, which Batshit cannot answer.
  assert.deepEqual(commands, [['container', 'system', 'start', '--disable-kernel-install']]);
  const record = await readAppleContainerSystemRecord(join(sandbox, 'default-state'));
  assert.equal(record.launchedBy, THIS_APP);
  assert.ok(Date.parse(record.callStartedAt) <= Date.parse(record.callEndedAt));
  assert.ok(Date.now() - Date.parse(record.callEndedAt) < 60_000);
  assert.ok(isAbsolute(record.containerPath) && record.containerPath.endsWith('/container'));
  await rm(join(sandbox, 'default-state'), { recursive: true, force: true });
});

// BL-129: a start that still asked for a kernel (0.12.3 without the flag: "failed to read user
// input", after the apiserver is registered) is not a success, though the system then runs. Runtime
// Doctor names the one command, the same words the app uses.
test('Runtime Doctor\'s Start names the kernel command when Apple Container has no kernel', async () => {
  const states = [
    { supported: true, healthy: true, systemRunning: false },
    { supported: true, healthy: true, systemRunning: true }
  ];
  const recorded = [];
  const result = await startAppleContainer({
    readStatus: async () => states.shift(),
    runCommand: async () => ({
      ok: false,
      code: 1,
      stdout: 'Verifying apiserver is running...\nNo default kernel configured.\n',
      stderr: 'Error: internalError: "failed to read user input"'
    }),
    recordStart: async (window) => recorded.push(window)
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Apple Container has no Linux kernel yet[\s\S]*`container system kernel set --recommended`[\s\S]*about 600 MB[\s\S]*#apple-container-has-no-linux-kernel-yet/);
  // Its call started the system, so the quit still stops it.
  assert.equal(recorded.length, 1);
  // The app's words and the supervisor's are one sentence.
  const appSource = await readFile(new URL('../../batshit-app/src/lib/server/services/appleContainerSandbox.ts', import.meta.url), 'utf8');
  assert.ok(appSource.includes(result.error));
});
