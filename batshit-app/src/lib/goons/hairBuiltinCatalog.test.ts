import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectHairAssetFileRefs, verifyHairAsset, type HairAssetV1 } from './hairAssets'
import { classifyHairAssetAvailability } from './hairCatalog'
import { verifyHairFollowerDefinitionBytes } from './hairFollowers'
import { inspectHairMaterialPng } from './hairMaterial'
import { RECIPE_SOURCE_CONTRACT } from './recipe/packageMetadata'
import { sha256Hex } from './recipe/recipeCanonical'
import { decodeSemanticGlbAccessor, parseSemanticGlb } from './recipe/semanticGlb'
import {
  HAIR_MOTION_WEIGHT_CURVE,
  HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
  HAIR_ROOT_WEIGHTED_MOTION_TAG,
  HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
  verifyHairSecondaryMotionDefinitionBytes
} from './secondaryMotion'

type PromotionReceipt = {
  contract: string
  acceptedSource: { revisionSha256: string }
  rights: { approved: boolean; planAtGeneration?: string }
  geometryPromotion: {
    normalizedMotionMetadataNodeCount: number
    normalizedMotionWeightVertexCount: number
    meshPositionsIndicesAndTopologyPreserved: boolean
  }
}

const GLTF_ROOT_WEIGHTED_TIP_ATTRIBUTE = '_BATSHAIR_TIP'

const EXPECTED = {
  'batshit-style-01': {
    revisionId: 'batshit-style-01-r1',
    revisionSha256: '9c78aa4a29f14a4e6005b887348bbab945df77124f61b03b8266cfa28c420d6e',
    geometrySha256: 'b0246684f0d02ccbfde2e701e4ec38c629a8a103f8d2841d12297941021250d2',
    sourceSha256: 'ab4e8c9737da31f10921a35a1dfe8875864a713d01a2ed99ea99a237ae4f9168',
    acceptedSourceRevisionSha256:
      '0cff598fd0d93bd40b2ea80be15e9529cb6b7dbe66d4a815c6268e0164127efe',
    chainCount: 49,
    anchoredLength: 0.6,
    defaultIntensity: 0.65,
    planAtGeneration: undefined
  },
  'batshit-style-02': {
    revisionId: 'batshit-style-02-r1',
    revisionSha256: 'd647f03c9737c942c55f0d2d6c153cb183a7c5c76151309eb54cf33b6aa041c9',
    geometrySha256: '3c7d16f32f364537bf0c9db0d0ba79a43ecdfa9897245ef6f45bf7121b2e2619',
    sourceSha256: 'a4c0baab026f09b437c4e3e4f36c9f106ee35bffffb2662cd2435b390a4be84c',
    acceptedSourceRevisionSha256:
      'dcb9db49676c7391e47c01a37633256288012252629dfcba9e1c745e59e2e7a5',
    chainCount: 2,
    anchoredLength: 0.5,
    defaultIntensity: 1,
    planAtGeneration: 'Pro Plan'
  }
} as const

function staticPath(ref: string) {
  expect(ref).toMatch(/^\/goon-assets\/hair\/v1\//)
  return resolve(process.cwd(), 'static', ref.slice(1))
}

async function fileBytes(ref: string) {
  return new Uint8Array(await readFile(staticPath(ref)))
}

describe('built-in Hair catalog', () => {
  it('ships the two exact accepted H9 proving revisions with complete immutable files', async () => {
    const catalogPath = resolve(process.cwd(), 'static/goon-assets/hair/v1/catalog.json')
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      schemaVersion: string
      assets: unknown[]
    }
    expect(catalog.schemaVersion).toBe('hair-catalog/v1')
    expect(catalog.assets).toHaveLength(2)

    const assets = await Promise.all(catalog.assets.map((value) => verifyHairAsset(value)))
    expect(assets.map((asset) => asset.assetId)).toEqual(Object.keys(EXPECTED))

    for (const asset of assets) {
      const expected = EXPECTED[asset.assetId as keyof typeof EXPECTED]
      expect(expected).toBeDefined()
      expect(asset).toMatchObject({
        sourceClass: 'builtin',
        revisionId: expected.revisionId,
        revisionSha256: expected.revisionSha256,
        geometry: { main: { sha256: expected.geometrySha256 } },
        provenance: {
          license: 'LicenseRef-Batshit-First-Party',
          sourceSha256: expected.sourceSha256,
          catalogEligible: true,
          productExportApproved: true
        }
      })
      expect(asset.display.tags).toContain(HAIR_ROOT_WEIGHTED_MOTION_TAG)
      expect(
        classifyHairAssetAvailability(asset, {
          contract: RECIPE_SOURCE_CONTRACT,
          schemaVersion: 1,
          baseId: asset.compatibility.baseId,
          fitFamily: asset.compatibility.fitFamily,
          modelSha256: '0'.repeat(64),
          manifestSemanticSha256: '0'.repeat(64),
          definitionSha256: asset.attachment.fitReceipt.appearanceDefinitionSha256,
          neutralId: 'catalog-test-neutral',
          neutralRecipeSha256: '0'.repeat(64),
          physicalBasisSha256: asset.attachment.fitReceipt.physicalBasisSha256,
          behaviorSha256: '0'.repeat(64),
          componentGraphSha256: '0'.repeat(64),
          topologySha256: asset.attachment.fitReceipt.topologySha256,
          skeletonHierarchySha256: asset.attachment.fitReceipt.skeletonHierarchySha256
        })
      ).toEqual({ status: 'ready', selectable: true, label: 'Ready', message: null })

      const refs = collectHairAssetFileRefs(asset)
      for (const ref of refs) {
        const bytes = await fileBytes(ref.ref)
        expect(bytes.byteLength, ref.ref).toBe(ref.bytes)
        expect(await sha256Hex(bytes), ref.ref).toBe(ref.sha256)
      }

      const follower = await verifyHairFollowerDefinitionBytes(
        asset,
        await fileBytes(asset.follower.asset!.ref)
      )
      const physics = await verifyHairSecondaryMotionDefinitionBytes(
        asset,
        await fileBytes(asset.physics.asset!.ref)
      )
      expect(follower).toMatchObject({ assetId: asset.assetId, revisionId: asset.revisionId })
      expect(physics.owner).toMatchObject({
        assetId: asset.assetId,
        revisionId: asset.revisionId
      })
      expect(physics.chains).toHaveLength(expected.chainCount)

      const geometry = parseSemanticGlb(await fileBytes(asset.geometry.main.ref))
      const weightedNodes = geometry.nodes.flatMap((node) => {
        const extras = node.extras as Record<string, unknown> | undefined
        const metadata = extras?.batshitHairRootWeightedMotion
        return metadata === undefined ? [] : [metadata as Record<string, unknown>]
      })
      expect(weightedNodes).toHaveLength(expected.chainCount)
      for (const metadata of weightedNodes) {
        expect(Object.keys(metadata).sort()).toEqual(
          [
            'anchoredLength',
            'contract',
            'defaultEnabled',
            'defaultIntensity',
            'dynamicJointSlot',
            'meshNode',
            'tipAttribute',
            'weightCurve'
          ].sort()
        )
        expect(metadata).toMatchObject({
          contract: HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
          tipAttribute: HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
          anchoredLength: expected.anchoredLength,
          weightCurve: HAIR_MOTION_WEIGHT_CURVE,
          defaultEnabled: true,
          defaultIntensity: expected.defaultIntensity
        })
      }

      const weightedMeshNames = new Set(
        weightedNodes.map((metadata) => metadata.meshNode as string)
      )
      let validatedWeightVertices = 0
      for (const node of geometry.nodes) {
        if (
          node.mesh === undefined ||
          typeof node.name !== 'string' ||
          !weightedMeshNames.has(node.name)
        ) {
          continue
        }
        const mesh = geometry.meshes[node.mesh as number]!
        for (const primitive of mesh.primitives as Array<Record<string, unknown>>) {
          const attributes = primitive.attributes as Record<string, unknown>
          const weights = decodeSemanticGlbAccessor(geometry, attributes.WEIGHTS_0)
          const tips = decodeSemanticGlbAccessor(
            geometry,
            attributes[GLTF_ROOT_WEIGHTED_TIP_ATTRIBUTE]
          )
          expect(weights.type).toBe('VEC4')
          expect(weights.componentType).toBe(5126)
          expect(tips.type).toBe('SCALAR')
          expect(tips.componentType).toBe(5126)
          expect(weights.count).toBe(tips.count)
          for (let vertex = 0; vertex < weights.count; vertex += 1) {
            const offset = vertex * 4
            expect(weights.values[offset]).toBeCloseTo(1 - tips.values[vertex]!, 6)
            expect(weights.values[offset + 1]).toBeCloseTo(tips.values[vertex]!, 6)
            expect(weights.values[offset + 2]).toBe(0)
            expect(weights.values[offset + 3]).toBe(0)
          }
          validatedWeightVertices += weights.count
        }
      }
      expect(validatedWeightVertices).toBeGreaterThan(0)

      inspectHairMaterialPng(
        await fileBytes(asset.material.neutralValueTexture!.ref),
        asset.material,
        'neutral-value'
      )
      inspectHairMaterialPng(
        await fileBytes(asset.material.highlightMask!.ref),
        asset.material,
        'highlight-mask'
      )

      const promotionRef = asset.receiptRefs.find((ref) =>
        ref.ref.endsWith('/promotion-receipt.json')
      )
      expect(promotionRef).toBeDefined()
      const receipt = JSON.parse(
        new TextDecoder().decode(await fileBytes(promotionRef!.ref))
      ) as PromotionReceipt
      expect(receipt.contract).toBe('hair-catalog-promotion-receipt/v1')
      expect(receipt.acceptedSource.revisionSha256).toBe(
        expected.acceptedSourceRevisionSha256
      )
      expect(receipt.rights.approved).toBe(true)
      expect(receipt.rights.planAtGeneration).toBe(expected.planAtGeneration)
      expect(receipt.geometryPromotion).toMatchObject({
        normalizedMotionMetadataNodeCount:
          asset.assetId === 'batshit-style-01' ? expected.chainCount : 0,
        normalizedMotionWeightVertexCount:
          asset.assetId === 'batshit-style-01' ? validatedWeightVertices : 0,
        meshPositionsIndicesAndTopologyPreserved: true
      })
    }
  })
})
