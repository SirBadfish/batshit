import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createHairState, hairAssetRevisionSha256, hairFitReceiptSha256, verifyHairAsset, type HairAssetV1 } from './hairAssets'
import {
  classifyHairAssetAvailability,
  createHairCatalogSelection,
  loadHairAssetCatalog,
  projectBuiltinHairStyleCards,
  resolveHairAssetBrowserUrl,
  resolveHairSelectionCatalogStatus
} from './hairCatalog'
import {
  createHairAssetFixture,
  createRigidHairGlbFixture
} from './recipe/fixtures/hairAssetFixture'
import { RECIPE_SOURCE_CONTRACT, type RecipeSourceIdentity } from './recipe/packageMetadata'
import type { RecipeSource } from './recipe/recipeContracts'

const hash = (value: string) => value.repeat(64)

function sourceIdentity(overrides: Partial<RecipeSourceIdentity> = {}): RecipeSourceIdentity {
  return {
    contract: RECIPE_SOURCE_CONTRACT,
    schemaVersion: 1,
    baseId: 'batshit-base-female',
    fitFamily: 'batshit-base-female-v1',
    modelSha256: hash('1'),
    manifestSemanticSha256: hash('2'),
    definitionSha256: hash('3'),
    neutralId: 'batshit-base-female-neutral',
    neutralRecipeSha256: hash('4'),
    physicalBasisSha256: hash('5'),
    behaviorSha256: hash('6'),
    componentGraphSha256: hash('7'),
    topologySha256: hash('8'),
    skeletonHierarchySha256: hash('9'),
    ...overrides
  }
}

async function assetFixture(source = sourceIdentity()) {
  return createHairAssetFixture({
    recipeSource: { identities: source } as RecipeSource,
    mainBytes: createRigidHairGlbFixture(),
    headNode: 'head'
  })
}

async function fittedVariant(source: RecipeSourceIdentity, revision: number, label: string, pending = false) {
  const asset = await assetFixture(source)
  asset.revision = revision
  asset.revisionId = `${asset.assetId}-r${revision}`
  asset.display.tags = [label]
  if (pending) Object.assign(asset.material, { status: 'pending', definitionSha256: null, layout: null,
    neutralValueTexture: null, highlightMask: null, normalTexture: null, roughnessTexture: null })
  asset.attachment.fitReceipt.receiptId = `${asset.assetId}-fit-r${revision}`
  asset.attachment.fitReceipt.assetRevisionId = asset.revisionId
  asset.revisionSha256 = hash('0')
  asset.attachment.fitReceipt.assetRevisionSha256 = hash('0')
  asset.attachment.fitReceipt.fitSha256 = hash('0')
  asset.revisionSha256 = await hairAssetRevisionSha256(asset)
  asset.attachment.fitReceipt.assetRevisionSha256 = asset.revisionSha256
  asset.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(asset.attachment.fitReceipt)
  return verifyHairAsset(asset)
}

describe('Hair catalog product helpers', () => {
  it('projects one style card to the unique matching fit without using style labels as permission', async () => {
    const female = sourceIdentity()
    const male = sourceIdentity({ baseId: 'base-male', fitFamily: 'fit-male', definitionSha256: hash('a') })
    const femaleFit = await fittedVariant(female, 1, 'masculine')
    const maleFit = await fittedVariant(male, 2, 'feminine')
    const candidates = [femaleFit, maleFit]
    expect(projectBuiltinHairStyleCards(candidates, female)).toEqual([{ asset: femaleFit, availability: classifyHairAssetAvailability(femaleFit, female) }])
    expect(projectBuiltinHairStyleCards(candidates, male)).toEqual([{ asset: maleFit, availability: classifyHairAssetAvailability(maleFit, male) }])
    const absent = projectBuiltinHairStyleCards(candidates, sourceIdentity({ baseId: 'other' }))
    expect(absent).toHaveLength(1)
    expect(absent[0]!.availability.selectable).toBe(false)
    const olderMale = { ...male, definitionSha256: hash('f') }
    for (const order of [candidates, [...candidates].reverse()]) {
      expect(projectBuiltinHairStyleCards(order, olderMale)).toMatchObject([{ asset: maleFit, availability: { status: 'stale-fit', selectable: false } }])
    }
    const duplicate = await fittedVariant(male, 3, 'another-style-label')
    expect(projectBuiltinHairStyleCards([maleFit, duplicate], male)[0]!.availability).toMatchObject({ status: 'ambiguous-fit', selectable: false })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ assets: [maleFit, duplicate], retainedBuiltinAssets: [], refitSources: [] }), { status: 200 }))
    await expect(loadHairAssetCatalog(fetcher as typeof fetch)).rejects.toThrow('ambiguous current fits')
    const unready = await fittedVariant(male, 4, 'feminine', true)
    expect(projectBuiltinHairStyleCards([femaleFit, unready], male)).toMatchObject([{ asset: unready, availability: { status: 'material-pending', selectable: false } }])
    expect(projectBuiltinHairStyleCards([maleFit, unready], male)[0]!.availability).toMatchObject({ status: 'ambiguous-fit', selectable: false })
    const duplicateWithUnready = vi.fn(async () => new Response(JSON.stringify({ assets: [maleFit, unready], retainedBuiltinAssets: [], refitSources: [] }), { status: 200 }))
    await expect(loadHairAssetCatalog(duplicateWithUnready as typeof fetch)).rejects.toThrow('ambiguous current fits')
    const savedMale = createHairState(maleFit, { baseColor: '#123456', highlightColor: '#abcdef' })
    const savedBefore = JSON.stringify(savedMale)
    expect(resolveHairSelectionCatalogStatus(savedMale, [femaleFit])).toMatchObject({ status: 'missing', asset: null })
    expect(JSON.stringify(savedMale)).toBe(savedBefore)
  })
  it('loads and verifies the exact asset records returned by the catalog API', async () => {
    const asset = await assetFixture()
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ assets: [asset], retainedBuiltinAssets: [], refitSources: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    await expect(loadHairAssetCatalog(fetcher as typeof fetch)).resolves.toEqual({
      assets: [asset],
      retainedBuiltinAssets: [],
      refitSources: []
    })
    expect(fetcher).toHaveBeenCalledWith('/api/goons/hair-assets')
  })

  it('resolves the actual retained Style 01 r1 without offering it as a current style', async () => {
    const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'static/goon-assets/hair/v2/catalog.json'), 'utf8')) as {
      assets: HairAssetV1[]
    }
    const r1 = catalog.assets.find((asset) => asset.revisionId === 'batshit-style-01-r1')!
    const r2 = catalog.assets.find((asset) => asset.revisionId === 'batshit-style-01-r2')!
    const fit = r1.attachment.fitReceipt
    const source = sourceIdentity({
      baseId: r1.compatibility.baseId,
      fitFamily: r1.compatibility.fitFamily,
      definitionSha256: fit.appearanceDefinitionSha256,
      physicalBasisSha256: fit.physicalBasisSha256,
      topologySha256: fit.topologySha256,
      skeletonHierarchySha256: fit.skeletonHierarchySha256
    })
    const state = createHairState(r1, {
      baseColor: '#123456', highlightColor: '#abcdef',
      motionSettings: { enabled: false, intensity: 0.42 }
    })
    const before = JSON.stringify(state)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      assets: [r2], retainedBuiltinAssets: [r1], refitSources: []
    }), { status: 200 }))
    const loaded = await loadHairAssetCatalog(fetcher as typeof fetch)

    expect(loaded.assets).toEqual([r2])
    expect(resolveHairSelectionCatalogStatus(state, loaded.assets).status).toBe('missing')
    expect(resolveHairSelectionCatalogStatus(state, [...loaded.assets, ...loaded.retainedBuiltinAssets]))
      .toMatchObject({ status: 'ready', asset: r1 })
    expect(classifyHairAssetAvailability(r1, source).status).toBe('ready')
    expect(classifyHairAssetAvailability(r2, source).status).toBe('stale-fit')
    expect(JSON.stringify(state)).toBe(before)
  })

  it('rejects missing, duplicate or non-built-in retained history', async () => {
    const asset = await assetFixture()
    const user = await createHairAssetFixture({
      recipeSource: { identities: sourceIdentity() } as RecipeSource,
      mainBytes: createRigidHairGlbFixture(), headNode: 'head', sourceClass: 'user'
    })
    user.revision = 9
    user.revisionId = 'h1-test-hair-r9'
    user.attachment.fitReceipt.assetRevisionId = user.revisionId
    user.attachment.fitReceipt.receiptId = 'h1-test-hair-fit-r9'
    user.revisionSha256 = '0'.repeat(64)
    user.attachment.fitReceipt.assetRevisionSha256 = '0'.repeat(64)
    user.attachment.fitReceipt.fitSha256 = '0'.repeat(64)
    user.revisionSha256 = await hairAssetRevisionSha256(user)
    user.attachment.fitReceipt.assetRevisionSha256 = user.revisionSha256
    user.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(user.attachment.fitReceipt)
    await verifyHairAsset(user)
    for (const { payload, error } of [
      { payload: { assets: [asset], refitSources: [] }, error: 'response is invalid' },
      { payload: { assets: [asset], retainedBuiltinAssets: [asset], refitSources: [] }, error: 'ambiguous revision identity' },
      { payload: { assets: [], retainedBuiltinAssets: [user], refitSources: [] }, error: 'invalid retained built-in history' },
      { payload: { assets: [asset, user], retainedBuiltinAssets: [], refitSources: [] }, error: 'user style that conflicts' }
    ]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
      await expect(loadHairAssetCatalog(fetcher as typeof fetch)).rejects.toThrow(error)
    }
  })

  it('surfaces API and invalid-payload failures instead of returning an empty catalog', async () => {
    const apiFailure = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Owned Hair bytes are missing.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    await expect(loadHairAssetCatalog(apiFailure as typeof fetch)).rejects.toThrow(
      'Owned Hair bytes are missing.'
    )

    const invalidPayload = vi.fn(async () =>
      new Response(JSON.stringify({ assets: 'not-an-array', refitSources: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    await expect(loadHairAssetCatalog(invalidPayload as typeof fetch)).rejects.toThrow(
      'Hair catalog response is invalid.'
    )
  })

  it('distinguishes ready, incompatible, and stale fit states', async () => {
    const source = sourceIdentity()
    const asset = await assetFixture(source)

    expect(classifyHairAssetAvailability(asset, source)).toMatchObject({
      status: 'ready',
      selectable: true
    })
    expect(classifyHairAssetAvailability(asset, null)).toMatchObject({
      status: 'needs-recipe',
      selectable: false
    })
    expect(
      classifyHairAssetAvailability(asset, sourceIdentity({ baseId: 'another-base' }))
    ).toMatchObject({ status: 'incompatible-base', selectable: false })
    expect(
      classifyHairAssetAvailability(asset, sourceIdentity({ definitionSha256: hash('a') }))
    ).toMatchObject({ status: 'stale-fit', selectable: false })
  })

  it('keeps retired secondary-motion revisions visible but requires a refit', async () => {
    const source = sourceIdentity()
    const asset = await assetFixture(source)
    asset.physics.mode = 'secondary-motion/v1'
    asset.display.tags = []

    expect(classifyHairAssetAvailability(asset, source)).toEqual({
      status: 'motion-upgrade-required',
      selectable: false,
      label: 'Refit required',
      message: 'This imported revision uses the retired Hair motion model. Refit or re-import it.'
    })
  })

  it('keeps exact selection identity and reports missing or stale catalog state', async () => {
    const asset = await assetFixture()
    const selected = createHairState(asset)

    expect(resolveHairSelectionCatalogStatus(selected, [asset])).toMatchObject({
      status: 'ready',
      asset
    })
    expect(resolveHairSelectionCatalogStatus(selected, [])).toMatchObject({
      status: 'missing',
      asset: null
    })

    const stale = structuredClone(selected)
    stale.selected!.assetRevisionSha256 = hash('f')
    stale.definitionSha256 = hash('f')
    expect(resolveHairSelectionCatalogStatus(stale, [asset])).toMatchObject({
      status: 'stale-revision'
    })
  })

  it('preserves the color draft when the user explicitly selects None', async () => {
    const asset = await assetFixture()
    const selected = createHairState(asset, {
      baseColor: '#123456',
      highlightColor: '#abcdef'
    })
    expect(createHairCatalogSelection(null, selected)).toMatchObject({
      selected: null,
      baseColor: '#123456',
      highlightColor: '#abcdef'
    })
  })

  it('routes only owned upload refs through batshit-server', () => {
    expect(resolveHairAssetBrowserUrl('/goon-assets/hair/style.glb', 'http://localhost:5600')).toBe(
      '/goon-assets/hair/style.glb'
    )
    expect(
      resolveHairAssetBrowserUrl('/uploads/goon_hair_assets/style.glb', 'http://localhost:5600')
    ).toBe('http://localhost:5600/uploads/goon_hair_assets/style.glb')
  })
})
