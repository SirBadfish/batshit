<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import {
    canonicalRecipeString,
    classifyRecipeAuthorUpdatePlan,
    classifyRecipeBuildDirtyDomains,
    computeAnatomyFitRecipeSiblingInWorker,
    createRecipeWorkflowClient,
    deriveServerAuthorizedRecipePreviewControls,
    buildRecipeSiblingInputs,
    buildRecipeStateSnapshot,
    parseRecipeMigrationPlan,
    parseAnatomyFitState,
    projectGoonRecipeSource,
    getAnatomyFitRecipeSibling,
    replaceAnatomyFitRecipeSibling,
    recipeStateSnapshotSha256,
    sha256Hex,
    verifyRecipeArchiveContainmentReceipt,
    verifyRecipePackageMetadata,
    verifyRecipeStateSnapshot,
    type GoonRecipeV2,
    type RecipeAnalysisHydration,
    type RecipeJobActionResponse,
    type RecipeJobRecoveryResponse,
    type RecipeJobStatus,
    type RecipeRollbackPreviewResponse,
    type RecipeSiblingStateDraft,
    type RecipeStageResponse,
    type RecipeSource,
    type RecipeStateSnapshot,
    type RecipeWorkflowProgress,
    type ServerAuthorizedRecipePreviewControl
  } from '$lib/goons/recipe'
  import { loadCustomAvatarManifest, type GoonCustomAvatarManifest } from '$lib/goons/customAvatar'
  import {
    parseAppearanceDialsManifest,
    type AppearanceDialValueState
  } from '$lib/goons/appearanceDials'
  import type { FacialArtworkState } from '$lib/goons/facialArtwork'
  import type { EyeAppearanceState } from '$lib/goons/eyeAppearance'
  import type { OralAppearanceStateV1 } from '$lib/goons/oralAppearance'
  import type {
    LipArtworkPresenceStateV1,
    LipArtworkStateV2
  } from '$lib/goons/lipArtwork'
  import type {
    NailSurfacePresenceStateV1,
    NailSurfaceStateV1
  } from '$lib/goons/nailSurface'
  import type { SkinAppearanceStateV2 } from '$lib/goons/skinAppearance'
  import type { HairStateV2 } from '$lib/goons/hairAssets'
  import {
    cleanupCustomGoonPackageUpload,
    loadGoons,
    uploadCustomGoonPackage
  } from '$lib/services/goons'
  import type { GoonRecord } from '$lib/types/goons'
  import { pickGoonPackageFile } from '$lib/goons/goonPackageFilePicker'
  import RecipeWorkflowPanel from './RecipeWorkflowPanel.svelte'
  import type {
    RecipeAuthorizedPreviewControl,
    RecipeFileTechnicalDetails,
    RecipeLifecycleBusyAction,
    RecipePreviewSide,
    RecipeFittedPreviewState,
    RecipeWorkflowActions,
    RecipeWorkflowViewModel
  } from './types'

  type RecipePreviewTarget = {
    goon: GoonRecord
    state: RecipeStateSnapshot
    preview: RecipeFittedPreviewState
    side: RecipePreviewSide
  }

  type RecipeAnalysisBoundary = {
    goonId: string
    owner: GoonRecipeV2
  }

  type RecipeAnalysisIntent = {
    mode: 'direct' | 'save' | 'discard'
    boundary: RecipeAnalysisBoundary
  }

  type Props = {
    goon: GoonRecord
    appearanceDials: AppearanceDialValueState | null
    facialArtwork: FacialArtworkState | null
    eyeAppearance: EyeAppearanceState | null
    oralAppearance: OralAppearanceStateV1 | null
    lipArtwork: LipArtworkStateV2 | null
    lipArtworkPresence: LipArtworkPresenceStateV1 | null
    nailSurface: NailSurfaceStateV1 | null
    nailSurfacePresence: NailSurfacePresenceStateV1 | null
    skinAppearance: SkinAppearanceStateV2 | null
    hairState?: HairStateV2 | null
    onSaveEditorDraft: () => Promise<boolean>
    onDiscardEditorDraft: () => void | Promise<void>
    onRecipeGoonChanged?: (goon: GoonRecord) => void | Promise<void>
    onDraftPreviewStateChange?: (
      preview: RecipeFittedPreviewState | null
    ) => void | Promise<void>
    onPreviewTargetChange?: (target: RecipePreviewTarget | null) => void | Promise<void>
    onPreviewLiveCandidate: (staged: RecipeStageResponse) => Promise<void>
    fileTechnicalDetails?: RecipeFileTechnicalDetails | null
    autoPrepare?: boolean
    onWorkflowBusyChange?: (busy: boolean) => void
  }

  let {
    goon,
    appearanceDials,
    facialArtwork,
    eyeAppearance,
    oralAppearance,
    lipArtwork,
    lipArtworkPresence,
    nailSurface,
    nailSurfacePresence,
    skinAppearance,
    hairState = null,
    onSaveEditorDraft,
    onDiscardEditorDraft,
    onRecipeGoonChanged,
    onDraftPreviewStateChange,
    onPreviewTargetChange,
    onPreviewLiveCandidate,
    fileTechnicalDetails = null,
    autoPrepare = false,
    onWorkflowBusyChange
  }: Props = $props()

  let packageInput = $state<HTMLInputElement | null>(null)
  let client = $derived(createRecipeWorkflowClient(goon.id))
  let hydration = $state<RecipeAnalysisHydration | null>(null)
  let targetManifest = $state<GoonCustomAvatarManifest | null>(null)
  let previewState = $state<RecipeStateSnapshot | null>(null)
  let previewFitFreshStateSha256 = $state<string | null>(null)
  let previewFitBusy = $state(false)
  let previewControls = $state<ServerAuthorizedRecipePreviewControl[]>([])
  let previewSide = $state<RecipePreviewSide>('current')
  let draftState = $state<RecipeStateSnapshot | null>(null)
  let draftStateError = $state<string | null>(null)
  let preparationFailure = $state<string | null>(null)
  let jobView = $state<RecipeJobRecoveryResponse | RecipeJobActionResponse | null>(null)
  let jobReviewedState = $state<RecipeStateSnapshot | null>(null)
  let workflowProgress = $state<RecipeWorkflowProgress | null>(null)
  let lifecycleBusy = $state<RecipeLifecycleBusyAction>(null)
  let reviewBusy = $state<'updating' | 'keeping' | 'resetting' | null>(null)
  let jobBusy = $state<'resuming' | 'retrying' | 'discarding' | 'canceling' | null>(null)
  let dirtyGuardOpen = $state(false)
  let dirtyGuardBusy = $state<'saving' | 'discarding' | null>(null)
  let cleanResetOpen = $state(false)
  let restoreOpen = $state(false)
  let confirmationBusy = $state<'clean-reset' | 'restore' | null>(null)
  let rollbackPreview = $state<RecipeRollbackPreviewResponse | null>(null)
  let pendingAnalysisIntent: RecipeAnalysisIntent | null = null
  let buildAbortController: AbortController | null = null
  let previewFitAbortController: AbortController | null = null
  let previewFitPromise: Promise<RecipeStateSnapshot> | null = null
  let draftToken = 0
  let hydrationToken = 0
  let automaticPreparationAttemptKey = ''

  const owner = $derived.by<GoonRecipeV2 | null>(() =>
    goon.recipe?.contract === 'goon-recipe/v2' ? goon.recipe : null
  )
  const buildDecision = $derived.by(() =>
    classifyRecipeBuildDirtyDomains({
      savedState: owner?.authoringRevision.state ?? null,
      draftState
    })
  )
  const recipeDraftDirty = $derived(buildDecision.action === 'update')
  const draftInputSignature = $derived.by(() => canonicalRecipeString({
    appearanceDials,
    facialArtwork,
    eyeAppearance,
    oralAppearance,
    lipArtwork,
    lipArtworkPresence,
    nailSurface,
    nailSurfacePresence,
    skinAppearance,
    hairState,
    sourceModel: owner?.authoringRevision?.source?.model?.ref ?? goon.customAvatar?.model?.url ?? null,
    sourceManifest: owner?.authoringRevision?.source?.manifest?.ref ?? goon.customAvatar?.manifest?.url ?? null,
    anatomyFitReady: goon.customAvatar?.manifestSummary?.anatomyFitReady ?? false
  }))
  const workflowBusy = $derived(
    lifecycleBusy !== null ||
      reviewBusy !== null ||
      confirmationBusy !== null ||
      jobBusy !== null ||
      previewFitBusy
  )

  $effect(() => {
    onWorkflowBusyChange?.(workflowBusy)
  })

  onDestroy(() => {
    previewFitAbortController?.abort()
    void onDraftPreviewStateChange?.(null)
    onWorkflowBusyChange?.(false)
  })

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }

  async function fittedPreviewState(
    state: RecipeStateSnapshot
  ): Promise<RecipeFittedPreviewState> {
    const sibling = await getAnatomyFitRecipeSibling(state)
    const fitState = sibling ? await parseAnatomyFitState(sibling.state) : null
    return {
      stateSha256: state.stateSha256,
      appearanceDials: cloneJson(state.appearanceDials),
      anatomyFitResults: cloneJson(
        fitState?.fits.map((entry) => entry.result) ?? []
      )
    }
  }

  function buildPreviewGoon(source: RecipeSource, state: RecipeStateSnapshot): GoonRecord {
    return projectGoonRecipeSource(goon, { source, state })
  }

  function draftGoon(): GoonRecord {
    return {
      ...goon,
      facialArtwork: facialArtwork ? cloneJson(facialArtwork) : null,
      eyeAppearance: eyeAppearance ? cloneJson(eyeAppearance) : null,
      oralAppearance: oralAppearance ? cloneJson(oralAppearance) : null,
      lipArtwork: lipArtwork ? cloneJson(lipArtwork) : null,
      lipArtworkPresence: lipArtworkPresence ? cloneJson(lipArtworkPresence) : null,
      nailSurface: nailSurface ? cloneJson(nailSurface) : null,
      nailSurfacePresence: nailSurfacePresence ? cloneJson(nailSurfacePresence) : null,
      skinAppearance: skinAppearance ? cloneJson(skinAppearance) : null,
      hairState: hairState ? cloneJson(hairState) : null,
      skinMaterialArtwork: null
    }
  }

  async function buildCurrentDraftState(
    signal?: AbortSignal,
    recomputeAnatomyFit = false
  ) {
    if (!appearanceDials) {
      throw new Error('Appearance controls are still loading for this Goon.')
    }
    let anatomyFitState: RecipeSiblingStateDraft | null | undefined = undefined
    const hasManagedAnatomyFit = Boolean(
      goon.customAvatar?.manifestSummary?.anatomyFitReady ||
      owner?.authoringRevision?.state?.siblings?.some(
        (entry) => entry.id === 'anatomy-fit' || entry.contract === 'anatomy-fit-state/v2'
      )
    )
    if (recomputeAnatomyFit) anatomyFitState = null
    if (recomputeAnatomyFit && hasManagedAnatomyFit) {
      const authoringGoon = owner ? projectGoonRecipeSource(goon) : goon
      const manifest = await loadCustomAvatarManifest(authoringGoon.customAvatar?.manifest)
      if (manifest.anatomyFit === undefined || manifest.anatomyFit === null) {
        throw new Error('The Recipe state requires Anatomy Fit but its authoring definition is missing.')
      }
      const modelRef = authoringGoon.customAvatar?.model
      if (!modelRef?.url) {
        throw new Error('This Anatomy Fit Goon is missing its authoring model.')
      }
      const response = await fetch(modelRef.url, { signal })
      if (!response.ok) {
        throw new Error(`Failed to load the Anatomy Fit authoring model (${response.status}).`)
      }
      const modelBytes = new Uint8Array(await response.arrayBuffer())
      const source = owner?.authoringRevision.source.identities
        ?? (await verifyRecipePackageMetadata(manifest, await sha256Hex(modelBytes))).source
      const previousSibling = owner?.authoringRevision.state.siblings.find(
        (entry) => entry.id === 'anatomy-fit' || entry.contract === 'anatomy-fit-state/v2'
      ) ?? null
      const sibling = await computeAnatomyFitRecipeSiblingInWorker({
        manifest,
        modelBytes,
        source,
        appearanceDials: cloneJson(appearanceDials),
        previousSibling: previousSibling ? cloneJson(previousSibling) : null
      }, signal)
      if (!sibling) {
        throw new Error('The Anatomy Fit source package did not produce its required Recipe state.')
      }
      anatomyFitState = {
        id: sibling.id,
        contract: sibling.contract,
        definitionSha256: sibling.definitionSha256,
        state: cloneJson(sibling.state)
      }
    }
    return buildRecipeStateSnapshot({
      goon: draftGoon(),
      appearanceDials: cloneJson(appearanceDials),
      anatomyFitState
    })
  }

  $effect(() => {
    goon.id
    owner?.writeVersion
    draftInputSignature
    const token = ++draftToken
    const abortController = new AbortController()
    const appearanceChanged =
      !owner ||
      canonicalRecipeString(appearanceDials) !==
        canonicalRecipeString(owner.authoringRevision.state.appearanceDials)
    const recomputeAnatomyFit = Boolean(
      appearanceChanged &&
      (
        goon.customAvatar?.manifestSummary?.anatomyFitReady ||
        owner?.authoringRevision.state.siblings.some(
          (entry) => entry.id === 'anatomy-fit' || entry.contract === 'anatomy-fit-state/v2'
        )
      )
    )
    const run = () => {
      void buildCurrentDraftState(
        abortController.signal,
        recomputeAnatomyFit
      )
        .then(async (state) => ({
          state,
          preview: await fittedPreviewState(state)
        }))
        .then(({ state, preview }) => {
          if (token !== draftToken) return
          draftState = state
          draftStateError = null
          void onDraftPreviewStateChange?.(preview)
        })
        .catch((error) => {
          if (token !== draftToken || abortController.signal.aborted) return
          draftState = null
          draftStateError = errorMessage(error)
        })
    }
    // Slider input can emit many intermediate values. Keep the last valid
    // fitted preview visible while one exact replacement is computed off the
    // UI thread after the pointer settles.
    const timer = recomputeAnatomyFit ? setTimeout(run, 90) : null
    if (timer === null) run()
    return () => {
      if (timer !== null) clearTimeout(timer)
      abortController.abort()
    }
  })

  async function emitAnalysisPreview() {
    if (!hydration || !previewState) {
      await onPreviewTargetChange?.(null)
      return
    }
    const plan = parseRecipeMigrationPlan(hydration.plan)
    const source = previewSide === 'current' ? plan.fromSource : plan.toSource
    const state = previewSide === 'current'
      ? hydration.owner.authoringRevision.state
      : previewState
    await onPreviewTargetChange?.({
      goon: buildPreviewGoon(source, state),
      state,
      preview: await fittedPreviewState(state),
      side: previewSide
    })
  }

  async function computeAnalysisPreviewAnatomyFit(
    next: RecipeAnalysisHydration,
    manifest: GoonCustomAvatarManifest,
    state: RecipeStateSnapshot,
    workflowClient: ReturnType<typeof createRecipeWorkflowClient>,
    signal?: AbortSignal
  ) {
    if (manifest.anatomyFit === undefined || manifest.anatomyFit === null) {
      return replaceAnatomyFitRecipeSibling(state, null)
    }
    const plan = parseRecipeMigrationPlan(next.plan)
    const [modelBytes, previousSibling] = await Promise.all([
      workflowClient.loadAnalysisTargetModelBytes(next, { signal }),
      getAnatomyFitRecipeSibling(next.owner.authoringRevision.state)
    ])
    const sibling = await computeAnatomyFitRecipeSiblingInWorker({
      manifest,
      modelBytes,
      source: plan.toSource.identities,
      appearanceDials: cloneJson(state.appearanceDials),
      previousSibling
    }, signal)
    if (!sibling) {
      throw new Error('The updated Goon file did not produce its required Anatomy Fit.')
    }
    return replaceAnatomyFitRecipeSibling(state, sibling.state)
  }

  async function ensurePreviewAnatomyFit(): Promise<RecipeStateSnapshot> {
    if (!hydration || !targetManifest || !previewState) {
      throw new Error('The updated Goon preview is unavailable.')
    }
    if (previewFitFreshStateSha256 === previewState.stateSha256) return previewState
    if (previewFitPromise) return previewFitPromise
    const sourceState = cloneJson(previewState)
    const sourceStateSha256 = sourceState.stateSha256
    const activeHydration = hydration
    const activeManifest = targetManifest
    const activeClient = createRecipeWorkflowClient(goon.id)
    previewFitAbortController?.abort()
    const abortController = new AbortController()
    previewFitAbortController = abortController
    previewFitBusy = true
    previewFitPromise = computeAnalysisPreviewAnatomyFit(
      activeHydration,
      activeManifest,
      sourceState,
      activeClient,
      abortController.signal
    ).then(async (nextState): Promise<RecipeStateSnapshot> => {
      if (!previewState || previewState.stateSha256 !== sourceStateSha256) {
        previewFitPromise = null
        return ensurePreviewAnatomyFit()
      }
      previewState = nextState
      previewFitFreshStateSha256 = nextState.stateSha256
      if (previewSide === 'updated') await emitAnalysisPreview()
      return nextState
    }).finally(() => {
      if (previewFitAbortController === abortController) {
        previewFitAbortController = null
        previewFitBusy = false
        previewFitPromise = null
      }
    })
    return previewFitPromise
  }

  async function prepareHydration(
    next: RecipeAnalysisHydration,
    workflowClient = createRecipeWorkflowClient(goon.id)
  ) {
    const manifest = await workflowClient.loadAnalysisTargetManifest(next)
    const appearanceManifest = parseAppearanceDialsManifest(manifest)
    if (!appearanceManifest) {
      throw new Error('The selected Goon file has no supported appearance controls.')
    }
    const controls = await deriveServerAuthorizedRecipePreviewControls(
      next,
      appearanceManifest
    )
    const plan = parseRecipeMigrationPlan(next.plan)
    const basePreviewState = next.reviewedState?.state ?? plan.proposedState
    previewFitAbortController?.abort()
    const abortController = new AbortController()
    previewFitAbortController = abortController
    previewFitBusy = true
    let fittedPreviewState: RecipeStateSnapshot | null = null
    try {
      fittedPreviewState = basePreviewState
        ? await computeAnalysisPreviewAnatomyFit(
            next,
            manifest,
            basePreviewState,
            workflowClient,
            abortController.signal
          )
        : null
    } finally {
      if (previewFitAbortController === abortController) {
        previewFitAbortController = null
        previewFitBusy = false
      }
    }
    hydration = next
    targetManifest = manifest
    previewState = fittedPreviewState
    previewFitFreshStateSha256 = fittedPreviewState?.stateSha256 ?? null
    previewControls = controls
    previewSide = 'updated'
    rollbackPreview = null
    await emitAnalysisPreview()
  }

  async function clearAnalysisPreview() {
    previewFitAbortController?.abort()
    previewFitAbortController = null
    previewFitPromise = null
    previewFitBusy = false
    hydration = null
    targetManifest = null
    previewState = null
    previewFitFreshStateSha256 = null
    previewControls = []
    previewSide = 'current'
    rollbackPreview = null
    await onPreviewTargetChange?.(null)
  }

  async function refreshGoon(preferred?: GoonRecord) {
    const list = await loadGoons()
    const next = list.find((entry) => entry.id === goon.id) ?? preferred
    if (!next) throw new Error('The updated Goon could not be reloaded.')
    await onRecipeGoonChanged?.(next)
    return next
  }

  async function recoverPendingJob(nextGoon: GoonRecord) {
    const nextOwner = nextGoon.recipe?.contract === 'goon-recipe/v2' ? nextGoon.recipe : null
    if (!nextOwner?.pendingJob) {
      jobView = null
      jobReviewedState = null
      return
    }
    const recovered = await createRecipeWorkflowClient(nextGoon.id).recoverJob(
      nextOwner.pendingJob.jobId
    )
    jobView = recovered
    jobReviewedState = recovered.reviewedState.state
  }

  $effect(() => {
    const goonId = goon.id
    const writeVersion = owner?.writeVersion ?? -1
    const analysisId = owner?.pendingAnalysis?.analysisId ?? ''
    const jobId = owner?.pendingJob?.jobId ?? ''
    const token = ++hydrationToken
    void (async () => {
      try {
        if (analysisId) {
          const next = await createRecipeWorkflowClient(goonId).hydrateAnalysis()
          if (token !== hydrationToken) return
          await prepareHydration(next)
        } else if (token === hydrationToken && !rollbackPreview) {
          await clearAnalysisPreview()
        }
        if (jobId) {
          const recovered = await createRecipeWorkflowClient(goonId).recoverJob(jobId)
          if (token !== hydrationToken) return
          jobView = recovered
          jobReviewedState = recovered.reviewedState.state
        } else if (token === hydrationToken) {
          jobView = null
          jobReviewedState = null
        }
      } catch (error) {
        if (token !== hydrationToken) return
        toast.error(errorMessage(error))
      }
    })()
    writeVersion
  })

  function progressStatus(progress: RecipeWorkflowProgress | null): RecipeJobStatus | null {
    if (!progress) return null
    if (progress === 'starting' || progress === 'fetching-source' || progress === 'validating-source') {
      return 'validating'
    }
    if (progress === 'evaluating-recipe') return 'planning'
    if (progress === 'rewriting-model' || progress === 'auditing-model') return 'baking'
    if (progress === 'packaging-live-goon' || progress === 'uploading-candidate' || progress === 'registering-candidate') {
      return 'packaging'
    }
    if (
      progress === 'verifying-output' ||
      progress === 'staging-candidate' ||
      progress === 'previewing-candidate'
    ) return 'verifying'
    if (progress === 'committing') return 'committing'
    return progress === 'complete' ? 'committed' : null
  }

  async function runBuild(start: Parameters<typeof client.buildUploadStageCommit>[0]['start']) {
    buildAbortController = new AbortController()
    workflowProgress = 'starting'
    try {
      const result = await client.buildUploadStageCommit({
        start,
        signal: buildAbortController.signal,
        previewCandidate: onPreviewLiveCandidate,
        onProgress: (stage) => {
          workflowProgress = stage
        }
      })
      jobView = null
      jobReviewedState = null
      await clearAnalysisPreview()
      const next = await refreshGoon(result.committed.goon)
      toast.success(owner?.activeRevision ? 'Goon updated' : 'Goon is ready')
      return next
    } catch (error) {
      let recoveryError: unknown = null
      try {
        const next = await refreshGoon()
        await recoverPendingJob(next)
      } catch (nextError) {
        recoveryError = nextError
      }
      toast.error(
        recoveryError
          ? `${errorMessage(error)} Recovery status could not be reloaded: ${errorMessage(recoveryError)}`
          : errorMessage(error)
      )
      return null
    } finally {
      buildAbortController = null
      workflowProgress = null
      if (jobBusy === 'canceling') jobBusy = null
    }
  }

  async function resumeReadyBuild(recovery: RecipeJobRecoveryResponse) {
    buildAbortController = new AbortController()
    workflowProgress = 'previewing-candidate'
    try {
      const committed = await client.resumeReadyCandidate({
        recovery,
        signal: buildAbortController.signal,
        previewCandidate: onPreviewLiveCandidate,
        onProgress: (stage) => {
          workflowProgress = stage
        }
      })
      jobView = null
      jobReviewedState = null
      await clearAnalysisPreview()
      const next = await refreshGoon(committed.goon)
      toast.success(owner?.activeRevision ? 'Goon updated' : 'Goon is ready')
      return next
    } catch (error) {
      let recoveryError: unknown = null
      try {
        const next = await refreshGoon()
        await recoverPendingJob(next)
      } catch (nextError) {
        recoveryError = nextError
      }
      toast.error(
        recoveryError
          ? `${errorMessage(error)} Recovery status could not be reloaded: ${errorMessage(recoveryError)}`
          : errorMessage(error)
      )
      return null
    } finally {
      buildAbortController = null
      workflowProgress = null
      if (jobBusy === 'canceling') jobBusy = null
    }
  }

  async function runBake(
    kind: 'first-bake' | 'rebake',
    requestedState: RecipeStateSnapshot | null = draftState,
    startingOwner: GoonRecipeV2 | null = owner
  ) {
    if (!requestedState) {
      toast.error(draftStateError ?? 'This Goon’s appearance state is not ready.')
      return false
    }
    lifecycleBusy = kind
    if (kind === 'first-bake') preparationFailure = null
    try {
      let activeOwner = startingOwner
      if (!activeOwner) {
        const initialized = await client.initializeFromCurrentPackage(goon, requestedState)
        activeOwner = initialized.owner
        await refreshGoon(initialized.goon)
      }
      const committed = await runBuild({
        kind: 'bake',
        request: {
          expectedWriteVersion: activeOwner.writeVersion,
          idempotencyKey: `recipe_${kind}_${crypto.randomUUID()}`,
          state: requestedState
        }
      })
      return Boolean(committed)
    } catch (error) {
      const message = errorMessage(error)
      if (kind === 'first-bake') preparationFailure = message
      toast.error(message)
      return false
    } finally {
      lifecycleBusy = null
    }
  }

  export async function saveRecipeDraftIfNeeded(): Promise<boolean> {
    if (!owner && !autoPrepare) return true
    if (workflowBusy) {
      toast.error('Wait for the current Goon update to finish before saving again.')
      return false
    }
    try {
      // Rebuild from the current controlled props at the Save boundary. The
      // reactive preview hash is intentionally asynchronous, so a fast Save
      // click can otherwise observe the previous draft and silently skip the
      // one build required for the newly staged appearance batch.
      let activeOwner = owner
      const appearanceChanged = !activeOwner || canonicalRecipeString(appearanceDials) !==
        canonicalRecipeString(activeOwner.authoringRevision.state.appearanceDials)
      const currentDraftState = await buildCurrentDraftState(undefined, appearanceChanged)
      draftState = currentDraftState
      draftStateError = null
      if (activeOwner?.pendingAnalysis) {
        toast.error('Finish or discard the current Goon file update before saving new appearance edits.')
        return false
      }
      if (activeOwner?.pendingJob) {
        const visibleJobView = jobView
        const pending =
          visibleJobView?.job.jobId === activeOwner.pendingJob.jobId &&
          'reviewedState' in visibleJobView
            ? visibleJobView
            : await client.recoverJob(activeOwner.pendingJob.jobId)
        jobView = pending
        jobReviewedState = pending.reviewedState.state
        if (pending.job.status !== 'failed' && pending.job.status !== 'interrupted') {
          toast.error('Finish or discard the current Goon file update before saving new appearance edits.')
          return false
        }
        if (pending.reviewedState.state.stateSha256 === currentDraftState.stateSha256) {
          toast.error('This failed update already contains these exact appearance changes. Choose Retry or Discard in Goon File.')
          return false
        }
        const discarded = await client.discardJob(pending)
        jobView = null
        jobReviewedState = null
        activeOwner = discarded.owner
        await refreshGoon(discarded.goon)
        toast.info('The previous failed update was replaced with your current appearance changes.')
      }
      const currentDecision = classifyRecipeBuildDirtyDomains({
        savedState: activeOwner?.authoringRevision.state ?? null,
        draftState: currentDraftState
      })
      if (!currentDecision.requiresBuild) {
        if (activeOwner?.liveStatus !== 'needs_bake') return true
        return runBake(
          activeOwner.activeRevision ? 'rebake' : 'first-bake',
          currentDraftState,
          activeOwner
        )
      }
      return runBake(
        currentDecision.action === 'prepare' ? 'first-bake' : 'rebake',
        currentDraftState,
        activeOwner
      )
    } catch (error) {
      const message = errorMessage(error)
      draftStateError = message
      toast.error(message)
      return false
    }
  }

  $effect(() => {
    const attemptKey =
      autoPrepare && !owner && draftState
        ? `${goon.id}:${draftState.stateSha256}`
        : ''
    if (!attemptKey || automaticPreparationAttemptKey === attemptKey || workflowBusy) return
    automaticPreparationAttemptKey = attemptKey
    void runBake('first-bake')
  })

  function captureAnalysisBoundary(): RecipeAnalysisBoundary | null {
    if (!owner) return null
    return {
      goonId: goon.id,
      owner
    }
  }

  function openUpdatePicker(
    mode: RecipeAnalysisIntent['mode'] = 'direct',
    boundary: RecipeAnalysisBoundary | null = captureAnalysisBoundary()
  ) {
    if (!boundary) {
      toast.error('The saved Goon state changed before file selection. Try Update Goon File again.')
      return false
    }
    if (!packageInput) {
      toast.error('The file picker is not ready. Try Update Goon File again.')
      return false
    }
    pendingAnalysisIntent = { mode, boundary }
    void pickGoonPackageFile()
      .then((file) => {
        if (file === undefined) {
          packageInput?.click()
        } else if (file) {
          void analyzeUpdateFile(file)
        } else {
          pendingAnalysisIntent = null
        }
      })
      .catch((error) => {
        pendingAnalysisIntent = null
        toast.error(errorMessage(error))
      })
    return true
  }

  async function selectUpdateFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] ?? null
    input.value = ''
    if (!file) return
    await analyzeUpdateFile(file)
  }

  async function analyzeUpdateFile(file: File) {
    const capturedBoundary = captureAnalysisBoundary()
    const intent = pendingAnalysisIntent ?? (capturedBoundary
      ? { mode: 'direct' as const, boundary: capturedBoundary }
      : null)
    pendingAnalysisIntent = null
    if (!intent) {
      toast.error('The saved Goon state changed before the selected file could be checked. Try again.')
      return
    }
    // Capture the file before Save or Discard rehydrates the parent editor. Resetting
    // the draft before the native picker returns can replace the hidden input and its
    // change listener, losing the selection entirely. The intent makes the compound
    // action transactional: canceling the picker preserves the edits; selecting a file
    // applies the chosen edit action and continues with a stable Recipe boundary.
    const goonId = intent.boundary.goonId
    let activeOwner = intent.boundary.owner
    const workflowClient = createRecipeWorkflowClient(goonId)
    let uploadedArchiveReceipt: unknown = null
    try {
      if (intent.mode === 'save') {
        if (!(await saveRecipeDraftIfNeeded())) return
        if (!(await onSaveEditorDraft())) return
        const latestGoon = (await loadGoons()).find((entry) => entry.id === goonId)
        const latestOwner = latestGoon?.recipe?.contract === 'goon-recipe/v2'
          ? latestGoon.recipe
          : null
        if (!latestOwner) {
          throw new Error('The saved Goon could not be reloaded before checking its new file.')
        }
        activeOwner = latestOwner
      } else if (intent.mode === 'discard') {
        await onDiscardEditorDraft()
      }
      lifecycleBusy = 'analyze'
      const upload = await uploadCustomGoonPackage(goonId, file)
      uploadedArchiveReceipt = upload.archiveReceipt
      const [receipt, manifest] = await Promise.all([
        verifyRecipeArchiveContainmentReceipt(upload.archiveReceipt),
        loadCustomAvatarManifest(upload.manifest)
      ])
      const model = receipt.members.find((member) => member.role === 'model')?.extracted
      if (!model) throw new Error('The uploaded Goon file has no verified avatar.glb member.')
      const metadata = await verifyRecipePackageMetadata(manifest, model.sha256)
      const currentIdentity = canonicalRecipeString(activeOwner.authoringRevision.source.identities)
      const edges = metadata.updates.edges.filter(
        (edge) => canonicalRecipeString(edge.from) === currentIdentity
      )
      if (edges.length !== 1) {
        throw new Error(
          edges.length === 0
            ? 'This Goon file does not declare a supported direct update from the current source.'
            : 'This Goon file declares more than one direct update from the current source.'
        )
      }
      const siblingInputs = await buildRecipeSiblingInputs({
        state: activeOwner.authoringRevision.state,
        targetManifest: manifest,
        edge: edges[0]!
      })
      const next = await workflowClient.analyzeUpdate({ receipt, siblingInputs })
      await prepareHydration(next, workflowClient)
      await refreshGoon(next.goon)
      toast.success('Goon file check ready for review')
    } catch (error) {
      if (uploadedArchiveReceipt) {
        try {
          await cleanupCustomGoonPackageUpload(goonId, uploadedArchiveReceipt)
        } catch (cleanupError) {
          toast.error(
            `Package analysis failed: ${errorMessage(error)} Rejected-upload cleanup also could not be confirmed: ${errorMessage(cleanupError)}`
          )
          return
        }
      }
      toast.error(errorMessage(error))
    } finally {
      lifecycleBusy = null
    }
  }

  function requestAnalyze() {
    if (recipeDraftDirty) {
      dirtyGuardOpen = true
      return
    }
    openUpdatePicker()
  }

  async function saveAndAnalyze() {
    dirtyGuardBusy = 'saving'
    let continueToPicker = false
    const analysisBoundary = captureAnalysisBoundary()
    try {
      if (!analysisBoundary) {
        toast.error('The saved Goon state changed before file selection. Try Update Goon File again.')
        return
      }
      dirtyGuardOpen = false
      continueToPicker = true
    } finally {
      dirtyGuardBusy = null
    }
    if (!continueToPicker) return
    // Let the controlled dialog finish closing before the native Mac picker
    // takes over the event loop. Keeping the busy guard around input.click()
    // strands the modal overlay until the picker continuation completes.
    await tick()
    openUpdatePicker('save', analysisBoundary)
  }

  async function discardAndAnalyze() {
    dirtyGuardBusy = 'discarding'
    let continueToPicker = false
    const analysisBoundary = captureAnalysisBoundary()
    try {
      if (!analysisBoundary) {
        toast.error('The saved Goon state changed before file selection. Try Update Goon File again.')
        return
      }
      dirtyGuardOpen = false
      continueToPicker = true
    } finally {
      dirtyGuardBusy = null
    }
    if (!continueToPicker) return
    await tick()
    openUpdatePicker('discard', analysisBoundary)
  }

  async function updatePreviewControl(id: string, value: number) {
    if (!previewState) return
    const control = previewControls.find((entry) => entry.id === id)
    if (!control) return
    const bounded = Math.min(control.maximum, Math.max(control.minimum, value))
    const next = cloneJson(previewState)
    next.appearanceDials.values[id] = bounded
    next.stateSha256 = await recipeStateSnapshotSha256(next)
    previewState = await verifyRecipeStateSnapshot(next)
    previewControls = previewControls.map((entry) =>
      entry.id === id ? { ...entry, value: bounded } : entry
    )
    if (previewSide === 'updated') await emitAnalysisPreview()
  }

  async function commitPreviewControl() {
    try {
      await ensurePreviewAnatomyFit()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  async function reviewAndBuild(nextHydration: RecipeAnalysisHydration, cleanResetConfirmed: boolean) {
    if (!previewState) throw new Error('The reviewed appearance state is unavailable.')
    await ensurePreviewAnatomyFit()
    if (!previewState) throw new Error('The fitted reviewed appearance state is unavailable.')
    const plan = parseRecipeMigrationPlan(nextHydration.plan)
    const confirmedControlIds = plan.controlRows
      .filter((row) => row.requiresConfirmation)
      .map((row) => row.ledgerId)
      .sort((left, right) => left.localeCompare(right))
    const reviewed = await client.reviewAnalysisState({
      expectedWriteVersion: nextHydration.owner.writeVersion,
      analysisId: nextHydration.pendingAnalysis.analysisId,
      state: previewState,
      confirmedControlIds,
      cleanResetConfirmed
    })
    await prepareHydration(reviewed)
    const committed = await runBuild({
      kind: 'package-update',
      request: {
        expectedWriteVersion: reviewed.owner.writeVersion,
        idempotencyKey: `recipe_package_update_${crypto.randomUUID()}`,
        analysisId: reviewed.pendingAnalysis.analysisId
      }
    })
    return Boolean(committed)
  }

  async function updateAndRebuild() {
    if (!hydration) return
    reviewBusy = 'updating'
    try {
      await reviewAndBuild(hydration, false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      reviewBusy = null
    }
  }

  async function keepCurrentPackage() {
    if (!hydration) return
    reviewBusy = 'keeping'
    try {
      const result = await client.discardAnalysis({
        expectedWriteVersion: hydration.owner.writeVersion,
        analysisId: hydration.pendingAnalysis.analysisId,
        confirmed: true
      })
      await clearAnalysisPreview()
      await refreshGoon(result.goon)
      toast.success('Current Goon kept')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      reviewBusy = null
    }
  }

  async function confirmCleanReset() {
    if (!hydration) return
    confirmationBusy = 'clean-reset'
    reviewBusy = 'resetting'
    try {
      const reset = await client.resetAnalysis({
        expectedWriteVersion: hydration.owner.writeVersion,
        analysisId: hydration.pendingAnalysis.analysisId,
        confirmed: true
      })
      await prepareHydration(reset)
      cleanResetOpen = false
      await reviewAndBuild(reset, true)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      confirmationBusy = null
      reviewBusy = null
    }
  }

  async function requestRestore() {
    lifecycleBusy = 'restore'
    try {
      const preview = await client.previewRollback()
      await onPreviewTargetChange?.({
        goon: buildPreviewGoon(preview.previous.revision.source, preview.previous.revision.state),
        state: preview.previous.revision.state,
        preview: await fittedPreviewState(preview.previous.revision.state),
        side: 'updated'
      })
      rollbackPreview = preview
      restoreOpen = true
      toast.success('Previewing the previous Goon version')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      lifecycleBusy = null
    }
  }

  async function closeRestore() {
    restoreOpen = false
    rollbackPreview = null
    await emitAnalysisPreview()
  }

  async function confirmRestore() {
    if (!owner) return
    confirmationBusy = 'restore'
    try {
      const result = await client.rollback(owner.writeVersion)
      restoreOpen = false
      rollbackPreview = null
      await clearAnalysisPreview()
      await refreshGoon(result.goon)
      toast.success('Previous Goon version restored')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      confirmationBusy = null
    }
  }

  async function retryJob() {
    if (!jobView || !jobReviewedState) return
    jobBusy = 'retrying'
    try {
      const retried = await client.retryJob(jobView)
      jobView = retried
      if (retried.job.status === 'ready') {
        await resumeReadyBuild(await client.recoverJob(retried.job.jobId))
        return
      }
      const operation = retried.job.operation
      if (operation === 'package-update') {
        const recovered = await client.recoverJob(retried.job.jobId)
        const analysisId = recovered.reviewedState.analysisId
        if (!analysisId) throw new Error('The package-update retry lost its analysis identity.')
        await runBuild({
          kind: 'package-update',
          request: {
            expectedWriteVersion: retried.owner.writeVersion,
            idempotencyKey: retried.job.idempotencyKey,
            analysisId
          }
        })
      } else {
        await runBuild({
          kind: 'bake',
          request: {
            expectedWriteVersion: retried.owner.writeVersion,
            idempotencyKey: retried.job.idempotencyKey,
            state: jobReviewedState
          }
        })
      }
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      jobBusy = null
    }
  }

  async function resumeReadyJob() {
    if (!jobView || jobView.job.status !== 'ready') return
    jobBusy = 'resuming'
    try {
      await resumeReadyBuild(await client.recoverJob(jobView.job.jobId))
    } finally {
      jobBusy = null
    }
  }

  async function discardJob() {
    if (!jobView) return
    jobBusy = 'discarding'
    try {
      const result = await client.discardJob(jobView)
      jobView = null
      jobReviewedState = null
      await refreshGoon(result.goon)
      toast.success('Unfinished Goon update discarded')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      jobBusy = null
    }
  }

  function cancelBuild() {
    if (!buildAbortController) return
    jobBusy = 'canceling'
    buildAbortController.abort(new DOMException('Goon update canceled by the user.', 'AbortError'))
  }

  const selectedPlan = $derived.by(() => hydration ? parseRecipeMigrationPlan(hydration.plan) : null)
  const baseAuthorUpdateClassification = $derived.by(() =>
    hydration
      ? classifyRecipeAuthorUpdatePlan(parseRecipeMigrationPlan(hydration.basePlan))
      : null
  )
  const displayedJobStatus = $derived.by<RecipeJobStatus | null>(() =>
    progressStatus(workflowProgress) ?? jobView?.job.status ?? null
  )
  const viewModel = $derived.by<RecipeWorkflowViewModel>(() => ({
    lifecycle: {
      recipeStatus: !owner
        ? 'not-initialized'
        : hydration
          ? 'reviewing'
          : recipeDraftDirty
            ? 'dirty'
            : 'ready',
      liveStatus: owner?.liveStatus ?? null,
      preparationEligible: autoPrepare,
      preparationFailure,
      dirtyDomains: buildDecision.dirtyDomains,
      activeVersionAvailable: Boolean(owner?.activeRevision),
      recipeRevision: owner?.authoringRevision.recipeRevision ?? null,
      activeRevision: owner?.activeRevision && owner.liveStatus === 'up_to_date'
        ? owner.authoringRevision.recipeRevision
        : null,
      lastFailureStage: owner?.lastFailure?.stage ?? null,
      fileTechnicalDetails,
      busyAction: lifecycleBusy,
      canFirstBake: Boolean(
        autoPrepare && !owner && preparationFailure && draftState && !workflowBusy
      ),
      canRebake: Boolean(
        owner &&
        owner.liveStatus === 'needs_bake' &&
        !owner.pendingAnalysis &&
        !owner.pendingJob &&
        !workflowBusy
      ),
      canAnalyzeUpdate: Boolean(
        owner?.activeRevision && !owner.pendingAnalysis && !owner.pendingJob && !workflowBusy
      ),
      canRestorePrevious: Boolean(owner?.previousRevision && !owner.pendingJob && !workflowBusy),
      actionsLoading: Boolean(autoPrepare && !owner && !draftState && !draftStateError),
      actionsUnavailableReason: preparationFailure ?? draftStateError
    },
    report: hydration?.report ?? null,
    review: {
      classification: baseAuthorUpdateClassification,
      busy: reviewBusy,
      canUpdateAndRebuild: Boolean(
        hydration &&
        selectedPlan?.outcome.readiness !== 'blocked' &&
        baseAuthorUpdateClassification !== 'blocked-ineligible' &&
        previewState &&
        !workflowBusy
      ),
      canKeepCurrentPackage: Boolean(hydration && !workflowBusy),
      canCleanReset: Boolean(
        hydration &&
        parseRecipeMigrationPlan(hydration.basePlan).outcome.cleanResetEligibility === 'eligible' &&
        !workflowBusy
      )
    },
    preview: {
      side: previewSide,
      controls: previewControls as RecipeAuthorizedPreviewControl[],
      disabled: workflowBusy
    },
    build: displayedJobStatus
      ? {
          status: displayedJobStatus,
          initialPreparation: !owner?.activeRevision,
          failureStage: jobView?.job.failure?.stage ?? owner?.lastFailure?.stage ?? null,
          failureReason: jobView?.job.failure?.reason ?? owner?.lastFailure?.reason ?? null,
          retryable: displayedJobStatus === 'failed' || displayedJobStatus === 'interrupted',
          resumable: displayedJobStatus === 'ready' && !buildAbortController,
          cancelable: Boolean(buildAbortController),
          busyAction: jobBusy
        }
      : null,
    dirtyGuard: {
      open: dirtyGuardOpen,
      busy: dirtyGuardBusy
    },
    confirmations: {
      cleanResetOpen,
      restoreOpen,
      previousRevision: rollbackPreview?.previous.revision.recipeRevision ?? null,
      busy: confirmationBusy
    }
  }))

  const actions: RecipeWorkflowActions = {
    onFirstBake: async () => { await runBake('first-bake') },
    onRebake: async () => { await runBake('rebake') },
    onAnalyzeUpdate: requestAnalyze,
    onRequestRestorePrevious: () => void requestRestore(),
    onCancelDirtyGuard: () => { dirtyGuardOpen = false },
    onSaveAndAnalyze: saveAndAnalyze,
    onDiscardAndAnalyze: discardAndAnalyze,
    onUpdateAndRebuild: updateAndRebuild,
    onKeepCurrentPackage: keepCurrentPackage,
    onRequestCleanReset: () => { cleanResetOpen = true },
    onPreviewSideChange: (side) => {
      previewSide = side
      void emitAnalysisPreview()
    },
    onPreviewControlChange: (id, value) => void updatePreviewControl(id, value),
    onPreviewControlCommit: () => void commitPreviewControl(),
    onResetPreviewControl: (id) => {
      const control = previewControls.find((entry) => entry.id === id)
      if (control) {
        void updatePreviewControl(id, control.neutralValue).then(commitPreviewControl)
      }
    },
    onResumeReadyJob: resumeReadyJob,
    onRetryJob: retryJob,
    onDiscardJob: discardJob,
    onCancelBuild: cancelBuild,
    onCloseCleanReset: () => { cleanResetOpen = false },
    onConfirmCleanReset: confirmCleanReset,
    onCloseRestorePrevious: () => void closeRestore(),
    onConfirmRestorePrevious: confirmRestore
  }
</script>

<input
  class="hidden"
  type="file"
  bind:this={packageInput}
  onchange={selectUpdateFile}
/>

<RecipeWorkflowPanel {viewModel} {actions} />
