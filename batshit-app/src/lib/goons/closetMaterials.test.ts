import { describe, expect, it } from 'vitest'

import {
  buildClosetSlotNames,
  deriveAutoShadeHex,
  getDefaultClosetSlotLabel,
  hasMaterialColorOverride,
  isBodySkinClosetSlotMaterialName,
  isClosetSlotMaterialName,
  resolveClosetRuntimeMaterialName,
  SKIN_OVERLAY_SLOT_KEY,
  isSkinOverlayClosetSlotKey,
  normalizeClosetSlotMaterialName,
  normalizeHexColor,
  xwearColorToHex
} from './closetMaterials'

describe('closetMaterials', () => {
  it('normalizes duplicate slot suffixes down to the base VRoid template key', () => {
    expect(
      normalizeClosetSlotMaterialName('N00_010_01_Onepiece_00_CLOTH_07 (Instance)')
    ).toBe('N00_010_01_Onepiece_00_CLOTH')
    expect(
      normalizeClosetSlotMaterialName('N00_000_00_Body_00_SKIN(Clone) (Instance)')
    ).toBe('N00_000_00_Body_00_SKIN')
  })

  it('maps known VRoid template keys to friendly default slot labels', () => {
    expect(getDefaultClosetSlotLabel('N00_004_01_Tops_01_CLOTH (Instance)')).toBe('T-Shirt')
    expect(getDefaultClosetSlotLabel('N00_010_01_Onepiece_00_CLOTH_07 (Instance)')).toBe(
      'Body Suit'
    )
    expect(getDefaultClosetSlotLabel('N00_000_00_Body_00_SKIN(Clone) (Instance)')).toBe(
      'Skin Overlay'
    )
    expect(getDefaultClosetSlotLabel(SKIN_OVERLAY_SLOT_KEY)).toBe('Skin Overlay')
  })

  it('falls back to Other when a slot is not mapped yet', () => {
    expect(getDefaultClosetSlotLabel('N00_999_99_Mystery_99_CLOTH (Instance)')).toBe('Other')
  })

  it('recognizes both cloth and body skin as Closet-compatible slot materials', () => {
    expect(isClosetSlotMaterialName('N00_004_01_Tops_01_CLOTH (Instance)')).toBe(true)
    expect(isClosetSlotMaterialName('N00_000_00_Body_00_SKIN (Instance)')).toBe(true)
    expect(isClosetSlotMaterialName('N00_000_00_Face_00_SKIN (Instance)')).toBe(false)
    expect(isBodySkinClosetSlotMaterialName('N00_000_00_Body_00_SKIN(Clone) (Instance)')).toBe(
      true
    )
    expect(isBodySkinClosetSlotMaterialName('N00_004_01_Tops_01_CLOTH (Instance)')).toBe(false)
    expect(isSkinOverlayClosetSlotKey(SKIN_OVERLAY_SLOT_KEY)).toBe(true)
  })

  it('builds a virtual Skin Overlay slot while hiding the raw body-skin material row', () => {
    expect(
      buildClosetSlotNames([
        'N00_000_00_Body_00_SKIN (Instance)',
        'N00_010_01_Onepiece_00_CLOTH_02 (Instance)',
        'N00_004_01_Tops_01_CLOTH (Instance)'
      ])
    ).toEqual([
      'N00_010_01_Onepiece_00_CLOTH_02 (Instance)',
      'N00_004_01_Tops_01_CLOTH (Instance)',
      SKIN_OVERLAY_SLOT_KEY
    ])
  })

  it('resolves the virtual Skin Overlay slot back onto the live body-skin material', () => {
    expect(
      resolveClosetRuntimeMaterialName(SKIN_OVERLAY_SLOT_KEY, [
        'N00_000_00_Body_00_SKIN (Instance)',
        'N00_010_01_Onepiece_00_CLOTH_01 (Instance)'
      ])
    ).toBe('N00_000_00_Body_00_SKIN (Instance)')
  })

  it('normalizes hex colors consistently', () => {
    expect(normalizeHexColor('cfd6f7')).toBe('#CFD6F7')
    expect(normalizeHexColor('#cfd6f7')).toBe('#CFD6F7')
    expect(normalizeHexColor('not-a-color')).toBeUndefined()
  })

  it('converts linear XWear colors back into display hex', () => {
    expect(
      xwearColorToHex({
        r: 0.6239603916750761,
        g: 0.6724431569576875,
        b: 0.9301108583754237,
        a: 1
      })
    ).toBe('#CFD6F7')
  })

  it('preserves the original base-to-shade relationship when deriving auto shade', () => {
    expect(deriveAutoShadeHex('#FFFFFF', '#FFFFFF', '#CFD6F7')).toBe('#CFD6F7')
    expect(deriveAutoShadeHex('#FF0000', '#FFFFFF', '#CFD6F7')).toBe('#CF0000')
  })

  it('detects whether an override actually contains colors', () => {
    expect(hasMaterialColorOverride({ baseHex: '#FF0000' })).toBe(true)
    expect(hasMaterialColorOverride({ shadeHex: '#AA0000' })).toBe(true)
    expect(hasMaterialColorOverride({})).toBe(false)
    expect(hasMaterialColorOverride(undefined)).toBe(false)
  })
})
