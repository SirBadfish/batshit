const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');

// The upload router makes `<uploadsDir>/_tmp` when it loads, so the directory has to be a
// private temp folder before the first require.
const mockUploadRoot = path.join(os.tmpdir(), `batshit-avatar-upload-${process.pid}-${Date.now()}`);
jest.mock('../../config', () => ({ uploadsDir: mockUploadRoot }));
jest.mock('../../utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

// The REAL redisService (its `get` answers null on a Redis error, which is BL-144's cause),
// over a fake client with node-redis 5 shapes.
const redisService = require('../../services/redisService');
const uploadRoutes = require('../upload-redis');

/**
 * BL-143 (2026-09-25): the avatar upload names every picture after its owner, so it must
 * refuse an upload with no owner or an owner id outside the owner id rule. Before, a missing
 * `entityId` wrote an ownerless `avatar_<ts>.jpg` that no owner delete can ever find.
 *
 * Since BL-281 (2026-09-27) an upload deletes no picture at all (`oldAvatarUrl` is ignored):
 * every Settings panel tidies after its save instead. BL-288: an upload and a tidy of the
 * same owner take turns, and each picture's name is later than the owner's previous one.
 *
 * BL-144 (2026-09-25): an upload delete reads the record through a read that throws, so a
 * Redis error keeps both the record and the file. Before, `redisService.get` answered null,
 * the key was deleted, and the file stayed with nothing pointing at it.
 */
function createFakeClient(records = {}) {
  const store = new Map(Object.entries(records));
  const client = {
    store,
    isOpen: true,
    exists: jest.fn(async (key) => (store.has(key) ? 1 : 0)),
    type: jest.fn(async (key) => (store.has(key) ? 'ReJSON-RL' : 'none')),
    get: jest.fn(async (key) => (store.has(key) ? JSON.stringify(store.get(key)) : null)),
    json: {
      get: jest.fn(async (key) => (store.has(key) ? structuredClone(store.get(key)) : null)),
      set: jest.fn(async (key, _path, value) => {
        store.set(key, structuredClone(value));
        return 'OK';
      })
    },
    expire: jest.fn(async () => 1),
    del: jest.fn(async (key) => (store.delete(key) ? 1 : 0))
  };
  return client;
}

let server;
let baseUrl;
let png;

beforeAll(async () => {
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .png()
    .toBuffer();
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

let client;
beforeEach(async () => {
  client = createFakeClient();
  redisService.client = client;
  redisService.connected = true;
  redisService.useRedis = true;
  await fs.rm(path.join(mockUploadRoot, 'avatars'), { recursive: true, force: true });
  await fs.rm(path.join(mockUploadRoot, 'images'), { recursive: true, force: true });
});

afterEach(() => {
  redisService.client = null;
  redisService.connected = false;
});

async function uploadAvatar(fields) {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'picked.png');
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(name, value);
  }
  const response = await fetch(`${baseUrl}/api/upload/avatar`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

function avatarRecord(filename) {
  return {
    uploadType: 'avatars',
    storage: 'filesystem',
    relativePath: `avatars/${filename}`,
    filePath: path.join(mockUploadRoot, 'avatars', filename)
  };
}

async function seedAvatar(key, filename) {
  await fs.mkdir(path.join(mockUploadRoot, 'avatars'), { recursive: true });
  await fs.writeFile(path.join(mockUploadRoot, 'avatars', filename), 'jpg');
  client.store.set(key, avatarRecord(filename));
}

async function fileExists(relativePath) {
  try {
    await fs.access(path.join(mockUploadRoot, ...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
}

describe('POST /api/upload/avatar owner rule (BL-143)', () => {
  test('stores the picture under its owner’s name', async () => {
    const result = await uploadAvatar({ entityType: 'subagent', entityId: 'zb_sub' });

    expect(result.status).toBe(200);
    expect(result.body.filename).toMatch(/^subagent_zb_sub_[0-9]+\.jpg$/);
    expect([...client.store.keys()]).toEqual([`upload:avatars:subagent:${result.body.filename}`]);
    expect(await fileExists(`avatars/${result.body.filename}`)).toBe(true);
  });

  test.each([
    ['no owner at all', {}],
    ['no entityId', { entityType: 'agent' }],
    ['no entityType', { entityId: 'bob' }],
    ['an unknown owner type', { entityType: 'goon', entityId: 'bob' }],
    ['an empty entityId', { entityType: 'agent', entityId: '' }],
    ['a glob in the id', { entityType: 'agent', entityId: 'bob*' }],
    ['a dot in the id', { entityType: 'agent', entityId: 'a.b' }],
    ['a path in the id', { entityType: 'agent', entityId: '../bob' }],
    ['spaces around the id', { entityType: 'agent', entityId: ' bob ' }]
  ])('refuses %s and stores nothing', async (_label, fields) => {
    const result = await uploadAvatar(fields);

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/entityType|entityId/);
    expect(client.store.size).toBe(0);
    expect(await fileExists('avatars')).toBe(false);
  });
});

describe('POST /api/upload/avatar deletes no picture (BL-281)', () => {
  // The user and Group panels named the picture they replaced (`oldAvatarUrl`), and the upload
  // deleted it before the save: a save the form then refused kept pointing at a deleted
  // picture (BL-145's hazard). Every panel now tidies after its save instead, so an upload
  // stores one picture and deletes nothing, whatever the browser sends.
  test.each([
    ['the same owner’s old picture', 'group_new_group_1775792747492.jpg', 'upload:avatars:group:'],
    ['another owner of the same type', 'group_new_group_2_1775865948156.jpg', 'upload:avatars:group:'],
    ['another owner type with the same id', 'agent_new_group_1770000000000.jpg', 'upload:avatars:agent:'],
    ['the user’s picture', 'user_josh_1775362752696.jpg', 'upload:avatars:user:'],
    ['a legacy flat picture', 'avatar_1754000000000.jpg', 'upload:avatars:']
  ])('keeps %s, whatever the browser names', async (_label, filename, keyPrefix) => {
    await seedAvatar(`${keyPrefix}${filename}`, filename);

    const result = await uploadAvatar({
      entityType: 'group',
      entityId: 'new_group',
      oldAvatarUrl: `http://localhost:5600/uploads/avatars/${filename}`
    });

    expect(result.status).toBe(200);
    expect(client.store.has(`${keyPrefix}${filename}`)).toBe(true);
    expect(await fileExists(`avatars/${filename}`)).toBe(true);
    expect(client.del).not.toHaveBeenCalled();
  });
});

describe('an upload and a tidy of the same owner never cross (BL-288)', () => {
  function gatedScan() {
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    client.scanIterator = jest.fn(async function* ({ MATCH }) {
      await gate;
      const pattern = new RegExp(
        `^${MATCH.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`
      );
      yield [...client.store.keys()].filter((key) => pattern.test(key));
    });
    return open;
  }

  test('an upload that lands while a tidy runs waits for it, and is never deleted by it', async () => {
    const old = 'group_new_group_1000000000000.jpg';
    await seedAvatar(`upload:avatars:group:${old}`, old);
    const openScan = gatedScan();

    // The saved record shows no picture of the owner (a cleared picture): the tidy is running.
    const tidy = fetch(`${baseUrl}/api/upload/avatar`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tidy: true, entityType: 'group', entityId: 'new_group', keepFilenames: [] })
    });
    for (let tries = 0; client.scanIterator.mock.calls.length === 0 && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(client.scanIterator).toHaveBeenCalled();

    // A new picture is uploaded meanwhile (another tab, or ms timing).
    let uploadAnswered = false;
    const upload = uploadAvatar({ entityType: 'group', entityId: 'new_group' }).then((result) => {
      uploadAnswered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(uploadAnswered).toBe(false);

    openScan();
    const [tidyResponse, uploaded] = await Promise.all([tidy, upload]);
    const tidied = await tidyResponse.json();

    expect(tidyResponse.status).toBe(200);
    expect(tidied.deletedRecords).toEqual([`upload:avatars:group:${old}`]);
    expect(uploaded.status).toBe(200);
    expect(client.store.has(`upload:avatars:group:${uploaded.body.filename}`)).toBe(true);
    expect(await fileExists(`avatars/${uploaded.body.filename}`)).toBe(true);
  });

  test('two uploads of one owner in the same millisecond get two names, in order', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_780_000_000_000);
    try {
      const [first, second] = await Promise.all([
        uploadAvatar({ entityType: 'agent', entityId: 'zb_same_ms' }),
        uploadAvatar({ entityType: 'agent', entityId: 'zb_same_ms' })
      ]);
      const names = [first.body.filename, second.body.filename].sort();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(names[0]).not.toBe(names[1]);
      expect(names.map((name) => Number(/_([0-9]+)\.jpg$/.exec(name)[1]))).toEqual([
        1_780_000_000_000,
        1_780_000_000_001
      ]);
      for (const name of names) {
        expect(client.store.has(`upload:avatars:agent:${name}`)).toBe(true);
      }
    } finally {
      now.mockRestore();
    }
  });
});

describe('upload deletes read the record strictly (BL-144)', () => {
  test('a Redis error while reading keeps the record AND the file, and answers 500', async () => {
    await fs.mkdir(path.join(mockUploadRoot, 'images'), { recursive: true });
    await fs.writeFile(path.join(mockUploadRoot, 'images', 'picture.png'), 'png');
    client.store.set('upload:images:picture.png', {
      uploadType: 'images',
      storage: 'filesystem',
      relativePath: 'images/picture.png',
      filePath: path.join(mockUploadRoot, 'images', 'picture.png')
    });
    // One read fails (a dropped connection, a busy server): `redisService.get` used to turn
    // that into "no record", delete the key, and leave the file.
    client.type.mockRejectedValueOnce(new Error('Socket closed unexpectedly'));
    client.exists.mockRejectedValueOnce(new Error('Socket closed unexpectedly'));

    const response = await fetch(`${baseUrl}/api/upload/asset`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadType: 'images', filename: 'picture.png' })
    });

    expect(response.status).toBe(500);
    expect((await response.json()).details).toMatch(/Socket closed unexpectedly/);
    expect(client.store.has('upload:images:picture.png')).toBe(true);
    expect(await fileExists('images/picture.png')).toBe(true);
    expect(client.del).not.toHaveBeenCalled();
  });

  test('a record that reads fine is deleted with its file', async () => {
    await fs.mkdir(path.join(mockUploadRoot, 'images'), { recursive: true });
    await fs.writeFile(path.join(mockUploadRoot, 'images', 'picture.png'), 'png');
    client.store.set('upload:images:picture.png', {
      uploadType: 'images',
      storage: 'filesystem',
      relativePath: 'images/picture.png',
      filePath: path.join(mockUploadRoot, 'images', 'picture.png')
    });

    const response = await fetch(`${baseUrl}/api/upload/asset`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadType: 'images', filename: 'picture.png' })
    });

    expect(response.status).toBe(200);
    expect(client.store.has('upload:images:picture.png')).toBe(false);
    expect(await fileExists('images/picture.png')).toBe(false);
  });

  test('Redis not connected: nothing is deleted and the delete says why', async () => {
    await fs.mkdir(path.join(mockUploadRoot, 'images'), { recursive: true });
    await fs.writeFile(path.join(mockUploadRoot, 'images', 'picture.png'), 'png');
    client.store.set('upload:images:picture.png', {
      uploadType: 'images',
      storage: 'filesystem',
      relativePath: 'images/picture.png',
      filePath: path.join(mockUploadRoot, 'images', 'picture.png')
    });
    redisService.connected = false;

    const response = await fetch(`${baseUrl}/api/upload/asset`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadType: 'images', filename: 'picture.png' })
    });

    expect(response.status).toBe(500);
    expect((await response.json()).details).toMatch(/Redis is not connected/);
    expect(client.store.has('upload:images:picture.png')).toBe(true);
    expect(await fileExists('images/picture.png')).toBe(true);
  });
});
