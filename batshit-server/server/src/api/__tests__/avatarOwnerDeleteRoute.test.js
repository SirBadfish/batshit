const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// The upload router makes `<uploadsDir>/_tmp` when it loads, so the directory has to be a
// private temp folder before the first require (a `mock`-prefixed name may be read by a
// hoisted jest.mock factory).
const mockUploadRoot = path.join(os.tmpdir(), `batshit-avatar-route-${process.pid}-${Date.now()}`);
jest.mock('../../config', () => ({ uploadsDir: mockUploadRoot }));
jest.mock('../../services/redisService', () => ({
  client: null,
  isConnected: jest.fn(() => false),
  get: jest.fn(async () => null)
}));
jest.mock('../../utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

const redisService = require('../../services/redisService');
const uploadRoutes = require('../upload-redis');

/**
 * BL-41: the agent-avatar sweep route `DELETE /api/upload/avatar` (the app's agent delete
 * calls it server to server with the service token; `apiSurfaceAuth.test.js` pins that gate).
 * These cases pin what the route itself owes: strict input before anything else, a refusal
 * instead of a success when Redis is not connected, and the sweep's own result or failure.
 */
function createConnectedClient(records) {
  const store = new Map(Object.entries(records));
  return {
    store,
    isOpen: true,
    async *scanIterator({ MATCH }) {
      const prefix = MATCH.slice(0, -1);
      yield [...store.keys()].filter((key) => key.startsWith(prefix));
    },
    json: { get: async (key) => (store.has(key) ? structuredClone(store.get(key)) : null) },
    del: async (key) => (store.delete(key) ? 1 : 0)
  };
}

let server;
let baseUrl;

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

afterEach(() => {
  redisService.client = null;
  redisService.isConnected.mockReturnValue(false);
});

async function deleteAvatars(body) {
  const response = await fetch(`${baseUrl}/api/upload/avatar`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('sweeps the agent’s avatar records and files and answers what it deleted', async () => {
  const filename = 'agent_zb_route_1790000000000.jpg';
  await fs.mkdir(path.join(mockUploadRoot, 'avatars'), { recursive: true });
  await fs.writeFile(path.join(mockUploadRoot, 'avatars', filename), 'jpg');
  await fs.writeFile(path.join(mockUploadRoot, 'avatars', 'agent_zb_route_2_1790000000001.jpg'), 'jpg');
  const client = createConnectedClient({
    [`upload:avatars:agent:${filename}`]: { storage: 'filesystem', relativePath: `avatars/${filename}` },
    'upload:avatars:agent:agent_zb_route_2_1790000000001.jpg': {
      storage: 'filesystem',
      relativePath: 'avatars/agent_zb_route_2_1790000000001.jpg'
    }
  });
  redisService.client = client;
  redisService.isConnected.mockReturnValue(true);

  const result = await deleteAvatars({ entityType: 'agent', entityId: 'zb_route', legacyFilenames: [] });

  expect(result).toEqual({
    status: 200,
    body: {
      success: true,
      deletedRecords: [`upload:avatars:agent:${filename}`],
      deletedFiles: [`avatars/${filename}`]
    }
  });
  expect([...client.store.keys()]).toEqual(['upload:avatars:agent:agent_zb_route_2_1790000000001.jpg']);
  await expect(fs.access(path.join(mockUploadRoot, 'avatars', 'agent_zb_route_2_1790000000001.jpg'))).resolves.toBeUndefined();
});

test('answers 400 for an unsafe owner id before looking at storage', async () => {
  redisService.isConnected.mockImplementation(() => {
    throw new Error('storage must not be consulted for a bad request');
  });
  const result = await deleteAvatars({ entityType: 'agent', entityId: 'x*' });
  expect(result.status).toBe(400);
  expect(result.body.error).toMatch(/entityId/);
});

test('answers 503 when Redis is not connected, never a success over the in-memory fallback', async () => {
  const result = await deleteAvatars({ entityType: 'agent', entityId: 'zb_route' });
  expect(result.status).toBe(503);
  expect(result.body.error).toMatch(/no avatar was deleted/i);
});

test('answers 500 with the reason when the sweep fails part way', async () => {
  const client = createConnectedClient({
    'upload:avatars:agent:agent_zb_route_1790000000000.jpg': {
      storage: 'filesystem',
      relativePath: 'avatars/user_josh_1775362752696.jpg'
    }
  });
  redisService.client = client;
  redisService.isConnected.mockReturnValue(true);

  const result = await deleteAvatars({ entityType: 'agent', entityId: 'zb_route' });

  expect(result.status).toBe(500);
  expect(result.body.error).toBe('Avatar delete failed');
  expect(result.body.details).toMatch(/points at avatars\/user_josh_1775362752696\.jpg/);
  expect(client.store.size).toBe(1);
});
