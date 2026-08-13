import {
  DESKTOP_CONTROLS_COMMANDS,
  DESKTOP_CONTROLS_SCHEMA_VERSION
} from './desktop-controls-contract.mjs';
import {
  applyDesktopControlsWorkspacePolicy,
  clampDesktopControlsBounds,
  defaultDesktopControlsBounds,
  DESKTOP_CONTROLS_MINIMUM_HEIGHT,
  DESKTOP_CONTROLS_MINIMUM_WIDTH,
  normalizeDesktopControlsWorkspace,
  resolveDesktopControlsWindowPolicy
} from './desktop-controls-window-policy.mjs';
import {
  DESKTOP_CONTROLS_WINDOW_STATE_VERSION,
  readDesktopControlsWindowState,
  writeDesktopControlsWindowState
} from './desktop-controls-window-state.mjs';

function windowIsAlive(window) {
  return Boolean(window && !window.isDestroyed?.());
}

function displayId(display) {
  return String(display?.id ?? '');
}

function cloneAndFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  const clone = JSON.parse(JSON.stringify(value));
  const freeze = (entry) => {
    if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) {
      for (const nested of Object.values(entry)) freeze(nested);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(clone);
}

export class DesktopControlsWindowController {
  constructor({
    BrowserWindow,
    screen,
    platform = process.platform,
    preloadPath,
    controlsUrl,
    stateFilePath,
    registerWindowRole,
    configureControlsWebContents,
    getDesktopGoonState,
    setAdjust = async () => {},
    emitState = () => {},
    readState = readDesktopControlsWindowState,
    writeState = writeDesktopControlsWindowState,
    rendererReadyTimeoutMs = 15_000,
    devTools = false
  }) {
    if (typeof BrowserWindow !== 'function') throw new Error('Desktop Controls require BrowserWindow.');
    if (!screen) throw new Error('Desktop Controls require Electron screen.');
    if (typeof preloadPath !== 'string' || !preloadPath) {
      throw new Error('Desktop Controls require a preload path.');
    }
    if (typeof controlsUrl !== 'string' || !controlsUrl) {
      throw new Error('Desktop Controls require an exact renderer URL.');
    }
    if (typeof stateFilePath !== 'string' || !stateFilePath) {
      throw new Error('Desktop Controls require a machine-local state path.');
    }
    this.BrowserWindow = BrowserWindow;
    this.screen = screen;
    this.platform = platform;
    this.preloadPath = preloadPath;
    this.controlsUrl = controlsUrl;
    this.stateFilePath = stateFilePath;
    this.registerWindowRole = registerWindowRole;
    this.configureControlsWebContents = configureControlsWebContents;
    this.getDesktopGoonState = getDesktopGoonState;
    this.setAdjustCallback = setAdjust;
    this.emitStateCallback = emitState;
    this.readState = readState;
    this.writeState = writeState;
    this.rendererReadyTimeoutMs = rendererReadyTimeoutMs;
    this.devTools = devTools;

    this.window = null;
    this.unregisterControlsRole = null;
    this.workspace = 'current-workspace';
    this.workspacePolicy = null;
    this.projection = null;
    this.rendererReady = false;
    this.visibleIntent = false;
    this.machineState = null;
    this.machineStateLoaded = false;
    this.persistTimer = null;
    this.rendererReadyTimer = null;
    this.quitting = false;
    this.intentionalClose = false;
    this.displayListenersInstalled = false;
    this.boundDisplayChanged = () => this.handleDisplayChanged();
  }

  getState() {
    const goon = this.getDesktopGoonState?.() || null;
    const alive = windowIsAlive(this.window);
    const bounds = alive ? this.window.getBounds() : this.machineState?.bounds || null;
    return Object.freeze({
      schemaVersion: DESKTOP_CONTROLS_SCHEMA_VERSION,
      active: alive,
      visible: Boolean(alive && this.window.isVisible?.()),
      rendererReady: this.rendererReady,
      adjustActive: Boolean(goon?.adjustMode),
      goonActive: Boolean(goon?.active),
      workspace: this.workspace,
      workspacePolicy: this.workspacePolicy,
      projection: this.projection,
      displayId: alive && bounds
        ? displayId(this.screen.getDisplayMatching(bounds))
        : this.machineState?.displayId || null,
      bounds
    });
  }

  async emitState(type, detail = {}) {
    const event = Object.freeze({
      schemaVersion: DESKTOP_CONTROLS_SCHEMA_VERSION,
      type,
      detail: Object.freeze({ ...detail }),
      state: this.getState()
    });
    await this.emitStateCallback(event);
    return event;
  }

  async loadMachineState() {
    if (this.machineStateLoaded) return this.machineState;
    this.machineStateLoaded = true;
    try {
      this.machineState = await this.readState(this.stateFilePath);
    } catch (error) {
      this.machineState = null;
      await this.emitState('machine-state-error', {
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return this.machineState;
  }

  selectDisplay(bounds = null, preferredDisplayId = null) {
    const displays = this.screen.getAllDisplays();
    const preferred = displays.find((display) => displayId(display) === String(preferredDisplayId));
    if (preferred) return preferred;
    if (bounds) return this.screen.getDisplayMatching(bounds);
    return this.screen.getPrimaryDisplay();
  }

  resolveBounds() {
    const stored = this.machineState;
    const display = this.selectDisplay(stored?.bounds || null, stored?.displayId || null);
    return {
      display,
      bounds: stored?.bounds
        ? clampDesktopControlsBounds(stored.bounds, display.workArea)
        : defaultDesktopControlsBounds(display.workArea)
    };
  }

  installDisplayListeners() {
    if (this.displayListenersInstalled) return;
    this.displayListenersInstalled = true;
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      this.screen.on(event, this.boundDisplayChanged);
    }
  }

  removeDisplayListeners() {
    if (!this.displayListenersInstalled) return;
    this.displayListenersInstalled = false;
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      this.screen.removeListener(event, this.boundDisplayChanged);
    }
  }

  async open({ workspace = this.workspace, visible = true } = {}) {
    if (!this.getDesktopGoonState?.()?.active) {
      throw new Error('Desktop Controls cannot open without an active Desktop Goon.');
    }
    this.workspace = normalizeDesktopControlsWorkspace(workspace);
    this.visibleIntent = Boolean(visible);
    await this.loadMachineState();
    if (windowIsAlive(this.window)) {
      await this.applyPolicy();
      if (this.visibleIntent && this.rendererReady) this.window.showInactive();
      await this.emitState('shown-requested');
      return this.getState();
    }

    const policy = resolveDesktopControlsWindowPolicy(this.platform, this.workspace);
    if (!policy.supported) throw new Error(policy.reason);
    const placement = this.resolveBounds();
    const window = new this.BrowserWindow({
      ...policy.browserWindowOptions,
      ...placement.bounds,
      title: 'Batshit Desktop Controls',
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: true,
        devTools: this.devTools,
        additionalArguments: ['--batshit-window-role=controls']
      }
    });
    this.window = window;
    this.rendererReady = false;
    this.intentionalClose = false;
    try {
      this.unregisterControlsRole = this.registerWindowRole?.(window.webContents, 'controls') || null;
      this.configureControlsWebContents?.(window.webContents);
      this.attachWindowLifecycle(window);
      this.installDisplayListeners();
      await this.applyPolicy();
      await this.emitState('opening', { displayId: displayId(placement.display) });
      await window.loadURL(this.controlsUrl);
      this.scheduleRendererReadyTimeout(window);
    } catch (error) {
      await this.close({ reason: 'controls-route-load-failed', exitAdjust: true });
      throw error;
    }
    return this.getState();
  }

  attachWindowLifecycle(window) {
    window.on('move', () => this.schedulePersist());
    window.on('resize', () => this.schedulePersist());
    window.on('closed', () => void this.handleWindowClosed(window));
    window.on('unresponsive', () => void this.handleRendererFailure('controls-renderer-unresponsive'));
    window.webContents.on('render-process-gone', () => {
      if (!this.quitting) void this.handleRendererFailure('controls-renderer-stopped');
    });
    window.webContents.on(
      'did-start-navigation',
      (_event, _url, _isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        this.rendererReady = false;
        window.hide();
      }
    );
    window.webContents.on('did-finish-load', () => {
      if (window === this.window && !this.rendererReady) {
        this.scheduleRendererReadyTimeout(window);
      }
    });
    window.webContents.on('before-input-event', (event, input) => {
      if (input?.type !== 'keyDown' || input?.key !== 'Escape') return;
      event.preventDefault();
      void this.setAdjustIntent(false, 'escape');
    });
  }

  async handleWindowClosed(window) {
    if (window !== this.window) return;
    const wasIntentional = this.intentionalClose;
    this.window = null;
    this.rendererReady = false;
    this.visibleIntent = false;
    this.clearRendererReadyTimeout();
    this.unregisterControlsRole?.();
    this.unregisterControlsRole = null;
    this.removeDisplayListeners();
    if (!this.quitting) await this.setAdjustCallback(false, 'controls-window-closed');
    await this.emitState('closed', { intentional: wasIntentional });
  }

  async handleRendererFailure(reason) {
    await this.close({ reason, exitAdjust: true });
    await this.emitState(reason);
  }

  async applyPolicy() {
    if (!windowIsAlive(this.window)) return;
    const policy = resolveDesktopControlsWindowPolicy(this.platform, this.workspace);
    this.window.setResizable(true);
    this.window.setMinimumSize?.(
      DESKTOP_CONTROLS_MINIMUM_WIDTH,
      DESKTOP_CONTROLS_MINIMUM_HEIGHT
    );
    this.window.setMovable?.(true);
    this.window.setSkipTaskbar(true);
    this.window.setAlwaysOnTop(true, policy.effects.alwaysOnTopLevel);
    this.workspacePolicy = applyDesktopControlsWorkspacePolicy(
      this.window,
      this.platform,
      this.workspace
    );
  }

  async syncWorkspace(workspace) {
    this.workspace = normalizeDesktopControlsWorkspace(workspace);
    await this.applyPolicy();
    await this.emitState('workspace-updated');
    return this.getState();
  }

  clearRendererReadyTimeout() {
    if (!this.rendererReadyTimer) return;
    clearTimeout(this.rendererReadyTimer);
    this.rendererReadyTimer = null;
  }

  scheduleRendererReadyTimeout(window) {
    this.clearRendererReadyTimeout();
    this.rendererReadyTimer = setTimeout(() => {
      this.rendererReadyTimer = null;
      if (window === this.window && !this.rendererReady) {
        void this.handleRendererFailure('controls-renderer-ready-timeout');
      }
    }, this.rendererReadyTimeoutMs);
    this.rendererReadyTimer.unref?.();
  }

  async rendererDidBecomeReady() {
    if (!windowIsAlive(this.window)) throw new Error('Desktop Controls window is not open.');
    this.clearRendererReadyTimeout();
    this.rendererReady = true;
    if (this.visibleIntent) this.window.showInactive();
    await this.emitState('renderer-ready');
    return this.getState();
  }

  async show(source = 'requested') {
    if (!windowIsAlive(this.window)) {
      return this.open({ workspace: this.workspace, visible: true });
    }
    this.visibleIntent = true;
    if (this.rendererReady) this.window.showInactive();
    await this.emitState('shown', { source });
    return this.getState();
  }

  async hide(reason = 'requested') {
    await this.setAdjustIntent(false, 'controls-hidden');
    this.visibleIntent = false;
    if (windowIsAlive(this.window)) this.window.hide();
    await this.emitState('hidden', { reason });
    return this.getState();
  }

  async toggle(source = 'requested') {
    if (windowIsAlive(this.window) && this.window.isVisible?.()) return this.hide(source);
    return this.show(source);
  }

  async setAdjustIntent(enabled, source = 'controls-intent') {
    if (typeof enabled !== 'boolean') throw new Error('Desktop Controls Adjust intent must be boolean.');
    if (enabled && (!windowIsAlive(this.window) || !this.window.isVisible?.())) {
      throw new Error('Desktop Controls must be visible before Adjust can be enabled.');
    }
    await this.setAdjustCallback(enabled, source);
    await this.emitState('adjust-intent', { enabled, source });
    return this.getState();
  }

  async handleAdjustChanged(enabled, source = 'desktop-goon') {
    await this.emitState('adjust-state-changed', { enabled, source });
  }

  async updateProjectedState(value) {
    this.projection = cloneAndFreeze(value);
    await this.emitState('projection-updated');
    return this.getState();
  }

  async forwardRendererIntent(intent, payload) {
    await this.emitState('renderer-intent', {
      intent,
      payload: cloneAndFreeze(payload)
    });
    return this.getState();
  }

  schedulePersist() {
    if (!windowIsAlive(this.window) || this.quitting) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistWindowState().catch((error) => {
        void this.emitState('machine-state-error', {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, 150);
  }

  async persistWindowState() {
    if (!windowIsAlive(this.window)) return null;
    const display = this.screen.getDisplayMatching(this.window.getBounds());
    const bounds = clampDesktopControlsBounds(this.window.getBounds(), display.workArea);
    const state = {
      schemaVersion: DESKTOP_CONTROLS_WINDOW_STATE_VERSION,
      displayId: displayId(display),
      bounds
    };
    this.machineState = await this.writeState(this.stateFilePath, state);
    return this.machineState;
  }

  async handleDisplayChanged() {
    if (!windowIsAlive(this.window)) return;
    const display = this.selectDisplay(this.window.getBounds());
    this.window.setBounds(clampDesktopControlsBounds(this.window.getBounds(), display.workArea));
    await this.persistWindowState();
    await this.emitState('display-placement-updated', { displayId: displayId(display) });
  }

  async close({ reason = 'requested', exitAdjust = true } = {}) {
    if (exitAdjust && !this.quitting) await this.setAdjustCallback(false, 'controls-closed');
    if (!windowIsAlive(this.window)) return this.getState();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.clearRendererReadyTimeout();
    await this.persistWindowState().catch(() => {});
    const window = this.window;
    this.intentionalClose = true;
    this.window = null;
    this.rendererReady = false;
    this.visibleIntent = false;
    this.unregisterControlsRole?.();
    this.unregisterControlsRole = null;
    this.removeDisplayListeners();
    const closed = new Promise((resolve) => window.once('closed', resolve));
    window.destroy();
    await closed;
    await this.emitState('closed', { reason, intentional: true });
    return this.getState();
  }

  async prepareForQuit() {
    this.quitting = true;
    await this.close({ reason: 'app-quit', exitAdjust: false });
    this.removeDisplayListeners();
  }

  async handleCommand(role, command, payload) {
    switch (command) {
      case DESKTOP_CONTROLS_COMMANDS.getState:
        return this.getState();
      case DESKTOP_CONTROLS_COMMANDS.show:
        if (role !== 'main') throw new Error('Only the main window can show Desktop Controls.');
        return this.show('main-command');
      case DESKTOP_CONTROLS_COMMANDS.hide:
        return this.hide(payload.reason || `${role}-command`);
      case DESKTOP_CONTROLS_COMMANDS.toggle:
        if (role !== 'main') throw new Error('Only the main window can toggle Desktop Controls.');
        return this.toggle('main-command');
      case DESKTOP_CONTROLS_COMMANDS.updateState:
        if (role !== 'main') throw new Error('Only the main window can project Desktop Controls state.');
        return this.updateProjectedState(payload.state);
      case DESKTOP_CONTROLS_COMMANDS.sendIntent:
        if (role !== 'controls') throw new Error('Only Desktop Controls can send renderer intent.');
        return this.forwardRendererIntent(payload.intent, payload.payload);
      case DESKTOP_CONTROLS_COMMANDS.setAdjust:
        if (role !== 'controls') throw new Error('Only Desktop Controls can send Adjust intent.');
        return this.setAdjustIntent(payload.enabled);
      case DESKTOP_CONTROLS_COMMANDS.rendererReady:
        if (role !== 'controls') throw new Error('Only Desktop Controls can report readiness.');
        return this.rendererDidBecomeReady();
      default:
        throw new Error(`Unsupported Desktop Controls command: ${command}`);
    }
  }
}
