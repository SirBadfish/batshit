const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

jest.mock('../../config', () => ({ uploadsDir: '' }));
jest.mock('../../services/redisService', () => ({ get: jest.fn() }));
jest.mock('../../utils/logger', () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../utils/httpSecurity', () => ({ getTrustedCorsOriginForRequest: () => 'http://localhost:5620' }));
const config = require('../../config');
const redis = require('../../services/redisService');
const uploads = require('../serve-uploads');

describe('file-backed video delivery', () => {
  let root, server, url;
  const bytes = Buffer.from('0123456789abcdef');
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-range-test-'));
    config.uploadsDir = root;
    await fs.mkdir(path.join(root, 'goon_scenes'));
    await fs.writeFile(path.join(root, 'goon_scenes/city.mp4'), bytes);
    redis.get.mockResolvedValue({
      relativePath: 'goon_scenes/city.mp4', mimetype: 'video/mp4',
      uploadedAt: '2026-09-06T00:00:00.000Z'
    });
    const app = express();
    app.use('/uploads', uploads);
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    url = `http://127.0.0.1:${server.address().port}/uploads/goon_scenes/city.mp4`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  test('serves exact byte ranges with media type and CORS', async () => {
    const response = await fetch(url, { headers: { Range: 'bytes=2-5' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/16');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5620');
    expect(await response.text()).toBe('2345');
  });
  test('serves suffix ranges and preserves full file downloads', async () => {
    const suffix = await fetch(url, { headers: { Range: 'bytes=-4' } });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe('cdef');
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  });
  test('rejects unsatisfiable ranges and supports metadata-only HEAD', async () => {
    const invalid = await fetch(url, { headers: { Range: 'bytes=20-30' } });
    expect(invalid.status).toBe(416);
    await invalid.arrayBuffer();
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('16');
    expect(await head.text()).toBe('');
  });
});
