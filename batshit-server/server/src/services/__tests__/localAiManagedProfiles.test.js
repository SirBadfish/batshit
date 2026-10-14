'use strict';

// The helper's default runner is Jest; keep the real fixed-child/FS proof here.
const { test, beforeAll, afterAll, afterEach } = require('@jest/globals');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
jest.setTimeout(30_000);
const W = require('../localAiManagedProfileWriter.cjs');
let S;
let runtimeRoot;
let fixtureWriter;
beforeAll(() => {
  runtimeRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kobold-writer-runtime-')));
  fs.chmodSync(runtimeRoot, 0o700);
  const writerSource = fs.realpathSync.native(require.resolve('../localAiManagedProfileWriter.cjs'));
  fixtureWriter = path.join(runtimeRoot, 'localAiManagedProfileWriter.cjs');
  fs.copyFileSync(writerSource, fixtureWriter, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(fixtureWriter, 0o600);
  assert.deepEqual(fs.readFileSync(fixtureWriter), fs.readFileSync(writerSource));
  const hostNode = fs.realpathSync.native(process.execPath);
  const nodeStat = fs.lstatSync(hostNode);
  let fixtureNode = hostNode;
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || ![0, process.getuid()].includes(nodeStat.uid) || (nodeStat.mode & 0o022)) {
    fixtureNode = path.join(runtimeRoot, 'node');
    fs.copyFileSync(hostNode, fixtureNode, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(fixtureNode, 0o700);
  }
  // Select fixed test-owned inputs only while loading the actual service.
  // All later FS, trust, spawn, environment and inherited-directory checks are real.
  // Retain an already-trusted host Node (including Homebrew's linked Mac runtime).
  jest.isolateModules(() => {
    let selectingFixedInputs = true;
    jest.doMock('node:fs', () => ({
      ...fs,
      realpathSync: Object.assign((...args) => fs.realpathSync(...args), {
        native: (file, ...args) => {
          const canonical = fs.realpathSync.native(file, ...args);
          if (selectingFixedInputs && file === process.execPath) return fixtureNode;
          if (selectingFixedInputs && canonical === writerSource) return fixtureWriter;
          return canonical;
        }
      })
    }));
    try { S = require('../localAiManagedProfiles.js'); }
    finally { selectingFixedInputs = false; jest.dontMock('node:fs'); }
  });
});
afterAll(() => { if (runtimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true }); });
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kobold-writer-')));
  roots.push(root);
  const folder = path.join(root, 'owned');
  fs.mkdirSync(folder, { mode: 0o700 });
  const template = { model_param: path.join(root, 'model.gguf'), model: [], contextsize: 65536, gpulayers: 44, threads: 8, jinja: true, usecuda: null, usevulkan: null, usecpu: false, jinja_kwargs: { enable_thinking: true }, quantkv: 2 };
  const baseName = `base-${randomUUID()}.kcpps`;
  const bytes = JSON.stringify(template) + '\n';
  fs.writeFileSync(path.join(folder, baseName), bytes, { mode: 0o600 });
  return { root, folder, template, baseName, request: { operation: 'context', directory: S.directory(folder), id: randomUUID(), contextTokens: 60000, base: { name: baseName, hash: W.hash(bytes) } } };
}
test('fixed writer trust still refuses group-writable and symlinked fixture modules before publication', async () => {
  const f = fixture();
  const before = fs.readdirSync(f.folder);
  fs.chmodSync(fixtureWriter, 0o620);
  try { await assert.rejects(S.write(f.request), /fixed executable or module is not trusted/); }
  finally { fs.chmodSync(fixtureWriter, 0o600); }
  assert.deepEqual(fs.readdirSync(f.folder), before);
  const retained = `${fixtureWriter}.retained`;
  fs.renameSync(fixtureWriter, retained);
  fs.symlinkSync(retained, fixtureWriter);
  try { await assert.rejects(S.write(f.request), /fixed executable or module is not trusted/); }
  finally { fs.unlinkSync(fixtureWriter); fs.renameSync(retained, fixtureWriter); }
  assert.deepEqual(fs.readdirSync(f.folder), before);
});
test('real fixed child publishes exact 60000 override and preserves every full-base byte', async () => {
  const f = fixture();
  const before = fs.readFileSync(path.join(f.folder, f.baseName));
  const answer = await S.write(f.request);
  assert.equal(answer.success, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.folder, answer.name))), { contextsize: 60000 });
  assert.deepEqual(fs.readFileSync(path.join(f.folder, f.baseName)), before);
  assert.equal(fs.statSync(path.join(f.folder, answer.name)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.folder, answer.name)).nlink, 1);
  assert.equal(fs.readdirSync(f.folder).filter(n => n.startsWith('.pending-')).length, 0);
});
test('strict integer and basename admission refuses unknown JSON, traversal and shell-shaped values', async () => {
  for (const bad of [255, 524289, 60000.5, '60000', null]) {
    const f = fixture();
    await assert.rejects(S.write({ ...f.request, contextTokens: bad }), /context token/);
    assert.deepEqual([...fs.readdirSync(f.folder)], [f.baseName]);
  }
  const f = fixture();
  await assert.rejects(S.write({ ...f.request, command: 'touch anything' }), /schema/);
  await assert.rejects(S.write({ ...f.request, base: { name: '../base.kcpps', hash: f.request.base.hash } }), /base name/);
  await assert.rejects(S.write({ ...f.request, directory: { ...f.request.directory, ancestry: f.request.directory.ancestry.slice(1) } }), /Incomplete/);
  await assert.rejects(S.write({ ...f.request, directory: { ...f.request.directory, identity: { ...f.request.directory.identity, extra: true } } }), /schema/);
});
test('a changed or symlinked full base refuses before any write', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.folder, f.baseName), '{}');
  await assert.rejects(S.write(f.request), /base changed/);
  fs.unlinkSync(path.join(f.folder, f.baseName));
  fs.symlinkSync(path.join(f.root, 'elsewhere'), path.join(f.folder, f.baseName));
  await assert.rejects(S.write(f.request));
  assert.equal(fs.readdirSync(f.folder).length, 1);
});
test('replacement and symlinked ancestry refuse before spawning a writer', async () => {
  const f = fixture();
  fs.renameSync(f.folder, `${f.folder}-old`);
  fs.mkdirSync(f.folder, { mode: 0o700 });
  await assert.rejects(S.write(f.request), /ancestry changed/);
  fs.rmdirSync(f.folder);
  fs.symlinkSync(`${f.folder}-old`, f.folder);
  await assert.rejects(S.write(f.request), /path changed/);
});
function heldPerform(f, hook) {
  const previous = process.cwd();
  const fd = fs.openSync(f.folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { process.chdir(f.folder); return W.perform(f.request, hook, fd); }
  finally { process.chdir(previous); fs.closeSync(fd); }
}
test('rename and path replacement after the fsynced write preserve partial artifacts, no publication', () => {
  const f = fixture();
  let caught;
  try { heldPerform(f, () => { fs.renameSync(f.folder, `${f.folder}-moved`); fs.mkdirSync(f.folder, { mode: 0o700 }); }); }
  catch (e) { caught = e; }
  assert.match(caught.message, /ancestry changed/);
  assert.equal(caught.partial, true);
  assert.deepEqual([...fs.readdirSync(f.folder)], []);
  const retained = fs.readdirSync(`${f.folder}-moved`);
  assert(retained.includes(`.pending-${f.request.id}`));
  assert(!retained.some(n => n.startsWith('context-')));
});
test('interrupted write retains the exact pending artifact and cannot overwrite a published name', () => {
  const f = fixture();
  assert.throws(() => heldPerform(f, () => { throw new Error('interrupted fixture'); }), e => e.partial && /interrupted/.test(e.message));
  assert(fs.existsSync(path.join(f.folder, `.pending-${f.request.id}`)));
  const second = fixture();
  const target = path.join(second.folder, `context-${second.request.id}.kcpps`);
  fs.writeFileSync(target, 'other owner', { mode: 0o600 });
  assert.throws(() => heldPerform(second), /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'other owner');
});
test('a held directory different from child dot is refused', () => {
  const f = fixture();
  const previous = process.cwd();
  const fd = fs.openSync(f.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    process.chdir(f.folder);
    assert.throws(() => W.perform(f.request, undefined, fd), /held directory/);
  } finally { process.chdir(previous); fs.closeSync(fd); }
});
test('finite native base schema rejects secrets, onready commands and automatic templates', () => {
  const f = fixture();
  W.validateTemplate(f.template);
  for (const patch of [{ password: 'secret' }, { onready: 'echo unsafe' }, { agent: true }, { istemplate: true }, { invented_option: 1 }]) assert.throws(() => W.validateTemplate({ ...f.template, ...patch }));
  assert.equal(S.servedName(f.template, '/approved/Qwen 3.5.gguf'), 'Qwen3.5');
  assert.equal(S.servedName({ ...f.template, hordemodelname: 'koboldcpp/custom' }, '/approved/model.gguf'), 'custom');
  assert.equal(S.servedName({ ...f.template, hordemodelname: 'custom', debugmode: 1 }, '/approved/model.gguf'), 'debug-custom');
  const readFd = fs.openSync(path.join(f.folder, f.baseName), fs.constants.O_RDONLY);
  try { assert.throws(() => W.readBytes(readFd, 8), /byte bound/); }
  finally { fs.closeSync(readFd); }
});
test('native empty/single model lists retain exact canonical model binding through the real writer', async () => {
  const f = fixture();
  for (const model of [[], [f.template.model_param], f.template.model_param, '', null]) {
    const template = { ...f.template, model, istemplate: false };
    const result = await S.write({ operation: 'snapshot', directory: f.request.directory, id: randomUUID(), template });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.folder, result.name))), template);
  }
  for (const model of [['/another.gguf'], [f.template.model_param, '/another.gguf'], '/another.gguf', true]) assert.throws(() => W.validateTemplate({ ...f.template, model }), /exact canonical/);
});
test('malformed native flags refuse before any publication effects', async () => {
  const f = fixture();
  for (const patch of [{ istemplate: 1 }, { istemplate: 'false' }, { istemplate: null }, { istemplate: 0 }, { istemplate: [] }, { jinja: 'false' }, { usecpu: 1 }, { enableguidance: null }]) {
    await assert.rejects(S.write({ operation: 'snapshot', directory: f.request.directory, id: randomUUID(), template: { ...f.template, ...patch } }));
    assert.deepEqual([...fs.readdirSync(f.folder)], [f.baseName]);
  }
});
test('remote, credential-bearing, path-shaped and Docker host addresses have no enrollment authority', () => {
  assert.equal(S.endpoint('http://localhost:5001'), 'http://127.0.0.1:5001');
  for (const url of ['http://host.docker.internal:5001', 'https://127.0.0.1:5001', 'http://127.0.0.1:5001/path', 'http://user:secret@127.0.0.1:5001', 'http://192.168.1.2:5001']) assert.throws(() => S.endpoint(url));
});

test('operator directory creation uses the fixed held-directory child and refuses a symlink', async () => {
  const f = fixture();
  const answer = await S.write({ operation: 'directory', directory: f.request.directory, id: randomUUID(), directoryKind: 'managed' });
  assert.equal(answer.name, 'batshit-managed');
  assert.equal(fs.statSync(path.join(f.folder, answer.name)).mode & 0o777, 0o700);
  fs.rmdirSync(path.join(f.folder, answer.name));
  fs.symlinkSync(f.root, path.join(f.folder, answer.name));
  await assert.rejects(S.write({ operation: 'directory', directory: f.request.directory, id: randomUUID(), directoryKind: 'managed' }), /privately owned/);
});
test('credential-free fixed child does not inherit loader flags', async () => {
  const f = fixture();
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require /nonexistent-bl1213-loader.cjs';
  try { assert.equal((await S.write(f.request)).success, true); }
  finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
});

async function hostFixture() {
  const f = fixture();
  const directory = await S.createDirectory(S.directory(f.root), 'grants');
  const host = directory.path;
  fs.mkdirSync(path.join(f.root, 'batshit-managed'), { mode: 0o700 });
  const id = randomUUID();
  const grant = { version: 1, id, userId: 'test-owner', endpoint: 'http://127.0.0.1:5001', installation: directory,
    directory: S.directory(path.join(f.root, 'batshit-managed')), adminDirectory: S.directory(f.root), executable: fs.realpathSync.native(process.execPath),
    enrolledProcess: { pid: 1, birth: 'isolated fixture', uid: process.getuid(), executable: fs.realpathSync.native(process.execPath) },
    models: [{ id: randomUUID(), nativeRef: 'model.gguf', servedName: 'custom', modelPath: f.template.model_param,
      modelIdentity: W.identity(fs.statSync(path.join(f.folder, f.baseName))), baseName: '', baseHash: f.request.base.hash }], createdAt: '2026-10-04T14:00:00Z' };
  grant.models[0].baseName = `base-${grant.models[0].id}.kcpps`;
  return { ...f, host, directory, grant };
}
async function registerFixture(lock, grant, generation) {
  grant.generationId = generation.id;
  await S.write({ operation: 'registration', directory: lock.directory, id: grant.id, grant });
}
test('durable generation equality defeats rollback, equal/future clocks and failed restore rollback', async () => {
  const f = await hostFixture();
  let original;
  await S.withHostLock(f.directory, async lock => {
    original = await S.advanceHostGeneration(lock, randomUUID(), 'initial-enrollment');
    await registerFixture(lock, f.grant, original);
    assert.equal(S.matchesHostGeneration(f.grant, S.readHostGeneration(lock)), true);
  });
  const restoreId = randomUUID();
  await assert.rejects(S.withHostLock(f.directory, async lock => {
    const restored = await S.advanceHostGeneration(lock, restoreId, 'restore');
    assert.equal(S.matchesHostGeneration(f.grant, restored), false);
    throw new Error('Redis replacement failed after durable fence');
  }), /replacement failed/);
  for (const clock of ['1900-01-01T00:00:00Z', original.createdAt, '2200-01-01T00:00:00Z']) {
    const recordPath = path.join(f.host, `generation-${restoreId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath));
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, createdAt: clock }) + '\n');
    await S.withHostLock(f.directory, async lock => {
      assert.equal(S.readHostGeneration(lock).id, restoreId);
      assert.equal(S.matchesHostGeneration(f.grant, S.readHostGeneration(lock)), false);
      assert.equal((await S.advanceHostGeneration(lock, restoreId, 'restore')).id, restoreId);
      assert.equal(S.matchesHostGeneration({ ...f.grant, generationId: restoreId }, S.readHostGeneration(lock)), true);
    });
  }
  assert(fs.existsSync(path.join(f.host, `${f.grant.id}.json`)));
});
test('restore operation replay is idempotent only while current, with no timestamp ordering', async () => {
  const f = await hostFixture();
  const first = randomUUID();
  await S.withHostLock(f.directory, async lock => {
    await S.advanceHostGeneration(lock, first, 'restore');
    await S.advanceHostGeneration(lock, first, 'restore');
    assert.equal(fs.readdirSync(f.host).filter(n => n.startsWith('generation-')).length, 1);
    await S.advanceHostGeneration(lock, randomUUID(), 'restore');
    await assert.rejects(S.advanceHostGeneration(lock, first, 'restore'), /superseded/);
  });
});
test('owner deletion revokes current, inactive and legacy grants without a surviving Redis registration ID', async () => {
  const f = await hostFixture();
  await S.withHostLock(f.directory, async lock => {
    const initial = await S.advanceHostGeneration(lock, randomUUID(), 'initial-enrollment');
    await registerFixture(lock, f.grant, initial);
    const restored = await S.advanceHostGeneration(lock, randomUUID(), 'restore');
    const next = { ...f.grant, id: randomUUID() };
    await registerFixture(lock, next, restored);
    const legacy = { ...f.grant, id: randomUUID() }; delete legacy.generationId;
    fs.writeFileSync(path.join(f.host, `${legacy.id}.json`), JSON.stringify(legacy) + '\n', { mode: 0o600 });
    const other = { ...f.grant, id: randomUUID(), userId: 'other-owner' };
    await registerFixture(lock, other, restored);
    const result = await S.revokeOwnerUnlocked(lock, f.grant.userId);
    assert.deepEqual(result.revoked.sort(), [f.grant.id, next.id, legacy.id].sort());
    assert(!fs.existsSync(path.join(f.host, `${other.id}.revoked.json`)));
    for (const id of result.revoked) {
      assert(fs.existsSync(path.join(f.host, `${id}.json`)));
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.host, `${id}.revoked.json`))).revoked, true);
    }
    assert.deepEqual((await S.revokeOwnerUnlocked(lock, f.grant.userId)).revoked.sort(), result.revoked.sort());
  });
});
test('host lock excludes competing enrollment/admission/fencing and cannot be released by another nonce', async () => {
  const f = await hostFixture();
  await S.withHostLock(f.directory, async lock => {
    await assert.rejects(S.withHostLock(f.directory, () => assert.fail('concurrent admission')), /lock custody/);
    await assert.rejects(S.write({ operation: 'lock-release', directory: f.directory, id: randomUUID(), lockIdentity: lock.identity }), /custody changed/);
    assert.deepEqual([...fs.readdirSync(f.host)], ['.generation-lock']);
    await S.advanceHostGeneration(lock, randomUUID(), 'restore');
  });
  assert(!fs.existsSync(path.join(f.host, '.generation-lock')));
});
test('missing, corrupt, branched or unresolved host state refuses and preserves every uncertain file', async () => {
  for (const corruption of ['missing', 'invalid', 'branch', 'pending']) {
    const f = await hostFixture();
    await S.withHostLock(f.directory, async lock => {
      const initial = await S.advanceHostGeneration(lock, randomUUID(), 'initial-enrollment');
      await registerFixture(lock, f.grant, initial);
      if (corruption === 'missing') fs.unlinkSync(path.join(f.host, `generation-${initial.id}.json`));
      if (corruption === 'invalid') fs.writeFileSync(path.join(f.host, `generation-${initial.id}.json`), '{}');
      if (corruption === 'branch') {
        for (let i = 0; i < 2; i++) {
          const id = randomUUID();
          await S.write({ operation: 'generation', directory: f.directory, id, generation: { ...initial, id, previousId: initial.id, reason: 'restore' } });
        }
      }
      if (corruption === 'pending') fs.writeFileSync(path.join(f.host, `.pending-${randomUUID()}`), 'uncertain', { mode: 0o600 });
      const before = fs.readdirSync(f.host).sort();
      await assert.rejects(S.advanceHostGeneration(lock, randomUUID(), 'restore'));
      assert.deepEqual(fs.readdirSync(f.host).sort(), before);
    });
  }
});


test('missing unreferenced newest restore tail cannot reactivate the older grant', async () => {
  const f = await hostFixture();
  await S.withHostLock(f.directory, async lock => {
    const original = await S.advanceHostGeneration(lock, randomUUID(), 'initial-enrollment');
    await registerFixture(lock, f.grant, original);
    const restored = await S.advanceHostGeneration(lock, randomUUID(), 'restore');
    // No grant binds the new generation: the authoritative head must still
    // reject suffix loss instead of deriving older authority from surviving A.
    fs.unlinkSync(path.join(f.host, `generation-${restored.id}.json`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.host, W.HEAD_NAME))).generationId, restored.id);
    assert.throws(() => S.readHostGeneration(lock), /head.*chain disagree/);
    await assert.rejects(S.advanceHostGeneration(lock, randomUUID(), 'initial-enrollment'), /head.*chain disagree/);
    assert(fs.existsSync(path.join(f.host, `${f.grant.id}.json`)));
  });
});
test('missing/corrupt head and emptied modern state refuse fresh initialization', async () => {
  for (const loss of ['missing-head', 'corrupt-head', 'noncanonical-head', 'symlink-head', 'empty-modern-directory']) {
    const f = await hostFixture();
    await S.withHostLock(f.directory, async lock => {
      const initial = await S.advanceHostGeneration(lock, randomUUID(), 'initial-enrollment');
      await registerFixture(lock, f.grant, initial);
      if (loss === 'missing-head') fs.unlinkSync(path.join(f.host, W.HEAD_NAME));
      if (loss === 'corrupt-head') fs.writeFileSync(path.join(f.host, W.HEAD_NAME), '{}');
      if (loss === 'noncanonical-head') fs.appendFileSync(path.join(f.host, W.HEAD_NAME), ' ');
      if (loss === 'symlink-head') { fs.unlinkSync(path.join(f.host, W.HEAD_NAME)); fs.symlinkSync(path.join(f.root, 'missing-head'), path.join(f.host, W.HEAD_NAME)); }
      if (loss === 'empty-modern-directory') {
        for (const name of fs.readdirSync(f.host).filter(n => n !== '.generation-lock')) fs.unlinkSync(path.join(f.host, name));
      }
      const before = fs.readdirSync(f.host).sort();
      assert.throws(() => S.readHostGeneration(lock));
      await assert.rejects(S.advanceHostGeneration(lock, randomUUID(), 'initial-enrollment'));
      assert.deepEqual(fs.readdirSync(f.host).sort(), before);
    });
    // A new process/root object has no consumed fresh-directory witness either.
    await assert.rejects(S.withHostLock(S.directory(f.host), lock => S.advanceHostGeneration(lock, randomUUID(), 'restore')));
  }
});
test('orphan generation, wrong expected head and interrupted head publication retain custody witnesses', async () => {
  const f = await hostFixture();
  await S.withHostLock(f.directory, async lock => {
    const original = await S.advanceHostGeneration(lock, randomUUID(), 'initial-enrollment');
    const previous = S.readHostHead(lock);
    const id = randomUUID();
    await S.write({ operation: 'generation', directory: f.directory, id, generation: { ...original, id, previousId: original.id, reason: 'restore' } });
    assert.throws(() => S.readHostGeneration(lock), /head.*chain disagree/);
    const request = { operation: 'generation-head', directory: f.directory, id, head: { generationId: id, previous, lock: { id: lock.id, identity: lock.identity } } };
    const before = fs.readdirSync(f.host).sort();
    await assert.rejects(S.write({ ...request, head: { ...request.head, lock: { ...request.head.lock, id: randomUUID() } } }), /lock changed/);
    assert.deepEqual(fs.readdirSync(f.host).sort(), before);
    await assert.rejects(S.write({ ...request, head: { ...request.head, previous: { ...previous, identity: { ...previous.identity, ino: previous.identity.ino + 1 } } } }), /head changed/);
    assert.deepEqual(fs.readdirSync(f.host).sort(), before);
    assert.throws(() => heldPerform({ folder: f.host, request }, () => { throw new Error('interrupted head fixture'); }), error => error.partial && /interrupted head/.test(error.message));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.host, W.HEAD_NAME))).generationId, original.id);
    assert(fs.existsSync(path.join(f.host, `.pending-head-${id}`)));
    assert(fs.existsSync(path.join(f.host, `generation-${id}.json`)));
    assert.throws(() => S.readHostGeneration(lock), /unresolved/);
  });
});
