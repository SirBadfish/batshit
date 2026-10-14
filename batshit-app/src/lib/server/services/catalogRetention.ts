import { CONFIRMED_CATALOG_RETIREMENTS, type ConfirmedCatalogRetirement } from '$lib/data/catalog-confirmed-retirements'

/** No caller-supplied deletion flag: only the reviewed, versioned evidence list. */
export function retainCatalogSourceEntries<T extends { id: string }>(
  connectionId: string,
  fresh: T[],
  previous: T[],
  retirements: readonly ConfirmedCatalogRetirement[] = CONFIRMED_CATALOG_RETIREMENTS
) {
  const present = new Set(fresh.map(entry => entry.id))
  const approved = new Set<string>()
  for (const item of retirements.filter(item => item.connectionId === connectionId)) {
    const first = Date.parse(item.firstAbsentAt)
    const recheck = Date.parse(item.recheckedAt)
    if (!item.effectiveId.trim() || !Number.isFinite(first) || !Number.isFinite(recheck) ||
      recheck - first < 3_600_000 || recheck > Date.now() || !item.reason.trim() ||
      !URL.canParse(item.evidenceUrl) || new URL(item.evidenceUrl).protocol !== 'https:') {
      throw new Error(`Invalid confirmed catalog retirement evidence for ${connectionId}`)
    }
    approved.add(item.effectiveId)
  }
  const absent = previous.filter(entry => !present.has(entry.id))
  const missing = absent.filter(entry => !approved.has(entry.id))
  return {
    entries: [...fresh, ...missing],
    pendingRemovalIds: [...new Set(missing.map(entry => entry.id))],
    confirmedRemovalIds: [...new Set(absent.filter(entry => approved.has(entry.id)).map(entry => entry.id))],
    warning: missing.length
      ? `Retaining ${missing.length} previously published model IDs absent from this response; retirement requires a successful recheck and provider evidence`
      : undefined
  }
}
