import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizeDesktopGoonBounds } from './desktop-goon-window-policy.mjs';

export const DESKTOP_CONTROLS_WINDOW_STATE_VERSION = 'desktop-controls-window-state/v1';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateDesktopControlsWindowState(value) {
  if (!isPlainObject(value)) throw new Error('Desktop Controls window state must be an object.');
  const allowed = new Set(['schemaVersion', 'displayId', 'bounds']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported Desktop Controls state field: ${key}`);
  }
  if (value.schemaVersion !== DESKTOP_CONTROLS_WINDOW_STATE_VERSION) {
    throw new Error(`Desktop Controls state must use ${DESKTOP_CONTROLS_WINDOW_STATE_VERSION}.`);
  }
  if (
    !['string', 'number'].includes(typeof value.displayId) ||
    (typeof value.displayId === 'number' && !Number.isSafeInteger(value.displayId)) ||
    !String(value.displayId).trim() ||
    String(value.displayId).length > 128
  ) {
    throw new Error('Desktop Controls displayId must be a bounded string or number.');
  }
  return Object.freeze({
    schemaVersion: DESKTOP_CONTROLS_WINDOW_STATE_VERSION,
    displayId: String(value.displayId),
    bounds: normalizeDesktopGoonBounds(value.bounds)
  });
}

export async function readDesktopControlsWindowState(filePath) {
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
    throw new Error('Desktop Controls window state contains invalid JSON.');
  }
  return validateDesktopControlsWindowState(parsed);
}

export async function writeDesktopControlsWindowState(filePath, value) {
  const state = validateDesktopControlsWindowState(value);
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
    const target = await open(filePath, 'r+');
    try {
      await target.chmod(0o600);
      await target.sync();
    } finally {
      await target.close();
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
