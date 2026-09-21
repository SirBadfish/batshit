import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAIN_WINDOW_STATE_VERSION,
  readMainWindowState,
  validateMainWindowState,
  writeMainWindowState
} from './main-window-state.mjs';

const BOUNDS = { x: 480, y: 220, width: 1600, height: 1000 };

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'batshit-window-state-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a first run has no saved window state and that is not an error', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readMainWindowState(join(dir, 'missing.json')), null);
  });
});

test('window state survives a write and read unchanged', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'main-window-state-v1.json');
    await writeMainWindowState(filePath, {
      schemaVersion: MAIN_WINDOW_STATE_VERSION,
      bounds: BOUNDS,
      maximized: true
    });
    const restored = await readMainWindowState(filePath);
    assert.deepEqual(restored, {
      schemaVersion: MAIN_WINDOW_STATE_VERSION,
      bounds: BOUNDS,
      maximized: true
    });
    const stats = await stat(filePath);
    assert.equal(stats.mode & 0o777, 0o600, 'window state is written private to the user');
  });
});

test('a corrupt or foreign state file is reported instead of silently replaced', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'state.json');
    await writeFile(filePath, '{ not json', 'utf8');
    await assert.rejects(() => readMainWindowState(filePath), /invalid JSON/);

    await writeFile(filePath, JSON.stringify({ schemaVersion: 'other/v9', bounds: BOUNDS, maximized: false }));
    await assert.rejects(() => readMainWindowState(filePath), /must use main-window-state\/v1/);
  });
});

test('window state rejects unknown fields and a non-boolean maximized flag', () => {
  assert.throws(
    () => validateMainWindowState({ schemaVersion: MAIN_WINDOW_STATE_VERSION, bounds: BOUNDS, maximized: 'yes' }),
    /maximized must be a boolean/
  );
  assert.throws(
    () =>
      validateMainWindowState({
        schemaVersion: MAIN_WINDOW_STATE_VERSION,
        bounds: BOUNDS,
        maximized: false,
        display: 'main'
      }),
    /Unsupported main window state field/
  );
});

test('a failed write leaves no temporary file behind', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'state.json');
    await assert.rejects(() =>
      writeMainWindowState(filePath, { schemaVersion: MAIN_WINDOW_STATE_VERSION, bounds: null, maximized: false })
    );
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(dir), [], 'validation must fail before anything is written');
  });
});

test('a rewrite replaces the previous state atomically', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'state.json');
    await writeMainWindowState(filePath, {
      schemaVersion: MAIN_WINDOW_STATE_VERSION,
      bounds: BOUNDS,
      maximized: false
    });
    await writeMainWindowState(filePath, {
      schemaVersion: MAIN_WINDOW_STATE_VERSION,
      bounds: { ...BOUNDS, width: 1200 },
      maximized: false
    });
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(raw.bounds.width, 1200);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(dir), ['state.json'], 'no .tmp file may survive a rewrite');
  });
});
