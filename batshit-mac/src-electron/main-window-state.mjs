import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizeMainWindowBounds } from './main-window-policy.mjs';

export const MAIN_WINDOW_STATE_VERSION = 'main-window-state/v1';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateMainWindowState(value) {
  if (!isPlainObject(value)) throw new Error('Main window state must be an object.');
  const allowed = new Set(['schemaVersion', 'bounds', 'maximized']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported main window state field: ${key}`);
  }
  if (value.schemaVersion !== MAIN_WINDOW_STATE_VERSION) {
    throw new Error(`Main window state must use ${MAIN_WINDOW_STATE_VERSION}.`);
  }
  if (typeof value.maximized !== 'boolean') {
    throw new Error('Main window maximized must be a boolean.');
  }
  return Object.freeze({
    schemaVersion: MAIN_WINDOW_STATE_VERSION,
    bounds: normalizeMainWindowBounds(value.bounds),
    maximized: value.maximized
  });
}

export async function readMainWindowState(filePath) {
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
    throw new Error('Main window state contains invalid JSON.');
  }
  return validateMainWindowState(parsed);
}

export async function writeMainWindowState(filePath, value) {
  const state = validateMainWindowState(value);
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
