const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Module } = require('node:module');
const { buildSync } = require('esbuild');
const classifierSource = path.resolve(__dirname, '../../../../../batshit-app/src/lib/server/services/backupHairSnapshot.ts');
const compiled = buildSync({ entryPoints: [classifierSource], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const classifier = new Module(classifierSource); classifier._compile(compiled, classifierSource);
const { stagedHairUploadKeys } = classifier.exports;

const mockUploadRoot = path.join(os.tmpdir(), `batshit-hair-upload-${process.pid}-${Date.now()}`);
jest.mock('../../config', () => ({ uploadsDir: mockUploadRoot }));
jest.mock('../../utils/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/redisService', () => ({ client: null, isConnected: jest.fn(() => true), setWithTTL: jest.fn() }));
const mockQueues = [];
let mockPublicationArrival = null;
jest.mock('../../services/serialTransactionQueue', () => {
  const actual = jest.requireActual('../../services/serialTransactionQueue');
  return { createSerialTransactionQueue: (...args) => {
    const queue = actual.createSerialTransactionQueue(...args);
    const observed = { arrivals: 0, starts: [], run(task) {
      const index = observed.arrivals++;
      const pending = queue.run(() => { observed.starts.push(index); return task(); });
      // Resolve AFTER the real queue has admitted/scheduled this exact task.
      if (observed === mockQueues[0]) mockPublicationArrival?.(index);
      return pending;
    }, get isIdle() { return queue.isIdle; } };
    mockQueues.push(observed); return observed;
  } };
});
const redisService = require('../../services/redisService');
const routes = require('../upload-redis');
let server, baseUrl, store, markers;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api', routes);
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  expect(server.address().address).toBe('127.0.0.1');
  expect(server.address().port).toBeGreaterThan(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (process.env.HAIR_FILE_EVIDENCE) await fs.writeFile(path.join(process.env.HAIR_FILE_EVIDENCE, 'listener-admission.json'), JSON.stringify({ address: server.address(), pid: process.pid, uploadRoot: mockUploadRoot })+'\n', { flag: 'wx' });
});
afterAll(async () => {
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  expect(server.listening).toBe(false);
  if (process.env.HAIR_FILE_EVIDENCE) await fs.writeFile(path.join(process.env.HAIR_FILE_EVIDENCE, 'listener-cleanup.json'), JSON.stringify({ address, listening: server.listening, pid: process.pid })+'\n', { flag: 'wx' });
  await fs.rm(mockUploadRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  store = new Map(); markers = new Map();
  redisService.client = { isOpen: true, type: jest.fn(async (key) => store.has(key) ? 'ReJSON-RL' : 'none'),
    get: jest.fn(async (key) => markers.get(key) ?? null),
    keys: jest.fn(async (pattern) => [...store.keys()].filter((key) => key.startsWith(pattern.slice(0, -1)))),
    sendCommand: jest.fn(async ([command, key]) => { if (command !== 'JSON.GET') throw new Error('Unexpected test command'); return store.has(key) ? JSON.stringify(store.get(key)) : null; }),
    del: jest.fn(async (key) => store.delete(key) ? 1 : 0),
    json: { set: jest.fn(async (key, _path, value) => { store.set(key, structuredClone(value)); return 'OK'; }),
      get: jest.fn(async (key) => store.get(key) ?? null) }, expire: jest.fn(async () => 1),
    eval: jest.fn(async (script, { keys, arguments: args }) => {
      if (script.includes('-- CLAIM_PUBLICATION')) {
        for (const key of keys) {
          const marker = markers.has(key) ? JSON.parse(markers.get(key)) : null;
          if (marker && marker.phase !== 'publishing') return 'BLOCKED';
        }
        keys.forEach((key) => markers.set(key, args[1])); return 'CLAIMED';
      }
      if (script.includes('-- RELEASE_PUBLICATION')) {
        for (const key of keys) {
          const marker = markers.has(key) ? JSON.parse(markers.get(key)) : null;
          if (!marker || marker.token !== args[1] || marker.phase !== 'publishing') return 'CHANGED_MARKER';
        }
        keys.forEach((key) => markers.delete(key)); return 'RELEASED';
      }
      throw new Error('Unexpected Lua in finite upload fake');
    }) };
  redisService.setWithTTL.mockImplementation(async (key, payload) => { store.set(key, structuredClone(payload)); return true; });
  redisService.connected = true; redisService.useRedis = true;
  await fs.rm(path.join(mockUploadRoot, 'goon_hair_assets'), { recursive: true, force: true });
});
afterEach(() => { redisService.client = null; redisService.connected = false; });

async function upload(owner, version = 2) {
  const form = new FormData();
  form.set('assetId', 'imported-hair-job'); form.set('revisionId', 'imported-hair-job-r1'); form.set('role', 'import-receipt');
  form.set('file', new Blob(['{"geometry":"unchanged"}\n'], { type: 'application/json' }), 'receipt.json');
  if (owner !== undefined) { form.set('hairImportOwner', typeof owner === 'string' ? owner : JSON.stringify(owner)); form.set('hairImportStateVersion', String(version)); }
  const response = await fetch(`${baseUrl}/api/upload/goon-hair-asset`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

function job(status = 'preparing', stateVersion = 2) {
  const source = { uploadType: 'goon_hair_imports', filename: 'fixture.obj', ref: '/uploads/goon_hair_imports/fixture.obj',
    sha256: 'a'.repeat(64), bytes: 20, mimeType: 'text/plain' };
  return { contract: 'hair-import-job/v4', userId: 'user', jobId: 'job', goonId: 'goon', target: { kind: 'new' },
    status, stateVersion, source, cleanupFiles: [source], candidate: null, startingTransform: {}, initialTransform: {}, calibration: null,
    expiresAt: new Date(Date.now()+60000).toISOString() };
}
function snapshot() {
  return new Map([...store].map(([key, value]) => [key, { key, type: 'json', value, ttlSeconds: null }]));
}
const owner = { contract: 'hair-import-upload/v1', userId: 'user', jobId: 'job' };

async function bounded(promise, label, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Owned handler ${label} did not arrive within ${timeout}ms`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

it('stores the creation receipt with the original artifact metadata/file and unchanged identity', async () => {
  store.set('hair_import_job:user:job', job());
  const result = await upload(owner);
  expect(result.status).toBe(200);
  const filename = result.body.file.filename;
  const stored = store.get(`upload:goon_hair_assets:${filename}`);
  const bytes = await fs.readFile(path.join(mockUploadRoot, 'goon_hair_assets', filename));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  expect(filename).toBe(`imported-hair-job_imported-hair-job-r1_import-receipt_${sha256}.json`);
  expect(stored.hairImportUpload).toEqual({ ...owner, ...stored.hairAssetArtifact, filename, bytes: bytes.length });
  expect(stored.sha256).toBe(sha256);
  expect(stored.filename).toBe(filename);
  // Producer/consumer proof uses the actual handler's persisted top-level value.
  expect([...stagedHairUploadKeys(snapshot())]).toEqual([`upload:goon_hair_assets:${filename}`]);
  store.set('hair_asset:user:imported-hair-job:imported-hair-job-r1', { retained: { ref: `/uploads/goon_hair_assets/${filename}` } });
  expect([...stagedHairUploadKeys(snapshot())]).toEqual([]);
  expect(bytes.toString()).toBe('{"geometry":"unchanged"}\n');
});
it('retains callers without an importer receipt as ordinary canonical upload records', async () => {
  expect((await upload()).status).toBe(200);
  expect([...store.values()][0].hairImportUpload).toBeUndefined();
  expect([...stagedHairUploadKeys(snapshot())]).toEqual([]);
});
// Moved from apiSurfaceAuth.test.js (BL-1493): this route runs the Redis maintenance fence before
// Multer, so the owner-ID refusal is proved here, with the Redis fake, not on the Redis-less boot.
it('rejects a Hair artifact without exact immutable-owner IDs before storage', async () => {
  const form = new FormData();
  form.set('role', 'material-definition');
  form.set('file', new Blob(['{}'], { type: 'application/json' }), 'material.json');
  const response = await fetch(`${baseUrl}/api/upload/goon-hair-asset`, { method: 'POST', body: form });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('assetId must be') }));
  expect(store.size).toBe(0);
  expect(markers.size).toBe(0);
  expect(redisService.client.eval).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(mockUploadRoot, 'goon_hair_assets'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([
  '{bad json', { contract: 'older', userId: 'user', jobId: 'job' },
  { contract: 'hair-import-upload/v1', userId: '../user', jobId: 'job' },
  { contract: 'hair-import-upload/v1', userId: 'user', jobId: '' },
  { contract: 'hair-import-upload/v1', userId: 'user', jobId: 'job', extra: 'foreign' }
])('refuses malformed importer authority before file/record publication: %p', async (owner) => {
  expect((await upload(owner)).status).toBe(400);
  expect(store.size).toBe(0);
  await expect(fs.stat(path.join(mockUploadRoot, 'goon_hair_assets'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('records the actual raw source filename so its validated staging receipt reaches the classifier', async () => {
  const form = new FormData(); form.set('file', new Blob(['o hair\nv 0 0 0\n'], { type: 'text/plain' }), 'hair.obj');
  const response = await fetch(`${baseUrl}/api/upload/goon-hair-import-source`, { method: 'POST', body: form });
  expect(response.status).toBe(200); const { file } = await response.json();
  const key = `upload:goon_hair_imports:${file.filename}`;
  expect(store.get(key).filename).toBe(file.filename);
  expect([...stagedHairUploadKeys(snapshot())]).toEqual([key]);
  store.set('hair_refit_source:user:retained:r1', { source: { ref: `/uploads/goon_hair_imports/${file.filename}` } });
  expect([...stagedHairUploadKeys(snapshot())]).toEqual([]);
});

it('refuses an old source generation before file IO and preserves existing stored values', async () => {
  store.set('hair_import_job:user:job', job('preparing', 3));
  expect((await upload(owner, 2)).status).toBe(409);
  expect([...store.keys()]).toEqual(['hair_import_job:user:job']);
  expect(markers.size).toBe(0);
  await expect(fs.stat(path.join(mockUploadRoot, 'goon_hair_assets'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('waits for an admitted upload before retired-job discovery and rejects later stale publication', async () => {
  store.set('hair_import_job:user:job', job());
  let entered, release;
  const admission = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  redisService.setWithTTL.mockImplementationOnce(async (key, payload) => {
    entered(); await held; store.set(key, structuredClone(payload)); return true;
  });
  const publication = upload(owner);
  publication.catch(() => {}); // Preserve rejection for await without an unhandled latch-time rejection.
  let discovery;
  try {
    await bounded(admission, 'upload admission');
    store.set('hair_import_job:user:job', job('cancelled', 3));
    let finished = false;
    const discoveryIndex = mockQueues[0].arrivals;
    let arrival;
    const arrived = new Promise((resolve) => { arrival = resolve; });
    mockPublicationArrival = (index) => { if (index === discoveryIndex) arrival(); };
    discovery = fetch(`${baseUrl}/api/upload/asset-deletion/discover-hair-import`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cleanupContext: { jobKey: 'hair_import_job:user:job', stateVersion: 3, mode: 'retired', files: [] } })
    }).then(async (response) => { finished = true; return { status: response.status, body: await response.json() }; });
    discovery.catch(() => {});
    // A real queue ingress latch proves this HTTP request reached admission.
    await bounded(arrived, 'discovery queue ingress');
    const startedWhileHeld = mockQueues[0].starts.includes(discoveryIndex);
    const finishedWhileHeld = finished;
    release();
    const result = await bounded(publication, 'released upload'); expect(result.status).toBe(200);
    const found = await bounded(discovery, 'released discovery'); expect(startedWhileHeld).toBe(false); expect(finishedWhileHeld).toBe(false); expect(found.status).toBe(200);
    expect(found.body.files).toEqual([{ uploadType: 'goon_hair_assets', filename: result.body.file.filename,
      ref: `/uploads/goon_hair_assets/${result.body.file.filename}`, sha256: result.body.file.sha256,
      bytes: result.body.file.size, mimeType: 'application/json' }]);
    expect((await upload(owner)).status).toBe(409);
    expect(mockQueues[0].isIdle).toBe(true);
    expect(markers.size).toBe(0);
  } finally {
    mockPublicationArrival = null;
    release();
    await bounded(Promise.allSettled([publication, ...(discovery ? [discovery] : [])]), 'fixture settlement', 10000);
  }
}, 20000);

async function cleanupFixture() {
  store.set('hair_import_job:user:job', job());
  const uploaded = await upload(owner);
  expect(uploaded.status).toBe(200);
  const file = { uploadType: 'goon_hair_assets', filename: uploaded.body.file.filename,
    ref: `/uploads/goon_hair_assets/${uploaded.body.file.filename}`, sha256: uploaded.body.file.sha256,
    bytes: uploaded.body.file.size, mimeType: 'application/json' };
  const retired = { ...job('cancelled', 3), cleanupFiles: [file] };
  store.set('hair_import_job:user:job', retired);
  const token = '00000000-0000-4000-8000-000000000001';
  const markerKey = `goon_asset_delete:goon_hair_assets:${file.filename}`;
  markers.set(markerKey, JSON.stringify({ contract: 'goon-asset-deletion/v1', token, phase: 'reserved' }));
  return { file, retired, token, markerKey };
}

it.each(['known-refusal', 'unknown-response'])('distinguishes %s at BEGIN without unlinking Hair bytes', async (mode) => {
  const { file, token, markerKey } = await cleanupFixture();
  redisService.client.eval.mockImplementationOnce(async (script) => {
    expect(script).toContain('-- BEGIN_DELETION');
    if (mode === 'unknown-response') throw new Error('Redis response was lost');
    // An actual Lua CHANGED_JOB return is a definitive pre-mutation refusal.
    store.get('hair_import_job:user:job').stateVersion = 4;
    return 'CHANGED_JOB';
  });
  const response = await fetch(`${baseUrl}/api/upload/asset`, { method: 'DELETE',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...file, deletionToken: token,
      cleanupContext: { jobKey: 'hair_import_job:user:job', stateVersion: 3, mode: 'retired', files: [file] } }) });
  expect(response.status).toBe(mode === 'known-refusal' ? 409 : 500);
  expect((await response.json()).deletionNotStarted).toBe(mode === 'known-refusal');
  expect(JSON.parse(markers.get(markerKey)).phase).toBe('reserved');
  expect(store.has(`upload:goon_hair_assets:${file.filename}`)).toBe(true);
  expect(crypto.createHash('sha256').update(await fs.readFile(path.join(mockUploadRoot, 'goon_hair_assets', file.filename))).digest('hex')).toBe(file.sha256);
});

it('materializes an exact legacy raw digest for atomic BEGIN and refuses a changed digest before it', async () => {
  const { file, retired, token } = await cleanupFixture();
  const raw = JSON.stringify(retired);
  const request = async (expectedRawSha256) => fetch(`${baseUrl}/api/upload/asset`, { method: 'DELETE',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...file, deletionToken: token,
      cleanupContext: { jobKey: 'hair_import_job:user:job', expectedRawSha256, mode: 'retired', files: [file] } }) });
  const mismatch = await request('f'.repeat(64));
  expect(mismatch.status).toBe(409);
  expect((await mismatch.json()).deletionNotStarted).toBe(true);
  expect(redisService.client.eval).not.toHaveBeenCalledWith(expect.stringContaining('-- BEGIN_DELETION'), expect.anything());
  redisService.client.eval.mockImplementationOnce(async (script, { arguments: args }) => {
    expect(script).toContain('-- BEGIN_DELETION');
    expect(JSON.parse(args[2])).toEqual({ jobKey: 'hair_import_job:user:job', expectedRaw: raw, mode: 'retired', files: [file] });
    return 'CHANGED_JOB';
  });
  const matching = await request(crypto.createHash('sha256').update(raw).digest('hex'));
  expect(matching.status).toBe(409);
  expect((await matching.json()).deletionNotStarted).toBe(true);
  expect(store.get(`upload:goon_hair_assets:${file.filename}`).filename).toBe(file.filename);
  expect(await fs.readFile(path.join(mockUploadRoot, 'goon_hair_assets', file.filename), 'utf8')).toBe('{"geometry":"unchanged"}\n');
});
