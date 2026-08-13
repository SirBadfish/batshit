import {
  DESKTOP_GOON_COMMANDS,
  DESKTOP_GOON_PORT_CHANNEL,
  DESKTOP_GOON_PORT_CLOSE_CHANNEL,
  DESKTOP_GOON_SCHEMA_VERSION,
  DESKTOP_GOON_WINDOW_ROLES
} from './desktop-goon-contract.mjs';
import {
  DEFAULT_DESKTOP_GOON_PREFERENCES,
  applyDesktopWorkspacePolicy,
  clampDesktopGoonBounds,
  defaultDesktopGoonBounds,
  normalizeDesktopGoonBounds,
  normalizeDesktopGoonPreferences,
  resolveDesktopGoonWindowPolicy
} from './desktop-goon-window-policy.mjs';
import {
  DESKTOP_GOON_WINDOW_STATE_VERSION,
  readDesktopGoonWindowState,
  writeDesktopGoonWindowState
} from './desktop-goon-window-state.mjs';

function windowIsAlive(window) {
  return Boolean(window && !window.isDestroyed?.());
}

function contentsIsAlive(contents) {
  return Boolean(contents && !contents.isDestroyed?.());
}

function displayId(display) {
  return String(display?.id ?? '');
}

export class DesktopGoonWindowController {
  constructor({
    BrowserWindow,
    MessageChannelMain,
    screen,
    globalShortcut,
    platform = process.platform,
    preloadPath,
    desktopUrl,
    stateFilePath,
    registerWindowRole,
    configureDesktopWebContents,
    getMainWindow,
    emitStatus = () => {},
    requestReturnToBatshit = async () => {},
    openDesktopControls = async () => {},
    closeDesktopControls = async () => {},
    toggleDesktopControls = async () => {},
    syncDesktopControlsWorkspace = async () => {},
    notifyAdjustChanged = async () => {},
    showFailure = async () => {},
    readState = readDesktopGoonWindowState,
    writeState = writeDesktopGoonWindowState,
    bridgeReadyTimeoutMs = 15_000,
    rendererReadyTimeoutMs = 30_000,
    devTools = false
  }) {
    if (typeof BrowserWindow !== 'function') throw new Error('Desktop Goon requires BrowserWindow.');
    if (typeof MessageChannelMain !== 'function') {
      throw new Error('Desktop Goon requires MessageChannelMain.');
    }
    if (!screen || !globalShortcut) throw new Error('Desktop Goon requires screen and globalShortcut.');
    if (typeof preloadPath !== 'string' || !preloadPath) {
      throw new Error('Desktop Goon requires a preload path.');
    }
    if (typeof desktopUrl !== 'string' || !desktopUrl) {
      throw new Error('Desktop Goon requires an exact route URL.');
    }
    if (typeof stateFilePath !== 'string' || !stateFilePath) {
      throw new Error('Desktop Goon requires a machine-local state path.');
    }
    this.BrowserWindow = BrowserWindow;
    this.MessageChannelMain = MessageChannelMain;
    this.screen = screen;
    this.globalShortcut = globalShortcut;
    this.platform = platform;
    this.preloadPath = preloadPath;
    this.desktopUrl = desktopUrl;
    this.stateFilePath = stateFilePath;
    this.registerWindowRole = registerWindowRole;
    this.configureDesktopWebContents = configureDesktopWebContents;
    this.getMainWindow = getMainWindow;
    this.emitStatusCallback = emitStatus;
    this.requestReturnToBatshitCallback = requestReturnToBatshit;
    this.openDesktopControlsCallback = openDesktopControls;
    this.closeDesktopControlsCallback = closeDesktopControls;
    this.toggleDesktopControlsCallback = toggleDesktopControls;
    this.syncDesktopControlsWorkspaceCallback = syncDesktopControlsWorkspace;
    this.notifyAdjustChangedCallback = notifyAdjustChanged;
    this.showFailureCallback = showFailure;
    this.readState = readState;
    this.writeState = writeState;
    this.bridgeReadyTimeoutMs = bridgeReadyTimeoutMs;
    this.rendererReadyTimeoutMs = rendererReadyTimeoutMs;
    this.devTools = devTools;

    this.window = null;
    this.unregisterDesktopRole = null;
    this.preferences = DEFAULT_DESKTOP_GOON_PREFERENCES;
    this.workspacePolicy = null;
    this.adjustMode = false;
    this.bridgeReady = false;
    this.rendererReady = false;
    this.statePortRequested = false;
    this.hasStatePort = false;
    this.portGeneration = 0;
    this.shortcut = Object.freeze({
      accelerator: null,
      registered: false,
      requestedAccelerator: null,
      error: null
    });
    this.machineState = null;
    this.machineStateLoaded = false;
    this.persistTimer = null;
    this.rendererReadyTimer = null;
    this.quitting = false;
    this.intentionalClose = false;
    this.displayListenersInstalled = false;
    this.boundDisplayChanged = () => this.handleDisplayChanged();
  }

  async emitStatus(type, detail = {}) {
    const event = Object.freeze({
      schemaVersion: DESKTOP_GOON_SCHEMA_VERSION,
      type,
      detail: Object.freeze({ ...detail }),
      status: this.getStatus()
    });
    await this.emitStatusCallback(event);
    return event;
  }

  getStatus() {
    const policy = resolveDesktopGoonWindowPolicy(this.platform, this.preferences);
    return Object.freeze({
      schemaVersion: DESKTOP_GOON_SCHEMA_VERSION,
      supported: policy.supported,
      unavailableReason: policy.supported ? null : policy.reason,
      active: windowIsAlive(this.window),
      bridgeReady: this.bridgeReady,
      rendererReady: this.rendererReady,
      adjustMode: this.adjustMode,
      preferences: this.preferences,
      workspacePolicy: this.workspacePolicy,
      bounds: windowIsAlive(this.window) ? this.window.getBounds() : this.machineState?.bounds || null,
      displayId: windowIsAlive(this.window)
        ? displayId(this.screen.getDisplayMatching(this.window.getBounds()))
        : this.machineState?.displayId || null,
      shortcut: this.shortcut,
      portGeneration: this.portGeneration,
      portConnected: this.hasStatePort,
      capabilities: policy.capabilities || Object.freeze({ allWorkspaces: false })
    });
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

  async loadMachineState() {
    if (this.machineStateLoaded) return this.machineState;
    this.machineStateLoaded = true;
    try {
      this.machineState = await this.readState(this.stateFilePath);
    } catch (error) {
      this.machineState = null;
      await this.emitStatus('machine-state-error', {
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

  resolveBounds(requestedBounds = null) {
    const stored = this.machineState;
    const source = requestedBounds || stored?.bounds || null;
    const display = this.selectDisplay(source, requestedBounds ? null : stored?.displayId);
    const bounds = source || defaultDesktopGoonBounds(display.workArea, this.preferences);
    return {
      display,
      bounds: clampDesktopGoonBounds({
        bounds,
        workArea: display.workArea,
        preferences: this.preferences
      })
    };
  }

  resolvePreferenceAdjustedBounds(currentBounds, previousPreferences) {
    const display = this.selectDisplay(currentBounds);
    let requested = normalizeDesktopGoonBounds(currentBounds);
    if (previousPreferences.normalizedWidth !== this.preferences.normalizedWidth) {
      const width = Math.round(display.workArea.width * this.preferences.normalizedWidth);
      requested = {
        ...requested,
        x: requested.x + requested.width - width,
        width
      };
    }
    return {
      display,
      bounds: clampDesktopGoonBounds({
        bounds: requested,
        workArea: display.workArea,
        preferences: this.preferences
      })
    };
  }

  async open({ preferences = {}, bounds = null } = {}) {
    const previousPreferences = this.preferences;
    this.preferences = normalizeDesktopGoonPreferences({ ...this.preferences, ...preferences });
    const policy = resolveDesktopGoonWindowPolicy(this.platform, this.preferences);
    if (!policy.supported) throw new Error(policy.reason);
    await this.loadMachineState();

    if (windowIsAlive(this.window)) {
      if (bounds) await this.setBounds(bounds);
      else this.window.setBounds(
        this.resolvePreferenceAdjustedBounds(this.window.getBounds(), previousPreferences).bounds
      );
      if (!bounds) this.schedulePersist();
      await this.applyPolicy();
      await this.registerControlsShortcut(this.preferences.controlsShortcut);
      if (this.rendererReady) this.window.showInactive();
      return this.getStatus();
    }

    const placement = this.resolveBounds(bounds ? normalizeDesktopGoonBounds(bounds) : null);
    const window = new this.BrowserWindow({
      ...policy.browserWindowOptions,
      ...placement.bounds,
      title: 'Batshit Desktop Goon',
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        devTools: this.devTools,
        additionalArguments: ['--batshit-window-role=desktop']
      }
    });
    this.window = window;
    this.intentionalClose = false;
    this.bridgeReady = false;
    this.rendererReady = false;
    this.statePortRequested = false;
    this.adjustMode = false;
    try {
      this.unregisterDesktopRole = this.registerWindowRole?.(
        window.webContents,
        DESKTOP_GOON_WINDOW_ROLES.desktop
      ) || null;
      this.configureDesktopWebContents?.(window.webContents);
      this.installDisplayListeners();
      this.attachWindowLifecycle(window);
      await this.applyPolicy();
      await this.registerControlsShortcut(this.preferences.controlsShortcut);
      await this.emitStatus('opening', { displayId: displayId(placement.display) });
      await window.loadURL(this.desktopUrl);
      this.rendererReadyTimer = setTimeout(() => {
        this.rendererReadyTimer = null;
        if (!this.bridgeReady && window === this.window) {
          void this.recoverFromFailure(
            'desktop-bridge-ready-timeout',
            'The Desktop Goon route did not establish its isolated bridge.'
          );
        }
      }, this.bridgeReadyTimeoutMs);
      this.rendererReadyTimer.unref?.();
    } catch (error) {
      await this.recoverFromFailure(
        'desktop-route-load-failed',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
    return this.getStatus();
  }

  attachWindowLifecycle(window) {
    window.on('move', () => this.schedulePersist());
    window.on('resize', () => this.schedulePersist());
    window.on('closed', () => void this.handleWindowClosed(window));
    window.on('unresponsive', () => {
      void this.recoverFromFailure(
        'desktop-renderer-unresponsive',
        'The Desktop Goon window stopped responding.'
      );
    });
    window.webContents.on('render-process-gone', (_event, details = {}) => {
      if (this.quitting) return;
      void this.recoverFromFailure(
        'desktop-renderer-stopped',
        `The Desktop Goon renderer stopped (${details.reason || 'unknown reason'}).`
      );
    });
    window.webContents.on(
      'did-start-navigation',
      (_event, _url, _isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        this.bridgeReady = false;
        this.rendererReady = false;
        this.closeStatePort('desktop-navigation');
      }
    );
    window.webContents.on('before-input-event', (event, input) => {
      if (!this.adjustMode || input?.type !== 'keyDown' || input?.key !== 'Escape') return;
      event.preventDefault();
      void this.setAdjustMode(false, 'escape');
    });
  }

  async handleWindowClosed(window) {
    if (window !== this.window) return;
    const shouldReturn = !this.quitting && !this.intentionalClose;
    this.window = null;
    this.bridgeReady = false;
    this.rendererReady = false;
    this.closeStatePort('desktop-window-closed');
    this.unregisterDesktopRole?.();
    this.unregisterDesktopRole = null;
    this.unregisterControlsShortcut();
    this.removeDisplayListeners();
    await this.closeDesktopControlsCallback({ reason: 'desktop-window-closed', exitAdjust: false });
    await this.emitStatus('closed', { reason: shouldReturn ? 'native-close' : 'controlled-close' });
    if (shouldReturn) await this.requestReturnToBatshitCallback('desktop-window-closed');
  }

  async applyPolicy() {
    if (!windowIsAlive(this.window)) return;
    const policy = resolveDesktopGoonWindowPolicy(this.platform, this.preferences);
    if (!policy.supported) throw new Error(policy.reason);
    const { effects } = policy;
    this.window.setHasShadow(false);
    this.window.setResizable(false);
    this.window.setSkipTaskbar(true);
    this.window.setAlwaysOnTop(effects.alwaysOnTop, effects.alwaysOnTopLevel);
    this.workspacePolicy = applyDesktopWorkspacePolicy(
      this.window,
      this.platform,
      this.preferences
    );
    this.window.setIgnoreMouseEvents(this.preferences.clickThrough && !this.adjustMode, {
      forward: effects.forwardMouseEvents
    });
  }

  async updatePreferences(value) {
    const previousPreferences = this.preferences;
    const previousShortcut = previousPreferences.controlsShortcut;
    this.preferences = normalizeDesktopGoonPreferences({ ...this.preferences, ...value });
    if (windowIsAlive(this.window)) {
      await this.applyPolicy();
      const placement = this.resolvePreferenceAdjustedBounds(
        this.window.getBounds(),
        previousPreferences
      );
      this.window.setBounds(placement.bounds);
      this.schedulePersist();
      if (previousShortcut !== this.preferences.controlsShortcut) {
        await this.registerControlsShortcut(this.preferences.controlsShortcut);
      }
      await this.syncDesktopControlsWorkspaceCallback(this.preferences.workspace);
    }
    await this.emitStatus('preferences-updated');
    return this.getStatus();
  }

  async setBounds(value) {
    if (!windowIsAlive(this.window)) throw new Error('Desktop Goon window is not open.');
    const requested = normalizeDesktopGoonBounds(value);
    const display = this.selectDisplay(requested);
    const bounds = clampDesktopGoonBounds({
      bounds: requested,
      workArea: display.workArea,
      preferences: this.preferences
    });
    this.window.setBounds(bounds);
    await this.persistWindowState();
    await this.emitStatus('bounds-updated', { displayId: displayId(display) });
    return this.getStatus();
  }

  async setAdjustMode(enabled, source = 'command') {
    if (typeof enabled !== 'boolean') throw new Error('Desktop Goon Adjust state must be boolean.');
    this.adjustMode = enabled;
    if (windowIsAlive(this.window)) {
      this.window.setIgnoreMouseEvents(this.preferences.clickThrough && !enabled, { forward: true });
      if (enabled) {
        this.window.show();
        this.window.focus();
      } else if (this.rendererReady) {
        this.window.showInactive();
      }
    }
    await this.emitStatus('adjust-mode-changed', { enabled, source });
    await this.notifyAdjustChangedCallback(enabled, source);
    return this.getStatus();
  }

  async registerControlsShortcut(accelerator) {
    const normalized = normalizeDesktopGoonPreferences({
      ...this.preferences,
      controlsShortcut: accelerator
    }).controlsShortcut;
    if (this.shortcut.registered && this.shortcut.accelerator === normalized) {
      return this.shortcut;
    }
    const registered = this.globalShortcut.register(normalized, () => {
      void this.toggleDesktopControlsCallback('global-shortcut');
    });
    if (!registered) {
      const previous = this.shortcut.registered ? this.shortcut.accelerator : null;
      this.shortcut = Object.freeze({
        accelerator: previous || normalized,
        registered: Boolean(previous),
        requestedAccelerator: normalized,
        error: `The global shortcut ${normalized} is already in use.`
      });
      await this.emitStatus('shortcut-conflict', {
        accelerator: normalized,
        fallbackAccelerator: previous,
        message: this.shortcut.error
      });
      return this.shortcut;
    }
    const previous = this.shortcut.registered ? this.shortcut.accelerator : null;
    if (previous && previous !== normalized) this.globalShortcut.unregister(previous);
    this.shortcut = Object.freeze({
      accelerator: normalized,
      registered: true,
      requestedAccelerator: null,
      error: null
    });
    await this.emitStatus('shortcut-registered', { accelerator: normalized });
    return this.shortcut;
  }

  unregisterControlsShortcut() {
    if (this.shortcut.registered && this.shortcut.accelerator) {
      this.globalShortcut.unregister(this.shortcut.accelerator);
    }
    this.shortcut = Object.freeze({
      accelerator: null,
      registered: false,
      requestedAccelerator: null,
      error: null
    });
  }

  async bridgeDidBecomeReady() {
    if (!windowIsAlive(this.window)) throw new Error('Desktop Goon window is not open.');
    if (this.rendererReadyTimer) {
      clearTimeout(this.rendererReadyTimer);
      this.rendererReadyTimer = null;
    }
    this.bridgeReady = true;
    const window = this.window;
    this.rendererReadyTimer = setTimeout(() => {
      this.rendererReadyTimer = null;
      if (!this.rendererReady && window === this.window) {
        void this.recoverFromFailure(
          'desktop-renderer-ready-timeout',
          'The Desktop Goon renderer did not finish loading its initial snapshot.'
        );
      }
    }, this.rendererReadyTimeoutMs);
    this.rendererReadyTimer.unref?.();
    this.replaceStatePortIfReady();
    await this.emitStatus('bridge-ready');
    return this.getStatus();
  }

  async rendererDidBecomeReady() {
    if (!windowIsAlive(this.window)) throw new Error('Desktop Goon window is not open.');
    if (!this.bridgeReady) throw new Error('Desktop Goon bridge must be ready before its renderer.');
    if (this.rendererReadyTimer) {
      clearTimeout(this.rendererReadyTimer);
      this.rendererReadyTimer = null;
    }
    this.rendererReady = true;
    await this.applyPolicy();
    this.window.showInactive();
    this.replaceStatePortIfReady();
    try {
      await this.openDesktopControlsCallback({
        workspace: this.preferences.workspace,
        visible: true
      });
    } catch (error) {
      await this.recoverFromFailure(
        'desktop-controls-open-failed',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
    await this.emitStatus('renderer-ready');
    return this.getStatus();
  }

  requestStatePort() {
    this.statePortRequested = true;
    this.replaceStatePortIfReady();
    return this.getStatus();
  }

  replaceStatePortIfReady() {
    const mainWindow = this.getMainWindow?.();
    if (
      !this.statePortRequested ||
      !this.bridgeReady ||
      !windowIsAlive(this.window) ||
      !windowIsAlive(mainWindow) ||
      !contentsIsAlive(mainWindow.webContents) ||
      !contentsIsAlive(this.window.webContents)
    ) {
      return false;
    }
    this.closeStatePort('port-replaced');
    const channel = new this.MessageChannelMain();
    const generation = ++this.portGeneration;
    const metadata = Object.freeze({
      schemaVersion: DESKTOP_GOON_SCHEMA_VERSION,
      generation
    });
    try {
      mainWindow.webContents.postMessage(
        DESKTOP_GOON_PORT_CHANNEL,
        { ...metadata, role: DESKTOP_GOON_WINDOW_ROLES.main },
        [channel.port1]
      );
      this.window.webContents.postMessage(
        DESKTOP_GOON_PORT_CHANNEL,
        { ...metadata, role: DESKTOP_GOON_WINDOW_ROLES.desktop },
        [channel.port2]
      );
      this.hasStatePort = true;
      void this.emitStatus('state-port-connected', { generation });
      return true;
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      this.hasStatePort = false;
      void this.recoverFromFailure(
        'state-port-transfer-failed',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  closeStatePort(reason) {
    if (!this.hasStatePort) return;
    const message = {
      schemaVersion: DESKTOP_GOON_SCHEMA_VERSION,
      generation: this.portGeneration,
      reason
    };
    const mainWindow = this.getMainWindow?.();
    if (windowIsAlive(mainWindow) && contentsIsAlive(mainWindow.webContents)) {
      mainWindow.webContents.send(DESKTOP_GOON_PORT_CLOSE_CHANNEL, message);
    }
    if (windowIsAlive(this.window) && contentsIsAlive(this.window.webContents)) {
      this.window.webContents.send(DESKTOP_GOON_PORT_CLOSE_CHANNEL, message);
    }
    this.hasStatePort = false;
  }

  schedulePersist() {
    if (!windowIsAlive(this.window) || this.quitting) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistWindowState().catch((error) => {
        void this.emitStatus('machine-state-error', {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, 150);
  }

  async persistWindowState() {
    if (!windowIsAlive(this.window)) return null;
    const bounds = normalizeDesktopGoonBounds(this.window.getBounds());
    const display = this.screen.getDisplayMatching(bounds);
    const state = {
      schemaVersion: DESKTOP_GOON_WINDOW_STATE_VERSION,
      displayId: displayId(display),
      bounds
    };
    this.machineState = await this.writeState(this.stateFilePath, state);
    return this.machineState;
  }

  async handleDisplayChanged() {
    if (!windowIsAlive(this.window)) return;
    const placement = this.resolveBounds(this.window.getBounds());
    this.window.setBounds(placement.bounds);
    await this.persistWindowState();
    await this.emitStatus('display-placement-updated', { displayId: displayId(placement.display) });
  }

  async returnToBatshit(reason = 'requested') {
    return this.close({ reason, returnToBatshit: true });
  }

  async close({ reason = 'requested', returnToBatshit = true } = {}) {
    if (!windowIsAlive(this.window)) {
      if (returnToBatshit) await this.requestReturnToBatshitCallback(reason);
      return this.getStatus();
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.rendererReadyTimer) {
      clearTimeout(this.rendererReadyTimer);
      this.rendererReadyTimer = null;
    }
    await this.persistWindowState().catch(() => {});
    const window = this.window;
    this.intentionalClose = true;
    await this.closeDesktopControlsCallback({ reason, exitAdjust: false });
    this.closeStatePort(reason);
    this.window = null;
    this.bridgeReady = false;
    this.rendererReady = false;
    this.unregisterDesktopRole?.();
    this.unregisterDesktopRole = null;
    this.unregisterControlsShortcut();
    this.removeDisplayListeners();
    const closed = new Promise((resolve) => window.once('closed', resolve));
    window.destroy();
    await closed;
    await this.emitStatus('closed', { reason });
    // Renderer ownership is exclusive: only tell the main window to remount
    // its Dock after the Desktop renderer has been destroyed.
    if (returnToBatshit) await this.requestReturnToBatshitCallback(reason);
    return this.getStatus();
  }

  async recoverFromFailure(type, message) {
    if (this.quitting) return;
    // Dispose the failed Desktop owner before the failure event can remount
    // the in-app Dock. The later status keeps the failure visible.
    await this.close({ reason: type, returnToBatshit: false });
    await this.emitStatus(type, { message });
    await this.showFailureCallback(message);
    await this.requestReturnToBatshitCallback(type);
  }

  async handleMainRendererFailure(reason = 'main-renderer-failed') {
    if (!windowIsAlive(this.window)) return;
    await this.close({ reason, returnToBatshit: false });
  }

  async prepareForQuit() {
    this.quitting = true;
    await this.close({ reason: 'app-quit', returnToBatshit: false });
    this.unregisterControlsShortcut();
    this.removeDisplayListeners();
  }

  async handleCommand(role, command, payload) {
    switch (command) {
      case DESKTOP_GOON_COMMANDS.getStatus:
        return this.getStatus();
      case DESKTOP_GOON_COMMANDS.open:
        if (role !== DESKTOP_GOON_WINDOW_ROLES.main) throw new Error('Only the main window can open Desktop Mode.');
        return this.open(payload);
      case DESKTOP_GOON_COMMANDS.close:
        if (role !== DESKTOP_GOON_WINDOW_ROLES.main) throw new Error('Only the main window can close Desktop Mode.');
        return this.close({
          reason: payload.reason || 'main-command',
          returnToBatshit: false
        });
      case DESKTOP_GOON_COMMANDS.updatePreferences:
        if (role !== DESKTOP_GOON_WINDOW_ROLES.main) throw new Error('Only the main window can update Desktop Mode preferences.');
        return this.updatePreferences(payload.preferences);
      case DESKTOP_GOON_COMMANDS.setBounds:
        return this.setBounds(payload.bounds);
      case DESKTOP_GOON_COMMANDS.setAdjustMode:
        return this.setAdjustMode(payload.enabled);
      case DESKTOP_GOON_COMMANDS.returnToBatshit:
        return this.returnToBatshit(payload.reason || 'renderer-command');
      case DESKTOP_GOON_COMMANDS.registerShortcut:
        if (role !== DESKTOP_GOON_WINDOW_ROLES.main) throw new Error('Only the main window can register Desktop Mode shortcuts.');
        return this.registerControlsShortcut(payload.accelerator);
      case DESKTOP_GOON_COMMANDS.bridgeReady:
        if (role !== DESKTOP_GOON_WINDOW_ROLES.desktop) throw new Error('Only the Desktop window can report bridge readiness.');
        return this.bridgeDidBecomeReady();
      case DESKTOP_GOON_COMMANDS.rendererReady:
        if (role !== DESKTOP_GOON_WINDOW_ROLES.desktop) throw new Error('Only the Desktop window can report renderer readiness.');
        return this.rendererDidBecomeReady();
      case DESKTOP_GOON_COMMANDS.rendererFailed:
        if (role !== DESKTOP_GOON_WINDOW_ROLES.desktop) throw new Error('Only the Desktop window can report renderer failure.');
        await this.recoverFromFailure('desktop-renderer-initialization-failed', payload.message);
        return this.getStatus();
      case DESKTOP_GOON_COMMANDS.connectStatePort:
        if (role !== DESKTOP_GOON_WINDOW_ROLES.main) throw new Error('Only the main window can connect Desktop Goon state.');
        return this.requestStatePort();
      default:
        throw new Error(`Unsupported Desktop Goon controller command: ${command}`);
    }
  }
}
