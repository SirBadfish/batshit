import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { redisServerArgs } from './lane.mjs';
import { askRedis, logTail, waitForOwnRedis } from './lifecycle.mjs';

import {
  fetchPinned,
  installRedisRuntime,
  pinokioBaseLibDir,
  redisProcessEnv,
  redisRuntimeDownloads
} from './redis-runtime.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

test('macOS on Apple silicon downloads the Mac app\'s pinned Redis archive', () => {
  const [archive, ...rest] = redisRuntimeDownloads({ platform: 'darwin', arch: 'arm64' });
  assert.equal(rest.length, 0);
  assert.equal(archive.url, 'https://packages.redis.io/homebrew/redis-oss-8.10.1-arm64.zip');
  assert.equal(archive.sha256, '3e7966a847255580f93fac2398d99c20d80583decf10f194b60fe20a7724e433');
});

test('Linux downloads Redis\'s Ubuntu 22.04 packages and Ubuntu\'s libcrypt1, all pinned', () => {
  for (const [arch, deb] of [['x64', 'amd64'], ['arm64', 'arm64']]) {
    const downloads = redisRuntimeDownloads({ platform: 'linux', arch });
    assert.deepEqual(downloads.map((d) => d.name), ['redis-server', 'redis-tools', 'libcrypt1']);
    for (const entry of downloads) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      assert.ok(entry.url.startsWith('https://'), entry.url);
      assert.ok(entry.file.endsWith(`_${deb}.deb`), entry.file);
    }
    assert.ok(downloads[0].url.startsWith('https://packages.redis.io/deb/pool/jammy/'));
    const targets = downloads.flatMap((d) => d.files.map(([, to]) => to));
    assert.deepEqual(targets, ['bin/redis-server', 'lib/rejson.so', 'lib/redisearch.so', 'bin/redis-cli', 'lib/libcrypt.so.1']);
  }
});

test('unsupported computers get a plain answer', () => {
  assert.throws(() => redisRuntimeDownloads({ platform: 'darwin', arch: 'x64' }), /Apple silicon/);
  assert.throws(() => redisRuntimeDownloads({ platform: 'linux', arch: 'ia32' }), /x64 or arm64/);
  assert.throws(() => redisRuntimeDownloads({ platform: 'win32', arch: 'x64' }), /install Batshit with Docker/);
});

test('Linux Redis finds its bundled libraries, and only those; macOS needs nothing', () => {
  assert.deepEqual(redisProcessEnv('/r', 'linux'), { LD_LIBRARY_PATH: '/r/lib' });
  assert.deepEqual(redisProcessEnv('/r', 'darwin'), {});
  assert.equal(pinokioBaseLibDir('/home/ada/pinokio/bin/miniforge/bin/node'), '/home/ada/pinokio/bin/miniforge/lib');
});

function fakeFetch(bodies) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const body = bodies[url];
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body);
  };
  return { impl, calls };
}

test('a download is kept only when its checksum matches the pin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-pin-'));
  try {
    const good = Buffer.from('the real package');
    const entry = { file: 'pkg.deb', url: 'https://example.test/pkg.deb', sha256: sha256(good) };
    const fetch1 = fakeFetch({ [entry.url]: good });
    assert.equal(await fetchPinned(entry, dir, { fetchImpl: fetch1.impl }), join(dir, 'pkg.deb'));
    assert.deepEqual(await readFile(join(dir, 'pkg.deb')), good);

    const fetch2 = fakeFetch({ [entry.url]: good });
    await fetchPinned(entry, dir, { fetchImpl: fetch2.impl });
    assert.equal(fetch2.calls.length, 0, 'a verified copy is reused without downloading again');

    await writeFile(join(dir, 'pkg.deb'), 'tampered');
    const fetch3 = fakeFetch({ [entry.url]: Buffer.from('a different file') });
    await assert.rejects(fetchPinned(entry, dir, { fetchImpl: fetch3.impl }), /failed its checksum/);
    assert.equal(existsSync(join(dir, 'pkg.deb.partial')), false, 'the bad download is deleted');

    const fetch4 = fakeFetch({});
    await assert.rejects(fetchPinned({ ...entry, file: 'other.deb' }, dir, { fetchImpl: fetch4.impl }), /HTTP 404/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen({ port: 0, host: '127.0.0.1' }, done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

// Starts the installed Redis as `run redis` does (the lane's arguments, its log in a file), on a
// free port instead of the lane's, so a running Pinokio Batshit on this computer is never touched.
async function startLaneRedis(dest, dir, { modules = ['rejson.so', 'redisearch.so'] } = {}) {
  const redisDir = join(dir, 'data');
  const logFile = join(dir, 'logs', 'redis.log');
  await mkdir(redisDir, { recursive: true });
  await mkdir(join(dir, 'logs'), { recursive: true });
  const port = await freePort();
  const args = redisServerArgs({ redisDir, moduleDir: join(dest, 'lib'), modules, logFile });
  args[args.indexOf('--port') + 1] = String(port);
  const child = spawn(join(dest, 'bin', 'redis-server'), args, {
    cwd: redisDir,
    env: { ...process.env, ...redisProcessEnv(dest) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((done) => child.once('exit', (code) => done(code)));
  return { child, port, logFile, exited, output: () => output };
}

// Downloads the real pinned files and proves the runtime starts with RedisJSON and Search on
// this machine, then that it starts the lane's way: silent in the terminal, its log in a file,
// ready when its own process answers PONG (BL-363). CI runs it on Linux (x64) with the system's
// own OpenSSL and C++ runtime standing in for Pinokio's base environment.
test('installs and probes the real Redis runtime', { skip: process.env.BATSHIT_LIVE_PINOKIO_REDIS !== '1' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-live-'));
  try {
    const dest = join(dir, 'redis');
    await installRedisRuntime({
      dest,
      downloadsDir: join(dir, 'downloads'),
      baseLibDir: process.env.BATSHIT_PINOKIO_BASE_LIB_DIR || pinokioBaseLibDir(),
      log: (message) => console.log(`  ${message}`)
    });
    const source = JSON.parse(await readFile(join(dest, 'SOURCE.json'), 'utf8'));
    assert.equal(source.redis, '8.10.1');
    assert.deepEqual(source.modules, ['rejson.so', 'redisearch.so']);

    const redis = await startLaneRedis(dest, join(dir, 'lane'));
    try {
      const ready = await waitForOwnRedis({ host: '127.0.0.1', port: redis.port, pid: redis.child.pid, exited: redis.exited });
      assert.equal(ready, true);
      assert.match((await readFile(redis.logFile, 'utf8')), /Ready to accept connections/);
      assert.equal(redis.output(), '', 'nothing reaches the terminal after the ready line');
    } finally {
      redis.child.kill('SIGTERM');
      await redis.exited;
    }

    const broken = await startLaneRedis(dest, join(dir, 'broken'), { modules: ['rejson.so', 'missing.so'] });
    assert.equal(await waitForOwnRedis({ host: '127.0.0.1', port: broken.port, pid: broken.child.pid, exited: broken.exited }), false);
    assert.notEqual(await broken.exited, 0);
    assert.match((await logTail(broken.logFile)).join('\n'), /missing\.so/, 'the log tail says which module failed');
    assert.equal(await askRedis({ host: '127.0.0.1', port: broken.port, args: ['PING'] }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
