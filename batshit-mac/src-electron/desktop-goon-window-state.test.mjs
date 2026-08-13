import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DESKTOP_GOON_WINDOW_STATE_VERSION,
  readDesktopGoonWindowState,
  validateDesktopGoonWindowState,
  writeDesktopGoonWindowState
} from './desktop-goon-window-state.mjs';

const state = {
  schemaVersion: DESKTOP_GOON_WINDOW_STATE_VERSION,
  displayId: '42',
  bounds: { x: -100, y: 20, width: 500, height: 700 }
};

test('machine-local window state accepts only display ID and DIP bounds', () => {
  assert.deepEqual(validateDesktopGoonWindowState(state), state);
  assert.throws(
    () => validateDesktopGoonWindowState({ ...state, active: true }),
    /Unsupported.*active/
  );
  assert.throws(
    () => validateDesktopGoonWindowState({ ...state, goonId: 'goon-1' }),
    /Unsupported.*goonId/
  );
});

test('window state is published atomically with private permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-desktop-goon-state-'));
  const target = join(root, 'nested', 'desktop-goon-window-state-v1.json');
  await writeDesktopGoonWindowState(target, state);
  assert.deepEqual(await readDesktopGoonWindowState(target), state);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, 'nested')), ['desktop-goon-window-state-v1.json']);
});

test('missing state is empty while corruption fails visibly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-desktop-goon-state-invalid-'));
  assert.equal(await readDesktopGoonWindowState(join(root, 'missing.json')), null);
  const target = join(root, 'invalid.json');
  await writeFile(target, '{broken');
  await assert.rejects(() => readDesktopGoonWindowState(target), /invalid JSON/);
});
