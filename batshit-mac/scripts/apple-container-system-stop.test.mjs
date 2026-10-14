// Apple's container system at shutdown (2026-09-22, BL-62 part 2): the decision, and the stop
// through a fake `container` that keeps the rules of container 0.12.3
// (`test-fixtures/fake-apple-container.mjs`): `system start` rewrites the apiserver plist and
// registers it; `system status --format json` says running (with the app root) or unregistered;
// `system stop` stops EVERY container, then deregisters; `list --all --format json` lists them.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  APPLE_CONTAINER_CALL_TIMEOUT_MS,
  APPLE_CONTAINER_OWNER_LABEL,
  APPLE_CONTAINER_STOP_WORST_CASE_MS,
  APPLE_CONTAINER_SYSTEM_RECORD_NAME,
  APPLE_CONTAINER_SYSTEM_STOP_TIMEOUT_MS,
  appleContainerOwnerLabelValue,
  appleContainerSandboxesOwnedBy,
  appleContainerSweepTimeoutMs,
  busyAppleContainers,
  decideAppleContainerSystemStop,
  findContainerOnPath,
  readAppleContainerSystemRecord,
  readAppleContainerSystemRecordState,
  recordedStartWindow,
  registeredByRecordedCall,
  resolveAppleContainerStateDir,
  stopAppleContainerSystemIfBatshitStartedIt,
  writeAppleContainerSystemRecord
} from './apple-container-system-stop.mjs';
import { withLocalRuntimeRecordLock } from './local-voice-runtime-stop.mjs';
import { installFakeAppleContainer } from './test-fixtures/fake-apple-container.mjs';

const execFileAsync = promisify(execFile);
const OWNER = 'mac-app:/Users/x/Library/Application Support/Batshit';
// Apple dates are seconds since 2001-01-01.
const appleDate = (ms) => (ms - Date.UTC(2001, 0, 1)) / 1000;
const MINUTE = 60_000;
// BL-149: the owner label's value, worked out here on its own rather than by the code under test.
const digestOf = (owner) => createHash('sha256').update(owner).digest('hex').slice(0, 16);
const OTHER_BATSHIT = 'native:4242:1758459739000';
// A sandbox as `list --all --format json` shows it, labelled with an owner (or none).
const sandboxEntry = (id, { status = 'running', owner = OWNER, startedDate = appleDate(Date.now() - MINUTE) } = {}) => ({
  status,
  configuration: {
    id,
    labels: { 'batshit.created-at': String(Date.now() - MINUTE), ...(owner ? { 'batshit.owner': digestOf(owner) } : {}) }
  },
  startedDate
});

test('the owner label is a short digest of the owner, so any owner fits Apple\'s label rule', () => {
  assert.equal(APPLE_CONTAINER_OWNER_LABEL, 'batshit.owner');
  assert.equal(appleContainerOwnerLabelValue(OWNER), digestOf(OWNER));
  assert.match(appleContainerOwnerLabelValue('mac-app:/Users/a=b/Batshit'), /^[0-9a-f]{16}$/);
  assert.notEqual(appleContainerOwnerLabelValue(OWNER), appleContainerOwnerLabelValue(OTHER_BATSHIT));
  assert.equal(appleContainerOwnerLabelValue(`  ${OWNER} `), digestOf(OWNER));
  assert.equal(appleContainerOwnerLabelValue(null), null);
  assert.equal(appleContainerOwnerLabelValue('  '), null);
});

test('this Batshit\'s sandboxes are the Batshit-named ones carrying its owner label, in any state', () => {
  const listed = JSON.stringify([
    sandboxEntry('batshit-apple-sandbox-josh-s1-a'),
    sandboxEntry('batshit-apple-sandbox-josh-s2-b', { status: 'stopped' }),
    sandboxEntry('batshit-apple-sandbox-josh-s3-c', { owner: OTHER_BATSHIT }),
    sandboxEntry('batshit-apple-sandbox-josh-s4-d', { owner: null }),
    // The label alone does not make a container Batshit's sandbox.
    sandboxEntry('users-web')
  ]);
  assert.deepEqual(appleContainerSandboxesOwnedBy(listed, OWNER), ['batshit-apple-sandbox-josh-s1-a', 'batshit-apple-sandbox-josh-s2-b']);
  assert.deepEqual(appleContainerSandboxesOwnedBy(listed, OTHER_BATSHIT), ['batshit-apple-sandbox-josh-s3-c']);
  assert.deepEqual(appleContainerSandboxesOwnedBy(listed, null), []);
  assert.throws(() => appleContainerSandboxesOwnedBy('Error: apiserver is not running', OWNER));
});

test('the running registration is the recorded call\'s only when the plist was written during that call', () => {
  const record = { callStartedAt: '2026-09-22T13:02:19.600Z', callEndedAt: '2026-09-22T13:02:21.950Z' };
  const at = (iso) => Date.parse(iso);
  assert.equal(registeredByRecordedCall(record, at('2026-09-22T13:02:20.100Z')), true);
  assert.equal(registeredByRecordedCall(record, at('2026-09-22T13:02:21.950Z')), true);
  // A file system that keeps whole seconds dates a write during :19.6 to :19.
  assert.equal(registeredByRecordedCall(record, at('2026-09-22T13:02:19.000Z')), true);
  assert.equal(registeredByRecordedCall(record, at('2026-09-22T13:02:18.999Z')), false);
  // Someone's `system start` after Batshit's call rewrote the plist.
  assert.equal(registeredByRecordedCall(record, at('2026-09-22T13:02:21.951Z')), false);
  assert.equal(registeredByRecordedCall({}, at('2026-09-22T13:02:20.000Z')), false);
  assert.equal(registeredByRecordedCall(record, Number.NaN), false);
});

test('busy is any container not stopped, and a Batshit sandbox still starting', () => {
  const now = Date.parse('2026-09-22T14:00:00.000Z');
  const entry = (id, status, extra = {}) => ({ status, configuration: { id, labels: extra.labels ?? {} }, startedDate: extra.startedDate ?? null });
  const listed = JSON.stringify([
    entry('users-web', 'running'),
    entry('users-db', 'stopping'),
    entry('odd', 'unknown'),
    entry('users-old', 'stopped', { startedDate: appleDate(now - 3_600_000) }),
    // Starting: Apple lists it stopped with no startedDate, and its stamp is recent.
    entry('batshit-apple-sandbox-user-s1-a', 'stopped', { labels: { 'batshit.created-at': String(now - 30_000) } }),
    // Never started and stamped long ago: dead, not busy.
    entry('batshit-apple-sandbox-user-s2-b', 'stopped', { labels: { 'batshit.created-at': String(now - 11 * MINUTE) } }),
    // Ran and stopped.
    entry('batshit-apple-sandbox-user-s3-c', 'stopped', { startedDate: appleDate(now - MINUTE) }),
    // No stamp, never started: an older Batshit's leftover.
    entry('batshit-apple-sandbox-user-s4-d', 'stopped')
  ]);
  assert.deepEqual(busyAppleContainers(listed, now), ['users-web', 'users-db', 'odd', 'batshit-apple-sandbox-user-s1-a']);
  assert.deepEqual(busyAppleContainers('[]', now), []);
  assert.throws(() => busyAppleContainers('Error: apiserver is not running', now));
  assert.throws(() => busyAppleContainers('{"status":"running"}', now));
});

test('the decision: nothing without a record, never another Batshit\'s, never a system started since', () => {
  const record = { launchedBy: OWNER, callStartedAt: '2026-09-22T13:02:19.600Z', callEndedAt: '2026-09-22T13:02:21.950Z' };
  const ours = { state: 'running', registeredAtMs: Date.parse('2026-09-22T13:02:20.500Z') };
  const later = { state: 'running', registeredAtMs: Date.parse('2026-09-22T15:00:00.000Z') };

  assert.deepEqual(decideAppleContainerSystemStop({ record: null, system: ours, owner: OWNER }), { action: 'none', verdict: 'absent' });
  // An unreadable record is kept (BL-1256): it may name a system still running.
  assert.equal(decideAppleContainerSystemStop({ record: { invalid: true }, system: ours, owner: OWNER }).action, 'keep');
  assert.deepEqual(decideAppleContainerSystemStop({ record, system: ours, owner: OWNER }), { action: 'check-containers' });
  assert.equal(decideAppleContainerSystemStop({ record, system: later, owner: OWNER }).action, 'drop-record');
  assert.equal(decideAppleContainerSystemStop({ record, system: { state: 'unregistered' }, owner: OWNER }).action, 'drop-record');
  // Registered but not answering: its containers cannot be checked, so it stays, with its record.
  assert.equal(decideAppleContainerSystemStop({ record, system: { state: 'not-running' }, owner: OWNER }).action, 'keep');

  const native = { ...record, launchedBy: 'native:4242:1758459739000' };
  assert.equal(decideAppleContainerSystemStop({ record: native, system: ours, owner: OWNER }).action, 'keep');
  assert.equal(
    decideAppleContainerSystemStop({ record: native, system: ours, owner: OWNER, ownerIsGone: () => true }).action,
    'check-containers'
  );
  const { launchedBy: _unused, ...unmarked } = record;
  assert.equal(decideAppleContainerSystemStop({ record: unmarked, system: ours, owner: OWNER }).action, 'check-containers');
});

test('the state folder defaults under ~/.batshit/runtime and honors an override', () => {
  assert.match(resolveAppleContainerStateDir(undefined), /\/\.batshit\/runtime\/apple-container$/);
  assert.equal(resolveAppleContainerStateDir('/tmp/x/apple-container'), '/tmp/x/apple-container');
});

// ---- Through the fake `container` ---------------------------------------------------------------

const sandbox = await mkdtemp(join(tmpdir(), 'batshit-apple-container-stop-'));
const fake = await installFakeAppleContainer(sandbox);
Object.assign(process.env, fake.env);
// The fake comes first on PATH for the whole file, ahead of the fallback folder that holds Apple's
// real CLI: a broken runner (or a mutation run) must never reach the real `container system stop`.
process.env.PATH = `${fake.binDir}${delimiter}${process.env.PATH ?? ''}`;
test.after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function freshStateDir(name) {
  const dir = join(sandbox, 'state', name);
  await mkdir(dir, { recursive: true });
  return dir;
}

// What the app and the supervisor do: time the `system start`, and record that call.
async function batshitStartsTheSystem(stateDir, launchedBy = OWNER, containerPath = fake.container) {
  const callStartedAt = Date.now();
  await execFileAsync(fake.container, ['system', 'start']);
  const callEndedAt = Date.now();
  await writeAppleContainerSystemRecord(stateDir, { launchedBy, callStartedAt, callEndedAt, containerPath });
}

async function fresh(name) {
  await fake.reset();
  return freshStateDir(name);
}

test('the container a PATH finds is recorded as PATH names it', () => {
  assert.equal(findContainerOnPath(`/nonexistent${delimiter}${fake.binDir}`), fake.container);
  assert.equal(findContainerOnPath('/nonexistent'), null);
});

test('quitting stops the system Batshit\'s own call started, with container system stop, and drops the record', async () => {
  const stateDir = await fresh('ours');
  await batshitStartsTheSystem(stateDir);
  await fake.setContainers([{ status: 'stopped', configuration: { id: 'batshit-apple-sandbox-x', labels: {} }, startedDate: appleDate(Date.now() - MINUTE) }]);
  await fake.clearCalls();

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.deepEqual(result, { action: 'stopped', ok: true, verdict: 'stopped' });
  assert.equal(await fake.registered(), false);
  assert.deepEqual(await fake.calls(), [
    'system status --format json',
    'list --all --format json',
    'system stop',
    'system status --format json'
  ]);
  assert.deepEqual(await readdir(stateDir), []);
});

test('a system the user started is never touched: there is no record, and no `container` call', async () => {
  const stateDir = await fresh('users');
  await execFileAsync(fake.container, ['system', 'start']);
  await fake.setContainers([sandboxEntry('users-web', { owner: null })]);
  await fake.clearCalls();

  assert.deepEqual(await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER }), { action: 'none', verdict: 'absent' });
  assert.equal(await fake.registered(), true);
  assert.deepEqual(await fake.calls(), []);

  // With its app down, the quit also looks for this Batshit's sandboxes, and finds none here.
  assert.deepEqual(await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true }), { action: 'none', verdict: 'absent' });
  assert.deepEqual(await fake.calls(), ['system status --format json', 'list --all --format json']);
  assert.deepEqual(await fake.deletedContainers(), []);
});

test('with no owner there is nothing to look for: no record means no `container` call at all', async () => {
  const stateDir = await fresh('users-no-owner');
  await execFileAsync(fake.container, ['system', 'start']);
  await fake.setContainers([sandboxEntry('batshit-apple-sandbox-josh-s1-a')]);
  await fake.clearCalls();

  assert.deepEqual(await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: null, removeOwnSandboxes: true }), { action: 'none', verdict: 'absent' });
  assert.deepEqual(await fake.calls(), []);
});

test('a `system start` since Batshit\'s makes the system not Batshit\'s: the record goes, the system stays', async () => {
  const stateDir = await fresh('restarted');
  await batshitStartsTheSystem(stateDir);
  // The user (or anyone) ran `container system start` afterwards: the plist is rewritten.
  await fake.setRegisteredAt(Date.now() + 5_000);

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.equal(result.action, 'drop-record');
  assert.match(result.reason, /started again since/);
  assert.equal(await fake.registered(), true);
  assert.ok(!(await fake.calls()).includes('system stop'));
  assert.equal(await readAppleContainerSystemRecord(stateDir), null);
});

test('a running container keeps the system, anyone\'s, and the record stays for the next quit', async () => {
  const stateDir = await fresh('busy');
  await batshitStartsTheSystem(stateDir);
  const users = { status: 'running', configuration: { id: 'users-web', labels: {} }, startedDate: appleDate(Date.now() - MINUTE) };
  await fake.setContainers([users]);

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /a container is still running \(users-web\)/);
  assert.equal(await fake.registered(), true);
  assert.deepEqual(await fake.stoppedContainers(), [], 'the user\'s container was never stopped');
  assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);

  // Once nothing runs, the next quit stops it.
  await fake.setContainers([{ ...users, status: 'stopped' }]);
  assert.equal((await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER })).action, 'stopped');
  assert.equal(await fake.registered(), false);
});

test('a Batshit sandbox another process is starting keeps the system', async () => {
  const stateDir = await fresh('starting');
  await batshitStartsTheSystem(stateDir);
  await fake.setContainers([
    { status: 'stopped', configuration: { id: 'batshit-apple-sandbox-other-s1-a', labels: { 'batshit.created-at': String(Date.now() - 2_000) } }, startedDate: null }
  ]);

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /batshit-apple-sandbox-other-s1-a/);
  assert.equal(await fake.registered(), true);
});

test('another running Batshit\'s system is left alone, without calling `container`', async () => {
  const stateDir = await fresh('theirs');
  await batshitStartsTheSystem(stateDir, `native:${process.pid}:1758459739000`, '/nonexistent/container');
  await fake.clearCalls();

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /another Batshit/);
  assert.equal(await fake.registered(), true);
  assert.deepEqual(await fake.calls(), []);

  // With its app down, only a look for this Batshit's sandboxes.
  await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true });
  assert.deepEqual(await fake.calls(), ['system status --format json', 'list --all --format json']);
});

test('a system already stopped only drops the record', async () => {
  const stateDir = await fresh('gone');
  await batshitStartsTheSystem(stateDir);
  await execFileAsync(fake.container, ['system', 'stop']);
  await fake.clearCalls();

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.equal(result.action, 'drop-record');
  assert.deepEqual(await fake.calls(), ['system status --format json']);
  assert.deepEqual(await readdir(stateDir), []);
});

test('a `system stop` that fails is reported, and the record stays', async () => {
  const stateDir = await fresh('stop-fails');
  await batshitStartsTheSystem(stateDir);
  await fake.setStopFails(true);
  try {
    const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });
    assert.equal(result.action, 'keep');
    assert.equal(result.ok, false);
    assert.match(result.reason, /did not stop/);
    assert.equal(await fake.registered(), true);
    assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
  } finally {
    await fake.setStopFails(false);
  }
});

test('when the recorded `container` has gone, the one PATH finds is used', async () => {
  const stateDir = await fresh('moved');
  await batshitStartsTheSystem(stateDir, OWNER, '/nonexistent/old/container');
  assert.deepEqual(await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER }), { action: 'stopped', ok: true, verdict: 'stopped' });
  assert.equal(await fake.registered(), false);
});

test('a `container list` that fails keeps the system, whatever it printed', async () => {
  const stateDir = await fresh('list-fails');
  await batshitStartsTheSystem(stateDir);
  await fake.setListFails(true);
  try {
    const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });
    assert.equal(result.action, 'keep');
    assert.match(result.reason, /could not be listed/);
    assert.equal(await fake.registered(), true);
  } finally {
    await fake.setListFails(false);
  }
});

test('the recorded `container` is run before the one PATH finds', async () => {
  const stateDir = await fresh('recorded-first');
  await batshitStartsTheSystem(stateDir);
  // A decoy first on PATH that fails every call: only the recorded one can stop the system.
  const decoyBin = join(sandbox, 'decoy-bin');
  await mkdir(decoyBin, { recursive: true });
  await writeFile(join(decoyBin, 'container'), '#!/bin/sh\necho decoy >&2\nexit 3\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${decoyBin}${delimiter}${originalPath ?? ''}`;
  try {
    assert.deepEqual(await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER }), { action: 'stopped', ok: true, verdict: 'stopped' });
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(await fake.registered(), false);
});

test('a `container` that never answers costs the quit seconds, never minutes', async () => {
  const stateDir = await fresh('stuck');
  await batshitStartsTheSystem(stateDir);
  await fake.setHang(true);
  try {
    const startedAt = Date.now();
    const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, callTimeoutMs: 500 });
    assert.equal(result.action, 'keep');
    assert.match(result.reason, /could not be checked/);
    assert.ok(Date.now() - startedAt < 3_000, `took ${Date.now() - startedAt} ms`);
    assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
  } finally {
    await fake.setHang(false);
  }
});

test('an unreadable record is kept, without calling `container` (BL-1256)', async () => {
  const stateDir = await fresh('garbage');
  await writeFile(join(stateDir, APPLE_CONTAINER_SYSTEM_RECORD_NAME), 'not json');
  await fake.clearCalls();

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });
  assert.deepEqual({ action: result.action, verdict: result.verdict }, { action: 'keep', verdict: 'unknown' });
  assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
  assert.equal(await readFile(join(stateDir, APPLE_CONTAINER_SYSTEM_RECORD_NAME), 'utf8'), 'not json');
  assert.deepEqual(await fake.calls(), []);

  // With its app down, it costs only the look for this Batshit's sandboxes: the system is not
  // running (the fake starts unregistered), so there is nothing to list; the record still stays.
  const swept = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true });
  assert.equal(swept.verdict, 'unknown');
  assert.deepEqual(await fake.calls(), ['system status --format json']);
  assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
});

// ---- BL-149: the sandboxes this Batshit left running --------------------------------------------
// A quit in the middle of a run never gets that run's cleanup, and the app's prune removes only dead
// sandboxes, so the run's sandbox ran on, and kept the system up, until the chat's next turn.

const CHAT = 'batshit-apple-sandbox-josh-s1a2b3c4d-0f1e2d3c4b';
const RECOVERED = 'batshit-apple-sandbox-josh-0f1e2d3c4b';

test('quitting removes the sandboxes this Batshit left running, then stops the system its call started', async () => {
  const stateDir = await fresh('sweep-ours');
  await batshitStartsTheSystem(stateDir);
  await fake.setContainers([sandboxEntry(CHAT), sandboxEntry(RECOVERED)]);
  await fake.clearCalls();

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true });

  assert.deepEqual(result, { action: 'stopped', ok: true, verdict: 'stopped', sandboxes: { removed: [CHAT, RECOVERED] } });
  assert.deepEqual(await fake.deletedContainers(), [CHAT, RECOVERED]);
  // Removed before the system stop, not stopped by it.
  assert.deepEqual(await fake.stoppedContainers(), []);
  assert.deepEqual(await fake.calls(), [
    'system status --format json',
    'list --all --format json',
    `delete --force ${CHAT} ${RECOVERED}`,
    'system stop',
    'system status --format json'
  ]);
  assert.equal(await fake.registered(), false);
  assert.deepEqual(await readdir(stateDir), []);
});

test('never removes a sandbox that is not this Batshit\'s: another Batshit\'s, an older unlabelled one, a user\'s', async () => {
  const stateDir = await fresh('sweep-mixed');
  await batshitStartsTheSystem(stateDir);
  const others = [
    sandboxEntry('batshit-apple-sandbox-josh-s9-other', { owner: OTHER_BATSHIT }),
    sandboxEntry('batshit-apple-sandbox-josh-s8-older', { owner: null }),
    sandboxEntry('users-web', { owner: null }),
    // A user's container that happens to carry the label is still not a Batshit sandbox.
    sandboxEntry('users-db')
  ];
  await fake.setContainers([sandboxEntry(CHAT), ...others]);

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /a container is still running \(batshit-apple-sandbox-josh-s9-other, batshit-apple-sandbox-josh-s8-older, users-web, users-db\)/);
  assert.deepEqual(result.sandboxes, { removed: [CHAT] });
  assert.deepEqual(await fake.deletedContainers(), [CHAT]);
  assert.deepEqual((await fake.containers()).map((entry) => entry.configuration.id), others.map((entry) => entry.configuration.id));
  assert.equal(await fake.registered(), true);
  assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
});

test('removes its own sandboxes even when the system is not its to stop', async () => {
  // The user started the system: no record.
  let stateDir = await fresh('sweep-users-system');
  await execFileAsync(fake.container, ['system', 'start']);
  await fake.setContainers([sandboxEntry(CHAT), sandboxEntry('users-web', { owner: null })]);
  await fake.clearCalls();

  assert.deepEqual(await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true }), {
    action: 'none',
    verdict: 'absent',
    sandboxes: { removed: [CHAT] }
  });
  assert.ok(!(await fake.calls()).includes('system stop'));
  assert.equal(await fake.registered(), true);

  // Another running Batshit started it: its record stays, and so does the system.
  stateDir = await fresh('sweep-theirs');
  await batshitStartsTheSystem(stateDir, `native:${process.pid}:1758459739000`);
  await fake.setContainers([sandboxEntry(CHAT)]);

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /another Batshit/);
  assert.deepEqual(result.sandboxes, { removed: [CHAT] });
  assert.equal(await fake.registered(), true);
  assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
});

test('a sandbox it could not remove is reported, keeps the system, and fails the quit step', async () => {
  const stateDir = await fresh('sweep-fails');
  await batshitStartsTheSystem(stateDir);
  await fake.setContainers([sandboxEntry(CHAT)]);
  await fake.setDeleteFails(true);
  try {
    const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true });

    assert.equal(result.action, 'keep');
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(`a container is still running \\(${CHAT}\\)`));
    assert.deepEqual(result.sandboxes.removed, []);
    assert.deepEqual(result.sandboxes.notRemoved, [CHAT]);
    assert.match(result.sandboxes.reason, /failed to delete one or more containers/);
    assert.equal(await fake.registered(), true);
    assert.deepEqual(await fake.stoppedContainers(), []);
    assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
  } finally {
    await fake.setDeleteFails(false);
  }
});

test('some removed and some not: each is told apart by what `delete` printed', async () => {
  const stateDir = await fresh('sweep-partial');
  await batshitStartsTheSystem(stateDir);
  await fake.setContainers([sandboxEntry(CHAT), sandboxEntry(RECOVERED)]);
  // Apple deletes each id on its own and prints each one it deleted, then exits 1 for the rest.
  await fake.setDeleteFailsFor([RECOVERED]);
  try {
    const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true });

    assert.equal(result.ok, false);
    assert.deepEqual(result.sandboxes.removed, [CHAT]);
    assert.deepEqual(result.sandboxes.notRemoved, [RECOVERED]);
    assert.equal(result.action, 'keep');
    assert.match(result.reason, new RegExp(`a container is still running \\(${RECOVERED}\\)`));
    assert.deepEqual(await fake.deletedContainers(), [CHAT]);
  } finally {
    await fake.setDeleteFailsFor(null);
  }
});

test('the removal fits inside the stop\'s own time budget: a slow delete is cut off and reported', async () => {
  const stateDir = await fresh('sweep-slow');
  await batshitStartsTheSystem(stateDir, OWNER, '/nonexistent/container');
  await fake.setContainers([sandboxEntry(CHAT)]);
  await fake.setDeleteDelay(20_000);
  try {
    const callTimeoutMs = 1_500;
    const stopTimeoutMs = 3_000;
    const startedAt = Date.now();
    const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true, callTimeoutMs, stopTimeoutMs });
    const took = Date.now() - startedAt;

    // The budget is the stop's worst case before the sweep existed: three bounded calls and the stop.
    assert.ok(took < 3 * callTimeoutMs + stopTimeoutMs, `took ${took} ms`);
    assert.equal(result.ok, false);
    assert.deepEqual(result.sandboxes.notRemoved, [CHAT]);
    assert.match(result.sandboxes.reason, /did not answer in time/);
    assert.equal(result.action, 'keep');
    assert.equal(await fake.registered(), true);
  } finally {
    await fake.setDeleteDelay(null);
  }
});

// Review finding 1: the quit step runs whatever the app's stop answered, and an app that did not
// stop may still be running a command in its sandbox. Only a caller that knows its app is down asks
// for the sweep; otherwise its own running sandbox keeps the system, as before BL-149.
test('without the app known to be down, its own running sandbox is left alone and keeps the system', async () => {
  const stateDir = await fresh('sweep-app-alive');
  await batshitStartsTheSystem(stateDir);
  await fake.setContainers([sandboxEntry(CHAT)]);
  await fake.clearCalls();

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER });

  assert.deepEqual(result, { action: 'keep', verdict: 'kept', reason: `a container is still running (${CHAT})` });
  assert.deepEqual(await fake.deletedContainers(), []);
  assert.deepEqual(await fake.calls(), ['system status --format json', 'list --all --format json']);
  assert.equal(await fake.registered(), true);
});

// Review finding 4: the list does not need the apiserver's registration file, only the stop does.
test('a registration that cannot be read still lets the sweep run; the system stays, as cautious as before', async () => {
  const stateDir = await fresh('sweep-no-plist');
  await batshitStartsTheSystem(stateDir);
  await fake.setContainers([sandboxEntry(CHAT)]);
  await rm(fake.plist, { force: true });

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true });

  assert.equal(result.action, 'keep');
  assert.match(result.reason, /it could not be checked: the apiserver registration .*apiserver\.plist could not be read/);
  assert.deepEqual(result.sandboxes, { removed: [CHAT] });
  assert.deepEqual(await fake.deletedContainers(), [CHAT]);
  assert.equal(await fake.registered(), true);
  assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
  assert.ok(!(await fake.calls()).includes('system stop'));
});

test('the decision never stops a system whose registration could not be read', () => {
  const record = { launchedBy: OWNER, callStartedAt: '2026-09-22T13:02:19.600Z', callEndedAt: '2026-09-22T13:02:21.950Z' };
  const decision = decideAppleContainerSystemStop({
    record,
    system: { state: 'running', registrationError: 'container system status named no app root' },
    owner: OWNER
  });
  assert.deepEqual(decision, { action: 'keep', verdict: 'unknown', reason: 'it could not be checked: container system status named no app root' });
});

test('the whole stop, sweep included, keeps the worst case the native launcher waits for', () => {
  assert.equal(APPLE_CONTAINER_STOP_WORST_CASE_MS, 3 * APPLE_CONTAINER_CALL_TIMEOUT_MS + APPLE_CONTAINER_SYSTEM_STOP_TIMEOUT_MS);
  // The delete gets what is left once the stop (10 s) and the status after it (4 s) are set aside.
  const startedAt = 1_000_000;
  const deadline = startedAt + APPLE_CONTAINER_STOP_WORST_CASE_MS;
  assert.equal(appleContainerSweepTimeoutMs(deadline, startedAt + 100, 4_000, 10_000), 7_900);
  // Never 0 or less, which `execFile` would read as no limit at all.
  assert.equal(appleContainerSweepTimeoutMs(deadline, deadline - 14_000, 4_000, 10_000), 1);
  assert.equal(appleContainerSweepTimeoutMs(deadline, deadline, 4_000, 10_000), 1);
});

test('a computer with no `container` at all: nothing to look for, and nothing to say', async () => {
  const stateDir = await fresh('sweep-no-cli');
  const originalPath = process.env.PATH;
  process.env.PATH = join(sandbox, 'no-container-here');
  try {
    assert.deepEqual(await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true, fallbackPathDirs: [] }), { action: 'none', verdict: 'absent' });
  } finally {
    process.env.PATH = originalPath;
  }
});

test('a system that does not answer: the look for this Batshit\'s sandboxes says it could not look', async () => {
  const stateDir = await fresh('sweep-hang');
  await execFileAsync(fake.container, ['system', 'start']);
  await fake.setHang(true);
  try {
    const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, removeOwnSandboxes: true, callTimeoutMs: 500 });
    assert.equal(result.action, 'none');
    assert.match(result.sandboxes.reason, /could not be looked for: container system status failed \(it did not answer in time\)/);
    assert.equal(result.ok, undefined);
  } finally {
    await fake.setHang(false);
  }
});

test('the record is replaced whole: a new file renamed over the old, never rewritten in place', async () => {
  const stateDir = await fresh('atomic');
  const write = (callStartedAt) =>
    writeAppleContainerSystemRecord(stateDir, {
      launchedBy: OWNER,
      callStartedAt,
      callEndedAt: callStartedAt + 2_350,
      containerPath: '/usr/local/bin/container'
    });
  const recordPath = join(stateDir, APPLE_CONTAINER_SYSTEM_RECORD_NAME);
  await write(Date.parse('2026-09-22T13:02:19.600Z'));
  const first = await stat(recordPath);
  await write(Date.parse('2026-09-22T14:00:00.000Z'));
  const second = await stat(recordPath);

  // A write in place keeps the file (its inode); a replacement is a new file renamed over it.
  assert.notEqual(second.ino, first.ino);
  assert.deepEqual(await readAppleContainerSystemRecord(stateDir), {
    launchedBy: OWNER,
    callStartedAt: '2026-09-22T14:00:00.000Z',
    callEndedAt: '2026-09-22T14:00:02.350Z',
    containerPath: '/usr/local/bin/container'
  });
  assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);

  // A folder that cannot take a new file: the write fails, and the old record stays as it was.
  const before = await readFile(recordPath, 'utf8');
  await chmod(stateDir, 0o555);
  try {
    await assert.rejects(write(Date.parse('2026-09-22T15:00:00.000Z')));
  } finally {
    await chmod(stateDir, 0o755);
  }
  assert.equal(await readFile(recordPath, 'utf8'), before);
  assert.deepEqual(await readdir(stateDir), [APPLE_CONTAINER_SYSTEM_RECORD_NAME]);
});

// The fake itself must keep Apple's rule that makes this whole check necessary: `system stop`
// stops every container, the user's too.
test('fixture check: the fake\'s system stop stops every running container, as 0.12.3 does', async () => {
  await fake.reset();
  await execFileAsync(fake.container, ['system', 'start']);
  await fake.setContainers([{ status: 'running', configuration: { id: 'users-web', labels: {} }, startedDate: 1 }]);
  await execFileAsync(fake.container, ['system', 'stop']);
  assert.deepEqual(await fake.stoppedContainers(), ['users-web']);
  assert.equal(await fake.registered(), false);
});

// ---- What is not known is kept, and an effect acts only on the admitted record (BL-1255/1256/1257) ----

const RECORD = APPLE_CONTAINER_SYSTEM_RECORD_NAME;
const verdictOf = (result) => ({ action: result.action, verdict: result.verdict });

function replaceRecordSync(stateDir, content) {
  writeFileSync(join(stateDir, `${RECORD}.replacement.tmp`), content);
  renameSync(join(stateDir, `${RECORD}.replacement.tmp`), join(stateDir, RECORD));
}

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

test('the record reader: only "no such file" is absent; anything unreadable is unknown (BL-1256)', async () => {
  const base = await fresh('reader');
  assert.deepEqual(await readAppleContainerSystemRecordState(join(base, 'none')), { state: 'absent' });
  const makers = {
    directory: async (dir) => mkdir(join(dir, RECORD), { recursive: true }),
    unreadable: async (dir) => {
      await writeFile(join(dir, RECORD), JSON.stringify({ launchedBy: OWNER }));
      await chmod(join(dir, RECORD), 0o000);
    },
    empty: async (dir) => writeFile(join(dir, RECORD), ''),
    malformed: async (dir) => writeFile(join(dir, RECORD), '{ "x": '),
    array: async (dir) => writeFile(join(dir, RECORD), '[]')
  };
  for (const [name, make] of Object.entries(makers)) {
    const dir = join(base, name);
    await mkdir(dir, { recursive: true });
    await make(dir);
    const read = await readAppleContainerSystemRecordState(dir);
    assert.equal(read.state, 'unknown', name);
    assert.equal((await readAppleContainerSystemRecord(dir)).invalid, true, name);
    await chmod(join(dir, RECORD), 0o755);
  }
  const dir = join(base, 'present');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, RECORD), JSON.stringify({ launchedBy: OWNER }));
  const read = await readAppleContainerSystemRecordState(dir);
  assert.equal(read.state, 'present');
  assert.equal(read.generation.ino, (await stat(join(dir, RECORD))).ino);
});

test('an unreadable record (a folder in its place) is kept and no `container` is asked, under either policy', async () => {
  const stateDir = await fresh('record-is-folder');
  await mkdir(join(stateDir, RECORD), { recursive: true });
  await fake.clearCalls();
  for (const ownerPolicy of ['legacy', 'exact']) {
    assert.deepEqual(verdictOf(await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy })), { action: 'keep', verdict: 'unknown' });
  }
  assert.deepEqual(await fake.calls(), []);
  assert.deepEqual(await readdir(stateDir), [RECORD]);
});

test('a record whose call times cannot be read never stops the system (BL-1255)', async () => {
  const stateDir = await fresh('bad-times');
  await execFileAsync(fake.container, ['system', 'start']);
  await writeFile(join(stateDir, RECORD), JSON.stringify({ launchedBy: OWNER, callStartedAt: 'soon', callEndedAt: 'later', containerPath: fake.container }));
  assert.equal(recordedStartWindow({ callStartedAt: 'soon', callEndedAt: 'later' }), null);
  await fake.clearCalls();
  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /no readable call time/);
  assert.equal(await fake.registered(), true);
  assert.ok(!(await fake.calls()).includes('system stop'));
  assert.deepEqual(await readdir(stateDir), [RECORD]);
});

test('the exact owner policy never stops the system on an unmarked record, but still sweeps this owner\'s own sandboxes', async () => {
  const stateDir = await fresh('exact-unmarked');
  await batshitStartsTheSystem(stateDir, null);
  await fake.setContainers([sandboxEntry(CHAT, { status: 'running', owner: OWNER })]);
  await fake.clearCalls();
  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact', removeOwnSandboxes: true });
  assert.equal(result.verdict, 'not-ours');
  assert.deepEqual(result.sandboxes, { removed: [CHAT] }, 'its own sandbox goes by its label, not by the record');
  assert.equal(await fake.registered(), true);
  assert.ok(!(await fake.calls()).includes('system stop'));
  assert.deepEqual(await readdir(stateDir), [RECORD]);
  await assert.rejects(stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: null, ownerPolicy: 'exact' }), /needs an owner/);
});

test('a record replaced between the decision and the stop is never stopped on or removed (BL-1257)', async () => {
  const replacements = {
    unmarked: (record) => JSON.stringify({ callStartedAt: record.callStartedAt, callEndedAt: record.callEndedAt }),
    malformed: () => '{ "launchedBy": ',
    'same-times': (record) => JSON.stringify({ ...record, note: 'a newer call with the same times' })
  };
  for (const [name, replacementFor] of Object.entries(replacements)) {
    for (const ownerPolicy of ['legacy', 'exact']) {
      const stateDir = await fresh(`replaced-${name}-${ownerPolicy}`);
      await batshitStartsTheSystem(stateDir);
      const original = JSON.parse(await readFile(join(stateDir, RECORD), 'utf8'));
      const replacement = replacementFor(original);
      await fake.clearCalls();
      // `now` is read after the container list, between the decision and the stop.
      const result = await stopAppleContainerSystemIfBatshitStartedIt({
        stateDir,
        owner: OWNER,
        ownerPolicy,
        now: () => {
          replaceRecordSync(stateDir, replacement);
          return Date.now();
        }
      });
      assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' }, `${name} ${ownerPolicy}`);
      assert.match(result.reason, /record changed while it was being checked/);
      assert.ok(!(await fake.calls()).includes('system stop'), `${name} ${ownerPolicy}: no stop on a replaced record`);
      assert.equal(await fake.registered(), true);
      assert.equal(await readFile(join(stateDir, RECORD), 'utf8'), replacement);
    }
  }
});

test('a record rewritten in place (the same file, new bytes) between the decision and the stop is never stopped on (BL-1257)', async () => {
  const stateDir = await fresh('rewritten-in-place');
  await batshitStartsTheSystem(stateDir);
  const recordPath = join(stateDir, RECORD);
  const replacement = JSON.stringify({ ...JSON.parse(await readFile(recordPath, 'utf8')), note: 'rewritten in place' });
  const inode = (await stat(recordPath)).ino;
  await fake.clearCalls();
  const result = await stopAppleContainerSystemIfBatshitStartedIt({
    stateDir,
    owner: OWNER,
    ownerPolicy: 'exact',
    now: () => {
      writeFileSync(recordPath, replacement);
      return Date.now();
    }
  });
  assert.equal((await stat(recordPath)).ino, inode, 'the fixture kept the same file');
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' });
  assert.ok(!(await fake.calls()).includes('system stop'));
  assert.equal(await fake.registered(), true);
  assert.equal(await readFile(recordPath, 'utf8'), replacement);
});

test('a record replaced while Apple reports the system unregistered is not removed; one left alone is (BL-1257)', async () => {
  // A `container` that answers through the fake, after replacing the record the first time it is asked.
  let stateDir = await fresh('drop-replaced');
  const wrapper = join(sandbox, 'replacing-container');
  const replacement = JSON.stringify({ launchedBy: OWNER, callStartedAt: new Date().toISOString(), callEndedAt: new Date().toISOString(), note: 'newer' });
  await writeFile(
    wrapper,
    `#!${process.execPath}
const fs = require('fs')
const { spawnSync } = require('child_process')
const record = ${JSON.stringify(join(stateDir, RECORD))}
fs.writeFileSync(record + '.tmp', ${JSON.stringify(replacement)})
fs.renameSync(record + '.tmp', record)
const run = spawnSync(${JSON.stringify(fake.container)}, process.argv.slice(2), { encoding: 'utf8', env: process.env })
process.stdout.write(run.stdout || '')
process.stderr.write(run.stderr || '')
process.exit(run.status ?? 1)
`
  );
  await chmod(wrapper, 0o755);
  const hourAgo = Date.now() - 3_600_000;
  await writeAppleContainerSystemRecord(stateDir, { launchedBy: OWNER, callStartedAt: hourAgo, callEndedAt: hourAgo + 1_000, containerPath: wrapper });
  let result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' });
  assert.equal(await readFile(join(stateDir, RECORD), 'utf8'), replacement, 'the newer record survives');

  stateDir = await fresh('drop-plain');
  await writeAppleContainerSystemRecord(stateDir, { launchedBy: OWNER, callStartedAt: hourAgo, callEndedAt: hourAgo + 1_000, containerPath: fake.container });
  result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  assert.deepEqual(verdictOf(result), { action: 'drop-record', verdict: 'gone' });
  assert.deepEqual(await readdir(stateDir), []);
});

test('checks that used up the stop\'s budget keep the system before `system stop`, inside the budget (BL-1257)', async () => {
  const stateDir = await fresh('out-of-time');
  await batshitStartsTheSystem(stateDir);
  await fake.clearCalls();
  // Budget: 3 x 1 s calls + a 1 s stop = 4 s. `now` runs after the list and burns 2.4 s of it, so what
  // is left cannot hold the stop and the check after it (2 s).
  const startedAt = Date.now();
  const result = await stopAppleContainerSystemIfBatshitStartedIt({
    stateDir,
    owner: OWNER,
    ownerPolicy: 'exact',
    callTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    now: () => {
      const until = Date.now() + 2_400;
      while (Date.now() < until);
      return Date.now();
    }
  });
  const took = Date.now() - startedAt;
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /too little of the stop's time was left/);
  assert.ok(!(await fake.calls()).includes('system stop'), 'no stop');
  assert.ok(took < 4_000, `took ${took} ms, inside the stop's one budget`);
  assert.equal(await fake.registered(), true);
  assert.deepEqual(await readdir(stateDir), [RECORD]);
});

test('a record lock held past the wait keeps everything and asks no `container`; a waiting stop reads the record again', async () => {
  let stateDir = await fresh('lock-busy');
  await batshitStartsTheSystem(stateDir);
  await fake.clearCalls();
  let holder = holdLock(stateDir, 1_000);
  await holder.acquired;
  let result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact', lockWaitMs: 300 });
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /its record could not be locked \(timed out/);
  assert.deepEqual(await fake.calls(), []);
  await holder.released;
  assert.equal(await fake.registered(), true);
  assert.deepEqual(await readdir(stateDir), [RECORD], 'no lock left behind');

  // Changed to another Batshit's while the stop waited: read again under the lock, and left alone.
  stateDir = await fresh('lock-replaced');
  await batshitStartsTheSystem(stateDir);
  const foreign = JSON.stringify({ launchedBy: OTHER_BATSHIT, callStartedAt: new Date().toISOString(), callEndedAt: new Date().toISOString() });
  holder = holdLock(stateDir, 200, async () => {
    await writeFile(join(stateDir, `${RECORD}.tmp`), foreign);
    await rename(join(stateDir, `${RECORD}.tmp`), join(stateDir, RECORD));
  });
  await holder.acquired;
  await fake.clearCalls();
  result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });
  await holder.released;
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'not-ours' });
  assert.deepEqual(await fake.calls(), []);
  assert.equal(await fake.registered(), true);
  assert.equal(await readFile(join(stateDir, RECORD), 'utf8'), foreign);
});

test('a lock with no valid owner is never taken over, and a writer waits for a held lock', async () => {
  let stateDir = await fresh('lock-ownerless');
  await batshitStartsTheSystem(stateDir);
  const lockPath = join(stateDir, '.batshit-local-runtime-launch.lock');
  await writeFile(lockPath, 'not an owner');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact', lockWaitMs: 300 });
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /no valid owner; refusing unsafe takeover/);
  assert.equal(await readFile(lockPath, 'utf8'), 'not an owner');

  stateDir = await fresh('writer-waits');
  const holder = holdLock(stateDir, 400);
  await holder.acquired;
  const startedAt = Date.now();
  await writeAppleContainerSystemRecord(stateDir, { launchedBy: OWNER, callStartedAt: Date.now(), callEndedAt: Date.now(), containerPath: fake.container });
  assert.ok(Date.now() - startedAt >= 300, 'the writer waited for the lock');
  await holder.released;
  assert.deepEqual(await readdir(stateDir), [RECORD]);
});

test('a record replaced while `system stop` runs is never removed, though the system went (BL-1257)', async () => {
  const stateDir = await fresh('replaced-during-stop');
  await batshitStartsTheSystem(stateDir);
  const recordPath = join(stateDir, RECORD);
  const original = JSON.parse(await readFile(recordPath, 'utf8'));
  const replacement = JSON.stringify({ ...original, note: 'written while the system stopped' });
  // A `container` that answers through the fake, and replaces the record when asked to stop the system.
  const wrapper = join(sandbox, 'replacing-on-stop-container');
  await writeFile(
    wrapper,
    `#!${process.execPath}
const fs = require('fs')
const { spawnSync } = require('child_process')
const args = process.argv.slice(2)
if (args.join(' ') === 'system stop') {
  fs.writeFileSync(${JSON.stringify(recordPath)} + '.tmp', ${JSON.stringify(replacement)})
  fs.renameSync(${JSON.stringify(recordPath)} + '.tmp', ${JSON.stringify(recordPath)})
}
const run = spawnSync(${JSON.stringify(fake.container)}, args, { encoding: 'utf8', env: process.env })
process.stdout.write(run.stdout || '')
process.stderr.write(run.stderr || '')
process.exit(run.status ?? 1)
`
  );
  await chmod(wrapper, 0o755);
  writeFileSync(recordPath, JSON.stringify({ ...original, containerPath: wrapper }));
  const admitted = await readFile(recordPath, 'utf8');
  await fake.clearCalls();

  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerPolicy: 'exact' });

  assert.ok((await fake.calls()).includes('system stop'), 'the system was stopped');
  assert.equal(await fake.registered(), false);
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' });
  assert.match(result.reason, /it was stopped, but its record changed before it could be removed/);
  assert.notEqual(await readFile(recordPath, 'utf8'), admitted);
  assert.equal(await readFile(recordPath, 'utf8'), replacement, 'the newer record survives');
});

test('a failure inside the locked check is reported as such, not as a lock it could not take', async () => {
  const stateDir = await fresh('settle-throws');
  await batshitStartsTheSystem(stateDir, 'native:1:1');
  let asked = 0;
  const ownerIsGone = () => {
    asked += 1;
    if (asked > 1) throw new Error('the owner check failed');
    return true;
  };
  await fake.clearCalls();
  const result = await stopAppleContainerSystemIfBatshitStartedIt({ stateDir, owner: OWNER, ownerIsGone });
  assert.ok(asked >= 2);
  assert.deepEqual(verdictOf(result), { action: 'keep', verdict: 'unknown' });
  assert.equal(result.reason, 'it could not be settled (the owner check failed)');
  assert.ok(!(await fake.calls()).includes('system stop'));
  assert.deepEqual(await readdir(stateDir), [RECORD]);
});
