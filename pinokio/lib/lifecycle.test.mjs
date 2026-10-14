// The Start steps that touch processes (BL-343, BL-363), against REAL temporary processes and
// sockets: detached "engines" this file starts and always kills, and small fake Redis servers on
// ephemeral loopback ports. Nothing here reads or stops anything it did not start.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  askRedis,
  LANE_PORT_CHECKS,
  LANE_VOICE_RUNTIME_REGISTRY,
  logTail,
  parseRedisReply,
  describeEnginesBlockingDelete,
  decideLaneVoiceRuntimeGroupStop,
  enginesBlockingDelete,
  proveLanePortsIdle,
  settleBeforeDelete,
  settleBeforeStart,
  superviseRedis,
  REDIS_READY_LINE,
  redisProcessId,
  rotateLog,
  resolvePinokioEngineStopPolicy,
  stopLeftoverVoiceEngines,
  waitForOwnRedis
} from './lifecycle.mjs';
import { LANE_PORTS, laneDataPaths, laneVoiceRuntimeOwner, sharedLaneEnv } from './lane.mjs';
import {
  readLocalRuntimeProcessGroup,
  removeLocalRuntimeLaunchRecord
} from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs';

const sandbox = await mkdtemp(join(tmpdir(), 'bs-pinokio-lifecycle-'));
const paths = laneDataPaths(join(sandbox, 'pinokio'));
const OWNER = laneVoiceRuntimeOwner(paths);
const PRIMARY = '.batshit-local-runtime-launch.json';

// Children this file started that have not exited yet. Teardown kills only these: a child the
// code under test already stopped was reaped, and its pid may belong to someone else by then.
const running = new Set();
test.after(async () => {
  for (const pid of running) {
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

async function waitGone(pid) {
  for (let tries = 0; tries < 50 && alive(pid); tries += 1) {
    await new Promise((done) => setTimeout(done, 100));
  }
  return !alive(pid);
}

// A detached "engine", leading its own process group like a real one, its install path in argv.
async function startEngineProcess(name) {
  const installRoot = join(sandbox, 'installs', name);
  await mkdir(installRoot, { recursive: true });
  const script = join(installRoot, 'fake-engine.mjs');
  await writeFile(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { cwd: installRoot, detached: true, stdio: 'ignore' });
  child.unref();
  running.add(child.pid);
  child.once('exit', () => running.delete(child.pid));
  return { pid: child.pid, command: process.execPath, args: [script], cwd: installRoot };
}

// Written after the spawn, as the app writes it: a record older than its process reads as a
// reused pid.
async function writeRecord(engineId, record, fileName = PRIMARY) {
  await mkdir(join(paths.voiceEngines, engineId), { recursive: true });
  await writeFile(
    join(paths.voiceEngines, engineId, fileName),
    JSON.stringify({ engineId, launchedAt: new Date().toISOString(), ...record })
  );
}

async function recordNames(engineId) {
  return (await readdir(join(paths.voiceEngines, engineId)).catch(() => []))
    .filter((name) => name.startsWith('.batshit-local-runtime-launch') && name.endsWith('.json'))
    .sort();
}

function collector() {
  const lines = [];
  return { lines, say: (line) => lines.push(line) };
}

async function settle(options = {}) {
  const { lines, say } = collector();
  const results = await stopLeftoverVoiceEngines({ stateRoot: paths.voiceEngines, owner: OWNER, say, ...options });
  const resultFor = (pid) => results.find((entry) => entry.pid === pid)?.result;
  return { lines, results, resultFor };
}

// ---- The lane's ports ---------------------------------------------------------------------

test('every lane port is checked, the database last', () => {
  assert.deepEqual(
    LANE_PORT_CHECKS.map(([, port]) => port),
    [LANE_PORTS.server, LANE_PORTS.app, LANE_PORTS.redis]
  );
});

test('a leftover database is never stopped while the lane\'s app or file server still runs', async () => {
  for (const held of [LANE_PORTS.app, LANE_PORTS.server]) {
    let stops = 0;
    await assert.rejects(
      proveLanePortsIdle({
        isFree: async (port) => port !== held && port !== LANE_PORTS.redis,
        stopOwnLeftoverRedis: async () => {
          stops += 1;
          return true;
        },
        busy: (name, port) => new Error(`busy ${name} ${port}`)
      }),
      new RegExp(`busy .* ${held}`)
    );
    assert.equal(stops, 0);
  }
});

test('the lane\'s own leftover database is stopped once the other ports are idle; anything else holding it is refused', async () => {
  let stops = 0;
  const onlyDatabaseHeld = async (port) => port !== LANE_PORTS.redis;
  await proveLanePortsIdle({
    isFree: onlyDatabaseHeld,
    stopOwnLeftoverRedis: async () => {
      stops += 1;
      return true;
    },
    busy: (name) => new Error(`busy ${name}`)
  });
  assert.equal(stops, 1);
  await assert.rejects(
    proveLanePortsIdle({ isFree: onlyDatabaseHeld, stopOwnLeftoverRedis: async () => false, busy: (name) => new Error(`busy ${name}`) }),
    /busy database/
  );
});

test('Start stops leftover voice engines only after every lane port is proven idle', async () => {
  const calls = [];
  const steps = (busyPort) => ({
    isFree: async (port) => {
      calls.push(`port ${port}`);
      return port !== busyPort;
    },
    stopOwnLeftoverRedis: async () => {
      calls.push('stop leftover redis');
      return false;
    },
    busy: (name, port) => new Error(`busy ${name} ${port}`),
    stopLeftoverEngines: async () => calls.push('stop leftover engines')
  });
  for (const port of [LANE_PORTS.server, LANE_PORTS.app, LANE_PORTS.redis]) {
    calls.length = 0;
    await assert.rejects(settleBeforeStart(steps(port)), new RegExp(`busy .* ${port}`));
    assert.equal(calls.includes('stop leftover engines'), false, `nothing is stopped while ${port} is held`);
  }
  calls.length = 0;
  await settleBeforeStart(steps(null));
  assert.deepEqual(calls, [`port ${LANE_PORTS.server}`, `port ${LANE_PORTS.app}`, `port ${LANE_PORTS.redis}`, 'stop leftover engines']);
});

// ---- BL-343 -------------------------------------------------------------------------------

test('Windows guest engine policy is an explicit Linux-only pair, never the durable profile or bind host', () => {
  assert.equal(resolvePinokioEngineStopPolicy({ env: {}, platform: 'linux' }), 'per-engine');
  assert.equal(resolvePinokioEngineStopPolicy({ env: { BATSHIT_PINOKIO_LAUNCH_PROFILE: 'windows-wsl', HOST: 'windows-wsl' }, platform: 'linux' }), 'per-engine');
  const env = { BATSHIT_PINOKIO_HOST: 'windows-wsl', BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'all-owned' };
  assert.equal(resolvePinokioEngineStopPolicy({ env, platform: 'linux' }), 'all-owned');
  for (const platform of ['darwin', 'win32']) assert.throws(() => resolvePinokioEngineStopPolicy({ env, platform }), /requires Linux/);
  for (const invalid of [
    { BATSHIT_PINOKIO_HOST: 'windows-wsl' },
    { BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'all-owned' },
    { ...env, BATSHIT_PINOKIO_HOST: '' },
    { ...env, BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'force' }
  ]) assert.throws(() => resolvePinokioEngineStopPolicy({ env: invalid, platform: 'linux' }), /requires Linux/);
});

test('the lane registry stamp matches the app normalization of the actual child Redis environment, including DB0', () => {
  const child = sharedLaneEnv({ paths, secrets: {} });
  const redis = new URL(child.REDIS_URL);
  assert.equal(redis.hostname, '127.0.0.1');
  assert.equal(redis.pathname, '/0');
  assert.equal(LANE_VOICE_RUNTIME_REGISTRY,
    `redis-${createHash('sha256').update(`${redis.hostname}:${redis.port}/${redis.pathname.slice(1)}`).digest('hex').slice(0, 16)}`);
});

test('all-owned overrides only exact-lane and registry choices while retaining the shared PID and process-group proof', () => {
  const launch = { engineId: 'owned', pid: 101, command: '/engine', launchedBy: OWNER, registry: LANE_VOICE_RUNTIME_REGISTRY, launchedAt: '2026-10-12T10:00:00Z', stopOnShutdown: false };
  const attach = { ...launch, engineId: 'owned-attach', startedBy: 'owned' };
  const inputs = { owner: OWNER, records: [launch, attach], alive: true, commandLines: ['/engine'], leaderStartedAtMs: Date.parse('2026-10-12T09:59:59Z') };
  const policy = { engineStopPolicy: 'all-owned', platform: 'linux' };
  assert.equal(decideLaneVoiceRuntimeGroupStop(inputs).action, 'keep-running', 'the default still honors saved OFF');
  assert.equal(decideLaneVoiceRuntimeGroupStop(inputs, policy).action, 'stop');
  assert.equal(launch.stopOnShutdown, false);
  assert.equal(attach.stopOnShutdown, false);
  assert.equal(decideLaneVoiceRuntimeGroupStop({ ...inputs, commandLines: null }, policy).action, 'unverified');
  const reused = decideLaneVoiceRuntimeGroupStop({ ...inputs, leaderStartedAtMs: Date.parse('2026-10-12T10:01:00Z') }, policy);
  assert.equal(reused.action, 'refuse');
  assert.equal(reused.stale[0], launch, 'guarded cleanup receives original records');
  assert.equal(reused.stale[1], attach);
  assert.throws(() => decideLaneVoiceRuntimeGroupStop(inputs, { ...policy, platform: 'darwin' }), /requires Linux/);
});

test('Windows guest Delete refusal never asks for an unavailable keep-running switch change', () => {
  const blocked = [{ result: 'unverified', label: 'voice engine "owned"' }];
  assert.match(describeEnginesBlockingDelete(blocked), /turn it on for that engine/);
  const refusal = describeEnginesBlockingDelete(blocked, { engineStopPolicy: 'all-owned' });
  assert.doesNotMatch(refusal, /turn it on|Where Stop with Batshit is off/);
  assert.match(refusal, /prove this install owns/);
});

test('all-owned never overrides or removes foreign, mixed, or unmarked records, even when stale', () => {
  const own = { engineId: 'owned', pid: 101, command: '/engine', launchedBy: OWNER, registry: LANE_VOICE_RUNTIME_REGISTRY, stopOnShutdown: false };
  const policy = { engineStopPolicy: 'all-owned', platform: 'linux' };
  for (const records of [
    [{ ...own, launchedBy: 'pinokio:/another-lane' }],
    [{ ...own, launchedBy: undefined }],
    [own, { ...own, engineId: 'shared', startedBy: 'owned', launchedBy: 'native:1:1' }],
    [{ ...own, registry: undefined }],
    [{ ...own, registry: 'redis-another-registry' }],
    [own, { ...own, engineId: 'foreign-off-attach', startedBy: 'owned', registry: 'redis-another-registry', stopOnShutdown: false }],
    [own, { ...own, engineId: 'unknown-off-attach', startedBy: 'owned', registry: undefined, stopOnShutdown: false }]
  ]) {
    for (const alive of [true, false]) {
      const decision = decideLaneVoiceRuntimeGroupStop({ records, owner: OWNER, alive, commandLines: ['/unrelated'] }, policy);
      assert.equal(decision.action, 'keep-running');
      assert.deepEqual(decision.stale, []);
    }
  }
});

test('all-owned inventory uncertainty sends no signal and removes no record', async () => {
  for (const unknown of ['not json', JSON.stringify({ engineId: 'unknown', launchedBy: OWNER, stopOnShutdown: false })]) {
    const root = await mkdtemp(join(sandbox, 'all-owned-unknown-'));
    await mkdir(join(root, 'unknown'));
    await mkdir(join(root, 'known'));
    await writeFile(join(root, 'unknown', PRIMARY), unknown);
    await writeFile(join(root, 'known', PRIMARY), JSON.stringify({ engineId: 'known', pid: 101, command: '/engine', launchedBy: OWNER, registry: LANE_VOICE_RUNTIME_REGISTRY, stopOnShutdown: false }));
    const effects = [];
    const outcomes = await stopLeftoverVoiceEngines({
      stateRoot: root, owner: OWNER, say: () => {}, engineStopPolicy: 'all-owned', platform: 'linux',
      isAlive: () => true, readGroup: async () => ({ commandLines: ['/engine'], leaderStartedAtMs: null }),
      terminate: async () => { effects.push('signal'); return { ok: true }; },
      removeRecord: async () => { effects.push('remove'); }
    });
    assert.deepEqual(effects, []);
    assert.equal(outcomes.find((entry) => entry.pid === 101)?.result, 'held');
    assert.equal(enginesBlockingDelete(outcomes).length, 1);
    if (unknown.startsWith('{')) {
      const issue = outcomes.find((entry) => entry.recordIssue === 'no-process-id');
      assert.equal(issue.result, 'unchecked');
      assert.equal(issue.recordPath, join(root, 'unknown', PRIMARY));
      const refusal = describeEnginesBlockingDelete(enginesBlockingDelete(outcomes), { engineStopPolicy: 'all-owned' });
      assert.ok(refusal.includes(issue.recordPath), 'the exact repair target is retained');
      assert.doesNotMatch(refusal, /is still running|are still running|then delete again\.$/);
      assert.match(refusal, /Once you have confirmed the engines have ended.*repair or remove/);
      assert.match(refusal, /Restarting alone does not repair the record/);
      const afterRestart = await stopLeftoverVoiceEngines({
        stateRoot: root, owner: OWNER, say: () => {}, engineStopPolicy: 'all-owned', platform: 'linux',
        isAlive: () => false, terminate: async () => { effects.push('signal'); return { ok: true }; },
        removeRecord: async () => { effects.push('remove'); }
      });
      assert.equal(afterRestart.find((entry) => entry.recordIssue === 'no-process-id')?.result, 'unchecked');
      assert.equal(await readFile(issue.recordPath, 'utf8'), unknown, 'restart proof does not authorize discarding an unknown record');
      assert.deepEqual(effects, []);
    }
  }
});

test('unknown-record Delete guidance retains a long exact path and never directs removal before engines have ended', () => {
  const recordPath = `/owned/${'long-folder/'.repeat(30)}.batshit-local-runtime-launch.json`;
  const refusal = describeEnginesBlockingDelete([
    { result: 'unchecked', recordIssue: 'no-process-id', recordPath, label: 'voice engine "unknown"' }
  ], { engineStopPolicy: 'all-owned' });
  assert.ok(refusal.includes(recordPath));
  assert.doesNotMatch(refusal, /is still running|Where Stop with Batshit is off/);
  assert.ok(refusal.indexOf('confirmed the engines have ended') < refusal.indexOf('repair or remove'));
});

test('all-owned settle stops a verified own OFF engine and keeps a foreign shared group byte-for-byte', async () => {
  const root = await mkdtemp(join(sandbox, 'all-owned-settle-'));
  const records = [
    { engineId: 'own', pid: 101, command: '/engine', launchedBy: OWNER, registry: LANE_VOICE_RUNTIME_REGISTRY, stopOnShutdown: false },
    { engineId: 'mixed-own', pid: 102, command: '/engine', launchedBy: OWNER, registry: LANE_VOICE_RUNTIME_REGISTRY, stopOnShutdown: true },
    // Actual attachments copy the starter's launcher owner while keeping the attaching registry.
    { engineId: 'mixed-foreign', pid: 102, command: '/engine', launchedBy: OWNER, registry: 'redis-another-registry', startedBy: 'mixed-own', stopOnShutdown: false }
  ];
  for (const record of records) {
    await mkdir(join(root, record.engineId));
    await writeFile(join(root, record.engineId, PRIMARY), JSON.stringify(record));
  }
  const stopped = [];
  const removed = [];
  const outcomes = await stopLeftoverVoiceEngines({
    stateRoot: root, owner: OWNER, say: () => {}, engineStopPolicy: 'all-owned', platform: 'linux',
    isAlive: () => true, readGroup: async () => ({ commandLines: ['/engine'], leaderStartedAtMs: null }),
    terminate: async (pid) => { stopped.push(pid); return { ok: true }; },
    removeRecord: async (record) => { removed.push(record.engineId); }
  });
  assert.deepEqual(stopped, [101]);
  assert.deepEqual(removed, ['own']);
  assert.equal(outcomes.find((entry) => entry.pid === 102)?.result, 'unchecked');
  assert.equal(outcomes.find((entry) => entry.pid === 102)?.recordIssue, 'registry-custody');
  const blockers = enginesBlockingDelete(outcomes);
  assert.equal(blockers.length, 1, 'copied launcher owner does not let Delete erase an own starter used by a foreign registry');
  assert.equal(blockers[0].pid, 102);
  const refusal = describeEnginesBlockingDelete(blockers, { engineStopPolicy: 'all-owned' });
  assert.match(refusal, /whole group and its launch records were left as they were/);
  assert.doesNotMatch(refusal, /is still running|are still running/);
  for (const record of records.slice(1)) assert.ok(refusal.includes(join(root, record.engineId, PRIMARY)));
  for (const record of records.slice(1)) {
    assert.equal(await readFile(join(root, record.engineId, PRIMARY), 'utf8'), JSON.stringify(record));
  }
  let deletions = 0;
  const deadGroupLogs = [];
  const held = await settleBeforeDelete({
    isFree: async () => true, busy: () => new Error('unexpected'),
    stopLeftoverEngines: () => stopLeftoverVoiceEngines({
      stateRoot: root, owner: OWNER, say: (line) => deadGroupLogs.push(line), engineStopPolicy: 'all-owned', platform: 'linux',
      isAlive: () => false, removeRecord: async () => { deletions++; }
    })
  });
  assert.equal(held.length, 1, 'unknown custody preserves the whole group records even when the PID is gone');
  assert.equal(held[0].pid, 102);
  assert.equal(deletions, 1, 'only the wholly owned finished launch is removable');
  assert.doesNotMatch(deadGroupLogs.join('\n'), /left .* running:/, 'unknown custody does not falsely report a dead process as running');
});

test('an engine this lane launched, left running by a hard Stop, is stopped at the next start', async () => {
  const engine = await startEngineProcess('kokoro');
  await writeRecord('kokoro', { ...engine, launchedBy: OWNER });
  const { lines, resultFor } = await settle();
  assert.equal(resultFor(engine.pid), 'stopped');
  assert.equal(await waitGone(engine.pid), true);
  assert.deepEqual(await recordNames('kokoro'), []);
  assert.match(lines.join('\n'), /stopped voice engine "kokoro", left running by an earlier start/);
});

test('an engine whose Stop with Batshit is off keeps running, and keeps its record', async () => {
  const engine = await startEngineProcess('keep');
  await writeRecord('keep', { ...engine, launchedBy: OWNER, stopOnShutdown: false });
  const { lines, resultFor } = await settle();
  assert.equal(resultFor(engine.pid), 'kept-by-choice');
  assert.equal(alive(engine.pid), true);
  assert.deepEqual(await recordNames('keep'), [PRIMARY]);
  assert.match(lines.join('\n'), /left voice engine "keep" running: Stop with Batshit is off/);
});

test('an engine another Batshit launched is never stopped by this lane', async () => {
  const engine = await startEngineProcess('foreign');
  await writeRecord('foreign', { ...engine, launchedBy: 'mac-app:/elsewhere' });
  const { lines, resultFor } = await settle();
  assert.equal(resultFor(engine.pid), 'not-ours');
  assert.equal(alive(engine.pid), true);
  assert.deepEqual(await recordNames('foreign'), [PRIMARY]);
  assert.match(lines.join('\n'), /left voice engine "foreign" running: another Batshit/);
});

test('an unmarked launch is left running: the lane claims only launches it marked as its own', async () => {
  const engine = await startEngineProcess('unmarked');
  await writeRecord('unmarked', { ...engine });
  const { lines, resultFor } = await settle();
  assert.equal(resultFor(engine.pid), 'not-ours');
  assert.equal(alive(engine.pid), true);
  assert.deepEqual(await recordNames('unmarked'), [PRIMARY]);
  assert.match(lines.join('\n'), /left voice engine "unmarked" running: its record does not say this Pinokio install launched it/);
});

test('a process this lane started but another record names for someone else is left running', async () => {
  const engine = await startEngineProcess('mixed');
  await writeRecord('mixed', { ...engine, launchedBy: OWNER });
  await writeRecord('mixed-guest', { ...engine, launchedBy: 'native:1:1', startedBy: 'mixed' });
  const { resultFor } = await settle();
  assert.equal(resultFor(engine.pid), 'not-ours');
  assert.equal(alive(engine.pid), true);
  assert.deepEqual(await recordNames('mixed'), [PRIMARY]);
  assert.deepEqual(await recordNames('mixed-guest'), [PRIMARY]);
});

test('a record whose pid now belongs to a newer process is refused, and nothing is killed', async () => {
  const engine = await startEngineProcess('reused');
  // Launched a minute before this process started: the pid was reused since.
  await writeRecord('reused', { ...engine, launchedBy: OWNER, launchedAt: new Date(Date.now() - 60_000).toISOString() });
  const { lines, resultFor } = await settle();
  assert.equal(resultFor(engine.pid), 'refused');
  assert.equal(alive(engine.pid), true);
  assert.deepEqual(await recordNames('reused'), [], 'the stale record is dropped');
  assert.match(lines.join('\n'), /did not stop voice engine "reused": .*refused to kill it/);
});

test('a stale record that cannot be removed is reported, and the outcome stands', async () => {
  const engine = await startEngineProcess('stale-stuck');
  await writeRecord('stale-stuck', { ...engine, launchedBy: OWNER });
  process.kill(-engine.pid, 'SIGKILL');
  assert.equal(await waitGone(engine.pid), true);
  const { lines, resultFor } = await settle({
    removeRecord: async (record) => {
      if (record.engineId === 'stale-stuck') throw new Error('the record folder is locked');
      return removeLocalRuntimeLaunchRecord(record);
    }
  });
  assert.equal(resultFor(engine.pid), 'gone');
  assert.match(lines.join('\n'), /could not remove a stale launch record of voice engine "stale-stuck" \(the record folder is locked\)/);
  await settle();
  assert.deepEqual(await recordNames('stale-stuck'), []);
});

test('a record whose process is gone is dropped quietly', async () => {
  const engine = await startEngineProcess('gone');
  // Written while the process runs, as the app writes it: a record written after a kill could
  // name a pid reused in between.
  await writeRecord('gone', { ...engine, launchedBy: OWNER });
  process.kill(-engine.pid, 'SIGKILL');
  assert.equal(await waitGone(engine.pid), true);
  const { lines, resultFor } = await settle();
  assert.equal(resultFor(engine.pid), 'gone');
  assert.deepEqual(await recordNames('gone'), []);
  assert.equal(lines.some((line) => line.includes('"gone"')), false);
});

test('when the process table cannot be read, the engine is left running with its record', async () => {
  const engine = await startEngineProcess('unread');
  await writeRecord('unread', { ...engine, launchedBy: OWNER });
  const { lines, resultFor } = await settle({ readGroup: async () => null });
  assert.equal(resultFor(engine.pid), 'unverified');
  assert.equal(alive(engine.pid), true);
  assert.deepEqual(await recordNames('unread'), [PRIMARY]);
  assert.match(lines.join('\n'), /left voice engine "unread" running: could not read pid/);
  await settle(); // the next start, with ps working, stops it
  assert.equal(await waitGone(engine.pid), true);
});

test('a runtime two engines share stops only when both say stop', async () => {
  const engine = await startEngineProcess('shared');
  await writeRecord('shared', { ...engine, launchedBy: OWNER });
  await writeRecord('shared-twin', { ...engine, launchedBy: OWNER, startedBy: 'shared', stopOnShutdown: false });
  const { resultFor } = await settle();
  assert.equal(resultFor(engine.pid), 'kept-by-choice');
  assert.equal(alive(engine.pid), true);
  assert.deepEqual(await recordNames('shared'), [PRIMARY]);
  assert.deepEqual(await recordNames('shared-twin'), [PRIMARY]);
});

test('a record that cannot be removed is reported, and never stops the other engines', async () => {
  const stuck = await startEngineProcess('stuck');
  const fine = await startEngineProcess('fine');
  await writeRecord('stuck', { ...stuck, launchedBy: OWNER });
  await writeRecord('fine', { ...fine, launchedBy: OWNER });
  const { lines } = await settle({
    removeRecord: async (record) => {
      if (record.engineId === 'stuck') throw new Error('the record folder is locked');
      return removeLocalRuntimeLaunchRecord(record);
    }
  });
  assert.equal(await waitGone(stuck.pid), true);
  assert.equal(await waitGone(fine.pid), true);
  assert.deepEqual(await recordNames('fine'), []);
  assert.deepEqual(await recordNames('stuck'), [PRIMARY], 'kept for the next start, which drops it');
  assert.match(lines.join('\n'), /could not remove the launch record of voice engine "stuck" \(the record folder is locked\)/);
  assert.equal(lines.some((line) => /error:|errno /i.test(line)), false, 'Pinokio would stop the step on these words');
  await settle();
  assert.deepEqual(await recordNames('stuck'), []);
});

test('trouble before anything is stopped leaves that engine as it was', async () => {
  const engine = await startEngineProcess('troubled');
  await writeRecord('troubled', { ...engine, launchedBy: OWNER });
  const { lines, results } = await settle({
    readGroup: async (pgid) => {
      if (pgid === engine.pid) throw new Error('ps was interrupted');
      return readLocalRuntimeProcessGroup(pgid);
    }
  });
  assert.equal(alive(engine.pid), true);
  assert.deepEqual(await recordNames('troubled'), [PRIMARY]);
  assert.match(lines.join('\n'), /could not check the voice engine in process group \d+ \(ps was interrupted\); left it as it was/);
  assert.equal(results.find((entry) => entry.pid === engine.pid)?.result, 'unchecked');
  await settle();
  assert.equal(await waitGone(engine.pid), true);
});

test('the lane needs its owner to settle anything', async () => {
  await assert.rejects(stopLeftoverVoiceEngines({ stateRoot: paths.voiceEngines, owner: '', say: () => {} }), /owner is required/);
});

test('an empty or missing voice engines folder is nothing to do', async () => {
  const { lines, say } = collector();
  assert.deepEqual(await stopLeftoverVoiceEngines({ stateRoot: join(sandbox, 'nowhere'), owner: OWNER, say }), []);
  assert.deepEqual(lines, []);
});

test('Delete Batshit data refuses while any lane port is held, and never stops a database', async () => {
  for (const held of [LANE_PORTS.server, LANE_PORTS.app, LANE_PORTS.redis]) {
    let engineStops = 0;
    await assert.rejects(
      settleBeforeDelete({
        isFree: async (port) => port !== held,
        busy: () => new Error('Batshit is running'),
        stopLeftoverEngines: async () => {
          engineStops += 1;
          return [];
        }
      }),
      /Batshit is running/
    );
    assert.equal(engineStops, 0);
  }
});

test('Delete Batshit data stops this lane\'s leftover engines first, and is held up only by one that may be its own', async () => {
  const doomed = await startEngineProcess('delete-doomed');
  const kept = await startEngineProcess('delete-kept');
  await writeRecord('delete-doomed', { ...doomed, launchedBy: OWNER });
  await writeRecord('delete-kept', { ...kept, launchedBy: OWNER, stopOnShutdown: false });
  const { say } = collector();
  const blocking = await settleBeforeDelete({
    isFree: async () => true,
    busy: () => new Error('unexpected'),
    stopLeftoverEngines: () => stopLeftoverVoiceEngines({ stateRoot: paths.voiceEngines, owner: OWNER, say })
  });
  assert.equal(await waitGone(doomed.pid), true);
  assert.ok(blocking.some((entry) => entry.pid === kept.pid && entry.result === 'kept-by-choice'));
  // Other tests' engines in this folder: another Batshit's or unmarked ones never hold it up.
  assert.equal(blocking.some((entry) => entry.result === 'not-ours' || entry.result === 'refused'), false);
  assert.equal(alive(kept.pid), true);
});

test('only an engine that may be this lane\'s and still runs holds a delete up', () => {
  const kinds = ['gone', 'refused', 'unverified', 'kept-by-choice', 'not-ours', 'still-running', 'stopped', 'unchecked', 'unreadable'];
  const held = enginesBlockingDelete(kinds.map((result, pid) => ({ pid, result, label: result })));
  assert.deepEqual(held.map((entry) => entry.result), ['unverified', 'kept-by-choice', 'still-running', 'unchecked', 'unreadable']);
});

test('a delete is held up by this lane\'s engine that cannot be checked, not by a stale record it could not remove', async () => {
  const unread = await startEngineProcess('delete-unread');
  const dead = await startEngineProcess('delete-dead');
  await writeRecord('delete-unread', { ...unread, launchedBy: OWNER });
  await writeRecord('delete-dead', { ...dead, launchedBy: OWNER });
  process.kill(-dead.pid, 'SIGKILL');
  assert.equal(await waitGone(dead.pid), true);
  const { say } = collector();
  const blocking = await settleBeforeDelete({
    isFree: async () => true,
    busy: () => new Error('unexpected'),
    stopLeftoverEngines: () =>
      stopLeftoverVoiceEngines({
        stateRoot: paths.voiceEngines,
        owner: OWNER,
        say,
        readGroup: async (pgid) => (pgid === unread.pid ? null : readLocalRuntimeProcessGroup(pgid)),
        removeRecord: async (record) => {
          if (record.engineId === 'delete-dead') throw new Error('the record folder is locked');
          return removeLocalRuntimeLaunchRecord(record);
        }
      })
  });
  assert.ok(blocking.some((entry) => entry.pid === unread.pid && entry.result === 'unverified'));
  assert.equal(blocking.some((entry) => entry.pid === dead.pid), false);
  assert.equal(alive(unread.pid), true);
});

test('a launch record the lane cannot read is left as it is and said; Start goes on, Delete is held up (BL-1264)', async () => {
  const root = join(sandbox, 'unreadable-records');
  const writeIn = async (engineId, content, fileName = PRIMARY) => {
    await mkdir(join(root, engineId), { recursive: true });
    await writeFile(join(root, engineId, fileName), content);
  };
  const good = await startEngineProcess('unreadable-good');
  await writeIn('good', JSON.stringify({ engineId: 'good', launchedAt: new Date().toISOString(), ...good, launchedBy: OWNER }));
  await writeIn('garbled', '{ "pid": ');
  await writeIn('blank', '');
  await mkdir(join(root, 'folder-record', PRIMARY), { recursive: true });
  await writeIn('locked', JSON.stringify({ pid: 1, launchedBy: OWNER }));
  await chmod(join(root, 'locked'), 0o000);
  try {
    const { lines, say } = collector();
    const results = await stopLeftoverVoiceEngines({ stateRoot: root, owner: OWNER, say });

    // One unreadable record holds the whole pass: the readable engine is left for the next one.
    assert.equal(alive(good.pid), true, 'nothing is stopped while a record cannot be read');
    assert.deepEqual(results.filter((entry) => entry.pid === good.pid).map((entry) => entry.result), ['held']);
    const unreadable = results.filter((entry) => entry.result === 'unreadable');
    assert.deepEqual(unreadable.map((entry) => entry.label).sort(), ['voice engine "blank"', 'voice engine "folder-record"', 'voice engine "garbled"', 'voice engine "locked"']);
    for (const pattern of [/is not valid JSON/, /is empty/, /could not be read \(EISDIR\)/, /the folder .*locked could not be read \(EACCES\)/]) {
      assert.ok(lines.some((line) => pattern.test(line) && /left it, and any voice engine it names, as they are\.$/.test(line)), `${pattern}: ${lines.join(' | ')}`);
    }
    assert.equal(lines.some((line) => /error:|errno /i.test(line)), false);
    for (const engineId of ['good', 'garbled', 'blank', 'folder-record']) {
      assert.deepEqual(await readdir(join(root, engineId)), [PRIMARY], `${engineId}: left as it is`);
    }

    // Start is never held up by them.
    await settleBeforeStart({ isFree: async () => true, stopOwnLeftoverRedis: async () => false, busy: () => new Error('unexpected'), stopLeftoverEngines: async () => results });

    // Delete is, with a refusal that names each one and what to do.
    const blocking = await settleBeforeDelete({ isFree: async () => true, busy: () => new Error('unexpected'), stopLeftoverEngines: async () => results });
    assert.equal(blocking.filter((entry) => entry.result === 'unreadable').length, 4);
    const refusal = describeEnginesBlockingDelete(blocking);
    assert.match(refusal, /^4 voice engine launch records could not be read \(/);
    for (const engineId of ['garbled', 'blank', 'folder-record', 'locked']) assert.ok(refusal.includes(join(root, engineId)), engineId);
    assert.match(refusal, /Restart the computer \(that stops every engine Batshit started\), remove those files or folders yourself, then delete again\.$/);
    assert.doesNotMatch(refusal, /error:|errno /i);
    assert.doesNotMatch(refusal, /still running/, 'an unreadable record is not said to be a running engine');
  } finally {
    await chmod(join(root, 'locked'), 0o755);
  }
});

test('one unreadable record beside a readable stop-on engine: no signal and no removal in that pass, and the next pass stops it (BL-1264)', async () => {
  const root = join(sandbox, 'partial-inventory');
  const engine = await startEngineProcess('partial-stop-on');
  const writeIn = async (engineId, content, fileName = PRIMARY) => {
    await mkdir(join(root, engineId), { recursive: true });
    await writeFile(join(root, engineId, fileName), content);
  };
  // A readable record of this lane that says stop (Stop with Batshit on, the default), a stale record
  // naming a dead pid, a readable record naming no process, and one record that cannot be read: it
  // could be another engine's "keep running" for the same process.
  await writeIn('stop-on', JSON.stringify({ engineId: 'stop-on', launchedAt: new Date().toISOString(), ...engine, launchedBy: OWNER }));
  await writeIn('no-pid', JSON.stringify({ engineId: 'no-pid', launchedBy: OWNER }));
  await writeIn('hidden-attach', '{ "engineId": "hidden-attach", "startedBy": "stop-on", "stopOnShutdown": fal');
  const signals = [];
  const removals = [];
  const { lines, say } = collector();

  const results = await stopLeftoverVoiceEngines({
    stateRoot: root,
    owner: OWNER,
    say,
    terminate: async (pid) => {
      signals.push(pid);
      return { ok: true };
    },
    removeRecord: async (record) => {
      removals.push(record.recordPath);
      return true;
    }
  });

  assert.deepEqual(signals, [], 'no signal');
  assert.deepEqual(removals, [], 'no record removed');
  assert.equal(alive(engine.pid), true);
  for (const engineId of ['stop-on', 'no-pid', 'hidden-attach']) assert.deepEqual(await readdir(join(root, engineId)), [PRIMARY], engineId);
  assert.deepEqual(results.map((entry) => entry.result).sort(), ['held', 'unreadable']);
  assert.ok(lines.some((line) => /stopped no voice engine and removed no launch record/.test(line)), lines.join(' | '));
  assert.doesNotMatch(lines.join('\n'), /error:|errno /i);
  // The shared words, whole and in a safe order: the engines stop first, then the file is repaired
  // or removed. Never "repair or remove" before that, and no line cut short.
  const said = lines.join(' ');
  assert.match(said, /Once the voice engines have stopped \(restarting the computer stops them\), repair or remove that file or folder; the next Start settles them\./);
  assert.doesNotMatch(said, /Repair or remove that file/);
  assert.ok(lines.every((line) => !line.endsWith('…')), lines.join(' | '));
  const blocking = enginesBlockingDelete(results);
  assert.deepEqual(blocking.map((entry) => entry.result), ['unreadable'], 'Delete is held up by the unreadable record');
  assert.match(describeEnginesBlockingDelete(blocking), /^a voice engine launch record could not be read \(.*hidden-attach/);

  // Once that record is readable again, the next pass decides with the whole inventory.
  await writeIn('hidden-attach', JSON.stringify({ engineId: 'hidden-attach', launchedAt: new Date().toISOString(), ...engine, launchedBy: OWNER, startedBy: 'stop-on', stopOnShutdown: false }));
  const next = await stopLeftoverVoiceEngines({ stateRoot: root, owner: OWNER, say: () => {} });
  assert.equal(alive(engine.pid), true, 'the hidden "keep running" was real, so the engine keeps running');
  assert.deepEqual(next.filter((entry) => entry.pid === engine.pid).map((entry) => entry.result), ['kept-by-choice']);
});

test('a voice engines folder that cannot be read at all holds Delete up as one entry (BL-1264)', async () => {
  const notAFolder = join(sandbox, 'voice-engines-is-a-file');
  await writeFile(notAFolder, 'not a folder');
  const { lines, say } = collector();
  const results = await stopLeftoverVoiceEngines({ stateRoot: notAFolder, owner: OWNER, say });
  assert.deepEqual(results.map((entry) => [entry.result, entry.label, entry.recordPath]), [['unreadable', 'the voice engines', notAFolder]]);
  assert.match(lines[0], /records folder .* could not be read \(ENOTDIR\)/);
  assert.deepEqual(enginesBlockingDelete(results).length, 1);
  const refusal = describeEnginesBlockingDelete([...results, { result: 'kept-by-choice', label: 'voice engine "kokoro"' }]);
  assert.match(refusal, /^voice engine "kokoro" is still running .* a voice engine launch record could not be read \(.*voice-engines-is-a-file\)/);
});

// ---- BL-363 -------------------------------------------------------------------------------

test('Redis replies are read whole: status, error, bulk, and an incomplete bulk', () => {
  assert.deepEqual(parseRedisReply(Buffer.from('+PONG\r\n')), { ok: true, text: 'PONG' });
  assert.deepEqual(parseRedisReply(Buffer.from('-LOADING Redis is loading the dataset in memory\r\n')), {
    ok: false,
    text: 'LOADING Redis is loading the dataset in memory'
  });
  assert.equal(parseRedisReply(Buffer.from('+PON')), null);
  assert.equal(parseRedisReply(Buffer.from('$20\r\nprocess_id:4')), null);
  assert.deepEqual(parseRedisReply(Buffer.from('$12\r\nprocess_id:7\r\n')), { ok: true, text: 'process_id:7' });
  assert.deepEqual(parseRedisReply(Buffer.from('$-1\r\n')), { ok: true, text: null });
  assert.equal(redisProcessId('# Server\r\nredis_version:8.10.1\r\nprocess_id:4242\r\nrun_id:x\r\n'), 4242);
  assert.equal(redisProcessId('# Server\r\n'), null);
});

// A fake Redis that answers PING from `pings` in turn (the last one repeats) and INFO with `pid`.
async function fakeRedis({ pings, pid }) {
  let served = 0;
  const server = createServer((socket) => {
    socket.on('data', (data) => {
      const text = data.toString('utf8');
      if (text.includes('PING')) {
        socket.write(pings[Math.min(served, pings.length - 1)]);
        served += 1;
      } else if (text.includes('INFO')) {
        const body = `# Server\r\nredis_version:8.10.1\r\nprocess_id:${pid}\r\n`;
        socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
      }
    });
  });
  await new Promise((done) => server.listen({ port: 0, host: '127.0.0.1' }, done));
  return { port: server.address().port, pings: () => served, close: () => new Promise((done) => server.close(done)) };
}

const never = new Promise(() => {});

test('the database is ready only once its own process answers PONG, not while it loads', { timeout: 10_000 }, async () => {
  const redis = await fakeRedis({ pings: ['-LOADING Redis is loading the dataset in memory\r\n', '-LOADING\r\n', '+PONG\r\n'], pid: 4242 });
  try {
    const ready = await waitForOwnRedis({ host: '127.0.0.1', port: redis.port, pid: 4242, exited: never, intervalMs: 10 });
    assert.equal(ready, true);
    assert.equal(redis.pings(), 3, 'two LOADING replies were waited through');
    assert.equal((await askRedis({ host: '127.0.0.1', port: redis.port, args: ['PING'] })).text, 'PONG');
  } finally {
    await redis.close();
  }
});

test('another program answering on the port is not the database: the wait ends when Redis exits', { timeout: 10_000 }, async () => {
  const other = await fakeRedis({ pings: ['+PONG\r\n'], pid: 1 });
  try {
    let exit;
    const exited = new Promise((done) => (exit = done));
    setTimeout(() => exit(1), 150);
    const ready = await waitForOwnRedis({ host: '127.0.0.1', port: other.port, pid: 4242, exited, intervalMs: 10 });
    assert.equal(ready, false);
    assert.ok(other.pings() > 1, 'it kept asking until Redis exited');
  } finally {
    await other.close();
  }
});

test('a Redis that exits before it answers ends the wait, and a slow one is reported', { timeout: 10_000 }, async () => {
  const probe = createServer();
  await new Promise((done) => probe.listen({ port: 0, host: '127.0.0.1' }, done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done)); // nothing listens there now
  let exit;
  const exited = new Promise((done) => (exit = done));
  let slow = 0;
  setTimeout(() => exit(1), 200);
  const ready = await waitForOwnRedis({
    host: '127.0.0.1',
    port,
    pid: 4242,
    exited,
    intervalMs: 10,
    slowMs: 50,
    slowRepeatMs: 1_000,
    onSlow: () => (slow += 1)
  });
  assert.equal(ready, false);
  assert.equal(slow, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

const tick = () => new Promise((done) => setImmediate(done));

test('run redis prints the ready line only once Redis answers, and nothing after it while Redis runs', { timeout: 10_000 }, async () => {
  const ready = deferred();
  const exit = deferred();
  const printed = [];
  const supervising = superviseRedis({
    exited: exit.promise,
    waitReady: () => ready.promise,
    print: (line) => printed.push(line),
    printLogTail: async () => printed.push('<log tail>')
  });
  await tick();
  assert.deepEqual(printed, [], 'nothing before Redis answers');
  ready.resolve(true);
  await tick();
  assert.deepEqual(printed, [REDIS_READY_LINE]);
  exit.resolve(0);
  assert.equal(await supervising, 0);
  assert.deepEqual(printed, [REDIS_READY_LINE], 'a clean stop adds nothing');
});

test('a database that ends prints the end of its log, then one Error line, last', { timeout: 10_000 }, async () => {
  for (const [readyFirst, code, expected] of [
    [false, 1, 1],
    [false, 0, 1],
    [true, 137, 137]
  ]) {
    const printed = [];
    const result = await superviseRedis({
      exited: Promise.resolve(code),
      waitReady: async () => readyFirst,
      print: (line) => printed.push(line),
      printLogTail: async () => printed.push('<log tail>')
    });
    assert.equal(result, expected);
    assert.equal(printed.includes(REDIS_READY_LINE), readyFirst);
    assert.equal(printed.at(-2), '<log tail>');
    assert.match(printed.at(-1), /^Error: Batshit's database stopped/);
  }
});

// Pinokio 8.2.0's event matching, the part of `pinokiod/kernel/shells.js` that decides this: each
// chunk read from the terminal is appended to a buffer cut to its last 300 characters, and the
// step's event regex is tried on that buffer only; a matched event moves Start to its next step.
// (Pinokio also strips terminal styling first; these inputs have none.)
function pinokioMatches(chunks, event) {
  const [, pattern, flags] = /^\/(.+)\/([dgimsuy]*)$/s.exec(event);
  const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  let buffer = '';
  for (const chunk of chunks) {
    buffer = (buffer + chunk).slice(-300);
    if ([...buffer.matchAll(re)].length > 0) return true;
  }
  return false;
}

// Redis 8.10.1's own lines around its ready line, from the 2026-09-26 Start on Josh's Mac
// (`_local/pinokio-proof/i1/pterm-start4.log`), once the memory search indexes exist.
const REDIS_READY_BURST = [
  '56965:M 26 Sep 2026 00:39:14.147 * Opening AOF incr file appendonly.aof.1.incr.aof on server start',
  '56965:M 26 Sep 2026 00:39:14.147 * Ready to accept connections tcp',
  '56965:M 26 Sep 2026 00:39:14.147 # WARNING: Redis does not require authentication. Redis will accept connections from any local client.',
  '56965:M 26 Sep 2026 00:39:14.147 * <search> Scanning index batshit_memory_idx in background',
  '56965:M 26 Sep 2026 00:39:14.149 * <search> Scanning index batshit_memory_idx in background: done (scanned=18)',
  '56965:M 26 Sep 2026 00:39:14.149 * <search> Scanning index batshit_memseg_idx in background',
  '56965:M 26 Sep 2026 00:39:14.150 * <search> Scanning index batshit_memseg_idx in background: done (scanned=18)'
].map((line) => `${line}\r\n`);

test('BL-363 reproduced: Redis\'s ready line read in one busy batch falls outside Pinokio\'s window', () => {
  const OLD_EVENT = '/Ready to accept connections/';
  assert.equal(pinokioMatches(REDIS_READY_BURST, OLD_EVENT), true, 'line by line, as on an idle computer, it matched');
  assert.equal(pinokioMatches([REDIS_READY_BURST.join('')], OLD_EVENT), false, 'in one batch, Start waits forever');
});

test('Start waits for the launcher\'s own ready line, which nothing follows', () => {
  const require = createRequire(import.meta.url);
  const start = require('../start.js');
  const step = start.run.find((entry) => entry.params?.message === 'node lib/cli.mjs run redis');
  const event = step.params.on[0].event;
  assert.equal(step.params.on[0].done, true);
  const echo = '<<PINOKIO_SHELL>>eval "$(conda shell.bash hook)" ; conda activate base && node lib/cli.mjs run redis\r\n';
  const slow = 'Batshit: the database is still loading your data. A large database takes longer.\r\n';
  assert.equal(pinokioMatches([echo, slow, slow], event), false, 'only the ready line moves Start on');
  // However much came before it in the same batch, the ready line is the last thing printed.
  assert.equal(pinokioMatches([`${echo}${slow.repeat(20)}${REDIS_READY_LINE}\n`], event), true);
  assert.equal(pinokioMatches([`${echo}${REDIS_READY_LINE}\n`], event), true);
  assert.doesNotMatch(REDIS_READY_LINE, /error:|errno /i);
});

test('each start keeps the one before\'s Redis log, and a failure shows the end of this one', async () => {
  await mkdir(paths.logs, { recursive: true });
  assert.deepEqual(await logTail(paths.redisLog), [], 'no log yet');
  await rotateLog(paths.redisLog, paths.redisPreviousLog); // nothing to keep yet
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  await writeFile(paths.redisLog, `${lines.join('\n')}\n`);
  assert.deepEqual(await logTail(paths.redisLog, { maxLines: 3 }), ['line 37', 'line 38', 'line 39']);
  const tail = await logTail(paths.redisLog, { maxLines: 100, maxBytes: 30 });
  assert.equal(tail.at(-1), 'line 39');
  assert.ok(tail.every((line) => /^line \d+$/.test(line)), 'a partial first line is dropped');
  await rotateLog(paths.redisLog, paths.redisPreviousLog);
  assert.deepEqual(await logTail(paths.redisLog), []);
  assert.deepEqual(await logTail(paths.redisPreviousLog, { maxLines: 1 }), ['line 39']);
});
