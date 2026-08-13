import { resolve, sep } from 'node:path';

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
