/**
 * The zip ids a chat message's text names, for the message view (`MessageContent`): which zips to
 * hydrate, and whether the text needs a compile. BL-609: a reference is read with the trust
 * reader's one shape (`scanZipReferences`), as the reply end neutralizes and trusts it, so a
 * spaced or odd id reads the same here as there. Pure.
 */

import { normalizeId } from './idNormalizer'
import { scanZipReferences } from './zipReferenceSafety'

/** The older `{{batshit|id:X|...}}` form some stored messages still hold. */
const LEGACY_ZIP_REFERENCE = /\{\{batshit\|id:([^|]+)\|[^}]+\}\}/g

/**
 * The zip ids `text` names, raw, each once: references first, then the older form. With
 * `allowedIds` (normalized ids, the message's trusted set), only the ids in it.
 */
export function zipIdsInMessageText(text: string, allowedIds?: Set<string> | null): string[] {
  const ids = new Set<string>()
  const add = (zipId: string) => {
    if (allowedIds && !allowedIds.has(normalizeId(zipId))) return
    ids.add(zipId)
  }
  for (const reference of scanZipReferences(text)) add(reference.id)
  for (const match of text.matchAll(LEGACY_ZIP_REFERENCE)) add(match[1])
  return Array.from(ids)
}

/**
 * Whether the zips `text` names (those in `allowedIds`, when given) are all tool cards, and there
 * is at least one: such a message hydrates its cards from Redis and needs no compile.
 */
export function namesOnlyToolZips(text: string, allowedIds?: Set<string> | null): boolean {
  if (!text || !text.includes('{{batshit-zip:')) return false
  let found = false
  for (const reference of scanZipReferences(text)) {
    if (allowedIds && !allowedIds.has(normalizeId(reference.id))) continue
    if (!reference.id.includes('cool_tool')) return false
    found = true
  }
  return found
}

/** The zip id of one reference (an entry of a tool payload's `imageZipReferences`), or null. */
export function zipIdOfReference(reference: string): string | null {
  if (typeof reference !== 'string' || !reference) return null
  return scanZipReferences(reference)[0]?.id ?? null
}
