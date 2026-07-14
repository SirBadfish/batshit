import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import { GoonEngine } from '$lib/goons/engine'

describe('Room Shell runtime placement', () => {
  it('reapplies same-URL placement on a wrapper while preserving authored root transforms and bounds', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const engine = new GoonEngine(document.createElement('div'))
    const internals = engine as unknown as {
      sceneRoot: THREE.Group
      roomShell: THREE.Object3D | null
      roomShellUrl: string | null
      shellBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null
    }

    const authoredRoot = new THREE.Group()
    authoredRoot.position.set(0.4, 0.7, -0.2)
    authoredRoot.rotation.set(0.1, 0.2, 0.3)
    authoredRoot.scale.set(1.2, 0.8, 1.1)
    authoredRoot.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial()))

    const wrapper = new THREE.Group()
    wrapper.name = 'BatshitRoomShell'
    wrapper.add(authoredRoot)
    internals.sceneRoot.add(wrapper)
    internals.roomShell = wrapper
    internals.roomShellUrl = '/uploads/room-shell.glb'

    const authoredPosition = authoredRoot.position.clone()
    const authoredRotation = authoredRoot.rotation.clone()
    const authoredScale = authoredRoot.scale.clone()

    engine.setRoomShellTransform({
      position: [2, -0.367, 3],
      rotationY: Math.PI / 2,
      uniformScale: 1.5
    })

    expect(wrapper.position.toArray()).toEqual([2, -0.367, 3])
    expect(wrapper.rotation.y).toBeCloseTo(Math.PI / 2)
    expect(wrapper.scale.toArray()).toEqual([1.5, 1.5, 1.5])
    expect(authoredRoot.position.toArray()).toEqual(authoredPosition.toArray())
    expect(authoredRoot.rotation.toArray()).toEqual(authoredRotation.toArray())
    expect(authoredRoot.scale.toArray()).toEqual(authoredScale.toArray())
    expect(internals.shellBounds).not.toBeNull()

    const boundsAfterTransform = { ...internals.shellBounds! }
    await engine.setRoomShell('/uploads/room-shell.glb')

    expect(internals.roomShell).toBe(wrapper)
    expect(internals.shellBounds).toEqual(boundsAfterTransform)

    authoredRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      object.geometry.dispose()
      ;(object.material as THREE.Material).dispose()
    })
    vi.restoreAllMocks()
  })
})
