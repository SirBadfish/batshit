/**
 * BL-795: the id the page gives one Compact (its plan and its summary share it), sent to the
 * Compact route and the Compact's Stop route, so a Stop that reaches the server before its Compact
 * registered waits for that Compact alone (`compactRunRegistry.ts`). Client-safe: the page makes
 * it, the routes read it with the same rule.
 */
const COMPACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** A new id for one Compact. */
export function newCompactId(): string {
  return `compact_${crypto.randomUUID().replace(/-/g, '')}`
}

/** A request's `compactId`, or null when it has none or it is not one this page could make. */
export function readCompactId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return COMPACT_ID_PATTERN.test(id) ? id : null
}
