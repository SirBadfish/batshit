import { redis } from '$lib/server/redis'
import { clipClothingUploadReferences, clipHairUploadReferences } from './clipHairReferences'
import { CUSTOM_GOON_UPLOAD_GUARD_LUA } from './goonCustomAssetOwnership.server'

const STORE_CLIP_SCRIPT = `
${CUSTOM_GOON_UPLOAD_GUARD_LUA}
if not customGoonUploadsAvailable(ARGV[2]) then return 'ASSET_UNAVAILABLE' end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
return 'STORED'
`

export async function storeClipRecordForClient(client: any, key: string, value: unknown) {
  const refs = [...clipHairUploadReferences(value), ...clipClothingUploadReferences(value)]
  if (!refs.length) return client.json.set(key, '$', value)
  const label = refs.some((ref) => ref.uploadType === 'goon_clothing_assets' || ref.uploadType === 'goon_closet') ? 'Goon attachment' : 'Hair'
  if (typeof client.eval !== 'function') throw new Error(`Redis EVAL is required to save borrowed ${label} references safely.`)
  const result = await client.eval(STORE_CLIP_SCRIPT, { keys: [key], arguments: [JSON.stringify(value),
    JSON.stringify(refs.map(({ uploadType, filename }) => `upload:${uploadType}:${filename}`))] })
  if (result !== 'STORED') throw Object.assign(new Error(`A borrowed ${label} file is unavailable or being deleted. Retry after cleanup finishes.`), {
    code: 'ASSET_UNAVAILABLE', status: 409
  })
  return 'OK'
}

/** Narrow Clip whole-row seam; ordinary image/document/text writes keep their
 * existing native JSON.SET fast path. No compiler or global Redis rewrite. */
export function saveClipRecord(key: string, value: unknown) {
  return redis.execute((client) => storeClipRecordForClient(client, key, value))
}
