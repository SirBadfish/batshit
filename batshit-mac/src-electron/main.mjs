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
  ipcMain,
  protocol,
  session,
  shell
} from 'electron';

import {
  SUPERVISOR_COMMANDS,
  collectAllowedOrigins,
  isAllowedAppUrl,
  isSafeExternalUrl,
  resolveShellAssetPath,
  validateSaveFileOptions
} from './electron-shell-policy.mjs';

const execFileAsync = promisify(execFile);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const allowedOrigins = collectAllowedOrigins();
const shellRoot = app.isPackaged
  ? join(app.getAppPath(), 'shell')
  : join(app.getAppPath(), 'frontend', 'dist');
const shellUrl = 'batshit-shell://app/index.html';
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
let shutdownStarted = false;
let quittingAfterShutdown = false;

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

function validateIpcSender(event) {
  const url = event.senderFrame?.url || event.sender.getURL();
  if (!isAllowedAppUrl(url, allowedOrigins)) {
    throw new Error('The native Mac bridge rejected an untrusted sender.');
  }
}

function installIpcHandlers() {
  ipcMain.handle('batshit:invoke', async (event, command, payload) => {
    validateIpcSender(event);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Runtime bridge payload must be an object.');
    }
    const action = SUPERVISOR_COMMANDS[command];
    if (!action) throw new Error(`Unsupported runtime bridge command: ${command}`);
    return runSupervisor(action);
  });

  ipcMain.handle('batshit:save-file', async (event, rawOptions) => {
    validateIpcSender(event);
    const options = validateSaveFileOptions(rawOptions);
    const defaultPath = options.defaultPath ||
      (options.defaultName ? join(app.getPath('downloads'), basename(options.defaultName)) : undefined);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || 'Save File',
      defaultPath
    });
    return result.canceled ? null : result.filePath || null;
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
    const origin = requestingOrigin || details.requestingUrl || webContents?.getURL?.() || '';
    if (!isAllowedAppUrl(origin, allowedOrigins)) return false;
    if (permission !== 'media') return false;
    const mediaTypes = details.mediaTypes || [];
    return mediaTypes.length === 0 || mediaTypes.every((type) => type === 'audio');
  };
  session.defaultSession.setPermissionCheckHandler(isAllowed);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAllowed(webContents, permission, details.requestingUrl, details));
  });
}

function configureWebContents(contents) {
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 720,
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
  window.once('ready-to-show', () => window.show());
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quittingAfterShutdown) return;
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Batshit renderer stopped',
      message: 'The Batshit window process stopped unexpectedly.',
      detail: `Reason: ${details.reason}. Your local runtime was left running so this failure is visible and recoverable.`,
      buttons: ['Close']
    });
  });
  window.on('unresponsive', () => {
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Batshit is not responding',
      message: 'The Batshit window stopped responding.',
      detail: 'The app will not silently reload or discard your editor state. Wait for the current work to finish or close the app deliberately.',
      buttons: ['OK']
    });
  });
  void window.loadURL(shellUrl);
  return window;
}

async function stopRuntimeBeforeQuit() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
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
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('before-quit', (event) => {
    if (quittingAfterShutdown) return;
    event.preventDefault();
    void stopRuntimeBeforeQuit().finally(() => {
      quittingAfterShutdown = true;
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    await installShellProtocol();
    installIpcHandlers();
    configureSessionPermissions();
    app.on('web-contents-created', (_event, contents) => configureWebContents(contents));
    mainWindow = createWindow();
  }).catch((error) => {
    console.error('[Batshit Mac] Shell startup failed:', error);
    dialog.showErrorBox('Batshit could not open', error instanceof Error ? error.message : String(error));
    quittingAfterShutdown = true;
    app.quit();
  });
}
