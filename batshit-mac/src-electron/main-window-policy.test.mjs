import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMainWindowSizePolicy, restoreMainWindowBounds } from './main-window-policy.mjs';

test('main window preserves the narrow chat column between both persistent rails', () => {
  const policy = resolveMainWindowSizePolicy();

  assert.deepEqual(policy, {
    width: 1600,
    height: 1000,
    minWidth: 576,
    minHeight: 720
  });
  assert.equal(policy.minWidth - 48 - 48, 480);
});

test('a remembered window is restored as saved when it still fits its display', () => {
  const workArea = { x: 0, y: 25, width: 3840, height: 2135 };
  const saved = { x: 480, y: 220, width: 1600, height: 1000 };
  assert.deepEqual(restoreMainWindowBounds({ saved, workArea }), saved);
});

test('a remembered window is shrunk to the minimum usable chat width, never below it', () => {
  const workArea = { x: 0, y: 25, width: 3840, height: 2135 };
  const restored = restoreMainWindowBounds({
    saved: { x: 0, y: 25, width: 200, height: 200 },
    workArea
  });
  assert.equal(restored.width, 576, 'both rails plus the 480px chat column must survive');
  assert.equal(restored.height, 720);
});

test('a window saved larger than the current screen is fitted to it', () => {
  const restored = restoreMainWindowBounds({
    saved: { x: 0, y: 0, width: 3400, height: 2000 },
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  });
  assert.equal(restored.width, 1440);
  assert.equal(restored.height, 875);
});

test('a window saved on a disconnected display is pulled back into reach', () => {
  // The second screen is gone, so the saved origin is far outside the work area.
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const restored = restoreMainWindowBounds({
    saved: { x: 4200, y: 1800, width: 1200, height: 800 },
    workArea
  });
  assert.ok(
    restored.x < workArea.x + workArea.width,
    'the window must not start beyond the right edge of the only screen'
  );
  assert.ok(
    restored.x + restored.width > workArea.x,
    'part of the window must remain on screen'
  );
  assert.ok(restored.y >= workArea.y, 'the title bar must not sit above the work area');
  assert.ok(
    restored.y < workArea.y + workArea.height,
    'the title bar must stay reachable with the pointer'
  );
});

test('a window saved above the menu bar cannot hide its own title bar', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const restored = restoreMainWindowBounds({ saved: { x: 100, y: -500, width: 900, height: 800 }, workArea });
  assert.equal(restored.y, 25);
});

test('unusable saved bounds are rejected rather than quietly corrected', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  assert.throws(() => restoreMainWindowBounds({ saved: null, workArea }), /must be an object/);
  assert.throws(
    () => restoreMainWindowBounds({ saved: { x: 0, y: 0, width: 0, height: 100 }, workArea }),
    /positive size/
  );
  assert.throws(
    () => restoreMainWindowBounds({ saved: { x: 0, y: 0, width: 1.5, height: 100 }, workArea }),
    /safe integer/
  );
  assert.throws(
    () => restoreMainWindowBounds({ saved: { x: 0, y: 0, width: 100, height: 100, rogue: 1 }, workArea }),
    /Unsupported main window bounds field/
  );
});
