import { GOON_RECIPE_OWNER_V2_CONTRACT } from '$lib/goons/recipe'
import { RECIPE_MANAGED_GOON_FIELDS } from '$lib/goons/recipe/recipeManagedGoonFields'
import { captureGoonCompatibilityResetBasis, isGoonCompatibilityModelReplacement } from '$lib/goons/goonCompatibilityBasis'
import { canonicalRecipeString } from '$lib/goons/recipe/recipeCanonical'
import {
  FIRST_PARTY_RECIPE_PREPARATION_BASE_IDS,
  RECOGNIZED_FIRST_PARTY_RECIPE_SOURCE_PAIRS,
  requiresFirstPartyRecipePreparation,
  isRecognizedFirstPartyRecipeSourcePair
} from '$lib/goons/recipe/recipeAuthorUpdatePolicy'
import type { GoonRecord } from '$lib/types/goons'
import { resolveUploadUrlsForBrowserInPayload } from './batshitServerUrls'
import {
  collectGoonGuardedReferences,
  CUSTOM_GOON_UPLOAD_GUARD_LUA
} from './goonCustomAssetOwnership.server'

export { RECIPE_MANAGED_GOON_FIELDS }
export { GoonCompatibilityError, writeOwnedGoonCompatibilityForClient } from './goonCompatibilityRepository.server'

const IDENTITY_FIELDS = ['id', 'user_id', 'created_at', 'updated_at'] as const

const RECIPE_MANAGED_FIELD_LUA_CONDITION = RECIPE_MANAGED_GOON_FIELDS
  .slice(1)
  .map((field) => `field == '${field}'`)
  .join(' or ')
const FIRST_PARTY_SOURCE_PAIR_LUA_CONDITION = RECOGNIZED_FIRST_PARTY_RECIPE_SOURCE_PAIRS
  .map(({ baseId, fitFamily }) => `(source.baseId == ${JSON.stringify(baseId)} and source.fitFamily == ${JSON.stringify(fitFamily)})`)
  .join(' or ')
const FIRST_PARTY_PREPARATION_BASE_LUA_CONDITION = FIRST_PARTY_RECIPE_PREPARATION_BASE_IDS
  .map((baseId) => `summary.baseId == ${JSON.stringify(baseId)}`)
  .join(' or ')

export type GoonMutationErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'RESERVED_FIELD'
  | 'RECIPE_MANAGED_FIELD'
  | 'RECIPE_SOURCE_ROUTING'
  | 'ATOMIC_UPDATE_UNAVAILABLE'
  | 'ALREADY_EXISTS'
  | 'ASSET_UNAVAILABLE'
  | 'CORRUPT_RESULT'
  | 'COMPATIBILITY_OWNER_REQUIRED'
  | 'COMPATIBILITY_STALE'

export class GoonMutationError extends Error {
  constructor(
    readonly code: GoonMutationErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GoonMutationError'
  }
}

const UNSUPPORTED_PUBLIC_GOON_FIELDS = ['anatomyPresence', 'clothingState', 'clothingCloset', 'sphericalEyelid'] as const
function assertSupportedPublicGoonFields(value: Record<string, unknown>) {
  if (UNSUPPORTED_PUBLIC_GOON_FIELDS.some(field => Object.hasOwn(value, field)) ||
      value.closet && typeof value.closet === 'object' && Object.hasOwn(value.closet, 'clothingPresets') ||
      value.recipe && typeof value.recipe === 'object' && Object.hasOwn(value.recipe, 'requiredMotionPreparation')) {
    throw new GoonMutationError('RESERVED_FIELD', 'This Goon contains fields this release does not support. Nothing was saved.', 400)
  }
}

/** Neutral exact RAW owner read, copied from the existing validated boundary;
 * it imports no Clothing ledger or recovery behavior. */
export async function readOwnedGoonRawForClient(client: any, userId: string, goonId: string) {
  if (![userId, goonId].every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))) throw new GoonMutationError('NOT_FOUND', 'Goon ownership identity is invalid.', 404)
  const key = 'goon:' + goonId
  const raw: string | null = typeof client.sendCommand === 'function' ? await client.sendCommand(['JSON.GET', key]) : JSON.stringify(await client.json.get(key))
  if (!raw || raw === 'null') throw new GoonMutationError('NOT_FOUND', 'Goon not found.', 404)
  const goon = JSON.parse(raw) as GoonRecord
  if (!goon || goon.id !== goonId || goon.user_id !== userId) throw new GoonMutationError('FORBIDDEN', 'The Goon belongs to another user.', 403)
  assertSupportedPublicGoonFields(goon as unknown as Record<string, unknown>)
  return { key, raw, goon }
}

const GENERIC_GOON_PATCH_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
local raw = redis.call('JSON.GET', KEYS[1])
if not raw then
  return 'NOT_FOUND'
end
local current = cjson.decode(raw)
if current['user_id'] ~= ARGV[1] then
  return 'FORBIDDEN'
end
local function unsupportedPublicGoon(value)
  for _, field in ipairs({'anatomyPresence', 'clothingState', 'clothingCloset', 'sphericalEyelid'}) do
    if value[field] ~= nil then return true end
  end
  return (type(value['closet']) == 'table' and value['closet']['clothingPresets'] ~= nil) or
    (type(value['recipe']) == 'table' and value['recipe']['requiredMotionPreparation'] ~= nil)
end
if unsupportedPublicGoon(current) then return 'RESERVED_FIELD' end
if ARGV[#ARGV - 1] ~= '' and raw ~= ARGV[#ARGV - 1] then
  if ARGV[3] == 'compatibility-reset' then return 'COMPATIBILITY_STALE' end
  return 'ASSET_UNAVAILABLE'
end
local identityFields = { 'id', 'user_id', 'created_at', 'updated_at' }
local recipe = current['recipe']
local recipeManaged = type(recipe) == 'table' and recipe['contract'] == '${GOON_RECIPE_OWNER_V2_CONTRACT}'
local source = recipeManaged and type(recipe.authoringRevision) == 'table' and
  type(recipe.authoringRevision.source) == 'table' and recipe.authoringRevision.source.identities
local firstPartySource = type(source) == 'table' and (${FIRST_PARTY_SOURCE_PAIR_LUA_CONDITION})
local avatar = current['customAvatar']
local summary = type(avatar) == 'table' and avatar['manifestSummary']
local firstPartyPreparing = not recipeManaged and current['sourceProfile'] == 'expert-custom-glb' and
  type(summary) == 'table' and (summary.baseId == 'batshit-base-m-v1' or
    (summary.recipeReady == true and (${FIRST_PARTY_PREPARATION_BASE_LUA_CONDITION})))
for index = 4, #ARGV - 2, 2 do
  local field = ARGV[index]
  if not string.match(field, '^[A-Za-z][A-Za-z0-9_]*$') then
    return 'RESERVED_FIELD'
  end
  for _, identityField in ipairs(identityFields) do
    if field == identityField then
      return 'RESERVED_FIELD'
    end
  end
  if field == 'recipe' or field == 'anatomyPresence' or field == 'clothingState' or field == 'clothingCloset' or field == 'sphericalEyelid' then
    return 'RESERVED_FIELD'
  end
  if field == 'closet' then
    local proposed = cjson.decode(ARGV[index + 1])
    if type(proposed) == 'table' and proposed['clothingPresets'] ~= nil then return 'RESERVED_FIELD' end
  end
  if field == 'compatibility' then
    if ARGV[3] ~= 'compatibility-reset' then return 'COMPATIBILITY_OWNER_REQUIRED' end
    local pending = cjson.decode(ARGV[index + 1])
    local message = current.sourceProfile == 'guided-custom-vrm' and
      'Awaiting Advanced/Blender Goon analysis' or 'Awaiting VRM analysis'
    if type(pending) ~= 'table' or pending.tier ~= 'pending' or type(pending.issues) ~= 'table' or
      #pending.issues ~= 1 or pending.issues[1] ~= message then return 'COMPATIBILITY_OWNER_REQUIRED' end
    for key, _ in pairs(pending) do if key ~= 'tier' and key ~= 'issues' then return 'COMPATIBILITY_OWNER_REQUIRED' end end
    local nextFiles = nil
    local nextGuided = current.guidedAvatar
    for nextIndex = 4, #ARGV - 2, 2 do
      if ARGV[nextIndex] == 'files' then nextFiles = cjson.decode(ARGV[nextIndex + 1]) end
      if ARGV[nextIndex] == 'guidedAvatar' then nextGuided = cjson.decode(ARGV[nextIndex + 1]) end
    end
    local function fileUrl(files, field)
      if type(files) ~= 'table' then return '' end
      if type(files[field]) == 'table' and type(files[field].url) == 'string' then return files[field].url end
      return ''
    end
    local function manifestUrl(guided)
      if type(guided) == 'table' and type(guided.manifest) == 'table' and type(guided.manifest.url) == 'string' then return guided.manifest.url end
      return ''
    end
    if current.kind == 'custom' or type(nextFiles) ~= 'table' or
      (fileUrl(current.files, 'vrm') == fileUrl(nextFiles, 'vrm') and
       fileUrl(current.files, 'vrmPending') == fileUrl(nextFiles, 'vrmPending') and
       manifestUrl(current.guidedAvatar) == manifestUrl(nextGuided)) then
      return 'COMPATIBILITY_OWNER_REQUIRED'
    end
  end
  if (firstPartySource or firstPartyPreparing) and (field == 'kind' or field == 'sourceProfile') and
      cjson.decode(ARGV[index + 1]) ~= current[field] then
    return 'RECIPE_SOURCE_ROUTING'
  end
  if not recipeManaged and field == 'customAvatar' then
    local proposed = cjson.decode(ARGV[index + 1])
    local existingPackage = current['sourceProfile'] == 'expert-custom-glb' and
      type(avatar) == 'table' and avatar.package ~= nil and avatar.package ~= cjson.null
    local proposedPackage = type(proposed) == 'table' and proposed.package ~= nil and proposed.package ~= cjson.null
    if existingPackage or proposedPackage then return 'RECIPE_MANAGED_FIELD' end
  end
  if recipeManaged then
    if ${RECIPE_MANAGED_FIELD_LUA_CONDITION} then
      return 'RECIPE_MANAGED_FIELD'
    end
  end
end
if not customGoonUploadsAvailable(ARGV[#ARGV]) then
  return 'ASSET_UNAVAILABLE'
end
for index = 4, #ARGV - 2, 2 do
  local field = ARGV[index]
  redis.call('JSON.SET', KEYS[1], '$.' .. field, ARGV[index + 1])
end
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[2])
return redis.call('JSON.GET', KEYS[1])
`

const CREATE_GOON_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 'ALREADY_EXISTS'
end
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'set' then return 'CORRUPT_INDEX' end
if ARGV[4] ~= '' and redis.call('JSON.GET', KEYS[3]) ~= ARGV[4] then return 'ASSET_UNAVAILABLE' end
if not customGoonUploadsAvailable(ARGV[3]) then
  return 'ASSET_UNAVAILABLE'
end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
return 'CREATED'
`

function hasOwn(value: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field)
}

export function assertGenericGoonPatchAllowed(
  existing: Pick<GoonRecord, 'recipe' | 'kind' | 'sourceProfile' | 'customAvatar'>,
  updates: Record<string, unknown>
) {
  assertSupportedPublicGoonFields(existing as unknown as Record<string, unknown>)
  assertSupportedPublicGoonFields(updates)
  if (hasOwn(updates, 'compatibility')) {
    throw new GoonMutationError('COMPATIBILITY_OWNER_REQUIRED',
      'Compatibility reports require their captured Goon and motion owner.', 409)
  }
  const reserved = [...IDENTITY_FIELDS, 'recipe', 'clothingCloset'].find((field) => hasOwn(updates, field))
  if (reserved) {
    throw new GoonMutationError(
      'RESERVED_FIELD',
      `The generic Goon update route cannot change reserved field "${reserved}".`,
      400
    )
  }
  if (existing.recipe?.contract !== GOON_RECIPE_OWNER_V2_CONTRACT) {
    const summary = existing.customAvatar?.manifestSummary
    const preparing = existing.sourceProfile === 'expert-custom-glb' && requiresFirstPartyRecipePreparation(summary)
    if (preparing && (['kind', 'sourceProfile'] as const).some(
      (field) => hasOwn(updates, field) && updates[field] !== existing[field]
    )) {
      throw new GoonMutationError('RECIPE_SOURCE_ROUTING',
        'This Goon’s kind and source profile are fixed while its first preparation is pending.', 409)
    }
    const proposed = updates.customAvatar
    const proposedPackage = proposed && typeof proposed === 'object' && !Array.isArray(proposed) &&
      (proposed as Record<string, unknown>).package != null
    if (hasOwn(updates, 'customAvatar') &&
        ((existing.sourceProfile === 'expert-custom-glb' && existing.customAvatar?.package != null) || proposedPackage)) {
      throw new GoonMutationError('RECIPE_MANAGED_FIELD',
        'A Goon package cannot be replaced through the generic update route.', 409)
    }
    return
  }
  // The durable Source owns first-party routing. A cached manifest summary
  // and the caller's requested profile cannot change that authority.
  const source = existing.recipe.authoringRevision?.source?.identities
  const firstPartySource = isRecognizedFirstPartyRecipeSourcePair(source)
  if (firstPartySource && (['kind', 'sourceProfile'] as const).some(
    (field) => hasOwn(updates, field) && updates[field] !== existing[field]
  )) {
    throw new GoonMutationError(
      'RECIPE_SOURCE_ROUTING',
      'This first-party Goon’s kind and source profile are fixed by its Recipe Source.',
      409
    )
  }
  const managed = RECIPE_MANAGED_GOON_FIELDS.slice(1).find((field) => hasOwn(updates, field))
  if (managed) {
    throw new GoonMutationError(
      'RECIPE_MANAGED_FIELD',
      `Field "${managed}" belongs to the durable Recipe workflow. Analyze and commit a Recipe update instead.`,
      409
    )
  }
}

function throwMutationFailure(code: string): never {
  if (code === 'ALREADY_EXISTS') {
    throw new GoonMutationError('ALREADY_EXISTS', 'A Goon with this id already exists.', 409)
  }
  if (code === 'ASSET_UNAVAILABLE') {
    throw new GoonMutationError(
      'ASSET_UNAVAILABLE',
      'A custom Goon asset is unavailable or being deleted. Reload before retrying.',
      409
    )
  }
  if (code === 'NOT_FOUND') {
    throw new GoonMutationError('NOT_FOUND', 'Goon not found.', 404)
  }
  if (code === 'FORBIDDEN') {
    throw new GoonMutationError('FORBIDDEN', 'The Goon belongs to another user.', 403)
  }
  if (code === 'RESERVED_FIELD') {
    throw new GoonMutationError('RESERVED_FIELD', 'The update contains a reserved Goon field.', 400)
  }
  if (code === 'RECIPE_MANAGED_FIELD') {
    throw new GoonMutationError(
      'RECIPE_MANAGED_FIELD',
      'The update contains a Recipe-managed field. Analyze and commit a Recipe update instead.',
      409
    )
  }
  if (code === 'RECIPE_SOURCE_ROUTING') {
    throw new GoonMutationError(
      'RECIPE_SOURCE_ROUTING',
      'This first-party Goon’s kind and source profile are fixed by its Recipe Source.',
      409
    )
  }
  if (code === 'COMPATIBILITY_OWNER_REQUIRED' || code === 'COMPATIBILITY_STALE') {
    throw new GoonMutationError(code, 'Compatibility inputs changed or were not supplied. Reload before retrying.', 409)
  }
  throw new GoonMutationError(
    'CORRUPT_RESULT',
    `Atomic Goon persistence returned an unsupported result: ${code}`,
    500
  )
}

export async function patchOwnedGoonForClient(input: {
  client: any
  userId: string
  goonId: string
  updates: Record<string, unknown>
  updatedAt: string
  compatibilityResetBasis?: unknown
}): Promise<GoonRecord> {
  const { client, userId, goonId, updatedAt, updates: callerUpdates, compatibilityResetBasis: callerResetBasis } = input
  if (typeof client.eval !== 'function') {
    throw new GoonMutationError(
      'ATOMIC_UPDATE_UNAVAILABLE',
      'Redis EVAL is unavailable; the Goon update cannot be applied safely.',
      500
    )
  }
  assertSupportedPublicGoonFields(callerUpdates)
  if (Object.hasOwn(callerUpdates, 'compatibility')) {
    throw new GoonMutationError('COMPATIBILITY_OWNER_REQUIRED', 'Compatibility reports require their captured owner.', 409)
  }
  // Own exactly the values that will be written and reference-checked before
  // any asynchronous read. Direct callers can retain their input objects.
  let updates: Record<string, unknown> = Object.create(null)
  for (const [field, value] of Object.entries(callerUpdates)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
      throw new GoonMutationError('RESERVED_FIELD', `Invalid Goon field name "${field}".`, 400)
    }
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new GoonMutationError('RESERVED_FIELD', `Goon field "${field}" cannot contain an undefined value.`, 400)
    updates[field] = JSON.parse(serialized)
  }
  let resetBasis: unknown = undefined
  if (callerResetBasis !== undefined) {
    try { resetBasis = JSON.parse(canonicalRecipeString(callerResetBasis)) }
    catch { throw new GoonMutationError('COMPATIBILITY_STALE', 'The Goon model update basis is invalid.', 409) }
  }
  const observed = await readOwnedGoonRawForClient(client, userId, goonId)
  let expectedRaw = ''
  let reset = false
  if (resetBasis !== undefined) {
    const browserGoon = resolveUploadUrlsForBrowserInPayload(observed.goon)
    try {
      if (canonicalRecipeString(resetBasis) !== canonicalRecipeString(captureGoonCompatibilityResetBasis(browserGoon))) {
        throw new GoonMutationError('COMPATIBILITY_STALE', 'The Goon changed before its model update.', 409)
      }
    } catch (error) {
      if (error instanceof GoonMutationError) throw error
      throw new GoonMutationError('COMPATIBILITY_STALE', 'The Goon model update basis is invalid.', 409)
    }
    const files = updates.files
    if (observed.goon.kind === 'custom' || !files || typeof files !== 'object' || Array.isArray(files)) {
      throw new GoonMutationError('COMPATIBILITY_OWNER_REQUIRED', 'A compatibility reset requires a VRM model replacement.', 409)
    }
    const nextFiles = files as GoonRecord['files']
    const nextUrl = nextFiles.vrm?.url ?? ''
    const nextPending = nextFiles.vrmPending?.url ?? ''
    const nextGuided = updates.guidedAvatar as GoonRecord['guidedAvatar'] | undefined
    const nextManifest = Object.hasOwn(updates, 'guidedAvatar')
      ? nextGuided?.manifest?.url ?? '' : observed.goon.guidedAvatar?.manifest?.url ?? ''
    if ((!nextUrl && !nextPending && !nextManifest) ||
      !isGoonCompatibilityModelReplacement(observed.goon, updates as Partial<GoonRecord>)) {
      throw new GoonMutationError('COMPATIBILITY_OWNER_REQUIRED', 'A compatibility reset requires a changed model.', 409)
    }
    updates = { ...updates, compatibility: {
      tier: 'pending', issues: [observed.goon.sourceProfile === 'guided-custom-vrm'
        ? 'Awaiting Advanced/Blender Goon analysis' : 'Awaiting VRM analysis']
    } }
    expectedRaw = observed.raw
    reset = true
  }
  const updateArguments: string[] = []
  for (const [field, value] of Object.entries(updates)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
      throw new GoonMutationError('RESERVED_FIELD', `Invalid Goon field name "${field}".`, 400)
    }
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new GoonMutationError(
        'RESERVED_FIELD',
        `Goon field "${field}" cannot contain an undefined value.`,
        400
      )
    }
    updateArguments.push(field, serialized)
  }
  const result = await client.eval(GENERIC_GOON_PATCH_SCRIPT, {
    keys: [`goon:${goonId}`],
    arguments: [
      userId,
      JSON.stringify(updatedAt),
      reset ? 'compatibility-reset' : '',
      ...updateArguments,
      expectedRaw,
      JSON.stringify(await collectGoonGuardedReferences(updates, userId))
    ]
  })
  const serialized = String(result)
  if (!serialized.startsWith('{')) throwMutationFailure(serialized)
  const stored = JSON.parse(serialized) as GoonRecord
  if (stored.id !== goonId || stored.user_id !== userId) {
    throw new GoonMutationError(
      'CORRUPT_RESULT',
      'Atomic Goon persistence returned a mismatched owner or Goon id.',
      500
    )
  }
  return stored
}

export async function createOwnedGoonForClient(input: {
  client: any; userId: string; goon: GoonRecord; duplicateSource?: { goonId: string; raw: string }
}): Promise<GoonRecord> {
  const { client, userId } = input
  const duplicateSource = input.duplicateSource && { goonId: input.duplicateSource.goonId, raw: input.duplicateSource.raw }
  let goon: GoonRecord
  try { goon = JSON.parse(JSON.stringify(input.goon)) as GoonRecord }
  catch { throw new GoonMutationError('CORRUPT_RESULT', 'Goon creation received an invalid record.', 500) }
  if (!goon || goon.user_id !== userId || !goon.id) throw new GoonMutationError('CORRUPT_RESULT', 'Goon creation received a mismatched owner or id.', 500)
  assertSupportedPublicGoonFields(goon as unknown as Record<string, unknown>)
  if (typeof client.eval !== 'function') throw new GoonMutationError('ATOMIC_UPDATE_UNAVAILABLE', 'Redis EVAL is unavailable; the Goon cannot be created safely.', 500)
  if (goon.recipe?.contract === GOON_RECIPE_OWNER_V2_CONTRACT) throw new GoonMutationError('RECIPE_MANAGED_FIELD', 'This Goon must be copied through its Recipe workflow.', 409)
  if (duplicateSource) {
    let source: GoonRecord
    try { source = JSON.parse(duplicateSource.raw) as GoonRecord }
    catch { throw new GoonMutationError('CORRUPT_RESULT', 'The duplicate source is invalid.', 500) }
    if (!source || source.id !== duplicateSource.goonId || source.user_id !== userId) throw new GoonMutationError('FORBIDDEN', 'The duplicate source does not belong to this user.', 403)
    assertSupportedPublicGoonFields(source as unknown as Record<string, unknown>)
    if (source.recipe?.contract === GOON_RECIPE_OWNER_V2_CONTRACT) throw new GoonMutationError('RECIPE_MANAGED_FIELD', 'This Goon must be copied through its Recipe workflow.', 409)
  }
  const result = await client.eval(CREATE_GOON_SCRIPT, {
    keys: ['goon:' + goon.id, 'user:' + userId + ':goons', 'goon:' + (duplicateSource?.goonId ?? goon.id)],
    arguments: [JSON.stringify(goon), goon.id, JSON.stringify(await collectGoonGuardedReferences(goon, userId)), duplicateSource?.raw ?? '']
  })
  if (result !== 'CREATED') throwMutationFailure(String(result))
  return goon
}
