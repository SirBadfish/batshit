// Same-OS Node replacement on real temporary files and tiny synthetic archives. The Node/npm
// stand-ins prove transaction/ownership behavior only, never WSL or real runtime acceptance.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { admit, probeAdmissionEntry, releaseAdmission, runtimeWriterStdio } from './admission.mjs';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'batshit-wsl-node-')));
const SCRIPT = join(import.meta.dirname, 'windows-wsl-bootstrap.sh');
const NONCE = 'd'.repeat(32);
const NODE = process.execPath;
after(() => rmSync(ROOT, { recursive: true, force: true }));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// The product requires GNU stat and mv on Ubuntu. These fixture-only adapters give Mac tests
// exactly those formats and atomic rename semantics; they are never sourced by the product.
const PORTABILITY = process.platform === 'darwin' ? `
stat() {
  local path="$3"
  if [[ "$path" = /proc/self/fd/9 ]]; then
    [[ "$1" = -Lc && "$2" = %d:%i ]] || return 90
    /usr/bin/python3 -c 'import os; s=os.fstat(9); print(str(s.st_dev)+":"+str(s.st_ino))'
    return
  fi
  if [[ "$1" = -Lc ]]; then /usr/bin/stat -Lf "$2" "$path"; return; fi
  case "$2" in
    %u) /usr/bin/stat -f %u "$path" ;;
    %a) /usr/bin/stat -f %Lp "$path" ;;
    %h) /usr/bin/stat -f %l "$path" ;;
    %d|%i|%d:%i) /usr/bin/stat -f "$2" "$path" ;;
    *) return 90 ;;
  esac
}
sha256sum() { /usr/bin/shasum -a 256 "$@"; }
flock() {
  [[ "$1" = -n && "$2" = 9 ]] || return 90
  /usr/bin/python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)'
}
node_test_mv() {
  if [[ "$1" = -Tf || "$1" = -T ]]; then shift; fi
  if [[ "$1" = -- ]]; then shift; fi
  ${quote(NODE)} -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2"
}
mv() { node_test_mv "$@"; }
` : 'node_test_mv() { command mv "$@"; }';

function fixture(name) {
  const parent = join(ROOT, name);
  mkdirSync(parent, { mode: 0o700 });
  return { parent, prefix: join(parent, 'batshit-node') };
}

let sequence = 0;
function archive(version = 'v24.19.0', { tag = '', npmVersion = '11.0.0', npmTarget, probeLog } = {}) {
  const dir = join(ROOT, `archive-${++sequence}`);
  const payload = join(dir, 'payload', 'node');
  mkdirSync(join(payload, 'bin'), { recursive: true });
  const npmBin = join(payload, 'lib/node_modules/npm/bin');
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(join(payload, 'bin/node'), `#!/bin/sh\n${probeLog ? `printf 'probe\\n' >> ${quote(probeLog)}\n` : ''}printf '%s\\n' ${quote(version)}\n`, { mode: 0o755 });
  writeFileSync(join(npmBin, 'npm-cli.js'), `#!/bin/sh\nprintf '%s\\n' ${quote(npmVersion)}\n`, { mode: 0o755 });
  writeFileSync(join(npmBin, 'npx-cli.js'), '#!/bin/sh\nprintf "11.0.0\\n"\n', { mode: 0o755 });
  symlinkSync(npmTarget ?? '../lib/node_modules/npm/bin/npm-cli.js', join(payload, 'bin/npm'));
  symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', join(payload, 'bin/npx'));
  writeFileSync(join(payload, 'fixture-tag'), tag);
  const file = join(dir, 'node.tar.xz');
  const made = spawnSync('tar', ['-cJf', file, '-C', dirname(payload), 'node'], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return { file, sha: createHash('sha256').update(readFileSync(file)).digest('hex'), version };
}

function run(body, hooks = '') {
  return spawnSync('/bin/bash', ['-c', `source ${quote(SCRIPT)}\n${PORTABILITY}\n${hooks}\n${body}`], { encoding: 'utf8' });
}
function install(prefix, next, old = null, hooks = '') {
  return run(['install_node_archive', next.file, next.sha, NONCE, prefix, next.version,
    old?.sha ?? '', old?.version ?? ''].map(quote).join(' '), hooks);
}
function verify(prefix, selected) {
  return run(['verify_node_runtime', prefix, NONCE, selected.sha, selected.version].map(quote).join(' '));
}
function passed(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }
function refused(result) { assert.notEqual(result.status, 0, result.stdout); }
function selected(prefix, expected) {
  assert.equal(readlinkSync(join(prefix, 'current')), `node-${expected.sha}`);
  passed(verify(prefix, expected));
}

test('first install publishes only a fully verified runtime and readonly verification mutates nothing', () => {
  const { prefix } = fixture('initial');
  const next = archive();
  passed(install(prefix, next));
  selected(prefix, next);
  assert.equal(lstatSync(`${prefix}.owner`).mode & 0o777, 0o600);
  const before = readFileSync(`${prefix}.owner`, 'utf8');
  const listing = readdirSync(prefix).sort();
  passed(verify(prefix, next));
  assert.equal(readFileSync(`${prefix}.owner`, 'utf8'), before);
  assert.deepEqual(readdirSync(prefix).sort(), listing);
});

test('same-OS Node24 replacement and a same-version checksum re-pin remove only exact verified old runtimes', () => {
  const { prefix } = fixture('upgrade');
  const old = archive('v24.19.0', { tag: 'old' });
  const next = archive('v24.21.0', { tag: 'new' });
  const repin = archive('v24.21.0', { tag: 'repin' });
  passed(install(prefix, old));
  passed(install(prefix, next, old));
  selected(prefix, next);
  assert.equal(existsSync(join(prefix, `node-${old.sha}`)), false);
  passed(install(prefix, repin, next));
  selected(prefix, repin);
  assert.equal(existsSync(join(prefix, `node-${next.sha}`)), false);
  passed(install(prefix, repin, next));
  selected(prefix, repin);
});

test('extraction interruption keeps an old current valid and retries only positively owned staging', () => {
  const { prefix } = fixture('extract-interrupted');
  const old = archive('v24.19.0', { tag: 'old' });
  const next = archive('v24.21.0', { tag: 'new' });
  passed(install(prefix, old));
  refused(install(prefix, next, old, `tar() { local target=""; while [[ $# -gt 0 ]]; do if [[ "$1" = -C ]]; then shift; target="$1"; fi; shift; done; printf partial > "$target/partial"; return 42; }`));
  selected(prefix, old);
  const stage = join(prefix, `.stage-${NONCE}-${next.sha}`);
  assert.equal(readFileSync(join(stage, 'partial'), 'utf8'), 'partial');
  passed(install(prefix, next, old));
  selected(prefix, next);
  assert.equal(existsSync(stage), false);
  assert.equal(existsSync(`${stage}.owner`), false);
});

for (const timing of ['before-current', 'after-current', 'before-old-cleanup', 'after-old-cleanup']) {
  test(`${timing} interruption exposes an old or new valid current and retry completes`, () => {
    const { prefix } = fixture(timing);
    const old = archive('v24.19.0', { tag: timing });
    const next = archive('v24.21.0', { tag: timing });
    passed(install(prefix, old));
    const oldDir = join(prefix, `node-${old.sha}`);
    const hooks = timing.includes('current') ? `
mv() {
  local last="" arg; for arg in "$@"; do last="$arg"; done
  if [[ "$last" = ${quote(join(prefix, 'current'))} ]]; then
    ${timing === 'after-current' ? 'node_test_mv "$@";' : ''}
    return 42
  fi
  node_test_mv "$@"
}` : `
rm() {
  local last="" arg; for arg in "$@"; do last="$arg"; done
  if [[ "$last" = ${quote(oldDir)} ]]; then
    ${timing === 'after-old-cleanup' ? 'command rm "$@";' : ''}
    return 42
  fi
  command rm "$@"
}`;
    refused(install(prefix, next, old, hooks));
    selected(prefix, timing === 'before-current' ? old : next);
    passed(install(prefix, next, old));
    selected(prefix, next);
    assert.equal(existsSync(oldDir), false);
  });
}

test('partial old cleanup retries only the positively recorded original directory identity', () => {
  for (const replaceDirectory of [false, true]) {
    const { prefix, parent } = fixture(`partial-cleanup-${replaceDirectory}`);
    const old = archive('v24.19.0', { tag: String(replaceDirectory) });
    const next = archive('v24.21.0', { tag: String(replaceDirectory) });
    passed(install(prefix, old));
    const oldDir = join(prefix, `node-${old.sha}`);
    const oldIdentity = lstatSync(oldDir);
    const hooks = `rm() {
      local last="" arg; for arg in "$@"; do last="$arg"; done
      if [[ "$last" = ${quote(oldDir)} ]]; then command rm ${quote(join(oldDir, 'bin/node'))}; return 42; fi
      command rm "$@"
    }`;
    refused(install(prefix, next, old, hooks));
    selected(prefix, next);
    const retirement = join(prefix, `.retire-${NONCE}-${old.sha}.owner`);
    const receipt = readFileSync(retirement, 'utf8');
    assert.ok(receipt.includes(`device=${oldIdentity.dev}\ninode=${oldIdentity.ino}\n`));
    if (replaceDirectory) {
      // Keep the original elsewhere so the OS cannot recycle its inode for the replacement.
      const moved = join(parent, 'original-old-directory');
      assert.equal(spawnSync('/bin/mv', [oldDir, moved]).status, 0);
      mkdirSync(oldDir, { mode: 0o700 });
      writeFileSync(join(oldDir, 'sentinel'), 'unrelated replacement');
      refused(install(prefix, next, old));
      assert.equal(readFileSync(join(oldDir, 'sentinel'), 'utf8'), 'unrelated replacement');
      assert.equal(readFileSync(retirement, 'utf8'), receipt);
    } else {
      passed(install(prefix, next, old));
      selected(prefix, next);
      assert.equal(existsSync(oldDir), false);
      assert.equal(existsSync(retirement), false);
    }
  }
});

test('dedicated writer uses a persistent nonblocking kernel lock, preserving its inode', async () => {
  const { prefix, parent } = fixture('kernel-lock');
  const old = archive('v24.19.0');
  const next = archive('v24.21.0');
  passed(install(prefix, old));
  const identity = lstatSync(`${prefix}.lock`);
  const ready = join(parent, 'ready');
  const holder = spawn('/bin/bash', ['-c', `source ${quote(SCRIPT)}\n${PORTABILITY}\n_node_acquire_write_lock ${quote(prefix)} ${quote(NONCE)} "$(id -u)"\nprintf ready > ${quote(ready)}\nsleep 3`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let failure = '';
  holder.stderr.on('data', chunk => { failure += chunk; });
  const ended = once(holder, 'exit');
  try {
    const deadline = Date.now() + 2_000;
    while (!existsSync(ready) && Date.now() < deadline && holder.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(ready), true, failure);
    const blocked = install(prefix, next, old);
    refused(blocked);
    assert.match(blocked.stderr, /writer is still active/);
    assert.equal(existsSync(join(prefix, `.stage-${NONCE}-${next.sha}`)), false);
    selected(prefix, old);
  } finally {
    await ended;
  }
  passed(install(prefix, next, old));
  selected(prefix, next);
  assert.equal(lstatSync(`${prefix}.lock`).ino, identity.ino);
  assert.equal(lstatSync(`${prefix}.lock`).dev, identity.dev);
});

// Root must review this case before Linux execution. Mac deliberately skips it: no BSD shim
// can qualify GNU tar retaining Linux admission3/flock9 after both writer ancestors die.
test('Linux killed driver and Bash leave GNU tar holding admission3 and flock9 until safe retry', {
  skip: process.platform !== 'linux' ? 'Requires independently reviewed Linux GNU tar/flock lifetime proof.' : false,
  timeout: 30_000
}, async () => {
  const { prefix, parent } = fixture('linux-continued-writer');
  const old = archive('v24.19.0', { tag: 'lifetime-old' });
  const next = archive('v24.21.0', { tag: 'lifetime-new' });
  assert.match(spawnSync('/usr/bin/tar', ['--version'], { encoding: 'utf8' }).stdout, /GNU tar/);
  assert.equal(spawnSync('/usr/bin/flock', ['--version']).status, 0);
  passed(install(prefix, old));

  const dataRoot = join(parent, 'guarded-data');
  const driverReport = join(parent, 'driver.json');
  const tarReport = join(parent, 'tar-pids');
  const paused = join(parent, 'tar-paused');
  const checkpoint = join(parent, 'checkpoint.sh');
  const driverFile = join(parent, 'driver.mjs');
  const admissionUrl = pathToFileURL(join(import.meta.dirname, 'admission.mjs')).href;
  // GNU's first read checkpoint occurs before extraction. The hook returns immediately after
  // SIGSTOP, so no continuing checkpoint helper can falsely supply the reader/lock proof.
  // https://www.gnu.org/software/tar/manual/html_section/checkpoints.html
  writeFileSync(checkpoint, `#!/bin/bash
set -euo pipefail
[[ "$TAR_CHECKPOINT" = 1 && ! -e ${quote(paused)} ]] || exit 0
for ((attempt=0; attempt<250; attempt++)); do
  [[ -f ${quote(tarReport)} ]] && break
  sleep 0.02
done
read -r shell_pid tar_pid < ${quote(tarReport)}
[[ "$shell_pid" =~ ^[0-9]+$ && "$tar_pid" =~ ^[0-9]+$ ]]
kill -STOP "$tar_pid"
helper_pid="$BASHPID"
helper_birth="$(/usr/bin/awk '{print $22}' /proc/$helper_pid/stat)"
printf '%s %s\\n' "$helper_pid" "$helper_birth" > ${quote(`${paused}.new`)}
/usr/bin/mv -Tf ${quote(`${paused}.new`)} ${quote(paused)}
`, { mode: 0o700 });
  const body = `PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
source ${quote(SCRIPT)}
tar() {
  command /usr/bin/tar --checkpoint=1 ${quote(`--checkpoint-action=exec=/bin/bash ${quote(checkpoint)}`)} "$@" &
  local tar_pid="$!"
  printf '%s %s\\n' "$BASHPID" "$tar_pid" > ${quote(`${tarReport}.new`)}
  command /usr/bin/mv -Tf ${quote(`${tarReport}.new`)} ${quote(tarReport)}
  wait "$tar_pid"
}
${['install_node_archive', next.file, next.sha, NONCE, prefix, next.version, old.sha, old.version].map(quote).join(' ')}
`;
  writeFileSync(driverFile, `import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { admit, runtimeWriterStdio } from ${JSON.stringify(admissionUrl)};
const admission = admit({ role: 'delete', label: 'nodeupdate', dataRoot: ${JSON.stringify(dataRoot)} });
if (!admission.ok) throw new Error(admission.message);
const writer = spawn('/bin/bash', ['-c', ${JSON.stringify(body)}], {
  stdio: runtimeWriterStdio(admission, ['ignore', 'pipe', 'pipe'])
});
writer.stdout.on('data', chunk => process.stdout.write(chunk));
writer.stderr.on('data', chunk => process.stderr.write(chunk));
writeFileSync(${JSON.stringify(`${driverReport}.new`)}, JSON.stringify({ driver: process.pid, bash: writer.pid, admission: admission.path }));
renameSync(${JSON.stringify(`${driverReport}.new`)}, ${JSON.stringify(driverReport)});
setInterval(() => {}, 1_000);
`);

  // /proc start ticks + original private process group identify the exact fixture births.
  // Missing/zombie is finished; other read failures are failures, never permission to signal.
  const processState = pid => {
    let raw;
    try { raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    assert.ok(fields.length >= 20);
    return { state: fields[0], group: Number(fields[2]), birth: fields[19] };
  };
  const waitFor = async (condition, message, milliseconds = 5_000) => {
    const end = Date.now() + milliseconds;
    while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(condition(), message);
  };
  const driver = spawn(NODE, [driverFile], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const driverEnded = once(driver, 'exit');
  let diagnostic = '';
  driver.stderr.on('data', chunk => { diagnostic += chunk; });
  driver.stdout.resume();
  const owned = new Map();
  let tarPid;
  let admissionPath;
  const remember = pid => {
    const state = processState(pid);
    assert.ok(state && state.state !== 'Z', `fixture process ${pid} ended before capture`);
    assert.equal(state.group, driver.pid);
    owned.set(pid, state.birth);
  };
  const sameLiveProcess = pid => {
    const state = processState(pid);
    return state && state.state !== 'Z' && state.group === driver.pid && state.birth === owned.get(pid);
  };
  const signalOwned = (pid, signal) => {
    assert.ok(sameLiveProcess(pid), `refused to signal unproved fixture pid ${pid}`);
    process.kill(pid, signal);
  };
  try {
    remember(driver.pid);
    await waitFor(() => existsSync(paused) && existsSync(driverReport), `GNU checkpoint was not reached: ${diagnostic}`);
    const report = JSON.parse(readFileSync(driverReport, 'utf8'));
    const [subshellPid, reportedTar] = readFileSync(tarReport, 'utf8').trim().split(/\s+/).map(Number);
    assert.equal(report.driver, driver.pid);
    assert.ok(Number.isInteger(report.bash) && Number.isInteger(subshellPid) && Number.isInteger(reportedTar));
    assert.notEqual(report.bash, subshellPid, 'capture and kill the extraction subshell as well as top Bash');
    tarPid = reportedTar;
    admissionPath = report.admission;
    remember(report.bash); remember(subshellPid); remember(tarPid);
    const [checkpointPid, checkpointBirth] = readFileSync(paused, 'utf8').trim().split(/\s+/);
    assert.match(checkpointPid, /^[0-9]+$/); assert.match(checkpointBirth, /^[0-9]+$/);
    owned.set(Number(checkpointPid), checkpointBirth);
    await waitFor(() => processState(tarPid)?.state === 'T', 'GNU tar did not pause');
    await waitFor(() => !sameLiveProcess(Number(checkpointPid)), 'the checkpoint helper still supplies writer descriptors');
    assert.ok(readFileSync(`/proc/${tarPid}/cmdline`, 'utf8').split('\0').includes(next.file));
    const expectedReader = statSync(admissionPath, { bigint: true });
    const expectedLock = statSync(`${prefix}.lock`, { bigint: true });
    const assertTarDescriptors = () => {
      assert.ok(sameLiveProcess(tarPid));
      const reader = statSync(`/proc/${tarPid}/fd/3`, { bigint: true });
      const lock = statSync(`/proc/${tarPid}/fd/9`, { bigint: true });
      assert.equal(reader.dev, expectedReader.dev); assert.equal(reader.ino, expectedReader.ino);
      assert.equal(lock.dev, expectedLock.dev); assert.equal(lock.ino, expectedLock.ino);
    };
    assertTarDescriptors();
    // Driver death alone is insufficient: both actual Bash ancestors must also end, leaving
    // the stopped GNU tar writer itself as the descriptor holder being qualified.
    signalOwned(report.bash, 'SIGKILL');
    signalOwned(subshellPid, 'SIGKILL');
    signalOwned(driver.pid, 'SIGKILL');
    await driverEnded;
    await waitFor(() => !sameLiveProcess(report.bash) && !sameLiveProcess(subshellPid), 'a Bash ancestor still holds the writer descriptors');
    assertTarDescriptors();
    assert.equal(probeAdmissionEntry(admissionPath), 'live');
    const start = admit({ role: 'start', label: 'preflight', dataRoot });
    assert.equal(start.ok, false);
    assert.equal(start.reason, 'opposite-live');
    const stage = join(prefix, `.stage-${NONCE}-${next.sha}`);
    const stageIdentity = statSync(stage, { bigint: true });
    const competing = admit({ role: 'delete', label: 'noderetry', dataRoot });
    assert.equal(competing.ok, true, 'same-role admission is intentionally not the writer lock');
    try {
      const blocked = spawnSync('/bin/bash', ['-c', `${['source', SCRIPT].map(quote).join(' ')}\n${['install_node_archive', next.file, next.sha, NONCE, prefix, next.version, old.sha, old.version].map(quote).join(' ')}`], {
        encoding: 'utf8', stdio: runtimeWriterStdio(competing, ['ignore', 'pipe', 'pipe']), timeout: 5_000
      });
      refused(blocked);
      assert.match(blocked.stderr, /writer is still active/);
    } finally { releaseAdmission(competing); }
    assert.equal(statSync(stage, { bigint: true }).ino, stageIdentity.ino);
    selected(prefix, old);
    assertTarDescriptors();
    signalOwned(tarPid, 'SIGCONT');
    await waitFor(() => !sameLiveProcess(tarPid), 'surviving GNU tar did not finish');
    assert.equal(probeAdmissionEntry(admissionPath), 'dead');
    assert.equal(readFileSync(join(stage, 'fixture-tag'), 'utf8'), 'lifetime-new', 'the real orphaned tar finished extraction');
    assert.equal(existsSync(join(prefix, `node-${next.sha}`)), false, 'a dead Bash never published the stage');

    const retry = admit({ role: 'delete', label: 'noderetry', dataRoot });
    assert.equal(retry.ok, true);
    try {
      passed(spawnSync('/bin/bash', ['-c', `${['source', SCRIPT].map(quote).join(' ')}\n${['install_node_archive', next.file, next.sha, NONCE, prefix, next.version, old.sha, old.version].map(quote).join(' ')}`], {
        encoding: 'utf8', stdio: runtimeWriterStdio(retry, ['ignore', 'pipe', 'pipe']), timeout: 10_000
      }));
    } finally { releaseAdmission(retry); }
    selected(prefix, next);
    assert.equal(existsSync(join(prefix, `node-${old.sha}`)), false);
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(`${stage}.owner`), false);
    assert.equal(statSync(`${prefix}.lock`, { bigint: true }).ino, expectedLock.ino);
    const nowStart = admit({ role: 'start', label: 'preflight', dataRoot });
    assert.equal(nowStart.ok, true);
    releaseAdmission(nowStart);
    assert.equal(existsSync(admissionPath), false, 'only a proven-dead admission was swept');
  } finally {
    // The private group cannot be recycled while a captured same-birth member still lives.
    // No normal process/port/data is consulted or signalled; finish fixture descendants before
    // the existing ROOT teardown removes their archives, markers and FIFO folder.
    if ([...owned.keys()].some(sameLiveProcess)) process.kill(-driver.pid, 'SIGKILL');
    await driverEnded;
    await waitFor(() => ![...owned.keys()].some(sameLiveProcess), 'owned writer fixture did not end');
    if (admissionPath) assert.notEqual(probeAdmissionEntry(admissionPath), 'live');
  }
});

test('the production root bootstrap executes no ordinary-user Node and CLI destinations stay fixed', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const rootBody = source.slice(source.indexOf('bootstrap_root()'), source.indexOf('bootstrap_main()'));
  assert.doesNotMatch(rootBody, /install_node_archive|verify_node_runtime|_node_verify_tree|\/bin\/node|current\/bin/);
  assert.match(rootBody, /util-linux/);
  assert.match(rootBody, /procps/);
  assert.match(source.slice(source.indexOf('bootstrap_main()')), /PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.match(source, /"\$EUID" = 1000/);
  assert.match(source, /prefix=\/home\/batshit\/\.local\/batshit-node/);
  assert.match(source, /"\$\{HOME:-\}" = \/home\/batshit/);
});

test('checksum, reported Node version and npm verification all refuse before current publication', () => {
  for (const issue of ['checksum', 'node-version', 'npm']) {
    const { prefix } = fixture(`bad-${issue}`);
    const old = archive('v24.19.0', { tag: issue });
    passed(install(prefix, old));
    const next = archive('v24.21.0', { npmVersion: issue === 'npm' ? '' : '11.0.0' });
    const request = issue === 'checksum' ? { ...next, sha: '0'.repeat(64) }
      : issue === 'node-version' ? { ...next, version: 'v24.22.0' } : next;
    refused(install(prefix, request, old));
    selected(prefix, old);
    assert.equal(existsSync(join(prefix, `node-${request.sha}`)), false);
    assert.equal(existsSync(join(prefix, `.stage-${NONCE}-${request.sha}`, 'bin/node')), issue !== 'checksum',
      'each probe refusal reaches its own extraction, rather than an earlier case\'s unknown staging');
  }
});

test('readonly checks reject unknown prefix fields and current.new before any Node execution or mutation', () => {
  for (const issue of ['prefix-extra-field', 'pending-selector']) {
    const { prefix, parent } = fixture(`readonly-${issue}`);
    const probeLog = join(parent, 'probe-log');
    const old = archive('v24.19.0', { tag: issue, probeLog });
    passed(install(prefix, old));
    rmSync(probeLog);
    if (issue === 'prefix-extra-field') writeFileSync(`${prefix}.owner`, `${readFileSync(`${prefix}.owner`, 'utf8')}extra=unknown\n`);
    else symlinkSync('../outside', join(prefix, 'current.new'));
    const marker = readFileSync(`${prefix}.owner`, 'utf8');
    refused(verify(prefix, old));
    assert.equal(existsSync(probeLog), false);
    assert.equal(readFileSync(`${prefix}.owner`, 'utf8'), marker);
    if (issue === 'pending-selector') assert.equal(readlinkSync(join(prefix, 'current.new')), '../outside');
  }
});

test('unknown staging, third directories and wrong selector links are retained and refuse replacement', () => {
  for (const problem of ['stage', 'third', 'selector']) {
    const { prefix } = fixture(`unknown-${problem}`);
    const old = archive('v24.19.0', { tag: problem });
    const next = archive('v24.21.0', { tag: problem });
    passed(install(prefix, old));
    const sentinel = problem === 'stage' ? join(prefix, `.stage-${NONCE}-${next.sha}`)
      : problem === 'third' ? join(prefix, `node-${'0'.repeat(64)}`) : join(prefix, 'current');
    if (problem === 'selector') {
      rmSync(sentinel);
      symlinkSync('../foreign', sentinel);
    } else {
      mkdirSync(sentinel, { mode: 0o700 });
      writeFileSync(join(sentinel, 'sentinel'), 'unique');
    }
    refused(install(prefix, next, old));
    if (problem === 'selector') assert.equal(readlinkSync(sentinel), '../foreign');
    else assert.equal(readFileSync(join(sentinel, 'sentinel'), 'utf8'), 'unique');
    assert.equal(existsSync(join(prefix, `node-${old.sha}`)), true);
  }
});

test('prefix/runtime receipts reject linked, nonprivate, foreign and hardlinked markers', () => {
  for (const problem of ['linked', 'nonprivate', 'foreign', 'hardlinked']) {
    const { prefix, parent } = fixture(`marker-${problem}`);
    const old = archive('v24.19.0', { tag: problem });
    const next = archive('v24.21.0', { tag: problem });
    passed(install(prefix, old));
    const marker = join(prefix, `node-${old.sha}`, '.batshit-node-runtime.owner');
    const before = readFileSync(marker, 'utf8');
    if (problem === 'linked') {
      const foreign = join(parent, 'foreign-marker');
      writeFileSync(foreign, before, { mode: 0o600 });
      rmSync(marker);
      symlinkSync(foreign, marker);
    } else if (problem === 'nonprivate') chmodSync(marker, 0o644);
    else if (problem === 'foreign') writeFileSync(marker, before.replace(`nonce=${NONCE}`, `nonce=${'e'.repeat(32)}`));
    else linkSync(marker, join(parent, 'other-marker-link'));
    refused(install(prefix, next, old));
    refused(verify(prefix, old));
    assert.equal(existsSync(join(prefix, `node-${old.sha}`)), true);
  }
});

test('a linked prefix parent or unrecognized npm/npx link is refused without replacing current', () => {
  const { prefix, parent } = fixture('linked-parent');
  const real = join(parent, 'real-local');
  mkdirSync(real, { mode: 0o700 });
  const linked = join(parent, '.local');
  symlinkSync(real, linked);
  const next = archive();
  refused(install(join(linked, 'batshit-node'), next));
  assert.equal(readdirSync(real).length, 0);
  const badLink = archive('v24.21.0', { npmTarget: '/usr/bin/true' });
  refused(install(prefix, badLink));
  assert.equal(existsSync(join(prefix, 'current')), false);
});
