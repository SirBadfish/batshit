import { describe, expect, it } from 'vitest'

import {
  createHairState,
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  verifyHairAsset,
  type HairAssetV1
} from './hairAssets'
import {
  HAIR_BUILTIN_CATALOG_CONTRACT,
  hairBuiltinRevisionRef,
  listCurrentHairBuiltinAssets,
  migrateHairBuiltinStateToCurrent,
  parseHairBuiltinCatalog,
  resolveHairBuiltinSelection,
  type HairBuiltinCatalogV2
} from './hairBuiltinCatalog'
import { HAIR_ROOT_WEIGHTED_MOTION_TAG } from './secondaryMotion'
import {
  createHairAssetFixture,
  createRigidHairGlbFixture
} from './recipe/fixtures/hairAssetFixture'
import { RECIPE_SOURCE_CONTRACT, type RecipeSourceIdentity } from './recipe/packageMetadata'
import type { RecipeSource } from './recipe/recipeContracts'

const ZERO = '0'.repeat(64)
const HASH_A = 'a'.repeat(64)

function sourceIdentity(overrides: Partial<RecipeSourceIdentity> = {}): RecipeSourceIdentity {
  return {
    contract: RECIPE_SOURCE_CONTRACT,
    schemaVersion: 1,
    baseId: 'batshit-base-female',
    fitFamily: 'batshit-base-female-v1',
    modelSha256: '1'.repeat(64),
    manifestSemanticSha256: '2'.repeat(64),
    definitionSha256: '3'.repeat(64),
    neutralId: 'batshit-base-female-neutral',
    neutralRecipeSha256: '4'.repeat(64),
    physicalBasisSha256: '5'.repeat(64),
    behaviorSha256: '6'.repeat(64),
    componentGraphSha256: '7'.repeat(64),
    topologySha256: '8'.repeat(64),
    skeletonHierarchySha256: '9'.repeat(64),
    ...overrides
  }
}

async function firstRevision(): Promise<HairAssetV1> {
  const source = sourceIdentity()
  return createHairAssetFixture({
    recipeSource: { identities: source } as RecipeSource,
    mainBytes: createRigidHairGlbFixture(),
    headNode: 'head',
    tags: [HAIR_ROOT_WEIGHTED_MOTION_TAG],
    physics: {
      bytes: new Uint8Array([1, 2, 3]),
      definitionSha256: HASH_A
    }
  })
}

async function successorRevision(
  source: HairAssetV1,
  options: { revision?: number; revisionId?: string; definitionSha256?: string } = {}
): Promise<HairAssetV1> {
  const next = structuredClone(source)
  next.revision = options.revision ?? source.revision + 1
  next.revisionId = options.revisionId ?? `${source.assetId}-r${next.revision}`
  next.attachment.fitReceipt.receiptId = `${source.assetId}-fit-r${next.revision}`
  next.attachment.fitReceipt.assetRevisionId = next.revisionId
  next.attachment.fitReceipt.appearanceDefinitionSha256 =
    options.definitionSha256 ?? String(next.revision).repeat(64).slice(0, 64)
  next.revisionSha256 = ZERO
  next.attachment.fitReceipt.assetRevisionSha256 = ZERO
  next.attachment.fitReceipt.fitSha256 = ZERO
  next.revisionSha256 = await hairAssetRevisionSha256(next)
  next.attachment.fitReceipt.assetRevisionSha256 = next.revisionSha256
  next.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(next.attachment.fitReceipt)
  return verifyHairAsset(next)
}

function manifest(assets: HairAssetV1[], current: HairAssetV1, edges: Array<[HairAssetV1, HairAssetV1]>) {
  return {
    schemaVersion: HAIR_BUILTIN_CATALOG_CONTRACT,
    assets,
    currentRevisions: [hairBuiltinRevisionRef(current)],
    successorEdges: edges.map(([from, to]) => ({
      from: hairBuiltinRevisionRef(from),
      to: hairBuiltinRevisionRef(to)
    }))
  }
}

describe('versioned built-in Hair catalog lifecycle', () => {
  it('retains historical revisions while exposing exactly the declared current revision', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1)
    const catalog = await parseHairBuiltinCatalog(manifest([r1, r2], r2, [[r1, r2]]))

    expect(catalog).toMatchObject({
      schemaVersion: HAIR_BUILTIN_CATALOG_CONTRACT,
      assets: [r1, r2]
    })
    expect(listCurrentHairBuiltinAssets(catalog)).toEqual([r2])
    expect(resolveHairBuiltinSelection(catalog, createHairState(r1).selected!)).toEqual(r1)
    expect(resolveHairBuiltinSelection(catalog, createHairState(r2).selected!)).toEqual(r2)
  })

  it('follows only declared successor edges and preserves palette plus motion settings exactly', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1)
    const r3 = await successorRevision(r2)
    const catalog = await parseHairBuiltinCatalog(
      manifest([r1, r2, r3], r3, [
        [r1, r2],
        [r2, r3]
      ])
    )
    const saved = createHairState(r1, {
      baseColor: '#123456',
      highlightColor: '#abcdef',
      motionSettings: { enabled: false, intensity: 0.42 }
    })

    const result = migrateHairBuiltinStateToCurrent(saved, catalog)

    expect(result.status).toBe('migrated')
    expect(result.path).toEqual([
      hairBuiltinRevisionRef(r1),
      hairBuiltinRevisionRef(r2),
      hairBuiltinRevisionRef(r3)
    ])
    expect(result.state).toEqual(
      createHairState(r3, {
        baseColor: '#123456',
        highlightColor: '#abcdef',
        motionSettings: { enabled: false, intensity: 0.42 }
      })
    )
  })

  it('does not migrate None, current built-ins, or user-import selection identities', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1)
    const catalog = await parseHairBuiltinCatalog(manifest([r1, r2], r2, [[r1, r2]]))

    const none = createHairState(null, {
      baseColor: '#123456',
      highlightColor: '#abcdef'
    })
    expect(migrateHairBuiltinStateToCurrent(none, catalog)).toMatchObject({
      status: 'none',
      state: none
    })

    const current = createHairState(r2, {
      baseColor: '#123456',
      highlightColor: '#abcdef',
      motionSettings: { enabled: true, intensity: 0.77 }
    })
    expect(migrateHairBuiltinStateToCurrent(current, catalog)).toMatchObject({
      status: 'current',
      state: current,
      sourceAsset: r2,
      targetAsset: r2
    })

    const userState = structuredClone(current)
    userState.selected!.assetId = 'user-imported-style'
    expect(migrateHairBuiltinStateToCurrent(userState, catalog)).toMatchObject({
      status: 'user-selection',
      state: userState,
      sourceAsset: null,
      targetAsset: null
    })
  })

  it('fails loudly for an unknown or tampered selection under a reserved built-in id', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1)
    const catalog = await parseHairBuiltinCatalog(manifest([r1, r2], r2, [[r1, r2]]))
    const unknown = createHairState(r1)
    unknown.selected!.assetRevisionId = 'h1-test-hair-r999'

    expect(() => migrateHairBuiltinStateToCurrent(unknown, catalog)).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_BUILTIN_SELECTION' })
    )

    const tampered = createHairState(r1)
    tampered.selected!.fitSha256 = 'f'.repeat(64)
    expect(() => migrateHairBuiltinStateToCurrent(tampered, catalog)).toThrowError(
      expect.objectContaining({ code: 'TAMPERED_BUILTIN_SELECTION' })
    )
  })

  it('rejects missing, ambiguous, cross-style, and tampered successor declarations', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1)

    await expect(parseHairBuiltinCatalog(manifest([r1, r2], r2, []))).rejects.toMatchObject({
      code: 'INVALID_CATALOG'
    })

    const ambiguous = manifest([r1, r2], r2, [
      [r1, r2],
      [r1, r2]
    ])
    await expect(parseHairBuiltinCatalog(ambiguous)).rejects.toMatchObject({
      code: 'INVALID_CATALOG'
    })

    const crossStyleR1 = structuredClone(r1)
    crossStyleR1.assetId = 'another-style'
    crossStyleR1.revisionId = 'another-style-r1'
    crossStyleR1.attachment.fitReceipt.assetId = crossStyleR1.assetId
    crossStyleR1.attachment.fitReceipt.assetRevisionId = crossStyleR1.revisionId
    crossStyleR1.revisionSha256 = ZERO
    crossStyleR1.attachment.fitReceipt.assetRevisionSha256 = ZERO
    crossStyleR1.attachment.fitReceipt.fitSha256 = ZERO
    crossStyleR1.revisionSha256 = await hairAssetRevisionSha256(crossStyleR1)
    crossStyleR1.attachment.fitReceipt.assetRevisionSha256 = crossStyleR1.revisionSha256
    crossStyleR1.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(
      crossStyleR1.attachment.fitReceipt
    )
    const other = await verifyHairAsset(crossStyleR1)
    await expect(
      parseHairBuiltinCatalog({
        schemaVersion: HAIR_BUILTIN_CATALOG_CONTRACT,
        assets: [other, r1, r2],
        currentRevisions: [hairBuiltinRevisionRef(other), hairBuiltinRevisionRef(r2)],
        successorEdges: [{ from: hairBuiltinRevisionRef(r1), to: hairBuiltinRevisionRef(other) }]
      })
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' })

    const tampered = manifest([r1, r2], r2, [[r1, r2]])
    tampered.successorEdges[0]!.to.revisionSha256 = 'f'.repeat(64)
    await expect(parseHairBuiltinCatalog(tampered)).rejects.toMatchObject({
      code: 'INVALID_CATALOG'
    })
  })

  it('rejects catalogs with a user-owned revision or more than one current revision per style', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1)
    const verifiedUser = await createHairAssetFixture({
      recipeSource: { identities: sourceIdentity() } as RecipeSource,
      mainBytes: createRigidHairGlbFixture(),
      headNode: 'head',
      sourceClass: 'user'
    })

    await expect(
      parseHairBuiltinCatalog({
        schemaVersion: HAIR_BUILTIN_CATALOG_CONTRACT,
        assets: [verifiedUser],
        currentRevisions: [hairBuiltinRevisionRef(verifiedUser)],
        successorEdges: []
      })
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' })

    await expect(
      parseHairBuiltinCatalog({
        ...manifest([r1, r2], r2, [[r1, r2]]),
        currentRevisions: [hairBuiltinRevisionRef(r1), hairBuiltinRevisionRef(r2)]
      } satisfies HairBuiltinCatalogV2)
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' })
  })
})
