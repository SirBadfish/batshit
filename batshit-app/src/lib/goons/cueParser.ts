import type { GoonCueDefinition, GoonCueMap, GoonEmojiMap } from '$lib/types/goons'
import { extractBatshitCuePayload } from '$lib/utils/batshitCue'

export type ParsedGoonCue = {
  name: string
  index: number
  source: 'emoji' | 'stage' | 'cue' | 'natural'
  definition?: GoonCueDefinition
  spanStart?: number
  spanEnd?: number
}

const STAGE_CUE_REGEX = /\*goon:\s*([a-zA-Z0-9 _-]+)\s*\*/g
const CONTROL_TAG_REGEX = /<batshit-cue[^>]*>([\s\S]*?)<\/batshit-cue>/gi
const PAIRED_EMOTE_TAG_REGEX =
  /<(?:emote|goon-emote)\b([^>]*)>([\s\S]*?)<\/(?:emote|goon-emote)>/gi
const SELF_CLOSING_EMOTE_TAG_REGEX = /<(?:emote|goon-emote)\b([^>]*)\/>/gi
const NAMED_EMOTE_TAG_REGEX =
  /<((?:emote|goon-emote)-([a-zA-Z0-9_-]+))\b[^>]*>[\s\S]*?<\/\1>/gi
const SELF_CLOSING_NAMED_EMOTE_TAG_REGEX = /<(?:emote|goon-emote)-([a-zA-Z0-9_-]+)\b[^>]*\/>/gi
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu
const EMOJI_TEST_REGEX = /\p{Extended_Pictographic}/u
const EMOJI_PAREN_COMBO_REGEX = /\(([^)]*)\)/g
const EMOJI_PLUS_COMBO_REGEX = /(\S+\s*\+\s*\S+)/g
const EMOJI_MODIFIER_REGEX = /\p{Emoji_Modifier}/gu
const EMOJI_VARIATION_REGEX = /[\uFE0E\uFE0F]/g

function normalizeEmoji(value: string) {
  if (!value) return value
  return value.replace(EMOJI_VARIATION_REGEX, '').replace(EMOJI_MODIFIER_REGEX, '')
}

function stripComboParens(value: string) {
  if (!value) return value
  const trimmed = value.trim()
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseEmojiCombo(value: string): EmojiSequenceResult {
  const stripped = stripComboParens(value)
  if (!stripped) {
    return { emojis: [], valid: false }
  }

  if (!stripped.includes('+')) {
    const result = parseEmojiSequence(stripped)
    if (!result.valid || result.emojis.length !== 2) {
      return { emojis: [], valid: false }
    }
    return { emojis: result.emojis, valid: true }
  }

  const parts = stripped
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length !== 2) {
    return { emojis: [], valid: false }
  }

  const emojis: string[] = []
  for (const part of parts) {
    const result = parseEmojiSequence(part)
    if (!result.valid || result.emojis.length !== 1) {
      return { emojis: [], valid: false }
    }
    emojis.push(result.emojis[0])
  }

  return { emojis, valid: true }
}

function canonicalizeEmojiCombo(value: string) {
  const stripped = stripComboParens(value)
  const combo = parseEmojiCombo(stripped)
  if (combo.valid) {
    return combo.emojis.map((emoji) => normalizeEmoji(emoji)).join('+')
  }

  const normalized = normalizeEmoji(stripped)
  return normalized
}

type EmojiSequenceResult = {
  emojis: string[]
  valid: boolean
}

function parseEmojiSequence(value: string): EmojiSequenceResult {
  const emojis: string[] = []
  let valid = true

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    for (const segment of segmenter.segment(value)) {
      const part = segment.segment
      if (!part) continue
      if (part.trim() === '') continue
      if (EMOJI_TEST_REGEX.test(part)) {
        emojis.push(part)
      } else {
        valid = false
      }
    }
  } else {
    for (const match of value.matchAll(EMOJI_REGEX)) {
      emojis.push(match[0])
    }
    const remainder = value.replace(EMOJI_REGEX, '').replace(/\s+/g, '')
    if (remainder.length > 0) valid = false
  }

  return { emojis, valid }
}

type EmojiComboRange = {
  start: number
  end: number
}

function isIndexInRanges(index: number, ranges: EmojiComboRange[]): boolean {
  for (const range of ranges) {
    if (index >= range.start && index < range.end) return true
  }
  return false
}

function collectEmojiCombos(
  text: string,
  emojiMap: Map<string, string>,
  cueMap: GoonCueMap
): { cues: ParsedGoonCue[]; ranges: EmojiComboRange[] } {
  const cues: ParsedGoonCue[] = []
  const ranges: EmojiComboRange[] = []

  const collectMatch = (raw: string, matchIndex: number, inner?: string) => {
    const comboSource = inner ?? raw
    const { emojis, valid } = parseEmojiCombo(comboSource)
    if (!valid) return
    const combined = emojis.join('+')
    const normalized = canonicalizeEmojiCombo(combined)
    const legacyCombined = emojis.join('')
    const cueName =
      emojiMap.get(combined) ||
      (normalized ? emojiMap.get(normalized) : undefined) ||
      emojiMap.get(legacyCombined)
    if (!cueName) return
    const emojiIndex = raw.indexOf(emojis[0])
    const index = matchIndex + (emojiIndex >= 0 ? emojiIndex : 0)
    cues.push({
      name: cueName,
      index,
      source: 'emoji',
      definition: cueMap[cueName],
      spanStart: matchIndex,
      spanEnd: matchIndex + raw.length
    })
    ranges.push({ start: matchIndex, end: matchIndex + raw.length })
  }

  EMOJI_PAREN_COMBO_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = null
  while ((match = EMOJI_PAREN_COMBO_REGEX.exec(text)) !== null) {
    collectMatch(match[0], match.index ?? 0, match[1] ?? '')
  }

  EMOJI_PLUS_COMBO_REGEX.lastIndex = 0
  while ((match = EMOJI_PLUS_COMBO_REGEX.exec(text)) !== null) {
    const matchIndex = match.index ?? 0
    if (isIndexInRanges(matchIndex, ranges)) continue
    collectMatch(match[1] ?? match[0], matchIndex)
  }

  return { cues, ranges }
}

function isSafeBoundary(text: string, index: number) {
  if (index <= 0) return true
  const prefix = text.slice(0, index)
  const trimmed = prefix.replace(/\s+$/g, '')
  if (!trimmed) return true
  const lastChar = trimmed.slice(-1)
  return lastChar === '.' || lastChar === '!' || lastChar === '?' || lastChar === '\n'
}

export function stripGoonStageDirections(text: string): string {
  if (!text) return ''
  return text.replace(STAGE_CUE_REGEX, '').trim()
}

type ControlPayloadResult = {
  moods: string[]
  cues: string[]
}

function normalizeCueKey(value: string) {
  return value.trim().toLowerCase()
}

function cueNameTokens(value: string): string[] {
  return normalizeCueKey(value)
    .replace(/[_-]+/g, ' ')
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter(Boolean)
}

function resolveCanonicalCueName(cueName: string, cueMap: GoonCueMap): string {
  const trimmed = cueName.trim()
  if (!trimmed) return cueName
  if (cueMap[trimmed]) return trimmed

  const normalized = normalizeCueKey(trimmed)
  for (const [key, cue] of Object.entries(cueMap)) {
    if (normalizeCueKey(key) === normalized) return key
    if (cue?.name && normalizeCueKey(cue.name) === normalized) return key
  }

  const requestedTokens = cueNameTokens(trimmed)
  if (requestedTokens.length === 1 && requestedTokens[0].length >= 3) {
    const requested = requestedTokens[0]
    const matchingKeys = Object.entries(cueMap)
      .filter(([key, cue]) => {
        const candidateTokens = new Set([
          ...cueNameTokens(key),
          ...cueNameTokens(cue?.name ?? '')
        ])
        return candidateTokens.has(requested)
      })
      .map(([key]) => key)

    if (matchingKeys.length === 1) return matchingKeys[0]
  }

  return trimmed
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cueNameToSpokenPattern(cueName: string): string | null {
  const normalized = cueName
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
  if (!normalized) return null

  const escaped = escapeRegExp(normalized)
  const compact = escapeRegExp(normalized.replace(/\s+/g, ''))
  const separatorPattern = escaped.replace(/\\ /g, '[\\s_-]+')
  const tokens = cueNameTokens(normalized)
  if (normalized === 'wink' || tokens.includes('wink')) return '(?:wink|winked|winking)'
  if (normalized === 'smile') return '(?:smile|smiled|smiling)'
  if (normalized === 'laugh') return '(?:laugh|laughed|laughing)'
  if (normalized === 'giggle') return '(?:giggle|giggled|giggling)'
  return compact === escaped ? escaped : `(?:${separatorPattern}|${compact})`
}

function hasNaturalCueNegation(text: string, cuePattern: string): boolean {
  const negation = new RegExp(
    `\\b(?:do\\s+not|don't|did\\s+not|didn't|won't|will\\s+not|cannot|can't|no|not)\\b.{0,24}\\b${cuePattern}\\b`,
    'i'
  )
  return negation.test(text)
}

function findLiveKitNaturalCueIndex(text: string, cuePattern: string): number | null {
  const patterns = [
    new RegExp(`^\\s*(?:there[,.!]?\\s+)?\\b(${cuePattern})\\b`, 'i'),
    new RegExp(`\\b(${cuePattern})\\b\\s+(?:right\\s+back|at\\s+you|for\\s+you)\\b`, 'i'),
    new RegExp(
      `\\b(?:i\\s+(?:just\\s+)?(?:did|used|triggered|played|sent|gave)|i\\s+(?:just\\s+)?(?:${cuePattern})|giving\\s+you|gave\\s+you|sent\\s+you)\\b.{0,40}\\b(${cuePattern})\\b`,
      'i'
    ),
    new RegExp(`\\b(?:a|little|quick|soft|big)\\s+(${cuePattern})\\b`, 'i')
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.index !== undefined) {
      const matchedCue = match[1] ?? match[2] ?? match[0]
      const offset = matchedCue ? match[0].toLowerCase().indexOf(matchedCue.toLowerCase()) : 0
      return match.index + Math.max(0, offset)
    }
  }

  return null
}

export function parseLiveKitNaturalGoonCues(
  text: string,
  cueMap: GoonCueMap
): ParsedGoonCue[] {
  if (!text) return []

  const cues: ParsedGoonCue[] = []
  const seen = new Set<string>()
  for (const [cueName, definition] of Object.entries(cueMap)) {
    if (!cueName || !definition || definition.kind !== 'emote') continue
    const cuePattern = cueNameToSpokenPattern(cueName)
    if (!cuePattern) continue
    if (hasNaturalCueNegation(text, cuePattern)) continue

    const index = findLiveKitNaturalCueIndex(text, cuePattern)
    if (index === null) continue
    const canonicalName = resolveCanonicalCueName(cueName, cueMap)
    if (seen.has(canonicalName)) continue
    seen.add(canonicalName)
    cues.push({
      name: canonicalName,
      index,
      source: 'natural',
      definition: cueMap[canonicalName],
      spanStart: index,
      spanEnd: index + cueName.length
    })
  }

  return cues.sort((a, b) => a.index - b.index)
}

function resolveEmoteTagCueName(attrs: string | undefined, innerText?: string | null): string | null {
  const attrText = (attrs ?? '').replace(/\/\s*$/g, '').trim()
  if (attrText) {
    const namedAttr = attrText.match(
      /(?:^|\s)(?:name|emote|cue|goon_cue|goonCue|goon_emote|goonEmote|motion)=["']?([a-zA-Z0-9 _-]+)["']?/i
    )
    if (namedAttr?.[1]) return namedAttr[1]

    const shorthand = attrText
      .split(/\s+/g)
      .map((part) => part.trim())
      .find((part) => /^[a-zA-Z0-9_-]+$/.test(part))
    if (shorthand) return shorthand
  }

  const inner = innerText?.trim()
  return inner && /^[a-zA-Z0-9 _-]+$/.test(inner) ? inner : null
}

function pushEmoteTagCue(
  cues: ParsedGoonCue[],
  cueName: string | null,
  baseIndex: number,
  spanEnd: number,
  cueMap: GoonCueMap
) {
  if (!cueName) return
  const canonicalName = resolveCanonicalCueName(cueName, cueMap)
  cues.push({
    name: canonicalName,
    index: baseIndex,
    source: 'cue',
    definition: cueMap[canonicalName],
    spanStart: baseIndex,
    spanEnd
  })
}

function parseControlPayload(raw: string): ControlPayloadResult {
  const payload = extractBatshitCuePayload(raw)
  return {
    moods: payload.mood ? [payload.mood] : [],
    cues: payload.cues
  }
}

export function parseGoonCues(
  text: string,
  emojiMap: GoonEmojiMap,
  cueMap: GoonCueMap
): ParsedGoonCue[] {
  if (!text) return []

  const cues: ParsedGoonCue[] = []

  let match: RegExpExecArray | null = null
  while ((match = STAGE_CUE_REGEX.exec(text)) !== null) {
    const cueName = match[1]?.trim().replace(/\s+/g, ' ')
    if (!cueName) continue
    if (!isSafeBoundary(text, match.index)) continue
    const canonicalName = resolveCanonicalCueName(cueName, cueMap)
    cues.push({
      name: canonicalName,
      index: match.index,
      source: 'stage',
      definition: cueMap[canonicalName],
      spanStart: match.index,
      spanEnd: match.index + match[0].length
    })
  }

  while ((match = CONTROL_TAG_REGEX.exec(text)) !== null) {
    const payload = match[1]
    if (!payload) continue
    const { moods, cues: controlCues } = parseControlPayload(payload)
    const baseIndex = match.index ?? 0
    const spanEnd = baseIndex + match[0].length
    moods.forEach((mood, idx) => {
      if (!mood) return
      const canonicalName = resolveCanonicalCueName(mood, cueMap)
      cues.push({
        name: canonicalName,
        index: baseIndex + idx,
        source: 'cue',
        definition: cueMap[canonicalName],
        spanStart: baseIndex,
        spanEnd
      })
    })
    controlCues.forEach((cueName, idx) => {
      if (!cueName) return
      const canonicalName = resolveCanonicalCueName(cueName, cueMap)
      cues.push({
        name: canonicalName,
        index: baseIndex + moods.length + idx,
        source: 'cue',
        definition: cueMap[canonicalName],
        spanStart: baseIndex,
        spanEnd
      })
    })
  }

  while ((match = PAIRED_EMOTE_TAG_REGEX.exec(text)) !== null) {
    const baseIndex = match.index ?? 0
    pushEmoteTagCue(
      cues,
      resolveEmoteTagCueName(match[1], match[2]),
      baseIndex,
      baseIndex + match[0].length,
      cueMap
    )
  }

  while ((match = NAMED_EMOTE_TAG_REGEX.exec(text)) !== null) {
    const baseIndex = match.index ?? 0
    pushEmoteTagCue(cues, match[2] ?? null, baseIndex, baseIndex + match[0].length, cueMap)
  }

  while ((match = SELF_CLOSING_EMOTE_TAG_REGEX.exec(text)) !== null) {
    const baseIndex = match.index ?? 0
    pushEmoteTagCue(
      cues,
      resolveEmoteTagCueName(match[1]),
      baseIndex,
      baseIndex + match[0].length,
      cueMap
    )
  }

  while ((match = SELF_CLOSING_NAMED_EMOTE_TAG_REGEX.exec(text)) !== null) {
    const baseIndex = match.index ?? 0
    pushEmoteTagCue(cues, match[1] ?? null, baseIndex, baseIndex + match[0].length, cueMap)
  }

  if (emojiMap && Object.keys(emojiMap).length > 0) {
    const normalizedEmojiMap = new Map<string, string>()
    for (const [emoji, cueName] of Object.entries(emojiMap)) {
      if (!emoji || !cueName) continue
      const trimmed = emoji.trim()
      const stripped = stripComboParens(trimmed)
      normalizedEmojiMap.set(trimmed, cueName)
      if (stripped && stripped !== trimmed) normalizedEmojiMap.set(stripped, cueName)
      const canonicalCombo = canonicalizeEmojiCombo(stripped)
      if (canonicalCombo) normalizedEmojiMap.set(canonicalCombo, cueName)
      const normalized = normalizeEmoji(stripped)
      if (normalized) normalizedEmojiMap.set(normalized, cueName)
    }

    const comboResults = collectEmojiCombos(text, normalizedEmojiMap, cueMap)
    cues.push(...comboResults.cues)

    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      let index = 0
      for (const segment of segmenter.segment(text)) {
        if (comboResults.ranges.length > 0) {
          const segmentIndex = segment.index ?? index
          if (isIndexInRanges(segmentIndex, comboResults.ranges)) {
            index += segment.segment.length
            continue
          }
        }
        const value = segment.segment
        if (!value) continue
        if (!EMOJI_TEST_REGEX.test(value)) {
          index += value.length
          continue
        }
        const normalized = normalizeEmoji(value)
        const cueName =
          normalizedEmojiMap.get(value) || (normalized ? normalizedEmojiMap.get(normalized) : undefined)
        if (cueName) {
          cues.push({
            name: cueName,
            index: segment.index ?? index,
            source: 'emoji',
            definition: cueMap[cueName],
            spanStart: segment.index ?? index,
            spanEnd: (segment.index ?? index) + value.length
          })
        }
        index += value.length
      }
    } else {
      const emojiMatches = text.matchAll(EMOJI_REGEX)
      for (const emojiMatch of emojiMatches) {
        if (
          comboResults.ranges.length > 0 &&
          isIndexInRanges(emojiMatch.index ?? 0, comboResults.ranges)
        ) {
          continue
        }
        const emoji = emojiMatch[0]
        const normalized = normalizeEmoji(emoji)
        const cueName =
          normalizedEmojiMap.get(emoji) || (normalized ? normalizedEmojiMap.get(normalized) : undefined)
        if (!cueName) continue
        cues.push({
          name: cueName,
          index: emojiMatch.index ?? 0,
          source: 'emoji',
          definition: cueMap[cueName],
          spanStart: emojiMatch.index ?? 0,
          spanEnd: (emojiMatch.index ?? 0) + emoji.length
        })
      }
    }
  }

  return cues.sort((a, b) => a.index - b.index)
}
