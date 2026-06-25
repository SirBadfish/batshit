/**
 * ID Normalizer Utility
 * 
 * Handles the normalization of zip and clip IDs by removing index suffixes
 * that get added during generation. This ensures consistent ID comparison
 * and prevents duplicate rendering issues.
 * 
 * Patterns handled:
 * - Zips: sessionId-messageId-type-0 → sessionId-messageId-type
 * - Cool Tools: id-cool_tool-0 → id-cool_tool
 * - Clips: clip_timestamp_hash_0 → clip_timestamp_hash
 */

/**
 * Normalize any Batshit ID by removing index suffixes
 * This is the main function that should be used everywhere
 */
export function normalizeId(id: string): string {
  if (!id) return id;
  
  // Handle Cool Tools special case (always normalize to -0)
  if (id.includes('-cool_tool-')) {
    return id.replace(/-cool_tool-\d+$/, '-cool_tool-0');
  }
  
  // Handle regular zips (remove -index at the end)
  // Pattern: anything-number at the end where number is 0-9
  if (id.match(/-\d+$/)) {
    return id.replace(/-\d+$/, '');
  }
  
  // Handle clips (remove _index at the end)
  // Pattern: anything_number at the end where number is 0-9
  if (id.match(/_\d+$/)) {
    return id.replace(/_\d+$/, '');
  }
  
  return id;
}

/**
 * Compare two IDs after normalization
 * Use this when checking if two IDs refer to the same content
 */
export function isSameId(id1: string, id2: string): boolean {
  return normalizeId(id1) === normalizeId(id2);
}

/**
 * Normalize a list of IDs
 */
export function normalizeIds(ids: string[]): string[] {
  return ids.map(id => normalizeId(id));
}

/**
 * Create a normalized ID map from an array of items with IDs
 * This helps prevent duplicates when rendering
 */
export function createNormalizedIdMap<T extends { id?: string; zipId?: string }>(
  items: T[]
): Map<string, T> {
  const map = new Map<string, T>();
  
  for (const item of items) {
    const id = item.id || item.zipId;
    if (id) {
      const normalizedId = normalizeId(id);
      // Only add if not already in map (prevents duplicates)
      if (!map.has(normalizedId)) {
        map.set(normalizedId, item);
      }
    }
  }
  
  return map;
}

/**
 * Check if an ID exists in a collection after normalization
 */
export function hasNormalizedId(
  collection: string[] | Set<string>,
  id: string
): boolean {
  const normalizedId = normalizeId(id);
  
  if (collection instanceof Set) {
    const normalizedSet = new Set(Array.from(collection).map(normalizeId));
    return normalizedSet.has(normalizedId);
  } else {
    const normalizedArray = collection.map(normalizeId);
    return normalizedArray.includes(normalizedId);
  }
}

/**
 * Generate a base ID without index suffix
 * Use this when you want to ensure no index is added
 */
export function generateBaseId(
  sessionId: string,
  messageId: string,
  contentType: string
): string {
  return `${sessionId}-${messageId}-${contentType}`;
}

/**
 * Extract the base ID and index from an ID
 */
export function parseIdParts(id: string): { baseId: string; index: number } {
  const normalizedId = normalizeId(id);
  
  // Try to extract index from original ID
  let index = 0;
  
  // Check for -number pattern
  const dashMatch = id.match(/-(\d+)$/);
  if (dashMatch) {
    index = parseInt(dashMatch[1], 10);
  } else {
    // Check for _number pattern
    const underscoreMatch = id.match(/_(\d+)$/);
    if (underscoreMatch) {
      index = parseInt(underscoreMatch[1], 10);
    }
  }
  
  return { baseId: normalizedId, index };
}