import {
  parseDesktopGoonCameraCommandV1,
  type DesktopGoonCameraCommandV1,
  type DesktopGoonCameraStateV1
} from '$lib/goons/desktopGoonCamera'
import type { GoonCamera } from '$lib/types/goons'

export type DesktopGoonCameraEngine = {
  applyDesktopCameraZoom(delta: number, pointerNdc: { x: number; y: number }): boolean
  applyDesktopCameraPan(deltaX: number, deltaY: number, viewportHeight: number): boolean
  applyDesktopCameraVerticalOrbit(deltaPitchRadians: number): boolean
  rotateDesktopGoon(deltaRadians: number): boolean
  setCameraFov(fov: number): void
  applyCamera(camera?: GoonCamera): void
  getCameraState(): GoonCamera | null
  getGoonRotation(): number
}

export type DesktopGoonCameraCommandResult =
  { status: 'applied' } | { status: 'captured'; state: DesktopGoonCameraStateV1 }

export function captureDesktopGoonEngineCameraState(
  engine: DesktopGoonCameraEngine
): DesktopGoonCameraStateV1 {
  const camera = engine.getCameraState()
  if (!camera) throw new Error('Desktop Goon camera is not ready to capture.')
  if (camera.mode === 'indoor') {
    throw new Error('Desktop Mode cannot capture an Indoor Camera state.')
  }
  return {
    schemaVersion: 'desktop-goon-camera/v1',
    camera: { ...camera, mode: 'free' },
    goonRotation: engine.getGoonRotation()
  }
}

/**
 * Apply only the versioned, manual Desktop camera contract. No arbitrary
 * engine method name or renderer command crosses the window boundary.
 */
export function applyDesktopGoonEngineCameraCommand(
  engine: DesktopGoonCameraEngine,
  rawCommand: unknown
): DesktopGoonCameraCommandResult {
  const command: DesktopGoonCameraCommandV1 = parseDesktopGoonCameraCommandV1(rawCommand)
  switch (command.kind) {
    case 'zoom':
      engine.applyDesktopCameraZoom(command.delta, command.pointerNdc)
      return { status: 'applied' }
    case 'pan':
      engine.applyDesktopCameraPan(command.deltaX, command.deltaY, command.viewportHeight)
      return { status: 'applied' }
    case 'orbit-vertical':
      engine.applyDesktopCameraVerticalOrbit(command.deltaPitchRadians)
      return { status: 'applied' }
    case 'rotate-goon':
      engine.rotateDesktopGoon(command.deltaRadians)
      return { status: 'applied' }
    case 'set-fov':
      engine.setCameraFov(command.fov)
      return { status: 'applied' }
    case 'apply-state':
      engine.applyCamera({ ...command.state.camera, mode: 'free' })
      engine.rotateDesktopGoon(command.state.goonRotation - engine.getGoonRotation())
      return { status: 'applied' }
    case 'capture-state':
      return { status: 'captured', state: captureDesktopGoonEngineCameraState(engine) }
  }
}
