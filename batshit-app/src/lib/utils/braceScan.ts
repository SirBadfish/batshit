/**
 * Linear scans for `{{…}}` shapes whose regex cost (openers) x (text length).
 *
 * A pattern such as `/\{\{batshit-zip:[^}]+\}\}/g` searches to the first `}` again from every
 * opener, so a text of openers that never close cost the one Node process seconds to minutes
 * (about 30 s for 20,000 in 1 MB). These scans keep each lookup until an opener lies past it.
 */

/**
 * The first `needle` at or after a position, for a scan whose positions mostly move forward:
 * the last answer is kept until a position lies past it, so a text is searched about once however
 * many openers ask. A position before the last lookup's start searches again. The answer is
 * `content.length` when there is no `needle` there.
 */
export function createNextIndexFinder(content: string, needle: string): (position: number) => number {
  let from = -1
  let at = -1
  return (position: number) => {
    if (position < from || at < position) {
      from = position
      at = content.indexOf(needle, position)
      if (at < 0) at = content.length
    }
    return at
  }
}

export interface BracedToken {
  /** Where the token starts in the scanned text. */
  start: number
  /** Where it ends (just past its `}}`). */
  end: number
  /** The whole token. */
  match: string
}

const CLOSE_BRACE_CODE = 125 // `}`

/**
 * Every `open` + one or more characters other than `}` + `}}` in `content`, in order: exactly
 * what the regex `\{\{…[^}]+\}\}` with `g` finds for an `open` like `{{batshit-zip:` (an opener
 * that holds no `}`). The body may hold anything else, `{`, `:`, and line breaks included, at any
 * length. The first `}` after the opener must be the first of `}}`; otherwise that opener is not
 * a token and the search resumes one character later.
 */
export function scanBracedTokens(content: string, open: string): BracedToken[] {
  const found: BracedToken[] = []
  if (!content || !content.includes(open)) return found

  const nextBrace = createNextIndexFinder(content, '}')
  let from = 0
  for (;;) {
    const start = content.indexOf(open, from)
    if (start < 0) break
    const bodyStart = start + open.length
    const braceAt = nextBrace(bodyStart)
    if (braceAt > bodyStart && content.charCodeAt(braceAt + 1) === CLOSE_BRACE_CODE) {
      const end = braceAt + 2
      found.push({ start, end, match: content.slice(start, end) })
      from = end
    } else {
      from = start + 1
    }
  }
  return found
}

/** `content` with each token `scanBracedTokens` finds replaced by `replacer(token)`. */
export function replaceBracedTokens(
  content: string,
  open: string,
  replacer: (match: string) => string
): string {
  const found = scanBracedTokens(content, open)
  if (found.length === 0) return content
  const parts: string[] = []
  let from = 0
  for (const token of found) {
    parts.push(content.slice(from, token.start), replacer(token.match))
    from = token.end
  }
  parts.push(content.slice(from))
  return parts.join('')
}
