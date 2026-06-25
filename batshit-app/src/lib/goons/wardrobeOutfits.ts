import type {
  GoonClosetAssignment,
  GoonClosetItem,
  GoonWardrobeOutfit
} from '$lib/types/goons'

export const ALL_ORIGINAL_WARDROBE_OUTFIT_ID = '__all_original__'
export const NO_WARDROBE_OUTFIT_ID = '__none__'

export function buildWardrobeOutfitId() {
  return `wardrobe_outfit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function normalizeWardrobeOutfitName(name?: string | null) {
  return name?.trim().replace(/\s+/g, ' ') ?? ''
}

export function cloneWardrobeOutfitAssignments(
  assignments: Record<string, GoonClosetAssignment> = {}
): Record<string, GoonClosetAssignment> {
  const cloned: Record<string, GoonClosetAssignment> = {}
  for (const [slotName, assignment] of Object.entries(assignments)) {
    const normalizedSlotName = slotName.trim()
    if (!normalizedSlotName) continue
    const label = assignment.label?.trim()
    if (assignment.mode === 'item') {
      const itemId = assignment.itemId?.trim()
      if (!itemId) continue
      cloned[normalizedSlotName] = {
        mode: 'item',
        itemId,
        ...(label ? { label } : {})
      }
      continue
    }
    if (assignment.mode === 'none') {
      cloned[normalizedSlotName] = {
        mode: 'none',
        ...(label ? { label } : {})
      }
      continue
    }
    cloned[normalizedSlotName] = {
      mode: 'original',
      ...(label ? { label } : {})
    }
  }
  return cloned
}

export function cloneWardrobeGuidedPieceStates(states: Record<string, boolean> = {}) {
  return Object.fromEntries(
    Object.entries(states)
      .map(([pieceId, visible]) => [pieceId.trim(), Boolean(visible)] as const)
      .filter(([pieceId]) => Boolean(pieceId))
  )
}

export function sanitizeWardrobeOutfit(
  outfit: GoonWardrobeOutfit,
  options: {
    resolveItem?: (itemId?: string | null) => GoonClosetItem | null
  } = {}
) {
  const id = outfit.id?.trim()
  const name = normalizeWardrobeOutfitName(outfit.name)
  if (!id || !name) return null

  const assignments = cloneWardrobeOutfitAssignments(outfit.assignments)
  for (const [slotName, assignment] of Object.entries(assignments)) {
    if (assignment.mode !== 'item') continue
    if (options.resolveItem?.(assignment.itemId)) continue
    assignments[slotName] = {
      mode: 'original',
      ...(assignment.label?.trim() ? { label: assignment.label.trim() } : {})
    }
  }

  const guidedPieceStates = cloneWardrobeGuidedPieceStates(outfit.guidedPieceStates)

  return {
    id,
    name,
    ...(Object.keys(assignments).length > 0 ? { assignments } : {}),
    ...(Object.keys(guidedPieceStates).length > 0 ? { guidedPieceStates } : {}),
    ...(outfit.createdAt ? { createdAt: outfit.createdAt } : {}),
    ...(outfit.updatedAt ? { updatedAt: outfit.updatedAt } : {})
  } satisfies GoonWardrobeOutfit
}

export function sanitizeWardrobeOutfits(
  outfits: Record<string, GoonWardrobeOutfit> = {},
  options: {
    resolveItem?: (itemId?: string | null) => GoonClosetItem | null
  } = {}
) {
  const sanitized: Record<string, GoonWardrobeOutfit> = {}
  for (const outfit of Object.values(outfits)) {
    const next = sanitizeWardrobeOutfit(outfit, options)
    if (next) {
      sanitized[next.id] = next
    }
  }
  return sanitized
}
