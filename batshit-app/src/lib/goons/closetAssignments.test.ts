import { describe, expect, it } from 'vitest'

import type { GoonClosetAssignment, GoonClosetItem } from '$lib/types/goons'
import { SKIN_OVERLAY_SLOT_KEY } from '$lib/goons/closetMaterials'
import { applyClosetSelectionChange, getClosetItemMaterialTargets } from './closetAssignments'

const multiItem: GoonClosetItem = {
  id: 'dress',
  name: 'Red Dress',
  category: 'dress',
  xwear: {
    materialName: 'N00_002_01_Tops_01_CLOTH',
    materials: [
      { materialName: 'N00_002_01_Tops_01_CLOTH' },
      { materialName: 'N00_010_01_Onepiece_00_CLOTH' },
      { materialName: 'N00_007_01_Tops_01_CLOTH' }
    ]
  }
}

const singleItem: GoonClosetItem = {
  id: 'tee',
  name: 'Yellow Tee',
  category: 'top',
  xwear: {
    materialName: 'N00_004_01_Tops_01_CLOTH'
  }
}

const skinOverlayItem: GoonClosetItem = {
  id: 'thong',
  name: 'Black Thong',
  category: 'other',
  xwear: {
    materialName: 'N00_000_00_Body_00_SKIN(Clone) (Instance)'
  }
}

function resolveItem(itemId?: string | null) {
  if (itemId === multiItem.id) return multiItem
  if (itemId === singleItem.id) return singleItem
  if (itemId === skinOverlayItem.id) return skinOverlayItem
  return null
}

describe('closetAssignments', () => {
  it('returns unique material targets from a multi-material item', () => {
    expect(getClosetItemMaterialTargets(multiItem)).toEqual([
      'N00_002_01_Tops_01_CLOTH',
      'N00_010_01_Onepiece_00_CLOTH',
      'N00_007_01_Tops_01_CLOTH'
    ])
  })

  it('assigns a multi-material item to the exact slot the user picked', () => {
    const next = applyClosetSelectionChange(
      {},
      'N00_002_01_Tops_01_CLOTH (Instance)',
      'dress',
      resolveItem,
      [
        'N00_002_01_Tops_01_CLOTH (Instance)',
        'N00_010_01_Onepiece_00_CLOTH_03 (Instance)',
        'N00_007_01_Tops_01_CLOTH (Instance)'
      ]
    )
    expect(next).toEqual({
      'N00_002_01_Tops_01_CLOTH (Instance)': { mode: 'item', itemId: 'dress', label: undefined }
    })
  })

  it('only changes the selected slot when swapping to a different item', () => {
    const current: Record<string, GoonClosetAssignment> = {
      'N00_002_01_Tops_01_CLOTH (Instance)': { mode: 'item', itemId: 'dress', label: 'Dress Slot' },
      'N00_010_01_Onepiece_00_CLOTH_03 (Instance)': { mode: 'item', itemId: 'dress' },
      'N00_007_01_Tops_01_CLOTH (Instance)': { mode: 'item', itemId: 'dress' }
    }
    const next = applyClosetSelectionChange(
      current,
      'N00_002_01_Tops_01_CLOTH (Instance)',
      'tee',
      resolveItem,
      [
        'N00_002_01_Tops_01_CLOTH (Instance)',
        'N00_010_01_Onepiece_00_CLOTH_03 (Instance)',
        'N00_007_01_Tops_01_CLOTH (Instance)',
        'N00_004_01_Tops_01_CLOTH (Instance)'
      ]
    )
    expect(next).toEqual({
      'N00_002_01_Tops_01_CLOTH (Instance)': { mode: 'item', itemId: 'tee', label: 'Dress Slot' },
      'N00_010_01_Onepiece_00_CLOTH_03 (Instance)': { mode: 'item', itemId: 'dress' },
      'N00_007_01_Tops_01_CLOTH (Instance)': { mode: 'item', itemId: 'dress' }
    })
  })

  it('preserves a slot label when clearing back to original', () => {
    const current: Record<string, GoonClosetAssignment> = {
      'N00_004_01_Tops_01_CLOTH (Instance)': { mode: 'item', itemId: 'tee', label: 'T-Shirt' }
    }
    const next = applyClosetSelectionChange(
      current,
      'N00_004_01_Tops_01_CLOTH (Instance)',
      '__original__',
      resolveItem
    )
    expect(next).toEqual({
      'N00_004_01_Tops_01_CLOTH (Instance)': { mode: 'original', label: 'T-Shirt' }
    })
  })

  it('routes body-skin XWear items onto the virtual Skin Overlay slot', () => {
    const next = applyClosetSelectionChange(
      {},
      SKIN_OVERLAY_SLOT_KEY,
      'thong',
      resolveItem,
      [SKIN_OVERLAY_SLOT_KEY, 'N00_010_01_Onepiece_00_CLOTH_01 (Instance)']
    )
    expect(next).toEqual({
      [SKIN_OVERLAY_SLOT_KEY]: { mode: 'item', itemId: 'thong', label: undefined }
    })
  })
})
