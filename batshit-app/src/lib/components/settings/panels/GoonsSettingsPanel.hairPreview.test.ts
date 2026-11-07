// @vitest-environment jsdom
import { createRecipePreviewAttempt } from '$lib/goons/recipe/recipePreviewAttempt'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createHairState, parseHairState, validateHairStateBinding, type HairAssetV1 } from '$lib/goons/hairAssets'
import {
  classifyHairAssetAvailability, createHairCatalogSelection, hairStateEquals,
  resolveHairAssetBrowserUrl, resolveHairSelectionCatalogStatus
} from '$lib/goons/hairCatalog'
import { RECIPE_SOURCE_CONTRACT, type RecipeSourceIdentity } from '$lib/goons/recipe/packageMetadata'
import { canonicalRecipeString } from '$lib/goons/recipe/recipeCanonical'

/** Exercise the actual panel owners with controlled async boundaries, using
 * the existing panel writer-contract test's source-extraction approach. */
function extractPanelOwners(context: Record<string, any>, names: string[]) {
  const script = readFileSync('src/lib/components/settings/panels/GoonsSettingsPanel.svelte', 'utf8')
    .split('<script lang="ts">')[1]!.split('</script>')[0]!
  const file = ts.createSourceFile('GoonsSettingsPanel.ts', script, ts.ScriptTarget.Latest, true)
  const declarations = file.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text))
  if (declarations.length !== names.length) throw new Error('The panel Hair preview owners were not found')
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

function panelOwners(context: Record<string, any>) {
  return extractPanelOwners(context, ['applyHairStatePreview', 'captureEditorHairPreviewOwner',
    'captureEditorHairEditOwner', 'selectEditorHairAsset', 'updateEditorHairColors',
    'updateEditorHairMotionTuning']) as {
    applyHairStatePreview: (...args: any[]) => Promise<any>
    selectEditorHairAsset: (...args: any[]) => Promise<void>
    updateEditorHairColors: (...args: any[]) => Promise<void>
    updateEditorHairMotionTuning: (...args: any[]) => Promise<void>
  }
}

function panelReadinessOwners(context: Record<string, any>) {
  return extractPanelOwners(context, ['currentEditorHairPreviewContext', 'isMountedEditorHairPreview',
    'isSettledEditorHairPreview', 'ensureSeparateEditorHairPreview']) as { ensureSeparateEditorHairPreview: () => Promise<any> }
}

function actualStyle() {
  const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'static/goon-assets/hair/v2/catalog.json'), 'utf8')) as {
    assets: HairAssetV1[]
  }
  const r1 = catalog.assets.find((asset) => asset.revisionId === 'batshit-style-01-r1')!
  const r2 = catalog.assets.find((asset) => asset.revisionId === 'batshit-style-01-r2')!
  const fit = r1.attachment.fitReceipt
  const source: RecipeSourceIdentity = {
    contract: RECIPE_SOURCE_CONTRACT, schemaVersion: 1,
    baseId: r1.compatibility.baseId, fitFamily: r1.compatibility.fitFamily,
    modelSha256: '1'.repeat(64), manifestSemanticSha256: '2'.repeat(64),
    definitionSha256: fit.appearanceDefinitionSha256, neutralId: 'neutral', neutralRecipeSha256: '3'.repeat(64),
    physicalBasisSha256: fit.physicalBasisSha256, behaviorSha256: '4'.repeat(64),
    componentGraphSha256: '5'.repeat(64), topologySha256: fit.topologySha256,
    skeletonHierarchySha256: fit.skeletonHierarchySha256
  }
  return { r1, r2, source }
}

function contextFor(source: RecipeSourceIdentity, state: ReturnType<typeof createHairState>) {
  const engine = { clearHairPreview: vi.fn(), loadHairAssetPreview: vi.fn().mockResolvedValue({ meshCount: 1, triangleCount: 2 }),
    getHairMotionPreviewTuning: vi.fn().mockReturnValue(null), updateHairPreviewColors: vi.fn(),
    updateHairMotionPreviewTuning: vi.fn() }
  const context: Record<string, any> = {
      parseHairState, createHairState, validateHairStateBinding,
      classifyHairAssetAvailability, createHairCatalogSelection, hairStateEquals,
      resolveHairAssetBrowserUrl, resolveHairSelectionCatalogStatus,
      BATSHIT_SERVER_URL: 'http://127.0.0.1:5641',
      editorHairSupported: true, editorGoonId: 'first-goon', editorHairHydrationGoonId: 'first-goon', editorHairRecipeSource: source,
      editorHairState: state, previewEngine: engine, previewToken: 1,
      previewReady: true, previewGoonId: 'first-goon', editorSavedSphericalPreview: false,
      previewLoading: false, previewAnimationSyncing: false,
      previewContextSignature: 'first-signature', previewVrmUrl: '/first.glb',
      clothingPreviewGoon: null, hairPreviewOperation: 0, hairColorEditOperation: 0, hairMotionEditOperation: 0,
      ensureSeparateEditorHairPreview: vi.fn().mockResolvedValue(engine),
      ensureHairCatalog: vi.fn(), hairPreviewError: null, hairPreviewBusy: false,
      editorHairStateError: null, editorDirty: false,
      beginEditorSourceMotionMutation: vi.fn().mockReturnValue(true),
      toast: { error: vi.fn(), success: vi.fn() }
  }
  context.markEditorDirty = () => { context.editorDirty = true }
  context.currentEditorHairPreviewContext = () => ({ goonId: context.editorGoonId,
    signature: 'first-signature', url: '/first.glb' })
  context.isSettledEditorHairPreview = (value: { goonId: string; signature: string; url: string } | null) =>
    Boolean(value && !context.previewLoading && !context.previewAnimationSyncing && context.previewReady && context.previewEngine &&
      context.previewGoonId === value.goonId && context.previewContextSignature === value.signature &&
      context.previewVrmUrl === value.url)
  return { engine, context }
}

function retrySettlementFixture() {
  const { r1, source } = actualStyle()
  const state = createHairState(r1)
  const { context } = contextFor(source, state)
  Object.assign(context, {
    canonicalRecipeString, editorDirtyEpoch: 0, editorInstanceEpoch: 1, editorDirtyHasOther: false,
    hasActiveHairImport: () => Boolean(context.importActive), clothingPreviewBusy: false,
    clothingImportOperation: null, closetXWearBusy: false, editorFacialArtworkUploadBusy: false,
    guidedUploadBusy: false, customUploadBusy: false, animationUploadBusy: false, libraryUploadBusy: false,
    editorPendingVrmFile: null, editorPendingVrmUpdate: null, editorPendingAdvancedPackageUpdate: null
  })
  const owners = extractPanelOwners(context, ['markEditorDirty', 'clearEditorDirty', 'invalidateRetrySettlement',
    'setEditorArtworkUploadBusy', 'captureHairRetrySettlement']) as {
    markEditorDirty: (kind?: 'hair' | 'other') => void
    clearEditorDirty: () => void
    invalidateRetrySettlement: () => void
    setEditorArtworkUploadBusy: (busy: boolean) => void
    captureHairRetrySettlement: (reviewed: any) => ((committed: any) => void) | null
  }
  Object.assign(context, owners)
  const reviewed = { stateSha256: 'reviewed-state', siblings: [{ id: 'hairState', contract: 'hair-state/v2', state }] }
  const committed = { id: 'first-goon', recipe: { contract: 'goon-recipe/v2', liveStatus: 'up_to_date',
    activeRevision: { ref: 'active' }, pendingJob: null,
    authoringRevision: { state: structuredClone(reviewed), source: { identities: source } } } }
  return { context, owners, reviewed, committed, state }
}

function readinessContext() {
  const engine = {}
  const target = { id: 'first-goon', signature: 'wanted-signature', url: '/wanted.glb' }
  const context: Record<string, any> = {
    editorGoon: target, editorRecipeSourceGoon: target, recipeStagedPreviewGoon: null,
    recipeEditorPreviewTarget: null, clothingPreviewGoon: null, editorSavedSphericalPreview: false,
    resolveGoonSettingsPreviewTarget: ({ editorGoon }: { editorGoon: unknown }) => editorGoon,
    hasRenderableGoonAvatar: () => true, editorPreviewModeFor: () => 'editor',
    resolveRecipePreviewGoonAssetUrls: (goon: unknown) => goon,
    buildPreviewContextSignature: (goon: typeof target) => goon.signature,
    resolveGoonAvatarUrl: (goon: typeof target) => goon.url, BATSHIT_SERVER_URL: 'http://127.0.0.1:5641',
    previewEngine: engine, previewGoonId: target.id, previewReady: true, previewLoading: false,
    previewAnimationSyncing: false, previewAnimationSyncPromise: null, previewToken: 1,
    previewContextSignature: 'old-signature', previewVrmUrl: '/old.glb',
    previewLoadInFlightSignature: '', previewLoadCompletion: null,
    ensurePreviewGoonReady: vi.fn().mockResolvedValue(engine)
  }
  return { engine, target, context }
}

describe('Goon editor retained Hair preview ownership', () => {
  it('waits for the actual matching in-flight preview before returning its engine', async () => {
    const { engine, context } = readinessContext()
    let finish!: () => void
    context.previewLoading = true
    context.previewLoadInFlightSignature = 'wanted-signature'
    context.previewLoadCompletion = new Promise<void>((resolvePromise) => { finish = resolvePromise })
    const pending = panelReadinessOwners(context).ensureSeparateEditorHairPreview()
    await Promise.resolve()
    expect(context.ensurePreviewGoonReady).not.toHaveBeenCalled()
    context.previewLoading = false
    context.previewContextSignature = 'wanted-signature'
    context.previewVrmUrl = '/wanted.glb'
    finish()
    await expect(pending).resolves.toBe(engine)
    expect(context.ensurePreviewGoonReady).not.toHaveBeenCalled()
  })

  it('refuses a different in-flight preview and a context changed during the wait', async () => {
    const first = readinessContext()
    first.context.previewLoading = true
    first.context.previewLoadInFlightSignature = 'unrelated-signature'
    await expect(panelReadinessOwners(first.context).ensureSeparateEditorHairPreview())
      .rejects.toThrow('Another Goon preview is loading')
    expect(first.context.ensurePreviewGoonReady).not.toHaveBeenCalled()

    const second = readinessContext()
    let finish!: () => void
    second.context.previewLoading = true
    second.context.previewLoadInFlightSignature = 'wanted-signature'
    second.context.previewLoadCompletion = new Promise<void>((resolvePromise) => { finish = resolvePromise })
    const pending = panelReadinessOwners(second.context).ensureSeparateEditorHairPreview()
    second.target.signature = 'newer-signature'
    second.context.previewLoading = false
    second.context.previewContextSignature = 'wanted-signature'
    second.context.previewVrmUrl = '/wanted.glb'
    finish()
    await expect(pending).rejects.toThrow('The Goon preview changed')
    expect(second.context.ensurePreviewGoonReady).not.toHaveBeenCalled()
  })

  it('allows the helper to load its own new context before returning', async () => {
    const { engine, context } = readinessContext()
    context.ensurePreviewGoonReady.mockImplementation(async () => {
      context.previewContextSignature = 'wanted-signature'
      context.previewVrmUrl = '/wanted.glb'
      return engine
    })
    await expect(panelReadinessOwners(context).ensureSeparateEditorHairPreview()).resolves.toBe(engine)
    expect(context.ensurePreviewGoonReady).toHaveBeenCalledOnce()
  })

  it('waits for animation synchronization and refuses a replaced preview', async () => {
    const first = readinessContext()
    first.context.previewContextSignature = 'wanted-signature'
    first.context.previewVrmUrl = '/wanted.glb'
    first.context.previewAnimationSyncing = true
    let finish!: () => void
    first.context.previewAnimationSyncPromise = new Promise<void>((resolvePromise) => { finish = resolvePromise })
    const pending = panelReadinessOwners(first.context).ensureSeparateEditorHairPreview()
    first.context.previewAnimationSyncing = false
    finish()
    await expect(pending).resolves.toBe(first.engine)
    expect(first.context.ensurePreviewGoonReady).not.toHaveBeenCalled()

    const second = readinessContext()
    second.context.previewContextSignature = 'wanted-signature'
    second.context.previewVrmUrl = '/wanted.glb'
    second.context.previewAnimationSyncing = true
    let finishOld!: () => void
    second.context.previewAnimationSyncPromise = new Promise<void>((resolvePromise) => { finishOld = resolvePromise })
    const stale = panelReadinessOwners(second.context).ensureSeparateEditorHairPreview()
    second.context.previewToken += 1
    second.context.previewAnimationSyncing = false
    finishOld()
    await expect(stale).rejects.toThrow('preview changed while its animations loaded')
  })

  it('mounts an exact historical saved fit without changing its palette or motion', async () => {
    const { r1, r2, source } = actualStyle()
    const state = createHairState(r1, { baseColor: '#123456', highlightColor: '#abcdef',
      motionSettings: { enabled: false, intensity: 0.42 } })
    const before = JSON.stringify(state)
    const { engine, context } = contextFor(source, state)
    context.ensureHairCatalog.mockResolvedValue([r2, r1])
    const owners = panelOwners(context)
    await owners.applyHairStatePreview(engine, state, source, () => {})
    expect(engine.loadHairAssetPreview).toHaveBeenCalledOnce()
    expect(engine.loadHairAssetPreview.mock.calls[0]![0]).toEqual(r1)
    expect(engine.loadHairAssetPreview.mock.calls[0]![1]).toEqual(state)
    expect(JSON.stringify(state)).toBe(before)
    expect(context.editorDirty).toBe(false)
  })

  it('restores an explicitly selected prior fit with its exact colors and motion', async () => {
    const { r1, r2, source } = actualStyle()
    const restored = createHairState(r1, { baseColor: '#123456', highlightColor: '#abcdef',
      motionSettings: { enabled: false, intensity: 0.42 } })
    const none = createHairState(null, { baseColor: restored.baseColor, highlightColor: restored.highlightColor })
    const { engine, context } = contextFor(source, none)
    context.ensureHairCatalog.mockResolvedValue([r2, r1])
    await panelOwners(context).selectEditorHairAsset(r1, restored)
    expect(engine.loadHairAssetPreview).toHaveBeenCalledOnce()
    expect(engine.loadHairAssetPreview.mock.calls[0]![1]).toEqual(restored)
    expect(context.editorHairState).toEqual(restored)
    expect(context.editorDirty).toBe(true)
  })

  it('does not publish or assign a late selection to a changed Goon', async () => {
    const { r1, r2, source } = actualStyle()
    const { engine, context } = contextFor(source, createHairState(null))
    let resolveCatalog!: (assets: HairAssetV1[]) => void
    context.ensureHairCatalog.mockReturnValue(new Promise<HairAssetV1[]>((resolvePromise) => { resolveCatalog = resolvePromise }))
    const owners = panelOwners(context)
    const loading = owners.selectEditorHairAsset(r1)
    await vi.waitFor(() => expect(context.ensureHairCatalog).toHaveBeenCalledOnce())
    const otherState = createHairState(null, { baseColor: '#654321', highlightColor: '#fedcba' })
    context.editorGoonId = 'second-goon'
    context.editorHairState = otherState
    resolveCatalog([r2, r1])
    await loading
    expect(engine.loadHairAssetPreview).not.toHaveBeenCalled()
    expect(context.editorHairState).toBe(otherState)
    expect(context.editorDirty).toBe(false)
    expect(context.toast.error).not.toHaveBeenCalled()
  })

  it('does not publish an old error or clear a newer busy owner after a same-Goon preview replacement', async () => {
    const { r1, r2, source } = actualStyle()
    const { engine, context } = contextFor(source, createHairState(null))
    let resolveCatalog!: (assets: HairAssetV1[]) => void
    context.ensureHairCatalog.mockReturnValue(new Promise<HairAssetV1[]>((resolvePromise) => { resolveCatalog = resolvePromise }))
    const loading = panelOwners(context).selectEditorHairAsset(r1)
    await vi.waitFor(() => expect(context.ensureHairCatalog).toHaveBeenCalledOnce())
    context.previewToken += 1
    context.previewEngine = { ...engine }
    context.hairPreviewOperation += 1
    context.hairPreviewBusy = true
    context.hairPreviewError = 'newer preview error'
    resolveCatalog([r2, r1])
    await loading
    expect(engine.loadHairAssetPreview).not.toHaveBeenCalled()
    expect(context.hairPreviewError).toBe('newer preview error')
    expect(context.hairPreviewBusy).toBe(true)
    expect(context.editorHairState.selected).toBeNull()
    expect(context.toast.error).not.toHaveBeenCalled()
  })

  it('releases its own busy state without publishing an error when only the preview token changes', async () => {
    const { r1, r2, source } = actualStyle()
    const { context } = contextFor(source, createHairState(null))
    let resolveCatalog!: (assets: HairAssetV1[]) => void
    context.ensureHairCatalog.mockReturnValue(new Promise<HairAssetV1[]>((resolvePromise) => { resolveCatalog = resolvePromise }))
    const loading = panelOwners(context).selectEditorHairAsset(r1)
    await vi.waitFor(() => expect(context.ensureHairCatalog).toHaveBeenCalledOnce())
    context.previewToken += 1
    context.hairPreviewError = 'newer preview error'
    resolveCatalog([r2, r1])
    await loading
    expect(context.hairPreviewError).toBe('newer preview error')
    expect(context.hairPreviewBusy).toBe(false)
    expect(context.editorHairState.selected).toBeNull()
  })

  it('refuses a retained fit against a different Source before mounting it', async () => {
    const { r1, r2, source } = actualStyle()
    const state = createHairState(r1, { baseColor: '#123456', highlightColor: '#abcdef' })
    const before = JSON.stringify(state)
    const { engine, context } = contextFor(source, state)
    context.ensureHairCatalog.mockResolvedValue([r2, r1])
    await expect(panelOwners(context).applyHairStatePreview(
      engine, state, { ...source, topologySha256: 'f'.repeat(64) }, () => {}
    )).rejects.toThrow(/fit receipt is stale/)
    expect(engine.loadHairAssetPreview).not.toHaveBeenCalled()
    expect(JSON.stringify(state)).toBe(before)
  })

  it('surfaces a failed catalog read while retaining the prior selected state', async () => {
    const { r1, source } = actualStyle()
    const state = createHairState(null, { baseColor: '#123456', highlightColor: '#abcdef' })
    const before = JSON.stringify(state)
    const { engine, context } = contextFor(source, state)
    context.ensureHairCatalog.mockRejectedValue(new Error('catalog unavailable'))
    await panelOwners(context).selectEditorHairAsset(r1)
    expect(engine.loadHairAssetPreview).not.toHaveBeenCalled()
    expect(JSON.stringify(context.editorHairState)).toBe(before)
    expect(context.editorDirty).toBe(false)
    expect(context.hairPreviewError).toBe('catalog unavailable')
  })

  it('does not apply a delayed color edit or error to a different Goon', async () => {
    const { r1, source } = actualStyle()
    const { engine, context } = contextFor(source, createHairState(r1))
    let resolveEngine!: (value: typeof engine) => void
    context.ensureSeparateEditorHairPreview.mockReturnValue(new Promise((resolvePromise) => { resolveEngine = resolvePromise }))
    const pending = panelOwners(context).updateEditorHairColors({ baseColor: '#123456', highlightColor: '#abcdef' })
    const other = createHairState(null, { baseColor: '#654321', highlightColor: '#fedcba' })
    context.editorGoonId = 'second-goon'
    context.editorHairState = other
    context.hairPreviewError = 'newer preview error'
    resolveEngine(engine)
    await pending
    expect(engine.updateHairPreviewColors).not.toHaveBeenCalled()
    expect(context.editorHairState).toBe(other)
    expect(context.hairPreviewError).toBe('newer preview error')
    expect(context.editorDirty).toBe(false)
  })

  it('refuses a delayed motion edit after the same Goon preview is replaced', async () => {
    const { r1, source } = actualStyle()
    const state = createHairState(r1)
    const { engine, context } = contextFor(source, state)
    let resolveEngine!: (value: typeof engine) => void
    context.ensureSeparateEditorHairPreview.mockReturnValue(new Promise((resolvePromise) => { resolveEngine = resolvePromise }))
    const pending = panelOwners(context).updateEditorHairMotionTuning({ enabled: false, intensity: 0.42 })
    context.previewToken += 1
    context.hairPreviewError = 'newer preview error'
    resolveEngine(engine)
    await pending
    expect(engine.updateHairMotionPreviewTuning).not.toHaveBeenCalled()
    expect(context.editorHairState).toBe(state)
    expect(context.hairPreviewError).toBe('newer preview error')
  })

  it.each(['source', 'selection', 'hydration'] as const)(
    'does not apply pending color or motion after the %s changes', async (changed) => {
      const { r1, source } = actualStyle()
      const { engine, context } = contextFor(source, createHairState(r1))
      let resolveColor!: (value: typeof engine) => void
      let resolveMotion!: (value: typeof engine) => void
      context.ensureSeparateEditorHairPreview
        .mockReturnValueOnce(new Promise((resolvePromise) => { resolveColor = resolvePromise }))
        .mockReturnValueOnce(new Promise((resolvePromise) => { resolveMotion = resolvePromise }))
      const owners = panelOwners(context)
      const color = owners.updateEditorHairColors({ baseColor: '#123456', highlightColor: '#abcdef' })
      const motion = owners.updateEditorHairMotionTuning({ enabled: false, intensity: 0.42 })
      if (changed === 'source') context.editorHairRecipeSource = { ...source, topologySha256: 'f'.repeat(64) }
      else if (changed === 'selection') context.editorHairState = createHairState(null)
      else context.editorHairHydrationGoonId = 'second-goon'
      const currentState = context.editorHairState
      context.hairPreviewError = 'newer preview error'
      resolveColor(engine)
      resolveMotion(engine)
      await Promise.all([color, motion])
      expect(engine.updateHairPreviewColors).not.toHaveBeenCalled()
      expect(engine.updateHairMotionPreviewTuning).not.toHaveBeenCalled()
      expect(context.editorHairState).toBe(currentState)
      expect(context.hairPreviewError).toBe('newer preview error')
      expect(context.editorDirty).toBe(false)
    }
  )

  it('permits its own necessary preview transition and merges color with motion', async () => {
    const { r1, source } = actualStyle()
    const { engine, context } = contextFor(source, createHairState(r1))
    context.previewReady = false
    let resolveColor!: (value: typeof engine) => void
    let resolveMotion!: (value: typeof engine) => void
    context.ensureSeparateEditorHairPreview
      .mockReturnValueOnce(new Promise((resolvePromise) => { resolveColor = resolvePromise }))
      .mockReturnValueOnce(new Promise((resolvePromise) => { resolveMotion = resolvePromise }))
    const owners = panelOwners(context)
    const color = owners.updateEditorHairColors({ baseColor: '#123456', highlightColor: '#abcdef' })
    const motion = owners.updateEditorHairMotionTuning({ enabled: false, intensity: 0.42 })
    context.previewToken += 1
    context.previewReady = true
    resolveMotion(engine)
    await motion
    resolveColor(engine)
    await color
    expect(context.editorHairState).toMatchObject({ baseColor: '#123456', highlightColor: '#abcdef',
      motionSettings: { enabled: false, intensity: 0.42 } })
    expect(engine.updateHairMotionPreviewTuning).toHaveBeenCalledOnce()
    expect(engine.updateHairPreviewColors).toHaveBeenCalledOnce()
  })

  it('permits a necessary same-Goon context reload before applying a color edit', async () => {
    const { r1, source } = actualStyle()
    const { engine, context } = contextFor(source, createHairState(r1))
    context.previewContextSignature = 'stale-signature'
    context.ensureSeparateEditorHairPreview.mockImplementation(async () => {
      context.previewToken += 1
      context.previewContextSignature = 'first-signature'
      return engine
    })
    await panelOwners(context).updateEditorHairColors({ baseColor: '#123456', highlightColor: '#abcdef' })
    expect(engine.updateHairPreviewColors).toHaveBeenCalledOnce()
    expect(context.editorHairState).toMatchObject({ baseColor: '#123456', highlightColor: '#abcdef' })
  })

  it('keeps the newest color request when two edits settle out of order', async () => {
    const { r1, source } = actualStyle()
    const { engine, context } = contextFor(source, createHairState(r1))
    let resolveOld!: (value: typeof engine) => void
    let resolveNew!: (value: typeof engine) => void
    context.ensureSeparateEditorHairPreview
      .mockReturnValueOnce(new Promise((resolvePromise) => { resolveOld = resolvePromise }))
      .mockReturnValueOnce(new Promise((resolvePromise) => { resolveNew = resolvePromise }))
    const owners = panelOwners(context)
    const old = owners.updateEditorHairColors({ baseColor: '#111111', highlightColor: '#222222' })
    const next = owners.updateEditorHairColors({ baseColor: '#333333', highlightColor: '#444444' })
    resolveNew(engine)
    await next
    resolveOld(engine)
    await old
    expect(context.editorHairState).toMatchObject({ baseColor: '#333333', highlightColor: '#444444' })
    expect(engine.updateHairPreviewColors).toHaveBeenCalledOnce()
  })

  it('reports a current preview failure without changing the saved draft', async () => {
    const { r1, source } = actualStyle()
    const state = createHairState(r1)
    const { context } = contextFor(source, state)
    context.ensureSeparateEditorHairPreview.mockRejectedValue(new Error('preview unavailable'))
    await panelOwners(context).updateEditorHairColors({ baseColor: '#123456', highlightColor: '#abcdef' })
    expect(context.editorHairState).toBe(state)
    expect(context.editorDirty).toBe(false)
    expect(context.hairPreviewError).toBe('preview unavailable')
    expect(context.toast.error).toHaveBeenCalledWith('preview unavailable')
  })

  it('clears only an exact Hair-only draft after the captured Retry commits', () => {
    const { context, owners, reviewed, committed, state } = retrySettlementFixture()
    owners.markEditorDirty('hair')
    const settle = owners.captureHairRetrySettlement(reviewed)
    expect(settle).toBeTypeOf('function')
    settle!(committed)
    expect(context.editorDirty).toBe(false)
    expect(context.editorHairState).toEqual(state)
    expect(context.editorDirtyEpoch).toBe(2)
  })

  it('keeps mixed or preexisting non-Hair edits after Retry', () => {
    const first = retrySettlementFixture()
    first.owners.markEditorDirty()
    first.owners.markEditorDirty('hair')
    expect(first.owners.captureHairRetrySettlement(first.reviewed)).toBeNull()
    expect(first.context.editorDirty).toBe(true)
    const later = retrySettlementFixture()
    later.owners.markEditorDirty('hair')
    const settle = later.owners.captureHairRetrySettlement(later.reviewed)!
    later.owners.markEditorDirty()
    settle(later.committed)
    expect(later.context.editorDirty).toBe(true)
  })

  it('keeps a same-value Hair edit or A-B-A editor replacement made during Retry', () => {
    const later = retrySettlementFixture()
    later.owners.markEditorDirty('hair')
    const settle = later.owners.captureHairRetrySettlement(later.reviewed)!
    later.owners.markEditorDirty('hair')
    settle(later.committed)
    expect(later.context.editorDirty).toBe(true)
    const replaced = retrySettlementFixture()
    replaced.owners.markEditorDirty('hair')
    const stale = replaced.owners.captureHairRetrySettlement(replaced.reviewed)!
    replaced.context.editorGoonId = 'other-goon'
    replaced.context.editorInstanceEpoch += 1
    replaced.context.editorGoonId = 'first-goon'
    replaced.context.editorInstanceEpoch += 1
    stale(replaced.committed)
    expect(replaced.context.editorDirty).toBe(true)
  })

  it('keeps the draft for a mismatched committed state, source, or Hair value', () => {
    for (const change of [
      (value: any) => { value.recipe.authoringRevision.state.stateSha256 = 'different' },
      (value: any) => { value.recipe.authoringRevision.source.identities.modelSha256 = 'f'.repeat(64) },
      (value: any) => { value.recipe.authoringRevision.state.siblings[0].state.baseColor = '#123456' },
      (value: any) => { value.recipe.liveStatus = 'failed' }
    ]) {
      const fixture = retrySettlementFixture()
      fixture.owners.markEditorDirty('hair')
      const settle = fixture.owners.captureHairRetrySettlement(fixture.reviewed)!
      const committed = structuredClone(fixture.committed)
      change(committed)
      settle(committed)
      expect(fixture.context.editorDirty).toBe(true)
    }
  })

  it('does not clear a draft while an import, upload or newer preview is pending', () => {
    for (const field of ['importActive', 'editorFacialArtworkUploadBusy', 'hairPreviewBusy', 'editorPendingVrmFile']) {
      const fixture = retrySettlementFixture()
      fixture.owners.markEditorDirty('hair')
      fixture.context[field] = true
      expect(fixture.owners.captureHairRetrySettlement(fixture.reviewed)).toBeNull()
      fixture.context[field] = false
      const settle = fixture.owners.captureHairRetrySettlement(fixture.reviewed)!
      fixture.context[field] = true
      settle(fixture.committed)
      expect(fixture.context.editorDirty).toBe(true)
    }
    const newer = retrySettlementFixture()
    newer.owners.markEditorDirty('hair')
    const settle = newer.owners.captureHairRetrySettlement(newer.reviewed)!
    newer.context.hairColorEditOperation += 1
    settle(newer.committed)
    expect(newer.context.editorDirty).toBe(true)
    const transient = retrySettlementFixture()
    transient.owners.markEditorDirty('hair')
    const stale = transient.owners.captureHairRetrySettlement(transient.reviewed)!
    transient.owners.setEditorArtworkUploadBusy(true)
    transient.owners.setEditorArtworkUploadBusy(false)
    stale(transient.committed)
    expect(transient.context.editorDirty).toBe(true)
  })

  it('keeps dirty epochs monotonic across ordinary reset and reopen', () => {
    const { context, owners } = retrySettlementFixture()
    owners.markEditorDirty('hair')
    owners.clearEditorDirty()
    expect(context.editorDirtyEpoch).toBe(2)
    owners.markEditorDirty()
    expect(context.editorDirtyEpoch).toBe(3)
    expect(context.editorDirtyHasOther).toBe(true)
  })
})

describe('staged Recipe preview cancellation owns the real panel load and restoration', () => {
  function stagedOwners(stage: 'model' | 'animation') {
    let finishCandidate!: () => void, finishRestoration!: () => void
    const candidateGate = new Promise<void>(resolve => { finishCandidate = resolve })
    const restorationGate = new Promise<void>(resolve => { finishRestoration = resolve })
    const previous = { id: 'preview-goon', customAvatar: { model: { url: '/previous.glb' } } }
    const candidate = { id: 'preview-goon', customAvatar: { model: { url: '/candidate.glb' } } }
    const engine: any = { generation: 0, mountedUrl: '/previous.glb', animation: 'previous',
      refreshLayout: vi.fn(), captureComparisonPreviewState: () => ({ marker: 'original-view' }),
      restoreComparisonPreviewState: vi.fn(), setGoonVisible: vi.fn(), setCameraChangeHandler: vi.fn(),
      getAnimationCatalog: () => [], getMaterialNames: () => [], getCustomExpressionNames: () => [],
      unloadGoon: vi.fn(() => { engine.generation++; engine.mountedUrl = null; engine.animation = null }) }
    const scope: Record<string, any> = { createRecipePreviewAttempt, stagedPreviewAttempt: null,
      recipeStagedPreviewGoon: null, recipeEditorPreviewTarget: null, clothingPreviewGoon: null,
      editorDefaultPreviewGoon: previous, editorPreviewModeFor: () => 'editor',
      projectStagedRecipeLiveCandidate: () => candidate, recipePreviewTransitioning: false,
      previewContainer: document.createElement('div'), previewEngine: engine, previewToken: 0,
      previewReady: true, previewLoading: false, previewAnimationSyncing: false,
      previewAnimationSyncPromise: null, previewLoadCompletion: null,
      previewGoonId: previous.id, previewVrmUrl: '/previous.glb', previewContextSignature: 'editor:/previous.glb',
      previewFailedContextSignature: '', previewLoadInFlightSignature: '', previewLoadInFlightPriority: null,
      editorGoonId: previous.id, editorHairState: null, editorBuilderPreviewOpen: false, editorBuilderMotionTesting: false,
      resolveRecipePreviewGoonAssetUrls: (goon: any) => goon,
      resolveGoonAvatarUrl: (goon: any) => goon.customAvatar.model.url,
      buildPreviewContextSignature: (goon: any, mode: string) => `${mode}:${goon.customAvatar.model.url}`,
      shouldAdmitGoonSettingsPreviewLoad: () => true,
      resetEditorSourceMotionInteractionOwners: vi.fn(), bindSourceMotionQuarantine: vi.fn(),
      ensurePreviewEngine: async () => engine,
      recipeEditorPreviewLoadPolicy: () => ({ role: 'recipe-live-candidate', mountSeparateHair: false }),
      editorPreviewIntent: { capture: () => ({}), isCurrent: () => true },
      applyHairStatePreview: async () => null, resolveAnimationFiles: () => [], resolveCueMapForPreviewGoon: () => ({}),
      buildPreviewAnimationLoadPlan: () => ({ eager: [], deferred: [] }), resolveSceneForPreviewGoon: () => null,
      applyGoonSceneDefinition: async () => {}, stagePostureMap: {}, applyPreviewCamera: vi.fn(),
      resolvePreviewCameraForGoon: () => null, applyEditorPreviewLoopState: vi.fn(), buildGoonSceneSignature: () => 'scene',
      applyPendingEditorOpeningFrame: vi.fn(), applyEditorBuilderPreviewPolicy: vi.fn(), restorePreviewCameraPersistence: vi.fn(),
      toGoonPreviewError: (error: unknown) => error, toast: { error: vi.fn() } }
    scope.loadAvatarIntoEngine = vi.fn(async (_engine: any, goon: any) => {
      const token = ++engine.generation
      const candidateLoad = goon.customAvatar.model.url === '/candidate.glb'
      if (!candidateLoad) await restorationGate
      else if (stage === 'model') await candidateGate
      if (token !== engine.generation) return { kind: 'custom', role: 'cancelled' }
      engine.mountedUrl = goon.customAvatar.model.url
      return { kind: 'custom', role: 'live' }
    })
    engine.syncAnimations = vi.fn(async () => {
      const token = engine.generation, url = engine.mountedUrl
      if (url === '/candidate.glb' && stage === 'animation') await candidateGate
      if (token === engine.generation) engine.animation = url
    })
    const owners = extractPanelOwners(scope, ['loadPreviewGoon', 'previewStagedRecipeLiveCandidate'])
    Object.assign(scope, owners)
    return { scope, engine, owners, finishCandidate, finishRestoration }
  }

  it.each([['model', 'cancel'], ['animation', 'cancel'], ['model', 'timeout'], ['animation', 'timeout']] as const)(
    'bounds a delayed %s on %s, restores before releasing custody and fences its late completion', async (stage, reason) => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = stagedOwners(stage), abort = new AbortController()
      let settled = false
      const outcome = h.owners.previewStagedRecipeLiveCandidate({} as any, { signal: abort.signal })
        .catch((error: unknown) => error).then((value: unknown) => { settled = true; return value })
      await vi.advanceTimersByTimeAsync(0)
      expect(h.scope.loadAvatarIntoEngine).toHaveBeenCalledOnce()
      const candidateSignal = h.scope.stagedPreviewAttempt.signal
      expect(h.scope.loadAvatarIntoEngine.mock.calls[0]![2].signal).toBe(candidateSignal)
      if (stage === 'animation') {
        expect(h.engine.syncAnimations).toHaveBeenCalledOnce()
        expect(h.engine.syncAnimations.mock.calls[0]![1].signal).toBe(candidateSignal)
      }
      if (reason === 'cancel') abort.abort(new DOMException('Stop staged preview.', 'AbortError'))
      else await vi.advanceTimersByTimeAsync(15 * 60_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.engine.unloadGoon).toHaveBeenCalledOnce()
      expect(h.scope.loadAvatarIntoEngine).toHaveBeenCalledTimes(2)
      expect(h.scope.loadAvatarIntoEngine.mock.calls[1]![2].signal.aborted).toBe(false)
      expect(settled).toBe(false)
      expect(h.scope.recipePreviewTransitioning).toBe(true)
      h.finishRestoration()
      expect(await outcome).toMatchObject({ name: reason === 'cancel' ? 'AbortError' : 'TimeoutError' })
      expect(h.engine.mountedUrl).toBe('/previous.glb')
      expect(h.scope.previewVrmUrl).toBe('/previous.glb')
      expect(h.scope.stagedPreviewAttempt).toBeNull()
      expect(h.scope.recipePreviewTransitioning).toBe(false)
      const generation = h.engine.generation, publications = h.engine.setGoonVisible.mock.calls.length
      h.finishCandidate()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.engine.generation).toBe(generation)
      expect(h.engine.mountedUrl).toBe('/previous.glb')
      expect(h.scope.previewVrmUrl).toBe('/previous.glb')
      expect(h.engine.setGoonVisible).toHaveBeenCalledTimes(publications)
      expect(vi.getTimerCount()).toBe(0)
    } finally { log.mockRestore(); vi.useRealTimers() }
  })

  it('bounds a stalled prior-preview recovery and reports both failures without a ready result', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = stagedOwners('model'), abort = new AbortController()
      const outcome = h.owners.previewStagedRecipeLiveCandidate({} as any, { signal: abort.signal }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      abort.abort(new DOMException('Stop staged preview.', 'AbortError'))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30_000)
      const error = await outcome as AggregateError
      expect(error).toBeInstanceOf(AggregateError)
      expect(error.errors).toMatchObject([{ name: 'AbortError' }, { name: 'TimeoutError' }])
      expect(h.engine.unloadGoon).toHaveBeenCalledTimes(2)
      expect(h.scope.stagedPreviewAttempt).toBeNull()
      expect(h.scope.recipePreviewTransitioning).toBe(false)
      h.finishRestoration(); h.finishCandidate()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.engine.mountedUrl).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally { log.mockRestore(); vi.useRealTimers() }
  })
})
