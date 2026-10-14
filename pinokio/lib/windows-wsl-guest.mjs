// Runs only in the owned Linux guest. Install/Reset hold the EXISTING data admission for
// the whole operation. Ordinary subprocesses receive no admission/run-end descriptor or
// host secrets; only the dedicated Node runtime writer inherits reader3 for crash lifetime.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admit, releaseAdmission, runtimeWriterStdio } from './admission.mjs';
import { laneDataPaths, laneDataRoot, LANE_PORTS } from './lane.mjs';
import { startChild } from './service-child.mjs';
import { assertPhysicalPath } from './windows-wsl.mjs';
import { codeReleaseTuple, validateWindowsRelease, WSL_ASSETS, WSL_NODE_VERSION, WSL_CODE, WSL_CODE_RESET_PATHS, WSL_CODE_RESET_FILES, WSL_ENV, WSL_HOME, WSL_PROTOCOL } from './windows-wsl-contract.mjs';
import { checkSavedDataForInstall, settleLaneBeforeMaintenance } from './cli.mjs';

export function assertGuestIdentity(nonce, { platform = process.platform, uid = process.getuid?.(), home = process.env.HOME, recordedNonce } = {}) {
  if (platform !== 'linux' || uid !== 1000 || home !== WSL_HOME || !/^[a-f0-9]{32}$/.test(nonce) || recordedNonce !== nonce) {
    throw new Error('The owned Linux user/environment identity differs; no data was changed.');
  }
}

export function guestGitArgs(directory, args, trustedSource) {
  // DrvFS uses the imported distro's default root ownership. Only this bound physical
  // Windows release source gets command-scoped trust. Worktree reads and local
  // clone/upload-pack can identify it differently, so include its exact physical .git.
  // The guest's UID-1000 ext4 checkout keeps Git's ordinary ownership checks.
  if (trustedSource && (!/^\/mnt\/[a-z]\//.test(trustedSource) || /[\r\n\0]/.test(trustedSource))) throw new Error('The mounted release source is invalid.');
  const trust = trustedSource ? ['-c', `safe.directory=${trustedSource}`, '-c', `safe.directory=${join(trustedSource, '.git')}`] : [];
  let operation = args;
  if (trustedSource && ['clone', 'fetch'].includes(args[0])) {
    // Git's local transport strips caller config before upload-pack. Its documented
    // command option must carry these same exact exceptions into the actual child.
    // Only literal arguments enter the shell command; the executable/subcommand are fixed.
    const quoted = trust.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
    operation = [args[0], `--upload-pack=/usr/bin/git ${quoted} upload-pack`, ...args.slice(1)];
  }
  return [...trust, '-C', directory, ...operation];
}

function git(directory, args, trustedSource) {
  const result = spawnSync('git', guestGitArgs(directory, args, trustedSource), { encoding: 'utf8', env: WSL_ENV });
  if (result.error || result.status !== 0) throw new Error(`The released code operation failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

async function portsAreFree() {
  for (const port of Object.values(LANE_PORTS)) await new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once('error', () => reject(new Error(`Linux port ${port} is still in use; stop Batshit before changing its installation.`)));
    socket.listen({ host: '127.0.0.1', port, exclusive: true }, () => socket.close(resolvePort));
  });
}

function physicalCodeRoot(directory) {
  assertPhysicalPath(directory, { directory: true, allowMissing: true });
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error('A linked/non-directory code root is refused.');
  if (existsSync(join(directory, '.git')) && lstatSync(join(directory, '.git')).isSymbolicLink()) throw new Error('A linked Git directory is refused.');
}

export async function resetCode(directory = WSL_CODE) {
  physicalCodeRoot(directory);
  const targets = [];
  for (const [relative, directoryTarget] of [...WSL_CODE_RESET_PATHS.map(p => [p, true]), ...WSL_CODE_RESET_FILES.map(p => [p, false])]) {
    const target = join(directory, relative);
    // Check every component, including an intermediate app/server directory. Validate the
    // complete allowlist before the first erase so a later refusal leaves all outputs intact.
    assertPhysicalPath(target, { directory: directoryTarget, allowMissing: true });
    if (existsSync(target)) targets.push(target);
  }
  for (const target of targets) await rm(target, { recursive: true });
}

export function assertBoundGuestRelease(directory, release, commit) {
  physicalCodeRoot(directory);
  const protocol = JSON.parse(readFileSync(join(directory, 'pinokio', 'windows-wsl-protocol.json'), 'utf8'));
  validateWindowsRelease({ release, commit, declaredRelease: readFileSync(join(directory, 'pinokio', 'RELEASE'), 'utf8'), protocol });
  if (git(directory, ['rev-parse', 'HEAD']) !== commit) throw new Error('The guest and Windows launcher releases differ. Click Install or Update.');
}

export function selectMaintenanceCode(directory, old, pending) {
  for (const tuple of [old, pending]) if (tuple) codeReleaseTuple(tuple.release, tuple.commit);
  try { lstatSync(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (old) throw new Error('Established guest code is missing; nothing was adopted.');
    return null; // Initial install has not cloned code yet.
  }
  physicalCodeRoot(directory);
  const head = git(directory, ['rev-parse', 'HEAD']);
  const selected = [old, pending].find(tuple => tuple && tuple.commit === head);
  if (!selected) throw new Error('The guest checkout is neither the recorded old nor pending target; it was retained.');
  assertBoundGuestRelease(directory, selected.release, selected.commit);
  if (git(directory, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('The recorded guest release has edited tracked files; they were retained.');
  return selected;
}

async function runChild(command, args, cwd, env = WSL_ENV, stdio = ['inherit', 'inherit', 'inherit']) {
  const { exited } = startChild('Linux install', { command, args, cwd, env }, stdio);
  const code = await exited;
  if (code !== 0) throw new Error('The Linux step did not finish; existing data was retained.');
}

export async function upgradeNodeRuntime({ nonce, archive, newSha, newVersion, oldSha, oldVersion }, { dataRoot = laneDataRoot(), settle = settleLaneBeforeMaintenance, install = runChild } = {}) {
  if (!/^[a-f0-9]{32}$/.test(nonce ?? '') || newSha !== WSL_ASSETS[1].sha256 || newVersion !== WSL_NODE_VERSION || !/^[a-f0-9]{64}$/.test(oldSha ?? '') || !/^v24\.[0-9]+\.[0-9]+$/.test(oldVersion ?? '')) throw new Error('The Node replacement tuple differs from the released pins/owned runtime.');
  assertPhysicalPath(archive);
  const admission = admit({ role: 'delete', label: 'nodeupdate', dataRoot });
  if (!admission.ok) throw new Error(admission.message);
  try {
    const blocking = await settle(laneDataPaths(dataRoot), { action: 'runtime-update' });
    if (blocking.length) throw new Error(`The Node update was held by owned/unknown runtime records: ${blocking.map(entry => `${entry.label ?? entry.service} (${entry.result}; ${(entry.recordPaths ?? [entry.recordPath]).filter(Boolean).join(', ')})`).join('; ')}. Confirm those engines/services ended and repair the named records; they and data were retained.`);
    // Narrow writer exception: reader3 belongs to this actual Bash runtime writer and its
    // writing descendants until they end, even if this driver is killed. It is no run-end
    // pipe; ordinary npm/build/prune children above still use ONLY stdio0/1/2. Writer's own
    // persistent flock separately excludes a second Delete-role writer during crash recovery.
    await install('/bin/bash', [join(fileURLToPath(new URL('.', import.meta.url)), 'windows-wsl-bootstrap.sh'), 'install-node', nonce, archive, newSha, newVersion, oldSha, oldVersion], WSL_HOME, WSL_ENV, runtimeWriterStdio(admission, ['inherit', 'inherit', 'inherit']));
  } finally { releaseAdmission(admission); }
}

export async function maintainGuestInstallation({ release, commit, pendingRelease, pendingCommit, dataPresent }, { dataRoot = laneDataRoot(), selectCode = () => selectMaintenanceCode(WSL_CODE, codeReleaseTuple(release, commit), codeReleaseTuple(pendingRelease, pendingCommit)), loadEstablished = async () => import(pathToFileURL(join(WSL_CODE, 'pinokio/lib/cli.mjs')).href), settleFresh = settleLaneBeforeMaintenance } = {}) {
  const admission = admit({ role: 'delete', label: 'installcheck', dataRoot });
  if (!admission.ok) throw new Error(admission.message);
  try {
    await checkSavedDataForInstall(laneDataPaths(dataRoot), { dataPresent });
    let blocking;
    const selected = selectCode();
    if (selected) {
      const tools = await loadEstablished();
      if (typeof tools.settleLaneBeforeInstall !== 'function') throw new Error('The established guest release has no compatible maintenance guard; data and runtime were retained.');
      blocking = await tools.settleLaneBeforeInstall(laneDataPaths(dataRoot));
    } else {
      // No established guest code/runtime exists yet. Never substitute a host Redis binary.
      blocking = await settleFresh(laneDataPaths(dataRoot), { action: 'install' });
    }
    if (blocking.length) throw new Error(`Install was held by owned/unknown runtime records: ${blocking.map(entry => `${entry.label ?? entry.service} (${entry.result})`).join('; ')}; records and data were retained.`);
    return selected;
  } finally { releaseAdmission(admission); }
}

export async function installGuestCode({ source, release, commit, directory = WSL_CODE }, { build = runChild, finish = async () => {
  const tools = await import(pathToFileURL(join(directory, 'pinokio/lib/cli.mjs')).href);
  await tools.installRedis({ baseLibDir: '/usr/lib/x86_64-linux-gnu' });
  await tools.prepareDataFiles(laneDataPaths(laneDataRoot()));
  await tools.markInstalled();
} } = {}) {
    // Only the independently validated RELEASE/tag is a code source. A build failure after
    // this checkout leaves the host's pending tuple as the sole additional recovery authority.
    assertPhysicalPath(source, { directory: true });
    assertPhysicalPath(join(source, '.git'), { directory: true });
    const taggedCommit = git(source, ['rev-parse', '--verify', `${release}^{commit}`], source.startsWith('/mnt/') ? source : undefined);
    const declaredRelease = git(source, ['show', `${release}:pinokio/RELEASE`], source.startsWith('/mnt/') ? source : undefined);
    const protocol = JSON.parse(git(source, ['show', `${release}:pinokio/windows-wsl-protocol.json`], source.startsWith('/mnt/') ? source : undefined));
    validateWindowsRelease({ release, commit, declaredRelease, protocol });
    if (taggedCommit !== commit || protocol.version !== WSL_PROTOCOL) throw new Error('The released host source changed; stopped before install.');
    physicalCodeRoot(directory);
    const freshClone = !existsSync(directory);
    if (freshClone) {
      const result = spawnSync('git', guestGitArgs(source, ['clone', '--no-local', '--no-hardlinks', '--no-checkout', source, directory], source.startsWith('/mnt/') ? source : undefined), { env: WSL_ENV, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('The released Linux code could not be cloned.');
    }
    if (!freshClone && git(directory, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('The Linux release has edited files; they were retained.');
    git(directory, ['remote', 'set-url', 'origin', source]);
    git(directory, ['fetch', '--tags', 'origin'], source.startsWith('/mnt/') ? source : undefined);
    git(directory, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', release]);
    assertBoundGuestRelease(directory, release, commit);
    for (const [folder, args, extra] of [
      ['batshit-app', ['ci', '--no-audit', '--no-fund']],
      ['batshit-server/server', ['ci', '--omit=dev', '--no-audit', '--no-fund']],
      ['batshit-app', ['run', 'build:anchored-reader', '--', '--if-supported']],
      ['batshit-app', ['run', 'build'], { BATSHIT_SVELTE_ADAPTER: 'node' }],
      ['batshit-app', ['prune', '--omit=dev', '--no-save', '--no-audit', '--no-fund']]
    ]) await build('npm', args, join(directory, folder), { ...WSL_ENV, ...extra });
    await finish();
}

export async function runGuestOperation({ action, source, release, commit, service, dataPresent }) {
  if (!['install', 'reset', 'preflight', 'run', 'delete-data'].includes(action)) throw new Error('Unknown guest operation.');
  if (action === 'run' && !['redis', 'server', 'app'].includes(service)) throw new Error('Unknown guest service.');
  if (action !== 'install') assertBoundGuestRelease(WSL_CODE, release, commit);
  if (action === 'run' || action === 'preflight' || action === 'delete-data') {
    return runChild(process.execPath, [join(WSL_CODE, 'pinokio/lib/cli.mjs'), ...(action === 'run' ? ['run', service] : [action])], WSL_CODE, {
      ...WSL_ENV, ...(action === 'delete-data' ? { BATSHIT_DELETE_CONFIRM: 'DELETE' } : {})
    });
  }
  const admission = admit({ role: 'delete', label: action === 'reset' ? 'reset' : 'install', dataRoot: laneDataRoot() });
  if (!admission.ok) throw new Error(admission.message);
  try {
    if (action === 'install') await checkSavedDataForInstall(laneDataPaths(laneDataRoot()), { dataPresent });
    await portsAreFree();
    if (action === 'reset') return resetCode();
    await installGuestCode({ source, release, commit });
  } finally { releaseAdmission(admission); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, nonce, source, ...args] = process.argv.slice(2);
    const instanceFile = '/etc/batshit-pinokio-instance';
    const identity = lstatSync(instanceFile);
    if (identity.isSymbolicLink() || !identity.isFile() || identity.uid !== 0 || (identity.mode & 0o022)) throw new Error('Guest ownership file is not a protected root-owned file.');
    assertGuestIdentity(nonce, { recordedNonce: readFileSync(instanceFile, 'utf8').trim() });
    if (action === 'upgrade-node') {
      const [archive,newSha,newVersion,oldSha,oldVersion] = args;
      await upgradeNodeRuntime({ nonce,archive,newSha,newVersion,oldSha,oldVersion });
    } else if (action === 'maintain-install') {
      const [release,commit,state,pendingRelease,pendingCommit] = args;
      if (!['empty','kept'].includes(state)) throw new Error('Unknown saved-data disposition.');
      const selected = await maintainGuestInstallation({release:release||undefined,commit:commit||undefined,pendingRelease:pendingRelease||undefined,pendingCommit:pendingCommit||undefined,dataPresent:state==='kept'});
      console.log(`Batshit: maintenance code ${JSON.stringify(selected)}`);
    } else {
      const [service, release, commit] = action === 'run' ? args : [undefined, ...args];
      const state = action === 'install' ? args[2] : undefined;
      if (action === 'install' && !['empty','kept'].includes(state)) throw new Error('Unknown saved-data disposition.');
      await runGuestOperation({ action, source, release, commit, service, dataPresent:state==='kept' });
    }
  } catch (error) { console.log(`Error: ${error.message}`); process.exitCode = 1; }
}
