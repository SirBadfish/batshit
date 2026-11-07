/**
 * The command-pattern reader behind the bash Allow and Never Allow lists (Agent Settings → Access).
 * An entry is a regex when written `re:<source>` or `/<source>/<flags>`; otherwise it is literal
 * text where `*` matches anything, anchored at the start and ending at a word boundary
 * (`git status` matches `git status -s`, not `git statusx`). Moved here from `nativeTools.ts` so
 * the typed file tools (SA-136) read Never Allow entries with the same reader.
 */
export function parseCommandPattern(pattern: string): RegExp | null {
  const trimmed = pattern.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('re:')) {
    try {
      return new RegExp(trimmed.slice(3).trim(), 'i')
    } catch {
      return null
    }
  }

  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    const lastSlash = trimmed.lastIndexOf('/')
    const source = trimmed.slice(1, lastSlash)
    const flags = trimmed.slice(lastSlash + 1)
    try {
      return new RegExp(source, flags || 'i')
    } catch {
      return null
    }
  }

  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*')
  return new RegExp(`^\\s*${escaped}(\\s|$)`, 'i')
}

/** Whether an entry is a regex (`re:` or `/…/`) rather than literal text with `*` wildcards. */
export function isRegexCommandPattern(pattern: string): boolean {
  const trimmed = pattern.trim()
  return trimmed.startsWith('re:') || (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0)
}
