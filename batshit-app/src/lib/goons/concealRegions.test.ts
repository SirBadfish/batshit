import { describe, expect, it } from 'vitest'

import type { GoonClosetItem, GoonGuidedOutfitPiece } from '$lib/types/goons'
import {
  buildGuidedPieceOriginalClosetSlot,
  resolveActiveWearableConceal
} from './concealRegions'

type LegacyRegionClosetItem = GoonClosetItem & { concealRegions?: string[] }
type LegacyRegionGuidedPiece = GoonGuidedOutfitPiece & { concealRegions?: string[] }

const hoodie: LegacyRegionClosetItem = {
  id: 'hoodie',
  name: 'Hoodie',
  category: 'top',
  concealRegions: ['upper_belly', 'upper_back', 'shoulder_cap_left', 'shoulder_cap_right'],
  paintedConcealMask: {
    version: 1,
    topologySignature: 'topology:a',
    meshes: [
      {
        mesh: 'Body',
        topologySignature: 'mesh:a',
        triangleCount: 10,
        vertexCount: 6,
        triangleRanges: [[1, 3]]
      }
    ]
  }
}

const bottoms: LegacyRegionGuidedPiece = {
  id: 'duf_overlay_bottoms',
  label: 'Pants',
  runtimeNodeNames: ['Bottoms'],
  source: 'duf-overlay',
  overlayId: 'overlay_1',
  materialNames: ['N00_001_01_Bottoms_01_CLOTH'],
  concealRegions: ['glute_left', 'glute_right', 'upper_thigh_front_left', 'upper_thigh_front_right']
}

const cape: LegacyRegionGuidedPiece = {
  id: 'cape',
  label: 'Cape',
  runtimeNodeNames: ['Cape'],
  source: 'base',
  concealRegions: ['upper_back']
}

describe('concealRegions helpers', () => {
  it('ignores retired named conceal regions and keeps selected painted masks', () => {
    const conceal = resolveActiveWearableConceal({
      closetAssignments: {
        N00_004_01_Tops_01_CLOTH: { mode: 'item', itemId: 'hoodie' }
      },
      resolveClosetItem: (itemId) => (itemId === hoodie.id ? hoodie : null),
      guidedOutfitPieces: [cape]
    })

    expect(conceal.paintedMasks).toHaveLength(1)
    expect(conceal.paintedMasks[0]?.topologySignature).toBe('topology:a')
  })

  it('does not apply guided DUF named regions after region conceal retirement', () => {
    const original = resolveActiveWearableConceal({
      guidedOutfitPieces: [bottoms]
    })
    expect(original.paintedMasks).toEqual([])

    const none = resolveActiveWearableConceal({
      closetAssignments: {
        N00_001_01_Bottoms_01_CLOTH: { mode: 'none' }
      },
      guidedOutfitPieces: [bottoms]
    })
    expect(none.paintedMasks).toEqual([])
  })

  it('includes painted masks for selected standalone guided original edited items', () => {
    const savedOriginalCape: GoonClosetItem = {
      id: 'saved_original_cape',
      name: 'Original Cape',
      category: 'outerwear',
      originalSource: { kind: 'guided-piece-original', pieceId: 'cape' },
      paintedConcealMask: {
        version: 1,
        topologySignature: 'topology:piece',
        meshes: [
          {
            mesh: 'Body',
            topologySignature: 'mesh:piece',
            triangleCount: 12,
            vertexCount: 8,
            triangleRanges: [[8, 9]]
          }
        ]
      }
    }

    const conceal = resolveActiveWearableConceal({
      closetAssignments: {
        [buildGuidedPieceOriginalClosetSlot('cape')]: {
          mode: 'item',
          itemId: 'saved_original_cape'
        }
      },
      guidedOutfitPieces: [cape],
      resolveClosetItem: (itemId) => (itemId === 'saved_original_cape' ? savedOriginalCape : null)
    })

    expect(conceal.paintedMasks.map((mask) => mask.topologySignature)).toEqual(['topology:piece'])
  })

  it('favors edited original painted masks when the raw original is active', () => {
    const editedOriginal: GoonClosetItem = {
      id: 'edited_slot_original',
      name: 'Original Tops Edited',
      category: 'top',
      originalSource: { kind: 'slot-original', slotName: 'N00_004_01_Tops_01_CLOTH' },
      paintedConcealMask: {
        version: 1,
        topologySignature: 'topology:original-slot',
        meshes: [
          {
            mesh: 'Body',
            topologySignature: 'mesh:original-slot',
            triangleCount: 12,
            vertexCount: 8,
            triangleRanges: [[2, 4]]
          }
        ]
      }
    }

    const conceal = resolveActiveWearableConceal({
      closetAssignments: {
        N00_004_01_Tops_01_CLOTH: { mode: 'original' }
      },
      resolveOriginalSavedItem: (source) =>
        source.kind === 'slot-original' && source.slotName === 'N00_004_01_Tops_01_CLOTH'
          ? editedOriginal
          : null
    })

    expect(conceal.paintedMasks.map((mask) => mask.topologySignature)).toEqual(['topology:original-slot'])
  })
})
