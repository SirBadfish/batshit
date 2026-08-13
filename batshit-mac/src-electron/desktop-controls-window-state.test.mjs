import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DESKTOP_CONTROLS_WINDOW_STATE_VERSION,
  readDesktopControlsWindowState,
  validateDesktopControlsWindowState,
  writeDesktopControlsWindowState
} from './desktop-controls-window-state.mjs';

const state = {
  schemaVersion: DESKTOP_CONTROLS_WINDOW_STATE_VERSION,
  displayId: '9',
  bounds: { x: 40, y: 50, width: 560, height: 72 }
};

test('Desktop Controls state contains only machine-local display and DIP bounds', () => {
  assert.deepEqual(validateDesktopControlsWindowState(state), state);
  assert.throws(
    () => validateDesktopControlsWindowState({ ...state, visible: true }),
    /Unsupported.*visible/
  );
  assert.throws(
    () => validateDesktopControlsWindowState({ ...state, adjustActive: true }),
    /Unsupported.*adjustActive/
  );
  assert.throws(
    () => validateDesktopControlsWindowState({ ...state, displayId: Number.NaN }),
    /displayId/
  );
});

test('Desktop Controls state writes atomically with 0600 permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-desktop-controls-state-'));
  const target = join(root, 'nested', 'state.json');
  await writeDesktopControlsWindowState(target, state);
  assert.deepEqual(await readDesktopControlsWindowState(target), state);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, 'nested')), ['state.json']);
});
