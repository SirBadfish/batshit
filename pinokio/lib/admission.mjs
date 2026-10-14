// Who may touch the Pinokio lane's data root right now (BL-1270). Delete Batshit data removes the
// whole root, and a Start holds none of the lane's ports during preflight, the gap before `run
// redis`, and each service's spawn-to-bind, so an idle-port proof alone cannot keep the two apart.
// Every launcher command that touches the root holds an admission FIFO reader for its whole life;
// the three service children (redis-server, the file server, the app) are handed the same reader
// and keep it until they exit. A command publishes its FIFO only after opening its reader, renames
// it to its final name, and only then looks at the other role's FIFOs: Delete refuses while any
// Start FIFO has a reader, and a Start command refuses while any Delete FIFO has one. Whether a
// reader exists is the kernel's answer (opening a FIFO for writing without blocking fails with
// ENXIO when nobody holds it for reading), so nothing here guesses from pids, start times, or ages,
// and a process that dies releases its reader by itself.
//
// Containment: Node's own startup marks every inherited descriptor close-on-exec (SERVICE_FD_CONTRACT),
// so a Node service child keeps descriptor 3 but nothing it spawns receives it. Only the three
// service children get it (`serviceStdio`); every other spawn, above all the stop-watch handoff,
// must not (`assertNoAdmissionFd`).
//
// Bookkeeping: `<root>.admission/` beside the data root (keyed by the root, so every launcher folder
// on the computer shares it), owned by the Pinokio launcher, machine-local liveness that no backup
// carries. Only FIFOs proven dead are removed; a live or unknown entry is kept, and the folder
// itself is never removed. Nothing here reads, creates, or changes the data root.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const ADMISSION_ROLES = Object.freeze(['start', 'delete']);

// The Node contract the containment rests on (read 2026-10-11 from the v24.12.0 sources): a normal
// `node` startup calls uv_disable_stdio_inheritance() ("Make inherited handles noninheritable"),
// which sets FD_CLOEXEC on descriptors 0-15 unconditionally and after that only up to the first one
// that is not open. The reader rides in slot 3, well inside that range. The tests observe it with a
// plain execve, so macOS's posix_spawn (which closes unlisted descriptors by itself) plays no part.
export const SERVICE_FD_CONTRACT = Object.freeze({
  pinnedNode: 'v24.12.0',
  minimumNodeMajor: 24,
  nodeSource: 'https://github.com/nodejs/node/blob/v24.12.0/src/node.cc#L784',
  libuvSource: 'https://github.com/nodejs/node/blob/v24.12.0/deps/uv/src/unix/core.c#L753'
});

const LABEL = /^[a-z][a-z0-9]{0,23}$/;
const FINAL = /^(start|delete)\.(.*)\.fifo$/;
const TEMPORARY = /^\.(start|delete)\..*\.tmp$/;
const PARTS = /^([a-z][a-z0-9]{0,23})\.(\d+)\.([0-9a-f]{12})$/;
const PUBLISH_ATTEMPTS = 2;
const MKFIFO_TIMEOUT_MS = 5_000;

const LABEL_WORDS = {
  prepare: "Install's data step",
  preflight: "Start's checks",
  redis: 'the database',
  server: 'the file server',
  app: 'the app',
  delete: 'Delete Batshit data'
};

function makeFifo(path) {
  const result = spawnSync('mkfifo', ['-m', '600', path], { encoding: 'utf8', timeout: MKFIFO_TIMEOUT_MS });
  if (result.error) {
    const error = new Error('mkfifo could not run');
    error.code = result.error.code;
    throw error;
  }
  if (result.status !== 0) {
    const error = new Error(`mkfifo exited with status ${result.status}`);
    error.code = 'MKFIFO_FAILED';
    throw error;
  }
}

const REAL_DEPS = Object.freeze({
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
  readdirSync,
  makeFifo,
  randomHex: () => randomBytes(6).toString('hex'),
  pid: () => process.pid,
  platform: () => process.platform,
  nodeVersion: () => process.versions.node,
  // Test seam: called after this command's FIFO has its final name and before it scans.
  afterPublish: () => {}
});

function withDeps(deps) {
  return { ...REAL_DEPS, ...deps };
}

function codeOf(problem) {
  return typeof problem?.code === 'string' ? problem.code : 'unknown';
}

/** The admission folder for a data root: its sibling `<root name>.admission`. Pure. */
export function laneAdmissionDir(dataRoot) {
  const root = resolve(dataRoot);
  return join(dirname(root), `${basename(root)}.admission`);
}

/**
 * Has anybody this FIFO open for reading? `live`, `dead` (nobody: ENXIO), `gone` (no such entry), or
 * `unknown`: a symlink, a file, a folder, or a FIFO that cannot be asked. Unknown never counts as
 * "no holder".
 */
export function probeAdmissionEntry(path, { deps } = {}) {
  const d = withDeps(deps);
  let info;
  try {
    info = d.lstatSync(path);
  } catch (problem) {
    return codeOf(problem) === 'ENOENT' ? 'gone' : 'unknown';
  }
  if (!info.isFIFO()) return 'unknown';
  let fd;
  try {
    fd = d.openSync(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (problem) {
    const code = codeOf(problem);
    if (code === 'ENXIO') return 'dead';
    if (code === 'ENOENT') return 'gone';
    return 'unknown';
  }
  try {
    d.closeSync(fd);
  } catch {}
  return 'live';
}

function describeEntry(name) {
  const final = FINAL.exec(name);
  const parts = final && PARTS.exec(final[2]);
  if (!parts) return { role: final?.[1] ?? null, label: null, pid: null };
  return { role: final[1], label: parts[1], pid: Number(parts[2]) };
}

// Unlink an entry only while it is proven dead; answers whether it is gone afterwards. A dead final
// FIFO stays dead (only its creator ever opens one for reading, and only as a temporary). A temporary
// can come alive between the probe and the unlink (its creator opens it right after mkfifo): unlinking
// it then only makes that creator's rename fail, and the creator retries or refuses. It never admits
// anyone, because a temporary never decides.
function removeIfDead(path, d) {
  const state = probeAdmissionEntry(path, { deps: d });
  if (state === 'gone') return true;
  if (state !== 'dead') return false;
  try {
    d.unlinkSync(path);
  } catch (problem) {
    // Not removable: a dead entry holds nothing up, and the next scan tries again.
    return codeOf(problem) === 'ENOENT';
  }
  return true;
}

// One line Pinokio shows as it is: never the words that make it stop a step (an `error:`, an
// `errno `), whatever a path happens to contain.
function safeLine(text) {
  return String(text).replace(/\s+/g, ' ').replace(/(error):/gi, '$1 -').replace(/(errno) /gi, '$1=');
}

function refusal(reason, message, entries = []) {
  return { ok: false, reason, message: safeLine(message), entries };
}

function nothingDone(role) {
  return role === 'delete' ? 'nothing was deleted' : "Batshit's data was not touched";
}

function holderWords(entries) {
  return entries
    .map((entry) => {
      const what = Object.hasOwn(LABEL_WORDS, entry.label ?? '')
        ? LABEL_WORDS[entry.label]
        : entry.label
          ? `its ${entry.label}`
          : 'a launcher step';
      return entry.pid ? `${what} (started by launcher process ${entry.pid})` : what;
    })
    .join(', ');
}

function liveRefusal(role, entries) {
  if (role === 'delete') {
    return refusal(
      'opposite-live',
      `nothing was deleted: Batshit is starting or running: ${holderWords(entries)}. If Batshit is running, press Pinokio's stop button; if Pinokio does not show it running, click Start, then stop it; restarting the computer also ends it. Then delete again.`,
      entries
    );
  }
  return refusal(
    'opposite-live',
    "Delete Batshit data is running, so Batshit's data was not touched. Try again after it finishes.",
    entries
  );
}

function unknownRefusal(role, entries) {
  const other = role === 'delete' ? 'a Batshit Start' : 'a Delete Batshit data';
  return refusal(
    'opposite-unknown',
    `${nothingDone(role)}: the launcher could not tell whether ${entries.map((entry) => entry.path).join(', ')} belongs to ${other} that still runs (it is not a FIFO, or the launcher could not ask it). If no Batshit Start or Delete is running, remove it, then try again.`,
    entries
  );
}

function ensureFolder(dir, d) {
  try {
    // `~/.batshit` is shared with the app: if it is missing, it gets the default mode, as the app
    // would create it. Only the admission folder itself is private.
    d.mkdirSync(dirname(dir), { recursive: true });
    d.mkdirSync(dir, { mode: 0o700 });
  } catch (problem) {
    if (codeOf(problem) !== 'EEXIST') return codeOf(problem);
  }
  try {
    const info = d.lstatSync(dir);
    return info.isDirectory() ? null : 'not a folder';
  } catch (problem) {
    return codeOf(problem);
  }
}

// mkfifo the temporary, open its reader, then give it its final name. On any failure the reader is
// closed and the temporary removed only if it is dead, so nothing of this attempt is left holding.
function publish({ dir, role, label }, d) {
  let lastProblem = 'unknown';
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    const stem = `${role}.${label}.${d.pid()}.${d.randomHex()}`;
    const temporary = join(dir, `.${stem}.tmp`);
    const final = join(dir, `${stem}.fifo`);
    let fd = null;
    try {
      d.makeFifo(temporary);
      fd = d.openSync(temporary, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      d.renameSync(temporary, final);
      return { fd, path: final };
    } catch (problem) {
      lastProblem = codeOf(problem);
      if (fd !== null) {
        try {
          d.closeSync(fd);
        } catch {}
      }
      removeIfDead(temporary, d);
    }
  }
  return { problem: lastProblem };
}

/**
 * Admit one launcher command. `role` is 'start' (anything that reads or creates the data root,
 * services included) or 'delete'. Answers `{ ok: true, role, label, path, fd }` to hold (keep `fd`
 * open; process death releases it), or `{ ok: false, reason, message, entries }`: refuse with
 * `message`, before reading or touching the root.
 */
export function admit({ role, label, dataRoot, deps } = {}) {
  if (!ADMISSION_ROLES.includes(role)) throw new TypeError(`admission role must be start or delete, not "${role}"`);
  if (!LABEL.test(label ?? '')) throw new TypeError(`admission label must be one lower-case word, not "${label}"`);
  if (typeof dataRoot !== 'string' || !dataRoot) throw new TypeError('admission needs the data root it guards');
  const d = withDeps(deps);
  if (d.platform() === 'win32') {
    return refusal('unsupported', `${nothingDone(role)}: Batshit's Pinokio launcher does not run on Windows.`);
  }
  const dir = laneAdmissionDir(dataRoot);
  const folderProblem = ensureFolder(dir, d);
  if (folderProblem) {
    return refusal(
      'folder-unusable',
      `${nothingDone(role)}: the launcher could not use its admission folder ${dir} (${folderProblem}). Check that it is a folder you own, then try again.`
    );
  }
  const published = publish({ dir, role, label }, d);
  if (!published.path) {
    return refusal(
      'publish-failed',
      `${nothingDone(role)}: the launcher could not create its admission entry in ${dir} (${published.problem}). Try again; if it keeps happening, check that folder.`
    );
  }
  const admission = { ok: true, role, label, path: published.path, fd: published.fd };
  d.afterPublish(admission);

  let names;
  try {
    names = d.readdirSync(dir);
  } catch (problem) {
    releaseAdmission(admission, { deps: d });
    return refusal(
      'folder-unusable',
      `${nothingDone(role)}: the launcher could not read its admission folder ${dir} (${codeOf(problem)}). Check that it is a folder you own, then try again.`
    );
  }
  const opposite = role === 'start' ? 'delete' : 'start';
  const live = [];
  const unknown = [];
  for (const name of names) {
    const path = join(dir, name);
    if (path === admission.path) continue;
    if (TEMPORARY.test(name)) {
      // A creator scans after its own rename, so its temporary never decides; only a dead one goes.
      removeIfDead(path, d);
      continue;
    }
    const final = FINAL.exec(name);
    if (!final) continue;
    const state = probeAdmissionEntry(path, { deps: d });
    if (state === 'dead') {
      removeIfDead(path, d);
      continue;
    }
    if (final[1] !== opposite || state === 'gone') continue;
    const entry = { path, state, ...describeEntry(name) };
    if (state === 'live') live.push(entry);
    else unknown.push(entry);
  }
  if (live.length > 0 || unknown.length > 0) {
    releaseAdmission(admission, { deps: d });
    return live.length > 0 ? liveRefusal(role, [...live, ...unknown]) : unknownRefusal(role, unknown);
  }
  return admission;
}

/**
 * Close this process's reader, then remove its FIFO only if that left it dead. A service child that
 * still holds the reader keeps the FIFO live ('kept-live'); a later scan removes it once it dies.
 * Never throws, and may be called again (it runs in `finally` blocks and after a child exits).
 */
export function releaseAdmission(admission, { deps } = {}) {
  // 'removed' | 'kept-live' (a service child holds it) | 'kept-dead' (dead, not removable now; the
  // next scan tries again) | 'kept-unknown' | 'gone' (also for anything that was never held).
  const d = withDeps(deps);
  if (!admission?.ok || typeof admission.path !== 'string') return 'gone';
  if (admission.fd !== null && admission.fd !== undefined) {
    try {
      d.closeSync(admission.fd);
    } catch {}
    admission.fd = null;
  }
  const state = probeAdmissionEntry(admission.path, { deps: d });
  if (state === 'dead') return removeIfDead(admission.path, d) ? 'removed' : 'kept-dead';
  if (state === 'live') return 'kept-live';
  return state === 'gone' ? 'gone' : 'kept-unknown';
}

function nodeMajor(version) {
  return Number(String(version).replace(/^v/, '').split('.')[0]);
}

/**
 * The stdio for one of the three service children: its three standard entries, then the admission
 * reader as descriptor 3, which it keeps until it exits. Only for redis-server, the file server and
 * the app.
 */
export function serviceStdio(admission, base = ['ignore', 'inherit', 'inherit'], { deps } = {}) {
  const d = withDeps(deps);
  if (!(nodeMajor(d.nodeVersion()) >= SERVICE_FD_CONTRACT.minimumNodeMajor)) {
    throw new Error(
      `the admission reader's containment needs Node ${SERVICE_FD_CONTRACT.minimumNodeMajor} or newer (pinned ${SERVICE_FD_CONTRACT.pinnedNode}), not ${d.nodeVersion()}`
    );
  }
  if (!admission?.ok || !Number.isInteger(admission.fd)) throw new TypeError('serviceStdio needs a held admission');
  if (!Array.isArray(base) || base.length !== 3) throw new TypeError('serviceStdio takes exactly the three standard entries');
  assertNoAdmissionFd(base, admission);
  return [...base, admission.fd];
}

/**
 * One narrow additional writer: Windows-WSL's managed Node publication/cleanup Bash child.
 * Its inherited reader must survive a dead driver through its writing descendants. It has no
 * run-end pipe. This is not for ordinary npm/build/prune commands; the writer also holds its
 * own persistent kernel flock, because admission excludes opposite roles, not two Deletes.
 */
export function runtimeWriterStdio(admission, base = ['ignore', 'inherit', 'inherit']) {
  return serviceStdio(admission, base);
}

/** Throw when `stdio` would hand the admission reader to a spawn that is not a service child. */
export function assertNoAdmissionFd(stdio, admission) {
  const fd = admission?.fd;
  if (!Number.isInteger(fd)) return;
  const entries = Array.isArray(stdio) ? stdio : [];
  if (entries.some((entry) => entry === fd || (entry && typeof entry === 'object' && entry.fd === fd))) {
    throw new Error(`descriptor ${fd} is the admission reader: only the three service children may receive it`);
  }
}
