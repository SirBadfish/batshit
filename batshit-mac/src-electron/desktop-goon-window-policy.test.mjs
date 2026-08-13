import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DESKTOP_GOON_PREFERENCES,
  applyDesktopWorkspacePolicy,
  clampDesktopGoonBounds,
  defaultDesktopGoonBounds,
  normalizeDesktopGoonPreferences,
  resolveDesktopGoonWindowPolicy
} from './desktop-goon-window-policy.mjs';

const workArea = { x: 100, y: 50, width: 1200, height: 800 };

test('darwin and win32 policies isolate Mac-only behavior', () => {
  const mac = resolveDesktopGoonWindowPolicy('darwin', {
    stayOnTop: true,
    workspace: 'all-workspaces'
  });
  assert.equal('type' in mac.browserWindowOptions, false);
  assert.equal(mac.effects.visibleOnAllWorkspaces, true);
  assert.equal(mac.effects.alwaysOnTopLevel, 'floating');

  const windows = resolveDesktopGoonWindowPolicy('win32', {
    stayOnTop: true,
    workspace: 'all-workspaces'
  });
  assert.equal('type' in windows.browserWindowOptions, false);
  assert.equal(windows.effects.visibleOnAllWorkspaces, null);
  assert.equal(windows.capabilities.allWorkspaces, false);
  assert.equal(windows.browserWindowOptions.transparent, true);
  assert.equal(windows.browserWindowOptions.resizable, false);
  assert.equal(windows.browserWindowOptions.skipTaskbar, true);
});

test('Electron preference defaults stay in exact parity with the Desktop Goon contract', () => {
  assert.deepEqual(DEFAULT_DESKTOP_GOON_PREFERENCES, {
    fullHeight: true,
    normalizedWidth: 0.35,
    stayOnTop: true,
    clickThrough: false,
    controlsShortcut: 'CommandOrControl+Shift+G',
    workspace: 'current-workspace'
  });
  assert.deepEqual(Object.keys(DEFAULT_DESKTOP_GOON_PREFERENCES).sort(), [
    'clickThrough',
    'controlsShortcut',
    'fullHeight',
    'normalizedWidth',
    'stayOnTop',
    'workspace'
  ]);
});

test('unsupported platforms return a capability result instead of Mac assumptions', () => {
  const linux = resolveDesktopGoonWindowPolicy('linux');
  assert.equal(linux.supported, false);
  assert.match(linux.reason, /managed Mac app/);
});

test('full height locks y and height while preserving bounded width and x', () => {
  const bounds = clampDesktopGoonBounds({
    bounds: { x: 1150, y: 500, width: 500, height: 300 },
    workArea,
    preferences: { fullHeight: true, normalizedWidth: 0.3 }
  });
  assert.deepEqual(bounds, { x: 800, y: 50, width: 500, height: 800 });
});

test('default and restored bounds remain inside negative-origin and small work areas', () => {
  const area = { x: -900, y: 20, width: 900, height: 600 };
  const initial = defaultDesktopGoonBounds(area, { normalizedWidth: 0.25 });
  assert.ok(initial.x >= area.x);
  assert.ok(initial.x + initial.width <= area.x + area.width);
  const restored = clampDesktopGoonBounds({
    bounds: { x: 5000, y: -5000, width: 4000, height: 4000 },
    workArea: area,
    preferences: {}
  });
  assert.deepEqual(restored, area);
});

test('preferences reject capability and type expansion', () => {
  assert.throws(() => normalizeDesktopGoonPreferences({ nativeResize: true }), /Unsupported/);
  assert.throws(() => normalizeDesktopGoonPreferences({ normalizedWidth: 2 }), /between 0.1 and 1/);
  assert.throws(
    () => normalizeDesktopGoonPreferences({ workspace: 'magic' }),
    /current-workspace or all-workspaces/
  );
  assert.throws(
    () => normalizeDesktopGoonPreferences({ editShortcut: 'CommandOrControl+Shift+G' }),
    /Unsupported Desktop Goon preference/
  );
  assert.throws(
    () => normalizeDesktopGoonPreferences({ controlsShortcut: 42 }),
    /controlsShortcut must be a bounded accelerator string/
  );
});

test('macOS workspace policy uses explicit setter/readback while Windows remains a no-op', () => {
  const calls = [];
  const macWindow = {
    visible: false,
    setVisibleOnAllWorkspaces(value, options) {
      this.visible = value;
      calls.push([value, options]);
    },
    isVisibleOnAllWorkspaces() { return this.visible; }
  };
  const current = applyDesktopWorkspacePolicy(macWindow, 'darwin', {
    workspace: 'current-workspace'
  });
  assert.equal(current.matches, true);
  assert.deepEqual(calls.at(-1), [false, {
    visibleOnFullScreen: false,
    skipTransformProcessType: false
  }]);
  const all = applyDesktopWorkspacePolicy(macWindow, 'darwin', {
    workspace: 'all-workspaces'
  });
  assert.equal(all.appliedAllWorkspaces, true);
  assert.deepEqual(calls.at(-1), [true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: false
  }]);

  const windows = applyDesktopWorkspacePolicy({}, 'win32', {
    workspace: 'all-workspaces'
  });
  assert.equal(windows.supported, false);
  assert.equal(windows.appliedAllWorkspaces, null);
});

test('macOS workspace readback mismatch fails visibly', () => {
  assert.throws(
    () => applyDesktopWorkspacePolicy({
      setVisibleOnAllWorkspaces() {},
      isVisibleOnAllWorkspaces() { return true; }
    }, 'darwin', { workspace: 'current-workspace' }),
    /readback mismatch/
  );
});
