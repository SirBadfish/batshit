import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDesktopControlsWorkspacePolicy,
  clampDesktopControlsBounds,
  defaultDesktopControlsBounds,
  resolveDesktopControlsWindowPolicy
} from './desktop-controls-window-policy.mjs';

test('Desktop Controls policy is movable, compactly resizable, always-on-top, and platform-safe', () => {
  const mac = resolveDesktopControlsWindowPolicy('darwin', 'current-workspace');
  assert.equal(mac.supported, true);
  assert.equal(mac.browserWindowOptions.movable, true);
  assert.equal(mac.browserWindowOptions.resizable, true);
  assert.equal(mac.browserWindowOptions.alwaysOnTop, true);
  assert.equal(mac.browserWindowOptions.skipTaskbar, true);
  assert.equal(mac.browserWindowOptions.acceptFirstMouse, true);
  assert.equal('type' in mac.browserWindowOptions, false);
  assert.equal(mac.effects.alwaysOnTopLevel, 'status');

  const windows = resolveDesktopControlsWindowPolicy('win32', 'all-workspaces');
  assert.equal(windows.browserWindowOptions.thickFrame, false);
  assert.equal(windows.effects.alwaysOnTopLevel, 'floating');
  assert.equal('acceptFirstMouse' in windows.browserWindowOptions, false);
});

test('Desktop Controls bounds remain visible across negative and small work areas', () => {
  const area = { x: -900, y: 20, width: 900, height: 600 };
  const initial = defaultDesktopControlsBounds(area);
  assert.deepEqual(initial, { x: -584, y: 44, width: 560, height: 88 });
  assert.deepEqual(
    clampDesktopControlsBounds(
      { x: 5000, y: -5000, width: 2000, height: 1000 },
      area
    ),
    area
  );
});

test('Desktop Controls use the same explicit/read-back macOS workspace policy as the Goon', () => {
  const window = {
    applied: false,
    setVisibleOnAllWorkspaces(value) { this.applied = value; },
    isVisibleOnAllWorkspaces() { return this.applied; }
  };
  assert.equal(
    applyDesktopControlsWorkspacePolicy(window, 'darwin', 'all-workspaces').matches,
    true
  );
  assert.equal(window.applied, true);
  assert.equal(
    applyDesktopControlsWorkspacePolicy(window, 'darwin', 'current-workspace').matches,
    true
  );
  assert.equal(window.applied, false);
  assert.equal(
    applyDesktopControlsWorkspacePolicy({}, 'win32', 'all-workspaces').supported,
    false
  );
});
