import { describe, expect, it } from 'vitest'

import {
  buildGoonQuickControlPatch,
  buildGoonQuickControlsProjection,
  normalizeGoonQuickControlAction,
  normalizeGoonQuickControlRuntimeContext
} from '$lib/goons/goonQuickControls'
import type { GoonRecord, GoonsSettings } from '$lib/types/goons'

const TOP_SLOT = 'N00_004_01_Tops_01_CLOTH'

function quickControlGoon(): GoonRecord {
  return {
    id: 'goon-quick-controls',
    user_id: 'josh',
    name: 'Quick Control Goon',
    kind: 'custom',
    sourceProfile: 'guided-custom-vrm',
    files: { vrm: { url: '/goons/quick.vrm', filename: 'quick.vrm' } },
    cues: {
      enabled: ['calm', 'dance'],
      overrides: {
        calm: { name: 'Calm', kind: 'mood', animationName: 'calm_idle' },
        dance: { name: 'Dance', kind: 'mood', animationName: 'dance_loop' }
      }
    },
    defaults: { baseLoop: 'Calm', quality: 'high', closetOutfitId: 'evening' },
    closet: {
      items: {
        hoodie: { id: 'hoodie', name: 'Hoodie', category: 'top' },
        capeEdit: {
          id: 'capeEdit',
          name: 'Cape Original',
          category: 'guided',
          originalSource: { kind: 'guided-piece-original', pieceId: 'cape' },
          materialColors: { baseHex: '#336699' }
        }
      },
      outfits: {
        evening: {
          id: 'evening',
          name: 'Evening',
          assignments: { [TOP_SLOT]: { mode: 'item', itemId: 'hoodie' } },
          guidedPieceStates: { cape: true }
        }
      }
    },
    closetAssignments: { [TOP_SLOT]: { mode: 'item', itemId: 'hoodie', label: 'Top' } },
    guidedAvatar: {
      outfitPieces: [
        {
          id: 'cape',
          label: 'Cape',
          runtimeNodeNames: ['Cape'],
          source: 'base',
          defaultOn: true
        }
      ],
      pieceStates: { cape: true }
    },
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z'
  }
}

const settings: GoonsSettings = {
  globalCloset: {
    items: {
      jacket: { id: 'jacket', name: 'Jacket', category: 'top' }
    }
  }
}

describe('Goon quick controls', () => {
  it('projects the same saved Mood, Closet, Quality, and Eye Contact choices for Desktop Controls', () => {
    const projection = buildGoonQuickControlsProjection(quickControlGoon(), settings, {
      materialNames: [TOP_SLOT, TOP_SLOT, ''],
      eyeContactEnabled: false
    })

    expect(projection).toMatchObject({
      goonId: 'goon-quick-controls',
      mood: { currentName: 'Calm', currentLabel: 'Calm' },
      quality: { current: 'high' },
      eyeContactEnabled: false
    })
    expect(projection?.mood.options).toEqual(
      expect.arrayContaining([
        { name: 'Calm', label: 'Calm', current: true },
        { name: 'Dance', label: 'Dance', current: false }
      ])
    )
    const closetOptions = projection?.closet.groups.flatMap((group) => group.options) ?? []
    expect(closetOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: { kind: 'outfit', outfitId: 'evening' }, current: true }),
        expect.objectContaining({
          action: { kind: 'slot', slotName: TOP_SLOT, value: 'hoodie' },
          current: true
        }),
        expect.objectContaining({
          action: { kind: 'guided-piece', pieceId: 'cape', value: 'capeEdit' },
          current: true
        })
      ])
    )
  })

  it('builds canonical persisted patches for mood, quality, slot, guided-piece, and outfit actions', () => {
    const goon = quickControlGoon()
    expect(
      buildGoonQuickControlPatch(goon, settings, [TOP_SLOT], {
        kind: 'mood',
        cueName: 'Dance'
      })
    ).toMatchObject({ defaults: { baseLoop: 'Dance', quality: 'high' } })
    expect(
      buildGoonQuickControlPatch(goon, settings, [TOP_SLOT], {
        kind: 'quality',
        value: 'ultra'
      })
    ).toMatchObject({ defaults: { quality: 'ultra' } })

    const slotPatch = buildGoonQuickControlPatch(goon, settings, [TOP_SLOT], {
      kind: 'slot',
      slotName: TOP_SLOT,
      value: '__none__'
    })
    expect(slotPatch?.closetAssignments?.[TOP_SLOT]).toEqual({ mode: 'none', label: 'Top' })
    expect(slotPatch?.defaults).not.toHaveProperty('closetOutfitId')

    const piecePatch = buildGoonQuickControlPatch(goon, settings, [TOP_SLOT], {
      kind: 'guided-piece',
      pieceId: 'cape',
      value: '__none__'
    })
    expect(piecePatch?.guidedAvatar?.pieceStates?.cape).toBe(false)

    const outfitPatch = buildGoonQuickControlPatch(goon, settings, [TOP_SLOT], {
      kind: 'outfit',
      outfitId: 'evening'
    })
    expect(outfitPatch?.closetAssignments?.[TOP_SLOT]).toEqual({
      mode: 'item',
      itemId: 'hoodie'
    })
    expect(outfitPatch?.defaults?.closetOutfitId).toBe('evening')
  })

  it('normalizes bounded intents and rejects stale or broadened action shapes', () => {
    expect(
      normalizeGoonQuickControlAction({ kind: 'eye-contact', enabled: false })
    ).toEqual({ kind: 'eye-contact', enabled: false })
    expect(
      normalizeGoonQuickControlRuntimeContext({
        materialNames: [' B ', 'A', 'A'],
        eyeContactEnabled: true
      })
    ).toEqual({ materialNames: ['A', 'B'], eyeContactEnabled: true })
    expect(() =>
      normalizeGoonQuickControlAction({ kind: 'quality', value: 'cinematic' })
    ).toThrow(/Quality/)
    expect(() =>
      normalizeGoonQuickControlAction({ kind: 'mood', cueName: 'Calm', surprise: true })
    ).toThrow(/unsupported shape/)
    expect(() =>
      buildGoonQuickControlPatch(quickControlGoon(), settings, [TOP_SLOT], {
        kind: 'slot',
        slotName: 'missing',
        value: '__none__'
      })
    ).toThrow(/no longer available/)
  })

  it('rebuilds reactive Closet actions as structured-cloneable plain objects', () => {
    const reactiveAction = new Proxy(
      { kind: 'outfit' as const, outfitId: 'evening' },
      {}
    )

    expect(() => structuredClone(reactiveAction)).toThrow()
    const normalized = normalizeGoonQuickControlAction(reactiveAction)
    expect(structuredClone(normalized)).toEqual({ kind: 'outfit', outfitId: 'evening' })
  })
})
