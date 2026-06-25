import { describe, expect, it } from 'vitest'

import type { GoonGuidedOutfitPiece } from '$lib/types/goons'
import {
  buildGuidedOutfitPieceStates,
  isGuidedOutfitPieceSlotManaged,
  listStandaloneGuidedOutfitPieces,
  resolveGuidedOutfitManagedSlotName,
  resolveGuidedOutfitPieceVisible
} from './guidedOutfits'

const hoodie: GoonGuidedOutfitPiece = {
  id: 'hoodie',
  label: 'Hoodie',
  runtimeNodeNames: ['Hoodie'],
  source: 'base',
  defaultOn: true,
  materialNames: ['N00_004_01_Tops_01_CLOTH']
}

const cape: GoonGuidedOutfitPiece = {
  id: 'cape',
  label: 'Cape',
  runtimeNodeNames: ['Cape'],
  source: 'base',
  defaultOn: true,
  materialNames: ['Cape_Custom_Material']
}

const glasses: GoonGuidedOutfitPiece = {
  id: 'duf_glasses',
  label: 'Glasses',
  runtimeNodeNames: ['Glasses'],
  source: 'duf-overlay',
  overlayId: 'overlay_1',
  defaultOn: false,
  materialNames: ['N00_007_01_Accessory_Tie_01_CLOTH']
}

describe('guidedOutfits helpers', () => {
  it('detects guided original pieces that are managed by real closet slots', () => {
    const availableSlots = ['N00_004_01_Tops_01_CLOTH']

    expect(resolveGuidedOutfitManagedSlotName(hoodie, availableSlots)).toBe(
      'N00_004_01_Tops_01_CLOTH'
    )
    expect(isGuidedOutfitPieceSlotManaged(hoodie, availableSlots)).toBe(true)
    expect(listStandaloneGuidedOutfitPieces([hoodie, cape], availableSlots)).toEqual([cape])
  })

  it('keeps non-slot guided original pieces as standalone outfit entries', () => {
    expect(listStandaloneGuidedOutfitPieces([cape], ['N00_004_01_Tops_01_CLOTH'])).toEqual([
      cape
    ])
  })

  it('keeps DUF overlay pieces out of standalone original outfit controls', () => {
    expect(resolveGuidedOutfitPieceVisible(glasses, { availableSlotNames: [] })).toBe(true)
    expect(listStandaloneGuidedOutfitPieces([glasses], [])).toEqual([])
  })

  it('drives slot-managed visibility from the closet assignment', () => {
    const availableSlots = ['N00_004_01_Tops_01_CLOTH']

    expect(
      resolveGuidedOutfitPieceVisible(hoodie, {
        availableSlotNames: availableSlots,
        assignments: {
          N00_004_01_Tops_01_CLOTH: { mode: 'none' }
        }
      })
    ).toBe(false)
    expect(
      resolveGuidedOutfitPieceVisible(hoodie, {
        availableSlotNames: availableSlots,
        assignments: {
          N00_004_01_Tops_01_CLOTH: { mode: 'item', itemId: 'red_hoodie' }
        }
      })
    ).toBe(true)
  })

  it('builds persisted piece states from slot assignments and standalone defaults', () => {
    expect(
      buildGuidedOutfitPieceStates([hoodie, cape], {
        availableSlotNames: ['N00_004_01_Tops_01_CLOTH'],
        pieceStates: {
          cape: false
        },
        assignments: {
          N00_004_01_Tops_01_CLOTH: { mode: 'none' }
        }
      })
    ).toEqual({
      hoodie: false,
      cape: false
    })
  })
})
