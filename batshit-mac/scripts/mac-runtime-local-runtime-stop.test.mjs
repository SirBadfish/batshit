// The Mac supervisor's "Stop with Batshit" pass, against REAL detached processes.
//
// The decision rules have their own unit tests (`local-voice-runtime-stop.test.mjs`); this file
// proves the supervisor acts on them: one decision per process, whichever records name it.
// Its own file because the supervisor fixes its log/data folders when it is imported, and a
// test must never write into Josh's real `~/Library/Logs/Batshit/supervisor.log`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sandbox = await mkdtemp(join(tmpdir(), 'batshit-supervisor-local-runtime-stop-'));
process.env.BATSHIT_MAC_LOG_DIR = join(sandbox, 'logs');
process.env.BATSHIT_MAC_DATA_DIR = join(sandbox, 'data');
process.env.BATSHIT_MAC_CACHE_DIR = join(sandbox, 'cache');
const stateRoot = join(sandbox, 'voice-engines');
const env = { get: (name) => (name === 'BATSHIT_VOICE_RUNTIME_STATE_ROOT' ? stateRoot : undefined) };

const { stopManagedLocalRuntimes, stopSbxDaemonStartedByThisApp } = await import('./mac-runtime-supervisor.mjs');
const { writeSbxDaemonRecord } = await import('./sbx-daemon-stop.mjs');
const { installFakeSbxDaemon } = await import('./test-fixtures/fake-sbx-daemon.mjs');

const started = [];
test.after(async () => {
  for (const pid of started) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {}
    }
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

// A detached "engine" whose command line carries its install path, like a real one.
async function startEngineProcess(name) {
  const installRoot = join(sandbox, 'installs', name);
  await mkdir(installRoot, { recursive: true });
  const script = join(installRoot, 'fake-engine.mjs');
  await writeFile(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { cwd: installRoot, detached: true, stdio: 'ignore' });
  child.unref();
  started.push(child.pid);
  return { pid: child.pid, command: process.execPath, args: [script], cwd: installRoot };
}

async function writeRecord(engineId, fileName, record) {
  await mkdir(join(stateRoot, engineId), { recursive: true });
  await writeFile(
    join(stateRoot, engineId, fileName),
    JSON.stringify({ engineId, launchedAt: new Date().toISOString(), ...record })
  );
}

async function recordNames(engineId) {
  return (await readdir(join(stateRoot, engineId)).catch(() => [])).sort();
}

async function waitGone(pid) {
  for (let tries = 0; tries < 50 && alive(pid); tries += 1) {
    await new Promise((done) => setTimeout(done, 100));
  }
  return !alive(pid);
}

const PRIMARY = '.batshit-local-runtime-launch.json';

test('a runtime several engines share runs on while one of them says keep running', async () => {
  const mlx = await startEngineProcess('shared-mlx');
  await writeRecord('chatterbox-turbo', PRIMARY, { ...mlx, stopOnShutdown: true });
  await writeRecord('kokoro', PRIMARY, { ...mlx, startedBy: 'chatterbox-turbo', stopOnShutdown: false });

  const kept = await stopManagedLocalRuntimes(env);

  assert.equal(alive(mlx.pid), true);
  assert.deepEqual(await recordNames('chatterbox-turbo'), [PRIMARY]);
  assert.deepEqual(await recordNames('kokoro'), [PRIMARY]);
  assert.match(
    kept.find((entry) => entry.engineId === 'chatterbox-turbo').reason,
    /Stop with Batshit is off for "kokoro"/
  );

  // Once every engine that uses it says stop, it stops, and every record naming it goes.
  await writeRecord('kokoro', PRIMARY, { ...mlx, startedBy: 'chatterbox-turbo', stopOnShutdown: true });
  const stopped = await stopManagedLocalRuntimes(env);

  assert.equal(await waitGone(mlx.pid), true);
  assert.deepEqual(await recordNames('chatterbox-turbo'), []);
  assert.deepEqual(await recordNames('kokoro'), []);
  assert.deepEqual(
    stopped.map((entry) => [entry.engineId, entry.ok]).sort(),
    [
      ['chatterbox-turbo', true],
      ['kokoro', true]
    ]
  );
  const log = await readFile(join(sandbox, 'logs', 'supervisor.log'), 'utf8');
  assert.match(log, /Stopped Local runtime "chatterbox-turbo" \(shared with "kokoro"\)/);
});

test('a launch moved aside for a newer one is still stopped on quit', async () => {
  // The 2026-09-16 orphan, replayed: two launches of one engine id on two ports, both running.
  const first = await startEngineProcess('chatterbox-8012');
  const second = await startEngineProcess('chatterbox-8010');
  await writeRecord('chatterbox-turbo', `.batshit-local-runtime-launch.${first.pid}.json`, first);
  await writeRecord('chatterbox-turbo', PRIMARY, second);

  await stopManagedLocalRuntimes(env);

  assert.equal(await waitGone(first.pid), true);
  assert.equal(await waitGone(second.pid), true);
  assert.deepEqual(await recordNames('chatterbox-turbo'), []);
});

test('a record whose pid now belongs to something else is refused, and nothing is killed', async () => {
  // A reused pid, as it really happens: the record was written a minute ago for a launch that has
  // since ended, and a newer process took its pid. Even a command line that matches the record
  // cannot make it the recorded launch, because it started after that record was written.
  const stranger = await startEngineProcess('stranger');
  await writeRecord('whisper-cpp', PRIMARY, {
    ...stranger,
    launchedAt: new Date(Date.now() - 60_000).toISOString()
  });

  const results = await stopManagedLocalRuntimes(env);

  assert.equal(alive(stranger.pid), true);
  assert.match(
    results.find((entry) => entry.engineId === 'whisper-cpp').reason,
    /started after its launch \(a reused pid\); refused to kill it/
  );
  assert.deepEqual(await recordNames('whisper-cpp'), []);
});

test('a record with no launch time still needs its command line to match', async () => {
  // With no `launchedAt` the start time cannot speak, so the command match decides, as before.
  const stranger = await startEngineProcess('stranger-no-launch-time');
  await writeRecord('whisper-cpp-2', PRIMARY, {
    pid: stranger.pid,
    command: '/Users/x/.batshit/installs/whisper-cpp/bin/whisper-server',
    args: ['--port', '8077'],
    cwd: '/Users/x/.batshit/installs/whisper-cpp',
    launchedAt: undefined
  });

  const results = await stopManagedLocalRuntimes(env);

  assert.equal(alive(stranger.pid), true);
  assert.match(results.find((entry) => entry.engineId === 'whisper-cpp-2').reason, /no longer matches its launch record/);
  assert.deepEqual(await recordNames('whisper-cpp-2'), []);
});

test('an engine whose interpreter re-executes itself under another path is still stopped (BL-60)', async () => {
  // The python.org framework Python: the venv's `bin/python` re-executes itself as
  // `…/Python.app/Contents/MacOS/Python`, so the live command line holds neither the recorded
  // command nor the install folder. Replayed with a launcher script that `exec`s node from a path
  // outside the install: every quit used to refuse this engine and drop its record for good.
  const installRoot = join(sandbox, 'installs', 'dots-tts-mf');
  await mkdir(join(installRoot, '.venv', 'bin'), { recursive: true });
  const launcher = join(installRoot, '.venv', 'bin', 'python');
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" -e "setInterval(() => {}, 1000)" -- uvicorn server:app --port 8122\n`, {
    mode: 0o755
  });
  const child = spawn(launcher, ['-m', 'uvicorn', 'server:app', '--port', '8122'], {
    cwd: installRoot,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  started.push(child.pid);
  await new Promise((done) => setTimeout(done, 300));
  await writeRecord('dots-tts-mf', PRIMARY, {
    pid: child.pid,
    command: launcher,
    args: ['-m', 'uvicorn', 'server:app', '--port', '8122'],
    cwd: installRoot
  });

  const results = await stopManagedLocalRuntimes(env);

  assert.equal(await waitGone(child.pid), true);
  assert.equal(results.find((entry) => entry.engineId === 'dots-tts-mf').ok, true);
  assert.deepEqual(await recordNames('dots-tts-mf'), []);
});

test('engines stop side by side, so a quit waits for the slowest one, not the sum (BL-64)', async () => {
  // Each engine takes 1.5 s to exit after SIGTERM (the LiveKit sidecar takes about 1.9 s). One
  // after another, three held the quit for 4.5 s or more.
  const engines = [];
  for (const name of ['slow-a', 'slow-b', 'slow-c']) {
    const installRoot = join(sandbox, 'installs', name);
    await mkdir(installRoot, { recursive: true });
    const script = join(installRoot, 'slow-engine.mjs');
    await writeFile(script, "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500));\nsetInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [script], { cwd: installRoot, detached: true, stdio: 'ignore' });
    child.unref();
    started.push(child.pid);
    engines.push({ name, pid: child.pid, command: process.execPath, args: [script], cwd: installRoot });
  }
  await new Promise((done) => setTimeout(done, 300));
  for (const engine of engines) {
    const { name, ...process } = engine;
    await writeRecord(name, PRIMARY, process);
  }

  const startedAt = Date.now();
  const results = await stopManagedLocalRuntimes(env);
  const tookMs = Date.now() - startedAt;

  for (const engine of engines) {
    assert.equal(alive(engine.pid), false);
    assert.equal(results.find((entry) => entry.engineId === engine.name).ok, true);
  }
  assert.ok(tookMs < 3_500, `three 1.5 s stops took ${tookMs} ms`);
});

test('a record naming a live pid that leads no process group is dropped, and nothing is killed', async () => {
  // What a reused pid looks like: `ps` works, the pid is alive, and no process has it as its
  // group. The record must go (the old rule), or a later reuse by a group leader could match it.
  const installRoot = join(sandbox, 'installs', 'non-leader');
  await mkdir(installRoot, { recursive: true });
  const script = join(installRoot, 'fake-engine.mjs');
  await writeFile(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { cwd: installRoot, stdio: 'ignore' }); // not detached
  child.unref();
  started.push(child.pid);
  await new Promise((done) => setTimeout(done, 200));
  await writeRecord('reused', PRIMARY, { pid: child.pid, command: process.execPath, args: [script], cwd: installRoot });

  const results = await stopManagedLocalRuntimes(env);

  assert.equal(alive(child.pid), true);
  assert.match(results.find((entry) => entry.engineId === 'reused').reason, /refused to kill it/);
  assert.deepEqual(await recordNames('reused'), []);
  child.kill('SIGKILL');
});

test('quitting the packaged app stops its own launches and a gone native run\'s, never a running native lane\'s', async () => {
  const mine = await startEngineProcess('mine');
  const nativeAlive = await startEngineProcess('native-alive');
  const nativeGone = await startEngineProcess('native-gone');
  await writeRecord('mine', PRIMARY, { ...mine, launchedBy: `mac-app:${join(sandbox, 'data')}` });
  // A native lane still running (its launcher is this test process) launched this one.
  await writeRecord('native-alive', PRIMARY, { ...nativeAlive, launchedBy: `native:${process.pid}:1789700000000` });
  // A native lane whose launcher is gone (killed hard) launched this one: nobody else will stop it.
  await writeRecord('native-gone', PRIMARY, { ...nativeGone, launchedBy: 'native:999999999:1789700000000' });

  const results = await stopManagedLocalRuntimes(env);

  assert.equal(await waitGone(mine.pid), true);
  assert.equal(await waitGone(nativeGone.pid), true);
  assert.equal(alive(nativeAlive.pid), true);
  assert.deepEqual(await recordNames('native-alive'), [PRIMARY]);
  assert.match(results.find((entry) => entry.engineId === 'native-alive').reason, /another Batshit \(native:\d+:\d+\) launched it/);
});

test('one engine whose record cannot be changed never stops the rest of the quit', async () => {
  // The local-runtime stop runs inside the ordered stop beside other services, where a throw
  // would skip Redis's clean shutdown. A record folder that cannot be written is the trouble here.
  const first = await startEngineProcess('a-locked');
  const second = await startEngineProcess('b-normal');
  await writeRecord('a-locked', PRIMARY, first);
  await writeRecord('b-normal', PRIMARY, second);
  const { chmod } = await import('node:fs/promises');
  await chmod(join(stateRoot, 'a-locked'), 0o555);
  try {
    const results = await stopManagedLocalRuntimes(env);
    assert.equal(await waitGone(second.pid), true);
    assert.ok(results.some((entry) => entry.engineId === 'a-locked' && /could not be handled/.test(entry.error ?? '')));
  } finally {
    await chmod(join(stateRoot, 'a-locked'), 0o755);
  }
});

test('a launch record the quit cannot read is kept for the next quit, never removed, and the log says which (BL-1264)', async () => {
  await mkdir(join(stateRoot, 'garbled'), { recursive: true });
  await mkdir(join(stateRoot, 'blank'), { recursive: true });
  await writeFile(join(stateRoot, 'garbled', PRIMARY), '{ "pid": ');
  await writeFile(join(stateRoot, 'blank', PRIMARY), '');
  try {
    const results = await stopManagedLocalRuntimes(env);

    for (const engineId of ['garbled', 'blank']) {
      const result = results.find((entry) => entry.engineId === engineId);
      assert.equal(result.skipped, true, engineId);
      assert.notEqual(result.ok, false, `${engineId}: a kept record is not a failed quit`);
      assert.match(result.reason, /kept it for the next quit/);
      assert.deepEqual(await recordNames(engineId), [PRIMARY], `${engineId}: the record stays`);
    }
    const log = await readFile(join(sandbox, 'logs', 'supervisor.log'), 'utf8');
    assert.match(log, /Local runtime "garbled": the launch record .* is not valid JSON; kept it for the next quit\./);
    assert.match(log, /Local runtime "blank": the launch record .* is empty; kept it for the next quit\./);
  } finally {
    await rm(join(stateRoot, 'garbled'), { recursive: true, force: true });
    await rm(join(stateRoot, 'blank'), { recursive: true, force: true });
  }
});

test('while one launch record cannot be read, the quit stops no engine and removes no record (BL-1269)', async () => {
  // The unreadable record could be kokoro's "keep running" attach record for the same process.
  const engine = await startEngineProcess('held-engine');
  await writeRecord('chatterbox-held', PRIMARY, engine);
  await writeRecord('no-process', PRIMARY, { command: '/bin/nothing' });
  await mkdir(join(stateRoot, 'kokoro-held'), { recursive: true });
  await writeFile(join(stateRoot, 'kokoro-held', PRIMARY), '{ "pid": ');
  try {
    const results = await stopManagedLocalRuntimes(env);

    await new Promise((done) => setTimeout(done, 300));
    assert.equal(alive(engine.pid), true, 'a readable record beside an unreadable one is held, not stopped');
    const held = results.find((entry) => entry.engineId === 'chatterbox-held');
    assert.deepEqual([held.skipped, held.held, held.pid, held.ok], [true, true, engine.pid, undefined], 'held is not a failed quit');
    assert.deepEqual(await recordNames('chatterbox-held'), [PRIMARY]);
    assert.deepEqual(await recordNames('no-process'), [PRIMARY], 'no record is removed while one is held');
    assert.deepEqual(await recordNames('kokoro-held'), [PRIMARY]);
    const log = await readFile(join(sandbox, 'logs', 'supervisor.log'), 'utf8');
    assert.match(
      log,
      /Local runtimes: stopped no voice engine and removed no launch record: .*kokoro-held.* could not be read and may hold an engine's "keep running" choice\. Once the voice engines have stopped \(restarting the computer stops them\), repair or remove that file or folder\. Left as they are: .*Local runtime "chatterbox-held" \(pgid \d+\)/
    );

    // Repaired (here: removed once nothing it names runs), the next quit decides with every record.
    await rm(join(stateRoot, 'kokoro-held'), { recursive: true, force: true });
    await stopManagedLocalRuntimes(env);
    assert.equal(await waitGone(engine.pid), true);
    assert.deepEqual(await recordNames('chatterbox-held'), []);
    assert.deepEqual(await recordNames('no-process'), []);
  } finally {
    for (const engineId of ['chatterbox-held', 'no-process', 'kokoro-held']) {
      await rm(join(stateRoot, engineId), { recursive: true, force: true });
    }
  }
});

test('quitting stops Docker\'s sbx daemon when this app\'s own call started it, and says so (BL-61)', async () => {
  const fake = await installFakeSbxDaemon(join(sandbox, 'sbx'));
  Object.assign(process.env, fake.env);
  const sbxStateDir = join(sandbox, 'sbx-daemon');
  const sbxEnv = { get: (name) => (name === 'BATSHIT_SBX_DAEMON_STATE_DIR' ? sbxStateDir : undefined) };
  const { execFile } = await import('node:child_process');
  const run = (args) =>
    new Promise((done) => execFile(fake.sbx, args, (error, stdout, stderr) => done({ error, stdout, stderr })));

  // The app's status check starts the daemon, and records that as this app (the supervisor gives
  // the app `mac-app:<its data folder>` as BATSHIT_VOICE_RUNTIME_OWNER).
  const callStartedAt = Date.now();
  const listed = await run(['ls', '--json']);
  assert.match(listed.stderr, /Starting sandboxd daemon/);
  await writeSbxDaemonRecord(sbxStateDir, {
    launchedBy: `mac-app:${process.env.BATSHIT_MAC_DATA_DIR}`,
    callStartedAt,
    callEndedAt: Date.now(),
    sbxPath: fake.sbx
  });
  const pid = await fake.daemonPid();
  started.push(pid);
  assert.equal(alive(pid), true);

  const result = await stopSbxDaemonStartedByThisApp(sbxEnv);

  assert.deepEqual(result, { action: 'stopped', ok: true, verdict: 'stopped', pid });
  assert.equal(await waitGone(pid), true);
  assert.deepEqual(await readdir(sbxStateDir), []);
  const log = await readFile(join(sandbox, 'logs', 'supervisor.log'), 'utf8');
  assert.match(log, new RegExp(`Stopped Docker's sbx daemon \\(pid ${pid}\\), which this Batshit started\\.`));

  // A daemon it did not start (no record) is left alone.
  await run(['ls', '--json']);
  const users = await fake.daemonPid();
  started.push(users);
  assert.deepEqual(await stopSbxDaemonStartedByThisApp(sbxEnv), { action: 'none', verdict: 'absent' });
  assert.equal(alive(users), true);
});
