import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import { instancedDynamicBufferAttribute, vec2 } from 'three/tsl'

import type { NormalizedGoonSceneAmbience } from '$lib/goons/sceneAmbience'
import type { GoonRoomShellBuilder } from '$lib/types/goons'

const AMBIENCE_BASE_HEIGHT = 6
const AMBIENCE_MIN_ROOM_SIZE = 4
const AMBIENCE_OUTSIDE_MARGIN_MIN = 3
const AMBIENCE_OUTSIDE_MARGIN_MAX = 6
const AMBIENCE_OUTSIDE_MARGIN_RATIO = 0.25

export type GoonSceneAmbienceBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
  innerHalfX: number
  innerHalfZ: number
}

export type GoonSceneAmbienceSpriteLayer = {
  object: THREE.Sprite
  material: PointsNodeMaterial
  positionAttribute: THREE.InstancedBufferAttribute
}

export function createGoonSceneAmbienceSpriteLayer(options: {
  positions: Float32Array
  color: number
  size: readonly [number, number]
  opacity: number
  texture?: THREE.Texture | null
  additive?: boolean
}): GoonSceneAmbienceSpriteLayer {
  if (options.positions.length === 0 || options.positions.length % 3 !== 0) {
    throw new Error('Scene ambience positions must contain one or more XYZ triplets.')
  }

  const positionAttribute = new THREE.InstancedBufferAttribute(options.positions, 3)
  const material = new PointsNodeMaterial({
    color: options.color,
    transparent: true,
    opacity: options.opacity,
    depthWrite: false,
    sizeAttenuation: true,
    map: options.texture ?? undefined,
    blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending
  })
  material.positionNode = instancedDynamicBufferAttribute(positionAttribute)
  material.sizeNode = vec2(options.size[0], options.size[1])
  if (options.texture) {
    material.alphaTest = 0.02
  }

  // Three's runtime supports node materials on Sprite, while its current TypeScript
  // constructor still narrows the parameter to SpriteMaterial.
  const object = new THREE.Sprite(material as unknown as THREE.SpriteMaterial)
  object.count = options.positions.length / 3
  object.frustumCulled = false
  object.renderOrder = 3

  return { object, material, positionAttribute }
}

export function resolveGoonSceneAmbienceBounds(
  builder: GoonRoomShellBuilder | null | undefined,
  placement: NormalizedGoonSceneAmbience['placement']
): GoonSceneAmbienceBounds {
  const width = Math.max(
    AMBIENCE_MIN_ROOM_SIZE,
    Number.isFinite(builder?.width) ? Number(builder?.width) : 12
  )
  const depth = Math.max(
    AMBIENCE_MIN_ROOM_SIZE,
    Number.isFinite(builder?.depth) ? Number(builder?.depth) : 12
  )
  const height = Math.max(
    3,
    Number.isFinite(builder?.height) ? Number(builder?.height) : AMBIENCE_BASE_HEIGHT
  )
  const innerHalfX = width / 2
  const innerHalfZ = depth / 2
  const outsideMargin = THREE.MathUtils.clamp(
    Math.max(width, depth) * AMBIENCE_OUTSIDE_MARGIN_RATIO,
    AMBIENCE_OUTSIDE_MARGIN_MIN,
    AMBIENCE_OUTSIDE_MARGIN_MAX
  )
  const outerHalfX = innerHalfX + outsideMargin
  const outerHalfZ = innerHalfZ + outsideMargin

  if (placement === 'inside') {
    return {
      minX: -innerHalfX,
      maxX: innerHalfX,
      minY: 0.15,
      maxY: height + 1.5,
      minZ: -innerHalfZ,
      maxZ: innerHalfZ,
      innerHalfX,
      innerHalfZ
    }
  }

  if (placement === 'outside') {
    return {
      minX: -outerHalfX,
      maxX: outerHalfX,
      minY: 0.05,
      maxY: height + 3,
      minZ: -outerHalfZ,
      maxZ: outerHalfZ,
      innerHalfX: innerHalfX + 0.4,
      innerHalfZ: innerHalfZ + 0.4
    }
  }

  return {
    minX: -outerHalfX,
    maxX: outerHalfX,
    minY: 0.05,
    maxY: height + 3,
    minZ: -outerHalfZ,
    maxZ: outerHalfZ,
    innerHalfX: 0,
    innerHalfZ: 0
  }
}
