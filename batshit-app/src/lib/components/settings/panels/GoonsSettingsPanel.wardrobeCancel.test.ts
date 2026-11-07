// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { resolveEnabledCustomClosetItems } from '$lib/goons/customClosetLibrary'
import { normalizeHexColor, xwearColorToHex } from '$lib/goons/closetMaterials'
import { createRecipePreviewAttempt } from '$lib/goons/recipe/recipePreviewAttempt'

/** Exercise the actual panel owners with controlled queue and load boundaries. */
function panelOwners(context: Record<string, any>, extraNames: string[] = []) {
  const script = readFileSync('src/lib/components/settings/panels/GoonsSettingsPanel.svelte', 'utf8')
    .split('<script lang="ts">')[1]!.split('</script>')[0]!
  const file = ts.createSourceFile('GoonsSettingsPanel.ts', script, ts.ScriptTarget.Latest, true)
  const names = ['beginClosetPreviewRequest', 'discardCueEditorChanges', 'runLoggedEditorPreviewUpdate', 'queueLoggedEditorPreviewUpdate',
    'refreshEditorClosetPreview', 'syncEditorGuidedOutfitPreview', 'captureClosetPreviewOwner',
    'applyClosetAssignments', 'applyClosetAssignment', 'handleClosetSlotChange', 'loadKitchenPreviewGoon',
    'ensureKitchenPreviewReady', 'createSavedClosetPreviewContext', 'originalSourceMatches', ...extraNames]
  const declarations = file.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text))
  if (declarations.length !== names.length) throw new Error('Wardrobe preview owners were not found')
  const js = ts.transpileModule(declarations.map((item) => item.getText(file)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const scope = new Proxy(context, {
    has: () => true,
    get(target, key) { return typeof key === 'symbol' ? undefined : key in target ? Reflect.get(target, key) : Reflect.get(globalThis, key) },
    set(target, key, value) { return Reflect.set(target, key, value) }
  })
  return new Function('scope', `with (scope) { ${js}; return { ${names.join(', ')} } }`)(scope)
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(guided = false) {
  const root = {}, generation = { current: 1 }, goon = { id: 'luci', kind: 'vrm', closetAssignments: {} }
  const engine = {
    getAvatarRootObject: vi.fn(() => root), resetMaterialOverrides: vi.fn(),
    getGoonLoadGeneration: vi.fn(() => generation.current),
    isCurrentGoonLoad: vi.fn((token: number) => token === generation.current),
    getMaterialNames: vi.fn(() => ['shirt']), applyXWearMaterial: vi.fn().mockResolvedValue(true),
    applyMaterialTexture: vi.fn().mockResolvedValue(true),
    hideClosetMaterial: vi.fn(),
    applyBodyConceal: vi.fn(), configureGuidedOutfitPieces: vi.fn().mockResolvedValue(undefined)
  }
  const context: Record<string, any> = {
    resolveEnabledCustomClosetItems, closetItemsById: new Map(),
    active: true, activeTab: 'goons', editorGoonId: goon.id, editorGoon: goon, goons: [goon],
    previewEngine: engine, previewGoonId: goon.id, previewReady: true, previewLoading: false, previewToken: 7,
    previewLoadCompletion: null, createRecipePreviewAttempt,
    kitchenPreviewContainer: {}, kitchenPreviewEngine: engine, kitchenPreviewLoadRequestId: 1,
    queueKitchenPreviewLoad: (task: () => Promise<unknown>) => task(),
    isKitchenPreviewLoadRequestCurrent: (requestId: number) => requestId === context.kitchenPreviewLoadRequestId,
    resolveGoonAvatarUrl: () => '/luci.vrm', ensureKitchenPreviewEngine: vi.fn().mockResolvedValue(engine),
    loadAvatarIntoEngine: vi.fn().mockResolvedValue({ role: 'avatar', kind: 'vrm' }),
    applyGoonSceneDefinition: vi.fn().mockResolvedValue(undefined), buildGoonSceneSignature: () => '',
    stagePostureMap: {},
    editorInstanceEpoch: 1, editorDirtyEpoch: 1, editorPreviewUpdateEpoch: 0,
    closetBusy: false, closetPreviewRequest: 0, closetSlotNames: ['shirt', 'pants'],
    editorPreviewUpdateQueue: Promise.resolve(), editorIsGuidedCustomVrm: guided,
    editorSourceProfile: guided ? 'guided-custom-vrm' : 'standard-vrm',
    closetAssignments: { shirt: { mode: 'none' } }, editorClosetItems: {},
    editorGuidedOutfitPiecesDraft: guided ? [{ id: 'coat' }] : [], editorGuidedPieceStates: guided ? { coat: true } : {},
    editorGuidedDufOverlays: guided ? [{ id: 'overlay', file: { url: '/overlay.vrm' } }] : [],
    paintedConcealEditorOpen: false, paintedConcealTarget: null, paintedConcealDraftTriangles: {},
    resolveGoonKind: () => 'vrm', beginEditorSourceMotionMutation: () => true,
    discardFacialArtworkDraftUploads: vi.fn().mockResolvedValue(undefined),
    restorePackageOwnedEditorDrafts: vi.fn(), clearEditorDirty: vi.fn(),
    ensurePreviewGoonReady: vi.fn().mockResolvedValue(engine),
    buildPersistedGuidedPieceStates: () => context.editorGuidedPieceStates,
    resolveActiveWearableConceal: () => ({ paintedMasks: [] }),
    resolveClosetItem: () => null, resolveOriginalSavedItemForConceal: () => null,
    resolveClosetRuntimeMaterialName: (name: string) => name,
    isSkinOverlayClosetSlotKey: () => false, applyClosetColorOverride: vi.fn(),
    resolveEditedOriginalWardrobeItemForSlot: () => null, resolveGuidedBasePiecesForSlot: () => [],
    applyClosetSelectionChange: (assignments: any, slot: string) => ({ ...assignments, [slot]: { mode: 'none' } }),
    logClientEvent: vi.fn(), logClientError: vi.fn(), toast: { error: vi.fn() }
  }
  context.openCueEditor = vi.fn((saved: typeof goon) => {
    context.editorInstanceEpoch += 1; context.editorDirtyEpoch += 1
    context.closetAssignments = structuredClone(saved.closetAssignments)
  })
  context.markEditorDirty = () => { context.editorDirtyEpoch += 1 }
  return { context, engine, generation, goon, owners: panelOwners(context) }
}

describe('Goon editor Cancel Wardrobe preview', () => {
  it('restores the saved manual Closet preview after Cancel even if another edit begins', async () => {
    const { context, engine, owners } = fixture()
    owners.discardCueEditorChanges()
    context.editorDirtyEpoch += 1
    await context.editorPreviewUpdateQueue
    expect(context.closetAssignments).toEqual({})
    expect(engine.resetMaterialOverrides).toHaveBeenCalledOnce()
    expect(engine.applyBodyConceal).toHaveBeenCalledWith({ paintedMasks: [] })
  })

  it('reapplies the saved item and conceal when Cancel reopens the Goon', async () => {
    const { context, engine, goon, owners } = fixture()
    goon.closetAssignments = { shirt: { mode: 'item', itemId: 'saved' } } as any
    const xwear = { materialName: 'shirt' }
    context.resolveClosetItem = () => ({ id: 'saved', xwear })
    context.resolveActiveWearableConceal = () => ({ paintedMasks: ['saved-mask'] })
    owners.discardCueEditorChanges()
    await context.editorPreviewUpdateQueue
    expect(engine.resetMaterialOverrides).toHaveBeenCalledOnce()
    expect(engine.applyXWearMaterial).toHaveBeenCalledWith('shirt', xwear, expect.objectContaining({ isCurrent: expect.any(Function) }))
    expect(engine.applyBodyConceal).toHaveBeenCalledWith({ paintedMasks: ['saved-mask'] })
  })

  it('reapplies the saved Closet after the same-owner preview load finishes', async () => {
    const { context, engine, owners } = fixture(), loading = deferred()
    context.previewLoading = true
    context.previewReady = false
    context.previewGoonId = null
    context.previewLoadCompletion = loading.promise
    owners.discardCueEditorChanges()
    await Promise.resolve()
    expect(engine.resetMaterialOverrides).not.toHaveBeenCalled()
    context.previewLoading = false
    context.previewReady = true
    context.previewGoonId = 'luci'
    loading.resolve()
    await context.editorPreviewUpdateQueue
    expect(engine.resetMaterialOverrides).toHaveBeenCalledOnce()
    expect(engine.applyBodyConceal).toHaveBeenCalledWith({ paintedMasks: [] })
  })

  it('reports a stalled preview load and lets the queue recover without canceling the load', async () => {
    vi.useFakeTimers()
    try {
      const { context, owners } = fixture(), loading = deferred(), next = vi.fn().mockResolvedValue(undefined)
      context.previewLoading = true
      context.previewLoadCompletion = loading.promise
      owners.discardCueEditorChanges()
      const settled = context.editorPreviewUpdateQueue.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(30_000)
      await settled
      expect(context.toast.error).toHaveBeenCalledWith(expect.stringContaining('took too long'))
      owners.queueLoggedEditorPreviewUpdate('later', next)
      await context.editorPreviewUpdateQueue
      expect(next).toHaveBeenCalledOnce()
      loading.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores guided pieces and DUF before applying saved manual Closet', async () => {
    const { context, engine, owners } = fixture(true)
    owners.discardCueEditorChanges()
    await context.editorPreviewUpdateQueue
    expect(engine.configureGuidedOutfitPieces).toHaveBeenCalledWith(
      [{ id: 'coat' }], { coat: true }, [{ id: 'overlay', file: { url: '/overlay.vrm' } }]
    )
    expect(engine.resetMaterialOverrides).toHaveBeenCalledOnce()
    expect(engine.applyBodyConceal).toHaveBeenCalledWith({ paintedMasks: [] })
  })

  it.each(['replacement', 'generation'] as const)(
    'does not apply queued Cancel restoration after preview %s changes', async (change) => {
      const { context, engine, generation, owners } = fixture(), blocker = deferred()
      context.editorPreviewUpdateQueue = blocker.promise
      owners.discardCueEditorChanges()
      if (change === 'replacement') context.previewToken += 1
      else generation.current += 1
      blocker.resolve()
      await context.editorPreviewUpdateQueue
      expect(engine.resetMaterialOverrides).not.toHaveBeenCalled()
      expect(engine.applyBodyConceal).not.toHaveBeenCalled()
    }
  )

  it('lets a newer manual slot choice win over a queued Cancel restore', async () => {
    const { context, engine, owners } = fixture(), blocker = deferred()
    context.editorPreviewUpdateQueue = blocker.promise
    owners.discardCueEditorChanges()
    await owners.handleClosetSlotChange('shirt', '__none__')
    blocker.resolve()
    await context.editorPreviewUpdateQueue
    expect(context.closetAssignments).toEqual({ shirt: { mode: 'none' } })
    expect(engine.hideClosetMaterial).toHaveBeenCalledWith('shirt')
    expect(engine.resetMaterialOverrides).toHaveBeenCalledOnce()
  })

  it('reports a failed Cancel restore and still permits a later queued update', async () => {
    const { context, owners } = fixture(), next = vi.fn().mockResolvedValue(undefined)
    context.ensurePreviewGoonReady.mockRejectedValueOnce(new Error('preview unavailable'))
    owners.discardCueEditorChanges()
    await context.editorPreviewUpdateQueue.catch(() => undefined)
    await vi.waitFor(() => expect(context.toast.error).toHaveBeenCalledWith('preview unavailable'))
    owners.queueLoggedEditorPreviewUpdate('later', next)
    await context.editorPreviewUpdateQueue
    expect(next).toHaveBeenCalledOnce()
  })

  it('does not apply an old slot selection after Cancel reopens the saved Goon', async () => {
    const { context, engine, owners } = fixture(), blocker = deferred<typeof engine>()
    context.ensurePreviewGoonReady.mockReturnValue(blocker.promise)
    const selection = owners.handleClosetSlotChange('shirt', '__none__')
    expect(context.closetBusy).toBe(true)
    owners.discardCueEditorChanges()
    expect(context.closetBusy).toBe(false)
    blocker.resolve(engine)
    await selection
    expect(context.closetAssignments).toEqual({})
    expect(engine.hideClosetMaterial).not.toHaveBeenCalled()
  })

  it('releases a superseded slot busy state when a newer refresh takes ownership', async () => {
    const { context, engine, owners } = fixture(), blocker = deferred<typeof engine>()
    context.ensurePreviewGoonReady.mockReturnValueOnce(blocker.promise).mockResolvedValueOnce(engine)
    const selection = owners.handleClosetSlotChange('shirt', '__none__')
    expect(context.closetBusy).toBe(true)
    await owners.refreshEditorClosetPreview()
    expect(context.closetBusy).toBe(false)
    blocker.resolve(engine)
    await selection
    expect(context.closetBusy).toBe(false)
  })

  it('retains rapid selections in different slots and keeps the newer request busy', async () => {
    const { context, engine, owners } = fixture(), first = deferred<typeof engine>(), second = deferred<typeof engine>()
    context.closetAssignments = {}
    context.ensurePreviewGoonReady.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const firstSelection = owners.handleClosetSlotChange('shirt', '__none__')
    const secondSelection = owners.handleClosetSlotChange('pants', '__none__')
    expect(context.closetAssignments).toEqual({ shirt: { mode: 'none' }, pants: { mode: 'none' } })
    first.resolve(engine)
    await firstSelection
    expect(context.closetBusy).toBe(true)
    second.resolve(engine)
    await secondSelection
    expect(context.closetBusy).toBe(false)
    expect(engine.hideClosetMaterial).toHaveBeenCalledWith('shirt')
    expect(engine.hideClosetMaterial).toHaveBeenCalledWith('pants')
  })

  it('does not apply an old item color or conceal after a default refresh changes owner', async () => {
    const { context, engine, owners } = fixture(), blocker = deferred()
    context.closetAssignments = { shirt: { mode: 'item', itemId: 'saved' } }
    context.resolveClosetItem = () => ({ id: 'saved', xwear: { materialName: 'shirt' } })
    engine.applyXWearMaterial.mockImplementation(async () => { await blocker.promise; return true })
    const refresh = owners.refreshEditorClosetPreview()
    await vi.waitFor(() => expect(engine.applyXWearMaterial).toHaveBeenCalledOnce())
    context.previewToken += 1
    engine.getAvatarRootObject.mockReturnValue({})
    blocker.resolve()
    await refresh
    expect(context.applyClosetColorOverride).not.toHaveBeenCalled()
    expect(engine.applyBodyConceal).not.toHaveBeenCalled()
  })

  it('keeps a newer same-owner Closet refresh when an older texture load settles last', async () => {
    const { context, engine, owners } = fixture(), blocker = deferred()
    context.closetAssignments = { shirt: { mode: 'item', itemId: 'red' } }
    context.resolveClosetItem = (id: string) => ({ id, xwear: { materialName: 'shirt', id } })
    engine.applyXWearMaterial.mockImplementation(async (_name, xwear, options) => {
      if (xwear.id === 'red') await blocker.promise
      return options.isCurrent()
    })
    const older = owners.refreshEditorClosetPreview()
    await vi.waitFor(() => expect(engine.applyXWearMaterial).toHaveBeenCalledTimes(1))
    context.closetAssignments = { shirt: { mode: 'item', itemId: 'blue' } }
    await owners.refreshEditorClosetPreview()
    blocker.resolve()
    await older
    expect(context.applyClosetColorOverride).toHaveBeenCalledOnce()
    expect(context.applyClosetColorOverride).toHaveBeenCalledWith(engine, 'shirt', expect.anything(), expect.objectContaining({ id: 'blue' }))
    expect(engine.applyBodyConceal).toHaveBeenCalledOnce()
  })

  it('does not apply an old item color or conceal after a same-root load generation changes', async () => {
    const { context, engine, generation, owners } = fixture(), blocker = deferred()
    context.closetAssignments = { shirt: { mode: 'item', itemId: 'saved' } }
    context.resolveClosetItem = () => ({ id: 'saved', xwear: { materialName: 'shirt' } })
    engine.applyXWearMaterial.mockImplementation(async () => { await blocker.promise; return false })
    const refresh = owners.refreshEditorClosetPreview()
    await vi.waitFor(() => expect(engine.applyXWearMaterial).toHaveBeenCalledOnce())
    generation.current += 1
    blocker.resolve()
    await refresh
    expect(context.applyClosetColorOverride).not.toHaveBeenCalled()
    expect(engine.applyBodyConceal).not.toHaveBeenCalled()
  })

  it('does not publish a delayed Kitchen item after its load request is superseded', async () => {
    const { context, engine, goon, owners } = fixture(), blocker = deferred()
    goon.closetAssignments = { shirt: { mode: 'item', itemId: 'saved' } } as any
    Object.assign(goon, { closet: { items: { saved: { id: 'saved', name: 'Saved', category: 'shirt', xwear: { materialName: 'shirt' } } } } })
    engine.applyXWearMaterial.mockImplementation(async () => { await blocker.promise; return true })
    const loading = owners.loadKitchenPreviewGoon(goon, null, 1)
    await vi.waitFor(() => expect(engine.applyXWearMaterial).toHaveBeenCalledOnce())
    context.kitchenPreviewLoadRequestId += 1
    blocker.resolve()
    expect(await loading).toBe(false)
    expect(context.applyClosetColorOverride).not.toHaveBeenCalled()
    expect(engine.applyBodyConceal).not.toHaveBeenCalled()
  })

  it.each(['xwear', 'texture'] as const)(
    'preserves color and conceal behavior when a current %s target returns false', async (kind) => {
      const { context, engine, owners } = fixture()
      context.closetAssignments = { shirt: { mode: 'item', itemId: 'saved' } }
      context.resolveClosetItem = () => kind === 'xwear'
        ? { id: 'saved', xwear: { materialName: 'shirt' } }
        : { id: 'saved', texture: { url: '/saved.png' } }
      engine.applyXWearMaterial.mockResolvedValue(false)
      engine.applyMaterialTexture.mockResolvedValue(false)
      await owners.refreshEditorClosetPreview()
      expect(context.applyClosetColorOverride).toHaveBeenCalledOnce()
      expect(engine.applyBodyConceal).toHaveBeenCalledWith({ paintedMasks: [] })
    }
  )

  it.each(['closed', 'other Goon'] as const)(
    'loads saved Kitchen material with editor %s without borrowing its items', async (editor) => {
      const { context, engine, goon } = fixture()
      const item = { id: 'local', name: 'Saved green', category: 'shirt',
        xwear: { materialName: 'shirt' }, materialColors: { baseHex: '#20a059' } }
      Object.assign(goon, { closet: { items: { local: item } },
        closetAssignments: { shirt: { mode: 'item', itemId: 'local' } } })
      context.closetItemsById = new Map()
      context.editorGoonId = editor === 'closed' ? null : 'other'
      context.resolveClosetItem = () => ({ ...item, name: 'Wrong editor', materialColors: { baseHex: '#ff0000' } })
      Object.assign(engine, { getAnimationCatalog: () => [], getCustomExpressionNames: () => [],
        setMood: vi.fn(), setGoonVisible: vi.fn(), syncAnimations: vi.fn().mockResolvedValue(undefined) })
      Object.assign(context, { kitchenScenes: {}, goonsSettings: {}, applyPreviewCamera: vi.fn(),
        resolveAnimationFiles: () => [], resolveGoonCues: () => ({ cueMap: {} }),
        buildPreviewAnimationLoadPlan: () => ({ eager: [], deferred: [] }),
        scenePreviewUsesMotionOnly: () => false, buildBaseLoopSignature: () => '' })
      context.resolveActiveWearableConceal = vi.fn((args) => {
        expect(args.resolveClosetItem('local')).toEqual(item)
        return { paintedMasks: ['saved-target'] }
      })
      const owners = panelOwners(context)
      expect(await owners.loadKitchenPreviewGoon(goon, null, 1)).toBe(true)
      expect(engine.applyXWearMaterial).toHaveBeenCalledWith('shirt', item.xwear, expect.objectContaining({ isCurrent: expect.any(Function) }))
      expect(context.applyClosetColorOverride).toHaveBeenCalledWith(engine, 'shirt', goon.closetAssignments.shirt, item)
      expect(engine.applyBodyConceal).toHaveBeenCalledWith({ paintedMasks: ['saved-target'] })
      // A warm Kitchen request with changed assignments uses the same saved owner.
      context.kitchenPreviewClosetSignature = 'older assignments'
      Object.assign(context, { scenePreviewUsingProxy: false, kitchenPreviewGoonId: goon.id,
        resolveGoonById: () => goon, hasRenderableGoonAvatar: () => true })
      await owners.ensureKitchenPreviewReady()
      expect(engine.applyXWearMaterial).toHaveBeenCalledTimes(2)
      expect(context.applyClosetColorOverride.mock.calls[1][3]).toEqual(item)
    }
  )

  it('keeps saved Original conceal and None scoped to the selected Goon', async () => {
    const { context, engine, goon } = fixture()
    const savedOriginal = { id: 'original', name: 'Saved Original', category: 'shirt',
      originalSource: { kind: 'slot-original', slotName: 'shirt' } }
    Object.assign(goon, { closet: { items: { original: savedOriginal } } })
    context.closetItemsById = new Map()
    context.resolveOriginalSavedItemForConceal = () => ({ id: 'wrong-editor' })
    context.resolveActiveWearableConceal = vi.fn((args) => {
      expect(args.resolveOriginalSavedItem({ kind: 'slot-original', slotName: 'shirt' })).toEqual(savedOriginal)
      expect(args.resolveOriginalSavedItem({ kind: 'slot-original', slotName: 'pants' })).toBeNull()
      return { paintedMasks: ['original-target'] }
    })
    const owners = panelOwners(context)
    await owners.applyClosetAssignments(engine, { shirt: { mode: 'original' }, pants: { mode: 'none' } }, { goon })
    expect(engine.resetMaterialOverrides).toHaveBeenCalledWith('shirt')
    expect(engine.hideClosetMaterial).toHaveBeenCalledWith('pants')
    expect(engine.applyBodyConceal).toHaveBeenCalledWith({ paintedMasks: ['original-target'] })
  })

  it('keeps public global fallback scoped to the selected saved Goon', () => {
    const { context, goon } = fixture()
    const globalItem = { id: 'global', name: 'Global', category: 'shirt' }
    context.closetItemsById = new Map([['global', globalItem]])
    const owners = panelOwners(context)
    expect(owners.createSavedClosetPreviewContext(goon).resolveItem('global')).toEqual(globalItem)
    const local = { id: 'local', name: 'Z newest target copy', category: 'shirt', sourceItemId: 'global', updatedAt: '2026-11-06T02:00:00Z' }
    const older = { id: 'older', name: 'A older copy', category: 'shirt', sourceItemId: 'global', createdAt: '2026-11-06T01:00:00Z' }
    Object.assign(goon, { closet: { items: { older, local } } })
    const saved = owners.createSavedClosetPreviewContext(goon)
    expect(saved.resolveItem('global')).toEqual(local)
    expect(saved.resolveItem('local')).toEqual(local)
    expect(saved.resolveItem('missing')).toBeNull()
    expect(saved.resolveItem(undefined)).toBeNull()
  })

  it('takes runtime color fallbacks from the selected item and actual target engine', () => {
    const { context, engine } = fixture()
    Object.assign(context, { normalizeHexColor, xwearColorToHex,
      resolveClosetSlotSourceColors: vi.fn(() => ({ baseHex: '#ff0000', shadeHex: '#ff0000' })) })
    Object.assign(engine, { getMaterialColorInfo: vi.fn(() => ({ baseHex: '#123456', shadeHex: '#654321' })) })
    const owners = panelOwners(context, ['resolveAppliedClosetColors', 'resolveClosetItemMaterialColors'])
    expect(owners.resolveAppliedClosetColors(engine, 'shirt')).toEqual({ baseHex: '#123456', shadeHex: '#654321' })
    expect(owners.resolveAppliedClosetColors(engine, 'shirt', { materialColors: { baseHex: '#20a059', shadeHex: '#166c3f' } }))
      .toEqual({ baseHex: '#20A059', shadeHex: '#166C3F' })
    context.isSkinOverlayClosetSlotKey = () => true
    expect(owners.resolveAppliedClosetColors(engine, 'skin-overlay')).toEqual({ baseHex: undefined, shadeHex: undefined })
    expect(context.resolveClosetSlotSourceColors).not.toHaveBeenCalled()
  })

})
