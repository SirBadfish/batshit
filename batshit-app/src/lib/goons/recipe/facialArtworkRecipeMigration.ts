import {
  FACIAL_ARTWORK_ROLE_IDS,
  createDefaultFacialArtworkState,
  parseFacialArtworkDefinition,
  parseFacialArtworkState,
  type FacialArtworkDefinition,
  type FacialArtworkRoleId
} from '../facialArtwork'
import type { AppearanceRecipeSiblingVerifier } from './appearanceRecipeMigrationPlanner'
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256
} from './recipeCanonical'
import {
  LEGACY_FACIAL_ARTWORK_DEFINITION_V5,
  LEGACY_FACIAL_ARTWORK_STATE_V5,
  migrateFacialArtworkStateV5ToV6,
  type FacialArtworkV6MigrationDefinitionBinding,
  type FacialArtworkV6Orientation,
  type FacialArtworkV6RoleTemplateBinding,
  type FacialArtworkV6UploadTemplateBinding
} from './facialArtworkV6StateMigration'
import {
  recipeSiblingStateSha256,
  type RecipeJsonValue,
  type RecipeSiblingStateRecord
} from './recipeContracts'

function clone<T>(value: T): T {
  return JSON.parse(canonicalRecipeString(value)) as T
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${context} must be a non-empty trimmed string.`)
  }
  return value
}

function templateSet(value: unknown, context: string) {
  const raw = record(value, context)
  return {
    id: text(raw.id, `${context}.id`),
    version: text(raw.version, `${context}.version`)
  }
}

type TemplateShape = {
  id: string
  version: string
  canonicalOrientation: 'orientation-neutral' | 'anatomical-left'
  guide: { sha256: string }
  safePaintMask: { sha256: string }
  mirroredHorizontalVariant?: {
    orientation: 'anatomical-right'
    guide: { sha256: string }
    safePaintMask: { sha256: string }
  } | null
}

function templateVariant(
  template: TemplateShape,
  orientation: FacialArtworkV6Orientation,
  guideSha256: unknown,
  maskSha256: unknown
): FacialArtworkV6UploadTemplateBinding {
  return {
    id: template.id,
    version: template.version,
    orientation,
    guideSha256: requireLowercaseSha256(guideSha256, `${template.id} ${orientation} guideSha256`),
    maskSha256: requireLowercaseSha256(maskSha256, `${template.id} ${orientation} maskSha256`)
  }
}

function roleTemplate(
  template: TemplateShape,
  role: FacialArtworkRoleId
): FacialArtworkV6RoleTemplateBinding {
  const variants: FacialArtworkV6UploadTemplateBinding[] = [
    templateVariant(
      template,
      template.canonicalOrientation,
      template.guide.sha256,
      template.safePaintMask.sha256
    )
  ]
  if (template.mirroredHorizontalVariant) {
    variants.push(
      templateVariant(
        template,
        template.mirroredHorizontalVariant.orientation,
        template.mirroredHorizontalVariant.guide.sha256,
        template.mirroredHorizontalVariant.safePaintMask.sha256
      )
    )
  }
  if (template.canonicalOrientation === 'anatomical-left' && variants.length !== 2) {
    throw new Error(`${role} requires an exact anatomical-right template variant.`)
  }
  return { id: template.id, version: template.version, variants }
}

function bindingFromDefinition(
  definition: FacialArtworkDefinition
): FacialArtworkV6MigrationDefinitionBinding {
  const templates = new Map(definition.templates.map((template) => [template.id, template]))
  const roles = new Map(definition.roles.map((role) => [role.id, role]))
  const result = {} as Record<FacialArtworkRoleId, FacialArtworkV6RoleTemplateBinding>
  for (const roleId of FACIAL_ARTWORK_ROLE_IDS) {
    const role = roles.get(roleId)
    if (!role) throw new Error(`Facial Artwork definition is missing ${roleId}.`)
    const template = templates.get(role.template)
    if (!template) throw new Error(`${roleId} references an unknown template.`)
    result[roleId] = roleTemplate(template as TemplateShape, roleId)
  }
  return {
    schemaVersion: definition.schemaVersion,
    stateSchemaVersion: definition.stateSchemaVersion,
    definitionSha256: definition.definitionSha256,
    templateSet: { ...definition.templateSet },
    templates: result
  }
}

function legacyTemplate(value: unknown, context: string): TemplateShape {
  const raw = record(value, context)
  const canonicalOrientation = raw.canonicalOrientation
  if (
    canonicalOrientation !== 'orientation-neutral' &&
    canonicalOrientation !== 'anatomical-left'
  ) {
    throw new Error(`${context}.canonicalOrientation is invalid.`)
  }
  const guide = record(raw.guide, `${context}.guide`)
  const mask = record(raw.safePaintMask, `${context}.safePaintMask`)
  let mirroredHorizontalVariant: TemplateShape['mirroredHorizontalVariant']
  if (raw.mirroredHorizontalVariant !== undefined) {
    const mirror = record(raw.mirroredHorizontalVariant, `${context}.mirroredHorizontalVariant`)
    if (mirror.orientation !== 'anatomical-right') {
      throw new Error(`${context}.mirroredHorizontalVariant.orientation is invalid.`)
    }
    const mirrorGuide = record(mirror.guide, `${context}.mirroredHorizontalVariant.guide`)
    const mirrorMask = record(
      mirror.safePaintMask,
      `${context}.mirroredHorizontalVariant.safePaintMask`
    )
    mirroredHorizontalVariant = {
      orientation: 'anatomical-right',
      guide: {
        sha256: requireLowercaseSha256(
          mirrorGuide.sha256,
          `${context}.mirroredHorizontalVariant.guide.sha256`
        )
      },
      safePaintMask: {
        sha256: requireLowercaseSha256(
          mirrorMask.sha256,
          `${context}.mirroredHorizontalVariant.safePaintMask.sha256`
        )
      }
    }
  }
  return {
    id: text(raw.id, `${context}.id`),
    version: text(raw.version, `${context}.version`),
    canonicalOrientation,
    guide: {
      sha256: requireLowercaseSha256(guide.sha256, `${context}.guide.sha256`)
    },
    safePaintMask: {
      sha256: requireLowercaseSha256(mask.sha256, `${context}.safePaintMask.sha256`)
    },
    ...(mirroredHorizontalVariant ? { mirroredHorizontalVariant } : {})
  }
}

function legacyBinding(value: unknown): FacialArtworkV6MigrationDefinitionBinding {
  const definition = record(value, 'source Facial Artwork definition')
  if (
    definition.schemaVersion !== LEGACY_FACIAL_ARTWORK_DEFINITION_V5 ||
    definition.stateSchemaVersion !== LEGACY_FACIAL_ARTWORK_STATE_V5
  ) {
    throw new Error('Facial Artwork migration source must be the exact v5 contract.')
  }
  if (!Array.isArray(definition.templates) || !Array.isArray(definition.roles)) {
    throw new Error('Source Facial Artwork definition is missing templates or roles.')
  }
  const templates = new Map<string, TemplateShape>()
  for (const [index, value] of definition.templates.entries()) {
    const parsed = legacyTemplate(value, `source Facial Artwork templates[${index}]`)
    if (templates.has(parsed.id))
      throw new Error('Source Facial Artwork template ids must be unique.')
    templates.set(parsed.id, parsed)
  }
  const roles = new Map<string, Record<string, unknown>>()
  for (const [index, value] of definition.roles.entries()) {
    const role = record(value, `source Facial Artwork roles[${index}]`)
    const id = text(role.id, `source Facial Artwork roles[${index}].id`)
    if (roles.has(id)) throw new Error('Source Facial Artwork role ids must be unique.')
    roles.set(id, role)
  }
  if (
    roles.size !== FACIAL_ARTWORK_ROLE_IDS.length ||
    FACIAL_ARTWORK_ROLE_IDS.some((roleId) => !roles.has(roleId))
  ) {
    throw new Error('Source Facial Artwork role inventory does not match v5.')
  }
  const roleBindings = {} as Record<FacialArtworkRoleId, FacialArtworkV6RoleTemplateBinding>
  for (const roleId of FACIAL_ARTWORK_ROLE_IDS) {
    const templateId = text(roles.get(roleId)!.template, `source ${roleId}.template`)
    const template = templates.get(templateId)
    if (!template) throw new Error(`Source ${roleId} references an unknown template.`)
    roleBindings[roleId] = roleTemplate(template, roleId)
  }
  return {
    schemaVersion: LEGACY_FACIAL_ARTWORK_DEFINITION_V5,
    stateSchemaVersion: LEGACY_FACIAL_ARTWORK_STATE_V5,
    definitionSha256: requireLowercaseSha256(
      definition.definitionSha256,
      'source Facial Artwork definitionSha256'
    ),
    templateSet: templateSet(definition.templateSet, 'source Facial Artwork templateSet'),
    templates: roleBindings
  }
}

async function stateRecord(
  id: string,
  definition: FacialArtworkDefinition,
  state: ReturnType<typeof parseFacialArtworkState>
): Promise<RecipeSiblingStateRecord> {
  const serialized = clone(state) as unknown as {
    [key: string]: RecipeJsonValue
  }
  return {
    id,
    contract: definition.stateSchemaVersion,
    definitionSha256: definition.definitionSha256,
    stateSha256: await recipeSiblingStateSha256(serialized),
    state: serialized
  }
}

function rebindCurrentState(
  sourceDefinition: FacialArtworkDefinition,
  targetDefinition: FacialArtworkDefinition,
  targetBinding: FacialArtworkV6MigrationDefinitionBinding,
  value: unknown
) {
  const state = clone(parseFacialArtworkState(sourceDefinition, value))
  const sourceBinding = bindingFromDefinition(sourceDefinition)
  state.definitionSha256 = targetDefinition.definitionSha256
  state.templateSet = { ...targetDefinition.templateSet }
  for (const roleId of FACIAL_ARTWORK_ROLE_IDS) {
    const role = state.roles[roleId]
    const eyes =
      role.mode === 'shared'
        ? [{ side: 'shared' as const, eye: role.shared }]
        : [
            { side: 'left' as const, eye: role.left },
            { side: 'right' as const, eye: role.right }
          ]
    for (const { side, eye } of eyes) {
      if (!eye.artwork) continue
      const orientation = eye.artwork.upload.template.orientation
      const sourceVariant = sourceBinding.templates[roleId].variants.find(
        (candidate) => candidate.orientation === orientation
      )
      const variant = targetBinding.templates[roleId].variants.find(
        (candidate) => candidate.orientation === orientation
      )
      if (!sourceVariant || !variant) {
        throw new Error(`Target Facial Artwork template lacks ${roleId} ${orientation}.`)
      }
      if (
        sourceVariant.guideSha256 !== variant.guideSha256 ||
        sourceVariant.maskSha256 !== variant.maskSha256
      ) {
        const exactTrustedArtwork = targetDefinition.trustedArtwork.entries.some(
          (entry) =>
            entry.role === roleId &&
            entry.side === side &&
            entry.asset.sha256 === eye.artwork!.upload.sha256
        )
        if (!exactTrustedArtwork) {
          eye.artwork = null
          continue
        }
      }
      eye.artwork.upload.template = { ...variant }
    }
  }
  return parseFacialArtworkState(targetDefinition, state)
}

/** Verify the sole v5 -> v6 Facial Artwork Recipe boundary. */
export function createFacialArtworkRecipeSiblingVerifier(
  sourceDefinitionValue: unknown | null,
  targetDefinitionValue: unknown
): AppearanceRecipeSiblingVerifier {
  const sourceSchema =
    sourceDefinitionValue === null
      ? null
      : record(sourceDefinitionValue, 'source Facial Artwork definition').schemaVersion
  const legacySource =
    sourceSchema === LEGACY_FACIAL_ARTWORK_DEFINITION_V5
      ? legacyBinding(sourceDefinitionValue)
      : null
  const currentSource =
    sourceDefinitionValue !== null && sourceSchema === 'facial-artwork/v6'
      ? parseFacialArtworkDefinition(sourceDefinitionValue)
      : null
  if (sourceDefinitionValue !== null && !legacySource && !currentSource) {
    throw new Error('Facial Artwork migration source contract is unsupported.')
  }
  const targetDefinition = parseFacialArtworkDefinition(targetDefinitionValue)
  const target = bindingFromDefinition(targetDefinition)
  return {
    verifierId: 'facial-artwork-state-v5-to-v6',
    verifierVersion: 2,
    async verify(request) {
      if (request.surface !== 'facialArtwork') {
        throw new Error('Facial Artwork verifier received another sibling surface.')
      }
      if (
        request.targetDefinition.contract !== targetDefinition.stateSchemaVersion ||
        request.targetDefinition.definitionSha256 !== targetDefinition.definitionSha256
      ) {
        throw new Error(
          'Facial Artwork verifier target does not match the loaded package definition.'
        )
      }

      const state =
        request.operation === 'reset'
          ? createDefaultFacialArtworkState(targetDefinition)
          : (() => {
              if (!request.sourceState) {
                throw new Error('Facial Artwork migration requires an exact source state.')
              }
              if (request.sourceState.contract === LEGACY_FACIAL_ARTWORK_STATE_V5) {
                if (
                  !legacySource ||
                  request.sourceState.definitionSha256 !== legacySource.definitionSha256
                ) {
                  throw new Error('Facial Artwork migration requires the exact v5 source state.')
                }
                return parseFacialArtworkState(
                  targetDefinition,
                  migrateFacialArtworkStateV5ToV6({
                    source: legacySource,
                    target,
                    state: request.sourceState.state
                  })
                )
              }
              if (
                request.sourceState.contract !== targetDefinition.stateSchemaVersion ||
                !currentSource ||
                request.sourceState.definitionSha256 !== currentSource.definitionSha256
              ) {
                throw new Error('Facial Artwork migration source contract is unsupported.')
              }
              return rebindCurrentState(
                currentSource,
                targetDefinition,
                target,
                request.sourceState.state
              )
            })()
      const proposedState = await stateRecord(request.targetStateId, targetDefinition, state)
      const domainEvidenceSha256 = await canonicalRecipeSha256({
        contract: 'facial-artwork-recipe-migration-evidence/v2',
        operation: request.operation,
        sourceDefinitionSha256:
          legacySource?.definitionSha256 ?? currentSource?.definitionSha256 ?? null,
        sourceContract: request.sourceState?.contract ?? null,
        sourceStateSha256: request.sourceState?.stateSha256 ?? null,
        targetDefinitionSha256: targetDefinition.definitionSha256,
        proposedStateSha256: proposedState.stateSha256,
        templateIdentityLaw:
          'preserve uploads when orientation plus Guide and Mask hashes remain exact, or when the signed target definition proves the exact upload bytes as trusted artwork for that role and side; otherwise clear changed template coordinates for explicit remigration',
        canonicalizedRoleIds: ['iris', 'pupil'],
        reboundTemplateSet: targetDefinition.templateSet
      })
      return {
        proposedState,
        domainEvidenceSha256,
        message:
          request.operation === 'migrate'
            ? request.sourceState?.contract === LEGACY_FACIAL_ARTWORK_STATE_V5
              ? 'Facial Artwork v5 uploads and user choices were preserved while templates and definition-owned transforms migrated exactly to v6.'
              : 'Facial Artwork v6 choices were rebound to the exact updated definition; changed Guide or Mask coordinates preserved only exact signed trusted artwork bytes and cleared every other upload for explicit remigration.'
            : 'Facial Artwork was explicitly reset to the corrected v6 defaults.'
      }
    }
  }
}
