import * as THREE from 'three'
import type { GoonFaceControl } from '$lib/types/goons'
import type { ResolvedCustomExpressionBinding } from '$lib/goons/customAvatar'

const LEGACY_CONTRACT = 'batshit-performance-rig/v1' as const
const SOCKET_CONTRACT = 'batshit-performance-rig/v2' as const
const TRANSFORM_COMBINE = 'translation-sum-rotation-vector-sum/v1' as const
const EPSILON = 1e-8
const SHARE_TOLERANCE = 1e-6

type Vec3 = [number, number, number]

export type CustomPerformanceAxis = {
  axis: Vec3
  sign: -1 | 1
  rangeDegrees: {
    negative: number
    positive: number
  }
}

export type CustomPerformanceLookNode = {
  node: string
  yaw: CustomPerformanceAxis
  pitch: CustomPerformanceAxis
}

export type CustomPerformanceTargetChannel = {
  translation: Vec3
  rotationVector: Vec3
}

export type CustomPerformanceTargetTransform = {
  node: string
  combine: typeof TRANSFORM_COMBINE
  channels: Record<string, CustomPerformanceTargetChannel>
}

type CustomPerformanceRigManifestBase = {
  space: 'node-parent-rest'
  rotation: {
    representation: 'rotation-vector'
    units: 'radians'
    composition: 'ordered-expmap/v1'
  }
  targetTransforms: Record<string, CustomPerformanceTargetTransform>
}

export type LegacyCustomPerformanceRigManifest = CustomPerformanceRigManifestBase & {
  contract: typeof LEGACY_CONTRACT
  nodes: {
    head: CustomPerformanceLookNode
    neck: CustomPerformanceLookNode
    leftEye: CustomPerformanceLookNode
    rightEye: CustomPerformanceLookNode
  }
  look: {
    headYawShares: { head: number; neck: number }
    headPitchShares: { head: number; neck: number }
    eyeYawMode: 'asymmetric-in-out'
    eyePitchMode: 'asymmetric-up-down'
  }
}

export type SocketCustomPerformanceRigManifest = CustomPerformanceRigManifestBase & {
  contract: typeof SOCKET_CONTRACT
  nodes: {
    head: CustomPerformanceLookNode
    neck: CustomPerformanceLookNode
  }
  look: {
    headYawShares: { head: number; neck: number }
    headPitchShares: { head: number; neck: number }
    eyeDriver: 'socket-surface-target/v1'
  }
}

export type CustomPerformanceRigManifest =
  | LegacyCustomPerformanceRigManifest
  | SocketCustomPerformanceRigManifest

export type CustomPerformanceDirection = {
  headYaw: number
  headPitch: number
  leftEyeYaw: number
  leftEyePitch: number
  rightEyeYaw: number
  rightEyePitch: number
}

export type CustomPerformanceEyeContactState = {
  eyeYaw: number
  eyePitch: number
  headYaw: number
  headPitch: number
}

export type CustomPerformanceEyeContactRange = {
  eyeYaw: number
  eyePitch: number
  headYaw: number
  headPitch: number
}

export const NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION: CustomPerformanceDirection =
  Object.freeze({
    headYaw: 0,
    headPitch: 0,
    leftEyeYaw: 0,
    leftEyePitch: 0,
    rightEyeYaw: 0,
    rightEyePitch: 0
  })

export type WeightedCustomExpressionTarget = {
  preset: string
  weight: number
}

export type CustomPerformanceRigResolution = {
  manifest: CustomPerformanceRigManifest | null
  issues: string[]
}

export type CustomPerformanceRigResolutionOptions = {
  required?: boolean
}

export type CustomPerformanceRigBinding = {
  runtime: CustomPerformanceRigRuntime | null
  issues: string[]
}

type BoundLookNode = {
  node: THREE.Object3D
  spec: CustomPerformanceLookNode
}

type CustomPerformanceLookRole = 'head' | 'neck' | 'leftEye' | 'rightEye'

type BoundTargetTransform = {
  node: THREE.Object3D
  spec: CustomPerformanceTargetTransform
}

type AppliedOverlay = {
  translation: THREE.Vector3
  rotation: THREE.Quaternion
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function addIssue(issues: string[], path: string, message: string) {
  issues.push(`${path} ${message}`)
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[]
) {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key))
      addIssue(issues, `${path}.${key}`, 'is not allowed by this performance contract.')
  }
}

function parseFiniteNumber(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(issues, path, 'must be a finite number.')
    return 0
  }
  return value
}

function parseNonNegativeNumber(
  value: unknown,
  path: string,
  issues: string[]
) {
  const parsed = parseFiniteNumber(value, path, issues)
  if (parsed < 0) addIssue(issues, path, 'must be non-negative.')
  return Math.max(0, parsed)
}

function parseVec3(value: unknown, path: string, issues: string[]): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    addIssue(issues, path, 'must be a three-number vector.')
    return [0, 0, 0]
  }
  return [
    parseFiniteNumber(value[0], `${path}[0]`, issues),
    parseFiniteNumber(value[1], `${path}[1]`, issues),
    parseFiniteNumber(value[2], `${path}[2]`, issues)
  ]
}

function parseNonEmptyString(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'string' || !value.trim()) {
    addIssue(issues, path, 'must be a non-empty string.')
    return ''
  }
  if (value !== value.trim()) {
    addIssue(issues, path, 'must not contain leading or trailing whitespace.')
  }
  return value.trim()
}

function parseAxis(
  value: unknown,
  path: string,
  issues: string[]
): CustomPerformanceAxis {
  if (!isRecord(value)) {
    addIssue(issues, path, 'must be an object.')
    return {
      axis: [0, 0, 0],
      sign: 1,
      rangeDegrees: { negative: 0, positive: 0 }
    }
  }
  rejectUnknownKeys(value, ['axis', 'sign', 'rangeDegrees'], path, issues)
  const axis = parseVec3(value.axis, `${path}.axis`, issues)
  const axisLength = Math.hypot(...axis)
  if (Math.abs(axisLength - 1) > 1e-5) {
    addIssue(issues, `${path}.axis`, 'must be unit length.')
  }
  const signValue = parseFiniteNumber(value.sign, `${path}.sign`, issues)
  if (signValue !== -1 && signValue !== 1) {
    addIssue(issues, `${path}.sign`, 'must be exactly -1 or 1.')
  }
  const range = value.rangeDegrees
  if (!isRecord(range)) {
    addIssue(issues, `${path}.rangeDegrees`, 'must be an object.')
  } else {
    rejectUnknownKeys(
      range,
      ['negative', 'positive'],
      `${path}.rangeDegrees`,
      issues
    )
  }
  return {
    axis,
    sign: signValue === -1 ? -1 : 1,
    rangeDegrees: {
      negative: parseNonNegativeNumber(
        isRecord(range) ? range.negative : undefined,
        `${path}.rangeDegrees.negative`,
        issues
      ),
      positive: parseNonNegativeNumber(
        isRecord(range) ? range.positive : undefined,
        `${path}.rangeDegrees.positive`,
        issues
      )
    }
  }
}

function parseLookNode(
  value: unknown,
  path: string,
  issues: string[]
): CustomPerformanceLookNode {
  if (!isRecord(value)) {
    addIssue(issues, path, 'must be an object.')
    return {
      node: '',
      yaw: parseAxis(null, `${path}.yaw`, issues),
      pitch: parseAxis(null, `${path}.pitch`, issues)
    }
  }
  rejectUnknownKeys(value, ['node', 'yaw', 'pitch'], path, issues)
  return {
    node: parseNonEmptyString(value.node, `${path}.node`, issues),
    yaw: parseAxis(value.yaw, `${path}.yaw`, issues),
    pitch: parseAxis(value.pitch, `${path}.pitch`, issues)
  }
}

function parseShares(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) {
    addIssue(issues, path, 'must be an object.')
    return { head: 0, neck: 0 }
  }
  rejectUnknownKeys(value, ['head', 'neck'], path, issues)
  const result = {
    head: parseNonNegativeNumber(value.head, `${path}.head`, issues),
    neck: parseNonNegativeNumber(value.neck, `${path}.neck`, issues)
  }
  if (Math.abs(result.head + result.neck - 1) > SHARE_TOLERANCE) {
    addIssue(issues, path, 'head + neck must equal 1.')
  }
  return result
}

function parseTargetChannel(
  value: unknown,
  path: string,
  issues: string[]
): CustomPerformanceTargetChannel {
  if (!isRecord(value)) {
    addIssue(issues, path, 'must be an object.')
    return { translation: [0, 0, 0], rotationVector: [0, 0, 0] }
  }
  rejectUnknownKeys(value, ['translation', 'rotationVector'], path, issues)
  const translation =
    value.translation === undefined
      ? ([0, 0, 0] as Vec3)
      : parseVec3(value.translation, `${path}.translation`, issues)
  const rotationVector =
    value.rotationVector === undefined
      ? ([0, 0, 0] as Vec3)
      : parseVec3(value.rotationVector, `${path}.rotationVector`, issues)
  if (
    translation.every((entry) => Math.abs(entry) <= EPSILON) &&
    rotationVector.every((entry) => Math.abs(entry) <= EPSILON)
  ) {
    addIssue(
      issues,
      path,
      'must declare a non-zero translation or rotationVector.'
    )
  }
  return { translation, rotationVector }
}

function parseTargetTransform(
  value: unknown,
  path: string,
  issues: string[]
): CustomPerformanceTargetTransform {
  if (!isRecord(value)) {
    addIssue(issues, path, 'must be an object.')
    return { node: '', combine: TRANSFORM_COMBINE, channels: {} }
  }
  rejectUnknownKeys(value, ['node', 'combine', 'channels'], path, issues)
  if (value.combine !== TRANSFORM_COMBINE) {
    addIssue(issues, `${path}.combine`, `must equal "${TRANSFORM_COMBINE}".`)
  }
  const channels: Record<string, CustomPerformanceTargetChannel> = {}
  if (!isRecord(value.channels) || Object.keys(value.channels).length === 0) {
    addIssue(issues, `${path}.channels`, 'must be a non-empty object.')
  } else {
    for (const [targetName, rawChannel] of Object.entries(value.channels)) {
      const trimmed = targetName.trim()
      if (!trimmed) {
        addIssue(issues, `${path}.channels`, 'contains an empty target name.')
        continue
      }
      if (targetName !== trimmed) {
        addIssue(
          issues,
          `${path}.channels.${targetName}`,
          'must not contain surrounding whitespace.'
        )
      }
      if (Object.hasOwn(channels, trimmed)) {
        addIssue(
          issues,
          `${path}.channels.${targetName}`,
          `duplicates target "${trimmed}".`
        )
        continue
      }
      channels[trimmed] = parseTargetChannel(
        rawChannel,
        `${path}.channels.${trimmed}`,
        issues
      )
    }
  }
  return {
    node: parseNonEmptyString(value.node, `${path}.node`, issues),
    combine: TRANSFORM_COMBINE,
    channels
  }
}

export function resolveCustomPerformanceRigManifest(
  value: unknown,
  options: CustomPerformanceRigResolutionOptions = {}
): CustomPerformanceRigResolution {
  if (value === undefined || value === null) {
    return options.required
      ? {
          manifest: null,
          issues: [
            'rig.performance is required for first-party appearance packages.'
          ]
        }
      : { manifest: null, issues: [] }
  }
  const issues: string[] = []
  const path = 'rig.performance'
  if (!isRecord(value)) {
    return { manifest: null, issues: [`${path} must be an object.`] }
  }
  rejectUnknownKeys(
    value,
    ['contract', 'space', 'rotation', 'nodes', 'look', 'targetTransforms'],
    path,
    issues
  )
  const contract =
    value.contract === LEGACY_CONTRACT || value.contract === SOCKET_CONTRACT
      ? value.contract
      : null
  if (!contract) {
    addIssue(
      issues,
      `${path}.contract`,
      `must equal "${LEGACY_CONTRACT}" or "${SOCKET_CONTRACT}".`
    )
  }
  if (value.space !== 'node-parent-rest') {
    addIssue(issues, `${path}.space`, 'must equal "node-parent-rest".')
  }

  const rotation = value.rotation
  if (!isRecord(rotation)) {
    addIssue(issues, `${path}.rotation`, 'must be an object.')
  } else {
    rejectUnknownKeys(
      rotation,
      ['representation', 'units', 'composition'],
      `${path}.rotation`,
      issues
    )
    if (rotation.representation !== 'rotation-vector') {
      addIssue(
        issues,
        `${path}.rotation.representation`,
        'must equal "rotation-vector".'
      )
    }
    if (rotation.units !== 'radians') {
      addIssue(issues, `${path}.rotation.units`, 'must equal "radians".')
    }
    if (rotation.composition !== 'ordered-expmap/v1') {
      addIssue(
        issues,
        `${path}.rotation.composition`,
        'must equal "ordered-expmap/v1".'
      )
    }
  }

  const nodes = value.nodes
  if (!isRecord(nodes)) {
    addIssue(issues, `${path}.nodes`, 'must be an object.')
  } else {
    rejectUnknownKeys(
      nodes,
      contract === SOCKET_CONTRACT
        ? ['head', 'neck']
        : ['head', 'neck', 'leftEye', 'rightEye'],
      `${path}.nodes`,
      issues
    )
  }
  const parsedHeadAndNeck = {
    head: parseLookNode(
      isRecord(nodes) ? nodes.head : undefined,
      `${path}.nodes.head`,
      issues
    ),
    neck: parseLookNode(
      isRecord(nodes) ? nodes.neck : undefined,
      `${path}.nodes.neck`,
      issues
    )
  }
  const parsedLegacyEyeNodes =
    contract === SOCKET_CONTRACT
      ? null
      : {
          leftEye: parseLookNode(
            isRecord(nodes) ? nodes.leftEye : undefined,
            `${path}.nodes.leftEye`,
            issues
          ),
          rightEye: parseLookNode(
            isRecord(nodes) ? nodes.rightEye : undefined,
            `${path}.nodes.rightEye`,
            issues
          )
        }

  const look = value.look
  if (!isRecord(look)) {
    addIssue(issues, `${path}.look`, 'must be an object.')
  } else {
    rejectUnknownKeys(
      look,
      contract === SOCKET_CONTRACT
        ? ['headYawShares', 'headPitchShares', 'eyeDriver']
        : ['headYawShares', 'headPitchShares', 'eyeYawMode', 'eyePitchMode'],
      `${path}.look`,
      issues
    )
    if (contract === SOCKET_CONTRACT && look.eyeDriver !== 'socket-surface-target/v1') {
      addIssue(
        issues,
        `${path}.look.eyeDriver`,
        'must equal "socket-surface-target/v1".'
      )
    } else if (contract !== SOCKET_CONTRACT && look.eyeYawMode !== 'asymmetric-in-out') {
      addIssue(
        issues,
        `${path}.look.eyeYawMode`,
        'must equal "asymmetric-in-out".'
      )
    } else if (contract !== SOCKET_CONTRACT && look.eyePitchMode !== 'asymmetric-up-down') {
      addIssue(issues, `${path}.look.eyePitchMode`, 'must equal "asymmetric-up-down".')
    }
  }
  const parsedShares = {
    headYawShares: parseShares(
      isRecord(look) ? look.headYawShares : undefined,
      `${path}.look.headYawShares`,
      issues
    ),
    headPitchShares: parseShares(
      isRecord(look) ? look.headPitchShares : undefined,
      `${path}.look.headPitchShares`,
      issues
    )
  }

  const targetTransforms: Record<string, CustomPerformanceTargetTransform> = {}
  if (!isRecord(value.targetTransforms)) {
    addIssue(issues, `${path}.targetTransforms`, 'must be an object.')
  } else if (Object.keys(value.targetTransforms).length === 0) {
    addIssue(
      issues,
      `${path}.targetTransforms`,
      'must declare at least one transform driver.'
    )
  } else {
    for (const [role, rawTransform] of Object.entries(value.targetTransforms)) {
      const trimmed = role.trim()
      if (!trimmed) {
        addIssue(
          issues,
          `${path}.targetTransforms`,
          'contains an empty role name.'
        )
        continue
      }
      if (role !== trimmed) {
        addIssue(
          issues,
          `${path}.targetTransforms.${role}`,
          'must not contain surrounding whitespace.'
        )
      }
      if (Object.hasOwn(targetTransforms, trimmed)) {
        addIssue(
          issues,
          `${path}.targetTransforms.${role}`,
          `duplicates role "${trimmed}".`
        )
        continue
      }
      targetTransforms[trimmed] = parseTargetTransform(
        rawTransform,
        `${path}.targetTransforms.${trimmed}`,
        issues
      )
    }
  }

  if (issues.length > 0) return { manifest: null, issues }
  const base = {
      space: 'node-parent-rest',
      rotation: {
        representation: 'rotation-vector',
        units: 'radians',
        composition: 'ordered-expmap/v1'
      },
      targetTransforms
  } satisfies CustomPerformanceRigManifestBase
  return {
    manifest:
      contract === SOCKET_CONTRACT
        ? {
            ...base,
            contract: SOCKET_CONTRACT,
            nodes: parsedHeadAndNeck,
            look: {
              ...parsedShares,
              eyeDriver: 'socket-surface-target/v1'
            }
          }
        : {
            ...base,
            contract: LEGACY_CONTRACT,
            nodes: { ...parsedHeadAndNeck, ...parsedLegacyEyeNodes! },
            look: {
              ...parsedShares,
              eyeYawMode: 'asymmetric-in-out',
              eyePitchMode: 'asymmetric-up-down'
            }
          },
    issues: []
  }
}

function clampSigned(value: number) {
  return THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, -1, 1)
}

function readWeight(weights: ReadonlyMap<string, number>, target: string) {
  const value = weights.get(target) ?? 0
  return THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1)
}

const CUSTOM_PERFORMANCE_DIRECTION_PRESETS = new Set<string>([
  'lookLeftHead',
  'lookRightHead',
  'lookUpHead',
  'lookDownHead',
  'lookLeft',
  'lookRight',
  'lookUp',
  'lookDown'
])

export function shouldApplyCustomExpressionMorphPreset(
  preset: string,
  hasBoundPerformanceRig: boolean
) {
  return (
    hasBoundPerformanceRig || !CUSTOM_PERFORMANCE_DIRECTION_PRESETS.has(preset)
  )
}

export function resolveCustomPerformanceDirection(input: {
  expressionTargets?: readonly WeightedCustomExpressionTarget[]
  faceControls?: readonly GoonFaceControl[]
  rawTargetWeights?: ReadonlyMap<string, number>
}): CustomPerformanceDirection {
  let headYaw = 0
  let headPitch = 0
  let eyeYaw = 0
  let eyePitch = 0

  for (const target of input.expressionTargets ?? []) {
    const weight = THREE.MathUtils.clamp(
      Number.isFinite(target.weight) ? target.weight : 0,
      0,
      1
    )
    if (target.preset === 'lookLeftHead') headYaw -= weight
    else if (target.preset === 'lookRightHead') headYaw += weight
    else if (target.preset === 'lookDownHead') headPitch -= weight
    else if (target.preset === 'lookUpHead') headPitch += weight
    else if (target.preset === 'lookLeft') eyeYaw -= weight
    else if (target.preset === 'lookRight') eyeYaw += weight
    else if (target.preset === 'lookDown') eyePitch -= weight
    else if (target.preset === 'lookUp') eyePitch += weight
  }

  for (const faceControl of input.faceControls ?? []) {
    const value = clampSigned(faceControl.value)
    if (faceControl.control === 'head_leftright') headYaw += value
    else if (faceControl.control === 'head_updown') headPitch += value
    else if (faceControl.control === 'eyes_leftright') eyeYaw += value
    else if (faceControl.control === 'eyes_updown') eyePitch += value
  }

  const raw = input.rawTargetWeights ?? new Map<string, number>()
  const hasLeftEyeYawRaw = raw.has('eyeLookOutLeft') || raw.has('eyeLookInLeft')
  const hasRightEyeYawRaw = raw.has('eyeLookInRight') || raw.has('eyeLookOutRight')
  const hasLeftEyePitchRaw = raw.has('eyeLookDownLeft') || raw.has('eyeLookUpLeft')
  const hasRightEyePitchRaw = raw.has('eyeLookDownRight') || raw.has('eyeLookUpRight')
  const leftEyeYaw =
    (hasLeftEyeYawRaw ? 0 : eyeYaw) -
    readWeight(raw, 'eyeLookOutLeft') +
    readWeight(raw, 'eyeLookInLeft')
  const rightEyeYaw =
    (hasRightEyeYawRaw ? 0 : eyeYaw) -
    readWeight(raw, 'eyeLookInRight') +
    readWeight(raw, 'eyeLookOutRight')
  const leftEyePitch =
    (hasLeftEyePitchRaw ? 0 : eyePitch) -
    readWeight(raw, 'eyeLookDownLeft') +
    readWeight(raw, 'eyeLookUpLeft')
  const rightEyePitch =
    (hasRightEyePitchRaw ? 0 : eyePitch) -
    readWeight(raw, 'eyeLookDownRight') +
    readWeight(raw, 'eyeLookUpRight')

  return {
    headYaw: clampSigned(headYaw),
    headPitch: clampSigned(headPitch),
    leftEyeYaw: clampSigned(leftEyeYaw),
    leftEyePitch: clampSigned(leftEyePitch),
    rightEyeYaw: clampSigned(rightEyeYaw),
    rightEyePitch: clampSigned(rightEyePitch)
  }
}

/**
 * Eye Contact v2 and the custom performance rig use opposite signed look
 * channels. Reduce the two independent authored eyes only for the shared
 * camera-contact solver; the final composition below restores their exact
 * asymmetric difference.
 */
export function resolveCustomPerformanceEyeContactState(
  direction: CustomPerformanceDirection
): CustomPerformanceEyeContactState {
  return {
    eyeYaw: clampSigned(-(direction.leftEyeYaw + direction.rightEyeYaw) / 2),
    eyePitch: clampSigned(-(direction.leftEyePitch + direction.rightEyePitch) / 2),
    headYaw: clampSigned(-direction.headYaw),
    headPitch: clampSigned(-direction.headPitch)
  }
}

export function hasCustomPerformanceAuthoredEyeDirection(
  direction: CustomPerformanceDirection,
  threshold = 0.05
) {
  return (
    Math.max(
      Math.abs(direction.leftEyeYaw),
      Math.abs(direction.leftEyePitch),
      Math.abs(direction.rightEyeYaw),
      Math.abs(direction.rightEyePitch)
    ) >= threshold
  )
}

/**
 * Map the shared Eye Contact result back onto the performance rig without
 * collapsing one-sided ARKit eye input. The shared ambient eye delta is added
 * equally to both eyes; authored asymmetry stays intact.
 */
export function composeCustomPerformanceEyeContact(
  authored: CustomPerformanceDirection,
  applied: CustomPerformanceEyeContactState,
  range: CustomPerformanceEyeContactRange = {
    eyeYaw: 1,
    eyePitch: 1,
    headYaw: 1,
    headPitch: 1
  }
): CustomPerformanceDirection {
  const authoredState = resolveCustomPerformanceEyeContactState(authored)
  const ambientEyeYaw = applied.eyeYaw - authoredState.eyeYaw
  const ambientEyePitch = applied.eyePitch - authoredState.eyePitch
  const ambientHeadYaw = applied.headYaw - authoredState.headYaw
  const ambientHeadPitch = applied.headPitch - authoredState.headPitch

  return {
    headYaw: clampSigned(authored.headYaw - ambientHeadYaw * range.headYaw),
    headPitch: clampSigned(authored.headPitch - ambientHeadPitch * range.headPitch),
    leftEyeYaw: clampSigned(authored.leftEyeYaw - ambientEyeYaw * range.eyeYaw),
    leftEyePitch: clampSigned(authored.leftEyePitch - ambientEyePitch * range.eyePitch),
    rightEyeYaw: clampSigned(authored.rightEyeYaw - ambientEyeYaw * range.eyeYaw),
    rightEyePitch: clampSigned(authored.rightEyePitch - ambientEyePitch * range.eyePitch)
  }
}

export function resolveFaceControlEyeLookPresetWeights(
  faceControls: readonly GoonFaceControl[]
): Map<string, number> {
  const result = new Map<string, number>()
  const setMax = (preset: string, value: number) => {
    const clamped = THREE.MathUtils.clamp(value, 0, 1)
    if (clamped <= 0) return
    result.set(preset, Math.max(result.get(preset) ?? 0, clamped))
  }
  for (const faceControl of faceControls) {
    const value = clampSigned(faceControl.value)
    if (faceControl.control === 'eyes_leftright') {
      if (value < 0) setMax('lookLeft', -value)
      else setMax('lookRight', value)
    } else if (faceControl.control === 'eyes_updown') {
      if (value < 0) setMax('lookDown', -value)
      else setMax('lookUp', value)
    }
  }
  return result
}

export function resolveFinalCustomTargetWeights(input: {
  expressionWeights: ReadonlyMap<string, number>
  expressionBindings: ReadonlyMap<string, readonly ResolvedCustomExpressionBinding[]>
  faceControlWeights: ReadonlyMap<string, number>
  rawTargetWeights: ReadonlyMap<string, number>
}): Map<string, number> {
  const result = new Map<string, number>()
  const setMax = (target: string, value: number) => {
    const clamped = THREE.MathUtils.clamp(
      Number.isFinite(value) ? value : 0,
      0,
      1
    )
    result.set(target, Math.max(result.get(target) ?? 0, clamped))
  }
  for (const [preset, value] of input.expressionWeights) {
    for (const binding of input.expressionBindings.get(preset) ?? []) {
      setMax(binding.target, value * binding.weight)
    }
  }
  for (const [target, value] of input.faceControlWeights) setMax(target, value)
  for (const [target, value] of input.rawTargetWeights) {
    result.set(
      target,
      THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1)
    )
  }
  return result
}

export function resolveSocketEyeBlinkClosureTargetWeights(
  input: ReadonlyMap<string, number>,
  fullBlinkSquintFloor: number
): Map<string, number> {
  const floor = THREE.MathUtils.clamp(
    Number.isFinite(fullBlinkSquintFloor) ? fullBlinkSquintFloor : 0,
    0,
    1
  )
  const result = new Map(input)
  for (const suffix of ['Left', 'Right'] as const) {
    const blinkTarget = `eyeBlink${suffix}`
    const squintTarget = `eyeSquint${suffix}`
    const blink = THREE.MathUtils.clamp(result.get(blinkTarget) ?? 0, 0, 1)
    const explicitSquint = THREE.MathUtils.clamp(result.get(squintTarget) ?? 0, 0, 1)
    result.set(squintTarget, Math.max(explicitSquint, blink * floor))
  }
  return result
}

function vectorFromTuple(value: Vec3) {
  return new THREE.Vector3(value[0], value[1], value[2])
}

function quaternionFromRotationVector(rotationVector: THREE.Vector3) {
  const angle = rotationVector.length()
  if (angle <= EPSILON) return new THREE.Quaternion()
  return new THREE.Quaternion().setFromAxisAngle(
    rotationVector.clone().divideScalar(angle),
    angle
  )
}

function axisRotationVector(
  spec: CustomPerformanceAxis,
  value: number,
  share = 1
) {
  const clamped = clampSigned(value)
  const rangeDegrees =
    clamped < 0 ? spec.rangeDegrees.negative : spec.rangeDegrees.positive
  const angle = THREE.MathUtils.degToRad(
    Math.abs(clamped) * rangeDegrees * spec.sign * Math.sign(clamped)
  )
  return vectorFromTuple(spec.axis).multiplyScalar(angle * share)
}

export class CustomPerformanceRigRuntime {
  readonly manifest: CustomPerformanceRigManifest
  private readonly lookNodes: Partial<Record<CustomPerformanceLookRole, BoundLookNode>>
  private readonly targetTransforms: BoundTargetTransform[]
  private readonly lookRestTransforms = new Map<
    THREE.Object3D,
    { position: THREE.Vector3; rotation: THREE.Quaternion }
  >()
  private applied = new Map<THREE.Object3D, AppliedOverlay>()
  private disposed = false

  constructor(
    manifest: CustomPerformanceRigManifest,
    lookNodes: Partial<Record<CustomPerformanceLookRole, BoundLookNode>>,
    targetTransforms: BoundTargetTransform[]
  ) {
    this.manifest = manifest
    this.lookNodes = lookNodes
    this.targetTransforms = targetTransforms
    for (const binding of Object.values(lookNodes)) {
      if (!binding) continue
      const { node } = binding
      this.lookRestTransforms.set(node, {
        position: node.position.clone(),
        rotation: node.quaternion.clone()
      })
    }
  }

  getLookNode(role: CustomPerformanceLookRole) {
    const binding = this.lookNodes[role]
    if (!binding) {
      throw new Error(
        `[custom-performance-rig] ${this.manifest.contract} does not expose ${role} as a rotating look node.`
      )
    }
    return binding.node
  }

  hasLookNode(role: CustomPerformanceLookRole) {
    return Boolean(this.lookNodes[role])
  }

  usesSocketEyeDriver() {
    return this.manifest.contract === SOCKET_CONTRACT
  }

  rebaseLookNodePositions() {
    for (const binding of Object.values(this.lookNodes)) {
      if (!binding) continue
      const { node } = binding
      const rest = this.lookRestTransforms.get(node)
      if (rest) rest.position.copy(node.position)
    }
  }

  neutralizeMotionLookNodes() {
    this.removeOverlay()
    for (const [node, rest] of this.lookRestTransforms) {
      node.position.copy(rest.position)
      node.quaternion.copy(rest.rotation)
    }
  }

  removeOverlay() {
    if (this.applied.size === 0) return
    for (const [node, overlay] of this.applied) {
      node.position.sub(overlay.translation)
      node.quaternion.premultiply(overlay.rotation.clone().invert()).normalize()
    }
    this.applied.clear()
  }

  apply(
    direction: CustomPerformanceDirection,
    finalTargetWeights: ReadonlyMap<string, number>
  ) {
    if (this.disposed) return
    this.removeOverlay()
    const rotationVectors = new Map<THREE.Object3D, THREE.Vector3>()
    const translations = new Map<THREE.Object3D, THREE.Vector3>()
    const addLook = (
      binding: BoundLookNode,
      yaw: number,
      pitch: number,
      yawShare = 1,
      pitchShare = 1
    ) => {
      const rotationVector =
        rotationVectors.get(binding.node) ?? new THREE.Vector3()
      rotationVector.add(axisRotationVector(binding.spec.yaw, yaw, yawShare))
      rotationVector.add(
        axisRotationVector(binding.spec.pitch, pitch, pitchShare)
      )
      rotationVectors.set(binding.node, rotationVector)
    }

    addLook(
      this.lookNodes.head!,
      direction.headYaw,
      direction.headPitch,
      this.manifest.look.headYawShares.head,
      this.manifest.look.headPitchShares.head
    )
    addLook(
      this.lookNodes.neck!,
      direction.headYaw,
      direction.headPitch,
      this.manifest.look.headYawShares.neck,
      this.manifest.look.headPitchShares.neck
    )
    if (this.manifest.contract === LEGACY_CONTRACT) {
      addLook(this.lookNodes.leftEye!, direction.leftEyeYaw, direction.leftEyePitch)
      addLook(this.lookNodes.rightEye!, direction.rightEyeYaw, direction.rightEyePitch)
    }

    for (const binding of this.targetTransforms) {
      const translation = translations.get(binding.node) ?? new THREE.Vector3()
      const rotationVector =
        rotationVectors.get(binding.node) ?? new THREE.Vector3()
      for (const [target, channel] of Object.entries(binding.spec.channels)) {
        const weight = THREE.MathUtils.clamp(
          finalTargetWeights.get(target) ?? 0,
          0,
          1
        )
        if (weight <= 0) continue
        translation.addScaledVector(
          vectorFromTuple(channel.translation),
          weight
        )
        rotationVector.addScaledVector(
          vectorFromTuple(channel.rotationVector),
          weight
        )
      }
      translations.set(binding.node, translation)
      rotationVectors.set(binding.node, rotationVector)
    }

    const nodes = new Set([...rotationVectors.keys(), ...translations.keys()])
    for (const node of nodes) {
      const translation = translations.get(node) ?? new THREE.Vector3()
      const rotation = quaternionFromRotationVector(
        rotationVectors.get(node) ?? new THREE.Vector3()
      )
      if (
        translation.lengthSq() <= EPSILON * EPSILON &&
        1 - Math.abs(rotation.w) <= EPSILON
      )
        continue
      node.position.add(translation)
      node.quaternion.premultiply(rotation).normalize()
      this.applied.set(node, { translation: translation.clone(), rotation })
    }
  }

  dispose() {
    if (this.disposed) return
    this.removeOverlay()
    this.disposed = true
  }
}

export function bindCustomPerformanceRig(
  root: THREE.Object3D,
  manifest: CustomPerformanceRigManifest | null
): CustomPerformanceRigBinding {
  if (!manifest) return { runtime: null, issues: [] }
  const issues: string[] = []
  const byName = new Map<string, THREE.Object3D[]>()
  root.traverse((node) => {
    const name = node.name.trim()
    if (!name) return
    const bucket = byName.get(name) ?? []
    bucket.push(node)
    byName.set(name, bucket)
  })
  const resolveUnique = (name: string, path: string) => {
    const matches = byName.get(name) ?? []
    if (matches.length === 0) {
      addIssue(issues, path, `references missing runtime node "${name}".`)
      return null
    }
    if (matches.length > 1) {
      addIssue(
        issues,
        path,
        `references ${matches.length} runtime nodes named "${name}"; exactly one is required.`
      )
      return null
    }
    return matches[0]!
  }

  const boundLook: Partial<Record<CustomPerformanceLookRole, BoundLookNode>> = {}
  const claimedNodes = new Map<THREE.Object3D, string>()
  const lookRoles: CustomPerformanceLookRole[] =
    manifest.contract === SOCKET_CONTRACT
      ? ['head', 'neck']
      : ['head', 'neck', 'leftEye', 'rightEye']
  const lookNodeSpecs = manifest.nodes as Partial<
    Record<CustomPerformanceLookRole, CustomPerformanceLookNode>
  >
  for (const role of lookRoles) {
    const spec = lookNodeSpecs[role]
    if (!spec) {
      addIssue(issues, `rig.performance.nodes.${role}`, 'is required.')
      continue
    }
    const node = resolveUnique(spec.node, `rig.performance.nodes.${role}.node`)
    if (!node) continue
    const prior = claimedNodes.get(node)
    if (prior) {
      addIssue(
        issues,
        `rig.performance.nodes.${role}.node`,
        `duplicates the node already claimed by ${prior}.`
      )
      continue
    }
    claimedNodes.set(node, `nodes.${role}`)
    boundLook[role] = { node, spec }
  }

  const boundTransforms: BoundTargetTransform[] = []
  for (const [role, spec] of Object.entries(manifest.targetTransforms)) {
    const node = resolveUnique(
      spec.node,
      `rig.performance.targetTransforms.${role}.node`
    )
    if (!node) continue
    const prior = claimedNodes.get(node)
    if (prior) {
      addIssue(
        issues,
        `rig.performance.targetTransforms.${role}.node`,
        `duplicates the node already claimed by ${prior}.`
      )
      continue
    }
    claimedNodes.set(node, `targetTransforms.${role}`)
    boundTransforms.push({ node, spec })
  }

  if (issues.length > 0) return { runtime: null, issues }
  return {
    runtime: new CustomPerformanceRigRuntime(
      manifest,
      boundLook,
      boundTransforms
    ),
    issues: []
  }
}
