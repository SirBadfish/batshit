import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createHairState,
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  verifyHairAsset,
  type HairAssetV1
} from './hairAssets'
import {
  HAIR_BUILTIN_CATALOG_CONTRACT,
  HAIR_BUILTIN_FIT_CATALOG_CONTRACT,
  hairBuiltinRevisionRef,
  listCurrentHairBuiltinAssets,
  migrateHairBuiltinStateToCurrent,
  parseHairBuiltinCatalog,
  resolveHairBuiltinSelection,
  type HairBuiltinCatalogV2
} from './hairBuiltinCatalog'
import { HAIR_ROOT_WEIGHTED_MOTION_TAG } from './secondaryMotion'
import { projectBuiltinHairStyleCards } from './hairCatalog'
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

async function separateFit(source: HairAssetV1, target: RecipeSourceIdentity, revision: number) {
  const next = structuredClone(source)
  next.revision = revision
  next.revisionId = `${source.assetId}-r${revision}`
  next.compatibility = { baseId: target.baseId, fitFamily: target.fitFamily }
  Object.assign(next.attachment.fitReceipt, {
    receiptId: `${source.assetId}-fit-r${revision}`, assetRevisionId: next.revisionId,
    baseId: target.baseId, fitFamily: target.fitFamily,
    appearanceDefinitionSha256: target.definitionSha256, physicalBasisSha256: target.physicalBasisSha256,
    topologySha256: target.topologySha256, skeletonHierarchySha256: target.skeletonHierarchySha256,
    assetRevisionSha256: ZERO, fitSha256: ZERO
  })
  next.revisionSha256 = ZERO
  next.revisionSha256 = await hairAssetRevisionSha256(next)
  next.attachment.fitReceipt.assetRevisionSha256 = next.revisionSha256
  next.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(next.attachment.fitReceipt)
  return verifyHairAsset(next)
}

function sourceForFit(asset: HairAssetV1): RecipeSourceIdentity {
  const fit = asset.attachment.fitReceipt
  return sourceIdentity({ baseId: asset.compatibility.baseId, fitFamily: asset.compatibility.fitFamily,
    definitionSha256: fit.appearanceDefinitionSha256, physicalBasisSha256: fit.physicalBasisSha256,
    topologySha256: fit.topologySha256, skeletonHierarchySha256: fit.skeletonHierarchySha256 })
}

function fitManifest(assets: HairAssetV1[], current: HairAssetV1[], edges: Array<[HairAssetV1, HairAssetV1]>) {
  return { schemaVersion: HAIR_BUILTIN_FIT_CATALOG_CONTRACT, assets,
    currentRevisions: current.map(hairBuiltinRevisionRef),
    successorEdges: edges.map(([from, to]) => ({ from: hairBuiltinRevisionRef(from), to: hairBuiltinRevisionRef(to) })) }
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
  it('keeps the real Female r1 to r2 successor despite its changed exact fit hashes', async () => {
    const catalog = await parseHairBuiltinCatalog(JSON.parse(readFileSync(resolve(process.cwd(), 'static/goon-assets/hair/v2/catalog.json'), 'utf8')))
    const r1 = catalog.assets.find(asset => asset.assetId === 'batshit-style-01' && asset.revision === 1)!
    const r2 = catalog.assets.find(asset => asset.assetId === 'batshit-style-01' && asset.revision === 2)!
    expect(r1.attachment.fitReceipt.topologySha256).not.toBe(r2.attachment.fitReceipt.topologySha256)
    const state = createHairState(r1, { baseColor: '#123456', highlightColor: '#abcdef', motionSettings: { enabled: false, intensity: 0.42 } })
    const result = migrateHairBuiltinStateToCurrent(state, catalog, sourceForFit(r2))
    expect(result.status).toBe('migrated')
    expect(result.path).toEqual([hairBuiltinRevisionRef(r1), hairBuiltinRevisionRef(r2)])
    expect(result.state).toEqual(createHairState(r2, { baseColor: '#123456', highlightColor: '#abcdef', motionSettings: { enabled: false, intensity: 0.42 } }))
  })
  it('keeps two target fits under one style while preserving the established successor lineage', async () => {
    const femaleR1 = await firstRevision()
    const femaleR2 = await successorRevision(femaleR1, { definitionSha256: 'a'.repeat(64) })
    const maleSource = sourceIdentity({ baseId: 'base-male', fitFamily: 'fit-male', definitionSha256: 'b'.repeat(64), physicalBasisSha256: 'c'.repeat(64), topologySha256: 'd'.repeat(64), skeletonHierarchySha256: 'e'.repeat(64) })
    const maleR3 = await separateFit(femaleR1, maleSource, 3)
    const catalog = await parseHairBuiltinCatalog(fitManifest([femaleR1, femaleR2, maleR3], [femaleR2, maleR3], [[femaleR1, femaleR2]]))
    expect(listCurrentHairBuiltinAssets(catalog)).toEqual([femaleR2, maleR3])
    const old = createHairState(femaleR1, { baseColor: '#123456', highlightColor: '#abcdef', motionSettings: { enabled: false, intensity: 0.42 } })
    const unchanged = migrateHairBuiltinStateToCurrent(old, catalog, sourceForFit(femaleR1))
    expect(unchanged).toMatchObject({ status: 'current', state: old, targetAsset: femaleR1 })
    const migrated = migrateHairBuiltinStateToCurrent(old, catalog, sourceForFit(femaleR2))
    expect(migrated.status).toBe('migrated')
    expect(migrated.path).toEqual([hairBuiltinRevisionRef(femaleR1), hairBuiltinRevisionRef(femaleR2)])
    expect(migrated.state).toEqual(createHairState(femaleR2, { baseColor: '#123456', highlightColor: '#abcdef', motionSettings: { enabled: false, intensity: 0.42 } }))
    expect(() => migrateHairBuiltinStateToCurrent(old, catalog, maleSource)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SUCCESSOR' }))
    expect(() => migrateHairBuiltinStateToCurrent(old, catalog)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SUCCESSOR' }))
    expect(migrateHairBuiltinStateToCurrent(createHairState(maleR3), catalog, maleSource)).toMatchObject({ status: 'current', targetAsset: maleR3 })
  })

  it('keeps an older fit selectable while following its declared successor only for a matching Source update', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1, { definitionSha256: 'a'.repeat(64) })
    const maleSource = sourceIdentity({ baseId: 'base-male', fitFamily: 'fit-male', definitionSha256: 'c'.repeat(64) })
    const r3 = await separateFit(r1, maleSource, 3)
    const r4 = await successorRevision(r2, { revision: 4, definitionSha256: 'b'.repeat(64) })
    const catalog = await parseHairBuiltinCatalog(fitManifest(
      [r1, r2, r3, r4], [r2, r3, r4], [[r1, r2], [r2, r4]]
    ))
    const saved = createHairState(r2, {
      baseColor: '#123456', highlightColor: '#abcdef',
      motionSettings: { enabled: false, intensity: 0.42 }
    })
    const before = structuredClone(saved)
    const selectable = listCurrentHairBuiltinAssets(catalog)
    expect(selectable).toEqual([r2, r3, r4])
    for (const order of [selectable, [...selectable].reverse()]) {
      for (const asset of [r2, r3, r4]) {
        expect(projectBuiltinHairStyleCards(order, sourceForFit(asset))).toMatchObject([
          { asset, availability: { selectable: true } }
        ])
      }
    }
    expect(migrateHairBuiltinStateToCurrent(saved, catalog, sourceForFit(r2))).toMatchObject({
      status: 'current', state: before, targetAsset: r2, path: [hairBuiltinRevisionRef(r2)]
    })
    expect(migrateHairBuiltinStateToCurrent(createHairState(r1), catalog, sourceForFit(r2))).toMatchObject({
      status: 'migrated', targetAsset: r2, path: [hairBuiltinRevisionRef(r1), hairBuiltinRevisionRef(r2)]
    })
    expect(migrateHairBuiltinStateToCurrent(saved, catalog, sourceForFit(r4))).toMatchObject({
      status: 'migrated', targetAsset: r4,
      state: createHairState(r4, { baseColor: '#123456', highlightColor: '#abcdef', motionSettings: { enabled: false, intensity: 0.42 } }),
      path: [hairBuiltinRevisionRef(r2), hairBuiltinRevisionRef(r4)]
    })
    expect(migrateHairBuiltinStateToCurrent(createHairState(r1), catalog, sourceForFit(r4)).path).toEqual([
      hairBuiltinRevisionRef(r1), hairBuiltinRevisionRef(r2), hairBuiltinRevisionRef(r4)
    ])
    expect(() => migrateHairBuiltinStateToCurrent(saved, catalog)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SUCCESSOR' }))
    expect(() => migrateHairBuiltinStateToCurrent(saved, catalog, maleSource)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SUCCESSOR' }))
    expect(() => migrateHairBuiltinStateToCurrent(createHairState(r4), catalog, sourceForFit(r2))).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SUCCESSOR' }))
    expect(saved).toEqual(before)
  })

  it('validates the entire v3 chain even after an intermediate selectable fit', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1, { definitionSha256: 'a'.repeat(64) })
    const r4 = await successorRevision(r2, { revision: 4, definitionSha256: 'b'.repeat(64) })
    await expect(parseHairBuiltinCatalog(fitManifest([r1, r2, r4], [r2], [[r1, r2], [r2, r4]])))
      .rejects.toMatchObject({ code: 'INVALID_CATALOG' })
    await expect(parseHairBuiltinCatalog(fitManifest([r1, r2], [r2], [[r1, r2], [r2, r4]])))
      .rejects.toMatchObject({ code: 'INVALID_CATALOG' })
    await expect(parseHairBuiltinCatalog(fitManifest([r1, r2, r4], [r2, r4], [[r1, r2], [r2, r4], [r4, r2]])))
      .rejects.toMatchObject({ code: 'INVALID_CATALOG' })
    await expect(parseHairBuiltinCatalog(manifest([r1, r2, r4], r2, [[r1, r2], [r2, r4]])))
      .rejects.toMatchObject({ code: 'INVALID_CATALOG' })
  })

  it('refuses a matching but unready intermediate fit without changing the saved state', async () => {
    const r1 = await firstRevision()
    const candidate = await successorRevision(r1, { definitionSha256: 'a'.repeat(64) })
    const pending = structuredClone(candidate)
    Object.assign(pending.material, { status: 'pending', definitionSha256: null, layout: null,
      neutralValueTexture: null, highlightMask: null, normalTexture: null, roughnessTexture: null })
    pending.revisionSha256 = ZERO
    pending.attachment.fitReceipt.assetRevisionSha256 = ZERO
    pending.attachment.fitReceipt.fitSha256 = ZERO
    pending.revisionSha256 = await hairAssetRevisionSha256(pending)
    pending.attachment.fitReceipt.assetRevisionSha256 = pending.revisionSha256
    pending.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(pending.attachment.fitReceipt)
    const r2 = await verifyHairAsset(pending)
    const r4 = await successorRevision(r2, { revision: 4, definitionSha256: 'b'.repeat(64) })
    const catalog = await parseHairBuiltinCatalog(fitManifest([r1, r2, r4], [r2, r4], [[r1, r2], [r2, r4]]))
    const saved = createHairState(r1, { baseColor: '#123456', highlightColor: '#abcdef' })
    const before = structuredClone(saved)
    expect(() => migrateHairBuiltinStateToCurrent(saved, catalog, sourceForFit(r2)))
      .toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SUCCESSOR' }))
    expect(saved).toEqual(before)
  })

  it('rejects duplicate same-style target fits and cross-family successor edges', async () => {
    const femaleR1 = await firstRevision()
    const femaleR2 = await successorRevision(femaleR1)
    const sameFitR3 = await separateFit(femaleR1, sourceForFit(femaleR2), 3)
    await expect(parseHairBuiltinCatalog(fitManifest([femaleR1, femaleR2, sameFitR3], [femaleR2, sameFitR3], [[femaleR1, femaleR2]]))).rejects.toMatchObject({ code: 'INVALID_CATALOG' })
    const maleR3 = await separateFit(femaleR1, sourceIdentity({ baseId: 'base-male', fitFamily: 'fit-male' }), 3)
    await expect(parseHairBuiltinCatalog(fitManifest([femaleR1, femaleR2, maleR3], [maleR3], [[femaleR1, femaleR2], [femaleR2, maleR3]]))).rejects.toMatchObject({ code: 'INVALID_CATALOG' })
  })

  it('allows different styles to share a fit and revision number', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1)
    const other = structuredClone(r2)
    other.assetId = 'z-other-style'
    other.revisionId = 'z-other-style-r2'
    other.attachment.fitReceipt.assetId = other.assetId
    other.attachment.fitReceipt.assetRevisionId = other.revisionId
    other.attachment.fitReceipt.receiptId = 'z-other-style-fit-r2'
    other.revisionSha256 = ZERO
    other.attachment.fitReceipt.assetRevisionSha256 = ZERO
    other.attachment.fitReceipt.fitSha256 = ZERO
    other.revisionSha256 = await hairAssetRevisionSha256(other)
    other.attachment.fitReceipt.assetRevisionSha256 = other.revisionSha256
    other.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(other.attachment.fitReceipt)
    const verified = await verifyHairAsset(other)
    const catalog = await parseHairBuiltinCatalog(fitManifest([r1, r2, verified], [r2, verified], [[r1, r2]]))
    expect(listCurrentHairBuiltinAssets(catalog)).toEqual([r2, verified])
  })

  it('refuses a compatible terminal on another lineage without changing the saved state', async () => {
    const r1 = await firstRevision()
    const r2 = await successorRevision(r1)
    const separateTarget = sourceIdentity({ definitionSha256: 'b'.repeat(64) })
    const otherTerminal = await separateFit(r1, separateTarget, 3)
    const catalog = await parseHairBuiltinCatalog(fitManifest([r1, r2, otherTerminal], [r2, otherTerminal], [[r1, r2]]))
    const saved = createHairState(r1, { baseColor: '#123456', highlightColor: '#abcdef', motionSettings: { enabled: false, intensity: 0.42 } })
    const before = structuredClone(saved)
    expect(() => migrateHairBuiltinStateToCurrent(saved, catalog, separateTarget)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SUCCESSOR' }))
    expect(saved).toEqual(before)
  })
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
