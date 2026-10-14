import {
  GOON_STAGE_DIRECTION_REGEX_SOURCE,
  findControlBlocks,
  stripEmoteTags,
  type ControlBlock
} from './controlTags'

export type VisibleBatshitCueNote = {
  kind: 'mood'
  label: string
  value: string
}

export type BatshitCuePayload = {
  mood: string | null
  cues: string[]
}

const GOON_STAGE_DIRECTION_REGEX = new RegExp(GOON_STAGE_DIRECTION_REGEX_SOURCE, 'gi')

/**
 * The complete Goon cue blocks of a text, as the registry's scanner reads them (BL-442): outside
 * code, followed by a payload the cue parser reads, and closed. A cue shown as an example in code,
 * or named in a sentence, sets no mood and stays in the text. One linear pass.
 */
export function findCueBlocks(content: string): ControlBlock[] {
  return findControlBlocks(content, { final: true }).filter((block) => block.id === 'cue' && block.kind === 'paired')
}

function normalizeControlString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeCueControlString(value: unknown): string | null {
  const normalized = normalizeControlString(value)
  if (!normalized) return null
  return /^[a-zA-Z0-9 _-]+$/.test(normalized) ? normalized.replace(/\s+/g, ' ') : null
}

function pushControlCue(target: string[], value: unknown) {
  if (Array.isArray(value)) {
    value.forEach((entry) => pushControlCue(target, entry))
    return
  }
  const cue = normalizeCueControlString(value)
  if (cue) target.push(cue)
}

function tryParseControlObject(value: string): Record<string, unknown> | null {
  let current: unknown = value

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (typeof current !== 'string') break
    const trimmed = current.trim()
    if (!trimmed) break

    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      if (typeof parsed === 'string' && parsed.trim() && parsed.trim() !== trimmed) {
        current = parsed
        continue
      }
      break
    } catch {
      break
    }
  }

  return null
}

function parseControlObject(raw: string): Record<string, unknown> | null {
  const payload = raw.trim()
  if (!payload) return null

  const decodeSelectedEscapes = (value: string, allowed: Set<string>): string => {
    let output = ''
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]
      if (char !== '\\') {
        output += char
        continue
      }

      const next = value[index + 1]
      if (next && allowed.has(next)) {
        output += next
        index += 1
        continue
      }

      output += char
    }
    return output
  }

  const candidates = [
    payload,
    decodeSelectedEscapes(payload, new Set(['"'])),
    decodeSelectedEscapes(payload, new Set(['\\', '"']))
  ]

  for (const candidate of candidates) {
    const parsed = tryParseControlObject(candidate)
    if (parsed) return parsed
  }

  return null
}

export function extractGoonMoodFromCuePayload(raw: string): string | null {
  return extractBatshitCuePayload(raw).mood
}

export function extractBatshitCuePayload(raw: string): BatshitCuePayload {
  const result: BatshitCuePayload = { mood: null, cues: [] }
  const payload = raw.trim()
  if (!payload) return result

  const parsed = parseControlObject(payload)
  if (parsed) {
    result.mood =
      normalizeControlString(parsed.goon_mood) ??
      normalizeControlString(parsed.goonMood) ??
      normalizeControlString(parsed.mood) ??
      normalizeControlString(parsed.goonMoodName)

    pushControlCue(result.cues, parsed.goon_cue)
    pushControlCue(result.cues, parsed.goonCue)
    pushControlCue(result.cues, parsed.goon_cues)
    pushControlCue(result.cues, parsed.goonCues)
    pushControlCue(result.cues, parsed.goon_emote)
    pushControlCue(result.cues, parsed.goonEmote)
    pushControlCue(result.cues, parsed.goon_emotes)
    pushControlCue(result.cues, parsed.goonEmotes)
    pushControlCue(result.cues, parsed.goon_motion)
    pushControlCue(result.cues, parsed.goonMotion)
    pushControlCue(result.cues, parsed.goon_motions)
    pushControlCue(result.cues, parsed.goonMotions)
    pushControlCue(result.cues, parsed.emote)
    pushControlCue(result.cues, parsed.emotes)
    pushControlCue(result.cues, parsed.motion)
    pushControlCue(result.cues, parsed.motions)

    result.cues = Array.from(new Set(result.cues))
    return result
  }

  const normalizedPayload = payload.replace(/\\"/g, '"')
  const moodMatch = normalizedPayload.match(
    /["']?(?:goon_mood|goonMood|mood|goonMoodName)["']?\s*[:=]\s*["']?([a-zA-Z0-9 _-]+)["']?/i
  )
  result.mood = moodMatch?.[1]?.trim() || null

  const cueRegex =
    /["']?(?:goon_cue|goonCue|goon_emote|goonEmote|goon_motion|goonMotion|emote|motion)["']?\s*[:=]\s*["']?([a-zA-Z0-9 _-]+)["']?/gi
  let cueMatch: RegExpExecArray | null = null
  while ((cueMatch = cueRegex.exec(normalizedPayload)) !== null) {
    const cue = normalizeCueControlString(cueMatch[1])
    if (cue) result.cues.push(cue)
  }
  result.cues = Array.from(new Set(result.cues))
  return result
}

export function extractVisibleBatshitCueState(content: string): {
  cleanedContent: string
  notes: VisibleBatshitCueNote[]
} {
  if (!content) {
    return { cleanedContent: '', notes: [] }
  }

  const notes: VisibleBatshitCueNote[] = []
  const kept: string[] = []
  let cursor = 0
  for (const block of findCueBlocks(content)) {
    kept.push(content.slice(cursor, block.start))
    cursor = block.end
    const mood = extractGoonMoodFromCuePayload(content.slice(block.bodyStart, block.bodyEnd))
    if (mood) {
      notes.push({
        kind: 'mood',
        label: `Mood: ${mood}`,
        value: mood
      })
    }
  }
  kept.push(content.slice(cursor))
  const cleanedContent = stripEmoteTags(kept.join(''))
    .replace(GOON_STAGE_DIRECTION_REGEX, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { cleanedContent, notes }
}
