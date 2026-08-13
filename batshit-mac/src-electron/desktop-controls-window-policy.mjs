import {
  DEFAULT_DESKTOP_GOON_PREFERENCES,
  applyDesktopWorkspacePolicy,
  normalizeDesktopGoonBounds
} from './desktop-goon-window-policy.mjs';

export const DESKTOP_CONTROLS_DEFAULT_WIDTH = 560;
export const DESKTOP_CONTROLS_DEFAULT_HEIGHT = 88;
export const DESKTOP_CONTROLS_MINIMUM_WIDTH = 400;
export const DESKTOP_CONTROLS_MINIMUM_HEIGHT = 56;

export function normalizeDesktopControlsWorkspace(value) {
  if (value !== 'current-workspace' && value !== 'all-workspaces') {
    throw new Error('Desktop Controls workspace must be current-workspace or all-workspaces.');
  }
  return value;
}

export function clampDesktopControlsBounds(bounds, workArea) {
  const requested = normalizeDesktopGoonBounds(bounds);
  const area = normalizeDesktopGoonBounds(workArea);
  if (area.width < 1 || area.height < 1) throw new Error('Desktop Controls work area is empty.');
  const width = Math.min(
    area.width,
    Math.max(Math.min(DESKTOP_CONTROLS_MINIMUM_WIDTH, area.width), requested.width)
  );
  const height = Math.min(
    area.height,
    Math.max(Math.min(DESKTOP_CONTROLS_MINIMUM_HEIGHT, area.height), requested.height)
  );
  return Object.freeze({
    x: Math.min(area.x + area.width - width, Math.max(area.x, requested.x)),
    y: Math.min(area.y + area.height - height, Math.max(area.y, requested.y)),
    width,
    height
  });
}

export function defaultDesktopControlsBounds(workArea) {
  const area = normalizeDesktopGoonBounds(workArea);
  const width = Math.min(area.width, DESKTOP_CONTROLS_DEFAULT_WIDTH);
  const height = Math.min(area.height, DESKTOP_CONTROLS_DEFAULT_HEIGHT);
  return clampDesktopControlsBounds(
    {
      x: area.x + area.width - width - Math.min(24, Math.max(0, area.width - width)),
      y: area.y + Math.min(24, Math.max(0, area.height - height)),
      width,
      height
    },
    area
  );
}

export function resolveDesktopControlsWindowPolicy(platform, workspace = 'current-workspace') {
  const normalizedWorkspace = normalizeDesktopControlsWorkspace(workspace);
  if (!['darwin', 'win32'].includes(platform)) {
    return Object.freeze({
      supported: false,
      platform,
      reason: 'Desktop Controls require a supported managed desktop shell.'
    });
  }
  return Object.freeze({
    supported: true,
    platform,
    workspace: normalizedWorkspace,
    browserWindowOptions: Object.freeze({
      width: DESKTOP_CONTROLS_DEFAULT_WIDTH,
      height: DESKTOP_CONTROLS_DEFAULT_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      focusable: true,
      alwaysOnTop: true,
      ...(platform === 'darwin' ? { acceptFirstMouse: true } : { thickFrame: false })
    }),
    effects: Object.freeze({
      // The Goon uses `floating` on macOS and `normal` on Windows. Keeping
      // Controls one structural level higher prevents later Goon preference
      // updates from covering the island without placing it above the Dock.
      alwaysOnTopLevel: platform === 'darwin' ? 'status' : 'floating'
    })
  });
}

export function applyDesktopControlsWorkspacePolicy(window, platform, workspace) {
  return applyDesktopWorkspacePolicy(window, platform, {
    ...DEFAULT_DESKTOP_GOON_PREFERENCES,
    workspace: normalizeDesktopControlsWorkspace(workspace)
  });
}
