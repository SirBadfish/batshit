'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const W = require('./localAiManagedProfileWriter.cjs');
const { macCustodyRoots } = require('../utils/macCustodyPaths.cjs');
const run = promisify(execFile);
const WRITER = fs.realpathSync.native(require.resolve('./localAiManagedProfileWriter.cjs'));
const NODE = fs.realpathSync.native(process.execPath);
const CHILD_ENV = Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
const active = new Set();
const hostLocks = new WeakSet();
const freshDirectories = new WeakSet();
const initializableLocks = new WeakSet();

function exact(v, keys) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error('Invalid managed profile request.');
}
function user(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw new Error('Invalid local profile owner.'); }
function endpoint(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname) || !u.port) throw new Error('Context editing requires a registered same-machine HTTP loopback server.');
  u.hostname = '127.0.0.1';
  return u.origin;
}
function storageRoot(environment = process.env) {
  if (process.platform !== 'darwin' || environment.BATSHIT_RUNTIME_OWNER !== 'mac-app' || environment.BATSHIT_CONTAINERIZED === '1') throw new Error('Local context editing is available only to an enrolled Mac app installation. Remote and Docker connections use saved setups.');
  const config = macCustodyRoots(environment)[0];
  return path.join(config, 'local-ai', 'koboldcpp-managed-profiles', 'grants');
}
function directory(folder) {
  const canonical = fs.realpathSync.native(folder);
  const st = fs.lstatSync(canonical);
  const d = { path: canonical, identity: W.identity(st), ancestry: W.chain(canonical) };
  W.assertDirectory(d);
  return d;
}
function privateRead(file, limit = W.LIMIT) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1 || st.size > limit) throw new Error('Private managed profile ownership or size changed.');
    return W.readBytes(fd, limit);
  } finally { fs.closeSync(fd); }
}
async function metadataDirectory() {
  storageRoot();
  let root = directory(macCustodyRoots()[0]);
  for (const kind of ['localAi', 'profiles', 'grants']) root = await createDirectory(root, kind);
  return root;
}
async function withHostLock(root, action) {
  const id = randomUUID();
  const acquired = await write({ operation: 'lock-acquire', directory: root, id });
  const lock = Object.freeze({ directory: root, id, identity: acquired.lockIdentity, canInitialize: freshDirectories.has(root) });
  freshDirectories.delete(root);
  hostLocks.add(lock);
  if (lock.canInitialize) initializableLocks.add(lock);
  try { return await action(lock); }
  finally {
    try { await write({ operation: 'lock-release', directory: root, id, lockIdentity: lock.identity }); }
    finally { hostLocks.delete(lock); initializableLocks.delete(lock); }
  }
}
function assertHostLock(lock) {
  if (!hostLocks.has(lock)) throw new Error('Host generation operation has no owned lock.');
  W.assertDirectory(lock.directory);
  const file = path.join(lock.directory.path, '.generation-lock');
  if (!W.same(fs.lstatSync(file), lock.identity) || privateRead(file, 256).toString('utf8') !== JSON.stringify({ version: 1, id: lock.id }) + '\n') throw new Error('Host generation lock custody changed.');
}
function hostInventory(root) {
  W.assertDirectory(root);
  const names = fs.readdirSync(root.path);
  if (names.filter(n => n !== '.generation-lock').length > 512 || names.filter(n => !n.endsWith('.revoked.json') && n !== '.generation-lock').length > 256) throw new Error('Host authority inventory exceeds its retained bound.');
  for (const name of names) {
    if (name === '.generation-lock' || name === W.HEAD_NAME) continue;
    if (!/^(?:generation-)?[a-f0-9-]{36}\.json$/.test(name) && !/^[a-f0-9-]{36}\.revoked\.json$/.test(name)) throw new Error('Host authority has unresolved or unknown retained files.');
    if (name.endsWith('.revoked.json')) {
      const id = name.slice(0, -13);
      const value = JSON.parse(privateRead(path.join(root.path, name), 256));
      if (!W.UUID.test(id) || Object.keys(value).sort().join(',') !== 'id,revoked,version' || value.version !== 1 || value.id !== id || value.revoked !== true || !names.includes(`${id}.json`)) throw new Error('Host revocation custody is inconsistent.');
    }
  }
  W.assertDirectory(root);
  return names;
}
function readHostHead(lock) {
  assertHostLock(lock);
  const file = path.join(lock.directory.path, W.HEAD_NAME);
  let expected;
  try { expected = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error('Current host head is not a private regular file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1 || st.size > 256 || !W.same(st, W.identity(expected))) throw new Error('Current host head custody changed.');
    const bytes = W.readBytes(fd, 256);
    const value = JSON.parse(bytes);
    W.validateHead(value);
    if (bytes.toString('utf8') !== JSON.stringify(value) + '\n') throw new Error('Current host head bytes are not canonical.');
    if (!W.same(fs.lstatSync(file), W.identity(st))) throw new Error('Current host head path changed.');
    assertHostLock(lock);
    return { generationId: value.generationId, identity: W.identity(st), hash: W.hash(bytes) };
  } finally { fs.closeSync(fd); }
}
function readHostGeneration(lock) {
  assertHostLock(lock);
  const names = hostInventory(lock.directory);
  const head = readHostHead(lock);
  const records = names.filter(n => n.startsWith('generation-')).map(name => {
    const value = JSON.parse(privateRead(path.join(lock.directory.path, name), 4096));
    W.validateGeneration(value);
    if (name !== `generation-${value.id}.json`) throw new Error('Host generation filename changed.');
    return value;
  });
  if (!records.length) {
    if (head) throw new Error('Current host head refers to missing generation state.');
    const legacy = names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n));
    if (!legacy.length && !initializableLocks.has(lock)) throw new Error('Existing host metadata is empty or missing; explicit custody recovery is required.');
    for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const grant = readStoredGrant(lock.directory, name.slice(0, -5));
      if (grant.generationId !== undefined) throw new Error('Registered host generation state is missing.');
    }
    return null; // Only explicit enrollment/restore may initialize legacy/empty state.
  }
  if (!head) throw new Error('Current host generation head is missing.');
  const byId = new Map(records.map(r => [r.id, r]));
  for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
    const grant = readStoredGrant(lock.directory, name.slice(0, -5));
    if (grant.generationId !== undefined && !byId.has(grant.generationId)) throw new Error('A grant refers to missing host generation custody.');
  }
  const children = new Map();
  let roots = 0;
  for (const record of records) {
    if (record.previousId === null) { roots++; continue; }
    if (!byId.has(record.previousId) || children.has(record.previousId)) throw new Error('Host generation chain is inconsistent.');
    children.set(record.previousId, record.id);
  }
  const ends = records.filter(r => !children.has(r.id));
  if (roots !== 1 || ends.length !== 1) throw new Error('Host generation custody is ambiguous.');
  const visited = new Set();
  let current = ends[0];
  while (current) {
    if (visited.has(current.id)) throw new Error('Host generation chain contains a cycle.');
    visited.add(current.id);
    current = current.previousId === null ? null : byId.get(current.previousId);
  }
  if (visited.size !== records.length) throw new Error('Host generation chain is incomplete.');
  if (head.generationId !== ends[0].id) throw new Error('Current host head and complete generation chain disagree.');
  assertHostLock(lock);
  return ends[0];
}
async function advanceHostGeneration(lock, operationId, reason) {
  if (!W.UUID.test(operationId) || !['initial-enrollment', 'restore'].includes(reason)) throw new Error('Invalid host generation operation.');
  const previous = readHostGeneration(lock);
  const file = path.join(lock.directory.path, `generation-${operationId}.json`);
  if (fs.existsSync(file)) {
    if (previous?.id !== operationId || previous.reason !== reason) throw new Error('This operation was superseded; use an explicit new restore operation.');
    return previous; // Same explicit operation identity, never timestamp ordering.
  }
  const next = { version: 1, id: operationId, previousId: previous?.id ?? null, reason, createdAt: new Date().toISOString() };
  const previousHead = readHostHead(lock);
  initializableLocks.delete(lock);
  await write({ operation: 'generation', directory: lock.directory, id: next.id, generation: next });
  try {
    await write({ operation: 'generation-head', directory: lock.directory, id: next.id, head: { generationId: next.id, previous: previousHead, lock: { id: lock.id, identity: lock.identity } } });
  } catch (error) { error.partial = true; throw error; }
  const verified = readHostGeneration(lock);
  if (verified?.id !== next.id) throw Object.assign(new Error('Published host generation could not be confirmed.'), { partial: true });
  return verified;
}
function matchesHostGeneration(grant, generation) {
  return Boolean(generation && W.UUID.test(grant.generationId) && grant.generationId === generation.id);
}
async function fenceRestore(input) {
  exact(input, ['userId', 'operationId', 'requireState']); user(input.userId);
  if (typeof input.requireState !== 'boolean') throw new Error('Restore requires an explicit local custody expectation.');
  if (input.requireState && !fs.existsSync(storageRoot())) throw new Error('Expected host authority state is missing. Restore was refused.');
  if (!W.UUID.test(input.operationId)) throw new Error('A restore needs its explicit operation identity.');
  return withHostLock(await metadataDirectory(), async lock => {
    const generation = await advanceHostGeneration(lock, input.operationId, 'restore');
    return { generationId: generation.id, retainedFiles: true };
  });
}
function assertTrustedExecutable(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || ![0, process.getuid()].includes(st.uid) || (st.mode & 0o022)) throw new Error('The fixed executable or module is not trusted.');
}

/** Finite socket/PID/birth/UID/executable probe. Never argv, environment or logs. */
async function attest(rawEndpoint, expectedExecutable) {
  if (process.platform !== 'darwin') throw new Error('Same-machine native ownership is not available on this host.');
  const e = endpoint(rawEndpoint);
  const port = new URL(e).port;
  const opts = { env: CHILD_ENV, timeout: 3000, maxBuffer: 8192, encoding: 'utf8', shell: false };
  const listeners = async () => {
    const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], opts);
    const pids = [...stdout.matchAll(/^p([0-9]+)$/gm)].map(x => Number(x[1]));
    const names = [...stdout.matchAll(/^n(.+)$/gm)].map(x => x[1]);
    if (pids.length !== 1 || names.length !== 1 || names[0] !== `127.0.0.1:${port}`) throw new Error('The endpoint has no unique exact loopback listener.');
    return pids[0];
  };
  const pid = await listeners();
  const probe = async () => {
    const { stdout } = await run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'comm='], opts);
    const match = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(stdout);
    if (!match || Number(match[1]) !== process.getuid() || !path.isAbsolute(match[3])) throw new Error('Native listener owner or executable is ambiguous.');
    const executable = fs.realpathSync.native(match[3]);
    if (executable !== expectedExecutable) throw new Error('The listener is not the enrolled KoboldCpp executable.');
    assertTrustedExecutable(executable);
    return { pid, birth: match[2], uid: Number(match[1]), executable };
  };
  const first = await probe();
  if (await listeners() !== pid || JSON.stringify(await probe()) !== JSON.stringify(first)) throw new Error('Native process changed during ownership attestation.');
  return first;
}

/** Parent holds the directory open; child must match inherited fd3 and its dot. */
async function write(request) {
  W.assertDirectory(request.directory);
  assertTrustedExecutable(NODE);
  assertTrustedExecutable(WRITER);
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > W.LIMIT) throw new Error('Managed request exceeds its byte bound.');
  const fd = fs.openSync(request.directory.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  if (!W.same(fs.fstatSync(fd), request.directory.identity)) { fs.closeSync(fd); throw new Error('Held directory identity changed.'); }
  try {
    return await new Promise((resolve, reject) => {
      let child;
      let output = '';
      let exceeded = false;
      let timedOut = false;
      let killTimer;
      try { child = spawn(NODE, [WRITER], { cwd: request.directory.path, env: CHILD_ENV, shell: false, stdio: ['pipe', 'pipe', 'pipe', fd] }); }
      catch (error) { reject(error); return; }
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 200); }, 9000);
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > 8192) { exceeded = true; child.kill('SIGKILL'); }
      });
      // Discard stderr: unexpected runtime output must not expose parent state.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); clearTimeout(killTimer);
        if (exceeded || timedOut || signal) { reject(Object.assign(new Error('Managed writer ended without a verified publication. Files may remain; do not retry automatically.'), { partial: true })); return; }
        try {
          const answer = JSON.parse(output);
          if (code !== 0 || answer.success !== true) throw Object.assign(new Error(answer.message || 'Managed writer refused publication.'), { partial: answer.partial === true, artifacts: answer.artifacts });
          W.assertDirectory(request.directory);
          resolve(answer);
        } catch (error) { reject(error); }
      });
      child.stdin.end(input);
    });
  } finally { fs.closeSync(fd); }
}
function readStoredGrant(root, id) {
  if (!W.UUID.test(id)) throw new Error('Invalid managed registration ID.');
  const g = JSON.parse(privateRead(path.join(root.path, `${id}.json`)));
  W.validateGrant(g);
  if (g.id !== id || !W.same(fs.lstatSync(root.path), g.installation.identity) || root.path !== g.installation.path) throw new Error('Registration belongs to another installation.');
  W.assertDirectory(g.installation);
  return g;
}
function readGrant(lock, id) {
  if (!W.UUID.test(id)) throw new Error('Invalid managed registration ID.');
  const generation = readHostGeneration(lock);
  const root = lock.directory;
  if (fs.existsSync(path.join(root.path, `${id}.revoked.json`))) throw new Error('This managed registration has been revoked.');
  const g = readStoredGrant(root, id);
  if (!matchesHostGeneration(g, generation)) throw new Error('This setup belongs to an inactive host generation. Explicit local re-enrollment is required.');
  W.assertDirectory(g.adminDirectory);
  W.assertDirectory(g.directory);
  return g;
}
function assertGguf(file, expected) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (expected && !W.same(st, expected))) throw new Error('Installed GGUF identity changed.');
    const magic = Buffer.alloc(4);
    if (fs.readSync(fd, magic, 0, 4, 0) !== 4 || magic.toString('ascii') !== 'GGUF') throw new Error('The installed model is not a GGUF file.');
  } finally { fs.closeSync(fd); }
}
function verifyContextFile(g, artifactId, contextTokens) {
  if (!W.UUID.test(artifactId) || !W.context(contextTokens)) throw new Error('Invalid prepared context identity.');
  W.assertDirectory(g.directory);
  const bytes = privateRead(path.join(g.directory.path, `context-${artifactId}.kcpps`), 128);
  if (bytes.toString('utf8') !== JSON.stringify({ contextsize: contextTokens }) + '\n') throw new Error('Prepared context content changed.');
  W.assertDirectory(g.directory);
}
function checkModel(g, model) {
  W.assertDirectory(g.directory);
  const st = fs.lstatSync(model.modelPath);
  if (!st.isFile() || st.isSymbolicLink() || !W.same(st, model.modelIdentity) || st.uid !== process.getuid() || (st.mode & 0o022) || fs.realpathSync.native(model.modelPath) !== model.modelPath) throw new Error('The enrolled GGUF file changed. Re-enroll its full setup.');
  assertGguf(model.modelPath, model.modelIdentity);
  if (path.relative(g.adminDirectory.path, model.modelPath).split(path.sep).join('/') !== model.nativeRef) throw new Error('GGUF-to-base mapping changed.');
  const bytes = privateRead(path.join(g.directory.path, model.baseName));
  if (W.hash(bytes) !== model.baseHash) throw new Error('The registered full base changed. Re-enroll rather than silently replacing it.');
  const base = JSON.parse(bytes);
  W.validateTemplate(base);
  if (base.model_param !== model.modelPath) throw new Error('The full base names another model.');
}
async function validateUnlocked(input, lock) {
  exact(input, ['userId', 'endpoint', 'registrationId', 'modelId', 'contextTokens', 'artifactId']);
  user(input.userId);
  const g = readGrant(lock, input.registrationId);
  if (g.userId !== input.userId || g.endpoint !== endpoint(input.endpoint)) throw new Error('Registration does not match this user and saved connection.');
  await attest(g.endpoint, g.executable);
  for (const model of g.models) checkModel(g, model);
  return g;
}
function publicGrant(g) { return { registrationId: g.id, generationId: g.generationId, createdAt: g.createdAt, models: g.models.map(m => ({ id: m.id, nativeRef: m.nativeRef, servedName: m.servedName, baseConfig: `batshit-managed/${m.baseName}` })) }; }
async function validate(input) {
  return withHostLock(directory(storageRoot()), async lock => publicGrant(await validateUnlocked(input, lock)));
}
// Official 1.122.1 friendly-model rule, including a configured vanity name.
function servedName(template, modelPath) {
  if (template.hordemodelname != null && typeof template.hordemodelname !== 'string') throw new Error('Invalid native served-model name.');
  if (template.hordemodelname) {
    let name = template.hordemodelname;
    if (template.debugmode === 1 || template.gendefaults) name = `debug-${name}`;
    if (!name.startsWith('koboldcpp/')) name = `koboldcpp/${name}`;
    return name.slice('koboldcpp/'.length);
  }
  return path.basename(modelPath, path.extname(modelPath)).replace(/[^\p{L}\p{N}_.-]/gu, '');
}
async function list(input) {
  exact(input, ['userId', 'endpoint']);
  user(input.userId);
  endpoint(input.endpoint);
  const rootPath = storageRoot();
  if (!fs.existsSync(rootPath)) return { registrations: [], reenrollmentRequired: false };
  return withHostLock(directory(rootPath), async lock => {
    const generation = readHostGeneration(lock);
    const names = hostInventory(lock.directory);
    const grants = [];
    let reenrollmentRequired = false;
    for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const id = name.slice(0, -5);
      if (names.includes(`${id}.revoked.json`)) continue;
      const g = readStoredGrant(lock.directory, id);
      if (g.userId !== input.userId || g.endpoint !== endpoint(input.endpoint)) continue;
      if (!matchesHostGeneration(g, generation)) { reenrollmentRequired = true; continue; }
      grants.push(await validateUnlocked({ ...input, registrationId: g.id }, lock));
    }
    if (grants.length > 1) throw new Error('Several active setups match this connection. Revoke the older setup explicitly.');
    return { registrations: grants.map(publicGrant), reenrollmentRequired };
  });
}
async function prepare(input) {
  if (!W.context(input.contextTokens) || !W.UUID.test(input.modelId)) throw new Error('Choose a registered model and valid context token count.');
  const slot = input.registrationId;
  if (active.has(slot)) throw new Error('Another managed file operation is still running.');
  active.add(slot);
  try {
    return await withHostLock(directory(storageRoot()), async lock => {
      const g = await validateUnlocked(input, lock);
      const model = g.models.find(m => m.id === input.modelId);
      if (!model) throw new Error('The selected installed model is not enrolled.');
      const artifactId = randomUUID();
      const answer = await write({ operation: 'context', directory: g.directory, id: artifactId, contextTokens: input.contextTokens, base: { name: model.baseName, hash: model.baseHash } });
      // A post-publication refusal is partial, never a rollback or automatic retry.
      try { await validateUnlocked(input, lock); verifyContextFile(g, artifactId, input.contextTokens); } catch (error) { error.partial = true; throw error; }
      return { artifactId, filename: `batshit-managed/${answer.name}`, baseConfig: `batshit-managed/${model.baseName}`, expectedModel: model.servedName, fileHash: answer.hash };
    });
  } finally { active.delete(slot); }
}
async function verify(input) {
  return withHostLock(directory(storageRoot()), async lock => {
    const g = await validateUnlocked(input, lock);
    if (!g.models.some(m => m.id === input.modelId)) throw new Error('The prepared model is not enrolled.');
    verifyContextFile(g, input.artifactId, input.contextTokens);
    return { verified: true };
  });
}
async function revoke(input) {
  exact(input, ['userId', 'registrationId']);
  user(input.userId);
  if (active.has(input.registrationId)) throw new Error('A managed write is running; registration was retained.');
  active.add(input.registrationId);
  try {
    return await withHostLock(directory(storageRoot()), async lock => {
      readHostGeneration(lock);
      const root = lock.directory;
      if (!W.UUID.test(input.registrationId)) throw new Error('Invalid registration ID.');
      const g = JSON.parse(privateRead(path.join(root.path, `${input.registrationId}.json`)));
      W.validateGrant(g);
      if (g.userId !== input.userId || g.id !== input.registrationId) throw new Error('Registration belongs to another user.');
      // Do not require a surviving native process/directory to disable authority.
      if (!fs.existsSync(path.join(root.path, `${g.id}.revoked.json`))) await write({ operation: 'revoke', directory: root, id: g.id });
      return { success: true, retainedFiles: true, message: 'Local context editing is revoked. Managed files remain because native references cannot be proven inactive.' };
    });
  } finally { active.delete(input.registrationId); }
}
async function revokeOwnerUnlocked(lock, userId) {
  user(userId);
  readHostGeneration(lock);
  const root = lock.directory;
  const names = hostInventory(root);
  const revoked = [];
  for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
    const g = readStoredGrant(root, name.slice(0, -5));
    if (g.userId !== userId) continue;
    if (!names.includes(`${g.id}.revoked.json`)) await write({ operation: 'revoke', directory: root, id: g.id });
    revoked.push(g.id);
  }
  return { revoked, retainedFiles: true };
}
async function revokeOwner(input) {
  exact(input, ['userId', 'requireState']); user(input.userId);
  if (typeof input.requireState !== 'boolean') throw new Error('Deletion requires an explicit local custody expectation.');
  const root = storageRoot();
  if (!fs.existsSync(root)) {
    if (input.requireState) throw new Error('Expected host authority state is missing. The saved connection was retained.');
    return { revoked: [], retainedFiles: true };
  }
  return withHostLock(directory(root), lock => revokeOwnerUnlocked(lock, input.userId));
}

/** Operator-only producer; no HTTP caller supplies roots, files or config JSON. */
async function createDirectory(parent, kind) {
  const answer = await write({ operation: 'directory', directory: parent, id: randomUUID(), directoryKind: kind });
  const child = directory(path.join(parent.path, answer.name));
  if (!W.same(fs.lstatSync(child.path), answer.childIdentity)) throw new Error('The created directory object changed.');
  W.assertDirectory(parent);
  if (answer.created === true) freshDirectories.add(child);
  return child;
}
async function enroll(spec) {
  exact(spec, ['userId', 'endpoint', 'executable', 'adminRoot', 'models', 'directoryObjectGrant', 'nonsecretFullBase']);
  user(spec.userId);
  if (spec.directoryObjectGrant !== true || spec.nonsecretFullBase !== true || !Array.isArray(spec.models) || spec.models.length < 1 || spec.models.length > 32) throw new Error('Explicit directory-object and nonsecret full-base enrollment is required.');
  storageRoot(); // refuse unsupported hosts before reads or effects
  const executable = fs.realpathSync.native(spec.executable);
  const native = await attest(spec.endpoint, executable);
  const adminDirectory = directory(spec.adminRoot);
  const templates = [];
  for (const pair of spec.models) {
    exact(pair, ['nativeRef', 'fullBaseFile']);
    if (typeof pair.nativeRef !== 'string' || !/^[^/\\\0]+(?:\/[^/\\\0]+)?\.gguf$/i.test(pair.nativeRef) || pair.nativeRef.split('/').some(x => ['.', '..'].includes(x))) throw new Error('An exact root or depth-one GGUF reference is required.');
    const modelPath = fs.realpathSync.native(path.join(adminDirectory.path, pair.nativeRef));
    if (path.relative(adminDirectory.path, modelPath).split(path.sep).join('/') !== pair.nativeRef) throw new Error('Model path is not the exact authorized GGUF reference.');
    const st = fs.lstatSync(modelPath);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o022)) throw new Error('Installed model ownership is unsafe.');
    assertGguf(modelPath, W.identity(st));
    const template = JSON.parse(privateRead(pair.fullBaseFile));
    W.validateTemplate(template);
    if (template.model_param !== modelPath) throw new Error('The full base must name this exact canonical GGUF.');
    templates.push({ pair, template, modelPath, modelIdentity: W.identity(st), servedName: servedName(template, modelPath) });
  }
  // Reject every malformed base before any directory/file effects. Enrollment,
  // restore fencing and grant admission share this retained host lock.
  const installation = await metadataDirectory();
  return withHostLock(installation, async lock => {
    const generation = readHostGeneration(lock) ?? await advanceHostGeneration(lock, randomUUID(), 'initial-enrollment');
    const managedDirectory = await createDirectory(adminDirectory, 'managed');
    const models = [];
    for (const t of templates) {
      const id = randomUUID();
      const snapshot = await write({ operation: 'snapshot', directory: managedDirectory, id, template: t.template });
      models.push({ id, nativeRef: t.pair.nativeRef, servedName: t.servedName, baseName: snapshot.name, baseHash: snapshot.hash, modelPath: t.modelPath, modelIdentity: t.modelIdentity });
    }
    const g = { version: 1, id: randomUUID(), generationId: generation.id, userId: spec.userId, endpoint: endpoint(spec.endpoint), installation, directory: managedDirectory, adminDirectory, executable, enrolledProcess: native, models, createdAt: new Date().toISOString() };
    W.validateGrant(g);
    W.assertDirectory(adminDirectory);
    for (const model of g.models) checkModel(g, model);
    await attest(g.endpoint, executable);
    if (readHostGeneration(lock)?.id !== g.generationId) throw new Error('Host generation changed during enrollment. Files were retained.');
    await write({ operation: 'registration', directory: installation, id: g.id, grant: g });
    return publicGrant(g);
  });
}
module.exports = { list, verify, validate, prepare, revoke, revokeOwner, fenceRestore, enroll, write, endpoint, directory, servedName,
  withHostLock, readHostGeneration, readHostHead, advanceHostGeneration, matchesHostGeneration, revokeOwnerUnlocked, createDirectory };

if (require.main === module) {
  // Explicit terminal enrollment, no shell interpretation, no saved/live argv read.
  const [command, manifest, ...extra] = process.argv.slice(2);
  if (command === 'revoke' && W.UUID.test(manifest) && extra.length === 1) {
    revoke({ registrationId: manifest, userId: extra[0] }).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(`Revocation refused: ${error.message}\n`); process.exitCode = 1; });
  } else if (command !== 'enroll' || !manifest || extra.length) {
    process.stderr.write('Usage: node localAiManagedProfiles.js enroll <private-operator-manifest.json>, or revoke <registration UUID> <user ID>\n');
    process.exitCode = 1;
  } else {
    Promise.resolve().then(() => enroll(JSON.parse(privateRead(manifest)))).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
      process.stderr.write(`Enrollment refused: ${error.message}. Any created files are retained for operator review.\n`);
      process.exitCode = 1;
    });
  }
}
