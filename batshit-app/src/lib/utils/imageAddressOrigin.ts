/**
 * Where an outside picture's address came from (BL-474, step 2). Josh's decision (Sunday
 * 2026-09-27): an address that the agent built itself is blocked, with no Load action. Batshit
 * cannot know how a model made an address; it can know whether the address was in what the model
 * read. So the server keeps, for each turn, the RECORD: every whole address in the bytes that were
 * delivered to the model, each with the source it came from, and decides once, when the reply
 * ends. The address-origin contract below is shared by every reader.
 *
 * The decision, in this order, for each outside picture address of the reply:
 *   1. the whole address is in the record                                  -> `as_read`
 *   2. a shorter address in the record is its start                       -> `blocked`
 *   3. its path, query, or fragment holds a run of 12 or more characters
 *      that also stands in a user message, a tool result, or a memory     -> `blocked` ("may")
 *   4. none of the above, and the record is complete                      -> `blocked`
 *   5. none of the above, and the record is not complete                  -> `unknown`
 *
 * The function returns the EVIDENCE for each rule (Faye, 2026-09-29), and one table below maps
 * the evidence to the state, the rule, and the line the box shows, in the design's order. A change
 * of the order is a row of the table, never a change of what is measured.
 *
 * It is a rule with evidence, not a proof: the box says what is known and never says "safe".
 * Pure, with no imports, so the server decides with it, the page reads its lines, and the tests
 * pin it.
 */

export type ImageAddressOriginState = 'as_read' | 'blocked' | 'unknown'
export type ImageAddressOriginRule = 1 | 2 | 3 | 4 | 5

/** What is known about one address, for every rule (each field is measured, whatever the others say). */
export type ImageAddressEvidence = {
  /** Rule 1: the whole address is in the record. */
  inRecord: boolean
  /** Rule 2: a shorter address in the record is its start. */
  startInRecord: boolean
  /**
   * Rule 3: a run of 12 or more characters of its path, query, or fragment stands in a user,
   * tool-result, or memory text, outside the record's own whole addresses.
   */
  sharesChatRun: boolean
  /** Rules 4 and 5: Batshit accounted for every input of the turn. */
  complete: boolean
}

export type ImageAddressOriginOutcome = {
  state: ImageAddressOriginState
  rule: ImageAddressOriginRule
  /** The line under the picture's box (none for an address as read: the box shows the website). */
  line: string | null
}

export type ImageAddressOriginDecision = ImageAddressOriginOutcome & { evidence: ImageAddressEvidence }

/**
 * THE TABLE: the evidence to the state, the rule, and the line, in the design's order. The first
 * row whose condition holds decides. Each line says only what Batshit knows.
 */
export const IMAGE_ADDRESS_ORIGIN_TABLE: ReadonlyArray<
  ImageAddressOriginOutcome & { when: (evidence: ImageAddressEvidence) => boolean }
> = [
  {
    rule: 3,
    state: 'unknown',
    line: 'This address may contain text from the chat.',
    when: (evidence) => evidence.inRecord && evidence.sharesChatRun
  },
  { rule: 1, state: 'as_read', line: null, when: (evidence) => evidence.inRecord },
  {
    rule: 2,
    state: 'blocked',
    line: 'Only the start of this address was in what the agent read.',
    when: (evidence) => evidence.startInRecord
  },
  {
    rule: 3,
    state: 'blocked',
    line: 'This address may contain text from the chat.',
    when: (evidence) => evidence.sharesChatRun
  },
  { rule: 4, state: 'blocked', line: 'This address was not in what the agent read.', when: (evidence) => evidence.complete },
  { rule: 5, state: 'unknown', line: 'Batshit cannot tell where this address came from.', when: () => true }
]

/** The first row of the table that the evidence meets. */
export function decideImageAddressOrigin(evidence: ImageAddressEvidence): ImageAddressOriginOutcome {
  const row = IMAGE_ADDRESS_ORIGIN_TABLE.find((candidate) => candidate.when(evidence))!
  return { state: row.state, rule: row.rule, line: row.line }
}

/** The line for a stored decision's rule (the page shows the server's decision; it never decides). */
export function imageAddressOriginLine(rule: ImageAddressOriginRule): string | null {
  return IMAGE_ADDRESS_ORIGIN_TABLE.find((row) => row.rule === rule)?.line ?? null
}

/**
 * Where a piece of the model's input came from. The compiler labels every piece; the record
 * decides which of them count as read.
 * - `batshit`: text Batshit compiled (the system prompt's blocks, the DCM, a post-compile addendum).
 * - `memory`: the agent's memories (Awareness, the DCM's memory lines).
 * - `user`: the human's own words (a message, a steer, a text Clip).
 * - `note`: a message Batshit delivered from outside the chat's agents: a webhook's wake.
 * - `agent_note`: every other message Batshit delivered for someone else: a DM, a DM steer, a
 *   schedule's wake (an agent can write a schedule's text), an artifact share, a group follow-up.
 *   Another agent's words are not read, as in a group chat (build note gap 1, reviews of
 *   2026-09-29): else agent B builds an address and agent A repeats it as read. Rule 3 still reads
 *   its text.
 * - `summary`: a history entry of the system role (a Compact summary, a graduation gist, the Trim
 *   notice). A summary is written by a model, so its addresses are not read.
 * - `tool_result`: a tool result as it was delivered to the model.
 * - `agent_words`: an assistant message as compiled, the agent's own or another agent's. An address
 *   that stands only here is not read, unless the server's own decision for that reply said
 *   `as_read` (`messageId` names the reply).
 */
export type AddressSourceKind =
  | 'batshit'
  | 'memory'
  | 'user'
  | 'note'
  | 'agent_note'
  | 'summary'
  | 'tool_result'
  | 'agent_words'

/**
 * A Batshit-written message (`isBatshitWrittenUserMessage`) whose words come from outside the
 * chat's agents: only a webhook's wake (`metadata.origin.kind === 'webhook'`; every wake files a DM
 * record, so `wake.dmId` does not tell the kinds apart). A DM, a schedule (an agent can create one
 * and write its text; the wake does not say who did), an artifact share, and anything unknown are
 * another agent's words (`agent_note`).
 */
export function isOutsideNote(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  const record = metadata as Record<string, any>
  return Boolean(record.wake) && record.origin?.kind === 'webhook'
}

export type AddressSourcePiece = {
  source: AddressSourceKind
  text: string
  /** The reply an `agent_words` piece is (its stored decision may vouch for its addresses). */
  messageId?: string
}

/** The sources whose whole addresses count as read (rules 1 and 2). */
const READ_SOURCES: ReadonlySet<AddressSourceKind> = new Set([
  'batshit',
  'memory',
  'user',
  'note',
  'tool_result'
])

/**
 * The sources rule 3 reads for a run of the chat's text: the design's user messages, tool results,
 * and memories, plus what carries the same text (a delivered note, a summary of the chat).
 */
const RUN_SOURCES: ReadonlySet<AddressSourceKind> = new Set([
  'memory',
  'user',
  'note',
  'agent_note',
  'summary',
  'tool_result'
])

export type ImageAddressRecord = {
  /** The match form (`toAddressMatchForm`) of every whole address that counts as read. */
  readAddresses: ReadonlySet<string>
  /** A scanner-capped address token's match form; usable only as rule-2 start evidence. */
  readAddressPrefixes: ReadonlySet<string>
  /** The texts rule 3 reads. */
  runTexts: readonly RunSourceText[]
  /** Batshit accounted for every input of the turn (never on a managed lane). */
  complete: boolean
}

export const RUN_LENGTH = 12

const SCHEME_START = '(?:https?:\\/\\/|\\/\\/)'
/** A character that may stand right before a whole address: anything but a scheme character. */
const SCHEME_CHARACTER = /[A-Za-z0-9+.-]/
/**
 * The characters an address token is made of: anything but white space, control characters, and
 * the characters that end an address in text, HTML, JSON, or Markdown.
 */
const TOKEN_CHARACTER = /[^\s\u0000-\u001f\u007f<>"`{}|^,]/
const TRAILING_PUNCTUATION = new Set(['.', ',', ':', ';', '!', '?', '*', '_', '~', '。', '，', '、', '；', '：', '！', '？', '’', '”'])
/**
 * The longest address token read. A picture address is far shorter; a longer run of address
 * characters in a hostile page is cut here so reading it stays linear (review of 2026-09-29). A
 * real address longer than this is recorded cut, so its exact repeat is blocked by rule 2 (safe).
 */
export const MAX_ADDRESS_TOKEN_LENGTH = 8_192

/** Trailing sentence punctuation and unbalanced closing brackets off a token, in one backward pass. */
function trimTrailing(token: string): string {
  let parentheses = 0
  let brackets = 0
  for (let i = 0; i < token.length; i++) {
    const character = token[i]
    if (character === '(') parentheses += 1
    else if (character === ')') parentheses -= 1
    else if (character === '[') brackets += 1
    else if (character === ']') brackets -= 1
  }
  let end = token.length
  while (end > 0) {
    const character = token[end - 1]
    if (TRAILING_PUNCTUATION.has(character)) {
      end -= 1
    } else if (character === ')' && parentheses < 0) {
      parentheses += 1
      end -= 1
    } else if (character === ']' && brackets < 0) {
      brackets += 1
      end -= 1
    } else {
      break
    }
  }
  return token.slice(0, end)
}

/**
 * Every whole `http:`/`https:` address in a text, in order. A whole address starts where no scheme
 * character stands before it and runs to the first character that ends an address. An address
 * inside a longer one (`https://a.example/?next=https://b.example/`) is part of that one and is
 * never a token of its own. Each token is given as written and, when they differ, without its
 * trailing sentence punctuation and unbalanced closing brackets (`(https://a.example/x).`).
 * Entities are left as written; `buildImageAddressRecord` decodes each token once.
 */
export function extractWholeAddresses(text: string): string[] {
  const found: string[] = []
  for (const span of scanWholeAddressSpans(text)) {
    const trimmed = trimTrailing(span.token)
    if (trimmed.length > span.schemeLength) {
      found.push(trimmed)
      if (trimmed !== span.token) found.push(span.token)
    }
  }
  return found
}

type WholeAddressSpan = { start: number; end: number; token: string; schemeLength: number; quoted: boolean; truncated: boolean }
type RunSourceText = { text: string; spans: readonly { start: number; end: number; forms: ReadonlySet<string> }[] }

/** One JSON escape layer, without requiring a whole tool response to be JSON. */
function unescapeJsonText(text: string): string {
  return text.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (escape) => {
    if (escape.startsWith('\\u')) return String.fromCharCode(parseInt(escape.slice(2), 16))
    const values: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
    return values[escape[1]] ?? escape
  })
}

function textVariants(text: string): string[] {
  const decoded = unescapeJsonText(text)
  return decoded === text ? [text] : [text, decoded]
}

function scanWholeAddressSpans(text: string): WholeAddressSpan[] {
  const spans: WholeAddressSpan[] = []
  if (!text) return spans
  const scan = new RegExp(SCHEME_START, 'gi')
  let match: RegExpExecArray | null
  while ((match = scan.exec(text)) !== null) {
    const start = match.index
    const before = text[start - 1]
    const quoted = before === '"' || before === "'" || before === '`'
    let end = start + match[0].length
    while (end < text.length) {
      const character = text[end]
      const sentenceBoundary = /[。，、；：！？’”]/.test(character)
      if (quoted ? character === before || /[\r\n<>]/.test(character) : !TOKEN_CHARACTER.test(character) || sentenceBoundary) break
      // An encoded quote is a boundary in printed HTML text, not permission to swallow its tail.
      if (/^&(?:quot|apos|gt|lt|#(?:34|39|60|62)|#x(?:22|27|3c|3e));/i.test(text.slice(end, end + 10))) break
      end += 1
    }
    scan.lastIndex = end
    if (start > 0 && (SCHEME_CHARACTER.test(before) || match[0] === '//' && /[:/\\]/.test(before))) continue
    const cut = Math.min(end, start + MAX_ADDRESS_TOKEN_LENGTH)
    // `end` owns the full lexical token for rule 3's self-exclusion; only `token` is capped for
    // normalization and address-prefix evidence.
    spans.push({ start, end, token: text.slice(start, cut), schemeLength: match[0].length, quoted, truncated: cut < end })
  }
  return spans
}

/**
 * A text with each of its whole addresses replaced by one space: rule 3 reads the chat's text
 * outside the record's addresses, or each address that was read would match itself.
 */

/**
 * The form two addresses are compared in: the address exactly as the browser will request it
 * (the WHATWG URL parser, as `imageSource.ts` gives the picture its address). So the scheme and
 * the host are in lower case, an empty path is `/`, a default port is dropped, a backslash is a
 * slash and a tab or line break inside the address is gone, as they are for the request itself;
 * the user part, the path, the query, and the fragment are otherwise as written (no fuzzy match).
 * `null` for anything that is not an absolute `http:`/`https:` address with a host.
 */
export function toAddressMatchForm(address: string): string | null {
  let parsed: URL
  try {
    const value = address.trim()
    parsed = new URL(value.startsWith('//') ? `https:${value}` : value)
  } catch {
    return null
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null
  return parsed.href
}

/** Protocol-relative sources and replies are judged with both browser schemes. */
export function toAddressMatchForms(address: string): string[] {
  const value = address.trim()
  const candidates = value.startsWith('//') ? [`https:${value}`, `http:${value}`] : [value]
  return [...new Set(candidates.map(toAddressMatchForm).filter((form): form is string => form !== null))]
}

export type BuildImageAddressRecordOptions = {
  /** Batshit accounted for every input of the turn. */
  complete: boolean
  /**
   * The server's own decided records of earlier replies: for a reply id, the match forms its
   * decision judged `as_read`. Never a browser's copy.
   */
  earlierAsRead?: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * The one entity-decoding step (the reply parser's own, for an attribute value), applied to each
   * address token as written; the decoded token is read for whole addresses again, so a decoded
   * `&quot;` or `&gt;` ends the address as it does on the page.
   */
  decode?: (token: string) => string
}

/** The record of one turn, from the labelled pieces of what was delivered to the model. */
export function buildImageAddressRecord(
  pieces: readonly AddressSourcePiece[],
  options: BuildImageAddressRecordOptions
): ImageAddressRecord {
  const decode = options.decode ?? ((text: string) => text)
  const readAddresses = new Set<string>()
  const readAddressPrefixes = new Set<string>()
  const runTexts: RunSourceText[] = []
  for (const piece of pieces) {
    if (!piece || typeof piece.text !== 'string' || !piece.text) continue
    const vouched = piece.source === 'agent_words' && piece.messageId ? options.earlierAsRead?.get(piece.messageId) : undefined
    for (const text of textVariants(piece.text)) {
      const spans = scanWholeAddressSpans(text)
      const runSpans: RunSourceText['spans'][number][] = []
      for (const span of spans) {
        const written = span.quoted ? span.token : trimTrailing(span.token)
        const tokens = textVariants(written).flatMap((variant) => {
          const decoded = decode(variant)
          return span.quoted ? [decoded] : extractWholeAddresses(decoded)
        })
        const forms = new Set(tokens.flatMap(toAddressMatchForms))
        runSpans.push({ start: span.start, end: span.end, forms })
        for (const form of forms) {
          if (READ_SOURCES.has(piece.source) || vouched?.has(form)) {
            if (span.truncated) readAddressPrefixes.add(form)
            else readAddresses.add(form)
          }
        }
      }
      if (RUN_SOURCES.has(piece.source)) runTexts.push({ text, spans: runSpans })
    }
  }
  return { readAddresses, readAddressPrefixes, runTexts, complete: options.complete === true }
}

const HASH_BASE = 0x01000193

function hashOf(window: string): number {
  let hash = 0
  for (let i = 0; i < window.length; i++) hash = (Math.imul(hash, HASH_BASE) + window.charCodeAt(i)) | 0
  return hash
}

type RunOwners = Map<number, Array<{ window: string; owners: Set<number> }>>

/**
 * Marks in `found` each address (by index) that has a run of `RUN_LENGTH` characters in `text`:
 * one linear pass with a rolling hash over UTF-16 code units (h = sum(c_i * B^(n-1-i)) mod 2^32),
 * and an exact compare on each hash hit. Stops once every address with a run is marked.
 */
function markRuns(source: RunSourceText, runs: RunOwners, found: Set<number>, wanted: number,
  forms: readonly string[][], inRecord: readonly boolean[], startInRecord: readonly boolean[]): void {
  const text = source.text
  let spanIndex = 0
  if (text.length < RUN_LENGTH || found.size >= wanted) return
  let power = 1
  for (let i = 0; i < RUN_LENGTH - 1; i++) power = Math.imul(power, HASH_BASE)
  let hash = hashOf(text.slice(0, RUN_LENGTH))
  for (let start = 0; ; start++) {
    const candidates = runs.get(hash)
    if (candidates) {
      const window = text.slice(start, start + RUN_LENGTH)
      for (const candidate of candidates) {
        if (candidate.window !== window) continue
        while (spanIndex < source.spans.length && source.spans[spanIndex].end <= start) spanIndex += 1
        const span = source.spans[spanIndex]
        for (const owner of candidate.owners) {
          // A partial/start match cannot establish that this is the same address: another URL
          // may share the capped prefix. Self-exclude only a complete match form inside its own
          // whole-address span.
          const onlyInsideItself = inRecord[owner] && span && span.start <= start && start + RUN_LENGTH <= span.end &&
            forms[owner].some((form) => span.forms.has(form))
          if (!onlyInsideItself) found.add(owner)
        }
        if (found.size >= wanted) return
      }
    }
    const next = start + RUN_LENGTH
    if (next >= text.length) return
    hash = (Math.imul(hash - Math.imul(text.charCodeAt(start), power), HASH_BASE) + text.charCodeAt(next)) | 0
  }
}

/**
 * The part after the host (path, query, fragment) as the browser requests it and with its escapes
 * decoded, so percent escapes do not hide a run the chat holds as plain text.
 */
function restsOf(matchForm: string): string[] {
  const parsed = new URL(matchForm)
  const requested = `${parsed.pathname}${parsed.search}${parsed.hash}`
  // Decode valid UTF-8 escape runs independently, so one malformed byte never hides others.
  const plusDecoded = requested.replace(/\+/g, ' ')
  const decoded = plusDecoded.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try { return decodeURIComponent(run) } catch {
      const bytes = run.match(/%[0-9a-fA-F]{2}/g) ?? []
      let result = ''
      for (let index = 0; index < bytes.length;) {
        const first = parseInt(bytes[index].slice(1), 16)
        const count = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
        let piece: string | null = null
        if (count && index + count <= bytes.length) {
          try { piece = decodeURIComponent(bytes.slice(index, index + count).join('')) } catch { /* preserve malformed bytes */ }
        }
        result += piece ?? bytes[index]
        index += piece === null ? 1 : count
      }
      return result
    }
  })
  return [...new Set([requested, decoded])]

}

/**
 * The evidence and the decision for each outside picture address of a reply (after step 1's
 * classifier said it is not Batshit's own), in one pass over the chat's text. Each `address` is the
 * picture's address as the reply's parser read it (entity-decoded once). The state is decided for
 * the exact address; a changed address is a new address.
 */
export function classifyImageAddressOrigins(
  addresses: readonly string[],
  record: ImageAddressRecord
): ImageAddressOriginDecision[] {
  const forms = addresses.map(toAddressMatchForms)
  const inRecord = forms.map((values) => values.some((form) => record.readAddresses.has(form)))
  const startInRecord = forms.map((values) => values.some((form) => {
    for (const read of record.readAddresses) if (read.length < form.length && form.startsWith(read)) return true
    for (const prefix of record.readAddressPrefixes) if (prefix.length <= form.length && form.startsWith(prefix)) return true
    return false
  }))
  const runs: RunOwners = new Map()
  const withRuns = new Set<number>()
  forms.forEach((form, index) => {
    for (const rest of form.flatMap(restsOf)) {
      for (let start = 0; start + RUN_LENGTH <= rest.length; start++) {
        const window = rest.slice(start, start + RUN_LENGTH)
        const hash = hashOf(window)
        const list = runs.get(hash) ?? []
        if (!runs.has(hash)) runs.set(hash, list)
        const entry = list.find((candidate) => candidate.window === window)
        if (entry) entry.owners.add(index)
        else list.push({ window, owners: new Set([index]) })
        withRuns.add(index)
      }
    }
  })
  const sharing = new Set<number>()
  for (const text of record.runTexts) markRuns(text, runs, sharing, withRuns.size, forms, inRecord, startInRecord)

  return forms.map((form, index) => {
    const evidence: ImageAddressEvidence = {
      inRecord: inRecord[index],
      startInRecord: startInRecord[index],
      sharesChatRun: sharing.has(index),
      complete: record.complete
    }
    return { ...decideImageAddressOrigin(evidence), evidence }
  })
}

/** The evidence and the decision for one address (`classifyImageAddressOrigins` for one). */
export function classifyImageAddressOrigin(address: string, record: ImageAddressRecord): ImageAddressOriginDecision {
  return classifyImageAddressOrigins([address], record)[0]
}
