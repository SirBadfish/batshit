export const ORAL_APPEARANCE_SCHEMA_VERSION = 'oral-appearance/v1' as const
export const ORAL_APPEARANCE_STATE_SCHEMA_VERSION = 'oral-appearance-state/v1' as const

export const ORAL_APPEARANCE_CONTROL_IDS = [
  'teeth_color',
  'teeth_brightness',
  'teeth_shine',
  'gum_color',
  'tongue_color'
] as const

export type OralAppearanceControlId = (typeof ORAL_APPEARANCE_CONTROL_IDS)[number]
export type OralAppearanceRgb = [number, number, number]
export type OralAppearanceFamily = 'teeth' | 'gums' | 'tongue'

export type OralAppearanceColorControlDefinition = {
  id: 'teeth_color' | 'gum_color' | 'tongue_color'
  kind: 'color'
  label: string
  description: string
  default: OralAppearanceRgb
  unit: 'srgb-tint'
}

export type OralAppearanceNumberControlDefinition = {
  id: 'teeth_brightness' | 'teeth_shine'
  kind: 'number'
  label: string
  description: string
  minimum: number
  maximum: number
  step: number
  default: number
  unit: 'multiplier' | 'inverse-roughness'
}

export type OralAppearanceControlDefinition =
  | OralAppearanceColorControlDefinition
  | OralAppearanceNumberControlDefinition

export type OralAppearanceMaterialBinding = {
  nodes: string[]
  material: string
}

export type OralAppearanceDefinitionV1 = {
  schemaVersion: typeof ORAL_APPEARANCE_SCHEMA_VERSION
  stateSchemaVersion: typeof ORAL_APPEARANCE_STATE_SCHEMA_VERSION
  status: string
  productExportApproved: false
  definitionSha256: string
  ownership: string
  defaultLaw: string
  compositionOrder: string[]
  customTexturePolicy: string
  runtimeBindings: Record<OralAppearanceFamily, OralAppearanceMaterialBinding>
  materialDefaults: Record<
    OralAppearanceFamily,
    { color: OralAppearanceRgb; roughness: number }
  >
  controls: OralAppearanceControlDefinition[]
}

export type OralAppearanceStateV1 = {
  schemaVersion: typeof ORAL_APPEARANCE_STATE_SCHEMA_VERSION
  definitionSha256: string
  teeth: {
    color: OralAppearanceRgb
    brightness: number
    shine: number
  }
  gums: { color: OralAppearanceRgb }
  tongue: { color: OralAppearanceRgb }
}

export type OralAppearanceReconciliation = {
  state: OralAppearanceStateV1 | null
  incompatible: boolean
  reason?: string
}

const HASH_PATTERN = /^[a-f0-9]{64}$/
const FAMILY_ORDER = ['teeth', 'gums', 'tongue'] as const

function fail(message: string): never {
  throw new Error(`[oral-appearance/v1] ${message}`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string
) {
  const accepted = new Set(allowed)
  const extra = Object.keys(value).filter((key) => !accepted.has(key))
  if (extra.length > 0) fail(`${context} contains unsupported fields: ${extra.join(', ')}`)
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    fail(`${context} must be a non-empty trimmed string`)
  }
  return value
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context} must be finite`)
  return value
}

function sha256(value: unknown, context: string): string {
  const parsed = text(value, context)
  if (!HASH_PATTERN.test(parsed)) fail(`${context} must be lowercase SHA-256`)
  return parsed
}

function stringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${context} must be a non-empty array`)
  const values = value.map((entry, index) => text(entry, `${context}[${index}]`))
  if (new Set(values).size !== values.length) fail(`${context} contains duplicate values`)
  return values
}

function rgb(value: unknown, context: string): OralAppearanceRgb {
  if (!Array.isArray(value) || value.length !== 3) fail(`${context} must contain three channels`)
  return value.map((channel, index) => {
    const parsed = finite(channel, `${context}[${index}]`)
    if (parsed < 0 || parsed > 1) fail(`${context}[${index}] must be inside [0, 1]`)
    return parsed
  }) as OralAppearanceRgb
}

function sameRgb(left: OralAppearanceRgb, right: OralAppearanceRgb) {
  return left.every((value, index) => value === right[index])
}

function onStepLattice(value: number, minimum: number, step: number) {
  const steps = (value - minimum) / step
  const tolerance = Math.max(1, Math.abs(steps)) * Number.EPSILON * 64
  return Math.abs(steps - Math.round(steps)) <= tolerance
}

function parseBinding(value: unknown, family: OralAppearanceFamily): OralAppearanceMaterialBinding {
  const source = record(value, `definition.runtimeBindings.${family}`)
  rejectUnknownKeys(source, ['nodes', 'material'], `definition.runtimeBindings.${family}`)
  return {
    nodes: stringList(source.nodes, `definition.runtimeBindings.${family}.nodes`),
    material: text(source.material, `definition.runtimeBindings.${family}.material`)
  }
}

function parseColorControl(
  value: unknown,
  expectedId: OralAppearanceColorControlDefinition['id'],
  context: string
): OralAppearanceColorControlDefinition {
  const source = record(value, context)
  rejectUnknownKeys(source, ['id', 'kind', 'label', 'description', 'default', 'unit'], context)
  if (source.id !== expectedId) fail(`${context}.id must be ${expectedId}`)
  if (source.kind !== 'color') fail(`${context}.kind must be color`)
  if (source.unit !== 'srgb-tint') fail(`${context}.unit must be srgb-tint`)
  return {
    id: expectedId,
    kind: 'color',
    label: text(source.label, `${context}.label`),
    description: text(source.description, `${context}.description`),
    default: rgb(source.default, `${context}.default`),
    unit: 'srgb-tint'
  }
}

function parseNumberControl(
  value: unknown,
  expectedId: OralAppearanceNumberControlDefinition['id'],
  expectedUnit: OralAppearanceNumberControlDefinition['unit'],
  context: string
): OralAppearanceNumberControlDefinition {
  const source = record(value, context)
  rejectUnknownKeys(
    source,
    ['id', 'kind', 'label', 'description', 'minimum', 'maximum', 'step', 'default', 'unit'],
    context
  )
  if (source.id !== expectedId) fail(`${context}.id must be ${expectedId}`)
  if (source.kind !== 'number') fail(`${context}.kind must be number`)
  if (source.unit !== expectedUnit) fail(`${context}.unit must be ${expectedUnit}`)
  const minimum = finite(source.minimum, `${context}.minimum`)
  const maximum = finite(source.maximum, `${context}.maximum`)
  const step = finite(source.step, `${context}.step`)
  const defaultValue = finite(source.default, `${context}.default`)
  if (minimum >= maximum) fail(`${context}.minimum must be less than maximum`)
  if (step <= 0) fail(`${context}.step must be positive`)
  if (defaultValue < minimum || defaultValue > maximum) {
    fail(`${context}.default must be inside its bounds`)
  }
  if (!onStepLattice(maximum, minimum, step) || !onStepLattice(defaultValue, minimum, step)) {
    fail(`${context} bounds and default must use the minimum-plus-step lattice`)
  }
  return {
    id: expectedId,
    kind: 'number',
    label: text(source.label, `${context}.label`),
    description: text(source.description, `${context}.description`),
    minimum,
    maximum,
    step,
    default: defaultValue,
    unit: expectedUnit
  }
}

export function parseOralAppearanceDefinition(value: unknown): OralAppearanceDefinitionV1 {
  const source = record(value, 'definition')
  rejectUnknownKeys(
    source,
    [
      'schemaVersion',
      'stateSchemaVersion',
      'status',
      'productExportApproved',
      'definitionSha256',
      'ownership',
      'defaultLaw',
      'compositionOrder',
      'customTexturePolicy',
      'runtimeBindings',
      'materialDefaults',
      'controls'
    ],
    'definition'
  )
  if (source.schemaVersion !== ORAL_APPEARANCE_SCHEMA_VERSION) {
    fail('definition schemaVersion is unsupported')
  }
  if (source.stateSchemaVersion !== ORAL_APPEARANCE_STATE_SCHEMA_VERSION) {
    fail('definition stateSchemaVersion is unsupported')
  }
  if (source.productExportApproved !== false) {
    fail('definition productExportApproved must remain false')
  }

  const rawBindings = record(source.runtimeBindings, 'definition.runtimeBindings')
  rejectUnknownKeys(rawBindings, FAMILY_ORDER, 'definition.runtimeBindings')
  const runtimeBindings = Object.fromEntries(
    FAMILY_ORDER.map((family) => [family, parseBinding(rawBindings[family], family)])
  ) as OralAppearanceDefinitionV1['runtimeBindings']
  const allNodes = FAMILY_ORDER.flatMap((family) => runtimeBindings[family].nodes)
  const allMaterials = FAMILY_ORDER.map((family) => runtimeBindings[family].material)
  if (new Set(allNodes).size !== allNodes.length) fail('definition runtime nodes overlap')
  if (new Set(allMaterials).size !== allMaterials.length) fail('definition material families overlap')

  const rawDefaults = record(source.materialDefaults, 'definition.materialDefaults')
  rejectUnknownKeys(rawDefaults, FAMILY_ORDER, 'definition.materialDefaults')
  const materialDefaults = Object.fromEntries(
    FAMILY_ORDER.map((family) => {
      const familyDefaults = record(rawDefaults[family], `definition.materialDefaults.${family}`)
      rejectUnknownKeys(familyDefaults, ['color', 'roughness'], `definition.materialDefaults.${family}`)
      const roughness = finite(
        familyDefaults.roughness,
        `definition.materialDefaults.${family}.roughness`
      )
      if (roughness < 0 || roughness > 1) {
        fail(`definition.materialDefaults.${family}.roughness must be inside [0, 1]`)
      }
      return [
        family,
        {
          color: rgb(familyDefaults.color, `definition.materialDefaults.${family}.color`),
          roughness
        }
      ]
    })
  ) as OralAppearanceDefinitionV1['materialDefaults']

  if (!Array.isArray(source.controls) || source.controls.length !== 5) {
    fail('definition.controls must contain exactly five controls')
  }
  const teethColorControl = parseColorControl(
    source.controls[0],
    'teeth_color',
    'definition.controls[0]'
  )
  const teethBrightnessControl = parseNumberControl(
      source.controls[1],
      'teeth_brightness',
      'multiplier',
      'definition.controls[1]'
    )
  const teethShineControl = parseNumberControl(
      source.controls[2],
      'teeth_shine',
      'inverse-roughness',
      'definition.controls[2]'
    )
  const gumColorControl = parseColorControl(
    source.controls[3],
    'gum_color',
    'definition.controls[3]'
  )
  const tongueColorControl = parseColorControl(
    source.controls[4],
    'tongue_color',
    'definition.controls[4]'
  )
  const controls: OralAppearanceControlDefinition[] = [
    teethColorControl,
    teethBrightnessControl,
    teethShineControl,
    gumColorControl,
    tongueColorControl
  ]
  if (!sameRgb(teethColorControl.default, materialDefaults.teeth.color)) {
    fail('Teeth Color default must match the authored teeth material color')
  }
  if (!sameRgb(gumColorControl.default, materialDefaults.gums.color)) {
    fail('Gum Color default must match the authored gum material color')
  }
  if (!sameRgb(tongueColorControl.default, materialDefaults.tongue.color)) {
    fail('Tongue Color default must match the authored tongue material color')
  }
  if (teethBrightnessControl.default !== 1) {
    fail('Teeth Brightness default must preserve authored color')
  }
  if (Math.abs(teethShineControl.default - (1 - materialDefaults.teeth.roughness)) > 1e-9) {
    fail('Teeth Shine default must preserve authored roughness')
  }

  return {
    schemaVersion: ORAL_APPEARANCE_SCHEMA_VERSION,
    stateSchemaVersion: ORAL_APPEARANCE_STATE_SCHEMA_VERSION,
    status: text(source.status, 'definition.status'),
    productExportApproved: false,
    definitionSha256: sha256(source.definitionSha256, 'definition.definitionSha256'),
    ownership: text(source.ownership, 'definition.ownership'),
    defaultLaw: text(source.defaultLaw, 'definition.defaultLaw'),
    compositionOrder: stringList(source.compositionOrder, 'definition.compositionOrder'),
    customTexturePolicy: text(source.customTexturePolicy, 'definition.customTexturePolicy'),
    runtimeBindings,
    materialDefaults,
    controls
  }
}

export function oralAppearanceControl(
  definition: OralAppearanceDefinitionV1,
  id: OralAppearanceColorControlDefinition['id']
): OralAppearanceColorControlDefinition
export function oralAppearanceControl(
  definition: OralAppearanceDefinitionV1,
  id: OralAppearanceNumberControlDefinition['id']
): OralAppearanceNumberControlDefinition
export function oralAppearanceControl(
  definition: OralAppearanceDefinitionV1,
  id: OralAppearanceControlId
): OralAppearanceControlDefinition {
  const found = definition.controls.find((control) => control.id === id)
  if (!found) fail(`definition is missing ${id}`)
  return found
}

export function createDefaultOralAppearanceState(
  definition: OralAppearanceDefinitionV1
): OralAppearanceStateV1 {
  return {
    schemaVersion: ORAL_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    teeth: {
      color: [...oralAppearanceControl(definition, 'teeth_color').default] as OralAppearanceRgb,
      brightness: oralAppearanceControl(definition, 'teeth_brightness').default,
      shine: oralAppearanceControl(definition, 'teeth_shine').default
    },
    gums: {
      color: [...oralAppearanceControl(definition, 'gum_color').default] as OralAppearanceRgb
    },
    tongue: {
      color: [...oralAppearanceControl(definition, 'tongue_color').default] as OralAppearanceRgb
    }
  }
}

export function countChangedOralAppearanceControls(
  definition: OralAppearanceDefinitionV1,
  state: OralAppearanceStateV1
) {
  const parsed = parseOralAppearanceState(definition, state)
  const defaults = createDefaultOralAppearanceState(definition)
  return [
    parsed.teeth.color.some((channel, index) => channel !== defaults.teeth.color[index]),
    parsed.teeth.brightness !== defaults.teeth.brightness,
    parsed.teeth.shine !== defaults.teeth.shine,
    parsed.gums.color.some((channel, index) => channel !== defaults.gums.color[index]),
    parsed.tongue.color.some((channel, index) => channel !== defaults.tongue.color[index])
  ].filter(Boolean).length
}

function boundedNumber(
  definition: OralAppearanceDefinitionV1,
  id: OralAppearanceNumberControlDefinition['id'],
  value: unknown,
  context: string
) {
  const parsed = finite(value, context)
  const control = oralAppearanceControl(definition, id)
  if (parsed < control.minimum || parsed > control.maximum) {
    fail(`${context} must be inside [${control.minimum}, ${control.maximum}]`)
  }
  if (!onStepLattice(parsed, control.minimum, control.step)) {
    fail(`${context} must use the control step lattice`)
  }
  return parsed
}

export function parseOralAppearanceState(
  definition: OralAppearanceDefinitionV1,
  value: unknown
): OralAppearanceStateV1 {
  const source = record(value, 'state')
  rejectUnknownKeys(source, ['schemaVersion', 'definitionSha256', 'teeth', 'gums', 'tongue'], 'state')
  if (source.schemaVersion !== ORAL_APPEARANCE_STATE_SCHEMA_VERSION) {
    fail('state schemaVersion is unsupported')
  }
  if (source.definitionSha256 !== definition.definitionSha256) {
    fail('state definitionSha256 does not match this package')
  }
  const teeth = record(source.teeth, 'state.teeth')
  const gums = record(source.gums, 'state.gums')
  const tongue = record(source.tongue, 'state.tongue')
  rejectUnknownKeys(teeth, ['color', 'brightness', 'shine'], 'state.teeth')
  rejectUnknownKeys(gums, ['color'], 'state.gums')
  rejectUnknownKeys(tongue, ['color'], 'state.tongue')
  return {
    schemaVersion: ORAL_APPEARANCE_STATE_SCHEMA_VERSION,
    definitionSha256: definition.definitionSha256,
    teeth: {
      color: rgb(teeth.color, 'state.teeth.color'),
      brightness: boundedNumber(
        definition,
        'teeth_brightness',
        teeth.brightness,
        'state.teeth.brightness'
      ),
      shine: boundedNumber(definition, 'teeth_shine', teeth.shine, 'state.teeth.shine')
    },
    gums: { color: rgb(gums.color, 'state.gums.color') },
    tongue: { color: rgb(tongue.color, 'state.tongue.color') }
  }
}

export function resolveOralAppearanceState(
  definition: OralAppearanceDefinitionV1,
  value: OralAppearanceStateV1 | null | undefined
) {
  return value
    ? parseOralAppearanceState(definition, value)
    : createDefaultOralAppearanceState(definition)
}

export function reconcileOralAppearanceState(
  definition: OralAppearanceDefinitionV1,
  value: unknown
): OralAppearanceReconciliation {
  if (value == null) return { state: null, incompatible: false }
  try {
    return { state: parseOralAppearanceState(definition, value), incompatible: false }
  } catch (error) {
    return {
      state: null,
      incompatible: true,
      reason:
        error instanceof Error
          ? error.message
          : 'Oral Appearance state is incompatible with this package.'
    }
  }
}

export function updateOralAppearanceColor(
  state: OralAppearanceStateV1,
  id: OralAppearanceColorControlDefinition['id'],
  color: OralAppearanceRgb
): OralAppearanceStateV1 {
  const next: OralAppearanceStateV1 = {
    ...state,
    teeth: { ...state.teeth, color: [...state.teeth.color] },
    gums: { color: [...state.gums.color] },
    tongue: { color: [...state.tongue.color] }
  }
  if (id === 'teeth_color') next.teeth.color = [...color]
  if (id === 'gum_color') next.gums.color = [...color]
  if (id === 'tongue_color') next.tongue.color = [...color]
  return next
}

export function updateOralAppearanceNumber(
  state: OralAppearanceStateV1,
  id: OralAppearanceNumberControlDefinition['id'],
  value: number
): OralAppearanceStateV1 {
  const next: OralAppearanceStateV1 = {
    ...state,
    teeth: { ...state.teeth, color: [...state.teeth.color] },
    gums: { color: [...state.gums.color] },
    tongue: { color: [...state.tongue.color] }
  }
  if (id === 'teeth_brightness') next.teeth.brightness = value
  if (id === 'teeth_shine') next.teeth.shine = value
  return next
}

export function oralAppearanceRgbToHex(value: OralAppearanceRgb) {
  return `#${value
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0'))
    .join('')}`
}

export function oralAppearanceHexToRgb(value: string): OralAppearanceRgb | null {
  if (!/^#[a-f0-9]{6}$/i.test(value)) return null
  return [1, 3, 5].map(
    (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255
  ) as OralAppearanceRgb
}
