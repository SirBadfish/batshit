// BL-1270's admission FIFOs against REAL FIFOs in a temporary sandbox and REAL fake processes this
// file starts and always kills: `sleep` standing in for redis-server, small Node scripts standing in
// for a Node service child, the stop-watch handoff, and racing launcher commands. No real data root,
// Redis, service, or Pinokio. The data root under test is never created.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync as fsOpen,
  readdirSync,
  renameSync as fsRename,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  admit,
  assertNoAdmissionFd,
  laneAdmissionDir,
  probeAdmissionEntry,
  releaseAdmission,
  SERVICE_FD_CONTRACT,
  serviceStdio
} from './admission.mjs';

const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'admission.mjs')).href;
const sandbox = mkdtempSync(join(tmpdir(), 'bs-pinokio-admission-'));
const scripts = join(sandbox, 'scripts');
mkdirSync(scripts);
let rootCount = 0;
const messages = [];

// Every process this file starts, by pid (`births`), and those not yet proven gone (`running`).
// Teardown kills only the latter, so a pid that was already reaped is never signalled; a wrapper leads
// its own process group, so its service child goes with it even if the wrapper never reported. The
// last test proves that nothing runs by then.
const births = new Set();
const running = new Set();
const groups = new Set();
test.after(() => {
  for (const pgid of groups) {
    // A process group id is not reused while any member lives, so a group that still answers is ours.
    try {
      process.kill(-pgid, 0);
      process.kill(-pgid, 'SIGKILL');
    } catch {}
  }
  for (const pid of running) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function track(pid) {
  if (!pid) return;
  births.add(pid);
  running.add(pid);
}

function freshRoot() {
  rootCount += 1;
  return join(sandbox, `home-${rootCount}`, '.batshit', 'pinokio');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitGone(pid) {
  for (let tries = 0; tries < 100 && alive(pid); tries += 1) await new Promise((done) => setTimeout(done, 50));
  const gone = !alive(pid);
  if (gone) running.delete(pid);
  return gone;
}

function kill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function refused(result) {
  assert.equal(result.ok, false);
  messages.push(result.message);
  return result;
}

function entriesOf(dir) {
  return readdirSync(dir).sort();
}

function firstLine(child) {
  return new Promise((resolveLine, rejectLine) => {
    let text = '';
    const timer = setTimeout(() => rejectLine(new Error(`no line from ${child.pid}: ${text}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end >= 0) {
        clearTimeout(timer);
        resolveLine(JSON.parse(text.slice(0, end)));
      }
    });
  });
}

function start(command, args, options) {
  const child = spawn(command, args, options);
  track(child.pid);
  if (options?.detached) groups.add(child.pid);
  child.once('exit', () => running.delete(child.pid));
  return child;
}

// Successive JSON lines from a child's stdout.
function lineReader(child) {
  const queue = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const value = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  return () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolveLine, rejectLine) => {
          const timer = setTimeout(() => rejectLine(new Error(`no line from ${child.pid}`)), 10_000);
          waiters.push((value) => {
            clearTimeout(timer);
            resolveLine(value);
          });
        });
}

const FD3_CHECK = 'if [ -e /dev/fd/3 ]; then echo open; else echo closed; fi';

// Fixtures, written once. The wrapper is a launcher `run` command: it admits, hands the reader to its
// fake service child through serviceStdio, reports, and idles until it is killed.
writeFileSync(
  join(scripts, 'node-service.mjs'),
  `import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';
let holds = true;
try { fstatSync(3); } catch { holds = false; }
// Ordinary three-descriptor descendants: does either see descriptor 3? One detached, as the app spawns
// them; one through libuv's fork path (\`uid\`), where only close-on-exec can close it.
function descendant(options) {
  const shell = spawn('/bin/sh', ['-c', ${JSON.stringify(FD3_CHECK)} + '; exec sleep 30'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true, ...options });
  return new Promise((done) => { let seen = ''; shell.stdout.on('data', (chunk) => { seen += chunk; if (seen.includes('\\n')) done({ pid: shell.pid, fd3: seen.trim() }); }); });
}
const [plain, forked] = [await descendant({}), await descendant({ uid: process.getuid() })];
console.log(JSON.stringify({ self: process.pid, holds, descendant: plain.pid, descendantFd3: plain.fd3, forkDescendant: forked.pid, forkDescendantFd3: forked.fd3 }));
setInterval(() => {}, 1000);
`
);
writeFileSync(
  join(scripts, 'handoff.mjs'),
  `import { spawn } from 'node:child_process';
const watcher = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
watcher.unref();
console.log(JSON.stringify({ handoff: process.pid, watcher: watcher.pid }));
setTimeout(() => process.exit(0), 100);
`
);
writeFileSync(
  join(scripts, 'wrapper.mjs'),
  `import { spawn } from 'node:child_process';
import { admit, assertNoAdmissionFd, serviceStdio } from ${JSON.stringify(moduleUrl)};
const [dataRoot, mode, label] = process.argv.slice(2);
const admission = admit({ role: 'start', label, dataRoot });
if (!admission.ok) { console.log(JSON.stringify({ ok: false, message: admission.message })); process.exit(0); }
function lineOf(child) {
  return new Promise((done) => { let t = ''; child.stdout.on('data', (c) => { t += c; const i = t.indexOf('\\n'); if (i >= 0) done(JSON.parse(t.slice(0, i))); }); });
}
const report = { ok: true, wrapper: process.pid, path: admission.path };
if (mode === 'sleep-service') {
  report.child = spawn('sleep', ['30'], { stdio: serviceStdio(admission, ['ignore', 'ignore', 'ignore']) }).pid;
} else {
  const service = spawn(process.execPath, [${JSON.stringify(join(scripts, 'node-service.mjs'))}], { stdio: serviceStdio(admission, ['ignore', 'pipe', 'inherit']) });
  report.service = await lineOf(service);
  if (mode === 'handoff') {
    // The stop-watch handoff keeps its own explicit channel (R-1 Part 2's shape) and never the reader.
    const stdio = ['ignore', 'pipe', 'inherit', 'pipe'];
    assertNoAdmissionFd(stdio, admission);
    report.handoff = await lineOf(spawn(process.execPath, [${JSON.stringify(join(scripts, 'handoff.mjs'))}], { stdio }));
  }
}
console.log(JSON.stringify(report));
setInterval(() => {}, 1000);
`
);
writeFileSync(
  join(scripts, 'racer.mjs'),
  `import { admit, releaseAdmission } from ${JSON.stringify(moduleUrl)};
const [dataRoot, role, pauseMs] = process.argv.slice(2);
const pause = Number(pauseMs);
const label = role === 'delete' ? 'delete' : 'preflight';
let result = null;
// The parent's go is one line on stdin; it ends stdin once both racers have answered, so an admitted
// racer holds until both have answered.
process.stdin.on('data', () => {
  if (result) return;
  result = admit({ role, label, dataRoot, deps: { afterPublish: () => { if (pause) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause); } } });
  console.log(JSON.stringify({ role, ok: result.ok, reason: result.reason ?? null }));
});
process.stdin.on('end', () => { if (result?.ok) releaseAdmission(result); process.exit(0); });
console.log(JSON.stringify({ ready: true }));
`
);

async function startWrapper(dataRoot, mode, label) {
  const wrapper = start(process.execPath, [join(scripts, 'wrapper.mjs'), dataRoot, mode, label], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  const report = await firstLine(wrapper);
  assert.equal(report.ok, true, report.message);
  const s = report.service;
  for (const pid of [report.child, s?.self, s?.descendant, s?.forkDescendant, report.handoff?.handoff, report.handoff?.watcher]) track(pid);
  return report;
}

test('the folder is the data root\'s sibling, and admission never reads, creates, or changes the root', () => {
  const dataRoot = freshRoot();
  const dir = laneAdmissionDir(dataRoot);
  assert.equal(dir, join(dirname(dataRoot), 'pinokio.admission'));
  assert.equal(laneAdmissionDir(`${dataRoot}${sep}`), dir);
  const touched = [];
  const real = { lstatSync, mkdirSync, openSync: fsOpen, renameSync: fsRename, unlinkSync, readdirSync };
  const spy = {};
  for (const [name, call] of Object.entries(real)) {
    spy[name] = (...args) => {
      for (const arg of args) if (typeof arg === 'string') touched.push(arg);
      return call(...args);
    };
  }
  spy.makeFifo = (path) => {
    touched.push(path);
    return realMkfifo(path);
  };
  const held = admit({ role: 'delete', label: 'delete', dataRoot, deps: spy });
  assert.equal(held.ok, true);
  refused(admit({ role: 'start', label: 'preflight', dataRoot, deps: spy }));
  releaseAdmission(held, { deps: spy });
  const started = admit({ role: 'start', label: 'preflight', dataRoot, deps: spy });
  assert.equal(started.ok, true);
  releaseAdmission(started, { deps: spy });
  assert.ok(touched.length > 10);
  assert.deepEqual(touched.filter((path) => path === dataRoot || path.startsWith(`${dataRoot}${sep}`)), []);
  assert.equal(existsSync(dataRoot), false);
  assert.deepEqual(entriesOf(dir), [], 'every proven-dead entry is gone; the folder itself stays');
});

test('a command publishes only after opening its reader, then renames, then looks', () => {
  const dataRoot = freshRoot();
  const steps = [];
  const deps = {
    makeFifo: (path) => {
      steps.push(['mkfifo', path]);
      return realMkfifo(path);
    },
    openSync: (path, flags) => {
      steps.push(['open', path, flags]);
      return fsOpen(path, flags);
    },
    renameSync: (from, to) => {
      steps.push(['rename', from, to]);
      return fsRename(from, to);
    },
    readdirSync: (path) => {
      steps.push(['scan', path]);
      return readdirSync(path);
    }
  };
  const held = admit({ role: 'start', label: 'redis', dataRoot, deps });
  assert.equal(held.ok, true);
  const [mk, open, rename, scan] = steps;
  assert.equal(mk[0], 'mkfifo');
  assert.match(mk[1], /\/\.start\.redis\.\d+\.[0-9a-f]{12}\.tmp$/);
  assert.deepEqual(open.slice(0, 2), ['open', mk[1]]);
  assert.equal(open[2] & (fsConstants.O_WRONLY | fsConstants.O_RDWR), 0, 'the reader is read-only');
  assert.ok(open[2] & fsConstants.O_NONBLOCK, 'and never waits for a writer');
  assert.ok(open[2] & fsConstants.O_NOFOLLOW, 'and never opens through a symlink');
  assert.deepEqual(rename, ['rename', mk[1], held.path]);
  assert.equal(scan[0], 'scan');
  assert.match(held.path, /\/start\.redis\.\d+\.[0-9a-f]{12}\.fifo$/);
  assert.equal(lstatSync(held.path).mode & 0o777, 0o600);
  assert.equal(probeAdmissionEntry(held.path), 'live');
  assert.equal(releaseAdmission(held), 'removed');
  assert.equal(probeAdmissionEntry(held.path), 'gone');
});

function realMkfifo(path) {
  const result = spawnSync('mkfifo', ['-m', '600', path]);
  if (result.status !== 0) throw Object.assign(new Error('mkfifo failed'), { code: 'MKFIFO_FAILED' });
}

test('a live Delete refuses every Start, a live Start refuses Delete, and Starts never refuse each other', () => {
  const dataRoot = freshRoot();
  const deleting = admit({ role: 'delete', label: 'delete', dataRoot });
  assert.equal(deleting.ok, true);
  for (const label of ['prepare', 'preflight', 'redis', 'server', 'app']) {
    const result = refused(admit({ role: 'start', label, dataRoot }));
    assert.equal(result.reason, 'opposite-live');
    assert.match(result.message, /^Delete Batshit data is running, so Batshit's data was not touched/);
    assert.deepEqual(result.entries.map((entry) => entry.label), ['delete']);
  }
  assert.equal(releaseAdmission(deleting), 'removed');
  const redis = admit({ role: 'start', label: 'redis', dataRoot });
  const app = admit({ role: 'start', label: 'app', dataRoot });
  assert.equal(redis.ok && app.ok, true);
  const result = refused(admit({ role: 'delete', label: 'delete', dataRoot }));
  assert.equal(result.reason, 'opposite-live');
  assert.match(result.message, /^nothing was deleted: Batshit is starting or running: /);
  assert.match(result.message, new RegExp(`the database \\(started by launcher process ${process.pid}\\)`));
  assert.match(result.message, /the app \(started by launcher process/);
  releaseAdmission(redis);
  releaseAdmission(app);
  const odd = admit({ role: 'start', label: 'constructor', dataRoot });
  assert.match(refused(admit({ role: 'delete', label: 'delete', dataRoot })).message, /its constructor \(started by launcher process \d+\)\. If/);
  releaseAdmission(odd);
  const now = admit({ role: 'delete', label: 'delete', dataRoot });
  assert.equal(now.ok, true);
  releaseAdmission(now);
});

test('an opposite command admitted between another\'s publish and its scan never lets both pass', () => {
  for (const [first, second] of [
    ['start', 'delete'],
    ['delete', 'start']
  ]) {
    const dataRoot = freshRoot();
    let inner;
    const outer = admit({
      role: first,
      label: first === 'delete' ? 'delete' : 'preflight',
      dataRoot,
      deps: {
        afterPublish: () => {
          inner = admit({ role: second, label: second === 'delete' ? 'delete' : 'preflight', dataRoot });
        }
      }
    });
    assert.equal(inner.ok, false, `${second} admitted after ${first} published must see it`);
    assert.equal(inner.reason, 'opposite-live');
    assert.equal(outer.ok, true, `${first} goes on once ${second} has released`);
    releaseAdmission(outer);
  }
});

test('racing real processes are never both admitted, even when both publish before either looks', async () => {
  const rounds = [];
  for (let round = 0; round < 16; round += 1) {
    const dataRoot = freshRoot();
    mkdirSync(laneAdmissionDir(dataRoot), { recursive: true });
    // Half the rounds pause between publish and scan, so both have published before either looks.
    const pause = round % 2 === 0 ? 150 : 0;
    const racers = ['start', 'delete'].map((role) =>
      start(process.execPath, [join(scripts, 'racer.mjs'), dataRoot, role, String(pause)], { stdio: ['pipe', 'pipe', 'inherit'] })
    );
    const next = racers.map(lineReader);
    assert.deepEqual(await Promise.all(next.map((line) => line())), [{ ready: true }, { ready: true }]);
    for (const racer of racers) racer.stdin.write('go\n');
    const results = await Promise.all(next.map((line) => line()));
    // Both are alive, and an admitted one still holds, until the round ends here: both admitted would
    // be two holders at once.
    assert.ok(!(results[0].ok && results[1].ok), `round ${round}: both admitted`);
    for (const result of results) {
      if (!result.ok) assert.ok(['opposite-live', 'publish-failed'].includes(result.reason), JSON.stringify(result));
    }
    rounds.push({ pause, admitted: results.filter((result) => result.ok).length, sawOther: results.some((result) => result.reason === 'opposite-live') });
    for (const racer of racers) racer.stdin.end();
    for (const racer of racers) assert.ok(await waitGone(racer.pid));
    assert.deepEqual(entriesOf(laneAdmissionDir(dataRoot)).filter((name) => probeAdmissionEntry(join(laneAdmissionDir(dataRoot), name)) === 'live'), []);
  }
  assert.ok(rounds.some((round) => round.sawOther), JSON.stringify(rounds));
});

test('a failed publication closes its reader and retries once, then refuses before anything else', () => {
  // mkfifo never works: refused, nothing left, no scan.
  let dataRoot = freshRoot();
  let scanned = false;
  let result = refused(
    admit({
      role: 'start',
      label: 'preflight',
      dataRoot,
      deps: {
        makeFifo: () => {
          throw Object.assign(new Error('no'), { code: 'MKFIFO_FAILED' });
        },
        readdirSync: () => {
          scanned = true;
          return [];
        }
      }
    })
  );
  assert.equal(result.reason, 'publish-failed');
  assert.match(result.message, /MKFIFO_FAILED/);
  assert.equal(scanned, false);
  assert.deepEqual(entriesOf(laneAdmissionDir(dataRoot)), []);

  // The first rename fails: its reader is closed and its dead temporary removed; the retry holds.
  dataRoot = freshRoot();
  const events = [];
  let renames = 0;
  const held = admit({
    role: 'delete',
    label: 'delete',
    dataRoot,
    deps: {
      openSync: (path, flags) => {
        const fd = fsOpen(path, flags);
        if (!(flags & fsConstants.O_WRONLY)) events.push(['open', fd]);
        return fd;
      },
      closeSync: (fd) => {
        events.push(['close', fd]);
        return closeSync(fd);
      },
      renameSync: (from, to) => {
        renames += 1;
        if (renames === 1) throw Object.assign(new Error('no'), { code: 'EIO' });
        return fsRename(from, to);
      }
    }
  });
  assert.equal(held.ok, true);
  const readers = events.filter(([what]) => what === 'open');
  assert.equal(readers.length, 2);
  const firstClose = events.findIndex(([what, fd]) => what === 'close' && fd === readers[0][1]);
  assert.ok(firstClose >= 0 && firstClose < events.indexOf(readers[1]), 'the failed attempt\'s reader is closed before the retry opens');
  assert.equal(held.fd, readers[1][1]);
  assert.deepEqual(entriesOf(laneAdmissionDir(dataRoot)), [held.path.split(sep).pop()]);
  releaseAdmission(held);

  // A scanner removed the temporary before it was opened: the retry holds.
  dataRoot = freshRoot();
  let made = 0;
  const retried = admit({
    role: 'start',
    label: 'app',
    dataRoot,
    deps: {
      makeFifo: (path) => {
        realMkfifo(path);
        made += 1;
        if (made === 1) unlinkSync(path);
      }
    }
  });
  assert.equal(retried.ok, true);
  releaseAdmission(retried);

  // A sweeper that probed the temporary dead just before its reader opened unlinks it just after: the
  // rename fails, the reader is closed, and the retry holds. Nobody is admitted by the sweep.
  dataRoot = freshRoot();
  let swept = 0;
  const afterSweep = admit({
    role: 'delete',
    label: 'delete',
    dataRoot,
    deps: {
      openSync: (path, flags) => {
        const fd = fsOpen(path, flags);
        if (!(flags & fsConstants.O_WRONLY) && swept === 0) {
          swept += 1;
          unlinkSync(path);
        }
        return fd;
      }
    }
  });
  assert.equal(afterSweep.ok, true);
  assert.deepEqual(entriesOf(laneAdmissionDir(dataRoot)), [afterSweep.path.split(sep).pop()]);
  releaseAdmission(afterSweep);

  // Every reader open fails: refused, and each temporary, proven dead, is removed.
  dataRoot = freshRoot();
  result = refused(
    admit({
      role: 'start',
      label: 'server',
      dataRoot,
      deps: {
        openSync: (path, flags) => {
          if (!(flags & fsConstants.O_WRONLY)) throw Object.assign(new Error('no'), { code: 'EMFILE' });
          return fsOpen(path, flags);
        }
      }
    })
  );
  assert.equal(result.reason, 'publish-failed');
  assert.deepEqual(entriesOf(laneAdmissionDir(dataRoot)), []);
  assert.equal(existsSync(dataRoot), false);
});

test('an entry the launcher cannot ask is unknown: kept, and never read as "no holder"', () => {
  const cases = [
    ['a regular file', (path) => writeFileSync(path, 'x')],
    ['a folder', (path) => mkdirSync(path)],
    [
      'a symlink to a dead FIFO',
      (path, dir) => {
        const target = join(dir, '..', `elsewhere-${rootCount}.fifo`);
        realMkfifo(target);
        symlinkSync(target, path);
      }
    ],
    [
      'a FIFO it may not open',
      (path) => {
        realMkfifo(path);
        chmodSync(path, 0o000);
      }
    ]
  ];
  for (const [what, make] of cases) {
    const dataRoot = freshRoot();
    const dir = laneAdmissionDir(dataRoot);
    mkdirSync(dir, { recursive: true });
    const odd = join(dir, 'delete.delete.4242.aaaaaaaaaaaa.fifo');
    make(odd, dir);
    const result = refused(admit({ role: 'start', label: 'preflight', dataRoot }));
    assert.equal(result.reason, 'opposite-unknown', what);
    assert.ok(result.message.includes(odd), what);
    assert.ok(lstatSync(odd), `${what} is kept`);
    assert.deepEqual(entriesOf(dir), ['delete.delete.4242.aaaaaaaaaaaa.fifo'], `${what}: only the odd entry is left`);
    // The same entry names the other role for a Delete, so it does not decide there.
    const deleting = admit({ role: 'delete', label: 'delete', dataRoot });
    assert.equal(deleting.ok, true, what);
    releaseAdmission(deleting);
    if (what === 'a FIFO it may not open') chmodSync(odd, 0o600);
  }
  // A symlink swapped in after the lstat: the open refuses to follow it, so it is unknown, not live.
  {
    const dataRoot = freshRoot();
    const dir = laneAdmissionDir(dataRoot);
    mkdirSync(dir, { recursive: true });
    const live = admit({ role: 'delete', label: 'delete', dataRoot });
    const swapped = join(dir, 'delete.delete.4343.cccccccccccc.fifo');
    symlinkSync(live.path, swapped);
    const asIfFifo = { lstatSync: (path) => (path === swapped ? lstatSync(live.path) : lstatSync(path)) };
    assert.equal(probeAdmissionEntry(swapped, { deps: asIfFifo }), 'unknown');
    assert.equal(probeAdmissionEntry(live.path), 'live');
    releaseAdmission(live);
  }
  // A name that does not parse is still a token name, and a temporary name never decides.
  const dataRoot = freshRoot();
  const dir = laneAdmissionDir(dataRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'start.weird.fifo'), 'x');
  writeFileSync(join(dir, '.delete.delete.1.bbbbbbbbbbbb.tmp'), 'x');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  assert.equal(refused(admit({ role: 'delete', label: 'delete', dataRoot })).reason, 'opposite-unknown');
  const started = admit({ role: 'start', label: 'preflight', dataRoot });
  assert.equal(started.ok, true);
  releaseAdmission(started);
  assert.deepEqual(entriesOf(dir), ['.delete.delete.1.bbbbbbbbbbbb.tmp', 'notes.txt', 'start.weird.fifo']);
});

test('a missing parent gets the default mode; only the admission folder is private', () => {
  const dataRoot = freshRoot();
  const control = join(sandbox, `control-${rootCount}`);
  mkdirSync(control);
  const held = admit({ role: 'start', label: 'prepare', dataRoot });
  assert.equal(held.ok, true);
  assert.equal(lstatSync(dirname(dataRoot)).mode & 0o777, lstatSync(control).mode & 0o777);
  assert.equal(lstatSync(laneAdmissionDir(dataRoot)).mode & 0o777, 0o700);
  assert.equal(existsSync(dataRoot), false);
  releaseAdmission(held);
});

test('an unusable admission folder refuses both roles and names it', () => {
  let dataRoot = freshRoot();
  mkdirSync(dirname(dataRoot), { recursive: true });
  writeFileSync(laneAdmissionDir(dataRoot), 'x');
  for (const role of ['start', 'delete']) {
    const result = refused(admit({ role, label: role === 'start' ? 'preflight' : 'delete', dataRoot }));
    assert.equal(result.reason, 'folder-unusable');
    assert.ok(result.message.includes(laneAdmissionDir(dataRoot)));
  }
  dataRoot = freshRoot();
  mkdirSync(join(dirname(dataRoot), 'real'), { recursive: true });
  symlinkSync(join(dirname(dataRoot), 'real'), laneAdmissionDir(dataRoot));
  assert.equal(refused(admit({ role: 'start', label: 'redis', dataRoot })).reason, 'folder-unusable');
  assert.deepEqual(readdirSync(join(dirname(dataRoot), 'real')), [], 'nothing is published through a symlinked folder');
  // A scan that cannot read the folder refuses and releases its own entry.
  dataRoot = freshRoot();
  const result = refused(
    admit({
      role: 'delete',
      label: 'delete',
      dataRoot,
      deps: {
        readdirSync: () => {
          throw Object.assign(new Error('no'), { code: 'EACCES' });
        }
      }
    })
  );
  assert.equal(result.reason, 'folder-unusable');
  assert.deepEqual(entriesOf(laneAdmissionDir(dataRoot)), []);
});

test('only proven-dead entries are swept: live ones of either role and unknown ones stay', async () => {
  const dataRoot = freshRoot();
  const dir = laneAdmissionDir(dataRoot);
  mkdirSync(dir, { recursive: true });
  for (const name of ['start.redis.11.aaaaaaaaaaaa.fifo', 'delete.delete.12.bbbbbbbbbbbb.fifo', '.start.app.13.cccccccccccc.tmp', '.delete.delete.14.dddddddddddd.tmp']) {
    realMkfifo(join(dir, name));
  }
  const holder = await startWrapper(dataRoot, 'sleep-service', 'server');
  const deleting = admit({ role: 'delete', label: 'delete', dataRoot });
  assert.equal(deleting.ok, false, 'the live holder refuses Delete');
  const started = admit({ role: 'start', label: 'preflight', dataRoot });
  assert.equal(started.ok, true);
  assert.deepEqual(entriesOf(dir), [holder.path.split(sep).pop(), started.path.split(sep).pop()].sort(), 'the four dead entries are gone');
  releaseAdmission(started);
  kill(holder.wrapper);
  kill(holder.child);
  assert.ok(await waitGone(holder.wrapper));
  assert.ok(await waitGone(holder.child));
});

test('a SIGKILLed wrapper leaves Delete refused while its fake Redis still holds the reader', async () => {
  const dataRoot = freshRoot();
  const redis = await startWrapper(dataRoot, 'sleep-service', 'redis');
  refused(admit({ role: 'delete', label: 'delete', dataRoot }));
  kill(redis.wrapper);
  assert.ok(await waitGone(redis.wrapper));
  assert.ok(alive(redis.child));
  const result = refused(admit({ role: 'delete', label: 'delete', dataRoot }));
  assert.equal(result.reason, 'opposite-live');
  assert.deepEqual(result.entries.map((entry) => [entry.label, entry.pid]), [['redis', redis.wrapper]]);
  kill(redis.child);
  assert.ok(await waitGone(redis.child));
  const deleting = admit({ role: 'delete', label: 'delete', dataRoot });
  assert.equal(deleting.ok, true);
  assert.equal(existsSync(redis.path), false, 'the dead entry was swept');
  releaseAdmission(deleting);
});

test('Node marks the inherited reader close-on-exec at startup; the wrapper\'s own reader is never inherited', async () => {
  const dataRoot = freshRoot();
  const held = admit({ role: 'start', label: 'app', dataRoot });
  async function answer(command, args, stdio, options = {}) {
    const child = start(command, args, { stdio, ...options });
    const text = await new Promise((done) => {
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.once('close', () => done(out.trim()));
    });
    assert.ok(await waitGone(child.pid));
    return text;
  }
  // A Node service child replaces itself with a shell by a plain execve: descriptor 3 is gone, so Node
  // had marked it close-on-exec. The control, a shell holding the same descriptor, keeps it across exec.
  const both = `${FD3_CHECK}; if [ -e /dev/fd/20 ]; then echo open; else echo closed; fi`;
  const withGap = [...serviceStdio(held, ['ignore', 'pipe', 'inherit']), ...Array(16).fill('ignore'), held.fd];
  const viaNode = await answer(
    process.execPath,
    ['-e', `require('node:fs').fstatSync(3); process.execve('/bin/sh', ['sh', '-c', ${JSON.stringify(both)}])`],
    withGap
  );
  const viaShell = await answer('/bin/sh', ['-c', `exec /bin/sh -c '${FD3_CHECK}'`], serviceStdio(held, ['ignore', 'pipe', 'inherit']));
  // Slot 3 (marked by Node's startup) is closed across the execve; slot 20 (past the gap, unmarked) is
  // not, so execve itself closes nothing. The shell control keeps slot 3 across exec.
  assert.deepEqual({ viaNode: viaNode.split('\n'), viaShell }, { viaNode: ['closed', 'open'], viaShell: 'open' });
  // The wrapper's own reader (opened close-on-exec) reaches no child it does not list, even on libuv's
  // fork path; listed in slot 3, it does.
  const check = `if [ -e /dev/fd/${held.fd} ]; then echo open; else echo closed; fi`;
  const unlisted = await answer('/bin/sh', ['-c', check], ['ignore', 'pipe', 'inherit'], { uid: process.getuid() });
  const listed = await answer('/bin/sh', ['-c', FD3_CHECK], serviceStdio(held, ['ignore', 'pipe', 'inherit']), { uid: process.getuid() });
  assert.deepEqual({ unlisted, listed }, { unlisted: 'closed', listed: 'open' });
  releaseAdmission(held);
});

test('a fake Node service child holds the reader past its wrapper, and its descendants never get it', async () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= SERVICE_FD_CONTRACT.minimumNodeMajor);
  const dataRoot = freshRoot();
  const app = await startWrapper(dataRoot, 'node-service', 'app');
  assert.equal(app.service.holds, true, 'the Node service child has descriptor 3');
  assert.equal(app.service.descendantFd3, 'closed', 'an ordinary three-descriptor descendant does not');
  assert.equal(app.service.forkDescendantFd3, 'closed', 'nor one spawned through the fork path');
  kill(app.wrapper);
  assert.ok(await waitGone(app.wrapper));
  assert.equal(refused(admit({ role: 'delete', label: 'delete', dataRoot })).reason, 'opposite-live');
  kill(app.service.self);
  assert.ok(await waitGone(app.service.self));
  assert.ok(alive(app.service.descendant), 'the descendant still runs');
  const deleting = admit({ role: 'delete', label: 'delete', dataRoot });
  assert.equal(deleting.ok, true, 'and holds nothing');
  releaseAdmission(deleting);
  for (const pid of [app.service.descendant, app.service.forkDescendant]) {
    kill(pid);
    assert.ok(await waitGone(pid));
  }
});

test('the stop-watch handoff and its watcher never get the reader', async () => {
  const dataRoot = freshRoot();
  const run = await startWrapper(dataRoot, 'handoff', 'app');
  assert.ok(await waitGone(run.handoff.handoff));
  kill(run.wrapper);
  kill(run.service.self);
  kill(run.service.descendant);
  kill(run.service.forkDescendant);
  for (const pid of [run.wrapper, run.service.self, run.service.descendant, run.service.forkDescendant]) assert.ok(await waitGone(pid));
  assert.ok(alive(run.handoff.watcher), 'the watcher still runs');
  const deleting = admit({ role: 'delete', label: 'delete', dataRoot });
  assert.equal(deleting.ok, true, 'and holds nothing');
  releaseAdmission(deleting);
  kill(run.handoff.watcher);
  assert.ok(await waitGone(run.handoff.watcher));

  const held = admit({ role: 'start', label: 'app', dataRoot });
  assert.throws(() => assertNoAdmissionFd(['ignore', 'pipe', 'inherit', held.fd], held), /admission reader/);
  assert.throws(() => assertNoAdmissionFd(['ignore', { fd: held.fd }, 'inherit'], held), /admission reader/);
  assert.doesNotThrow(() => assertNoAdmissionFd('inherit', held));
  assert.deepEqual(serviceStdio(held), ['ignore', 'inherit', 'inherit', held.fd]);
  assert.throws(() => serviceStdio(held, ['ignore', 'inherit']), /exactly the three/);
  assert.throws(() => serviceStdio(held, ['ignore', 'inherit', 'inherit', 'pipe']), /exactly the three/);
  assert.throws(() => serviceStdio(held, ['ignore', 'inherit', held.fd]), /admission reader/);
  assert.throws(() => serviceStdio(held, undefined, { deps: { nodeVersion: () => '22.11.0' } }), /Node 24 or newer \(pinned v24\.12\.0\)/);
  assert.throws(() => serviceStdio(held, undefined, { deps: { nodeVersion: () => 'unreadable' } }), /Node 24 or newer/);
  releaseAdmission(held);
  assert.throws(() => serviceStdio(held), /needs a held admission/);
});

test('release closes this process\'s reader and removes the entry only once nobody holds it', async () => {
  const dataRoot = freshRoot();
  const held = admit({ role: 'start', label: 'preflight', dataRoot });
  const fd = held.fd;
  assert.equal(releaseAdmission(held), 'removed');
  assert.throws(() => fstatSync(fd), { code: 'EBADF' });
  assert.equal(releaseAdmission(held), 'gone', 'a second release is harmless');
  const stuck = admit({ role: 'start', label: 'server', dataRoot });
  const noUnlink = {
    unlinkSync: () => {
      throw Object.assign(new Error('no'), { code: 'EACCES' });
    }
  };
  assert.equal(releaseAdmission(stuck, { deps: noUnlink }), 'kept-dead');
  assert.equal(probeAdmissionEntry(stuck.path), 'dead');
  for (const notHeld of [null, undefined, { ok: false, reason: 'opposite-live' }]) {
    assert.equal(releaseAdmission(notHeld), 'gone', 'releasing what was never held is harmless too');
  }
  const base = ['ignore', 'pipe', 'inherit'];
  const again = admit({ role: 'start', label: 'server', dataRoot });
  assert.notEqual(serviceStdio(again, base), base, 'serviceStdio answers a new array');
  assert.deepEqual(base, ['ignore', 'pipe', 'inherit'], 'and leaves its base as it was');
  releaseAdmission(again);

  const redis = admit({ role: 'start', label: 'redis', dataRoot });
  const child = start('sleep', ['30'], { stdio: serviceStdio(redis, ['ignore', 'ignore', 'ignore']) });
  assert.equal(releaseAdmission(redis), 'kept-live', 'the service child still holds it');
  assert.equal(probeAdmissionEntry(redis.path), 'live');
  kill(child.pid);
  assert.ok(await waitGone(child.pid));
  const deleting = admit({ role: 'delete', label: 'delete', dataRoot });
  assert.equal(deleting.ok, true);
  assert.equal(existsSync(redis.path), false, 'the next scan swept it once dead');
  releaseAdmission(deleting);
});

test('Windows is refused with a plain line, and nothing is created', () => {
  const dataRoot = freshRoot();
  for (const role of ['start', 'delete']) {
    const result = refused(admit({ role, label: role === 'start' ? 'preflight' : 'delete', dataRoot, deps: { platform: () => 'win32' } }));
    assert.equal(result.reason, 'unsupported');
    assert.match(result.message, role === 'delete' ? /^nothing was deleted: .*does not run on Windows/ : /does not run on Windows/);
  }
  assert.equal(existsSync(laneAdmissionDir(dataRoot)), false);
  assert.throws(() => admit({ role: 'other', label: 'x', dataRoot }), /start or delete/);
  assert.throws(() => admit({ role: 'start', label: 'Two-Words', dataRoot }), /one lower-case word/);
});

test('every refusal is one line Pinokio shows as it is', () => {
  const dataRoot = join(sandbox, 'error: errno 5', '.batshit', 'pinokio');
  mkdirSync(dirname(dataRoot), { recursive: true });
  writeFileSync(laneAdmissionDir(dataRoot), 'x');
  refused(admit({ role: 'start', label: 'preflight', dataRoot }));
  assert.ok(messages.length >= 20);
  for (const message of messages) {
    assert.doesNotMatch(message, /error:|errno /i, message);
    assert.doesNotMatch(message, /\n/, message);
  }
});

test('every process this file started is gone', async () => {
  for (const pid of births) assert.ok(await waitGone(pid), `fixture ${pid} survived`);
  assert.equal(running.size, 0);
  assert.ok(births.size >= 40, `${births.size} fixtures`);
});
