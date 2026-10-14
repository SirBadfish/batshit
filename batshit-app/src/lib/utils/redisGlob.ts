/**
 * BL-541: Redis KEYS / SCAN MATCH patterns read `*`, `?`, `[`, `]`, and `\` as glob syntax. A
 * pattern built from an id (`episode:${sessionId}:*`) must escape the id, or an id like `a*`
 * matches every other id that starts with `a`, and a sweep of one chat deletes another's records.
 *
 * Pure and dependency-free, so `redis.ts` and the routes can both use it.
 */

const REDIS_GLOB_CHARACTERS = /[*?[\]\\]/g

/** The characters a chat id may not carry, as the create route words them. */
export const REDIS_GLOB_CHARACTERS_TEXT = '*, ?, [, ], or \\'

/** `value` with every Redis glob character escaped, for use inside a KEYS pattern. */
export function escapeRedisGlob(value: string): string {
  return value.replace(REDIS_GLOB_CHARACTERS, (character) => `\\${character}`)
}

/** Whether `value` carries a character Redis reads as glob syntax in a pattern. */
export function hasRedisGlobCharacters(value: string): boolean {
  return /[*?[\]\\]/.test(value)
}
