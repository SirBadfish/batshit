/**
 * Operator-reviewed source retirements. Automation A never infers these from a timeout,
 * a failed credential, or a missing ID alone. A maintenance change may add an exact
 * connection/ID only after a complete successful recheck at least an hour later AND
 * official provider evidence of retirement. Keep the evidence with the decision.
 * Entries affect missing IDs only: a source that lists the ID again wins.
 */
export type ConfirmedCatalogRetirement = {
  connectionId: string
  effectiveId: string
  firstAbsentAt: string
  recheckedAt: string
  evidenceUrl: string
  reason: string
}

export const CONFIRMED_CATALOG_RETIREMENTS: readonly ConfirmedCatalogRetirement[] = [
  'kimi-k2.5',
  'moonshot-v1-128k',
  'moonshot-v1-128k-vision-preview',
  'moonshot-v1-32k',
  'moonshot-v1-32k-vision-preview',
  'moonshot-v1-8k',
  'moonshot-v1-8k-vision-preview',
  'moonshot-v1-auto',
].map((effectiveId) => ({
  connectionId: 'direct:moonshot',
  effectiveId,
  firstAbsentAt: '2026-09-29T16:28:17.469Z',
  recheckedAt: '2026-09-29T17:28:33.371Z',
  evidenceUrl: 'https://platform.kimi.ai/docs/models',
  reason: 'Provider discontinued Kimi K2.5 and all Moonshot v1 variants on August 31, 2026; complete live lists one hour apart confirm absence.'
}))
