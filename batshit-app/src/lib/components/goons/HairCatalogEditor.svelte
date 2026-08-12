<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
  } from '$lib/components/ui/alert-dialog'
  import { BATSHIT_SERVER_URL } from '$lib/services/apiClient'
  import {
    classifyHairAssetAvailability,
    resolveHairAssetBrowserUrl,
    resolveHairSelectionCatalogStatus
  } from '$lib/goons/hairCatalog'
  import type { HairAssetV1, HairRefitSourceV1, HairStateV2 } from '$lib/goons/hairAssets'
  import { HAIR_COLOR_PRESETS } from '$lib/goons/hairMaterial'
  import {
    HAIR_MOTION_INTENSITY_MAX,
    HAIR_MOTION_INTENSITY_MIN,
    HAIR_ROOT_WEIGHTED_MOTION_TAG,
    type SecondaryMotionTuning
  } from '$lib/goons/secondaryMotion'
  import type { RecipeSourceIdentity } from '$lib/goons/recipe/packageMetadata'
  import { Check, CircleAlert, FileUp, Loader2, Pencil, RefreshCw, RotateCcw, Scissors, Trash2 } from '@lucide/svelte'

  type Props = {
    assets: HairAssetV1[]
    refitSources?: HairRefitSourceV1[]
    valueState: HairStateV2
    recipeSource: RecipeSourceIdentity | null
    supported: boolean
    loading?: boolean
    busy?: boolean
    loadError?: string | null
    previewError?: string | null
    retiredStateRecovery?: {
      busy: boolean
      onReset: () => void | Promise<void>
    } | null
    disabled?: boolean
    onRefresh: () => void | Promise<void>
    onSelect: (asset: HairAssetV1 | null) => void | Promise<void>
    onColorsChange: (colors: {
      baseColor: string
      highlightColor: string
    }) => void | Promise<void>
    onImport?: (files: File[]) => void
    onRefit?: (asset: HairAssetV1, source: HairRefitSourceV1) => void | Promise<void>
    onDelete?: (asset: HairAssetV1) => void | Promise<void>
    motionTuning: SecondaryMotionTuning
    onMotionTuningChange: (value: SecondaryMotionTuning) => void | Promise<void>
  }

  let {
    assets,
    refitSources = [],
    valueState,
    recipeSource,
    supported,
    loading = false,
    busy = false,
    loadError = null,
    previewError = null,
    retiredStateRecovery = null,
    disabled = false,
    onRefresh,
    onSelect,
    onColorsChange,
    onImport = undefined,
    onRefit = undefined,
    onDelete = undefined,
    motionTuning,
    onMotionTuningChange
  }: Props = $props()

  let hairImportInput: HTMLInputElement | null = $state(null)
  let deleteTarget: HairAssetV1 | null = $state(null)
  let deleteDialogOpen = $state(false)
  let deleteBusy = $state(false)
  let previousSelectedKey = $state('')
  const selectionStatus = $derived(resolveHairSelectionCatalogStatus(valueState, assets))
  const selectedKey = $derived(
    valueState.selected
      ? `${valueState.selected.assetId}@${valueState.selected.assetRevisionId}`
      : ''
  )
  const builtInAssets = $derived(assets.filter((asset) => asset.sourceClass === 'builtin'))
  const importedAssets = $derived(assets.filter((asset) => asset.sourceClass === 'user'))

  $effect(() => {
    if (selectedKey) previousSelectedKey = selectedKey
  })

  function assetKey(asset: HairAssetV1) {
    return `${asset.assetId}@${asset.revisionId}`
  }

  function refitSourceFor(asset: HairAssetV1) {
    return refitSources.find(
      (source) => source.assetId === asset.assetId && source.revisionId === asset.revisionId
    ) ?? null
  }

  function handleHairImportSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const files = input.files ? Array.from(input.files) : []
    input.value = ''
    if (files.length > 0) onImport?.(files)
  }

  function singleValue(value: number | number[]): number {
    return typeof value === 'number' ? value : (value[0] ?? 0)
  }

  function selectableAsset(asset: HairAssetV1): boolean {
    return classifyHairAssetAvailability(asset, recipeSource).selectable
  }

  function handleNoHairChange(checked: boolean) {
    if (checked) {
      void onSelect(null)
      return
    }
    const previous = assets.find(
      (asset) => assetKey(asset) === previousSelectedKey && selectableAsset(asset)
    )
    const fallback = previous ?? assets.find(selectableAsset)
    if (fallback) void onSelect(fallback)
  }

  async function confirmDelete() {
    const target = deleteTarget
    if (!target || !onDelete || deleteBusy) return
    deleteBusy = true
    try {
      await onDelete(target)
      deleteTarget = null
      deleteDialogOpen = false
    } finally {
      deleteBusy = false
    }
  }
</script>

<AlertDialog bind:open={deleteDialogOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete this Hair revision?</AlertDialogTitle>
      <AlertDialogDescription>
        {deleteTarget
          ? `${deleteTarget.display.name} revision ${deleteTarget.revision} and its owned import files will be permanently deleted. Other immutable revisions remain available. Batshit will block deletion if a saved Goon still uses this exact revision.`
          : ''}
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel
        onclick={() => {
          deleteTarget = null
          deleteDialogOpen = false
        }}
        disabled={deleteBusy}
      >Cancel</AlertDialogCancel>
      <AlertDialogAction
        class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        disabled={deleteBusy}
        onclick={(event) => {
          event.preventDefault()
          void confirmDelete()
        }}
      >
        {#if deleteBusy}<Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />{/if}
        Delete revision
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>

<div class="space-y-4 px-3 pb-3">
  {#if !supported}
    <div class="batshit-settings-muted-panel flex items-start gap-2" role="status">
      <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="min-w-0">
        <div class="batshit-settings-form-label">Advanced/GLB Hair only</div>
        <p class="batshit-settings-caption mt-1">
          Hair Assets currently require a first-party Advanced/GLB Goon with a verified Recipe.
        </p>
      </div>
    </div>
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="batshit-settings-caption min-w-0">
        {loading
          ? 'Loading Hair catalog…'
          : 'Choose a style here, preview it immediately, then use Save Goon to keep it.'}
      </p>
      <Badge variant="secondary" class="batshit-settings-child-label">
        {assets.length} {assets.length === 1 ? 'style' : 'styles'}
      </Badge>
    </div>

    {#if selectionStatus.status === 'ready' && selectionStatus.asset}
      <div class="batshit-settings-muted-panel space-y-3">
        <div class="flex items-center gap-1.5">
          <div class="batshit-settings-form-label">Two-color Hair Palette</div>
          <SettingsInfoMenu ariaLabel="About Two-color Hair Palette">
            <p>
              Base controls the main tone. Highlight follows this style's painted mask while the neutral master keeps its shadows and sheen.
            </p>
          </SettingsInfoMenu>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="batshit-hair-color-control">
            <span class="batshit-settings-child-label">Base</span>
            <span class="batshit-settings-caption font-mono">{valueState.baseColor}</span>
            <input
              type="color"
              value={valueState.baseColor}
              aria-label="Hair Base Color"
              disabled={disabled || busy}
              oninput={(event) =>
                void onColorsChange({
                  baseColor: (event.currentTarget as HTMLInputElement).value,
                  highlightColor: valueState.highlightColor
                })}
            />
          </label>
          <label class="batshit-hair-color-control">
            <span class="batshit-settings-child-label">Highlight</span>
            <span class="batshit-settings-caption font-mono">{valueState.highlightColor}</span>
            <input
              type="color"
              value={valueState.highlightColor}
              aria-label="Hair Highlight Color"
              disabled={disabled || busy}
              oninput={(event) =>
                void onColorsChange({
                  baseColor: valueState.baseColor,
                  highlightColor: (event.currentTarget as HTMLInputElement).value
                })}
            />
          </label>
        </div>
        <div>
          <div class="batshit-settings-child-label mb-2">Palette presets</div>
          <div class="flex flex-wrap gap-2">
            {#each HAIR_COLOR_PRESETS as preset (preset.id)}
              <button
                type="button"
                class="batshit-hair-palette-preset"
                class:batshit-hair-palette-preset-active={valueState.baseColor ===
                  preset.baseColor && valueState.highlightColor === preset.highlightColor}
                aria-label={`Use ${preset.label} Hair palette`}
                disabled={disabled || busy}
                onclick={() =>
                  void onColorsChange({
                    baseColor: preset.baseColor,
                    highlightColor: preset.highlightColor
                  })}
              >
                <span class="batshit-hair-palette-swatches" aria-hidden="true">
                  <span style:background={preset.baseColor}></span>
                  <span style:background={preset.highlightColor}></span>
                </span>
                <span>{preset.label}</span>
              </button>
            {/each}
          </div>
        </div>
      </div>
      {#if selectionStatus.asset.display.tags.includes(HAIR_ROOT_WEIGHTED_MOTION_TAG)}
        <div class="batshit-settings-muted-panel space-y-3">
          <div class="flex items-center gap-1.5">
            <div class="batshit-settings-form-label">Motion Settings</div>
            <SettingsInfoMenu ariaLabel="About Motion Settings" contentClass="w-80">
              <p>
                This style already knows which Hair regions move and keeps their roots anchored. Turn physics on or off, then choose how strongly the loose sections respond.
              </p>
              <p class="mt-2">
                These values are saved with this Goon and baked into its self-contained Live Hair when you click Save Goon.
              </p>
            </SettingsInfoMenu>
          </div>
          <div class="batshit-hair-motion-switch-row">
            <div class="flex items-center gap-1.5">
              <div class="batshit-settings-child-label">Hair Physics</div>
              <SettingsInfoMenu ariaLabel="About Hair Physics">
                <p>
                  {motionTuning.enabled ? 'Loose sections respond to Goon movement.' : 'The whole hairstyle stays in its authored shape.'}
                </p>
              </SettingsInfoMenu>
            </div>
            <Switch.Root
              checked={motionTuning.enabled}
              onCheckedChange={(checked) =>
                void onMotionTuningChange({
                  ...motionTuning,
                  enabled: Boolean(checked)
                })}
              disabled={disabled || busy}
              aria-label="Hair Physics"
            />
          </div>
          <label class="batshit-hair-motion-control">
            <span>
              <span class="batshit-settings-child-label">Motion Intensity</span>
              <output>{Math.round(motionTuning.intensity * 100)}%</output>
            </span>
            <Slider
              type="single"
              value={motionTuning.intensity * 100}
              min={HAIR_MOTION_INTENSITY_MIN * 100}
              max={HAIR_MOTION_INTENSITY_MAX * 100}
              step={5}
              fillFrom={HAIR_MOTION_INTENSITY_MIN * 100}
              showAnchorMarker={false}
              aria-label="Hair Physics Intensity"
              disabled={disabled || busy || !motionTuning.enabled}
              onValueChange={(value: number | number[]) =>
                void onMotionTuningChange({
                  ...motionTuning,
                  intensity: singleValue(value) / 100
                })}
            />
          </label>
        </div>
      {/if}
    {/if}

    {#if selectionStatus.message && !loading && !loadError}
      <div class="batshit-settings-muted-panel flex items-start gap-2" role="alert">
        <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <p class="batshit-settings-caption is-danger">{selectionStatus.message}</p>
      </div>
    {/if}

    {#if retiredStateRecovery}
      <div class="batshit-settings-muted-panel space-y-3" role="alert">
        <div class="flex items-start gap-2">
          <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <div class="min-w-0">
            <div class="batshit-settings-form-label is-danger">This Goon needs a Hair reset</div>
            <p class="batshit-settings-caption mt-1">
              Reset only the retired Hair state. The Goon and every other appearance setting stay intact.
            </p>
          </div>
        </div>
        <div class="batshit-settings-action-row">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onclick={() => void retiredStateRecovery?.onReset()}
            disabled={retiredStateRecovery.busy}
          >
            {#if retiredStateRecovery.busy}
              <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {:else}
              <RotateCcw aria-hidden="true" />
            {/if}
            {retiredStateRecovery.busy ? 'Resetting Hair…' : 'Reset retired Hair'}
          </Button>
        </div>
      </div>
    {:else if previewError}
      <div class="batshit-settings-muted-panel flex items-start gap-2" role="alert">
        <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <p class="batshit-settings-caption is-danger">Hair preview failed: {previewError}</p>
      </div>
    {/if}

    {#if loadError}
      <div class="batshit-settings-muted-panel flex flex-wrap items-center justify-between gap-3" role="alert">
        <div class="flex min-w-0 items-start gap-2">
          <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <p class="batshit-settings-caption is-danger">{loadError}</p>
        </div>
        <Button variant="outline" size="sm" onclick={() => void onRefresh()} disabled={loading}>
          <RefreshCw class={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
          Retry
        </Button>
      </div>
    {:else}
      {#if loading}
        <div class="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3" aria-label="Loading Hair catalog">
          {#each Array(4) as _}
            <div class="h-44 animate-pulse rounded-lg border border-border/60 bg-muted/20 motion-reduce:animate-none"></div>
          {/each}
        </div>
      {:else}
        {#each [
          { id: 'builtin', label: 'Built-in Styles', items: builtInAssets },
          { id: 'imported', label: 'Imported Styles', items: importedAssets }
        ] as section (section.id)}
          <section class="space-y-3" aria-labelledby={`hair-section-${section.id}`}>
            <div class="flex items-center justify-between gap-2">
              <div id={`hair-section-${section.id}`} class="batshit-settings-form-label">{section.label}</div>
              <div class="flex items-center gap-2">
                {#if section.id === 'builtin'}
                  <label class="flex items-center gap-2">
                    <span class="batshit-settings-child-label">No Hair</span>
                    <Switch.Root
                      checked={!selectedKey}
                      onCheckedChange={(checked) => handleNoHairChange(Boolean(checked))}
                      disabled={disabled || busy || (!selectedKey && !assets.some(selectableAsset))}
                      aria-label="No Hair"
                    />
                  </label>
                {/if}
                {#if section.id === 'imported' && onImport}
                  <input
                    bind:this={hairImportInput}
                    class="sr-only"
                    type="file"
                    accept=".obj,.glb,.ahs,model/gltf-binary,text/plain,application/json"
                    aria-label="Import Hair OBJ or GLB with optional AHS calibration"
                    multiple
                    onchange={handleHairImportSelection}
                    disabled={disabled || busy}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={() => hairImportInput?.click()}
                    disabled={disabled || busy}
                  >
                    <FileUp aria-hidden="true" />
                    Import Hair
                  </Button>
                {/if}
                <Badge variant="secondary" class="batshit-settings-child-label">{section.items.length}</Badge>
              </div>
            </div>
            {#if section.items.length > 0}
              <div class="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3">
                {#each section.items as asset (assetKey(asset))}
                  {@const availability = classifyHairAssetAvailability(asset, recipeSource)}
                  {@const selected = selectedKey === assetKey(asset)}
                  {@const refitSource = refitSourceFor(asset)}
                  <div class="batshit-hair-card-stack">
                    <button
                      type="button"
                      class={`batshit-hair-card is-style ${selected ? 'is-selected' : ''}`}
                      aria-pressed={selected}
                      aria-label={`${asset.display.name}. ${availability.label}`}
                      title={availability.message ?? `Preview ${asset.display.name}`}
                      disabled={disabled || busy || !availability.selectable}
                      onclick={() => void onSelect(asset)}
                    >
                      <span class="batshit-hair-card-image-wrap">
                        <img
                          src={resolveHairAssetBrowserUrl(asset.display.previewImage.ref, BATSHIT_SERVER_URL)}
                          alt={`${asset.display.name} Hair preview`}
                          class="h-full w-full object-cover"
                          loading="lazy"
                        />
                        {#if selected}
                          <span class="batshit-hair-card-check" aria-hidden="true"><Check class="h-3.5 w-3.5" /></span>
                        {/if}
                      </span>
                      <span class="min-w-0 px-2.5 py-2 text-left">
                        <span class="batshit-settings-form-label block truncate">{asset.display.name}</span>
                        <span class="mt-1 flex flex-wrap gap-1">
                          <Badge variant="secondary" class="batshit-settings-child-label">
                            {asset.sourceClass === 'builtin' ? 'Built-in' : 'Imported'}
                          </Badge>
                          <Badge variant="secondary" class="batshit-settings-child-label">
                            {availability.label}
                          </Badge>
                        </span>
                      </span>
                    </button>
                    {#if asset.sourceClass === 'user'}
                      <div class="batshit-hair-card-actions">
                        {#if refitSource && onRefit}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={disabled || busy}
                            aria-label={`Edit ${asset.display.name}`}
                            onclick={() => void onRefit?.(asset, refitSource)}
                          >
                            <Pencil aria-hidden="true" />
                            Edit
                          </Button>
                        {/if}
                        {#if onDelete}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={disabled || busy || selected}
                            title={selected ? 'Choose another style or turn on No Hair before deleting this selected revision.' : `Delete ${asset.display.name} revision ${asset.revision}`}
                            aria-label={`Delete ${asset.display.name} revision ${asset.revision}`}
                            onclick={() => {
                              deleteTarget = asset
                              deleteDialogOpen = true
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                            Delete
                          </Button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <div class="batshit-settings-muted-panel flex items-start gap-2">
                <Scissors class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <p class="batshit-settings-caption">
                  {section.id === 'builtin'
                    ? 'Built-in styles will appear here as they finish product validation.'
                    : 'Import an OBJ or GLB to create your first reviewed Hair style.'}
                </p>
              </div>
            {/if}
          </section>
        {/each}
      {/if}
    {/if}
  {/if}
</div>

<style>
  .batshit-hair-card-stack {
    display: grid;
    min-width: 0;
    gap: 0.5rem;
  }

  .batshit-hair-card-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr));
    gap: 0.5rem;
  }

  .batshit-hair-card {
    display: flex;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--bs-settings-display-line, oklch(0.64 0.04 282.81 / 0.12));
    border-radius: 0.5rem;
    background: var(--bs-settings-display-surface, oklch(0.23 0.02 285));
    color: inherit;
    transition: background-color 160ms ease-out, border-color 160ms ease-out;
  }

  .batshit-hair-card:hover:not(:disabled) {
    background: var(--bs-settings-display-hover, oklch(0.27 0.025 285));
  }

  .batshit-hair-card:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .batshit-hair-card:disabled {
    cursor: not-allowed;
    opacity: 0.56;
  }

  .batshit-hair-card.is-selected {
    border-color: var(--primary);
    background: color-mix(in oklch, var(--primary) 18%, var(--bs-settings-display-surface, oklch(0.23 0.02 285)));
  }

  .batshit-hair-card.is-style {
    flex-direction: column;
    align-items: stretch;
  }

  .batshit-hair-card-image-wrap {
    position: relative;
    display: block;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    background: var(--bs-settings-inset-surface, oklch(0.12 0.012 245));
  }

  .batshit-hair-card-check {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: grid;
    width: 1.5rem;
    height: 1.5rem;
    place-items: center;
    border-radius: 999px;
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .batshit-hair-color-control {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--bs-settings-display-line, oklch(0.64 0.04 282.81 / 0.12));
    border-radius: 0.5rem;
    background: var(--bs-settings-display-surface, oklch(0.23 0.02 285));
  }

  .batshit-hair-color-control input[type='color'] {
    width: 2rem;
    height: 2rem;
    padding: 0.125rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: transparent;
    cursor: pointer;
  }

  .batshit-hair-color-control input[type='color']:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .batshit-hair-color-control input[type='color']:disabled {
    cursor: not-allowed;
    opacity: 0.56;
  }

  .batshit-hair-motion-control,
  .batshit-hair-motion-control > span {
    display: flex;
    min-width: 0;
  }

  .batshit-hair-motion-control {
    flex-direction: column;
    gap: 0.5rem;
  }

  .batshit-hair-motion-control > span {
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .batshit-hair-motion-control output {
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }

  .batshit-hair-motion-switch-row {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .batshit-hair-palette-preset {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.25rem;
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--bs-settings-display-line, oklch(0.64 0.04 282.81 / 0.12));
    border-radius: 999px;
    background: var(--bs-settings-display-surface, oklch(0.23 0.02 285));
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 600;
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .batshit-hair-palette-preset:hover:not(:disabled),
  .batshit-hair-palette-preset-active {
    border-color: color-mix(in oklab, var(--primary) 70%, transparent);
    background: color-mix(in oklab, var(--primary) 12%, transparent);
  }

  .batshit-hair-palette-preset:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .batshit-hair-palette-preset:disabled {
    cursor: not-allowed;
    opacity: 0.56;
  }

  .batshit-hair-palette-swatches {
    display: grid;
    grid-template-columns: repeat(2, 0.875rem);
    height: 0.875rem;
    overflow: hidden;
    border: 1px solid color-mix(in oklab, var(--foreground) 24%, transparent);
    border-radius: 999px;
  }

  @media (prefers-reduced-motion: reduce) {
    .batshit-hair-card {
      transition: none;
    }
  }
</style>
