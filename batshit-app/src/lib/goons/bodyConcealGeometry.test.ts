import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { cloneGeometryForBodyConceal } from './bodyConcealGeometry'

describe('cloneGeometryForBodyConceal', () => {
  it('owns base/index data without copying immutable morph payloads', () => {
    const source = new THREE.BufferGeometry()
    source.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3))
    source.setIndex([0, 1])
    const morph = new THREE.Float32BufferAttribute([0.1, 0, 0, 0.1, 0, 0], 3)
    source.morphAttributes.position = [morph]
    source.morphTargetsRelative = true

    const cloned = cloneGeometryForBodyConceal(source)

    expect(cloned.getAttribute('position')).not.toBe(source.getAttribute('position'))
    expect(cloned.getIndex()).not.toBe(source.getIndex())
    expect(cloned.morphAttributes.position).not.toBe(source.morphAttributes.position)
    expect(cloned.morphAttributes.position?.[0]).toBe(morph)
    expect(cloned.morphTargetsRelative).toBe(true)

    cloned.morphAttributes.position = []
    expect(source.morphAttributes.position).toEqual([morph])
  })
})
