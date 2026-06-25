import * as THREE from 'three'

import type { GoonSceneMarker } from '$lib/types/goons'

function buildRotationQuaternion(rotation?: [number, number, number]) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rotation?.[0] ?? 0, rotation?.[1] ?? 0, rotation?.[2] ?? 0, 'YXZ')
  )
}

function extractYaw(quaternion: THREE.Quaternion) {
  return new THREE.Euler().setFromQuaternion(quaternion, 'YXZ').y
}

export function resolveMarkerWorldPosition(
  marker: Pick<GoonSceneMarker, 'position'>,
  parent?: THREE.Object3D | null
) {
  const local = new THREE.Vector3(
    marker.position[0] ?? 0,
    marker.position[1] ?? 0,
    marker.position[2] ?? 0
  )

  if (!parent) {
    return local
  }

  parent.updateWorldMatrix(true, true)
  return parent.localToWorld(local)
}

export function resolveMarkerWorldYaw(
  marker: Pick<GoonSceneMarker, 'rotation'>,
  parent?: THREE.Object3D | null
) {
  const localQuaternion = buildRotationQuaternion(marker.rotation)
  if (!parent) {
    return extractYaw(localQuaternion)
  }

  parent.updateWorldMatrix(true, true)
  const worldQuaternion = parent.getWorldQuaternion(new THREE.Quaternion()).multiply(localQuaternion)
  return extractYaw(worldQuaternion)
}

export function captureMarkerFromWorldAnchor(options: {
  anchorWorldPosition: THREE.Vector3
  worldYaw: number
  parent?: THREE.Object3D | null
}) {
  const { anchorWorldPosition, worldYaw, parent = null } = options
  const localPosition = anchorWorldPosition.clone()
  let localYaw = worldYaw

  if (parent) {
    parent.updateWorldMatrix(true, true)
    parent.worldToLocal(localPosition)
    const parentQuaternion = parent.getWorldQuaternion(new THREE.Quaternion())
    const worldQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, worldYaw, 0, 'YXZ'))
    const localQuaternion = parentQuaternion.invert().multiply(worldQuaternion)
    localYaw = extractYaw(localQuaternion)
  }

  return {
    position: [localPosition.x, localPosition.y, localPosition.z] as [number, number, number],
    rotation: [0, localYaw, 0] as [number, number, number]
  }
}

export function captureMarkerFromAvatarPlacement(options: {
  avatarWorldPosition: THREE.Vector3
  worldYaw: number
  baseY: number
  parent?: THREE.Object3D | null
}) {
  const { avatarWorldPosition, worldYaw, baseY, parent = null } = options
  const anchorWorldPosition = avatarWorldPosition.clone()
  anchorWorldPosition.y -= baseY
  return captureMarkerFromWorldAnchor({
    anchorWorldPosition,
    worldYaw,
    parent
  })
}

export function rebindMarkerPreservingWorldPlacement(options: {
  marker: GoonSceneMarker
  currentParent?: THREE.Object3D | null
  nextParent?: THREE.Object3D | null
  nextPropId?: string
}) {
  const {
    marker,
    currentParent = null,
    nextParent = null,
    nextPropId
  } = options

  const worldPosition = resolveMarkerWorldPosition(marker, currentParent)
  const worldYaw = resolveMarkerWorldYaw(marker, currentParent)
  const rebound = captureMarkerFromWorldAnchor({
    anchorWorldPosition: worldPosition,
    worldYaw,
    parent: nextParent
  })

  return {
    ...marker,
    propId: nextPropId || undefined,
    position: rebound.position,
    rotation: rebound.rotation
  } satisfies GoonSceneMarker
}
