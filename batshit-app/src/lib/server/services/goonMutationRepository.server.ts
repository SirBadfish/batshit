import { GOON_RECIPE_OWNER_V2_CONTRACT } from '$lib/goons/recipe'
import type { GoonRecord } from '$lib/types/goons'

export const RECIPE_MANAGED_GOON_FIELDS = [
  'recipe',
  'customAvatar',
  'appearanceDials',
  'facialArtwork',
  'eyeAppearance'
] as const

const IDENTITY_FIELDS = ['id', 'user_id', 'created_at', 'updated_at'] as const

export type GoonMutationErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'RESERVED_FIELD'
  | 'RECIPE_MANAGED_FIELD'
  | 'ATOMIC_UPDATE_UNAVAILABLE'
  | 'CORRUPT_RESULT'

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

const GENERIC_GOON_PATCH_SCRIPT = `
local raw = redis.call('JSON.GET', KEYS[1])
if not raw then
  return 'NOT_FOUND'
end
local current = cjson.decode(raw)
if current['user_id'] ~= ARGV[1] then
  return 'FORBIDDEN'
end
local identityFields = { 'id', 'user_id', 'created_at', 'updated_at' }
local recipe = current['recipe']
local recipeManaged = recipe and recipe['contract'] == '${GOON_RECIPE_OWNER_V2_CONTRACT}'
for index = 3, #ARGV, 2 do
  local field = ARGV[index]
  if not string.match(field, '^[A-Za-z][A-Za-z0-9_]*$') then
    return 'RESERVED_FIELD'
  end
  for _, identityField in ipairs(identityFields) do
    if field == identityField then
      return 'RESERVED_FIELD'
    end
  end
  if field == 'recipe' then
    return 'RESERVED_FIELD'
  end
  if recipeManaged then
    if field == 'customAvatar' or field == 'appearanceDials' or field == 'facialArtwork' or field == 'eyeAppearance' then
      return 'RECIPE_MANAGED_FIELD'
    end
  end
  redis.call('JSON.SET', KEYS[1], '$.' .. field, ARGV[index + 1])
end
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[2])
return redis.call('JSON.GET', KEYS[1])
`

function hasOwn(value: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field)
}

export function assertGenericGoonPatchAllowed(
  existing: Pick<GoonRecord, 'recipe'>,
  updates: Record<string, unknown>
) {
  const reserved = [...IDENTITY_FIELDS, 'recipe'].find((field) => hasOwn(updates, field))
  if (reserved) {
    throw new GoonMutationError(
      'RESERVED_FIELD',
      `The generic Goon update route cannot change reserved field "${reserved}".`,
      400
    )
  }
  if (existing.recipe?.contract !== GOON_RECIPE_OWNER_V2_CONTRACT) return
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
}): Promise<GoonRecord> {
  if (typeof input.client.eval !== 'function') {
    throw new GoonMutationError(
      'ATOMIC_UPDATE_UNAVAILABLE',
      'Redis EVAL is unavailable; the Goon update cannot be applied safely.',
      500
    )
  }
  const updateArguments: string[] = []
  for (const [field, value] of Object.entries(input.updates)) {
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
  const result = await input.client.eval(GENERIC_GOON_PATCH_SCRIPT, {
    keys: [`goon:${input.goonId}`],
    arguments: [
      input.userId,
      JSON.stringify(input.updatedAt),
      ...updateArguments
    ]
  })
  const serialized = String(result)
  if (!serialized.startsWith('{')) throwMutationFailure(serialized)
  const stored = JSON.parse(serialized) as GoonRecord
  if (stored.id !== input.goonId || stored.user_id !== input.userId) {
    throw new GoonMutationError(
      'CORRUPT_RESULT',
      'Atomic Goon persistence returned a mismatched owner or Goon id.',
      500
    )
  }
  return stored
}
