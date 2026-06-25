import { normalizeId } from './idNormalizer'

export type ZipControlToolSummary = {
  toolCallId?: string
  toolName?: string
  summary: string
}

export type ZipControlPayload = {
  unzip: string[]
  zip: string[]
  toolResultsSummary: ZipControlToolSummary[]
  parseError?: string
}

export type ZipControlResolveOptions = {
  currentToolZipIds?: string[]
}

const ZIP_CONTROL_TAG = 'batshit-zip-control'
const ZIP_CONTROL_REGEX = new RegExp(`<${ZIP_CONTROL_TAG}>([\\s\\S]*?)<\\/${ZIP_CONTROL_TAG}>`, 'gi')
const BARE_ZIP_CONTROL_KEYS = new Set([
  'unzip',
  'zip',
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
const STREAMING_HIDDEN_BLOCK_OPEN_REGEX =
  /<(batshit-zip-control|batshit-cue|batshit-group)\b[^>]*>/i
const STREAMING_EMOTE_TAG_REGEX =
  /<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*\/>[ \t]*|<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*>[\s\S]*?<\/(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?>[ \t]*/gi
const STREAMING_INCOMPLETE_EMOTE_REGEX =
  /<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*$/i
const STREAMING_GOON_STAGE_DIRECTION_REGEX = /\*goon:\s*[a-zA-Z0-9 _-]+\s*\*[ \t]*/gi

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
  const toolResultsSummary = normalizeToolResultsSummary(
    record.toolResultsSummary ??
      record.tool_results_summary ??
      record.toolNotes ??
      record.tool_notes ??
      record.notes ??
      record.toolNotesList
  )
  return { unzip, zip, toolResultsSummary }
}

function isBareZipControlRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, any>
  const keys = Object.keys(record)
  if (keys.length === 0) return false
  if (keys.some((key) => !BARE_ZIP_CONTROL_KEYS.has(key))) return false

  return (
    Object.prototype.hasOwnProperty.call(record, 'unzip') ||
    Object.prototype.hasOwnProperty.call(record, 'toolResultsSummary') ||
    Object.prototype.hasOwnProperty.call(record, 'tool_results_summary') ||
    Object.prototype.hasOwnProperty.call(record, 'toolNotes') ||
    Object.prototype.hasOwnProperty.call(record, 'tool_notes') ||
    Object.prototype.hasOwnProperty.call(record, 'notes') ||
    Object.prototype.hasOwnProperty.call(record, 'toolNotesList') ||
    Array.isArray(record.zip)
  )
}

type BareHiddenControlKind = 'zip' | 'cue' | 'group'

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

function parseBareHiddenControlRecord(
  raw: string,
  allowedKind?: BareHiddenControlKind
): { kind: BareHiddenControlKind; payload?: ZipControlPayload } | null {
  try {
    const parsed = JSON.parse(raw)
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

function extractTrailingBareHiddenControl(
  content: string,
  allowedKind?: BareHiddenControlKind
): {
  cleaned: string
  payload?: ZipControlPayload
} | null {
  const starts: number[] = []
  for (let index = content.indexOf('{'); index >= 0; index = content.indexOf('{', index + 1)) {
    starts.push(index)
  }

  for (const start of starts) {
    const prefix = content.slice(0, start)
    if (prefix.trim().length > 0 && !/\n\s*$/.test(prefix)) continue

    const raw = content.slice(start).trim()
    if (!raw.endsWith('}')) continue

    const parsed = parseBareHiddenControlRecord(raw, allowedKind)
    if (parsed) {
      return {
        cleaned: prefix.replace(/\n{3,}/g, '\n\n').trim(),
        payload: parsed.payload
      }
    }
  }

  return null
}

function extractLeadingBareHiddenControl(
  content: string,
  allowedKind?: BareHiddenControlKind
): {
  cleaned: string
  payload?: ZipControlPayload
} | null {
  const ends: number[] = []
  for (let index = content.indexOf('}'); index >= 0; index = content.indexOf('}', index + 1)) {
    ends.push(index)
  }

  for (const end of ends) {
    const raw = content.slice(0, end + 1).trim()
    const suffix = content.slice(end + 1)
    if (suffix.trim().length > 0 && !/^\s*\n/.test(suffix)) continue

    const parsed = parseBareHiddenControlRecord(raw, allowedKind)
    if (parsed) {
      return {
        cleaned: suffix.replace(/\n{3,}/g, '\n\n').trim(),
        payload: parsed.payload
      }
    }
  }

  return null
}

function extractTrailingBareZipControl(content: string): {
  cleaned: string
  payload?: ZipControlPayload
} | null {
  return extractTrailingBareHiddenControl(content, 'zip')
}

function stripBareHiddenControlPayloads(content: string): string {
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

export function stripZipControlBlocks(content: string): string {
  if (!content) return content
  const stripped = content.replace(ZIP_CONTROL_REGEX, '').replace(/\n{3,}/g, '\n\n').trim()
  return stripBareHiddenControlPayloads(stripped)
}

function closeRegexForStreamingHiddenTag(tag: string): RegExp {
  if (tag === ZIP_CONTROL_TAG) return /<\/batshit-zip-control>/i
  if (tag === 'batshit-group') return /<\/batshit-group>/i
  return /<\/batshit-cue>/i
}

function normalizeHiddenControlWhitespace(content: string): string {
  return content
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function hideStreamingHiddenControlBlocks(content: string): string {
  if (!content) return content

  let output = content
  let guard = 0

  while (guard < 50) {
    guard += 1
    const openMatch = STREAMING_HIDDEN_BLOCK_OPEN_REGEX.exec(output)
    if (!openMatch || openMatch.index === undefined) break

    const tag = openMatch[1].toLowerCase()
    const closeRegex = closeRegexForStreamingHiddenTag(tag)
    const afterOpenIndex = openMatch.index + openMatch[0].length
    const closeMatch = closeRegex.exec(output.slice(afterOpenIndex))

    if (!closeMatch || closeMatch.index === undefined) {
      output = output.slice(0, openMatch.index)
      break
    }

    const blockEndIndex = afterOpenIndex + closeMatch.index + closeMatch[0].length
    output = `${output.slice(0, openMatch.index)}${output.slice(blockEndIndex)}`
  }

  const cleaned = normalizeHiddenControlWhitespace(
    output
      .replace(STREAMING_EMOTE_TAG_REGEX, '')
      .replace(STREAMING_INCOMPLETE_EMOTE_REGEX, '')
      .replace(STREAMING_GOON_STAGE_DIRECTION_REGEX, '')
  )
  return stripBareHiddenControlPayloads(cleaned)
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

  const matches = Array.from(content.matchAll(ZIP_CONTROL_REGEX))
  if (matches.length === 0) {
    const bare = extractTrailingBareZipControl(content)
    if (bare) {
      return { cleaned: bare.cleaned, payload: bare.payload, hadBlock: true }
    }
    return { cleaned: content, hadBlock: false }
  }

  const raw = matches[matches.length - 1]?.[1]?.trim() || ''
  const cleaned = stripZipControlBlocks(content)

  if (!raw) {
    return { cleaned, hadBlock: true }
  }

  try {
    const parsed = JSON.parse(raw)
    const normalized = normalizeZipControlPayload(parsed)
    if (!normalized) {
      return { cleaned, hadBlock: true, parseError: 'Zip control block is not a JSON object.' }
    }
    return { cleaned, payload: normalized, hadBlock: true }
  } catch (error) {
    return {
      cleaned,
      hadBlock: true,
      parseError: error instanceof Error ? error.message : 'Failed to parse zip control block.'
    }
  }
}
