import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  DESKTOP_GOON_WINDOW_ROLES
} from './desktop-goon-contract.mjs';
import { DESKTOP_GOON_ROUTE_PATH } from './desktop-goon-window-policy.mjs';

export const SUPERVISOR_COMMANDS = Object.freeze({
  'batshit.runtime.status': 'status',
  'batshit.runtime.doctor': 'doctor',
  'batshit.runtime.start': 'start',
  'batshit.runtime.stop': 'stop',
  'batshit.runtime.restart': 'restart',
  'batshit.runtime.appleContainerStart': 'apple-container-start'
});

const BASE_PORTS = Object.freeze([5620, 5640]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
export const MAX_GOON_PACKAGE_SELECTION_BYTES = 1024 * 1024 * 1024;
export const MAX_GOON_PACKAGE_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const GOON_PACKAGE_HANDLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeLoopbackOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    !parsed.port
  ) {
    return null;
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return parsed.origin;
}

export function collectAllowedOrigins(env = process.env) {
  const origins = new Set(['batshit-shell://app']);
  for (const port of BASE_PORTS) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }

  const configuredPort = Number(env.BATSHIT_FRONTEND_PORT || 0);
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535) {
    origins.add(`http://127.0.0.1:${configuredPort}`);
    origins.add(`http://localhost:${configuredPort}`);
  }

  for (const key of ['BATSHIT_FRONTEND_URL', 'BATSHIT_MAC_DIRECT_URL']) {
    const origin = normalizeLoopbackOrigin(env[key]);
    if (origin) origins.add(origin);
  }
  return origins;
}

export const MAC_APP_NAME = 'Batshit';
const TEST_PACKAGE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Which app this shell is (BL-72). A test package built with `rebuild-mac-app.sh --artifact-suffix
 * -<Label>` is named "Batshit <Label>" (its package.json `productName`, from `macPackageIdentity` in
 * package-mac-app.mjs) and keeps its data in "Batshit-<Label>" folders, so its name, its Keychain
 * entry ("<name> Safe Storage"), its folders, and its one-instance lock never touch the real app's.
 * The real app and an unpackaged shell are "Batshit", as before. Any other packaged name is refused:
 * acting as the real app would put a test build on the real app's data.
 */
export function resolveMacShellIdentity({ packaged, packagedName }) {
  if (!packaged || packagedName === MAC_APP_NAME) {
    return { appName: MAC_APP_NAME, dataFolderName: MAC_APP_NAME, testPackage: false };
  }
  const prefix = `${MAC_APP_NAME} `;
  const label = typeof packagedName === 'string' && packagedName.startsWith(prefix) ? packagedName.slice(prefix.length) : '';
  if (!TEST_PACKAGE_LABEL.test(label)) {
    throw new Error(
      `This Mac package calls itself "${packagedName}", which is neither Batshit nor a Batshit test package ("Batshit <Label>").`
    );
  }
  return { appName: packagedName, dataFolderName: `${MAC_APP_NAME}-${label}`, testPackage: true };
}

/**
 * The folders a test package uses when its launcher named none (opened from Finder or the Dock):
 * its own, never the real app's. main.mjs adds them to its environment, which the runtime supervisor
 * inherits. Folders a launcher set win; the real app adds none.
 */
export function macShellFolderEnv(identity, env = process.env, homePath = '') {
  if (!identity?.testPackage) return {};
  const folder = identity.dataFolderName;
  const defaults = {
    BATSHIT_MAC_DATA_DIR: join(homePath, 'Library', 'Application Support', folder),
    BATSHIT_MAC_LOG_DIR: join(homePath, 'Library', 'Logs', folder),
    BATSHIT_MAC_CACHE_DIR: join(homePath, 'Library', 'Caches', folder)
  };
  return Object.fromEntries(Object.entries(defaults).filter(([key]) => !env[key]));
}

export const DEV_TOOLS_OPT_IN_FILENAME = 'enable-devtools';

export function resolveMacDataRoot(env = process.env, homePath = '') {
  return env.BATSHIT_MAC_DATA_DIR || join(homePath, 'Library', 'Application Support', 'Batshit');
}

export function resolveDevToolsOptInPath(env = process.env, homePath = '') {
  return join(resolveMacDataRoot(env, homePath), DEV_TOOLS_OPT_IN_FILENAME);
}

export function resolveDevToolsEnabled({
  env = process.env,
  homePath = '',
  fileExists = () => false
} = {}) {
  if (env.BATSHIT_MAC_ENABLE_DEVTOOLS === '1') return true;
  if (env.BATSHIT_MAC_ENABLE_DEVTOOLS === '0') return false;
  return fileExists(resolveDevToolsOptInPath(env, homePath)) === true;
}

export const CUSTOM_CSS_FILENAME = 'custom.css';

export function resolveCustomCssPath(env = process.env, homePath = '') {
  const configured = typeof env.BATSHIT_MAC_CUSTOM_CSS === 'string' ? env.BATSHIT_MAC_CUSTOM_CSS.trim() : '';
  if (configured) return configured;
  return join(resolveMacDataRoot(env, homePath), CUSTOM_CSS_FILENAME);
}

export function isAllowedAppUrl(value, allowedOrigins) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'batshit-shell:' && parsed.hostname === 'app') {
      return allowedOrigins.has('batshit-shell://app');
    }
    return allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

export function resolveDesktopControlsUrl(env = process.env) {
  const goonUrl = new URL(resolveDesktopGoonUrl(env));
  goonUrl.pathname = '/desktop-controls';
  return goonUrl.toString();
}

export function isExactDesktopControlsUrl(value, controlsUrl) {
  if (typeof value !== 'string' || typeof controlsUrl !== 'string') return false;
  try {
    const parsed = new URL(value);
    const expected = new URL(controlsUrl);
    return (
      parsed.protocol === 'http:' &&
      parsed.origin === expected.origin &&
      parsed.pathname === '/desktop-controls' &&
      expected.pathname === '/desktop-controls' &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function resolveDesktopGoonUrl(env = process.env) {
  for (const key of ['BATSHIT_FRONTEND_URL', 'BATSHIT_MAC_DIRECT_URL']) {
    const origin = normalizeLoopbackOrigin(env[key]);
    if (origin) return `${origin}${DESKTOP_GOON_ROUTE_PATH}`;
  }
  const configuredPort = Number(env.BATSHIT_FRONTEND_PORT || 0);
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535) {
    return `http://127.0.0.1:${configuredPort}${DESKTOP_GOON_ROUTE_PATH}`;
  }
  return `http://127.0.0.1:5620${DESKTOP_GOON_ROUTE_PATH}`;
}

export function isExactDesktopGoonUrl(value, desktopUrl) {
  if (typeof value !== 'string' || typeof desktopUrl !== 'string') return false;
  try {
    const parsed = new URL(value);
    const expected = new URL(desktopUrl);
    return (
      parsed.protocol === 'http:' &&
      parsed.origin === expected.origin &&
      parsed.pathname === DESKTOP_GOON_ROUTE_PATH &&
      expected.pathname === DESKTOP_GOON_ROUTE_PATH &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function isAllowedMainWindowUrl(
  value,
  allowedOrigins,
  desktopUrl,
  controlsUrl
) {
  return (
    isAllowedAppUrl(value, allowedOrigins) &&
    !isExactDesktopGoonUrl(value, desktopUrl) &&
    !isExactDesktopControlsUrl(value, controlsUrl)
  );
}

export function validateElectronIpcSender(
  event,
  { allowedOrigins, roleRegistry, allowedRoles, desktopUrl, controlsUrl }
) {
  const sender = event?.sender;
  const frame = event?.senderFrame;
  if (!sender || !frame || frame !== sender.mainFrame) {
    throw new Error('The native bridge rejected a non-top-frame sender.');
  }
  const record = roleRegistry.get(sender.id);
  if (!record || record.webContents !== sender || !allowedRoles.includes(record.role)) {
    throw new Error('The native bridge rejected an unexpected window role.');
  }
  const url = frame.url || sender.getURL?.() || '';
  const trusted = record.role === DESKTOP_GOON_WINDOW_ROLES.desktop
    ? isExactDesktopGoonUrl(url, desktopUrl)
    : record.role === DESKTOP_GOON_WINDOW_ROLES.controls
      ? isExactDesktopControlsUrl(url, controlsUrl)
      : isAllowedMainWindowUrl(url, allowedOrigins, desktopUrl, controlsUrl);
  if (!trusted) throw new Error('The native bridge rejected an untrusted sender URL.');
  return record;
}

export function isAllowedElectronMediaPermission({
  webContents,
  permission,
  requestingUrl,
  details = {},
  roleRegistry,
  allowedOrigins,
  desktopUrl,
  controlsUrl
}) {
  const record = webContents ? roleRegistry.get(webContents.id) : null;
  if (
    !record ||
    record.webContents !== webContents ||
    record.role !== DESKTOP_GOON_WINDOW_ROLES.main ||
    !isAllowedMainWindowUrl(
      requestingUrl || webContents.getURL?.() || '',
      allowedOrigins,
      desktopUrl,
      controlsUrl
    ) ||
    permission !== 'media'
  ) {
    return false;
  }
  const mediaTypes = details.mediaTypes || [];
  return mediaTypes.length === 0 || mediaTypes.every((type) => type === 'audio');
}

export function isSafeExternalUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function resolveShellAssetPath(shellRoot, requestUrl) {
  const rawPath = requestUrl.match(/^batshit-shell:\/\/app(\/[^?#]*)?(?:[?#]|$)/)?.[1] || '/';
  if (decodeURIComponent(rawPath).split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Invalid shell asset path.');
  }
  const parsed = new URL(requestUrl);
  if (parsed.protocol !== 'batshit-shell:' || parsed.hostname !== 'app') {
    throw new Error('Shell assets are available only from batshit-shell://app.');
  }
  const decoded = decodeURIComponent(parsed.pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!relative || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid shell asset path.');
  }
  const root = resolve(shellRoot);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('Shell asset path escapes the packaged shell root.');
  }
  return target;
}

export function validateSaveFileOptions(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Save dialog options must be an object.');
  }
  const allowed = new Set(['title', 'defaultPath', 'defaultName']);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported save dialog option: ${key}`);
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || entry.length > 4096 || entry.includes('\0')) {
      throw new Error(`Invalid save dialog option: ${key}`);
    }
    result[key] = entry;
  }
  return result;
}

const BACKUP_PARTIAL_ENTRY_LIMIT = 10_000;
const BACKUP_PARTIAL_STRING_MAX = 4096;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * BL-378 Phase 1b: the partial backup's `partial` option, bounded the way the app route bounds it
 * (1 to 10,000 entries of exactly key, relativePath and fingerprint; keys and paths at most 4,096
 * UTF-16 code units, as `targetPath` is measured here; a 64-lowercase-hex fingerprint;
 * confirmAllMissing only true). The route checks it again in full. A fresh copy goes on, never the
 * renderer's object.
 */
function validateBackupPartialOption(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backup export partial must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'acknowledged' && key !== 'confirmAllMissing') throw new Error(`Unsupported backup export partial option: ${key}`);
  }
  if (value.confirmAllMissing !== undefined && value.confirmAllMissing !== true) {
    throw new Error('Backup export confirmAllMissing may only be true.');
  }
  const list = value.acknowledged;
  if (!Array.isArray(list) || list.length < 1 || list.length > BACKUP_PARTIAL_ENTRY_LIMIT) {
    throw new Error(`Backup export partial must list 1 to ${BACKUP_PARTIAL_ENTRY_LIMIT} upload records.`);
  }
  const acknowledged = list.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Backup export partial entries must be objects.');
    }
    const fields = Object.keys(entry);
    if (fields.length !== 3 || !['key', 'relativePath', 'fingerprint'].every((field) => Object.hasOwn(entry, field))) {
      throw new Error('Backup export partial entries must have exactly key, relativePath and fingerprint.');
    }
    for (const field of ['key', 'relativePath']) {
      const text = entry[field];
      if (typeof text !== 'string' || !text || text.length > BACKUP_PARTIAL_STRING_MAX || text.includes('\0')) {
        throw new Error(`Backup export partial ${field} is invalid.`);
      }
    }
    if (typeof entry.fingerprint !== 'string' || !SHA256_HEX.test(entry.fingerprint)) {
      throw new Error('Backup export partial fingerprint is invalid.');
    }
    return { key: entry.key, relativePath: entry.relativePath, fingerprint: entry.fingerprint };
  });
  return value.confirmAllMissing === true ? { acknowledged, confirmAllMissing: true } : { acknowledged };
}

export function validateBackupExportOptions(value) {
  if (value === undefined || value === null) return { includeSecrets: false };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backup export options must be an object.');
  }
  const allowed = new Set(['includeSecrets', 'partial']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported backup export option: ${key}`);
  }
  if (value.includeSecrets !== undefined && typeof value.includeSecrets !== 'boolean') {
    throw new Error('Backup export includeSecrets must be a boolean.');
  }
  const options = { includeSecrets: value.includeSecrets === true };
  if (value.partial !== undefined) options.partial = validateBackupPartialOption(value.partial);
  return options;
}

export function resolveBackupExportUrl(value, allowedOrigins, desktopUrl, controlsUrl) {
  if (!isAllowedMainWindowUrl(value, allowedOrigins, desktopUrl, controlsUrl)) {
    throw new Error('Backup export requires the authenticated main Batshit window.');
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('Backup export requires the local Batshit app origin.');
  }
  parsed.pathname = '/api/admin/backup/export';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function validateGoonPackageFileSelection(filePath, stats) {
  if (
    typeof filePath !== 'string' ||
    !filePath ||
    filePath.includes('\0') ||
    filePath.length > 4096 ||
    !isAbsolute(filePath)
  ) {
    throw new Error('The selected Goon package path is invalid.');
  }
  const extension = extname(filePath).toLowerCase();
  if (extension !== '.bgoon' && extension !== '.zip') {
    throw new Error('Goon File Package must be a .bgoon or .zip archive.');
  }
  if (!stats || typeof stats.isFile !== 'function' || !stats.isFile()) {
    throw new Error('The selected Goon package is not a regular file.');
  }
  if (!Number.isSafeInteger(stats.size) || stats.size <= 0) {
    throw new Error('The selected Goon package is empty or has an invalid size.');
  }
  if (stats.size > MAX_GOON_PACKAGE_SELECTION_BYTES) {
    throw new Error('The selected Goon package exceeds the 1 GB limit.');
  }
  return Object.freeze({
    name: basename(filePath),
    size: stats.size,
    mimeType: 'application/zip'
  });
}

export function validateGoonPackageHandleId(value) {
  if (typeof value !== 'string' || !GOON_PACKAGE_HANDLE_ID.test(value)) {
    throw new Error('Invalid Goon package selection handle.');
  }
  return value;
}

export function validateGoonPackageReadRequest(value, selectionSize) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Goon package read request must be an object.');
  }
  const allowed = new Set(['handleId', 'offset', 'length']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported Goon package read option: ${key}`);
  }
  const handleId = validateGoonPackageHandleId(value.handleId);
  const { offset, length } = value;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Invalid Goon package read offset.');
  }
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > MAX_GOON_PACKAGE_READ_CHUNK_BYTES
  ) {
    throw new Error('Invalid Goon package read length.');
  }
  if (!Number.isSafeInteger(selectionSize) || selectionSize <= 0 || offset + length > selectionSize) {
    throw new Error('Goon package read exceeds the selected file.');
  }
  return Object.freeze({ handleId, offset, length });
}
