import type { ResolvedAppearanceDialState } from './appearanceDials.contracts'
import type { HairAssetV1 } from './hairAssets'
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
  sha256Hex
} from './recipe/recipeCanonical'

export const HAIR_APPEARANCE_FOLLOWER_CONTRACT = 'hair-appearance-followers/v1' as const
export const HAIR_SCALP_CAGE_CONTRACT = 'hair-scalp-cage/v1' as const
export const HAIR_FOLLOWER_RISK_MATRIX_CONTRACT = 'hair-follower-risk-matrix/v1' as const

export type HairFollowerFalloffProfileId = 'global-head' | 'scalp-shape' | 'local-clearance'

export type HairFollowerMorphDriverV1 = {
  kind: 'dial-endpoint'
  dialId: string
  endpoint: number
}

export type HairFollowerCorrectiveActivationV1 = {
  kind: 'bounded-product'
  terms: Array<{
    dialId: string
    endpoint: number
  }>
  maxWeight: number
}

export type HairFollowerDefinitionV1 = {
  contract: typeof HAIR_APPEARANCE_FOLLOWER_CONTRACT
  appearanceFollowerContract: 'appearance-followers/v2'
  assetId: string
  revisionId: string
  geometrySha256: string
  fitFamily: string
  appearanceDefinitionSha256: string
  headNode: string
  sourceBodyNode: string
  scalpCage: {
    contract: typeof HAIR_SCALP_CAGE_CONTRACT
    space: 'avatar-root-rest'
    rootBounds: {
      minimum: [number, number, number]
      maximum: [number, number, number]
    }
    transferBounds: {
      minimum: [number, number, number]
      maximum: [number, number, number]
    }
    nearestNeighbors: 4
    rootSeedFraction: number
    topology: 'triangle-geodesic/v1'
  }
  falloffProfiles: Array<{
    id: HairFollowerFalloffProfileId
    curve: 'smoothstep-root-to-tip/v1'
    tipWeight: number
  }>
  morphTargets: Array<{
    name: string
    driver: HairFollowerMorphDriverV1
    falloffProfile: HairFollowerFalloffProfileId
  }>
  correctives: Array<{
    name: string
    activation: HairFollowerCorrectiveActivationV1
  }>
  riskMatrix: {
    contract: typeof HAIR_FOLLOWER_RISK_MATRIX_CONTRACT
    scenarios: Array<{
      id: string
      values: Record<string, number>
    }>
    thresholds: {
      maximumRootGapChange: number
      maximumClearanceLoss: number
      structuralEdgeMinimumLength: number
      minimumAbsoluteStretch: number
      maximumTipEdgeStretchRatio: number
      minimumSilhouetteDimensionRatio: number
      maximumSilhouetteDimensionRatio: number
    }
  }
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MORPH_NAME_PATTERN = /^HairFollower_[A-Za-z0-9_]+$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const DECODER = new TextDecoder('utf-8', { fatal: true })

function fail(message: string): never {
  throw new Error(`[${HAIR_APPEARANCE_FOLLOWER_CONTRACT}] ${message}`)
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
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be finite`)
  }
  return Object.is(value, -0) ? 0 : value
}

function unit(value: unknown, context: string): number {
  const parsed = finite(value, context)
  if (parsed < 0 || parsed > 1) fail(`${context} must be between 0 and 1`)
  return parsed
}

function positive(value: unknown, context: string): number {
  const parsed = finite(value, context)
  if (parsed <= 0) fail(`${context} must be greater than zero`)
  return parsed
}

function vec3(value: unknown, context: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    fail(`${context} must contain exactly three numbers`)
  }
  return value.map((entry, index) => finite(entry, `${context}[${index}]`)) as [
    number,
    number,
    number
  ]
}

function parseFalloffProfileId(value: unknown, context: string): HairFollowerFalloffProfileId {
  if (value !== 'global-head' && value !== 'scalp-shape' && value !== 'local-clearance') {
    fail(`${context} is unsupported`)
  }
  return value
}

function parseDriver(value: unknown, context: string): HairFollowerMorphDriverV1 {
  const raw = record(value, context)
  exactKeys(raw, ['kind', 'dialId', 'endpoint'], context)
  if (raw.kind !== 'dial-endpoint') fail(`${context}.kind is unsupported`)
  const endpoint = finite(raw.endpoint, `${context}.endpoint`)
  if (endpoint < -1 || endpoint > 1 || endpoint === 0) {
    fail(`${context}.endpoint must be a non-zero value between -1 and 1`)
  }
  return {
    kind: 'dial-endpoint',
    dialId: stableId(raw.dialId, `${context}.dialId`),
    endpoint
  }
}

function parseCorrectiveActivation(
  value: unknown,
  context: string
): HairFollowerCorrectiveActivationV1 {
  const raw = record(value, context)
  exactKeys(raw, ['kind', 'terms', 'maxWeight'], context)
  if (raw.kind !== 'bounded-product') fail(`${context}.kind is unsupported`)
  if (!Array.isArray(raw.terms) || raw.terms.length < 2 || raw.terms.length > 4) {
    fail(`${context}.terms must contain two to four dial terms`)
  }
  const terms = raw.terms.map((entry, index) => {
    const term = record(entry, `${context}.terms[${index}]`)
    exactKeys(term, ['dialId', 'endpoint'], `${context}.terms[${index}]`)
    const endpoint = finite(term.endpoint, `${context}.terms[${index}].endpoint`)
    if (endpoint < -1 || endpoint > 1 || endpoint === 0) {
      fail(`${context}.terms[${index}].endpoint must be a non-zero value between -1 and 1`)
    }
    return {
      dialId: stableId(term.dialId, `${context}.terms[${index}].dialId`),
      endpoint
    }
  })
  const keys = terms.map((term) => `${term.dialId}:${term.endpoint}`)
  if (new Set(keys).size !== keys.length) fail(`${context}.terms must be unique`)
  return {
    kind: 'bounded-product',
    terms,
    maxWeight: unit(raw.maxWeight, `${context}.maxWeight`)
  }
}

function parseScenarioValues(value: unknown, context: string): Record<string, number> {
  const raw = record(value, context)
  const values: Record<string, number> = Object.create(null)
  const entries = Object.entries(raw)
  if (entries.length === 0 || entries.length > 12) {
    fail(`${context} must contain one to twelve dial values`)
  }
  for (const [key, entry] of entries) {
    const dialId = stableId(key, `${context} key`)
    const parsed = finite(entry, `${context}.${dialId}`)
    if (parsed < -1 || parsed > 1 || parsed === 0) {
      fail(`${context}.${dialId} must be a non-zero value between -1 and 1`)
    }
    values[dialId] = parsed
  }
  return values
}

export function parseHairFollowerDefinition(value: unknown): HairFollowerDefinitionV1 {
  canonicalRecipeString(value)
  const raw = record(value, 'definition')
  exactKeys(
    raw,
    [
      'contract',
      'appearanceFollowerContract',
      'assetId',
      'revisionId',
      'geometrySha256',
      'fitFamily',
      'appearanceDefinitionSha256',
      'headNode',
      'sourceBodyNode',
      'scalpCage',
      'falloffProfiles',
      'morphTargets',
      'correctives',
      'riskMatrix'
    ],
    'definition'
  )
  if (raw.contract !== HAIR_APPEARANCE_FOLLOWER_CONTRACT) {
    fail(`definition.contract must equal ${HAIR_APPEARANCE_FOLLOWER_CONTRACT}`)
  }
  if (raw.appearanceFollowerContract !== 'appearance-followers/v2') {
    fail('definition must reuse appearance-followers/v2')
  }

  const scalpCage = record(raw.scalpCage, 'definition.scalpCage')
  exactKeys(
    scalpCage,
    [
      'contract',
      'space',
      'rootBounds',
      'transferBounds',
      'nearestNeighbors',
      'rootSeedFraction',
      'topology'
    ],
    'definition.scalpCage'
  )
  if (
    scalpCage.contract !== HAIR_SCALP_CAGE_CONTRACT ||
    scalpCage.space !== 'avatar-root-rest' ||
    scalpCage.nearestNeighbors !== 4 ||
    scalpCage.topology !== 'triangle-geodesic/v1'
  ) {
    fail('definition.scalpCage does not match the H4 canonical cage contract')
  }
  const parseBounds = (value: unknown, context: string) => {
    const bounds = record(value, context)
    exactKeys(bounds, ['minimum', 'maximum'], context)
    const minimum = vec3(bounds.minimum, `${context}.minimum`)
    const maximum = vec3(bounds.maximum, `${context}.maximum`)
    if (minimum.some((entry, index) => entry >= maximum[index]!)) {
      fail(`${context} must have positive dimensions`)
    }
    return { minimum, maximum }
  }
  const rootBounds = parseBounds(scalpCage.rootBounds, 'definition.scalpCage.rootBounds')
  const transferBounds = parseBounds(
    scalpCage.transferBounds,
    'definition.scalpCage.transferBounds'
  )
  const rootSeedFraction = unit(scalpCage.rootSeedFraction, 'definition.scalpCage.rootSeedFraction')
  if (rootSeedFraction < 0.01 || rootSeedFraction > 0.25) {
    fail('definition.scalpCage.rootSeedFraction must remain between 0.01 and 0.25')
  }

  if (!Array.isArray(raw.falloffProfiles) || raw.falloffProfiles.length !== 3) {
    fail('definition.falloffProfiles must declare the three H4 profiles')
  }
  const falloffProfiles = raw.falloffProfiles.map((entry, index) => {
    const profile = record(entry, `definition.falloffProfiles[${index}]`)
    exactKeys(profile, ['id', 'curve', 'tipWeight'], `definition.falloffProfiles[${index}]`)
    if (profile.curve !== 'smoothstep-root-to-tip/v1') {
      fail(`definition.falloffProfiles[${index}].curve is unsupported`)
    }
    return {
      id: parseFalloffProfileId(profile.id, `definition.falloffProfiles[${index}].id`),
      curve: 'smoothstep-root-to-tip/v1' as const,
      tipWeight: unit(profile.tipWeight, `definition.falloffProfiles[${index}].tipWeight`)
    }
  })
  const profileIds = falloffProfiles.map((entry) => entry.id)
  if (
    new Set(profileIds).size !== 3 ||
    !['global-head', 'scalp-shape', 'local-clearance'].every((id) =>
      profileIds.includes(id as HairFollowerFalloffProfileId)
    )
  ) {
    fail('definition.falloffProfiles must declare each H4 profile exactly once')
  }

  if (
    !Array.isArray(raw.morphTargets) ||
    raw.morphTargets.length < 2 ||
    raw.morphTargets.length > 96
  ) {
    fail('definition.morphTargets must contain two to 96 targets')
  }
  const morphTargets = raw.morphTargets.map((entry, index) => {
    const target = record(entry, `definition.morphTargets[${index}]`)
    exactKeys(target, ['name', 'driver', 'falloffProfile'], `definition.morphTargets[${index}]`)
    const name = stableText(target.name, `definition.morphTargets[${index}].name`)
    if (!MORPH_NAME_PATTERN.test(name)) {
      fail(`definition.morphTargets[${index}].name is not a Hair follower morph name`)
    }
    return {
      name,
      driver: parseDriver(target.driver, `definition.morphTargets[${index}].driver`),
      falloffProfile: parseFalloffProfileId(
        target.falloffProfile,
        `definition.morphTargets[${index}].falloffProfile`
      )
    }
  })
  const morphNames = morphTargets.map((entry) => entry.name)
  const driverKeys = morphTargets.map((entry) => `${entry.driver.dialId}:${entry.driver.endpoint}`)
  if (new Set(morphNames).size !== morphNames.length) {
    fail('definition.morphTargets names must be unique')
  }
  if (new Set(driverKeys).size !== driverKeys.length) {
    fail('definition.morphTargets drivers must be unique')
  }
  const headSizeEndpoints = new Set(
    morphTargets
      .filter((entry) => entry.driver.dialId === 'head_size')
      .map((entry) => entry.driver.endpoint)
  )
  if (!headSizeEndpoints.has(-1) || !headSizeEndpoints.has(1)) {
    fail('definition.morphTargets must include both global Head Size endpoints')
  }

  if (!Array.isArray(raw.correctives) || raw.correctives.length > 16) {
    fail('definition.correctives must contain at most 16 bounded correctives')
  }
  const correctives = raw.correctives.map((entry, index) => {
    const corrective = record(entry, `definition.correctives[${index}]`)
    exactKeys(corrective, ['name', 'activation'], `definition.correctives[${index}]`)
    const name = stableText(corrective.name, `definition.correctives[${index}].name`)
    if (!MORPH_NAME_PATTERN.test(name)) {
      fail(`definition.correctives[${index}].name is not a Hair follower morph name`)
    }
    return {
      name,
      activation: parseCorrectiveActivation(
        corrective.activation,
        `definition.correctives[${index}].activation`
      )
    }
  })
  const correctiveNames = correctives.map((entry) => entry.name)
  if (new Set(correctiveNames).size !== correctiveNames.length) {
    fail('definition.correctives names must be unique')
  }
  if (correctiveNames.some((name) => morphNames.includes(name))) {
    fail('definition corrective and driver morph names must not collide')
  }

  const riskMatrix = record(raw.riskMatrix, 'definition.riskMatrix')
  exactKeys(riskMatrix, ['contract', 'scenarios', 'thresholds'], 'definition.riskMatrix')
  if (riskMatrix.contract !== HAIR_FOLLOWER_RISK_MATRIX_CONTRACT) {
    fail(`definition.riskMatrix.contract must equal ${HAIR_FOLLOWER_RISK_MATRIX_CONTRACT}`)
  }
  if (
    !Array.isArray(riskMatrix.scenarios) ||
    riskMatrix.scenarios.length < 8 ||
    riskMatrix.scenarios.length > 96
  ) {
    fail('definition.riskMatrix.scenarios must contain eight to 96 scenarios')
  }
  const scenarios = riskMatrix.scenarios.map((entry, index) => {
    const scenario = record(entry, `definition.riskMatrix.scenarios[${index}]`)
    exactKeys(scenario, ['id', 'values'], `definition.riskMatrix.scenarios[${index}]`)
    return {
      id: stableId(scenario.id, `definition.riskMatrix.scenarios[${index}].id`),
      values: parseScenarioValues(
        scenario.values,
        `definition.riskMatrix.scenarios[${index}].values`
      )
    }
  })
  if (new Set(scenarios.map((entry) => entry.id)).size !== scenarios.length) {
    fail('definition.riskMatrix scenario ids must be unique')
  }
  const thresholds = record(riskMatrix.thresholds, 'definition.riskMatrix.thresholds')
  exactKeys(
    thresholds,
    [
      'maximumRootGapChange',
      'maximumClearanceLoss',
      'structuralEdgeMinimumLength',
      'minimumAbsoluteStretch',
      'maximumTipEdgeStretchRatio',
      'minimumSilhouetteDimensionRatio',
      'maximumSilhouetteDimensionRatio'
    ],
    'definition.riskMatrix.thresholds'
  )
  const minimumSilhouetteDimensionRatio = positive(
    thresholds.minimumSilhouetteDimensionRatio,
    'definition.riskMatrix.thresholds.minimumSilhouetteDimensionRatio'
  )
  const maximumSilhouetteDimensionRatio = positive(
    thresholds.maximumSilhouetteDimensionRatio,
    'definition.riskMatrix.thresholds.maximumSilhouetteDimensionRatio'
  )
  if (
    minimumSilhouetteDimensionRatio >= 1 ||
    maximumSilhouetteDimensionRatio <= 1 ||
    minimumSilhouetteDimensionRatio >= maximumSilhouetteDimensionRatio
  ) {
    fail('definition.riskMatrix silhouette thresholds must bracket the neutral silhouette')
  }

  return {
    contract: HAIR_APPEARANCE_FOLLOWER_CONTRACT,
    appearanceFollowerContract: 'appearance-followers/v2',
    assetId: stableId(raw.assetId, 'definition.assetId'),
    revisionId: stableId(raw.revisionId, 'definition.revisionId'),
    geometrySha256: requireLowercaseSha256(raw.geometrySha256, 'definition.geometrySha256'),
    fitFamily: stableId(raw.fitFamily, 'definition.fitFamily'),
    appearanceDefinitionSha256: requireLowercaseSha256(
      raw.appearanceDefinitionSha256,
      'definition.appearanceDefinitionSha256'
    ),
    headNode: stableText(raw.headNode, 'definition.headNode'),
    sourceBodyNode: stableText(raw.sourceBodyNode, 'definition.sourceBodyNode'),
    scalpCage: {
      contract: HAIR_SCALP_CAGE_CONTRACT,
      space: 'avatar-root-rest',
      rootBounds,
      transferBounds,
      nearestNeighbors: 4,
      rootSeedFraction,
      topology: 'triangle-geodesic/v1'
    },
    falloffProfiles,
    morphTargets,
    correctives,
    riskMatrix: {
      contract: HAIR_FOLLOWER_RISK_MATRIX_CONTRACT,
      scenarios,
      thresholds: {
        maximumRootGapChange: positive(
          thresholds.maximumRootGapChange,
          'definition.riskMatrix.thresholds.maximumRootGapChange'
        ),
        maximumClearanceLoss: positive(
          thresholds.maximumClearanceLoss,
          'definition.riskMatrix.thresholds.maximumClearanceLoss'
        ),
        structuralEdgeMinimumLength: positive(
          thresholds.structuralEdgeMinimumLength,
          'definition.riskMatrix.thresholds.structuralEdgeMinimumLength'
        ),
        minimumAbsoluteStretch: positive(
          thresholds.minimumAbsoluteStretch,
          'definition.riskMatrix.thresholds.minimumAbsoluteStretch'
        ),
        maximumTipEdgeStretchRatio: positive(
          thresholds.maximumTipEdgeStretchRatio,
          'definition.riskMatrix.thresholds.maximumTipEdgeStretchRatio'
        ),
        minimumSilhouetteDimensionRatio,
        maximumSilhouetteDimensionRatio
      }
    }
  }
}

export async function hairFollowerDefinitionSha256(value: unknown): Promise<string> {
  return canonicalRecipeSha256(parseHairFollowerDefinition(value))
}

export async function verifyHairFollowerDefinitionBytes(
  asset: HairAssetV1,
  bytes: Uint8Array
): Promise<HairFollowerDefinitionV1> {
  if (
    asset.follower.mode !== 'appearance-followers/v2' ||
    !asset.follower.asset ||
    !asset.follower.definitionSha256
  ) {
    fail('Hair Asset does not declare a production appearance follower')
  }
  if (
    !ArrayBuffer.isView(bytes) ||
    !('BYTES_PER_ELEMENT' in bytes) ||
    bytes.BYTES_PER_ELEMENT !== 1 ||
    bytes.byteLength !== asset.follower.asset.bytes
  ) {
    fail('follower bytes do not match the immutable file receipt')
  }
  const byteSha256 = await sha256Hex(bytes)
  if (byteSha256 !== asset.follower.asset.sha256) {
    fail('follower bytes do not match the immutable SHA-256 receipt')
  }
  let decoded: string
  let raw: unknown
  try {
    decoded = DECODER.decode(bytes)
    raw = JSON.parse(decoded)
  } catch (error) {
    fail(`follower JSON is invalid: ${String(error)}`)
  }
  const definition = parseHairFollowerDefinition(raw)
  if (decoded !== `${canonicalRecipeString(definition)}\n`) {
    fail('follower JSON bytes are not the canonical newline-terminated representation')
  }
  const definitionSha256 = await hairFollowerDefinitionSha256(definition)
  if (definitionSha256 !== asset.follower.definitionSha256) {
    fail('follower definition hash does not match the Hair Asset declaration')
  }
  if (
    definition.assetId !== asset.assetId ||
    definition.revisionId !== asset.revisionId ||
    definition.geometrySha256 !== asset.geometry.main.sha256 ||
    definition.fitFamily !== asset.compatibility.fitFamily ||
    definition.appearanceDefinitionSha256 !==
      asset.attachment.fitReceipt.appearanceDefinitionSha256 ||
    definition.headNode !== asset.attachment.headNode
  ) {
    fail('follower definition is bound to a different Hair revision or Goon head contract')
  }
  return definition
}

export function resolveHairFollowerWeights(
  definitionValue: HairFollowerDefinitionV1,
  state: Pick<ResolvedAppearanceDialState, 'values'>
): Map<string, number> {
  const definition = parseHairFollowerDefinition(definitionValue)
  const weights = new Map<string, number>()
  for (const target of definition.morphTargets) {
    const value = state.values[target.driver.dialId] ?? 0
    if (!Number.isFinite(value)) {
      fail(`appearance dial ${target.driver.dialId} resolved a non-finite Hair follower input`)
    }
    const directed = value / target.driver.endpoint
    weights.set(target.name, Math.min(1, Math.max(0, directed)))
  }
  for (const corrective of definition.correctives) {
    let weight = 1
    for (const term of corrective.activation.terms) {
      const value = state.values[term.dialId] ?? 0
      if (!Number.isFinite(value)) {
        fail(`appearance dial ${term.dialId} resolved a non-finite Hair corrective input`)
      }
      weight *= Math.min(1, Math.max(0, value / term.endpoint))
    }
    weights.set(corrective.name, Math.min(corrective.activation.maxWeight, weight))
  }
  return weights
}

export function hairFollowerMorphNames(definitionValue: HairFollowerDefinitionV1): string[] {
  const definition = parseHairFollowerDefinition(definitionValue)
  return [
    ...definition.morphTargets.map((entry) => entry.name),
    ...definition.correctives.map((entry) => entry.name)
  ]
}
