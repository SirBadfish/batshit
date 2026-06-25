import type {
  GoonClosetAssignment,
  GoonClosetItem,
  GoonClosetOriginalSource,
  GoonRecord
} from '$lib/types/goons'
import { normalizePaintedConcealMask } from '$lib/goons/paintedConcealMasks'

export type ClosetPickerItem = GoonClosetItem & {
  pickerSource: 'custom' | 'global'
}

type LegacyConcealRegionItem = GoonClosetItem & {
  concealRegions?: unknown
}

function cloneClosetItem<T extends GoonClosetItem>(item: T): T {
  return JSON.parse(JSON.stringify(item)) as T
}

function sortClosetItems(items: GoonClosetItem[]) {
  return [...items].sort((left, right) => left.name.localeCompare(right.name))
}

function sanitizeStringArray(values: string[] | null | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
}

function sanitizeOriginalSource(
  source?: GoonClosetOriginalSource | null
): GoonClosetOriginalSource | undefined {
  if (!source) return undefined
  if (source.kind === 'slot-original') {
    const slotName = source.slotName?.trim()
    return slotName ? { kind: 'slot-original', slotName } : undefined
  }
  if (source.kind === 'guided-piece-original') {
    const pieceId = source.pieceId?.trim()
    return pieceId ? { kind: 'guided-piece-original', pieceId } : undefined
  }
  return undefined
}

function sanitizeClosetItem(
  item?: GoonClosetItem | null,
  options: { stripPerGoonFields?: boolean } = {}
): GoonClosetItem | undefined {
  if (!item) return undefined

  const cloned = cloneClosetItem(item)
  const id = cloned.id?.trim()
  const name = cloned.name?.trim()
  const category = cloned.category?.trim() || 'other'

  if (!id || !name) return undefined

  cloned.id = id
  cloned.name = name
  cloned.category = category

  const description = cloned.description?.trim()
  if (description) {
    cloned.description = description
  } else {
    delete cloned.description
  }

  const sourceItemId = cloned.sourceItemId?.trim()
  if (sourceItemId) {
    cloned.sourceItemId = sourceItemId
  } else {
    delete cloned.sourceItemId
  }

  const originalSource = sanitizeOriginalSource(cloned.originalSource)
  if (originalSource) {
    cloned.originalSource = originalSource
  } else {
    delete cloned.originalSource
  }

  if (cloned.materialColors && Object.keys(cloned.materialColors).length === 0) {
    delete cloned.materialColors
  }

  delete (cloned as LegacyConcealRegionItem).concealRegions

  const paintedConcealMask = normalizePaintedConcealMask(cloned.paintedConcealMask)
  if (paintedConcealMask) {
    cloned.paintedConcealMask = paintedConcealMask
  } else {
    delete cloned.paintedConcealMask
  }

  const tags = sanitizeStringArray(cloned.tags)
  if (tags.length > 0) {
    cloned.tags = tags
  } else {
    delete cloned.tags
  }

  if (options.stripPerGoonFields) {
    delete cloned.sourceItemId
    delete cloned.originalSource
    delete cloned.materialColors
    delete (cloned as LegacyConcealRegionItem).concealRegions
    delete cloned.paintedConcealMask
  }

  return cloned
}

function buildCustomClosetItemId() {
  return `goon_closet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function restoreAssignmentAfterRemoval(
  assignment?: GoonClosetAssignment
): GoonClosetAssignment | undefined {
  const label = assignment?.label?.trim()
  if (!label) return undefined
  return {
    mode: 'original',
    label
  }
}

export function createCustomClosetItemFromGlobal(sourceItem: GoonClosetItem) {
  const sanitizedSource = sanitizeClosetItem(sourceItem, { stripPerGoonFields: true })
  if (!sanitizedSource) {
    throw new Error('Global Closet item is missing required data')
  }

  const now = new Date().toISOString()
  return {
    ...sanitizedSource,
    id: buildCustomClosetItemId(),
    sourceItemId: sourceItem.id,
    createdAt: now,
    updatedAt: now
  } satisfies GoonClosetItem
}

export function createCustomClosetItemFromOriginal(args: {
  originalSource: GoonClosetOriginalSource
  name: string
  category?: string
  paintedConcealMask?: GoonClosetItem['paintedConcealMask']
}) {
  const originalSource = sanitizeOriginalSource(args.originalSource)
  const name = args.name.trim()
  if (!originalSource || !name) {
    throw new Error('Original closet item is missing required data')
  }

  const now = new Date().toISOString()
  const item = sanitizeClosetItem({
    id: buildCustomClosetItemId(),
    originalSource,
    name,
    category: args.category?.trim() || 'original',
    paintedConcealMask: args.paintedConcealMask,
    createdAt: now,
    updatedAt: now
  })
  if (!item) {
    throw new Error('Original closet item is missing required data')
  }
  return item
}

export function buildCustomClosetDraft(goon: Pick<GoonRecord, 'closet'> | null | undefined) {
  const items: Record<string, GoonClosetItem> = {}

  for (const [itemId, item] of Object.entries(goon?.closet?.items ?? {})) {
    const sanitized = sanitizeClosetItem({
      ...item,
      id: item.id?.trim() || itemId
    })
    if (!sanitized) continue
    items[sanitized.id] = sanitized
  }

  return { items }
}

export function resolveEnabledCustomClosetItems(items: Record<string, GoonClosetItem> = {}) {
  return sortClosetItems(
    Object.values(items)
      .map((item) => sanitizeClosetItem(item))
      .filter((item): item is GoonClosetItem => Boolean(item))
  )
}

export function buildClosetPickerItems(
  globalItems: Record<string, GoonClosetItem>,
  customItems: Record<string, GoonClosetItem> = {}
): ClosetPickerItem[] {
  const sortedCustomItems = resolveEnabledCustomClosetItems(customItems).map((item) => ({
    ...item,
    pickerSource: 'custom' as const
  }))

  const sortedGlobalItems = sortClosetItems(
    Object.values(globalItems)
      .map((item) => sanitizeClosetItem(item, { stripPerGoonFields: true }))
      .filter((item): item is GoonClosetItem => Boolean(item))
  ).map((item) => ({
    ...item,
    pickerSource: 'global' as const
  }))

  return [...sortedCustomItems, ...sortedGlobalItems]
}

export function buildClosetAssignmentsAfterItemRemoval(
  assignments: Record<string, GoonClosetAssignment>,
  itemId: string
) {
  const nextAssignments: Record<string, GoonClosetAssignment> = {}

  for (const [slotName, assignment] of Object.entries(assignments)) {
    if (assignment.mode !== 'item' || assignment.itemId !== itemId) {
      nextAssignments[slotName] = assignment
      continue
    }

    const restored = restoreAssignmentAfterRemoval(assignment)
    if (restored) {
      nextAssignments[slotName] = restored
    }
  }

  return nextAssignments
}

export function buildGoonRecordCustomClosetCleanup(goon: GoonRecord, itemId: string) {
  const nextAssignments = buildClosetAssignmentsAfterItemRemoval(goon.closetAssignments ?? {}, itemId)
  const currentAssignments = goon.closetAssignments ?? {}
  const assignmentsChanged =
    JSON.stringify(nextAssignments) !== JSON.stringify(currentAssignments)

  if (!assignmentsChanged) {
    return null
  }

  return {
    closetAssignments: nextAssignments
  } satisfies Pick<GoonRecord, 'closetAssignments'>
}
