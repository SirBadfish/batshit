import { loadHairBuiltinCatalogMetadata } from './hairBuiltinCatalogMetadata.server'

/** Upload types whose shared, hash-named files can be acquired by Goon records. */
export const CUSTOM_GOON_UPLOAD_TYPES = [
  'goon_custom_packages',
  'goon_custom_models',
  'goon_custom_manifests',
  'goon_hair_assets',
  'goon_hair_imports'
] as const

export type CustomGoonUploadType = (typeof CUSTOM_GOON_UPLOAD_TYPES)[number]

const CUSTOM_GOON_UPLOAD_TYPE_SET = new Set<string>(CUSTOM_GOON_UPLOAD_TYPES)

export function customGoonDeletionKey(uploadType: CustomGoonUploadType, filename: string) {
  return `goon_asset_delete:${uploadType}:${filename}`
}

function uploadKeyFromUrl(value: string): string | null {
  // These are stored URL/ref values, not prose which merely mentions one.
  // In particular, Recipe failure reasons name an asset in a sentence and
  // must remain writable even if the named upload has since disappeared.
  const candidate = value.trim()
  if (!candidate.startsWith('/') && !/^https?:\/\//i.test(candidate)) return null
  let pathname: string
  try {
    pathname = new URL(candidate, 'http://batshit.local').pathname
  } catch {
    return null
  }
  const parts = pathname.split('/').filter(Boolean)
  const uploadsIndex = parts.lastIndexOf('uploads')
  // The deletion audit treats the first type/filename after /uploads as the
  // reference, including URLs with a trailing path. Publication must agree.
  if (uploadsIndex < 0 || parts.length < uploadsIndex + 3) return null
  let uploadType: string
  let filename: string
  try {
    uploadType = decodeURIComponent(parts[uploadsIndex + 1])
    filename = decodeURIComponent(parts[uploadsIndex + 2])
  } catch {
    return null
  }
  if (!CUSTOM_GOON_UPLOAD_TYPE_SET.has(uploadType) || !filename || /[/\\]/.test(filename)) return null
  return `upload:${uploadType}:${filename}`
}

/** Collects actual custom upload URLs/refs and filename-only customAvatar file refs. */
export function collectCustomGoonUploadKeys(value: unknown): string[] {
  const keys = new Set<string>()
  const seen = new Set<object>()

  function addCustomAvatarFile(file: unknown, uploadType: CustomGoonUploadType) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return
    const filename = (file as Record<string, unknown>).filename
    if (typeof filename === 'string' && filename.trim() && !/[/\\]/.test(filename)) {
      keys.add(`upload:${uploadType}:${filename.trim()}`)
    }
  }

  function visit(node: unknown) {
    if (typeof node === 'string') {
      const key = uploadKeyFromUrl(node)
      if (key) keys.add(key)
      return
    }
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const record = node as Record<string, unknown>
    if (typeof record.uploadType === 'string' && CUSTOM_GOON_UPLOAD_TYPE_SET.has(record.uploadType) &&
        typeof record.filename === 'string' && record.filename && !/[/\\]/.test(record.filename)) {
      keys.add(`upload:${record.uploadType}:${record.filename}`)
    }
    const customAvatar = record.customAvatar
    if (customAvatar && typeof customAvatar === 'object' && !Array.isArray(customAvatar)) {
      for (const section of [customAvatar, (customAvatar as Record<string, unknown>).backup,
        (customAvatar as Record<string, unknown>).pending]) {
        if (!section || typeof section !== 'object' || Array.isArray(section)) continue
        const files = section as Record<string, unknown>
        addCustomAvatarFile(files.package, 'goon_custom_packages')
        addCustomAvatarFile(files.model, 'goon_custom_models')
        addCustomAvatarFile(files.manifest, 'goon_custom_manifests')
      }
    }
    for (const child of Object.values(record)) visit(child)
  }

  visit(value)
  return [...keys].sort()
}

export type GoonGuardedReference = string | { hairRevisionKey: string; sha256: string }

/** Resolve identity-only selections using the vouched owner. Only an exact
 * packaged identity/hash is exempt; a caller's builtin flag grants nothing. */
export async function collectGoonGuardedReferences(value: unknown, userId: string): Promise<GoonGuardedReference[]> {
  const refs: GoonGuardedReference[] = collectCustomGoonUploadKeys(value)
  const identities = new Map<string, { assetId: string; revisionId: string; sha256: string; revision: number }>()
  const seen = new Set<object>()
  function visit(node: unknown) {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) { node.forEach(visit); return }
    const row = node as Record<string, unknown>
    const selection = row.schemaVersion === 'hair-state/v2' && row.selected &&
      typeof row.selected === 'object' && !Array.isArray(row.selected)
      ? row.selected as Record<string, unknown> : null
    if (selection) {
      const row = selection
      if (typeof row.assetId !== 'string' || typeof row.assetRevisionId !== 'string' ||
          typeof row.assetRevisionSha256 !== 'string') throw new Error('Hair selection identity is invalid.')
      if (![userId, row.assetId, row.assetRevisionId].every((part) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(part)) ||
          !/^[a-f0-9]{64}$/.test(row.assetRevisionSha256)) throw new Error('Hair selection identity is invalid.')
      const key = `hair_asset:${userId}:${row.assetId}:${row.assetRevisionId}`
      const previous = identities.get(key)
      if (previous && (previous.sha256 !== row.assetRevisionSha256 || previous.revision !== Number(row.assetRevision))) {
        throw new Error('Hair selection contains conflicting immutable identities.')
      }
      identities.set(key, { assetId: row.assetId, revisionId: row.assetRevisionId,
        sha256: row.assetRevisionSha256, revision: Number(row.assetRevision) })
    }
    Object.values(row).forEach(visit)
  }
  visit(value)
  if (identities.size) {
    const catalog = await loadHairBuiltinCatalogMetadata()
    for (const [hairRevisionKey, identity] of identities) {
      if (!catalog.assets.some((asset) => asset.assetId === identity.assetId &&
          asset.revisionId === identity.revisionId && asset.revision === identity.revision &&
          asset.revisionSha256 === identity.sha256)) {
        refs.push({ hairRevisionKey, sha256: identity.sha256 })
      }
    }
  }
  return refs
}

/** Embed before mutations in Redis EVAL. Read/decode only; never re-encode
 * persisted records, whose precision belongs to RedisJSON and the JS reader. */
export const CUSTOM_GOON_UPLOAD_GUARD_LUA = `
local function goonUploadAvailable(uploadKey)
  local deletionKey = 'goon_asset_delete:' .. string.sub(uploadKey, 8)
  return redis.call('EXISTS', deletionKey) == 0 and redis.call('EXISTS', uploadKey) == 1
end
local function hairFilesAvailable(value)
  if type(value) == 'string' then
    value = string.gsub(string.gsub(value, '^%s+', ''), '%s+$', '')
    local lower = string.lower(value)
    if string.sub(value, 1, 1) ~= '/' and string.sub(lower, 1, 7) ~= 'http://' and
       string.sub(lower, 1, 8) ~= 'https://' then return true end
    local uploadType, filename = string.match(value, '^/uploads/(goon_hair_[a-z]+)/([^/]+)$')
    if filename and (uploadType == 'goon_hair_assets' or uploadType == 'goon_hair_imports') then
      return goonUploadAvailable('upload:' .. uploadType .. ':' .. filename)
    end
    return not string.find(value, '/uploads/goon_hair_assets/', 1, true) and
      not string.find(value, '/uploads/goon_hair_imports/', 1, true)
  end
  if type(value) == 'table' then
    for _, child in pairs(value) do
      if not hairFilesAvailable(child) then return false end
    end
  end
  return true
end
local function customGoonUploadsAvailable(encodedKeys)
  local uploadKeys = cjson.decode(encodedKeys)
  if #uploadKeys > 0 and redis.call('EXISTS', 'goon_asset_restore') ~= 0 then
    return false
  end
  for _, ref in ipairs(uploadKeys) do
    if type(ref) == 'string' then
      if not goonUploadAvailable(ref) then return false end
    elseif type(ref) == 'table' and type(ref.hairRevisionKey) == 'string' then
      local raw = redis.call('JSON.GET', ref.hairRevisionKey)
      if not raw then return false end
      local asset = cjson.decode(raw)
      if asset.revisionSha256 ~= ref.sha256 or not hairFilesAvailable(asset) then return false end
    else return false end
  end
  return true
end
`

const STORE_GUARDED_REFERENCE_RECORD_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
if not customGoonUploadsAvailable(ARGV[2]) then return 'ASSET_UNAVAILABLE' end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
return 'STORED'
`

/** Existing whole-record publishers retain their normal empty-ref fast path. */
export async function storeGoonReferenceRecordForClient(client: any, key: string, value: unknown, userId: string) {
  const refs = await collectGoonGuardedReferences(value, userId)
  if (!refs.length) return client.json.set(key, '$', value)
  if (typeof client.eval !== 'function') throw new Error('Redis EVAL is required to save retained Goon file references safely.')
  const result = await client.eval(STORE_GUARDED_REFERENCE_RECORD_SCRIPT, {
    keys: [key], arguments: [JSON.stringify(value), JSON.stringify(refs)]
  })
  if (result !== 'STORED') throw Object.assign(new Error('A retained Goon file is unavailable or being deleted. Retry after cleanup finishes.'), {
    code: 'ASSET_UNAVAILABLE', status: 409
  })
  return 'OK'
}
