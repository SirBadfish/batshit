import {
  buildGoonAnimationLoadPlan,
  buildGoonAnimationPriorityNames,
  filterGoonAnimationFilesForLane,
  type GoonAnimationLoadPlan
} from '$lib/goons/animationLoadPlan'
import {
  isGuidedCustomVrmGoon,
  loadAvatarIntoEngine,
  resolveGoonKind
} from '$lib/goons/customAvatar'
import { resolveActiveWearableConceal } from '$lib/goons/concealRegions'
import { resolveGuidedOutfitPieceVisible } from '$lib/goons/guidedOutfits'
import { isMountedRecipeLiveGoon } from '$lib/goons/recipe'
import { resolveGoonCues } from '$lib/goons/resolve'
import { applyGoonSceneDefinition, buildGoonSceneSignature } from '$lib/goons/stageScene'
import {
  buildClosetSlotNames,
  isSkinOverlayClosetSlotKey,
  normalizeHexColor,
  resolveClosetRuntimeMaterialName
} from '$lib/goons/closetMaterials'
import type {
  GoonCameraMode,
  GoonClosetItem,
  GoonClosetOriginalSource,
  GoonCueDefinition,
  GoonFileRef,
  GoonPostureMap,
  GoonRecord,
  GoonSceneDefinition,
  GoonXWearData,
  GoonsSettings
} from '$lib/types/goons'
import type { GoonEngine, GoonMountedRuntimeState } from '$lib/goons/engine'

export const MOUNTED_LIVE_GOON_DEFAULT_FOV = 50
export const MOUNTED_LIVE_GOON_MIN_FOV = 15
export const MOUNTED_LIVE_GOON_MAX_FOV = 100

const TRANSPARENT_TEXTURE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='

export type MountedLiveGoonSceneMode = 'saved' | 'none'

export type MountedLiveGoonLoadOptions = {
  goonsSettings?: GoonsSettings | null
  animationFiles?: GoonFileRef[]
  stagePostures?: GoonPostureMap
  sceneMode?: MountedLiveGoonSceneMode
  initialFov?: number
  mountedState?: GoonMountedRuntimeState | null
}

export type MountedLiveGoonLoadPlan = {
  goon: GoonRecord
  goonsSettings: GoonsSettings | null
  kind: 'vrm' | 'custom'
  sceneMode: MountedLiveGoonSceneMode
  scene: GoonSceneDefinition | null
  sceneSignature: string
  stagePostures: GoonPostureMap
  initialFov: number
  viewFov: number
  cameraMode: GoonCameraMode
  baseLoop: string
  baseLoopDefinition?: GoonCueDefinition
  baseLoopSignature: string
  animationPlan: GoonAnimationLoadPlan
  animationSignature: string
  closetSignature: string
  appearanceDialsSignature: string
  facialArtworkSignature: string
  eyeAppearanceSignature: string
  oralAppearanceSignature: string
  mountedState: GoonMountedRuntimeState | null
}

export type MountedLiveGoonLoadResult = {
  kind: 'vrm' | 'custom'
  sceneSignature: string
  baseLoopSignature: string
  animationSignature: string
  closetSignature: string
  animationCatalog: Array<{ name: string; source: 'vrm' | 'goon' | 'vrma' }>
  materialNames: string[]
  appearanceDialsSignature: string
  facialArtworkSignature: string
  eyeAppearanceSignature: string
  oralAppearanceSignature: string
  viewFov: number
  cameraMode: GoonCameraMode
}

export type MountedLiveGoonClosetContext = Pick<
  MountedLiveGoonLoadPlan,
  'goon' | 'goonsSettings'
>

export function clampMountedLiveGoonFov(value: number) {
  return Math.max(MOUNTED_LIVE_GOON_MIN_FOV, Math.min(MOUNTED_LIVE_GOON_MAX_FOV, value))
}

export function buildMountedLiveGoonBaseLoopSignature(
  baseLoop: string,
  definition?: GoonCueDefinition
) {
  const expressionTargets = definition?.expressionTargets
    ? JSON.stringify(definition.expressionTargets)
    : ''
  return [
    baseLoop,
    definition?.animationName ?? '',
    definition?.posture ?? '',
    definition?.kind ?? '',
    definition?.intensity ?? '',
    expressionTargets
  ].join('|')
}

export function buildMountedLiveGoonAnimationPlan(
  goon: GoonRecord | null | undefined,
  animationFiles: GoonFileRef[] = [],
  goonsSettings?: GoonsSettings | null
) {
  const lane = resolveGoonKind(goon) === 'custom' ? 'glb' : 'vrm'
  const libraryFiles = filterGoonAnimationFilesForLane(animationFiles, lane)
  const { cueMap } = resolveGoonCues(goon, goonsSettings)
  const baseLoop = goon?.defaults?.baseLoop ?? 'base_stand'
  const baseLoopAnimation = cueMap?.[baseLoop]?.animationName ?? baseLoop
  return buildGoonAnimationLoadPlan(libraryFiles, [], {
    priorityNames: buildGoonAnimationPriorityNames(baseLoopAnimation)
  })
}

export function buildMountedLiveGoonAnimationSignature(plan: GoonAnimationLoadPlan) {
  const eager = plan.eager.map((file) => file.url).join('|')
  const deferred = plan.deferred.map((file) => file.url).join('|')
  return `${eager}::${deferred}`
}

export function resolveMountedLiveGoonScene(
  goon: GoonRecord | null | undefined,
  goonsSettings?: GoonsSettings | null,
  sceneMode: MountedLiveGoonSceneMode = 'saved'
) {
  if (sceneMode === 'none') return null
  const sceneId = goon?.defaults?.sceneId
  if (!sceneId) return null
  return goonsSettings?.kitchen?.scenes?.[sceneId] ?? null
}

function originalSourceMatches(
  source: GoonClosetItem['originalSource'] | null | undefined,
  target: GoonClosetOriginalSource
) {
  if (!source || source.kind !== target.kind) return false
  if (source.kind === 'slot-original' && target.kind === 'slot-original') {
    return source.slotName === target.slotName
  }
  if (source.kind === 'guided-piece-original' && target.kind === 'guided-piece-original') {
    return source.pieceId === target.pieceId
  }
  return false
}

export function resolveMountedLiveGoonClosetItem(
  goon: GoonRecord | null | undefined,
  itemId?: string | null,
  goonsSettings?: GoonsSettings | null
): GoonClosetItem | null {
  if (!itemId) return null
  const localItem = goon?.closet?.items?.[itemId]
  if (localItem) return localItem
  const globalItem = goonsSettings?.globalCloset?.items?.[itemId]
  if (!globalItem) return null
  return (
    Object.values(goon?.closet?.items ?? {}).find(
      (item) => item.sourceItemId === globalItem.id && !item.originalSource
    ) ?? globalItem
  )
}

export function resolveMountedLiveGoonSavedOriginalClosetItem(
  goon: GoonRecord | null | undefined,
  source: GoonClosetOriginalSource
) {
  return (
    Object.values(goon?.closet?.items ?? {}).find((item) =>
      originalSourceMatches(item.originalSource, source)
    ) ?? null
  )
}

export function buildMountedLiveGoonAvailableClosetSlotNames(
  sourceNames: string[],
  assignmentNames: string[] = []
) {
  const names = new Set<string>()
  for (const name of buildClosetSlotNames(sourceNames)) names.add(name)
  for (const name of sourceNames) {
    if (isSkinOverlayClosetSlotKey(name)) names.add(name)
  }
  for (const name of buildClosetSlotNames(assignmentNames)) names.add(name)
  for (const name of assignmentNames) {
    if (isSkinOverlayClosetSlotKey(name)) names.add(name)
  }
  return Array.from(names).sort((left, right) => left.localeCompare(right))
}

export function buildMountedLiveGoonClosetSignature(
  goon: GoonRecord,
  goonsSettings?: GoonsSettings | null
) {
  const assignments = goon.closetAssignments ?? {}
  const itemMetadata = Object.values(assignments)
    .filter((assignment) => assignment.mode === 'item' && assignment.itemId)
    .map((assignment) => resolveMountedLiveGoonClosetItem(goon, assignment.itemId, goonsSettings))
    .filter(Boolean)
    .map((item) => ({
      id: item?.id,
      updatedAt: item?.updatedAt ?? null,
      paintedConcealMask: item?.paintedConcealMask ?? null
    }))
  return JSON.stringify({
    assignments,
    itemMetadata,
    guidedPieceStates: goon.guidedAvatar?.pieceStates ?? {},
    savedOriginalConceal: Object.values(goon.closet?.items ?? {})
      .filter((item) => item.originalSource)
      .map((item) => ({
        id: item.id,
        updatedAt: item.updatedAt ?? null,
        originalSource: item.originalSource,
        paintedConcealMask: item.paintedConcealMask ?? null
      })),
    guidedPieceIds: (goon.guidedAvatar?.outfitPieces ?? []).map((piece) => piece.id)
  })
}

function applyGuidedOutfitPieceVisibility(
  engine: GoonEngine,
  context: MountedLiveGoonClosetContext
) {
  const { goon } = context
  if (!isGuidedCustomVrmGoon(goon)) return
  const availableSlotNames = buildMountedLiveGoonAvailableClosetSlotNames(
    engine.getMaterialNames(),
    Object.keys(goon.closetAssignments ?? {})
  )
  const assignments = goon.closetAssignments ?? {}
  const pieceStates = goon.guidedAvatar?.pieceStates ?? {}
  for (const piece of goon.guidedAvatar?.outfitPieces ?? []) {
    if (piece.source === 'duf-overlay') continue
    engine.setGuidedOutfitPieceVisible(
      piece.id,
      resolveGuidedOutfitPieceVisible(piece, {
        availableSlotNames,
        pieceStates,
        assignments
      })
    )
  }
}

function resolveAppliedClosetColors(item?: GoonClosetItem | null) {
  return {
    baseHex: normalizeHexColor(item?.materialColors?.baseHex),
    shadeHex: normalizeHexColor(item?.materialColors?.shadeHex)
  }
}

export async function applyMountedLiveGoonClosetAssignments(
  engine: GoonEngine,
  context: MountedLiveGoonClosetContext
) {
  const { goon, goonsSettings } = context
  const assignments = goon.closetAssignments ?? {}
  for (const [materialName, assignment] of Object.entries(assignments)) {
    const runtimeMaterialName =
      resolveClosetRuntimeMaterialName(materialName, engine.getMaterialNames()) ?? null
    if (!runtimeMaterialName) continue

    if (!assignment || assignment.mode === 'original') {
      const colors = resolveAppliedClosetColors()
      if (colors.baseHex || colors.shadeHex) {
        engine.resetMaterialOverrides(runtimeMaterialName)
        engine.applyMaterialColorOverride(runtimeMaterialName, colors)
      }
      continue
    }
    if (assignment.mode === 'none') {
      if (isSkinOverlayClosetSlotKey(materialName)) {
        engine.resetMaterialOverrides(runtimeMaterialName)
        continue
      }
      await engine.applyMaterialTexture(runtimeMaterialName, TRANSPARENT_TEXTURE_URL)
      const colors = resolveAppliedClosetColors()
      if (colors.baseHex || colors.shadeHex) {
        engine.applyMaterialColorOverride(runtimeMaterialName, colors)
      }
      continue
    }
    if (assignment.mode === 'item') {
      const item = resolveMountedLiveGoonClosetItem(goon, assignment.itemId, goonsSettings)
      if (!item) continue
      if (item.xwear) {
        await engine.applyXWearMaterial(runtimeMaterialName, item.xwear as GoonXWearData)
      } else if (item.texture?.url) {
        await engine.applyMaterialTexture(runtimeMaterialName, item.texture.url)
      } else if (item.originalSource) {
        engine.resetMaterialOverrides(runtimeMaterialName)
      }
      const colors = resolveAppliedClosetColors(item)
      if (colors.baseHex || colors.shadeHex) {
        engine.applyMaterialColorOverride(runtimeMaterialName, colors)
      }
    }
  }

  const bodyConceal = resolveActiveWearableConceal({
    closetAssignments: assignments,
    resolveClosetItem: (itemId) =>
      resolveMountedLiveGoonClosetItem(goon, itemId, goonsSettings),
    resolveOriginalSavedItem: (source) =>
      resolveMountedLiveGoonSavedOriginalClosetItem(goon, source),
    guidedOutfitPieces: goon.guidedAvatar?.outfitPieces ?? [],
    guidedPieceStates: goon.guidedAvatar?.pieceStates ?? {}
  })
  engine.applyBodyConceal({ paintedMasks: bodyConceal.paintedMasks })
  applyGuidedOutfitPieceVisibility(engine, context)
}

export function buildMountedLiveGoonLoadPlan(
  goon: GoonRecord,
  options: MountedLiveGoonLoadOptions = {}
): MountedLiveGoonLoadPlan {
  const goonsSettings = options.goonsSettings ?? null
  const sceneMode = options.sceneMode ?? 'saved'
  const scene = resolveMountedLiveGoonScene(goon, goonsSettings, sceneMode)
  const { cueMap } = resolveGoonCues(goon, goonsSettings)
  const baseLoop = goon.defaults?.baseLoop ?? 'base_stand'
  const baseLoopDefinition = cueMap?.[baseLoop]
  const animationPlan = buildMountedLiveGoonAnimationPlan(
    goon,
    options.animationFiles,
    goonsSettings
  )
  const initialFov = clampMountedLiveGoonFov(
    options.initialFov ?? MOUNTED_LIVE_GOON_DEFAULT_FOV
  )
  const viewFov =
    typeof goon.camera?.fov === 'number'
      ? clampMountedLiveGoonFov(goon.camera.fov)
      : initialFov
  const shouldCaptureLegacyAppearance =
    resolveGoonKind(goon) === 'custom' && !isMountedRecipeLiveGoon(goon)

  return {
    goon,
    goonsSettings,
    kind: resolveGoonKind(goon),
    sceneMode,
    scene,
    sceneSignature: buildGoonSceneSignature(scene),
    stagePostures: options.stagePostures ?? {},
    initialFov,
    viewFov,
    cameraMode: goon.camera?.mode ?? 'free',
    baseLoop,
    baseLoopDefinition,
    baseLoopSignature: buildMountedLiveGoonBaseLoopSignature(baseLoop, baseLoopDefinition),
    animationPlan,
    animationSignature: buildMountedLiveGoonAnimationSignature(animationPlan),
    closetSignature:
      resolveGoonKind(goon) === 'vrm'
        ? buildMountedLiveGoonClosetSignature(goon, goonsSettings)
        : '',
    appearanceDialsSignature: shouldCaptureLegacyAppearance
      ? JSON.stringify(goon.appearanceDials ?? null)
      : '',
    facialArtworkSignature: shouldCaptureLegacyAppearance
      ? JSON.stringify(goon.facialArtwork ?? null)
      : '',
    eyeAppearanceSignature: shouldCaptureLegacyAppearance
      ? JSON.stringify(goon.eyeAppearance ?? null)
      : '',
    oralAppearanceSignature: shouldCaptureLegacyAppearance
      ? JSON.stringify(goon.oralAppearance ?? null)
      : '',
    mountedState: options.mountedState ?? null
  }
}

export async function loadMountedLiveGoon(engine: GoonEngine, plan: MountedLiveGoonLoadPlan) {
  await engine.init()
  engine.setCameraFov(plan.initialFov)
  const { kind } = await loadAvatarIntoEngine(engine, plan.goon, { role: 'mounted-live' })

  if (plan.sceneMode === 'saved') {
    await applyGoonSceneDefinition(engine, plan.scene, plan.stagePostures)
  }

  engine.setMood(plan.baseLoop, plan.baseLoopDefinition)
  if (plan.goon.camera) {
    engine.applyCamera(plan.goon.camera)
    engine.setDefaultCamera(plan.goon.camera)
  } else {
    engine.resetCamera()
  }

  const animations = [...plan.animationPlan.eager, ...plan.animationPlan.deferred]
  await engine.syncAnimations(animations)
  if (kind === 'vrm') {
    await applyMountedLiveGoonClosetAssignments(engine, plan)
  }

  if (plan.mountedState) engine.restoreMountedRuntimeState(plan.mountedState)
  engine.setGoonVisible(true)

  return {
    kind,
    sceneSignature: plan.sceneSignature,
    baseLoopSignature: plan.baseLoopSignature,
    animationSignature: plan.animationSignature,
    closetSignature: plan.closetSignature,
    animationCatalog: engine.getAnimationCatalog(),
    materialNames: kind === 'vrm' ? buildClosetSlotNames(engine.getMaterialNames()) : [],
    appearanceDialsSignature: plan.appearanceDialsSignature,
    facialArtworkSignature: plan.facialArtworkSignature,
    eyeAppearanceSignature: plan.eyeAppearanceSignature,
    oralAppearanceSignature: plan.oralAppearanceSignature,
    viewFov: plan.viewFov,
    cameraMode: plan.cameraMode
  } satisfies MountedLiveGoonLoadResult
}
