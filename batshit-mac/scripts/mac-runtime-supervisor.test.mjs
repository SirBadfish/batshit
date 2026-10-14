import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runtimeFingerprintFiles,
  auditAnchoredProjectReader,
  attemptSafeRedisShutdown,
  auditManagedNodeRuntime,
  auditElectronPackage,
  cleanupAbandonedRedisTempSnapshots,
  chooseRedisShutdownMode,
  classifyAppleContainerStatus,
  createServiceDefinitions,
  doctorAdvice,
  ensureDurableEncryptionKey,
  evaluateLiveServiceUnhealthyGrace,
  dockerMcpGatewayMetadataIsCurrent,
  dockerMcpGatewayRunArgs,
  executeOrderedRuntimeStop,
  isRedisTempSnapshotName,
  packageIdentityIssues,
  publishJsonAtomically,
  readInfoPlistBundleIdentifier,
  redisStatusProvesStopped,
  startAppleContainer,
  testPackageFolderRefusal
} from './mac-runtime-supervisor.mjs';
import { macPackageIdentity } from './package-mac-app.mjs';

test('anchored reader package audit pins source content and an executable artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-anchored-reader-audit-'));
  const scripts = join(root, 'batshit-app', 'scripts');
  try {
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'anchored-project-reader.c'), 'trusted source');
    const machOHeader = Buffer.from('cffaedfe', 'hex');
    await writeFile(join(scripts, 'anchored-project-reader'), machOHeader, { mode: 0o755 });
    const { createHash } = await import('node:crypto');
    const entry = {
      contract: 'bl320/1', source: 'batshit-app/scripts/anchored-project-reader.c',
      sourceSha256: createHash('sha256').update('trusted source').digest('hex'),
      executable: 'batshit-app/scripts/anchored-project-reader', platform: 'darwin',
      architecture: 'arm64', minimumMacosVersion: '14.0'
    };
    assert.deepEqual(await auditAnchoredProjectReader(root, entry), []);
    await writeFile(join(scripts, 'anchored-project-reader'), 'binary');
    assert.match((await auditAnchoredProjectReader(root, entry)).join(' '), /not a Mach-O executable/);
    await writeFile(join(scripts, 'anchored-project-reader'), machOHeader);
    await writeFile(join(scripts, 'anchored-project-reader.c'), 'replaced');
    assert.match((await auditAnchoredProjectReader(root, entry)).join(' '), /hash differs/);
    await rm(join(scripts, 'anchored-project-reader'));
    assert.match((await auditAnchoredProjectReader(root, entry)).join(' '), /missing, empty, or not executable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an anchored reader change restarts packaged services', () => {
  assert.ok(runtimeFingerprintFiles().some(path => path.endsWith('/batshit-app/scripts/anchored-project-reader')));
});

test('live services tolerate one long in-flight operation before restart', () => {
  const first = evaluateLiveServiceUnhealthyGrace(null, 1_000, 180_000);
  assert.deepEqual(first, {
    unhealthySince: 1_000,
    elapsedMs: 0,
    remainingMs: 180_000,
    shouldRestart: false
  });

  assert.deepEqual(evaluateLiveServiceUnhealthyGrace(first.unhealthySince, 180_999, 180_000), {
    unhealthySince: 1_000,
    elapsedMs: 179_999,
    remainingMs: 1,
    shouldRestart: false
  });
  assert.equal(
    evaluateLiveServiceUnhealthyGrace(first.unhealthySince, 181_000, 180_000).shouldRestart,
    true
  );
});

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

test('managed Node runtime audit proves preserved npm and npx launchers execute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-managed-node-'));
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'lib'), { recursive: true });
  await symlink(process.execPath, join(root, 'bin', 'node'));
  await writeFile(join(root, 'lib', 'npm-cli.mjs'), "console.log('10.0.0')\n");
  await symlink('../lib/npm-cli.mjs', join(root, 'bin', 'npm'));
  await symlink('../lib/npm-cli.mjs', join(root, 'bin', 'npx'));

  assert.deepEqual(await auditManagedNodeRuntime(root), []);
});

test('managed Node runtime audit rejects dereferenced npm launchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-managed-node-flat-'));
  await mkdir(join(root, 'bin'), { recursive: true });
  await symlink(process.execPath, join(root, 'bin', 'node'));
  await writeFile(join(root, 'bin', 'npm'), "console.log('10.0.0')\n");
  await writeFile(join(root, 'bin', 'npx'), "console.log('10.0.0')\n");

  assert.deepEqual(await auditManagedNodeRuntime(root), [
    'Managed Node runtime must preserve the official bin/npm symlink.',
    'Managed Node runtime must preserve the official bin/npx symlink.'
  ]);
});

test('managed Node runtime audit rejects npm links that escape the app bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-managed-node-external-link-'));
  await mkdir(join(root, 'bin'), { recursive: true });
  await symlink(process.execPath, join(root, 'bin', 'node'));
  await symlink('/tmp/npm-cli.js', join(root, 'bin', 'npm'));
  await symlink('/tmp/npx-cli.js', join(root, 'bin', 'npx'));

  assert.deepEqual(await auditManagedNodeRuntime(root), [
    'Managed Node runtime bin/npm must remain a relative link inside the app-owned Node runtime.',
    'Managed Node runtime bin/npx must remain a relative link inside the app-owned Node runtime.'
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

test('packaged file service and MCP stdio children log outside the signed app', () => {
  const definitions = createServiceDefinitions(new Map());
  for (const service of [definitions.batshitServer, definitions.mcpProxy]) {
    assert.equal(service.env.BATSHIT_SERVER_LOG_DIR, dirname(service.logFile));
    assert.notEqual(service.env.BATSHIT_SERVER_LOG_DIR, service.cwd);
  }
});

test('packaged JavaScript services launch through the managed Node executable directly', () => {
  const managedNode = '/Batshit.app/Contents/Resources/runtime/vendor/node/bin/node';
  const definitions = createServiceDefinitions(new Map(), {
    useProductionApp: true,
    nodeCommand: managedNode
  });

  assert.equal(definitions.batshitApp.command, managedNode);
  assert.equal(definitions.batshitServer.command, managedNode);
  assert.equal(definitions.mcpProxy.command, managedNode);
  assert.equal(definitions.batshitApp.args[0], 'build');
  assert.ok(!Object.values(definitions).some((definition) => definition.command === 'npm'));
});

test('the streamable MCP helper is started to listen on this computer only', async () => {
  // supergateway has no listen-address option and serves Batshit's MCP tools with no login, so
  // the launch preloads batshit-server's loopbackListen.cjs, which binds it to 127.0.0.1.
  const definitions = createServiceDefinitions(new Map());
  const { args, cwd, matchCommandFragments } = definitions.mcpProxy;
  assert.equal(args[0], '-r');
  assert.equal(args[1], join(cwd, 'src', 'mcp', 'loopbackListen.cjs'));
  assert.ok((await readFile(args[1], 'utf8')).includes('127.0.0.1'), 'the preload ships inside batshit-server/src');
  assert.equal(args[2], 'node_modules/supergateway/dist/index.js');
  assert.ok(matchCommandFragments.includes('supergateway'));
  // An update that changes only the preload still restarts the helper.
  assert.ok(runtimeFingerprintFiles().includes(args[1]));
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

test('a stop step that throws never skips Redis or the final sweep', async () => {
  // Bug sweep (2026-09-18): the concurrent group ran under `Promise.all`, so one throw there
  // skipped Redis's clean shutdown and the sweep that proves nothing managed survived.
  const events = [];
  const operation = (name, value) => async () => {
    events.push(name);
    return value;
  };
  const throwing = (name) => async () => {
    events.push(name);
    throw new Error(`${name} broke`);
  };

  const results = await executeOrderedRuntimeStop({
    monitor: throwing('monitor'),
    batshitApp: operation('app', { ok: true }),
    localRuntimes: throwing('local'),
    mcpProxy: operation('mcp', { ok: true }),
    batshitServer: throwing('server'),
    dockerMcpGateway: operation('gateway', { ok: true }),
    sbxDaemon: throwing('sbx'),
    appleContainerSystem: throwing('apple'),
    redis: operation('redis', { ok: true }),
    sweep: throwing('sweep')
  });

  for (const step of ['monitor', 'app', 'local', 'mcp', 'server', 'gateway', 'sbx', 'apple', 'redis', 'sweep']) {
    assert.ok(events.includes(step), `${step} ran`);
  }
  assert.ok(events.indexOf('redis') > events.indexOf('server'));
  assert.deepEqual(results.monitor, { ok: false, error: 'monitor broke' });
  assert.deepEqual(results.localRuntimes, [{ ok: false, error: 'local broke' }]);
  assert.deepEqual(results.batshitServer, { ok: false, error: 'server broke' });
  assert.deepEqual(results.sbxDaemon, { ok: false, error: 'sbx broke' });
  assert.deepEqual(results.appleContainerSystem, { ok: false, error: 'apple broke' });
  assert.deepEqual(results.redis, { ok: true });
  assert.deepEqual(results.sweep, { issues: ['The final sweep failed: sweep broke'] });
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
    sbxDaemon: operation('sbx', { action: 'none' }, 30),
    appleContainerSystem: operation('apple', { action: 'none' }, 40),
    redis: operation('redis', { ok: true }),
    sweep: operation('sweep', { issues: [] })
  });

  assert.ok(events.indexOf('monitor:end') < events.indexOf('app:start'));
  for (const service of ['local', 'mcp', 'server', 'gateway']) {
    assert.ok(events.indexOf('app:end') < events.indexOf(`${service}:start`));
    assert.ok(events.indexOf(`${service}:end`) < events.indexOf('redis:start'));
  }
  // Docker's sbx daemon is stopped only after the app, whose calls could start another sandbox,
  // and a slow `sbx` never holds up Redis's clean shutdown.
  assert.ok(events.indexOf('app:end') < events.indexOf('sbx:start'));
  assert.ok(events.indexOf('redis:end') < events.indexOf('sbx:end'));
  assert.deepEqual(results.sbxDaemon, { action: 'none' });
  // Apple's container system the same way (BL-62 part 2): only once the app, which starts
  // sandboxes, is down, and a slow `container` never holds up Redis.
  assert.ok(events.indexOf('app:end') < events.indexOf('apple:start'));
  assert.ok(events.indexOf('redis:end') < events.indexOf('apple:end'));
  assert.deepEqual(results.appleContainerSystem, { action: 'none' });
  assert.ok(events.indexOf('redis:end') < events.indexOf('sweep:start'));
  assert.deepEqual(results.localRuntimes, []);
});

// Review finding 1 (BL-149): the Apple step decides from the app's own stop whether the app is down,
// so it is handed that result.
test('the Apple Container step is handed the app\'s stop result', async () => {
  const appResult = { skipped: true, reason: 'Batshit App has no pid file.' };
  let handed = 'not called';
  await executeOrderedRuntimeStop({
    monitor: async () => ({ ok: true }),
    batshitApp: async () => appResult,
    localRuntimes: async () => [],
    mcpProxy: async () => ({ ok: true }),
    batshitServer: async () => ({ ok: true }),
    dockerMcpGateway: async () => ({ ok: true }),
    sbxDaemon: async () => ({ action: 'none' }),
    appleContainerSystem: async (app) => {
      handed = app;
      return { action: 'none' };
    },
    redis: async () => ({ ok: true }),
    sweep: async () => ({ issues: [] })
  });
  assert.equal(handed, appResult);
});

// BL-83: Runtime Doctor says the true thing for each Apple Container state. Since BL-62 part 1 a
// stopped system is usable (the first sandboxed command starts it), so only a missing CLI and a
// `system status` that does not answer need the user.
const APPLE_VERSION_RUN = {
  ok: true,
  code: 0,
  signal: null,
  stdout: 'container CLI version 0.12.3 (build: release, commit: f989901)\n',
  stderr: ''
};
// `container system status` on a stopped system, as the 0.12.3 CLI answers it: exit 1. The words
// contain "running", so the exit code has to decide.
const APPLE_STOPPED_STATUS_RUN = {
  ok: false,
  code: 1,
  signal: null,
  stdout: 'apiserver is not running and not registered with launchd\n',
  stderr: ''
};
const APPLE_RUNNING_STATUS_RUN = {
  ok: true,
  code: 0,
  signal: null,
  stdout: 'FIELD              VALUE\nstatus             running\nappRoot            /Users/tester/Library/Application Support/com.apple.container/\n',
  stderr: ''
};
// Killed at its time limit: no exit code of its own.
const APPLE_HUNG_STATUS_RUN = { ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: '' };

const APPLE_CONTAINER_STATES = {
  'not installed': classifyAppleContainerStatus({
    platform: 'darwin',
    versionRun: { ok: false, code: 1, signal: null, stdout: '', stderr: 'spawn container ENOENT' }
  }),
  'installed, not started': classifyAppleContainerStatus({
    platform: 'darwin',
    versionRun: APPLE_VERSION_RUN,
    statusRun: APPLE_STOPPED_STATUS_RUN
  }),
  running: classifyAppleContainerStatus({
    platform: 'darwin',
    versionRun: APPLE_VERSION_RUN,
    statusRun: APPLE_RUNNING_STATUS_RUN
  }),
  'installed, not answering': classifyAppleContainerStatus({
    platform: 'darwin',
    versionRun: APPLE_VERSION_RUN,
    statusRun: APPLE_HUNG_STATUS_RUN
  })
};

function healthyDoctorReport(appleContainer) {
  const tool = { available: true, healthy: true };
  const service = { healthy: true, pidAlive: true };
  return {
    tools: {
      node: tool,
      npm: tool,
      redisCli: tool,
      ffmpeg: tool,
      appleContainer,
      docker: tool,
      dockerMcpToolkit: tool
    },
    services: {
      redis: { ...service, external: false, portOccupied: false },
      batshitServer: service,
      mcpProxy: service,
      batshitApp: service,
      dockerMcpGateway: service
    },
    monitor: { running: true, state: { services: {} } }
  };
}

function appleContainerActions(appleContainer) {
  return doctorAdvice(healthyDoctorReport(appleContainer)).filter((action) =>
    action.id.startsWith('apple-container')
  );
}

test('Apple Container status: a stopped system is installed, answering, and usable (BL-83)', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(APPLE_CONTAINER_STATES).map(([state, status]) => [
        state,
        {
          available: status.available,
          installed: status.installed,
          healthy: status.healthy,
          systemRunning: status.systemRunning
        }
      ])
    ),
    {
      'not installed': { available: false, installed: false, healthy: false, systemRunning: false },
      'installed, not started': { available: true, installed: true, healthy: true, systemRunning: false },
      running: { available: true, installed: true, healthy: true, systemRunning: true },
      'installed, not answering': { available: true, installed: true, healthy: false, systemRunning: false }
    }
  );
  assert.equal(APPLE_CONTAINER_STATES['installed, not started'].error, null);
  assert.equal(APPLE_CONTAINER_STATES.running.version, 'container CLI version 0.12.3 (build: release, commit: f989901)');
  assert.match(APPLE_CONTAINER_STATES['installed, not answering'].error, /did not answer/);
  assert.deepEqual(
    classifyAppleContainerStatus({ platform: 'linux' }),
    {
      label: 'Apple Container',
      available: false,
      installed: false,
      supported: false,
      healthy: false,
      systemRunning: false,
      version: null,
      error: 'Apple Container is only supported on macOS.',
      installUrl: 'https://github.com/apple/container/releases/latest'
    }
  );
});

// BL-83 review: only Apple's own "stopped" answer is an answer. 0.12.3 (SystemStatus.swift) exits 1
// with "apiserver is not running and not registered with launchd" for a stopped system; a registered
// apiserver that does not answer its ping prints "apiserver is not running", and an XPC or launchd
// error prints its own words. Those are a broken install, not a stopped one.
test('Apple Container status: only Apple\'s own stopped answer is stopped; any other failure is not answering', () => {
  const failing = (stdout, stderr) =>
    classifyAppleContainerStatus({
      platform: 'darwin',
      versionRun: APPLE_VERSION_RUN,
      statusRun: { ok: false, code: 1, signal: null, stdout, stderr }
    });
  const xpc = failing('', 'Error: XPC connection error: Connection invalid\n');
  assert.deepEqual(
    { available: xpc.available, installed: xpc.installed, healthy: xpc.healthy, systemRunning: xpc.systemRunning },
    { available: true, installed: true, healthy: false, systemRunning: false }
  );
  assert.match(xpc.error, /XPC connection error: Connection invalid/);
  const silent = failing('apiserver is not running\n', '');
  assert.equal(silent.healthy, false);
  assert.match(silent.error, /apiserver is not running/);

  const actions = appleContainerActions(xpc);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'apple-container-not-answering');
  assert.match(actions[0].detail, /XPC connection error/);
  assert.equal(actions[0].repairCommand, 'appleContainerStart');
});

test('Runtime Doctor warns about Apple Container only when it is missing or not answering (BL-83)', () => {
  const missing = appleContainerActions(APPLE_CONTAINER_STATES['not installed']);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'apple-container-missing');
  assert.equal(missing[0].severity, 'warning');
  assert.match(missing[0].detail, /fail until it is installed/);
  assert.match(missing[0].detail, /Batshit starts it with the first sandboxed command/);
  assert.equal(missing[0].externalUrl, 'https://github.com/apple/container/releases/latest');

  // Installed and not started is the normal resting state: nothing to fix, nothing to start.
  assert.deepEqual(appleContainerActions(APPLE_CONTAINER_STATES['installed, not started']), []);
  assert.deepEqual(appleContainerActions(APPLE_CONTAINER_STATES.running), []);

  const hung = appleContainerActions(APPLE_CONTAINER_STATES['installed, not answering']);
  assert.equal(hung.length, 1);
  assert.equal(hung[0].id, 'apple-container-not-answering');
  assert.equal(hung[0].severity, 'warning');
  assert.match(hung[0].detail, /did not answer/);
  assert.match(hung[0].detail, /fail until it answers/);
  assert.equal(hung[0].repairCommand, 'appleContainerStart');

  // The old words claimed a stopped system breaks runs.
  for (const status of Object.values(APPLE_CONTAINER_STATES)) {
    for (const action of appleContainerActions(status)) {
      assert.doesNotMatch(action.detail, /installed and running/);
      assert.doesNotMatch(action.detail, /start the Apple Container system/);
    }
  }
});

test('Start Apple Container starts a stopped system, records that start, and leaves a running one alone (BL-83, BL-62)', async () => {
  const commands = [];
  let startCalledAt = 0;
  const runCommand = async (command, args) => {
    commands.push(`${command} ${args.join(' ')}`);
    if (args.join(' ') === 'system start --disable-kernel-install') {
      startCalledAt = Date.now();
      await new Promise((done) => setTimeout(done, 20));
    }
    return { ok: true, code: 0, signal: null, stdout: '', stderr: '' };
  };
  // Never the real recorder here: it would write into the real ~/.batshit.
  const recorded = [];
  const recordStart = async (window) => {
    recorded.push(window);
  };

  // A stopped system is healthy (usable) now; the start still has to happen, so it reads systemRunning.
  const stoppedThenRunning = [APPLE_CONTAINER_STATES['installed, not started'], APPLE_CONTAINER_STATES.running];
  const started = await startAppleContainer({ readStatus: async () => stoppedThenRunning.shift(), runCommand, recordStart });
  // BL-129: Apple's start never gets to ask for a kernel on stdin.
  assert.deepEqual(commands, ['container system start --disable-kernel-install']);
  assert.equal(started.ok, true);
  assert.equal(started.skipped, false);
  // One record, whose window holds the `system start` call.
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0].callStartedAt <= startCalledAt && startCalledAt <= recorded[0].callEndedAt);
  assert.ok(recorded[0].callEndedAt - recorded[0].callStartedAt >= 15);

  commands.length = 0;
  recorded.length = 0;
  const skipped = await startAppleContainer({ readStatus: async () => APPLE_CONTAINER_STATES.running, runCommand, recordStart });
  assert.deepEqual(commands, []);
  assert.equal(skipped.skipped, true);
  assert.deepEqual(recorded, [], 'a system already running is not Batshit\'s start');

  // A start that leaves it stopped is a failure, even though the stopped system is "healthy",
  // and it records nothing.
  const stillStopped = await startAppleContainer({
    readStatus: async () => APPLE_CONTAINER_STATES['installed, not started'],
    runCommand,
    recordStart
  });
  assert.equal(stillStopped.ok, false);
  assert.equal(stillStopped.error, 'Apple Container did not start.');
  assert.deepEqual(recorded, []);

  // Review: a system that was not answering (a hung status, or a registered apiserver that did not
  // reply) may be the user's. The Start button still tries to repair it, but its `system start`
  // rewrites the plist inside Batshit's window, so recording it would make Batshit stop the user's
  // system at quit. Only Apple's own stopped answer before the start is Batshit's start.
  commands.length = 0;
  const notAnsweringThenRunning = [APPLE_CONTAINER_STATES['installed, not answering'], APPLE_CONTAINER_STATES.running];
  const repaired = await startAppleContainer({ readStatus: async () => notAnsweringThenRunning.shift(), runCommand, recordStart });
  assert.deepEqual(commands, ['container system start --disable-kernel-install']);
  assert.equal(repaired.ok, true);
  assert.deepEqual(recorded, [], 'a repair of a system that did not answer is not recorded');
});

test('the runtime stop runs the Apple Container system step (BL-62)', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'mac-runtime-supervisor.mjs'), 'utf8');
  const stopAt = source.indexOf('\nasync function stop() {\n');
  const endAt = source.indexOf('\n}\n', stopAt);
  const body = source.slice(stopAt, endAt);
  assert.ok(body.includes('stopRedis(env)'), 'the pin reads the real stop function');
  // BL-149 review: the step is handed the app's stop result and sweeps only when the app is down.
  assert.ok(
    body.includes(
      '\n    appleContainerSystem: (batshitApp) => stopAppleContainerSystemStartedByThisApp(env, { appStop: batshitApp }),\n'
    )
  );
  assert.ok(body.includes('\n      results.appleContainerSystem,\n'), 'a failed Apple stop makes the stop not ok');
});

// BL-62 part 2: the packaged app no longer starts Apple's container system at launch; the first
// sandboxed command does, and records it. `start` spawns every service, so its body is pinned.
test('the runtime start no longer starts Apple\'s container system (BL-62)', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'mac-runtime-supervisor.mjs'), 'utf8');
  const startAt = source.indexOf('\nasync function start() {\n');
  const endAt = source.indexOf('\n}\n', startAt);
  assert.ok(startAt > 0 && endAt > startAt);
  const body = source.slice(startAt, endAt);
  assert.ok(body.includes('startRedis(env)'), 'the pin reads the real start function');
  assert.ok(!body.includes('startAppleContainer('), 'start() calls startAppleContainer again');
  assert.ok(!body.includes("'system', 'start'"));
});


// BL-72: a test package (bundle id ai.batshit.mac.<label>) must be told its folders. Its main process
// and the lane launchers always name them; run by hand without them, the supervisor's defaults are
// the real app's folders, pid files, and Redis data.
// BL-72 review: the bundle id comes from the package's XML Info.plist, read in plain JavaScript (no
// child process on every supervisor call), and a packaged run that cannot read it refuses.
const PACKAGER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Batshit</string>
	<key>CFBundleExecutable</key>
	<string>Batshit</string>
	<key>CFBundleIdentifier</key>
	<string>ai.batshit.mac</string>
	<key>UTExportedTypeDeclarations</key>
	<array>
		<dict>
			<key>UTTypeIdentifier</key>
			<string>ai.batshit.goon-package</string>
		</dict>
	</array>
</dict>
</plist>
`;

test('the supervisor reads its bundle id from the XML Info.plist, and nothing else (BL-72 review)', () => {
  assert.equal(readInfoPlistBundleIdentifier(PACKAGER_INFO_PLIST), 'ai.batshit.mac');
  assert.equal(
    readInfoPlistBundleIdentifier(PACKAGER_INFO_PLIST.replace('<string>ai.batshit.mac</string>', '<string>ai.batshit.mac.firstruntest</string>')),
    'ai.batshit.mac.firstruntest'
  );
  // A binary plist, a plist without the key, and a value no bundle id can have are unreadable.
  assert.equal(readInfoPlistBundleIdentifier('bplist00\u0000\u0001garbage'), null);
  assert.equal(readInfoPlistBundleIdentifier('<plist><dict><key>CFBundleName</key><string>Batshit</string></dict></plist>'), null);
  assert.equal(readInfoPlistBundleIdentifier('<key>CFBundleIdentifier</key><string>ai.batshit.mac&amp;x</string>'), null);
  assert.equal(readInfoPlistBundleIdentifier(''), null);
});

test('an unreadable package plist refuses without folders; the real app and a source checkout never refuse (BL-72 review)', () => {
  const folders = {
    BATSHIT_MAC_DATA_DIR: '/lane/data',
    BATSHIT_MAC_LOG_DIR: '/lane/logs',
    BATSHIT_MAC_CACHE_DIR: '/lane/cache'
  };
  // `undefined`: a source checkout, no package at all.
  assert.equal(testPackageFolderRefusal({ bundleId: undefined, env: {} }), null);
  // `null`: a package whose plist could not be read: it cannot tell it is the real app.
  assert.match(testPackageFolderRefusal({ bundleId: null, env: {} }), /could not be read/);
  assert.equal(testPackageFolderRefusal({ bundleId: null, env: folders }), null);
});

test('a test package supervisor refuses to run without its own folders (BL-72)', () => {
  const folders = {
    BATSHIT_MAC_DATA_DIR: '/lane/data',
    BATSHIT_MAC_LOG_DIR: '/lane/logs',
    BATSHIT_MAC_CACHE_DIR: '/lane/cache'
  };
  assert.equal(testPackageFolderRefusal({ bundleId: 'ai.batshit.mac', env: {} }), null);
  assert.equal(testPackageFolderRefusal({ bundleId: 'ai.batshit.mac.firstruntest', env: folders }), null);
  assert.match(
    testPackageFolderRefusal({ bundleId: 'ai.batshit.mac.firstruntest', env: {} }),
    /test package \(ai\.batshit\.mac\.firstruntest\).*BATSHIT_MAC_DATA_DIR, BATSHIT_MAC_LOG_DIR, BATSHIT_MAC_CACHE_DIR/
  );
  assert.match(
    testPackageFolderRefusal({ bundleId: 'ai.batshit.mac.firstruntest', env: { BATSHIT_MAC_DATA_DIR: '/lane/data' } }),
    /BATSHIT_MAC_LOG_DIR, BATSHIT_MAC_CACHE_DIR/
  );
});

test('the packaged supervisor of a test package refuses before any action (BL-72)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  // The real path: the supervisor only runs when started by its own resolved path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'batshit-bl72-supervisor-')));
  try {
    const contents = join(root, 'Batshit-ZbmacProbe.app', 'Contents');
    const packagedScripts = join(contents, 'Resources', 'scripts');
    await mkdir(packagedScripts, { recursive: true });
    await mkdir(join(contents, 'Resources', 'runtime', 'batshit-app'), { recursive: true });
    await mkdir(join(contents, 'Resources', 'runtime', 'batshit-server', 'server'), { recursive: true });
    // The supervisor and every sibling it reaches, read from the real imports (as packaging copies them).
    const files = new Set();
    const queue = ['mac-runtime-supervisor.mjs'];
    while (queue.length) {
      const file = queue.shift();
      if (files.has(file)) continue;
      files.add(file);
      const source = await readFile(join(scriptsDir, file), 'utf8');
      for (const match of source.matchAll(/from '\.\/([A-Za-z0-9._-]+\.mjs)'/g)) queue.push(match[1]);
    }
    for (const file of files) {
      await copyFile(join(scriptsDir, file), join(packagedScripts, file));
    }
    const writePlist = (text) => writeFile(join(contents, 'Info.plist'), text);
    await writePlist(PACKAGER_INFO_PLIST.replace('<string>ai.batshit.mac</string>', '<string>ai.batshit.mac.zbmacprobe</string>'));
    const home = join(root, 'home');
    await mkdir(home);
    // An action the supervisor does not know: with or without the guard, nothing is started or written.
    const run = (extraEnv) => {
      const env = { ...process.env, HOME: home, ...extraEnv };
      // A node child that inherits the test runner's context reports as a test file, not as itself.
      delete env.NODE_TEST_CONTEXT;
      delete env.BATSHIT_MAC_REPO_ROOT;
      for (const key of ['BATSHIT_MAC_DATA_DIR', 'BATSHIT_MAC_LOG_DIR', 'BATSHIT_MAC_CACHE_DIR']) {
        if (!(key in extraEnv)) delete env[key];
      }
      return spawnSync(process.execPath, [join(packagedScripts, 'mac-runtime-supervisor.mjs'), 'zbmac-probe'], {
        env,
        encoding: 'utf8',
        timeout: 30_000
      });
    };
    const refused = run({});
    assert.equal(refused.status, 1, `stdout: ${refused.stdout}\nstderr: ${refused.stderr}`);
    assert.match(refused.stdout, /test package \(ai\.batshit\.mac\.zbmacprobe\)/);
    // A refused `stop` writes nothing either: its error path records completion in the data folder,
    // which without the lane's folders is the real app's (here the temporary HOME's).
    const refusedStop = spawnSync(process.execPath, [join(packagedScripts, 'mac-runtime-supervisor.mjs'), 'stop'], {
      env: (() => {
        const env = { ...process.env, HOME: home };
        for (const key of ['NODE_TEST_CONTEXT', 'BATSHIT_MAC_REPO_ROOT', 'BATSHIT_MAC_DATA_DIR', 'BATSHIT_MAC_LOG_DIR', 'BATSHIT_MAC_CACHE_DIR']) delete env[key];
        return env;
      })(),
      encoding: 'utf8',
      timeout: 30_000
    });
    assert.equal(refusedStop.status, 1);
    assert.match(refusedStop.stdout, /test package \(ai\.batshit\.mac\.zbmacprobe\)/);
    assert.deepEqual(await readdir(home), [], 'nothing was written under HOME');

    // The real app's own plist: it runs as it always has, with no folders named.
    await writePlist(PACKAGER_INFO_PLIST);
    assert.match(run({}).stdout, /Unknown supervisor action: zbmac-probe/);
    // A plist it cannot read: it cannot tell it is the real app, so it refuses rather than use the
    // real app's folders.
    await writePlist('bplist00 not the XML packaging writes');
    const unreadable = run({});
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stdout, /could not be read/);
    assert.deepEqual(await readdir(home), [], 'nothing was written under HOME');

    const told = run({
      BATSHIT_MAC_DATA_DIR: join(root, 'data'),
      BATSHIT_MAC_LOG_DIR: join(root, 'logs'),
      BATSHIT_MAC_CACHE_DIR: join(root, 'cache')
    });
    assert.match(told.stdout, /Unknown supervisor action: zbmac-probe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the source checkout\'s supervisor never refuses: it is no package (BL-72 review)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'batshit-bl72-source-')));
  try {
    const env = { ...process.env, HOME: root };
    for (const key of ['NODE_TEST_CONTEXT', 'BATSHIT_MAC_REPO_ROOT', 'BATSHIT_MAC_DATA_DIR', 'BATSHIT_MAC_LOG_DIR', 'BATSHIT_MAC_CACHE_DIR']) {
      delete env[key];
    }
    // An action the supervisor does not know: it touches nothing either way.
    const run = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'mac-runtime-supervisor.mjs'), 'zbmac-probe'], {
      env,
      encoding: 'utf8',
      timeout: 30_000
    });
    assert.match(run.stdout, /Unknown supervisor action: zbmac-probe/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the package audit requires a separate display identity and the canonical helper prefix (BL-72, BL-226)', () => {
  assert.deepEqual(packageIdentityIssues({ bundleId: 'ai.batshit.mac', displayName: 'Batshit', bundleName: 'Batshit' }), []);
  // The audit accepts exactly what packaging writes.
  for (const suffix of ['-FirstRunTest', '-SA090-R7', '-my_lane', '-v1.2']) {
    const identity = macPackageIdentity(suffix);
    assert.deepEqual(
      packageIdentityIssues({ bundleId: identity.bundleId, displayName: identity.displayName, bundleName: 'Batshit' }),
      [],
      suffix
    );
    // The former BL-72 shape passes display identity but crashes before Electron starts JS.
    assert.match(
      packageIdentityIssues({ bundleId: identity.bundleId, displayName: identity.displayName, bundleName: identity.displayName })[0],
      /keep CFBundleName "Batshit" for helper lookup/
    );
  }
  // A test package still named like the real app is the BL-72 package.
  assert.equal(
    packageIdentityIssues({ bundleId: 'ai.batshit.mac.firstruntest', displayName: 'Batshit', bundleName: 'Batshit' }).length,
    1
  );
  assert.equal(
    packageIdentityIssues({ bundleId: 'ai.batshit.mac', displayName: 'Batshit FirstRunTest', bundleName: 'Batshit FirstRunTest' }).length,
    1
  );
  assert.equal(
    packageIdentityIssues({ bundleId: 'ai.batshit.mac.firstruntest', displayName: 'Batshit OtherLane', bundleName: 'Batshit OtherLane' }).length,
    1
  );
  assert.equal(packageIdentityIssues({ bundleId: 'com.electron.batshit', displayName: 'Batshit', bundleName: 'Batshit' }).length, 1);
  assert.match(packageIdentityIssues({ bundleId: null, displayName: null, bundleName: null })[0], /could not be read/);
});

test('the package audit checks the bundle identity, and that the supervisor reads the same bundle id', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'mac-runtime-supervisor.mjs'), 'utf8');
  assert.ok(source.includes('\n  electronPackageIssues.push(\n    ...packageIdentityIssues({\n'));
  assert.ok(source.includes('\n  const supervisorReads = readInfoPlistBundleIdentifier(infoPlist);\n  if (supervisorReads !== plistBundleId) {\n'));
});

// The Docker MCP gateway started with `--port` alone listened on every network interface (`*:<port>`,
// measured by the launch helper, 2026-09-25): its token was all that kept the rest of the network
// out. It serves this Mac only (the app and n8n reach it at 127.0.0.1), so it binds loopback.
test('the Docker MCP gateway listens on this Mac only', async () => {
  assert.deepEqual(dockerMcpGatewayRunArgs(5648, 'default'), [
    'mcp', 'gateway', 'run', '--port', '5648', '--host', '127.0.0.1', '--transport', 'streaming', '--profile', 'default'
  ]);
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'mac-runtime-supervisor.mjs'), 'utf8');
  const startAt = source.indexOf('\nasync function startDetachedDockerMcpGateway(env) {\n');
  const body = source.slice(startAt, source.indexOf('\n}\n', startAt));
  assert.ok(body.includes('\n  const args = dockerMcpGatewayRunArgs(port, profile);\n'), 'the launch uses those arguments');
  assert.ok(body.includes("spawn('bash', heldStdinSpawnArgs('docker', args), {"));
});

// Review follow-up: a gateway started before the loopback bind listens on every interface, and the
// restart check compared only port, profile, and URL, so it was reused until a quit. The launch now
// records its bind host, and a gateway whose record does not name 127.0.0.1 is restarted.
test('a running gateway is current only when its launch record names the loopback bind', async () => {
  const desired = { port: 8080, profile: 'default', url: 'http://127.0.0.1:8080/mcp' };
  const current = { pid: 4242, generation: 'g', ...desired, host: '127.0.0.1' };
  assert.equal(dockerMcpGatewayMetadataIsCurrent(current, desired), true);
  const { host: _host, ...beforeTheBind } = current;
  assert.equal(dockerMcpGatewayMetadataIsCurrent(beforeTheBind, desired), false);
  assert.equal(dockerMcpGatewayMetadataIsCurrent({ ...current, host: '0.0.0.0' }, desired), false);
  assert.equal(dockerMcpGatewayMetadataIsCurrent({ ...current, port: 5648 }, desired), false);
  assert.equal(dockerMcpGatewayMetadataIsCurrent({ ...current, profile: 'other' }, desired), false);
  assert.equal(dockerMcpGatewayMetadataIsCurrent({ ...current, url: 'http://localhost:8080/mcp' }, desired), false);
  assert.equal(dockerMcpGatewayMetadataIsCurrent(null, desired), false);

  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'mac-runtime-supervisor.mjs'), 'utf8');
  const startAt = source.indexOf('\nasync function startDetachedDockerMcpGateway(env) {\n');
  const body = source.slice(startAt, source.indexOf('\n}\n', startAt));
  assert.ok(body.includes('\n        host: DOCKER_MCP_GATEWAY_HOST,\n'), 'the launch records its bind host');
  const checkAt = source.indexOf('\nasync function dockerMcpGatewayNeedsRestart(env, currentStatus) {\n');
  const check = source.slice(checkAt, source.indexOf('\n}\n', checkAt));
  assert.ok(check.includes('\n  return !dockerMcpGatewayMetadataIsCurrent(metadata, {\n'), 'the restart check asks it');
});
