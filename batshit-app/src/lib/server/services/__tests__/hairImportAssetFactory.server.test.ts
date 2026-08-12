import { describe, expect, it } from 'vitest'

import {
  createHairFollowerDefinitionFixture,
  createHairSecondaryMotionDefinitionFixture,
  createRootWeightedFollowerHairGlbFixture
} from '$lib/goons/recipe/fixtures/hairAssetFixture'
import { sha256Hex, type RecipeSource } from '$lib/goons/recipe'

import {
  buildImportedHairAsset,
  buildImportedHairRefitSource
} from '../hairImportAssetFactory.server'

const identity = {
  baseId: 'batshit-base-f-v1',
  fitFamily: 'batshit-base-f-v1',
  packageSha256: '1'.repeat(64),
  modelSha256: '2'.repeat(64),
  manifestSha256: '3'.repeat(64),
  definitionSha256: '4'.repeat(64),
  physicalBasisSha256: '5'.repeat(64),
  materialFamilySha256: '6'.repeat(64),
  uvLayoutSha256: '7'.repeat(64),
  topologySha256: '8'.repeat(64),
  skeletonHierarchySha256: '9'.repeat(64)
}

function file(
  role: string,
  mimeType: string,
  sha256 = role
    .padEnd(64, 'a')
    .slice(0, 64)
    .replace(/[^a-f0-9]/g, 'a')
) {
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'model/gltf-binary' ? 'glb' : 'json'
  return {
    uploadType: 'goon_hair_assets' as const,
    filename: `${role}.${ext}`,
    ref: `/uploads/goon_hair_assets/${role}.${ext}`,
    sha256,
    bytes: 128,
    mimeType
  }
}

describe('imported Hair Asset factory', () => {
  it('binds final geometry, follower, physics, material, fit, and provenance into one verified revision', async () => {
    const geometry = createRootWeightedFollowerHairGlbFixture()
    const geometrySha256 = await sha256Hex(geometry)
    const recipeSource = { identities: identity } as RecipeSource
    const followerDefinition = createHairFollowerDefinitionFixture({
      recipeSource,
      geometrySha256,
      headNode: 'Head'
    })
    const physicsDefinition = createHairSecondaryMotionDefinitionFixture({
      recipeSource,
      geometrySha256,
      motionNode: 'HairFollowerFixtureMotion',
      colliderNode: 'Head'
    })
    const asset = await buildImportedHairAsset({
      displayName: 'Imported Ponytail',
      assetId: 'h1-test-hair',
      revisionId: 'h1-test-hair-r1',
      revision: 1,
      recipeSource: identity,
      headNode: 'Head',
      authoredRootMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      sourceSha256: 'b'.repeat(64),
      sourceMode: 'generic-glb',
      author: 'Local user',
      license: 'User-provided source',
      followerDefinition,
      physicsDefinition,
      files: {
        geometry: file('geometry', 'model/gltf-binary', geometrySha256),
        followerDefinition: file('follower', 'application/json'),
        physicsDefinition: file('physics', 'application/json'),
        neutralValue: file('neutral', 'image/png'),
        highlightMask: file('highlight', 'image/png'),
        preview: file('preview', 'image/png'),
        importReceipt: file('receipt', 'application/json'),
        refitSource: file('refit-source', 'model/gltf-binary')
      },
      audit: {
        meshCount: 1,
        vertexCount: 3,
        triangleCount: 1,
        materialCount: 1
      }
    })

    expect(asset).toMatchObject({
      sourceClass: 'user',
      display: { name: 'Imported Ponytail' },
      geometry: { main: { sha256: geometrySha256 } },
      follower: { mode: 'appearance-followers/v2' },
      physics: { mode: 'secondary-motion/v1' },
      provenance: { catalogEligible: false, productExportApproved: false }
    })
    expect(asset.display.tags).toContain('root-weighted-motion-v2')
    expect(
      buildImportedHairRefitSource({
        assetId: asset.assetId,
        revisionId: asset.revisionId,
        source: file('refit-source', 'model/gltf-binary'),
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
    ).toMatchObject({
      assetId: asset.assetId,
      revisionId: asset.revisionId,
      savedTransform: { rotate: { y: -90 } }
    })
  })

  it('rejects generated definitions that bind another immutable identity', async () => {
    const geometry = createRootWeightedFollowerHairGlbFixture()
    const geometrySha256 = await sha256Hex(geometry)
    const recipeSource = { identities: identity } as RecipeSource
    const followerDefinition = createHairFollowerDefinitionFixture({
      recipeSource,
      geometrySha256,
      headNode: 'Head'
    })
    const physicsDefinition = createHairSecondaryMotionDefinitionFixture({
      recipeSource,
      geometrySha256,
      motionNode: 'HairFollowerFixtureMotion',
      colliderNode: 'Head'
    })
    followerDefinition.assetId = 'another-asset'

    await expect(
      buildImportedHairAsset({
        displayName: 'Bad binding',
        assetId: 'h1-test-hair',
        revisionId: 'h1-test-hair-r1',
        revision: 1,
        recipeSource: identity,
        headNode: 'Head',
        authoredRootMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        sourceSha256: 'b'.repeat(64),
        sourceMode: 'generic-glb',
        author: 'Local user',
        license: 'User-provided source',
        followerDefinition,
        physicsDefinition,
        files: {
          geometry: file('geometry', 'model/gltf-binary', geometrySha256),
          followerDefinition: file('follower', 'application/json'),
          physicsDefinition: file('physics', 'application/json'),
          neutralValue: file('neutral', 'image/png'),
          highlightMask: file('highlight', 'image/png'),
          preview: file('preview', 'image/png'),
          importReceipt: file('receipt', 'application/json'),
          refitSource: file('refit-source', 'model/gltf-binary')
        },
        audit: {
          meshCount: 1,
          vertexCount: 3,
          triangleCount: 1,
          materialCount: 1
        }
      })
    ).rejects.toThrow(/do not bind the final immutable ids/)
  })
})
