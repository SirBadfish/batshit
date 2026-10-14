const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const sharp = require('sharp');

// BL-1155: exercise the real multipart routes, Sharp, local storage and Redis
// service. Only the Redis client is in-memory; this proves MIME propagation,
// not real Redis durability, authentication, browser rendering or inference.
// The router creates uploadsDir/_tmp at import, so bind a disposable root first.
const mockUploadRoot = path.join(os.tmpdir(), `batshit-clip-mime-${process.pid}-${Date.now()}`);
jest.mock('../../config', () => ({ uploadsDir: mockUploadRoot }));
jest.mock('../../utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn()
}));

const redisService = require('../../services/redisService');
const uploadRoutes = require('../upload-redis');
const serveUploads = require('../serve-uploads');
const userId = 'sa125-mime-fixture';

function createFakeClient() {
  const records = new Map();
  const sets = new Map();
  return {
    records,
    sets,
    isOpen: true,
    exists: jest.fn(async (key) => records.has(key) ? 1 : 0),
    type: jest.fn(async (key) => records.has(key) ? 'ReJSON-RL' : 'none'),
    json: {
      get: jest.fn(async (key) => records.has(key) ? structuredClone(records.get(key)) : null),
      set: jest.fn(async (key, jsonPath, value) => {
        if (jsonPath !== '$') throw new Error('Fixture accepts whole-record writes only.');
        records.set(key, structuredClone(value));
        return 'OK';
      })
    },
    sAdd: jest.fn(async (key, value) => {
      const values = sets.get(key) || new Set();
      const added = values.has(value) ? 0 : 1;
      values.add(value);
      sets.set(key, values);
      return added;
    }),
    expire: jest.fn(async () => 1)
  };
}

let server;
let baseUrl;
let client;
let images;

beforeAll(async () => {
  const image = () => sharp({
    create: { width: 16, height: 12, channels: 4, background: { r: 180, g: 40, b: 90, alpha: 0.5 } }
  });
  images = {
    png: await image().png().toBuffer(),
    jpeg: await image().flatten({ background: '#ffffff' }).jpeg().toBuffer(),
    webp: await image().webp().toBuffer(),
    gif: await image().gif().toBuffer()
  };
  const app = express();
  app.use('/api', uploadRoutes);
  app.use('/uploads', serveUploads);
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  client = createFakeClient();
  redisService.client = client;
  redisService.connected = true;
  redisService.useRedis = true;
});

afterEach(async () => {
  redisService.client = null;
  redisService.connected = false;
  redisService.useRedis = false;
  await fs.rm(path.join(mockUploadRoot, 'images'), { recursive: true, force: true });
});

afterAll(async () => {
  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    }
  } finally {
    await fs.rm(mockUploadRoot, { recursive: true, force: true });
  }
});

async function uploadImage(endpoint, format, compressionSettings, uploadSettings) {
  const mimeType = `image/${format}`;
  const filename = `picked.${format === 'jpeg' ? 'jpg' : format}`;
  const form = new FormData();
  form.append('userId', userId);
  form.append(endpoint === '/upload' ? 'files' : 'file', new Blob([images[format]], { type: mimeType }), filename);
  if (compressionSettings !== undefined) form.append('compressionSettings', JSON.stringify(compressionSettings));
  if (uploadSettings !== undefined) form.append('uploadSettings', JSON.stringify(uploadSettings));
  const response = await fetch(`${baseUrl}/api${endpoint}`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(10000)
  });
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  return endpoint === '/upload' ? body.files[0] : body.file;
}

function expectMimeAndBytes(file, upload, bytes, expectedFormat) {
  const expectedMime = `image/${expectedFormat}`;
  expect(file.mimetype).toBe(expectedMime);
  expect(upload.mimetype).toBe(expectedMime);
  expect(file.size).toBe(bytes.length);
  expect(upload.size).toBe(bytes.length);
  expect(file.base64).toBeNull();
  expect(file.processedForAI).toBeNull();
}

describe.each(['/upload', '/upload/single'])('%s actual image MIME (BL-1155)', (endpoint) => {
  test.each([
    ['default PNG to JPEG', 'png', undefined, 'jpeg', false],
    ['PNG optimization with force JPEG off', 'png', { force_jpeg: false }, 'png', false],
    ['compression disabled', 'png', { compress_images: false }, 'png', true],
    ['untouched small JPEG', 'jpeg', undefined, 'jpeg', true],
    ['untouched small WebP', 'webp', undefined, 'webp', true],
    ['untouched small GIF', 'gif', undefined, 'gif', true],
    ['resized WebP to JPEG', 'webp', { max_image_size: '8' }, 'jpeg', false],
    ['resized JPEG', 'jpeg', { max_image_size: '8' }, 'jpeg', false]
  ])('%s agrees across bytes, upload metadata, response and Clip', async (_label, format, settings, outputFormat, unchanged) => {
    const file = await uploadImage(endpoint, format, settings);
    const upload = await redisService.get(file.redisKey);
    expect(upload.storage).toBe('filesystem');
    expect(upload.filePath.startsWith(`${mockUploadRoot}${path.sep}`)).toBe(true);
    const bytes = await fs.readFile(upload.filePath);
    const decoded = await sharp(bytes).metadata();
    expect(decoded.format).toBe(outputFormat);
    expectMimeAndBytes(file, upload, bytes, outputFormat);
    expect(upload.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(upload).not.toHaveProperty('base64');
    if (unchanged) expect(bytes.equals(images[format])).toBe(true);
    if (settings?.max_image_size) expect(decoded.width).toBe(8);

    for (const method of ['GET', 'HEAD']) {
      const served = await fetch(`${baseUrl}${file.tunnelPath}`, {
        method, signal: AbortSignal.timeout(10000)
      });
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe(`image/${outputFormat}`);
      expect(served.headers.get('x-content-type-options')).toBe('nosniff');
      expect(served.headers.get('content-length')).toBe(String(bytes.length));
      const servedBytes = Buffer.from(await served.arrayBuffer());
      expect(servedBytes.equals(method === 'GET' ? bytes : Buffer.alloc(0))).toBe(true);
    }

    const clip = await redisService.getClip(userId, file.clipId);
    expect(clip.mimeType).toBe(`image/${outputFormat}`);
    expect(clip.fileType).toBe('image');
    expect(clip.filename).toBe(file.originalName);
    expect(file.originalName).toBe(`picked.${format === 'jpeg' ? 'jpg' : format}`);
    expect(clip.fileSize).toBe(bytes.length);
    expect(clip.localBase64).toBeNull();
    expect(clip.externalTokens).toBe(765);
    expect(clip.localTokens).toBe(765);
    expect(clip.tunnelPath).toBe(file.tunnelPath);
    expect(client.sets.get(`user:${userId}:clips`)).toEqual(new Set([file.clipId]));
  });
});

test('ephemeral upload-only conversion carries JPEG MIME without creating a Clip', async () => {
  const file = await uploadImage('/upload/single', 'png', undefined, {
    artifact_ttl_seconds: 60,
    skip_clip_persistence: true,
    artifact_source: 'sa125-mime-fixture'
  });
  const upload = await redisService.get(file.redisKey);
  const bytes = Buffer.from(upload.base64, 'base64');
  expect((await sharp(bytes).metadata()).format).toBe('jpeg');
  expectMimeAndBytes(file, upload, bytes, 'jpeg');
  expect(file.clipPersistenceSkipped).toBe(true);
  expect(file.persistedAs).toBe('upload');
  expect(file.clipId).toBeUndefined();
  expect(client.expire).toHaveBeenCalledWith(file.redisKey, 60);
  expect([...client.records.keys()]).toEqual([file.redisKey]);
  expect(client.sets.size).toBe(0);
});
