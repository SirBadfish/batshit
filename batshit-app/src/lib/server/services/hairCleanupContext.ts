export type HairImportOwnedFile = {
  uploadType: 'goon_hair_imports' | 'goon_hair_assets'
  filename: string
  ref: string
  sha256: string
  bytes: number
  mimeType: string
}

/** One observed generation and exact cleanup subset, never a whole-job waiver. */
export type HairCleanupContext = {
  jobKey: string
  stateVersion?: number
  expectedRaw?: string
  mode: 'retired' | 'subset' | 'source-consumed'
  files: readonly HairImportOwnedFile[]
}

export function hairCleanupFileKey(file: Pick<HairImportOwnedFile, 'uploadType' | 'filename'>) {
  return `upload:${file.uploadType}:${file.filename}`
}

export function sameHairCleanupFile(left: HairImportOwnedFile, right: HairImportOwnedFile) {
  return left.uploadType === right.uploadType && left.filename === right.filename &&
    left.ref === right.ref && left.sha256 === right.sha256 && left.bytes === right.bytes && left.mimeType === right.mimeType
}

export function isHairCleanupFile(value: unknown): value is HairImportOwnedFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as HairImportOwnedFile
  return ['goon_hair_imports', 'goon_hair_assets'].includes(file.uploadType) &&
    typeof file.filename === 'string' && file.filename.length > 0 && !/[/\\]/.test(file.filename) &&
    file.ref === `/uploads/${file.uploadType}/${file.filename}` &&
    typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256) &&
    Number.isSafeInteger(file.bytes) && file.bytes >= 0 && typeof file.mimeType === 'string' && file.mimeType.length > 0
}

export function isDiscoveredHairCleanupFile(value: unknown): value is HairImportOwnedFile {
  if (!isHairCleanupFile(value) || value.uploadType !== 'goon_hair_assets' || value.bytes < 1 ||
      value.bytes > 64 * 1024 * 1024 || Object.keys(value).length !== 6) return false
  const suffix = /_(geometry|follower-definition|physics-definition|material-definition|neutral-value|highlight-mask|normal|roughness|preview|import-receipt|fit-receipt|refit-source)_([a-f0-9]{64})\.(glb|json|png)$/.exec(value.filename)
  if (!suffix || !/^[A-Za-z0-9_-]+$/.test(value.filename.slice(0, suffix.index)) || suffix[2] !== value.sha256) return false
  const role = suffix[1]
  const ext = ['geometry', 'refit-source'].includes(role) ? 'glb' :
    ['neutral-value', 'highlight-mask', 'normal', 'roughness', 'preview'].includes(role) ? 'png' : 'json'
  return suffix[3] === ext && value.mimeType === ({ glb: 'model/gltf-binary', png: 'image/png', json: 'application/json' })[ext]
}
