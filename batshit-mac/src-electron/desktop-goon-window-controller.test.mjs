import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DESKTOP_GOON_COMMANDS } from './desktop-goon-contract.mjs';
import { DesktopGoonWindowController } from './desktop-goon-window-controller.mjs';

let nextContentsId = 10;

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextContentsId++;
    this.destroyed = false;
    this.visible = false;
    this.visibleOnAllWorkspaces = false;
    this.messages = [];
    this.sent = [];
  }
  isDestroyed() { return this.destroyed; }
  postMessage(channel, message, ports) { this.messages.push({ channel, message, ports }); }
  send(channel, message) { this.sent.push({ channel, message }); }
}

class FakeWindow extends EventEmitter {
  static created = [];
  constructor(options) {
    super();
    this.options = options;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.calls = [];
    FakeWindow.created.push(this);
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; this.calls.push(['setBounds', bounds]); }
  setHasShadow(value) { this.calls.push(['setHasShadow', value]); }
  setResizable(value) { this.calls.push(['setResizable', value]); }
  setSkipTaskbar(value) { this.calls.push(['setSkipTaskbar', value]); }
  setAlwaysOnTop(...value) { this.calls.push(['setAlwaysOnTop', ...value]); }
  setVisibleOnAllWorkspaces(value, options) {
    this.visibleOnAllWorkspaces = value;
    this.calls.push(['setVisibleOnAllWorkspaces', value, options]);
  }
  isVisibleOnAllWorkspaces() { return this.visibleOnAllWorkspaces; }
  setIgnoreMouseEvents(...value) { this.calls.push(['setIgnoreMouseEvents', ...value]); }
  showInactive() { this.visible = true; this.calls.push(['showInactive']); }
  show() { this.visible = true; this.calls.push(['show']); }
  hide() { this.visible = false; this.calls.push(['hide']); }
  isVisible() { return this.visible; }
  focus() { this.calls.push(['focus']); }
  async loadURL(url) { this.loadedUrl = url; }
  destroy() { this.destroyed = true; this.webContents.destroyed = true; this.emit('closed'); }
}

class FakeMessageChannel {
  constructor() {
    this.port1 = { closed: false, close() { this.closed = true; } };
    this.port2 = { closed: false, close() { this.closed = true; } };
  }
}

function fixture({
  platform = 'darwin',
  shortcutRegisters = true,
  bridgeReadyTimeoutMs,
  rendererReadyTimeoutMs
} = {}) {
  FakeWindow.created = [];
  const displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1200, height: 800 } },
    { id: 2, workArea: { x: -1000, y: 0, width: 1000, height: 700 } }
  ];
  const screen = new EventEmitter();
  screen.getAllDisplays = () => displays;
  screen.getPrimaryDisplay = () => displays[0];
  screen.getDisplayMatching = (bounds) => bounds.x < 0 ? displays[1] : displays[0];
  const registered = new Map();
  const globalShortcut = {
    register(accelerator, callback) {
      const accepted = typeof shortcutRegisters === 'function'
        ? shortcutRegisters(accelerator)
        : shortcutRegisters;
      if (!accepted) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) { registered.delete(accelerator); }
  };
  const mainWindow = new FakeWindow({ x: 10, y: 10, width: 900, height: 700 });
  const statuses = [];
  const returns = [];
  const returnActiveStates = [];
  const persisted = [];
  const roles = new Map();
  const controlsToggles = [];
  const controlsOpens = [];
  const controlsCloses = [];
  let controller;
  controller = new DesktopGoonWindowController({
    BrowserWindow: FakeWindow,
    MessageChannelMain: FakeMessageChannel,
    screen,
    globalShortcut,
    platform,
    preloadPath: '/tmp/preload.cjs',
    desktopUrl: 'http://127.0.0.1:5620/desktop-goon',
    stateFilePath: '/tmp/state.json',
    registerWindowRole(contents, role) {
      roles.set(contents.id, role);
      return () => roles.delete(contents.id);
    },
    configureDesktopWebContents() {},
    getMainWindow: () => mainWindow,
    emitStatus: (status) => statuses.push(status),
    openDesktopControls: (options) => controlsOpens.push(options),
    closeDesktopControls: (options) => controlsCloses.push(options),
    toggleDesktopControls: (source) => controlsToggles.push(source),
    requestReturnToBatshit: (reason) => {
      returns.push(reason);
      returnActiveStates.push(controller.getStatus().active);
    },
    readState: async () => null,
    writeState: async (_path, state) => {
      persisted.push(state);
      return Object.freeze({ ...state, bounds: Object.freeze({ ...state.bounds }) });
    },
    ...(bridgeReadyTimeoutMs === undefined ? {} : { bridgeReadyTimeoutMs }),
    ...(rendererReadyTimeoutMs === undefined ? {} : { rendererReadyTimeoutMs })
  });
  return {
    controller,
    mainWindow,
    screen,
    registered,
    statuses,
    returns,
    returnActiveStates,
    persisted,
    roles,
    controlsToggles,
    controlsOpens,
    controlsCloses
  };
}

test('Mac policy creates a secure inactive transparent window and shows only after renderer ready', async () => {
  const { controller, roles } = fixture();
  await controller.open({
    preferences: { fullHeight: true, normalizedWidth: 0.4, workspace: 'all-workspaces' }
  });
  const window = controller.window;
  assert.equal('type' in window.options, false);
  assert.equal(window.options.transparent, true);
  assert.equal(window.options.frame, false);
  assert.equal(window.options.resizable, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.deepEqual(window.bounds, { x: 720, y: 0, width: 480, height: 800 });
  assert.equal(roles.get(window.webContents.id), 'desktop');
  assert.equal(window.calls.some(([name]) => name === 'showInactive'), false);
  await controller.handleCommand('desktop', DESKTOP_GOON_COMMANDS.bridgeReady, {});
  assert.equal(window.calls.some(([name]) => name === 'showInactive'), false);
  await controller.handleCommand('desktop', DESKTOP_GOON_COMMANDS.rendererReady, {});
  assert.equal(window.calls.some(([name]) => name === 'showInactive'), true);
});

test('Windows policy never executes the Mac all-workspaces API', async () => {
  const { controller } = fixture({ platform: 'win32' });
  await controller.open({ preferences: { workspace: 'all-workspaces' } });
  assert.equal('type' in controller.window.options, false);
  assert.equal(
    controller.window.calls.some(([name]) => name === 'setVisibleOnAllWorkspaces'),
    false
  );
});

test('full-height bounds clamp and persist only display ID and DIP bounds', async () => {
  const { controller, persisted } = fixture();
  await controller.open({ preferences: { fullHeight: true } });
  await controller.setBounds({ x: -5000, y: 9000, width: 500, height: 100 });
  assert.deepEqual(controller.window.bounds, { x: -1000, y: 0, width: 500, height: 700 });
  assert.deepEqual(Object.keys(persisted.at(-1)).sort(), ['bounds', 'displayId', 'schemaVersion']);
  assert.equal('active' in persisted.at(-1), false);
});

test('normalized width intent updates live geometry while preserving the right edge', async () => {
  const { controller } = fixture();
  await controller.open();
  assert.deepEqual(controller.window.bounds, { x: 780, y: 0, width: 420, height: 800 });
  await controller.updatePreferences({ normalizedWidth: 0.5 });
  assert.deepEqual(controller.window.bounds, { x: 600, y: 0, width: 600, height: 800 });
});

test('shortcut conflicts are visible and the main recovery path remains available', async () => {
  const { controller, statuses } = fixture({ shortcutRegisters: false });
  await controller.open();
  assert.equal(controller.getStatus().shortcut.registered, false);
  assert.match(controller.getStatus().shortcut.error, /already in use/);
  assert.equal(statuses.some((status) => status.type === 'shortcut-conflict'), true);
});

test('shortcut rebinding retains the working fallback and recovers after a conflict clears', async () => {
  let allowRequested = false;
  const { controller, registered } = fixture({
    shortcutRegisters: (accelerator) =>
      accelerator === 'CommandOrControl+Shift+G' || allowRequested
  });
  await controller.open();
  assert.equal(registered.has('CommandOrControl+Shift+G'), true);

  await controller.updatePreferences({ controlsShortcut: 'CommandOrControl+Shift+H' });
  assert.equal(controller.getStatus().shortcut.registered, true);
  assert.equal(controller.getStatus().shortcut.accelerator, 'CommandOrControl+Shift+G');
  assert.equal(
    controller.getStatus().shortcut.requestedAccelerator,
    'CommandOrControl+Shift+H'
  );
  assert.equal(registered.has('CommandOrControl+Shift+G'), true);

  allowRequested = true;
  await controller.registerControlsShortcut('CommandOrControl+Shift+H');
  assert.equal(controller.getStatus().shortcut.accelerator, 'CommandOrControl+Shift+H');
  assert.equal(controller.getStatus().shortcut.error, null);
  assert.equal(registered.has('CommandOrControl+Shift+G'), false);
  assert.equal(registered.has('CommandOrControl+Shift+H'), true);
});

test('global shortcut toggles the controls island without entering Adjust', async () => {
  const { controller, registered, controlsToggles } = fixture();
  await controller.open();
  registered.get('CommandOrControl+Shift+G')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controlsToggles, ['global-shortcut']);
  assert.equal(controller.getStatus().adjustMode, false);
});

test('state ports connect only after both roles are ready and replace deterministically', async () => {
  const { controller, mainWindow } = fixture();
  await controller.open();
  controller.requestStatePort();
  assert.equal(mainWindow.webContents.messages.length, 0);
  await controller.bridgeDidBecomeReady();
  assert.equal(mainWindow.webContents.messages.length, 1);
  assert.equal(controller.window.webContents.messages.length, 1);
  const firstGeneration = controller.portGeneration;
  controller.requestStatePort();
  assert.equal(controller.portGeneration, firstGeneration + 1);
  assert.equal(mainWindow.webContents.sent.at(-1).message.reason, 'port-replaced');
});

test('renderer readiness is ordered behind bridge setup and initialization failure returns ownership', async () => {
  const { controller, returns, returnActiveStates, statuses } = fixture();
  await controller.open();
  await assert.rejects(
    () => controller.handleCommand('desktop', DESKTOP_GOON_COMMANDS.rendererReady, {}),
    /bridge must be ready/
  );
  await controller.handleCommand('desktop', DESKTOP_GOON_COMMANDS.bridgeReady, {});
  await controller.handleCommand('desktop', DESKTOP_GOON_COMMANDS.rendererFailed, {
    message: 'Transparent renderer failed to initialize.'
  });
  assert.deepEqual(returns, ['desktop-renderer-initialization-failed']);
  assert.deepEqual(returnActiveStates, [false]);
  assert.equal(
    statuses.some((status) => status.type === 'desktop-renderer-initialization-failed'),
    true
  );
  assert.equal(controller.getStatus().active, false);
});

test('bridge readiness starts a bounded renderer-ready timeout with Dock recovery', async () => {
  const { controller, returns, statuses } = fixture({ rendererReadyTimeoutMs: 0 });
  await controller.open();
  await controller.bridgeDidBecomeReady();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(returns, ['desktop-renderer-ready-timeout']);
  assert.equal(controller.getStatus().active, false);
  assert.equal(
    statuses.some((status) => status.type === 'desktop-renderer-ready-timeout'),
    true
  );
});

test('unexpected Desktop close recovers while intentional close and app quit do not remount', async () => {
  const first = fixture();
  await first.controller.open();
  first.controller.window.emit('closed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(first.returns, ['desktop-window-closed']);
  assert.deepEqual(first.returnActiveStates, [false]);

  const requested = fixture();
  await requested.controller.open();
  await requested.controller.returnToBatshit('desktop-button');
  assert.deepEqual(requested.returns, ['desktop-button']);
  assert.deepEqual(requested.returnActiveStates, [false]);

  const second = fixture();
  await second.controller.open();
  await second.controller.prepareForQuit();
  assert.deepEqual(second.returns, []);
  assert.equal(second.controller.getStatus().active, false);

  const intentional = fixture();
  await intentional.controller.open();
  await intentional.controller.handleCommand('main', DESKTOP_GOON_COMMANDS.close, {
    reason: 'controls-island'
  });
  assert.deepEqual(intentional.returns, []);
  assert.equal(intentional.controller.getStatus().active, false);
});

test('a recovered Desktop Goon can immediately open a fresh renderer and state port', async () => {
  const { controller } = fixture();
  await controller.open();
  const firstWindow = controller.window;
  await controller.returnToBatshit('controls-return');

  await controller.open();
  await controller.bridgeDidBecomeReady();
  controller.requestStatePort();
  await controller.rendererDidBecomeReady();

  assert.notEqual(controller.window, firstWindow);
  assert.equal(controller.getStatus().active, true);
  assert.equal(controller.getStatus().portConnected, true);
});
