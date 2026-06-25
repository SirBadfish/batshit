import { describe, expect, it } from 'vitest'

import type { GoonClosetItem, GoonRecord } from '$lib/types/goons'

import {
  buildClosetPickerItems,
  buildClosetAssignmentsAfterItemRemoval,
  buildCustomClosetDraft,
  buildGoonRecordCustomClosetCleanup,
  createCustomClosetItemFromGlobal,
  createCustomClosetItemFromOriginal,
  resolveEnabledCustomClosetItems
} from './customClosetLibrary'

const globalItems: Record<string, GoonClosetItem> = {
  hoodie: {
    id: 'hoodie',
    name: 'Pink Hoodie',
    category: 'top'
  },
  boots: {
    id: 'boots',
    name: 'Stage Boots',
    category: 'shoes'
  }
}

type LegacyRegionClosetItem = GoonClosetItem & { concealRegions?: string[] }

describe('customClosetLibrary', () => {
  it('builds a goon-specific closet draft from stored local items', () => {
    const draft = buildCustomClosetDraft({
      closet: {
        items: {
          goon_closet_1: {
            id: 'goon_closet_1',
            sourceItemId: 'hoodie',
            originalSource: { kind: 'slot-original', slotName: '  N00_004_01_Tops_01_CLOTH  ' },
            name: 'Luci Hoodie',
            category: 'top',
            paintedConcealMask: {
              version: 1,
              topologySignature: 'topology:a',
              meshes: [
                {
                  mesh: 'Body',
                  topologySignature: 'mesh:a',
                  triangleCount: 10,
                  vertexCount: 6,
                  triangleRanges: [[1, 2]]
                }
              ]
            }
          } satisfies GoonClosetItem,
          invalid: {
            id: '',
            name: '   ',
            category: 'top'
          }
        }
      }
    })

    expect(draft).toEqual({
      items: {
        goon_closet_1: {
          id: 'goon_closet_1',
          sourceItemId: 'hoodie',
          originalSource: { kind: 'slot-original', slotName: 'N00_004_01_Tops_01_CLOTH' },
          name: 'Luci Hoodie',
          category: 'top',
          paintedConcealMask: {
            version: 1,
            topologySignature: 'topology:a',
            meshes: [
              {
                mesh: 'Body',
                topologySignature: 'mesh:a',
                triangleCount: 10,
                vertexCount: 6,
                triangleRanges: [[1, 2]]
              }
            ]
          }
        }
      }
    })
  })

  it('creates a local goon closet item copy from a global item', () => {
    const created = createCustomClosetItemFromGlobal({
      ...globalItems.hoodie,
      concealRegions: ['upper_belly'],
      materialColors: { baseHex: '#FFFFFF' },
      originalSource: { kind: 'slot-original', slotName: 'N00_004_01_Tops_01_CLOTH' },
      paintedConcealMask: {
        version: 1,
        topologySignature: 'topology:a',
        meshes: [
          {
            mesh: 'Body',
            topologySignature: 'mesh:a',
            triangleCount: 10,
            vertexCount: 6,
            triangleRanges: [[1, 2]]
          }
        ]
      }
    } satisfies LegacyRegionClosetItem)

    expect(created.id).toMatch(/^goon_closet_/)
    expect(created.sourceItemId).toBe('hoodie')
    expect(created.name).toBe('Pink Hoodie')
    expect(created.category).toBe('top')
    expect(created.originalSource).toBeUndefined()
    expect((created as LegacyRegionClosetItem).concealRegions).toBeUndefined()
    expect(created.materialColors).toBeUndefined()
    expect(created.paintedConcealMask).toBeUndefined()
  })

  it('creates a saved original item for per-Goon painted conceal', () => {
    const created = createCustomClosetItemFromOriginal({
      originalSource: { kind: 'guided-piece-original', pieceId: 'jacket' },
      name: 'Original Jacket',
      category: 'outerwear',
      paintedConcealMask: {
        version: 1,
        topologySignature: 'topology:a',
        meshes: [
          {
            mesh: 'Body',
            topologySignature: 'mesh:a',
            triangleCount: 10,
            vertexCount: 6,
            triangleRanges: [[4, 6]]
          }
        ]
      }
    })

    expect(created.id).toMatch(/^goon_closet_/)
    expect(created.sourceItemId).toBeUndefined()
    expect(created.originalSource).toEqual({ kind: 'guided-piece-original', pieceId: 'jacket' })
    expect(created.name).toBe('Original Jacket')
    expect(created.category).toBe('outerwear')
    expect(created.paintedConcealMask?.meshes[0]?.triangleRanges).toEqual([[4, 6]])
  })

  it('resolves goon closet items sorted by name', () => {
    const resolved = resolveEnabledCustomClosetItems({
      goon_closet_2: {
        id: 'goon_closet_2',
        sourceItemId: 'boots',
        name: 'Stage Boots',
        category: 'shoes'
      },
      goon_closet_1: {
        id: 'goon_closet_1',
        sourceItemId: 'hoodie',
        name: 'Luci Hoodie',
        category: 'top'
      }
    })

    expect(resolved).toEqual([
      {
        id: 'goon_closet_1',
        sourceItemId: 'hoodie',
        name: 'Luci Hoodie',
        category: 'top'
      },
      {
        id: 'goon_closet_2',
        sourceItemId: 'boots',
        name: 'Stage Boots',
        category: 'shoes'
      }
    ])
  })

  it('builds slot picker items as local copies first plus all global items', () => {
    const pickerItems = buildClosetPickerItems(globalItems, {
      goon_closet_1: {
        id: 'goon_closet_1',
        sourceItemId: 'hoodie',
        name: 'Luci Hoodie',
        category: 'top'
      }
    })

    expect(pickerItems).toEqual([
      {
        id: 'goon_closet_1',
        sourceItemId: 'hoodie',
        name: 'Luci Hoodie',
        category: 'top',
        pickerSource: 'custom'
      },
      {
        id: 'hoodie',
        name: 'Pink Hoodie',
        category: 'top',
        pickerSource: 'global'
      },
      {
        id: 'boots',
        name: 'Stage Boots',
        category: 'shoes',
        pickerSource: 'global'
      }
    ])
  })

  it('restores matching slot assignments back to original while preserving user labels', () => {
    expect(
      buildClosetAssignmentsAfterItemRemoval(
        {
          top: { mode: 'item', itemId: 'goon_closet_1', label: 'Main Hoodie' },
          shoes: { mode: 'item', itemId: 'boots' }
        },
        'goon_closet_1'
      )
    ).toEqual({
      top: { mode: 'original', label: 'Main Hoodie' },
      shoes: { mode: 'item', itemId: 'boots' }
    })
  })

  it('builds cleanup payloads when a global closet item is removed from the library', () => {
    const goon = {
      id: 'goon-1',
      user_id: 'user-1',
      name: 'Luci',
      files: {},
      created_at: '2026-04-15T00:00:00.000Z',
      updated_at: '2026-04-15T00:00:00.000Z',
      closet: {
        items: {
          goon_closet_1: {
            id: 'goon_closet_1',
            sourceItemId: 'hoodie',
            name: 'Luci Hoodie',
            category: 'top'
          }
        }
      },
      closetAssignments: {
        top: { mode: 'item', itemId: 'hoodie', label: 'Main Hoodie' },
        jacket: { mode: 'item', itemId: 'goon_closet_1' }
      }
    } satisfies GoonRecord

    expect(buildGoonRecordCustomClosetCleanup(goon, 'hoodie')).toEqual({
      closetAssignments: {
        top: { mode: 'original', label: 'Main Hoodie' },
        jacket: { mode: 'item', itemId: 'goon_closet_1' }
      }
    })
  })
})
