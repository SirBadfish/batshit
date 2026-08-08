import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countChangedSkinAppearanceControls,
  createDefaultSkinAppearanceState,
  migrateSkinAppearanceState,
  parseSkinAppearanceDefinition,
  parseSkinAppearanceState,
  reconcileSkinAppearanceState,
  setCustomSkinSurfaceUpload,
  skinAppearanceHexToRgb,
  skinAppearanceRgbToHex,
  updateSkinAppearanceRegion,
  updateSkinAppearanceSurface
} from './skinAppearance'
import type { SkinSurfaceMapRole, SkinSurfaceUploadV1 } from './skinSurface'

function rawDefinition() {
  return JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        'static/goons/skin-appearance/v1/skin-appearance-v1.json'
      ),
      'utf8'
    )
  )
}

function upload(
  role: SkinSurfaceMapRole,
  definitionSha256: string
): SkinSurfaceUploadV1 {
  const baseColor = role === 'baseColor'
  const hashChannel: Record<SkinSurfaceMapRole, string> = {
    baseColor: 'a',
    normal: 'b',
    roughness: 'c',
    metallic: 'd'
  }
  return {
    schemaVersion: 'skin-surface-artwork/v1',
    map: role,
    url: `/uploads/goon_skin_artwork/${role}.png`,
    filename: `${role}.png`,
    size: 100,
    mimeType: 'image/png',
    sha256: hashChannel[role].repeat(64),
    definitionSha256,
    canvas: {
      width: baseColor ? 4096 : 2048,
      height: baseColor ? 4096 : 2048,
      colorSpace: baseColor ? 'srgb' : 'linear',
      flipY: false,
      encoding:
        role === 'baseColor'
          ? 'rgba8'
          : role === 'normal'
            ? 'rgb8-normal-opengl'
            : role === 'roughness'
              ? 'rgb8-roughness-g'
              : 'rgb8-metallic-b'
    },
    provenance: {
      sourceKind: 'user-authored',
      author: 'Josh',
      license: 'LicenseRef-User-Owned',
      rightsConfirmed: true
    }
  }
}

describe('skin-appearance-state/v2', () => {
  it('adapts the immutable package definition by removing Base Skin from product controls', () => {
    const definition = parseSkinAppearanceDefinition(rawDefinition())
    expect(definition.definitionSha256).toBe(
      'd1a609899ed6c67463c67f141adb3f3e5277e83921501d23907bb88762af8c52'
    )
    expect(definition.controls.map((control) => control.id)).toEqual([
      'nipplesAreolae',
      'palmsSoles',
      'cheekBlush'
    ])
    expect(definition.defaultTint).toEqual([0.729412, 0.486275, 0.407843])
    expect(definition.stateSchemaVersion).toBe('skin-appearance-state/v2')
    expect(definition.canvas).toEqual({
      width: 4096,
      height: 4096,
      colorSpace: 'srgb',
      flipY: false
    })
    expect(definition.masks.palmsSoles).toMatchObject({
      width: 2048,
      height: 2048,
      channels: 'alpha-rgba8'
    })
    for (const asset of Object.values(definition.masks)) {
      const bytes = readFileSync(resolve(process.cwd(), 'static', asset.path))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256)
    }
  })

  it('owns all map modes, one tint, normal strength, and three regional controls atomically', () => {
    const definition = parseSkinAppearanceDefinition(rawDefinition())
    const defaults = createDefaultSkinAppearanceState(definition)
    expect(parseSkinAppearanceState(definition, defaults)).toEqual(defaults)
    expect(countChangedSkinAppearanceControls(definition, defaults)).toBe(0)
    expect(defaults.surface.baseColor).toEqual({
      mode: 'package',
      custom: null,
      tint: [1, 1, 1]
    })
    expect(defaults.surface.normal.strength).toBe(1)

    const customBase = setCustomSkinSurfaceUpload(
      definition,
      defaults,
      'baseColor',
      upload('baseColor', definition.definitionSha256)
    )
    expect(customBase.surface.baseColor.tint).toEqual(definition.defaultTint)
    const customNormal = setCustomSkinSurfaceUpload(
      definition,
      customBase,
      'normal',
      upload('normal', definition.definitionSha256)
    )
    const noMetal = updateSkinAppearanceSurface(
      definition,
      customNormal,
      'metallic',
      { mode: 'none', custom: null }
    )
    const blushOff = updateSkinAppearanceRegion(
      definition,
      noMetal,
      'cheekBlush',
      { mode: 'off' }
    )
    expect(countChangedSkinAppearanceControls(definition, blushOff)).toBe(4)
    expect(blushOff.surface.normal.custom?.map).toBe('normal')
    expect(blushOff.regions.cheekBlush.mode).toBe('off')
    expect(skinAppearanceRgbToHex([1, 0.5, 0])).toBe('#ff8000')
    expect(skinAppearanceHexToRgb('#804020')).toEqual([
      0.501961, 0.25098, 0.12549
    ])
  })

  it('migrates legacy Base Color Artwork and inheriting regional state without changing tint', () => {
    const definition = parseSkinAppearanceDefinition(rawDefinition())
    const legacyAppearance = {
      schemaVersion: 'skin-appearance-state/v1',
      definitionSha256: definition.definitionSha256,
      regions: {
        baseSkin: { mode: 'inherit', color: definition.defaultTint },
        nipplesAreolae: { mode: 'inherit', color: [0.6, 0.3, 0.3] },
        palmsSoles: { mode: 'custom', color: [0.8, 0.7, 0.6] },
        cheekBlush: { mode: 'off', color: [0.8, 0.4, 0.4] }
      }
    }
    const legacyUpload = upload('baseColor', definition.definitionSha256)
    const legacyArtwork = {
      schemaVersion: 'skin-material-artwork-state/v2',
      definitionSha256: definition.definitionSha256,
      baseColor: {
        ...legacyUpload,
        schemaVersion: 'skin-material-artwork/v1',
        canvas: {
          width: 4096,
          height: 4096,
          colorSpace: 'srgb',
          flipY: false
        }
      },
      tint: [0.25, 0.5, 0.75]
    }
    const migrated = migrateSkinAppearanceState(
      definition,
      legacyAppearance,
      legacyArtwork
    )
    expect(migrated.schemaVersion).toBe('skin-appearance-state/v2')
    expect(migrated.surface.baseColor).toMatchObject({
      mode: 'custom',
      tint: [0.25, 0.5, 0.75],
      custom: { schemaVersion: 'skin-surface-artwork/v1', map: 'baseColor' }
    })
    expect(migrated.regions.palmsSoles.mode).toBe('custom')
    expect(migrated.regions.cheekBlush.mode).toBe('off')
  })

  it('fails visibly instead of approximating legacy whole-atlas Base Skin replacement', () => {
    const definition = parseSkinAppearanceDefinition(rawDefinition())
    const legacy = {
      schemaVersion: 'skin-appearance-state/v1',
      definitionSha256: definition.definitionSha256,
      regions: {
        baseSkin: { mode: 'custom', color: [0.2, 0.3, 0.4] },
        nipplesAreolae: { mode: 'inherit', color: [0.6, 0.3, 0.3] },
        palmsSoles: { mode: 'inherit', color: [0.8, 0.7, 0.6] },
        cheekBlush: { mode: 'inherit', color: [0.8, 0.4, 0.4] }
      }
    }
    expect(() => migrateSkinAppearanceState(definition, legacy)).toThrow(
      /cannot be represented by Artwork Tint/
    )
  })

  it('rejects impossible modes, stale hashes, wrong roles, and hidden state keys', () => {
    const definition = parseSkinAppearanceDefinition(rawDefinition())
    const state = createDefaultSkinAppearanceState(definition) as any
    state.surface.baseColor.mode = 'none'
    expect(() => parseSkinAppearanceState(definition, state)).toThrow(/unsupported/)
    state.surface.baseColor.mode = 'package'
    state.surface.normal.mode = 'custom'
    expect(() => parseSkinAppearanceState(definition, state)).toThrow(/required/)
    state.surface.normal.mode = 'package'
    state.regions.palmsSoles.opacity = 0.5
    expect(() => parseSkinAppearanceState(definition, state)).toThrow(/exactly/)
    delete state.regions.palmsSoles.opacity
    state.definitionSha256 = 'a'.repeat(64)
    expect(reconcileSkinAppearanceState(definition, state)).toMatchObject({
      state: null,
      incompatible: true
    })
  })

  it('rejects non-canonical masks and package control ordering', () => {
    const definition = rawDefinition()
    definition.masks.generalSkin.width = 1536
    expect(() => parseSkinAppearanceDefinition(definition)).toThrow(/exact divisor/)
    const reordered = rawDefinition()
    reordered.controls.reverse()
    expect(() => parseSkinAppearanceDefinition(reordered)).toThrow(
      /id must be baseSkin/
    )
  })
})
