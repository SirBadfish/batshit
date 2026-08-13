import type {
  DesktopGoonMessagePortLike,
  DesktopGoonPortEventListener,
  DesktopGoonPortEventType
} from '$lib/goons/desktopGoonStateBridge'

export const DESKTOP_GOON_SHELL_SCHEMA_VERSION = 'desktop-goon/v1' as const

export type DesktopGoonWindowRole = 'main' | 'desktop'

export type DesktopGoonStatePortFacade = {
  generation: number
  metadata: Readonly<{
    schemaVersion: typeof DESKTOP_GOON_SHELL_SCHEMA_VERSION
    generation: number
    role: DesktopGoonWindowRole
  }>
  postMessage(value: unknown): void
  onMessage(listener: (value: unknown) => void): () => void
  onClose(listener: (event: { generation: number; reason: string }) => void): () => void
  close(): void
}

export type DesktopGoonShellStatus = {
  schemaVersion: typeof DESKTOP_GOON_SHELL_SCHEMA_VERSION
  type?: string
  supported?: boolean
  active?: boolean
  rendererReady?: boolean
  adjustMode?: boolean
  unavailableReason?: string | null
  detail?: Record<string, unknown>
  status?: DesktopGoonShellStatus | null
  [key: string]: unknown
}

export type DesktopGoonNativeBridge = {
  schemaVersion: typeof DESKTOP_GOON_SHELL_SCHEMA_VERSION
  role: DesktopGoonWindowRole
  invoke(command: string, payload?: Record<string, unknown>): Promise<DesktopGoonShellStatus>
  onStatus(listener: (status: DesktopGoonShellStatus) => void): () => void
  onStatePort(listener: (port: DesktopGoonStatePortFacade) => void): () => void
}

type DesktopGoonWindow = Window & {
  zero?: { desktopGoon?: DesktopGoonNativeBridge }
}

export function getDesktopGoonNativeBridge(
  expectedRole?: DesktopGoonWindowRole
): DesktopGoonNativeBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as DesktopGoonWindow).zero?.desktopGoon
  if (
    !bridge ||
    bridge.schemaVersion !== DESKTOP_GOON_SHELL_SCHEMA_VERSION ||
    (expectedRole && bridge.role !== expectedRole)
  ) {
    return null
  }
  return bridge
}

/** Adapt the frozen preload facade without exposing Electron or a raw port. */
export function adaptDesktopGoonStatePort(
  facade: DesktopGoonStatePortFacade
): DesktopGoonMessagePortLike {
  const listeners: Record<DesktopGoonPortEventType, Set<DesktopGoonPortEventListener>> = {
    message: new Set(),
    messageerror: new Set()
  }
  let closed = false
  const unsubscribeMessage = facade.onMessage((value) => {
    if (closed) return
    for (const listener of listeners.message) listener({ data: value })
  })
  const unsubscribeClose = facade.onClose((event) => {
    if (closed) return
    closed = true
    // Electron intentionally closes both ends before destroying the Desktop
    // window. Treat only preload validation failures as transport errors;
    // controller-driven closes are followed by the authoritative shell status
    // and must not remount a second renderer before the window is gone.
    if (event.reason === 'invalid-message') {
      for (const listener of listeners.messageerror) listener({ data: event })
    }
    listeners.message.clear()
    listeners.messageerror.clear()
  })

  return {
    postMessage(value) {
      if (closed) throw new Error('Desktop Goon state port is closed.')
      facade.postMessage(value)
    },
    addEventListener(type, listener) {
      listeners[type].add(listener)
    },
    removeEventListener(type, listener) {
      listeners[type].delete(listener)
    },
    start() {
      // The isolated preload owns and starts the raw MessagePort.
    },
    close() {
      if (closed) return
      closed = true
      unsubscribeMessage()
      unsubscribeClose()
      listeners.message.clear()
      listeners.messageerror.clear()
      facade.close()
    }
  }
}
