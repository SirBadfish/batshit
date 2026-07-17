/**
 * Boots the real batshit-server (child process, ephemeral port, in-memory
 * fallback storage) and asserts the launch security contract for the HTTP
 * surface:
 *
 * - health checks stay public
 * - every /api and /api/v1 route requires the service token (G-0162/G-0238)
 * - the task dispatcher only accepts allow-listed tool names (G-0162)
 * - the unauthenticated .env settings route family is gone (G-0163)
 * - the Express server does not expose the streamable MCP endpoint directly
 * - /uploads/* clip serving stays public for AI-provider fetching (G-0233)
 *
 * This is the tunnel/LAN exposure proof: when a managed cloudflared tunnel or
 * a Docker port publish points at batshit-server, everything reachable
 * without the token is health + read-only upload serving.
 */
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

jest.setTimeout(30000);

const SERVER_ROOT = path.resolve(__dirname, '../..');
const TEST_TOKEN = 'gauntlet-security-wave-test-token';

let child;
let baseUrl;

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Redis fallback deliberately preserves the production 15-attempt startup
// window; leave enough headroom for that bounded retry contract to finish.
async function waitForHealth(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.status === 200 || response.status === 503) return response.status;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`batshit-server never became reachable: ${lastError}`);
}

beforeAll(async () => {
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BATSHIT_SERVER_HOST: '127.0.0.1',
      // A developer .env may flip these (e.g. HTTPS_ONLY); the proof needs plain HTTP.
      ENABLE_HTTPS: 'false',
      HTTPS_ONLY: 'false',
      BATSHIT_TOKEN: TEST_TOKEN,
      // Redis is optional for this proof; the in-memory fallback is fine.
      BATSHIT_REDIS_REQUIRED: 'false',
      REDIS_URL: 'redis://127.0.0.1:1/0',
      LOG_LEVEL: 'error',
      BATSHIT_HTTP_LOGS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await waitForHealth(baseUrl);
});

afterAll(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 4000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});

const tokenHeaders = { 'x-batshit-service-token': TEST_TOKEN };

describe('public surface', () => {
  it('serves /health and /api/v1/health without a token', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect([200, 503]).toContain(health.status);
    const apiHealth = await fetch(`${baseUrl}/api/v1/health`);
    expect([200, 503]).toContain(apiHealth.status);
  });

  it('keeps /uploads/* free of the token gate (clip serving for AI providers)', async () => {
    // Gated routes 401 immediately (the gate runs before any storage access).
    // /uploads must never do that. With this test's intentionally-dead Redis the
    // route blocks on storage instead of answering, so a timeout also proves the
    // request got past auth; with healthy Redis it would be a plain 404.
    let status = null;
    try {
      const response = await fetch(`${baseUrl}/uploads/images/does-not-exist.png`, {
        signal: AbortSignal.timeout(1500),
      });
      status = response.status;
    } catch (error) {
      status = 'no-response-before-timeout';
    }
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });
});

describe('token gate on the API surface (G-0162/G-0238)', () => {
  const protectedProbes = [
    { method: 'POST', path: '/api/v1/task/s', body: { serviceName: 'built-in', toolName: 'list_files', input: {}, params: {} } },
    { method: 'GET', path: '/api/v1/task/some-task-id' },
    { method: 'POST', path: '/api/upload' },
    { method: 'POST', path: '/api/upload/single' },
    { method: 'POST', path: '/api/upload/avatar' },
    { method: 'DELETE', path: '/api/upload/asset', body: { uploadType: 'images', filename: 'x.png' } },
    { method: 'GET', path: '/api/v1/' },
  ];

  for (const probe of protectedProbes) {
    it(`${probe.method} ${probe.path} rejects requests without the token`, async () => {
      const response = await fetch(`${baseUrl}${probe.path}`, {
        method: probe.method,
        headers: probe.body ? { 'content-type': 'application/json' } : {},
        body: probe.body ? JSON.stringify(probe.body) : undefined,
      });
      expect(response.status).toBe(401);
    });
  }

  it('rejects a wrong token with 401', async () => {
    const response = await fetch(`${baseUrl}/api/v1/task/some-task-id`, {
      headers: { 'x-batshit-service-token': 'wrong-token-wrong-token-wrong-tok' },
    });
    expect(response.status).toBe(401);
  });

  it('accepts the configured token (task status route)', async () => {
    const response = await fetch(`${baseUrl}/api/v1/task/some-task-id`, {
      headers: tokenHeaders,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.taskId).toBe('some-task-id');
  });

  it('executes an allow-listed tool with the token (file-tree lane stays alive)', async () => {
    const response = await fetch(`${baseUrl}/api/v1/task/s`, {
      method: 'POST',
      headers: { ...tokenHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceName: 'built-in',
        toolName: 'list_files',
        input: { dirPath: '', maxDepth: 1 },
        params: { projectPath: SERVER_ROOT },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it('rejects the retired Claude-era task lane', async () => {
    const response = await fetch(`${baseUrl}/api/v1/task/s`, {
      method: 'POST',
      headers: { ...tokenHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceName: 'claude-code',
        toolName: 'execute_task',
        input: { task: 'hello' },
        params: { projectPath: SERVER_ROOT },
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Available services: built-in');
  });
});

describe('task dispatch allow-list (G-0162)', () => {
  const blockedNames = [
    'constructor',
    'handle_tool_call',
    'process_and_store_file',
    'general',
    'to_string',
  ];

  for (const toolName of blockedNames) {
    it(`refuses non-allow-listed tool name "${toolName}" even with the token`, async () => {
      const response = await fetch(`${baseUrl}/api/v1/task/s`, {
        method: 'POST',
        headers: { ...tokenHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceName: 'built-in',
          toolName,
          input: {},
          params: {},
        }),
      });
      expect(response.status).toBe(404);
    });
  }
});

describe('deleted route families', () => {
  it('the unauthenticated .env settings routes are gone (G-0163)', async () => {
    const read = await fetch(`${baseUrl}/api/v1/settings/env`, { headers: tokenHeaders });
    expect(read.status).toBe(404);
    const write = await fetch(`${baseUrl}/api/v1/settings/env`, {
      method: 'POST',
      headers: { ...tokenHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ KEY: 'value' }),
    });
    expect(write.status).toBe(404);
  });

  it('the dead session/zip/SSE/MCP bridge/Claude auth route families are gone', async () => {
    const probes = [
      { method: 'POST', path: '/api/v1/session/create', body: { sessionId: 'x', projectPath: SERVER_ROOT } },
      { method: 'POST', path: '/api/v1/zips', body: { id: 'x', content: 'y' } },
      { method: 'GET', path: '/api/v1/zips/some-zip' },
      { method: 'GET', path: '/api/v1/sse/some-session' },
      { method: 'POST', path: '/api/v1/sse/send', body: {} },
      { method: 'GET', path: '/api/v1/mcp/tools' },
      { method: 'POST', path: '/api/v1/auth/claude' },
      { method: 'GET', path: '/api/v1/auth/claude/status' },
    ];

    for (const probe of probes) {
      const response = await fetch(`${baseUrl}${probe.path}`, {
        method: probe.method,
        headers: { ...tokenHeaders, ...(probe.body ? { 'content-type': 'application/json' } : {}) },
        body: probe.body ? JSON.stringify(probe.body) : undefined,
      });
      expect(response.status).toBe(404);
    }
  });

  it('does not expose the streamable MCP endpoint on the Express server', async () => {
    const response = await fetch(`${baseUrl}/mcp`, { headers: tokenHeaders });
    expect(response.status).toBe(404);
  });

  it('the task debug echo endpoint is gone (G-0169)', async () => {
    const response = await fetch(`${baseUrl}/api/v1/task/debug`, {
      method: 'POST',
      headers: { ...tokenHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ probe: true }),
    });
    // /api/v1/task/debug now falls through to GET-only routes → 404 for POST.
    expect(response.status).toBe(404);
  });
});
