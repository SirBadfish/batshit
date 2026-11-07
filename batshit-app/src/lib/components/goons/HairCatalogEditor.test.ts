import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createHairState, hairAssetRevisionSha256, hairFitReceiptSha256, verifyHairAsset, type HairAssetV1 } from '$lib/goons/hairAssets'
import { HAIR_REFIT_SOURCE_CONTRACT } from '$lib/goons/hairAssets'
import {
  createHairAssetFixture,
  createRigidHairGlbFixture
} from '$lib/goons/recipe/fixtures/hairAssetFixture'
import {
  RECIPE_SOURCE_CONTRACT,
  type RecipeSourceIdentity
} from '$lib/goons/recipe/packageMetadata'
import type { RecipeSource } from '$lib/goons/recipe/recipeContracts'
import {
  HAIR_MOTION_DEFAULT_INTENSITY,
  HAIR_ROOT_WEIGHTED_MOTION_TAG
} from '$lib/goons/secondaryMotion'
import HairCatalogEditor from './HairCatalogEditor.svelte'

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })
}

const HASH = 'a'.repeat(64)

const SOURCE: RecipeSourceIdentity = {
  contract: RECIPE_SOURCE_CONTRACT,
  schemaVersion: 1,
  baseId: 'batshit-base-female',
  fitFamily: 'batshit-base-female-v1',
  modelSha256: HASH,
  manifestSemanticSha256: HASH,
  definitionSha256: HASH,
  neutralId: 'batshit-base-female-neutral',
  neutralRecipeSha256: HASH,
  physicalBasisSha256: HASH,
  behaviorSha256: HASH,
  componentGraphSha256: HASH,
  topologySha256: HASH,
  skeletonHierarchySha256: HASH
}

async function fixture() {
  return createHairAssetFixture({
    recipeSource: { identities: SOURCE } as RecipeSource,
    mainBytes: createRigidHairGlbFixture(),
    headNode: 'head'
  })
}

async function fittedVariant(source: RecipeSourceIdentity, revision: number) {
  const asset = await createHairAssetFixture({ recipeSource: { identities: source } as RecipeSource,
    mainBytes: createRigidHairGlbFixture(), headNode: 'head' })
  asset.revision = revision
  asset.revisionId = `${asset.assetId}-r${revision}`
  asset.attachment.fitReceipt.receiptId = `${asset.assetId}-fit-r${revision}`
  asset.attachment.fitReceipt.assetRevisionId = asset.revisionId
  asset.revisionSha256 = '0'.repeat(64)
  asset.attachment.fitReceipt.assetRevisionSha256 = '0'.repeat(64)
  asset.attachment.fitReceipt.fitSha256 = '0'.repeat(64)
  asset.revisionSha256 = await hairAssetRevisionSha256(asset)
  asset.attachment.fitReceipt.assetRevisionSha256 = asset.revisionSha256
  asset.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(asset.attachment.fitReceipt)
  return verifyHairAsset(asset)
}

describe('HairCatalogEditor', () => {
  it('shows one shared style card and selects its exact current Goon fit', async () => {
    const female = await fixture()
    const maleSource = { ...SOURCE, baseId: 'base-male', fitFamily: 'fit-male', definitionSha256: 'b'.repeat(64) }
    const male = await fittedVariant(maleSource, 2)
    const onSelect = vi.fn()
    const props = { assets: [female, male], valueState: createHairState(null), recipeSource: SOURCE,
      supported: true, onRefresh: vi.fn(), onSelect, onColorsChange: vi.fn() }
    const view = render(HairCatalogEditor, props)
    expect(screen.getAllByRole('button', { name: 'H1 Test Hair. Ready' })).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'H1 Test Hair. Ready' }))
    expect(onSelect).toHaveBeenLastCalledWith(female)
    await view.rerender({ ...props, recipeSource: maleSource })
    expect(screen.getAllByRole('button', { name: 'H1 Test Hair. Ready' })).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'H1 Test Hair. Ready' }))
    expect(onSelect).toHaveBeenLastCalledWith(male)
    const duplicate = await fittedVariant(maleSource, 3)
    onSelect.mockClear()
    await view.rerender({ ...props, assets: [female, male, duplicate], recipeSource: maleSource })
    expect(screen.getByRole('button', { name: 'H1 Test Hair. Fit unavailable' })).toBeDisabled()
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('shows a saved historical fit without offering it as a second style or rewriting its state', async () => {
    const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'static/goon-assets/hair/v2/catalog.json'), 'utf8')) as {
      assets: HairAssetV1[]
    }
    const r1 = catalog.assets.find((asset) => asset.revisionId === 'batshit-style-01-r1')!
    const r2 = catalog.assets.find((asset) => asset.revisionId === 'batshit-style-01-r2')!
    const fit = r1.attachment.fitReceipt
    const source = {
      ...SOURCE, baseId: r1.compatibility.baseId, fitFamily: r1.compatibility.fitFamily,
      definitionSha256: fit.appearanceDefinitionSha256, physicalBasisSha256: fit.physicalBasisSha256,
      topologySha256: fit.topologySha256, skeletonHierarchySha256: fit.skeletonHierarchySha256
    }
    const state = createHairState(r1, {
      baseColor: '#123456', highlightColor: '#abcdef',
      motionSettings: { enabled: false, intensity: 0.42 }
    })
    const before = JSON.stringify(state)
    const onSelect = vi.fn()
    const props = {
      assets: [r2], retainedBuiltinAssets: [r1], valueState: state, recipeSource: source,
      supported: true, onRefresh: vi.fn(), onSelect, onColorsChange: vi.fn(),
      motionTuning: { enabled: false, intensity: 0.42 }, onMotionTuningChange: vi.fn()
    }
    const view = render(HairCatalogEditor, props)

    expect(screen.getByText('Currently selected: Style 01 · Shaggy Layers (saved fit)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Style 01 · Shaggy Layers. Refit required' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: /Style 01 · Shaggy Layers\./ })).toHaveLength(1)
    expect((screen.getByLabelText('Hair Base Color') as HTMLInputElement).value).toBe('#123456')
    expect((screen.getByLabelText('Hair Highlight Color') as HTMLInputElement).value).toBe('#abcdef')
    expect(screen.getByText('Motion Settings')).toBeTruthy()
    expect(screen.queryByText(/saved Hair style is missing/i)).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
    expect(JSON.stringify(state)).toBe(before)

    await view.rerender({ ...props, recipeSource: { ...source, definitionSha256: 'f'.repeat(64) } })
    expect(screen.getByText(/fitted to an older head definition/)).toBeTruthy()
    expect(screen.queryByText('Two-color Hair Palette')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
    expect(JSON.stringify(state)).toBe(before)
  })

  it('restores the previous exact historical fit and palette after an explicit No Hair toggle', async () => {
    const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'static/goon-assets/hair/v2/catalog.json'), 'utf8')) as {
      assets: HairAssetV1[]
    }
    const r1 = catalog.assets.find((asset) => asset.revisionId === 'batshit-style-01-r1')!
    const r2 = catalog.assets.find((asset) => asset.revisionId === 'batshit-style-01-r2')!
    const fit = r1.attachment.fitReceipt
    const source = {
      ...SOURCE, baseId: r1.compatibility.baseId, fitFamily: r1.compatibility.fitFamily,
      definitionSha256: fit.appearanceDefinitionSha256, physicalBasisSha256: fit.physicalBasisSha256,
      topologySha256: fit.topologySha256, skeletonHierarchySha256: fit.skeletonHierarchySha256
    }
    const state = createHairState(r1, {
      baseColor: '#123456', highlightColor: '#abcdef',
      motionSettings: { enabled: false, intensity: 0.42 }
    })
    const none = createHairState(null, { baseColor: state.baseColor, highlightColor: state.highlightColor })
    const onSelect = vi.fn()
    const props = {
      assets: [r2], retainedBuiltinAssets: [r1], ownerId: 'goon-a', stateOwnerId: 'goon-a',
      valueState: state, recipeSource: source, supported: true, onRefresh: vi.fn(), onSelect,
      onColorsChange: vi.fn(), motionTuning: { enabled: false, intensity: 0.42 }, onMotionTuningChange: vi.fn()
    }
    const view = render(HairCatalogEditor, props)
    await fireEvent.click(screen.getByRole('switch', { name: 'No Hair' }))
    expect(onSelect).toHaveBeenLastCalledWith(null)
    await view.rerender({ ...props, valueState: none })
    await fireEvent.click(screen.getByRole('switch', { name: 'No Hair' }))
    expect(onSelect).toHaveBeenLastCalledWith(r1, state)
    expect(screen.getAllByRole('button', { name: /Style 01 · Shaggy Layers\./ })).toHaveLength(1)

    await view.rerender({ ...props, valueState: state })
    await fireEvent.click(screen.getByRole('switch', { name: 'No Hair' }))
    onSelect.mockClear()
    await view.rerender({ ...props, valueState: none, recipeSource: { ...source, definitionSha256: 'f'.repeat(64) } })
    await fireEvent.click(screen.getByRole('switch', { name: 'No Hair' }))
    expect(screen.getByText('The previous Hair fit is unavailable for this Goon. Choose an available style.')).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()

    await view.rerender({ ...props, ownerId: 'goon-b', stateOwnerId: 'goon-a', valueState: state, disabled: true })
    await view.rerender({ ...props, ownerId: 'goon-b', stateOwnerId: 'goon-b', valueState: none })
    expect(screen.getByRole('switch', { name: 'No Hair' })).toBeDisabled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders the real catalog groups and selects a compatible style', async () => {
    const asset = await fixture()
    const onSelect = vi.fn()
    render(HairCatalogEditor, {
      assets: [asset],
      valueState: createHairState(null),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect,
      onColorsChange: vi.fn()
    })

    expect(screen.getByText('Built-in Styles')).toBeTruthy()
    expect(screen.getByText('Imported Styles')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'H1 Test Hair. Ready' })).toBeEnabled()

    await fireEvent.click(screen.getByRole('button', { name: 'H1 Test Hair. Ready' }))
    expect(onSelect).toHaveBeenCalledWith(asset)
  })

  it('keeps incompatible cards visible but unavailable', async () => {
    const asset = await fixture()
    render(HairCatalogEditor, {
      assets: [asset],
      valueState: createHairState(null),
      recipeSource: { ...SOURCE, baseId: 'another-base' },
      supported: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn()
    })

    expect(screen.getByRole('button', { name: 'H1 Test Hair. Different Goon base' })).toBeDisabled()
    expect(screen.getByText('Different Goon base')).toBeTruthy()
  })

  it('does not mislabel a saved selection as missing while the catalog is loading', async () => {
    const asset = await fixture()
    render(HairCatalogEditor, {
      assets: [],
      valueState: createHairState(asset),
      recipeSource: SOURCE,
      supported: true,
      loading: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn()
    })

    expect(screen.getByText('Loading Hair catalog…')).toBeTruthy()
    expect(screen.queryByText(/saved Hair style is missing/i)).toBeNull()
  })

  it('shows the explicit No Hair state and teaches empty catalog sections', async () => {
    const onSelect = vi.fn()
    render(HairCatalogEditor, {
      assets: [],
      valueState: createHairState(null),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect,
      onColorsChange: vi.fn()
    })

    expect(
      screen.getByText('Built-in styles will appear here as they finish product validation.')
    ).toBeTruthy()
    expect(
      screen.getByText('Import an OBJ or GLB to create your first reviewed Hair style.')
    ).toBeTruthy()
    expect(screen.queryByPlaceholderText('Search styles')).toBeNull()
    const noHair = screen.getByRole('switch', { name: 'No Hair' })
    expect(noHair.getAttribute('data-state')).toBe('checked')
    expect(noHair).toBeDisabled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects No Hair from the compact Built-in Styles header switch', async () => {
    const asset = await fixture()
    const onSelect = vi.fn()
    render(HairCatalogEditor, {
      assets: [asset],
      valueState: createHairState(asset),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect,
      onColorsChange: vi.fn()
    })

    await fireEvent.click(screen.getByRole('switch', { name: 'No Hair' }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('shows the retired-state reset in the Hair panel instead of the raw schema error', async () => {
    const onReset = vi.fn()
    render(HairCatalogEditor, {
      assets: [],
      valueState: createHairState(null),
      recipeSource: SOURCE,
      supported: true,
      previewError: '[hair-assets/v1] state.schemaVersion must equal hair-state/v2',
      disabled: true,
      retiredStateRecovery: {
        busy: false,
        onReset
      },
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn()
    })

    expect(screen.getByText('This Goon needs a Hair reset')).toBeTruthy()
    expect(screen.queryByText(/Hair preview failed:/)).toBeNull()
    expect(screen.getByRole('switch', { name: 'No Hair' })).toBeDisabled()

    await fireEvent.click(screen.getByRole('button', { name: 'Reset retired Hair' }))
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('exposes the reviewed import entry point only when its controller is available', async () => {
    const onImport = vi.fn()
    const view = render(HairCatalogEditor, {
      assets: [],
      valueState: createHairState(null),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn(),
      onImport
    })

    const input = screen.getByLabelText(
      'Import Hair OBJ or GLB with optional AHS calibration'
    ) as HTMLInputElement
    const inputClick = vi.spyOn(input, 'click')
    await fireEvent.click(screen.getByRole('button', { name: 'Import Hair' }))
    expect(inputClick).toHaveBeenCalledTimes(1)
    expect(onImport).not.toHaveBeenCalled()

    const file = new File(['hair'], 'finished-hair.glb', {
      type: 'model/gltf-binary'
    })
    await fireEvent.change(input, { target: { files: [file] } })
    expect(onImport).toHaveBeenCalledWith([file])

    view.unmount()
    render(HairCatalogEditor, {
      assets: [],
      valueState: createHairState(null),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn()
    })
    expect(screen.queryByRole('button', { name: 'Import Hair' })).toBeNull()
  })

  it('offers imported revisions a separate edit action without exposing revision shorthand', async () => {
    const asset = await fixture()
    asset.sourceClass = 'user'
    const refitSource = {
      contract: HAIR_REFIT_SOURCE_CONTRACT,
      assetId: asset.assetId,
      revisionId: asset.revisionId,
      source: {
        ref: '/uploads/goon_hair_assets/refit-source.glb',
        sha256: HASH,
        bytes: 3_000_000,
        mimeType: 'model/gltf-binary'
      },
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
    }
    const onRefit = vi.fn()
    render(HairCatalogEditor, {
      assets: [asset],
      refitSources: [refitSource],
      valueState: createHairState(null),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn(),
      onRefit
    })

    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit H1 Test Hair'
      })
    )
    expect(onRefit).toHaveBeenCalledWith(asset, refitSource)
    expect(screen.getByText('Imported')).toBeTruthy()
    expect(screen.queryByText('Imported r1')).toBeNull()
  })

  it('confirms deletion of one unselected imported revision', async () => {
    const asset = await fixture()
    asset.sourceClass = 'user'
    const onDelete = vi.fn()
    render(HairCatalogEditor, {
      assets: [asset],
      valueState: createHairState(null),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn(),
      onDelete
    })

    await fireEvent.click(
      screen.getByRole('button', { name: 'Delete H1 Test Hair revision 1' })
    )
    expect(screen.getByText('Delete this Hair revision?')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Delete revision' }))
    expect(onDelete).toHaveBeenCalledWith(asset)
  })

  it('shows the unsupported Goon state without hiding the Hair surface', () => {
    render(HairCatalogEditor, {
      assets: [],
      valueState: createHairState(null),
      recipeSource: null,
      supported: false,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn()
    })

    expect(screen.getByText('Advanced/GLB Hair only')).toBeTruthy()
  })

  it('edits Base and Highlight independently for the mounted ready style', async () => {
    const asset = await fixture()
    const onColorsChange = vi.fn()
    render(HairCatalogEditor, {
      assets: [asset],
      valueState: createHairState(asset),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange
    })

    expect(screen.getByText('Two-color Hair Palette')).toBeTruthy()
    expect(screen.queryByText(/Base controls the main tone/)).toBeNull()
    await fireEvent.click(
      screen.getByRole('button', { name: 'About Two-color Hair Palette' })
    )
    expect(screen.getByText(/Base controls the main tone/)).toBeTruthy()
    await fireEvent.change(screen.getByLabelText('Hair Base Color'), {
      target: { value: '#101820' }
    })
    expect(onColorsChange).toHaveBeenCalledWith({
      baseColor: '#101820',
      highlightColor: '#6f4a8e'
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Use Dark Purple Hair palette' }))
    expect(onColorsChange).toHaveBeenLastCalledWith({
      baseColor: '#21142f',
      highlightColor: '#68468f'
    })
  })

  it('coalesces picker dragging and commits the final Hair color when the picker closes', async () => {
    const asset = await fixture()
    const onColorsChange = vi.fn()
    render(HairCatalogEditor, {
      assets: [asset],
      valueState: createHairState(asset),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange
    })
    const picker = screen.getByLabelText('Hair Base Color')
    for (const color of ['#112233', '#223344', '#334455']) {
      await fireEvent.input(picker, { target: { value: color } })
    }
    expect(onColorsChange).not.toHaveBeenCalled()
    await fireEvent.change(picker)
    await fireEvent.blur(picker)
    expect(onColorsChange).toHaveBeenCalledExactlyOnceWith({
      baseColor: '#334455',
      highlightColor: '#6f4a8e'
    })
  })

  it('exposes bounded saved motion settings for a root-weighted style', async () => {
    const asset = await fixture()
    const weightedAsset = {
      ...asset,
      display: {
        ...asset.display,
        tags: [...asset.display.tags, HAIR_ROOT_WEIGHTED_MOTION_TAG].sort()
      }
    }
    const onMotionTuningChange = vi.fn()
    render(HairCatalogEditor, {
      assets: [weightedAsset],
      valueState: createHairState(weightedAsset),
      recipeSource: SOURCE,
      supported: true,
      onRefresh: vi.fn(),
      onSelect: vi.fn(),
      onColorsChange: vi.fn(),
      motionTuning: {
        enabled: true,
        intensity: HAIR_MOTION_DEFAULT_INTENSITY
      },
      onMotionTuningChange
    })

    expect(screen.getByText('Motion Settings')).toBeTruthy()
    expect(screen.getByText('Hair Physics')).toBeTruthy()
    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.queryByText(/saved with this Goon/i)).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'About Motion Settings' }))
    expect(screen.getByText(/saved with this Goon/i)).toBeTruthy()

    await fireEvent.keyDown(screen.getByRole('slider', { name: 'Hair Physics Intensity' }), {
      key: 'ArrowRight'
    })
    expect(onMotionTuningChange).toHaveBeenCalledWith({
      enabled: true,
      intensity: 1.05
    })

    await fireEvent.click(screen.getByRole('switch', { name: 'Hair Physics' }))
    expect(onMotionTuningChange).toHaveBeenLastCalledWith({ enabled: false, intensity: 1 })
  })
})
