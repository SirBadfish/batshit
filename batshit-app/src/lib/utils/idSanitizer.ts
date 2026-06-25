/**
 * ID Sanitization Utility
 *
 * Converts human-readable display names into valid slug-based IDs.
 * Used for users, agents, subagents, and other entities.
 *
 * Story: 6.9b - Message & User ID Slug Migration
 * Pattern: lowercase, alphanumeric + underscores/hyphens only
 *
 * Examples:
 * - "Josh" → "josh"
 * - "Big Papa!" → "big_papa"
 * - "  Test  User  " → "test_user"
 * - "___test___" → "test"
 */

/**
 * Sanitize display name into valid ID slug
 *
 * Process:
 * 1. Convert to lowercase
 * 2. Replace non-alphanumeric characters with underscores
 * 3. Trim leading/trailing underscores
 * 4. Collapse multiple consecutive underscores into one
 *
 * @param displayName - Human-readable name to sanitize
 * @returns Sanitized slug-based ID
 */
export function sanitizeId(displayName: string): string {
  return displayName
    .toLowerCase()                    // "Josh" → "josh"
    .replace(/[^a-z0-9_-]/g, '_')    // "Big Papa!" → "big_papa_"
    .replace(/[-_]+/g, '_')           // "test___---___user" → "test_user" (collapse separators)
    .replace(/^_+|_+$/g, '')          // "_test_" → "test" (trim leading/trailing)
}

/**
 * Validate if a string is already a valid sanitized ID
 * Useful for checking if sanitization is needed
 */
export function isValidId(id: string): boolean {
  // Must be lowercase, alphanumeric + underscores only
  // No leading/trailing underscores, no consecutive underscores
  return /^[a-z0-9]+(_[a-z0-9]+)*$/.test(id)
}

/**
 * Suggest alternative IDs when collision detected
 * Returns array of suggested alternatives
 */
export function suggestAlternatives(baseId: string, count: number = 3): string[] {
  const suggestions: string[] = []

  for (let i = 2; i <= count + 1; i++) {
    suggestions.push(`${baseId}_${i}`)
  }

  return suggestions
}
