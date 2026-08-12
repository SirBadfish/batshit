import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GoonEngine } from './engine'
import { HAIR_MOTION_PAINT_CONTRACT } from './hairMotionPaint'

describe('GoonEngine Hair motion paint topology', () => {
  it.each([
    ['indexed', true],
    ['non-indexed', false]
  ])('accepts %s triangle geometry', (_label, indexed) => {
    const engine = new GoonEngine(document.createElement('div')) as any
    const root = new THREE.Group()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.1, 0, 0, 0.1, 0, 0, 0, 0.2, 0], 3)
    )
    if (indexed) geometry.setIndex([0, 1, 2])
    const originalMaterial = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, originalMaterial)
    mesh.name = 'HairGeometry'
    root.add(mesh)
    engine.hairPreviewRoot = root
    engine.hairImportInspectionRoot = null

    expect(engine.getHairImportMotionPaintTopology()).toEqual({
      meshes: [{ meshNode: 'HairGeometry', triangleCount: 1, vertexCount: 3 }]
    })
    expect(() =>
      engine.showHairImportMotionPaint(
        {
          contract: HAIR_MOTION_PAINT_CONTRACT,
          regions: [
            {
              id: 'paint-region-001',
              label: 'Motion area 1',
              enabled: true,
              meshes: [
                {
                  meshNode: 'HairGeometry',
                  triangleCount: 1,
                  triangleRanges: [[0, 0]]
                }
              ]
            }
          ]
        },
        'paint-region-001'
      )
    ).not.toThrow()
    expect(
      root.children.some((child) => child.userData.batshitHairMotionPaintOverlay === true)
    ).toBe(true)
    expect(mesh.material).not.toBe(originalMaterial)
    engine.hideHairImportMotionMap()
    expect(mesh.material).toBe(originalMaterial)
  })

  it('does not duplicate unpainted Hair triangles into the temporary overlay', () => {
    const engine = new GoonEngine(document.createElement('div')) as any
    const root = new THREE.Group()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.1, 0, 0, 0.1, 0, 0, 0, 0.2, 0], 3)
    )
    const originalMaterial = new THREE.MeshBasicMaterial({ side: THREE.FrontSide })
    const mesh = new THREE.Mesh(geometry, originalMaterial)
    mesh.name = 'HairGeometry'
    root.add(mesh)
    engine.hairPreviewRoot = root
    engine.hairImportInspectionRoot = null

    engine.showHairImportMotionPaint(
      {
        contract: HAIR_MOTION_PAINT_CONTRACT,
        regions: [
          {
            id: 'paint-region-001',
            label: 'Motion area 1',
            enabled: true,
            meshes: []
          }
        ]
      },
      'paint-region-001'
    )

    expect(
      root.children.some((child) => child.userData.batshitHairMotionPaintOverlay === true)
    ).toBe(false)
    expect(mesh.material).not.toBe(originalMaterial)
    expect((mesh.material as THREE.Material).side).toBe(THREE.FrontSide)
    engine.hideHairImportMotionMap()
    expect(mesh.material).toBe(originalMaterial)
  })

  it('hides the Goon without hiding attached Hair and restores exact visibility', () => {
    const engine = new GoonEngine(document.createElement('div')) as any
    const avatar = new THREE.Group()
    const body = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial())
    const alreadyHidden = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial()
    )
    alreadyHidden.visible = false
    const hairRoot = new THREE.Group()
    const hair = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial())
    hair.name = 'HairGeometry'
    hairRoot.add(hair)
    avatar.add(body, alreadyHidden, hairRoot)
    engine.customAvatarRoot = avatar
    engine.hairPreviewRoot = hairRoot
    engine.hairImportInspectionRoot = null

    engine.setHairImportMotionPaintGoonVisible(false)
    expect(body.visible).toBe(false)
    expect(alreadyHidden.visible).toBe(false)
    expect(hair.visible).toBe(true)

    engine.setHairImportMotionPaintGoonVisible(true)
    expect(body.visible).toBe(true)
    expect(alreadyHidden.visible).toBe(false)
    expect(hair.visible).toBe(true)
  })

  it('keeps hidden Hair meshes out of painting and lets the Goon block through-body picks', () => {
    const engine = new GoonEngine(document.createElement('div')) as any
    const avatar = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    )
    body.position.z = 1
    const hairRoot = new THREE.Group()
    const hair = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    )
    hair.name = 'HairGeometry'
    hairRoot.add(hair)
    avatar.add(body, hairRoot)
    avatar.updateMatrixWorld(true)
    engine.customAvatarRoot = avatar
    engine.hairPreviewRoot = hairRoot
    engine.hairImportInspectionRoot = null
    engine.renderer = {
      domElement: {
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          right: 200,
          bottom: 200,
          width: 200,
          height: 200,
          x: 0,
          y: 0,
          toJSON: () => ({})
        })
      }
    }
    engine.camera.position.set(0, 0, 5)
    engine.camera.lookAt(0, 0, 0)
    engine.camera.updateProjectionMatrix()
    engine.camera.updateMatrixWorld(true)

    expect(engine.pickHairImportMotionTriangles(100, 100, 2)).toBeNull()

    engine.setHairImportMotionPaintGoonVisible(false)
    expect(engine.pickHairImportMotionTriangles(100, 100, 2)).toEqual(
      expect.objectContaining({ meshNode: 'HairGeometry', faceIndex: expect.any(Number) })
    )

    engine.setHairImportMotionPaintMeshVisible('HairGeometry', false)
    expect(engine.pickHairImportMotionTriangles(100, 100, 2)).toBeNull()
    engine.setHairImportMotionPaintMeshVisible('HairGeometry', true)
    expect(hair.visible).toBe(true)
  })

  it('freezes preview Hair physics at rest while painting and resumes it afterward', () => {
    const engine = new GoonEngine(document.createElement('div')) as any
    const runtime = {
      reset: vi.fn(),
      update: vi.fn()
    }
    engine.hairPreviewSecondaryMotionRuntime = runtime

    engine.setHairImportMotionPaintActive(true)
    engine.updateHairSecondaryMotionRuntimes(1 / 60)
    expect(runtime.reset).toHaveBeenCalledTimes(1)
    expect(runtime.update).not.toHaveBeenCalled()

    engine.setHairImportMotionPaintActive(false)
    engine.updateHairSecondaryMotionRuntimes(1 / 60)
    expect(runtime.reset).toHaveBeenCalledTimes(2)
    expect(runtime.update).toHaveBeenCalledWith(1 / 60)
  })
})
