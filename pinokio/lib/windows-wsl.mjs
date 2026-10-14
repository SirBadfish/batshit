// Route-local Windows adapter. No Windows Redis, service, carrier, global WSL stop/default,
// automatic distro removal, or credentials on argv. Menu reads never enter a Linux guest.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, linkSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, parse, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChild } from './service-child.mjs';
import { fetchPinned } from './redis-runtime.mjs';
import { LANE_PORTS } from './lane.mjs';
import { assertWslRuntimeCompatible, assertWslRuntimeFamily, codeReleaseTuple, guestCommandArgs, guestNodeArgs, recordedCodeTuples, reconcileCodeSelection, validateFreshWslImport, validateWindowsRelease, validateWslOwner, windowsPathToGuest, WSL_ASSETS, WSL_BOOTSTRAP_VERSION, WSL_ENV, WSL_NODE, WSL_NODE_VERSION, WSL_RUNTIME_OS, WSL_DISTRO_NAME } from './windows-wsl-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const launcherDir = dirname(here);
const repoRoot = dirname(launcherDir);
const markerName = 'instance.json';

function windowsAbsolutePath(path) {
  if (typeof path !== 'string' || !/^[a-z]:\\/i.test(path) || /[\0\r\n"]/.test(path)) throw new Error('An absolute Windows executable/script path is required.');
  return win32.normalize(path);
}

function powershellPath(env = process.env) {
  const systemRoot = windowsAbsolutePath(env.SystemRoot || env.SYSTEMROOT);
  const path = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  assertPhysicalPath(path);
  return path;
}

// Start-Process joins ArgumentList as a native Windows command line. Quote the absolute
// script for Node's argv parser, then separately quote that entire data string for PowerShell.
export function setupElevationCommand({ node, script, systemDirectory }) {
  node = windowsAbsolutePath(node); script = windowsAbsolutePath(script); systemDirectory = windowsAbsolutePath(systemDirectory);
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const argumentsString = `"${script.replace(/(\\+)$/g, '$1$1')}" enable-wsl-system`;
  return `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
try {
 $batshitSetup=Start-Process -FilePath ${literal(node)} -ArgumentList ${literal(argumentsString)} -WorkingDirectory ${literal(systemDirectory)} -Verb RunAs -Wait -PassThru -ErrorAction Stop;
 if($null -eq $batshitSetup -or $batshitSetup -isnot [Diagnostics.Process]){throw 'The elevated process is unavailable'};
 $batshitExit=$batshitSetup.ExitCode;
 if($null -eq $batshitExit -or $batshitExit -isnot [int]){throw 'The elevated process exit is unavailable'};
 [pscustomobject]@{version=1;outcome='exited';exitCode=$batshitExit}|ConvertTo-Json -Compress
} catch {
 $batshitCode=$null;$batshitException=$_.Exception;
 while($null -ne $batshitException){if($batshitException -is [ComponentModel.Win32Exception]){$batshitCode=$batshitException.NativeErrorCode;break};$batshitException=$batshitException.InnerException};
 [pscustomobject]@{version=1;outcome=$(if($batshitCode -eq 1223){'cancelled'}else{'failed'});exitCode=$batshitCode}|ConvertTo-Json -Compress
}`;
}

export function parseSetupOutcome(json) {
  const value = JSON.parse(json);
  if (value?.version !== 1) throw new Error('Windows setup outcome could not be verified.');
  if (value.outcome === 'cancelled' && value.exitCode === 1223) throw new Error('Windows setup was cancelled; no completion was recorded.');
  if (value.outcome !== 'exited' || ![0, 3010].includes(value.exitCode)) throw new Error('Windows setup failed or its outcome is unknown; no completion was recorded.');
  // WSL itself can report a required reboot but return 0. This flag is only an explicit
  // process3010 report, never proof that no reboot or VM qualification is necessary.
  return { restartReported: value.exitCode === 3010 };
}

// Elevated entry is system-only. No adapter construction, HOME/HKCU/owner/data discovery.
export function runSystemWslSetup({ systemDirectory, platform = process.platform, run = spawnSync, verify = assertPhysicalPath }) {
  if (platform !== 'win32') throw new Error('Windows prerequisite setup requires Windows.');
  systemDirectory = windowsAbsolutePath(systemDirectory);
  let restartRequired = false;
  for (const [name, args] of [
    ['dism.exe', ['/online', '/enable-feature', '/featurename:VirtualMachinePlatform', '/all', '/norestart']],
    ['wsl.exe', ['--install', '--no-distribution']]
  ]) {
    const command = win32.join(systemDirectory, name); verify(command);
    const result = run(command, args, { stdio: 'inherit', windowsHide: true });
    if (result.error || ![0, 3010].includes(result.status)) throw new Error('Windows could not complete its WSL 2 prerequisite commands.');
    restartRequired ||= result.status === 3010;
  }
  return restartRequired ? 3010 : 0;
}

// A fixed read-only commandlet query, not a .ps1/EncodedCommand/policy override. Windows
// client Restricted policy permits ordinary commands. The sole substitution is a checked PID.
export function metadataCommand(targetPid) {
  if (!Number.isSafeInteger(targetPid) || targetPid < 0 || targetPid > 2147483647) throw new Error('Invalid process identity query.');
  return `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $batshitLxss='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
$batshitDefault=$null; $batshitDistros=@();
if(Test-Path -LiteralPath $batshitLxss){
  $batshitDefault=(Get-ItemProperty -LiteralPath $batshitLxss).DefaultDistribution;
  $batshitDistros=@(Get-ChildItem -LiteralPath $batshitLxss | ForEach-Object {
    $batshitEntry=Get-ItemProperty -LiteralPath $_.PSPath;
    [pscustomobject]@{id=$_.PSChildName;name=$batshitEntry.DistributionName;basePath=$batshitEntry.BasePath;version=$batshitEntry.Version}
  });
};
$batshitBirth=$null;
if(${targetPid} -gt 0){
  try{$batshitProcess=Get-Process -Id ${targetPid} -ErrorAction Stop;$batshitBirth=$batshitProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}
  catch{if(-not $_.FullyQualifiedErrorId.StartsWith('NoProcessFoundForGivenId,')){throw}}
};
[pscustomobject]@{systemDirectory=[Environment]::SystemDirectory;windowsDirectory=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows);defaultDistribution=$batshitDefault;distributions=$batshitDistros;processBirth=$batshitBirth}|ConvertTo-Json -Depth 4 -Compress`;
}

export function assertPhysicalPath(path, { directory = false, allowMissing = false } = {}) {
  const target = resolve(path);
  const root = parse(target).root;
  let cursor = root;
  for (const part of target.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try { info = lstatSync(cursor); }
    catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return target;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`A linked storage path is refused: ${cursor}`);
  }
  const stat = lstatSync(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`The expected physical path has a different type: ${target}`);
  if (realpathSync.native(target).toLowerCase() !== target.toLowerCase()) throw new Error(`Storage resolves elsewhere: ${target}`);
  return target;
}

function checkedSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`The launcher command did not finish (${result.status ?? 'unavailable'}): ${result.stderr || result.stdout || result.error?.message}`);
  return (result.stdout ?? '').trim();
}

function normalizedRegistryPath(path) {
  return resolve(String(path).replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, ''));
}

export class WindowsWslAdapter {
  constructor({ home = homedir(), sourceRoot = repoRoot, platform = process.platform, arch = process.arch, env = process.env, runSync = checkedSync } = {}) {
    if (platform !== 'win32' || arch !== 'x64') throw new Error('This Windows Pinokio route requires x64 Windows.');
    this.sourceRoot = resolve(sourceRoot);
    this.root = resolve(home, '.batshit', 'pinokio-wsl');
    this.basePath = join(this.root, 'distro');
    this.marker = join(this.root, markerName);
    this.bootstrapScript = join(here, 'windows-wsl-bootstrap.sh');
    this.runSync = runSync;
    this.powershell = powershellPath(env);
    const metadata = this.metadata();
    this.wsl = join(metadata.systemDirectory, 'wsl.exe');
    if (existsSync(this.wsl)) assertPhysicalPath(this.wsl);
    if (this.root === this.sourceRoot || this.root.startsWith(`${this.sourceRoot}\\`)) throw new Error('The WSL data disk must be outside the launcher repository.');
  }

  metadata(targetPid = 0) {
    const value = JSON.parse(this.runSync(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', metadataCommand(targetPid)]));
    if (!value || !Array.isArray(value.distributions) || typeof value.systemDirectory !== 'string') throw new Error('Windows WSL metadata could not be verified.');
    return { ...value, defaultDistribution: value.defaultDistribution || null, distributions: value.distributions.map(d => ({ ...d, basePath: normalizedRegistryPath(d.basePath) })) };
  }

  readOwner({ required = true } = {}) {
    if (!existsSync(this.marker)) {
      if (required) throw new Error('Batshit\'s Linux environment is not installed. Click Install.');
      return null;
    }
    assertPhysicalPath(this.marker);
    const owner = JSON.parse(readFileSync(this.marker, 'utf8'));
    validateWslOwner(owner, this.metadata(), this.basePath);
    if (owner.phase !== 'planned') assertPhysicalPath(this.basePath, { directory: true });
    return owner;
  }

  writeOwner(owner, { create = false } = {}) {
    if (create) {
      writeFileSync(this.marker, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
      return;
    }
    const temporary = `${this.marker}.${randomBytes(8).toString('hex')}.new`;
    try {
      writeFileSync(temporary, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
      if (existsSync(this.marker)) assertPhysicalPath(this.marker);
      renameSync(temporary, this.marker);
    } finally { if (existsSync(temporary)) rmSync(temporary); }
  }

  menuState() {
    // Host file/registry metadata only: rendering does not start a stopped guest.
    const owner = this.readOwner({ required: false });
    return { installed: owner?.phase === 'installed', dataPresent: owner?.dataPresent === true, retained: Boolean(owner) };
  }

  prerequisites({ ignoreRecordedSetup = false } = {}) {
    if (!existsSync(this.wsl)) return { ready: false, unsupported: true };
    const owner = this.readOwner({ required: false });
    const result = this.probeWsl(['--status']);
    const version = this.probeWsl(['--version']);
    const version2 = this.metadata().distributions.some(d => d.version === 2);
    // General status is not a WSL2 launch guarantee. Require a supported component/existing
    // v2 registration, then let the actual owned import/start qualify it. A failure routes
    // back to the explicit setup/restart screen even if general status keeps returning 0.
    return { ready: (ignoreRecordedSetup || !owner?.needsSetup) && !result.error && result.status === 0 && (version2 || (!version.error && version.status === 0)), retrySetup: owner?.needsSetup === true, ...(owner?.setupCompleted ? { setupCompleted: true } : {}) };
  }

  probeWsl(args) { return spawnSync(this.wsl, args, { encoding: 'utf8', windowsHide: true }); }

  async enableWsl(consent) {
    if (consent !== 'ENABLE') throw new Error('WSL setup was not confirmed; no elevation was requested.');
    this.releaseFor('install'); // No machine change for an older/public unsupported tag.
    const system = this.metadata().systemDirectory;
    for (const path of [process.execPath, fileURLToPath(import.meta.url), system]) assertPhysicalPath(path, { directory: path === system });
    await this.reconcileWslSetup(this.runSync(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', setupElevationCommand({ node: process.execPath, script: fileURLToPath(import.meta.url), systemDirectory: system })]));
  }

  async reconcileWslSetup(json) {
    const outcome = parseSetupOutcome(json);
    // This process is still the ORIGINAL requester. Alternate administrator HOME/HKCU never
    // participates in registration or marker reconciliation, even after system setup succeeds.
    this.ensurePlannedOwner();
    const readiness = this.prerequisites({ ignoreRecordedSetup: true });
    const pending = outcome.restartReported || !readiness.ready;
    await this.withOperation(async () => {
      const current = this.readOwner();
      this.writeOwner({ ...current, needsSetup: pending, setupCompleted: true });
    });
    console.log(pending
      ? 'Batshit: Windows prerequisite commands completed, but setup is not yet ready. Restart Windows, reopen Pinokio, then click Install to resume without another administrator setup.'
      : 'Batshit: Windows prerequisite commands completed and this user’s component probes succeeded. Restart if Windows requested it; Install must still qualify the actual owned WSL2 environment.');
  }

  async resumeWslSetup() {
    const owner = this.readOwner();
    if (!owner.setupCompleted) throw new Error('Windows prerequisite setup has no verified completion.');
    if (!this.prerequisites({ ignoreRecordedSetup: true }).ready) throw new Error('Completed Windows setup is not ready yet. Restart Windows and click Install again; no new administrator setup was requested.');
    await this.withOperation(async () => this.writeOwner({ ...this.readOwner(), needsSetup: false }));
  }

  releaseFor(action) {
    const git = args => this.runSync('git', ['-C', this.sourceRoot, ...args]);
    git(['fetch', '--tags', 'origin']);
    if (action === 'update') {
      if (!git(['symbolic-ref', 'refs/remotes/origin/HEAD'])) throw new Error('The release source has no default branch.');
    }
    const release = action === 'update'
      ? git(['show', 'origin/HEAD:pinokio/RELEASE']).trim()
      : readFileSync(join(this.sourceRoot, 'pinokio', 'RELEASE'), 'utf8').trim();
    if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release)) throw new Error('The installer must name a release tag.');
    const commit = git(['rev-parse', '--verify', `${release}^{commit}`]);
    const declaredRelease = git(['show', `${release}:pinokio/RELEASE`]);
    let protocol;
    try { protocol = JSON.parse(git(['show', `${release}:pinokio/windows-wsl-protocol.json`])); } catch { throw new Error('This released version does not include Windows WSL. Wait for a Windows-capable release.'); }
    return validateWindowsRelease({ release, commit, declaredRelease, protocol });
  }

  assertHostRelease(owner) {
    const release = readFileSync(join(this.sourceRoot, 'pinokio', 'RELEASE'), 'utf8').trim();
    const head = this.runSync('git', ['-C', this.sourceRoot, 'rev-parse', 'HEAD']);
    if (owner.release !== release || owner.commit !== head) throw new Error('The launcher and Linux installation are different releases. Click Update or Install.');
  }

  async withOperation(body) {
    assertPhysicalPath(this.root, { directory: true });
    const lock = join(this.root, 'operation.json');
    const birth = this.metadata(process.pid).processBirth;
    if (!/^[1-9][0-9]{0,19}$/.test(birth ?? '')) throw new Error('This launcher process identity could not be verified.');
    if (existsSync(lock)) {
      assertPhysicalPath(lock);
      const previousBytes = readFileSync(lock, 'utf8');
      const previous = JSON.parse(previousBytes);
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !/^[1-9][0-9]{0,19}$/.test(previous.birth ?? '')) throw new Error('An unknown install operation is recorded; no data was changed.');
      const now = this.metadata(previous.pid).processBirth;
      if (now === previous.birth) throw new Error('Another Batshit setup operation is still running.');
      // Same deterministic hard-link claim used by repository process-record locks: one
      // reaper wins; a loser can never unlink a newly published live operation's record.
      const tombstone = `${lock}.reap.${createHash('sha256').update(previousBytes).digest('hex')}`;
      try { linkSync(lock, tombstone); }
      catch { throw new Error('Another launcher is reconciling setup ownership. Try again after it finishes.'); }
      try {
        if (readFileSync(tombstone, 'utf8') !== previousBytes || readFileSync(lock, 'utf8') !== previousBytes) throw new Error('Setup ownership changed; its live record was retained.');
        rmSync(lock);
      } finally { rmSync(tombstone); }
    }
    const fd = openSync(lock, 'wx');
    const contents = JSON.stringify({ pid: process.pid, birth });
    writeFileSync(fd, contents);
    try { return await body(); }
    finally {
      closeSync(fd);
      if (readFileSync(lock, 'utf8') !== contents) throw new Error('Setup lock ownership changed; its record was retained.');
      rmSync(lock);
    }
  }

  ensurePlannedOwner() {
    let owner = this.readOwner({ required: false });
    if (!owner) {
      const registry = this.metadata();
      if (registry.distributions.some(d => d.name === WSL_DISTRO_NAME)) throw new Error('A WSL distribution already uses Batshit\'s name without its ownership record; nothing was adopted.');
      assertPhysicalPath(this.root, { directory: true, allowMissing: true });
      if (existsSync(this.root)) throw new Error('Unrecorded Windows storage already exists; no files were replaced.');
      mkdirSync(this.root, { recursive: true });
      owner = { version: 1, phase: 'planned', distro: WSL_DISTRO_NAME, basePath: this.basePath, nonce: randomBytes(16).toString('hex'), registrationId: null, previousDefault: registry.defaultDistribution, dataPresent: false };
      this.writeOwner(owner, { create: true });
    }
    return owner;
  }

  async prepareEnvironment(afterReady) {
    let owner = this.ensurePlannedOwner();
    return this.withOperation(async () => {
      // Another installer may have progressed while this process acquired the lock.
      // Never replace its current phase/registration with our earlier snapshot.
      owner = this.readOwner();
      const cache = join(this.root, 'downloads');
      assertPhysicalPath(cache, { directory: true, allowMissing: true });
      const assets = [];
      for (const asset of WSL_ASSETS) {
        for (const path of [join(cache, asset.file), join(cache, `${asset.file}.partial`)]) {
          assertPhysicalPath(path, { allowMissing: true });
          if (existsSync(path) && path.endsWith('.partial') && lstatSync(path).nlink !== 1) throw new Error('A linked partial download was retained.');
        }
        assets.push(await this.downloadAsset(asset, cache));
      }
      if (owner.phase === 'planned') {
        const before = this.metadata();
        const existing = before.distributions.filter(d => d.name === owner.distro);
        if (existing.length) throw new Error('Import ownership is uncertain; no existing distribution was adopted or replaced.');
        assertPhysicalPath(this.basePath, { directory: true, allowMissing: true });
        if (!existing.length) {
          if (existsSync(this.basePath)) throw new Error('Unrecorded Linux disk storage exists; it was retained.');
          owner = { ...owner, importAttempted: true };
          this.writeOwner(owner);
          try { this.runSync(this.wsl, ['--import', owner.distro, this.basePath, assets[0], '--version', '2']); }
          catch (error) {
            this.writeOwner({ ...owner, needsSetup: true });
            throw new Error('WSL 2 could not import Batshit. Return to Install for its setup/restart screen. The partial environment was retained.');
          }
        }
        const after = this.metadata();
        const registered = validateFreshWslImport(owner, before, after, this.basePath);
        owner = { ...owner, phase: 'created', registrationId: registered.id };
        this.writeOwner(owner);
      }
      if (owner.phase === 'created') {
        owner = await this.bootstrapGuest(owner, assets[1]);
        owner = { ...owner, phase: 'ready', runtime: this.targetRuntime() };
        this.writeOwner(owner);
      } else {
        assertWslRuntimeFamily(owner); // A new archive hash alone is not an OS migration.
        owner = await this.maintainRetainedGuest(owner);
        if (owner.phase === 'updating' || owner.runtime.node !== WSL_NODE_VERSION || owner.runtime.nodeSha256 !== WSL_ASSETS[1].sha256) {
          owner = { ...owner, phase: 'updating' }; this.writeOwner(owner);
          await this.runGuest(owner, 'upgrade-node', [windowsPathToGuest(assets[1]), WSL_ASSETS[1].sha256, WSL_NODE_VERSION, owner.runtime.nodeSha256, owner.runtime.node]);
          owner = { ...owner, phase: 'ready', runtime: { ...this.targetRuntime(), rootfsSha256: owner.runtime.rootfsSha256 } };
          this.writeOwner(owner);
        }
      }
      assertWslRuntimeCompatible(owner);
      this.assertGuestRuntime(owner);
      if (afterReady) owner = await afterReady(owner);
      return owner;
    });
  }

  downloadAsset(asset, cache) { return fetchPinned(asset, cache, { log: message => console.log(`Batshit: ${message}`) }); }

  async maintainRetainedGuest(owner) {
    await this.assertHostPorts([LANE_PORTS.app, LANE_PORTS.server]);
    this.assertGuestRuntime(owner, { allowNodeUpdate: true });
    // One path for same/changed Node, Reset and interrupted updates. The established guest
    // maintenance guard does not require installed.json and never borrows a host runtime.
    const { pending } = recordedCodeTuples(owner);
    const selected = await this.runGuest(owner, 'maintain-install', [owner.release ?? '', owner.commit ?? '', owner.dataPresent === false ? 'empty' : 'kept', pending?.release ?? '', pending?.commit ?? ''], { captureMaintenance: true });
    const reconciled = reconcileCodeSelection(owner, selected);
    await this.assertHostPorts();
    // Keep the existing pending authority until this exact old/pending checkout has been
    // reconciled. A later newer request may then record its own target without losing the
    // only tuple that describes the actual guest checkout.
    this.writeOwner(reconciled);
    return reconciled;
  }

  targetRuntime() { return { node: WSL_NODE_VERSION, nodeSha256: WSL_ASSETS[1].sha256, bootstrap: WSL_BOOTSTRAP_VERSION, os: WSL_RUNTIME_OS, rootfsSha256: WSL_ASSETS[0].sha256 }; }

  assertGuestRuntime(owner, { allowNodeUpdate = false } = {}) {
    this.verifyBootstrapScript();
    const clean = command => guestCommandArgs(owner, ['/usr/bin/env', '-i', ...Object.entries(WSL_ENV).map(([k,v]) => `${k}=${v}`), ...command]);
    const tuples = allowNodeUpdate ? [owner.runtime, this.targetRuntime()] : [this.targetRuntime()];
    let verified;
    for (const tuple of tuples) {
      try { this.runSync(this.wsl, clean(['/bin/bash', windowsPathToGuest(this.bootstrapScript), 'verify-node', owner.nonce, tuple.nodeSha256, tuple.node])); verified = tuple; break; }
      catch { /* Only these exact owned/source tuples are allowed during atomic update recovery. */ }
    }
    if (!verified) throw new Error('The managed Node selector/runtime custody could not be verified; no application was started and data was retained.');
    const version = this.runSync(this.wsl, clean([WSL_NODE, '--version']));
    if (version !== verified.node) throw new Error('The owned guest Node version differs; its data was retained and no application was started.');
    const osRelease = this.runSync(this.wsl, clean(['/usr/bin/cat', '/etc/os-release']));
    if (!/^ID=(?:ubuntu|"ubuntu")$/m.test(osRelease) || !/^VERSION_ID=(?:24\.04|"24\.04")$/m.test(osRelease)) throw new Error('The retained guest OS differs from the supported Ubuntu24.04 family; no application was started and its disk was retained.');
  }

  async bootstrapGuest(owner, nodeArchive) {
    // First distinguish failure to enter/start WSL from failure of apt/download/extraction.
    const rootCommand = command => guestCommandArgs(owner, ['/usr/bin/env', '-i', 'HOME=/root', 'USER=root', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8', ...command], { user: 'root', cwd: '/' });
    try { this.runSync(this.wsl, rootCommand(['/bin/true'])); }
    catch { this.writeOwner({ ...owner, needsSetup: true }); throw new Error('The owned WSL 2 environment could not start. Return to Install for setup/restart guidance; its data was retained.'); }
    this.verifyBootstrapScript();
    try {
      if (!owner.osPrepared) {
        this.runSync(this.wsl, rootCommand(['/bin/bash', windowsPathToGuest(this.bootstrapScript), 'bootstrap-root', owner.nonce]), { stdio: ['ignore', 'inherit', 'inherit'] });
        owner = { ...owner, osPrepared: true }; this.writeOwner(owner);
      }
      this.runSync(this.wsl, guestCommandArgs(owner, ['/usr/bin/env', '-i', ...Object.entries(WSL_ENV).map(([k,v]) => `${k}=${v}`), '/bin/bash', windowsPathToGuest(this.bootstrapScript), 'install-node', owner.nonce, windowsPathToGuest(nodeArchive), WSL_ASSETS[1].sha256, WSL_NODE_VERSION, '', '']), { stdio: ['ignore', 'inherit', 'inherit'] });
    }
    catch { throw new Error('Linux package/runtime preparation did not finish. Retry Install after resolving the displayed package/download failure; no new Windows administrator setup is required and data was retained.'); }
    return owner;
  }

  verifyBootstrapScript() { assertPhysicalPath(this.bootstrapScript); }

  async assertHostPorts(ports = Object.values(LANE_PORTS)) {
    for (const port of ports) await new Promise((resolvePort, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error(`Windows port ${port} is already in use. Close its owning app, then try again; no port was changed.`)));
      probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(resolvePort));
    });
  }

  async runGuest(owner, action, args = [], { captureMaintenance = false } = {}) {
    if (captureMaintenance && action !== 'maintain-install') throw new Error('Only maintenance may return a code-selection receipt.');
    const driver = windowsPathToGuest(join(here, 'windows-wsl-guest.mjs'));
    const { child, exited } = startChild('Windows Linux environment', {
      command: this.wsl,
      args: guestNodeArgs(owner, driver, [action, owner.nonce, windowsPathToGuest(this.sourceRoot), ...args]),
      cwd: launcherDir, env: process.env
    }, ['inherit', captureMaintenance ? 'pipe' : 'inherit', 'inherit']);
    let output = '', overflow = false;
    const drained = captureMaintenance ? new Promise((resolveDrain, rejectDrain) => {
      child.stdout.on('data', chunk => { process.stdout.write(chunk); if (Buffer.byteLength(output) + chunk.length <= 65536) output += chunk.toString('utf8'); else overflow = true; });
      child.stdout.once('end', resolveDrain); child.stdout.once('close', resolveDrain); child.stdout.once('error', rejectDrain);
    }) : Promise.resolve();
    const code = await exited;
    await drained;
    if (code !== 0) throw new Error('The Linux operation did not finish. Its data and environment were retained.');
    if (captureMaintenance) {
      if (overflow) throw new Error('The maintenance receipt exceeded its bounded output; pending metadata was retained.');
      const prefix = 'Batshit: maintenance code ';
      const last = output.trimEnd().split(/\r?\n/).at(-1);
      if (!last?.startsWith(prefix)) throw new Error('The guest returned no code-selection receipt; pending metadata was retained.');
      const selected = JSON.parse(last.slice(prefix.length));
      reconcileCodeSelection(owner, selected); // Transport output never admits an arbitrary HEAD.
      return selected;
    }
  }

  async installPreparedGuest(owner, release) {
    const target = codeReleaseTuple(release.release, release.commit);
    const pending = { ...owner, phase: 'updating', pendingCode: target };
    this.writeOwner(pending); // Independently validated caller target, before guest checkout.
    await this.runGuest(pending, 'install', [target.release, target.commit, pending.dataPresent === false ? 'empty' : 'kept']);
    const { pendingCode, ...base } = pending;
    const installed = { ...base, ...target, phase: 'installed', dataPresent: true };
    this.writeOwner(installed);
    return installed;
  }

  async execute(action, service, confirm) {
    if (action === 'remove-environment') throw new Error('Removing the Linux data disk requires a verified recoverable export; this launcher does not remove it.');
    if (action === 'check-install-release') return this.releaseFor('install');
    if (action === 'resume-wsl-setup') { this.releaseFor('install'); return this.resumeWslSetup(); }
    if (!['install', 'update', 'finish-install', 'reset', 'preflight', 'run', 'delete-data'].includes(action)) throw new Error('Unknown Windows launcher action.');
    if (!this.prerequisites().ready) throw new Error('WSL setup is not ready. Return to Install for its setup/restart screen.');
    if (action === 'install' || action === 'update') {
      const release = this.releaseFor(action); // Capability gate precedes disk/data creation.
      const hostCommand = action === 'update' ? 'update-release' : 'checkout-release';
      this.runSync(process.execPath, [join(here, 'cli.mjs'), hostCommand]);
      // All target bootstrap/driver/pins now load in a fresh process from the verified tag.
      this.assertHostRelease(release);
      return this.runSync(process.execPath, [join(here, 'windows-wsl.mjs'), 'finish-install', release.release, release.commit], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
    if (action === 'finish-install') {
      const release = validateWindowsRelease({ release: service, commit: confirm, declaredRelease: readFileSync(join(launcherDir, 'RELEASE'), 'utf8'), protocol: JSON.parse(readFileSync(join(launcherDir, 'windows-wsl-protocol.json'), 'utf8')) });
      this.assertHostRelease(release);
      await this.assertHostPorts([LANE_PORTS.app, LANE_PORTS.server]);
      await this.prepareEnvironment(async owner => {
        await this.assertHostPorts();
        return this.installPreparedGuest(owner, release);
      });
      return;
    }
    const owner = this.readOwner();
    this.assertHostRelease(owner);
    if (owner.phase === 'updating' || owner.pendingCode) throw new Error('The runtime/code update is unfinished. Only Install/Update may resume it; no service/reset/deletion was started.');
    if (['run','preflight'].includes(action) && owner.phase !== 'installed') throw new Error('The installation/runtime update is unfinished. Click Install to resume; no application was started.');
    assertWslRuntimeCompatible(owner);
    if (action === 'preflight') {
      // A previously owned Redis can be settled by guest preflight. Never recover it while
      // a Windows app/server (possibly foreign) still owns either application port.
      await this.assertHostPorts([LANE_PORTS.app, LANE_PORTS.server]);
      this.assertGuestRuntime(owner);
      await this.runGuest(owner, 'preflight', [owner.release, owner.commit]);
      await this.assertHostPorts();
      return;
    }
    this.assertGuestRuntime(owner);
    if (action === 'run') {
      if (!['redis', 'server', 'app'].includes(service)) throw new Error('Unknown Windows service.');
      await this.assertHostPorts([LANE_PORTS[service]]);
      await this.runGuest(owner, 'run', [service, owner.release, owner.commit]);
    } else if (action === 'reset') {
      await this.assertHostPorts();
      await this.withOperation(async () => {
        const current = this.readOwner();
        this.assertHostRelease(current);
        await this.runGuest(current, 'reset', [current.release, current.commit]);
        this.writeOwner({ ...current, phase: 'reset' });
      });
    } else if (action === 'delete-data') {
      if (confirm !== 'DELETE') throw new Error('Deletion was not confirmed; no data was changed.');
      await this.assertHostPorts();
      await this.withOperation(async () => {
        const current = this.readOwner();
        this.assertHostRelease(current);
        await this.runGuest(current, 'delete-data', [current.release, current.commit]);
        this.writeOwner({ ...current, dataPresent: false });
      });
    } else await this.runGuest(owner, 'preflight', [owner.release, owner.commit]);
  }
}

export function windowsMenuState() { return new WindowsWslAdapter().menuState(); }
export function windowsPrerequisites() { return new WindowsWslAdapter().prerequisites(); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'enable-wsl-system') {
      const system = checkedSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::SystemDirectory']);
      process.exitCode = runSystemWslSetup({ systemDirectory: system });
    } else {
      const adapter = new WindowsWslAdapter();
      if (process.argv[2] === 'enable-wsl') await adapter.enableWsl(process.env.BATSHIT_WSL_SETUP_CONFIRM);
      else await adapter.execute(process.argv[2], process.argv[3], process.argv[2] === 'finish-install' ? process.argv[4] : process.env.BATSHIT_DELETE_CONFIRM);
    }
  } catch (error) { console.log(`Error: ${error.message}`); process.exitCode = 1; }
}
