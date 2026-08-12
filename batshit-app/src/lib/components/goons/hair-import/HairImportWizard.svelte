<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Input } from '$lib/components/ui/input'
  import { Progress } from '$lib/components/ui/progress'
  import * as ToggleGroup from '$lib/components/ui/toggle-group'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    ArrowLeft,
    ArrowRight,
    Check,
    CircleAlert,
    Eye,
    FileUp,
    Loader2,
    Paintbrush,
    RotateCcw,
    WandSparkles,
    X
  } from '@lucide/svelte'
  import {
    countHairMotionPaintTriangles,
    type HairMotionPaintV1
  } from '$lib/goons/hairMotionPaint'
  import { selectHairImportFiles } from '$lib/services/hairImports'

  import {
    HAIR_IMPORT_TRANSFORM_LIMITS,
    acceptHairImportInspection,
    acceptHairImportProposals,
    advanceHairImportStep,
    buildHairImportFinalizeRequest,
    buildHairImportPreviewRequest,
    canContinueHairImport,
    chooseHairImportFile,
    createHairImportUiState,
    returnToPreviousHairImportStep,
    toggleHairImportObject,
    updateHairImportMotionPaint,
    updateHairImportTransform,
    type HairImportFinalizeRequest,
    type HairImportInspection,
    type HairImportPreviewRequest,
    type HairImportProposalSet,
    type HairImportTransform,
    type HairImportUiState
  } from './hairImportUiState'

  type BusyAction = 'inspect' | 'preview' | 'physics' | 'finalize' | 'cancel'

  const HAIR_IMPORT_PROGRESS_STEPS = [
    { id: 'inspect', label: 'Inspect' },
    { id: 'fit', label: 'Fit' },
    { id: 'physics', label: 'Physics' },
    { id: 'finalize', label: 'Save' }
  ] as const

  const SOURCE_MATERIAL_NOTICE =
    'Source materials were inventoried and will be replaced by Batshit neutral material ownership.'

  type Props = {
    initialFile?: File | null
    initialCalibrationFile?: File | null
    initialInspection?: HairImportInspection | null
    initialFileSelection?: { name: string; size: number; type: string } | null
    mode?: 'import' | 'refit'
    disabled?: boolean
    onInspect: (file: File, calibrationFile: File | null) => Promise<HairImportInspection>
    onPreviewSelectionChange: (
      selectedObjectIds: string[],
      soloObjectId: string | null
    ) => void | Promise<void>
    onPreviewTransformChange: (transform: HairImportTransform) => void | Promise<void>
    onReturnToFit: (
      inspection: HairImportInspection,
      request: HairImportPreviewRequest
    ) => Promise<void>
    onBuildPreview: (request: HairImportPreviewRequest) => Promise<HairImportProposalSet>
    onEditMotionPaint: (
      current: HairMotionPaintV1 | null
    ) => Promise<HairMotionPaintV1 | null>
    onSetMotionMap: (
      enabled: boolean,
      request: HairImportPreviewRequest
    ) => void | Promise<void>
    onFinalize: (request: HairImportFinalizeRequest) => Promise<unknown>
    onCancel: (sessionId: string | null) => Promise<void>
    onComplete: (result: unknown) => void | Promise<void>
    onClose: () => void
  }

  let {
    initialFile = null,
    initialCalibrationFile = null,
    initialInspection = null,
    initialFileSelection = null,
    mode = 'import',
    disabled = false,
    onInspect,
    onPreviewSelectionChange,
    onPreviewTransformChange,
    onReturnToFit,
    onBuildPreview,
    onEditMotionPaint,
    onSetMotionMap,
    onFinalize,
    onCancel,
    onComplete,
    onClose
  }: Props = $props()

  const mountedFile = untrack(() => initialFile)
  const mountedCalibrationFile = untrack(() => initialCalibrationFile)
  const mountedInspection = untrack(() => initialInspection)
  const mountedFileSelection = untrack(() => initialFileSelection)
  let fileInput: HTMLInputElement | null = $state(null)
  let selectedFile: File | null = $state(mountedFile)
  let selectedCalibrationFile: File | null = $state(mountedCalibrationFile)
  let importState: HairImportUiState = $state(
    mountedInspection && mountedFileSelection
      ? acceptHairImportInspection(
          chooseHairImportFile(createHairImportUiState(), mountedFileSelection),
          mountedInspection
        )
      : mountedFile
        ? chooseHairImportFile(createHairImportUiState(), {
          name: mountedFile.name,
          size: mountedFile.size,
          type: mountedFile.type || 'application/octet-stream'
        })
        : createHairImportUiState()
  )
  let busyAction: BusyAction | null = $state(null)
  let errorMessage: string | null = $state(null)
  let retryAction: (() => Promise<void>) | null = $state(null)
  let finalizedResult: unknown | null = $state(null)
  let finalized = $state(false)
  let soloObjectId: string | null = $state(null)
  let physicsMode = $state<'automatic' | 'custom'>('automatic')

  const currentStepIndex = $derived(
    importState.step === 'fit'
      ? 1
      : importState.step === 'physics'
        ? 2
        : importState.step === 'finalize'
          ? 3
          : 0
  )
  const currentStep = $derived(HAIR_IMPORT_PROGRESS_STEPS[currentStepIndex])
  const busy = $derived(busyAction !== null)
  const actionDisabled = $derived(disabled || busy)
  const visibleInspectionNotices = $derived.by(
    () => importState.inspection?.notices.filter((notice) => notice !== SOURCE_MATERIAL_NOTICE) ?? []
  )

  function clearError() {
    errorMessage = null
    retryAction = null
  }

  function setError(error: unknown, fallback: string, retry: () => Promise<void>) {
    errorMessage = error instanceof Error ? error.message : fallback
    retryAction = retry
  }

  function chooseFiles(files: readonly File[]) {
    if (files.length === 0) return
    let selection
    try {
      selection = selectHairImportFiles(files)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Choose one OBJ or GLB Hair file.'
      retryAction = null
      return
    }
    selectedFile = selection.file
    selectedCalibrationFile = selection.calibrationFile
    finalizedResult = null
    finalized = false
    clearError()
    importState = chooseHairImportFile(importState, {
      name: selection.file.name,
      size: selection.file.size,
      type: selection.file.type || 'application/octet-stream'
    })
  }

  function handleFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    chooseFiles(input.files ? Array.from(input.files) : [])
    input.value = ''
  }

  async function inspectSelectedFile() {
    if (!selectedFile || busy) return
    clearError()
    busyAction = 'inspect'
    try {
      const inspection = await onInspect(selectedFile, selectedCalibrationFile)
      importState = acceptHairImportInspection(importState, inspection)
    } catch (error) {
      setError(error, 'Batshit could not inspect this Hair file.', inspectSelectedFile)
    } finally {
      busyAction = null
    }
  }

  onMount(() => {
    if (mountedFile && !mountedInspection) void inspectSelectedFile()
  })

  async function buildPreview() {
    if (busy) return
    clearError()
    busyAction = 'preview'
    try {
      const proposals = await onBuildPreview(buildHairImportPreviewRequest(importState))
      importState = acceptHairImportProposals(importState, proposals)
      physicsMode = importState.motionPaint ? 'custom' : 'automatic'
      await onSetMotionMap(true, buildHairImportPreviewRequest(importState))
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Batshit could not build the Hair Physics preview.'
      setError(
        new Error(`${message} The last good preview is still visible.`),
        'Batshit could not build the Hair Physics preview. The last good preview is still visible.',
        buildPreview
      )
    } finally {
      busyAction = null
    }
  }

  async function rebuildMotionAuthoring(
    next: HairImportUiState,
    previous: HairImportUiState,
    retry: () => Promise<void>
  ) {
    clearError()
    importState = next
    try {
      const proposals = await onBuildPreview(buildHairImportPreviewRequest(importState))
      importState = acceptHairImportProposals(importState, proposals)
      await onSetMotionMap(true, buildHairImportPreviewRequest(importState))
    } catch (error) {
      importState = previous
      setError(
        error,
        'Batshit could not rebuild this Hair motion proposal. The last good preview is still visible.',
        retry
      )
    }
  }

  async function editMotionPaint() {
    if (busy) return
    clearError()
    busyAction = 'physics'
    const previous = importState
    try {
      await onSetMotionMap(false, buildHairImportPreviewRequest(importState))
      const paint = await onEditMotionPaint(importState.motionPaint)
      if (!paint) {
        await onSetMotionMap(true, buildHairImportPreviewRequest(importState))
        return
      }
      physicsMode = 'custom'
      await rebuildMotionAuthoring(
        updateHairImportMotionPaint(importState, paint),
        previous,
        editMotionPaint
      )
      physicsMode = importState.motionPaint ? 'custom' : 'automatic'
    } catch (error) {
      setError(error, 'Batshit could not open the Hair motion paint editor.', editMotionPaint)
    } finally {
      busyAction = null
    }
  }

  async function useAutomaticTips() {
    if (busy) return
    const previous = importState
    busyAction = 'preview'
    physicsMode = 'automatic'
    try {
      await rebuildMotionAuthoring(
        updateHairImportMotionPaint(importState, null),
        previous,
        useAutomaticTips
      )
      physicsMode = importState.motionPaint ? 'custom' : 'automatic'
    } finally {
      busyAction = null
    }
  }

  async function selectPhysicsMode(value: string) {
    if (busy || (value !== 'automatic' && value !== 'custom') || value === physicsMode) return
    if (value === 'automatic' && importState.motionPaint) {
      await useAutomaticTips()
      return
    }
    physicsMode = value
  }

  async function continueFromPhysics() {
    if (busy || importState.step !== 'physics') return
    clearError()
    busyAction = 'physics'
    try {
      await onSetMotionMap(false, buildHairImportPreviewRequest(importState))
      importState = advanceHairImportStep(importState)
    } catch (error) {
      setError(
        error,
        'Batshit could not restore the clean Hair preview for final review.',
        continueFromPhysics
      )
    } finally {
      busyAction = null
    }
  }

  async function finalizeImport() {
    if (busy || finalized) return
    clearError()
    busyAction = 'finalize'
    try {
      if (finalizedResult === null) {
        finalizedResult = await onFinalize(buildHairImportFinalizeRequest(importState))
      }
      await onComplete(finalizedResult)
      finalized = true
      onClose()
    } catch (error) {
      setError(
        error,
        finalizedResult === null
          ? 'Batshit could not save this immutable Hair revision.'
          : 'The immutable Hair revision was saved, but Batshit could not mount it in the current editor.',
        finalizeImport
      )
    } finally {
      busyAction = null
    }
  }

  async function cancelImport() {
    if (busy) return
    if (finalized || finalizedResult !== null) {
      onClose()
      return
    }
    clearError()
    busyAction = 'cancel'
    const sessionId = importState.inspection?.sessionId ?? null
    try {
      await onCancel(sessionId)
      selectedFile = null
      selectedCalibrationFile = null
      importState = createHairImportUiState()
      onClose()
    } catch (error) {
      setError(error, 'Batshit could not clean up this unfinished Hair import.', cancelImport)
    } finally {
      busyAction = null
    }
  }

  function nextStep() {
    if (importState.step === 'choose') {
      void inspectSelectedFile()
      return
    }
    if (importState.step === 'fit') {
      void buildPreview()
      return
    }
    if (importState.step === 'physics') {
      void continueFromPhysics()
      return
    }
    if (importState.step === 'inspect' && soloObjectId !== null) {
      publishSelection(importState, null)
    }
    importState = advanceHairImportStep(importState)
  }

  async function previousStep() {
    if (importState.step === 'physics' && importState.inspection) {
      clearError()
      busyAction = 'preview'
      try {
        await onSetMotionMap(false, buildHairImportPreviewRequest(importState))
        await onReturnToFit(
          importState.inspection,
          buildHairImportPreviewRequest(importState)
        )
        soloObjectId = null
        importState = returnToPreviousHairImportStep(importState)
      } catch (error) {
        setError(error, 'The editable Hair preview could not be restored.', previousStep)
      } finally {
        busyAction = null
      }
      return
    }
    clearError()
    importState = returnToPreviousHairImportStep(importState)
  }

  function publishTransform(next: HairImportTransform) {
    clearError()
    importState = updateHairImportTransform(importState, next)
    try {
      void Promise.resolve(onPreviewTransformChange(importState.transform)).catch((error) => {
        setError(error, 'The live Hair fit could not be updated.', async () => publishTransform(next))
      })
    } catch (error) {
      setError(error, 'The live Hair fit could not be updated.', async () => publishTransform(next))
    }
  }

  function updateTransformGroup(
    group: 'move' | 'rotate' | 'axisScale',
    axis: 'x' | 'y' | 'z',
    value: number
  ) {
    const next: HairImportTransform = {
      move: { ...importState.transform.move },
      rotate: { ...importState.transform.rotate },
      uniformScale: importState.transform.uniformScale,
      axisScale: { ...importState.transform.axisScale }
    }
    next[group][axis] = value
    publishTransform(next)
  }

  function updateUniformScale(value: number) {
    publishTransform({ ...importState.transform, uniformScale: value })
  }

  function resetProposedTransform() {
    if (!importState.inspection) return
    publishTransform(importState.inspection.proposedTransform)
  }

  function moveOffsetCentimeters(axis: 'x' | 'y' | 'z') {
    if (!importState.inspection) return 0
    return Number(
      ((importState.transform.move[axis] - importState.inspection.proposedTransform.move[axis]) * 100).toFixed(2)
    )
  }

  function updateMoveOffsetCentimeters(axis: 'x' | 'y' | 'z', centimeters: number) {
    if (!importState.inspection) return
    updateTransformGroup(
      'move',
      axis,
      importState.inspection.proposedTransform.move[axis] + centimeters / 100
    )
  }

  function adjustRotationY(degrees: number) {
    updateTransformGroup('rotate', 'y', degrees)
  }

  function adjustUniformScale(factor: number) {
    updateUniformScale(importState.transform.uniformScale * factor)
  }

  function publishSelection(nextState: HairImportUiState, nextSoloObjectId: string | null) {
    clearError()
    importState = nextState
    soloObjectId = nextSoloObjectId
    const selected = [...nextState.selectedObjectIds]
    try {
      void Promise.resolve(onPreviewSelectionChange(selected, nextSoloObjectId)).catch((error) => {
        setError(error, 'The visible Hair objects could not be updated.', async () => {
          publishSelection(nextState, nextSoloObjectId)
        })
      })
    } catch (error) {
      setError(error, 'The visible Hair objects could not be updated.', async () => {
        publishSelection(nextState, nextSoloObjectId)
      })
    }
  }

  function setObjectIncluded(objectId: string, included: boolean) {
    const next = toggleHairImportObject(importState, objectId, included)
    publishSelection(next, soloObjectId === objectId && !included ? null : soloObjectId)
  }

  function toggleSoloObject(objectId: string) {
    const nextSolo = soloObjectId === objectId ? null : objectId
    publishSelection(importState, nextSolo)
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
</script>

<section class="hair-import-wizard" aria-labelledby="hair-import-title">
  <div class="hair-import-header">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-1.5">
        <h3 id="hair-import-title" class="batshit-settings-section-title">{mode === 'refit' ? 'Edit Hair Style' : 'Import Hair'}</h3>
        <SettingsInfoMenu ariaLabel={mode === 'refit' ? 'About Edit Hair Style' : 'About Import Hair'} contentClass="w-80">
          <p>
            {mode === 'refit'
              ? 'This starts from the last saved fit. Adjust it against the current Goon, then save. This creates a new copy of your hairstyle, so the older copy stays unchanged.'
              : 'Use the live preview to keep the right pieces and fit them to the Goon. Batshit builds the material, Appearance following, and motion automatically before you save.'}
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <Button
      variant="ghost"
      size="sm"
      onclick={() => void cancelImport()}
      disabled={actionDisabled}
      aria-label={finalized || finalizedResult !== null ? 'Close Hair import' : 'Cancel Hair import'}
    >
      {#if busyAction === 'cancel'}
        <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {:else}
        <X aria-hidden="true" />
      {/if}
      {finalized || finalizedResult !== null ? 'Close' : 'Cancel'}
    </Button>
  </div>

  <ol class="hair-import-steps" aria-label="Hair import progress">
    {#each HAIR_IMPORT_PROGRESS_STEPS as step, index (step.id)}
      <li class:current={step.id === currentStep.id} class:complete={index < currentStepIndex} aria-current={step.id === currentStep.id ? 'step' : undefined}>
        <span class="hair-import-step-marker" aria-hidden="true">
          {#if index < currentStepIndex}<Check />{:else}{index + 1}{/if}
        </span>
        <span>{step.label}</span>
      </li>
    {/each}
  </ol>
  <Progress
    value={currentStepIndex + (finalized ? 1 : 0)}
    max={HAIR_IMPORT_PROGRESS_STEPS.length}
    aria-label={`Hair import: ${finalized ? 'Saved' : currentStep.label}`}
  />

  {#if errorMessage}
    <div class="batshit-settings-muted-panel hair-import-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="batshit-settings-form-label is-danger">This step did not finish</div>
        <p class="batshit-settings-caption mt-1 break-words">{errorMessage}</p>
      </div>
      {#if retryAction}
        <Button variant="outline" size="sm" onclick={() => void retryAction?.()} disabled={actionDisabled}>
          <RotateCcw aria-hidden="true" />
          Retry
        </Button>
      {/if}
    </div>
  {/if}

  <div class="hair-import-stage" aria-live="polite">
    {#if importState.step === 'choose'}
      <section class="space-y-4" aria-labelledby="hair-import-choose-title">
        <div>
          <h4 id="hair-import-choose-title" class="batshit-settings-form-label">
            {selectedFile ? 'Selected Hair files' : 'Choose a finished Hair mesh'}
          </h4>
          <p class="batshit-settings-caption mt-1">
            {selectedFile
              ? 'Batshit is ready to inspect the selected geometry and optional Studio calibration.'
              : 'Choose one OBJ or GLB. For an Anime Hair Studio export, select its optional .ahs project at the same time for registered fitting.'}
          </p>
        </div>
        {#if !selectedFile}
          <input
            bind:this={fileInput}
            class="sr-only"
            type="file"
            accept=".obj,.glb,.ahs,model/gltf-binary,text/plain,application/json"
            aria-label="Choose Hair OBJ or GLB with optional AHS calibration"
            multiple
            onchange={handleFileChange}
            disabled={actionDisabled}
          />
          <Button variant="outline" onclick={() => fileInput?.click()} disabled={actionDisabled}>
            <FileUp aria-hidden="true" />
            Choose Hair files
          </Button>
        {/if}
        {#if importState.file}
          <div class="hair-import-file-row">
            <div class="min-w-0">
              <div class="batshit-settings-form-label truncate">{importState.file.name}</div>
              <p class="batshit-settings-code-caption mt-1">{formatBytes(importState.file.size)}</p>
            </div>
            <Badge variant="secondary" class="batshit-settings-child-label">Ready to inspect</Badge>
          </div>
        {/if}
        {#if selectedCalibrationFile}
          <div class="hair-import-file-row">
            <div class="min-w-0">
              <div class="batshit-settings-form-label truncate">{selectedCalibrationFile.name}</div>
              <p class="batshit-settings-code-caption mt-1">{formatBytes(selectedCalibrationFile.size)}</p>
            </div>
            <Badge variant="secondary" class="batshit-settings-child-label">Studio calibration</Badge>
          </div>
        {/if}
      </section>
    {:else if importState.step === 'inspect' && importState.inspection}
      <section class="space-y-4" aria-labelledby="hair-import-inspect-title">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="flex items-center gap-1.5">
            <h4 id="hair-import-inspect-title" class="batshit-settings-form-label">Keep Only the Hair Objects</h4>
            <SettingsInfoMenu ariaLabel="About Keep Only the Hair Objects" contentClass="w-80">
              <p>Uncheck a row and watch that piece disappear from the live Goon preview. Use Show only when source names do not explain what a piece is.</p>
            </SettingsInfoMenu>
          </div>
          <Badge variant="secondary" class="batshit-settings-child-label">{importState.inspection.sourceModeLabel}</Badge>
        </div>
        <div class="hair-import-object-list">
          {#each importState.inspection.objects as object (object.id)}
            <div class="hair-import-object-row">
              <Checkbox
                checked={importState.selectedObjectIds.includes(object.id)}
                onCheckedChange={(checked: boolean) => {
                  setObjectIncluded(object.id, checked === true)
                }}
                disabled={actionDisabled}
                class="shrink-0"
                aria-label={`Keep ${object.name}`}
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="batshit-settings-form-label">{object.name}</span>
                  {#if object.recommendedHair}
                    <Badge variant="outline" class="batshit-settings-child-label">Included initially</Badge>
                  {/if}
                </div>
                <p class="batshit-settings-code-caption mt-1">{object.triangleCount.toLocaleString()} triangles · {object.materialCount} {object.materialCount === 1 ? 'material' : 'materials'}</p>
              </div>
              <Button
                variant={soloObjectId === object.id ? 'default' : 'ghost'}
                size="sm"
                onclick={() => toggleSoloObject(object.id)}
                disabled={actionDisabled || !importState.selectedObjectIds.includes(object.id)}
                aria-label={soloObjectId === object.id ? `Show all included Hair objects` : `Show only ${object.name}`}
              >
                <Eye aria-hidden="true" />
                {soloObjectId === object.id ? 'Show all' : 'Show only'}
              </Button>
            </div>
          {/each}
        </div>
        {#if importState.selectedObjectIds.length === 0}
          <p class="batshit-settings-caption is-danger" role="status">Keep at least one Hair object to continue.</p>
        {/if}
        {#if visibleInspectionNotices.length > 0}
          <div class="hair-import-notices">
            {#each visibleInspectionNotices as notice (notice)}
              <p class="batshit-settings-caption">{notice}</p>
            {/each}
          </div>
        {/if}
      </section>
    {:else if importState.step === 'fit' && importState.inspection}
      <section class="space-y-5" aria-labelledby="hair-import-fit-title">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-1.5">
            <h4 id="hair-import-fit-title" class="batshit-settings-form-label">Fit the Live Hair Preview</h4>
            <SettingsInfoMenu ariaLabel="About Fit the Live Hair Preview" contentClass="w-80">
              Every control moves the temporary Hair immediately. Movement is measured in centimeters from Batshit’s starting fit.
            </SettingsInfoMenu>
          </div>
          <Button variant="ghost" size="sm" onclick={resetProposedTransform} disabled={actionDisabled}>
            <RotateCcw aria-hidden="true" />
            Reset Fit
          </Button>
        </div>

        <div class="hair-import-transform-group">
          <div class="flex items-center gap-1.5">
            <div class="batshit-settings-form-label">Move</div>
            <SettingsInfoMenu ariaLabel="About Move">Centimeter offsets from the starting fit.</SettingsInfoMenu>
          </div>
          <div class="hair-import-transform-grid">
            {#each ['x', 'y', 'z'] as axis (axis)}
              <label>
                <span>{axis.toUpperCase()} offset (cm)</span>
                <Input
                  type="number"
                  value={moveOffsetCentimeters(axis as 'x' | 'y' | 'z')}
                  min={-100}
                  max={100}
                  step={0.5}
                  disabled={actionDisabled}
                  oninput={(event) => updateMoveOffsetCentimeters(axis as 'x' | 'y' | 'z', Number(event.currentTarget.value))}
                  aria-label={`Move ${axis.toUpperCase()} offset in centimeters`}
                />
              </label>
            {/each}
          </div>
        </div>

        <div class="hair-import-transform-group">
          <div class="flex items-center gap-1.5">
            <div class="batshit-settings-form-label">Rotate</div>
            <SettingsInfoMenu ariaLabel="About Rotate">Degrees around each axis.</SettingsInfoMenu>
          </div>
          <div class="hair-import-quick-actions" aria-label="Quick Hair orientation">
            <Button variant="outline" size="sm" onclick={() => adjustRotationY(-90)} disabled={actionDisabled}>Turn left 90°</Button>
            <Button variant="outline" size="sm" onclick={() => adjustRotationY(90)} disabled={actionDisabled}>Turn right 90°</Button>
            <Button variant="outline" size="sm" onclick={() => adjustRotationY(180)} disabled={actionDisabled}>Flip 180°</Button>
          </div>
          <div class="hair-import-transform-grid hair-import-rotation-grid">
            {#each ['x', 'y', 'z'] as axis (axis)}
              <label>
                <span>{axis.toUpperCase()}</span>
                <Input
                  type="number"
                  value={importState.transform.rotate[axis as 'x' | 'y' | 'z']}
                  min={HAIR_IMPORT_TRANSFORM_LIMITS.rotate.min}
                  max={HAIR_IMPORT_TRANSFORM_LIMITS.rotate.max}
                  step={HAIR_IMPORT_TRANSFORM_LIMITS.rotate.step}
                  disabled={actionDisabled}
                  oninput={(event) => updateTransformGroup('rotate', axis as 'x' | 'y' | 'z', Number(event.currentTarget.value))}
                  aria-label={`Rotate ${axis.toUpperCase()}`}
                />
              </label>
            {/each}
          </div>
        </div>

        <div class="hair-import-transform-group">
          <div class="flex items-center gap-1.5">
            <div class="batshit-settings-form-label">Scale</div>
            <SettingsInfoMenu ariaLabel="About Scale" contentClass="w-80">
              Uniform scale sets size. X, Y, and Z make bounded fit corrections.
            </SettingsInfoMenu>
          </div>
          <div class="hair-import-quick-actions" aria-label="Quick Hair size">
            <Button variant="outline" size="sm" onclick={() => adjustUniformScale(0.8)} disabled={actionDisabled}>Smaller</Button>
            <Button variant="outline" size="sm" onclick={() => adjustUniformScale(1.25)} disabled={actionDisabled}>Larger</Button>
          </div>
          <div class="hair-import-scale-grid">
            <label>
              <span>Uniform</span>
              <Input
                type="number"
                value={importState.transform.uniformScale}
                min={HAIR_IMPORT_TRANSFORM_LIMITS.uniformScale.min}
                max={HAIR_IMPORT_TRANSFORM_LIMITS.uniformScale.max}
                step={HAIR_IMPORT_TRANSFORM_LIMITS.uniformScale.step}
                disabled={actionDisabled}
                oninput={(event) => updateUniformScale(Number(event.currentTarget.value))}
                aria-label="Uniform Scale"
              />
            </label>
            {#each ['x', 'y', 'z'] as axis (axis)}
              <label>
                <span>{axis.toUpperCase()} correction</span>
                <Input
                  type="number"
                  value={importState.transform.axisScale[axis as 'x' | 'y' | 'z']}
                  min={HAIR_IMPORT_TRANSFORM_LIMITS.axisScale.min}
                  max={HAIR_IMPORT_TRANSFORM_LIMITS.axisScale.max}
                  step={HAIR_IMPORT_TRANSFORM_LIMITS.axisScale.step}
                  disabled={actionDisabled}
                  oninput={(event) => updateTransformGroup('axisScale', axis as 'x' | 'y' | 'z', Number(event.currentTarget.value))}
                  aria-label={`${axis.toUpperCase()} Scale Correction`}
                />
              </label>
            {/each}
          </div>
        </div>
      </section>
    {:else if importState.step === 'physics' && importState.proposals}
      <section class="space-y-5" aria-labelledby="hair-import-physics-title">
        <div class="flex items-center gap-1.5">
          <h4 id="hair-import-physics-title" class="batshit-settings-form-label">Hair Physics</h4>
          <SettingsInfoMenu ariaLabel="About Hair Physics" contentClass="w-80">
            Choose Automatic Physics or paint the exact parts of the hairstyle that should move with the Goon.
          </SettingsInfoMenu>
        </div>
        <ToggleGroup.Root
          type="single"
          value={physicsMode}
          variant="outline"
          size="sm"
          class="hair-import-physics-mode"
          aria-label="Hair Physics Mode"
          onValueChange={selectPhysicsMode}
        >
          <ToggleGroup.Item value="automatic" class="!min-w-[7.5rem] !flex-none px-3.5" disabled={actionDisabled}>
            <WandSparkles aria-hidden="true" /> Automatic
          </ToggleGroup.Item>
          <ToggleGroup.Item value="custom" class="!min-w-[7.5rem] !flex-none px-3.5" disabled={actionDisabled}>
            <Paintbrush aria-hidden="true" /> Custom Paint
          </ToggleGroup.Item>
        </ToggleGroup.Root>
        <section class="hair-import-physics-content" aria-label="Hair Physics settings">
          <div class="hair-motion-paint-guide" aria-label="Hair motion map guide">
              <svg viewBox="0 0 320 92" role="img" aria-labelledby="hair-motion-guide-title hair-motion-guide-description">
                <title id="hair-motion-guide-title">How to paint Hair motion</title>
                <desc id="hair-motion-guide-description">Purple remains attached. Teal begins moving gently. Cyan moves most at the tip.</desc>
                <defs>
                  <linearGradient id="hair-motion-guide-gradient" x1="0" x2="1">
                    <stop offset="0%" stop-color="#251936" />
                    <stop offset="46%" stop-color="#251936" />
                    <stop offset="58%" stop-color="#16627a" />
                    <stop offset="100%" stop-color="#39d9ff" />
                  </linearGradient>
                </defs>
                <path d="M28 28 C88 10 140 28 184 42 C226 56 258 58 294 28 C282 58 266 76 235 76 C191 76 148 46 101 48 C74 49 50 57 28 70 Z" fill="url(#hair-motion-guide-gradient)" />
                <path d="M146 16 V78" stroke="currentColor" stroke-dasharray="3 4" opacity="0.55" />
              </svg>
              <div class="hair-motion-paint-guide-labels">
                <span><i class="hair-motion-swatch hair-motion-swatch-root"></i>Attached root</span>
                <span><i class="hair-motion-swatch hair-motion-swatch-painted"></i>Painted area</span>
                <span><i class="hair-motion-swatch hair-motion-swatch-tip"></i>Most motion</span>
              </div>
              {#if physicsMode === 'custom'}
                <p>For a hanging strand, paint roughly its outer half. Use a larger brush to fill connected tips, then orbit around to cover the back of each strand.</p>
              {/if}
          </div>
          {#if physicsMode === 'automatic'}
            <div class="hair-import-motion-summary">
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">Automatic Physics</Badge>
                <span class="batshit-settings-form-label">{importState.proposals.motionReview.regions.filter((region) => region.moving).length} moving sections found</span>
              </div>
              <p class="batshit-settings-caption mt-1">Batshit estimated the hanging tips. Orbit around the motion map and continue if it looks right.</p>
            </div>
          {:else}
            <div class="hair-import-custom-paint">
              <div>
                <h5 id="hair-motion-physics-title" class="batshit-settings-form-label">Paint What Can Move</h5>
                <p class="batshit-settings-caption mt-1">Paint the hanging strands, ponytail, or other parts that should move. Each disconnected painted piece becomes its own physics chain automatically.</p>
              </div>
              <Button
                variant="default"
                size="sm"
                onclick={() => void editMotionPaint()}
                disabled={actionDisabled}
              >
                <Paintbrush aria-hidden="true" />
                {importState.motionPaint ? 'Edit Painted Motion' : 'Paint Motion Areas'}
              </Button>
            </div>
            {#if importState.motionPaint}
              <div class="hair-import-motion-summary">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge variant="default">Custom Paint</Badge>
                  <span class="batshit-settings-code-caption">{countHairMotionPaintTriangles(importState.motionPaint).toLocaleString()} triangles</span>
                </div>
                <p class="batshit-settings-caption mt-1">Your painted selection replaces Automatic Physics.</p>
              </div>
            {/if}
          {/if}
        </section>
      </section>
    {:else if importState.step === 'finalize' && importState.proposals}
      <section class="space-y-5" aria-labelledby="hair-import-finalize-title">
        <div>
          <h4 id="hair-import-finalize-title" class="batshit-settings-form-label">Review Your Hair Style</h4>
          <p class="batshit-settings-caption mt-1">
            Orbit around the Goon and make sure the hairstyle looks right from every angle. When you’re happy with it, save the hair style.
          </p>
        </div>
      </section>
    {/if}
  </div>

  <div class="hair-import-footer">
    <Button
      variant="ghost"
      onclick={() => void previousStep()}
      disabled={actionDisabled || importState.step === 'choose' || (mode === 'refit' && importState.step === 'inspect') || finalized}
    >
      <ArrowLeft aria-hidden="true" />
      Back
    </Button>
    <div class="flex items-center gap-2">
      {#if importState.step === 'finalize'}
        <Button onclick={() => void finalizeImport()} disabled={actionDisabled || finalized}>
          {#if busyAction === 'finalize'}
            <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Saving…
          {:else if finalized}
            <Check aria-hidden="true" />
            Saved
          {:else}
            <Check aria-hidden="true" />
            Save Hair Style
          {/if}
        </Button>
      {:else}
        <Button onclick={nextStep} disabled={actionDisabled || !canContinueHairImport(importState) || (importState.step === 'physics' && physicsMode === 'custom' && !importState.motionPaint)}>
          {#if busyAction === 'inspect'}
            <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Inspecting…
          {:else if busyAction === 'preview'}
            <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Building preview…
          {:else}
            {importState.step === 'choose' ? 'Inspect and preview' : importState.step === 'fit' ? 'Continue to Physics' : 'Continue'}
            <ArrowRight aria-hidden="true" />
          {/if}
        </Button>
      {/if}
    </div>
  </div>
</section>

<style>
  .hair-import-wizard {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 1rem;
    border-top: 1px solid var(--bs-settings-inner-line);
    padding-top: 1rem;
  }

  .hair-import-header,
  .hair-import-footer {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .hair-import-steps {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .hair-import-steps li {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    color: var(--bs-settings-muted-text);
    font-size: 0.67rem;
    line-height: 1.2;
    text-align: center;
  }

  .hair-import-step-marker {
    display: grid;
    width: 1.25rem;
    height: 1.25rem;
    place-items: center;
    border: 1px solid var(--bs-settings-inner-line);
    border-radius: 999px;
    font-size: 0.62rem;
  }

  .hair-import-step-marker :global(svg) {
    width: 0.72rem;
    height: 0.72rem;
  }

  .hair-import-steps li.current,
  .hair-import-steps li.complete {
    color: var(--foreground);
  }

  .hair-import-steps li.current .hair-import-step-marker,
  .hair-import-steps li.complete .hair-import-step-marker {
    border-color: var(--primary);
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .hair-import-stage {
    min-height: 15rem;
    border-top: 1px solid var(--bs-settings-inner-line);
    border-bottom: 1px solid var(--bs-settings-inner-line);
    padding: 1rem 0;
  }

  .hair-import-error {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
  }

  .hair-import-error > :global(svg) {
    width: 1rem;
    height: 1rem;
    flex: none;
    margin-top: 0.1rem;
  }

  .hair-import-file-row,
  .hair-import-object-row {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .hair-import-file-row {
    align-items: center;
    border-top: 1px solid var(--bs-settings-inner-line);
    padding-top: 0.85rem;
  }

  .hair-import-object-list {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .hair-import-object-row {
    border-top: 1px solid var(--bs-settings-inner-line);
    padding: 0.85rem 0;
  }

  .hair-import-object-row:last-child {
    border-bottom: 1px solid var(--bs-settings-inner-line);
  }

  .hair-import-notices {
    display: grid;
    gap: 0.35rem;
    border-top: 1px solid var(--bs-settings-inner-line);
    padding-top: 0.75rem;
  }

  .hair-import-transform-group {
    display: grid;
    grid-template-columns: minmax(8rem, 0.8fr) minmax(0, 1.8fr);
    gap: 1rem;
    border-top: 1px solid var(--bs-settings-inner-line);
    padding-top: 1rem;
  }

  .hair-import-transform-grid,
  .hair-import-scale-grid {
    display: grid;
    grid-column: 2;
    grid-template-columns: repeat(3, minmax(5rem, 1fr));
    gap: 0.55rem;
  }

  .hair-import-scale-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .hair-import-rotation-grid {
    grid-template-columns: repeat(3, minmax(6.5rem, 1fr));
  }

  .hair-import-quick-actions {
    display: flex;
    grid-column: 2;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .hair-import-transform-grid label,
  .hair-import-scale-grid label {
    display: grid;
    gap: 0.3rem;
    color: var(--bs-settings-muted-text);
    font-size: 0.68rem;
  }

  .hair-import-motion-summary {
    border-top: 1px solid var(--bs-settings-inner-line);
    padding: 0.85rem 0;
  }

  .hair-import-physics-content {
    display: grid;
    gap: 1rem;
  }

  .hair-import-custom-paint {
    display: grid;
    justify-items: start;
    gap: 0.75rem;
  }

  .hair-motion-paint-guide {
    overflow: hidden;
    border: 1px solid var(--bs-settings-inner-line);
    border-radius: 0.65rem;
    background: oklch(from var(--muted) l c h / 0.2);
    padding: 0.7rem;
  }

  .hair-motion-paint-guide svg {
    display: block;
    width: 100%;
    max-height: 5.5rem;
    color: var(--muted-foreground);
  }

  .hair-motion-paint-guide-labels {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.45rem 0.8rem;
    margin-top: 0.25rem;
    color: var(--foreground);
    font-size: 0.66rem;
  }

  .hair-motion-paint-guide-labels span {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .hair-motion-swatch {
    width: 0.58rem;
    height: 0.58rem;
    border-radius: 999px;
  }

  .hair-motion-swatch-root {
    background: #251936;
  }

  .hair-motion-swatch-painted {
    background: #16627a;
  }

  .hair-motion-swatch-tip {
    background: #39d9ff;
  }

  .hair-motion-paint-guide p {
    margin-top: 0.55rem;
    color: var(--bs-settings-muted-text);
    font-size: 0.68rem;
    line-height: 1.45;
  }

  @media (max-width: 760px) {
    .hair-import-header,
    .hair-import-footer,
    .hair-import-object-row {
      align-items: stretch;
      flex-direction: column;
    }

    .hair-import-transform-group {
      grid-template-columns: 1fr;
    }

    .hair-import-quick-actions {
      grid-column: 1;
    }

    .hair-import-transform-grid,
    .hair-import-scale-grid {
      grid-column: 1;
    }

    .hair-import-transform-grid,
    .hair-import-scale-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
