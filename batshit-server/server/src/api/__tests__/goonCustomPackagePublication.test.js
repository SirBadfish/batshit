const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { zipSync, strToU8 } = require('fflate');

const mockUploadRoot = path.join(os.tmpdir(), `batshit-recipe-publication-${process.pid}-${Date.now()}`);
jest.mock('../../config', () => ({ uploadsDir: mockUploadRoot }));
jest.mock('../../services/redisService', () => ({
  get: jest.fn(),
  setWithTTL: jest.fn(),
  // Upload deletes read the record through the raw client, so a Redis error stops them (BL-144).
  isConnected: jest.fn(() => true),
  client: { isOpen: true, del: jest.fn(), eval: jest.fn(), get: jest.fn(), type: jest.fn(), json: { get: jest.fn() } }
}));
jest.mock('../../services/goonRecipeArchiveService', () => {
  const actual = jest.requireActual('../../services/goonRecipeArchiveService');
  return { ...actual, inspectAndExtractRecipeArchive: jest.fn() };
});
jest.mock('../../utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn()
}));

const redisService = require('../../services/redisService');
const recipeArchiveService = require('../../services/goonRecipeArchiveService');
const uploadRoutes = require('../upload-redis');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const modelBytes = Buffer.from('shared-model');
const manifestText = JSON.stringify({ name: 'Shared model' });
const manifestBytes = Buffer.from(manifestText);
const modelHash = sha256(modelBytes);
const manifestHash = sha256(manifestBytes);
const modelKey = `upload:goon_custom_models:${modelHash}.glb`;
const manifestKey = `upload:goon_custom_manifests:${manifestHash}.json`;

let server;
let baseUrl;
let records;
let markers;
let failManifest;
let manifestWriteEntered;
let releaseManifestWrite;
let extractionCount;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', uploadRoutes);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(mockUploadRoot, { recursive: true, force: true });
});

afterEach(() => jest.restoreAllMocks());

beforeEach(async () => {
  await fs.rm(mockUploadRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(mockUploadRoot, '_tmp'), { recursive: true });
  redisService.get.mockClear();
  redisService.setWithTTL.mockClear();
  redisService.client.del.mockClear();
  redisService.client.eval.mockClear();
  redisService.client.get.mockClear();
  recipeArchiveService.inspectAndExtractRecipeArchive.mockClear();
  records = new Map();
  markers = new Map();
  failManifest = false;
  extractionCount = 0;
  manifestWriteEntered = null;
  releaseManifestWrite = null;
  redisService.get.mockImplementation(async (key) => records.get(key) || null);
  redisService.setWithTTL.mockImplementation(async (key, payload) => {
    if (key === manifestKey && failManifest) {
      failManifest = false;
      manifestWriteEntered();
      await new Promise((resolve) => { releaseManifestWrite = resolve; });
      throw new Error('injected manifest failure');
    }
    records.set(key, payload);
    return true;
  });
  redisService.client.del.mockImplementation(async (key) => (records.delete(key) ? 1 : 0));
  redisService.client.type.mockImplementation(async (key) => (records.has(key) ? 'ReJSON-RL' : 'none'));
  redisService.client.json.get.mockImplementation(async (key) => records.get(key) ?? null);
  redisService.client.get.mockImplementation(async (key) => markers.get(key) ?? null);
  redisService.client.eval.mockImplementation(async (script, { keys, arguments: args }) => {
    if (script.includes('-- BEGIN_GOON_ASSET_RESTORE')) {
      if (markers.has(keys[1])) return markers.has(keys[0]) ? 'CLOSED_ACTIVE' : 'CLOSED_IDLE';
      const current = markers.get(keys[0]);
      if (current) return current === args[0] ? 'EXISTING' : 'CONFLICT';
      markers.set(keys[0], args[0]);
      return 'CREATED';
    }
    if (script.includes('-- END_GOON_ASSET_RESTORE')) {
      const current = markers.get(keys[0]);
      if (current && current !== args[0]) return 'CONFLICT';
      if (current) markers.delete(keys[0]);
      markers.set(keys[1], args[0]);
      return current ? 'RELEASED' : 'ABSENT';
    }
    const marker = (key) => {
      const raw = markers.get(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return 'INVALID'; }
    };
    if (script.includes('-- CLAIM_PUBLICATION')) {
      for (const key of keys) {
        const current = marker(key);
        if (current && (current === 'INVALID' || current.contract !== args[0] ||
            !current.token || !['publishing', 'reserved', 'deleting'].includes(current.phase))) {
          return 'INVALID_MARKER';
        }
        if (current && current.phase !== 'publishing') return 'BLOCKED';
      }
      for (const key of keys) markers.set(key, args[1]);
      return 'CLAIMED';
    }
    if (script.includes('-- RELEASE_PUBLICATION')) {
      for (const key of keys) {
        const current = marker(key);
        if (!current) return 'MISSING_MARKER';
        if (current.contract !== args[0] || current.token !== args[1] || current.phase !== 'publishing') {
          return 'CHANGED_MARKER';
        }
      }
      for (const key of keys) markers.delete(key);
      return 'RELEASED';
    }
    if (script.includes('-- RESERVE_DELETION')) {
      const current = marker(keys[0]);
      if (current && (current === 'INVALID' || current.contract !== args[0] ||
          !current.token || !['publishing', 'reserved', 'deleting'].includes(current.phase))) {
        return 'INVALID_MARKER';
      }
      if (current && current.phase !== 'publishing') return `EXISTING:${markers.get(keys[0])}`;
      markers.set(keys[0], args[1]);
      return `${current ? 'RECOVERED' : 'CREATED'}:${args[1]}`;
    }
    if (script.includes('-- BEGIN_DELETION')) {
      const current = marker(keys[0]);
      if (!current) return 'MISSING_MARKER';
      if (current.contract !== args[0] || !['reserved', 'deleting'].includes(current.phase)) {
        return 'INVALID_MARKER';
      }
      if (current.token !== args[1]) return 'WRONG_TOKEN';
      markers.set(keys[0], JSON.stringify({ ...current, phase: 'deleting' }));
      return 'DELETING';
    }
    if (script.includes('-- FINISH_DELETION')) {
      const current = marker(keys[0]);
      if (!current) return 'MISSING_MARKER';
      if (current.contract !== args[0] || current.token !== args[1] || current.phase !== 'deleting') {
        return 'CHANGED_MARKER';
      }
      markers.delete(keys[0]);
      return 'RELEASED';
    }
    throw new Error('Unexpected Redis script');
  });
  recipeArchiveService.inspectAndExtractRecipeArchive.mockImplementation(async ({ archivePath, outputDir }) => {
    extractionCount += 1;
    const archive = await fs.readFile(archivePath);
    const suffix = crypto.randomUUID();
    const modelPath = path.join(outputDir, `${suffix}.glb`);
    const manifestPath = path.join(outputDir, `${suffix}.json`);
    await Promise.all([fs.writeFile(modelPath, modelBytes), fs.writeFile(manifestPath, manifestBytes)]);
    return {
      contract: 'goon-recipe-extraction/v1',
      extractor: 'test',
      archive: { sha256: sha256(archive), bytes: archive.length },
      manifestText,
      members: [
        { role: 'model', path: 'avatar.glb', sha256: modelHash, bytes: modelBytes.length, tempPath: modelPath },
        { role: 'manifest', path: 'avatar.json', sha256: manifestHash, bytes: manifestBytes.length, tempPath: manifestPath }
      ],
      entryCount: 2,
      totalUncompressedBytes: modelBytes.length + manifestBytes.length
    };
  });
});

async function uploadArchive(marker) {
  const form = new FormData();
  // The parser is mocked here; the route still checks the uploaded ZIP signature.
  form.append('file', new Blob([Buffer.from(`PK\x03\x04${marker}`)]), `${marker}.bgoon`);
  const response = await fetch(`${baseUrl}/api/upload/goon-custom-package`, {
    method: 'POST', body: form
  });
  return { status: response.status, body: await response.json() };
}

async function inspectPackage(filename) {
  const response = await fetch(`${baseUrl}/api/upload/goon-custom-package/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename })
  });
  return { status: response.status, body: await response.json() };
}

async function reserveAsset(uploadType, filename) {
  const response = await fetch(`${baseUrl}/api/upload/asset-deletion/reserve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadType, filename })
  });
  return { status: response.status, body: await response.json() };
}

async function deleteAsset(uploadType, filename, deletionToken) {
  const response = await fetch(`${baseUrl}/api/upload/asset`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadType, filename, deletionToken })
  });
  return { status: response.status, body: await response.json() };
}

async function maintenance(action, token) {
  const response = await fetch(`${baseUrl}/api/upload/asset-maintenance/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for concurrent upload state');
}

test('inspection measures stored package members and removes only its temporary output', async () => {
  const upload = await uploadArchive('inspect');
  const filename = upload.body.files.package.filename;
  const result = await inspectPackage(filename);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    contract: 'recipe-archive-inspection/v1',
    archive: { sha256: upload.body.files.package.sha256, bytes: upload.body.files.package.size }
  });
  expect(result.body.members).toEqual(expect.arrayContaining([
    { role: 'model', sha256: modelHash, bytes: modelBytes.length },
    { role: 'manifest', sha256: manifestHash, bytes: manifestBytes.length }
  ]));
  expect((await fs.readdir(path.join(mockUploadRoot, '_tmp'))).filter(name => name.startsWith('recipe-inspect-'))).toEqual([]);
  expect(records.size).toBe(3);
});

test('the real file-service extractor inspects a compressed uploaded archive', async () => {
  const actual = jest.requireActual('../../services/goonRecipeArchiveService');
  recipeArchiveService.inspectAndExtractRecipeArchive.mockImplementation(actual.inspectAndExtractRecipeArchive);
  const model = crypto.randomBytes(256);
  model.write('glTF', 0, 'ascii');
  const manifest = strToU8('{"name":"Compressed Source"}');
  const archive = zipSync({ 'avatar.glb': model, 'avatar.json': manifest }, { level: 6 });
  const form = new FormData();
  form.append('file', new Blob([archive]), 'compressed.bgoon');
  const response = await fetch(`${baseUrl}/api/upload/goon-custom-package`, { method: 'POST', body: form });
  expect(response.status).toBe(200);
  const uploaded = await response.json();
  const inspected = await inspectPackage(uploaded.files.package.filename);
  expect(inspected.status).toBe(200);
  expect(inspected.body.archive).toEqual({ sha256: sha256(archive), bytes: archive.length });
  expect(inspected.body.members).toEqual(expect.arrayContaining([
    { role: 'model', sha256: sha256(model), bytes: model.length },
    { role: 'manifest', sha256: sha256(manifest), bytes: manifest.length }
  ]));
  expect((await fs.readdir(path.join(mockUploadRoot, '_tmp'))).filter(name => name.startsWith('recipe-inspect-'))).toEqual([]);
});

test('inspection refuses unsafe names and missing records, preserves a restored path, and rejects symlinked files', async () => {
  const upload = await uploadArchive('inspect-negative');
  const filename = upload.body.files.package.filename;
  expect((await inspectPackage('../escape.bgoon')).status).toBe(400);
  expect((await inspectPackage('missing.bgoon')).status).toBe(400);
  const key = `upload:goon_custom_packages:${filename}`;
  const original = records.get(key);
  const originalPath = path.join(mockUploadRoot, 'goon_custom_packages', filename);
  const sourcePath = path.join(mockUploadRoot, 'restored', filename);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.rename(originalPath, sourcePath);
  records.set(key, { ...original, relativePath: `restored/${filename}`, filePath: sourcePath });
  expect((await inspectPackage(filename)).status).toBe(200);
  records.set(key, { ...original, relativePath: `restored/${filename}`, filePath: sourcePath, sha256: '0'.repeat(64) });
  expect((await inspectPackage(filename)).status).toBe(400);
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-inspection-outside-'));
  try {
    await fs.copyFile(sourcePath, path.join(outsideRoot, filename));
    await fs.symlink(outsideRoot, path.join(mockUploadRoot, 'escape'), 'dir');
    records.set(key, { ...original, relativePath: `escape/${filename}` });
    expect((await inspectPackage(filename)).status).toBe(400);
  } finally {
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
  records.set(key, { ...original, relativePath: `restored/${filename}`, filePath: sourcePath });
  const movedPath = path.join(mockUploadRoot, 'moved.bgoon');
  await fs.rename(sourcePath, movedPath);
  await fs.symlink(movedPath, sourcePath);
  expect((await inspectPackage(filename)).status).toBe(400);
  expect(await fs.readFile(movedPath)).toEqual(Buffer.from('PK\x03\x04inspect-negative'));
});

test('inspection holds deletion and restore exclusion through extraction and cleanup', async () => {
  const upload = await uploadArchive('inspect-race');
  const filename = upload.body.files.package.filename;
  const original = recipeArchiveService.inspectAndExtractRecipeArchive.getMockImplementation();
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  recipeArchiveService.inspectAndExtractRecipeArchive.mockImplementation(async (input) => {
    const result = await original(input);
    if (input.archiveHandle) { entered(); await hold; }
    return result;
  });
  const inspecting = inspectPackage(filename);
  await reached;
  let reserved = false;
  const reservation = reserveAsset('goon_custom_packages', filename).then(result => { reserved = true; return result; });
  const restoreToken = crypto.randomUUID();
  const restore = maintenance('begin', restoreToken);
  await new Promise(resolve => setImmediate(resolve));
  expect(reserved).toBe(false);
  release();
  expect((await inspecting).status).toBe(200);
  const reservedResult = await reservation;
  const restoreResult = await restore;
  expect([200, 409]).toContain(reservedResult.status);
  expect(restoreResult.status).toBe(200);
  expect((await fs.readdir(path.join(mockUploadRoot, '_tmp'))).filter(name => name.startsWith('recipe-inspect-'))).toEqual([]);
  expect((await maintenance('end', restoreToken)).status).toBe(200);
});

test('a disconnected inspection still holds restore until its temporary files settle', async () => {
  const upload = await uploadArchive('inspect-disconnect');
  const filename = upload.body.files.package.filename;
  const original = recipeArchiveService.inspectAndExtractRecipeArchive.getMockImplementation();
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  recipeArchiveService.inspectAndExtractRecipeArchive.mockImplementation(async (input) => {
    const result = await original(input);
    if (input.archiveHandle) { entered(); await hold; }
    return result;
  });
  const controller = new AbortController();
  const request = fetch(`${baseUrl}/api/upload/goon-custom-package/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename }), signal: controller.signal
  }).catch(error => error);
  await reached;
  controller.abort();
  await request;
  const token = crypto.randomUUID();
  let restored = false;
  const restore = maintenance('begin', token).then(result => { restored = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  expect(restored).toBe(false);
  release();
  expect((await restore).status).toBe(200);
  expect((await fs.readdir(path.join(mockUploadRoot, '_tmp'))).filter(name => name.startsWith('recipe-inspect-'))).toEqual([]);
  expect((await maintenance('end', token)).status).toBe(200);
});

test('inspection does not report success when its owned temporary directory cannot be removed', async () => {
  const upload = await uploadArchive('inspect-cleanup-failure');
  const realRm = fs.rm.bind(fs);
  jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
    if (path.basename(target).startsWith('recipe-inspect-')) throw new Error('injected cleanup failure');
    return realRm(target, options);
  });
  expect((await inspectPackage(upload.body.files.package.filename)).status).toBe(500);
  expect((await fs.readdir(path.join(mockUploadRoot, '_tmp'))).some(name => name.startsWith('recipe-inspect-'))).toBe(true);
});

test('a failed archive cleans up before a different archive may publish shared model and manifest bytes', async () => {
  failManifest = true;
  const firstReachedManifest = new Promise((resolve) => { manifestWriteEntered = resolve; });
  const first = uploadArchive('first');
  await firstReachedManifest;

  const second = uploadArchive('second');
  await waitFor(() => extractionCount === 2);
  expect(redisService.get.mock.calls.some(([key]) => key.includes(sha256(Buffer.from('PK\x03\x04second'))))).toBe(false);

  releaseManifestWrite();
  expect((await first).status).toBe(500);
  const saved = await second;
  expect(saved.status).toBe(200);
  expect(records.has(modelKey)).toBe(true);
  expect(records.has(manifestKey)).toBe(true);
  expect(await fs.readFile(path.join(mockUploadRoot, 'goon_custom_models', `${modelHash}.glb`))).toEqual(modelBytes);
  expect(await fs.readFile(path.join(mockUploadRoot, 'goon_custom_manifests', `${manifestHash}.json`))).toEqual(manifestBytes);
  expect(records.has(`upload:goon_custom_packages:${sha256(Buffer.from('PK\x03\x04first'))}.bgoon`)).toBe(false);
});

test('different archives share immutable model and manifest records, and a same-byte retry reuses all assets', async () => {
  const first = await uploadArchive('one');
  const second = await uploadArchive('two');
  const retry = await uploadArchive('two');
  expect([first.status, second.status, retry.status]).toEqual([200, 200, 200]);
  expect(first.body.files.model.sha256).toBe(modelHash);
  expect(second.body.files.model.sha256).toBe(modelHash);
  expect(retry.body.files.package.sha256).toBe(second.body.files.package.sha256);
  expect(redisService.setWithTTL.mock.calls.filter(([key]) => key === modelKey)).toHaveLength(1);
  expect(redisService.setWithTTL.mock.calls.filter(([key]) => key === manifestKey)).toHaveLength(1);
  expect(records.size).toBe(4);
});

test('a custom package upload recreates its temporary directory after an uploads restore', async () => {
  await fs.rm(path.join(mockUploadRoot, '_tmp'), { recursive: true, force: true });
  const result = await uploadArchive('after-restore');
  expect(result.status).toBe(200);
  expect(records.has(modelKey)).toBe(true);
});

test('reservation fences publication and a stale deletion token cannot unlink republished bytes', async () => {
  expect((await uploadArchive('one')).status).toBe(200);
  const filename = `${modelHash}.glb`;
  const reservation = await reserveAsset('goon_custom_models', filename);
  expect(reservation.status).toBe(200);
  expect(reservation.body.state).toBe('created');
  expect(reservation.body.reservation.phase).toBe('reserved');
  expect((await reserveAsset('goon_custom_models', filename)).body.reservation)
    .toEqual(reservation.body.reservation);
  expect((await uploadArchive('two')).status).toBe(409);

  const token = reservation.body.reservation.token;
  expect((await deleteAsset('goon_custom_models', filename, token)).status).toBe(200);
  expect(records.has(modelKey)).toBe(false);
  await expect(fs.stat(path.join(mockUploadRoot, 'goon_custom_models', filename)))
    .rejects.toMatchObject({ code: 'ENOENT' });
  expect((await uploadArchive('two')).status).toBe(200);
  expect((await deleteAsset('goon_custom_models', filename, token)).status).toBe(409);
  expect(await fs.readFile(path.join(mockUploadRoot, 'goon_custom_models', filename))).toEqual(modelBytes);
});

test('an interrupted custom deletion retains its marker and resumes from upload metadata', async () => {
  expect((await uploadArchive('one')).status).toBe(200);
  const filename = `${modelHash}.glb`;
  const reservation = await reserveAsset('goon_custom_models', filename);
  const token = reservation.body.reservation.token;
  redisService.client.del.mockImplementationOnce(async () => { throw new Error('injected Redis delete failure'); });
  expect((await deleteAsset('goon_custom_models', filename, token)).status).toBe(500);
  expect(JSON.parse(markers.get(`goon_asset_delete:goon_custom_models:${filename}`)).phase).toBe('deleting');
  expect(records.has(modelKey)).toBe(true);
  await expect(fs.stat(path.join(mockUploadRoot, 'goon_custom_models', filename)))
    .rejects.toMatchObject({ code: 'ENOENT' });

  expect((await deleteAsset('goon_custom_models', filename, token)).status).toBe(200);
  expect(records.has(modelKey)).toBe(false);
  expect(markers.has(`goon_asset_delete:goon_custom_models:${filename}`)).toBe(false);
});

test('reservation waits for an active custom publication and recovers its settled marker', async () => {
  failManifest = true;
  const firstReachedManifest = new Promise((resolve) => { manifestWriteEntered = resolve; });
  const upload = uploadArchive('first');
  await firstReachedManifest;
  const filename = `${modelHash}.glb`;
  expect(JSON.parse(markers.get(`goon_asset_delete:goon_custom_models:${filename}`)).phase)
    .toBe('publishing');

  const reservation = reserveAsset('goon_custom_models', filename);
  let settled = false;
  reservation.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  releaseManifestWrite();
  expect((await upload).status).toBe(500);
  expect((await reservation).body.reservation.phase).toBe('reserved');
});

test('restore begin drains multipart publication lifetime and fences later custom operations', async () => {
  failManifest = true;
  const firstReachedManifest = new Promise((resolve) => { manifestWriteEntered = resolve; });
  const upload = uploadArchive('restore-running');
  await firstReachedManifest;
  const token = crypto.randomUUID();
  const beginning = maintenance('begin', token);
  await waitFor(() => markers.has('goon_asset_restore'));
  let settled = false;
  beginning.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  expect((await uploadArchive('blocked-by-restore')).status).toBe(409);
  expect((await reserveAsset('goon_custom_models', `${modelHash}.glb`)).status).toBe(409);
  releaseManifestWrite();
  expect((await upload).status).toBe(500);
  expect((await beginning).body).toEqual({
    success: true, token, state: 'created', activeOperations: 0
  });
  expect((await deleteAsset('goon_custom_models', `${modelHash}.glb`, crypto.randomUUID())).status)
    .toBe(409);
  expect((await maintenance('end', crypto.randomUUID())).status).toBe(409);
  expect((await maintenance('end', token)).body).toEqual({ success: true, token, state: 'released' });
  expect((await maintenance('begin', token)).status).toBe(409);
  expect((await uploadArchive('after-restore')).status).toBe(200);
});

test('failed rollback keeps a recoverable marker until the orphan is deleted', async () => {
  failManifest = true;
  const firstReachedManifest = new Promise((resolve) => { manifestWriteEntered = resolve; });
  const upload = uploadArchive('failed-rollback');
  await firstReachedManifest;
  let failedModelDelete = false;
  redisService.client.del.mockImplementation(async (key) => {
    if (key === modelKey && !failedModelDelete) {
      failedModelDelete = true;
      throw new Error('injected rollback failure');
    }
    return records.delete(key) ? 1 : 0;
  });
  releaseManifestWrite();
  expect((await upload).status).toBe(500);

  const filename = `${modelHash}.glb`;
  const key = `goon_asset_delete:goon_custom_models:${filename}`;
  expect(JSON.parse(markers.get(key)).phase).toBe('publishing');
  expect(records.has(modelKey)).toBe(true);
  const reservation = await reserveAsset('goon_custom_models', filename);
  expect(reservation.body.state).toBe('recovered');
  expect(reservation.body.reservation.phase).toBe('reserved');
  expect((await deleteAsset('goon_custom_models', filename, reservation.body.reservation.token)).status)
    .toBe(200);
  expect(records.has(modelKey)).toBe(false);
  expect(markers.has(key)).toBe(false);
});

test('a crashed publication with file but no metadata removes only its canonical hash path', async () => {
  expect((await uploadArchive('one')).status).toBe(200);
  const filename = `${modelHash}.glb`;
  records.delete(modelKey);
  markers.set(`goon_asset_delete:goon_custom_models:${filename}`, JSON.stringify({
    contract: 'goon-asset-deletion/v1', token: crypto.randomUUID(), phase: 'publishing'
  }));
  const reservation = await reserveAsset('goon_custom_models', filename);
  expect(reservation.body.state).toBe('recovered');
  expect((await deleteAsset('goon_custom_models', filename, reservation.body.reservation.token)).status)
    .toBe(200);
  await expect(fs.stat(path.join(mockUploadRoot, 'goon_custom_models', filename)))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

test('deletion follows a restored upload record path rather than its canonical hash path', async () => {
  expect((await uploadArchive('one')).status).toBe(200);
  const filename = `${modelHash}.glb`;
  const original = path.join(mockUploadRoot, 'goon_custom_models', filename);
  const restored = path.join(mockUploadRoot, 'restored', filename);
  await fs.mkdir(path.dirname(restored), { recursive: true });
  await fs.rename(original, restored);
  records.set(modelKey, {
    ...records.get(modelKey), relativePath: path.join('restored', filename), filePath: restored
  });
  const reservation = await reserveAsset('goon_custom_models', filename);
  expect((await deleteAsset('goon_custom_models', filename, reservation.body.reservation.token)).status)
    .toBe(200);
  await expect(fs.stat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(records.has(modelKey)).toBe(false);
});

test('an unrecorded nonhash custom filename keeps its deletion marker for inspection', async () => {
  const filename = 'legacy.glb';
  const reservation = await reserveAsset('goon_custom_models', filename);
  expect(reservation.status).toBe(200);
  const deleted = await deleteAsset('goon_custom_models', filename, reservation.body.reservation.token);
  expect(deleted.status).toBe(500);
  expect(JSON.parse(markers.get(`goon_asset_delete:goon_custom_models:${filename}`)).phase)
    .toBe('deleting');
});

test('a recorded custom asset without a verified path keeps metadata and its deletion marker', async () => {
  expect((await uploadArchive('one')).status).toBe(200);
  const filename = `${modelHash}.glb`;
  const payload = records.get(modelKey);
  records.set(modelKey, { ...payload, relativePath: undefined, filePath: undefined });
  const reservation = await reserveAsset('goon_custom_models', filename);
  const deleted = await deleteAsset('goon_custom_models', filename, reservation.body.reservation.token);
  expect(deleted.status).toBe(500);
  expect(records.has(modelKey)).toBe(true);
  expect(JSON.parse(markers.get(`goon_asset_delete:goon_custom_models:${filename}`)).phase)
    .toBe('deleting');
  expect(await fs.readFile(path.join(mockUploadRoot, 'goon_custom_models', filename)))
    .toEqual(modelBytes);
});

test('failed metadata publication retains an orphan claim when both file cleanups fail', async () => {
  failManifest = true;
  const firstReachedManifest = new Promise((resolve) => { manifestWriteEntered = resolve; });
  const upload = uploadArchive('failed-manifest-cleanup');
  await firstReachedManifest;
  const filename = `${manifestHash}.json`;
  const manifestPath = path.join(mockUploadRoot, 'goon_custom_manifests', filename);
  const realRm = fs.rm.bind(fs);
  const realUnlink = fs.unlink.bind(fs);
  let injectedFailures = 2;
  jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
    if (target === manifestPath && injectedFailures-- > 0) {
      throw new Error('injected file removal failure');
    }
    return realRm(target, options);
  });
  jest.spyOn(fs, 'unlink').mockImplementation(async (target) => {
    if (target === manifestPath && injectedFailures-- > 0) {
      throw new Error('injected file removal failure');
    }
    return realUnlink(target);
  });
  releaseManifestWrite();
  expect((await upload).status).toBe(500);
  expect(records.has(manifestKey)).toBe(false);
  expect(await fs.readFile(manifestPath)).toEqual(manifestBytes);
  const marker = `goon_asset_delete:goon_custom_manifests:${filename}`;
  expect(JSON.parse(markers.get(marker)).phase).toBe('publishing');
  jest.restoreAllMocks();
  const reservation = await reserveAsset('goon_custom_manifests', filename);
  expect(reservation.body.state).toBe('recovered');
  expect((await deleteAsset('goon_custom_manifests', filename, reservation.body.reservation.token)).status)
    .toBe(200);
  await expect(fs.stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(markers.has(marker)).toBe(false);
});
