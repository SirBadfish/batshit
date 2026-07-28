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
import {
  hasCueFacePayload,
  normalizeCueFaceSource
} from '$lib/goons/cueFaceProfiles'

export type ResolvedGoonCues = {
  cueMap: GoonCueMap
  emojiMap: GoonEmojiMap
  enabled: string[]
}

function cloneMap<T extends Record<string, any>>(input: T | undefined | null): T {
  return JSON.parse(JSON.stringify(input ?? {})) as T
}

const LEGACY_MOTION_ONLY_EMOTE_NAMES = new Set([
  'wave',
  'nod',
  'shake_head',
  'shrug',
  'point',
  'thinking_beat',
  'laugh'
])

function hasFacialPayload(cue: GoonCueDefinition): boolean {
  if (hasCueFacePayload(cue)) return true
  return (cue.steps ?? []).some((step) => hasCueFacePayload(step))
}

function normalizeCueFaceProfiles(cue: GoonCueDefinition): GoonCueDefinition {
  const topLevel = normalizeCueFaceSource(cue, {
    initializeNeutralArkit52: cue.kind === 'emote'
  })
  const normalized: GoonCueDefinition = {
    ...cue,
    faceProfiles: topLevel.faceProfiles,
    rawMorphTargets: topLevel.rawMorphTargets,
    steps: cue.steps?.map((step) => {
      const face = normalizeCueFaceSource(step, {
        initializeNeutralArkit52: cue.kind === 'emote'
      })
      const normalizedStep = {
        ...step,
        faceProfiles: face.faceProfiles,
        rawMorphTargets: face.rawMorphTargets
      }
      delete normalizedStep.expressionTargets
      delete normalizedStep.faceControls
      return normalizedStep
    })
  }
  delete normalized.expressionTargets
  delete normalized.faceControls
  return normalized
}

/**
 * Enforces the product boundary between facial Emotes and body Motions.
 * Older motion-linked Emotes keep any authored face payload, but their motion
 * fields are removed. Legacy motion-only defaults disappear from the Emote
 * catalog entirely; their animation files remain ordinary Motion Vault items.
 */
export function normalizeGoonCueMap(cueMap: GoonCueMap): GoonCueMap {
  const next: GoonCueMap = {}
  for (const [name, cue] of Object.entries(cueMap ?? {})) {
    const kind = (cue as { kind?: string })?.kind
    if (!cue || kind === 'move') continue

    if (cue.kind !== 'emote') {
      next[name] = normalizeCueFaceProfiles(cue)
      continue
    }

    const hadMotionFields = Boolean(cue.animationName?.trim() || cue.posture || cue.mask)
    const facial = hasFacialPayload(cue)
    const normalizedName = (cue.name || name).trim()
    if (
      !facial &&
      (hadMotionFields || LEGACY_MOTION_ONLY_EMOTE_NAMES.has(normalizedName.toLowerCase()))
    ) {
      continue
    }

    const normalized: GoonCueDefinition = {
      ...normalizeCueFaceProfiles(cue),
      name: normalizedName || name,
      playback: 'oneshot'
    }
    delete normalized.animationName
    delete normalized.posture
    delete normalized.mask
    next[name] = normalized
  }
  return next
}

function normalizeEmojiMap(emojiMap: GoonEmojiMap, cueMap: GoonCueMap): GoonEmojiMap {
  const next: GoonEmojiMap = {}
  for (const [emoji, cueName] of Object.entries(emojiMap ?? {})) {
    if (cueMap[cueName]?.kind !== 'emote') continue
    next[emoji] = cueName
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
  const cueMap = normalizeGoonCueMap(
    kitchen?.cues ? cloneMap(kitchen.cues) : cloneMap(DEFAULT_GOON_CUES)
  )
  const emojiMap = normalizeEmojiMap(
    kitchen?.emojiMap ? cloneMap(kitchen.emojiMap) : cloneMap(DEFAULT_GOON_EMOJI_MAP),
    cueMap
  )
  return { cueMap, emojiMap }
}

function normalizeGoonMotionsSettings(
  value?: GoonsSettings['motions'] | null
): NonNullable<GoonsSettings['motions']> {
  const glbPreviewGoonId =
    typeof value?.glbPreviewGoonId === 'string' && value.glbPreviewGoonId.trim()
      ? value.glbPreviewGoonId.trim()
      : undefined
  return glbPreviewGoonId ? { glbPreviewGoonId } : {}
}

export function normalizeGoonsSettings(
  settings?: GoonsSettings | null
): GoonsSettings {
  const cues = normalizeGoonCueMap(cloneMap(settings?.kitchen?.cues ?? DEFAULT_GOON_CUES))
  const emojiMap = normalizeEmojiMap(
    cloneMap(settings?.kitchen?.emojiMap ?? DEFAULT_GOON_EMOJI_MAP),
    cues
  )
  return {
    dockOpen: settings?.dockOpen ?? false,
    showCues: settings?.showCues ?? false,
    immersiveMode: settings?.immersiveMode ?? true,
    globalCloset: cloneMap(settings?.globalCloset ?? { items: {} }),
    kitchen: {
      cues,
      emojiMap,
      postures: normalizeCustomPostureMap(settings?.kitchen?.postures),
      scenes: cloneMap(settings?.kitchen?.scenes ?? {}),
      roomTextures: cloneMap(settings?.kitchen?.roomTextures ?? {}),
      bodyVariants: cloneMap(settings?.kitchen?.bodyVariants ?? { items: {} }),
      eyeContact: normalizeGoonGlobalEyeContactSettingsMap(settings?.kitchen?.eyeContact),
      defaultPack: cloneMap(settings?.kitchen?.defaultPack ?? null)
    },
    motions: normalizeGoonMotionsSettings(settings?.motions)
  }
}

export function mergeGoonsSettingsPatch(
  settings: GoonsSettings | null | undefined,
  patch: Partial<GoonsSettings> | null | undefined
): GoonsSettings {
  const normalized = normalizeGoonsSettings(settings)
  if (!patch || typeof patch !== 'object') return normalized

  const next: GoonsSettings = { ...normalized }
  if (patch.dockOpen !== undefined) next.dockOpen = patch.dockOpen
  if (patch.showCues !== undefined) next.showCues = patch.showCues
  if (patch.immersiveMode !== undefined) next.immersiveMode = patch.immersiveMode
  if (patch.globalCloset !== undefined) next.globalCloset = cloneMap(patch.globalCloset)

  const kitchenPatch = patch.kitchen
  if (kitchenPatch && typeof kitchenPatch === 'object') {
    next.kitchen = {
      ...normalized.kitchen,
      ...kitchenPatch,
      cues: kitchenPatch.cues !== undefined ? cloneMap(kitchenPatch.cues) : normalized.kitchen?.cues,
      emojiMap:
        kitchenPatch.emojiMap !== undefined
          ? cloneMap(kitchenPatch.emojiMap)
          : normalized.kitchen?.emojiMap,
      postures:
        kitchenPatch.postures !== undefined
          ? normalizeCustomPostureMap(kitchenPatch.postures)
          : normalized.kitchen?.postures,
      scenes:
        kitchenPatch.scenes !== undefined ? cloneMap(kitchenPatch.scenes) : normalized.kitchen?.scenes,
      roomTextures:
        kitchenPatch.roomTextures !== undefined
          ? cloneMap(kitchenPatch.roomTextures)
          : normalized.kitchen?.roomTextures,
      bodyVariants:
        kitchenPatch.bodyVariants !== undefined
          ? cloneMap(kitchenPatch.bodyVariants)
          : normalized.kitchen?.bodyVariants,
      eyeContact:
        kitchenPatch.eyeContact !== undefined
          ? normalizeGoonGlobalEyeContactSettingsMap(kitchenPatch.eyeContact)
          : normalized.kitchen?.eyeContact,
      defaultPack:
        kitchenPatch.defaultPack !== undefined
          ? kitchenPatch.defaultPack === null
            ? null
            : cloneMap(kitchenPatch.defaultPack)
          : normalized.kitchen?.defaultPack
    }
  }

  if (patch.motions !== undefined) {
    next.motions = normalizeGoonMotionsSettings(patch.motions)
  }

  return normalizeGoonsSettings(next)
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

  const mergedCueMap: GoonCueMap = normalizeGoonCueMap({
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
