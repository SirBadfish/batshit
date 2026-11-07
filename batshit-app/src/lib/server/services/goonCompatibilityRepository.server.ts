import {
  captureGoonCompatibilityBasis, collectGoonCompatibilityMotionFiles, compatibilityOwnerForBasis,
  MAX_COMPATIBILITY_BASIS_BYTES, MAX_COMPATIBILITY_GOONS, MAX_COMPATIBILITY_MOTIONS,
  type GoonCompatibilityBasis
} from '$lib/goons/goonCompatibilityBasis'
import { buildMountedLiveGoonAnimationPlan } from '$lib/goons/mountedLiveGoon'
import { canonicalRecipeString } from '$lib/goons/recipe/recipeCanonical'
import { normalizeGoonsSettings } from '$lib/goons/resolve'
import type { GoonCompatibilityReport, GoonFileRef, GoonRecord, GoonsSettings } from '$lib/types/goons'
import { resolveUploadUrlsForBrowserInPayload } from './batshitServerUrls'
import { normalizeGoonAnimationLibrary } from './goonAnimationLibraryNormalization.server'
import { collectGoonGuardedReferences, CUSTOM_GOON_UPLOAD_GUARD_LUA } from './goonCustomAssetOwnership.server'

export class GoonCompatibilityError extends Error {
  constructor(readonly code: 'COMPATIBILITY_STALE' | 'COMPATIBILITY_UNAVAILABLE' | 'NOT_FOUND', message: string, readonly status: number) {
    super(message)
    this.name = 'GoonCompatibilityError'
  }
}

const unavailable = () => new GoonCompatibilityError(
  'COMPATIBILITY_UNAVAILABLE', 'Compatibility analysis is unavailable. The Goon and its saved choices are unchanged.', 409
)
const stale = () => new GoonCompatibilityError(
  'COMPATIBILITY_STALE', 'The Goon or motion inputs changed before compatibility could be saved.', 409
)

type LeafSnapshot = { key: string; raws: Array<string | null>; type: string; parentType?: string; rootType?: string }

const COMPATIBILITY_PATCH_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
local raw = redis.call('JSON.GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
if raw ~= ARGV[2] then return 'COMPATIBILITY_STALE' end
local current = cjson.decode(raw)
if current.user_id ~= ARGV[1] or current.id ~= ARGV[3] then return 'NOT_FOUND' end
local function unsupportedPublicGoon(value)
  for _, field in ipairs({'anatomyPresence', 'clothingState', 'clothingCloset', 'sphericalEyelid'}) do
    if value[field] ~= nil then return true end
  end
  return (type(value['closet']) == 'table' and value['closet']['clothingPresets'] ~= nil) or
    (type(value['recipe']) == 'table' and value['recipe']['requiredMotionPreparation'] ~= nil)
end
if unsupportedPublicGoon(current) then return 'COMPATIBILITY_UNAVAILABLE' end
if redis.call('EXISTS', 'goon_asset_restore') ~= 0 then return 'COMPATIBILITY_UNAVAILABLE' end
local expectedIds = cjson.decode(ARGV[4])
local members = redis.call('SMEMBERS', KEYS[2])
if #members ~= #expectedIds then return 'COMPATIBILITY_STALE' end
local expected = {}
for _, id in ipairs(expectedIds) do expected[id] = true end
for _, id in ipairs(members) do if not expected[id] then return 'COMPATIBILITY_STALE' end end
local snapshots = cjson.decode(ARGV[5])
local function sameRaw(actual, expected)
  if expected == cjson.null then expected = false end
  return (actual or false) == expected
end
for index, snapshot in ipairs(snapshots) do
  local key = KEYS[index + 2]
  local rawOne
  local rawTwo = false
  local kind
  if snapshot.kind == 'source' then
    rawOne = redis.call('JSON.GET', key, '$.user_id')
    rawTwo = redis.call('JSON.GET', key, '$.files.animations')
    kind = redis.call('JSON.TYPE', key, '$.files')
  elseif snapshot.kind == 'vault' then
    rawOne = redis.call('JSON.GET', key, '$.vrma')
    kind = redis.call('JSON.TYPE', key, '$')
  elseif snapshot.kind == 'settings' then
    rawOne = redis.call('JSON.GET', key, '$.goons_settings.kitchen.cues')
    rawTwo = redis.call('JSON.GET', key, '$.goons_settings.kitchen.emojiMap')
    kind = redis.call('JSON.TYPE', key, '$.goons_settings.kitchen')
    local parent = redis.call('JSON.TYPE', key, '$.goons_settings')
    local root = redis.call('JSON.TYPE', key, '$')
    local parentType = type(parent) == 'table' and parent[1] or ''
    local rootType = type(root) == 'table' and root[1] or ''
    if (parentType or '') ~= snapshot.parentType or (rootType or '') ~= snapshot.rootType then return 'COMPATIBILITY_STALE' end
  else return 'COMPATIBILITY_UNAVAILABLE' end
  local actualType = type(kind) == 'table' and kind[1] or ''
  if actualType == nil then actualType = '' end
  if not sameRaw(rawOne, snapshot.raws[1]) or
    (#snapshot.raws == 2 and not sameRaw(rawTwo, snapshot.raws[2])) or
    actualType ~= snapshot.type then return 'COMPATIBILITY_STALE' end
end
if not customGoonUploadsAvailable(ARGV[8]) then return 'COMPATIBILITY_UNAVAILABLE' end
redis.call('JSON.SET', KEYS[1], '$.compatibility', ARGV[6])
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[7])
return redis.call('JSON.GET', KEYS[1])
`

function validBasis(value: unknown): value is GoonCompatibilityBasis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const basis = value as GoonCompatibilityBasis
  if (!basis.model || !basis.sources || !Array.isArray(basis.sources.goons) ||
    !Array.isArray(basis.sources.shared) || !Array.isArray(basis.goonOrder) ||
    !basis.plan || !Array.isArray(basis.plan.eager) || !Array.isArray(basis.plan.deferred)) return false
  if (basis.goonOrder.length > MAX_COMPATIBILITY_GOONS || basis.sources.goons.length > MAX_COMPATIBILITY_GOONS) return false
  if (basis.plan.eager.length + basis.plan.deferred.length > MAX_COMPATIBILITY_MOTIONS) return false
  if (basis.goonOrder.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))) return false
  let count = basis.sources.shared.length
  for (const source of basis.sources.goons) {
    if (!source || typeof source.id !== 'string' || !Array.isArray(source.animations)) return false
    count += source.animations.length
  }
  if (count > MAX_COMPATIBILITY_MOTIONS) return false
  try { return Buffer.byteLength(canonicalRecipeString(value), 'utf8') <= MAX_COMPATIBILITY_BASIS_BYTES }
  catch { return false }
}

function reportBytes(report: unknown) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || Object.hasOwn(report, 'owner')) throw unavailable()
  const value = report as Record<string, unknown>
  const allowed = new Set(['tier', 'issues', 'hasMouth', 'hasExpressions', 'hasBodyAnimations', 'runtimeBackend', 'boneCoverage', 'animationNames', 'updated_at'])
  if (Object.keys(value).some((key) => !allowed.has(key)) || !['A', 'B', 'C'].includes(String(value.tier))) throw unavailable()
  for (const field of ['issues', 'animationNames']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || !(value[field] as unknown[]).every((item) => typeof item === 'string'))) throw unavailable()
  }
  for (const field of ['hasMouth', 'hasExpressions', 'hasBodyAnimations']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw unavailable()
  }
  if (value.runtimeBackend !== undefined && !['webgpu', 'fallback-webgl2', 'unsupported'].includes(String(value.runtimeBackend))) throw unavailable()
  if (value.updated_at !== undefined && typeof value.updated_at !== 'string') throw unavailable()
  if (value.boneCoverage !== undefined) {
    const coverage = value.boneCoverage as Record<string, unknown> | null
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage) ||
      Object.keys(coverage).some((key) => key !== 'present' && key !== 'total') ||
      typeof coverage.present !== 'number' || typeof coverage.total !== 'number' ||
      !Number.isSafeInteger(coverage.present) || !Number.isSafeInteger(coverage.total) ||
      coverage.present < 0 || coverage.total < coverage.present) throw unavailable()
  }
  try {
    const text = canonicalRecipeString(report)
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024) throw unavailable()
    return text
  } catch (error) {
    if (error instanceof GoonCompatibilityError) throw error
    throw unavailable()
  }
}

async function rawJson(client: any, key: string, ...paths: string[]) {
  const raw = await client.sendCommand(['JSON.GET', key, ...paths])
  if (raw !== null && typeof raw !== 'string') throw unavailable()
  return raw as string | null
}

async function jsonType(client: any, key: string, path: string) {
  const value = await client.sendCommand(['JSON.TYPE', key, path])
  if (value === null || (Array.isArray(value) && value.length === 0)) return ''
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') throw unavailable()
  return value[0] as string
}

function arrayPath(raw: string | null) {
  if (raw === null) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw unavailable() }
  if (!Array.isArray(parsed)) throw unavailable()
  if (parsed.length === 0) return undefined
  if (parsed.length !== 1) throw unavailable()
  return parsed[0]
}

/** Write only a report whose exact producer inputs are still current at EVAL. */
export async function writeOwnedGoonCompatibilityForClient(input: {
  client: any; userId: string; goonId: string; basis: unknown; report: unknown; updatedAt: string
}): Promise<GoonRecord> {
  const { client, userId, goonId, updatedAt, basis: callerBasis, report: callerReport } = input
  if (typeof client.sendCommand !== 'function' || typeof client.eval !== 'function' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(userId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(goonId) ||
    typeof updatedAt !== 'string' || !updatedAt || !validBasis(callerBasis)) throw unavailable()
  // Own the checked JSON before the first Redis await. HTTP callers are
  // already isolated, but direct callers may retain and mutate their objects.
  let expected: GoonCompatibilityBasis
  let report: GoonCompatibilityReport
  try {
    expected = JSON.parse(canonicalRecipeString(callerBasis)) as GoonCompatibilityBasis
    report = JSON.parse(reportBytes(callerReport)) as GoonCompatibilityReport
  } catch { throw unavailable() }
  if (!validBasis(expected)) throw unavailable()
  reportBytes(report)
  if (expected.model.id !== goonId || expected.model.userId !== userId) throw stale()
  const targetKey = `goon:${goonId}`
  const rawTarget = await rawJson(client, targetKey)
  if (!rawTarget) throw new GoonCompatibilityError('NOT_FOUND', 'Goon not found.', 404)
  if (Buffer.byteLength(rawTarget, 'utf8') > MAX_COMPATIBILITY_BASIS_BYTES) throw unavailable()
  let target: GoonRecord
  try { target = JSON.parse(rawTarget) as GoonRecord } catch { throw unavailable() }
  if (!target || target.id !== goonId || target.user_id !== userId) throw new GoonCompatibilityError('NOT_FOUND', 'Goon not found.', 404)
  const targetFields = target as unknown as Record<string, unknown>
  if (['anatomyPresence', 'clothingState', 'clothingCloset', 'sphericalEyelid'].some(field => Object.hasOwn(targetFields, field)) ||
      target.closet && typeof target.closet === 'object' && Object.hasOwn(target.closet, 'clothingPresets') ||
      target.recipe && typeof target.recipe === 'object' && Object.hasOwn(target.recipe, 'requiredMotionPreparation')) throw unavailable()

  const indexKey = `user:${userId}:goons`
  const ids: string[] = await client.sMembers(indexKey)
  if (!Array.isArray(ids) || ids.length > MAX_COMPATIBILITY_GOONS ||
    ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))) throw unavailable()
  const orderedIds = expected.goonOrder
  if (new Set(orderedIds).size !== orderedIds.length || ids.length !== orderedIds.length ||
    ids.some((id) => !orderedIds.includes(id))) throw stale()

  const snapshots: Array<LeafSnapshot & { kind: 'source' | 'vault' | 'settings' }> = []
  const sourceMap = new Map<string, GoonRecord>()
  let rawBytes = Buffer.byteLength(rawTarget, 'utf8')
  let motionCount = 0
  for (const id of ids) {
    const key = `goon:${id}`
    const userRaw = await rawJson(client, key, '$.user_id')
    const animationsRaw = await rawJson(client, key, '$.files.animations')
    const type = await jsonType(client, key, '$.files')
    rawBytes += Buffer.byteLength(userRaw ?? '', 'utf8') + Buffer.byteLength(animationsRaw ?? '', 'utf8')
    if (rawBytes > MAX_COMPATIBILITY_BASIS_BYTES || !['object', '', 'null'].includes(type)) throw unavailable()
    if (arrayPath(userRaw) !== userId) throw unavailable()
    const animations = arrayPath(animationsRaw)
    if (animations != null && !Array.isArray(animations)) throw unavailable()
    motionCount += Array.isArray(animations) ? animations.length : 0
    if (motionCount > MAX_COMPATIBILITY_MOTIONS) throw unavailable()
    sourceMap.set(id, { id, user_id: userId, files: { animations: (animations ?? []) as GoonFileRef[] } } as GoonRecord)
    snapshots.push({ kind: 'source', key, raws: [userRaw, animationsRaw], type })
  }

  const vaultKey = `user:${userId}:goons_animation_library`
  const vaultRaw = await rawJson(client, vaultKey, '$.vrma')
  const vaultType = await jsonType(client, vaultKey, '$')
  rawBytes += Buffer.byteLength(vaultRaw ?? '', 'utf8')
  if (rawBytes > MAX_COMPATIBILITY_BASIS_BYTES) throw unavailable()
  if (vaultType !== '' && vaultType !== 'object') throw unavailable()
  const vaultFiles = arrayPath(vaultRaw)
  if (vaultType === 'object' && vaultFiles === undefined) throw unavailable()
  if (vaultFiles !== undefined && !Array.isArray(vaultFiles)) throw unavailable()
  motionCount += Array.isArray(vaultFiles) ? vaultFiles.length : 0
  if (motionCount > MAX_COMPATIBILITY_MOTIONS) throw unavailable()
  const shared = resolveUploadUrlsForBrowserInPayload(normalizeGoonAnimationLibrary({ vrma: vaultFiles ?? [] })).vrma
  snapshots.push({ kind: 'vault', key: vaultKey, raws: [vaultRaw], type: vaultType })

  const settingsKey = `user:${userId}:settings`
  const cuesRaw = await rawJson(client, settingsKey, '$.goons_settings.kitchen.cues')
  const emojiRaw = await rawJson(client, settingsKey, '$.goons_settings.kitchen.emojiMap')
  rawBytes += Buffer.byteLength(cuesRaw ?? '', 'utf8') + Buffer.byteLength(emojiRaw ?? '', 'utf8')
  if (rawBytes > MAX_COMPATIBILITY_BASIS_BYTES) throw unavailable()
  const settingsType = await jsonType(client, settingsKey, '$.goons_settings.kitchen')
  const settingsParentType = await jsonType(client, settingsKey, '$.goons_settings')
  const settingsRootType = await jsonType(client, settingsKey, '$')
  if (settingsRootType !== '' && settingsRootType !== 'object') throw unavailable()
  if (settingsParentType !== '' && settingsParentType !== 'object' && settingsParentType !== 'null') throw unavailable()
  if (settingsType !== '' && settingsType !== 'object' && settingsType !== 'null') throw unavailable()
  const cues = arrayPath(cuesRaw)
  const emojiMap = arrayPath(emojiRaw)
  let settings: GoonsSettings
  try { settings = normalizeGoonsSettings({ kitchen: { cues, emojiMap } } as unknown as GoonsSettings) } catch { throw unavailable() }
  snapshots.push({ kind: 'settings', key: settingsKey, raws: [cuesRaw, emojiRaw], type: settingsType, parentType: settingsParentType, rootType: settingsRootType })

  const browserTarget = resolveUploadUrlsForBrowserInPayload(target)
  const ordered = orderedIds.map((id) => resolveUploadUrlsForBrowserInPayload(sourceMap.get(id)!))
  const files = collectGoonCompatibilityMotionFiles(ordered, shared)
  const plan = buildMountedLiveGoonAnimationPlan(browserTarget, files, settings)
  let actual: GoonCompatibilityBasis
  try { actual = captureGoonCompatibilityBasis(browserTarget, ordered, shared, plan) } catch { throw unavailable() }
  if (canonicalRecipeString(actual) !== canonicalRecipeString(expected)) throw stale()
  const stamped = { ...report, owner: compatibilityOwnerForBasis(actual) }
  const guardedReferences = await collectGoonGuardedReferences({ compatibility: stamped }, userId)
  const args = [userId, rawTarget, goonId, JSON.stringify(ids), JSON.stringify(snapshots), JSON.stringify(stamped), JSON.stringify(updatedAt), JSON.stringify(guardedReferences)]
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_COMPATIBILITY_BASIS_BYTES) throw unavailable()
  const result = await client.eval(COMPATIBILITY_PATCH_SCRIPT, {
    keys: [targetKey, indexKey, ...snapshots.map((snapshot) => snapshot.key)], arguments: args
  })
  const serialized = String(result)
  if (serialized === 'NOT_FOUND') throw new GoonCompatibilityError('NOT_FOUND', 'Goon not found.', 404)
  if (serialized === 'COMPATIBILITY_STALE') throw stale()
  if (serialized === 'COMPATIBILITY_UNAVAILABLE') throw unavailable()
  if (!serialized.startsWith('{')) throw unavailable()
  const stored = JSON.parse(serialized) as GoonRecord
  if (stored.id !== goonId || stored.user_id !== userId) throw unavailable()
  return stored
}
