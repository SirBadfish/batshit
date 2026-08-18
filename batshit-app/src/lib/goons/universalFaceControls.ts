import type {
  BatshitFaceControlId,
  FaceControlSection,
  FaceControlSpec
} from '$lib/goons/faceControls'
import {
  ARKIT_52_CHANNEL_ORDER,
  AUDIO2FACE_16_TONGUE_CHANNEL_ORDER,
  OVR_15_VISEME_ORDER,
  type Arkit52Channel
} from '$lib/goons/speechFaceProfiles'
import type { CustomMouthPresetSupport } from '$lib/goons/customCompatibility'
import type { CustomMorphDefinition } from '$lib/goons/customMorphs'
import type { GoonExpressionPreset } from '$lib/types/goons'

export const UNIVERSAL_FACE_SECTION_ORDER = [
  'eyes',
  'brows',
  'cheeks-nose',
  'jaw',
  'mouth',
  'tongue',
  'visemes',
  'head-movement',
  'custom-morphs'
] as const

export type UniversalFaceSectionId = (typeof UNIVERSAL_FACE_SECTION_ORDER)[number]
export type UniversalFaceControlStorage =
  | 'face-control'
  | 'expression-preset'
  | 'arkit-channel'
  | 'raw-morph'

export type UniversalFaceControlDefinition = {
  id: string
  label: string
  searchText: string
  storage: UniversalFaceControlStorage
  faceControlId?: BatshitFaceControlId
  expressionPreset?: GoonExpressionPreset
  arkitChannel?: Arkit52Channel
  morphTargets?: string[]
  min: number
  max: number
  step: number
  bipolar: boolean
  negativeLabel: string
  positiveLabel: string
  lockGroup?: string
}

export type UniversalFaceControlSection = {
  id: UniversalFaceSectionId
  label: string
  controls: UniversalFaceControlDefinition[]
}

export type UniversalFaceControlModel = {
  sections: UniversalFaceControlSection[]
  managedRawMorphTargetNames: string[]
}

export type UniversalFaceControlModelInput = {
  arkitDefinitions?: CustomMorphDefinition[]
  tongueDefinitions?: CustomMorphDefinition[]
  customMorphDefinitions?: CustomMorphDefinition[]
  mouthPresetSupport?: CustomMouthPresetSupport | null
  classicSections?: FaceControlSection[]
}

const SECTION_LABELS: Record<UniversalFaceSectionId, string> = {
  eyes: 'Eyes',
  brows: 'Brows',
  'cheeks-nose': 'Cheeks & Nose',
  jaw: 'Jaw',
  mouth: 'Mouth',
  tongue: 'Tongue',
  visemes: 'Visemes',
  'head-movement': 'Head Movement',
  'custom-morphs': 'Custom Morphs'
}

const CANONICAL_ARKIT_RAW_TARGET_NAMES = new Set<string>(ARKIT_52_CHANNEL_ORDER)

const OVR_VISEME_LABELS: Record<string, string> = {
  PP: 'P / B / M',
  FF: 'F / V',
  TH: 'TH',
  DD: 'T / D',
  kk: 'K / G',
  CH: 'CH / J / SH',
  SS: 'S / Z',
  nn: 'N / L',
  RR: 'R',
  aa: 'AA / AH',
  E: 'EH',
  I: 'IH / Y',
  O: 'OH',
  U: 'OO'
}

const RHUBARB_VISEME_LABELS: Record<string, string> = {
  closed: 'Closed',
  clenched: 'Clenched',
  mid_open: 'Mid Open',
  wide_open: 'Wide Open',
  round: 'Round',
  pucker: 'Pucker',
  teeth_lip: 'Teeth & Lip',
  tongue_lift: 'Tongue Lift'
}

const VRM_VOWEL_LABELS: Record<string, string> = {
  aa: 'A',
  ih: 'I',
  ou: 'U',
  ee: 'E',
  oh: 'O'
}

function splitCamelCase(value: string): string {
  return value
    .replace(/^viseme[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(' ')
}

function sideAwareLabel(value: string, prefix: string): string {
  const withoutPrefix = value.startsWith(prefix) ? value.slice(prefix.length) : value
  const side = withoutPrefix.endsWith('Left')
    ? 'Left'
    : withoutPrefix.endsWith('Right')
      ? 'Right'
      : ''
  const action = side ? withoutPrefix.slice(0, -side.length) : withoutPrefix
  const label = titleCase(splitCamelCase(action))
  return side ? `${label}, ${side}` : label
}

export function formatArkitFaceControlLabel(channel: Arkit52Channel): string {
  if (channel.startsWith('eye')) return sideAwareLabel(channel, 'eye')
  if (channel.startsWith('brow')) return sideAwareLabel(channel, 'brow')
  if (channel.startsWith('cheek')) return sideAwareLabel(channel, 'cheek')
  if (channel.startsWith('nose')) return sideAwareLabel(channel, 'nose')
  if (channel.startsWith('jaw')) return sideAwareLabel(channel, 'jaw')
  if (channel.startsWith('mouth')) return sideAwareLabel(channel, 'mouth')
  if (channel.startsWith('tongue')) return sideAwareLabel(channel, 'tongue')
  return titleCase(splitCamelCase(channel))
}

function sectionForArkitChannel(channel: Arkit52Channel): UniversalFaceSectionId {
  if (channel.startsWith('eye')) return 'eyes'
  if (channel.startsWith('brow')) return 'brows'
  if (channel.startsWith('cheek') || channel.startsWith('nose')) return 'cheeks-nose'
  if (channel.startsWith('jaw')) return 'jaw'
  if (channel.startsWith('mouth')) return 'mouth'
  return 'tongue'
}

function rawControl(
  id: string,
  label: string,
  morphTargets: string[],
  searchText = ''
): UniversalFaceControlDefinition {
  return {
    id,
    label,
    searchText: `${id} ${label} ${searchText}`.trim(),
    storage: 'raw-morph',
    morphTargets: [...new Set(morphTargets)].sort((left, right) => left.localeCompare(right)),
    min: 0,
    max: 1,
    step: 0.01,
    bipolar: false,
    negativeLabel: 'Neutral',
    positiveLabel: 'Full'
  }
}

function arkitControl(
  channel: Arkit52Channel,
  morphTargets: string[]
): UniversalFaceControlDefinition {
  return {
    id: `arkit:${channel}`,
    label: formatArkitFaceControlLabel(channel),
    searchText: `${channel} ${formatArkitFaceControlLabel(channel)} ARKit`,
    storage: 'arkit-channel',
    arkitChannel: channel,
    morphTargets: [...new Set(morphTargets)].sort((left, right) => left.localeCompare(right)),
    min: 0,
    max: 1,
    step: 0.01,
    bipolar: false,
    negativeLabel: 'Neutral',
    positiveLabel: 'Full'
  }
}

function expressionControl(
  preset: GoonExpressionPreset,
  label: string
): UniversalFaceControlDefinition {
  return {
    id: `expression:${preset}`,
    label,
    searchText: `${preset} ${label}`,
    storage: 'expression-preset',
    expressionPreset: preset,
    min: 0,
    max: 1,
    step: 0.01,
    bipolar: false,
    negativeLabel: 'Neutral',
    positiveLabel: 'Full'
  }
}

function classicControl(spec: FaceControlSpec): UniversalFaceControlDefinition {
  return {
    id: `face-control:${spec.id}`,
    label: spec.label,
    searchText: `${spec.id} ${spec.label} ${spec.region}`,
    storage: 'face-control',
    faceControlId: spec.id,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    bipolar: spec.bipolar,
    negativeLabel: spec.negativeLabel ?? (spec.bipolar ? 'Negative' : 'Neutral'),
    positiveLabel: spec.positiveLabel ?? 'Full',
    lockGroup: spec.lockGroup
  }
}

function classicSectionId(section: FaceControlSection): UniversalFaceSectionId {
  if (section.id === 'eyes') return 'eyes'
  if (section.id === 'brows') return 'brows'
  if (section.id === 'mouth') return 'mouth'
  return 'head-movement'
}

function normalizedTargets(targets: string[]): string[] {
  return [...new Set(targets.map((target) => target.trim()).filter(Boolean))]
}

function findRawOvrDefinitions(definitions: CustomMorphDefinition[]) {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))
  const movingChannels = OVR_15_VISEME_ORDER.filter((channel) => channel !== 'sil')
  const resolved = movingChannels.map((channel) => {
    const definition = byId.get(`viseme_${channel}`) ?? byId.get(channel)
    return definition ? { channel, definition } : null
  })
  return resolved.every(Boolean)
    ? resolved.filter((entry): entry is NonNullable<(typeof resolved)[number]> => Boolean(entry))
    : []
}

function visemeLabel(preset: string, profile?: CustomMouthPresetSupport['profile']): string {
  if (profile === 'vrm-vowels-5') {
    return VRM_VOWEL_LABELS[preset] ?? titleCase(splitCamelCase(preset))
  }
  if (profile === 'rhubarb-9') {
    return RHUBARB_VISEME_LABELS[preset] ?? titleCase(splitCamelCase(preset))
  }
  return OVR_VISEME_LABELS[preset]
    ?? VRM_VOWEL_LABELS[preset]
    ?? RHUBARB_VISEME_LABELS[preset]
    ?? titleCase(splitCamelCase(preset))
}

export function buildUniversalFaceControlModel(
  input: UniversalFaceControlModelInput
): UniversalFaceControlModel {
  const sections = new Map<UniversalFaceSectionId, UniversalFaceControlDefinition[]>()
  const managedTargets = new Set<string>()
  const managedDefinitionIds = new Set<string>()
  const append = (sectionId: UniversalFaceSectionId, control: UniversalFaceControlDefinition) => {
    const current = sections.get(sectionId) ?? []
    current.push(control)
    sections.set(sectionId, current)
    for (const target of control.morphTargets ?? []) managedTargets.add(target)
  }

  const arkitDefinitions = input.arkitDefinitions ?? []
  const tongueDefinitions = input.tongueDefinitions ?? []
  const customDefinitions = input.customMorphDefinitions ?? []
  const richArkit = arkitDefinitions.length === ARKIT_52_CHANNEL_ORDER.length

  if (richArkit) {
    const arkitById = new Map(arkitDefinitions.map((definition) => [definition.id, definition]))
    for (const channel of ARKIT_52_CHANNEL_ORDER) {
      const definition = arkitById.get(channel)
      if (!definition) continue
      managedDefinitionIds.add(definition.id)
      append(
        sectionForArkitChannel(channel),
        arkitControl(channel, definition.morphTargets)
      )
    }

    const tongueById = new Map(tongueDefinitions.map((definition) => [definition.id, definition]))
    for (const channel of AUDIO2FACE_16_TONGUE_CHANNEL_ORDER) {
      const definition = tongueById.get(channel)
      if (!definition) continue
      managedDefinitionIds.add(definition.id)
      append(
        'tongue',
        rawControl(
          `tongue:${channel}`,
          titleCase(splitCamelCase(channel.replace(/^tongue/, ''))),
          definition.morphTargets,
          'Audio2Face tongue'
        )
      )
    }
  }

  for (const classicSection of input.classicSections ?? []) {
    const sectionId = classicSectionId(classicSection)
    if (richArkit && sectionId !== 'head-movement') continue
    for (const spec of classicSection.specs) append(sectionId, classicControl(spec))
  }

  const rawOvrDefinitions = findRawOvrDefinitions(customDefinitions)
  if (rawOvrDefinitions.length > 0) {
    for (const { channel, definition } of rawOvrDefinitions) {
      managedDefinitionIds.add(definition.id)
      append(
        'visemes',
        rawControl(`viseme:${channel}`, visemeLabel(channel, 'ovr-15'), definition.morphTargets, `OVR ${channel}`)
      )
    }
  } else {
    for (const preset of input.mouthPresetSupport?.availablePresets ?? []) {
      if (preset === 'sil' || preset === 'rest' || preset === 'neutral') continue
      append(
        'visemes',
        expressionControl(preset, visemeLabel(preset, input.mouthPresetSupport?.profile))
      )
    }
  }

  for (const definition of customDefinitions) {
    const targets = normalizedTargets(definition.morphTargets)
    if (
      targets.length === 0 ||
      managedDefinitionIds.has(definition.id) ||
      targets.some(
        (target) =>
          managedTargets.has(target) || CANONICAL_ARKIT_RAW_TARGET_NAMES.has(target)
      )
    ) continue
    append(
      'custom-morphs',
      rawControl(`custom:${definition.id}`, titleCase(splitCamelCase(definition.id)), targets, 'package extra')
    )
  }

  return {
    sections: UNIVERSAL_FACE_SECTION_ORDER.flatMap((sectionId) => {
      const controls = sections.get(sectionId) ?? []
      return controls.length > 0
        ? [{ id: sectionId, label: SECTION_LABELS[sectionId], controls }]
        : []
    }),
    // Canonical ARKit names are reserved even when a review/legacy package
    // declares only a partial channel map. Cue normalization rejects those
    // names from raw-morph payloads, so exposing them as Custom Morphs would
    // create sliders that can save a value but can never drive the Goon.
    managedRawMorphTargetNames: [
      ...new Set([...managedTargets, ...CANONICAL_ARKIT_RAW_TARGET_NAMES])
    ].sort((left, right) => left.localeCompare(right))
  }
}
