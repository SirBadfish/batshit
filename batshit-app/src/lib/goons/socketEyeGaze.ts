import * as THREE from 'three'
import type { CustomPerformanceDirection } from './customPerformanceRig'
import type { SocketEyeContactSettingsV2 } from './socketEyeContact'
import {
  projectTargetToSocketEyeSurface,
  type SocketEyeSide,
  type SocketEyeSurfaceDefinitionV2,
  type SocketEyeSurfaceProjection,
  type SocketEyeVec3
} from './socketEyeSurface'

export type SocketEyeCoordinates = { horizontal: number; vertical: number }
export type SocketEyeHeadAssist = { headYaw: number; headPitch: number }

export type SocketEyeGazeResolution = {
  projections: Record<SocketEyeSide, SocketEyeSurfaceProjection> | null
  gaze: Record<SocketEyeSide, SocketEyeCoordinates>
  headFollowPressure: number
  contactStatus: 'inactive' | 'target-behind' | 'projected'
}

export const SOCKET_EYE_LOOK_TARGETS = [
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeLookDownLeft',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeLookDownRight'
] as const

export type SocketEyeLookTarget = (typeof SOCKET_EYE_LOOK_TARGETS)[number]

function clampSigned(value: number) {
  return THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, -1, 1)
}

function mixCoordinates(
  authored: SocketEyeCoordinates,
  contact: SocketEyeCoordinates,
  strength: number
): SocketEyeCoordinates {
  const amount = THREE.MathUtils.clamp(strength, 0, 1)
  return {
    horizontal: THREE.MathUtils.lerp(authored.horizontal, contact.horizontal, amount),
    vertical: THREE.MathUtils.lerp(authored.vertical, contact.vertical, amount)
  }
}

function clampToSafeDomain(
  coordinates: SocketEyeCoordinates,
  maximumHorizontal: number,
  maximumVertical: number
): SocketEyeCoordinates {
  const x = coordinates.horizontal / maximumHorizontal
  const y = coordinates.vertical / maximumVertical
  const radius = Math.hypot(x, y)
  if (radius <= 1) return coordinates
  return {
    horizontal: (x / radius) * maximumHorizontal,
    vertical: (y / radius) * maximumVertical
  }
}

function applyConvergence(
  side: SocketEyeSide,
  coordinates: SocketEyeCoordinates,
  definition: SocketEyeSurfaceDefinitionV2,
  convergence: number
): SocketEyeCoordinates {
  const gaze = definition.runtimeBindings[side].gaze
  const inwardSign = side === 'left' ? -1 : 1
  return clampToSafeDomain(
    {
      horizontal:
        coordinates.horizontal + inwardSign * convergence * gaze.maximumHorizontal,
      vertical: coordinates.vertical
    },
    gaze.maximumHorizontal,
    gaze.maximumVertical
  )
}

function targetIsInFrontOfBothEyes(
  definition: SocketEyeSurfaceDefinitionV2,
  targetHeadLocal: SocketEyeVec3
) {
  const target = new THREE.Vector3(...targetHeadLocal)
  return (['left', 'right'] as const).every((side) => {
    const binding = definition.runtimeBindings[side]
    const direction = target.clone().sub(new THREE.Vector3(...binding.gazeAnchorHeadLocal))
    return direction.dot(new THREE.Vector3(...binding.forwardAxisHeadLocal)) > 1e-6
  })
}

export function resolveAuthoredSocketEyeCoordinates(
  definition: SocketEyeSurfaceDefinitionV2,
  direction: CustomPerformanceDirection
): Record<SocketEyeSide, SocketEyeCoordinates> {
  const left = definition.runtimeBindings.left.gaze
  const right = definition.runtimeBindings.right.gaze
  return {
    left: clampToSafeDomain(
      {
        horizontal: -clampSigned(direction.leftEyeYaw) * left.maximumHorizontal,
        vertical: clampSigned(direction.leftEyePitch) * left.maximumVertical
      },
      left.maximumHorizontal,
      left.maximumVertical
    ),
    right: clampToSafeDomain(
      {
        horizontal: -clampSigned(direction.rightEyeYaw) * right.maximumHorizontal,
        vertical: clampSigned(direction.rightEyePitch) * right.maximumVertical
      },
      right.maximumHorizontal,
      right.maximumVertical
    )
  }
}

export function resolveSocketEyeGaze(
  definition: SocketEyeSurfaceDefinitionV2,
  targetHeadLocal: SocketEyeVec3,
  authoredDirection: CustomPerformanceDirection,
  settings: SocketEyeContactSettingsV2,
  contactAllowed: boolean
): SocketEyeGazeResolution {
  const authored = resolveAuthoredSocketEyeCoordinates(definition, authoredDirection)
  const strength = settings.enabled && contactAllowed ? settings.strength : 0
  if (strength <= 0) {
    return {
      projections: null,
      gaze: authored,
      headFollowPressure: 0,
      contactStatus: 'inactive'
    }
  }
  // A camera behind the Head cannot make eye contact through the back of the
  // skull. Preserve the authored look until the target re-enters the shared
  // forward hemisphere; the strict surface projector remains fail-closed for
  // callers that claim a forward target but provide invalid geometry.
  if (!targetIsInFrontOfBothEyes(definition, targetHeadLocal)) {
    return {
      projections: null,
      gaze: authored,
      headFollowPressure: 0,
      contactStatus: 'target-behind'
    }
  }
  const projections = {
    left: projectTargetToSocketEyeSurface(definition.runtimeBindings.left, targetHeadLocal),
    right: projectTargetToSocketEyeSurface(definition.runtimeBindings.right, targetHeadLocal)
  }
  return {
    projections,
    gaze: {
      left: mixCoordinates(
        authored.left,
        applyConvergence('left', projections.left.resolved, definition, settings.convergence),
        strength
      ),
      right: mixCoordinates(
        authored.right,
        applyConvergence('right', projections.right.resolved, definition, settings.convergence),
        strength
      )
    },
    headFollowPressure:
      strength * Math.max(projections.left.headFollowPressure, projections.right.headFollowPressure),
    contactStatus: 'projected'
  }
}

/**
 * Convert the final, already-smoothed socket coordinates into the exact
 * ARKit-52 Look channels used by the eyelids, face, and eye treatment. The
 * physical-eye shader and the facial accommodation therefore share one
 * resolved gaze instead of running competing look solvers.
 */
export function resolveSocketEyeLookTargetWeights(
  definition: SocketEyeSurfaceDefinitionV2,
  gaze: Record<SocketEyeSide, SocketEyeCoordinates>
): Map<SocketEyeLookTarget, number> {
  const result = new Map<SocketEyeLookTarget, number>()
  const set = (target: SocketEyeLookTarget, value: number) => {
    result.set(target, THREE.MathUtils.clamp(value, 0, 1))
  }
  for (const side of ['left', 'right'] as const) {
    const limits = definition.runtimeBindings[side].gaze
    const horizontal = clampSigned(gaze[side].horizontal / limits.maximumHorizontal)
    const vertical = clampSigned(gaze[side].vertical / limits.maximumVertical)
    if (side === 'left') {
      set('eyeLookInLeft', Math.max(0, -horizontal))
      set('eyeLookOutLeft', Math.max(0, horizontal))
      set('eyeLookUpLeft', Math.max(0, vertical))
      set('eyeLookDownLeft', Math.max(0, -vertical))
    } else {
      set('eyeLookInRight', Math.max(0, horizontal))
      set('eyeLookOutRight', Math.max(0, -horizontal))
      set('eyeLookUpRight', Math.max(0, vertical))
      set('eyeLookDownRight', Math.max(0, -vertical))
    }
  }
  return result
}

export function resolveSocketEyeHeadAssist(
  targetHeadLocal: SocketEyeVec3,
  pressure: number,
  headFollow: number
) {
  const target = new THREE.Vector3(...targetHeadLocal)
  if (target.lengthSq() <= 1e-9) {
    throw new Error('[socket-eye-gaze] target must not coincide with the Head origin')
  }
  const horizontal = Math.max(1e-6, Math.hypot(target.x, target.z))
  const yawDegrees = THREE.MathUtils.radToDeg(Math.atan2(target.x, target.z))
  const pitchDegrees = THREE.MathUtils.radToDeg(Math.atan2(target.y, horizontal))
  const amount = THREE.MathUtils.clamp(pressure, 0, 1) * THREE.MathUtils.clamp(headFollow, 0, 1)
  if (amount === 0) return { headYaw: 0, headPitch: 0 }
  return {
    // Camera Head-local X and performance-rig Head yaw use opposite signs.
    // Keep pitch unchanged: its Head-local and authored directions already
    // agree. Applying the same sign conversion to both axes mirrors only the
    // horizontal Head Follow in the live Goon.
    headYaw: -clampSigned(yawDegrees / 60) * amount,
    headPitch: clampSigned(pitchDegrees / 45) * amount
  }
}

export function smoothSocketEyeHeadAssist(
  current: SocketEyeHeadAssist,
  target: SocketEyeHeadAssist,
  responseLerp: number
): SocketEyeHeadAssist {
  const amount = THREE.MathUtils.clamp(responseLerp, 0, 1)
  return {
    headYaw: THREE.MathUtils.lerp(current.headYaw, target.headYaw, amount),
    headPitch: THREE.MathUtils.lerp(current.headPitch, target.headPitch, amount)
  }
}
