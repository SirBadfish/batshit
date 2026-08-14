import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  MessageChannelMain,
  protocol,
  screen,
  session,
  shell
} from 'electron';

import {
  DESKTOP_CONTROLS_IPC_CHANNEL,
  DESKTOP_CONTROLS_STATE_CHANNEL,
  validateDesktopControlsCommandEnvelope
} from './desktop-controls-contract.mjs';
import { DesktopControlsWindowController } from './desktop-controls-window-controller.mjs';
import {
  DESKTOP_GOON_IPC_CHANNEL,
  DESKTOP_GOON_SCHEMA_VERSION,
  DESKTOP_GOON_STATUS_CHANNEL,
  DESKTOP_GOON_WINDOW_ROLES,
  validateDesktopGoonCommandEnvelope
} from './desktop-goon-contract.mjs';
import { DesktopGoonWindowController } from './desktop-goon-window-controller.mjs';
import { resolveMainWindowSizePolicy } from './main-window-policy.mjs';

import {
  SUPERVISOR_COMMANDS,
  collectAllowedOrigins,
  isAllowedAppUrl,
  isAllowedElectronMediaPermission,
  isAllowedMainWindowUrl,
  isExactDesktopControlsUrl,
  isExactDesktopGoonUrl,
  isSafeExternalUrl,
  resolveDesktopControlsUrl,
  resolveDesktopGoonUrl,
  resolveShellAssetPath,
  validateElectronIpcSender,
  validateSaveFileOptions
} from './electron-shell-policy.mjs';

const execFileAsync = promisify(execFile);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const allowedOrigins = collectAllowedOrigins();
const desktopGoonUrl = resolveDesktopGoonUrl();
const desktopControlsUrl = resolveDesktopControlsUrl();
const shellRoot = app.isPackaged
  ? join(app.getAppPath(), 'shell')
  : join(app.getAppPath(), 'frontend', 'dist');
const shellUrl = 'batshit-shell://app/index.html';
const appLifecycleSchemaVersion = 'app-lifecycle/v1';
const appShutdownChannel = 'batshit:lifecycle:shutdown-started';
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp']
]);

let mainWindow = null;
let desktopGoonController = null;
let desktopControlsController = null;
let shutdownStarted = false;
let quittingAfterShutdown = false;
let pendingShutdownReason = 'app-quit';
const windowRoleRegistry = new Map();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'batshit-shell',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

app.enableSandbox();
app.setName('Batshit');
app.setPath(
  'userData',
  process.env.BATSHIT_MAC_SHELL_DATA_DIR ||
    join(
      process.env.BATSHIT_MAC_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Batshit'),
      'electron-shell'
    )
);
app.setPath(
  'crashDumps',
  join(
    process.env.BATSHIT_MAC_LOG_DIR || join(homedir(), 'Library', 'Logs', 'Batshit'),
    'crash-dumps'
  )
);

function supervisorScriptPath() {
  const configured = process.env.BATSHIT_MAC_SUPERVISOR_SCRIPT;
  if (configured && existsSync(configured)) return configured;
  const packaged = join(process.resourcesPath, 'scripts', 'mac-runtime-supervisor.mjs');
  if (existsSync(packaged)) return packaged;
  const development = join(app.getAppPath(), 'scripts', 'mac-runtime-supervisor.mjs');
  if (existsSync(development)) return development;
  throw new Error('Batshit runtime supervisor is missing from the Mac app package.');
}

function supervisorNodePath() {
  for (const candidate of [
    process.env.BATSHIT_MAC_NODE_RUNTIME,
    join(process.resourcesPath, 'runtime', 'vendor', 'node', 'bin', 'node'),
    process.env.npm_node_execpath
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error('Batshit could not find its managed Node.js runtime.');
}

async function runSupervisor(action) {
  const timeout = ['start', 'stop', 'restart'].includes(action) ? 20 * 60_000 : 60_000;
  const { stdout, stderr } = await execFileAsync(
    supervisorNodePath(),
    [supervisorScriptPath(), action],
    {
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout
    }
  );
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(stderr.trim() || `Runtime ${action} returned no result.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Runtime ${action} returned invalid JSON.`);
  }
}

function registerWindowRole(webContents, role) {
  const record = {
    role,
    webContents,
    lastDesktopSequence: 0,
    lastControlsSequence: 0
  };
  windowRoleRegistry.set(webContents.id, record);
  const resetSequence = (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      record.lastDesktopSequence = 0;
      record.lastControlsSequence = 0;
    }
  };
  const remove = () => {
    if (windowRoleRegistry.get(webContents.id) === record) {
      windowRoleRegistry.delete(webContents.id);
    }
  };
  webContents.on('did-start-navigation', resetSequence);
  webContents.once('destroyed', remove);
  return () => {
    webContents.removeListener('did-start-navigation', resetSequence);
    webContents.removeListener('destroyed', remove);
    remove();
  };
}

function validateIpcSender(event, allowedRoles) {
  return validateElectronIpcSender(event, {
    allowedOrigins,
    roleRegistry: windowRoleRegistry,
    allowedRoles,
    desktopUrl: desktopGoonUrl,
    controlsUrl: desktopControlsUrl
  });
}

function sendDesktopGoonStatus(value) {
  for (const record of windowRoleRegistry.values()) {
    if (
      !record.webContents.isDestroyed() &&
      [DESKTOP_GOON_WINDOW_ROLES.main, DESKTOP_GOON_WINDOW_ROLES.desktop].includes(record.role)
    ) {
      record.webContents.send(DESKTOP_GOON_STATUS_CHANNEL, value);
    }
  }
}

function sendDesktopControlsState(value) {
  for (const record of windowRoleRegistry.values()) {
    if (
      !record.webContents.isDestroyed() &&
      [DESKTOP_GOON_WINDOW_ROLES.main, DESKTOP_GOON_WINDOW_ROLES.controls].includes(record.role)
    ) {
      record.webContents.send(DESKTOP_CONTROLS_STATE_CHANNEL, value);
    }
  }
}

function restoreMainRecoverySurface(reason = 'recovery') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendDesktopGoonStatus({
    schemaVersion: DESKTOP_GOON_SCHEMA_VERSION,
    type: 'main-recovery-surface-restored',
    detail: { reason },
    status: desktopGoonController?.getStatus() || null
  });
}

function installIpcHandlers() {
  ipcMain.handle('batshit:invoke', async (event, command, payload) => {
    validateIpcSender(event, [DESKTOP_GOON_WINDOW_ROLES.main]);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Runtime bridge payload must be an object.');
    }
    const action = SUPERVISOR_COMMANDS[command];
    if (!action) throw new Error(`Unsupported runtime bridge command: ${command}`);
    return runSupervisor(action);
  });

  ipcMain.handle('batshit:save-file', async (event, rawOptions) => {
    validateIpcSender(event, [DESKTOP_GOON_WINDOW_ROLES.main]);
    const options = validateSaveFileOptions(rawOptions);
    const defaultPath = options.defaultPath ||
      (options.defaultName ? join(app.getPath('downloads'), basename(options.defaultName)) : undefined);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || 'Save File',
      defaultPath
    });
    return result.canceled ? null : result.filePath || null;
  });

  ipcMain.handle(DESKTOP_GOON_IPC_CHANNEL, async (event, rawEnvelope) => {
    if (!desktopGoonController) throw new Error('Desktop Goon controller is unavailable.');
    const record = validateIpcSender(event, [
      DESKTOP_GOON_WINDOW_ROLES.main,
      DESKTOP_GOON_WINDOW_ROLES.desktop
    ]);
    const envelope = validateDesktopGoonCommandEnvelope(rawEnvelope, {
      role: record.role,
      lastSequence: record.lastDesktopSequence
    });
    record.lastDesktopSequence = envelope.sequence;
    return desktopGoonController.handleCommand(record.role, envelope.command, envelope.payload);
  });

  ipcMain.handle(DESKTOP_CONTROLS_IPC_CHANNEL, async (event, rawEnvelope) => {
    if (!desktopControlsController) throw new Error('Desktop Controls are unavailable.');
    const record = validateIpcSender(event, [
      DESKTOP_GOON_WINDOW_ROLES.main,
      DESKTOP_GOON_WINDOW_ROLES.controls
    ]);
    const envelope = validateDesktopControlsCommandEnvelope(rawEnvelope, {
      role: record.role,
      lastSequence: record.lastControlsSequence
    });
    record.lastControlsSequence = envelope.sequence;
    return desktopControlsController.handleCommand(
      record.role,
      envelope.command,
      envelope.payload
    );
  });
}

async function installShellProtocol() {
  protocol.handle('batshit-shell', async (request) => {
    try {
      const path = resolveShellAssetPath(shellRoot, request.url);
      const bytes = await readFile(path);
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': mimeTypes.get(extname(path).toLowerCase()) || 'application/octet-stream',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function configureSessionPermissions() {
  const isAllowed = (webContents, permission, requestingOrigin, details = {}) => {
    return isAllowedElectronMediaPermission({
      webContents,
      permission,
      requestingUrl: requestingOrigin || details.requestingUrl,
      details,
      roleRegistry: windowRoleRegistry,
      allowedOrigins,
      desktopUrl: desktopGoonUrl,
      controlsUrl: desktopControlsUrl
    });
  };
  session.defaultSession.setPermissionCheckHandler(isAllowed);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAllowed(webContents, permission, details.requestingUrl, details));
  });
}

function configureBaseWebContents(contents) {
  contents.on('will-navigate', (event, navigationUrl) => {
    if (isAllowedAppUrl(navigationUrl, allowedOrigins)) return;
    event.preventDefault();
    if (isSafeExternalUrl(navigationUrl)) void shell.openExternal(navigationUrl);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function configureRoleNavigation(contents, role) {
  const isAllowed = (navigationUrl) => role === DESKTOP_GOON_WINDOW_ROLES.desktop
    ? isExactDesktopGoonUrl(navigationUrl, desktopGoonUrl)
    : role === DESKTOP_GOON_WINDOW_ROLES.controls
      ? isExactDesktopControlsUrl(navigationUrl, desktopControlsUrl)
      : isAllowedMainWindowUrl(
          navigationUrl,
          allowedOrigins,
          desktopGoonUrl,
          desktopControlsUrl
        );
  const enforce = (event, navigationUrl) => {
    if (!isAllowed(navigationUrl)) event.preventDefault();
  };
  contents.on('will-navigate', enforce);
  contents.on('will-redirect', enforce);
}

function createWindow() {
  const window = new BrowserWindow({
    ...resolveMainWindowSizePolicy(),
    show: false,
    backgroundColor: '#080810',
    title: 'Batshit',
    webPreferences: {
      preload: join(moduleDir, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: process.env.BATSHIT_MAC_ENABLE_DEVTOOLS === '1'
    }
  });
  registerWindowRole(window.webContents, DESKTOP_GOON_WINDOW_ROLES.main);
  configureRoleNavigation(window.webContents, DESKTOP_GOON_WINDOW_ROLES.main);
  window.once('ready-to-show', () => window.show());
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quittingAfterShutdown) return;
    void desktopGoonController?.handleMainRendererFailure('main-renderer-stopped').finally(() => {
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'Batshit renderer stopped',
        message: 'The Batshit window process stopped unexpectedly.',
        detail: `Reason: ${details.reason}. The Desktop Goon was closed and your local runtime was left running so this failure is visible and recoverable.`,
        buttons: ['Close']
      });
    });
  });
  window.on('unresponsive', () => {
    void desktopGoonController?.handleMainRendererFailure('main-renderer-unresponsive').finally(() => {
      void dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Batshit is not responding',
        message: 'The Batshit window stopped responding.',
        detail: 'The Desktop Goon was closed. The app will not silently reload or discard your editor state.',
        buttons: ['OK']
      });
    });
  });
  window.on('close', (event) => {
    if (quittingAfterShutdown) return;
    event.preventDefault();
    pendingShutdownReason = 'window-close';
    app.quit();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(shellUrl);
  return window;
}

function notifyRendererShutdown(reason) {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (!window.webContents.isDestroyed()) {
    window.webContents.send(appShutdownChannel, {
      schemaVersion: appLifecycleSchemaVersion,
      type: 'shutdown-started',
      reason
    });
  }
  window.hide();
}

async function stopRuntimeBeforeQuit(reason = 'app-quit') {
  if (shutdownStarted) return;
  shutdownStarted = true;
  notifyRendererShutdown(reason);
  try {
    await desktopGoonController?.prepareForQuit();
    await desktopControlsController?.prepareForQuit();
    await runSupervisor('stop');
  } catch (error) {
    console.error('[Batshit Mac] Runtime shutdown failed:', error);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    restoreMainRecoverySurface('second-instance');
  });

  app.on('before-quit', (event) => {
    if (quittingAfterShutdown) return;
    event.preventDefault();
    void stopRuntimeBeforeQuit(pendingShutdownReason).finally(() => {
      quittingAfterShutdown = true;
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    await installShellProtocol();
    configureSessionPermissions();
    app.on('web-contents-created', (_event, contents) => configureBaseWebContents(contents));
    desktopControlsController = new DesktopControlsWindowController({
      BrowserWindow,
      screen,
      platform: process.platform,
      preloadPath: join(moduleDir, 'preload.cjs'),
      controlsUrl: desktopControlsUrl,
      stateFilePath: join(app.getPath('userData'), 'desktop-controls-window-state-v1.json'),
      registerWindowRole,
      configureControlsWebContents: (contents) =>
        configureRoleNavigation(contents, DESKTOP_GOON_WINDOW_ROLES.controls),
      getDesktopGoonState: () => desktopGoonController?.getStatus() || null,
      setAdjust: (enabled, source) => desktopGoonController?.setAdjustMode(enabled, source),
      emitState: (state) => sendDesktopControlsState(state),
      devTools: process.env.BATSHIT_MAC_ENABLE_DEVTOOLS === '1'
    });
    desktopGoonController = new DesktopGoonWindowController({
      BrowserWindow,
      MessageChannelMain,
      screen,
      globalShortcut,
      platform: process.platform,
      preloadPath: join(moduleDir, 'preload.cjs'),
      desktopUrl: desktopGoonUrl,
      stateFilePath: join(app.getPath('userData'), 'desktop-goon-window-state-v1.json'),
      registerWindowRole,
      configureDesktopWebContents: (contents) =>
        configureRoleNavigation(contents, DESKTOP_GOON_WINDOW_ROLES.desktop),
      getMainWindow: () => mainWindow,
      emitStatus: (status) => sendDesktopGoonStatus(status),
      openDesktopControls: (options) => desktopControlsController.open(options),
      closeDesktopControls: (options) => desktopControlsController.close(options),
      toggleDesktopControls: (source) => desktopControlsController.toggle(source),
      syncDesktopControlsWorkspace: (workspace) =>
        desktopControlsController.syncWorkspace(workspace),
      notifyAdjustChanged: (enabled, source) =>
        desktopControlsController.handleAdjustChanged(enabled, source),
      requestReturnToBatshit: async (reason) => {
        sendDesktopGoonStatus({
          schemaVersion: DESKTOP_GOON_SCHEMA_VERSION,
          type: 'return-to-batshit-requested',
          detail: { reason },
          status: desktopGoonController?.getStatus() || null
        });
        restoreMainRecoverySurface(reason);
      },
      showFailure: async (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Desktop Goon stopped',
            message,
            detail: 'The Desktop Goon was returned to Batshit so the failure remains recoverable.',
            buttons: ['OK']
          });
        } else {
          dialog.showErrorBox('Desktop Goon stopped', message);
        }
      },
      devTools: process.env.BATSHIT_MAC_ENABLE_DEVTOOLS === '1'
    });
    installIpcHandlers();
    mainWindow = createWindow();
  }).catch((error) => {
    console.error('[Batshit Mac] Shell startup failed:', error);
    dialog.showErrorBox('Batshit could not open', error instanceof Error ? error.message : String(error));
    quittingAfterShutdown = true;
    app.quit();
  });
}
