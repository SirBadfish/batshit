// Docker MCP gateway process-lifecycle contracts for the Mac runtime supervisor.
//
//   cd batshit-mac && npm run test:runtime
//   node --test scripts/mac-runtime-gateway-lifecycle.test.mjs
//
// These drive the real exported seams with real processes and real `lsof`. No
// Docker and no packaged app are needed: `heldStdinSpawnArgs` is the exact
// string the supervisor spawns, so it can be run against a stand-in command.
//
// Every assertion is about a process this file started, found by walking ppid
// links down from a PID it owns, so it can never touch anything else.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dockerMcpGatewayGroupMatchesMetadata,
  dockerMcpGatewayLogFile,
  heldStdinSpawnArgs,
  parseDockerMcpGatewayProcess,
  pidsHoldingFileOpen
} from './mac-runtime-supervisor.mjs';

test('gateway stop ownership requires the recorded pid, port, profile, and gateway command', () => {
  const rows = [
    {
      pid: 4242,
      pgid: 4242,
      ppid: 1,
      command: 'docker mcp gateway run --port 8080 --transport streaming --profile default'
    }
  ];
  const metadata = { pid: 4242, port: 8080, profile: 'default' };

  assert.equal(dockerMcpGatewayGroupMatchesMetadata(4242, metadata, rows), true);
  assert.equal(
    dockerMcpGatewayGroupMatchesMetadata(4242, metadata, [
      { ...rows[0], command: '/bin/sleep 120' }
    ]),
    false,
    'a reused pid running an unrelated command must not be treated as the managed gateway'
  );
  assert.equal(
    dockerMcpGatewayGroupMatchesMetadata(4242, { ...metadata, pid: 3131 }, rows),
    false,
    'metadata for another launch must not authorize a kill'
  );
  assert.equal(
    dockerMcpGatewayGroupMatchesMetadata(4242, { ...metadata, port: 9090 }, rows),
    false,
    'a gateway on another port must not be claimed through stale metadata'
  );
});

let workDir;
const startedPids = new Set();

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'batshit-mac-gateway-test-'));
});

after(() => {
  for (const pid of [...startedPids].reverse()) {
    for (const child of descendants(pid).reverse()) {
      try { process.kill(child, 'SIGKILL'); } catch {}
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function descendants(root) {
  let raw = '';
  try {
    raw = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (pid === ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const queue = [...(children.get(root) || [])];
  while (queue.length) {
    const pid = queue.shift();
    if (out.includes(pid)) continue;
    out.push(pid);
    startedPids.add(pid);
    queue.push(...(children.get(pid) || []));
  }
  return out;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

/** Spawn exactly the way startDetachedDockerMcpGateway does, minus Docker. */
function spawnHeldStdin(command, args, logPath) {
  const fd = openSync(logPath, 'a');
  const child = spawn('bash', heldStdinSpawnArgs(command, args), {
    detached: true,
    stdio: ['ignore', fd, fd]
  });
  child.unref();
  closeSync(fd);
  startedPids.add(child.pid);
  // Record the children too, while they are still reachable. A mutation run
  // that puts the old wrapper back orphans them to PID 1, where the tree walk
  // can no longer find them and the after() sweep would miss them.
  setTimeout(() => descendants(child.pid), 300).unref();
  setTimeout(() => descendants(child.pid), 900).unref();
  return child.pid;
}

test('the gateway spawn keeps stdin open — the reason tail -f /dev/null was there', async () => {
  const marker = join(workDir, 'eof.marker');
  const reader = join(workDir, 'reader.sh');
  // Writes the marker only if stdin reaches end-of-file. A streaming gateway
  // exits at that point, which is the bug the held stdin prevents.
  writeFileSync(reader, `#!/bin/bash\ncat > /dev/null\necho eof > ${JSON.stringify(marker)}\n`, { mode: 0o755 });

  const pid = spawnHeldStdin(reader, [], join(workDir, 'held.log'));
  await sleep(2500);

  assert.equal(existsSync(marker), false, 'stdin reached EOF; a streaming gateway would have exited');
  assert.ok(alive(pid), 'the command exited instead of blocking on stdin');
});

test('the gateway spawn leaves one process and nothing behind when the command exits', async () => {
  // The old wrapper outlived its command forever. child.pid must now BE the
  // command, so the supervisor pid file names the real gateway.
  const pid = spawnHeldStdin('/bin/sleep', ['20'], join(workDir, 'one.log'));
  await sleep(1200);

  const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  assert.match(command, /^\/bin\/sleep 20$/, `child.pid should be the command itself, got: ${command}`);
  assert.deepEqual(descendants(pid), [], 'the spawn left helper processes behind');

  process.kill(pid, 'SIGTERM');
  const gone = await waitUntil(() => !alive(pid), 5000);
  assert.ok(gone, 'the gateway process did not stop');
});

test('the gateway spawn is its own process group leader, so a group kill still works', async () => {
  const pid = spawnHeldStdin('/bin/sleep', ['20'], join(workDir, 'group.log'));
  await sleep(1200);

  const pgid = Number(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  );
  assert.equal(pgid, pid, 'the spawn is not a process-group leader; terminateDockerMcpGatewayGroup would miss it');

  process.kill(-pgid, 'SIGTERM');
  const gone = await waitUntil(() => !alive(pid), 5000);
  assert.ok(gone, 'a process-group TERM did not stop it');
});

test('pidsHoldingFileOpen finds the process holding the log file, and only that file', async () => {
  const logPath = join(workDir, 'holder.log');
  const otherPath = join(workDir, 'nobody.log');
  writeFileSync(otherPath, '');

  const pid = spawnHeldStdin('/bin/sleep', ['20'], logPath);
  await sleep(1200);

  const holders = await pidsHoldingFileOpen(logPath, [pid, process.pid]);
  assert.ok(holders.has(pid), 'the spawned process was not seen holding its log file open');

  const none = await pidsHoldingFileOpen(otherPath, [pid, process.pid]);
  assert.equal(none.size, 0, 'a file nobody holds open reported holders');

  process.kill(pid, 'SIGTERM');
});

test('macManagedOrphan is true only for a gateway holding this Mac log file open', async () => {
  const listener = { pid: 4242, pgid: 4242, ppid: 1, command: 'docker mcp gateway run --port 8080 --transport streaming --profile default' };

  // Ours: a process in the group holds THIS Mac data root's gateway log open.
  // The fixture has to name the same file the supervisor checks, or it proves
  // nothing — keying it with any other path is how this test first passed while
  // the real answer was false.
  const mine = parseDockerMcpGatewayProcess(
    listener,
    [listener],
    new Map([[4242, new Set([dockerMcpGatewayLogFile])]])
  );
  assert.equal(mine.macManagedOrphan, true, 'our own orphaned gateway was not recognised, so it could not be reclaimed');
  assert.equal(mine.profile, 'default');
  assert.equal(mine.port, 8080);

  // A gateway holding some OTHER file open is not ours either.
  const elsewhere = parseDockerMcpGatewayProcess(
    listener,
    [listener],
    new Map([[4242, new Set(['/tmp/some-other-gateway.log'])]])
  );
  assert.equal(elsewhere.macManagedOrphan, false, 'a gateway logging elsewhere was claimed as Mac-managed');

  // Somebody else's gateway: same command, nothing holding our log file.
  const theirs = parseDockerMcpGatewayProcess(listener, [listener], new Map());
  assert.equal(theirs.macManagedOrphan, false, 'an unrelated gateway was claimed as Mac-managed');

  // A process that is not a gateway at all is not parsed.
  assert.equal(parseDockerMcpGatewayProcess({ ...listener, command: '/bin/sleep 20' }, [], new Map()), null);
});
