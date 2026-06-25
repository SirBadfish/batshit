// Cache zip metadata to avoid re-fetching on every render
interface ZipMetadata {
  id: string
  type: string
  tokens: number
  bufferSize: number
  threshold: number
  content?: string
  created_at?: string
  [key: string]: any
}

const zipMetadataCache = new Map<string, ZipMetadata>()
const zipMetadataMissCache = new Map<string, number>()

const ZIP_METADATA_MISS_TTL_MS = 30000

export function cacheZipMetadata(metadata: ZipMetadata[]): void {
  metadata.forEach(item => {
    zipMetadataCache.set(item.id, item)
    zipMetadataMissCache.delete(item.id)
  })
}

export function cacheMissingZipMetadata(
  zipIds: string[],
  ttlMs = ZIP_METADATA_MISS_TTL_MS,
  nowMs = Date.now()
): void {
  const expiresAt = nowMs + ttlMs
  zipIds.forEach(id => {
    if (id) {
      zipMetadataMissCache.set(id, expiresAt)
    }
  })
}

export function isZipMetadataMissCached(zipId: string, nowMs = Date.now()): boolean {
  const expiresAt = zipMetadataMissCache.get(zipId)
  if (!expiresAt) return false
  if (expiresAt <= nowMs) {
    zipMetadataMissCache.delete(zipId)
    return false
  }
  return true
}

export function chunkZipMetadataIds(zipIds: string[], batchSize = 100): string[][] {
  if (batchSize <= 0) return []
  const batches: string[][] = []
  for (let index = 0; index < zipIds.length; index += batchSize) {
    batches.push(zipIds.slice(index, index + batchSize))
  }
  return batches
}

export function getCachedZipMetadataForIds(zipIds: string[]): Map<string, ZipMetadata> {
  const result = new Map<string, ZipMetadata>()

  zipIds.forEach(id => {
    const metadata = zipMetadataCache.get(id)
    if (metadata) {
      result.set(id, metadata)
    }
  })

  return result
}

export function haveSameZipMetadataEntries(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>
): boolean {
  if (left.size !== right.size) return false
  for (const [id, metadata] of right) {
    if (left.get(id) !== metadata) return false
  }
  return true
}

export function clearZipMetadataCache(): void {
  zipMetadataCache.clear()
  zipMetadataMissCache.clear()
}
