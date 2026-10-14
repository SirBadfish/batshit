#!/usr/bin/env node
// The steps behind Batshit's Pinokio buttons (install.js, start.js, update.js, delete-data.js).
// Each command either finishes with a plain progress line or prints one line that starts with
// "Error:" and exits 1: Pinokio stops the script on that line and shows it to the user. Normal
// output never contains that word followed by a colon, for the same reason.
import { spawnSync } from 'node:child_process';
import { startChild } from './service-child.mjs';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appEnv,
  childEnv,
  formatSecretsFile,
  generateSecrets,
  LANE_HOST,
  LANE_PORTS,
  laneDataFolders,
  laneDataPaths,
  laneDataRoot,
  laneVoiceRuntimeOwner,
  parseEnvText,
  redisServerArgs,
  resolveLaunchProfile,
  secretProblems,
  serverEnv,
  sharedLaneEnv
} from './lane.mjs';
import {
  describeEnginesBlockingDelete,
  describeServicesBlockingDelete,
  decideLaneVoiceRuntimeGroupStop,
  logTail,
  pinokioSafeText,
  proveLanePortsIdle,
  recordsAreLaneOwned,
  resolvePinokioEngineStopPolicy,
  rotateLog,
  settleBeforeDelete,
  settleBeforeStart,
  settleLeftoverSandboxServices,
  stopLeftoverVoiceEngines,
  superviseRedis,
  waitForOwnRedis
} from './lifecycle.mjs';
import {
  installRedisRuntime,
  REDIS_BUNDLED_MODULES,
  REDIS_PINNED_VERSION,
  redisProcessEnv,
  redisRuntimeDownloads
} from './redis-runtime.mjs';
import { admit, assertNoAdmissionFd, releaseAdmission, serviceStdio } from './admission.mjs';
import { handOffStopWatch, runStopWatch, startLaneStopWatch } from './stop-watch.mjs';
import {
  isLocalRuntimeProcessAlive,
  readLocalRuntimeLaunchRecords,
  readLocalRuntimeProcessGroup
} from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs';

const cliPath = fileURLToPath(import.meta.url);
const launcherDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(launcherDir);
const runtimeDir = join(launcherDir, 'runtime');
const redisRuntime = join(runtimeDir, 'redis');
const installedMarker = join(runtimeDir, 'installed.json');
const appDir = join(repoRoot, 'batshit-app');
const serverDir = join(repoRoot, 'batshit-server', 'server');
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MINIMUM_NODE_MAJOR = 24;
let launchProfile;
let engineStopPolicy;

class LauncherError extends Error {}

function say(message) {
  console.log(`Batshit: ${message}`);
}

function fail(message) {
  throw new LauncherError(message);
}

// BL-1270: the six commands that read or touch the data root hold an admission for their whole
// life (admission.mjs), so a Start and Delete Batshit data never overlap. The stop-watch takes
// none, by design: it creates nothing, removes no record, and re-reads before each signal. A refusal fails here, before the
// root is read or touched; its message is already safe for Pinokio's terminal.
function admitOrFail(role, label) {
  const admission = admit({ role, label, dataRoot: laneDataRoot() });
  if (!admission.ok) fail(admission.message);
  return admission;
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(' ')} did not work: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

async function releaseTag(text) {
  const tag = text.trim();
  if (!RELEASE_TAG.test(tag)) fail(`pinokio/RELEASE should name a release tag such as v0.1.0, not "${tag}".`);
  return tag;
}

function headIsAt(tag) {
  const head = git(['rev-parse', 'HEAD']);
  const tagged = git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { allowFailure: true });
  return Boolean(tagged) && head === tagged;
}

function checkoutTag(tag) {
  const changed = git(['status', '--porcelain', '--untracked-files=no']);
  if (changed) {
    fail(`The Batshit folder has changed files, so the launcher will not switch versions over them:\n${changed}`);
  }
  if (!git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { allowFailure: true })) {
    fail(`The release ${tag} is not published yet. Try again later, or ask in the Batshit Discord.`);
  }
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', tag]);
}

// DL-02: Batshit is built from the release the launcher names, never from the main branch.
async function checkoutRelease() {
  const tag = await releaseTag(await readFile(join(launcherDir, 'RELEASE'), 'utf8'));
  git(['fetch', '--quiet', '--tags', '--force', 'origin']);
  if (headIsAt(tag)) {
    say(`release ${tag} is checked out.`);
    return;
  }
  checkoutTag(tag);
  say(`checked out release ${tag}.`);
}

// Update moves to the release named by the newest launcher on the repository's default branch.
async function updateRelease() {
  git(['fetch', '--quiet', '--tags', '--force', 'origin']);
  if (!git(['rev-parse', '--verify', '--quiet', 'origin/HEAD'], { allowFailure: true })) {
    git(['remote', 'set-head', 'origin', '--auto']);
  }
  const newest = await releaseTag(git(['show', 'origin/HEAD:pinokio/RELEASE']));
  const current = await releaseTag(await readFile(join(launcherDir, 'RELEASE'), 'utf8'));
  if (newest === current && headIsAt(current)) {
    say(`release ${current} is the newest. Rebuilding it.`);
    return;
  }
  checkoutTag(newest);
  say(`moved from ${current} to release ${newest}.`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function installRedis({ baseLibDir } = {}) {
  const wanted = redisRuntimeDownloads({ platform: process.platform, arch: process.arch }).map((d) => d.sha256);
  if (existsSync(join(redisRuntime, 'SOURCE.json'))) {
    const source = await readJson(join(redisRuntime, 'SOURCE.json')).catch(() => null);
    const have = source?.downloads?.map((d) => d.sha256) ?? [];
    if (source?.redis === REDIS_PINNED_VERSION && JSON.stringify(have) === JSON.stringify(wanted)) {
      say(`Redis ${REDIS_PINNED_VERSION} is already installed.`);
      return;
    }
  }
  await installRedisRuntime({ dest: redisRuntime, downloadsDir: join(runtimeDir, 'downloads'), ...(baseLibDir ? { baseLibDir } : {}), log: say });
}

async function readSecrets(paths) {
  if (!existsSync(paths.secretsFile)) {
    fail(`Batshit's secrets file is missing (${paths.secretsFile}). Restore the original keys if saved data remains; Install can initialize keys only over absent or verified empty data.`);
  }
  const values = parseEnvText(await readFile(paths.secretsFile, 'utf8'));
  const problems = secretProblems(values);
  if (problems.length > 0) {
    fail(
      `${paths.secretsFile} is damaged (${problems.join('; ')}). Restore it from a backup: a new key cannot read the API keys you saved.`
    );
  }
  return values;
}

// Internal reuse by the WSL installer, which already holds an exclusive delete-role
// admission. Ordinary prepare-data still takes its own start reader.
export async function prepareDataFiles(paths) {
  // Every caller, including native prepare-data, must refuse replacement keys over
  // saved/unverified content. Windows separately requires its explicit dataPresent state.
  await checkSavedDataForInstall(paths, { dataPresent: false });
  for (const folder of laneDataFolders(paths)) await mkdir(folder, { recursive: true });
  await chmod(paths.root, 0o700);
  if (existsSync(paths.secretsFile)) {
    await readSecrets(paths);
    say(`using your existing data in ${paths.root}`);
    return;
  }
  await writeFile(paths.secretsFile, formatSecretsFile(generateSecrets()), { mode: 0o600, flag: 'wx' });
  say(`created your data folder: ${paths.root}`);
}

// Windows' explicit new/typed-deleted state may initialize keys only over absent/empty
// data (including known empty folders from an interrupted first preparation). A retained
// instance with missing/corrupt keys never silently gets a replacement encryption key.
export async function checkSavedDataForInstall(paths, { dataPresent }) {
  if (typeof dataPresent !== 'boolean') fail('saved-data ownership is unknown; nothing was initialized.');
  try {
    const file = await lstat(paths.secretsFile);
    if (file.isSymbolicLink() || !file.isFile()) fail('the saved secrets path is not a physical regular file; it was retained.');
    await readSecrets(paths);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (dataPresent) fail('the retained instance’s secrets are missing; restore the original keys before Install. No new encryption key was created.');
  const allowed = new Set(laneDataFolders(paths));
  const checkEmpty = async folder => {
    let info;
    try { info = await lstat(folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!allowed.has(folder) || info.isSymbolicLink() || !info.isDirectory()) fail('unverified data remains without its original keys; nothing was initialized.');
    for (const entry of await readdir(folder)) await checkEmpty(join(folder, entry));
  };
  await checkEmpty(paths.root);
}

// DL-05: the data folder and its two secrets are created once and never overwritten.
async function prepareData() {
  const admission = admitOrFail('start', 'prepare');
  try {
    const paths = laneDataPaths(laneDataRoot());
    await prepareDataFiles(paths);
  } finally {
    releaseAdmission(admission);
  }
}

export async function markInstalled() {
  const release = (await readFile(join(launcherDir, 'RELEASE'), 'utf8')).trim();
  for (const required of [join(appDir, 'build', 'index.js'), join(serverDir, 'node_modules'), join(redisRuntime, 'SOURCE.json')]) {
    if (!existsSync(required)) fail(`the install did not finish: ${required} is missing. Click Install again.`);
  }
  // An install step that edits a file of the release would block the next Update's checkout;
  // catch it here, where the cause is still in view.
  const changed = git(['status', '--porcelain', '--untracked-files=no']);
  if (changed) fail(`an install step changed files of the release, which would block updates:\n${changed}`);
  await writeFile(
    installedMarker,
    `${JSON.stringify({ release, commit: git(['rev-parse', 'HEAD']), node: process.version, installedAt: new Date().toISOString() }, null, 2)}\n`
  );
  say(`release ${release} is installed. Click Start.`);
}

function portIsFree(port) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.listen({ port, host: LANE_HOST, exclusive: true }, () => probe.close(() => resolvePort(true)));
  });
}

function portHolder(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return '';
  const pid = result.stdout.match(/^p(\d+)/m)?.[1];
  const command = result.stdout.match(/^c(.+)$/m)?.[1];
  return pid ? ` (held by ${command || 'a program'}, process ${pid})` : '';
}

function redisCli(args) {
  const result = spawnSync(
    join(redisRuntime, 'bin', 'redis-cli'),
    ['-h', LANE_HOST, '-p', String(LANE_PORTS.redis), ...args],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, ...redisProcessEnv(redisRuntime) } }
  );
  return result.status === 0 ? (result.stdout || '').trim() : null;
}

// A Redis on the lane's port that serves this lane's own data folder is Batshit's own, left
// running when Pinokio closed without stopping it. It is shut down cleanly (it saves first).
async function stopOwnLeftoverRedis(paths) {
  const reply = redisCli(['CONFIG', 'GET', 'dir']);
  const dir = reply?.split('\n')[1];
  if (!dir || dir !== (await realpath(paths.redis))) return false;
  say('found Batshit\'s own database still running from an earlier start. Stopping it cleanly first.');
  redisCli(['SHUTDOWN']);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await portIsFree(LANE_PORTS.redis)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  fail(`Batshit's earlier database did not stop on port ${LANE_PORTS.redis}. Restart the computer and try again.`);
}

async function preflight() {
  if (!existsSync(installedMarker)) fail('Batshit is not installed yet. Click Install first.');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MINIMUM_NODE_MAJOR) {
    fail(`Batshit needs Node.js ${MINIMUM_NODE_MAJOR} or newer; Pinokio's is ${process.version}. Update Pinokio.`);
  }
  const admission = admitOrFail('start', 'preflight');
  try {
    const paths = laneDataPaths(laneDataRoot());
    await readSecrets(paths);
    for (const folder of laneDataFolders(paths)) await mkdir(folder, { recursive: true });
    // Once every lane port is idle, no Batshit of this lane is serving: what its voice engines'
    // records still name was left by an earlier start that Pinokio's Stop ended (BL-343), and so
    // were the sandbox services its records name (BL-1249).
    await settleBeforeStart({
      isFree: portIsFree,
      stopOwnLeftoverRedis: () => stopOwnLeftoverRedis(paths),
      busy: (name, port) =>
        new LauncherError(
          `port ${port} is in use${portHolder(port)}. Batshit's Pinokio install needs ports ${LANE_PORTS.app}, ${LANE_PORTS.server}, and ${LANE_PORTS.redis} for its ${name}. Close that program, then click Start again.`
        ),
      stopLeftoverEngines: () => stopLeftoverVoiceEngines({ stateRoot: paths.voiceEngines, owner: laneVoiceRuntimeOwner(paths), say, engineStopPolicy }),
      stopLeftoverServices: () => settleLeftoverSandboxServices({ paths, owner: laneVoiceRuntimeOwner(paths), say })
    });
    say(`ready to start on ports ${LANE_PORTS.app}, ${LANE_PORTS.server}, and ${LANE_PORTS.redis}.`);
  } finally {
    releaseAdmission(admission);
  }
}

// The Docker lane's BL-111 rule: Redis started append-only on a folder that holds only a
// snapshot loads nothing and then overwrites the snapshot. This lane is append-only from its
// first start, so such a folder was put there by hand; refuse rather than lose it.
function assertRedisFolderIsSafe(redisDir) {
  if (existsSync(join(redisDir, 'dump.rdb')) && !existsSync(join(redisDir, 'appendonlydir', 'appendonly.aof.manifest'))) {
    fail(
      `${redisDir} holds a Redis snapshot (dump.rdb) without an append-only file. Starting would lose it. Move it aside, or restore Batshit data with Admin → Backup instead.`
    );
  }
}

async function serviceCommand(service) {
  const paths = laneDataPaths(laneDataRoot());
  const secrets = await readSecrets(paths);
  const shared = sharedLaneEnv({ paths, secrets });
  if (service === 'redis') {
    assertRedisFolderIsSafe(paths.redis);
    return {
      command: join(redisRuntime, 'bin', 'redis-server'),
      args: redisServerArgs({
        redisDir: paths.redis,
        moduleDir: join(redisRuntime, 'lib'),
        modules: REDIS_BUNDLED_MODULES,
        logFile: paths.redisLog,
        launchProfile
      }),
      cwd: paths.redis,
      env: { ...process.env, ...redisProcessEnv(redisRuntime) },
      paths
    };
  }
  if (service === 'server') {
    return { command: process.execPath, args: ['src/index.js'], cwd: serverDir, env: childEnv(process.env, serverEnv(shared)) };
  }
  if (service === 'app') {
    return { command: process.execPath, args: ['build'], cwd: appDir, env: childEnv(process.env, appEnv(shared)) };
  }
  fail(`unknown service "${service}"; expected redis, server, or app.`);
}

// The stop-watch (BL-1252): started by the app's run before the app, outside Pinokio's process
// tree, it applies each voice engine's "Stop with Batshit" choice once this run ends.
async function startAppStopWatch(admission) {
  const logs = dirname(laneDataPaths(laneDataRoot()).redisLog);
  await startLaneStopWatch({
    logFile: join(logs, 'stop-watch.log'),
    previousLogFile: join(logs, 'stop-watch.previous.log'),
    rotate: rotateLog,
    handoffArgs: [cliPath, 'stop-watch-handoff'],
    cwd: launcherDir,
    env: process.env,
    sanitize: pinokioSafeText,
    print: (line) => console.log(line),
    // The handoff and the watcher keep slot 3 for their own run-end pipe: never the admission.
    checkStdio: (stdio) => assertNoAdmissionFd(stdio, admission)
  });
}

// The watcher's body, with the lane's real pieces. Its output goes to the log `run app` opened.
async function runLaneStopWatch() {
  const paths = laneDataPaths(laneDataRoot());
  const owner = laneVoiceRuntimeOwner(paths);
  // pinokioSafeText cuts at its limit, so a long line is written in pieces that each fit.
  const log = (line) => {
    const stamp = new Date().toISOString();
    const text = String(line ?? '').replace(/\s+/g, ' ').trim();
    for (let at = 0; at === 0 || at < text.length; at += 200) console.log(`${stamp} ${pinokioSafeText(text.slice(at, at + 200))}`);
  };
  await runStopWatch({
    owner,
    readRecords: () => readLocalRuntimeLaunchRecords(paths.voiceEngines),
    isAlive: isLocalRuntimeProcessAlive,
    readGroup: readLocalRuntimeProcessGroup,
    decide: (inputs) => decideLaneVoiceRuntimeGroupStop(inputs, { engineStopPolicy }),
    isLaneOwned: recordsAreLaneOwned,
    lane: { host: LANE_HOST, ports: [LANE_PORTS.server, LANE_PORTS.app, LANE_PORTS.redis] },
    settle: ({ terminate, removeRecord }) =>
      stopLeftoverVoiceEngines({ stateRoot: paths.voiceEngines, owner, say: log, terminate, removeRecord, engineStopPolicy }),
    log
  });
}

// Runs one Batshit process in the foreground so Pinokio's terminal shows its output and
// Pinokio's Stop ends it.
async function runService(service) {
  // Checked before the admission, so a mistyped name publishes nothing.
  if (service !== 'server' && service !== 'app') fail(`unknown service "${service}"; expected redis, server, or app.`);
  // Before anything touches the root: the stop-watch log is in it.
  const admission = admitOrFail('start', service);
  try {
    if (service === 'app') await startAppStopWatch(admission);
    const command = await serviceCommand(service);
    // The service child keeps the admission reader as descriptor 3 until it exits.
    const { exited } = startChild(service, command, serviceStdio(admission, ['inherit', 'inherit', 'inherit']));
    const code = await exited;
    if (code !== 0) console.log(`Error: Batshit's ${service} stopped (exit code ${code}). The lines above say why.`);
    process.exitCode = code;
  } finally {
    releaseAdmission(admission);
  }
}

async function printRedisLogTail(paths) {
  const lines = await logTail(paths.redisLog);
  if (lines.length === 0) return;
  console.log(`Batshit: the last lines of the database's log (${paths.redisLog}):`);
  for (const line of lines) console.log(`  ${line}`);
}

// Redis logs to its own file, so this terminal stays quiet after the ready line Start waits for
// (BL-363). The line is printed once Redis's own process answers PONG; when Redis ends, the end
// of its log comes before the Error line, so the terminal still says why.
async function runRedis() {
  const admission = admitOrFail('start', 'redis');
  try {
    const command = await serviceCommand('redis');
    const { paths } = command;
    await rotateLog(paths.redisLog, paths.redisPreviousLog);
    // redis-server keeps the admission reader as descriptor 3 until it exits.
    const { child, exited } = startChild('database', command, serviceStdio(admission, ['ignore', 'inherit', 'inherit']));
    if (!Number.isInteger(child.pid)) {
      // It never started; startChild has printed why.
      process.exitCode = await exited;
      return;
    }
    process.exitCode = await superviseRedis({
      exited,
      waitReady: () =>
        waitForOwnRedis({
          host: LANE_HOST,
          port: LANE_PORTS.redis,
          pid: child.pid,
          exited,
          onSlow: () => say('the database is still loading your data. A large database takes longer.')
        }),
      print: (line) => console.log(line),
      printLogTail: () => printRedisLogTail(paths)
    });
  } finally {
    releaseAdmission(admission);
  }
}

// Caller must hold the existing Delete-role admission through this guard and every mutation.
// Runtime replacement reuses it; this function neither erases data nor admits a second holder.
export async function settleLaneBeforeMaintenance(paths, { engineStopPolicy: policy = resolvePinokioEngineStopPolicy(), action = 'delete' } = {}) {
  return settleBeforeDelete({
    isFree: portIsFree,
    busy: (name, port) => new LauncherError(
      action === 'delete'
        ? `nothing was deleted: port ${port} is in use${portHolder(port)}. If Batshit is running, press Pinokio's stop button; if Pinokio does not show it running, click Start, then stop it; if another program holds the port, close it. Then delete again.`
        : `the runtime update was held: port ${port} is in use${portHolder(port)}. Stop Batshit or its owning program, then Update again; data was retained.`
    ),
    stopLeftoverEngines: () => stopLeftoverVoiceEngines({ stateRoot: paths.voiceEngines, owner: laneVoiceRuntimeOwner(paths), say, engineStopPolicy: policy }),
    stopLeftoverServices: () => settleLeftoverSandboxServices({ paths, owner: laneVoiceRuntimeOwner(paths), say })
  });
}

// Install/Update may recover this established guest runtime's exact owned Redis without
// requiring installed.json. After Reset the missing redis-cli cannot prove a held port,
// so it safely refuses; when all ports are free, the same guard remains usable.
export async function settleLaneBeforeInstall(paths) {
  await proveLanePortsIdle({
    isFree: portIsFree,
    stopOwnLeftoverRedis: () => stopOwnLeftoverRedis(paths),
    busy: (name, port) => new LauncherError(`the install was held: port ${port} is in use${portHolder(port)}. Its ownership could not be recovered safely; stop its owning program and retry.`)
  });
  return settleLaneBeforeMaintenance(paths, { action: 'install' });
}

async function deleteData() {
  if (process.env.BATSHIT_DELETE_CONFIRM !== 'DELETE') {
    say('nothing was deleted: type DELETE, in capitals, to confirm.');
    return;
  }
  // Held through the whole erase: no Start command touches the root until rm has returned.
  const admission = admitOrFail('delete', 'delete');
  try {
    const paths = laneDataPaths(laneDataRoot());
    const blocking = await settleLaneBeforeMaintenance(paths, { engineStopPolicy });
    const engines = blocking.filter((entry) => !entry.service);
    const services = blocking.filter((entry) => entry.service);
    if (engines.length > 0 || services.length > 0) {
      const parts = [];
      if (engines.length > 0) parts.push(describeEnginesBlockingDelete(engines, { engineStopPolicy }));
      if (services.length > 0) parts.push(describeServicesBlockingDelete(services));
      fail(`nothing was deleted: ${parts.join(' ')}`);
    }
    await rm(paths.root, { recursive: true, force: true });
    say(`deleted ${paths.root}. Click Install to start again with a new, empty Batshit.`);
  } finally {
    releaseAdmission(admission);
  }
}

const commands = {
  'checkout-release': checkoutRelease,
  'update-release': updateRelease,
  'install-redis': installRedis,
  'prepare-data': prepareData,
  'mark-installed': markInstalled,
  preflight,
  run: () => (process.argv[3] === 'redis' ? runRedis() : runService(process.argv[3])),
  'delete-data': deleteData,
  // Not in Pinokio's menu: started only by the app's run, through startAppStopWatch.
  'stop-watch-handoff': async () => {
    process.exitCode = await handOffStopWatch({ watcherArgs: [cliPath, 'stop-watch'], cwd: launcherDir, env: process.env });
  },
  'stop-watch': runLaneStopWatch
};

if (process.argv[1] && resolve(process.argv[1]) === cliPath) {
  const command = commands[process.argv[2]];
  if (!command) {
    console.log(`Error: unknown launcher command "${process.argv[2] ?? ''}". Commands: ${Object.keys(commands).join(', ')}.`);
    process.exit(1);
  }
  try {
    launchProfile = resolveLaunchProfile({ env: process.env, platform: process.platform });
    engineStopPolicy = resolvePinokioEngineStopPolicy({ env: process.env, platform: process.platform });
    await command();
  } catch (error) {
    console.log(`Error: ${error instanceof LauncherError ? error.message : error?.stack || error}`);
    process.exit(1);
  }
}
