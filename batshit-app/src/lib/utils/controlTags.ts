/**
 * SA-104 P1 — the single control-tag registry (DL-104-06).
 *
 * Every inline `<batshit-*>` control tag is registered exactly once here. The
 * render strip (zipControl.hideStreamingHiddenControlBlocks), the TTS final
 * strip (speakableText), the realtime TTS mid-stream hold-back
 * (realtimeSpeechCoordinator), and group-chat presentation stripping all derive
 * their tag lists from this module instead of keeping their own copies.
 *
 * Adding a tag here is the whole registration: it is hidden from render,
 * stripped from speech (closed AND unclosed trailing forms), held back
 * mid-stream by the realtime speech pipeline, and covered by the shared
 * chunk-split partial-prefix hold. Site-specific behavior (payload parsing,
 * side-channel dispatch such as Goon cue firing, group-protocol lead parsing)
 * stays with its owning module — this registry owns identity and strip policy,
 * not semantics.
 */

export type ControlTagId = 'zip-control' | 'tool-notes' | 'memory' | 'cue' | 'group'

export interface ControlTagSpec {
  id: ControlTagId
  /** Element name as emitted by agents, e.g. `batshit-cue`. */
  tag: string
  /** Payload style inside the block. `json-tolerant` allows the cue-style lenient parse. */
  parse: 'json' | 'json-tolerant'
  /**
   * `any`: valid anywhere in a message (the strip layer makes every position safe).
   * `lead-required`: the group-chat protocol tag — it must be the first output and
   * keeps its own buffering logic in groupChatUtils.
   */
  position: 'any' | 'lead-required'
  /** Documented default convention for prompts: append bulky blocks at message end. */
  bulkyEndOfMessageConvention: boolean
  /** Hidden from chat rendering while streaming and in final render. */
  hideFromRender: boolean
  /** Stripped from TTS text (final pass) and held back mid-stream by realtime TTS. */
  hideFromTts: boolean
  /** Additionally stripped from group-chat presentation output. */
  strippedInGroupPresentation: boolean
  /**
   * Malformed payloads surface loudly: a `controlErrors` entry on the message
   * metadata plus a next-turn context line (DL-104-05). Never a silent drop.
   */
  loudFailure: boolean
}

export const CONTROL_TAGS: readonly ControlTagSpec[] = [
  {
    id: 'zip-control',
    tag: 'batshit-zip-control',
    parse: 'json',
    position: 'any',
    bulkyEndOfMessageConvention: true,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: false,
    loudFailure: true
  },
  {
    id: 'tool-notes',
    tag: 'batshit-tool-notes',
    parse: 'json',
    position: 'any',
    bulkyEndOfMessageConvention: true,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: false,
    loudFailure: true
  },
  {
    // SA-104 P3: the inline memory save (DL-104-05 hot path). Multiple blocks per
    // message are supported — each block is one save; parsing/writes live in
    // $lib/utils/memoryControl.ts + the inline-saves route.
    id: 'memory',
    tag: 'batshit-memory',
    parse: 'json',
    position: 'any',
    bulkyEndOfMessageConvention: true,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: false,
    loudFailure: true
  },
  {
    id: 'cue',
    tag: 'batshit-cue',
    parse: 'json-tolerant',
    position: 'any',
    bulkyEndOfMessageConvention: false,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: true,
    loudFailure: false
  },
  {
    id: 'group',
    tag: 'batshit-group',
    parse: 'json',
    position: 'lead-required',
    bulkyEndOfMessageConvention: false,
    hideFromRender: true,
    hideFromTts: true,
    strippedInGroupPresentation: false,
    loudFailure: false
  }
] as const

const TAG_BY_NAME = new Map(CONTROL_TAGS.map((spec) => [spec.tag.toLowerCase(), spec]))
const TAG_BY_ID = new Map(CONTROL_TAGS.map((spec) => [spec.id, spec]))

export function controlTag(id: ControlTagId): ControlTagSpec {
  const spec = TAG_BY_ID.get(id)
  if (!spec) throw new Error(`Unknown control tag id: ${id}`)
  return spec
}

export function controlTagByName(name: string): ControlTagSpec | null {
  return TAG_BY_NAME.get(name.toLowerCase()) ?? null
}

/**
 * Non-tag speech/presentation strip families that ride along with the control
 * grammar. They are not `<batshit-*>` tags but share the "never spoken, never
 * group-presented" policy, so their single source of truth lives here too.
 */
export const EMOTE_TAG_REGEX_SOURCE =
  String.raw`<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*\/>[ \t]*|<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*>[\s\S]*?<\/(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?>[ \t]*`
export const INCOMPLETE_EMOTE_TAG_REGEX_SOURCE = String.raw`<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*$`
export const GOON_STAGE_DIRECTION_REGEX_SOURCE = String.raw`\*goon:\s*[a-zA-Z0-9 _-]+\s*\*[ \t]*`

/**
 * Plain-text control sections (no XML tag) recognized by the speech pipeline —
 * today only the Tool Results Summary heading family, in tag-ish and
 * heading-ish spellings.
 */
export const PLAIN_CONTROL_SECTION_TAGS: readonly string[] = [
  'tool-results',
  'tool-results-summary',
  'tool_results',
  'tool_results_summary'
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Tag names hidden from chat rendering. */
export function renderHiddenTagNames(): string[] {
  return CONTROL_TAGS.filter((spec) => spec.hideFromRender).map((spec) => spec.tag)
}

/** Tag names hidden from TTS (final strip + realtime hold-back). */
export function ttsHiddenTagNames(): string[] {
  return CONTROL_TAGS.filter((spec) => spec.hideFromTts).map((spec) => spec.tag)
}

/** Realtime hold-back also withholds the plain tool-results tag spellings. */
export function realtimeHiddenTagNames(): string[] {
  return [...ttsHiddenTagNames(), ...PLAIN_CONTROL_SECTION_TAGS]
}

export function realtimeHiddenTagOpenPrefixes(): string[] {
  return realtimeHiddenTagNames().map((tag) => `<${tag}`)
}

/** Matches the first opening tag of any render-hidden control block. */
export function renderHiddenOpenRegex(): RegExp {
  const names = renderHiddenTagNames().map(escapeRegExp).join('|')
  return new RegExp(`<(${names})\\b[^>]*>`, 'i')
}

export function closeTagRegex(tag: string): RegExp {
  return new RegExp(`<\\/\\s*${escapeRegExp(tag)}\\s*>`, 'i')
}

/** `<tag ...>...</tag>` paired block, global + case-insensitive. */
export function pairedBlockRegexGlobal(tag: string): RegExp {
  const safe = escapeRegExp(tag)
  return new RegExp(`<${safe}\\b[\\s\\S]*?<\\/${safe}>`, 'gi')
}

/** Unclosed `<tag ...` reaching message end (the trailing-tail case TTS must eat). */
export function unclosedTailRegexGlobal(tag: string): RegExp {
  return new RegExp(`<${escapeRegExp(tag)}\\b[\\s\\S]*$`, 'gi')
}

/**
 * Chunk-split safety (shared): if the text ends inside a partial opening tag of
 * a registered hidden control (e.g. `...text <batshit-cu`), hold the partial
 * prefix back so it never flashes as literal text in render or reaches speech.
 * Returns the visible text and the held prefix (re-prepend it when more chunks
 * arrive).
 */
export function splitTrailingPartialControlPrefix(text: string): {
  visible: string
  heldPrefix: string
} {
  if (!text) return { visible: text, heldPrefix: '' }
  const lastOpen = text.lastIndexOf('<')
  if (lastOpen === -1) return { visible: text, heldPrefix: '' }
  const candidate = text.slice(lastOpen)
  // A completed tag (has `>`) is not a partial prefix.
  if (candidate.includes('>')) return { visible: text, heldPrefix: '' }
  const normalized = candidate.toLowerCase().replace(/^<\s+/, '<')
  const isPartial = realtimeHiddenTagOpenPrefixes().some(
    (prefix) =>
      prefix.startsWith(normalized) ||
      (normalized.startsWith(prefix) && /[\s/]/.test(normalized[prefix.length] ?? ''))
  )
  if (!isPartial) return { visible: text, heldPrefix: '' }
  return { visible: text.slice(0, lastOpen), heldPrefix: candidate }
}

/**
 * One entry in a message's `metadata.controlErrors` — the machine-readable half
 * of the DL-104-05 loud-failure surface. The next turn's compile reads these and
 * inserts a correction line so the agent can retry.
 */
export interface ControlErrorRecord {
  tag: string
  error: string
  hint?: string
  at: string
}

export function buildControlErrorRecord(
  tag: string,
  error: string,
  hint?: string
): ControlErrorRecord {
  return {
    tag,
    error,
    ...(hint ? { hint } : {}),
    at: new Date().toISOString()
  }
}

/**
 * Next-turn surfacing (DL-104-05): correction lines for the DCM, read from the
 * MOST RECENT assistant message only — control errors are one-turn correction
 * hints, not persistent state. The compilation path calls this with its message list.
 */
export function buildControlErrorDcmLines(
  messages: Array<{ role?: string; metadata?: Record<string, any> | null }>
): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    const errors = Array.isArray(message?.metadata?.controlErrors)
      ? (message.metadata!.controlErrors as ControlErrorRecord[])
      : []
    if (errors.length === 0) return []
    const lines = ['control_errors (your previous response had malformed control blocks):']
    for (const entry of errors.slice(0, 4)) {
      const tag = typeof entry?.tag === 'string' ? entry.tag : 'unknown'
      const error = typeof entry?.error === 'string' ? entry.error : 'malformed control block'
      const hint = typeof entry?.hint === 'string' && entry.hint ? ` | fix: ${entry.hint}` : ''
      lines.push(`- <${tag}>: ${error}${hint}`)
    }
    return lines
  }
  return []
}
