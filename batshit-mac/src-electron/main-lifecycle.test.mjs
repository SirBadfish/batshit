import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const mainSource = await readFile(join(moduleDir, 'main.mjs'), 'utf8');

test('intentional shutdown notifies and hides the renderer before service teardown', () => {
  const stopStart = mainSource.indexOf('async function stopRuntimeBeforeQuit');
  const notify = mainSource.indexOf('notifyRendererShutdown(reason);', stopStart);
  const stop = mainSource.indexOf("await runSupervisor('stop');", stopStart);

  assert.notEqual(stopStart, -1);
  assert.notEqual(notify, -1);
  assert.notEqual(stop, -1);
  assert.ok(notify < stop);
  assert.match(mainSource, /window\.webContents\.send\(appShutdownChannel/);
  assert.match(mainSource, /window\.hide\(\);/);
});

test('red-X close is identified separately from other application quit paths', () => {
  assert.match(mainSource, /pendingShutdownReason = 'window-close';/);
  assert.match(mainSource, /stopRuntimeBeforeQuit\(pendingShutdownReason\)/);
});
