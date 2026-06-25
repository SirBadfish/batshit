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
