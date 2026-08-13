export const DESKTOP_GOON_ROUTE_PATH = '/desktop-goon';
export const DESKTOP_GOON_MINIMUM_WIDTH = 240;
export const DESKTOP_GOON_MINIMUM_HEIGHT = 240;

export const DEFAULT_DESKTOP_GOON_PREFERENCES = Object.freeze({
  fullHeight: true,
  normalizedWidth: 0.35,
  stayOnTop: true,
  clickThrough: false,
  controlsShortcut: 'CommandOrControl+Shift+G',
  workspace: 'current-workspace'
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  const result = Math.round(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside the supported range.`);
  return result;
}

export function normalizeDesktopGoonPreferences(value = {}) {
  if (!isPlainObject(value)) throw new Error('Desktop Goon preferences must be an object.');
  const allowed = new Set([
    'fullHeight',
    'normalizedWidth',
    'stayOnTop',
    'clickThrough',
    'controlsShortcut',
    'workspace'
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported Desktop Goon preference: ${key}`);
  }
  const result = { ...DEFAULT_DESKTOP_GOON_PREFERENCES, ...value };
  for (const key of ['fullHeight', 'stayOnTop', 'clickThrough']) {
    if (typeof result[key] !== 'boolean') throw new Error(`Desktop Goon ${key} must be boolean.`);
  }
  if (
    !Number.isFinite(result.normalizedWidth) ||
    result.normalizedWidth < 0.1 ||
    result.normalizedWidth > 1
  ) {
    throw new Error('Desktop Goon normalizedWidth must be between 0.1 and 1.');
  }
  if (
    typeof result.controlsShortcut !== 'string' ||
    !result.controlsShortcut.trim() ||
    result.controlsShortcut.length > 128 ||
    result.controlsShortcut.includes('\0')
  ) {
    throw new Error('Desktop Goon controlsShortcut must be a bounded accelerator string.');
  }
  if (!['current-workspace', 'all-workspaces'].includes(result.workspace)) {
    throw new Error('Desktop Goon workspace must be current-workspace or all-workspaces.');
  }
  return Object.freeze(result);
}

export function normalizeDesktopGoonBounds(value) {
  if (!isPlainObject(value)) throw new Error('Desktop Goon bounds must be an object.');
  const allowed = new Set(['x', 'y', 'width', 'height']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported Desktop Goon bounds field: ${key}`);
  }
  for (const key of allowed) {
    if (value[key] === undefined) throw new Error(`Desktop Goon bounds are missing ${key}.`);
  }
  return Object.freeze({
    x: boundedInteger(value.x, 'Desktop Goon x'),
    y: boundedInteger(value.y, 'Desktop Goon y'),
    width: boundedInteger(value.width, 'Desktop Goon width'),
    height: boundedInteger(value.height, 'Desktop Goon height')
  });
}

export function clampDesktopGoonBounds({ bounds, workArea, preferences }) {
  const requested = normalizeDesktopGoonBounds(bounds);
  const area = normalizeDesktopGoonBounds(workArea);
  const prefs = normalizeDesktopGoonPreferences(preferences);
  if (area.width < 1 || area.height < 1) throw new Error('Desktop Goon display work area is empty.');

  const minimumWidth = Math.min(DESKTOP_GOON_MINIMUM_WIDTH, area.width);
  const minimumHeight = Math.min(DESKTOP_GOON_MINIMUM_HEIGHT, area.height);
  const preferredWidth = Math.round(area.width * prefs.normalizedWidth);
  const width = Math.min(
    area.width,
    Math.max(minimumWidth, Number.isFinite(requested.width) ? requested.width : preferredWidth)
  );
  const height = prefs.fullHeight
    ? area.height
    : Math.min(area.height, Math.max(minimumHeight, requested.height));
  const maximumX = area.x + area.width - width;
  const maximumY = area.y + area.height - height;
  return Object.freeze({
    x: Math.min(maximumX, Math.max(area.x, requested.x)),
    y: prefs.fullHeight ? area.y : Math.min(maximumY, Math.max(area.y, requested.y)),
    width,
    height
  });
}

export function defaultDesktopGoonBounds(workArea, preferences = {}) {
  const area = normalizeDesktopGoonBounds(workArea);
  const prefs = normalizeDesktopGoonPreferences(preferences);
  const width = Math.min(
    area.width,
    Math.max(DESKTOP_GOON_MINIMUM_WIDTH, Math.round(area.width * prefs.normalizedWidth))
  );
  const height = prefs.fullHeight
    ? area.height
    : Math.min(area.height, Math.max(DESKTOP_GOON_MINIMUM_HEIGHT, Math.round(area.height * 0.7)));
  return clampDesktopGoonBounds({
    bounds: {
      x: area.x + area.width - width,
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height
    },
    workArea: area,
    preferences: prefs
  });
}

export function resolveDesktopGoonWindowPolicy(platform, preferences = {}) {
  const prefs = normalizeDesktopGoonPreferences(preferences);
  if (!['darwin', 'win32'].includes(platform)) {
    return Object.freeze({
      supported: false,
      platform,
      reason: 'Desktop Mode is supported only by the managed Mac app in this release.',
      capabilities: Object.freeze({ allWorkspaces: false })
    });
  }
  const darwin = platform === 'darwin';
  return Object.freeze({
    supported: true,
    platform,
    browserWindowOptions: Object.freeze({
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      focusable: true,
      alwaysOnTop: prefs.stayOnTop
    }),
    effects: Object.freeze({
      showInactive: true,
      alwaysOnTop: prefs.stayOnTop,
      alwaysOnTopLevel: darwin ? 'floating' : 'normal',
      ignoreMouseEvents: prefs.clickThrough,
      forwardMouseEvents: true,
      visibleOnAllWorkspaces: darwin ? prefs.workspace === 'all-workspaces' : null
    }),
    capabilities: Object.freeze({ allWorkspaces: darwin })
  });
}

export function applyDesktopWorkspacePolicy(window, platform, preferences = {}) {
  const prefs = normalizeDesktopGoonPreferences(preferences);
  const desiredAllWorkspaces = prefs.workspace === 'all-workspaces';
  if (platform !== 'darwin') {
    return Object.freeze({
      supported: false,
      preference: prefs.workspace,
      desiredAllWorkspaces: false,
      appliedAllWorkspaces: null,
      matches: null
    });
  }
  if (!window || typeof window.setVisibleOnAllWorkspaces !== 'function') {
    throw new Error('Desktop workspace policy requires a macOS BrowserWindow.');
  }
  window.setVisibleOnAllWorkspaces(desiredAllWorkspaces, {
    visibleOnFullScreen: desiredAllWorkspaces,
    skipTransformProcessType: false
  });
  const appliedAllWorkspaces = typeof window.isVisibleOnAllWorkspaces === 'function'
    ? window.isVisibleOnAllWorkspaces()
    : null;
  if (appliedAllWorkspaces !== null && appliedAllWorkspaces !== desiredAllWorkspaces) {
    throw new Error(
      `Desktop workspace policy readback mismatch: expected ${desiredAllWorkspaces}, received ${appliedAllWorkspaces}.`
    );
  }
  return Object.freeze({
    supported: true,
    preference: prefs.workspace,
    desiredAllWorkspaces,
    appliedAllWorkspaces,
    matches: appliedAllWorkspaces === null ? null : true
  });
}
