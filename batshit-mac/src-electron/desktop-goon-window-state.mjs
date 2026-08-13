import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizeDesktopGoonBounds } from './desktop-goon-window-policy.mjs';

export const DESKTOP_GOON_WINDOW_STATE_VERSION = 'desktop-goon-window-state/v1';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateDesktopGoonWindowState(value) {
  if (!isPlainObject(value)) throw new Error('Desktop Goon window state must be an object.');
  const allowed = new Set(['schemaVersion', 'displayId', 'bounds']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported Desktop Goon window state field: ${key}`);
  }
  if (value.schemaVersion !== DESKTOP_GOON_WINDOW_STATE_VERSION) {
    throw new Error(`Desktop Goon window state must use ${DESKTOP_GOON_WINDOW_STATE_VERSION}.`);
  }
  if (
    !['string', 'number'].includes(typeof value.displayId) ||
    (typeof value.displayId === 'number' && !Number.isSafeInteger(value.displayId)) ||
    !String(value.displayId).trim() ||
    String(value.displayId).length > 128
  ) {
    throw new Error('Desktop Goon displayId must be a bounded string or number.');
  }
  return Object.freeze({
    schemaVersion: DESKTOP_GOON_WINDOW_STATE_VERSION,
    displayId: String(value.displayId),
    bounds: normalizeDesktopGoonBounds(value.bounds)
  });
}

export async function readDesktopGoonWindowState(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Desktop Goon window state contains invalid JSON.');
  }
  return validateDesktopGoonWindowState(parsed);
}

export async function writeDesktopGoonWindowState(filePath, value) {
  const state = validateDesktopGoonWindowState(value);
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
    const targetHandle = await open(filePath, 'r+');
    try {
      await targetHandle.chmod(0o600);
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  return state;
}
