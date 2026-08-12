import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { GoonEngine } from './engine'

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
    expect(root.rotation.order).toBe('XYZ')
    expect(THREE.MathUtils.radToDeg(root.rotation.y)).toBeCloseTo(-90)
    expect(root.scale.toArray()).toEqual([0.25, 0.225, 0.275])
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
