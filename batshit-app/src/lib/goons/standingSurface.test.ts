import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { probeStandingSurfaceY } from '$lib/goons/standingSurface'

describe('standing surface probe', () => {
  it('returns the top surface height for a walkable prop', () => {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8, 3), new THREE.MeshBasicMaterial())
    bed.position.set(0, 0.4, 0)
    bed.updateMatrixWorld(true)

    const y = probeStandingSurfaceY({
      objects: [bed],
      x: 0,
      z: 0,
      minY: 0,
      maxY: 3
    })

    expect(y).toBeCloseTo(0.81, 2)
  })

  it('chooses the highest valid top surface when props overlap in x/z', () => {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8, 3), new THREE.MeshBasicMaterial())
    bed.position.set(0, 0.4, 0)
    bed.updateMatrixWorld(true)

    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1.2, 1), new THREE.MeshBasicMaterial())
    crate.position.set(0, 0.6, 0)
    crate.updateMatrixWorld(true)

    const y = probeStandingSurfaceY({
      objects: [bed, crate],
      x: 0,
      z: 0,
      minY: 0,
      maxY: 3
    })

    expect(y).toBeCloseTo(1.21, 2)
  })

  it('ignores vertical faces that are not usable standing surfaces', () => {
    const ramp = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial())
    ramp.rotation.x = -THREE.MathUtils.degToRad(20)
    ramp.updateMatrixWorld(true)

    const y = probeStandingSurfaceY({
      objects: [ramp],
      x: 0,
      z: 0,
      minY: -2,
      maxY: 3,
      minNormalY: 0.8
    })

    expect(y).toBeNull()
  })
})
