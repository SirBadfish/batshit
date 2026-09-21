// Regression proof: a stale Docker MCP Gateway pid file must never authorize killing an
// unrelated process group after PID reuse. This file sets an isolated Mac data root before the
// supervisor module is imported, and touches only a detached sleep process the test owns.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('stopDockerMcpGateway refuses a stale pid file that points at an unrelated group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-gateway-stop-safety-'));
  const data = join(root, 'data');
  const pidDir = join(data, 'runtime', 'pids');
  process.env.BATSHIT_MAC_DATA_DIR = data;
  process.env.BATSHIT_MAC_LOG_DIR = join(root, 'logs');
  process.env.BATSHIT_MAC_CACHE_DIR = join(root, 'cache');
  process.env.BATSHIT_MAC_REPO_ROOT = resolve(import.meta.dirname, '..', '..');

  const unrelated = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' });
  unrelated.unref();
  assert.ok(unrelated.pid);

  try {
    await mkdir(pidDir, { recursive: true });
    await writeFile(join(pidDir, 'docker-mcp-gateway.pid'), `${unrelated.pid}\n`);
    await writeFile(
      join(pidDir, 'docker-mcp-gateway.meta.json'),
      `${JSON.stringify({ pid: unrelated.pid, port: 8080, profile: 'default', generation: 'stale' })}\n`
    );

    const { stopDockerMcpGateway, removeDockerMcpGatewayOwnershipIfCurrent } =
      await import('./mac-runtime-supervisor.mjs');
    const result = await stopDockerMcpGateway();

    assert.equal(result.skipped, true);
    assert.match(result.reason, /refused to kill/);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));

    const successor = { pid: unrelated.pid, port: 8080, profile: 'default', generation: 'successor' };
    await writeFile(join(pidDir, 'docker-mcp-gateway.pid'), `${unrelated.pid}\n`);
    await writeFile(join(pidDir, 'docker-mcp-gateway.meta.json'), `${JSON.stringify(successor)}\n`);
    assert.equal(
      await removeDockerMcpGatewayOwnershipIfCurrent({ ...successor, generation: 'older' }),
      false,
      'cleanup for an older generation must not remove a successor'
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(pidDir, 'docker-mcp-gateway.meta.json'), 'utf8')),
      successor
    );
  } finally {
    try {
      process.kill(-unrelated.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(unrelated.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
