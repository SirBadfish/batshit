import { describe, expect, it } from 'vitest'

import {
  DESKTOP_GOON_CAMERA_SCHEMA_VERSION,
  DesktopGoonCameraCommandError,
  parseDesktopGoonCameraCommandV1,
  parseDesktopGoonCameraStateV1
} from '$lib/goons/desktopGoonCamera'

const version = DESKTOP_GOON_CAMERA_SCHEMA_VERSION

describe('Desktop Goon camera contract', () => {
  it('accepts bounded manual zoom, pan, vertical orbit, Goon rotation, FOV, and capture commands', () => {
    expect(
      parseDesktopGoonCameraCommandV1({
        schemaVersion: version,
        kind: 'orbit-vertical',
        source: 'manual',
        deltaPitchRadians: 0.15
      })
    ).toMatchObject({ kind: 'orbit-vertical', source: 'manual', deltaPitchRadians: 0.15 })
    expect(
      parseDesktopGoonCameraCommandV1({
        schemaVersion: version,
        kind: 'zoom',
        delta: -120,
        pointerNdc: { x: -0.25, y: 0.75 }
      })
    ).toMatchObject({ kind: 'zoom', pointerNdc: { x: -0.25, y: 0.75 } })
    expect(
      parseDesktopGoonCameraCommandV1({
        schemaVersion: version,
        kind: 'pan',
        deltaX: 80,
        deltaY: -40,
        viewportHeight: 1200
      })
    ).toMatchObject({ kind: 'pan', viewportHeight: 1200 })
    expect(
      parseDesktopGoonCameraCommandV1({
        schemaVersion: version,
        kind: 'rotate-goon',
        deltaRadians: Math.PI / 3
      })
    ).toMatchObject({ kind: 'rotate-goon' })
    expect(
      parseDesktopGoonCameraCommandV1({ schemaVersion: version, kind: 'set-fov', fov: 36 })
    ).toMatchObject({ kind: 'set-fov', fov: 36 })
    expect(
      parseDesktopGoonCameraCommandV1({ schemaVersion: version, kind: 'capture-state' })
    ).toEqual({ schemaVersion: version, kind: 'capture-state' })
  })

  it('round-trips a free-camera snapshot through apply-state', () => {
    const state = parseDesktopGoonCameraStateV1({
      schemaVersion: version,
      camera: {
        orbitTarget: { x: 0.2, y: 1.7, z: -0.1 },
        distance: 2.4,
        yaw: 0.4,
        pitch: -0.15,
        zoom: 0.7,
        fov: 42,
        mode: 'free'
      },
      goonRotation: 1.2
    })
    expect(
      parseDesktopGoonCameraCommandV1({
        schemaVersion: version,
        kind: 'apply-state',
        state
      })
    ).toEqual({ schemaVersion: version, kind: 'apply-state', state })
  })

  it('rejects horizontal/free orbit, non-manual vertical orbit, and Indoor Camera explicitly', () => {
    for (const command of [
      { schemaVersion: version, kind: 'orbit', deltaX: 20, deltaY: 10 },
      { schemaVersion: version, kind: 'set-camera-mode', mode: 'indoor' }
    ]) {
      expect(() => parseDesktopGoonCameraCommandV1(command)).toThrow(DesktopGoonCameraCommandError)
    }
    expect(() =>
      parseDesktopGoonCameraCommandV1({ schemaVersion: version, kind: 'orbit' })
    ).toThrow(/does not support horizontal or free camera orbit/)
    expect(() =>
      parseDesktopGoonCameraCommandV1({
        schemaVersion: version,
        kind: 'orbit-vertical',
        source: 'agent',
        deltaPitchRadians: 0.1
      })
    ).toThrow(/only from manual user input/)
    expect(() =>
      parseDesktopGoonCameraStateV1({
        schemaVersion: version,
        camera: { mode: 'indoor' },
        goonRotation: 0
      })
    ).toThrow(/does not support Indoor Camera/)
  })

  it('rejects stale versions and values outside the manual-input bounds', () => {
    expect(() =>
      parseDesktopGoonCameraCommandV1({
        schemaVersion: 'desktop-goon-camera/v0',
        kind: 'capture-state'
      })
    ).toThrow(/version is unsupported/)
    expect(() =>
      parseDesktopGoonCameraCommandV1({
        schemaVersion: version,
        kind: 'zoom',
        delta: 121,
        pointerNdc: { x: 0, y: 0 }
      })
    ).toThrow(/zoom delta/)
    expect(() =>
      parseDesktopGoonCameraCommandV1({ schemaVersion: version, kind: 'set-fov', fov: 101 })
    ).toThrow(/camera FOV/)
    expect(() =>
      parseDesktopGoonCameraCommandV1({
        schemaVersion: version,
        kind: 'orbit-vertical',
        source: 'manual',
        deltaPitchRadians: Math.PI
      })
    ).toThrow(/vertical orbit delta/)
  })
})
