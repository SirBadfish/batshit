const MANUAL_ENTRY_DIRECT_PROVIDER_IDS = new Set(['alibaba', 'stepfun'])

export function isManualEntryDirectProvider(providerId?: string | null): boolean {
  const normalized = providerId?.trim().toLowerCase() ?? ''
  return MANUAL_ENTRY_DIRECT_PROVIDER_IDS.has(normalized)
}

export function isManualEntryCatalogConnection(connectionId?: string | null): boolean {
  const normalized = connectionId?.trim().toLowerCase() ?? ''
  if (!normalized) return false
  if (normalized.startsWith('direct:custom_')) return true
  return normalized.startsWith('direct:')
    ? isManualEntryDirectProvider(normalized.slice('direct:'.length))
    : false
}
