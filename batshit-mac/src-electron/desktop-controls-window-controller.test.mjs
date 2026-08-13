import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DESKTOP_CONTROLS_COMMANDS } from './desktop-controls-contract.mjs';
import { DesktopControlsWindowController } from './desktop-controls-window-controller.mjs';

let nextContentsId = 100;

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextContentsId++;
    this.destroyed = false;
  }
  isDestroyed() { return this.destroyed; }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.visible = false;
    this.allWorkspaces = false;
    this.calls = [];
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(value) { this.bounds = { ...value }; this.calls.push(['setBounds', value]); }
  setResizable(value) { this.calls.push(['setResizable', value]); }
  setMinimumSize(width, height) { this.calls.push(['setMinimumSize', width, height]); }
  setMovable(value) { this.calls.push(['setMovable', value]); }
  setSkipTaskbar(value) { this.calls.push(['setSkipTaskbar', value]); }
  setAlwaysOnTop(...value) { this.calls.push(['setAlwaysOnTop', ...value]); }
  setVisibleOnAllWorkspaces(value, options) {
    this.allWorkspaces = value;
    this.calls.push(['setVisibleOnAllWorkspaces', value, options]);
  }
  isVisibleOnAllWorkspaces() { return this.allWorkspaces; }
  showInactive() { this.visible = true; this.calls.push(['showInactive']); }
  hide() { this.visible = false; this.calls.push(['hide']); }
  isVisible() { return this.visible; }
  async loadURL(url) { this.loadedUrl = url; }
  destroy() {
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit('closed');
  }
}

function fixture({ platform = 'darwin', rendererReadyTimeoutMs = 15_000 } = {}) {
  const displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1200, height: 800 } },
    { id: 2, workArea: { x: -1000, y: 0, width: 1000, height: 700 } }
  ];
  const screen = new EventEmitter();
  screen.getAllDisplays = () => displays;
  screen.getPrimaryDisplay = () => displays[0];
  screen.getDisplayMatching = (bounds) => bounds.x < 0 ? displays[1] : displays[0];
  const goon = { active: true, adjustMode: false };
  const adjusts = [];
  const events = [];
  const persisted = [];
  const roles = new Map();
  const controller = new DesktopControlsWindowController({
    BrowserWindow: FakeWindow,
    screen,
    platform,
    preloadPath: '/tmp/preload.cjs',
    controlsUrl: 'http://127.0.0.1:5620/desktop-controls',
    stateFilePath: '/tmp/controls-state.json',
    registerWindowRole(contents, role) {
      roles.set(contents.id, role);
      return () => roles.delete(contents.id);
    },
    configureControlsWebContents() {},
    getDesktopGoonState: () => goon,
    setAdjust: (enabled, source) => {
      goon.adjustMode = enabled;
      adjusts.push([enabled, source]);
    },
    emitState: (event) => events.push(event),
    readState: async () => null,
    writeState: async (_path, value) => {
      persisted.push(value);
      return value;
    },
    rendererReadyTimeoutMs
  });
  return { controller, goon, adjusts, events, persisted, roles };
}

test('controls window is secure, movable, compactly resizable, and shown only after route readiness', async () => {
  const { controller, roles } = fixture();
  await controller.open({ workspace: 'current-workspace' });
  const window = controller.window;
  assert.equal(window.loadedUrl, 'http://127.0.0.1:5620/desktop-controls');
  assert.equal(window.options.frame, false);
  assert.equal(window.options.transparent, true);
  assert.equal(window.options.resizable, true);
  assert.equal(window.options.movable, true);
  assert.equal(window.options.alwaysOnTop, true);
  assert.ok(window.options.width >= 400);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(roles.get(window.webContents.id), 'controls');
  assert.equal(window.isVisible(), false);
  await controller.handleCommand('controls', DESKTOP_CONTROLS_COMMANDS.rendererReady, {});
  assert.equal(window.isVisible(), true);
  assert.deepEqual(
    window.calls.find((entry) => entry[0] === 'setAlwaysOnTop'),
    ['setAlwaysOnTop', true, 'status']
  );
  assert.deepEqual(
    window.calls.find((entry) => entry[0] === 'setMinimumSize'),
    ['setMinimumSize', 400, 56]
  );
});

test('hiding the island exits Adjust while Escape exits Adjust and keeps the island', async () => {
  const { controller, goon, adjusts } = fixture();
  await controller.open();
  await controller.rendererDidBecomeReady();
  await controller.setAdjustIntent(true);
  assert.equal(goon.adjustMode, true);
  await controller.hide('shortcut');
  assert.equal(goon.adjustMode, false);
  assert.equal(controller.window.isVisible(), false);

  await controller.show('shortcut');
  await controller.setAdjustIntent(true);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  controller.window.webContents.emit('before-input-event', event, {
    type: 'keyDown',
    key: 'Escape'
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.prevented, true);
  assert.equal(goon.adjustMode, false);
  assert.equal(controller.window.isVisible(), true);
  assert.equal(adjusts.at(-1)[1], 'escape');
});

test('main projection is pushed into state without polling', async () => {
  const { controller, events } = fixture();
  await controller.open();
  const projected = await controller.handleCommand('main', DESKTOP_CONTROLS_COMMANDS.updateState, {
    state: { sessionId: 's1', clips: { count: 2 }, voice: { listening: true } }
  });
  assert.deepEqual(projected.projection, {
    sessionId: 's1',
    clips: { count: 2 },
    voice: { listening: true }
  });
  assert.equal(Object.isFrozen(projected.projection.clips), true);
  assert.equal(events.at(-1).type, 'projection-updated');
});

test('controls forwards bounded renderer intents to the main subscription without executing them', async () => {
  const { controller, events } = fixture();
  await controller.open();
  await controller.handleCommand('controls', DESKTOP_CONTROLS_COMMANDS.sendIntent, {
    intent: 'voice.start',
    payload: { source: 'desktop-controls' }
  });
  assert.equal(events.at(-1).type, 'renderer-intent');
  assert.deepEqual(events.at(-1).detail, {
    intent: 'voice.start',
    payload: { source: 'desktop-controls' }
  });
  assert.equal(Object.isFrozen(events.at(-1).detail.payload), true);
});

test('controls placement persists only display ID and bounds and reclamps on display changes', async () => {
  const { controller, persisted } = fixture();
  await controller.open();
  controller.window.setBounds({ x: -5000, y: 9000, width: 400, height: 72 });
  await controller.handleDisplayChanged();
  assert.deepEqual(controller.window.bounds, { x: -1000, y: 628, width: 400, height: 72 });
  assert.deepEqual(Object.keys(persisted.at(-1)).sort(), ['bounds', 'displayId', 'schemaVersion']);
});

test('workspace changes apply identically on macOS and avoid Mac APIs on Windows', async () => {
  const mac = fixture();
  await mac.controller.open({ workspace: 'current-workspace' });
  await mac.controller.syncWorkspace('all-workspaces');
  assert.equal(mac.controller.window.isVisibleOnAllWorkspaces(), true);
  assert.equal(mac.controller.getState().workspacePolicy.matches, true);

  const windows = fixture({ platform: 'win32' });
  await windows.controller.open({ workspace: 'all-workspaces' });
  assert.equal(
    windows.controller.window.calls.some(([name]) => name === 'setVisibleOnAllWorkspaces'),
    false
  );
});

test('controls renderer readiness has a bounded failure path that exits Adjust', async () => {
  const { controller, adjusts, events } = fixture({ rendererReadyTimeoutMs: 5 });
  await controller.open();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(controller.window, null);
  assert.deepEqual(adjusts.at(-1), [false, 'controls-closed']);
  assert.equal(events.at(-1).type, 'controls-renderer-ready-timeout');
});
