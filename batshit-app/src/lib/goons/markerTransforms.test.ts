import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import {
  captureMarkerFromAvatarPlacement,
  rebindMarkerPreservingWorldPlacement,
  resolveMarkerWorldPosition,
  resolveMarkerWorldYaw
} from '$lib/goons/markerTransforms'
import type { GoonSceneMarker } from '$lib/types/goons'

describe('markerTransforms', () => {
  it('captures avatar placement as an anchor position by subtracting base height', () => {
    const snapshot = captureMarkerFromAvatarPlacement({
      avatarWorldPosition: new THREE.Vector3(1.25, 2.4, -0.75),
      worldYaw: Math.PI / 3,
      baseY: 1.1
    })

    expect(snapshot.position[0]).toBeCloseTo(1.25)
    expect(snapshot.position[1]).toBeCloseTo(1.3)
    expect(snapshot.position[2]).toBeCloseTo(-0.75)
    expect(snapshot.rotation?.[1]).toBeCloseTo(Math.PI / 3)
  })

  it('rebinds a marker to a prop without changing its visible world placement', () => {
    const currentParent = new THREE.Object3D()
    const nextParent = new THREE.Object3D()
    nextParent.position.set(2, 0.5, -1)
    nextParent.rotation.y = Math.PI / 4
    nextParent.updateWorldMatrix(true, true)

    const marker: GoonSceneMarker = {
      id: 'sit_1',
      position: [0.5, 0.25, -0.2],
      rotation: [0, Math.PI / 6, 0]
    }

    const worldPositionBefore = resolveMarkerWorldPosition(marker, currentParent)
    const worldYawBefore = resolveMarkerWorldYaw(marker, currentParent)

    const rebound = rebindMarkerPreservingWorldPlacement({
      marker,
      currentParent,
      nextParent,
      nextPropId: 'couch'
    })

    const worldPositionAfter = resolveMarkerWorldPosition(rebound, nextParent)
    const worldYawAfter = resolveMarkerWorldYaw(rebound, nextParent)

    expect(rebound.propId).toBe('couch')
    expect(worldPositionAfter.x).toBeCloseTo(worldPositionBefore.x)
    expect(worldPositionAfter.y).toBeCloseTo(worldPositionBefore.y)
    expect(worldPositionAfter.z).toBeCloseTo(worldPositionBefore.z)
    expect(worldYawAfter).toBeCloseTo(worldYawBefore)
  })
})
