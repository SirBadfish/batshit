import { describe, expect, test } from 'vitest'

import {
  HAIR_ASSET_AUDIT_CONTRACT,
  HAIR_ASSET_CONTRACT,
  HAIR_FIT_RECEIPT_CONTRACT,
  HAIR_FOLLOWER_DECLARATION_CONTRACT,
  HAIR_MATERIAL_DECLARATION_CONTRACT,
  HAIR_PHYSICS_DECLARATION_CONTRACT,
  HAIR_REFIT_SOURCE_CONTRACT,
  collectHairAssetFileRefs,
  createHairState,
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  parseHairAsset,
  parseHairRefitSource,
  parseHairState,
  validateHairStateBinding,
  verifyHairAsset,
  type HairAssetSourceClass,
  type HairAssetV1
} from './hairAssets'

const ZERO_SHA256 = '0'.repeat(64)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

function file(prefix: string, name: string, sha256: string) {
  return {
    ref: `${prefix}${name}`,
    sha256,
    bytes: 1024,
    mimeType: name.endsWith('.glb') ? 'model/gltf-binary' : 'application/json'
  }
}

async function asset(sourceClass: HairAssetSourceClass = 'builtin'): Promise<HairAssetV1> {
  const prefix =
    sourceClass === 'builtin'
      ? '/goon-assets/hair/v1/style-01/'
      : '/uploads/goon_hair_assets/style-01/'
  const draft = {
    schemaVersion: HAIR_ASSET_CONTRACT,
    assetId: 'style-01',
    revisionId: 'style-01-r1',
    revision: 1,
    revisionSha256: ZERO_SHA256,
    sourceClass,
    display: {
      name: 'Style 01',
      previewImage: {
        ...file(prefix, 'preview.json', HASH_A),
        mimeType: 'application/json'
      },
      tags: ['anime', 'shaggy']
    },
    compatibility: {
      baseId: 'batshit-base-female',
      fitFamily: 'batshit-base-female-v1'
    },
    geometry: {
      main: file(prefix, 'hair.glb', HASH_B),
      sparseAccent: null
    },
    attachment: {
      headNode: 'head',
      authoredRootMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      fitReceipt: {
        contract: HAIR_FIT_RECEIPT_CONTRACT,
        receiptId: 'style-01-fit-r1',
        assetId: 'style-01',
        assetRevisionId: 'style-01-r1',
        assetRevisionSha256: ZERO_SHA256,
        baseId: 'batshit-base-female',
        fitFamily: 'batshit-base-female-v1',
        headAttachmentNode: 'head',
        appearanceDefinitionSha256: HASH_C,
        physicalBasisSha256: HASH_A,
        topologySha256: HASH_B,
        skeletonHierarchySha256: HASH_C,
        fitSha256: ZERO_SHA256
      }
    },
    material: {
      contract: HAIR_MATERIAL_DECLARATION_CONTRACT,
      status: 'pending' as const,
      definitionSha256: null,
      layout: null,
      neutralValueTexture: null,
      highlightMask: null,
      normalTexture: null,
      roughnessTexture: null,
      defaults: {
        baseColor: '#2a1738',
        highlightColor: '#6f4a8e',
        metalness: 0,
        roughness: 0.55,
        alphaMode: 'OPAQUE' as const
      }
    },
    follower: {
      contract: HAIR_FOLLOWER_DECLARATION_CONTRACT,
      mode: 'static' as const,
      definitionSha256: null,
      asset: null,
      staticReason: 'pending-h4-preview-only' as const
    },
    physics: {
      contract: HAIR_PHYSICS_DECLARATION_CONTRACT,
      mode: 'static' as const,
      definitionSha256: null,
      asset: null,
      staticReason: 'pending-h5-preview-only' as const
    },
    audit: {
      contract: HAIR_ASSET_AUDIT_CONTRACT,
      meshCount: 49,
      vertexCount: 15876,
      triangleCount: 26460,
      materialCount: 1,
      textureCount: 0,
      sparseAccent: false,
      receiptSha256: HASH_A
    },
    provenance: {
      author: sourceClass === 'builtin' ? 'Josh' : 'Local user',
      license: sourceClass === 'builtin' ? 'LicenseRef-Batshit-First-Party' : 'user-provided',
      sourceTool: 'Anime Hair Studio',
      sourceSha256: HASH_B,
      catalogEligible: sourceClass === 'builtin',
      productExportApproved: sourceClass === 'builtin'
    },
    receiptRefs: [file(prefix, 'creation-receipt.json', HASH_C)]
  }
  draft.revisionSha256 = await hairAssetRevisionSha256(draft)
  draft.attachment.fitReceipt.assetRevisionSha256 = draft.revisionSha256
  draft.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(draft.attachment.fitReceipt)
  return verifyHairAsset(draft)
}

describe('hair-assets/v1', () => {
  test.each(['builtin', 'user'] as const)(
    'uses the same immutable contract for %s revisions',
    async (sourceClass) => {
      const value = await asset(sourceClass)
      expect(value.sourceClass).toBe(sourceClass)
      expect(value.revisionSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(value.attachment.fitReceipt.assetRevisionSha256).toBe(value.revisionSha256)
      expect(await verifyHairAsset(structuredClone(value))).toEqual(value)
    }
  )

  test('rejects unknown fields and source paths outside the owned boundary', async () => {
    const value = await asset('user')
    expect(() => parseHairAsset({ ...value, filename: 'identity.glb' })).toThrow(
      'asset must contain exactly'
    )

    const escaped = structuredClone(value)
    escaped.geometry.main.ref = '/uploads/goons/not-hair.glb'
    expect(() => parseHairAsset(escaped)).toThrow(
      'user asset refs must remain under /uploads/goon_hair_assets/'
    )
  })

  test('rejects revision and fit-receipt tampering', async () => {
    const value = await asset()
    const revisionTamper = structuredClone(value)
    revisionTamper.display.name = 'Changed after hashing'
    await expect(verifyHairAsset(revisionTamper)).rejects.toThrow('asset revision hash mismatch')

    const fitTamper = structuredClone(value)
    fitTamper.attachment.fitReceipt.appearanceDefinitionSha256 = HASH_B
    await expect(verifyHairAsset(fitTamper)).rejects.toThrow('fit receipt hash mismatch')
  })

  test('normalizes full-precision attachment numbers before immutable hashing', async () => {
    const value = await asset('user')
    value.attachment.authoredRootMatrix = [
      1.0000001192092896,
      7.198165674182855e-11,
      9.222511998086658e-8,
      -0,
      -1.2383957222474875e-11,
      1.0000000273221477,
      -0.000020774660564493175,
      0,
      -9.222218899873071e-8,
      0.00002108229873099043,
      1.0000022292645545,
      0,
      4.233189798141136e-9,
      -1.4731680690987062,
      -0.04590650020980835,
      1
    ]
    value.revisionSha256 = ZERO_SHA256
    value.attachment.fitReceipt.assetRevisionSha256 = ZERO_SHA256
    value.attachment.fitReceipt.fitSha256 = ZERO_SHA256
    value.revisionSha256 = await hairAssetRevisionSha256(value)
    value.attachment.fitReceipt.assetRevisionSha256 = value.revisionSha256
    value.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(
      value.attachment.fitReceipt
    )

    const verified = await verifyHairAsset(value)

    expect(verified.attachment.authoredRootMatrix).toEqual([
      1.00000011920929,
      7.19816567418286e-11,
      9.22251199808666e-8,
      0,
      -1.23839572224749e-11,
      1.00000002732215,
      -0.0000207746605644932,
      0,
      -9.22221889987307e-8,
      0.0000210822987309904,
      1.00000222926455,
      0,
      4.23318979814114e-9,
      -1.47316806909871,
      -0.0459065002098083,
      1
    ])
    await expect(verifyHairAsset(structuredClone(verified))).resolves.toEqual(verified)
  })

  test('deduplicates shared immutable files but rejects conflicting metadata', async () => {
    const value = await asset()
    value.receiptRefs = [structuredClone(value.geometry.main)]
    expect(collectHairAssetFileRefs(value)).toHaveLength(2)

    value.receiptRefs[0].sha256 = HASH_A
    expect(() => collectHairAssetFileRefs(value)).toThrow('conflicting immutable metadata')
  })

  test('keeps the reusable source and saved fit in a separate authoring record', async () => {
    const source = parseHairRefitSource({
      contract: HAIR_REFIT_SOURCE_CONTRACT,
      assetId: 'style-01',
      revisionId: 'style-01-r1',
      source: file('/uploads/goon_hair_assets/style-01/', 'refit-source.glb', HASH_A),
      startingTransform: {
        move: { x: 0, y: 1.48, z: 0.04 },
        rotate: { x: 0, y: 0, z: 0 },
        uniformScale: 0.5,
        axisScale: { x: 1, y: 1, z: 1 }
      },
      savedTransform: {
        move: { x: 0, y: 1.65, z: 0.04 },
        rotate: { x: 0, y: -90, z: 0 },
        uniformScale: 0.27,
        axisScale: { x: 1.15, y: 1.15, z: 1.01 }
      }
    })

    expect(source.savedTransform.rotate.y).toBe(-90)
    expect(source.assetId).toBe('style-01')
    const value = await asset('user')
    expect(() => parseHairAsset({ ...value, refit: source })).toThrow('asset must contain exactly')
  })
})

describe('hair-state/v2', () => {
  test('stores None without inventing an asset identity', () => {
    expect(createHairState(null)).toEqual({
      schemaVersion: 'hair-state/v2',
      definitionSha256: null,
      selected: null,
      baseColor: '#2a1738',
      highlightColor: '#6f4a8e',
      motionSettings: null
    })
  })

  test('stores bounded per-Goon motion settings without changing the selected asset revision', async () => {
    const value = await asset()
    const state = createHairState(value, {
      motionSettings: {
        enabled: true,
        intensity: 1.1
      }
    })

    expect(parseHairState(state)).toMatchObject({
      definitionSha256: value.revisionSha256,
      selected: { assetRevisionSha256: value.revisionSha256 },
      motionSettings: {
        enabled: true,
        intensity: 1.1
      }
    })
    expect(() =>
      parseHairState({
        ...state,
        motionSettings: { enabled: true, intensity: 1.51 }
      })
    ).toThrow('intensity')
  })

  test('binds exact selection, colors, fit family, and Recipe definition', async () => {
    const value = await asset()
    const state = createHairState(value, {
      baseColor: '#101010',
      highlightColor: '#6f4a8e'
    })
    expect(parseHairState(state).selected?.assetRevisionSha256).toBe(value.revisionSha256)
    await expect(
      validateHairStateBinding({
        asset: value,
        state,
        recipeSource: {
          baseId: 'batshit-base-female',
          fitFamily: 'batshit-base-female-v1',
          definitionSha256: HASH_C,
          physicalBasisSha256: HASH_A,
          topologySha256: HASH_B,
          skeletonHierarchySha256: HASH_C
        }
      })
    ).resolves.toEqual({ asset: value, state })
  })

  test('fails loudly for missing, stale, or incompatible selection evidence', async () => {
    const value = await asset()
    const state = createHairState(value)
    const stale = structuredClone(state)
    stale.selected!.fitSha256 = HASH_A
    await expect(
      validateHairStateBinding({
        asset: value,
        state: stale,
        recipeSource: {
          baseId: 'batshit-base-female',
          fitFamily: 'batshit-base-female-v1',
          definitionSha256: HASH_C
        }
      })
    ).rejects.toThrow('does not bind the exact immutable asset revision and fit receipt')

    await expect(
      validateHairStateBinding({
        asset: value,
        state,
        recipeSource: {
          baseId: 'another-base',
          fitFamily: 'another-fit-family',
          definitionSha256: HASH_C,
          physicalBasisSha256: HASH_A,
          topologySha256: HASH_B,
          skeletonHierarchySha256: HASH_C
        }
      })
    ).rejects.toThrow('incompatible with this Recipe base or fit family')

    await expect(
      validateHairStateBinding({
        asset: value,
        state,
        recipeSource: {
          baseId: 'batshit-base-female',
          fitFamily: 'batshit-base-female-v1',
          definitionSha256: HASH_A,
          physicalBasisSha256: HASH_A,
          topologySha256: HASH_B,
          skeletonHierarchySha256: HASH_C
        }
      })
    ).rejects.toThrow('fit receipt is stale')

    await expect(
      validateHairStateBinding({
        asset: value,
        state,
        recipeSource: {
          baseId: 'batshit-base-female',
          fitFamily: 'batshit-base-female-v1',
          definitionSha256: HASH_C,
          physicalBasisSha256: HASH_B,
          topologySha256: HASH_B,
          skeletonHierarchySha256: HASH_C
        }
      })
    ).rejects.toThrow('fit receipt is stale')
  })
})
