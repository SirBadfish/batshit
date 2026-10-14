'use strict';

// BL-1213: fixed one-request, credential-free filesystem child. A held cwd binds
// a directory OBJECT, not an immutable pathname against another same-UID process.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMIT = 128 * 1024;
// Pinned from official v1.122.1 argparse destinations, never supplied by a caller.
const CONFIG_KEYS = new Set(('admin admindir adminpassword adminunloadtimeout agent agent_api_key agent_base_url allow_config_onready analyze autofit autofitpadding autoswapmode autoswapthreshold baseconfig batchsize benchmark blasthreads chatcompletionsadapter cli config contextsize debugmode defaultgenamt device downloaddir draftamount draftgpulayers draftgpusplit draftmodel embeddingsgpu embeddingsmaxctx embeddingsmodel enableguidance exportconfig exporttemplate failsafe ffncpu flashattention forceversion foreground gendefaults gendefaultsoverwrite genlimit gpulayers highpriority hordeconfig hordegenlen hordekey hordemaxctx hordemodelname hordeworkername host ignoremissing istemplate jinja jinja_kwargs jinja_tools jinjatemplate jinjathink launch lora loramult lowvram maingpu maxrequestsize mcpfile mmproj mmprojcpu model model_param moecpu moeexperts multiplayer multiuser musicdiffusion musicembeddings musicllm musiclowvram musicvae noavx2 noblas nobostoken nocertify nofastforward noflashattention nommap nommq nomodel nopipelineparallel noshift noswa onready overridekv overridenativecontext overridetensors parallelrequests password pipelineparallel port port_param preloadstory prompt quantkv quiet ratelimit reasoningeffort remotetunnel reqtimeout ropeconfig routermode rpcdevice rpchost rpcmode rpcport rpctargets run_bundled_agent savedatafile sdaudiovae sdclamped sdclampedsoft sdclip1 sdclip2 sdclipdevice sdclipgpu sdconfig sdconvdirect sdflashattention sdgendefaults sdllm sdlora sdloramult sdmaingpu sdmodel sdnotile sdoffloadcpu sdphotomaker sdquant sdt5xxl sdthreads sdtiledvae sdupscaler sdvae sdvaeauto sdvaecpu sdvaedevice sdvramlimit showgui singleinstance skiplauncher smartcache smartcontext splitmode ssl swapadding tensor_split testmemory threads ttsdir ttsgpu ttsmaxlen ttsmodel ttsthreads ttswavtokenizer ubatchsize unpack usecpu usecuda usedirectio usemlock usemmap usemtp useswa usevulkan version visionmaxres visionmaxtokens visionmintokens websearch whispermodel').split(' '));
const FORBIDDEN = new Set(('password adminpassword agent_api_key hordekey onready allow_config_onready agent run_bundled_agent agent_base_url cli launch exportconfig exporttemplate unpack mcpfile savedatafile hordeconfig remotetunnel websearch').split(' '));
// Official 1.122.1 argparse store_true/store_false destinations.
const BOOLEAN_FLAGS = new Set(('usecpu launch version agent autofit cli enableguidance failsafe foreground gendefaultsoverwrite highpriority ignoremissing jinja jinja_tools lowvram mmprojcpu multiplayer nocertify nofastforward noflashattention noavx2 nobostoken nommq nomodel noshift noswa allow_config_onready quiet remotetunnel singleinstance smartcontext usemtp usemlock usemmap usedirectio websearch showgui skiplauncher sdflashattention sdoffloadcpu sdvaeauto ttsgpu musiclowvram embeddingsgpu admin routermode autoswapmode noblas nommap nopipelineparallel pipelineparallel sdnotile sdvaecpu sdclipgpu forceversion sdgendefaults flashattention useswa testmemory run_bundled_agent').split(' '));
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function exact(v, keys) {
  if (!object(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error('Invalid managed profile schema.');
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readBytes(fd, limit = LIMIT) {
  const bytes = Buffer.alloc(limit + 1);
  let size = 0;
  while (size < bytes.length) {
    const count = fs.readSync(fd, bytes, size, bytes.length - size, size);
    if (count === 0) break;
    size += count;
  }
  if (size > limit) throw new Error('Managed file exceeds its byte bound.');
  return bytes.subarray(0, size);
}
function context(v) { return Number.isSafeInteger(v) && v >= 256 && v <= 524288; }
function identity(stat) { return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 }; }
function same(stat, expected) { return Object.entries(identity(stat)).every(([k, v]) => expected?.[k] === v); }
function validateIdentity(value) {
  exact(value, ['dev', 'ino', 'uid', 'mode']);
  if (['dev', 'ino', 'uid', 'mode'].some(k => !Number.isSafeInteger(value[k]) || value[k] < 0) || value.mode > 0o7777) throw new Error('Invalid registered object identity.');
}
function validateDirectory(directory) {
  exact(directory, ['path', 'identity', 'ancestry']);
  if (typeof directory.path !== 'string' || !path.isAbsolute(directory.path) || path.normalize(directory.path) !== directory.path || !Array.isArray(directory.ancestry) || directory.ancestry.length > 64) throw new Error('Invalid registered directory.');
  validateIdentity(directory.identity);
  const paths = [];
  for (let p = directory.path;; p = path.dirname(p)) { paths.unshift(p); if (p === path.dirname(p)) break; }
  if (paths.length !== directory.ancestry.length) throw new Error('Incomplete registered directory ancestry.');
  directory.ancestry.forEach((entry, index) => {
    exact(entry, ['path', 'dev', 'ino', 'uid', 'mode']);
    if (entry.path !== paths[index]) throw new Error('Invalid registered directory ancestry.');
    const { path: ignoredPath, ...objectIdentity } = entry;
    validateIdentity(objectIdentity);
  });
}
function chain(folder) {
  const canonical = fs.realpathSync.native(folder);
  const entries = [];
  for (let p = canonical;; p = path.dirname(p)) {
    const st = fs.lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Directory ancestry is not a real directory.');
    entries.unshift({ path: p, ...identity(st) });
    if (p === path.dirname(p)) break;
  }
  return entries;
}
function assertDirectory(directory) {
  validateDirectory(directory);
  if (!path.isAbsolute(directory.path) || !Array.isArray(directory.ancestry) || directory.ancestry.length > 64 ||
      directory.ancestry.at(-1)?.path !== directory.path || fs.realpathSync.native(directory.path) !== directory.path) {
    throw new Error('Registered directory path changed.');
  }
  for (const entry of directory.ancestry) {
    const st = fs.lstatSync(entry.path);
    if (!st.isDirectory() || st.isSymbolicLink() || !same(st, entry)) throw new Error('Registered directory ancestry changed.');
  }
  const st = fs.lstatSync(directory.path);
  if (!same(st, directory.identity) || st.uid !== process.getuid() || (st.mode & 0o022)) throw new Error('Registered directory ownership changed.');
}
function validateTemplate(template) {
  if (!object(template) || Object.keys(template).length > 200) throw new Error('A complete nonsecret native base is required.');
  for (const key of ['model_param', 'contextsize', 'gpulayers', 'threads', 'jinja', 'usecuda', 'usevulkan', 'usecpu']) {
    if (!Object.hasOwn(template, key)) throw new Error(`The full base lacks ${key}.`);
  }
  if (typeof template.model_param !== 'string' || !path.isAbsolute(template.model_param) || !context(template.contextsize) || (Object.hasOwn(template, 'istemplate') && template.istemplate !== false)) throw new Error('The full base must name an exact installed model, not an automatic template.');
  if (template.model != null && template.model !== '' && template.model !== template.model_param && !(Array.isArray(template.model) && (template.model.length === 0 || (template.model.length === 1 && template.model[0] === template.model_param)))) throw new Error('The native model field must be empty or name this exact canonical GGUF.');
  function finite(v, depth = 0) {
    if (depth > 4) throw new Error('Base nesting exceeds the schema.');
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (typeof v === 'string' && v.length <= 16384 && !v.includes('\0')) return;
    if (Array.isArray(v) && v.length <= 128) { v.forEach(x => finite(x, depth + 1)); return; }
    // Native option objects have a finite scalar map, not arbitrary recursive JSON.
    if (object(v) && depth < 2 && Object.keys(v).length <= 64) {
      for (const [k, x] of Object.entries(v)) {
        if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(k) || /password|secret|token|key|command/i.test(k)) throw new Error('Secret or command fields are not allowed in a managed base.');
        finite(x, depth + 1);
      }
      return;
    }
    throw new Error('Invalid base option value.');
  }
  for (const [key, value] of Object.entries(template)) {
    if (!CONFIG_KEYS.has(key)) throw new Error('Unknown native base option.');
    if (BOOLEAN_FLAGS.has(key) && typeof value !== 'boolean') throw new Error('Native boolean flags must contain actual booleans.');
    if (FORBIDDEN.has(key) && value !== null && value !== '' && value !== false && value !== 0 && !(Array.isArray(value) && value.length === 0)) throw new Error('Secret, command or autonomous options cannot be enrolled.');
    finite(value);
  }
  if (Buffer.byteLength(JSON.stringify(template)) > LIMIT / 2) throw new Error('Native base is too large.');
}
function validateGrant(g) {
  exact(g, ['version', 'id', 'generationId', 'userId', 'endpoint', 'installation', 'directory', 'adminDirectory', 'executable', 'enrolledProcess', 'models', 'createdAt']);
  if (g.version !== 1 || !UUID.test(g.id) || !/^[A-Za-z0-9_-]{1,128}$/.test(g.userId) || typeof g.endpoint !== 'string' ||
      !Array.isArray(g.models) || g.models.length < 1 || g.models.length > 32 || typeof g.createdAt !== 'string' || !Number.isFinite(Date.parse(g.createdAt))) throw new Error('Invalid registration.');
  if (g.generationId !== undefined && !UUID.test(g.generationId)) throw new Error('Invalid host generation binding.');
  if (new Set(g.models.map(m => m.id)).size !== g.models.length || new Set(g.models.map(m => m.nativeRef)).size !== g.models.length) throw new Error('Duplicate model registrations are not allowed.');
  for (const d of [g.installation, g.directory, g.adminDirectory]) validateDirectory(d);
  if (g.directory.path !== path.join(g.adminDirectory.path, 'batshit-managed') || typeof g.executable !== 'string' || !path.isAbsolute(g.executable)) throw new Error('Invalid managed directory or executable binding.');
  exact(g.enrolledProcess, ['pid', 'birth', 'uid', 'executable']);
  if (!Number.isSafeInteger(g.enrolledProcess.pid) || g.enrolledProcess.pid < 1 || !Number.isSafeInteger(g.enrolledProcess.uid) || g.enrolledProcess.uid < 0 || typeof g.enrolledProcess.birth !== 'string' || g.enrolledProcess.birth.length > 64 || g.enrolledProcess.executable !== g.executable) throw new Error('Invalid enrolled process identity.');
  for (const model of g.models) {
    exact(model, ['id', 'nativeRef', 'servedName', 'baseName', 'baseHash', 'modelPath', 'modelIdentity']);
    validateIdentity(model.modelIdentity);
    if (!UUID.test(model.id) || model.baseName !== `base-${model.id}.kcpps` || !/^[a-f0-9]{64}$/.test(model.baseHash) ||
        typeof model.nativeRef !== 'string' || !/^[^/\\\0]+(?:\/[^/\\\0]+)?\.gguf$/i.test(model.nativeRef) || model.nativeRef.split('/').some(x => x === '.' || x === '..') ||
        typeof model.servedName !== 'string' || !model.servedName || model.servedName.length > 512 || !path.isAbsolute(model.modelPath)) throw new Error('Invalid model registration.');
    if (model.modelPath !== path.join(g.adminDirectory.path, model.nativeRef)) throw new Error('Invalid enrolled model path binding.');
  }
}
function validateGeneration(g) {
  exact(g, ['version', 'id', 'previousId', 'reason', 'createdAt']);
  if (g.version !== 1 || !UUID.test(g.id) || (g.previousId !== null && (!UUID.test(g.previousId) || g.previousId === g.id)) || !['initial-enrollment', 'restore'].includes(g.reason) || typeof g.createdAt !== 'string' || g.createdAt.length > 64 || !Number.isFinite(Date.parse(g.createdAt))) throw new Error('Invalid host generation record.');
}
const HEAD_NAME = '.current-generation.json';
function validateHead(head) {
  exact(head, ['version', 'generationId']);
  if (head.version !== 1 || !UUID.test(head.generationId)) throw new Error('Invalid current host generation head.');
}
function privateBytes(name, limit) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1 || st.size > limit) throw new Error('Private host metadata custody changed.');
    return { bytes: readBytes(fd, limit), identity: identity(st) };
  } finally { fs.closeSync(fd); }
}
function assertExpectedHead(previous) {
  if (previous === null) {
    try { fs.lstatSync(HEAD_NAME); throw new Error('A current host head already exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  exact(previous, ['generationId', 'identity', 'hash']);
  validateIdentity(previous.identity);
  if (!UUID.test(previous.generationId) || !/^[a-f0-9]{64}$/.test(previous.hash)) throw new Error('Invalid expected host head custody.');
  const actual = privateBytes(HEAD_NAME, 256);
  const value = JSON.parse(actual.bytes);
  validateHead(value);
  if (actual.bytes.toString('utf8') !== JSON.stringify(value) + '\n' || value.generationId !== previous.generationId || hash(actual.bytes) !== previous.hash || !Object.entries(actual.identity).every(([key, v]) => v === previous.identity[key]) || !same(fs.lstatSync(HEAD_NAME), previous.identity)) throw new Error('Expected current host head changed.');
}
function assertExpectedLock(lock) {
  exact(lock, ['id', 'identity']);
  validateIdentity(lock.identity);
  if (!UUID.test(lock.id)) throw new Error('Invalid expected host lock custody.');
  const actual = privateBytes('.generation-lock', 256);
  if (actual.bytes.toString('utf8') !== JSON.stringify({ version: 1, id: lock.id }) + '\n' || !Object.entries(actual.identity).every(([key, value]) => value === lock.identity[key]) || !same(fs.lstatSync('.generation-lock'), lock.identity)) throw new Error('Expected host generation lock changed.');
}
function boundedRead(name, expectedHash) {
  if (!/^base-[a-f0-9-]{36}\.kcpps$/.test(name)) throw new Error('Invalid base name.');
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1 || st.size > LIMIT) throw new Error('Base ownership or size changed.');
    const bytes = readBytes(fd);
    if (hash(bytes) !== expectedHash) throw new Error('Registered full base changed.');
    validateTemplate(JSON.parse(bytes));
  } finally { fs.closeSync(fd); }
}
function perform(request, beforePublish, inheritedDirectoryFd = 3) {
  exact(request, ['operation', 'directory', 'id', 'contextTokens', 'base', 'template', 'grant', 'directoryKind', 'generation', 'lockIdentity', 'head']);
  if (!UUID.test(request.id)) throw new Error('Invalid generated file identity.');
  assertDirectory(request.directory);
  const dirfd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let temporary;
  let published;
  let replacement;
  try {
    if (!same(fs.fstatSync(dirfd), request.directory.identity) || !same(fs.fstatSync(inheritedDirectoryFd), request.directory.identity)) throw new Error('Child working directory does not match the held directory.');
    if (request.operation === 'lock-acquire') {
      let fd;
      try { fd = fs.openSync('.generation-lock', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Another host generation operation is running or its lock custody is unresolved.'); throw error; }
      published = '.generation-lock';
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, id: request.id }) + '\n');
        fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd);
        assertDirectory(request.directory);
        if (!stat.isFile() || stat.nlink !== 1 || !same(fs.lstatSync('.generation-lock'), identity(stat))) throw new Error('Published lock identity changed.');
        fs.fsyncSync(dirfd);
        assertDirectory(request.directory);
        return { success: true, lockIdentity: identity(stat) };
      } finally { fs.closeSync(fd); }
    }
    if (request.operation === 'lock-release') {
      validateIdentity(request.lockIdentity);
      const fd = fs.openSync('.generation-lock', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || !same(stat, request.lockIdentity) || readBytes(fd, 256).toString('utf8') !== JSON.stringify({ version: 1, id: request.id }) + '\n') throw new Error('Host generation lock custody changed.');
        assertDirectory(request.directory);
        if (!same(fs.lstatSync('.generation-lock'), request.lockIdentity)) throw new Error('Host generation lock path changed.');
        published = '.generation-lock';
        fs.unlinkSync('.generation-lock');
        fs.fsyncSync(dirfd);
        assertDirectory(request.directory);
        return { success: true };
      } finally { fs.closeSync(fd); }
    }
    if (request.operation === 'directory') {
      const names = { managed: 'batshit-managed', localAi: 'local-ai', profiles: 'koboldcpp-managed-profiles', grants: 'grants' };
      const childName = names[request.directoryKind];
      if (!childName) throw new Error('Invalid managed directory kind.');
      try { fs.mkdirSync(childName, { mode: 0o700 }); published = childName; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const childStat = fs.lstatSync(childName);
      if (!childStat.isDirectory() || childStat.isSymbolicLink() || childStat.uid !== process.getuid() || (childStat.mode & 0o077)) throw new Error('Managed child directory is not privately owned.');
      fs.fsyncSync(dirfd);
      assertDirectory(request.directory);
      return { success: true, name: childName, childIdentity: identity(childStat), created: published === childName };
    }
    let name, bytes;
    if (request.operation === 'context') {
      exact(request.base, ['name', 'hash']);
      if (!context(request.contextTokens)) throw new Error('Invalid context token count.');
      boundedRead(request.base.name, request.base.hash);
      name = `context-${request.id}.kcpps`;
      bytes = JSON.stringify({ contextsize: request.contextTokens }) + '\n';
    } else if (request.operation === 'snapshot') {
      validateTemplate(request.template);
      name = `base-${request.id}.kcpps`;
      bytes = JSON.stringify(request.template) + '\n';
    } else if (request.operation === 'registration') {
      validateGrant(request.grant);
      if (request.grant.id !== request.id || !UUID.test(request.grant.generationId)) throw new Error('Registration identity or host generation mismatch.');
      name = `${request.id}.json`;
      bytes = JSON.stringify(request.grant) + '\n';
    } else if (request.operation === 'generation') {
      validateGeneration(request.generation);
      if (request.generation.id !== request.id) throw new Error('Generation operation identity mismatch.');
      name = `generation-${request.id}.json`;
      bytes = JSON.stringify(request.generation) + '\n';
    } else if (request.operation === 'generation-head') {
      exact(request.head, ['generationId', 'previous', 'lock']);
      if (request.head.generationId !== request.id) throw new Error('Host head operation identity mismatch.');
      assertExpectedLock(request.head.lock);
      const generation = JSON.parse(privateBytes(`generation-${request.id}.json`, 4096).bytes);
      validateGeneration(generation);
      if (generation.id !== request.id || generation.previousId !== (request.head.previous?.generationId ?? null)) throw new Error('New generation does not follow the expected head.');
      assertExpectedHead(request.head.previous);
      name = HEAD_NAME;
      bytes = JSON.stringify({ version: 1, generationId: request.id }) + '\n';
    } else if (request.operation === 'revoke') {
      name = `${request.id}.revoked.json`;
      bytes = JSON.stringify({ version: 1, revoked: true, id: request.id }) + '\n';
    } else throw new Error('Unknown managed file operation.');
    if (Buffer.byteLength(bytes) > LIMIT) throw new Error('Managed file exceeds its byte bound.');
    if (!['revoke', 'generation-head'].includes(request.operation) && fs.readdirSync('.').length >= 256) throw new Error('Managed directory retention limit reached. Authority records are retained for operator review.');
    temporary = request.operation === 'generation-head' ? `.pending-head-${request.id}` : `.pending-${request.id}`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const written = fs.fstatSync(fd);
      beforePublish?.();
      assertDirectory(request.directory);
      if (!same(fs.lstatSync(temporary), identity(written)) || !fs.lstatSync(temporary).isFile()) throw new Error('Pending file identity changed.');
      if (request.operation === 'generation-head' && request.head.previous !== null) {
        // Only this fixed owned metadata head may be replaced. Keep the pending
        // inode as a witness until replacement/content/durability are confirmed.
        replacement = `.head-replacement-${request.id}`;
        fs.linkSync(temporary, replacement);
        fs.fsyncSync(dirfd);
        assertDirectory(request.directory);
        assertExpectedLock(request.head.lock);
        assertExpectedHead(request.head.previous);
        fs.renameSync(replacement, HEAD_NAME);
        replacement = undefined;
      } else {
        if (request.operation === 'generation-head') {
          assertExpectedLock(request.head.lock);
          assertExpectedHead(null);
        }
        // Generated publications and the first head never overwrite a name.
        fs.linkSync(temporary, name);
      }
      published = name;
      const resultFd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!same(fs.fstatSync(resultFd), identity(written)) || hash(readBytes(resultFd)) !== hash(bytes)) throw new Error('Published file identity or content changed.');
      } finally { fs.closeSync(resultFd); }
      fs.fsyncSync(dirfd);
      if (!same(fs.lstatSync(temporary), identity(written))) throw new Error('Pending file changed before retirement.');
      fs.unlinkSync(temporary);
      temporary = undefined;
      fs.fsyncSync(dirfd);
    } finally { fs.closeSync(fd); }
    assertDirectory(request.directory);
    return { success: true, name, hash: hash(bytes) };
  } catch (error) {
    // No path-based or blind cleanup after uncertainty. Every possible artifact
    // remains in the held directory and is named in the bounded nonsecret answer.
    error.partial = Boolean(temporary || published || replacement);
    error.artifacts = [temporary, published, replacement].filter(Boolean);
    throw error;
  } finally { fs.closeSync(dirfd); }
}
module.exports = { UUID, LIMIT, hash, readBytes, context, identity, same, chain, assertDirectory, validateTemplate, validateGrant, validateGeneration, validateHead, HEAD_NAME, perform };

if (require.main === module) {
  let input = Buffer.alloc(0);
  const timer = setTimeout(() => process.exit(2), 8000);
  process.stdin.on('data', chunk => {
    input = Buffer.concat([input, chunk]);
    if (input.length > LIMIT) process.exit(2);
  });
  process.stdin.on('end', () => {
    try { process.stdout.write(JSON.stringify(perform(JSON.parse(input.toString('utf8'))))); }
    catch (error) {
      process.stdout.write(JSON.stringify({ success: false, message: error.message, partial: error.partial === true, artifacts: error.artifacts ?? [] }));
      process.exitCode = 1;
    } finally { clearTimeout(timer); }
  });
}
