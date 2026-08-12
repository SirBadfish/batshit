import * as THREE from 'three'

export type HairAttachmentSummary = {
  meshCount: number
  vertexCount: number
  triangleCount: number
}

function isDescendantOf(root: THREE.Object3D, candidate: THREE.Object3D) {
  let current: THREE.Object3D | null = candidate
  while (current) {
    if (current === root) return true
    current = current.parent
  }
  return false
}

export function summarizeHairAsset(root: THREE.Object3D): HairAttachmentSummary {
  const summary: HairAttachmentSummary = {
    meshCount: 0,
    vertexCount: 0,
    triangleCount: 0
  }

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    summary.meshCount += 1
    const geometry = object.geometry
    summary.vertexCount += geometry.getAttribute('position')?.count ?? 0
    const indexCount = geometry.getIndex()?.count
    summary.triangleCount +=
      indexCount === undefined
        ? Math.floor((geometry.getAttribute('position')?.count ?? 0) / 3)
        : Math.floor(indexCount / 3)
  })

  return summary
}

/**
 * Attach an already fitted, avatar-root-space hair asset to the animated head.
 * The authored avatar-space root is transformed through the inverse head rest
 * matrix before parenting, so the current head pose is applied exactly once
 * and subsequent head animation carries the hair rigidly with the bone.
 */
export function attachRigidHairAsset(
  avatarRoot: THREE.Object3D,
  headNode: THREE.Object3D,
  hairRoot: THREE.Object3D,
  headRestMatrixInAvatarSpace: THREE.Matrix4
) {
  if (!isDescendantOf(avatarRoot, headNode)) {
    throw new Error('The declared hair attachment node is not part of the loaded Goon.')
  }
  if (hairRoot === avatarRoot || isDescendantOf(hairRoot, avatarRoot)) {
    throw new Error('The hair asset cannot own the loaded Goon hierarchy.')
  }

  hairRoot.updateMatrix()
  const authoredRootMatrix = hairRoot.matrix.clone()
  hairRoot.removeFromParent()
  headNode.add(hairRoot)
  hairRoot.matrix.copy(headRestMatrixInAvatarSpace).invert().multiply(authoredRootMatrix)
  hairRoot.matrix.decompose(hairRoot.position, hairRoot.quaternion, hairRoot.scale)
  hairRoot.updateMatrix()
  avatarRoot.updateMatrixWorld(true)

  return summarizeHairAsset(hairRoot)
}
