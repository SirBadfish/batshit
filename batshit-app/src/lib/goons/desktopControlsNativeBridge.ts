export const DESKTOP_CONTROLS_SCHEMA_VERSION = 'desktop-controls/v1' as const

export type DesktopControlsRole = 'main' | 'controls'

export type DesktopControlsCommand =
  | 'desktopControls.getState'
  | 'desktopControls.show'
  | 'desktopControls.hide'
  | 'desktopControls.toggle'
  | 'desktopControls.updateState'
  | 'desktopControls.setAdjust'
  | 'desktopControls.sendIntent'
  | 'desktopControls.rendererReady'

export type DesktopControlsProjection = Record<string, unknown>

export type DesktopControlsShellState = {
  schemaVersion: typeof DESKTOP_CONTROLS_SCHEMA_VERSION
  active: boolean
  visible: boolean
  rendererReady: boolean
  adjustActive: boolean
  goonActive: boolean
  workspace: 'current-workspace' | 'all-workspaces'
  workspacePolicy: Record<string, unknown> | null
  projection: DesktopControlsProjection | null
  displayId: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
}

export type DesktopControlsStateEvent = {
  schemaVersion: typeof DESKTOP_CONTROLS_SCHEMA_VERSION
  type: string
  detail: Record<string, unknown>
  state: DesktopControlsShellState
}

export type DesktopControlsNativeBridge = {
  readonly schemaVersion: typeof DESKTOP_CONTROLS_SCHEMA_VERSION
  readonly role: DesktopControlsRole
  invoke(
    command: DesktopControlsCommand,
    payload?: Record<string, unknown>
  ): Promise<DesktopControlsShellState>
  onState(listener: (event: DesktopControlsStateEvent) => void): () => void
}

type DesktopControlsWindowZero = {
  desktopControls?: DesktopControlsNativeBridge
}

export function getDesktopControlsNativeBridge(
  expectedRole: DesktopControlsRole
): DesktopControlsNativeBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as typeof window & { zero?: DesktopControlsWindowZero }).zero
    ?.desktopControls
  if (
    !bridge ||
    bridge.schemaVersion !== DESKTOP_CONTROLS_SCHEMA_VERSION ||
    bridge.role !== expectedRole ||
    typeof bridge.invoke !== 'function' ||
    typeof bridge.onState !== 'function'
  ) {
    return null
  }
  return bridge
}
