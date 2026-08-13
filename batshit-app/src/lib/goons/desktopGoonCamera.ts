import type { GoonCamera } from '$lib/types/goons'

export const DESKTOP_GOON_CAMERA_SCHEMA_VERSION = 'desktop-goon-camera/v1' as const

const MAX_POINTER_DELTA = 4096
const MAX_VIEWPORT_HEIGHT = 16384
const MAX_ZOOM_DELTA = 120
const MAX_ROTATION_DELTA = Math.PI * 2
const MAX_VERTICAL_ORBIT_DELTA = Math.PI / 2
const MIN_FOV = 15
const MAX_FOV = 100
const MAX_CAMERA_DISTANCE = 10_000
const MAX_CAMERA_COORDINATE = 10_000
const MAX_ROTATION_MAGNITUDE = 1_000_000

export type DesktopGoonCameraStateV1 = {
  schemaVersion: typeof DESKTOP_GOON_CAMERA_SCHEMA_VERSION
  camera: GoonCamera & { mode?: 'free' }
  goonRotation: number
}

type DesktopGoonCameraCommandBase = {
  schemaVersion: typeof DESKTOP_GOON_CAMERA_SCHEMA_VERSION
}

export type DesktopGoonCameraCommandV1 =
  | (DesktopGoonCameraCommandBase & {
      kind: 'zoom'
      delta: number
      pointerNdc: { x: number; y: number }
    })
  | (DesktopGoonCameraCommandBase & {
      kind: 'pan'
      deltaX: number
      deltaY: number
      viewportHeight: number
    })
  | (DesktopGoonCameraCommandBase & {
      kind: 'orbit-vertical'
      source: 'manual'
      deltaPitchRadians: number
    })
  | (DesktopGoonCameraCommandBase & {
      kind: 'rotate-goon'
      deltaRadians: number
    })
  | (DesktopGoonCameraCommandBase & {
      kind: 'set-fov'
      fov: number
    })
  | (DesktopGoonCameraCommandBase & {
      kind: 'apply-state'
      state: DesktopGoonCameraStateV1
    })
  | (DesktopGoonCameraCommandBase & {
      kind: 'capture-state'
    })

export type DesktopGoonCameraCommandErrorCode =
  | 'INVALID_COMMAND'
  | 'UNSUPPORTED_VERSION'
  | 'ORBIT_FORBIDDEN'
  | 'NON_MANUAL_CONTROL_FORBIDDEN'
  | 'INDOOR_CAMERA_FORBIDDEN'

export class DesktopGoonCameraCommandError extends Error {
  readonly code: DesktopGoonCameraCommandErrorCode

  constructor(code: DesktopGoonCameraCommandErrorCode, message: string) {
    super(message)
    this.name = 'DesktopGoonCameraCommandError'
    this.code = code
  }
}

function fail(code: DesktopGoonCameraCommandErrorCode, message: string): never {
  throw new DesktopGoonCameraCommandError(code, message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_COMMAND', `${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function finite(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('INVALID_COMMAND', `${label} must be a finite number from ${minimum} to ${maximum}.`)
  }
  return value
}

function optionalFinite(value: unknown, label: string, minimum: number, maximum: number) {
  if (value === undefined) return undefined
  return finite(value, label, minimum, maximum)
}

function parseCamera(value: unknown): DesktopGoonCameraStateV1['camera'] {
  const input = record(value, 'Desktop Goon camera state')
  if (input.mode === 'indoor') {
    fail('INDOOR_CAMERA_FORBIDDEN', 'Desktop Mode does not support Indoor Camera.')
  }
  if (input.mode !== undefined && input.mode !== 'free') {
    fail('INVALID_COMMAND', 'Desktop Goon camera mode must be free when provided.')
  }

  let orbitTarget: GoonCamera['orbitTarget']
  if (input.orbitTarget !== undefined) {
    const target = record(input.orbitTarget, 'Desktop Goon orbit target')
    orbitTarget = {
      x: optionalFinite(
        target.x,
        'Desktop Goon orbit target x',
        -MAX_CAMERA_COORDINATE,
        MAX_CAMERA_COORDINATE
      ),
      y: optionalFinite(
        target.y,
        'Desktop Goon orbit target y',
        -MAX_CAMERA_COORDINATE,
        MAX_CAMERA_COORDINATE
      ),
      z: optionalFinite(
        target.z,
        'Desktop Goon orbit target z',
        -MAX_CAMERA_COORDINATE,
        MAX_CAMERA_COORDINATE
      )
    }
  }

  return {
    ...(orbitTarget ? { orbitTarget } : {}),
    ...(input.distance !== undefined
      ? { distance: finite(input.distance, 'Desktop Goon camera distance', 0, MAX_CAMERA_DISTANCE) }
      : {}),
    ...(input.yaw !== undefined
      ? {
          yaw: finite(
            input.yaw,
            'Desktop Goon camera yaw',
            -MAX_ROTATION_MAGNITUDE,
            MAX_ROTATION_MAGNITUDE
          )
        }
      : {}),
    ...(input.pitch !== undefined
      ? { pitch: finite(input.pitch, 'Desktop Goon camera pitch', -Math.PI / 2, Math.PI / 2) }
      : {}),
    ...(input.zoom !== undefined
      ? { zoom: finite(input.zoom, 'Desktop Goon camera zoom', 0, 1) }
      : {}),
    ...(input.fov !== undefined
      ? { fov: finite(input.fov, 'Desktop Goon camera FOV', MIN_FOV, MAX_FOV) }
      : {}),
    ...(input.mode === 'free' ? { mode: 'free' as const } : {})
  }
}

export function parseDesktopGoonCameraStateV1(value: unknown): DesktopGoonCameraStateV1 {
  const input = record(value, 'Desktop Goon camera snapshot')
  if (input.schemaVersion !== DESKTOP_GOON_CAMERA_SCHEMA_VERSION) {
    fail('UNSUPPORTED_VERSION', 'Desktop Goon camera snapshot version is unsupported.')
  }
  return {
    schemaVersion: DESKTOP_GOON_CAMERA_SCHEMA_VERSION,
    camera: parseCamera(input.camera),
    goonRotation: finite(
      input.goonRotation,
      'Desktop Goon rotation',
      -MAX_ROTATION_MAGNITUDE,
      MAX_ROTATION_MAGNITUDE
    )
  }
}

export function parseDesktopGoonCameraCommandV1(value: unknown): DesktopGoonCameraCommandV1 {
  const input = record(value, 'Desktop Goon camera command')
  if (input.schemaVersion !== DESKTOP_GOON_CAMERA_SCHEMA_VERSION) {
    fail('UNSUPPORTED_VERSION', 'Desktop Goon camera command version is unsupported.')
  }
  if (input.kind === 'orbit' || (input.kind === 'set-camera-mode' && input.mode === 'indoor')) {
    fail(
      input.kind === 'orbit' ? 'ORBIT_FORBIDDEN' : 'INDOOR_CAMERA_FORBIDDEN',
      input.kind === 'orbit'
        ? 'Desktop Mode does not support horizontal or free camera orbit.'
        : 'Desktop Mode does not support Indoor Camera.'
    )
  }

  const base = { schemaVersion: DESKTOP_GOON_CAMERA_SCHEMA_VERSION }
  switch (input.kind) {
    case 'zoom': {
      const pointer = record(input.pointerNdc, 'Desktop Goon zoom pointer')
      return {
        ...base,
        kind: 'zoom',
        delta: finite(input.delta, 'Desktop Goon zoom delta', -MAX_ZOOM_DELTA, MAX_ZOOM_DELTA),
        pointerNdc: {
          x: finite(pointer.x, 'Desktop Goon zoom pointer x', -1, 1),
          y: finite(pointer.y, 'Desktop Goon zoom pointer y', -1, 1)
        }
      }
    }
    case 'pan':
      return {
        ...base,
        kind: 'pan',
        deltaX: finite(
          input.deltaX,
          'Desktop Goon pan delta x',
          -MAX_POINTER_DELTA,
          MAX_POINTER_DELTA
        ),
        deltaY: finite(
          input.deltaY,
          'Desktop Goon pan delta y',
          -MAX_POINTER_DELTA,
          MAX_POINTER_DELTA
        ),
        viewportHeight: finite(
          input.viewportHeight,
          'Desktop Goon viewport height',
          1,
          MAX_VIEWPORT_HEIGHT
        )
      }
    case 'orbit-vertical':
      if (input.source !== 'manual') {
        fail(
          'NON_MANUAL_CONTROL_FORBIDDEN',
          'Desktop Goon vertical orbit is available only from manual user input.'
        )
      }
      return {
        ...base,
        kind: 'orbit-vertical',
        source: 'manual',
        deltaPitchRadians: finite(
          input.deltaPitchRadians,
          'Desktop Goon vertical orbit delta',
          -MAX_VERTICAL_ORBIT_DELTA,
          MAX_VERTICAL_ORBIT_DELTA
        )
      }
    case 'rotate-goon':
      return {
        ...base,
        kind: 'rotate-goon',
        deltaRadians: finite(
          input.deltaRadians,
          'Desktop Goon rotation delta',
          -MAX_ROTATION_DELTA,
          MAX_ROTATION_DELTA
        )
      }
    case 'set-fov':
      return {
        ...base,
        kind: 'set-fov',
        fov: finite(input.fov, 'Desktop Goon camera FOV', MIN_FOV, MAX_FOV)
      }
    case 'apply-state':
      return { ...base, kind: 'apply-state', state: parseDesktopGoonCameraStateV1(input.state) }
    case 'capture-state':
      return { ...base, kind: 'capture-state' }
    default:
      fail('INVALID_COMMAND', `Unsupported Desktop Goon camera command: ${String(input.kind)}.`)
  }
}
