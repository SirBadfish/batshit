import type { GoonCueMap, GoonEmojiMap, GoonRecord, GoonsSettings } from '$lib/types/goons'
import { resolveGoonCues } from '$lib/goons/resolve'
import {
  normalizeDesktopGoonPresentationMode,
  type DesktopGoonPresentationMode
} from '$lib/goons/desktopGoonPresentation'

export type GoonDcmOptions = {
  maxCuesPerGroup?: number
  maxEmojis?: number
  includeSpokenCues?: boolean
  presentationMode?: DesktopGoonPresentationMode | null
}

type GoonDcmLimits = Required<Pick<GoonDcmOptions, 'maxCuesPerGroup' | 'maxEmojis'>>

const DEFAULT_DCM_LIMITS: GoonDcmLimits = {
  maxCuesPerGroup: Number.POSITIVE_INFINITY,
  maxEmojis: Number.POSITIVE_INFINITY
}
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu

export function shouldIncludeGoonSpokenCues(
  voiceState?: { tts?: boolean; stt?: boolean; voiceMode?: string | null } | null
): boolean {
  if (!voiceState) return false
  const voiceMode = String(voiceState.voiceMode ?? '').toLowerCase()
  return (
    Boolean(voiceState.tts) ||
    voiceMode === 'voice' ||
    voiceMode === 'hybrid' ||
    voiceMode === 'speech-to-speech'
  )
}

function formatEmojiLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const inner =
    trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1).trim() : trimmed
  const parts = Array.from(inner.split('+')).map((part) => part.trim()).filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(0, 2).join('+')
  }
  const emojis = Array.from(inner.matchAll(EMOJI_REGEX)).map((match) => match[0]).filter(Boolean)
  if (emojis.length >= 2) return emojis.slice(0, 2).join('+')
  return inner
}

function formatList(items: string[], limit: number): string {
  if (items.length === 0) return ''
  if (items.length <= limit) return items.join(', ')
  const visible = items.slice(0, limit).join(', ')
  return `${visible}, +${items.length - limit} more`
}

function sortUnique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort()
}

function formatCueEntries(
  entries: Array<{ name: string; description?: string }>,
  limit: number
): string {
  if (entries.length === 0) return ''
  const seen = new Set<string>()
  const normalized = entries
    .map((entry) => ({
      name: entry.name.trim(),
      description: entry.description?.trim()
    }))
    .filter((entry) => {
      if (!entry.name || seen.has(entry.name)) return false
      seen.add(entry.name)
      return true
    })
    .sort((left, right) => left.name.localeCompare(right.name))

  const visible = normalized.slice(0, limit).map((entry) =>
    entry.description ? `${entry.name} (${entry.description})` : entry.name
  )

  if (normalized.length <= limit) return visible.join(', ')
  return `${visible.join(', ')}, +${normalized.length - limit} more`
}

function formatCategoryLabel(category: string): string {
  if (!category) return 'Closet'
  return category
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function formatClosetEntryLabel(entry: {
  slot: string
  name: string
  description?: string
}): string {
  const itemLabel = entry.description ? `${entry.name} (${entry.description})` : entry.name
  return `${entry.slot}: ${itemLabel}`
}

function resolveClosetEntries(goon: GoonRecord, goonsSettings?: GoonsSettings | null) {
  const assignments = goon.closetAssignments ?? {}
  const globalClosetItems = goonsSettings?.globalCloset?.items ?? {}
  const goonClosetItems = goon.closet?.items ?? {}
  const entries: Array<{ slot: string; name: string; description?: string }> = []

  for (const [slotName, assignment] of Object.entries(assignments)) {
    if (!assignment || assignment.mode !== 'item' || !assignment.itemId) continue

    const item = goonClosetItems[assignment.itemId] ?? globalClosetItems[assignment.itemId]
    const slot =
      assignment.label?.trim() ||
      formatCategoryLabel(item?.category?.trim() || slotName)
    const name = item?.name?.trim() || assignment.itemId
    const description = item?.description?.trim() || undefined

    entries.push({ slot, name, description })
  }

  return entries
    .filter((entry) => entry.name.length > 0)
    .sort((left, right) =>
      left.slot.localeCompare(right.slot) || left.name.localeCompare(right.name)
    )
}

export function buildGoonDcmLines(
  goon: GoonRecord,
  options: GoonDcmOptions = {},
  goonsSettings?: GoonsSettings | null
): string[] {
  if (!goon) return []

  const limits = {
    ...DEFAULT_DCM_LIMITS,
    ...options
  }
  const includeSpokenCues = options.includeSpokenCues === true
  const presentationMode = normalizeDesktopGoonPresentationMode(options.presentationMode) ?? 'dock'

  const { cueMap, emojiMap } = resolveGoonCues(goon, goonsSettings)

  const moodCues: Array<{ name: string; description?: string }> = []
  const emoteCues: Array<{ name: string; description?: string }> = []
  const otherCues: Array<{ name: string; description?: string }> = []
  const blockingCues: string[] = []

  for (const [key, cue] of Object.entries(cueMap)) {
    if (!cue) continue
    const name = cue.name || key
    if (cue.blocking) blockingCues.push(name)

    switch (cue.kind) {
      case 'mood':
        moodCues.push({ name, description: cue.description })
        break
      case 'emote':
        emoteCues.push({ name, description: cue.description })
        break
      default:
        otherCues.push({ name, description: cue.description })
        break
    }
  }

  const lines: string[] = []
  lines.push(
    'Goon moods stay active until changed. Use <batshit-cue>{"goon_mood":"mood_name"}</batshit-cue> inline wherever the mood should change; it does not have to be the first thing in the reply.'
  )
  if (includeSpokenCues) {
    lines.push(
      'One-shot goon Motions and facial-only emoji Emotes fire on spoken replies with TTS timing. Use *goon: motion_name* for a body Motion or the emoji mappings below for a facial Emote.'
    )
    lines.push('If an emote has Pause speech timing, that authored pause wins.')
    lines.push(
      'For normal emoji emotes, place the emoji immediately before the spoken word or sentence it should start with.'
    )
    lines.push(
      'If an emoji is followed only by punctuation or it ends the message, Batshit treats it like an after-reaction instead of waiting for a next word.'
    )
    lines.push('Emoji combos use +, e.g. 😏+🙄. Keep combos to 2 emojis max.')
  }

  const baseLoop = goon.defaults?.baseLoop
  if (baseLoop) {
    lines.push(`Current mood: ${baseLoop}`)
  }

  if (presentationMode === 'desktop') {
    lines.push(
      "Presentation: Desktop Mode — your live 3D Goon is currently visible directly on the user's operating-system desktop in a transparent, scene-free window, with wallpaper or other apps potentially behind and around you."
    )
    lines.push(
      "Desktop visibility boundary: no Batshit room, skybox, or saved Goon scene is visible. Desktop Mode does not give you screen vision; do not claim to see the user's wallpaper, windows, apps, or desktop contents unless the user shares them."
    )
  } else {
    lines.push(
      presentationMode === 'immersive'
        ? "Presentation: Immersive Mode — your live 3D Goon is currently visible across the user's Batshit workspace."
        : "Presentation: Goon Dock — your live 3D Goon is currently visible inside the user's Batshit app."
    )
    const sceneId = goon.defaults?.sceneId?.trim()
    const activeScene = sceneId ? goonsSettings?.kitchen?.scenes?.[sceneId] : null
    if (activeScene?.name) {
      lines.push(`Scene: ${activeScene.name}`)
    }
  }

  const closetEntries = resolveClosetEntries(goon, goonsSettings)
  if (closetEntries.length > 0) {
    lines.push(
      `Closet outfit: ${closetEntries.map((entry) => formatClosetEntryLabel(entry)).join('; ')}`
    )
  }

  if (moodCues.length > 0) {
    lines.push(`Moods: ${formatCueEntries(moodCues, limits.maxCuesPerGroup)}`)
  }
  if (includeSpokenCues && emoteCues.length > 0) {
    lines.push(`Emotes: ${formatCueEntries(emoteCues, limits.maxCuesPerGroup)}`)
  }
  if (includeSpokenCues && otherCues.length > 0) {
    lines.push(`Other motions: ${formatCueEntries(otherCues, limits.maxCuesPerGroup)}`)
  }

  if (includeSpokenCues && blockingCues.length > 0) {
    lines.push(
      `Pause speech emotes: ${formatList(sortUnique(blockingCues), limits.maxCuesPerGroup)}`
    )
  }

  const emojiPairs = Object.entries(emojiMap)
    .map(([emoji, cue]) => `${formatEmojiLabel(emoji)}=${cue}`)
    .filter((pair) => pair.trim().length > 0)

  if (includeSpokenCues && emojiPairs.length > 0) {
    lines.push(`Emoji triggers: ${formatList(emojiPairs, limits.maxEmojis)}`)
  }

  return lines
}
