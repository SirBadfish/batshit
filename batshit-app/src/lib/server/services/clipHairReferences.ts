export const CLIP_UPLOAD_URL_FIELDS = [
  'tunnelPath', 'localUrl', 'displayUrl', 'externalUrl', 'thumbnailUrl', 'fullResolutionUrl'
] as const

/** The actual Clip URL readers' locator semantics, for every persisted URL
 * field. Text/content/tags are not media ownership. Original rows stay opaque. */
function clipUploadReferences<T extends string>(value: unknown, uploadTypes: readonly T[]) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return [] }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const refs = new Map<string, { uploadType: T; filename: string; ref: string }>()
  for (const field of CLIP_UPLOAD_URL_FIELDS) {
    const raw = (value as Record<string, unknown>)[field]
    if (typeof raw !== 'string' || !raw.trim()) continue
    let pathname = raw.trim()
    if (!pathname.startsWith('/uploads/')) {
      try { pathname = new URL(pathname).pathname } catch { continue }
    }
    const match = /^\/uploads\/([^/]+)\/(.+)$/.exec(pathname.split(/[?#]/, 1)[0])
    if (!match) continue
    let uploadType: string, filename: string
    try { uploadType = decodeURIComponent(match[1]); filename = decodeURIComponent(match[2]) } catch { continue }
    if (!uploadTypes.includes(uploadType as T) || !filename) continue
    refs.set(`${uploadType}/${filename}`, { uploadType: uploadType as T, filename,
      ref: `/uploads/${uploadType}/${encodeURIComponent(filename)}` })
  }
  return [...refs.values()]
}

/** Hair's backup projection intentionally stays restricted to its two namespaces. */
export function clipHairUploadReferences(value: unknown) {
  return clipUploadReferences(value, ['goon_hair_assets', 'goon_hair_imports'] as const)
}

/** Independent Clothing borrower projection; never expands Hair backup inputs. */
export function clipClothingUploadReferences(value: unknown) {
  return clipUploadReferences(value, ['goon_clothing_assets', 'goon_closet'] as const)
}

/** Strict reference read; unlike a UI fallback, an unavailable row cannot
 * become evidence that no borrower exists. Legacy JSON strings stay opaque. */
export async function readClipReferenceRecord(client: any, key: string): Promise<unknown> {
  const value = typeof client.type === 'function' && await client.type(key) === 'string'
    ? await client.get(key) : await client.json.get(key)
  if (value === null || value === undefined) throw new Error(`Clip reference record ${key} disappeared. Retry cleanup.`)
  return value
}
