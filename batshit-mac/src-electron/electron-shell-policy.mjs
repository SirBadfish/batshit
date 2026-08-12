import { resolve, sep } from 'node:path';

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
