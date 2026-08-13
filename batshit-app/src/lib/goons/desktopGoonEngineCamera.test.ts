import { describe, expect, it, vi } from 'vitest'
import {
  applyDesktopGoonEngineCameraCommand,
  captureDesktopGoonEngineCameraState,
  type DesktopGoonCameraEngine
} from '$lib/goons/desktopGoonEngineCamera'

function engine(overrides: Partial<DesktopGoonCameraEngine> = {}): DesktopGoonCameraEngine {
  return {
    applyDesktopCameraZoom: vi.fn(() => true),
    applyDesktopCameraPan: vi.fn(() => true),
    applyDesktopCameraVerticalOrbit: vi.fn(() => true),
    rotateDesktopGoon: vi.fn(() => true),
    setCameraFov: vi.fn(),
    applyCamera: vi.fn(),
    getCameraState: vi.fn(() => ({
      orbitTarget: { x: 0, y: 1.4, z: 0 },
      distance: 2.2,
      yaw: 0,
      pitch: 0,
      fov: 50,
      mode: 'free'
    })),
    getGoonRotation: vi.fn(() => 0.25),
    ...overrides
  }
}

const version = 'desktop-goon-camera/v1' as const

describe('Desktop Goon engine camera adapter', () => {
  it('routes only the bounded manual zoom, pan, vertical orbit, rotation, and FOV commands', () => {
    const target = engine()
    applyDesktopGoonEngineCameraCommand(target, {
      schemaVersion: version,
      kind: 'orbit-vertical',
      source: 'manual',
      deltaPitchRadians: -0.12
    })
    applyDesktopGoonEngineCameraCommand(target, {
      schemaVersion: version,
      kind: 'zoom',
      delta: -12,
      pointerNdc: { x: 0.5, y: -0.25 }
    })
    applyDesktopGoonEngineCameraCommand(target, {
      schemaVersion: version,
      kind: 'pan',
      deltaX: 8,
      deltaY: -4,
      viewportHeight: 900
    })
    applyDesktopGoonEngineCameraCommand(target, {
      schemaVersion: version,
      kind: 'rotate-goon',
      deltaRadians: 0.2
    })
    applyDesktopGoonEngineCameraCommand(target, {
      schemaVersion: version,
      kind: 'set-fov',
      fov: 42
    })

    expect(target.applyDesktopCameraZoom).toHaveBeenCalledWith(-12, { x: 0.5, y: -0.25 })
    expect(target.applyDesktopCameraPan).toHaveBeenCalledWith(8, -4, 900)
    expect(target.applyDesktopCameraVerticalOrbit).toHaveBeenCalledWith(-0.12)
    expect(target.rotateDesktopGoon).toHaveBeenCalledWith(0.2)
    expect(target.setCameraFov).toHaveBeenCalledWith(42)
  })

  it('captures and applies free-camera state without exposing orbit commands', () => {
    const target = engine()
    const captured = captureDesktopGoonEngineCameraState(target)
    expect(captured).toMatchObject({
      schemaVersion: version,
      camera: { mode: 'free' },
      goonRotation: 0.25
    })

    applyDesktopGoonEngineCameraCommand(target, {
      schemaVersion: version,
      kind: 'apply-state',
      state: { ...captured, goonRotation: 1 }
    })
    expect(target.applyCamera).toHaveBeenCalledWith(expect.objectContaining({ mode: 'free' }))
    expect(target.rotateDesktopGoon).toHaveBeenCalledWith(0.75)
    expect(() =>
      applyDesktopGoonEngineCameraCommand(target, {
        schemaVersion: version,
        kind: 'orbit',
        deltaX: 1,
        deltaY: 1
      })
    ).toThrow(/does not support horizontal or free camera orbit/i)
  })

  it('fails visibly when a camera cannot be captured or is Indoor', () => {
    expect(() =>
      captureDesktopGoonEngineCameraState(engine({ getCameraState: () => null }))
    ).toThrow(/not ready/i)
    expect(() =>
      captureDesktopGoonEngineCameraState(
        engine({ getCameraState: () => ({ mode: 'indoor', fov: 50 }) })
      )
    ).toThrow(/Indoor Camera/i)
  })
})
