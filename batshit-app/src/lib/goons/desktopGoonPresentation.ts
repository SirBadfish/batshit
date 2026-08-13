export type DesktopGoonPresentationMode = 'dock' | 'immersive' | 'desktop'

export function normalizeDesktopGoonPresentationMode(
  value: unknown
): DesktopGoonPresentationMode | null {
  return value === 'dock' || value === 'immersive' || value === 'desktop' ? value : null
}

export function resolveVisibleGoonPresentationMode(input: {
  dockOpen: boolean
  immersiveMode: boolean
  desktopModeActive: boolean
}): DesktopGoonPresentationMode | null {
  if (input.desktopModeActive) return 'desktop'
  if (!input.dockOpen) return null
  return input.immersiveMode ? 'immersive' : 'dock'
}

export type DesktopGoonPresentationTransition = {
  id: string
  from: DesktopGoonPresentationMode
  to: DesktopGoonPresentationMode
}

export type DesktopGoonPresentationState = {
  mode: DesktopGoonPresentationMode
  transition: DesktopGoonPresentationTransition | null
  lastError: string | null
}

export function createDesktopGoonPresentationState(
  mode: DesktopGoonPresentationMode = 'dock'
): DesktopGoonPresentationState {
  return { mode, transition: null, lastError: null }
}

export function beginDesktopGoonPresentationTransition(
  state: DesktopGoonPresentationState,
  to: DesktopGoonPresentationMode,
  transitionId: string
): DesktopGoonPresentationState {
  const id = transitionId.trim()
  if (!id) throw new Error('Desktop Goon presentation transitions require an id.')
  if (state.transition) {
    throw new Error(`Desktop Goon presentation transition "${state.transition.id}" is still active.`)
  }
  if (state.mode === to) return { ...state, lastError: null }

  return {
    ...state,
    transition: { id, from: state.mode, to },
    lastError: null
  }
}

export function commitDesktopGoonPresentationTransition(
  state: DesktopGoonPresentationState,
  transitionId: string
): DesktopGoonPresentationState {
  if (!state.transition || state.transition.id !== transitionId) {
    throw new Error('Desktop Goon presentation commit does not match the active transition.')
  }
  return {
    mode: state.transition.to,
    transition: null,
    lastError: null
  }
}

export function rollbackDesktopGoonPresentationTransition(
  state: DesktopGoonPresentationState,
  transitionId: string,
  error: string
): DesktopGoonPresentationState {
  if (!state.transition || state.transition.id !== transitionId) {
    throw new Error('Desktop Goon presentation rollback does not match the active transition.')
  }

  const involvedDesktop =
    state.transition.from === 'desktop' || state.transition.to === 'desktop'
  return {
    // Desktop failures always recover to the visible in-app Dock. Other
    // transitions return to their last stable presentation.
    mode: involvedDesktop ? 'dock' : state.transition.from,
    transition: null,
    lastError: error.trim() || 'Desktop Mode transition failed.'
  }
}

export type DesktopGoonCapabilityInput = {
  surface: 'managed-electron' | 'browser' | 'source-web' | 'docker'
  platform?: string | null
}

export type DesktopGoonCapability =
  | {
      available: true
      platform: 'darwin' | 'win32'
      supportsAllWorkspaces: boolean
    }
  | {
      available: false
      code: 'MANAGED_ELECTRON_REQUIRED' | 'PLATFORM_UNSUPPORTED'
      message: string
    }

export function resolveDesktopGoonCapability(
  input: DesktopGoonCapabilityInput
): DesktopGoonCapability {
  if (input.surface !== 'managed-electron') {
    return {
      available: false,
      code: 'MANAGED_ELECTRON_REQUIRED',
      message: 'Desktop Mode requires the managed Batshit desktop app.'
    }
  }
  if (input.platform === 'darwin') {
    return { available: true, platform: 'darwin', supportsAllWorkspaces: true }
  }
  if (input.platform === 'win32') {
    return { available: true, platform: 'win32', supportsAllWorkspaces: false }
  }
  return {
    available: false,
    code: 'PLATFORM_UNSUPPORTED',
    message: 'Desktop Mode is not supported on this operating system.'
  }
}
