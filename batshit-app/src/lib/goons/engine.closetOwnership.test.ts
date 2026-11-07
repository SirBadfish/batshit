import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { GoonEngine } from './engine'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const engine = new GoonEngine(document.createElement('div')) as any
  const material = new THREE.MeshStandardMaterial()
  engine.vrm = {}
  engine.materialMap = new Map([['shirt', [material]]])
  const pending = deferred<THREE.Texture>()
  engine.textureLoader = { loadAsync: vi.fn(() => pending.promise) }
  const generation = engine.beginGoonLoad()
  const isCurrent = () => engine.isCurrentGoonLoad(generation)
  const texture = new THREE.DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1)
  return { engine, material, pending, isCurrent, texture }
}

describe('manual Closet texture ownership', () => {
  it.each(['texture', 'xwear'] as const)(
    'does not apply a delayed %s texture to a superseded same-root load', async (kind) => {
      const { engine, material, pending, isCurrent, texture } = fixture()
      const dispose = vi.spyOn(texture, 'dispose')
      const operation = kind === 'texture'
        ? engine.applyMaterialTexture('shirt', '/shirt.png', { isCurrent })
        : engine.applyXWearMaterial('shirt', {
            materialName: 'shirt', textures: { _MainTex: { url: '/shirt.png' } }
          }, { isCurrent })
      expect(engine.textureLoader.loadAsync).toHaveBeenCalledOnce()
      engine.beginGoonLoad() // Same engine/root; a newer load owns subsequent writes.
      pending.resolve(texture)
      await operation
      expect(material.map).toBeNull()
      expect(dispose).toHaveBeenCalledOnce()
    }
  )

  it.each(['texture', 'xwear'] as const)('still applies a current %s texture', async (kind) => {
    const { engine, material, pending, isCurrent, texture } = fixture()
    const operation = kind === 'texture'
      ? engine.applyMaterialTexture('shirt', '/shirt.png', { isCurrent })
      : engine.applyXWearMaterial('shirt', {
          materialName: 'shirt', textures: { _MainTex: { url: '/shirt.png' } }
        }, { isCurrent })
    pending.resolve(texture)
    expect(await operation).toBe(true)
    expect(material.map).toBe(texture)
  })

  it('disposes both unassigned XWear textures if ownership changes during the second load', async () => {
    const { engine, material, pending, isCurrent, texture } = fixture()
    const first = new THREE.DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1)
    const firstDispose = vi.spyOn(first, 'dispose'), secondDispose = vi.spyOn(texture, 'dispose')
    engine.textureLoader.loadAsync.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise)
    const operation = engine.applyXWearMaterial('shirt', {
      materialName: 'shirt', textures: { _MainTex: { url: '/first.png' }, _BumpMap: { url: '/second.png' } }
    }, { isCurrent })
    await vi.waitFor(() => expect(engine.textureLoader.loadAsync).toHaveBeenCalledTimes(2))
    engine.beginGoonLoad()
    pending.resolve(texture)
    expect(await operation).toBe(false)
    expect(material.map).toBeNull()
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })
})
