import {
  socketEyeCapRetainedDynamicMorphs,
  type SocketEyeSurfaceDefinitionV1,
  type SocketEyeSide
} from './socketEyeSurface'

export const EYE_APERTURE_SEAM_SCHEMA_VERSION = 'eye-aperture-seam/v1' as const
export const SOCKET_EYE_LINER_PERFORMANCE_MORPH_COUNT = 44

export type EyeApertureBoundaryDefinition = {
  sampleCount: number
  bindingSha256: string
}

export type EyeApertureSeamSideDefinition = {
  side: SocketEyeSide
  sourceBodyNode: string
  compositeCapNode: string
  lashesEyeOutlineNode: string
  upperBoundary: EyeApertureBoundaryDefinition
  lowerBoundary: EyeApertureBoundaryDefinition
  innerCanthusVertexIndex: number
  outerCanthusVertexIndex: number
  capUnderlapMeters: number
  liner: {
    innerOverlapMeters: number
    surfaceClearanceMeters: number
    baseForwardPitchDegrees: 0
    faceConformal: true
    visibleLidRimAllowed: false
    ordinaryDepthTest: true
    renderOrder: 'after-composite-cap'
    retainedPerformanceMorphs: string[]
    freeLashFlare: {
      profile: 'geometry-derived-attachment-hinge/v1'
      direction: 'model-forward'
      attachmentBandNormalizedWidth: number
      canthusTaperNormalizedWidth: number
      upperMaximumForwardOffsetMeters: number
      lowerMaximumForwardOffsetMeters: number
    }
  }
}

export type EyeApertureSeamDefinitionV1 = {
  schemaVersion: typeof EYE_APERTURE_SEAM_SCHEMA_VERSION
  definitionSha256: string
  status: 'product-export-approved'
  productExportApproved: true
  sharedCanthusRoots: true
  blinkClosure: {
    composition: 'same-side-squint-floor/v1'
    fullBlinkSquintFloor: 0.5
  }
  runtimeBindings: {
    left: EyeApertureSeamSideDefinition
    right: EyeApertureSeamSideDefinition
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const MAXIMUM_RASTER_SAFE_CLEARANCE_METERS = 0.00035
const EPSILON = 1e-12

function fail(message: string): never {
  throw new Error(`[eye-aperture-seam/v1] ${message}`)
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
  const allowedKeys = new Set(allowed)
  const extra = Object.keys(source).filter((key) => !allowedKeys.has(key))
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

function positive(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${context} must be a finite number greater than zero`)
  }
  return value
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

function unitInterval(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    fail(`${context} must be inside (0, 1)`)
  }
  return value
}

function retainedPerformanceMorphs(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length !== SOCKET_EYE_LINER_PERFORMANCE_MORPH_COUNT) {
    fail(`${context} must contain exactly ${SOCKET_EYE_LINER_PERFORMANCE_MORPH_COUNT} morphs`)
  }
  const parsed = value.map((entry, index) => stringValue(entry, `${context}[${index}]`))
  if (new Set(parsed).size !== parsed.length) fail(`${context} must not contain duplicates`)
  const sorted = [...parsed].sort()
  if (parsed.some((entry, index) => entry !== sorted[index])) fail(`${context} must be sorted`)
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

function parseSide(
  value: unknown,
  expectedSide: SocketEyeSide,
  context: string
): EyeApertureSeamSideDefinition {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    [
      'side',
      'sourceBodyNode',
      'compositeCapNode',
      'lashesEyeOutlineNode',
      'upperBoundary',
      'lowerBoundary',
      'innerCanthusVertexIndex',
      'outerCanthusVertexIndex',
      'capUnderlapMeters',
      'liner'
    ],
    context
  )
  if (source.side !== expectedSide) fail(`${context}.side must be ${expectedSide}`)
  const liner = record(source.liner, `${context}.liner`)
  rejectUnknownKeys(
    liner,
    [
      'innerOverlapMeters',
      'surfaceClearanceMeters',
      'baseForwardPitchDegrees',
      'faceConformal',
      'visibleLidRimAllowed',
      'ordinaryDepthTest',
      'renderOrder',
      'retainedPerformanceMorphs',
      'freeLashFlare'
    ],
    `${context}.liner`
  )
  const freeLashFlare = record(
    liner.freeLashFlare,
    `${context}.liner.freeLashFlare`
  )
  rejectUnknownKeys(
    freeLashFlare,
    [
      'profile',
      'direction',
      'attachmentBandNormalizedWidth',
      'canthusTaperNormalizedWidth',
      'upperMaximumForwardOffsetMeters',
      'lowerMaximumForwardOffsetMeters'
    ],
    `${context}.liner.freeLashFlare`
  )
  const parsed: EyeApertureSeamSideDefinition = {
    side: expectedSide,
    sourceBodyNode: stringValue(source.sourceBodyNode, `${context}.sourceBodyNode`),
    compositeCapNode: stringValue(source.compositeCapNode, `${context}.compositeCapNode`),
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
    capUnderlapMeters: positive(source.capUnderlapMeters, `${context}.capUnderlapMeters`),
    liner: {
      innerOverlapMeters: positive(
        liner.innerOverlapMeters,
        `${context}.liner.innerOverlapMeters`
      ),
      surfaceClearanceMeters: positive(
        liner.surfaceClearanceMeters,
        `${context}.liner.surfaceClearanceMeters`
      ),
      baseForwardPitchDegrees: literal(
        liner.baseForwardPitchDegrees,
        0,
        `${context}.liner.baseForwardPitchDegrees`
      ),
      faceConformal: literal(liner.faceConformal, true, `${context}.liner.faceConformal`),
      visibleLidRimAllowed: literal(
        liner.visibleLidRimAllowed,
        false,
        `${context}.liner.visibleLidRimAllowed`
      ),
      ordinaryDepthTest: literal(
        liner.ordinaryDepthTest,
        true,
        `${context}.liner.ordinaryDepthTest`
      ),
      renderOrder: literal(
        liner.renderOrder,
        'after-composite-cap',
        `${context}.liner.renderOrder`
      ),
      retainedPerformanceMorphs: retainedPerformanceMorphs(
        liner.retainedPerformanceMorphs,
        `${context}.liner.retainedPerformanceMorphs`
      ),
      freeLashFlare: {
        profile: literal(
          freeLashFlare.profile,
          'geometry-derived-attachment-hinge/v1',
          `${context}.liner.freeLashFlare.profile`
        ),
        direction: literal(
          freeLashFlare.direction,
          'model-forward',
          `${context}.liner.freeLashFlare.direction`
        ),
        attachmentBandNormalizedWidth: unitInterval(
          freeLashFlare.attachmentBandNormalizedWidth,
          `${context}.liner.freeLashFlare.attachmentBandNormalizedWidth`
        ),
        canthusTaperNormalizedWidth: unitInterval(
          freeLashFlare.canthusTaperNormalizedWidth,
          `${context}.liner.freeLashFlare.canthusTaperNormalizedWidth`
        ),
        upperMaximumForwardOffsetMeters: positive(
          freeLashFlare.upperMaximumForwardOffsetMeters,
          `${context}.liner.freeLashFlare.upperMaximumForwardOffsetMeters`
        ),
        lowerMaximumForwardOffsetMeters: positive(
          freeLashFlare.lowerMaximumForwardOffsetMeters,
          `${context}.liner.freeLashFlare.lowerMaximumForwardOffsetMeters`
        )
      }
    }
  }
  if (parsed.innerCanthusVertexIndex === parsed.outerCanthusVertexIndex) {
    fail(`${context} inner and outer canthus vertices must differ`)
  }
  if (parsed.liner.surfaceClearanceMeters > MAXIMUM_RASTER_SAFE_CLEARANCE_METERS) {
    fail(
      `${context}.liner.surfaceClearanceMeters exceeds the raster-safe micro-clearance limit`
    )
  }
  if (parsed.liner.innerOverlapMeters <= parsed.liner.surfaceClearanceMeters) {
    fail(`${context}.liner.innerOverlapMeters must exceed the presentation clearance`)
  }
  for (const required of socketEyeCapRetainedDynamicMorphs(expectedSide)) {
    if (!parsed.liner.retainedPerformanceMorphs.includes(required)) {
      fail(`${context}.liner.retainedPerformanceMorphs must include ${required}`)
    }
  }
  return parsed
}

export function parseEyeApertureSeamDefinition(value: unknown): EyeApertureSeamDefinitionV1 {
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
  const runtimeBindings = record(source.runtimeBindings, 'definition.runtimeBindings')
  const blinkClosure = record(source.blinkClosure, 'definition.blinkClosure')
  rejectUnknownKeys(
    blinkClosure,
    ['composition', 'fullBlinkSquintFloor'],
    'definition.blinkClosure'
  )
  rejectUnknownKeys(runtimeBindings, ['left', 'right'], 'definition.runtimeBindings')
  const left = parseSide(runtimeBindings.left, 'left', 'definition.runtimeBindings.left')
  const right = parseSide(runtimeBindings.right, 'right', 'definition.runtimeBindings.right')
  const uniqueNodes = [
    left.compositeCapNode,
    left.lashesEyeOutlineNode,
    right.compositeCapNode,
    right.lashesEyeOutlineNode
  ]
  if (new Set(uniqueNodes).size !== uniqueNodes.length) {
    fail('definition composite-cap and eye-outline nodes must be unique')
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
    sharedCanthusRoots: literal(
      source.sharedCanthusRoots,
      true,
      'definition.sharedCanthusRoots'
    ),
    blinkClosure: {
      composition: literal(
        blinkClosure.composition,
        'same-side-squint-floor/v1',
        'definition.blinkClosure.composition'
      ),
      fullBlinkSquintFloor: literal(
        blinkClosure.fullBlinkSquintFloor,
        0.5,
        'definition.blinkClosure.fullBlinkSquintFloor'
      )
    },
    runtimeBindings: { left, right }
  }
}

export function validateSocketEyeApertureOwnership(
  socketEye: SocketEyeSurfaceDefinitionV1,
  apertureSeam: EyeApertureSeamDefinitionV1
) {
  for (const sideName of ['left', 'right'] as const) {
    const surfaceSide = socketEye.runtimeBindings[sideName]
    const seamSide = apertureSeam.runtimeBindings[sideName]
    if (surfaceSide.apertureSeamDefinitionSha256 !== apertureSeam.definitionSha256) {
      fail(`${sideName} socket eye references a different aperture-seam definition`)
    }
    if (surfaceSide.nodes.compositeCap !== seamSide.compositeCapNode) {
      fail(`${sideName} aperture seam references a different composite-cap node`)
    }
    if (
      Math.abs(surfaceSide.cap.minimumHiddenUnderlapMeters - seamSide.capUnderlapMeters) >
      EPSILON
    ) {
      fail(`${sideName} cap underlap drifted between the socket and aperture seam`)
    }
  }
}
