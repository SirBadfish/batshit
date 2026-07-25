import { ARKIT_52_CHANNEL_ORDER, type Arkit52Channel } from '$lib/goons/speechFaceProfiles'
import type {
  GoonArkit52ChannelTarget,
  GoonCueArkit52FaceProfile,
  GoonCueDefinition,
  GoonCueFaceProfiles,
  GoonCuePortableFaceProfile,
  GoonEmoteStep,
  GoonExpressionTarget,
  GoonFaceControl,
  GoonRawMorphTarget
} from '$lib/types/goons'

const ARKIT_CHANNELS = new Set<string>(ARKIT_52_CHANNEL_ORDER)
const HEAD_CONTROLS = new Set(['head_leftright', 'head_updown'])

type CueFaceSource = Pick<
  GoonCueDefinition | GoonEmoteStep,
  'faceProfiles' | 'expressionTargets' | 'faceControls' | 'rawMorphTargets'
>

export type SelectedGoonCueFacePayload = {
  profile: 'portable' | 'arkit52'
  expressionTargets: GoonExpressionTarget[]
  faceControls: GoonFaceControl[]
  rawMorphTargets: GoonRawMorphTarget[]
}

function finiteClamped(value: unknown, min: number, max: number) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.max(min, Math.min(max, numeric))
}

function normalizeExpressionTargets(
  values: readonly GoonExpressionTarget[] | undefined
): GoonExpressionTarget[] | undefined {
  const normalized = (values ?? [])
    .filter((entry) => entry && typeof entry.preset === 'string' && entry.preset.trim())
    .map((entry) => ({
      preset: entry.preset,
      weight: finiteClamped(entry.weight ?? 1, 0, 1)
    }))
  return normalized.length > 0 ? normalized : undefined
}

function normalizeFaceControls(
  values: readonly GoonFaceControl[] | undefined,
  headOnly = false
): GoonFaceControl[] | undefined {
  const byControl = new Map<string, GoonFaceControl>()
  for (const entry of values ?? []) {
    if (!entry || typeof entry.control !== 'string') continue
    if (headOnly && !HEAD_CONTROLS.has(entry.control)) continue
    byControl.set(entry.control, {
      control: entry.control,
      value: finiteClamped(entry.value, -1, 1)
    })
  }
  const normalized = [...byControl.values()].sort((left, right) =>
    left.control.localeCompare(right.control)
  )
  return normalized.length > 0 ? normalized : undefined
}

function normalizePortableFaceProfile(
  value: GoonCuePortableFaceProfile | null | undefined,
  legacy: CueFaceSource
): GoonCuePortableFaceProfile {
  const expressionTargets = normalizeExpressionTargets(
    value?.expressionTargets ?? legacy.expressionTargets
  )
  const faceControls = normalizeFaceControls(value?.faceControls ?? legacy.faceControls)
  return {
    ...(expressionTargets ? { expressionTargets } : {}),
    ...(faceControls ? { faceControls } : {})
  }
}

function normalizeArkit52Channels(
  values: readonly GoonArkit52ChannelTarget[] | undefined
): GoonArkit52ChannelTarget[] | undefined {
  const byChannel = new Map<Arkit52Channel, number>()
  for (const entry of values ?? []) {
    if (!entry || !ARKIT_CHANNELS.has(entry.channel)) continue
    byChannel.set(entry.channel, finiteClamped(entry.value, 0, 1))
  }
  const normalized = ARKIT_52_CHANNEL_ORDER.flatMap((channel) => {
    const value = byChannel.get(channel)
    return value !== undefined && value > 0 ? [{ channel, value }] : []
  })
  return normalized.length > 0 ? normalized : undefined
}

function normalizeArkit52FaceProfile(
  value: GoonCueArkit52FaceProfile | null | undefined
): GoonCueArkit52FaceProfile {
  const channels = normalizeArkit52Channels(value?.channels)
  const headControls = normalizeFaceControls(value?.headControls, true)
  return {
    ...(channels ? { channels } : {}),
    ...(headControls ? { headControls } : {})
  }
}

export function isCanonicalArkit52TargetName(target: string): target is Arkit52Channel {
  return ARKIT_CHANNELS.has(target)
}

/**
 * Clean-break migration:
 * - legacy portable controls become the portable profile;
 * - every legacy Emote gets an explicit neutral ARKit profile so hidden old
 *   controls cannot affect an ARKit-capable Goon;
 * - old canonical ARKit raw targets are discarded and must be re-authored;
 * - unknown raw targets remain package-bound expert controls.
 */
export function normalizeCueFaceSource(
  source: CueFaceSource,
  options: { initializeNeutralArkit52: boolean }
): {
  faceProfiles: GoonCueFaceProfiles
  rawMorphTargets?: GoonRawMorphTarget[]
} {
  const portable = normalizePortableFaceProfile(source.faceProfiles?.portable, source)
  const hasArkit52 =
    Object.prototype.hasOwnProperty.call(source.faceProfiles ?? {}, 'arkit52') ||
    options.initializeNeutralArkit52
  const arkit52 = hasArkit52
    ? normalizeArkit52FaceProfile(source.faceProfiles?.arkit52)
    : undefined
  const rawMorphTargets = (source.rawMorphTargets ?? [])
    .filter((entry) => entry && !isCanonicalArkit52TargetName(entry.target))
    .map((entry) => ({
      target: entry.target.trim(),
      value: finiteClamped(entry.value, 0, 1)
    }))
    .filter((entry) => entry.target)
    .sort((left, right) => left.target.localeCompare(right.target))

  return {
    faceProfiles: {
      portable,
      ...(arkit52 !== undefined ? { arkit52 } : {})
    },
    ...(rawMorphTargets.length > 0 ? { rawMorphTargets } : {})
  }
}

export function hasCueFacePayload(source: CueFaceSource): boolean {
  const normalized = normalizeCueFaceSource(source, { initializeNeutralArkit52: false })
  return Boolean(
    normalized.faceProfiles.portable.expressionTargets?.length ||
    normalized.faceProfiles.portable.faceControls?.length ||
    normalized.faceProfiles.arkit52?.channels?.length ||
    normalized.faceProfiles.arkit52?.headControls?.length ||
    normalized.rawMorphTargets?.length
  )
}

export function selectCueFacePayload(
  source: CueFaceSource,
  options: {
    arkit52Available: boolean
    arkit52Bindings?: ReadonlyMap<Arkit52Channel, readonly string[]> | null
  }
): SelectedGoonCueFacePayload {
  const normalized = normalizeCueFaceSource(source, { initializeNeutralArkit52: false })
  const packageRaw = normalized.rawMorphTargets ?? []
  const arkit = normalized.faceProfiles.arkit52
  if (options.arkit52Available && arkit !== undefined) {
    const projected = new Map<string, number>()
    for (const entry of arkit.channels ?? []) {
      for (const target of options.arkit52Bindings?.get(entry.channel) ?? []) {
        projected.set(target, Math.max(projected.get(target) ?? 0, entry.value))
      }
    }
    return {
      profile: 'arkit52',
      expressionTargets: [],
      faceControls: [...(arkit.headControls ?? [])],
      rawMorphTargets: [
        ...packageRaw,
        ...[...projected].map(([target, value]) => ({ target, value }))
      ]
    }
  }

  return {
    profile: 'portable',
    expressionTargets: [...(normalized.faceProfiles.portable.expressionTargets ?? [])],
    faceControls: [...(normalized.faceProfiles.portable.faceControls ?? [])],
    rawMorphTargets: [...packageRaw]
  }
}

export function prepareCueForPortablePack(
  cue: GoonCueDefinition
): GoonCueDefinition {
  const portable = structuredClone(cue)
  delete portable.rawMorphTargets
  for (const step of portable.steps ?? []) delete step.rawMorphTargets
  return portable
}
