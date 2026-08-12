import type { ResolvedAppearanceDialState } from './appearanceDials.contracts'
import type { HairAssetV1 } from './hairAssets'
import {
  HAIR_MOTION_DEFAULT_INTENSITY,
  HAIR_MOTION_INTENSITY_MAX,
  HAIR_MOTION_INTENSITY_MIN,
  HAIR_ROOT_WEIGHTED_MOTION_TAG,
  parseHairMotionSettings,
  type HairMotionSettingsV2
} from './hairMotionSettings'
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
  sha256Hex
} from './recipe/recipeCanonical'

export const SECONDARY_MOTION_CONTRACT = 'secondary-motion/v1' as const
export const EMBEDDED_SECONDARY_MOTION_CONTRACT = 'embedded-secondary-motion/v2' as const
export const SECONDARY_MOTION_STRESS_MATRIX_CONTRACT = 'secondary-motion-stress-matrix/v1' as const
export const HAIR_ROOT_WEIGHTED_MOTION_CONTRACT = 'hair-root-weighted-motion/v2' as const
export const HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE = '_batshair_tip' as const
export const HAIR_MOTION_WEIGHT_CURVE = 'root-to-tip-smoothstep/v1' as const
export const HAIR_MOTION_DEFAULT_ANCHORED_LENGTH = 0.5 as const
export const HAIR_MOTION_ANCHORED_LENGTH_MIN = 0.2 as const
export const HAIR_MOTION_ANCHORED_LENGTH_MAX = 0.8 as const
export const SECONDARY_MOTION_MIN_REST_LENGTH_METERS = 0.005 as const
export const SECONDARY_MOTION_MAX_REST_LENGTH_METERS = 2 as const

export {
  HAIR_MOTION_DEFAULT_INTENSITY,
  HAIR_MOTION_INTENSITY_MAX,
  HAIR_MOTION_INTENSITY_MIN,
  HAIR_ROOT_WEIGHTED_MOTION_TAG
} from './hairMotionSettings'

export type HairRootWeightedMotionV2 = {
  contract: typeof HAIR_ROOT_WEIGHTED_MOTION_CONTRACT
  meshNode: string
  tipAttribute: typeof HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE
  dynamicJointSlot: number
  anchoredLength: number
  weightCurve: typeof HAIR_MOTION_WEIGHT_CURVE
  defaultEnabled: boolean
  defaultIntensity: number
}

export type SecondaryMotionTuning = HairMotionSettingsV2

export type SecondaryMotionOwnerKind = 'hair' | 'cloth' | 'cape' | 'tail' | 'soft-body'
export type SecondaryMotionVec3 = [number, number, number]

export type SecondaryMotionOwnerV1 = {
  kind: SecondaryMotionOwnerKind
  assetId: string
  revisionId: string
  geometrySha256: string
  fitFamily: string
  appearanceDefinitionSha256: string
}

export type SecondaryMotionSimulationV1 = {
  fixedStepSeconds: number
  maxSubsteps: number
  interruptionResetSeconds: number
  gravity: SecondaryMotionVec3
  collisionIterations: number
}

export type SecondaryMotionSegmentV1 = {
  node: string
  pivot: SecondaryMotionVec3
  tip: SecondaryMotionVec3
  stiffness: number
  damping: number
  drag: number
  gravityScale: number
  maxAngleRadians: number
  collisionRadius: number
  collisionGroups: string[]
  drivers: SecondaryMotionSegmentDriverV1[]
}

export type SecondaryMotionSegmentDriverV1 =
  | {
      kind: 'dial-endpoint'
      dialId: string
      endpoint: number
      pivotDelta: SecondaryMotionVec3
      tipDelta: SecondaryMotionVec3
    }
  | {
      kind: 'bounded-product'
      terms: Array<{ dialId: string; endpoint: number }>
      maxWeight: number
      pivotDelta: SecondaryMotionVec3
      tipDelta: SecondaryMotionVec3
    }

export type ResolvedSecondaryMotionSegmentV1 = Omit<SecondaryMotionSegmentV1, 'drivers'>

export type SecondaryMotionChainV1 = {
  id: string
  segments: SecondaryMotionSegmentV1[]
}

export type ResolvedSecondaryMotionChainV1 = {
  id: string
  segments: ResolvedSecondaryMotionSegmentV1[]
}

export type SecondaryMotionColliderDriverV1 = {
  dialId: string
  endpoint: number
  offsetDelta: SecondaryMotionVec3
  tailOffsetDelta: SecondaryMotionVec3
  radiusDelta: number
}

export type SecondaryMotionColliderV1 = {
  id: string
  group: string
  shape: 'sphere' | 'capsule'
  node: string
  offset: SecondaryMotionVec3
  tailOffset: SecondaryMotionVec3
  radius: number
  drivers: SecondaryMotionColliderDriverV1[]
}

export type ResolvedSecondaryMotionColliderV1 = Omit<SecondaryMotionColliderV1, 'drivers'>

export type SecondaryMotionStressScenarioId =
  | 'idle'
  | 'head-turn'
  | 'walk-dance'
  | 'bend'
  | 'interruption'

export type SecondaryMotionStressMatrixV1 = {
  contract: typeof SECONDARY_MOTION_STRESS_MATRIX_CONTRACT
  scenarios: Array<{
    id: SecondaryMotionStressScenarioId
    durationSeconds: number
  }>
  thresholds: {
    maximumStretchRatio: number
    maximumColliderPenetration: number
    maximumSettleSeconds: number
  }
}

export type SecondaryMotionDefinitionV1 = {
  contract: typeof SECONDARY_MOTION_CONTRACT
  owner: SecondaryMotionOwnerV1
  chainSpace: 'asset-root-rest'
  colliderSpace: 'node-local-rest'
  simulation: SecondaryMotionSimulationV1
  chains: SecondaryMotionChainV1[]
  colliders: SecondaryMotionColliderV1[]
  stressMatrix: SecondaryMotionStressMatrixV1
}

export type EmbeddedSecondaryMotionV2 = {
  contract: typeof EMBEDDED_SECONDARY_MOTION_CONTRACT
  sourceDefinitionSha256: string
  owner: SecondaryMotionOwnerV1
  chainSpace: 'asset-root-rest'
  colliderSpace: 'node-local-rest'
  simulation: SecondaryMotionSimulationV1
  chains: ResolvedSecondaryMotionChainV1[]
  colliders: ResolvedSecondaryMotionColliderV1[]
  motionSettings: HairMotionSettingsV2 | null
}

export type SecondaryMotionRuntimeDefinition = Omit<
  SecondaryMotionDefinitionV1,
  'contract' | 'stressMatrix' | 'chains' | 'colliders'
> & {
  chains: ResolvedSecondaryMotionChainV1[]
  colliders: ResolvedSecondaryMotionColliderV1[]
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const DECODER = new TextDecoder('utf-8', { fatal: true })

function fail(message: string): never {
  throw new Error(`[${SECONDARY_MOTION_CONTRACT}] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${context} must contain exactly: ${wanted.join(', ')}`)
  }
}

function stableText(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${context} must be a non-empty trimmed string without control characters`)
  }
  return value
}

function stableId(value: unknown, context: string): string {
  const parsed = stableText(value, context)
  if (!STABLE_ID_PATTERN.test(parsed) || FORBIDDEN_KEYS.has(parsed)) {
    fail(`${context} must be a stable id`)
  }
  return parsed
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return Object.is(value, -0) ? 0 : value
}

function positive(value: unknown, context: string): number {
  const parsed = finite(value, context)
  if (parsed <= 0) fail(`${context} must be greater than zero`)
  return parsed
}

function nonNegative(value: unknown, context: string): number {
  const parsed = finite(value, context)
  if (parsed < 0) fail(`${context} must be non-negative`)
  return parsed
}

function integer(value: unknown, context: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${context} must be a safe integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function vec3(value: unknown, context: string): SecondaryMotionVec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    fail(`${context} must contain exactly three numbers`)
  }
  return value.map((entry, index) => finite(entry, `${context}[${index}]`)) as SecondaryMotionVec3
}

function ownerKind(value: unknown, context: string): SecondaryMotionOwnerKind {
  if (
    value !== 'hair' &&
    value !== 'cloth' &&
    value !== 'cape' &&
    value !== 'tail' &&
    value !== 'soft-body'
  ) {
    fail(`${context} is unsupported`)
  }
  return value
}

function parseOwner(value: unknown, context: string): SecondaryMotionOwnerV1 {
  const raw = record(value, context)
  exactKeys(
    raw,
    ['kind', 'assetId', 'revisionId', 'geometrySha256', 'fitFamily', 'appearanceDefinitionSha256'],
    context
  )
  return {
    kind: ownerKind(raw.kind, `${context}.kind`),
    assetId: stableId(raw.assetId, `${context}.assetId`),
    revisionId: stableId(raw.revisionId, `${context}.revisionId`),
    geometrySha256: requireLowercaseSha256(raw.geometrySha256, `${context}.geometrySha256`),
    fitFamily: stableId(raw.fitFamily, `${context}.fitFamily`),
    appearanceDefinitionSha256: requireLowercaseSha256(
      raw.appearanceDefinitionSha256,
      `${context}.appearanceDefinitionSha256`
    )
  }
}

function parseSimulation(value: unknown, context: string): SecondaryMotionSimulationV1 {
  const raw = record(value, context)
  exactKeys(
    raw,
    [
      'fixedStepSeconds',
      'maxSubsteps',
      'interruptionResetSeconds',
      'gravity',
      'collisionIterations'
    ],
    context
  )
  const fixedStepSeconds = positive(raw.fixedStepSeconds, `${context}.fixedStepSeconds`)
  if (fixedStepSeconds < 1 / 240 || fixedStepSeconds > 1 / 30) {
    fail(`${context}.fixedStepSeconds must remain between 1/240 and 1/30 second`)
  }
  const interruptionResetSeconds = positive(
    raw.interruptionResetSeconds,
    `${context}.interruptionResetSeconds`
  )
  if (interruptionResetSeconds < fixedStepSeconds || interruptionResetSeconds > 1) {
    fail(`${context}.interruptionResetSeconds must remain between one fixed step and one second`)
  }
  return {
    fixedStepSeconds,
    maxSubsteps: integer(raw.maxSubsteps, `${context}.maxSubsteps`, 1, 16),
    interruptionResetSeconds,
    gravity: vec3(raw.gravity, `${context}.gravity`),
    collisionIterations: integer(raw.collisionIterations, `${context}.collisionIterations`, 1, 8)
  }
}

function parseGroups(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    fail(`${context} must contain one to 16 group ids`)
  }
  const groups = value.map((entry, index) => stableId(entry, `${context}[${index}]`))
  if (new Set(groups).size !== groups.length) fail(`${context} must be unique`)
  return groups
}

function endpoint(value: unknown, context: string): number {
  const parsed = finite(value, context)
  if (parsed < -1 || parsed > 1 || parsed === 0) {
    fail(`${context} must be a non-zero value between -1 and 1`)
  }
  return parsed
}

function parseSegmentDriver(value: unknown, context: string): SecondaryMotionSegmentDriverV1 {
  const raw = record(value, context)
  if (raw.kind === 'dial-endpoint') {
    exactKeys(raw, ['kind', 'dialId', 'endpoint', 'pivotDelta', 'tipDelta'], context)
    return {
      kind: 'dial-endpoint',
      dialId: stableId(raw.dialId, `${context}.dialId`),
      endpoint: endpoint(raw.endpoint, `${context}.endpoint`),
      pivotDelta: vec3(raw.pivotDelta, `${context}.pivotDelta`),
      tipDelta: vec3(raw.tipDelta, `${context}.tipDelta`)
    }
  }
  if (raw.kind !== 'bounded-product') fail(`${context}.kind is unsupported`)
  exactKeys(raw, ['kind', 'terms', 'maxWeight', 'pivotDelta', 'tipDelta'], context)
  if (!Array.isArray(raw.terms) || raw.terms.length < 2 || raw.terms.length > 4) {
    fail(`${context}.terms must contain two to four terms`)
  }
  const terms = raw.terms.map((entry, index) => {
    const term = record(entry, `${context}.terms[${index}]`)
    exactKeys(term, ['dialId', 'endpoint'], `${context}.terms[${index}]`)
    return {
      dialId: stableId(term.dialId, `${context}.terms[${index}].dialId`),
      endpoint: endpoint(term.endpoint, `${context}.terms[${index}].endpoint`)
    }
  })
  const termKeys = terms.map((term) => `${term.dialId}:${term.endpoint}`)
  if (new Set(termKeys).size !== terms.length) fail(`${context}.terms must be unique`)
  const maxWeight = finite(raw.maxWeight, `${context}.maxWeight`)
  if (maxWeight < 0 || maxWeight > 1) fail(`${context}.maxWeight must be between zero and one`)
  return {
    kind: 'bounded-product',
    terms,
    maxWeight,
    pivotDelta: vec3(raw.pivotDelta, `${context}.pivotDelta`),
    tipDelta: vec3(raw.tipDelta, `${context}.tipDelta`)
  }
}

function parseSegment(
  value: unknown,
  context: string,
  allowDrivers: boolean
): SecondaryMotionSegmentV1 {
  const raw = record(value, context)
  exactKeys(
    raw,
    [
      'node',
      'pivot',
      'tip',
      'stiffness',
      'damping',
      'drag',
      'gravityScale',
      'maxAngleRadians',
      'collisionRadius',
      'collisionGroups',
      ...(allowDrivers ? ['drivers'] : [])
    ],
    context
  )
  const pivot = vec3(raw.pivot, `${context}.pivot`)
  const tip = vec3(raw.tip, `${context}.tip`)
  const length = Math.hypot(tip[0] - pivot[0], tip[1] - pivot[1], tip[2] - pivot[2])
  if (
    length < SECONDARY_MOTION_MIN_REST_LENGTH_METERS ||
    length > SECONDARY_MOTION_MAX_REST_LENGTH_METERS
  ) {
    fail(`${context} rest length must remain between 5 mm and 2 m`)
  }
  const damping = nonNegative(raw.damping, `${context}.damping`)
  const drag = nonNegative(raw.drag, `${context}.drag`)
  const maxAngleRadians = positive(raw.maxAngleRadians, `${context}.maxAngleRadians`)
  if (damping > 100 || drag > 1 || maxAngleRadians > Math.PI) {
    fail(`${context} tuning exceeds the supported deterministic range`)
  }
  const drivers = allowDrivers
    ? (() => {
        if (!Array.isArray(raw.drivers) || raw.drivers.length > 96) {
          fail(`${context}.drivers must contain at most 96 entries`)
        }
        return raw.drivers.map((entry, index) =>
          parseSegmentDriver(entry, `${context}.drivers[${index}]`)
        )
      })()
    : []
  return {
    node: stableText(raw.node, `${context}.node`),
    pivot,
    tip,
    stiffness: positive(raw.stiffness, `${context}.stiffness`),
    damping,
    drag,
    gravityScale: nonNegative(raw.gravityScale, `${context}.gravityScale`),
    maxAngleRadians,
    collisionRadius: positive(raw.collisionRadius, `${context}.collisionRadius`),
    collisionGroups: parseGroups(raw.collisionGroups, `${context}.collisionGroups`),
    drivers
  }
}

function parseChains(
  value: unknown,
  context: string,
  allowDrivers: boolean
): SecondaryMotionChainV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 512) {
    fail(`${context} must contain one to 512 chains`)
  }
  const nodes = new Set<string>()
  const chains = value.map((entry, chainIndex) => {
    const raw = record(entry, `${context}[${chainIndex}]`)
    exactKeys(raw, ['id', 'segments'], `${context}[${chainIndex}]`)
    if (!Array.isArray(raw.segments) || raw.segments.length < 1 || raw.segments.length > 32) {
      fail(`${context}[${chainIndex}].segments must contain one to 32 segments`)
    }
    const segments = raw.segments.map((segment, segmentIndex) => {
      const parsed = parseSegment(
        segment,
        `${context}[${chainIndex}].segments[${segmentIndex}]`,
        allowDrivers
      )
      if (nodes.has(parsed.node))
        fail(`motion node ${parsed.node} is owned by more than one segment`)
      nodes.add(parsed.node)
      return parsed
    })
    return { id: stableId(raw.id, `${context}[${chainIndex}].id`), segments }
  })
  if (new Set(chains.map((entry) => entry.id)).size !== chains.length) {
    fail(`${context} ids must be unique`)
  }
  return chains
}

function parseDriver(value: unknown, context: string): SecondaryMotionColliderDriverV1 {
  const raw = record(value, context)
  exactKeys(raw, ['dialId', 'endpoint', 'offsetDelta', 'tailOffsetDelta', 'radiusDelta'], context)
  const endpoint = finite(raw.endpoint, `${context}.endpoint`)
  if (endpoint < -1 || endpoint > 1 || endpoint === 0) {
    fail(`${context}.endpoint must be a non-zero value between -1 and 1`)
  }
  return {
    dialId: stableId(raw.dialId, `${context}.dialId`),
    endpoint,
    offsetDelta: vec3(raw.offsetDelta, `${context}.offsetDelta`),
    tailOffsetDelta: vec3(raw.tailOffsetDelta, `${context}.tailOffsetDelta`),
    radiusDelta: finite(raw.radiusDelta, `${context}.radiusDelta`)
  }
}

function parseCollider(
  value: unknown,
  context: string,
  allowDrivers: boolean
): SecondaryMotionColliderV1 {
  const raw = record(value, context)
  const expected = ['id', 'group', 'shape', 'node', 'offset', 'tailOffset', 'radius']
  if (allowDrivers) expected.push('drivers')
  exactKeys(raw, expected, context)
  if (raw.shape !== 'sphere' && raw.shape !== 'capsule') fail(`${context}.shape is unsupported`)
  const offset = vec3(raw.offset, `${context}.offset`)
  const tailOffset = vec3(raw.tailOffset, `${context}.tailOffset`)
  if (raw.shape === 'sphere' && tailOffset.some((entry, index) => entry !== offset[index])) {
    fail(`${context}.tailOffset must equal offset for a sphere`)
  }
  const drivers = allowDrivers
    ? (() => {
        if (!Array.isArray(raw.drivers) || raw.drivers.length > 64) {
          fail(`${context}.drivers must contain at most 64 entries`)
        }
        const parsed = raw.drivers.map((entry, index) =>
          parseDriver(entry, `${context}.drivers[${index}]`)
        )
        const keys = parsed.map((entry) => `${entry.dialId}:${entry.endpoint}`)
        if (new Set(keys).size !== keys.length) fail(`${context}.drivers must be unique`)
        return parsed
      })()
    : []
  return {
    id: stableId(raw.id, `${context}.id`),
    group: stableId(raw.group, `${context}.group`),
    shape: raw.shape,
    node: stableText(raw.node, `${context}.node`),
    offset,
    tailOffset,
    radius: positive(raw.radius, `${context}.radius`),
    drivers
  }
}

function parseColliders(
  value: unknown,
  context: string,
  allowDrivers: boolean
): SecondaryMotionColliderV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    fail(`${context} must contain one to 256 colliders`)
  }
  const colliders = value.map((entry, index) =>
    parseCollider(entry, `${context}[${index}]`, allowDrivers)
  )
  if (new Set(colliders.map((entry) => entry.id)).size !== colliders.length) {
    fail(`${context} ids must be unique`)
  }
  return colliders
}

function validateCollisionGroups(
  chains: readonly {
    segments: readonly { node: string; collisionGroups: readonly string[] }[]
  }[],
  colliders: readonly Pick<SecondaryMotionColliderV1, 'group'>[]
): void {
  const groups = new Set(colliders.map((entry) => entry.group))
  for (const chain of chains) {
    for (const segment of chain.segments) {
      for (const group of segment.collisionGroups) {
        if (!groups.has(group))
          fail(`motion segment ${segment.node} references missing collider group ${group}`)
      }
    }
  }
}

function validateOwnerChainIds(
  owner: SecondaryMotionOwnerV1,
  chains: readonly { id: string }[]
): void {
  if (owner.kind === 'hair' && chains.some((chain) => !chain.id.startsWith('Hair_'))) {
    fail('Hair secondary-motion chain ids must use the Hair_ prefix')
  }
}

function parseStressMatrix(value: unknown): SecondaryMotionStressMatrixV1 {
  const raw = record(value, 'definition.stressMatrix')
  exactKeys(raw, ['contract', 'scenarios', 'thresholds'], 'definition.stressMatrix')
  if (raw.contract !== SECONDARY_MOTION_STRESS_MATRIX_CONTRACT) {
    fail(`definition.stressMatrix.contract must equal ${SECONDARY_MOTION_STRESS_MATRIX_CONTRACT}`)
  }
  const required: SecondaryMotionStressScenarioId[] = [
    'idle',
    'head-turn',
    'walk-dance',
    'bend',
    'interruption'
  ]
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length !== required.length) {
    fail('definition.stressMatrix.scenarios must declare the five H5 scenarios')
  }
  const scenarios = raw.scenarios.map((entry, index) => {
    const scenario = record(entry, `definition.stressMatrix.scenarios[${index}]`)
    exactKeys(scenario, ['id', 'durationSeconds'], `definition.stressMatrix.scenarios[${index}]`)
    if (!required.includes(scenario.id as SecondaryMotionStressScenarioId)) {
      fail(`definition.stressMatrix.scenarios[${index}].id is unsupported`)
    }
    return {
      id: scenario.id as SecondaryMotionStressScenarioId,
      durationSeconds: positive(
        scenario.durationSeconds,
        `definition.stressMatrix.scenarios[${index}].durationSeconds`
      )
    }
  })
  if (new Set(scenarios.map((entry) => entry.id)).size !== required.length) {
    fail('definition.stressMatrix.scenarios must declare each H5 scenario exactly once')
  }
  const thresholds = record(raw.thresholds, 'definition.stressMatrix.thresholds')
  exactKeys(
    thresholds,
    ['maximumStretchRatio', 'maximumColliderPenetration', 'maximumSettleSeconds'],
    'definition.stressMatrix.thresholds'
  )
  const maximumStretchRatio = positive(
    thresholds.maximumStretchRatio,
    'definition.stressMatrix.thresholds.maximumStretchRatio'
  )
  if (maximumStretchRatio < 1 || maximumStretchRatio > 1.1) {
    fail('definition.stressMatrix maximum stretch must remain between 1 and 1.1')
  }
  return {
    contract: SECONDARY_MOTION_STRESS_MATRIX_CONTRACT,
    scenarios,
    thresholds: {
      maximumStretchRatio,
      maximumColliderPenetration: nonNegative(
        thresholds.maximumColliderPenetration,
        'definition.stressMatrix.thresholds.maximumColliderPenetration'
      ),
      maximumSettleSeconds: positive(
        thresholds.maximumSettleSeconds,
        'definition.stressMatrix.thresholds.maximumSettleSeconds'
      )
    }
  }
}

export function parseSecondaryMotionDefinition(value: unknown): SecondaryMotionDefinitionV1 {
  canonicalRecipeString(value)
  const raw = record(value, 'definition')
  exactKeys(
    raw,
    [
      'contract',
      'owner',
      'chainSpace',
      'colliderSpace',
      'simulation',
      'chains',
      'colliders',
      'stressMatrix'
    ],
    'definition'
  )
  if (raw.contract !== SECONDARY_MOTION_CONTRACT) {
    fail(`definition.contract must equal ${SECONDARY_MOTION_CONTRACT}`)
  }
  if (raw.chainSpace !== 'asset-root-rest' || raw.colliderSpace !== 'node-local-rest') {
    fail('definition uses an unsupported coordinate-space contract')
  }
  const owner = parseOwner(raw.owner, 'definition.owner')
  const chains = parseChains(raw.chains, 'definition.chains', true)
  const colliders = parseColliders(raw.colliders, 'definition.colliders', true)
  validateOwnerChainIds(owner, chains)
  validateCollisionGroups(chains, colliders)
  return {
    contract: SECONDARY_MOTION_CONTRACT,
    owner,
    chainSpace: 'asset-root-rest',
    colliderSpace: 'node-local-rest',
    simulation: parseSimulation(raw.simulation, 'definition.simulation'),
    chains,
    colliders,
    stressMatrix: parseStressMatrix(raw.stressMatrix)
  }
}

export function parseEmbeddedSecondaryMotion(value: unknown): EmbeddedSecondaryMotionV2 | null {
  if (value === undefined || value === null) return null
  canonicalRecipeString(value)
  const raw = record(value, 'embedded definition')
  exactKeys(
    raw,
    [
      'contract',
      'sourceDefinitionSha256',
      'owner',
      'chainSpace',
      'colliderSpace',
      'simulation',
      'chains',
      'colliders',
      'motionSettings'
    ],
    'embedded definition'
  )
  if (raw.contract !== EMBEDDED_SECONDARY_MOTION_CONTRACT) {
    fail(`embedded definition.contract must equal ${EMBEDDED_SECONDARY_MOTION_CONTRACT}`)
  }
  if (raw.chainSpace !== 'asset-root-rest' || raw.colliderSpace !== 'node-local-rest') {
    fail('embedded definition uses an unsupported coordinate-space contract')
  }
  const owner = parseOwner(raw.owner, 'embedded definition.owner')
  const chains = parseChains(raw.chains, 'embedded definition.chains', false).map((chain) => ({
    id: chain.id,
    segments: chain.segments.map(({ drivers: _drivers, ...segment }) => segment)
  }))
  const colliders = parseColliders(raw.colliders, 'embedded definition.colliders', false).map(
    ({ drivers: _drivers, ...collider }) => collider
  )
  validateOwnerChainIds(owner, chains)
  validateCollisionGroups(chains, colliders)
  return {
    contract: EMBEDDED_SECONDARY_MOTION_CONTRACT,
    sourceDefinitionSha256: requireLowercaseSha256(
      raw.sourceDefinitionSha256,
      'embedded definition.sourceDefinitionSha256'
    ),
    owner,
    chainSpace: 'asset-root-rest',
    colliderSpace: 'node-local-rest',
    simulation: parseSimulation(raw.simulation, 'embedded definition.simulation'),
    chains,
    colliders,
    motionSettings:
      raw.motionSettings === null ? null : parseHairMotionSettings(raw.motionSettings)
  }
}

export async function secondaryMotionDefinitionSha256(value: unknown): Promise<string> {
  return canonicalRecipeSha256(parseSecondaryMotionDefinition(value))
}

function segmentDriverWeight(
  driver: SecondaryMotionSegmentDriverV1,
  values: Record<string, number>
): number {
  if (driver.kind === 'dial-endpoint') {
    const value = values[driver.dialId] ?? 0
    if (!Number.isFinite(value))
      fail(`appearance dial ${driver.dialId} resolved a non-finite segment input`)
    return Math.min(1, Math.max(0, value / driver.endpoint))
  }
  let weight = 1
  for (const term of driver.terms) {
    const value = values[term.dialId] ?? 0
    if (!Number.isFinite(value))
      fail(`appearance dial ${term.dialId} resolved a non-finite segment input`)
    weight *= Math.min(1, Math.max(0, value / term.endpoint))
  }
  return Math.min(driver.maxWeight, weight)
}

export function resolveSecondaryMotionChains(
  definitionValue: SecondaryMotionDefinitionV1,
  state: Pick<ResolvedAppearanceDialState, 'values'>
): ResolvedSecondaryMotionChainV1[] {
  const definition = parseSecondaryMotionDefinition(definitionValue)
  return definition.chains.map((chain) => ({
    id: chain.id,
    segments: chain.segments.map((segment) => {
      const pivot = [...segment.pivot] as SecondaryMotionVec3
      const tip = [...segment.tip] as SecondaryMotionVec3
      for (const driver of segment.drivers) {
        const weight = segmentDriverWeight(driver, state.values)
        for (let component = 0; component < 3; component += 1) {
          pivot[component] += driver.pivotDelta[component]! * weight
          tip[component] += driver.tipDelta[component]! * weight
        }
      }
      if (
        !pivot.every(Number.isFinite) ||
        !tip.every(Number.isFinite) ||
        Math.hypot(tip[0] - pivot[0], tip[1] - pivot[1], tip[2] - pivot[2]) <
          SECONDARY_MOTION_MIN_REST_LENGTH_METERS
      ) {
        fail(`motion segment ${segment.node} resolved an invalid driven rest shape`)
      }
      const { drivers: _drivers, ...resolved } = segment
      return { ...resolved, pivot, tip }
    })
  }))
}

export function resolveSecondaryMotionColliders(
  definitionValue: SecondaryMotionDefinitionV1,
  state: Pick<ResolvedAppearanceDialState, 'values'>
): ResolvedSecondaryMotionColliderV1[] {
  const definition = parseSecondaryMotionDefinition(definitionValue)
  return definition.colliders.map((collider) => {
    const offset = [...collider.offset] as SecondaryMotionVec3
    const tailOffset = [...collider.tailOffset] as SecondaryMotionVec3
    let radius = collider.radius
    for (const driver of collider.drivers) {
      const value = state.values[driver.dialId] ?? 0
      if (!Number.isFinite(value))
        fail(`appearance dial ${driver.dialId} resolved a non-finite collider input`)
      const weight = Math.min(1, Math.max(0, value / driver.endpoint))
      for (let component = 0; component < 3; component += 1) {
        offset[component] += driver.offsetDelta[component]! * weight
        tailOffset[component] += driver.tailOffsetDelta[component]! * weight
      }
      radius += driver.radiusDelta * weight
    }
    if (!Number.isFinite(radius) || radius <= 0) {
      fail(`collider ${collider.id} resolved a non-positive radius`)
    }
    return {
      id: collider.id,
      group: collider.group,
      shape: collider.shape,
      node: collider.node,
      offset,
      tailOffset,
      radius
    }
  })
}

export async function createEmbeddedSecondaryMotion(
  definitionValue: SecondaryMotionDefinitionV1,
  state: Pick<ResolvedAppearanceDialState, 'values'>,
  motionSettings: HairMotionSettingsV2 | null = null
): Promise<EmbeddedSecondaryMotionV2> {
  const definition = parseSecondaryMotionDefinition(definitionValue)
  return {
    contract: EMBEDDED_SECONDARY_MOTION_CONTRACT,
    sourceDefinitionSha256: await secondaryMotionDefinitionSha256(definition),
    owner: definition.owner,
    chainSpace: definition.chainSpace,
    colliderSpace: definition.colliderSpace,
    simulation: definition.simulation,
    chains: resolveSecondaryMotionChains(definition, state),
    colliders: resolveSecondaryMotionColliders(definition, state),
    motionSettings: motionSettings ? parseHairMotionSettings(motionSettings) : null
  }
}

export function runtimeSecondaryMotionDefinition(
  value: EmbeddedSecondaryMotionV2
): SecondaryMotionRuntimeDefinition {
  const embedded = parseEmbeddedSecondaryMotion(value)
  if (!embedded) fail('embedded definition is missing')
  return {
    owner: embedded.owner,
    chainSpace: embedded.chainSpace,
    colliderSpace: embedded.colliderSpace,
    simulation: embedded.simulation,
    chains: embedded.chains,
    colliders: embedded.colliders
  }
}

export async function verifyHairSecondaryMotionDefinitionBytes(
  asset: HairAssetV1,
  bytes: Uint8Array
): Promise<SecondaryMotionDefinitionV1> {
  if (
    asset.physics.mode !== 'secondary-motion/v1' ||
    !asset.physics.asset ||
    !asset.physics.definitionSha256
  ) {
    fail('Hair Asset does not declare production secondary motion')
  }
  if (
    !ArrayBuffer.isView(bytes) ||
    !('BYTES_PER_ELEMENT' in bytes) ||
    bytes.BYTES_PER_ELEMENT !== 1 ||
    bytes.byteLength !== asset.physics.asset.bytes
  ) {
    fail('secondary-motion bytes do not match the immutable file receipt')
  }
  if ((await sha256Hex(bytes)) !== asset.physics.asset.sha256) {
    fail('secondary-motion bytes do not match the immutable SHA-256 receipt')
  }
  let decoded: string
  let raw: unknown
  try {
    decoded = DECODER.decode(bytes)
    raw = JSON.parse(decoded)
  } catch (error) {
    fail(`secondary-motion JSON is invalid: ${String(error)}`)
  }
  const definition = parseSecondaryMotionDefinition(raw)
  if (decoded !== `${canonicalRecipeString(definition)}\n`) {
    fail('secondary-motion JSON bytes are not the canonical newline-terminated representation')
  }
  if ((await secondaryMotionDefinitionSha256(definition)) !== asset.physics.definitionSha256) {
    fail('secondary-motion definition hash does not match the Hair Asset declaration')
  }
  if (
    definition.owner.kind !== 'hair' ||
    definition.owner.assetId !== asset.assetId ||
    definition.owner.revisionId !== asset.revisionId ||
    definition.owner.geometrySha256 !== asset.geometry.main.sha256 ||
    definition.owner.fitFamily !== asset.compatibility.fitFamily ||
    definition.owner.appearanceDefinitionSha256 !==
      asset.attachment.fitReceipt.appearanceDefinitionSha256
  ) {
    fail(
      'secondary-motion definition is bound to a different Hair revision or Goon appearance contract'
    )
  }
  return definition
}
