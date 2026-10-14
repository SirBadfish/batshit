/**
 * BL-1485 (SA-129 D1, DL-07, Josh's one-word rule): the Zip Manager's words. A result is
 * compressed or expanded; Hold, Hold for N messages and Release are the actions; "zip" stays the
 * verb ("Zip now", "Zip all expanded").
 */
export type ZipManagerFilter = 'expanded' | 'compressed' | 'all'

export const ZIP_MANAGER_FILTERS: ReadonlyArray<{ value: ZipManagerFilter; label: string }> = [
  { value: 'expanded', label: 'Expanded' },
  { value: 'compressed', label: 'Compressed' },
  { value: 'all', label: 'All' }
]

export function zipManagerEmptyCopy(filter: ZipManagerFilter): string {
  if (filter === 'compressed') return 'No compressed results in this chat yet.'
  if (filter === 'all') return 'No zips in this chat yet.'
  return 'Nothing is expanded right now.'
}

/**
 * "N held": every hold, whoever holds it (you, an agent, or Judge Juice) and with or without a
 * countdown, the same holds the closed trigger's badge counts. A held copy the prompt compresses
 * anyway (a dead copy) is still held.
 */
export function countZipManagerHolds(rows: ReadonlyArray<{ isManuallyUnzipped: boolean }>): number {
  return rows.filter((row) => row.isManuallyUnzipped).length
}

export interface ZipManagerVisibilityItem {
  id?: string | null
  type?: string | null
  metadata?: Record<string, any> | null
}

function addZipIdVariants(ids: Set<string>, value: unknown) {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed) return

  ids.add(trimmed)

  if (trimmed.startsWith('zip:')) {
    const withoutPrefix = trimmed.slice(4)
    ids.add(withoutPrefix)
  } else {
    ids.add(`zip:${trimmed}`)
  }
}

function getToolCallId(zip: ZipManagerVisibilityItem): string | null {
  const value = zip.metadata?.toolCallId
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function isRawToolSidecarZip(zip: ZipManagerVisibilityItem): boolean {
  return zip.type === 'tool_raw' && zip.metadata?.rawSidecar === true
}

export function getHiddenRawSidecarZipIds(zips: ZipManagerVisibilityItem[]): Set<string> {
  const referencedSidecarIds = new Set<string>()
  const mainToolCallIds = new Set<string>()

  for (const zip of zips) {
    if (!zip || isRawToolSidecarZip(zip)) continue

    addZipIdVariants(referencedSidecarIds, zip.metadata?.rawSidecarZipId)

    const toolCallId = getToolCallId(zip)
    if (toolCallId) mainToolCallIds.add(toolCallId)
  }

  const hiddenIds = new Set<string>()
  for (const zip of zips) {
    if (!zip?.id || !isRawToolSidecarZip(zip)) continue

    const idVariants = new Set<string>()
    addZipIdVariants(idVariants, zip.id)
    const toolCallId = getToolCallId(zip)
    const isReferenced = Array.from(idVariants).some((id) => referencedSidecarIds.has(id))
    const hasMatchingMainZip = Boolean(toolCallId && mainToolCallIds.has(toolCallId))

    if (!isReferenced && !hasMatchingMainZip) continue
    for (const id of idVariants) hiddenIds.add(id)
  }

  return hiddenIds
}

export function shouldShowZipManagerItem(
  zip: ZipManagerVisibilityItem,
  hiddenRawSidecarZipIds: Set<string>
): boolean {
  if (!zip?.id) return false
  if (!isRawToolSidecarZip(zip)) return true

  const idVariants = new Set<string>()
  addZipIdVariants(idVariants, zip.id)
  return !Array.from(idVariants).some((id) => hiddenRawSidecarZipIds.has(id))
}
