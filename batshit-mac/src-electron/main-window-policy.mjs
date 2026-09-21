const MAIN_CHAT_MIN_WIDTH = 480;
const PERSISTENT_RAIL_WIDTH = 48;
const MAIN_WINDOW_MIN_WIDTH = MAIN_CHAT_MIN_WIDTH + (PERSISTENT_RAIL_WIDTH * 2);
const MAIN_WINDOW_MIN_HEIGHT = 720;
/** A restored window must keep at least this much of itself reachable on screen. */
const MIN_VISIBLE_EDGE = 80;

export function resolveMainWindowSizePolicy() {
  return Object.freeze({
    width: 1600,
    height: 1000,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  if (Math.abs(value) > 1_000_000) throw new Error(`${label} is out of range.`);
  return value;
}

export function normalizeMainWindowBounds(value) {
  if (!isPlainObject(value)) throw new Error('Main window bounds must be an object.');
  const allowed = new Set(['x', 'y', 'width', 'height']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported main window bounds field: ${key}`);
  }
  for (const key of allowed) {
    if (value[key] === undefined) throw new Error(`Main window bounds are missing ${key}.`);
  }
  const width = boundedInteger(value.width, 'Main window width');
  const height = boundedInteger(value.height, 'Main window height');
  if (width < 1 || height < 1) throw new Error('Main window bounds must have a positive size.');
  return Object.freeze({
    x: boundedInteger(value.x, 'Main window x'),
    y: boundedInteger(value.y, 'Main window y'),
    width,
    height
  });
}

/**
 * Fit a remembered window onto a work area that may have changed since it was
 * saved. A display can be disconnected, resized, or rearranged between runs, so
 * restored bounds are never trusted: the window is clamped to the minimum usable
 * size, shrunk to fit a smaller screen, and pulled back until a reachable strip
 * of its title bar is on screen. Returning bounds that are off-screen would
 * leave the window impossible to move without resetting state by hand.
 */
export function restoreMainWindowBounds({ saved, workArea }) {
  const requested = normalizeMainWindowBounds(saved);
  const area = normalizeMainWindowBounds(workArea);
  if (area.width < 1 || area.height < 1) throw new Error('Main window work area is empty.');

  const width = Math.min(area.width, Math.max(MAIN_WINDOW_MIN_WIDTH, requested.width));
  const height = Math.min(area.height, Math.max(MAIN_WINDOW_MIN_HEIGHT, requested.height));
  const visible = Math.min(MIN_VISIBLE_EDGE, width, height);

  return Object.freeze({
    x: Math.min(area.x + area.width - visible, Math.max(area.x - width + visible, requested.x)),
    y: Math.min(area.y + area.height - visible, Math.max(area.y, requested.y)),
    width,
    height
  });
}
