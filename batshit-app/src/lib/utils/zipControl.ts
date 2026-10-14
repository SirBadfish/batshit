import { normalizeId } from './idNormalizer'
import {
  CONTROL_TAGS,
  GOON_STAGE_DIRECTION_REGEX_SOURCE,
  controlTag,
  findControlBlocks,
  removeControlBlocks,
  stripEmoteTags,
  stripIncompleteEmoteTag,
  type ControlBlock,
  type ControlTagId
} from './controlTags'

export type ZipControlToolSummary = {
  toolCallId?: string
  toolName?: string
  summary: string
}

export type ZipControlPayload = {
  unzip: string[]
  zip: string[]
  /**
   * SA-104 P1 clean break: Tool Notes have their own `<batshit-tool-notes>` tag
   * and no longer ride the zip-control payload. This field stays as the parsed
   * NOTES payload shape (the storage location `metadata.zipControl` is
   * unchanged), but `extractZipControl` no longer fills it — see
   * `extractToolNotes` and `legacyNotesDropped`.
   */
  toolResultsSummary: ZipControlToolSummary[]
  /** Legacy note keys were present in the zip-control payload and were dropped (loudly). */
  legacyNotesDropped?: boolean
  parseError?: string
}

/** One Tool Notes block's holds and releases; inside a block, release runs before hold. */
export type ToolNotesHoldBlock = { hold: string[]; release: string[] }

export type ToolNotesPayload = {
  notes: ZipControlToolSummary[]
  /**
   * SA-129 P2 (DL-02): file paths the agent holds open (`hold`) or lets go (`release`). They ride
   * the Tool Notes block because every agent already writes it; no permission switch, no zip ids.
   */
  hold: string[]
  release: string[]
  /**
   * BL-538: set when the reply carried more than one Tool Notes block: each block's own `hold`
   * and `release`, in the order the blocks came. `hold` and `release` above are the merged asks
   * as written (for the stored record); the hold step applies these in order and compares paths
   * by FILE (`holdPathKeys`), which this pure reader cannot, since `./src/a.ts`, `src/a.ts`, and
   * an absolute path under the project are one file.
   */
  blocks?: ToolNotesHoldBlock[]
  /** Keys the block does not know. They are ignored, never guessed, and reported loudly. */
  unknownKeys?: string[]
  /** `hold` / `release` entries that were not file paths (a number, an object, an empty string). */
  invalidEntries?: Array<{ key: 'hold' | 'release'; value: string }>
  parseError?: string
}

export type ZipControlResolveOptions = {
  currentToolZipIds?: string[]
}

const ZIP_CONTROL_TAG = controlTag('zip-control').tag
const TOOL_NOTES_TAG = controlTag('tool-notes').tag
/**
 * The bulky reply blocks the reply end reads and every compile strips. BL-442: they are found by
 * the registry's one scanner (`findControlBlocks`), never by a lazy regex, whose cost was
 * (unclosed opening tags) x (reply length) (BL-543, BL-640), and which read a tag in code or a
 * tag named in a sentence as a command.
 */
const BULKY_REPLY_TAG_IDS: ReadonlySet<ControlTagId> = new Set(['tool-notes', 'memory', 'zip-control'])

/**
 * BL-543: the most Tool Notes blocks one reply is read for. The prompt asks for ONE block, and a
 * reply with more is already told so (BL-357); real replies have one, rarely two or three. Each
 * block read adds its notes to the stored reply, its errors to `controlErrors` (which the next
 * turn's DCM repeats), and its paths to the hold step's Redis writes, so a reply of thousands of
 * tiny blocks could write thousands of each. Twenty is far above any real reply and keeps that
 * bounded. The blocks after it are still removed from the reply, and the reply is told they were
 * not read (`buildReplyControlMetadata`).
 */
export const TOOL_NOTES_BLOCK_LIMIT = 20
// Zip-action keys only. Legacy note keys are recognized separately so old
// content still hides and the drop is loud, never silent.
const BARE_ZIP_CONTROL_KEYS = new Set(['unzip', 'zip'])
const LEGACY_NOTE_KEYS = new Set([
  'toolResultsSummary',
  'tool_results_summary',
  'toolNotes',
  'tool_notes',
  'notes',
  'toolNotesList'
])
const BARE_CUE_CONTROL_KEYS = new Set([
  'goon_mood',
  'goonMood',
  'mood',
  'goonMoodName',
  'goon_cue',
  'goonCue',
  'goon_cues',
  'goonCues',
  'goon_emote',
  'goonEmote',
  'goon_emotes',
  'goonEmotes',
  'goon_motion',
  'goonMotion',
  'goon_motions',
  'goonMotions',
  'emote',
  'emotes',
  'motion',
  'motions'
])
const BARE_CUE_SPECIFIC_KEYS = new Set(
  Array.from(BARE_CUE_CONTROL_KEYS).filter((key) => key !== 'mood')
)
// Derived from the control-tag registry (SA-104 P1): registering a tag there is
// enough to hide it here — no per-site list to update.
const RENDER_HIDDEN_TAG_IDS: ReadonlySet<ControlTagId> = new Set(
  CONTROL_TAGS.filter((spec) => spec.hideFromRender).map((spec) => spec.id)
)
const STREAMING_GOON_STAGE_DIRECTION_REGEX = new RegExp(GOON_STAGE_DIRECTION_REGEX_SOURCE, 'gi')

function normalizeStringList(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return []
}

const TOOL_RESULT_ALIAS_REGEX = /^tool_result_([1-9]\d*)$/i

function normalizeCurrentToolZipIds(ids: string[] | undefined): string[] {
  const resolved: string[] = []
  const seen = new Set<string>()
  for (const id of ids ?? []) {
    const raw = typeof id === 'string' ? id.trim() : ''
    if (!raw) continue
    const normalized = normalizeId(raw)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    resolved.push(raw)
  }
  return resolved
}

function resolveToolResultAlias(raw: string, currentToolZipIds: string[]): string | null {
  const match = raw.match(TOOL_RESULT_ALIAS_REGEX)
  if (!match) return null
  const index = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isInteger(index) || index < 1) return null
  return currentToolZipIds[index - 1] ?? null
}

export function resolveZipControlZipIds(
  requestedIds: string[],
  availableZipIds: string[],
  options: ZipControlResolveOptions = {}
): string[] {
  const currentToolZipIds = normalizeCurrentToolZipIds(options.currentToolZipIds)
  const lookup = new Map<string, string>()
  for (const id of [...availableZipIds, ...currentToolZipIds]) {
    const raw = typeof id === 'string' ? id.trim() : ''
    if (!raw) continue
    const normalized = normalizeId(raw)
    if (normalized && !lookup.has(normalized)) {
      lookup.set(normalized, raw)
    }
  }

  const resolved: string[] = []
  const seen = new Set<string>()
  for (const id of requestedIds) {
    const raw = typeof id === 'string' ? id.trim() : ''
    if (!raw) continue
    const resolvedAlias = resolveToolResultAlias(raw, currentToolZipIds)
    const normalized = normalizeId(resolvedAlias ?? raw)
    const zipId = lookup.get(normalized)
    if (!zipId) continue
    const normalizedZip = normalizeId(zipId)
    if (seen.has(normalizedZip)) continue
    seen.add(normalizedZip)
    resolved.push(zipId)
  }

  return resolved
}

function normalizeToolResultsSummary(value: unknown): ZipControlToolSummary[] {
  if (!value) return []
  const rawArray = Array.isArray(value) ? value : [value]
  const notes: ZipControlToolSummary[] = []

  for (const entry of rawArray) {
    if (typeof entry === 'string') {
      const summary = entry.trim()
      if (summary) {
        notes.push({ summary })
      }
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, any>
    const summary =
      typeof record.summary === 'string'
        ? record.summary
        : typeof record.note === 'string'
        ? record.note
        : typeof record.text === 'string'
        ? record.text
        : ''
    const trimmed = summary.trim()
    if (!trimmed) continue
    const toolCallId =
      typeof record.toolCallId === 'string'
        ? record.toolCallId
        : typeof record.tool_call_id === 'string'
        ? record.tool_call_id
        : typeof record.id === 'string'
        ? record.id
        : undefined
    const toolName =
      typeof record.toolName === 'string'
        ? record.toolName
        : typeof record.tool_name === 'string'
        ? record.tool_name
        : undefined
    notes.push({
      summary: trimmed,
      toolCallId,
      toolName
    })
  }

  return notes
}

export function normalizeZipControlPayload(raw: unknown): ZipControlPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, any>
  const unzip = normalizeStringList(record.unzip)
  const zip = normalizeStringList(record.zip)
  // SA-104 P1 clean break: zip-control payloads no longer carry Tool Notes.
  // Legacy note keys are detected (so the drop can surface loudly) but never
  // silently absorbed into the payload.
  const hadLegacyNotes = Object.keys(record).some((key) => LEGACY_NOTE_KEYS.has(key))
  return {
    unzip,
    zip,
    toolResultsSummary: [],
    ...(hadLegacyNotes ? { legacyNotesDropped: true as const } : {})
  }
}

/** The Tool Notes block's own keys: the notes (and their older spellings), then hold and release. */
const TOOL_NOTES_BLOCK_KEYS = new Set([...LEGACY_NOTE_KEYS, 'hold', 'release'])

/**
 * A `hold` or `release` list: file paths as the agent wrote them (trimmed, duplicates dropped).
 * A lone string is one path; anything that is not a non-empty string is reported, never guessed.
 */
function normalizeHoldPaths(
  value: unknown,
  key: 'hold' | 'release',
  invalid: Array<{ key: 'hold' | 'release'; value: string }>
): string[] {
  if (value === undefined || value === null) return []
  const entries = Array.isArray(value) ? value : [value]
  const paths: string[] = []
  for (const entry of entries) {
    const path = typeof entry === 'string' ? entry.trim() : ''
    if (!path) {
      invalid.push({ key, value: typeof entry === 'string' ? entry : JSON.stringify(entry) ?? String(entry) })
      continue
    }
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}

export function normalizeToolNotesPayload(raw: unknown): ToolNotesPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, any>
  const notes = normalizeToolResultsSummary(
    record.notes ??
      record.toolResultsSummary ??
      record.tool_results_summary ??
      record.toolNotes ??
      record.tool_notes ??
      record.toolNotesList
  )
  const invalidEntries: Array<{ key: 'hold' | 'release'; value: string }> = []
  const hold = normalizeHoldPaths(record.hold, 'hold', invalidEntries)
  const release = normalizeHoldPaths(record.release, 'release', invalidEntries)
  const unknownKeys = Object.keys(record).filter((key) => !TOOL_NOTES_BLOCK_KEYS.has(key))
  return {
    notes,
    hold,
    release,
    ...(unknownKeys.length > 0 ? { unknownKeys } : {}),
    ...(invalidEntries.length > 0 ? { invalidEntries } : {})
  }
}

function isBareZipControlRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, any>
  const keys = Object.keys(record)
  if (keys.length === 0) return false
  // Legacy note keys still count as zip-control-shaped so old bare payloads
  // keep hiding from render; extraction routes/drops them loudly.
  if (keys.some((key) => !BARE_ZIP_CONTROL_KEYS.has(key) && !LEGACY_NOTE_KEYS.has(key))) {
    return false
  }

  return (
    Object.prototype.hasOwnProperty.call(record, 'unzip') ||
    Array.isArray(record.zip) ||
    keys.some((key) => LEGACY_NOTE_KEYS.has(key))
  )
}

/**
 * A bare (untagged) Tool Notes payload: only `notes`, `hold`, and `release`, each an array, at
 * least one present. Narrow on purpose, so ordinary JSON in a reply is never hidden.
 */
export function isBareToolNotesRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, any>
  const keys = Object.keys(record)
  if (keys.length === 0) return false
  return keys.every((key) => (key === 'notes' || key === 'hold' || key === 'release') && Array.isArray(record[key]))
}

export type BareHiddenControlKind = 'zip' | 'tool-notes' | 'cue' | 'group'

function isBareCueControlRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, any>
  const keys = Object.keys(record)
  if (keys.length === 0) return false
  if (keys.some((key) => !BARE_CUE_CONTROL_KEYS.has(key))) return false

  // Avoid hiding ordinary JSON examples like {"mood":"happy"}.
  return keys.some((key) => BARE_CUE_SPECIFIC_KEYS.has(key))
}

function isBareGroupControlRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, any>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'mode') return false
  return record.mode === 'responding' || record.mode === 'listening'
}

export function parseBareHiddenControlRecord(
  raw: string,
  allowedKind?: BareHiddenControlKind
): { kind: BareHiddenControlKind; payload?: ZipControlPayload } | null {
  try {
    const parsed = JSON.parse(raw)
    // Notes-only records are the tool-notes kind; check before zip because the
    // zip matcher tolerates legacy note keys for hiding purposes.
    if ((!allowedKind || allowedKind === 'tool-notes') && isBareToolNotesRecord(parsed)) {
      return { kind: 'tool-notes' }
    }
    if ((!allowedKind || allowedKind === 'zip') && isBareZipControlRecord(parsed)) {
      const normalized = normalizeZipControlPayload(parsed)
      if (normalized) return { kind: 'zip', payload: normalized }
    }
    if ((!allowedKind || allowedKind === 'cue') && isBareCueControlRecord(parsed)) {
      return { kind: 'cue' }
    }
    if ((!allowedKind || allowedKind === 'group') && isBareGroupControlRecord(parsed)) {
      return { kind: 'group' }
    }
  } catch {
    return null
  }

  return null
}

const QUOTE = 34
const BACKSLASH = 92
const OPEN_BRACE = 123
const CLOSE_BRACE = 125

/** The characters `String.prototype.trim` removes (the same set as a regex `\s`). */
function isTrimSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char)
}

/**
 * BL-639: where the one JSON object that could end `content` starts, or -1.
 *
 * The old readers tried `JSON.parse` on the whole rest of the reply from EVERY `{` (and ran a
 * regex over the whole text before it), so their cost was (braces) x (reply length): 1.4 s for a
 * 260 KB code reply at its reply end, about 6 s for 780 KB, on the one Node process. Only one
 * start can work: `content.slice(start).trim()` must be exactly one JSON object, and no two
 * starts can both be one (a start inside the other object's structure leaves its closing braces
 * after it; a start inside one of its strings sees every later quote the other way round, so one
 * of the two ends inside a string). That start is the `{` that matches the last `}`, read
 * backwards: in valid JSON a quote is a string's edge exactly when an even number of backslashes
 * come before it, and there are no backslashes outside strings. So one backward pass finds it,
 * and the reader's behavior is the old one exactly (compared over generated replies in the tests).
 */
function trailingBareObjectStart(content: string): number {
  let end = content.length - 1
  while (end >= 0 && isTrimSpace(content[end])) end -= 1
  if (end < 0 || content.charCodeAt(end) !== CLOSE_BRACE) return -1
  let depth = 0
  let inString = false
  for (let index = end; index >= 0; index -= 1) {
    const code = content.charCodeAt(index)
    if (inString) {
      if (code !== QUOTE) continue
      let slashes = 0
      for (let before = index - 1; before >= 0 && content.charCodeAt(before) === BACKSLASH; before -= 1) slashes += 1
      if (slashes % 2 === 0) inString = false
      continue
    }
    if (code === QUOTE) inString = true
    else if (code === CLOSE_BRACE) depth += 1
    else if (code === OPEN_BRACE) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * BL-639: where the one JSON object that could START `content` ends (its `}`), or -1: the object
 * that opens at the first non-space character, read forwards. A JSON object ends at its matching
 * brace, so no other end can close it.
 */
function leadingBareObjectEnd(content: string): number {
  let start = 0
  while (start < content.length && isTrimSpace(content[start])) start += 1
  if (content.charCodeAt(start) !== OPEN_BRACE) return -1
  let depth = 0
  let inString = false
  for (let index = start; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (inString) {
      if (code === BACKSLASH) index += 1
      else if (code === QUOTE) inString = false
      continue
    }
    if (code === QUOTE) inString = true
    else if (code === OPEN_BRACE) depth += 1
    else if (code === CLOSE_BRACE) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * The old rule for where a trailing bare payload may start: at the text's start, or after a line
 * break with only spaces between (`prefix.trim() === '' || /\n\s*$/.test(prefix)`), read back
 * from `start` instead of over the whole prefix.
 */
function bareStartsOnItsOwnLine(content: string, start: number): boolean {
  let sawLineBreak = false
  for (let index = start - 1; index >= 0; index -= 1) {
    const char = content[index]
    if (!isTrimSpace(char)) return sawLineBreak
    if (char === '\n') sawLineBreak = true
  }
  return true
}

/** The same rule for where a leading bare payload may end (`suffix.trim() === '' || /^\s*\n/.test(suffix)`). */
function bareEndsOnItsOwnLine(content: string, end: number): boolean {
  let sawLineBreak = false
  for (let index = end + 1; index < content.length; index += 1) {
    const char = content[index]
    if (!isTrimSpace(char)) return sawLineBreak
    if (char === '\n') sawLineBreak = true
  }
  return true
}

/**
 * The malformed-output fallback (`zip-architecture.md`): a hidden-control JSON object written
 * without its tag, alone at the END of the reply. Behavior unchanged; one pass (BL-639).
 * Exported for the old-against-new comparison test.
 */
export function extractTrailingBareHiddenControl(
  content: string,
  allowedKind?: BareHiddenControlKind
): {
  cleaned: string
  payload?: ZipControlPayload
} | null {
  const start = trailingBareObjectStart(content)
  if (start < 0 || !bareStartsOnItsOwnLine(content, start)) return null
  const parsed = parseBareHiddenControlRecord(content.slice(start).trim(), allowedKind)
  if (!parsed) return null
  return {
    cleaned: content.slice(0, start).replace(/\n{3,}/g, '\n\n').trim(),
    payload: parsed.payload
  }
}

/** The same fallback at the START of the reply. Behavior unchanged; one pass (BL-639). */
export function extractLeadingBareHiddenControl(
  content: string,
  allowedKind?: BareHiddenControlKind
): {
  cleaned: string
  payload?: ZipControlPayload
} | null {
  const end = leadingBareObjectEnd(content)
  if (end < 0 || !bareEndsOnItsOwnLine(content, end)) return null
  const parsed = parseBareHiddenControlRecord(content.slice(0, end + 1).trim(), allowedKind)
  if (!parsed) return null
  return {
    cleaned: content.slice(end + 1).replace(/\n{3,}/g, '\n\n').trim(),
    payload: parsed.payload
  }
}

function extractTrailingBareZipControl(content: string): {
  cleaned: string
  payload?: ZipControlPayload
} | null {
  return extractTrailingBareHiddenControl(content, 'zip')
}

/** A bare Tool Notes payload alone at the end of the reply. Behavior unchanged; one pass (BL-639). */
export function extractTrailingBareToolNotes(content: string): {
  cleaned: string
  payload?: ToolNotesPayload
} | null {
  const start = trailingBareObjectStart(content)
  if (start < 0 || !bareStartsOnItsOwnLine(content, start)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content.slice(start).trim())
  } catch {
    return null
  }
  if (!isBareToolNotesRecord(parsed)) return null
  const normalized = normalizeToolNotesPayload(parsed)
  if (!normalized) return null
  return { cleaned: content.slice(0, start).replace(/\n{3,}/g, '\n\n').trim(), payload: normalized }
}

export function stripBareHiddenControlPayloads(content: string): string {
  let output = content
  let guard = 0

  while (guard < 10) {
    guard += 1
    const leading = extractLeadingBareHiddenControl(output)
    if (leading) {
      output = leading.cleaned
      continue
    }
    const trailing = extractTrailingBareHiddenControl(output)
    if (trailing) {
      output = trailing.cleaned
      continue
    }
    break
  }

  return output.replace(/\n{3,}/g, '\n\n').trim()
}

/** The last `stripZipControlBlocks` input and output: the page and the compile ask for the same text twice (BL-479). */
let lastStripped: { input: string; output: string } | null = null

/**
 * The compile's last strip (and the chat view's): every complete Tool Notes, memory, and
 * zip-control block removed, then a bare hidden-control payload at either edge (the
 * malformed-output fallback). Every compile runs it at least twice per history message.
 *
 * BL-442: a block counts only as the registry's scanner says (outside code, followed by its
 * payload, closed), so an example in a code block and a tag named in a sentence stay in the text
 * the agent and the user see, and a mention can no longer pair with a later block's closing tag
 * (trap 1). An unclosed block is not removed here: the reply end already hid it before the reply
 * was stored (R3), and this strip also runs over the user's own messages. One linear pass
 * (BL-543, BL-640), and the bare payloads are found in one pass each (BL-639).
 */
export function stripZipControlBlocks(content: string): string {
  if (!content) return content
  if (lastStripped?.input === content) return lastStripped.output
  const blocks = findControlBlocks(content, { final: true }).filter(
    (block) => block.kind === 'paired' && BULKY_REPLY_TAG_IDS.has(block.id)
  )
  const stripped = removeControlBlocks(content, blocks).replace(/\n{3,}/g, '\n\n').trim()
  const output = stripBareHiddenControlPayloads(stripped)
  lastStripped = { input: content, output }
  return output
}

function normalizeHiddenControlWhitespace(content: string): string {
  return content
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The live view of a streaming reply: every render-hidden control block hidden as the registry's
 * scanner reads it while the reply streams (BL-442, `final: false`), so the view shows what the
 * server will save. A complete block and a block still open are hidden; a last `<` that can still
 * become a tag is held back until the next chunk decides (R4), so a tag split across chunks never
 * flashes. An example in a code block, a tag named in a sentence, and a lone `<` are shown. Then
 * emote tags, Goon stage directions, and a bare hidden payload at either edge.
 *
 * One linear pass per call (BL-479: the bare-payload search used to grow with the square of the
 * reply's length, and the page calls this on every chunk).
 */
export function hideStreamingHiddenControlBlocks(content: string): string {
  if (!content) return content

  const blocks = findControlBlocks(content, { final: false }).filter((block) => RENDER_HIDDEN_TAG_IDS.has(block.id))
  const output = removeControlBlocks(content, blocks)

  const cleaned = normalizeHiddenControlWhitespace(
    stripIncompleteEmoteTag(stripEmoteTags(output)).replace(STREAMING_GOON_STAGE_DIRECTION_REGEX, '')
  )
  return stripBareHiddenControlPayloads(cleaned)
}

/**
 * Extract the last `<batshit-tool-notes>` block (or a trailing bare
 * `{"notes":[...]}` payload) from a message. `cleaned` removes only tool-notes
 * blocks so callers can chain zip-control extraction afterwards.
 */
/** One Tool Notes block's payload, or why it could not be read. */
function parseToolNotesBlock(raw: string): { payload?: ToolNotesPayload; parseError?: string } {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    const normalized = normalizeToolNotesPayload(parsed)
    const saysSomething =
      normalized !== null &&
      (Array.isArray((parsed as any)?.notes) ||
        normalized.notes.length > 0 ||
        normalized.hold.length > 0 ||
        normalized.release.length > 0 ||
        (normalized.invalidEntries?.length ?? 0) > 0)
    if (!normalized || !saysSomething) {
      return {
        parseError: 'Tool Notes block must be a JSON object like {"notes":[{"toolName":"...","summary":"..."}]}.'
      }
    }
    return { payload: normalized }
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : 'Failed to parse Tool Notes block.' }
  }
}

/**
 * SA-129 P2b (BL-357): a reply with more than one Tool Notes block keeps them ALL, in order. The
 * notes are joined; a file named in more than one block ends as the LAST block says (inside one
 * block, release then hold, as for a single block); unknown keys and non-path entries from every
 * block stay loud. Before, only the last block was read and the others were dropped without a
 * word, which could lose a hold or a release. `blockCount` lets the caller say so loudly too.
 *
 * BL-538: "the same file" is decided by the hold step, not here. The merged `hold` / `release`
 * lists compare the text as written and are only the record of what was asked; `blocks` carries
 * each block's own asks in order, and the hold step applies them in that order by file key, so
 * `hold src/a.ts` then `release ./src/a.ts` ends released.
 */
function mergeToolNotesPayloads(payloads: ToolNotesPayload[]): ToolNotesPayload {
  const notes: ZipControlToolSummary[] = []
  const unknownKeys: string[] = []
  const invalidEntries: Array<{ key: 'hold' | 'release'; value: string }> = []
  const lastAction = new Map<string, 'hold' | 'release'>()
  for (const payload of payloads) {
    notes.push(...payload.notes)
    for (const key of payload.unknownKeys ?? []) if (!unknownKeys.includes(key)) unknownKeys.push(key)
    invalidEntries.push(...(payload.invalidEntries ?? []))
    for (const path of payload.release) {
      lastAction.delete(path)
      lastAction.set(path, 'release')
    }
    for (const path of payload.hold) {
      lastAction.delete(path)
      lastAction.set(path, 'hold')
    }
  }
  const hold: string[] = []
  const release: string[] = []
  for (const [path, action] of lastAction) (action === 'hold' ? hold : release).push(path)
  return {
    notes,
    hold,
    release,
    blocks: payloads.map((payload) => ({ hold: [...payload.hold], release: [...payload.release] })),
    ...(unknownKeys.length > 0 ? { unknownKeys } : {}),
    ...(invalidEntries.length > 0 ? { invalidEntries } : {})
  }
}

/** What a reply's Tool Notes blocks say, read from the scanner's blocks. */
export interface ToolNotesRead {
  payload?: ToolNotesPayload
  parseError?: string
  /** A Tool Notes block (paired or unclosed) was present. */
  hadBlock: boolean
  /** How many complete Tool Notes blocks the reply carried. */
  blockCount: number
}

function unclosedBlockError(tag: string): string {
  return `Unclosed <${tag}> block (missing </${tag}>).`
}

/**
 * The Tool Notes among a reply's control blocks (`findControlBlocks`, final): the first
 * `TOOL_NOTES_BLOCK_LIMIT` complete blocks read in order (BL-357, BL-543), and an unclosed one
 * reported loudly (R3; BL-480: a reply cut inside its notes used to show the half-written JSON).
 */
export function readToolNotesBlocks(content: string, blocks: readonly ControlBlock[]): ToolNotesRead {
  // A held start is the start of a cut block (R4): hidden by the caller, never a block to read.
  const own = blocks.filter((block) => block.id === 'tool-notes' && block.kind !== 'held-start')
  const paired = own.filter((block) => block.kind === 'paired')
  const unclosed = own.find((block) => block.kind === 'unclosed')
  const blockCount = paired.length
  const read = paired
    .slice(0, TOOL_NOTES_BLOCK_LIMIT)
    .map((block) => parseToolNotesBlock(content.slice(block.bodyStart, block.bodyEnd).trim()))
  const parseErrors =
    blockCount === 1
      ? read.flatMap((block) => (block.parseError ? [block.parseError] : []))
      : read.flatMap((block, index) =>
          block.parseError ? [`Tool Notes block ${index + 1} of ${blockCount}: ${block.parseError}`] : []
        )
  if (unclosed) parseErrors.push(unclosedBlockError(TOOL_NOTES_TAG))
  const payloads = read.flatMap((block) => (block.payload ? [block.payload] : []))
  const payload = blockCount === 1 ? payloads[0] : payloads.length > 0 ? mergeToolNotesPayloads(payloads) : undefined
  return {
    hadBlock: own.length > 0,
    blockCount,
    ...(payload ? { payload } : {}),
    ...(parseErrors.length > 0 ? { parseError: parseErrors.join(' ') } : {})
  }
}

export function extractToolNotes(content: string): {
  cleaned: string
  payload?: ToolNotesPayload
  parseError?: string
  hadBlock: boolean
  /**
   * How many tagged Tool Notes blocks the reply carried (a trailing bare payload counts as one).
   * Only the first `TOOL_NOTES_BLOCK_LIMIT` are read; every one is removed from `cleaned`.
   */
  blockCount: number
} {
  if (!content) {
    return { cleaned: content, hadBlock: false, blockCount: 0 }
  }

  const own = findControlBlocks(content, { final: true }).filter(
    (block) => block.id === 'tool-notes' && block.kind !== 'held-start'
  )
  if (own.length === 0) {
    const bare = extractTrailingBareToolNotes(content)
    if (bare) {
      return { cleaned: bare.cleaned, payload: bare.payload, hadBlock: true, blockCount: 1 }
    }
    return { cleaned: content, hadBlock: false, blockCount: 0 }
  }

  const read = readToolNotesBlocks(content, own)
  return {
    cleaned: removeControlBlocks(content, own).replace(/\n{3,}/g, '\n\n').trim(),
    ...read
  }
}

/** What a reply's zip-control blocks say: the LAST complete block wins; an unclosed one is loud (R3). */
export function readZipControlBlocks(
  content: string,
  blocks: readonly ControlBlock[]
): { payload?: ZipControlPayload; parseError?: string; hadBlock: boolean } {
  const own = blocks.filter((block) => block.id === 'zip-control' && block.kind !== 'held-start')
  if (own.length === 0) return { hadBlock: false }
  const last = own.filter((block) => block.kind === 'paired').at(-1)
  const unclosed = own.some((block) => block.kind === 'unclosed')
  const errors: string[] = []
  let payload: ZipControlPayload | undefined
  const raw = last ? content.slice(last.bodyStart, last.bodyEnd).trim() : ''
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      const normalized = normalizeZipControlPayload(parsed)
      if (normalized) payload = normalized
      else errors.push('Zip control block is not a JSON object.')
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Failed to parse zip control block.')
    }
  }
  if (unclosed) errors.push(unclosedBlockError(ZIP_CONTROL_TAG))
  return {
    hadBlock: true,
    ...(payload ? { payload } : {}),
    ...(errors.length > 0 ? { parseError: errors.join(' ') } : {})
  }
}

export function extractZipControl(content: string): {
  cleaned: string
  payload?: ZipControlPayload
  parseError?: string
  hadBlock: boolean
} {
  if (!content) {
    return { cleaned: content, hadBlock: false }
  }

  const blocks = findControlBlocks(content, { final: true })
  const read = readZipControlBlocks(content, blocks)
  if (!read.hadBlock) {
    const bare = extractTrailingBareZipControl(content)
    if (bare) {
      return { cleaned: bare.cleaned, payload: bare.payload, hadBlock: true }
    }
    return { cleaned: content, hadBlock: false }
  }

  // The zip-control cleaner strips every bulky block (and an unclosed zip-control tail, R3).
  const unclosed = blocks.filter((block) => block.id === 'zip-control' && block.kind === 'unclosed')
  return { cleaned: stripZipControlBlocks(removeControlBlocks(content, unclosed)), ...read }
}
