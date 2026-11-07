import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertCanonicalInventory,
  assertNewBuiltinHairOutput,
  assertSafeBuiltinHairOutput,
  assertDeterministicAuthoringRuns,
  assertGenuineRefitEvidence,
  buildR2Asset,
  buildV2Catalog,
  isPathWithin,
  verifyExplicitRecipeSource
} from '../../../scripts/refit-builtin-hair-v38'
import {
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  verifyHairAsset,
  type HairAssetV1
} from './hairAssets'
import type { HairImportAuthoringResult } from './hairImportAuthoring'
import type { HairImportCanonicalizationV1 } from './hairImportIntake'
import { hairFollowerDefinitionSha256 } from './hairFollowers'
import { secondaryMotionDefinitionSha256 } from './secondaryMotion'
import { sha256Hex } from './recipe/recipeCanonical'
import {
  createHairAssetFixture,
  createRigidHairGlbFixture,
  createRootWeightedFollowerHairGlbFixture,
  createHairFollowerDefinitionFixture,
  createHairSecondaryMotionDefinitionFixture,
  HAIR_NEUTRAL_VALUE_PNG_FIXTURE,
  HAIR_HIGHLIGHT_MASK_PNG_FIXTURE
} from './recipe/fixtures/hairAssetFixture'
import { createRecipePhysicalMigrationFixture } from './recipe/fixtures/recipePhysicalMigrationPair'
import type { RecipeSource } from './recipe/recipeContracts'

const ZERO = '0'.repeat(64)

function result(byte = 1): HairImportAuthoringResult {
  return {
    geometryGlb: new Uint8Array([byte, 2, 3]),
    followerDefinition: { contract: 'follower-test', value: 1 },
    secondaryMotionDefinition: { contract: 'motion-test', value: 1 },
    proposal: { status: 'ready', confidence: 1 },
    evidence: { contract: 'evidence-test', geometry: byte }
  } as unknown as HairImportAuthoringResult
}

async function reseal(
  source: HairAssetV1,
  input: { assetId: string; revision: number; sourceClass?: 'builtin' | 'user' }
): Promise<HairAssetV1> {
  const next = structuredClone(source)
  next.assetId = input.assetId
  next.revision = input.revision
  next.revisionId = `${input.assetId}-r${input.revision}`
  next.sourceClass = input.sourceClass ?? 'builtin'
  next.attachment.fitReceipt.receiptId = `${input.assetId}-fit-r${input.revision}`
  next.attachment.fitReceipt.assetId = input.assetId
  next.attachment.fitReceipt.assetRevisionId = next.revisionId
  next.provenance.catalogEligible = next.sourceClass === 'builtin'
  next.provenance.productExportApproved = next.sourceClass === 'builtin'
  next.revisionSha256 = ZERO
  next.attachment.fitReceipt.assetRevisionSha256 = ZERO
  next.attachment.fitReceipt.fitSha256 = ZERO
  next.revisionSha256 = await hairAssetRevisionSha256(next)
  next.attachment.fitReceipt.assetRevisionSha256 = next.revisionSha256
  next.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(next.attachment.fitReceipt)
  return verifyHairAsset(next)
}

describe('deterministic built-in Hair r2 refit publication tool', () => {
  it('builds a new source-bound revision without changing the default r2 path or artwork', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    let source = await createHairAssetFixture({ recipeSource: fixture.source.recipeSource,
      mainBytes: createRigidHairGlbFixture(), headNode: 'HeadAnchor' })
    const acceptedReceipt = new TextEncoder().encode('{"fixture":"accepted"}\n')
    const preview = HAIR_NEUTRAL_VALUE_PNG_FIXTURE
    source.display.previewImage = { ref: '/goon-assets/hair/v1/h1-test-fixture/preview.png',
      sha256: await sha256Hex(preview), bytes: preview.length, mimeType: 'image/png' }
    source.receiptRefs = [{ ref: '/goon-assets/hair/v1/h1-test-fixture/accepted-source-receipt.json',
      sha256: await sha256Hex(acceptedReceipt), bytes: acceptedReceipt.length, mimeType: 'application/json' }]
    source = await reseal(source, { assetId: source.assetId, revision: 1 })
    const geometry = createRootWeightedFollowerHairGlbFixture()
    const geometrySha256 = await sha256Hex(geometry)
    const makeResult = async (revision: number) => {
      const follower = createHairFollowerDefinitionFixture({ recipeSource: fixture.target.recipeSource, geometrySha256, headNode: 'HeadAnchor' })
      follower.assetId = source.assetId; follower.revisionId = `${source.assetId}-r${revision}`
      const physics = createHairSecondaryMotionDefinitionFixture({ recipeSource: fixture.target.recipeSource, geometrySha256, motionNode: 'HairMotionRoot', colliderNode: 'HeadAnchor' })
      physics.owner.assetId = source.assetId; physics.owner.revisionId = `${source.assetId}-r${revision}`
      return { geometryGlb: geometry, followerDefinition: follower, secondaryMotionDefinition: physics, proposal: {},
        evidence: { recipeSourceSha256: fixture.target.identity.modelSha256, appearanceDefinitionSha256: fixture.target.identity.definitionSha256,
          outputGeometrySha256: geometrySha256, followerDefinitionSha256: await hairFollowerDefinitionSha256(follower),
          secondaryMotionDefinitionSha256: await secondaryMotionDefinitionSha256(physics), meshCount: 1, vertexCount: 3 } } as HairImportAuthoringResult
    }
    const copied = { preview, neutralValue: HAIR_NEUTRAL_VALUE_PNG_FIXTURE,
      highlightMask: HAIR_HIGHLIGHT_MASK_PNG_FIXTURE, acceptedSourceReceipt: acceptedReceipt }
    const r2Input = { sourceAsset: source, targetDirectory: 'fixture-r2', recipeSource: fixture.target.identity,
      authoredRootMatrix: source.attachment.authoredRootMatrix, result: await makeResult(2),
      topology: { meshCount: 1, vertexCount: 3, triangleCount: 1 }, copied, refitReceiptBytes: acceptedReceipt }
    expect(await buildR2Asset(r2Input)).toEqual(await buildR2Asset({ ...r2Input, targetRevision: 2 }))
    const r3 = await buildR2Asset({ ...r2Input, targetDirectory: 'fixture-r3', targetRevision: 3, result: await makeResult(3) })
    expect(r3).toMatchObject({ assetId: source.assetId, revisionId: `${source.assetId}-r3`, revision: 3,
      compatibility: { baseId: fixture.target.identity.baseId, fitFamily: fixture.target.identity.fitFamily } })
    expect(r3.material.layout).toEqual(source.material.layout)
    expect(r3.material.defaults).toEqual(source.material.defaults)
    expect(r3.material.neutralValueTexture?.sha256).toBe(source.material.neutralValueTexture?.sha256)
    expect(r3.material.highlightMask?.sha256).toBe(source.material.highlightMask?.sha256)
    await expect(buildR2Asset({ ...r2Input, targetDirectory: 'fixture-r3', targetRevision: 3 })).rejects.toThrow(/different Hair revision|different Hair Asset/)
    await expect(buildR2Asset({ ...r2Input, copied: { ...copied, neutralValue: new Uint8Array([1]) } })).rejects.toThrow('accepted artwork or source receipt')
    await expect(buildR2Asset({ ...r2Input, targetRevision: 0 })).rejects.toThrow('new stable identity')
  })
  it('recognizes equal and descendant paths without treating siblings as contained', () => {
    expect(isPathWithin('/workspace/hair/v1', '/workspace/hair/v1')).toBe(true)
    expect(isPathWithin('/workspace/hair/v1', '/workspace/hair/v1/new-candidate')).toBe(true)
    expect(isPathWithin('/workspace/hair', '/workspace/hair/v1')).toBe(true)
    expect(isPathWithin('/workspace/hair/v1', '/workspace/hair/v10')).toBe(false)
    expect(isPathWithin('/workspace/hair/v1', '/workspace/other')).toBe(false)
  })

  it('refuses protected-tree ancestors, descendants and symlink aliases before staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'batshit-hair-stage-'))
    try {
      const protectedRoot = join(root, 'hair', 'v1')
      await mkdir(protectedRoot, { recursive: true })
      await symlink(protectedRoot, join(root, 'alias'), 'dir')
      await symlink(join(root, 'missing-target'), join(root, 'dangling'), 'dir')
      await expect(assertSafeBuiltinHairOutput(protectedRoot, protectedRoot)).rejects.toThrow('overlap')
      await expect(assertSafeBuiltinHairOutput(join(protectedRoot, 'candidate'), protectedRoot)).rejects.toThrow('overlap')
      await expect(assertSafeBuiltinHairOutput(join(root, 'hair'), protectedRoot)).rejects.toThrow('overlap')
      await expect(assertSafeBuiltinHairOutput(join(root, 'alias', 'candidate'), protectedRoot)).rejects.toThrow('overlap')
      await expect(assertSafeBuiltinHairOutput(join(root, 'dangling'), protectedRoot)).rejects.toThrow('unresolved existing entry')
      await expect(assertSafeBuiltinHairOutput(join(root, 'dangling', 'candidate'), protectedRoot)).rejects.toThrow('unresolved existing entry')
      await expect(assertNewBuiltinHairOutput(join(root, 'dangling'))).rejects.toThrow('already exists')
      await expect(assertNewBuiltinHairOutput(join(root, 'new-candidate'))).resolves.toBeUndefined()
      await expect(assertSafeBuiltinHairOutput(join(root, 'hair', 'v10', 'candidate'), protectedRoot)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('accepts only a byte-identical explicit Recipe Source archive/model/manifest with pinned identity', async () => {
    const fixture = await createRecipePhysicalMigrationFixture({ hairImportCompatible: true })
    const target = fixture.target

    await expect(
      verifyExplicitRecipeSource({
        archiveBytes: target.packageBytes,
        modelBytes: target.glbBytes,
        manifestBytes: target.manifestBytes,
        expectedModelSha256: target.identity.modelSha256,
        expectedDefinitionSha256: target.identity.definitionSha256
      })
    ).resolves.toMatchObject({ identity: target.identity })

    const driftedModel = Uint8Array.from(target.glbBytes)
    driftedModel[driftedModel.length - 1] ^= 1
    await expect(
      verifyExplicitRecipeSource({
        archiveBytes: target.packageBytes,
        modelBytes: driftedModel,
        manifestBytes: target.manifestBytes,
        expectedModelSha256: target.identity.modelSha256,
        expectedDefinitionSha256: target.identity.definitionSha256
      })
    ).rejects.toThrow('explicit model bytes do not match avatar.glb')
  })

  it('fails loudly on canonical topology drift', () => {
    const canonical = {
      geometry: { meshCount: 49, vertexCount: 14651, triangleCount: 25480 }
    } as HairImportCanonicalizationV1
    expect(() =>
      assertCanonicalInventory(
        canonical,
        { meshCount: 49, vertexCount: 14651, triangleCount: 25481 },
        'Shaggy'
      )
    ).toThrow('canonical triangleCount drifted')
  })

  it('requires byte-for-byte deterministic independent authoring runs', async () => {
    await expect(assertDeterministicAuthoringRuns(result(), result(), 'Shaggy')).resolves.toEqual(
      result()
    )
    await expect(assertDeterministicAuthoringRuns(result(), result(9), 'Shaggy')).rejects.toThrow(
      'refit is nondeterministic: geometry differs across runs'
    )
  })

  it('rejects unchanged geometry and evidence bound to any other Recipe identity', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const identity = fixture.target.identity
    const evidence = {
      ...result().evidence,
      inputHairSha256: 'a'.repeat(64),
      recipeSourceSha256: identity.modelSha256,
      appearanceDefinitionSha256: identity.definitionSha256,
      outputGeometrySha256: 'a'.repeat(64),
      meshCount: 2,
      vertexCount: 9
    } as HairImportAuthoringResult['evidence']
    expect(() =>
      assertGenuineRefitEvidence({
        context: 'Bun',
        evidence,
        canonicalSha256: 'a'.repeat(64),
        r1GeometrySha256: 'b'.repeat(64),
        recipeSource: identity,
        topology: { meshCount: 2, vertexCount: 9, triangleCount: 3 }
      })
    ).toThrow('unchanged/non-refitted geometry')

    expect(() =>
      assertGenuineRefitEvidence({
        context: 'Bun',
        evidence: { ...evidence, outputGeometrySha256: 'c'.repeat(64), recipeSourceSha256: 'd'.repeat(64) },
        canonicalSha256: 'a'.repeat(64),
        r1GeometrySha256: 'b'.repeat(64),
        recipeSource: identity,
        topology: { meshCount: 2, vertexCount: 9, triangleCount: 3 }
      })
    ).toThrow('does not bind the explicit Recipe Source')
  })

  it('retains r1 history, declares one r2 successor per style, and rejects imported interference', async () => {
    const recipeFixture = await createRecipePhysicalMigrationFixture()
    const base = await createHairAssetFixture({
      recipeSource: { identities: recipeFixture.target.identity } as RecipeSource,
      mainBytes: createRigidHairGlbFixture(),
      headNode: 'head'
    })
    const r1a = await reseal(base, { assetId: 'batshit-style-01', revision: 1 })
    const r1b = await reseal(base, { assetId: 'batshit-style-02', revision: 1 })
    const r2a = await reseal(r1a, { assetId: 'batshit-style-01', revision: 2 })
    const r2b = await reseal(r1b, { assetId: 'batshit-style-02', revision: 2 })
    const catalog = await buildV2Catalog([r1a, r1b], [r2a, r2b])

    expect(catalog.assets.map((asset) => asset.revisionId)).toEqual([
      'batshit-style-01-r1',
      'batshit-style-01-r2',
      'batshit-style-02-r1',
      'batshit-style-02-r2'
    ])
    expect(catalog.successorEdges).toHaveLength(2)
    expect(catalog.currentRevisions.map((entry) => entry.revision)).toEqual([2, 2])

    const imported = structuredClone(r2b)
    imported.sourceClass = 'user'
    await expect(buildV2Catalog([r1a, r1b], [r2a, imported])).rejects.toThrow(
      'user-imported Hair cannot enter or interfere'
    )
  })
})
