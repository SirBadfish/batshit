/**
 * Where the stdio MCP helper (src/mcp/index.js) sends its app calls (BL-562, BL-340's live form).
 *
 * Its four app-backed tools (Dynamic MCP find and use, Fabric find and use) fell back to
 * `http://localhost:5620`, the Mac app, when `BATSHIT_FRONTEND_URL` was unset, so a lane that did
 * not set it called another Batshit. They now use the configured address, or refuse with an
 * error that names the variable and call nothing.
 *
 * The real index.js is started as supergateway starts it. Every HTTP call it makes goes through a
 * recording proxy (`HTTP_PROXY`, which axios honors), so the test sees where a call was headed
 * without ever reaching that address, the Mac app included.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const HELPER = path.resolve(__dirname, '../index.js');
const SERVER_ROOT = path.resolve(__dirname, '../../..');

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zcmisc', version: '1' } }
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

// The four tools that call the app, and the app route each one calls.
const APP_TOOLS = [
  { name: 'batshit_server_dynamic_mcp_find', args: { userId: 'zcmisc', query: 'weather' }, route: '/api/mcp/tools/find' },
  { name: 'batshit_server_dynamic_mcp_use', args: { userId: 'zcmisc', toolName: 'weather', params: {} }, route: '/api/mcp/tools/execute' },
  { name: 'mcp_fabric_find', args: { userId: 'zcmisc', query: 'artifact' }, route: '/api/controls/find' },
  { name: 'mcp_fabric_use', args: { userId: 'zcmisc', controlId: 'sys.zcmisc.probe' }, route: '/api/controls/use' }
];

describe('the stdio MCP helper calls the app at BATSHIT_FRONTEND_URL, never the Mac app by default (BL-562)', () => {
  const children = new Set();
  const servers = new Set();
  afterEach(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    children.clear();
    for (const stop of servers) await stop();
    servers.clear();
  });

  // Records the absolute URL of every request sent through it and answers each with a 502.
  async function recordingProxy() {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      req.resume();
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'zcmisc recording proxy' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.add(() => new Promise((resolve) => server.close(resolve)));
    return { url: `http://127.0.0.1:${server.address().port}`, seen };
  }

  function startHelper(env) {
    const child = spawn(process.execPath, [HELPER], {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        BATSHIT_MCP_STDIO_ONE_REQUEST: '',
        BATSHIT_TOKEN: 'zcmisc-service-token',
        NO_PROXY: '',
        no_proxy: '',
        ...env
      },
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
        try {
          replies.push(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.resume();
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
    return { send, reply };
  }

  async function callEveryAppTool(helper) {
    helper.send(INITIALIZE);
    await helper.reply(1);
    helper.send(INITIALIZED);
    const texts = [];
    for (const [index, tool] of APP_TOOLS.entries()) {
      const id = 10 + index;
      helper.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool.name, arguments: tool.args } });
      texts.push((await helper.reply(id)).result.content[0].text);
    }
    return texts;
  }

  test('with BATSHIT_FRONTEND_URL unset, every app tool refuses with an error naming it, and calls nothing', async () => {
    const proxy = await recordingProxy();
    // Empty, not absent: dotenv never replaces a variable that exists, so a local .env cannot fill it.
    const helper = startHelper({ BATSHIT_FRONTEND_URL: '', HTTP_PROXY: proxy.url, http_proxy: proxy.url });

    const texts = await callEveryAppTool(helper);

    expect(proxy.seen).toEqual([]);
    for (const text of texts) {
      expect(text).toContain('BATSHIT_FRONTEND_URL is not set');
      expect(text).not.toContain('5620');
    }
  }, 60000);

  test('with BATSHIT_FRONTEND_URL set, every app tool calls that address', async () => {
    const proxy = await recordingProxy();
    const helper = startHelper({
      BATSHIT_FRONTEND_URL: 'http://127.0.0.1:5763/',
      HTTP_PROXY: proxy.url,
      http_proxy: proxy.url
    });

    await callEveryAppTool(helper);

    expect(proxy.seen).toEqual(APP_TOOLS.map((tool) => `http://127.0.0.1:5763${tool.route}`));
  }, 60000);
});
