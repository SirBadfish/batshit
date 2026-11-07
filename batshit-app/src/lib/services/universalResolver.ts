/**
 * Universal Resolver for batshit-zip and batshit-clip references
 *
 * Reads the clean syntax:
 * - {{batshit-zip:id}} or {{batshit-zip:id:::content}}
 * - {{batshit-clip:id}} or {{batshit-clip:id:::description}}
 *
 * Triple colons (:::) separate the id from the optional content.
 *
 * BL-609: the compile asks it which references an earlier message carries (the zips it expands
 * or compresses, `extractZips` in `messageCompiler.ts`; whether a chat has zip history; a clip in
 * the current message), and it reads them with the trust reader's shapes (`zipReferenceSafety.ts`:
 * a zip id of 1 to 160 characters with no `:`, `{`, `}`, or line break; a clip id with no `:`,
 * `}`, or whitespace; a description that may be empty), so the compile reads a reference exactly
 * where the chat view and the reply-end neutralizer do. Every reference Batshit writes reads as
 * before, except one with an empty description (`zipService.ts` writes `:::}}` when a zip's
 * description is empty), which the older pattern left in the prompt as raw text. One scan, never a
 * regex over the whole text (BL-707).
 */

import { scanZipAndClipReferences } from '$lib/utils/zipReferenceSafety'

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
 * Every zip and clip reference in a text, in order, as one left-to-right reading
 * (`scanZipAndClipReferences`): a reference inside an earlier reference's description is part of
 * it. An empty description reads as no content.
 */
export function extractAllReferences(text: string): Array<{
  fullMatch: string;
  type: 'zip' | 'clip';
  id: string;
  optionalContent?: string;
}> {
  return scanZipAndClipReferences(text).map((reference) => ({
    fullMatch: reference.match,
    type: reference.type,
    id: reference.id,
    optionalContent: reference.description || undefined
  }));
}
