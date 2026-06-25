import type {
  GoonCueDefinition,
  GoonCueMap,
  GoonEmojiMap,
  GoonFileRef,
  GoonRecord,
  GoonsSettings
} from '$lib/types/goons'
import { sanitizeGoonAnimationName } from '$lib/goons/animationLoadPlan'
import { DEFAULT_GOON_CUES, DEFAULT_GOON_EMOJI_MAP } from '$lib/goons/defaults'
import { normalizeCustomPostureMap } from '$lib/goons/postures'
import { normalizeGoonGlobalEyeContactSettingsMap } from '$lib/goons/customAvatar'

export type ResolvedGoonCues = {
  cueMap: GoonCueMap
  emojiMap: GoonEmojiMap
  enabled: string[]
}

function cloneMap<T extends Record<string, any>>(input: T | undefined | null): T {
  return JSON.parse(JSON.stringify(input ?? {})) as T
}

function stripMoveCues(cueMap: GoonCueMap): GoonCueMap {
  const next: GoonCueMap = {}
  for (const [name, cue] of Object.entries(cueMap ?? {})) {
    const kind = (cue as { kind?: string })?.kind
    if (!cue || kind === 'move') continue
    next[name] = cue
  }
  return next
}

function normalizeMotionName(value: string) {
  return sanitizeGoonAnimationName(value).toLowerCase()
}

function resolveMotionFileName(file?: GoonFileRef | null) {
  if (!file) return ''
  return normalizeMotionName(file.originalName || file.filename || '')
}

export function resolveKitchenCues(goonsSettings?: GoonsSettings | null): {
  cueMap: GoonCueMap
  emojiMap: GoonEmojiMap
} {
  const kitchen = goonsSettings?.kitchen
  const cueMap = stripMoveCues(
    kitchen?.cues ? cloneMap(kitchen.cues) : cloneMap(DEFAULT_GOON_CUES)
  )
  const emojiMap = kitchen?.emojiMap
    ? cloneMap(kitchen.emojiMap)
    : cloneMap(DEFAULT_GOON_EMOJI_MAP)
  return { cueMap, emojiMap }
}

export function normalizeGoonsSettings(
  settings?: GoonsSettings | null
): GoonsSettings {
  return {
    dockOpen: settings?.dockOpen ?? false,
    showCues: settings?.showCues ?? false,
    immersiveMode: settings?.immersiveMode ?? true,
    globalCloset: cloneMap(settings?.globalCloset ?? { items: {} }),
    kitchen: {
      cues: stripMoveCues(cloneMap(settings?.kitchen?.cues ?? DEFAULT_GOON_CUES)),
      emojiMap: cloneMap(settings?.kitchen?.emojiMap ?? DEFAULT_GOON_EMOJI_MAP),
      postures: normalizeCustomPostureMap(settings?.kitchen?.postures),
      scenes: cloneMap(settings?.kitchen?.scenes ?? {}),
      roomTextures: cloneMap(settings?.kitchen?.roomTextures ?? {}),
      bodyVariants: cloneMap(settings?.kitchen?.bodyVariants ?? { items: {} }),
      eyeContact: normalizeGoonGlobalEyeContactSettingsMap(settings?.kitchen?.eyeContact),
      defaultPack: cloneMap(settings?.kitchen?.defaultPack ?? null)
    }
  }
}

export function resolveAutoEnabledCues(cueMap: GoonCueMap): string[] {
  return Object.entries(cueMap)
    .filter(([, cue]) => cue?.autoEnableForNewGoons !== false)
    .map(([name]) => name)
}

export function resolveGoonCues(
  goon?: GoonRecord | null,
  goonsSettings?: GoonsSettings | null
): ResolvedGoonCues {
  const kitchen = resolveKitchenCues(goonsSettings)
  const overrides = cloneMap(goon?.cues?.overrides ?? goon?.cues?.cueMap)
  const emojiOverrides = cloneMap(goon?.cues?.emojiOverrides ?? goon?.cues?.emojiMap)
  const disabledSet = new Set(
    (Array.isArray(goon?.cues?.disabled) ? goon?.cues?.disabled : []).filter(Boolean)
  )

  const mergedCueMap: GoonCueMap = stripMoveCues({
    ...kitchen.cueMap,
    ...overrides
  })

  const enabled: string[] = []
  const addEnabledName = (name?: string | null) => {
    if (!name) return
    if (disabledSet.has(name)) return
    if (!mergedCueMap[name]) return
    if (enabled.includes(name)) return
    enabled.push(name)
  }

  for (const name of resolveAutoEnabledCues(kitchen.cueMap)) {
    addEnabledName(name)
  }
  for (const name of Array.isArray(goon?.cues?.enabled) ? goon?.cues?.enabled ?? [] : []) {
    addEnabledName(name)
  }
  for (const name of Object.keys(overrides)) {
    addEnabledName(name)
  }

  const enabledSet = new Set(enabled)
  const filteredCueMap: GoonCueMap = {}
  for (const [name, cue] of Object.entries(mergedCueMap)) {
    if (!enabledSet.has(name)) continue
    filteredCueMap[name] = cue
  }

  const mergedEmojiMap: GoonEmojiMap = {
    ...kitchen.emojiMap,
    ...emojiOverrides
  }
  const filteredEmojiMap: GoonEmojiMap = {}
  for (const [emoji, cueName] of Object.entries(mergedEmojiMap)) {
    if (!cueName) continue
    if (!enabledSet.has(cueName)) continue
    filteredEmojiMap[emoji] = cueName
  }

  return {
    cueMap: filteredCueMap,
    emojiMap: filteredEmojiMap,
    enabled
  }
}

export function resolvePreviewAnimationDefinition(
  animationName: string,
  cueMap?: GoonCueMap | null,
  files: GoonFileRef[] = []
): GoonCueDefinition | undefined {
  const trimmed = animationName.trim()
  if (!trimmed) return undefined

  const directCue = cueMap?.[trimmed]
  if (directCue) return directCue

  const normalized = normalizeMotionName(trimmed)
  if (!normalized) return undefined

  for (const [cueName, cue] of Object.entries(cueMap ?? {})) {
    if (!cue) continue
    if (normalizeMotionName(cueName) === normalized) return cue
    if (cue.animationName && normalizeMotionName(cue.animationName) === normalized) return cue
  }

  const matchedFile = files.find((file) => resolveMotionFileName(file) === normalized)
  const posture = matchedFile?.motionMeta?.posture
  const playback = matchedFile?.motionMeta?.playback
  if (!posture && !playback) return undefined

  return {
    name: trimmed,
    kind: playback === 'oneshot' ? 'emote' : 'mood',
    animationName: trimmed,
    posture,
    playback: playback ?? 'loop'
  }
}
