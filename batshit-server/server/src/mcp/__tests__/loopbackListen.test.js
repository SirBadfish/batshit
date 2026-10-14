/**
 * The streamable MCP helper (supergateway, Mac app 5601 / native 5611) serves Batshit's own MCP
 * tools with no login of its own, and supergateway has no option for the address it listens on,
 * so it listened on every network interface: anyone on the same network could list and run
 * those tools (found 2026-09-22 on the rebuilt Mac app). `loopbackListen.cjs` is preloaded into
 * that process and must make every TCP listen shape it can use bind 127.0.0.1 only. Each case
 * runs in a child Node process, exactly as the launchers start it (`node -r <preload> …`).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRELOAD = path.resolve(__dirname, '../loopbackListen.cjs');

function listenWith(listenCall) {
  const script = `
    const http = require('http');
    const server = http.createServer();
    server.on('listening', () => {
      const address = server.address();
      process.stdout.write(JSON.stringify(typeof address === 'string' ? { path: address } : address));
      server.close();
    });
    server.on('error', (error) => { process.stdout.write(JSON.stringify({ error: error.message })); });
    ${listenCall};
  `;
  const result = spawnSync(process.execPath, ['-r', PRELOAD, '-e', script], {
    encoding: 'utf8',
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`child exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

describe('loopbackListen preload (the streamable MCP helper stays on this computer)', () => {
  test('a port alone, the shape supergateway uses (app.listen(port, callback)), binds 127.0.0.1', () => {
    expect(listenWith('server.listen(0, () => {})')).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(listenWith('server.listen(0)')).toMatchObject({ address: '127.0.0.1' });
  });

  test('an explicit all-interfaces host is replaced by 127.0.0.1', () => {
    expect(listenWith("server.listen(0, '0.0.0.0', () => {})")).toMatchObject({ address: '127.0.0.1' });
    expect(listenWith("server.listen(0, '::')")).toMatchObject({ address: '127.0.0.1' });
  });

  test('an options object and a bare listen() bind 127.0.0.1', () => {
    expect(listenWith('server.listen({ port: 0 })')).toMatchObject({ address: '127.0.0.1' });
    expect(listenWith("server.listen({ port: 0, host: '0.0.0.0' })")).toMatchObject({ address: '127.0.0.1' });
    expect(listenWith('server.listen()')).toMatchObject({ address: '127.0.0.1' });
    expect(listenWith('server.listen(() => {})')).toMatchObject({ address: '127.0.0.1' });
    expect(listenWith('server.listen(null)')).toMatchObject({ address: '127.0.0.1' });
  });

  test('a Unix socket listen is left alone', () => {
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-loopback-')), 's.sock');
    try {
      expect(listenWith(`server.listen(${JSON.stringify(socketPath)})`)).toEqual({ path: socketPath });
    } finally {
      fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
    }
  });
});

// BL-206: supergateway's stateless mode (how both launchers run it) starts one src/mcp/index.js
// per POST and never ends it. Only the preload knows that, so it marks the children it spawns.
describe('the preload marks supergateway children as one-request processes', () => {
  function markerSeenBy(args) {
    const env = { ...process.env };
    delete env.BATSHIT_MCP_STDIO_ONE_REQUEST;
    const result = spawnSync(
      process.execPath,
      ['-r', PRELOAD, '-e', 'process.stdout.write(String(process.env.BATSHIT_MCP_STDIO_ONE_REQUEST))', '--', ...args],
      { encoding: 'utf8', timeout: 15000, env }
    );
    if (result.status !== 0) throw new Error(`child exited ${result.status}: ${result.stderr}`);
    return result.stdout;
  }

  test('stateless, as the launchers start it: marked', () => {
    expect(markerSeenBy(['--stdio', 'node src/mcp/index.js', '--outputTransport', 'streamableHttp'])).toBe('1');
  });

  test('stateful (a child serves a whole session, and supergateway stops it): not marked', () => {
    expect(markerSeenBy(['--stdio', 'node src/mcp/index.js', '--outputTransport', 'streamableHttp', '--stateful'])).toBe(
      'undefined'
    );
  });
});
