/**
 * Universal Resolver for batshit-zip and batshit-clip references
 * 
 * Handles the new clean syntax:
 * - {{batshit-zip:id}} or {{batshit-zip:id:::content}}
 * - {{batshit-clip:id}} or {{batshit-clip:id:::description}}
 * 
 * Triple colons (:::) are used as separator because they're:
 * - Impossible to appear naturally in content
 * - Super visible and intentional
 * - Bulletproof for regex parsing
 */

// Regex patterns for the new syntax with triple colons
export const BATSHIT_ZIP_REGEX = /\{\{batshit-zip:([^:]+?)(?::::([^}]+))?\}\}/g;
export const BATSHIT_CLIP_REGEX = /\{\{batshit-clip:([^:]+?)(?::::([^}]+))?\}\}/g;
export const BATSHIT_UNIVERSAL_REGEX = /\{\{(batshit-zip|batshit-clip):([^:]+?)(?::::([^}]+))?\}\}/g;

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
 * Extract all references from a text string
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
  
  const matches = text.matchAll(BATSHIT_UNIVERSAL_REGEX);
  for (const match of matches) {
    const [fullMatch, fullTypeStr, id, optionalContent] = match;
    const type = fullTypeStr.replace('batshit-', '') as 'zip' | 'clip';
    references.push({
      fullMatch,
      type,
      id,
      optionalContent: optionalContent || undefined
    });
  }
  
  return references;
}
