import type { GoonClosetAssignment, GoonClosetItem } from '$lib/types/goons'
import { getXWearMaterials } from '$lib/utils/xwear'

type ResolveClosetItem = (itemId?: string | null) => GoonClosetItem | null

function buildOriginalAssignment(current?: GoonClosetAssignment): GoonClosetAssignment | undefined {
  if (!current?.label) return undefined
  return {
    mode: 'original',
    label: current.label
  }
}

export function getClosetItemMaterialTargets(item?: GoonClosetItem | null) {
  const targets = new Set<string>()
  for (const material of getXWearMaterials(item?.xwear)) {
    if (material.materialName) {
      targets.add(material.materialName)
    }
  }
  return Array.from(targets)
}

export function applyClosetSelectionChange(
  assignments: Record<string, GoonClosetAssignment>,
  slotName: string,
  nextValue: '__original__' | '__none__' | string,
  resolveClosetItem: ResolveClosetItem,
  _availableSlotNames: string[] = []
) {
  const nextAssignments: Record<string, GoonClosetAssignment> = { ...assignments }
  const currentAssignment = assignments[slotName]

  if (nextValue === '__original__') {
    const original = buildOriginalAssignment(currentAssignment)
    if (original) {
      nextAssignments[slotName] = original
    } else {
      delete nextAssignments[slotName]
    }
    return nextAssignments
  }

  if (nextValue === '__none__') {
    nextAssignments[slotName] = {
      mode: 'none',
      label: currentAssignment?.label
    }
    return nextAssignments
  }

  const nextItem = resolveClosetItem(nextValue)
  if (!nextItem) return nextAssignments

  nextAssignments[slotName] = {
    mode: 'item',
    itemId: nextItem.id,
    label: currentAssignment?.label
  }

  return nextAssignments
}
