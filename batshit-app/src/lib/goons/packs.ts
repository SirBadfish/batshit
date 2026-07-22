import {
  normalizeGoonEyeContactCompensation,
  normalizeGoonEyeContactHeadStart,
  normalizeGoonEyeContactMultiplier,
  normalizeGoonEyeContactSpeed
} from '$lib/goons/customAvatar'
import { normalizeGoonCueMap, normalizeGoonsSettings, resolveGoonCues } from '$lib/goons/resolve'
import { parseSocketEyeContactSettings } from '$lib/goons/socketEyeContact'
import type {
  GoonCueDefinition,
  GoonCueMap,
  GoonDefaultPack,
  GoonDefaultPackDefaults,
  GoonEmojiMap,
  GoonPostureDefinition,
  GoonRecord,
  GoonSceneDefinition,
  GoonsSettings
} from '$lib/types/goons'

export type GoonLibraryExportBundle = {
  version: 1
  exportedAt: string
  postures?: GoonPostureDefinition[]
  moods: GoonCueDefinition[]
  emotes: GoonCueDefinition[]
  emojiMap: GoonEmojiMap
  scenes: GoonSceneDefinition[]
}

export type ImportedGoonLibraryBundle = {
  settings: GoonsSettings
  renamedCueNames: Record<string, string>
  renamedSceneNames: Record<string, string>
  emojiConflicts: string[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function uniqueName(baseName: string, taken: Set<string>): string {
  const trimmed = baseName.trim() || 'item'
  if (!taken.has(trimmed)) {
    taken.add(trimmed)
    return trimmed
  }

  let index = 2
  let candidate = `${trimmed}${index}`
  while (taken.has(candidate)) {
    index += 1
    candidate = `${trimmed}${index}`
  }
  taken.add(candidate)
  return candidate
}

function buildSceneId(name: string, existingIds: Set<string>): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'scene'

  if (!existingIds.has(slug)) {
    existingIds.add(slug)
    return slug
  }

  let index = 2
  let candidate = `${slug}_${index}`
  while (existingIds.has(candidate)) {
    index += 1
    candidate = `${slug}_${index}`
  }
  existingIds.add(candidate)
  return candidate
}

function normalizeDefaultPackDefaults(
  defaults?: GoonDefaultPackDefaults | null
): GoonDefaultPackDefaults | undefined {
  if (!defaults) return undefined

  const next: GoonDefaultPackDefaults = {}
  if (typeof defaults.baseLoop === 'string' && defaults.baseLoop.trim()) {
    next.baseLoop = defaults.baseLoop.trim()
  }
  if (
    defaults.quality === 'auto' ||
    defaults.quality === 'low' ||
    defaults.quality === 'high' ||
    defaults.quality === 'ultra'
  ) {
    next.quality = defaults.quality
  }
  if (typeof defaults.lipSync === 'boolean') {
    next.lipSync = defaults.lipSync
  }
  if (defaults.eyeContactMode === 'bone' || defaults.eyeContactMode === 'expression') {
    next.eyeContactMode = defaults.eyeContactMode
  }
  if (defaults.eyeContactTuning) {
    const tuning = defaults.eyeContactTuning
    const legacy = tuning as typeof tuning & {
      yawStrength?: number
      pitchStrength?: number
      headStartDeg?: number
      headStrength?: number
    }
    next.eyeContactTuning = {
      eyeYawSensitivity: normalizeGoonEyeContactMultiplier(tuning.eyeYawSensitivity ?? legacy.yawStrength),
      eyeYawRange: normalizeGoonEyeContactMultiplier(tuning.eyeYawRange ?? legacy.yawStrength),
      eyePitchSensitivity: normalizeGoonEyeContactMultiplier(
        tuning.eyePitchSensitivity ?? legacy.pitchStrength
      ),
      eyePitchRange: normalizeGoonEyeContactMultiplier(tuning.eyePitchRange ?? legacy.pitchStrength),
      headYawStartOutDeg: normalizeGoonEyeContactHeadStart(
        tuning.headYawStartOutDeg ?? tuning.headYawStartDeg ?? legacy.headStartDeg,
        14
      ),
      headYawStartInDeg: normalizeGoonEyeContactHeadStart(tuning.headYawStartInDeg, 52),
      headYawSensitivity: normalizeGoonEyeContactMultiplier(
        tuning.headYawSensitivity ?? legacy.headStrength
      ),
      headYawRange: normalizeGoonEyeContactMultiplier(tuning.headYawRange ?? legacy.headStrength),
      headYawSpeed: normalizeGoonEyeContactSpeed(tuning.headYawSpeed),
      headPitchStartOutDeg: normalizeGoonEyeContactHeadStart(
        tuning.headPitchStartOutDeg ?? tuning.headPitchStartDeg,
        8
      ),
      headPitchStartInDeg: normalizeGoonEyeContactHeadStart(tuning.headPitchStartInDeg, 22),
      headPitchSensitivity: normalizeGoonEyeContactMultiplier(
        tuning.headPitchSensitivity ?? legacy.headStrength
      ),
      headPitchRange: normalizeGoonEyeContactMultiplier(tuning.headPitchRange ?? legacy.headStrength),
      headPitchSpeed: normalizeGoonEyeContactSpeed(tuning.headPitchSpeed),
      eyeYawHeadCompensation: normalizeGoonEyeContactCompensation(tuning.eyeYawHeadCompensation),
      eyePitchHeadCompensation: normalizeGoonEyeContactCompensation(tuning.eyePitchHeadCompensation)
    }
  }
  if (defaults.socketEyeContact) {
    next.socketEyeContact = parseSocketEyeContactSettings(defaults.socketEyeContact)
  }
  if (typeof defaults.sceneId === 'string' && defaults.sceneId.trim()) {
    next.sceneId = defaults.sceneId.trim()
  }

  return Object.keys(next).length > 0 ? next : undefined
}

export function buildDefaultPackFromGoon(
  goon: GoonRecord,
  goonsSettings?: GoonsSettings | null
): GoonDefaultPack {
  const normalizedSettings = normalizeGoonsSettings(goonsSettings)
  const resolved = resolveGoonCues(goon, normalizedSettings)
  const enabledCueNames = Object.keys(resolved.cueMap)
  const defaults = normalizeDefaultPackDefaults({
    baseLoop: goon.defaults?.baseLoop,
    quality: goon.defaults?.quality,
    lipSync: goon.defaults?.lipSync,
    eyeContactMode: goon.defaults?.eyeContactMode,
    eyeContactTuning: goon.defaults?.eyeContactTuning,
    socketEyeContact: goon.defaults?.socketEyeContact,
    sceneId: goon.defaults?.sceneId
  })

  const fallbackBaseLoop =
    defaults?.baseLoop && enabledCueNames.includes(defaults.baseLoop)
      ? defaults.baseLoop
      : enabledCueNames.find((name) => resolved.cueMap[name]?.kind === 'mood') ?? enabledCueNames[0]

  return {
    name: 'Default Pack',
    exportedAt: new Date().toISOString(),
    sourceGoonId: goon.id,
    sourceGoonName: goon.name,
    enabledCueNames,
    cueMap: clone(resolved.cueMap),
    emojiMap: clone(resolved.emojiMap),
    defaults: normalizeDefaultPackDefaults({
      ...defaults,
      baseLoop: fallbackBaseLoop
    })
  }
}

export function mergeDefaultPackIntoSettings(
  goonsSettings: GoonsSettings | null | undefined,
  pack: GoonDefaultPack
): GoonsSettings {
  const normalized = normalizeGoonsSettings(goonsSettings)
  const nextCueMap: GoonCueMap = {
    ...(normalized.kitchen?.cues ?? {})
  }
  for (const [name, cue] of Object.entries(pack.cueMap ?? {})) {
    nextCueMap[name] = clone(cue)
  }

  return {
    ...normalized,
    kitchen: {
      ...normalized.kitchen,
      cues: nextCueMap,
      emojiMap: {
        ...(normalized.kitchen?.emojiMap ?? {}),
        ...clone(pack.emojiMap ?? {})
      },
      defaultPack: clone(pack)
    }
  }
}

export function buildDefaultPackUpdateForGoon(
  goon: GoonRecord,
  goonsSettings?: GoonsSettings | null
): Partial<GoonRecord> | null {
  const normalized = normalizeGoonsSettings(goonsSettings)
  const pack = normalized.kitchen?.defaultPack
  if (!pack) return null

  const enabledCueNames = (pack.enabledCueNames ?? []).filter((name) =>
    Boolean(normalized.kitchen?.cues?.[name])
  )
  if (enabledCueNames.length === 0) return null
  const disabledCueNames = Object.keys(normalized.kitchen?.cues ?? {}).filter(
    (name) => !enabledCueNames.includes(name)
  )

  return {
    cues: {
      enabled: enabledCueNames,
      disabled: disabledCueNames,
      overrides: {},
      emojiOverrides: {}
    },
    defaults: {
      ...(goon.defaults ?? {}),
      ...(pack.defaults ?? {})
    }
  }
}

export function importGoonLibraryExportBundle(
  goonsSettings: GoonsSettings | null | undefined,
  bundle: GoonLibraryExportBundle
): ImportedGoonLibraryBundle {
  const normalized = normalizeGoonsSettings(goonsSettings)
  const nextCueMap: GoonCueMap = {
    ...(normalized.kitchen?.cues ?? {})
  }
  const nextEmojiMap: GoonEmojiMap = {
    ...(normalized.kitchen?.emojiMap ?? {})
  }
  const nextScenes = {
    ...(normalized.kitchen?.scenes ?? {})
  }

  const renamedCueNames: Record<string, string> = {}
  const renamedSceneNames: Record<string, string> = {}
  const emojiConflicts: string[] = []

  const takenCueNames = new Set(Object.keys(nextCueMap))
  const importedCues = [...(bundle.moods ?? []), ...(bundle.emotes ?? [])]
  for (const cue of importedCues) {
    const originalName = cue.name?.trim() || 'motion'
    const normalizedCue = normalizeGoonCueMap({
      [originalName]: {
        ...clone(cue),
        name: originalName
      }
    })[originalName]
    if (!normalizedCue) continue
    const nextName = uniqueName(originalName, takenCueNames)
    if (nextName !== originalName) {
      renamedCueNames[originalName] = nextName
    }
    nextCueMap[nextName] = {
      ...normalizedCue,
      name: nextName
    }
  }

  for (const [emoji, cueName] of Object.entries(bundle.emojiMap ?? {})) {
    const nextCueName = renamedCueNames[cueName] ?? cueName
    if (nextCueMap[nextCueName]?.kind !== 'emote') continue
    if (nextEmojiMap[emoji] && nextEmojiMap[emoji] !== nextCueName) {
      emojiConflicts.push(emoji)
      continue
    }
    nextEmojiMap[emoji] = nextCueName
  }

  const takenSceneNames = new Set(Object.values(nextScenes).map((scene) => scene.name))
  const existingSceneIds = new Set(Object.keys(nextScenes))
  for (const scene of bundle.scenes ?? []) {
    const originalName = scene.name?.trim() || 'Scene'
    const nextName = uniqueName(originalName, takenSceneNames)
    const nextId = buildSceneId(nextName, existingSceneIds)
    if (nextName !== originalName) {
      renamedSceneNames[originalName] = nextName
    }
    nextScenes[nextId] = {
      ...clone(scene),
      id: nextId,
      name: nextName
    }
  }

  return {
    settings: {
      ...normalized,
      kitchen: {
        ...normalized.kitchen,
        postures: bundle.postures && bundle.postures.length > 0
          ? {
              ...(normalized.kitchen?.postures ?? {}),
              ...Object.fromEntries(
                bundle.postures
                  .filter((posture: GoonPostureDefinition) => posture?.id)
                  .map((posture) => [posture.id, clone(posture)])
              )
            }
          : normalized.kitchen?.postures,
        cues: nextCueMap,
        emojiMap: nextEmojiMap,
        scenes: nextScenes
      }
    },
    renamedCueNames,
    renamedSceneNames,
    emojiConflicts
  }
}
