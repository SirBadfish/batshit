import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { attachRigidHairAsset, summarizeHairAsset } from '$lib/goons/hairAttachmentRuntime'

function vertexWorldPosition(mesh: THREE.Mesh) {
  return mesh.localToWorld(
    new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), 0)
  )
}

describe('rigid Goon hair attachment', () => {
  it('projects the fitted rest-space hair into the current head pose and follows later animation', () => {
    const avatarRoot = new THREE.Group()
    const head = new THREE.Bone()
    head.name = 'mixamorigHead'
    head.position.set(0, 1.5, 0)
    avatarRoot.add(head)

    const hairRoot = new THREE.Group()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0.1, 1.65, 0.08, -0.1, 1.65, 0.08, 0, 1.8, 0], 3)
    )
    geometry.setIndex([0, 1, 2])
    const hairMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
    hairRoot.add(hairMesh)

    avatarRoot.add(hairRoot)
    avatarRoot.updateMatrixWorld(true)
    const restHairPosition = vertexWorldPosition(hairMesh)
    const headRestMatrix = head.matrixWorld.clone()
    hairRoot.removeFromParent()

    head.rotation.y = Math.PI / 2
    avatarRoot.updateMatrixWorld(true)
    const expectedCurrentPosition = restHairPosition
      .clone()
      .applyMatrix4(headRestMatrix.clone().invert())
      .applyMatrix4(head.matrixWorld)
    const summary = attachRigidHairAsset(avatarRoot, head, hairRoot, headRestMatrix)
    const afterAttach = vertexWorldPosition(hairMesh)
    expect(afterAttach.distanceTo(expectedCurrentPosition)).toBeLessThan(1e-7)
    expect(summary).toEqual({ meshCount: 1, vertexCount: 3, triangleCount: 1 })

    head.rotation.y = Math.PI
    avatarRoot.updateMatrixWorld(true)
    const afterHeadTurn = vertexWorldPosition(hairMesh)
    expect(afterHeadTurn.distanceTo(afterAttach)).toBeGreaterThan(0.05)
  })

  it('rejects an attachment node outside the loaded Goon hierarchy', () => {
    expect(() =>
      attachRigidHairAsset(
        new THREE.Group(),
        new THREE.Bone(),
        new THREE.Group(),
        new THREE.Matrix4()
      )
    ).toThrow('not part of the loaded Goon')
  })

  it('preserves avatar-space fit under a transformed Goon root', () => {
    const scene = new THREE.Group()
    const avatarRoot = new THREE.Group()
    avatarRoot.position.set(3, -2, 4)
    avatarRoot.rotation.y = 0.35
    avatarRoot.scale.setScalar(1.4)
    scene.add(avatarRoot)
    const head = new THREE.Bone()
    head.position.set(0.1, 1.6, -0.05)
    avatarRoot.add(head)
    const hairRoot = new THREE.Group()
    hairRoot.position.set(0.02, 1.62, 0.01)
    avatarRoot.add(hairRoot)
    scene.updateMatrixWorld(true)
    const expectedWorld = hairRoot.matrixWorld.clone()
    const headRestInAvatar = avatarRoot.matrixWorld.clone().invert().multiply(head.matrixWorld)
    hairRoot.removeFromParent()

    attachRigidHairAsset(avatarRoot, head, hairRoot, headRestInAvatar)
    scene.updateMatrixWorld(true)
    hairRoot.matrixWorld.elements.forEach((value, index) => {
      expect(value).toBeCloseTo(expectedWorld.elements[index], 7)
    })
  })

  it('keeps a live nested fit identical to the baked Hair after head attachment', () => {
    const avatarRoot = new THREE.Group()
    const head = new THREE.Bone()
    head.position.set(0.02, 1.55, -0.03)
    head.rotation.set(0.03, -0.02, 0.04)
    avatarRoot.add(head)
    avatarRoot.updateMatrixWorld(true)
    const headRestMatrix = head.matrixWorld.clone()

    head.rotation.set(-0.08, 0.06, -0.12)
    avatarRoot.updateMatrixWorld(true)

    const fit = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0.195, 0),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, THREE.MathUtils.degToRad(-90), THREE.MathUtils.degToRad(10), 'XYZ')
      ),
      new THREE.Vector3(0.27 * 1.2, 0.27 * 1.02, 0.27 * 1.03)
    )
    const sourcePosition = new THREE.Vector3(0.12, 0.3, -0.05)

    const liveRoot = new THREE.Group()
    const liveFit = new THREE.Group()
    liveFit.matrix.copy(fit)
    liveFit.matrix.decompose(liveFit.position, liveFit.quaternion, liveFit.scale)
    const liveMesh = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(sourcePosition.toArray(), 3)
      )
    )
    liveFit.add(liveMesh)
    liveRoot.add(liveFit)
    attachRigidHairAsset(avatarRoot, head, liveRoot, headRestMatrix)

    const builtRoot = new THREE.Group()
    builtRoot.matrix.copy(headRestMatrix).invert()
    builtRoot.matrix.decompose(builtRoot.position, builtRoot.quaternion, builtRoot.scale)
    const builtMesh = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(sourcePosition.clone().applyMatrix4(fit).toArray(), 3)
      )
    )
    builtRoot.add(builtMesh)
    head.add(builtRoot)
    avatarRoot.updateMatrixWorld(true)

    expect(vertexWorldPosition(liveMesh).distanceTo(vertexWorldPosition(builtMesh))).toBeLessThan(
      1e-7
    )
  })

  it('rejects a hair root that owns the loaded Goon hierarchy', () => {
    const hairRoot = new THREE.Group()
    const avatarRoot = new THREE.Group()
    const head = new THREE.Bone()
    hairRoot.add(avatarRoot)
    avatarRoot.add(head)

    expect(() => attachRigidHairAsset(avatarRoot, head, hairRoot, new THREE.Matrix4())).toThrow(
      'cannot own the loaded Goon hierarchy'
    )
  })

  it('audits indexed and non-indexed hair meshes', () => {
    const root = new THREE.Group()
    root.add(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.Mesh(
        new THREE.BufferGeometry().setAttribute(
          'position',
          new THREE.Float32BufferAttribute(new Array(18).fill(0), 3)
        )
      )
    )

    expect(summarizeHairAsset(root)).toEqual({
      meshCount: 2,
      vertexCount: 30,
      triangleCount: 14
    })
  })
})
