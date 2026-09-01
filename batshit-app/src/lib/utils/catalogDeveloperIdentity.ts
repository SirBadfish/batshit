const CATALOG_DEVELOPER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  zai: 'zai',
  'z-ai': 'zai',
  'z.ai': 'zai',
  'zai-org': 'zai',
  zai_coding: 'zai',
  'zai-coding': 'zai'
})

/**
 * Returns Batshit's stable catalog developer identity.
 *
 * This is deliberately an explicit allow-list, not fuzzy matching. Provider-specific
 * developer namespaces and effective model IDs must stay untouched for runtime calls.
 */
export function canonicalizeCatalogDeveloperId(value?: string | null): string {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (!normalized) return ''
  return CATALOG_DEVELOPER_ALIASES[normalized] ?? normalized
}

export function catalogDeveloperIdsMatch(
  left?: string | null,
  right?: string | null
): boolean {
  const normalizedLeft = canonicalizeCatalogDeveloperId(left)
  const normalizedRight = canonicalizeCatalogDeveloperId(right)
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight)
}
