/**
 * How the stdio MCP helper (src/mcp/index.js) ends (BL-206). The streamable MCP helper
 * (supergateway, stateless) starts one index.js per POST to /mcp and never ends it: each request
 * left a Node process running until the helper stopped. The real index.js is started here as supergateway starts it (a
 * child with piped stdio) and spoken to over stdio.
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const { createOneRequestTracker } = require('../stdioLifecycle');

const HELPER = path.resolve(__dirname, '../index.js');
const SERVER_ROOT = path.resolve(__dirname, '../../..');

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zblaunch', version: '1' } }
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const RETIRED_FETCH_ZIP = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'batshit_server_fetch_zip', arguments: { zipId: 'zblaunch-missing-zip' } }
};
const DYNAMIC_FIND = {
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'batshit_server_dynamic_mcp_find', arguments: { userId: 'lifecycle-test', query: 'held-request' } }
};

describe('createOneRequestTracker', () => {
  function tracker(graceMs = 1000) {
    let now = 0;
    const timers = new Map();
    let nextId = 1;
    const idle = jest.fn();
    const t = createOneRequestTracker({
      graceMs,
      onIdle: idle,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id)
    });
    const advance = (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    };
    return { t, idle, advance };
  }

  test('ends once every request is answered and nothing more arrives for the grace period', () => {
    const { t, idle, advance } = tracker();
    t.received(INITIALIZE);
    advance(5000);
    expect(idle).not.toHaveBeenCalled();
    t.sent({ jsonrpc: '2.0', id: 1, result: {} });
    advance(999);
    expect(idle).not.toHaveBeenCalled();
    advance(1);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  test("supergateway's follow-up inside the grace period keeps it alive until that is answered too", () => {
    const { t, idle, advance } = tracker();
    t.received({ ...INITIALIZE, id: 'init_1_abc' });
    t.sent({ jsonrpc: '2.0', id: 'init_1_abc', result: {} });
    advance(10);
    t.received(INITIALIZED);
    t.received(LIST_TOOLS);
    advance(5000);
    expect(idle).not.toHaveBeenCalled();
    t.sent({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    advance(1000);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  test('a notification alone asks nothing, so the grace period starts again from it', () => {
    const { t, idle, advance } = tracker();
    advance(600);
    t.received(INITIALIZED);
    advance(600);
    expect(idle).not.toHaveBeenCalled();
    advance(400);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  test('matches answers to requests by id, number and string apart', () => {
    const { t, idle, advance } = tracker();
    t.received({ ...LIST_TOOLS, id: 7 });
    t.sent({ jsonrpc: '2.0', id: '7', result: {} });
    advance(2000);
    expect(idle).not.toHaveBeenCalled();
    t.sent({ jsonrpc: '2.0', id: 7, error: { code: -1, message: 'x' } });
    advance(1000);
    expect(idle).toHaveBeenCalledTimes(1);
  });
});

describe('the stdio MCP helper process', () => {
  const children = new Set();
  const servers = new Set();
  afterEach(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    children.clear();
    for (const stop of servers) await stop();
    servers.clear();
  });

  function startHelper(env) {
    const child = spawn(process.execPath, [HELPER], {
      cwd: SERVER_ROOT,
      env: { ...process.env, BATSHIT_SERVER_URL: 'http://127.0.0.1:9/api/v1', ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    children.add(child);
    const replies = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        // Like supergateway, skip a line that is not JSON-RPC (dotenv prints one at startup).
        try {
          replies.push(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.resume();
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const reply = async (id, ms = 15000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = replies.find((message) => message.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no reply to ${id}`);
    };
    return { child, send, reply, exited };
  }

  const within = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(() => resolve('still running'), ms); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // An app endpoint that accepts the connection and never answers: a request the helper holds open.
  async function silentApp() {
    const sockets = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.add(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    });
    const connected = async () => {
      const deadline = Date.now() + 10000;
      while (sockets.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sockets.length).toBeGreaterThan(0);
    };
    return { url: `http://127.0.0.1:${server.address().port}`, connected };
  }

  test('under the streamable helper, it exits once its one request is answered, with stdin still open', async () => {
    const helper = startHelper({ BATSHIT_MCP_STDIO_ONE_REQUEST: '1', BATSHIT_MCP_STDIO_ONE_REQUEST_GRACE_MS: '300' });
    helper.send(INITIALIZE);
    expect((await helper.reply(1)).result.serverInfo.name).toBe('batshit-server-mcp');
    expect(await within(helper.exited, 5000)).toEqual({ code: 0, signal: null });
  }, 30000);

  test("under the streamable helper, supergateway's follow-up is answered before it exits", async () => {
    const helper = startHelper({ BATSHIT_MCP_STDIO_ONE_REQUEST: '1', BATSHIT_MCP_STDIO_ONE_REQUEST_GRACE_MS: '300' });
    helper.send({ ...INITIALIZE, id: 'init_1_zblaunch' });
    await helper.reply('init_1_zblaunch');
    await new Promise((resolve) => setTimeout(resolve, 100));
    helper.send(INITIALIZED);
    helper.send(LIST_TOOLS);
    expect((await helper.reply(2)).result.tools.length).toBeGreaterThan(0);
    expect(await within(helper.exited, 5000)).toEqual({ code: 0, signal: null });
  }, 30000);

  test('does not advertise the retired file-server Fetch Zip and rejects an old call with replacement guidance', async () => {
    const helper = startHelper({ BATSHIT_MCP_STDIO_ONE_REQUEST: '' });
    helper.send(INITIALIZE);
    await helper.reply(1);
    helper.send(LIST_TOOLS);
    expect((await helper.reply(2)).result.tools.map((tool) => tool.name)).not.toContain('batshit_server_fetch_zip');
    helper.send(RETIRED_FETCH_ZIP);
    const result = await helper.reply(3);
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('fabric:sys.zip.fetch');
    expect(result.result.content[0].text).toContain('Fetch Zip tool in batshit_helpers');
    helper.child.stdin.end();
    expect(await within(helper.exited, 5000)).toEqual({ code: 0, signal: null });
  }, 30000);

  test('a request still being answered keeps it running', async () => {
    const app = await silentApp();
    const helper = startHelper({
      BATSHIT_MCP_STDIO_ONE_REQUEST: '1',
      BATSHIT_MCP_STDIO_ONE_REQUEST_GRACE_MS: '300',
      BATSHIT_FRONTEND_URL: app.url,
      BATSHIT_TOKEN: 'lifecycle-test-token'
    });
    helper.send(INITIALIZE);
    await helper.reply(1);
    helper.send(INITIALIZED);
    helper.send(DYNAMIC_FIND);
    await app.connected();
    expect(await within(helper.exited, 1500)).toBe('still running');
    helper.child.stdin.end();
    expect(await within(helper.exited, 5000)).toEqual({ code: 0, signal: null });
  }, 30000);

  test('any other stdio client keeps it for as long as it likes', async () => {
    const helper = startHelper({ BATSHIT_MCP_STDIO_ONE_REQUEST: '', BATSHIT_MCP_STDIO_ONE_REQUEST_GRACE_MS: '300' });
    helper.send(INITIALIZE);
    await helper.reply(1);
    expect(await within(helper.exited, 1500)).toBe('still running');
    helper.child.stdin.end();
    expect(await within(helper.exited, 5000)).toEqual({ code: 0, signal: null });
  }, 30000);

  test('it exits when its stdin ends, even holding an app request', async () => {
    const app = await silentApp();
    const helper = startHelper({ BATSHIT_MCP_STDIO_ONE_REQUEST: '', BATSHIT_FRONTEND_URL: app.url, BATSHIT_TOKEN: 'lifecycle-test-token' });
    helper.send(INITIALIZE);
    await helper.reply(1);
    helper.send(INITIALIZED);
    helper.send(DYNAMIC_FIND);
    await app.connected();
    helper.child.stdin.end();
    expect(await within(helper.exited, 5000)).toEqual({ code: 0, signal: null });
  }, 30000);

  test('it exits on SIGTERM, even holding an app request', async () => {
    const app = await silentApp();
    const helper = startHelper({ BATSHIT_MCP_STDIO_ONE_REQUEST: '', BATSHIT_FRONTEND_URL: app.url, BATSHIT_TOKEN: 'lifecycle-test-token' });
    helper.send(INITIALIZE);
    await helper.reply(1);
    helper.send(INITIALIZED);
    helper.send(DYNAMIC_FIND);
    await app.connected();
    helper.child.kill('SIGTERM');
    expect(await within(helper.exited, 5000)).toEqual({ code: 0, signal: null });
  }, 30000);
});

// stdout is the MCP stdio channel: every byte on it must be JSON-RPC. dotenv 17 prints a line
// ("◇ injected env (N) from .env") to stdout unless told to be quiet; supergateway skips such a
// line, a strict stdio client may not.
describe('the stdio channel', () => {
  test('carries only JSON-RPC, from its first byte', async () => {
    const env = { ...process.env, BATSHIT_SERVER_URL: 'http://127.0.0.1:9/api/v1', BATSHIT_MCP_STDIO_ONE_REQUEST: '' };
    delete env.DOTENV_CONFIG_QUIET;
    const child = spawn(process.execPath, [HELPER], { cwd: SERVER_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
    const deadline = Date.now() + 15000;
    while (!stdout.includes('"id":1') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    child.stdin.end();
    await new Promise((resolve) => child.on('exit', resolve));

    expect(stdout.startsWith('{"')).toBe(true);
    const lines = stdout.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe('2.0');
  }, 30000);
});
