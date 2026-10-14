import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertDefaultPreserved, guestNodeArgs, validateWindowsRelease, validateWslOwner, windowsPathToGuest, WSL_ASSETS, WSL_CODE_RESET_PATHS, WSL_CODE_RESET_FILES, WSL_ENV, WSL_NODE_VERSION, WSL_BOOTSTRAP_VERSION, WSL_RUNTIME_OS, assertWslRuntimeCompatible, validateFreshWslImport, codeReleaseTuple } from './windows-wsl-contract.mjs';
import { assertPhysicalPath, metadataCommand, setupElevationCommand, parseSetupOutcome, runSystemWslSetup, WindowsWslAdapter } from './windows-wsl.mjs';
import { assertGuestIdentity, guestGitArgs, resetCode } from './windows-wsl-guest.mjs';
import { checkSavedDataForInstall, prepareDataFiles } from './cli.mjs';
import { laneDataPaths } from './lane.mjs';
import { admit, releaseAdmission } from './admission.mjs';
import { upgradeNodeRuntime, maintainGuestInstallation, installGuestCode, selectMaintenanceCode } from './windows-wsl-guest.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bs-wsl-source-')));
after(() => rmSync(root, { recursive: true, force: true }));
const nonce = 'a'.repeat(32);
const commit = 'b'.repeat(40);
const ownedId = '{01234567-89ab-cdef-0123-456789abcdef}';
const foreignId = '{fedcba98-7654-3210-fedc-ba9876543210}';
const runtime = { node: WSL_NODE_VERSION, nodeSha256: WSL_ASSETS[1].sha256, bootstrap: WSL_BOOTSTRAP_VERSION, os: WSL_RUNTIME_OS, rootfsSha256: WSL_ASSETS[0].sha256 };
const protocol = { version: 1, platform: 'windows-wsl2', dataLayout: 1 };
const require = createRequire(import.meta.url);

function fixture(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const basePath = join(dir, 'distro');
  mkdirSync(basePath);
  const registry = { defaultDistribution: '{other}', distributions: [{ id: ownedId, name: 'Batshit-Pinokio', basePath, version: 2 }] };
  const owner = { version: 1, phase: 'installed', distro: 'Batshit-Pinokio', basePath, nonce, registrationId: ownedId, release: 'v0.1.0', commit, runtime, dataPresent: true };
  // Native API calls are injected here; these tests do not claim Windows/WSL execution.
  const adapter = Object.assign(Object.create(WindowsWslAdapter.prototype), {
    root: dir, basePath, marker: join(dir, 'instance.json'), sourceRoot: join(dir, 'source'),
    metadata: (pid = 0) => ({ ...registry, processBirth: pid === process.pid ? '133999000000000000' : null })
  });
  adapter.writeOwner(owner, { create: true });
  return { adapter, registry, owner, dir };
}

test('released Windows capability and tag/commit are mandatory; old release/main cannot masquerade as supported', () => {
  assert.deepEqual(validateWindowsRelease({ release: 'v0.1.0', commit, declaredRelease: 'v0.1.0\n', protocol }), { release: 'v0.1.0', commit });
  for (const change of [{ release: 'main' }, { commit: 'HEAD' }, { declaredRelease: 'v0.2.0' }, { protocol: null }, { protocol: { ...protocol, version: 2 } }]) {
    assert.throws(() => validateWindowsRelease({ release: 'v0.1.0', commit, declaredRelease: 'v0.1.0', protocol, ...change }));
  }
});

test('fresh WSL with no default accepts only no default or its first owned import; an existing default must stay identical', () => {
  assert.doesNotThrow(() => assertDefaultPreserved(null, null, ownedId));
  assert.doesNotThrow(() => assertDefaultPreserved(null, ownedId, ownedId));
  assert.doesNotThrow(() => assertDefaultPreserved('{docker}', '{docker}', ownedId));
  assert.throws(() => assertDefaultPreserved('{docker}', ownedId, ownedId));
  assert.throws(() => assertDefaultPreserved(null, '{other}', ownedId));
});

test('owned registration requires exact name/GUID/BasePath/version, never merely a matching distro name', () => {
  const { owner, registry, adapter } = fixture('registration');
  assert.equal(validateWslOwner(owner, registry, adapter.basePath).id, ownedId);
  for (const change of [{ id: foreignId }, { basePath: '/elsewhere' }, { version: 1 }]) {
    assert.throws(() => validateWslOwner(owner, { ...registry, distributions: [{ ...registry.distributions[0], ...change }] }, adapter.basePath));
  }
  assert.throws(() => validateWslOwner(owner, { ...registry, distributions: [...registry.distributions, registry.distributions[0]] }, adapter.basePath));
  assert.throws(() => validateWslOwner({ ...owner, nonce: '' }, registry, adapter.basePath));
});

test('physical path checks reject ancestor/junction-style and dangling redirects even when creation would otherwise be allowed', () => {
  const dir = join(root, 'physical'); mkdirSync(dir);
  const external = join(root, 'external'); mkdirSync(external);
  symlinkSync(external, join(dir, 'redirect'));
  symlinkSync(join(root, 'missing'), join(dir, 'dangling'));
  assert.throws(() => assertPhysicalPath(join(dir, 'redirect', 'data'), { directory: true, allowMissing: true }), /linked storage/);
  assert.throws(() => assertPhysicalPath(join(dir, 'dangling'), { allowMissing: true }), /linked storage/);
  assert.equal(assertPhysicalPath(join(dir, 'new'), { directory: true, allowMissing: true }), join(dir, 'new'));
});

test('menu status reads only host record/registry and never invokes WSL or a guest command', () => {
  const { adapter } = fixture('menu');
  adapter.runSync = () => { throw new Error('a native/guest command must not run during menu rendering'); };
  assert.deepEqual(adapter.menuState(), { installed: true, dataPresent: true, retained: true });
  rmSync(adapter.marker);
  assert.deepEqual(adapter.menuState(), { installed: false, dataPresent: false, retained: false });
});

test('ordinary menu exposes Update for retained unfinished Windows installs, with fresh/native/running routes unchanged', async () => {
  const { adapter, owner } = fixture('unfinished-menu');
  const source = readFileSync(join(import.meta.dirname, '../pinokio.js'), 'utf8');
  const info = { running: () => false, exists: () => false };
  adapter.runSync = () => { throw new Error('menu must not invoke WSL'); };
  let reads = 0;
  const loadMenu = platform => {
    const module = { exports: {} };
    const readOnlyRequire = name => name === './lib/windows-wsl-steps.cjs'
      ? { windowsMenuState: async () => { reads++; return adapter.menuState(); } }
      : require(name);
    // Execute the actual CJS menu with its ordinary read-only dependency/platform injected.
    // No process.platform mutation, vendor/guest command, import rewrite or UI controller.
    new Function('require', 'module', 'process', source)(readOnlyRequire, module, { platform });
    return module.exports.menu;
  };
  const windows = loadMenu('win32');
  for (const phase of ['created', 'ready', 'reset', 'updating']) {
    adapter.writeOwner({ ...owner, phase, dataPresent: false });
    assert.deepEqual((await windows({}, info)).map(item => item.href), ['install.js', 'update.js']);
  }
  adapter.writeOwner({ ...owner, phase: 'updating' });
  assert.deepEqual((await windows({}, info)).map(item => item.href), ['install.js', 'update.js', 'delete-data.js']);
  assert.deepEqual((await windows({}, { ...info, running: name => name === 'update.js' })).map(item => item.text), ['Updating']);
  assert.deepEqual((await windows({}, { ...info, running: name => name === 'install.js' })).map(item => item.text), ['Installing']);
  rmSync(adapter.marker);
  assert.deepEqual((await windows({}, info)).map(item => item.href), ['install.js']);
  const beforeNative = reads;
  assert.deepEqual((await loadMenu('darwin')({}, info)).map(item => item.href), ['install.js']);
  assert.deepEqual((await loadMenu('linux')({}, info)).map(item => item.href), ['install.js']);
  assert.equal(reads, beforeNative, 'native menu never queries Windows ownership');
});

test('initial ownership publication cannot replace another installer and an incomplete initial record refuses', () => {
  const { adapter, owner } = fixture('initial-owner');
  const bytes = readFileSync(adapter.marker, 'utf8');
  assert.throws(() => adapter.writeOwner({ ...owner, nonce: 'c'.repeat(32) }, { create: true }), /EEXIST/);
  assert.equal(readFileSync(adapter.marker, 'utf8'), bytes);
  writeFileSync(adapter.marker, '{');
  assert.throws(() => adapter.readOwner());
  assert.equal(readFileSync(adapter.marker, 'utf8'), '{');
});

test('general WSL status alone does not qualify WSL2 and owned setup failures remain on the explicit recovery screen', () => {
  const { adapter, registry, owner, dir } = fixture('prerequisites');
  adapter.wsl = join(dir, 'wsl.exe'); writeFileSync(adapter.wsl, 'not executed');
  const seen = [];
  adapter.probeWsl = args => { seen.push(args); return { status: args[0] === '--status' ? 0 : 1 }; };
  registry.distributions[0].version = 1;
  adapter.readOwner = () => null;
  assert.equal(adapter.prerequisites().ready, false);
  adapter.probeWsl = args => { seen.push(args); return { status: 0 }; };
  assert.equal(adapter.prerequisites().ready, true);
  adapter.readOwner = () => ({ ...owner, needsSetup: true });
  assert.deepEqual(adapter.prerequisites(), { ready: false, retrySetup: true });
  assert.ok(seen.every(args => args.length === 1 && ['--status', '--version'].includes(args[0])));
});

test('DrvFS trust is exact and command-scoped for mounted source reads/clone/fetch, never a global or guest-repo exemption', () => {
  const source = '/mnt/c/Pinokio/api/Batshit';
  const trust = ['-c', `safe.directory=${source}`, '-c', `safe.directory=${source}/.git`];
  assert.deepEqual(guestGitArgs(source, ['show', 'v0.1.0:pinokio/RELEASE'], source), [...trust, '-C', source, 'show', 'v0.1.0:pinokio/RELEASE']);
  const fetch = guestGitArgs('/home/batshit/batshit-code', ['fetch', '--tags', 'origin'], source);
  assert.deepEqual(fetch.slice(0, 7), [...trust, '-C', '/home/batshit/batshit-code', 'fetch']);
  assert.match(fetch[7], /^--upload-pack=\/usr\/bin\/git /);
  assert.ok(fetch[7].includes(`'safe.directory=${source}/.git'`));
  assert.deepEqual(fetch.slice(8), ['--tags', 'origin']);
  assert.deepEqual(guestGitArgs('/home/batshit/batshit-code', ['status']), ['-C', '/home/batshit/batshit-code', 'status']);
  for (const invalid of ['*', '/home/batshit', '/mnt/c/x\n-c safe.directory=*']) assert.throws(() => guestGitArgs(source, [], invalid));
});

test('exact command-scoped source trust permits real Git clone/upload-pack and fetch without global exceptions', () => {
  const relative = "source trust with spaces and 'apostrophe'";
  const source = join(root, relative);
  const cloned = join(root, 'source-trust-clone');
  mkdirSync(source);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' };
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  const invoke = (args, extra = {}) => spawnSync('git', args, { encoding: 'utf8', env: { ...env, ...extra } });
  const success = result => assert.equal(result.status, 0, result.stderr);
  success(invoke(['init', '--quiet', source]));
  writeFileSync(join(source, 'release'), 'first');
  success(invoke(['-C', source, 'add', '.']));
  success(invoke(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', source, 'commit', '--quiet', '-m', 'first']));
  success(invoke(['-C', source, 'tag', 'v9.1.0']));
  // Git's own t0033 uses this ownership-test flag. Only map the pure mounted-path
  // arguments onto an actual Mac/Linux temp repo; no production trust rule is relaxed.
  // https://github.com/git/git/blob/v2.47.1/t/t0033-safe-directory.sh
  const mountedPrefix = '/mnt/c/Pinokio/api/';
  const mounted = `${mountedPrefix}${relative}`;
  // Replace only the mount prefix. The product's real quoting of spaces/apostrophes
  // stays intact in the upload-pack command; no replacement builder hides quoting bugs.
  const argsFor = (directory, args) => guestGitArgs(directory, args, mounted).map(arg => arg.replaceAll(mountedPrefix, `${root}/`));
  const unowned = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  success(invoke(['-c', `safe.directory=${source}`, '-C', source, 'show', 'v9.1.0:release'], unowned));
  const oldClone = invoke(['-c', `safe.directory=${source}`, '-C', source, 'clone', '--no-hardlinks', '--no-checkout', source, cloned], unowned);
  assert.notEqual(oldClone.status, 0);
  assert.match(oldClone.stderr, /dubious ownership/);
  assert.ok(oldClone.stderr.includes(root) && oldClone.stderr.includes('/.git'));
  assert.equal(existsSync(cloned), false, 'Git must remove this failed clone before the safe retry');
  success(invoke(argsFor(mounted, ['clone', '--no-local', '--no-hardlinks', '--no-checkout', mounted, cloned]), unowned));
  success(invoke(['-C', cloned, 'checkout', '--quiet', '--detach', 'v9.1.0']));
  assert.equal(readFileSync(join(cloned, 'release'), 'utf8'), 'first');
  // Worktree trust alone must not admit a direct Git-directory read. Git 2.55's
  // upload-pack permits any owner, so it cannot supply this negative assertion.
  // https://github.com/git/git/blob/v2.55.0/builtin/upload-pack.c#L41
  const untrustedGitDirectory = invoke(['-c', `safe.directory=${source}`, '-C', `${source}/.git`, 'rev-parse', '--git-dir'], unowned);
  assert.notEqual(untrustedGitDirectory.status, 0);
  assert.match(untrustedGitDirectory.stderr, /dubious ownership/);
  // The actual product-built fetch still exercises its upload-pack child and
  // exact quoting; destination ownership stays under ordinary checks.
  const childOwnerArgs = argsFor(cloned, ['fetch', '--tags', 'origin']).map(arg => arg.startsWith('--upload-pack=') ? arg.replace('--upload-pack=', '--upload-pack=env GIT_TEST_ASSUME_DIFFERENT_OWNER=1 ') : arg);
  success(invoke(childOwnerArgs));
  const other = join(root, 'foreign-source-trust');
  success(invoke(['init', '--quiet', other]));
  const foreign = invoke(argsFor(other, ['status']), unowned);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /dubious ownership/); // No other actual repository is trusted.
  assert.equal(invoke(['-C', cloned, 'config', '--local', '--get-all', 'safe.directory']).status, 1);
  assert.equal(invoke(['-C', source, 'config', '--local', '--get-all', 'safe.directory']).status, 1);
});

test('setup lock preserves live/unknown ownership and releases its own exact record', async () => {
  const { adapter, dir } = fixture('locks');
  const lock = join(dir, 'operation.json');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, birth: '133999000000000000' }));
  await assert.rejects(adapter.withOperation(() => { throw new Error('must not act'); }), /still running/);
  rmSync(lock);
  writeFileSync(lock, JSON.stringify({ pid: 1234, birth: '133998000000000000' }));
  const metadata = adapter.metadata;
  adapter.metadata = pid => { if (pid === 1234) throw new Error('access unknown'); return metadata(pid); };
  await assert.rejects(adapter.withOperation(() => {}), /access unknown/);
  assert.equal(existsSync(lock), true);
  adapter.metadata = metadata;
  let ran = false;
  await adapter.withOperation(() => { ran = true; assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid); });
  assert.equal(ran, true);
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, JSON.stringify({ pid: 1234, birth: 'unknown' }));
  await assert.rejects(adapter.withOperation(() => {}), /unknown install operation/);
  assert.equal(existsSync(lock), true);
});

test('metadata uses only an ordinary fixed read-only command query and refuses script/PID injection', () => {
  const command = metadataCommand(1234);
  assert.match(command, /Get-ItemProperty/);
  assert.match(command, /Get-Process -Id 1234/);
  assert.match(command, /NoProcessFoundForGivenId/);
  assert.doesNotMatch(command, /Invoke-Expression|Get-Content|Set-ExecutionPolicy|EncodedCommand|Unblock|Bypass/i);
  for (const pid of ['1; stop-process', -1, NaN, 2147483648]) assert.throws(() => metadataCommand(pid));
});

test('guest launches explicitly bind distro/user/cwd and a clean fixed environment, not Windows PATH/WSLENV/credentials', () => {
  const owner = { distro: 'Batshit-Pinokio' };
  const args = guestNodeArgs(owner, '/mnt/c/Pinokio/pinokio/lib/windows-wsl-guest.mjs', ['run', nonce, '/mnt/c/Pinokio', 'redis', 'v0.1.0', commit]);
  assert.deepEqual(args.slice(0, 8), ['--distribution', 'Batshit-Pinokio', '--user', 'batshit', '--cd', '/home/batshit', '--exec', '/usr/bin/env']);
  assert.ok(args.includes('-i'));
  assert.ok(args.includes('BATSHIT_PINOKIO_HOST=windows-wsl'));
  assert.ok(args.includes('BATSHIT_PINOKIO_ENGINE_STOP_POLICY=all-owned'));
  assert.ok(args.includes('BATSHIT_PINOKIO_LAUNCH_PROFILE=windows-wsl'));
  assert.equal(Object.hasOwn(WSL_ENV, 'HOST'), false);
  assert.equal(Object.hasOwn(WSL_ENV, 'BATSHIT_TOKEN'), false);
  assert.doesNotMatch(args.join(' '), /--set-default|--shutdown|--unregister/);
  assert.equal(windowsPathToGuest('C:\\Users\\A B\\.batshit\\disk'), '/mnt/c/Users/A B/.batshit/disk');
  for (const path of ['\\\\server\\share', 'C:\\x:stream', 'C:\\x\ncommand']) assert.throws(() => windowsPathToGuest(path));
});

test('the guest ownership/user check refuses root, a different home or copied/unknown marker', () => {
  assert.doesNotThrow(() => assertGuestIdentity(nonce, { platform: 'linux', uid: 1000, home: '/home/batshit', recordedNonce: nonce }));
  for (const change of [{ uid: 0 }, { home: '/root' }, { recordedNonce: 'b'.repeat(32) }, { platform: 'win32' }]) {
    assert.throws(() => assertGuestIdentity(nonce, { platform: 'linux', uid: 1000, home: '/home/batshit', recordedNonce: nonce, ...change }));
  }
});

test('code-only Reset removes only declared generated outputs and leaves data/secrets/models/Git/release intact', async () => {
  const code = join(root, 'reset-code'); mkdirSync(code);
  const data = join(root, 'kept-data'); mkdirSync(data);
  writeFileSync(join(data, 'secret'), 'kept');
  for (const relative of WSL_CODE_RESET_PATHS) { mkdirSync(join(code, relative), { recursive: true }); writeFileSync(join(code, relative, 'generated'), 'generated'); }
  for (const relative of WSL_CODE_RESET_FILES) { mkdirSync(join(code, relative, '..'), { recursive: true }); writeFileSync(join(code, relative), 'generated executable'); }
  for (const relative of ['.git', 'models', 'pinokio/lib']) mkdirSync(join(code, relative), { recursive: true });
  writeFileSync(join(code, 'pinokio/RELEASE'), 'v0.1.0');
  await resetCode(code);
  for (const relative of [...WSL_CODE_RESET_PATHS, ...WSL_CODE_RESET_FILES]) assert.equal(existsSync(join(code, relative)), false);
  assert.equal(readFileSync(join(data, 'secret'), 'utf8'), 'kept');
  for (const relative of ['.git', 'models', 'pinokio/lib', 'pinokio/RELEASE']) assert.equal(existsSync(join(code, relative)), true);
  mkdirSync(join(code, 'pinokio/runtime'));
  rmSync(join(code, 'pinokio/runtime'), { recursive: true });
  symlinkSync(data, join(code, 'pinokio/runtime'));
  await assert.rejects(resetCode(code), /linked storage/);
  assert.equal(readFileSync(join(data, 'secret'), 'utf8'), 'kept');
});

test('Reset refuses an intermediate redirect before erasing any allowlisted output or external sentinel', async () => {
  const code = join(root, 'intermediate-code'); mkdirSync(join(code, 'pinokio/runtime'), { recursive: true });
  writeFileSync(join(code, 'pinokio/runtime/generated'), 'kept until every path is verified');
  const external = join(root, 'intermediate-external'); mkdirSync(join(external, 'node_modules'), { recursive: true });
  writeFileSync(join(external, 'node_modules/user-data'), 'external user data');
  symlinkSync(external, join(code, 'batshit-app'));
  await assert.rejects(resetCode(code), /linked storage/);
  assert.equal(readFileSync(join(code, 'pinokio/runtime/generated'), 'utf8'), 'kept until every path is verified');
  assert.equal(readFileSync(join(external, 'node_modules/user-data'), 'utf8'), 'external user data');
});

test('shared admitted data preparation keeps existing keys byte-identical and refuses damaged secrets', async () => {
  const paths = laneDataPaths(join(root, 'data-preparation'));
  await prepareDataFiles(paths);
  const before = readFileSync(paths.secretsFile, 'utf8');
  await prepareDataFiles(paths);
  assert.equal(readFileSync(paths.secretsFile, 'utf8'), before);
  writeFileSync(paths.secretsFile, 'ENCRYPTION_KEY=bad\n');
  await assert.rejects(prepareDataFiles(paths), /damaged/);
  assert.equal(readFileSync(paths.secretsFile, 'utf8'), 'ENCRYPTION_KEY=bad\n');
});

test('shared key creation refuses saved content without its original keys before any data mutation', async () => {
  const paths = laneDataPaths(join(root, 'shared-missing-keys'));
  mkdirSync(paths.redis, { recursive: true });
  mkdirSync(paths.uploads);
  writeFileSync(join(paths.redis, 'appendonly.aof'), 'saved encrypted Redis data');
  writeFileSync(join(paths.uploads, 'user-file'), 'saved user file');
  await assert.rejects(prepareDataFiles(paths), /unverified data/);
  assert.equal(existsSync(paths.secretsFile), false);
  assert.equal(existsSync(paths.logs), false);
  assert.equal(readFileSync(join(paths.redis, 'appendonly.aof'), 'utf8'), 'saved encrypted Redis data');
  assert.equal(readFileSync(join(paths.uploads, 'user-file'), 'utf8'), 'saved user file');
  const empty = laneDataPaths(join(root, 'shared-empty-keys'));
  mkdirSync(empty.redis, { recursive: true });
  await prepareDataFiles(empty);
  const keys = readFileSync(empty.secretsFile, 'utf8');
  writeFileSync(join(empty.redis, 'appendonly.aof'), 'data using the original keys');
  await prepareDataFiles(empty);
  assert.equal(readFileSync(empty.secretsFile, 'utf8'), keys);
  assert.equal(readFileSync(join(empty.redis, 'appendonly.aof'), 'utf8'), 'data using the original keys');
});

test('all pinned bootstrap downloads include concrete cache names and accepted SHA256 inputs', () => {
  assert.equal(WSL_ASSETS.length, 2);
  for (const asset of WSL_ASSETS) { assert.match(asset.sha256, /^[a-f0-9]{64}$/); assert.match(asset.file, /^[a-z0-9.-]+$/); assert.ok(asset.url.endsWith(asset.file)); }
});

test('stock start/reset/update steps use the Windows adapter while native Mac/Linux run arrays remain unchanged', async () => {
  const steps = require('./windows-wsl-steps.cjs');
  const start = await steps.windowsActionSteps('start');
  assert.match(start[0].params.message, /windows-wsl.mjs preflight$/);
  assert.match(start[1].params.message, /run redis$/);
  assert.match(start[1].params.on[0].event, /database is ready/);
  assert.equal(start[5].method, 'process.wait');
  assert.match((await steps.windowsActionSteps('reset'))[0].params.message, / reset$/);
  assert.match((await steps.windowsActionSteps('update'))[0].params.message, / update$/);
  if (process.platform !== 'win32') for (const script of ['install', 'start', 'reset', 'update', 'delete-data']) assert.equal(Array.isArray(require(`../${script}.js`).run), true);
});

test('Install separates unsupported/setup consent from ordinary install; typed input never becomes shell text', async () => {
  const { windowsActionSteps } = require('./windows-wsl-steps.cjs');
  const unsupported = await windowsActionSteps('install', { prerequisites: () => ({ unsupported: true, ready: false }) });
  assert.deepEqual(unsupported.map(step => step.method), ['shell.run','notify']);
  const setup = await windowsActionSteps('install', { prerequisites: () => ({ ready: false, retrySetup: true }) });
  assert.deepEqual(setup.map(step => step.method), ['shell.run','input','shell.run','notify']);
  assert.equal(setup[2].params.sudo, undefined);
  assert.equal(setup[2].params.env.BATSHIT_WSL_SETUP_CONFIRM, '{{input.confirm}}');
  assert.equal(setup[2].params.message, 'node lib/windows-wsl.mjs enable-wsl');
  const ready = await windowsActionSteps('install', { prerequisites: () => ({ ready: true }) });
  assert.deepEqual(ready.map(step => step.method), ['shell.run','notify','shell.run','notify']);
  assert.equal(ready[2].params.message, 'node lib/windows-wsl.mjs install');
  assert.equal(ready[2].params.sudo, undefined);
});

test('postimport custody requires a real exact GUID; only immediate successful fresh import may capture one', () => {
  const { owner, registry, adapter } = fixture('strict-guid');
  for (const phase of ['created','ready','installed','reset','updating']) for (const registrationId of [undefined,null,'',0,foreignId]) {
    assert.throws(() => validateWslOwner({ ...owner, phase, registrationId }, registry, adapter.basePath));
  }
  const planned = { ...owner, phase: 'planned', registrationId: null };
  const before = { ...registry, distributions: [] };
  assert.equal(validateWslOwner(planned, before, adapter.basePath), null);
  assert.throws(() => validateWslOwner(planned, registry, adapter.basePath), /uncertain/);
  assert.equal(validateFreshWslImport(planned, before, registry, adapter.basePath).id, ownedId);
  assert.throws(() => validateFreshWslImport(planned, registry, registry, adapter.basePath));
  assert.throws(() => validateFreshWslImport(owner, before, registry, adapter.basePath));
  assert.throws(() => validateFreshWslImport(planned, before, { ...registry, distributions: [{ ...registry.distributions[0], id: '' }] }, adapter.basePath));
});

test('elevation uses explicit native path quoting, no inherited consent, and only strict completion/cancel/failure outcomes', async () => {
  const command = setupElevationCommand({ node: 'C:\\Program Files\\Node\\node.exe', script: "C:\\Users\\O'Brien\\Pinokio app\\lib\\windows-wsl.mjs", systemDirectory: 'C:\\Windows\\System32' });
  assert.match(command, /-FilePath 'C:\\Program Files\\Node\\node.exe'/);
  assert.match(command, /-ArgumentList '"C:\\Users\\O''Brien\\Pinokio app\\lib\\windows-wsl.mjs" enable-wsl-system'/);
  assert.match(command, /-Verb RunAs -Wait -PassThru/);
  assert.doesNotMatch(command, /HOME|HKCU|ENABLE|nonce|EncodedCommand|Bypass|UseNewEnvironment|RedirectStandard|Credential/);
  for (const script of ['relative.mjs', 'C:\\x".mjs', 'C:\\x\nm.mjs']) assert.throws(() => setupElevationCommand({ node: 'C:\\node.exe', script, systemDirectory: 'C:\\Windows\\System32' }));
  assert.deepEqual(parseSetupOutcome('{"version":1,"outcome":"exited","exitCode":0}'), { restartReported: false });
  assert.deepEqual(parseSetupOutcome('{"version":1,"outcome":"exited","exitCode":3010}'), { restartReported: true });
  for (const result of [{ outcome:'cancelled',exitCode:1223 }, { outcome:'exited',exitCode:1 }, { outcome:'exited',exitCode:null }, { outcome:'failed',exitCode:0 }, { outcome:'exited',exitCode:'0' }]) assert.throws(() => parseSetupOutcome(JSON.stringify({ version:1,...result })));
  const { adapter, owner } = fixture('requester');
  adapter.writeOwner({ ...owner, needsSetup: true });
  adapter.metadata = () => { throw new Error('must not ask for elevation without literal consent'); };
  await assert.rejects(adapter.enableWsl('enable'), /not confirmed/);
  const bytes = readFileSync(adapter.marker, 'utf8');
  await assert.rejects(adapter.reconcileWslSetup('{"version":1,"outcome":"cancelled","exitCode":1223}'), /cancelled/);
  assert.equal(readFileSync(adapter.marker,'utf8'), bytes);
  adapter.metadata = pid => ({ defaultDistribution:'{other}',distributions:[{id:ownedId,name:owner.distro,basePath:owner.basePath,version:2}],processBirth:pid===process.pid?'133999000000000000':null });
  adapter.prerequisites=()=>({ready:true});
  await adapter.reconcileWslSetup('{"version":1,"outcome":"exited","exitCode":0}');
  assert.equal(JSON.parse(readFileSync(adapter.marker,'utf8')).needsSetup, false);
  adapter.prerequisites=()=>({ready:false});
  await adapter.reconcileWslSetup('{"version":1,"outcome":"exited","exitCode":0}');
  assert.equal(JSON.parse(readFileSync(adapter.marker,'utf8')).needsSetup,true);
  assert.equal(JSON.parse(readFileSync(adapter.marker,'utf8')).setupCompleted,true);
  await assert.rejects(adapter.resumeWslSetup(),/not ready yet/);
  adapter.prerequisites=()=>({ready:true});
  await adapter.reconcileWslSetup('{"version":1,"outcome":"exited","exitCode":3010}');
  assert.equal(JSON.parse(readFileSync(adapter.marker,'utf8')).needsSetup,true);
  await adapter.resumeWslSetup();
  assert.equal(JSON.parse(readFileSync(adapter.marker,'utf8')).needsSetup,false);
});

test('elevated setup performs only fixed system commands, propagates restart and stops on failure', () => {
  const seen=[];
  const result=runSystemWslSetup({ platform:'win32',systemDirectory:'C:\\Windows\\System32',verify:path=>seen.push(['verify',path]),run:(command,args)=>{seen.push([command,args]);return {status:command.endsWith('dism.exe')?3010:0};} });
  assert.equal(result,3010);
  assert.deepEqual(seen.filter(x=>x[0]!=='verify'), [['C:\\Windows\\System32\\dism.exe',['/online','/enable-feature','/featurename:VirtualMachinePlatform','/all','/norestart']],['C:\\Windows\\System32\\wsl.exe',['--install','--no-distribution']]]);
  let calls=0;
  assert.throws(()=>runSystemWslSetup({platform:'win32',systemDirectory:'C:\\Windows\\System32',verify:()=>{},run:()=>{calls++;return {status:1};}}));
  assert.equal(calls,1);
});

test('guest startup failure requests Windows recovery; package preparation failure does not re-elevate', async () => {
  const {adapter,owner}=fixture('bootstrap-classification');
  adapter.bootstrapScript='C:\\Pinokio\\lib\\windows-wsl-bootstrap.sh';
  adapter.verifyBootstrapScript=()=>{};
  adapter.runSync=()=>{throw new Error('WSL cannot start');};
  await assert.rejects(adapter.bootstrapGuest(owner,'C:\\cache\\node.tar.xz'),/could not start/);
  assert.equal(JSON.parse(readFileSync(adapter.marker,'utf8')).needsSetup,true);
  adapter.writeOwner(owner);
  let calls=0;
  adapter.runSync=()=>{if(++calls===2)throw new Error('apt unavailable');return '';};
  await assert.rejects(adapter.bootstrapGuest(owner,'C:\\cache\\node.tar.xz'),/package\/runtime preparation/);
  assert.equal(calls,2);
  assert.equal(JSON.parse(readFileSync(adapter.marker,'utf8')).needsSetup,undefined);
});

test('host preflight permits owned guest Redis recovery only after host app/server are free, then rechecks all ports', async () => {
  const {adapter}=fixture('recovery-order');
  adapter.prerequisites=()=>({ready:true});adapter.assertHostRelease=()=>{};adapter.assertGuestRuntime=()=>{};
  const events=[];
  adapter.assertHostPorts=async ports=>events.push(['host',ports??[5650,5651,5659]]);
  adapter.runGuest=async(_owner,action)=>events.push(['guest',action]);
  await adapter.execute('preflight');
  assert.deepEqual(events,[['host',[5650,5651]],['guest','preflight'],['host',[5650,5651,5659]]]);
  events.length=0;adapter.assertHostPorts=async()=>{throw new Error('foreign host app');};
  await assert.rejects(adapter.execute('preflight'),/foreign host app/);assert.deepEqual(events,[]);
  adapter.assertHostPorts=async ports=>events.push(['host',ports]);adapter.runGuest=async()=>{throw new Error('foreign guest Redis');};
  await assert.rejects(adapter.execute('preflight'),/foreign guest Redis/);assert.equal(events.length,1);
});

test('release checkout re-executes verified target machinery instead of preparing with old in-memory pins', async () => {
  const {adapter}=fixture('reexec');
  adapter.prerequisites=()=>({ready:true});adapter.releaseFor=()=>({release:'v0.1.0',commit});adapter.assertHostRelease=()=>{};
  adapter.prepareEnvironment=()=>{throw new Error('old process must not prepare');};
  const calls=[];adapter.runSync=(command,args)=>{calls.push([command,args]);return '';};
  await adapter.execute('install');
  assert.equal(calls.length,2);assert.equal(calls[0][1].at(-1),'checkout-release');
  assert.deepEqual(calls[1][1].slice(1),['finish-install','v0.1.0',commit]);
  assert.ok(calls[1][1][0].endsWith('/windows-wsl.mjs'));
  for (const candidate of [undefined,{...runtime,node:'v24.18.0'},{...runtime,bootstrap:0},{...runtime,os:'ubuntu-22.04'}]) assert.throws(()=>assertWslRuntimeCompatible({runtime:candidate}),/runtime|OS\/ABI\/layout/);
  assert.doesNotThrow(()=>assertWslRuntimeCompatible({runtime:{...runtime,rootfsSha256:'a new pin is provenance only'}}));
  assert.doesNotThrow(()=>assertWslRuntimeCompatible({runtime}));
});

test('an unsupported release prevents prerequisite elevation and unfinished runtime updates refuse Start', async () => {
  const {adapter,owner}=fixture('release-before-setup');
  adapter.releaseFor=()=>{throw new Error('release has no Windows capability');};
  adapter.metadata=()=>{throw new Error('must not reach elevation metadata');};
  await assert.rejects(adapter.execute('check-install-release'),/no Windows capability/);
  await assert.rejects(adapter.enableWsl('ENABLE'),/no Windows capability/);
  adapter.metadata=()=>({distributions:[{id:ownedId,name:owner.distro,basePath:owner.basePath,version:2}],defaultDistribution:null});
  adapter.writeOwner({...owner,phase:'updating'});adapter.prerequisites=()=>({ready:true});adapter.assertHostRelease=()=>{};
  adapter.assertGuestRuntime=()=>{throw new Error('must not boot unfinished runtime');};
  await assert.rejects(adapter.execute('run','app'),/unfinished/);
  const {windowsActionSteps}=require('./windows-wsl-steps.cjs');
  const resume=await windowsActionSteps('install',{prerequisites:()=>({ready:false,setupCompleted:true})});
  assert.equal(resume[0].params.message,'node lib/windows-wsl.mjs check-install-release');
  assert.equal(resume[2].params.message,'node lib/windows-wsl.mjs resume-wsl-setup');
  assert.equal(resume.some(step=>step.method==='input'||step.params?.sudo),false);
});

test('the existing guest Delete admission stays held through Node replacement/cleanup and a held record prevents replacement', async () => {
  const dataRoot=join(root,'node-upgrade-data');mkdirSync(dataRoot);writeFileSync(join(dataRoot,'sentinel'),'kept');
  const archive=join(root,'owned-node-archive');writeFileSync(archive,'synthetic fixture, not a real Node archive');
  const input={nonce,archive,newSha:WSL_ASSETS[1].sha256,newVersion:WSL_NODE_VERSION,oldSha:'c'.repeat(64),oldVersion:'v24.18.0'};
  const events=[];
  const proveHeld=()=>{const reader=admit({role:'start',label:'wouldstart',dataRoot});assert.equal(reader.ok,false);};
  await upgradeNodeRuntime(input,{dataRoot,settle:async()=>{proveHeld();events.push('idle');return [];},install:async(command,args,cwd,env,stdio)=>{assert.equal(stdio.length,4);assert.equal(typeof stdio[3],'number');proveHeld();events.push('replace');assert.equal(command,'/bin/bash');assert.equal(args[1],'install-node');await Promise.resolve();proveHeld();events.push('cleanup-finished');}});
  assert.deepEqual(events,['idle','replace','cleanup-finished']);
  let reader=admit({role:'start',label:'afterupdate',dataRoot});assert.equal(reader.ok,true);releaseAdmission(reader);
  await assert.rejects(upgradeNodeRuntime(input,{dataRoot,settle:async()=>[{result:'unchecked',label:'unknown engine',recordPath:'/owned/launch.json'}],install:async()=>{throw new Error('must not replace');}}),/owned\/unknown runtime records/);
  reader=admit({role:'start',label:'afterrefusal',dataRoot});assert.equal(reader.ok,true);releaseAdmission(reader);
  assert.equal(readFileSync(join(dataRoot,'sentinel'),'utf8'),'kept');
});

test('retained Reset/same-Node/interrupted updates use maintenance without installed.json and keep the host operation through install', async () => {
  for (const [name,phase,changedNode] of [['reset','reset',true],['same','installed',false],['retry','updating',true],['empty','installed',true]]) {
    const {adapter,owner,dir}=fixture(`retained-${name}`);
    adapter.writeOwner({...owner,phase,dataPresent:name==='empty'?false:true,runtime:changedNode?{...runtime,node:'v24.18.0',nodeSha256:'c'.repeat(64)}:runtime});
    adapter.downloadAsset=async asset=>`C:\\cache\\${asset.file}`;
    const events=[];
    adapter.assertHostPorts=async ports=>events.push(['host',ports??[5650,5651,5659]]);
    adapter.assertGuestRuntime=()=>{};
    adapter.runGuest=async(current,action,args)=>{events.push(['guest',action]);if(action==='upgrade-node')assert.equal(current.phase,'updating');if(action==='maintain-install'){assert.equal(args[2],name==='empty'?'empty':'kept');return {release:current.release,commit:current.commit};}};
    const result=await adapter.prepareEnvironment(async ready=>{assert.equal(existsSync(join(dir,'operation.json')),true);events.push(['inside','install']);return {...ready,phase:'installed'};});
    assert.equal(result.runtime.node,WSL_NODE_VERSION);
    assert.equal(events.filter(e=>e[0]==='guest'&&e[1]==='maintain-install').length,1);
    assert.equal(events.some(e=>e[0]==='guest'&&e[1]==='preflight'),false);
    assert.equal(events.filter(e=>e[1]==='upgrade-node').length,changedNode?1:0);
    assert.equal(existsSync(join(dir,'operation.json')),false);
  }
  const dataRoot=join(root,'reset-maintenance');await prepareDataFiles(laneDataPaths(dataRoot));writeFileSync(join(dataRoot,'data'),'kept');
  let established=0;
  await maintainGuestInstallation({release:'v0.1.0',commit,dataPresent:true},{dataRoot,selectCode:()=>({release:'v0.1.0',commit}),loadEstablished:async()=>({settleLaneBeforeInstall:async()=>{const reader=admit({role:'start',label:'blocked',dataRoot});assert.equal(reader.ok,false);established++;return [];}})});
  assert.equal(established,1);assert.equal(readFileSync(join(dataRoot,'data'),'utf8'),'kept');
});

test('verified new/typed-deleted data can initialize, but retained/missing/corrupt keys never silently get replaced', async () => {
  const paths=laneDataPaths(join(root,'saved-data-disposition'));
  await checkSavedDataForInstall(paths,{dataPresent:false});assert.equal(existsSync(paths.secretsFile),false);
  await assert.rejects(checkSavedDataForInstall(paths,{dataPresent:true}),/original keys/);
  mkdirSync(paths.redis,{recursive:true});writeFileSync(join(paths.redis,'appendonly.aof'),'user saved value');
  await assert.rejects(checkSavedDataForInstall(paths,{dataPresent:false}),/unverified data/);
  assert.equal(readFileSync(join(paths.redis,'appendonly.aof'),'utf8'),'user saved value');
  rmSync(join(paths.redis,'appendonly.aof'));await checkSavedDataForInstall(paths,{dataPresent:false});
  await prepareDataFiles(paths);const before=readFileSync(paths.secretsFile,'utf8');
  await checkSavedDataForInstall(paths,{dataPresent:true});assert.equal(readFileSync(paths.secretsFile,'utf8'),before);
  writeFileSync(paths.secretsFile,'ENCRYPTION_KEY=bad\n');
  await assert.rejects(checkSavedDataForInstall(paths,{dataPresent:false}),/damaged/);
  assert.equal(readFileSync(paths.secretsFile,'utf8'),'ENCRYPTION_KEY=bad\n');
});

test('real guest Git checkout/build interruption resumes only recorded old/pending releases, including initial and newer targets', async () => {
  const source = join(root, 'code-recovery-source');
  mkdirSync(join(source, 'pinokio/lib'), { recursive: true });
  const git = args => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet', source]);
  const releases = [];
  for (const release of ['v9.0.1', 'v9.0.2', 'v9.0.3']) {
    writeFileSync(join(source, 'pinokio/RELEASE'), `${release}\n`);
    writeFileSync(join(source, 'pinokio/windows-wsl-protocol.json'), JSON.stringify(protocol));
    writeFileSync(join(source, 'pinokio/lib/cli.mjs'), 'export async function settleLaneBeforeInstall() { return []; }\n');
    git(['-C', source, 'add', '.']);
    git(['-C', source, 'commit', '--quiet', '-m', release]);
    git(['-C', source, 'tag', release]);
    releases.push({ release, commit: git(['-C', source, 'rev-parse', 'HEAD']) });
  }
  const [old, target, newer] = releases;
  const head = directory => git(['-C', directory, 'rev-parse', 'HEAD']);
  const connect = (adapter, directory, dataRoot) => {
    const faults = { beforeCheckout: false, build: false };
    adapter.assertHostPorts = async () => {};
    adapter.assertGuestRuntime = () => {};
    // Only the Windows transport is injected. The real guest selection, Git checkout,
    // host record publication and data admission all execute; no npm/Redis/WSL runs.
    adapter.runGuest = async (owner, action, args) => {
      if (action === 'maintain-install') {
        return maintainGuestInstallation({ release: args[0] || undefined, commit: args[1] || undefined, dataPresent: args[2] === 'kept', pendingRelease: args[3] || undefined, pendingCommit: args[4] || undefined }, {
          dataRoot,
          selectCode: () => selectMaintenanceCode(directory, codeReleaseTuple(args[0] || undefined, args[1] || undefined), codeReleaseTuple(args[3] || undefined, args[4] || undefined)),
          loadEstablished: () => import(pathToFileURL(join(directory, 'pinokio/lib/cli.mjs')).href),
          settleFresh: async () => []
        });
      }
      assert.equal(action, 'install');
      const pending = JSON.parse(readFileSync(adapter.marker, 'utf8'));
      assert.deepEqual(pending.pendingCode, { release: args[0], commit: args[1] });
      assert.equal(pending.phase, 'updating');
      if (faults.beforeCheckout) throw new Error('injected before clone/checkout');
      return installGuestCode({ source, directory, release: args[0], commit: args[1] }, {
        build: async (_command, buildArgs) => {
          assert.equal(head(directory), args[1]);
          assert.deepEqual(JSON.parse(readFileSync(adapter.marker, 'utf8')).pendingCode, { release: args[0], commit: args[1] });
          if (faults.build && buildArgs.join(' ') === 'run build') throw new Error('injected build interruption after real checkout');
        },
        finish: async () => {}
      });
    };
    return faults;
  };

  const { adapter, owner, dir } = fixture('code-recovery');
  const directory = join(dir, 'guest-code');
  const dataRoot = join(dir, 'data');
  const paths = laneDataPaths(dataRoot);
  await prepareDataFiles(paths);
  const keys = readFileSync(paths.secretsFile, 'utf8');
  writeFileSync(join(paths.redis, 'appendonly.aof'), 'saved user value');
  await installGuestCode({ source, directory, ...old }, { build: async () => {}, finish: async () => {} });
  adapter.writeOwner({ ...owner, ...old });
  const faults = connect(adapter, directory, dataRoot);
  faults.build = true;
  await assert.rejects(adapter.installPreparedGuest(adapter.readOwner(), target), /build interruption/);
  assert.equal(head(directory), target.commit);
  assert.equal(adapter.readOwner().commit, old.commit);
  assert.deepEqual(adapter.readOwner().pendingCode, target);
  const reconciled = await adapter.maintainRetainedGuest(adapter.readOwner());
  assert.equal(reconciled.commit, target.commit);
  assert.deepEqual(reconciled.pendingCode, target); // Not an installed publication.
  assert.equal(reconciled.phase, 'updating');
  faults.build = false;
  faults.beforeCheckout = true;
  await assert.rejects(adapter.installPreparedGuest(reconciled, newer), /before clone/);
  assert.equal(head(directory), target.commit);
  assert.equal(adapter.readOwner().commit, target.commit); // Prior pending reconciled first.
  assert.deepEqual(adapter.readOwner().pendingCode, newer);
  git(['-C', directory, 'checkout', '--quiet', '--detach', old.release]);
  const beforeRefusal = readFileSync(adapter.marker, 'utf8');
  await assert.rejects(adapter.maintainRetainedGuest(adapter.readOwner()), /neither the recorded old nor pending/);
  assert.equal(readFileSync(adapter.marker, 'utf8'), beforeRefusal);
  git(['-C', directory, 'checkout', '--quiet', '--detach', target.release]);
  faults.beforeCheckout = false;
  const installed = await adapter.installPreparedGuest(await adapter.maintainRetainedGuest(adapter.readOwner()), newer);
  assert.equal(head(directory), newer.commit);
  assert.equal(installed.phase, 'installed');
  assert.equal(installed.pendingCode, undefined);
  assert.equal(readFileSync(paths.secretsFile, 'utf8'), keys);
  assert.equal(readFileSync(join(paths.redis, 'appendonly.aof'), 'utf8'), 'saved user value');

  const fresh = fixture('initial-code-recovery');
  const { release: _oldRelease, commit: _oldCommit, ...initial } = fresh.owner;
  fresh.adapter.writeOwner({ ...initial, phase: 'ready', dataPresent: false });
  const initialDirectory = join(fresh.dir, 'guest-code');
  const initialFaults = connect(fresh.adapter, initialDirectory, join(fresh.dir, 'data'));
  initialFaults.beforeCheckout = true;
  await assert.rejects(fresh.adapter.installPreparedGuest(fresh.adapter.readOwner(), old), /before clone/);
  assert.equal(existsSync(initialDirectory), false);
  let resumed = await fresh.adapter.maintainRetainedGuest(fresh.adapter.readOwner());
  assert.equal(resumed.commit, undefined);
  assert.deepEqual(resumed.pendingCode, old);
  initialFaults.beforeCheckout = false;
  initialFaults.build = true;
  await assert.rejects(fresh.adapter.installPreparedGuest(resumed, old), /build interruption/);
  assert.equal(head(initialDirectory), old.commit);
  resumed = await fresh.adapter.maintainRetainedGuest(fresh.adapter.readOwner());
  assert.equal(resumed.commit, old.commit);
  initialFaults.build = false;
  const firstInstalled = await fresh.adapter.installPreparedGuest(resumed, old);
  assert.equal(firstInstalled.phase, 'installed');
  assert.equal(firstInstalled.pendingCode, undefined);
});

test('the bootstrap Git attribute keeps a real autocrlf=true checkout LF without changing host Git configuration', () => {
  const source=join(root,'lf-source');const checkout=join(root,'lf-checkout');mkdirSync(join(source,'pinokio/lib'),{recursive:true});
  writeFileSync(join(source,'.gitattributes'),readFileSync(join(import.meta.dirname,'../../.gitattributes')));
  const original=readFileSync(join(import.meta.dirname,'windows-wsl-bootstrap.sh'));
  writeFileSync(join(source,'pinokio/lib/windows-wsl-bootstrap.sh'),original);
  const git=args=>{const result=spawnSync('git',['-c','core.autocrlf=true','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
  git(['init','--quiet',source]);git(['-C',source,'add','.']);git(['-C',source,'commit','--quiet','-m','fixture']);git(['clone','--quiet',source,checkout]);
  const actual=readFileSync(join(checkout,'pinokio/lib/windows-wsl-bootstrap.sh'));
  assert.deepEqual(actual,original);assert.equal(actual.includes(Buffer.from('\r\n')),false);
});
