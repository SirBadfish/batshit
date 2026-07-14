import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GoonEngine } from '$lib/goons/engine'
import {
  createGoonSceneAmbienceSpriteLayer,
  resolveGoonSceneAmbienceBounds
} from '$lib/goons/sceneAmbienceRuntime'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('scene ambience runtime', () => {
  it('uses one WebGPU-compatible instanced sprite batch instead of point primitives', () => {
    const positions = new Float32Array([
      0, 1, 0,
      1, 2, 1,
      -1, 3, -1
    ])
    const layer = createGoonSceneAmbienceSpriteLayer({
      positions,
      color: 0xff8a3d,
      size: [0.06, 0.085],
      opacity: 0.78,
      additive: true
    })

    expect(layer.object.isSprite).toBe(true)
    expect((layer.object as THREE.Object3D & { isPoints?: boolean }).isPoints).not.toBe(true)
    expect(layer.object.count).toBe(3)
    expect(layer.object.frustumCulled).toBe(false)
    expect(layer.material.isPointsNodeMaterial).toBe(true)
    expect(layer.material.sizeNode).not.toBeNull()
    expect(layer.material.blending).toBe(THREE.AdditiveBlending)
    expect(layer.positionAttribute.isInstancedBufferAttribute).toBe(true)
    expect(layer.positionAttribute.usage).toBe(THREE.DynamicDrawUsage)

    const version = layer.positionAttribute.version
    layer.positionAttribute.needsUpdate = true
    expect(layer.positionAttribute.version).toBe(version + 1)

    layer.material.dispose()
  })

  it('keeps outside ambience in a near-room band instead of a sparse distant square', () => {
    const bounds = resolveGoonSceneAmbienceBounds(
      { width: 13.5, depth: 13.5, height: 5.1 },
      'outside'
    )
    const width = bounds.maxX - bounds.minX
    const depth = bounds.maxZ - bounds.minZ
    const outerArea = width * depth
    const excludedArea = bounds.innerHalfX * 2 * (bounds.innerHalfZ * 2)

    expect(width).toBeCloseTo(20.25)
    expect(depth).toBeCloseTo(20.25)
    expect(outerArea - excludedArea).toBeLessThan(210)
    expect(bounds.innerHalfX).toBeCloseTo(7.15)
    expect(bounds.innerHalfZ).toBeCloseTo(7.15)
  })

  it('attaches, advances, and removes the sprite layer through GoonEngine', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const engine = new GoonEngine(document.createElement('div'))
    const internals = engine as unknown as {
      sceneRoot: THREE.Group
      sceneAmbienceRuntime: {
        object: THREE.Sprite
        positions: Float32Array
      } | null
      updateSceneAmbienceRuntime(delta: number, elapsed: number): void
    }

    engine.setSceneAmbience({
      enabled: true,
      preset: 'rain',
      placement: 'inside',
      intensity: 0.6,
      speed: 1,
      wind: [0.1, 0],
      seed: 42
    })

    const runtime = internals.sceneAmbienceRuntime
    expect(runtime).not.toBeNull()
    expect(runtime?.object.isSprite).toBe(true)
    expect(runtime ? internals.sceneRoot.children.includes(runtime.object) : false).toBe(true)
    expect(runtime?.positions.length).toBeGreaterThan(0)

    const before = runtime?.positions.slice()
    internals.updateSceneAmbienceRuntime(0.1, 0.1)
    expect(runtime?.positions).not.toEqual(before)

    engine.setSceneAmbience(null)
    expect(internals.sceneAmbienceRuntime).toBeNull()
    expect(runtime ? internals.sceneRoot.children.includes(runtime.object) : true).toBe(false)
  })
})
