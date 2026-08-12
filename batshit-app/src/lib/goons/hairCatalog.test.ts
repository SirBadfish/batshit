import { describe, expect, it, vi } from 'vitest'

import { createHairState } from './hairAssets'
import {
  classifyHairAssetAvailability,
  createHairCatalogSelection,
  loadHairAssetCatalog,
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

describe('Hair catalog product helpers', () => {
  it('loads and verifies the exact asset records returned by the catalog API', async () => {
    const asset = await assetFixture()
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ assets: [asset], refitSources: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    await expect(loadHairAssetCatalog(fetcher as typeof fetch)).resolves.toEqual({
      assets: [asset],
      refitSources: []
    })
    expect(fetcher).toHaveBeenCalledWith('/api/goons/hair-assets')
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
