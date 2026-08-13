import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import {
  DESKTOP_GOON_VERTICAL_ORBIT_MAX_PITCH,
  DESKTOP_GOON_VERTICAL_ORBIT_MIN_PITCH,
  resolveDesktopGoonPointerDragMode,
  resolveDesktopGoonVerticalOrbit
} from '$lib/goons/cameraNavigation'

describe('Desktop Goon vertical camera orbit', () => {
  it('maps the established mouse gestures to orbit, pan, and Goon rotation', () => {
    expect(resolveDesktopGoonPointerDragMode({ button: 0, buttons: 1 })).toBe(
      'desktop-vertical-orbit'
    )
    expect(resolveDesktopGoonPointerDragMode({ button: 2, buttons: 2 })).toBe('goon')
    expect(resolveDesktopGoonPointerDragMode({ button: 2, buttons: 3 })).toBe('camera-pan')
    expect(resolveDesktopGoonPointerDragMode({ button: 0, buttons: 3 })).toBe('camera-pan')
    expect(resolveDesktopGoonPointerDragMode({ button: 1, buttons: 4 })).toBe('none')
  })

  it('preserves target, distance, and horizontal angle while changing only pitch', () => {
    const target = new THREE.Vector3(0.35, 1.7, -0.2)
    const yaw = 0.6
    const distance = 2.8
    const startingPitch = 0.2
    const position = target
      .clone()
      .add(
        new THREE.Vector3().setFromSpherical(
          new THREE.Spherical(distance, Math.PI / 2 - startingPitch, yaw)
        )
      )
    const resolved = resolveDesktopGoonVerticalOrbit({
      currentCameraPosition: position,
      currentOrbitTarget: target,
      deltaPitchRadians: 0.18
    })

    expect(resolved).not.toBeNull()
    expect(resolved!.orbitTarget.distanceTo(target)).toBeLessThan(1e-12)
    expect(resolved!.nextCameraPosition.distanceTo(target)).toBeCloseTo(distance, 12)
    expect(resolved!.yawRadians).toBeCloseTo(yaw, 12)
    expect(resolved!.pitchRadians).toBeCloseTo(startingPitch + 0.18, 12)
  })

  it('clamps from slightly below eye level through the existing looking-down range', () => {
    const target = new THREE.Vector3(0, 1.6, 0)
    const position = new THREE.Vector3(0, 1.6, 2.2)
    const below = resolveDesktopGoonVerticalOrbit({
      currentCameraPosition: position,
      currentOrbitTarget: target,
      deltaPitchRadians: -Math.PI / 2
    })
    const above = resolveDesktopGoonVerticalOrbit({
      currentCameraPosition: position,
      currentOrbitTarget: target,
      deltaPitchRadians: Math.PI / 2
    })

    expect(below!.pitchRadians).toBeCloseTo(DESKTOP_GOON_VERTICAL_ORBIT_MIN_PITCH, 12)
    expect(above!.pitchRadians).toBeCloseTo(DESKTOP_GOON_VERTICAL_ORBIT_MAX_PITCH, 12)
    expect(THREE.MathUtils.radToDeg(DESKTOP_GOON_VERTICAL_ORBIT_MIN_PITCH)).toBeCloseTo(-8, 12)
  })

  it('does not mutate its inputs and rejects unusable geometry', () => {
    const target = new THREE.Vector3(1, 2, 3)
    const position = new THREE.Vector3(1, 2, 5)
    const targetBefore = target.clone()
    const positionBefore = position.clone()

    expect(
      resolveDesktopGoonVerticalOrbit({
        currentCameraPosition: position,
        currentOrbitTarget: target,
        deltaPitchRadians: 0.1
      })
    ).not.toBeNull()
    expect(target).toEqual(targetBefore)
    expect(position).toEqual(positionBefore)
    expect(
      resolveDesktopGoonVerticalOrbit({
        currentCameraPosition: target.clone(),
        currentOrbitTarget: target,
        deltaPitchRadians: 0.1
      })
    ).toBeNull()
  })
})
