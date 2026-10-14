/**
 * The edits a finished reply's text gets before it is stored (BL-775).
 *
 * Until BL-775 the chat page made these three edits to `end`'s content and saved the result over
 * the server's record: every Cool Tool marker replaced by its zip reference, the text sanitized,
 * and every zip reference the reply made but the text lost appended at the end. Its save also wrote
 * the reply's `zipIds` allow-list. The server now owns a reply's saved record (send-routed's
 * finalize saves the `/api/sse` rebuild), so the same edits run on the server, once, and `end`
 * carries the edited text: what a tab shows, what is stored, and what the agent reads next are the
 * same bytes. The rules are the page's, unchanged; `replyEndContent.test.ts` compares them with the
 * page's own code byte for byte.
 */
import { stripZipControlBlocks } from '$lib/utils/zipControl'
import { stripLeadingSubagentZipEcho } from '$lib/utils/subagentEchoSanitizer'
import { isConcreteZipId, scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { createNextIndexFinder, scanBracedTokens } from '$lib/utils/braceScan'

type ReplyZipReferenceLike = {
  zipId?: unknown
  zip_id?: unknown
  id?: unknown
  reference?: unknown
  placeholder?: unknown
}

function referenceList(zipReferences: unknown): ReplyZipReferenceLike[] {
  return Array.isArray(zipReferences) ? (zipReferences as ReplyZipReferenceLike[]) : []
}

const COOL_TOOL_OPEN = '<cool_tool'
const COOL_TOOL_CLOSE = '</cool_tool>'
const ZIP_OPEN = '{{batshit-zip:'
const WHITESPACE_RUN = /\s*/y

/**
 * ASCII letters lowered, nothing else changed, so every index still lines up. It is exactly the
 * case folding of a regex's `i` flag (without `u`) for an ASCII tag name.
 */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
}

type CoolToolMatch = { start: number; end: number }

/**
 * Every `<cool_tool…>…</cool_tool>` pair, in order (either case): exactly what
 * `/<cool_tool[^>]*>[\s\S]*?<\/cool_tool>/gi` finds, in one pass. The opening tag ends at the first
 * `>` after its name, the pair at the first closing tag after that; an opener with no `>` or no
 * closing tag after it means no later one has either. The pattern read to the end again from
 * every opener, which held the one Node process for seconds on a reply of openers that never
 * close (BL-775 moved these edits to the server; BL-707's rule).
 */
function scanPairedCoolTools(text: string, lower: string): CoolToolMatch[] {
  const found: CoolToolMatch[] = []
  const nextGt = createNextIndexFinder(text, '>')
  const nextClose = createNextIndexFinder(lower, COOL_TOOL_CLOSE)
  let from = 0
  for (;;) {
    const start = lower.indexOf(COOL_TOOL_OPEN, from)
    if (start < 0) break
    const gt = nextGt(start + COOL_TOOL_OPEN.length)
    if (gt >= text.length) break
    const close = nextClose(gt + 1)
    if (close >= lower.length) break
    const end = close + COOL_TOOL_CLOSE.length
    found.push({ start, end })
    from = end
  }
  return found
}

/** Every `<cool_tool…/>` (either case): exactly `/<cool_tool[^>]*\/>/gi`, in one pass. */
function scanSelfClosingCoolTools(text: string, lower: string): CoolToolMatch[] {
  const found: CoolToolMatch[] = []
  const nextGt = createNextIndexFinder(text, '>')
  let from = 0
  for (;;) {
    const start = lower.indexOf(COOL_TOOL_OPEN, from)
    if (start < 0) break
    const bodyStart = start + COOL_TOOL_OPEN.length
    const gt = nextGt(bodyStart)
    if (gt >= text.length) break
    // `[^>]*` cannot pass a `>`, so only the first one can end the tag, with `/` just before it.
    if (gt - 1 >= bodyStart && text.charCodeAt(gt - 1) === 47 /* / */) {
      found.push({ start, end: gt + 1 })
      from = gt + 1
    } else {
      from = start + 1
    }
  }
  return found
}

/** Every empty `<cool_tool…>` + whitespace + `</cool_tool>` (either case): exactly `/<cool_tool[^>]*>\s*<\/cool_tool>/gi`. */
function scanEmptyCoolTools(text: string, lower: string): CoolToolMatch[] {
  const found: CoolToolMatch[] = []
  const nextGt = createNextIndexFinder(text, '>')
  let lastGt = -1
  let lastAfterSpace = -1
  let from = 0
  for (;;) {
    const start = lower.indexOf(COOL_TOOL_OPEN, from)
    if (start < 0) break
    const gt = nextGt(start + COOL_TOOL_OPEN.length)
    if (gt >= text.length) break
    if (gt !== lastGt) {
      WHITESPACE_RUN.lastIndex = gt + 1
      WHITESPACE_RUN.test(text)
      lastGt = gt
      lastAfterSpace = WHITESPACE_RUN.lastIndex
    }
    if (lower.startsWith(COOL_TOOL_CLOSE, lastAfterSpace)) {
      const end = lastAfterSpace + COOL_TOOL_CLOSE.length
      found.push({ start, end })
      from = end
    } else {
      from = start + 1
    }
  }
  return found
}

function replaceMatches(text: string, matches: CoolToolMatch[], replacer: (match: string) => string): string {
  if (matches.length === 0) return text
  const parts: string[] = []
  let from = 0
  for (const match of matches) {
    parts.push(text.slice(from, match.start), replacer(text.slice(match.start, match.end)))
    from = match.end
  }
  parts.push(text.slice(from))
  return parts.join('')
}

/**
 * The id of the first `{{batshit-zip:<id>}}` or `{{batshit-zip:<id>:::<description>}}` in a
 * reference: exactly `/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/`, in one pass.
 */
function firstZipIdInReference(reference: string): string | undefined {
  const nextBrace = createNextIndexFinder(reference, '}')
  let from = 0
  for (;;) {
    const start = reference.indexOf(ZIP_OPEN, from)
    if (start < 0) return undefined
    const idStart = start + ZIP_OPEN.length
    const brace = nextBrace(idStart)
    let idEnd = idStart
    while (idEnd < brace && reference.charCodeAt(idEnd) !== 58 /* : */) idEnd += 1
    if (idEnd > idStart && brace < reference.length) {
      if (idEnd === brace && reference.charCodeAt(brace + 1) === 125) return reference.slice(idStart, idEnd)
      if (idEnd < brace && reference.startsWith(':::', idEnd) && reference.charCodeAt(brace + 1) === 125) {
        return reference.slice(idStart, idEnd)
      }
    }
    from = start + 1
  }
}

/** Every inline `<cool_tool>` marker becomes its server-made zip reference, in order. */
export function replaceCoolToolMarkersWithZipRefs(content: string, zipRefs: unknown): string {
  const refs = referenceList(zipRefs)
  if (!content || refs.length === 0) return content

  const coolToolRefs = refs.filter((ref) => {
    const placeholder = typeof ref?.placeholder === 'string' ? ref.placeholder : ''
    const reference = typeof ref?.reference === 'string' ? ref.reference : ''
    return placeholder.includes('ZIP_COOL_TOOL') || reference.includes('batshit-zip:cool_tool_')
  })

  if (coolToolRefs.length === 0) return content

  let idx = 0
  const lower = asciiLower(content)
  let replaced = replaceMatches(content, scanPairedCoolTools(content, lower), (match) => {
    const ref = coolToolRefs[idx++]
    return (typeof ref?.reference === 'string' && ref.reference) || match
  })

  // Self-closing cool_tool tags, defensively.
  const replacedLower = asciiLower(replaced)
  replaced = replaceMatches(replaced, scanSelfClosingCoolTools(replaced, replacedLower), (match) => {
    const ref = coolToolRefs[idx++]
    return (typeof ref?.reference === 'string' && ref.reference) || match
  })

  return replaced
}

/**
 * The finished text, cleaned: control blocks and a leading Subagent echo removed, `<cool_tool>`
 * tags dropped where zip references already stand for them, excess blank lines collapsed.
 */
export function sanitizeFinishedReplyContent(content: string): string {
  if (!content) {
    return content
  }

  let sanitized = stripZipControlBlocks(content)
  sanitized = stripLeadingSubagentZipEcho(sanitized)

  // Both zip references AND cool_tool tags: the zips are the source of truth.
  const hasZipRefs = scanBracedTokens(sanitized, ZIP_OPEN).length > 0
  const hasCoolToolTags = /<cool_tool[\s>]/.test(sanitized)

  if (hasZipRefs && hasCoolToolTags) {
    sanitized = replaceMatches(sanitized, scanPairedCoolTools(sanitized, asciiLower(sanitized)), () => '')
    sanitized = replaceMatches(sanitized, scanSelfClosingCoolTools(sanitized, asciiLower(sanitized)), () => '')
  } else if (!hasZipRefs) {
    // No zip references: only empty or self-closing cool_tool wrappers go.
    sanitized = replaceMatches(sanitized, scanEmptyCoolTools(sanitized, asciiLower(sanitized)), () => '')
    sanitized = replaceMatches(sanitized, scanSelfClosingCoolTools(sanitized, asciiLower(sanitized)), () => '')
  }

  // Orphaned closing tags.
  sanitized = sanitized.replace(/<\/cool_tool>/gi, '')

  sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim()

  return sanitized
}

/** The zip ids a reply's `zipReferences` entries name, concrete ones only. */
export function zipIdsFromReplyReferences(references: unknown): string[] {
  const ids = new Set<string>()
  const addId = (value: unknown) => {
    const id = typeof value === 'string' ? value.trim() : ''
    if (id && isConcreteZipId(id)) {
      ids.add(id)
    }
  }

  for (const ref of referenceList(references)) {
    if (ref && typeof ref === 'object') {
      addId(ref.zipId)
      addId(ref.zip_id)
      addId(ref.id)
    }
    const reference = typeof ref === 'string'
      ? (ref as string)
      : typeof ref?.reference === 'string'
        ? ref.reference
        : ''
    if (!reference) continue
    addId(firstZipIdInReference(reference))
  }
  return Array.from(ids)
}

/** The concrete zip ids a reply's text references, read with the one shared reader (BL-490). */
export function zipIdsFromReplyContent(content: string): string[] {
  if (!content) return []
  const ids: string[] = []
  for (const reference of scanZipReferences(content)) {
    if (reference.id && isConcreteZipId(reference.id)) {
      ids.push(reference.id)
    }
  }
  return ids
}

/**
 * `end`'s content as it is stored: the Cool Tool markers replaced, the text sanitized, and every
 * reference the reply made but the text lost appended, in the page's order.
 */
export function finishReplyEndContent(content: string, zipReferences: unknown): string {
  const refs = referenceList(zipReferences)
  let finalContent = content
  if (refs.length > 0) {
    finalContent = replaceCoolToolMarkersWithZipRefs(finalContent, refs)
  }

  finalContent = sanitizeFinishedReplyContent(finalContent)

  if (refs.length > 0) {
    const missingRefs = refs
      .map((ref) => (typeof ref?.reference === 'string' ? ref.reference : ''))
      .filter(Boolean)
      .filter((ref) => !finalContent.includes(ref))
    if (missingRefs.length > 0) {
      const refsBlock = missingRefs.join('\n\n')
      finalContent = finalContent.trim().length > 0
        ? `${finalContent}\n\n${refsBlock}`
        : refsBlock
    }
  }
  return finalContent
}

/**
 * The reply's `zipIds` allow-list: every zip its references name, then every zip its text names.
 * Always written, even empty: a reply stored without the key trusts every reference in its text
 * (`messageCompiler.ts`).
 */
export function replyEndZipIds(content: string, zipReferences: unknown): string[] {
  return Array.from(new Set([
    ...zipIdsFromReplyReferences(zipReferences),
    ...zipIdsFromReplyContent(content)
  ]))
}
