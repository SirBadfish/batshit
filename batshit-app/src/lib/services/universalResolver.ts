/**
 * Universal Resolver for batshit-zip and batshit-clip references
 *
 * Reads the clean syntax:
 * - {{batshit-zip:id}} or {{batshit-zip:id:::content}}
 * - {{batshit-clip:id}} or {{batshit-clip:id:::description}}
 *
 * Triple colons (:::) separate the id from the optional content.
 *
 * This is a looser reader than `zipReferenceSafety.ts` (the trust boundary): the compile uses it
 * to ask whether an earlier message carries a reference at all, and the id may hold anything but
 * `:`, line breaks and braces included. It is read by one scan (`createNextIndexFinder`), never
 * a regex over the whole text: the pattern it replaced,
 * `/\{\{(batshit-zip|batshit-clip):([^:]+?)(?::::([^}]+))?\}\}/g`, searched the rest of the
 * text again from every opener, about 40 s of the one Node process for 20,000 openers in 1 MB
 * whose content never closes, on every compile of that chat.
 */

import { createNextIndexFinder } from '$lib/utils/braceScan'

const REFERENCE_OPEN = '{{batshit-'
const CONTENT_MARK = ':::'
const COLON_CODE = 58 // `:`
const CLOSE_BRACE_CODE = 125 // `}`

/**
 * Create a new reference string from components
 */
export function createReference(
  type: 'zip' | 'clip',
  id: string,
  optionalContent?: string
): string {
  const baseRef = `{{batshit-${type}:${id}}}`;
  if (optionalContent) {
    return `{{batshit-${type}:${id}:::${optionalContent}}}`;
  }
  return baseRef;
}

/**
 * Extract all references from a text string, in order. It finds exactly what the pattern above
 * found (compared over 9,000 generated texts in `universalResolver.test.ts`):
 * - after `{{batshit-zip:` or `{{batshit-clip:`, the id is at least one character, never `:`;
 * - it ends at whichever comes first after its first character: a `}}` (a reference with no
 *   content), or a `:`, which must start `:::` and one or more characters of content that end at
 *   the first `}` after them, the first of `}}`;
 * - anything else is not a reference, and the search resumes one character later.
 */
export function extractAllReferences(text: string): Array<{
  fullMatch: string;
  type: 'zip' | 'clip';
  id: string;
  optionalContent?: string;
}> {
  const references: Array<{
    fullMatch: string;
    type: 'zip' | 'clip';
    id: string;
    optionalContent?: string;
  }> = [];
  if (!text.includes(REFERENCE_OPEN)) return references;

  const nextColon = createNextIndexFinder(text, ':');
  const nextPair = createNextIndexFinder(text, '}}');
  const nextBrace = createNextIndexFinder(text, '}');
  let from = 0;
  for (;;) {
    const start = text.indexOf(REFERENCE_OPEN, from);
    if (start < 0) break;
    const typeStart = start + REFERENCE_OPEN.length;
    const type: 'zip' | 'clip' | null = text.startsWith('zip:', typeStart)
      ? 'zip'
      : text.startsWith('clip:', typeStart)
        ? 'clip'
        : null;
    const idStart = type ? typeStart + type.length + 1 : -1;

    let end = -1;
    let id = '';
    let optionalContent: string | undefined;
    if (type && idStart < text.length && text.charCodeAt(idStart) !== COLON_CODE) {
      const colonAt = nextColon(idStart + 1);
      const pairAt = nextPair(idStart + 1);
      if (pairAt < colonAt) {
        id = text.slice(idStart, pairAt);
        end = pairAt + 2;
      } else if (colonAt < text.length && text.startsWith(CONTENT_MARK, colonAt)) {
        const contentStart = colonAt + CONTENT_MARK.length;
        const braceAt = nextBrace(contentStart);
        if (braceAt > contentStart && text.charCodeAt(braceAt + 1) === CLOSE_BRACE_CODE) {
          id = text.slice(idStart, colonAt);
          optionalContent = text.slice(contentStart, braceAt);
          end = braceAt + 2;
        }
      }
    }
    if (!type || end < 0) {
      from = start + 1;
      continue;
    }

    references.push({
      fullMatch: text.slice(start, end),
      type,
      id,
      optionalContent: optionalContent || undefined
    });
    from = end;
  }

  return references;
}
