import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { GoonEngine } from './engine'
import { canonicalizeHairImportSelection } from './hairImportIntake'
import { decodeSemanticGlbAccessor, parseSemanticGlb, type SemanticJsonRecord } from './recipe/semanticGlb'

function inspectionEngine() {
  const engine = new GoonEngine(document.createElement('div')) as any
  const root = new THREE.Group()
  const first = new THREE.Group()
  const second = new THREE.Group()
  engine.hairImportInspectionRoot = root
  engine.hairImportInspectionObjects = new Map([
    ['object-0001', first],
    ['object-0002', second]
  ])
  return { engine: engine as GoonEngine, root, first, second }
}

describe('GoonEngine Hair import inspection preview', () => {
  it('applies live centimeter-scale placement inputs as exact avatar-space transforms', () => {
    const { engine, root } = inspectionEngine()

    engine.updateHairImportInspectionTransform({
      move: { x: -0.05, y: 1.34, z: 0.07 },
      rotate: { x: 0, y: -90, z: 0 },
      uniformScale: 0.25,
      axisScale: { x: 1, y: 0.9, z: 1.1 }
    })

    expect(root.position.toArray()).toEqual([-0.05, 1.34, 0.07])
    expect(root.rotation.order).toBe('ZYX')
    expect(THREE.MathUtils.radToDeg(root.rotation.y)).toBeCloseTo(-90)
    expect(root.scale.toArray()).toEqual([0.25, 0.225, 0.275])
  })

  it('matches actual canonical authoring for combined rotations, nonuniform scale and translation', () => {
    const source = new TextEncoder().encode(`o Hair
v -0.1 1.2 0.03
v 0.1 1.4 -0.07
v 0.2 1.6 0.1
f 1 2 3
`)
    const canonical = canonicalizeHairImportSelection({ bytes: source, filename: 'hair.obj' })
    const move = { x: -0.05, y: 0.34, z: 0.07 }
    const rotate = { x: 20, y: -35, z: 25 }
    const uniformScale = 1.2
    const axisScale = { x: 0.9, y: 1.1, z: 0.8 }
    const { engine, root } = inspectionEngine()
    engine.updateHairImportInspectionTransform({ move, rotate, uniformScale, axisScale })
    const authored = canonicalizeHairImportSelection({ bytes: canonical.glbBytes, filename: 'hair.glb',
      transform: { translation: [move.x, move.y, move.z],
        rotation: [rotate.x, rotate.y, rotate.z].map(THREE.MathUtils.degToRad),
        uniformScale, axisScale: [axisScale.x, axisScale.y, axisScale.z] } })
    const sourceGlb = parseSemanticGlb(canonical.glbBytes), authoredGlb = parseSemanticGlb(authored.glbBytes)
    const attrs = (doc: typeof sourceGlb) => (doc.meshes[0]!.primitives as SemanticJsonRecord[])[0]!.attributes as SemanticJsonRecord
    const positions = decodeSemanticGlbAccessor(sourceGlb, attrs(sourceGlb).POSITION).values
    const expected = decodeSemanticGlbAccessor(authoredGlb, attrs(authoredGlb).POSITION).values
    const normals = decodeSemanticGlbAccessor(sourceGlb, attrs(sourceGlb).NORMAL).values
    const expectedNormals = decodeSemanticGlbAccessor(authoredGlb, attrs(authoredGlb).NORMAL).values
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(root.matrix)
    for (let i = 0; i < positions.length; i += 3) {
      const point = new THREE.Vector3().fromArray(positions, i).applyMatrix4(root.matrix)
      const normal = new THREE.Vector3().fromArray(normals, i).applyMatrix3(normalMatrix).normalize()
      point.toArray().forEach((value, axis) => expect(value).toBeCloseTo(expected[i + axis]!, 6))
      normal.toArray().forEach((value, axis) => expect(value).toBeCloseTo(expectedNormals[i + axis]!, 6))
    }
  })

  it('updates included and solo object visibility without rebuilding geometry', () => {
    const { engine, first, second } = inspectionEngine()

    engine.updateHairImportInspectionSelection(['object-0001'], null)
    expect(first.visible).toBe(true)
    expect(second.visible).toBe(false)

    engine.updateHairImportInspectionSelection(['object-0001', 'object-0002'], 'object-0002')
    expect(first.visible).toBe(false)
    expect(second.visible).toBe(true)

    expect(() =>
      engine.updateHairImportInspectionSelection(['object-9999'], null)
    ).toThrow(/does not contain object/)
  })
})
