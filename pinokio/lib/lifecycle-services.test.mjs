// BL-1249, with BL-1255/1256/1257: the sandbox services an earlier start left running, settled at
// Start and before Delete by the shared stops with `ownerPolicy: 'exact'`. Fake stops only for every
// outcome a stop can answer; the real sbx module only on real record files it must refuse to act on,
// with a tripwire `sbx` and `container` first on PATH that record any call, so no test can ever run
// Docker's or Apple's own CLI.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import { LANE_PORTS, laneDataPaths, laneVoiceRuntimeOwner } from './lane.mjs';
import {
  describeServicesBlockingDelete,
  pinokioSafeText,
  servicesBlockingDelete,
  settleBeforeDelete,
  settleBeforeStart,
  settleLeftoverSandboxServices
} from './lifecycle.mjs';

const sandbox = await mkdtemp(join(tmpdir(), 'bs-pinokio-services-'));
test.after(async () => {
  await chmod(join(sandbox, 'locked-folder'), 0o755).catch(() => {});
  await rm(sandbox, { recursive: true, force: true });
});

// Tripwires first on PATH for the whole file: a `sbx` or `container` that only writes down that it was
// run. A stop that reached for a real CLI here would show up in TRIPWIRE_LOG instead.
const TRIPWIRE_BIN = join(sandbox, 'tripwire-bin');
const TRIPWIRE_LOG = join(sandbox, 'tripwire.log');
await mkdir(TRIPWIRE_BIN, { recursive: true });
for (const name of ['sbx', 'container']) {
  await writeFile(
    join(TRIPWIRE_BIN, name),
    `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(TRIPWIRE_LOG)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(3)\n`
  );
  await chmod(join(TRIPWIRE_BIN, name), 0o755);
}
process.env.PATH = `${TRIPWIRE_BIN}${delimiter}${process.env.PATH ?? ''}`;
const tripwireCalls = async () => (await readFile(TRIPWIRE_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean);

const SBX_RECORD = '.batshit-sbx-daemon-launch.json';
const APPLE_RECORD = '.batshit-apple-container-system.json';
const ERROR_WORDS = /error:|errno /i;

let laneCount = 0;
async function lane() {
  laneCount += 1;
  const paths = laneDataPaths(join(sandbox, `lane-${laneCount}`, '.batshit', 'pinokio'));
  await mkdir(paths.sbxDaemon, { recursive: true });
  await mkdir(paths.appleContainer, { recursive: true });
  return { paths, owner: laneVoiceRuntimeOwner(paths) };
}

// A fake shared stop module: its stop records each call and answers `outcome` (or throws `throws`);
// its state reader answers `state` and counts its calls (the lane reads a record itself only after a
// stop threw, to tell a sweep-only call from one about a record).
function fakeService({ outcome = { action: 'none', verdict: 'absent' }, throws = null, state = { state: 'present' } } = {}) {
  const calls = [];
  const reads = [];
  const stop = async (args) => {
    calls.push(args);
    if (throws) throw throws;
    return outcome;
  };
  const readState = async (dir) => {
    reads.push(dir);
    return state;
  };
  return {
    calls,
    reads,
    module: {
      SBX_DAEMON_RECORD_NAME: SBX_RECORD,
      APPLE_CONTAINER_SYSTEM_RECORD_NAME: APPLE_RECORD,
      readSbxDaemonRecordState: readState,
      readAppleContainerSystemRecordState: readState,
      stopSbxDaemonIfBatshitStartedIt: stop,
      stopAppleContainerSystemIfBatshitStartedIt: stop
    }
  };
}

function loader({ sbx = fakeService(), apple = fakeService() } = {}) {
  const loaded = [];
  const load = async (specifier) => {
    loaded.push(specifier);
    if (specifier.includes('sbx-daemon-stop')) {
      if (sbx instanceof Error) throw sbx;
      return sbx.module;
    }
    if (specifier.includes('apple-container-system-stop')) {
      if (apple instanceof Error) throw apple;
      return apple.module;
    }
    throw new Error(`unexpected module ${specifier}`);
  };
  return { load, loaded };
}

async function settle({ paths, owner }, { platform = 'darwin', sbx, apple, load } = {}) {
  const lines = [];
  const fakes = loader({ sbx, apple });
  const outcomes = await settleLeftoverSandboxServices({
    paths,
    owner,
    say: (line) => lines.push(line),
    platform,
    load: load ?? fakes.load
  });
  const byService = Object.fromEntries(outcomes.map((entry) => [entry.service, entry]));
  return { lines, outcomes, byService, loaded: fakes.loaded };
}

test('the lane asks each shared stop with its exact owner, the exact policy, and no gone-run inference', async () => {
  const where = await lane();
  const sbx = fakeService({ outcome: { action: 'stopped', ok: true, verdict: 'stopped', pid: 4242 } });
  const apple = fakeService({ outcome: { action: 'stopped', ok: true, verdict: 'stopped' } });
  const { lines, byService } = await settle(where, { sbx, apple });
  for (const [service, expected] of [[sbx, where.paths.sbxDaemon], [apple, where.paths.appleContainer]]) {
    assert.equal(service.calls.length, 1);
    assert.equal(service.calls[0].stateDir, expected);
    assert.equal(service.calls[0].owner, where.owner);
    assert.equal(service.calls[0].ownerPolicy, 'exact');
    assert.equal(service.calls[0].ownerIsGone('native:1:1'), false, 'a gone native run never makes a record ours');
    assert.deepEqual(service.reads, [], 'the lane never reads the record itself before the stop: one admission, inside the stop');
  }
  assert.equal('removeOwnSandboxes' in sbx.calls[0], false);
  assert.equal(apple.calls[0].removeOwnSandboxes, true, 'only this owner\'s sandboxes, with the app proven down');
  assert.equal(byService.sbx.result, 'stopped');
  assert.equal(byService['apple-container'].result, 'stopped');
  assert.deepEqual(servicesBlockingDelete(Object.values(byService)), []);
  assert.match(lines.join('\n'), /stopped Docker's sbx daemon, which an earlier start of this Batshit started/);
});

test('only absent, gone, stopped, and not-ours let Delete go on; kept, did-not-stop, unknown, and no verdict hold it up', async () => {
  const cases = [
    [{ action: 'none', verdict: 'absent' }, 'none', false],
    [{ action: 'drop-record', verdict: 'gone', reason: 'the daemon Batshit started is no longer running' }, 'gone', false],
    [{ action: 'stopped', ok: true, verdict: 'stopped' }, 'stopped', false],
    [{ action: 'keep', verdict: 'not-ours', reason: 'its record names no Batshit' }, 'not-ours', false],
    [{ action: 'keep', verdict: 'kept', reason: 'a sandbox is still running (alpha)' }, 'kept', true],
    [{ action: 'keep', ok: false, verdict: 'kept', reason: 'it did not stop (Error: still registered)' }, 'did-not-stop', true],
    [{ action: 'keep', verdict: 'unknown', reason: 'its record could not be opened (EACCES)' }, 'unknown', true],
    [{ action: 'keep', verdict: 'unknown', reason: 'its record changed while it was being checked' }, 'unknown', true],
    [{ action: 'unverified', reason: 'nobody knows' }, 'unknown', true],
    [{ action: 'drop-record', reason: 'an old helper with no verdict' }, 'unknown', true]
  ];
  for (const [outcome, result, blocks] of cases) {
    const where = await lane();
    const sbx = fakeService({ outcome });
    const { lines, byService } = await settle(where, { sbx, platform: 'linux' });
    assert.equal(byService.sbx.result, result, JSON.stringify(outcome));
    assert.equal(byService.sbx.blocksDelete, blocks, JSON.stringify(outcome));
    assert.equal(lines.some((line) => ERROR_WORDS.test(line)), false, `Pinokio would stop the step: ${lines.join(' | ')}`);
  }
});

test('a stop that throws holds Delete up when a record is there, or might be; with no record it only looked for sandboxes', async () => {
  const thrown = new Error('Error: sbx daemon status failed\nerrno 2 more');
  for (const [state, result, blocks] of [
    [{ state: 'present' }, 'unknown', true],
    [{ state: 'unknown', reason: 'its record could not be opened (EIO)' }, 'unknown', true],
    [{ state: 'absent' }, 'none', false]
  ]) {
    const where = await lane();
    const apple = fakeService({ throws: thrown, state });
    const { lines, byService } = await settle(where, { apple, sbx: fakeService() });
    assert.equal(byService['apple-container'].result, result, state.state);
    assert.equal(byService['apple-container'].blocksDelete, blocks, state.state);
    assert.equal(lines.some((line) => ERROR_WORDS.test(line) || line.includes('\n')), false, lines.join(' | '));
  }
});

test('Apple Container is not touched off a Mac', async () => {
  const where = await lane();
  const apple = fakeService({ outcome: { action: 'stopped', verdict: 'stopped' } });
  const { byService, loaded } = await settle(where, { apple, platform: 'linux' });
  assert.equal(apple.calls.length, 0);
  assert.equal(loaded.some((specifier) => specifier.includes('apple-container')), false);
  assert.equal(byService['apple-container'], undefined);
});

test('with no Apple record, only this lane\'s own sandboxes are swept; one that could not be removed holds Delete up', async () => {
  const removed = fakeService({ outcome: { action: 'none', verdict: 'absent', sandboxes: { removed: ['batshit-apple-sandbox-m3-a'] } } });
  let where = await lane();
  let { lines, byService } = await settle(where, { apple: removed });
  assert.equal(removed.calls[0].removeOwnSandboxes, true);
  assert.equal(byService['apple-container'].blocksDelete, false);
  assert.match(lines.join('\n'), /removed the Apple Container sandboxes an earlier start left running: batshit-apple-sandbox-m3-a/);

  const stuck = fakeService({
    outcome: { action: 'none', verdict: 'absent', ok: false, sandboxes: { removed: [], notRemoved: ['batshit-apple-sandbox-m3-b'], reason: 'Error: delete timed out' } }
  });
  where = await lane();
  ({ lines, byService } = await settle(where, { apple: stuck }));
  assert.equal(byService['apple-container'].blocksDelete, true);
  assert.deepEqual(byService['apple-container'].sandboxesNotRemoved, ['batshit-apple-sandbox-m3-b']);
  assert.equal(lines.some((line) => ERROR_WORDS.test(line)), false);

  const blind = fakeService({ outcome: { action: 'none', verdict: 'absent', sandboxes: { reason: 'the system is registered but does not answer' } } });
  where = await lane();
  ({ lines, byService } = await settle(where, { apple: blind }));
  assert.equal(byService['apple-container'].blocksDelete, false, 'sandboxes nobody could list are not attributed to this lane');
  assert.match(lines.join('\n'), /could not look for Apple Container sandboxes/);

  const many = fakeService({ outcome: { action: 'none', verdict: 'absent', sandboxes: { removed: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] } } });
  where = await lane();
  ({ lines } = await settle(where, { apple: many }));
  assert.match(lines.join('\n'), /: a1, a2, a3, a4, a5 and 2 more\./, 'a long list stays one bounded line');
});

test('a shared stop that does not load: only a missing or empty folder is nothing to do (BL-1256)', async () => {
  const missing = new Error("Cannot find module '../../batshit-mac/scripts/sbx-daemon-stop.mjs'");
  let where = await lane();
  let { byService } = await settle(where, { sbx: missing, platform: 'linux' });
  assert.equal(byService.sbx.result, 'none', 'an empty folder');

  where = await lane();
  await rm(where.paths.sbxDaemon, { recursive: true });
  ({ byService } = await settle(where, { sbx: missing, platform: 'linux' }));
  assert.equal(byService.sbx.result, 'none', 'no folder at all');

  where = await lane();
  await writeFile(join(where.paths.sbxDaemon, SBX_RECORD), JSON.stringify({ launchedBy: where.owner }));
  let lines;
  ({ byService, lines } = await settle(where, { sbx: missing, platform: 'linux' }));
  assert.deepEqual([byService.sbx.result, byService.sbx.blocksDelete], ['unknown', true], 'a folder with something in it');
  assert.match(lines.join('\n'), /could not check Docker's sbx daemon: the launcher's stop for it did not load/);

  // A folder that cannot be read, and a file where the folder should be: unknown, never empty.
  const lockedParent = join(sandbox, 'locked-folder');
  await mkdir(join(lockedParent, 'sbx-daemon'), { recursive: true });
  await chmod(lockedParent, 0o000);
  const lockedPaths = { ...where.paths, sbxDaemon: join(lockedParent, 'sbx-daemon') };
  ({ byService } = await settle({ paths: lockedPaths, owner: where.owner }, { sbx: missing, platform: 'linux' }));
  assert.deepEqual([byService.sbx.result, byService.sbx.blocksDelete], ['unknown', true], 'an unreadable folder');
  await chmod(lockedParent, 0o755);

  where = await lane();
  await rm(where.paths.sbxDaemon, { recursive: true });
  await writeFile(where.paths.sbxDaemon, 'a file, not a folder');
  ({ byService } = await settle(where, { sbx: missing, platform: 'linux' }));
  assert.deepEqual([byService.sbx.result, byService.sbx.blocksDelete], ['unknown', true], 'a file in the folder\'s place');
});

test('a shared stop that does not load: the record lock\'s own files and a leftover temp file are not records (BL-1256)', async () => {
  const missing = new Error("Cannot find module '../../batshit-mac/scripts/sbx-daemon-stop.mjs'");
  const bookkeeping = [
    '.batshit-local-runtime-launch.lock',
    '.batshit-local-runtime-launch.lock.candidate-42-abcdef',
    '.batshit-local-runtime-launch.lock.release-0123',
    '.batshit-local-runtime-launch.reaped-0123',
    `${SBX_RECORD}.42.abcdef.tmp`
  ];
  let where = await lane();
  for (const name of bookkeeping) await writeFile(join(where.paths.sbxDaemon, name), '');
  let { byService, lines } = await settle(where, { sbx: missing, platform: 'linux' });
  assert.deepEqual([byService.sbx.result, byService.sbx.blocksDelete], ['none', false], 'only bookkeeping');

  where = await lane();
  for (const name of bookkeeping) await writeFile(join(where.paths.sbxDaemon, name), '');
  await writeFile(join(where.paths.sbxDaemon, SBX_RECORD), '{}');
  ({ byService, lines } = await settle(where, { sbx: missing, platform: 'linux' }));
  assert.deepEqual([byService.sbx.result, byService.sbx.blocksDelete], ['unknown', true], 'bookkeeping beside a record');
  assert.match(lines.join('\n'), /the files in .* are kept/);
});

test('an sbx stop that throws with no record says so about sbx, not Apple', async () => {
  const where = await lane();
  const sbx = fakeService({ throws: new Error('boom'), state: { state: 'absent' } });
  const { byService, lines } = await settle(where, { sbx, platform: 'linux' });
  assert.deepEqual([byService.sbx.result, byService.sbx.blocksDelete], ['none', false]);
  assert.match(lines.join('\n'), /could not check Docker's sbx daemon \(boom\); it has no record here/);
  assert.doesNotMatch(lines.join('\n'), /Apple/);
});

test('text from outside the launcher is one bounded line without the words that stop a Pinokio step', () => {
  const noisy = `Error: first line\n${'x'.repeat(2_000)}\nerrno 5 ERRNO 6 ERROR: last`;
  const safe = pinokioSafeText(noisy);
  assert.ok(safe.length <= 240, `${safe.length}`);
  assert.equal(safe.includes('\n'), false);
  assert.doesNotMatch(safe, ERROR_WORDS);
  assert.equal(pinokioSafeText('errno 5 then Error: x'), 'errno=5 then Error - x');
});

test('the real sbx stop on real record files: not this owner\'s, unreadable, or empty, refused without one CLI call (BL-1256/1257)', async () => {
  const where = await lane();
  const cases = {
    unmarked: JSON.stringify({ callStartedAt: '2026-10-11T01:00:00.000Z', callEndedAt: '2026-10-11T01:00:02.000Z' }),
    foreign: JSON.stringify({ launchedBy: 'mac-app:/elsewhere', callStartedAt: '2026-10-11T01:00:00.000Z', callEndedAt: '2026-10-11T01:00:02.000Z' }),
    'near-miss': JSON.stringify({ launchedBy: `${where.owner}/`, callStartedAt: '2026-10-11T01:00:00.000Z', callEndedAt: '2026-10-11T01:00:02.000Z' }),
    empty: '',
    malformed: '{ "launchedBy": '
  };
  const expected = { unmarked: 'not-ours', foreign: 'not-ours', 'near-miss': 'not-ours', empty: 'unknown', malformed: 'unknown' };
  for (const [name, content] of Object.entries(cases)) {
    const one = await lane();
    await writeFile(join(one.paths.sbxDaemon, SBX_RECORD), content);
    const [outcome] = await settleLeftoverSandboxServices({ paths: one.paths, owner: one.owner, say: () => {}, platform: 'linux' });
    assert.equal(outcome.result, expected[name], name);
    assert.equal(outcome.blocksDelete, expected[name] === 'unknown', name);
    assert.equal(await readFile(join(one.paths.sbxDaemon, SBX_RECORD), 'utf8'), content, `${name}: left exactly as it was`);
  }
  // A folder where the record should be: unknown, kept.
  const folder = await lane();
  await mkdir(join(folder.paths.sbxDaemon, SBX_RECORD), { recursive: true });
  const [outcome] = await settleLeftoverSandboxServices({ paths: folder.paths, owner: folder.owner, say: () => {}, platform: 'linux' });
  assert.deepEqual([outcome.result, outcome.blocksDelete], ['unknown', true]);
  assert.deepEqual(await tripwireCalls(), [], 'no CLI was ever asked');
});

test('Start settles services after the ports and the engines, and never while a port is held', async () => {
  const calls = [];
  const steps = (busyPort) => ({
    isFree: async (port) => {
      calls.push(`port ${port}`);
      return port !== busyPort;
    },
    stopOwnLeftoverRedis: async () => false,
    busy: (name, port) => new Error(`busy ${name} ${port}`),
    stopLeftoverEngines: async () => {
      calls.push('engines');
      return [];
    },
    stopLeftoverServices: async () => {
      calls.push('services');
      return [{ service: 'sbx', label: "Docker's sbx daemon", result: 'kept', blocksDelete: true }];
    }
  });
  for (const port of [LANE_PORTS.server, LANE_PORTS.app, LANE_PORTS.redis]) {
    calls.length = 0;
    await assert.rejects(settleBeforeStart(steps(port)), new RegExp(`busy .* ${port}`));
    assert.equal(calls.includes('services'), false);
  }
  calls.length = 0;
  await settleBeforeStart(steps(null));
  assert.deepEqual(calls, [`port ${LANE_PORTS.server}`, `port ${LANE_PORTS.app}`, `port ${LANE_PORTS.redis}`, 'engines', 'services']);
});

test('Delete is held up by a service this lane started, after the ports, and keeps engine blockers first', async () => {
  let servicesCalled = 0;
  const services = async () => {
    servicesCalled += 1;
    return [
      { service: 'sbx', label: "Docker's sbx daemon", result: 'kept', blocksDelete: true, reason: 'a sandbox is still running (alpha)', check: 'check it', recordPath: '/x/.batshit-sbx-daemon-launch.json' },
      { service: 'apple-container', label: "Apple's container system", result: 'not-ours', blocksDelete: false }
    ];
  };
  await assert.rejects(
    settleBeforeDelete({ isFree: async (port) => port !== LANE_PORTS.app, busy: () => new Error('busy'), stopLeftoverEngines: async () => [], stopLeftoverServices: services }),
    /busy/
  );
  assert.equal(servicesCalled, 0);
  const blocking = await settleBeforeDelete({
    isFree: async () => true,
    busy: () => new Error('unexpected'),
    stopLeftoverEngines: async () => [{ pid: 1, result: 'kept-by-choice', label: 'voice engine "keep"' }],
    stopLeftoverServices: services
  });
  assert.deepEqual(blocking.map((entry) => entry.label), ['voice engine "keep"', "Docker's sbx daemon"]);
});

test('Delete\'s refusal says what holds it up and what to do, without the words that stop a step', () => {
  const text = describeServicesBlockingDelete([
    { label: "Docker's sbx daemon", result: 'kept', reason: 'a sandbox is still running (alpha)', check: 'check it with "sbx daemon status"', recordPath: '/d/.batshit-sbx-daemon-launch.json' },
    { label: "Apple's container system", result: 'did-not-stop', reason: 'it did not stop (still registered)', check: 'check it with "container system status"' },
    { label: "Apple's container system", result: 'none', sandboxesNotRemoved: ['batshit-apple-sandbox-m3-b'] },
    { label: "Docker's sbx daemon", result: 'unknown', reason: 'its record could not be read', check: 'check it', recordPath: '/d/.batshit-sbx-daemon-launch.json' }
  ]);
  assert.match(text, /Docker's sbx daemon, which a record says this Batshit started, was not stopped \(a sandbox is still running \(alpha\)\)/);
  assert.match(text, /If you want it kept running for your own use, or you are sure it is not running, remove \/d\/\.batshit-sbx-daemon-launch\.json first; Batshit will then never stop it\./);
  assert.match(text, /Apple's container system, which a record says this Batshit started, was not stopped \(it did not stop/);
  assert.match(text, /could not be removed \(batshit-apple-sandbox-m3-b\): remove them with "container delete --force <name>"/);
  assert.match(text, /Docker's sbx daemon, which a record says this Batshit started, could not be checked \(its record could not be read\)/);
  assert.doesNotMatch(text, ERROR_WORDS);
});

test('the lane needs its owner to settle anything', async () => {
  const where = await lane();
  const load = async () => {
    throw new Error('nothing may load without an owner');
  };
  await assert.rejects(settleLeftoverSandboxServices({ paths: where.paths, owner: '', say: () => {}, load }), /owner is required/);
});
