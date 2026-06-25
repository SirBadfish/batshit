import { describe, expect, it } from 'vitest'

import type { GoonClosetItem, GoonWardrobeOutfit } from '$lib/types/goons'
import {
  cloneWardrobeOutfitAssignments,
  normalizeWardrobeOutfitName,
  sanitizeWardrobeOutfit
} from './wardrobeOutfits'

const localHoodie: GoonClosetItem = {
  id: 'goon_closet_hoodie',
  sourceItemId: 'hoodie',
  name: 'Pink Hoodie',
  category: 'top'
}

describe('wardrobeOutfits', () => {
  it('normalizes names without preserving extra whitespace', () => {
    expect(normalizeWardrobeOutfitName('  Casual   Hoodie  ')).toBe('Casual Hoodie')
  })

  it('clones outfit assignments without mutating the source object', () => {
    const source = {
      ' N00_004_01_Tops_01_CLOTH ': {
        mode: 'item' as const,
        itemId: ' goon_closet_hoodie ',
        label: ' Hoodie '
      }
    }

    expect(cloneWardrobeOutfitAssignments(source)).toEqual({
      N00_004_01_Tops_01_CLOTH: {
        mode: 'item',
        itemId: 'goon_closet_hoodie',
        label: 'Hoodie'
      }
    })
    expect(source[' N00_004_01_Tops_01_CLOTH '].itemId).toBe(' goon_closet_hoodie ')
  })

  it('falls missing saved item references back to original', () => {
    const outfit: GoonWardrobeOutfit = {
      id: 'casual',
      name: 'Casual',
      assignments: {
        N00_004_01_Tops_01_CLOTH: {
          mode: 'item',
          itemId: 'missing',
          label: 'Top'
        }
      }
    }

    expect(sanitizeWardrobeOutfit(outfit, { resolveItem: () => null })?.assignments).toEqual({
      N00_004_01_Tops_01_CLOTH: {
        mode: 'original',
        label: 'Top'
      }
    })
  })

  it('keeps valid per-goon wardrobe item references', () => {
    const outfit: GoonWardrobeOutfit = {
      id: 'casual',
      name: 'Casual',
      assignments: {
        N00_004_01_Tops_01_CLOTH: {
          mode: 'item',
          itemId: localHoodie.id
        }
      },
      guidedPieceStates: {
        cape: false
      }
    }

    expect(
      sanitizeWardrobeOutfit(outfit, {
        resolveItem: (itemId) => (itemId === localHoodie.id ? localHoodie : null)
      })
    ).toEqual(outfit)
  })
})
