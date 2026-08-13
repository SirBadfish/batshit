import { buildGuidedPieceOriginalClosetSlot } from '$lib/goons/concealRegions'
import { applyClosetSelectionChange } from '$lib/goons/closetAssignments'
import {
  buildClosetSlotNames,
  getDefaultClosetSlotLabel,
  isSkinOverlayClosetSlotKey
} from '$lib/goons/closetMaterials'
import { isGuidedCustomVrmGoon } from '$lib/goons/customAvatar'
import {
  buildGuidedOutfitPieceStates,
  listStandaloneGuidedOutfitPieces,
  resolveGuidedOutfitManagedSlotName,
  resolveGuidedOutfitPieceVisible
} from '$lib/goons/guidedOutfits'
import { countPaintedConcealTriangles } from '$lib/goons/paintedConcealMasks'
import { resolveGoonCues } from '$lib/goons/resolve'
import {
  ALL_ORIGINAL_WARDROBE_OUTFIT_ID,
  NO_WARDROBE_OUTFIT_ID,
  cloneWardrobeGuidedPieceStates,
  cloneWardrobeOutfitAssignments,
  sanitizeWardrobeOutfits
} from '$lib/goons/wardrobeOutfits'
import type {
  GoonClosetAssignment,
  GoonClosetItem,
  GoonDefaults,
  GoonGuidedOutfitPiece,
  GoonRecord,
  GoonWardrobeOutfit,
  GoonsSettings
} from '$lib/types/goons'

export const GOON_QUICK_CONTROLS_SCHEMA_VERSION = 'goon-quick-controls/v1' as const

export const GOON_QUICK_CONTROL_QUALITY_OPTIONS = Object.freeze([
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' }
] satisfies Array<{ value: NonNullable<GoonDefaults['quality']>; label: string }>)

export type GoonQuickControlRuntimeContext = {
  materialNames: string[]
  eyeContactEnabled: boolean
}

export type GoonQuickControlClosetAction =
  | { kind: 'outfit'; outfitId: string }
  | { kind: 'slot'; slotName: string; value: string }
  | { kind: 'guided-piece'; pieceId: string; value: string }

export type GoonQuickControlAction =
  | { kind: 'mood'; cueName: string }
  | { kind: 'quality'; value: NonNullable<GoonDefaults['quality']> }
  | { kind: 'eye-contact'; enabled: boolean }
  | GoonQuickControlClosetAction

function boundedControlString(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > 512 || normalized.includes('\0')) {
    throw new Error(`${label} must be a bounded non-empty string.`)
  }
  return normalized
}

export function normalizeGoonQuickControlAction(value: unknown): GoonQuickControlAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Goon quick-control action must be an object.')
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  const allowedKeys =
    kind === 'mood'
      ? new Set(['kind', 'cueName'])
      : kind === 'quality'
        ? new Set(['kind', 'value'])
        : kind === 'eye-contact'
          ? new Set(['kind', 'enabled'])
        : kind === 'outfit'
          ? new Set(['kind', 'outfitId'])
          : kind === 'slot'
            ? new Set(['kind', 'slotName', 'value'])
            : kind === 'guided-piece'
              ? new Set(['kind', 'pieceId', 'value'])
              : null
  if (!allowedKeys || Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error('Goon quick-control action has an unsupported shape.')
  }
  if (kind === 'mood') {
    return { kind, cueName: boundedControlString(record.cueName, 'Mood name') }
  }
  if (kind === 'quality') {
    const quality = record.value
    if (!GOON_QUICK_CONTROL_QUALITY_OPTIONS.some((option) => option.value === quality)) {
      throw new Error('Goon Quality must be Auto, Low, High, or Ultra.')
    }
    return { kind, value: quality as NonNullable<GoonDefaults['quality']> }
  }
  if (kind === 'eye-contact') {
    if (typeof record.enabled !== 'boolean') {
      throw new Error('Goon Eye Contact state must be boolean.')
    }
    return { kind, enabled: record.enabled }
  }
  if (kind === 'outfit') {
    return { kind, outfitId: boundedControlString(record.outfitId, 'Outfit ID') }
  }
  if (kind === 'slot') {
    return {
      kind,
      slotName: boundedControlString(record.slotName, 'Closet slot'),
      value: boundedControlString(record.value, 'Closet selection')
    }
  }
  return {
    kind: 'guided-piece',
    pieceId: boundedControlString(record.pieceId, 'Closet piece'),
    value: boundedControlString(record.value, 'Closet selection')
  }
}

export type GoonQuickControlClosetOption = {
  key: string
  label: string
  current: boolean
  action: GoonQuickControlClosetAction
}

export type GoonQuickControlClosetGroup = {
  key: string
  label: string
  options: GoonQuickControlClosetOption[]
}

export type GoonQuickControlsProjection = {
  schemaVersion: typeof GOON_QUICK_CONTROLS_SCHEMA_VERSION
  goonId: string
  recordUpdatedAt: string
  mood: {
    currentName: string | null
    currentLabel: string
    options: Array<{ name: string; label: string; current: boolean }>
  }
  closet: {
    available: boolean
    groups: GoonQuickControlClosetGroup[]
  }
  quality: {
    current: NonNullable<GoonDefaults['quality']>
    options: Array<{ value: NonNullable<GoonDefaults['quality']>; label: string }>
  }
  eyeContactEnabled: boolean
}

type QuickControlModel = {
  goon: GoonRecord
  goonsSettings: GoonsSettings | null
  cueMap: ReturnType<typeof resolveGoonCues>['cueMap']
  closetItems: GoonClosetItem[]
  closetItemsById: Map<string, GoonClosetItem>
  wardrobeOutfits: Record<string, GoonWardrobeOutfit>
  wardrobeOutfitList: GoonWardrobeOutfit[]
  closetSlotNames: string[]
  standaloneGuidedPieces: GoonGuidedOutfitPiece[]
}

function uniqueNames(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  )
}

export function normalizeGoonQuickControlRuntimeContext(
  value?: Partial<GoonQuickControlRuntimeContext> | null
): GoonQuickControlRuntimeContext {
  return {
    materialNames: uniqueNames(Array.isArray(value?.materialNames) ? value.materialNames : []),
    eyeContactEnabled: value?.eyeContactEnabled !== false
  }
}

function resolveClosetItem(model: QuickControlModel, itemId?: string | null) {
  if (!itemId) return null
  const localItem = model.goon.closet?.items?.[itemId]
  if (localItem) return localItem
  const globalItem = model.goonsSettings?.globalCloset?.items?.[itemId]
  if (!globalItem) return null
  return (
    Object.values(model.goon.closet?.items ?? {}).find(
      (item) => item.sourceItemId === globalItem.id && !item.originalSource
    ) ?? globalItem
  )
}

function originalSourceMatches(
  source: GoonClosetItem['originalSource'] | null | undefined,
  target: NonNullable<GoonClosetItem['originalSource']>
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

function resolveSavedOriginalClosetItem(
  model: QuickControlModel,
  source: NonNullable<GoonClosetItem['originalSource']>
) {
  return (
    Object.values(model.goon.closet?.items ?? {}).find((item) =>
      originalSourceMatches(item.originalSource, source)
    ) ?? null
  )
}

function isEditedWardrobeItem(item?: GoonClosetItem | null) {
  return Boolean(
    item && (item.materialColors || countPaintedConcealTriangles(item.paintedConcealMask) > 0)
  )
}

function wardrobeItemDisplayName(item: GoonClosetItem) {
  return item.originalSource && isEditedWardrobeItem(item) ? `${item.name} (edited)` : item.name
}

function buildAvailableClosetSlotNames(sourceNames: string[], assignmentNames: string[] = []) {
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

function buildModel(
  goon: GoonRecord,
  goonsSettings: GoonsSettings | null | undefined,
  materialNames: string[]
): QuickControlModel {
  const normalizedSettings = goonsSettings ?? null
  const localItems = (Object.values(goon.closet?.items ?? {}) as GoonClosetItem[]).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  const globalItems = (
    Object.values(normalizedSettings?.globalCloset?.items ?? {}) as GoonClosetItem[]
  ).sort((a, b) => a.name.localeCompare(b.name))
  const closetItems = [...localItems, ...globalItems]
  const partialModel = {
    goon,
    goonsSettings: normalizedSettings,
    cueMap: resolveGoonCues(goon, normalizedSettings).cueMap,
    closetItems,
    closetItemsById: new Map(closetItems.map((item) => [item.id, item])),
    wardrobeOutfits: {},
    wardrobeOutfitList: [],
    closetSlotNames: [],
    standaloneGuidedPieces: []
  } satisfies QuickControlModel
  const wardrobeOutfits = sanitizeWardrobeOutfits(goon.closet?.outfits ?? {}, {
    resolveItem: (itemId) => resolveClosetItem(partialModel, itemId)
  })
  const guidedMaterialNames = (goon.guidedAvatar?.outfitPieces ?? []).flatMap(
    (piece) => piece.materialNames ?? []
  )
  const closetSlotNames = buildAvailableClosetSlotNames(
    uniqueNames([...materialNames, ...guidedMaterialNames]),
    Object.keys(goon.closetAssignments ?? {})
  )
  const standaloneGuidedPieces = listStandaloneGuidedOutfitPieces(
    goon.guidedAvatar?.outfitPieces ?? [],
    closetSlotNames
  ).sort((left, right) => guidedPieceLabel(left).localeCompare(guidedPieceLabel(right)))
  return {
    ...partialModel,
    wardrobeOutfits,
    wardrobeOutfitList: Object.values(wardrobeOutfits).sort((a, b) => a.name.localeCompare(b.name)),
    closetSlotNames,
    standaloneGuidedPieces
  }
}

function resolveGuidedPiecesForSlot(model: QuickControlModel, slotName: string) {
  return (model.goon.guidedAvatar?.outfitPieces ?? []).filter(
    (piece) =>
      piece.source !== 'duf-overlay' &&
      resolveGuidedOutfitManagedSlotName(piece, model.closetSlotNames) === slotName
  )
}

function resolveGuidedPieceVisible(
  model: QuickControlModel,
  piece: GoonGuidedOutfitPiece,
  assignments: Record<string, GoonClosetAssignment> = model.goon.closetAssignments ?? {}
) {
  return resolveGuidedOutfitPieceVisible(piece, {
    availableSlotNames: model.closetSlotNames,
    pieceStates: model.goon.guidedAvatar?.pieceStates ?? {},
    assignments
  })
}

function getGuidedSlotOriginalState(model: QuickControlModel, slotName: string) {
  const pieces = resolveGuidedPiecesForSlot(model, slotName)
  return pieces.length === 0 || pieces.every((piece) => resolveGuidedPieceVisible(model, piece))
}

function editedOriginalForSlot(model: QuickControlModel, slotName: string) {
  const item = resolveSavedOriginalClosetItem(model, { kind: 'slot-original', slotName })
  return isEditedWardrobeItem(item) ? item : null
}

function editedOriginalForGuidedPiece(model: QuickControlModel, pieceId: string) {
  const item = resolveSavedOriginalClosetItem(model, {
    kind: 'guided-piece-original',
    pieceId
  })
  return isEditedWardrobeItem(item) ? item : null
}

function buildSlotWorkingAssignment(model: QuickControlModel, slotName: string) {
  const assignment =
    model.goon.closetAssignments?.[slotName] ??
    ({ mode: 'original' } satisfies GoonClosetAssignment)
  if (assignment.mode === 'original') {
    const editedOriginal = editedOriginalForSlot(model, slotName)
    if (editedOriginal) {
      return {
        mode: 'item',
        itemId: editedOriginal.id,
        label: assignment.label
      } satisfies GoonClosetAssignment
    }
  }
  return assignment
}

function getSlotValue(model: QuickControlModel, slotName: string) {
  const assignment = buildSlotWorkingAssignment(model, slotName)
  if (assignment.mode === 'item' && assignment.itemId) {
    return resolveClosetItem(model, assignment.itemId)?.id ?? assignment.itemId
  }
  if (assignment.mode === 'none') return '__none__'
  return getGuidedSlotOriginalState(model, slotName) ? '__original__' : '__none__'
}

function getSlotSelectionLabel(model: QuickControlModel, slotName: string) {
  const assignment = buildSlotWorkingAssignment(model, slotName)
  if (assignment.mode === 'none') return 'None'
  if (assignment.mode === 'item' && assignment.itemId) {
    const item = resolveClosetItem(model, assignment.itemId) ?? model.closetItemsById.get(assignment.itemId)
    return item ? wardrobeItemDisplayName(item) : 'Custom'
  }
  return getGuidedSlotOriginalState(model, slotName) ? 'Original' : 'None'
}

function getItemsForSlot(model: QuickControlModel, slotName: string) {
  const availableItems = model.closetItems.filter((item) => {
    if (item.originalSource?.kind === 'guided-piece-original') return false
    if (item.originalSource?.kind === 'slot-original') {
      return item.originalSource.slotName === slotName
    }
    return true
  })
  const currentValue = getSlotValue(model, slotName)
  const currentItem = currentValue.startsWith('__')
    ? null
    : resolveClosetItem(model, currentValue) ?? model.closetItemsById.get(currentValue)
  if (!currentItem || availableItems.some((item) => item.id === currentItem.id)) {
    return availableItems
  }
  return [currentItem, ...availableItems].sort((left, right) => left.name.localeCompare(right.name))
}

function guidedPieceLabel(piece: GoonGuidedOutfitPiece) {
  return piece.label?.trim() || 'Blender Outfit Slot'
}

function guidedPieceSelectedItem(model: QuickControlModel, piece: GoonGuidedOutfitPiece) {
  const assignment =
    model.goon.closetAssignments?.[buildGuidedPieceOriginalClosetSlot(piece.id)]
  if (assignment?.mode !== 'item') return null
  const item = resolveClosetItem(model, assignment.itemId)
  if (
    !item ||
    item.originalSource?.kind !== 'guided-piece-original' ||
    item.originalSource.pieceId !== piece.id
  ) {
    return null
  }
  return item
}

function getGuidedPieceValue(model: QuickControlModel, piece: GoonGuidedOutfitPiece) {
  const selectedItem = guidedPieceSelectedItem(model, piece)
  if (selectedItem) return selectedItem.id
  const editedOriginal = editedOriginalForGuidedPiece(model, piece.id)
  if (editedOriginal && resolveGuidedPieceVisible(model, piece)) return editedOriginal.id
  return resolveGuidedPieceVisible(model, piece) ? '__original__' : '__none__'
}

function getGuidedPieceItems(model: QuickControlModel, piece: GoonGuidedOutfitPiece) {
  return model.closetItems
    .filter(
      (item) =>
        item.originalSource?.kind === 'guided-piece-original' &&
        item.originalSource.pieceId === piece.id
    )
    .sort((left, right) => left.name.localeCompare(right.name))
}

function getGuidedPieceSelectionLabel(
  model: QuickControlModel,
  piece: GoonGuidedOutfitPiece,
  value = getGuidedPieceValue(model, piece)
) {
  if (value === '__none__') return 'None'
  if (value === '__original__') return 'Original'
  const item = resolveClosetItem(model, value)
  return item ? wardrobeItemDisplayName(item) : 'Edited Original'
}

function buildClosetGroups(model: QuickControlModel): GoonQuickControlClosetGroup[] {
  const groups: GoonQuickControlClosetGroup[] = []
  const closetAvailable =
    model.closetSlotNames.length > 0 || model.standaloneGuidedPieces.length > 0
  if (closetAvailable) {
    groups.push({
      key: 'closet',
      label: 'Closet',
      options: [
        {
          key: `outfit:${ALL_ORIGINAL_WARDROBE_OUTFIT_ID}`,
          label: 'All Original',
          current: false,
          action: { kind: 'outfit', outfitId: ALL_ORIGINAL_WARDROBE_OUTFIT_ID }
        },
        {
          key: `outfit:${NO_WARDROBE_OUTFIT_ID}`,
          label: 'None',
          current: false,
          action: { kind: 'outfit', outfitId: NO_WARDROBE_OUTFIT_ID }
        }
      ]
    })
  }
  if (model.wardrobeOutfitList.length > 0) {
    groups.push({
      key: 'saved-outfits',
      label: 'Saved Outfits',
      options: model.wardrobeOutfitList.map((outfit) => ({
        key: `outfit:${outfit.id}`,
        label: outfit.name,
        current: model.goon.defaults?.closetOutfitId === outfit.id,
        action: { kind: 'outfit', outfitId: outfit.id }
      }))
    })
  }
  for (const slotName of model.closetSlotNames) {
    const currentValue = getSlotValue(model, slotName)
    const options: GoonQuickControlClosetOption[] = []
    if (!editedOriginalForSlot(model, slotName)) {
      options.push({
        key: `slot:${slotName}:__original__`,
        label: 'Original',
        current: currentValue === '__original__',
        action: { kind: 'slot', slotName, value: '__original__' }
      })
    }
    options.push({
      key: `slot:${slotName}:__none__`,
      label: 'None',
      current: currentValue === '__none__',
      action: { kind: 'slot', slotName, value: '__none__' }
    })
    for (const item of getItemsForSlot(model, slotName)) {
      options.push({
        key: `slot:${slotName}:${item.id}`,
        label: wardrobeItemDisplayName(item),
        current: currentValue === item.id,
        action: { kind: 'slot', slotName, value: item.id }
      })
    }
    const nickname =
      model.goon.closetAssignments?.[slotName]?.label?.trim() ||
      getDefaultClosetSlotLabel(slotName)
    groups.push({
      key: `slot:${slotName}`,
      label: `${nickname} — ${getSlotSelectionLabel(model, slotName)}`,
      options
    })
  }
  for (const piece of model.standaloneGuidedPieces) {
    const currentValue = getGuidedPieceValue(model, piece)
    const options: GoonQuickControlClosetOption[] = []
    if (!editedOriginalForGuidedPiece(model, piece.id)) {
      options.push({
        key: `guided-piece:${piece.id}:__original__`,
        label: 'Original',
        current: currentValue === '__original__',
        action: { kind: 'guided-piece', pieceId: piece.id, value: '__original__' }
      })
    }
    options.push({
      key: `guided-piece:${piece.id}:__none__`,
      label: 'None',
      current: currentValue === '__none__',
      action: { kind: 'guided-piece', pieceId: piece.id, value: '__none__' }
    })
    for (const item of getGuidedPieceItems(model, piece)) {
      options.push({
        key: `guided-piece:${piece.id}:${item.id}`,
        label: wardrobeItemDisplayName(item),
        current: currentValue === item.id,
        action: { kind: 'guided-piece', pieceId: piece.id, value: item.id }
      })
    }
    groups.push({
      key: `guided-piece:${piece.id}`,
      label: `${guidedPieceLabel(piece)} — ${getGuidedPieceSelectionLabel(model, piece, currentValue)}`,
      options
    })
  }
  return groups
}

export function buildGoonQuickControlsProjection(
  goon: GoonRecord | null | undefined,
  goonsSettings: GoonsSettings | null | undefined,
  runtimeContext?: Partial<GoonQuickControlRuntimeContext> | null
): GoonQuickControlsProjection | null {
  if (!goon) return null
  const context = normalizeGoonQuickControlRuntimeContext(runtimeContext)
  const model = buildModel(goon, goonsSettings, context.materialNames)
  const currentMood = goon.defaults?.baseLoop ?? null
  const moodOptions = Object.values(model.cueMap)
    .filter((cue) => cue.kind === 'mood')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cue) => ({
      name: cue.name,
      label: cue.name,
      current: currentMood === cue.name
    }))
  const closetGroups = buildClosetGroups(model)
  return {
    schemaVersion: GOON_QUICK_CONTROLS_SCHEMA_VERSION,
    goonId: goon.id,
    recordUpdatedAt: goon.updated_at,
    mood: {
      currentName: currentMood,
      currentLabel: currentMood ? model.cueMap[currentMood]?.name ?? currentMood : 'No mood',
      options: moodOptions
    },
    closet: {
      available: closetGroups.some((group) => group.options.length > 0),
      groups: closetGroups
    },
    quality: {
      current: goon.defaults?.quality ?? 'auto',
      options: GOON_QUICK_CONTROL_QUALITY_OPTIONS.map((option) => ({ ...option }))
    },
    eyeContactEnabled: context.eyeContactEnabled
  }
}

function buildGuidedAvatarForAssignments(
  model: QuickControlModel,
  nextAssignments: Record<string, GoonClosetAssignment>,
  options: { pieceStates?: Record<string, boolean>; clearActivePreset?: boolean } = {}
) {
  if (!isGuidedCustomVrmGoon(model.goon) || !model.goon.guidedAvatar) return undefined
  const pieces = model.goon.guidedAvatar.outfitPieces ?? []
  return {
    ...model.goon.guidedAvatar,
    pieceStates: buildGuidedOutfitPieceStates(pieces, {
      availableSlotNames: model.closetSlotNames,
      pieceStates: options.pieceStates ?? model.goon.guidedAvatar.pieceStates ?? {},
      assignments: nextAssignments
    }),
    activePresetId: options.clearActivePreset
      ? null
      : model.goon.guidedAvatar.activePresetId ?? null
  }
}

function clearWardrobeOutfitDefault(goon: GoonRecord) {
  const nextDefaults = { ...(goon.defaults ?? {}) }
  delete (nextDefaults as Record<string, unknown>).closetOutfitId
  return nextDefaults
}

function buildWardrobeAssignmentKeys(model: QuickControlModel) {
  const keys = new Set(model.closetSlotNames)
  for (const piece of model.standaloneGuidedPieces) {
    keys.add(buildGuidedPieceOriginalClosetSlot(piece.id))
  }
  return keys
}

function buildBuiltInWardrobeOutfit(model: QuickControlModel, outfitId: string) {
  if (
    outfitId !== ALL_ORIGINAL_WARDROBE_OUTFIT_ID &&
    outfitId !== NO_WARDROBE_OUTFIT_ID
  ) {
    return null
  }
  if (model.closetSlotNames.length === 0 && model.standaloneGuidedPieces.length === 0) {
    throw new Error('The active Goon has no Closet slots to update.')
  }
  const mode = outfitId === NO_WARDROBE_OUTFIT_ID ? 'none' : 'original'
  const assignments: Record<string, GoonClosetAssignment> = {}
  for (const slotName of model.closetSlotNames) {
    const label = model.goon.closetAssignments?.[slotName]?.label?.trim()
    assignments[slotName] = { mode, ...(label ? { label } : {}) }
  }
  return {
    assignments,
    guidedPieceStates: Object.fromEntries(
      model.standaloneGuidedPieces.map((piece) => [
        piece.id,
        outfitId === ALL_ORIGINAL_WARDROBE_OUTFIT_ID
      ])
    )
  } satisfies Pick<GoonWardrobeOutfit, 'assignments' | 'guidedPieceStates'>
}

function buildWardrobeOutfitPatch(
  model: QuickControlModel,
  outfit: Pick<GoonWardrobeOutfit, 'assignments' | 'guidedPieceStates'>,
  activeOutfitId: string | null
) {
  const outfitAssignments = cloneWardrobeOutfitAssignments(outfit.assignments)
  const nextAssignments = { ...(model.goon.closetAssignments ?? {}) }
  for (const key of buildWardrobeAssignmentKeys(model)) delete nextAssignments[key]
  for (const [slotName, assignment] of Object.entries(outfitAssignments)) {
    if (assignment.mode === 'item' && !resolveClosetItem(model, assignment.itemId)) {
      nextAssignments[slotName] = {
        mode: 'original',
        ...(assignment.label?.trim() ? { label: assignment.label.trim() } : {})
      }
      continue
    }
    if (assignment.mode === 'original' && !assignment.label) continue
    nextAssignments[slotName] = assignment
  }
  const guidedAvatar = buildGuidedAvatarForAssignments(model, nextAssignments, {
    pieceStates: {
      ...(model.goon.guidedAvatar?.pieceStates ?? {}),
      ...cloneWardrobeGuidedPieceStates(outfit.guidedPieceStates)
    },
    clearActivePreset: true
  })
  const defaults = clearWardrobeOutfitDefault(model.goon)
  if (activeOutfitId && model.wardrobeOutfits[activeOutfitId]) {
    defaults.closetOutfitId = activeOutfitId
  }
  return {
    closetAssignments: nextAssignments,
    defaults,
    ...(guidedAvatar ? { guidedAvatar } : {})
  } satisfies Partial<GoonRecord>
}

function buildSlotPatch(model: QuickControlModel, slotName: string, value: string) {
  if (!model.closetSlotNames.includes(slotName)) {
    throw new Error('The selected Closet slot is no longer available.')
  }
  const projection = buildClosetGroups(model)
    .flatMap((group) => group.options)
    .find(
      (option) =>
        option.action.kind === 'slot' &&
        option.action.slotName === slotName &&
        option.action.value === value
    )
  if (!projection) throw new Error('The selected Closet item is no longer available.')
  const editedOriginal = value === '__original__' ? editedOriginalForSlot(model, slotName) : null
  const nextAssignments = applyClosetSelectionChange(
    model.goon.closetAssignments ?? {},
    slotName,
    (editedOriginal?.id ?? value) as '__original__' | '__none__' | string,
    (itemId) => resolveClosetItem(model, itemId),
    model.closetSlotNames
  )
  const guidedAvatar = buildGuidedAvatarForAssignments(model, nextAssignments, {
    clearActivePreset: resolveGuidedPiecesForSlot(model, slotName).length > 0
  })
  return {
    closetAssignments: nextAssignments,
    defaults: clearWardrobeOutfitDefault(model.goon),
    ...(guidedAvatar ? { guidedAvatar } : {})
  } satisfies Partial<GoonRecord>
}

function buildGuidedPiecePatch(model: QuickControlModel, pieceId: string, value: string) {
  const piece = model.standaloneGuidedPieces.find((entry) => entry.id === pieceId)
  if (!piece) throw new Error('The selected Closet piece is no longer available.')
  const projection = buildClosetGroups(model)
    .flatMap((group) => group.options)
    .find(
      (option) =>
        option.action.kind === 'guided-piece' &&
        option.action.pieceId === pieceId &&
        option.action.value === value
    )
  if (!projection) throw new Error('The selected Closet item is no longer available.')
  const virtualSlotName = buildGuidedPieceOriginalClosetSlot(piece.id)
  const nextAssignments = { ...(model.goon.closetAssignments ?? {}) }
  const nextPieceStates = { ...(model.goon.guidedAvatar?.pieceStates ?? {}) }
  if (value === '__none__') {
    delete nextAssignments[virtualSlotName]
    nextPieceStates[piece.id] = false
  } else if (value === '__original__') {
    const editedOriginal = editedOriginalForGuidedPiece(model, piece.id)
    if (editedOriginal) {
      nextAssignments[virtualSlotName] = { mode: 'item', itemId: editedOriginal.id }
    } else {
      delete nextAssignments[virtualSlotName]
    }
    nextPieceStates[piece.id] = true
  } else {
    const item = resolveClosetItem(model, value)
    if (
      !item ||
      item.originalSource?.kind !== 'guided-piece-original' ||
      item.originalSource.pieceId !== piece.id
    ) {
      throw new Error('The selected Closet item is no longer available.')
    }
    nextAssignments[virtualSlotName] = { mode: 'item', itemId: item.id }
    nextPieceStates[piece.id] = true
  }
  const guidedAvatar = buildGuidedAvatarForAssignments(model, nextAssignments, {
    pieceStates: nextPieceStates,
    clearActivePreset: true
  })
  return {
    closetAssignments: nextAssignments,
    defaults: clearWardrobeOutfitDefault(model.goon),
    ...(guidedAvatar ? { guidedAvatar } : {})
  } satisfies Partial<GoonRecord>
}

export function buildGoonQuickControlPatch(
  goon: GoonRecord,
  goonsSettings: GoonsSettings | null | undefined,
  materialNames: string[],
  action: GoonQuickControlAction
): Partial<GoonRecord> | null {
  const model = buildModel(goon, goonsSettings, materialNames)
  if (action.kind === 'mood') {
    const cue =
      model.cueMap[action.cueName] ??
      Object.values(model.cueMap).find((entry) => entry.name === action.cueName)
    if (!cue || cue.kind !== 'mood') throw new Error('The selected Mood is no longer available.')
    if (goon.defaults?.baseLoop === cue.name) return null
    return { defaults: { ...(goon.defaults ?? {}), baseLoop: cue.name } }
  }
  if (action.kind === 'quality') {
    if (!GOON_QUICK_CONTROL_QUALITY_OPTIONS.some((option) => option.value === action.value)) {
      throw new Error('The selected Quality is invalid.')
    }
    if ((goon.defaults?.quality ?? 'auto') === action.value) return null
    return { defaults: { ...(goon.defaults ?? {}), quality: action.value } }
  }
  if (action.kind === 'eye-contact') return null
  if (action.kind === 'outfit') {
    const builtIn = buildBuiltInWardrobeOutfit(model, action.outfitId)
    if (builtIn) return buildWardrobeOutfitPatch(model, builtIn, action.outfitId)
    const saved = model.wardrobeOutfits[action.outfitId]
    if (!saved) throw new Error('The selected Outfit is no longer available.')
    return buildWardrobeOutfitPatch(model, saved, saved.id)
  }
  if (action.kind === 'slot') return buildSlotPatch(model, action.slotName, action.value)
  return buildGuidedPiecePatch(model, action.pieceId, action.value)
}
