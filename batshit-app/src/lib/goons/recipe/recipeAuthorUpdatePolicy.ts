import type { RecipeMigrationPlan } from './migrationPlanContracts'

export const RECIPE_AUTHOR_UPDATE_POLICY_CONTRACT = 'recipe-author-update-policy/v1' as const

export const SUPPORTED_FIRST_PARTY_RECIPE_BASE_IDS = ['batshit-base-f-v1'] as const

export const RECIPE_AUTHOR_UPDATE_CLASSIFICATIONS = [
  'automatic-appearance-preserving',
  'proven-remap',
  'reset-required',
  'blocked-ineligible'
] as const

export type RecipeAuthorUpdateClassification =
  (typeof RECIPE_AUTHOR_UPDATE_CLASSIFICATIONS)[number]

export const RECIPE_AUTHOR_CHANGE_FAMILIES = [
  'presentation-metadata',
  'textures',
  'materials',
  'equivalent-glb-storage-layout',
  'base-neutral',
  'geometry',
  'topology',
  'vertex-order-count',
  'mesh-node-identities',
  'morph-inventory',
  'stable-control-ids',
  'target-behavior',
  'followers',
  'macros',
  'control-ranges',
  'neutral-meaning',
  'skeleton-hierarchy',
  'bone-identities',
  'bone-rests',
  'inverse-binds',
  'skin-weights',
  'root-grounding',
  'stage-roles',
  'attachments',
  'fit-consumers',
  'runtime-correctives',
  'performance-mappings',
  'eye-definitions',
  'facial-artwork-roles',
  'oral-definitions'
] as const

export type RecipeAuthorChangeFamily = (typeof RECIPE_AUTHOR_CHANGE_FAMILIES)[number]

export const RECIPE_AUTHOR_PROOF_DOMAINS = [
  'source-identities',
  'stable-control-ledger',
  'direct-update-edge',
  'component-map',
  'whole-recipe-physical-proof',
  'semantic-material-proof',
  'sibling-surface-proof',
  'clean-reset-proof',
  'structural-eligibility'
] as const

export type RecipeAuthorProofDomain = (typeof RECIPE_AUTHOR_PROOF_DOMAINS)[number]

export type RecipeAuthorChangeFamilyRule = {
  family: RecipeAuthorChangeFamily
  label: string
  proofDomains: RecipeAuthorProofDomain[]
  automaticWhen: string
  provenRemapWhen: string
  resetRequiredWhen: string
  blockedWhen: string
}

const ALWAYS_REQUIRED: RecipeAuthorProofDomain[] = [
  'source-identities',
  'stable-control-ledger',
  'direct-update-edge',
  'whole-recipe-physical-proof',
  'structural-eligibility'
]

function rule(
  family: RecipeAuthorChangeFamily,
  label: string,
  proofDomains: RecipeAuthorProofDomain[],
  automaticWhen: string,
  provenRemapWhen: string,
  resetRequiredWhen: string,
  blockedWhen: string
): RecipeAuthorChangeFamilyRule {
  return {
    family,
    label,
    proofDomains: [...new Set([...ALWAYS_REQUIRED, ...proofDomains])],
    automaticWhen,
    provenRemapWhen,
    resetRequiredWhen,
    blockedWhen
  }
}

const IDENTITY_AUTOMATIC = 'All exact source, physical, and semantic projections remain equivalent.'
const MAP_REMAP = 'A direct exporter edge supplies an exhaustive stable-id ledger and exact map that Batshit independently verifies.'
const SAFE_RESET = 'The target is a valid supported first-party source, preservation is unproven, and the independently verified clean reset is safe.'
const FAIL_CLOSED = 'Identity, provenance, structure, mapping, or independent proof is missing, ambiguous, unknown, or invalid.'

/**
 * Code-owned Blender/export compatibility matrix for the first supported
 * Recipe author-update contract. A family name never grants compatibility:
 * the verified evidence for one exact source-to-target edge decides the class.
 */
export const RECIPE_AUTHOR_CHANGE_FAMILY_RULES: readonly RecipeAuthorChangeFamilyRule[] = [
  rule('presentation-metadata', 'Presentation metadata', [], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('textures', 'Textures', ['semantic-material-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('materials', 'Materials', ['semantic-material-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('equivalent-glb-storage-layout', 'Equivalent GLB storage or layout', [], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('base-neutral', 'Base neutral', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('geometry', 'Geometry', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('topology', 'Topology', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('vertex-order-count', 'Vertex order or count', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('mesh-node-identities', 'Mesh and node identities', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('morph-inventory', 'Morph inventory', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('stable-control-ids', 'Stable control ids', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('target-behavior', 'Target behavior', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('followers', 'Followers', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('macros', 'Macros', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('control-ranges', 'Control ranges', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('neutral-meaning', 'Neutral meaning', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('skeleton-hierarchy', 'Skeleton hierarchy', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('bone-identities', 'Bone identities', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('bone-rests', 'Bone rests', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('inverse-binds', 'Inverse binds', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('skin-weights', 'Skin weights', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('root-grounding', 'Root and grounding behavior', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('stage-roles', 'Stage roles', ['sibling-surface-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('attachments', 'Attachments', ['sibling-surface-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('fit-consumers', 'Fit consumers', ['sibling-surface-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('runtime-correctives', 'Runtime correctives', ['component-map'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('performance-mappings', 'Performance mappings', ['sibling-surface-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('eye-definitions', 'Eye definitions', ['sibling-surface-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('facial-artwork-roles', 'Facial Artwork roles', ['sibling-surface-proof', 'semantic-material-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED),
  rule('oral-definitions', 'Oral definitions', ['sibling-surface-proof'], IDENTITY_AUTOMATIC, MAP_REMAP, SAFE_RESET, FAIL_CLOSED)
]

export function isSupportedFirstPartyRecipeBase(baseId: string | null | undefined): boolean {
  return SUPPORTED_FIRST_PARTY_RECIPE_BASE_IDS.includes(
    baseId as (typeof SUPPORTED_FIRST_PARTY_RECIPE_BASE_IDS)[number]
  )
}

function planUsesVerifiedRemap(plan: RecipeMigrationPlan): boolean {
  const remappedResolutions = new Set([
    'affine-remapped',
    'piecewise-remapped',
    'component-remapped',
    'alias-source',
    'alias-target',
    'removed-component-remapped'
  ])
  return (
    plan.controlRows.some((row) => remappedResolutions.has(row.resolution)) ||
    plan.siblingRows.some((row) => row.resolution === 'migrated')
  )
}

function planRequiresReset(plan: RecipeMigrationPlan): boolean {
  return (
    plan.controlRows.some((row) => row.resolution === 'reset-to-neutral') ||
    plan.siblingRows.some((row) => row.resolution === 'reset')
  )
}

/**
 * Collapse one verified production migration plan into the four public author
 * classes. The planner remains the proof engine; this policy only names the
 * already-verified result and fails closed when it does not fit the contract.
 */
export function classifyRecipeAuthorUpdatePlan(
  plan: RecipeMigrationPlan
): RecipeAuthorUpdateClassification {
  if (
    !isSupportedFirstPartyRecipeBase(plan.fromSource.identities.baseId) ||
    !isSupportedFirstPartyRecipeBase(plan.toSource.identities.baseId)
  ) {
    return 'blocked-ineligible'
  }

  if (plan.outcome.kind === 'clean-reset') return 'reset-required'

  if (plan.outcome.kind === 'unsupported') {
    return plan.outcome.cleanResetEligibility === 'eligible'
      ? 'reset-required'
      : 'blocked-ineligible'
  }

  const requiresReset = planRequiresReset(plan)
  if (requiresReset || plan.outcome.preservationClaim !== 'appearance-preserved') {
    return requiresReset ? 'reset-required' : 'blocked-ineligible'
  }

  return planUsesVerifiedRemap(plan)
    ? 'proven-remap'
    : 'automatic-appearance-preserving'
}
