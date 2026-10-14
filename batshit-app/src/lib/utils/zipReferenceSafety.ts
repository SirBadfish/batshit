import { normalizeId } from '$lib/utils/idNormalizer'

const ZIP_REFERENCE_OPEN = '{{batshit-zip:'
const CLIP_REFERENCE_OPEN = '{{batshit-clip:'
const DESCRIPTION_MARK = ':::'
const CLOSE_BRACE_CODE = 125 // `}`
/** A zip id: anything but `:`, `{`, `}`, and a line break. Read one past the limit to refuse it. */
const ZIP_ID_RUN = /[^:{}\r\n]{1,161}/y
const ZIP_ID_MAX_LENGTH = 160
/** A clip id: anything but `:`, `}`, and whitespace, of any length. */
const CLIP_ID_RUN = /[^:}\s]+/y
/**
 * BL-707: the older id several readers still keep (BL-609 moves them onto the shared shapes):
 * anything but `:` and `}`, of any length, so `{`, spaces, and line breaks are id characters.
 */
const LOOSE_ID_RUN = /[^:}]+/y

interface ReferenceShape {
  open: string
  /** A sticky pattern for the id's characters: the id is the whole run it matches. */
  idRun: RegExp
  /** A longer id is not a reference. */
  maxIdLength: number
  /** The fewest characters a `:::` description may have (0 for `[^}]*`, 1 for `[^}]+`). */
  minDescriptionLength?: number
}

const ZIP_REFERENCE: ReferenceShape = {
  open: ZIP_REFERENCE_OPEN,
  idRun: ZIP_ID_RUN,
  maxIdLength: ZIP_ID_MAX_LENGTH
}
const CLIP_REFERENCE: ReferenceShape = {
  open: CLIP_REFERENCE_OPEN,
  idRun: CLIP_ID_RUN,
  maxIdLength: Number.POSITIVE_INFINITY
}
const LOOSE_ZIP_REFERENCE: ReferenceShape = {
  open: ZIP_REFERENCE_OPEN,
  idRun: LOOSE_ID_RUN,
  maxIdLength: Number.POSITIVE_INFINITY
}
const LOOSE_CLIP_REFERENCE: ReferenceShape = {
  open: CLIP_REFERENCE_OPEN,
  idRun: LOOSE_ID_RUN,
  maxIdLength: Number.POSITIVE_INFINITY
}
/** BL-707: the chat deletion sweep's own shape: the clip id's rule (no whitespace), a described one never empty. */
const DELETION_SWEEP_ZIP_REFERENCE: ReferenceShape = {
  open: ZIP_REFERENCE_OPEN,
  idRun: CLIP_ID_RUN,
  maxIdLength: Number.POSITIVE_INFINITY,
  minDescriptionLength: 1
}

export interface ReferenceMatch {
  /** Where the reference starts in the scanned text. */
  start: number
  /** Where it ends (just past its `}}`). */
  end: number
  /** The whole reference. */
  match: string
  id: string
  /** The words after `:::`, or undefined when the reference has no `:::` part. */
  description: string | undefined
}

/**
 * Every `{{<open>id}}` and `{{<open>id:::description}}` reference in `content`, in order, read
 * once. It finds exactly what the two shared patterns it replaced found, compared over 9,000
 * generated texts in `zipReferenceSafety.test.ts`:
 * `/\{\{batshit-zip:([^:{}\r\n]{1,160})(?::::([^}]*))?\}\}/g` and
 * `/\{\{batshit-clip:([^:}\s]+)(?::::([^}]*))?\}\}/g`:
 * - the id is the whole run of id characters after the opener; a run longer than the limit (160
 *   for a zip) or an empty one is not a reference;
 * - right after the id comes `}}`, or `:::` and a description that runs to the first `}` after it,
 *   which must be the first of `}}` (so a description never holds a `}`);
 * - anything else is not a reference, and the search resumes one character later.
 *
 * The patterns' description part searched to the first `}` again for every opener, so a reply of
 * openers whose description never closes cost (openers) x (reply length), measured on the one
 * Node process: about 20 s for 20,000 in 620 KB and 40 s in 1 MB, at the reply's end, in each
 * trust, strip, and extract pass, and on every compile. The scan keeps the next `}` until an
 * opener's description starts past it. An id of any length (the clip id, the older shape) costs
 * no more: an id run ends at a `:`, and every opener holds one, so two openers' runs never overlap.
 *
 * The same scan serves the older shape (`scanLooseZipReferences`, BL-707) with its own id rule,
 * and stops after `limit` references for a reader that wants only the first.
 */
function scanReferences(
  content: string,
  shape: ReferenceShape,
  limit = Number.POSITIVE_INFINITY
): ReferenceMatch[] {
  const { open, idRun, maxIdLength, minDescriptionLength = 0 } = shape
  const found: ReferenceMatch[] = []
  if (!content || !content.includes(open)) return found

  let from = 0
  let braceFrom = -1 // where the last `}` lookup started
  let braceAt = -1 // the first `}` at or after braceFrom, or content.length when there is none

  for (;;) {
    const start = content.indexOf(open, from)
    if (start < 0) break
    const idStart = start + open.length
    idRun.lastIndex = idStart
    const id = idRun.exec(content)?.[0] ?? ''
    if (!id || id.length > maxIdLength) {
      from = start + 1
      continue
    }
    const idEnd = idStart + id.length

    let end = -1
    let description: string | undefined
    if (content.startsWith(DESCRIPTION_MARK, idEnd)) {
      const descriptionStart = idEnd + DESCRIPTION_MARK.length
      if (descriptionStart < braceFrom || braceAt < descriptionStart) {
        braceFrom = descriptionStart
        braceAt = content.indexOf('}', descriptionStart)
        if (braceAt < 0) braceAt = content.length
      }
      if (
        content.charCodeAt(braceAt + 1) === CLOSE_BRACE_CODE &&
        braceAt - descriptionStart >= minDescriptionLength
      ) {
        description = content.slice(descriptionStart, braceAt)
        end = braceAt + 2
      }
    } else if (
      content.charCodeAt(idEnd) === CLOSE_BRACE_CODE &&
      content.charCodeAt(idEnd + 1) === CLOSE_BRACE_CODE
    ) {
      end = idEnd + 2
    }
    if (end < 0) {
      from = start + 1
      continue
    }

    found.push({ start, end, match: content.slice(start, end), id, description })
    if (found.length >= limit) break
    from = end
  }

  return found
}

/**
 * THE zip reference reader, for every reader that neutralizes, trusts, or extracts one (BL-490).
 * The id is 1 to 160 characters with no `:`, `{`, `}`, or line break, so an unclosed prefix in
 * ordinary prose never swallows the words up to a later `}}`. Spaces are allowed: the chat
 * page's extractor (which writes a reply's `zipIds`) read `{{batshit-zip:id :::x}}` as the zip
 * `id`, while the shared shape refused a space and so never neutralized it. A reference Batshit
 * writes never has a space in its id, so `isConcreteZipId` refuses one, and a spaced reference is
 * always neutralized.
 */
export function scanZipReferences(content: string): ReferenceMatch[] {
  return scanReferences(content, ZIP_REFERENCE)
}

/** Every `{{batshit-clip:id}}` and `{{batshit-clip:id:::name}}` reference in `content`. */
export function scanClipReferences(content: string): ReferenceMatch[] {
  return scanReferences(content, CLIP_REFERENCE)
}

/**
 * BL-707: every zip reference of the older shape several readers still keep, in order, read
 * once: exactly what `/\{\{batshit-zip:([^:}]+)(?::::([^}]*))?\}\}/g` found (compared over
 * thousands of generated texts in `zipReferenceSafety.test.ts`). Its id is any run of characters
 * other than `:` and `}`, so it may hold `{`, spaces, and line breaks, which the shared shape
 * (`scanZipReferences`) refuses; the description rule is the shared one. The pattern searched to
 * the first `}` again from every opener, seconds to minutes of the one Node process for a text of
 * openers that never close. Its readers keep their own rules until BL-609 moves each onto the
 * shared shape: the reply-end step's current tool zips (`replyControlFinalize.ts`), Judge Juice
 * (`jevJuiceTurn.ts`), manual trim protection (`tokenPanel.ts`), and `extractZipIdFromReference`.
 */
export function scanLooseZipReferences(content: string): ReferenceMatch[] {
  return scanReferences(content, LOOSE_ZIP_REFERENCE)
}

/** `content` with each zip reference of the older shape replaced by `replacer(reference, id, description)`. */
export function replaceLooseZipReferences(
  content: string,
  replacer: (match: string, id: string, description: string | undefined) => string
): string {
  return replaceFound(content, scanLooseZipReferences(content), (reference) =>
    replacer(reference.match, reference.id, reference.description)
  )
}

/** The clip form of `scanLooseZipReferences`: `/\{\{batshit-clip:([^:}]+)(?::::([^}]*))?\}\}/g`. */
export function scanLooseClipReferences(content: string): ReferenceMatch[] {
  return scanReferences(content, LOOSE_CLIP_REFERENCE)
}

/**
 * BL-707: the zip references the chat deletion sweep reads in each stored message
 * (`redis.deleteSession`), read once: exactly what
 * `/\{\{batshit-zip:([^:}\s]+)(?::::[^}]+)?\}\}/g` found, an id with no whitespace and a
 * description of at least one character. The pattern searched to the first `}` again from every
 * opener, seconds of the one Node process per message inside the delete.
 */
export function scanDeletionSweepZipReferences(content: string): ReferenceMatch[] {
  return scanReferences(content, DELETION_SWEEP_ZIP_REFERENCE)
}

/**
 * The zip id of the first reference (the older shape) in one `zipReferences` entry's text, or
 * null: what `/api/sse`, `send-routed`, and `collectTrustedZipIdsFromMetadata` read from each
 * entry. An entry is not only server-written (a resumed reply's stored metadata is the browser's),
 * so it is read once like a reply (BL-707). A non-string reads as no id.
 */
export function extractZipIdFromReference(reference: string): string | null {
  if (typeof reference !== 'string' || !reference) return null
  return scanReferences(reference, LOOSE_ZIP_REFERENCE, 1)[0]?.id ?? null
}

/** The clip form of `extractZipIdFromReference`, for `collectTrustedClipIdsFromMetadata`. */
function extractClipIdFromReference(reference: string): string | null {
  if (!reference) return null
  return scanReferences(reference, LOOSE_CLIP_REFERENCE, 1)[0]?.id ?? null
}

function replaceFound<T extends { start: number; end: number }>(
  content: string,
  found: T[],
  replace: (reference: T) => string
): string {
  if (found.length === 0) return content
  const parts: string[] = []
  let from = 0
  for (const reference of found) {
    parts.push(content.slice(from, reference.start), replace(reference))
    from = reference.end
  }
  parts.push(content.slice(from))
  return parts.join('')
}

/** `content` with each zip reference replaced by `replacer(reference, id, description)`. */
export function replaceZipReferences(
  content: string,
  replacer: (match: string, id: string, description: string | undefined) => string
): string {
  return replaceFound(content, scanZipReferences(content), (reference) =>
    replacer(reference.match, reference.id, reference.description)
  )
}

/** `content` with each clip reference replaced by `replacer(reference, id, description)`. */
export function replaceClipReferences(
  content: string,
  replacer: (match: string, id: string, description: string | undefined) => string
): string {
  return replaceFound(content, scanClipReferences(content), (reference) =>
    replacer(reference.match, reference.id, reference.description)
  )
}

const LEGACY_CLIP_OPEN = '{{batshit-clip|'
const LEGACY_CLIP_CLOSE = '{{/batshit-clip}}'
/** One code unit a legacy clip id may hold (no `|`, no `}`, no whitespace). */
const LEGACY_CLIP_ID_CHAR = /[^|}\s]/
const LEGACY_CLIP_ID_RUN = /[^|}\s]+/y
/** What `\b` counts as a word character in a pattern without the `u` flag. */
const WORD_CHAR = /\w/

export interface LegacyClipReference {
  /** Where the block starts in the scanned text. */
  start: number
  /** Where the block ends (just past its `{{/batshit-clip}}`). */
  end: number
  /** The whole block, header, body, and closing tag. */
  match: string
  /** The id the header names. */
  clipId: string
}

/**
 * The last `id:` in a legacy clip header that starts an id: no word character before it and a
 * first id character after it. The header is `content[headerStart, headerEnd)`.
 */
function lastLegacyClipIdAt(content: string, headerStart: number, headerEnd: number): number {
  for (let at = headerEnd - 4; at >= headerStart; at--) {
    if (
      content.charCodeAt(at) === 105 && // i
      content.charCodeAt(at + 1) === 100 && // d
      content.charCodeAt(at + 2) === 58 && // :
      !WORD_CHAR.test(content[at - 1]) &&
      LEGACY_CLIP_ID_CHAR.test(content[at + 3])
    ) {
      return at
    }
  }
  return -1
}

/**
 * Every legacy clip block, `{{batshit-clip|…id:X…}}body{{/batshit-clip}}`, in `content`, in
 * order. It finds exactly what the lazy pattern it replaced found,
 * `/\{\{batshit-clip\|[^}]*\bid:([^|}\s]+)[^}]*\}\}[\s\S]*?\{\{\/batshit-clip\}\}/g`, compared
 * over 9,000 generated texts in `zipReferenceSafety.test.ts`:
 * - the header runs from `{{batshit-clip|` to the first `}` after it, and that `}` must be the
 *   first of `}}`;
 * - the id is the longest run of characters other than `|`, `}`, and whitespace after the LAST
 *   `id:` in the header that has no word character before it;
 * - the block ends at the first `{{/batshit-clip}}` after the header, so a later block's opener
 *   inside the body is part of this one;
 * - a header that fails any of these is not a block, and the search resumes one character later.
 *
 * The pattern retried every opener against the rest of the text, measured on the one Node
 * process: 10 to 13 s for 20,000 openers in 620 KB with no closing tag, 31 to 34 s for 20,000
 * openers in 1 MB that share one header with no id, and a header with no `}` at all backtracked
 * worse still (500 such openers in 16 KB took 12 to 15 s; 1,000 did not finish in a minute),
 * at the reply's end and again on every compile of the message. This scan reads the text once:
 * each lookup (the next `}`, the next closing tag, the header's last `id:`) is kept until an
 * opener lies past it, and a text with no `}` or no closing tag after an opener has no block
 * after it either.
 */
export function scanLegacyClipReferences(content: string): LegacyClipReference[] {
  const found: LegacyClipReference[] = []
  if (!content || !content.includes(LEGACY_CLIP_OPEN)) return found

  let from = 0
  let braceAt = -1 // the first `}` at or after the current header's start
  let closeAt = -1 // the first closing tag after the current header
  let idHeaderEnd = -1 // the header end the last id lookup was for
  let idAt = -1 // that lookup's answer, or -1

  for (;;) {
    const open = content.indexOf(LEGACY_CLIP_OPEN, from)
    if (open < 0) break
    const headerStart = open + LEGACY_CLIP_OPEN.length

    if (braceAt < headerStart) braceAt = content.indexOf('}', headerStart)
    if (braceAt < 0) break
    const headerEnd = braceAt
    if (content.charCodeAt(headerEnd + 1) !== CLOSE_BRACE_CODE) {
      from = open + 1
      continue
    }

    if (closeAt < headerEnd + 2) closeAt = content.indexOf(LEGACY_CLIP_CLOSE, headerEnd + 2)
    if (closeAt < 0) break

    if (idHeaderEnd !== headerEnd) {
      idHeaderEnd = headerEnd
      idAt = lastLegacyClipIdAt(content, headerStart, headerEnd)
    }
    if (idAt < headerStart) {
      from = open + 1
      continue
    }

    LEGACY_CLIP_ID_RUN.lastIndex = idAt + 3
    const clipId = LEGACY_CLIP_ID_RUN.exec(content)?.[0] ?? ''
    const end = closeAt + LEGACY_CLIP_CLOSE.length
    found.push({ start: open, end, match: content.slice(open, end), clipId })
    from = end
  }

  return found
}

/** `content` with each legacy clip block replaced by `replacer(block, clipId)`. */
export function replaceLegacyClipReferences(
  content: string,
  replacer: (match: string, clipId: string) => string
): string {
  return replaceFound(content, scanLegacyClipReferences(content), (reference) =>
    replacer(reference.match, reference.clipId)
  )
}

const CONCRETE_ZIP_ID_PATTERNS = [
  /^(zip|upload|terminal|diff|error|cool_tool|tool_raw|file|image|document|web)_\d{10,}_[a-z0-9]{4,12}$/i,
  /^tool_[a-z0-9_-]+_\d{10,}_[a-z0-9]{4,12}$/i
]

const CONCRETE_CLIP_ID_PATTERNS = [
  /^clip_\d{10,}_[a-z0-9]{4,12}$/i,
  /^clip_\d{10,}_[a-z0-9]{4,12}_\d+$/i,
  /^clip_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
]

function normalizeTrustedIds(trustedIds?: Set<string> | string[] | null): Set<string> | null {
  if (!trustedIds) return null
  const values = trustedIds instanceof Set ? Array.from(trustedIds) : trustedIds
  return new Set(values.map((id) => normalizeId(id)).filter(Boolean))
}

export function isConcreteZipId(id: string): boolean {
  if (typeof id !== 'string' || /\s/.test(id)) return false
  const raw = id
  if (!raw) return false
  if (raw.includes('...')) return false
  return CONCRETE_ZIP_ID_PATTERNS.some((pattern) => pattern.test(raw))
}

export function isTrustedZipReferenceId(
  id: string,
  trustedZipIds?: Set<string> | string[] | null,
  options: { allowConcreteWithoutTrustedSet?: boolean } = {}
): boolean {
  const trusted = normalizeTrustedIds(trustedZipIds)
  const normalized = normalizeId(id)

  if (trusted) {
    return trusted.has(normalized)
  }

  return options.allowConcreteWithoutTrustedSet ? isConcreteZipId(id) : false
}

export function neutralizeAllZipReferenceSyntax(content: string): string {
  if (!content || !content.includes('{{batshit-zip:')) return content
  return replaceZipReferences(content, () => '[zip reference omitted]')
}

export function neutralizeUntrustedZipReferenceSyntax(
  content: string,
  options: {
    trustedZipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string {
  if (!content || !content.includes('{{batshit-zip:')) return content

  return replaceZipReferences(content, (match, zipId) =>
    isTrustedZipReferenceId(zipId, options.trustedZipIds, {
      allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
    })
      ? match
      : '[zip reference omitted]'
  )
}

/**
 * BL-490: a finished reply's words, with every zip reference it does not own and every clip
 * reference neutralized. send-routed runs this ONCE, in `finalizeAssistantMessage`, for every
 * way a reply ends (finished, stopped, failed): the per-chunk neutralizer cannot see a reference
 * the model echoed across two chunks, and the Stop and failure paths once saved the raw words.
 * `trustedZipIds` are the reply's own zips (its tool results, images, inline zips).
 */
export function neutralizeFinishedReplyReferences(
  content: string,
  trustedZipIds: Set<string> | string[]
): string {
  if (!content) return content
  return neutralizeAllClipReferenceSyntax(
    neutralizeUntrustedZipReferenceSyntax(content, { trustedZipIds })
  )
}

/**
 * BL-490: whether a stored zip names a chat or a user other than the compile's. The compile
 * never expands such a zip into another chat's prompt, whatever allow-list a message carries
 * (a browser posts the history, and its `zipIds` come from the page). A zip that names neither
 * is left to the caller's other rules, as read-time trust repair does (`messageZipTrust.ts`).
 */
export function zipBelongsToAnotherChat(
  zipData: unknown,
  owner: { sessionId: string; userId?: string | null }
): boolean {
  if (!zipData || typeof zipData !== 'object') return false
  const record = zipData as Record<string, any>
  const read = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const zipUserId = read(
    record.metadata?.userId ?? record.metadata?.user_id ?? record.userId ?? record.user_id
  )
  if (zipUserId && owner.userId && zipUserId !== owner.userId) return true
  const zipSessionId = read(
    record.metadata?.sessionId ??
      record.metadata?.session_id ??
      record.sessionId ??
      record.session_id
  )
  return Boolean(zipSessionId && zipSessionId !== owner.sessionId)
}

export function extractTrustedZipIdsFromContent(
  content: string,
  options: {
    trustedZipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string[] {
  if (!content || !content.includes('{{batshit-zip:')) return []

  const ids = new Set<string>()
  for (const reference of scanZipReferences(content)) {
    const zipId = reference.id
    if (
      zipId &&
      isTrustedZipReferenceId(zipId, options.trustedZipIds, {
        allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
      })
    ) {
      ids.add(zipId)
    }
  }

  return Array.from(ids)
}

/**
 * The concrete zip ids a message's metadata names: `zipIds`, `zip_ids`, and each `zipReferences`
 * entry (its id fields, or the first reference in its text). `isConcreteZipId` gates every id.
 */
export function collectTrustedZipIdsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return []

  const ids = new Set<string>()
  const record = metadata as Record<string, any>
  const add = (value: unknown) => {
    if (typeof value === 'string' && isConcreteZipId(value)) {
      ids.add(value.trim())
    }
  }
  const addArray = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(add)
    }
  }

  addArray(record.zipIds)
  addArray(record.zip_ids)

  if (Array.isArray(record.zipReferences)) {
    for (const entry of record.zipReferences) {
      if (typeof entry === 'string') {
        add(extractZipIdFromReference(entry) ?? entry)
      } else if (entry && typeof entry === 'object') {
        add((entry as Record<string, any>).zipId)
        add((entry as Record<string, any>).zip_id)
        add((entry as Record<string, any>).id)
        const reference = (entry as Record<string, any>).reference
        if (typeof reference === 'string') add(extractZipIdFromReference(reference))
      }
    }
  }

  return Array.from(ids)
}

export function isConcreteClipId(id: string): boolean {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (!raw) return false
  if (raw.includes('...')) return false
  return CONCRETE_CLIP_ID_PATTERNS.some((pattern) => pattern.test(raw))
}

export function isTrustedClipReferenceId(
  id: string,
  trustedClipIds?: Set<string> | string[] | null,
  options: { allowConcreteWithoutTrustedSet?: boolean } = {}
): boolean {
  const trusted = normalizeTrustedIds(trustedClipIds)
  const normalized = normalizeId(id)

  if (trusted) {
    return trusted.has(normalized)
  }

  return options.allowConcreteWithoutTrustedSet ? isConcreteClipId(id) : false
}

export function neutralizeAllClipReferenceSyntax(content: string): string {
  if (!content || !content.includes('{{batshit-clip')) return content
  return replaceClipReferences(
    replaceLegacyClipReferences(content, () => '[clip reference omitted]'),
    () => '[clip reference omitted]'
  )
}

export function neutralizeUntrustedClipReferenceSyntax(
  content: string,
  options: {
    trustedClipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string {
  if (!content || !content.includes('{{batshit-clip')) return content

  const replaceIfUntrusted = (match: string, clipId: string) =>
    isTrustedClipReferenceId(clipId, options.trustedClipIds, {
      allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
    })
      ? match
      : '[clip reference omitted]'

  return replaceClipReferences(
    replaceLegacyClipReferences(content, replaceIfUntrusted),
    replaceIfUntrusted
  )
}

export function stripTrustedClipReferenceSyntax(
  content: string,
  options: {
    trustedClipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string {
  if (!content || !content.includes('{{batshit-clip')) return content

  const stripIfTrusted = (match: string, clipId: string) =>
    isTrustedClipReferenceId(clipId, options.trustedClipIds, {
      allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
    })
      ? ''
      : match

  return replaceClipReferences(replaceLegacyClipReferences(content, stripIfTrusted), stripIfTrusted)
}

export function extractTrustedClipIdsFromContent(
  content: string,
  options: {
    trustedClipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string[] {
  if (!content || !content.includes('{{batshit-clip')) return []

  const ids = new Set<string>()
  const addIfTrusted = (clipId: string) => {
    if (
      clipId &&
      isTrustedClipReferenceId(clipId, options.trustedClipIds, {
        allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
      })
    ) {
      ids.add(clipId)
    }
  }

  for (const reference of scanClipReferences(content)) {
    addIfTrusted(reference.id)
  }

  for (const reference of scanLegacyClipReferences(content)) {
    addIfTrusted(reference.clipId)
  }

  return Array.from(ids)
}

/**
 * The concrete clip ids a message's metadata names. Every `saveMessage` runs it on the metadata
 * the browser posted (`POST /api/messages`), so each `clipReferences` entry is read once
 * (BL-707); `isConcreteClipId` gates every id.
 */
export function collectTrustedClipIdsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return []

  const ids = new Set<string>()
  const record = metadata as Record<string, any>
  const add = (value: unknown) => {
    if (typeof value === 'string' && isConcreteClipId(value)) {
      ids.add(value.trim())
    }
  }
  const addArray = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(add)
    }
  }

  add(record.clipId)
  add(record.clip_id)
  addArray(record.clipIds)
  addArray(record.clip_ids)

  if (Array.isArray(record.clippedItems)) {
    for (const item of record.clippedItems) {
      add(item?.clipId)
      add(item?.clip_id)
      add(item?.id)
    }
  }

  if (Array.isArray(record.clipReferences)) {
    for (const entry of record.clipReferences) {
      if (typeof entry === 'string') {
        add(extractClipIdFromReference(entry) ?? entry)
      } else if (entry && typeof entry === 'object') {
        add((entry as Record<string, any>).clipId)
        add((entry as Record<string, any>).clip_id)
        add((entry as Record<string, any>).id)
        const reference = (entry as Record<string, any>).reference
        if (typeof reference === 'string') add(extractClipIdFromReference(reference))
      }
    }
  }

  return Array.from(ids)
}
