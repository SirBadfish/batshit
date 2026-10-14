import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = new URL('./service-child.mjs', import.meta.url).href;
const unix = process.platform !== 'win32';

async function fixture(t, signal, { group = false, delay = 0 } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'batshit-service-signal-'));
  const log = join(folder, 'child.log');
  const childSource = `
    const fs = require('node:fs');
    const log = ${JSON.stringify(log)};
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => {
        fs.appendFileSync(log, signal + '\\n');
        if (signal !== 'SIGHUP') setTimeout(() => process.exit(0), ${delay});
      });
    }
    setInterval(() => {}, 1000);
    console.log('ready');
  `;
  const wrapperSource = `
    import { startChild } from ${JSON.stringify(helper)};
    const { child, exited } = startChild('fixture', {
      command: process.execPath, args: ['-e', ${JSON.stringify(childSource)}],
      cwd: ${JSON.stringify(folder)}, env: process.env
    }, ['ignore', 'pipe', 'pipe']);
    child.stdout.once('data', () => process.send({ ready: true, pid: child.pid }));
    const code = await exited;
    process.send({ exited: code }, () => process.disconnect());
    process.exitCode = code;
  `;
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperSource], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let ended = false;
  const exit = once(wrapper, 'exit').then(([code, sig]) => { ended = true; return [code, sig]; });
  t.after(async () => {
    if (!ended) {
      // Only this test's freshly created, unreaped group; never a runtime PID.
      try { process.kill(-wrapper.pid, 'SIGKILL'); } catch {}
      await exit;
    }
    await rm(folder, { recursive: true, force: true });
  });
  const [ready] = await once(wrapper, 'message');
  assert.equal(ready.ready, true);
  const completion = once(wrapper, 'message');
  const before = Date.now();
  if (group) process.kill(-wrapper.pid, signal);
  else wrapper.kill(signal);
  const [result] = await completion;
  assert.equal(result.exited, 0);
  assert.deepEqual(await exit, [0, null]);
  return { signals: (await readFile(log, 'utf8')).trim().split('\n'), elapsed: Date.now() - before };
}

test('HUP requests TERM from a child which ignores HUP', { skip: !unix, timeout: 5000 }, async (t) => {
  assert.deepEqual((await fixture(t, 'SIGHUP')).signals, ['SIGTERM']);
});

test('a foreground-group HUP still ends the HUP-ignoring child through TERM', { skip: !unix, timeout: 5000 }, async (t) => {
  assert.ok((await fixture(t, 'SIGHUP', { group: true })).signals.includes('SIGTERM'));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} remains unchanged`, { skip: !unix, timeout: 5000 }, async (t) => {
    assert.deepEqual((await fixture(t, signal)).signals, [signal]);
  });
}

test('the wrapper waits for the child to finish its graceful stop', { skip: !unix, timeout: 5000 }, async (t) => {
  const result = await fixture(t, 'SIGHUP', { delay: 250 });
  assert.ok(result.elapsed >= 200);
  assert.deepEqual(result.signals, ['SIGTERM']);
});
