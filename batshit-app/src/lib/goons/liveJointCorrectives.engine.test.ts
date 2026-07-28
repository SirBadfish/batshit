import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { GoonEngine } from '$lib/goons/engine'
import type { GoonCustomAvatarManifest } from './customAvatar'

function manifest(morph = 'seat_corrective'): GoonCustomAvatarManifest {
  return {
    rig: {
      liveCorrectives: {
        contract: 'joint-angle-live-corrective/v1',
        drivers: [
          {
            id: 'hips-flex',
            kind: 'swing-angle',
            combine: 'mean',
            clampDeg: [0, 90],
            bones: [
              {
                bone: 'LeftUpLeg',
                restRotation: [0, 0, 0, 1],
                axisRestLocal: [1, 0, 0]
              }
            ]
          }
        ],
        entries: [
          {
            id: 'seat',
            driver: 'hips-flex',
            node: 'Body',
            morph,
            baseInfluence: 0.2,
            anchor: 0.4,
            influenceMin: -1,
            influenceMax: 1,
            angleCurve: [
              [0, 0],
              [90, 1]
            ],
            mode: 'additive'
          }
        ]
      }
    }
  }
}

function scene() {
  const root = new THREE.Group()
  const bone = new THREE.Bone()
  bone.name = 'LeftUpLeg'
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.name = 'Body'
  mesh.morphTargetDictionary = { seat_corrective: 0 }
  mesh.morphTargetInfluences = [0.2]
  root.add(bone, mesh)
  return { root, bone, mesh }
}

describe('GoonEngine Live corrective re-import', () => {
  it('binds the baked manifest directly and restores the baked base at zero angle', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const engine = new GoonEngine(document.createElement('div'))
    const loaded = scene()
    const internals = engine as unknown as {
      customAvatarRoot: THREE.Object3D | null
      setupLiveJointCorrectives: (value: GoonCustomAvatarManifest) => void
      applyJointCorrectives: () => void
    }
    internals.customAvatarRoot = loaded.root
    internals.setupLiveJointCorrectives(manifest())

    loaded.bone.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 4)
    internals.applyJointCorrectives()
    expect(loaded.mesh.morphTargetInfluences?.[0]).toBeCloseTo(0.4, 12)

    loaded.bone.quaternion.identity()
    internals.applyJointCorrectives()
    expect(loaded.mesh.morphTargetInfluences?.[0]).toBeCloseTo(0.2, 12)
    vi.restoreAllMocks()
  })

  it('fails closed when a retained corrective morph is missing', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const engine = new GoonEngine(document.createElement('div'))
    const loaded = scene()
    const internals = engine as unknown as {
      customAvatarRoot: THREE.Object3D | null
      setupLiveJointCorrectives: (value: GoonCustomAvatarManifest) => void
    }
    internals.customAvatarRoot = loaded.root
    expect(() => internals.setupLiveJointCorrectives(manifest('missing'))).toThrow(
      /Live corrective morph Body\/missing is missing/
    )
    vi.restoreAllMocks()
  })
})
