import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  attemptSafeRedisShutdown,
  auditElectronPackage,
  cleanupAbandonedRedisTempSnapshots,
  chooseRedisShutdownMode,
  createServiceDefinitions,
  ensureDurableEncryptionKey,
  executeOrderedRuntimeStop,
  isRedisTempSnapshotName,
  publishJsonAtomically,
  redisStatusProvesStopped
} from './mac-runtime-supervisor.mjs';

async function writeElectronPackageFixture(root, { omit = null } = {}) {
  const resources = join(root, 'Contents', 'Resources');
  const framework = join(root, 'Contents', 'Frameworks', 'Electron Framework.framework');
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, 'app.asar'), 'immutable shell');
  for (const relative of [
    'Versions/A/Electron Framework',
    'Versions/A/Resources/icudtl.dat',
    'Versions/A/Resources/chrome_100_percent.pak',
    'Versions/A/Resources/en.lproj/locale.pak'
  ]) {
    if (relative === omit) continue;
    const path = join(framework, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'runtime');
  }
  for (const helperName of [
    'Batshit Helper',
    'Batshit Helper (GPU)',
    'Batshit Helper (Plugin)',
    'Batshit Helper (Renderer)'
  ]) {
    const helperContents = join(
      root,
      'Contents',
      'Frameworks',
      `${helperName}.app`,
      'Contents'
    );
    await mkdir(join(helperContents, 'MacOS'), { recursive: true });
    await writeFile(join(helperContents, 'MacOS', helperName), 'helper');
    await writeFile(join(helperContents, 'Info.plist'), '<plist/>');
  }
}

test('Electron package audit accepts the standard hidden-helper packaging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-electron-package-'));
  await writeElectronPackageFixture(root);

  assert.deepEqual(await auditElectronPackage(root), []);
});

test('Electron package audit fails when its pinned Chromium runtime is incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-electron-incomplete-'));
  await writeElectronPackageFixture(root, { omit: 'Versions/A/Resources/icudtl.dat' });

  assert.deepEqual(await auditElectronPackage(root), [
    'The Electron package is missing required Chromium runtime file: Versions/A/Resources/icudtl.dat'
  ]);
});

const healthyAofInfo = {
  aof_enabled: '1',
  aof_last_write_status: 'ok',
  aof_last_bgrewrite_status: 'ok',
  loading: '0'
};

test('Mac encryption key is persisted separately and remains stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-mac-encryption-key-'));
  const keyPath = join(root, 'api-key-encryption.key');
  const values = new Map([['ENCRYPTION_KEY', 'a'.repeat(48)]]);

  assert.deepEqual(await ensureDurableEncryptionKey(values, { keyPath }), {
    changed: false,
    source: 'runtime-key'
  });
  assert.equal((await readFile(keyPath, 'utf8')).trim(), 'a'.repeat(48));
  assert.deepEqual(await ensureDurableEncryptionKey(values, { keyPath }), {
    changed: false,
    source: 'runtime-and-durable-key'
  });
});

test('Mac encryption key recovers from the durable copy when runtime.env loses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-mac-encryption-recovery-'));
  const keyPath = join(root, 'api-key-encryption.key');
  await writeFile(keyPath, `${'b'.repeat(48)}\n`, { mode: 0o600 });
  const values = new Map();

  assert.deepEqual(await ensureDurableEncryptionKey(values, { keyPath }), {
    changed: true,
    source: 'durable-key'
  });
  assert.equal(values.get('ENCRYPTION_KEY'), 'b'.repeat(48));
});

test('Mac encryption key mismatch fails closed before provider keys appear missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-mac-encryption-mismatch-'));
  const keyPath = join(root, 'api-key-encryption.key');
  await writeFile(keyPath, `${'c'.repeat(48)}\n`, { mode: 0o600 });
  const values = new Map([['ENCRYPTION_KEY', 'd'.repeat(48)]]);

  await assert.rejects(
    ensureDurableEncryptionKey(values, { keyPath }),
    /refused to start instead of making them appear missing/
  );
});

test('packaged batshit-server is required to use the managed Redis service', () => {
  const definitions = createServiceDefinitions(new Map());
  assert.equal(definitions.batshitServer.env.BATSHIT_REDIS_REQUIRED, 'true');
});

test('failed NOSAVE retries SAVE and never needs a force-kill path', async () => {
  let alive = true;
  const modes = [];
  const result = await attemptSafeRedisShutdown({
    pid: 42,
    initialMode: 'NOSAVE',
    isAlive: () => alive,
    waitForExit: async () => !alive,
    runShutdown: async (mode) => {
      modes.push(mode);
      if (mode === 'SAVE') alive = false;
      return mode === 'SAVE'
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: 'AOF persistence error' };
    }
  });

  assert.deepEqual(modes, ['NOSAVE', 'SAVE']);
  assert.equal(result.stopped, true);
  assert.equal(result.effectiveMode, 'SAVE');
  assert.equal(result.forceTerminationRefused, undefined);
});

test('failed durable Redis shutdown leaves the process alive and retryable', async () => {
  const result = await attemptSafeRedisShutdown({
    pid: 42,
    initialMode: 'SAVE',
    isAlive: () => true,
    waitForExit: async () => false,
    runShutdown: async () => ({ ok: false, stdout: '', stderr: 'RDB write failed' })
  });

  assert.equal(result.stopped, false);
  assert.equal(result.forceTerminationRefused, true);
  assert.deepEqual(result.attempts, [{ mode: 'SAVE', ok: false, error: 'RDB write failed' }]);
});

test('uses NOSAVE only after a healthy durable-AOF preflight', () => {
  assert.deepEqual(
    chooseRedisShutdownMode({
      appendonly: 'yes',
      appendfsync: 'everysec',
      info: healthyAofInfo
    }),
    { mode: 'NOSAVE', durableAofVerified: true, reasons: [] }
  );
});

test('falls back to SAVE for every uncertain or unhealthy AOF state', () => {
  for (const candidate of [
    { appendonly: 'no', appendfsync: 'everysec', info: healthyAofInfo },
    { appendonly: 'yes', appendfsync: 'no', info: healthyAofInfo },
    { appendonly: 'yes', appendfsync: 'everysec', info: { ...healthyAofInfo, aof_enabled: '0' } },
    {
      appendonly: 'yes',
      appendfsync: 'everysec',
      info: { ...healthyAofInfo, aof_last_write_status: 'err' }
    },
    { appendonly: 'yes', appendfsync: 'everysec', info: {}, error: 'INFO failed' }
  ]) {
    const policy = chooseRedisShutdownMode(candidate);
    assert.equal(policy.mode, 'SAVE');
    assert.equal(policy.durableAofVerified, false);
    assert.ok(policy.reasons.length > 0);
  }
});

test('strict temp snapshot classifier never matches dump or malformed names', () => {
  assert.equal(isRedisTempSnapshotName('temp-123.rdb'), true);
  for (const name of ['dump.rdb', 'temp-.rdb', 'temp-abc.rdb', 'temp-123.rdb.bak', '../temp-1.rdb']) {
    assert.equal(isRedisTempSnapshotName(name), false);
  }
});

test('cleanup removes only inactive regular temp snapshots after stop proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-redis-temp-cleanup-'));
  await writeFile(join(root, 'temp-123.rdb'), 'abandoned');
  await writeFile(join(root, 'temp-abc.rdb'), 'preserve malformed');
  await writeFile(join(root, 'dump.rdb'), 'preserve dump');
  await symlink(join(root, 'dump.rdb'), join(root, 'temp-456.rdb'));

  const result = await cleanupAbandonedRedisTempSnapshots({
    dataDir: root,
    redisIsStopped: true,
    isFileOpen: async () => false
  });

  assert.deepEqual(result.removed, ['temp-123.rdb']);
  assert.equal(result.bytesRemoved, Buffer.byteLength('abandoned'));
  assert.equal((await readFile(join(root, 'dump.rdb'), 'utf8')), 'preserve dump');
  assert.equal((await readFile(join(root, 'temp-abc.rdb'), 'utf8')), 'preserve malformed');
  assert.equal((await readFile(join(root, 'temp-456.rdb'), 'utf8')), 'preserve dump');
});

test('cleanup refuses to run without explicit stopped-state proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-redis-temp-refusal-'));
  await writeFile(join(root, 'temp-123.rdb'), 'preserve');

  await assert.rejects(
    cleanupAbandonedRedisTempSnapshots({
      dataDir: root,
      redisIsStopped: false,
      isFileOpen: async () => false
    }),
    /only after Redis is proven stopped or successful recovery is verified/
  );
  assert.equal(await readFile(join(root, 'temp-123.rdb'), 'utf8'), 'preserve');
});

test('cleanup reports and preserves an exact temp snapshot that is still open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-redis-temp-open-'));
  await writeFile(join(root, 'temp-123.rdb'), 'active');

  const result = await cleanupAbandonedRedisTempSnapshots({
    dataDir: root,
    redisIsStopped: true,
    isFileOpen: async () => true
  });

  assert.deepEqual(result.removed, []);
  assert.equal(result.issues.length, 1);
  assert.equal(await readFile(join(root, 'temp-123.rdb'), 'utf8'), 'active');
});

test('cleanup fails closed when open-file inspection cannot prove inactivity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-redis-temp-lsof-failure-'));
  await writeFile(join(root, 'temp-123.rdb'), 'preserve');

  const result = await cleanupAbandonedRedisTempSnapshots({
    dataDir: root,
    redisIsStopped: true,
    isFileOpen: async () => {
      throw new Error('lsof timed out');
    }
  });

  assert.deepEqual(result.removed, []);
  assert.match(result.issues[0].error, /lsof timed out/);
  assert.equal(await readFile(join(root, 'temp-123.rdb'), 'utf8'), 'preserve');
});

test('Redis stopped proof requires both a dead process and an absent listener', () => {
  const stopped = {
    pidAlive: false,
    portOccupied: false,
    external: false,
    response: '',
    listenerInspectionOk: true,
    listener: null
  };
  assert.equal(redisStatusProvesStopped(stopped), true);
  assert.equal(redisStatusProvesStopped({ ...stopped, pidAlive: true }), false);
  assert.equal(redisStatusProvesStopped({ ...stopped, listener: { pid: 123 } }), false);
  assert.equal(redisStatusProvesStopped({ ...stopped, listenerInspectionOk: false }), false);
  assert.equal(redisStatusProvesStopped({ ...stopped, response: 'PONG' }), false);
});

test('shutdown completion JSON is published atomically without temp residue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-shutdown-completion-'));
  const target = join(root, 'shutdown-complete.json');
  await publishJsonAtomically(target, { ok: true, completedAt: 'now' });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { ok: true, completedAt: 'now' });
  assert.deepEqual(await readdir(root), ['shutdown-complete.json']);
});

test('stop ordering keeps monitor and app first, Redis last, and sweep final', async () => {
  const events = [];
  const operation = (name, value, delay = 0) => async () => {
    events.push(`${name}:start`);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    events.push(`${name}:end`);
    return value;
  };

  const results = await executeOrderedRuntimeStop({
    monitor: operation('monitor', { ok: true }),
    batshitApp: operation('app', { ok: true }),
    localRuntimes: operation('local', [], 8),
    mcpProxy: operation('mcp', { ok: true }, 5),
    batshitServer: operation('server', { ok: true }, 2),
    dockerMcpGateway: operation('gateway', { ok: true }, 1),
    redis: operation('redis', { ok: true }),
    sweep: operation('sweep', { issues: [] })
  });

  assert.ok(events.indexOf('monitor:end') < events.indexOf('app:start'));
  for (const service of ['local', 'mcp', 'server', 'gateway']) {
    assert.ok(events.indexOf('app:end') < events.indexOf(`${service}:start`));
    assert.ok(events.indexOf(`${service}:end`) < events.indexOf('redis:start'));
  }
  assert.ok(events.indexOf('redis:end') < events.indexOf('sweep:start'));
  assert.deepEqual(results.localRuntimes, []);
});
