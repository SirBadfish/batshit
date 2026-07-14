export const EYE_APPEARANCE_SCHEMA_VERSION = 'eye-appearance/v1' as const
export const EYE_APPEARANCE_STATE_SCHEMA_VERSION = 'eye-appearance-state/v1' as const

export const EYE_APPEARANCE_CONTROL_IDS = [
  'iris_size',
  'pupil_size',
  'sclera_scale',
  'sclera_tilt',
  'sclera_horizontal_position',
  'sclera_vertical_position',
  'sclera_depth'
] as const

export type EyeAppearanceControlId = (typeof EYE_APPEARANCE_CONTROL_IDS)[number]

export type EyeAppearanceStateV1 = {
  schemaVersion: typeof EYE_APPEARANCE_STATE_SCHEMA_VERSION
  definitionSha256: string
  irisSize: number
  pupilSize: number
  scleraFit: {
    scale: number
    tilt: number
    horizontal: number
    vertical: number
    depth: number
  }
}

export type EyeAppearanceControlDefinition = {
  id: EyeAppearanceControlId
  label: string
  minimum: number
  maximum: number
  step: number
  default: number
  unit: 'neutral-multiplier' | 'post-fit-multiplier-offset' | 'degrees' | 'meters'
  linkedBilateral: true
  perEyeOverridesAllowed: false
  runtimeClampingAllowed: false
  geometrySemantics: string
}

export type EyeAppearanceRuntimeSideBinding = {
  eyeBone: string
  neutralPivotParent: [number, number, number]
  assemblyNodes: {
    sclera: string
    cornea: string
    iris: string
    pupil: string
  }
  eyeHighlightMaterialNodes: [string, string]
  horizontalAxisParent: [number, number, number]
  verticalAxisParent: [number, number, number]
  depthAxisParent: [number, number, number]
  forwardAxisParent: [number, number, number]
  tiltAxisParent: [number, number, number]
  horizontalSign: -1 | 1
  tiltSign: -1 | 1
  conformal: {
    scleraNode: string
    irisNode: string
    pupilNode: string
    opticalAxisLocal: [number, number, number]
    scleraRadiiLocal: [number, number, number]
    irisCenterLocal: [number, number, number]
    pupilCenterLocal: [number, number, number]
    irisAuthoredOffset: number
    pupilAuthoredOffset: number
  }
}

export type EyeAppearanceDefinitionV1 = {
  schemaVersion: typeof EYE_APPEARANCE_SCHEMA_VERSION
  stateSchemaVersion: typeof EYE_APPEARANCE_STATE_SCHEMA_VERSION
  status: string
  productExportApproved: false
  definitionSha256: string
  facialArtworkDependency: {
    schemaVersion: 'facial-artwork/v2'
    definitionSha256: string
  }
  ownership: string
  zeroLaw: string
  symmetryLaw: string
  compositionOrder: string[]
  completeEyeAssemblyNodes: string[]
  solidColorDefaults: {
    iris: [number, number, number, number]
    pupil: [number, number, number, number]
    sclera: [number, number, number, number]
  }
  runtimeBindings: {
    left: EyeAppearanceRuntimeSideBinding
    right: EyeAppearanceRuntimeSideBinding
    coordinateSpace: string
    pivotBindingLaw: string
    inverseBindLaw: string
    conformalLaw: string
    geometryEvidence: {
      acceptedV4GlbSha256: string
      localizedFitMatrixSha256: string
      conformalSolverSha256: string
    }
  }
  controls: EyeAppearanceControlDefinition[]
  rangeEvidence: {
    schemaVersion: string
    sha256: string
    canonicalSha256: string
  }
}

export type EyeAppearanceReconciliation = {
  state: EyeAppearanceStateV1 | null
  incompatible: boolean
  reason?: string
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const CONTROL_ID_SET = new Set<string>(EYE_APPEARANCE_CONTROL_IDS)

function fail(message: string): never {
  throw new Error(`[eye-appearance/v1] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${context} must be an object`)
  return value as Record<string, unknown>
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], context: string) {
  const accepted = new Set(allowed)
  const extra = Object.keys(value).filter((key) => !accepted.has(key))
  if (extra.length > 0) fail(`${context} contains unsupported fields: ${extra.join(', ')}`)
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function hash(value: unknown, context: string): string {
  const parsed = stringValue(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function stringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${context} must be a non-empty array`)
  return value.map((entry, index) => stringValue(entry, `${context}[${index}]`))
}

function rgba(value: unknown, context: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) fail(`${context} must contain four channels`)
  return value.map((channel, index) => {
    const parsed = finite(channel, `${context}[${index}]`)
    if (parsed < 0 || parsed > 1) fail(`${context}[${index}] must be inside [0, 1]`)
    return parsed
  }) as [number, number, number, number]
}

function vec3(value: unknown, context: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) fail(`${context} must contain three numbers`)
  return value.map((entry, index) => finite(entry, `${context}[${index}]`)) as [number, number, number]
}

function parseRuntimeSide(value: unknown, context: string): EyeAppearanceRuntimeSideBinding {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    [
      'eyeBone',
      'neutralPivotParent',
      'assemblyNodes',
      'eyeHighlightMaterialNodes',
      'horizontalAxisParent',
      'verticalAxisParent',
      'depthAxisParent',
      'forwardAxisParent',
      'tiltAxisParent',
      'horizontalSign',
      'tiltSign',
      'conformal'
    ],
    context
  )
  const assembly = record(source.assemblyNodes, `${context}.assemblyNodes`)
  rejectUnknownKeys(assembly, ['sclera', 'cornea', 'iris', 'pupil'], `${context}.assemblyNodes`)
  if (!Array.isArray(source.eyeHighlightMaterialNodes) || source.eyeHighlightMaterialNodes.length !== 2) {
    fail(`${context}.eyeHighlightMaterialNodes must contain iris and pupil node names`)
  }
  const conformal = record(source.conformal, `${context}.conformal`)
  rejectUnknownKeys(
    conformal,
    [
      'opticalAxisLocal',
      'scleraNode',
      'irisNode',
      'pupilNode',
      'scleraRadiiLocal',
      'irisCenterLocal',
      'pupilCenterLocal',
      'irisAuthoredOffset',
      'pupilAuthoredOffset'
    ],
    `${context}.conformal`
  )
  const horizontalSign = finite(source.horizontalSign, `${context}.horizontalSign`)
  const tiltSign = finite(source.tiltSign, `${context}.tiltSign`)
  if (horizontalSign !== -1 && horizontalSign !== 1) fail(`${context}.horizontalSign must be -1 or 1`)
  if (tiltSign !== -1 && tiltSign !== 1) fail(`${context}.tiltSign must be -1 or 1`)
  const result: EyeAppearanceRuntimeSideBinding = {
    eyeBone: stringValue(source.eyeBone, `${context}.eyeBone`),
    neutralPivotParent: vec3(source.neutralPivotParent, `${context}.neutralPivotParent`),
    assemblyNodes: {
      sclera: stringValue(assembly.sclera, `${context}.assemblyNodes.sclera`),
      cornea: stringValue(assembly.cornea, `${context}.assemblyNodes.cornea`),
      iris: stringValue(assembly.iris, `${context}.assemblyNodes.iris`),
      pupil: stringValue(assembly.pupil, `${context}.assemblyNodes.pupil`)
    },
    eyeHighlightMaterialNodes: source.eyeHighlightMaterialNodes.map((entry, index) =>
      stringValue(entry, `${context}.eyeHighlightMaterialNodes[${index}]`)
    ) as [string, string],
    horizontalAxisParent: vec3(source.horizontalAxisParent, `${context}.horizontalAxisParent`),
    verticalAxisParent: vec3(source.verticalAxisParent, `${context}.verticalAxisParent`),
    depthAxisParent: vec3(source.depthAxisParent, `${context}.depthAxisParent`),
    forwardAxisParent: vec3(source.forwardAxisParent, `${context}.forwardAxisParent`),
    tiltAxisParent: vec3(source.tiltAxisParent, `${context}.tiltAxisParent`),
    horizontalSign: horizontalSign as -1 | 1,
    tiltSign: tiltSign as -1 | 1,
    conformal: {
      scleraNode: stringValue(conformal.scleraNode, `${context}.conformal.scleraNode`),
      irisNode: stringValue(conformal.irisNode, `${context}.conformal.irisNode`),
      pupilNode: stringValue(conformal.pupilNode, `${context}.conformal.pupilNode`),
      opticalAxisLocal: vec3(conformal.opticalAxisLocal, `${context}.conformal.opticalAxisLocal`),
      scleraRadiiLocal: vec3(conformal.scleraRadiiLocal, `${context}.conformal.scleraRadiiLocal`),
      irisCenterLocal: vec3(conformal.irisCenterLocal, `${context}.conformal.irisCenterLocal`),
      pupilCenterLocal: vec3(conformal.pupilCenterLocal, `${context}.conformal.pupilCenterLocal`),
      irisAuthoredOffset: finite(conformal.irisAuthoredOffset, `${context}.conformal.irisAuthoredOffset`),
      pupilAuthoredOffset: finite(conformal.pupilAuthoredOffset, `${context}.conformal.pupilAuthoredOffset`)
    }
  }
  const expectedHighlights = new Set([result.assemblyNodes.iris, result.assemblyNodes.pupil])
  if (
    new Set(result.eyeHighlightMaterialNodes).size !== 2 ||
    result.eyeHighlightMaterialNodes.some((node) => !expectedHighlights.has(node))
  ) {
    fail(`${context}.eyeHighlightMaterialNodes must exactly reference the iris and pupil assembly nodes`)
  }
  if (
    result.conformal.scleraNode !== result.assemblyNodes.sclera ||
    result.conformal.irisNode !== result.assemblyNodes.iris ||
    result.conformal.pupilNode !== result.assemblyNodes.pupil
  ) {
    fail(`${context}.conformal node bindings must match the complete-eye assembly`)
  }
  if (result.conformal.scleraRadiiLocal.some((radius) => radius <= 0)) {
    fail(`${context}.conformal.scleraRadiiLocal must be positive`)
  }
  for (const [field, axis] of [
    ['horizontalAxisParent', result.horizontalAxisParent],
    ['verticalAxisParent', result.verticalAxisParent],
    ['depthAxisParent', result.depthAxisParent],
    ['forwardAxisParent', result.forwardAxisParent],
    ['tiltAxisParent', result.tiltAxisParent],
    ['opticalAxisLocal', result.conformal.opticalAxisLocal]
  ] as const) {
    const length = Math.hypot(...axis)
    if (Math.abs(length - 1) > 1e-5) fail(`${context}.${field} must be a unit vector`)
  }
  return result
}

function parseControl(value: unknown, expectedId: EyeAppearanceControlId, context: string) {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    [
      'id',
      'label',
      'minimum',
      'maximum',
      'step',
      'default',
      'unit',
      'linkedBilateral',
      'perEyeOverridesAllowed',
      'runtimeClampingAllowed',
      'geometrySemantics'
    ],
    context
  )
  const id = stringValue(source.id, `${context}.id`)
  if (id !== expectedId || !CONTROL_ID_SET.has(id)) fail(`${context}.id must be ${expectedId}`)
  const minimum = finite(source.minimum, `${context}.minimum`)
  const maximum = finite(source.maximum, `${context}.maximum`)
  const step = finite(source.step, `${context}.step`)
  const defaultValue = finite(source.default, `${context}.default`)
  if (minimum >= maximum) fail(`${context} minimum must be less than maximum`)
  if (step <= 0) fail(`${context}.step must be positive`)
  if (defaultValue < minimum || defaultValue > maximum) fail(`${context}.default must be inside its bounds`)
  if (source.linkedBilateral !== true) fail(`${context}.linkedBilateral must be true`)
  if (source.perEyeOverridesAllowed !== false) fail(`${context}.perEyeOverridesAllowed must be false`)
  if (source.runtimeClampingAllowed !== false) fail(`${context}.runtimeClampingAllowed must be false`)
  const unit = stringValue(source.unit, `${context}.unit`)
  if (!['neutral-multiplier', 'post-fit-multiplier-offset', 'degrees', 'meters'].includes(unit)) {
    fail(`${context}.unit is unsupported`)
  }
  return {
    id: expectedId,
    label: stringValue(source.label, `${context}.label`),
    minimum,
    maximum,
    step,
    default: defaultValue,
    unit: unit as EyeAppearanceControlDefinition['unit'],
    linkedBilateral: true,
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics: stringValue(source.geometrySemantics, `${context}.geometrySemantics`)
  } satisfies EyeAppearanceControlDefinition
}

export function parseEyeAppearanceDefinition(value: unknown): EyeAppearanceDefinitionV1 {
  const source = record(value, 'definition')
  rejectUnknownKeys(
    source,
    [
      'schemaVersion',
      'stateSchemaVersion',
      'status',
      'productExportApproved',
      'definitionSha256',
      'facialArtworkDependency',
      'ownership',
      'zeroLaw',
      'symmetryLaw',
      'compositionOrder',
      'completeEyeAssemblyNodes',
      'solidColorDefaults',
      'runtimeBindings',
      'controls',
      'rangeEvidence'
    ],
    'definition'
  )
  if (source.schemaVersion !== EYE_APPEARANCE_SCHEMA_VERSION) fail('definition schemaVersion is unsupported')
  if (source.stateSchemaVersion !== EYE_APPEARANCE_STATE_SCHEMA_VERSION) {
    fail('definition stateSchemaVersion is unsupported')
  }
  if (source.productExportApproved !== false) fail('definition productExportApproved must remain false')

  const dependency = record(source.facialArtworkDependency, 'definition.facialArtworkDependency')
  rejectUnknownKeys(dependency, ['schemaVersion', 'definitionSha256'], 'definition.facialArtworkDependency')
  if (dependency.schemaVersion !== 'facial-artwork/v2') fail('definition dependency must target facial-artwork/v2')

  const colors = record(source.solidColorDefaults, 'definition.solidColorDefaults')
  rejectUnknownKeys(colors, ['iris', 'pupil', 'sclera'], 'definition.solidColorDefaults')

  const runtimeBindings = record(source.runtimeBindings, 'definition.runtimeBindings')
  rejectUnknownKeys(
    runtimeBindings,
    [
      'coordinateSpace',
      'pivotBindingLaw',
      'inverseBindLaw',
      'conformalLaw',
      'geometryEvidence',
      'left',
      'right'
    ],
    'definition.runtimeBindings'
  )
  const geometryEvidence = record(
    runtimeBindings.geometryEvidence,
    'definition.runtimeBindings.geometryEvidence'
  )
  rejectUnknownKeys(
    geometryEvidence,
    ['acceptedV4GlbSha256', 'localizedFitMatrixSha256', 'conformalSolverSha256'],
    'definition.runtimeBindings.geometryEvidence'
  )

  if (!Array.isArray(source.controls) || source.controls.length !== EYE_APPEARANCE_CONTROL_IDS.length) {
    fail(`definition.controls must contain exactly ${EYE_APPEARANCE_CONTROL_IDS.length} controls`)
  }
  const controlSources = source.controls as unknown[]
  const controls = EYE_APPEARANCE_CONTROL_IDS.map((id, index) =>
    parseControl(controlSources[index], id, `definition.controls[${index}]`)
  )

  const rangeEvidence = record(source.rangeEvidence, 'definition.rangeEvidence')
  rejectUnknownKeys(rangeEvidence, ['schemaVersion', 'sha256', 'canonicalSha256'], 'definition.rangeEvidence')

  return {
    schemaVersion: EYE_APPEARANCE_SCHEMA_VERSION,
    stateSchemaVersion: EYE_APPEARANCE_STATE_SCHEMA_VERSION,
    status: stringValue(source.status, 'definition.status'),
    productExportApproved: false,
    definitionSha256: hash(source.definitionSha256, 'definition.definitionSha256'),
    facialArtworkDependency: {
      schemaVersion: 'facial-artwork/v2',
      definitionSha256: hash(dependency.definitionSha256, 'definition.facialArtworkDependency.definitionSha256')
    },
    ownership: stringValue(source.ownership, 'definition.ownership'),
    zeroLaw: stringValue(source.zeroLaw, 'definition.zeroLaw'),
    symmetryLaw: stringValue(source.symmetryLaw, 'definition.symmetryLaw'),
    compositionOrder: stringList(source.compositionOrder, 'definition.compositionOrder'),
    completeEyeAssemblyNodes: stringList(source.completeEyeAssemblyNodes, 'definition.completeEyeAssemblyNodes'),
    solidColorDefaults: {
      iris: rgba(colors.iris, 'definition.solidColorDefaults.iris'),
      pupil: rgba(colors.pupil, 'definition.solidColorDefaults.pupil'),
      sclera: rgba(colors.sclera, 'definition.solidColorDefaults.sclera')
    },
    runtimeBindings: {
      left: parseRuntimeSide(runtimeBindings.left, 'definition.runtimeBindings.left'),
      right: parseRuntimeSide(runtimeBindings.right, 'definition.runtimeBindings.right'),
      coordinateSpace: stringValue(runtimeBindings.coordinateSpace, 'definition.runtimeBindings.coordinateSpace'),
      pivotBindingLaw: stringValue(runtimeBindings.pivotBindingLaw, 'definition.runtimeBindings.pivotBindingLaw'),
      inverseBindLaw: stringValue(runtimeBindings.inverseBindLaw, 'definition.runtimeBindings.inverseBindLaw'),
      conformalLaw: stringValue(runtimeBindings.conformalLaw, 'definition.runtimeBindings.conformalLaw'),
      geometryEvidence: {
        acceptedV4GlbSha256: hash(
          geometryEvidence.acceptedV4GlbSha256,
          'definition.runtimeBindings.geometryEvidence.acceptedV4GlbSha256'
        ),
        localizedFitMatrixSha256: hash(
          geometryEvidence.localizedFitMatrixSha256,
          'definition.runtimeBindings.geometryEvidence.localizedFitMatrixSha256'
        ),
        conformalSolverSha256: hash(
          geometryEvidence.conformalSolverSha256,
          'definition.runtimeBindings.geometryEvidence.conformalSolverSha256'
        )
      }
    },
    controls,
    rangeEvidence: {
      schemaVersion: stringValue(rangeEvidence.schemaVersion, 'definition.rangeEvidence.schemaVersion'),
      sha256: hash(rangeEvidence.sha256, 'definition.rangeEvidence.sha256'),
      canonicalSha256: hash(rangeEvidence.canonicalSha256, 'definition.rangeEvidence.canonicalSha256')
    }
  }
}

function control(definition: EyeAppearanceDefinitionV1, id: EyeAppearanceControlId) {
  const found = definition.controls.find((entry) => entry.id === id)
  if (!found) fail(`definition is missing ${id}`)
  return found
}

function bounded(definition: EyeAppearanceDefinitionV1, id: EyeAppearanceControlId, value: unknown, context: string) {
  const parsed = finite(value, context)
  const bounds = control(definition, id)
  if (parsed < bounds.minimum || parsed > bounds.maximum) {
    fail(`${context} must be inside [${bounds.minimum}, ${bounds.maximum}]`)
  }
  return parsed
}

export function createDefaultEyeAppearanceState(definition: EyeAppearanceDefinitionV1): EyeAppearanceStateV1 {
  return {
    schemaVersion: EYE_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    irisSize: control(definition, 'iris_size').default,
    pupilSize: control(definition, 'pupil_size').default,
    scleraFit: {
      scale: control(definition, 'sclera_scale').default,
      tilt: control(definition, 'sclera_tilt').default,
      horizontal: control(definition, 'sclera_horizontal_position').default,
      vertical: control(definition, 'sclera_vertical_position').default,
      depth: control(definition, 'sclera_depth').default
    }
  }
}

export function parseEyeAppearanceState(
  definition: EyeAppearanceDefinitionV1,
  value: unknown
): EyeAppearanceStateV1 {
  const source = record(value, 'state')
  rejectUnknownKeys(source, ['schemaVersion', 'definitionSha256', 'irisSize', 'pupilSize', 'scleraFit'], 'state')
  if (source.schemaVersion !== EYE_APPEARANCE_STATE_SCHEMA_VERSION) fail('state schemaVersion is unsupported')
  if (source.definitionSha256 !== definition.definitionSha256) fail('state definitionSha256 does not match this package')
  const fit = record(source.scleraFit, 'state.scleraFit')
  rejectUnknownKeys(fit, ['scale', 'tilt', 'horizontal', 'vertical', 'depth'], 'state.scleraFit')
  return {
    schemaVersion: EYE_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    irisSize: bounded(definition, 'iris_size', source.irisSize, 'state.irisSize'),
    pupilSize: bounded(definition, 'pupil_size', source.pupilSize, 'state.pupilSize'),
    scleraFit: {
      scale: bounded(definition, 'sclera_scale', fit.scale, 'state.scleraFit.scale'),
      tilt: bounded(definition, 'sclera_tilt', fit.tilt, 'state.scleraFit.tilt'),
      horizontal: bounded(
        definition,
        'sclera_horizontal_position',
        fit.horizontal,
        'state.scleraFit.horizontal'
      ),
      vertical: bounded(definition, 'sclera_vertical_position', fit.vertical, 'state.scleraFit.vertical'),
      depth: bounded(definition, 'sclera_depth', fit.depth, 'state.scleraFit.depth')
    }
  }
}

export function resolveEyeAppearanceState(
  definition: EyeAppearanceDefinitionV1,
  value: EyeAppearanceStateV1 | null | undefined
) {
  return value ? parseEyeAppearanceState(definition, value) : createDefaultEyeAppearanceState(definition)
}

export function reconcileEyeAppearanceState(
  definition: EyeAppearanceDefinitionV1,
  value: unknown
): EyeAppearanceReconciliation {
  if (value == null) return { state: null, incompatible: false }
  try {
    return { state: parseEyeAppearanceState(definition, value), incompatible: false }
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason: error instanceof Error ? error.message : 'Eye Appearance state is incompatible with this package.'
    }
  }
}

export function readEyeAppearanceControl(state: EyeAppearanceStateV1, id: EyeAppearanceControlId) {
  switch (id) {
    case 'iris_size':
      return state.irisSize
    case 'pupil_size':
      return state.pupilSize
    case 'sclera_scale':
      return state.scleraFit.scale
    case 'sclera_tilt':
      return state.scleraFit.tilt
    case 'sclera_horizontal_position':
      return state.scleraFit.horizontal
    case 'sclera_vertical_position':
      return state.scleraFit.vertical
    case 'sclera_depth':
      return state.scleraFit.depth
  }
}

export function updateEyeAppearanceControl(
  state: EyeAppearanceStateV1,
  id: EyeAppearanceControlId,
  value: number
): EyeAppearanceStateV1 {
  const next = structuredClone(state)
  switch (id) {
    case 'iris_size':
      next.irisSize = value
      break
    case 'pupil_size':
      next.pupilSize = value
      break
    case 'sclera_scale':
      next.scleraFit.scale = value
      break
    case 'sclera_tilt':
      next.scleraFit.tilt = value
      break
    case 'sclera_horizontal_position':
      next.scleraFit.horizontal = value
      break
    case 'sclera_vertical_position':
      next.scleraFit.vertical = value
      break
    case 'sclera_depth':
      next.scleraFit.depth = value
      break
  }
  return next
}
