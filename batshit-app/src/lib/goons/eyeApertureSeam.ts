import type {
  SocketEyeSide,
  SocketEyeSurfaceDefinitionV2
} from './socketEyeSurface'

export const EYE_APERTURE_SEAM_SCHEMA_VERSION = 'eye-aperture-seam/v2' as const
export const SOCKET_EYE_TREATMENT_FOLLOWER_MORPH_COUNT = 84

export type EyeTreatmentSurfaceCorrectionV1 = {
  contract: 'head-projection-blink-surface-correction/v1'
  projectionMorph: string
  blinkLinearMorph: string
  blinkResidualMorph: string
  blinkMorph: string
  projectionWeightLaw: 'appearance-follower-weight'
  blinkLinearWeightLaw: 'blink-times-projection'
  blinkResidualWeightLaw: 'four-blink-one-minus-blink-times-projection'
}

export type EyeApertureBoundaryDefinition = {
  sampleCount: number
  bindingSha256: string
}

export type EyeApertureSeamSideDefinitionV2 = {
  side: SocketEyeSide
  sourceBodyNode: string
  physicalEyeNode: string
  lashesEyeOutlineNode: string
  upperBoundary: EyeApertureBoundaryDefinition
  lowerBoundary: EyeApertureBoundaryDefinition
  innerCanthusVertexIndex: number
  outerCanthusVertexIndex: number
  treatment: {
    geometryLaw: 'animated-upper-lower-thin-surface/v1'
    upperMaterialName: string
    lowerMaterialName: string
    appearanceFollowerContract: 'appearance-followers/v2'
    followerInventorySha256: string
    followerMorphs: string[]
    retainedPerformanceMorphs: string[]
    surfaceCorrection: EyeTreatmentSurfaceCorrectionV1
    doubleSided: true
    ordinaryDepthTest: true
    depthWrite: false
    renderOrder: 'after-physical-eye'
  }
}

export type EyeApertureSeamDefinitionV2 = {
  schemaVersion: typeof EYE_APERTURE_SEAM_SCHEMA_VERSION
  definitionSha256: string
  status: 'product-export-approved'
  productExportApproved: true
  sharedCanthusRoots: true
  blinkClosure: {
    composition: 'authored-independent/v2'
    fullBlinkSquintFloor: 0
  }
  runtimeBindings: {
    left: EyeApertureSeamSideDefinitionV2
    right: EyeApertureSeamSideDefinitionV2
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/

function fail(message: string): never {
  throw new Error(`[${EYE_APERTURE_SEAM_SCHEMA_VERSION}] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  context: string
) {
  const accepted = new Set(allowed)
  const extra = Object.keys(source).filter((key) => !accepted.has(key))
  if (extra.length > 0) fail(`${context} contains unsupported fields: ${extra.join(', ')}`)
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function sha256(value: unknown, context: string): string {
  const parsed = stringValue(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${context} must be a non-negative integer`)
  }
  return value
}

function sampleCount(value: unknown, context: string): number {
  const parsed = nonNegativeInteger(value, context)
  if (parsed < 4) fail(`${context} must contain at least four ordered samples`)
  return parsed
}

function literal<T extends boolean | number | string>(value: unknown, expected: T, context: string): T {
  if (value !== expected) fail(`${context} must be ${expected}`)
  return expected
}

function parseBoundary(value: unknown, context: string): EyeApertureBoundaryDefinition {
  const source = record(value, context)
  rejectUnknownKeys(source, ['sampleCount', 'bindingSha256'], context)
  return {
    sampleCount: sampleCount(source.sampleCount, `${context}.sampleCount`),
    bindingSha256: sha256(source.bindingSha256, `${context}.bindingSha256`)
  }
}

function requiredTreatmentEyeMorphs(side: SocketEyeSide): string[] {
  const suffix = side === 'left' ? 'Left' : 'Right'
  return [
    `eyeBlink${suffix}`,
    `eyeLookDown${suffix}`,
    `eyeLookIn${suffix}`,
    `eyeLookOut${suffix}`,
    `eyeLookUp${suffix}`,
    `eyeSquint${suffix}`,
    `eyeWide${suffix}`
  ]
}

function sortedUniqueMorphs(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${context} must be a non-empty array`)
  const parsed = value.map((entry, index) => stringValue(entry, `${context}[${index}]`))
  if (new Set(parsed).size !== parsed.length) fail(`${context} must not contain duplicates`)
  const sorted = [...parsed].sort()
  if (parsed.some((entry, index) => entry !== sorted[index])) fail(`${context} must be sorted`)
  return parsed
}

function followerMorphs(value: unknown, context: string): string[] {
  const parsed = sortedUniqueMorphs(value, context)
  if (parsed.length !== SOCKET_EYE_TREATMENT_FOLLOWER_MORPH_COUNT) {
    fail(`${context} must contain exactly ${SOCKET_EYE_TREATMENT_FOLLOWER_MORPH_COUNT} morphs`)
  }
  return parsed
}

function retainedPerformanceMorphs(value: unknown, side: SocketEyeSide, context: string): string[] {
  const parsed = sortedUniqueMorphs(value, context)
  for (const required of requiredTreatmentEyeMorphs(side)) {
    if (!parsed.includes(required)) fail(`${context} must include ${required}`)
  }
  return parsed
}

function parseSurfaceCorrection(
  value: unknown,
  side: SocketEyeSide,
  followerNames: readonly string[],
  retainedNames: readonly string[],
  context: string
): EyeTreatmentSurfaceCorrectionV1 {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    [
      'contract',
      'projectionMorph',
      'blinkLinearMorph',
      'blinkResidualMorph',
      'blinkMorph',
      'projectionWeightLaw',
      'blinkLinearWeightLaw',
      'blinkResidualWeightLaw'
    ],
    context
  )
  const parsed: EyeTreatmentSurfaceCorrectionV1 = {
    contract: literal(
      source.contract,
      'head-projection-blink-surface-correction/v1',
      `${context}.contract`
    ),
    projectionMorph: stringValue(source.projectionMorph, `${context}.projectionMorph`),
    blinkLinearMorph: stringValue(source.blinkLinearMorph, `${context}.blinkLinearMorph`),
    blinkResidualMorph: stringValue(source.blinkResidualMorph, `${context}.blinkResidualMorph`),
    blinkMorph: literal(
      source.blinkMorph,
      `eyeBlink${side === 'left' ? 'Left' : 'Right'}`,
      `${context}.blinkMorph`
    ),
    projectionWeightLaw: literal(
      source.projectionWeightLaw,
      'appearance-follower-weight',
      `${context}.projectionWeightLaw`
    ),
    blinkLinearWeightLaw: literal(
      source.blinkLinearWeightLaw,
      'blink-times-projection',
      `${context}.blinkLinearWeightLaw`
    ),
    blinkResidualWeightLaw: literal(
      source.blinkResidualWeightLaw,
      'four-blink-one-minus-blink-times-projection',
      `${context}.blinkResidualWeightLaw`
    )
  }
  const correctionMorphs = [
    parsed.projectionMorph,
    parsed.blinkLinearMorph,
    parsed.blinkResidualMorph
  ]
  if (new Set(correctionMorphs).size !== correctionMorphs.length) {
    fail(`${context} correction morph identities must differ`)
  }
  if (correctionMorphs.some((name) => followerNames.includes(name))) {
    fail(`${context} correction morphs must be separate from the 84 geometry followers`)
  }
  if (!retainedNames.includes(parsed.blinkMorph)) {
    fail(`${context}.blinkMorph must be retained for Live performance`)
  }
  return parsed
}

function parseSide(
  value: unknown,
  expectedSide: SocketEyeSide,
  context: string
): EyeApertureSeamSideDefinitionV2 {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    [
      'side',
      'sourceBodyNode',
      'physicalEyeNode',
      'lashesEyeOutlineNode',
      'upperBoundary',
      'lowerBoundary',
      'innerCanthusVertexIndex',
      'outerCanthusVertexIndex',
      'treatment'
    ],
    context
  )
  if (source.side !== expectedSide) fail(`${context}.side must be ${expectedSide}`)
  const treatment = record(source.treatment, `${context}.treatment`)
  rejectUnknownKeys(
    treatment,
    [
      'geometryLaw',
      'upperMaterialName',
      'lowerMaterialName',
      'appearanceFollowerContract',
      'followerInventorySha256',
      'followerMorphs',
      'retainedPerformanceMorphs',
      'surfaceCorrection',
      'doubleSided',
      'ordinaryDepthTest',
      'depthWrite',
      'renderOrder'
    ],
    `${context}.treatment`
  )
  const upperMaterialName = stringValue(
    treatment.upperMaterialName,
    `${context}.treatment.upperMaterialName`
  )
  const lowerMaterialName = stringValue(
    treatment.lowerMaterialName,
    `${context}.treatment.lowerMaterialName`
  )
  if (upperMaterialName === lowerMaterialName) {
    fail(`${context}.treatment upper and lower material identities must differ`)
  }
  const parsedFollowerMorphs = followerMorphs(
    treatment.followerMorphs,
    `${context}.treatment.followerMorphs`
  )
  const parsedRetainedPerformanceMorphs = retainedPerformanceMorphs(
    treatment.retainedPerformanceMorphs,
    expectedSide,
    `${context}.treatment.retainedPerformanceMorphs`
  )
  if (parsedRetainedPerformanceMorphs.some((name) => !parsedFollowerMorphs.includes(name))) {
    fail(`${context}.treatment retained performance morphs must be a subset of followerMorphs`)
  }
  const parsed: EyeApertureSeamSideDefinitionV2 = {
    side: expectedSide,
    sourceBodyNode: stringValue(source.sourceBodyNode, `${context}.sourceBodyNode`),
    physicalEyeNode: stringValue(source.physicalEyeNode, `${context}.physicalEyeNode`),
    lashesEyeOutlineNode: stringValue(
      source.lashesEyeOutlineNode,
      `${context}.lashesEyeOutlineNode`
    ),
    upperBoundary: parseBoundary(source.upperBoundary, `${context}.upperBoundary`),
    lowerBoundary: parseBoundary(source.lowerBoundary, `${context}.lowerBoundary`),
    innerCanthusVertexIndex: nonNegativeInteger(
      source.innerCanthusVertexIndex,
      `${context}.innerCanthusVertexIndex`
    ),
    outerCanthusVertexIndex: nonNegativeInteger(
      source.outerCanthusVertexIndex,
      `${context}.outerCanthusVertexIndex`
    ),
    treatment: {
      geometryLaw: literal(
        treatment.geometryLaw,
        'animated-upper-lower-thin-surface/v1',
        `${context}.treatment.geometryLaw`
      ),
      upperMaterialName,
      lowerMaterialName,
      appearanceFollowerContract: literal(
        treatment.appearanceFollowerContract,
        'appearance-followers/v2',
        `${context}.treatment.appearanceFollowerContract`
      ),
      followerInventorySha256: sha256(
        treatment.followerInventorySha256,
        `${context}.treatment.followerInventorySha256`
      ),
      followerMorphs: parsedFollowerMorphs,
      retainedPerformanceMorphs: parsedRetainedPerformanceMorphs,
      surfaceCorrection: parseSurfaceCorrection(
        treatment.surfaceCorrection,
        expectedSide,
        parsedFollowerMorphs,
        parsedRetainedPerformanceMorphs,
        `${context}.treatment.surfaceCorrection`
      ),
      doubleSided: literal(treatment.doubleSided, true, `${context}.treatment.doubleSided`),
      ordinaryDepthTest: literal(
        treatment.ordinaryDepthTest,
        true,
        `${context}.treatment.ordinaryDepthTest`
      ),
      depthWrite: literal(treatment.depthWrite, false, `${context}.treatment.depthWrite`),
      renderOrder: literal(
        treatment.renderOrder,
        'after-physical-eye',
        `${context}.treatment.renderOrder`
      )
    }
  }
  if (parsed.innerCanthusVertexIndex === parsed.outerCanthusVertexIndex) {
    fail(`${context} inner and outer canthus vertices must differ`)
  }
  return parsed
}

export function parseEyeApertureSeamDefinition(value: unknown): EyeApertureSeamDefinitionV2 {
  const source = record(value, 'definition')
  rejectUnknownKeys(
    source,
    [
      'schemaVersion',
      'definitionSha256',
      'status',
      'productExportApproved',
      'sharedCanthusRoots',
      'blinkClosure',
      'runtimeBindings'
    ],
    'definition'
  )
  if (source.schemaVersion !== EYE_APERTURE_SEAM_SCHEMA_VERSION) {
    fail(`definition.schemaVersion must be ${EYE_APERTURE_SEAM_SCHEMA_VERSION}`)
  }
  const blinkClosure = record(source.blinkClosure, 'definition.blinkClosure')
  rejectUnknownKeys(blinkClosure, ['composition', 'fullBlinkSquintFloor'], 'definition.blinkClosure')
  const runtimeBindings = record(source.runtimeBindings, 'definition.runtimeBindings')
  rejectUnknownKeys(runtimeBindings, ['left', 'right'], 'definition.runtimeBindings')
  const left = parseSide(runtimeBindings.left, 'left', 'definition.runtimeBindings.left')
  const right = parseSide(runtimeBindings.right, 'right', 'definition.runtimeBindings.right')
  const uniqueNodes = [
    left.physicalEyeNode,
    left.lashesEyeOutlineNode,
    right.physicalEyeNode,
    right.lashesEyeOutlineNode
  ]
  if (new Set(uniqueNodes).size !== uniqueNodes.length) {
    fail('definition physical-eye and lashes/outline treatment nodes must be unique')
  }
  const canthusVertices = [
    left.innerCanthusVertexIndex,
    left.outerCanthusVertexIndex,
    right.innerCanthusVertexIndex,
    right.outerCanthusVertexIndex
  ]
  if (new Set(canthusVertices).size !== canthusVertices.length) {
    fail('definition bilateral canthus vertices must be unique')
  }
  return {
    schemaVersion: EYE_APERTURE_SEAM_SCHEMA_VERSION,
    definitionSha256: sha256(source.definitionSha256, 'definition.definitionSha256'),
    status: literal(source.status, 'product-export-approved', 'definition.status'),
    productExportApproved: literal(
      source.productExportApproved,
      true,
      'definition.productExportApproved'
    ),
    sharedCanthusRoots: literal(source.sharedCanthusRoots, true, 'definition.sharedCanthusRoots'),
    blinkClosure: {
      composition: literal(
        blinkClosure.composition,
        'authored-independent/v2',
        'definition.blinkClosure.composition'
      ),
      fullBlinkSquintFloor: literal(
        blinkClosure.fullBlinkSquintFloor,
        0,
        'definition.blinkClosure.fullBlinkSquintFloor'
      )
    },
    runtimeBindings: { left, right }
  }
}

export function validateSocketEyeApertureOwnership(
  socketEye: SocketEyeSurfaceDefinitionV2,
  apertureSeam: EyeApertureSeamDefinitionV2
) {
  for (const sideName of ['left', 'right'] as const) {
    const surfaceSide = socketEye.runtimeBindings[sideName]
    const seamSide = apertureSeam.runtimeBindings[sideName]
    if (surfaceSide.apertureSeamDefinitionSha256 !== apertureSeam.definitionSha256) {
      fail(`${sideName} physical eye references a different aperture-seam definition`)
    }
    if (surfaceSide.nodes.physicalEye !== seamSide.physicalEyeNode) {
      fail(`${sideName} aperture seam references a different physical-eye node`)
    }
  }
}
