import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultSkinAppearanceState,
  parseSkinAppearanceDefinition,
  setCustomSkinSurfaceUpload
} from '$lib/goons/skinAppearance'
import type { SkinSurfaceMapRole, SkinSurfaceUploadV1 } from '$lib/goons/skinSurface'
import {
  loadGoonSkinAppearanceDefinition,
  validateGoonLegacySkinMaterialArtworkState,
  validateGoonSkinAppearanceState
} from '../skinAppearance.server'

const skinAppearance = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      'static/goons/skin-appearance/v1/skin-appearance-v1.json'
    ),
    'utf8'
  )
)
const goon = {
  customAvatar: {
    manifest: {
      url: '/uploads/goon_custom_manifests/avatar.json',
      filename: 'avatar.json'
    }
  }
}

function reader(manifest: unknown, records: Record<string, unknown> = {}) {
  return {
    json: {
      async get(key: string) {
        if (key === 'upload:goon_custom_manifests:avatar.json') {
          return { textContent: JSON.stringify(manifest) }
        }
        return records[key] ?? null
      }
    }
  }
}

function upload(role: SkinSurfaceMapRole): SkinSurfaceUploadV1 {
  const definition = parseSkinAppearanceDefinition(skinAppearance)
  const baseColor = role === 'baseColor'
  return {
    schemaVersion: 'skin-surface-artwork/v1',
    map: role,
    url: `/uploads/goon_skin_artwork/${role}.png`,
    filename: `${role}.png`,
    size: 100,
    mimeType: 'image/png',
    sha256: (role === 'baseColor' ? 'a' : 'b').repeat(64),
    definitionSha256: definition.definitionSha256,
    canvas: {
      width: baseColor ? 4096 : 2048,
      height: baseColor ? 4096 : 2048,
      colorSpace: baseColor ? 'srgb' : 'linear',
      flipY: false,
      encoding: baseColor ? 'rgba8' : 'rgb8-normal-opengl'
    },
    provenance: {
      sourceKind: 'user-authored',
      author: 'Josh',
      license: 'LicenseRef-User-Owned',
      rightsConfirmed: true
    }
  }
}

function proof(value: SkinSurfaceUploadV1) {
  return {
    uploadType: 'goon_skin_artwork',
    mimetype: 'image/png',
    size: value.size,
    skinSurfaceArtwork: {
      schemaVersion: value.schemaVersion,
      map: value.map,
      definitionSha256: value.definitionSha256,
      sha256: value.sha256,
      canvas: value.canvas,
      provenance: value.provenance
    }
  }
}

function legacyBaseColorProof(value: SkinSurfaceUploadV1) {
  return {
    uploadType: 'goon_skin_artwork',
    mimetype: 'image/png',
    size: value.size,
    skinMaterialArtwork: {
      schemaVersion: 'skin-material-artwork/v1',
      map: 'baseColor',
      definitionSha256: value.definitionSha256,
      sha256: value.sha256,
      canvas: {
        width: value.canvas.width,
        height: value.canvas.height,
        colorSpace: value.canvas.colorSpace,
        flipY: value.canvas.flipY
      },
      provenance: value.provenance
    }
  }
}

describe('skinAppearance.server', () => {
  it('loads the package-bound definition and validates exact v2 state', async () => {
    const definition = parseSkinAppearanceDefinition(skinAppearance)
    const state = createDefaultSkinAppearanceState(definition)
    state.regions.palmsSoles.mode = 'custom'
    await expect(
      loadGoonSkinAppearanceDefinition(reader({ skinAppearance }), goon)
    ).resolves.toEqual(definition)
    await expect(
      validateGoonSkinAppearanceState(reader({ skinAppearance }), goon, state)
    ).resolves.toEqual(state)
  })

  it('requires every Custom map to match its role-specific stored ownership proof', async () => {
    const definition = parseSkinAppearanceDefinition(skinAppearance)
    const baseColor = upload('baseColor')
    const normal = upload('normal')
    let state = createDefaultSkinAppearanceState(definition)
    state = setCustomSkinSurfaceUpload(definition, state, 'baseColor', baseColor)
    state = setCustomSkinSurfaceUpload(definition, state, 'normal', normal)
    const records = {
      'upload:goon_skin_artwork:baseColor.png': proof(baseColor),
      'upload:goon_skin_artwork:normal.png': proof(normal)
    }
    await expect(
      validateGoonSkinAppearanceState(
        reader({ skinAppearance }, records),
        goon,
        state
      )
    ).resolves.toEqual(state)
    await expect(
      validateGoonSkinAppearanceState(
        reader(
          { skinAppearance },
          { 'upload:goon_skin_artwork:baseColor.png': proof(baseColor) }
        ),
        goon,
        state
      )
    ).rejects.toThrow(/normal upload normal.png is missing/)
  })

  it('adopts an exactly matching legacy Base Color ownership proof into v2 state', async () => {
    const definition = parseSkinAppearanceDefinition(skinAppearance)
    const baseColor = upload('baseColor')
    let state = createDefaultSkinAppearanceState(definition)
    state = setCustomSkinSurfaceUpload(definition, state, 'baseColor', baseColor)

    await expect(
      validateGoonSkinAppearanceState(
        reader(
          { skinAppearance },
          {
            'upload:goon_skin_artwork:baseColor.png':
              legacyBaseColorProof(baseColor)
          }
        ),
        goon,
        state
      )
    ).resolves.toEqual(state)
  })

  it('keeps legacy ownership scoped to exact Base Color proof', async () => {
    const definition = parseSkinAppearanceDefinition(skinAppearance)
    const baseColor = upload('baseColor')
    const normal = upload('normal')
    let baseColorState = createDefaultSkinAppearanceState(definition)
    baseColorState = setCustomSkinSurfaceUpload(
      definition,
      baseColorState,
      'baseColor',
      baseColor
    )
    const mismatched = legacyBaseColorProof(baseColor)
    mismatched.skinMaterialArtwork.sha256 = 'f'.repeat(64)

    await expect(
      validateGoonSkinAppearanceState(
        reader(
          { skinAppearance },
          { 'upload:goon_skin_artwork:baseColor.png': mismatched }
        ),
        goon,
        baseColorState
      )
    ).rejects.toThrow(/does not match its ownership record/)

    let normalState = createDefaultSkinAppearanceState(definition)
    normalState = setCustomSkinSurfaceUpload(
      definition,
      normalState,
      'normal',
      normal
    )
    await expect(
      validateGoonSkinAppearanceState(
        reader(
          { skinAppearance },
          { 'upload:goon_skin_artwork:normal.png': legacyBaseColorProof(normal) }
        ),
        goon,
        normalState
      )
    ).rejects.toThrow(/does not match its ownership record/)
  })

  it('accepts null inheritance and rejects state for an unsupported package', async () => {
    const definition = parseSkinAppearanceDefinition(skinAppearance)
    const state = createDefaultSkinAppearanceState(definition)
    await expect(
      validateGoonSkinAppearanceState(reader({}), goon, null)
    ).resolves.toBeNull()
    await expect(
      validateGoonSkinAppearanceState(reader({}), goon, state)
    ).rejects.toThrow(/does not support Skin Appearance/)
  })

  it('retains read-only validation for legacy Base Color Recipe revisions', async () => {
    const definition = parseSkinAppearanceDefinition(skinAppearance)
    const baseColor = upload('baseColor')
    const legacyUpload = {
      ...baseColor,
      schemaVersion: 'skin-material-artwork/v1',
      canvas: {
        width: 4096,
        height: 4096,
        colorSpace: 'srgb',
        flipY: false
      }
    }
    const state = {
      schemaVersion: 'skin-material-artwork-state/v2',
      definitionSha256: definition.definitionSha256,
      baseColor: legacyUpload,
      tint: [1, 1, 1]
    }
    const legacyProof = {
      uploadType: 'goon_skin_artwork',
      mimetype: 'image/png',
      size: 100,
      skinMaterialArtwork: {
        schemaVersion: legacyUpload.schemaVersion,
        map: legacyUpload.map,
        definitionSha256: legacyUpload.definitionSha256,
        sha256: legacyUpload.sha256,
        canvas: legacyUpload.canvas,
        provenance: legacyUpload.provenance
      }
    }
    await expect(
      validateGoonLegacySkinMaterialArtworkState(
        reader(
          { skinAppearance },
          { 'upload:goon_skin_artwork:baseColor.png': legacyProof }
        ),
        goon,
        state
      )
    ).resolves.toEqual(state)
  })
})
