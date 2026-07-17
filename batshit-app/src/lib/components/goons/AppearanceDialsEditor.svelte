<script lang="ts">
  import type { Snippet } from 'svelte'
  import { ChevronDown, Link2, RotateCcw, Search, Unlink2 } from '@lucide/svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as ToggleGroup from '$lib/components/ui/toggle-group'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Slider } from '$lib/components/ui/slider'
  import GoonsFieldLabel from '$lib/components/goons/GoonsFieldLabel.svelte'
  import {
    reconcileAppearanceDialValues,
    relockAppearanceDialSides,
    type AppearanceDialDefinition,
    type AppearanceDialSurface,
    type AppearanceDialValueState,
    type AppearanceDialsManifest
  } from '$lib/goons/appearanceDials'
  import {
    EYE_APPEARANCE_SCLERA_FIT_CONTROL_IDS,
    createDefaultEyeAppearanceState,
    readEyeAppearanceControl,
    updateEyeAppearanceControl,
    type EyeAppearanceControlDefinition,
    type EyeAppearanceDefinitionV1,
    type EyeAppearanceStateV1
  } from '$lib/goons/eyeAppearance'

  type TierFilter = 'core' | 'all'

  type Props = {
    manifest: AppearanceDialsManifest
    valueState: AppearanceDialValueState
    surface: AppearanceDialSurface
    onChange: (state: AppearanceDialValueState) => void
    eyeAppearanceDefinition?: EyeAppearanceDefinitionV1 | null
    eyeAppearanceState?: EyeAppearanceStateV1 | null
    onEyeAppearanceChange?: (state: EyeAppearanceStateV1) => void
    regionContentIds?: string[]
    regionContent?: Snippet<[regionId: string]>
  }

  let {
    manifest,
    valueState,
    surface,
    onChange,
    eyeAppearanceDefinition = null,
    eyeAppearanceState = null,
    onEyeAppearanceChange,
    regionContentIds = [],
    regionContent
  }: Props = $props()

  let tierFilter = $state<TierFilter>('core')
  let searchQuery = $state('')
  let openRegionId = $state<string | null>(null)

  const surfaceLabel = $derived(surface === 'body' ? 'Body' : 'Face')
  const reconciled = $derived.by(() => reconcileAppearanceDialValues(manifest, valueState))
  const normalizedSearch = $derived(searchQuery.trim().toLocaleLowerCase())
  const eyeRegionId = $derived.by(
    () =>
      manifest.regions.find(
        (region) =>
          region.surface === 'head-face' &&
          (region.id === 'face.eyes' || region.label.toLocaleLowerCase() === 'eyes')
      )?.id ?? null
  )
  const defaultEyeAppearanceState = $derived.by(() =>
    eyeAppearanceDefinition ? createDefaultEyeAppearanceState(eyeAppearanceDefinition) : null
  )
  const eyeAppearanceControls = $derived.by(() => {
    if (!eyeAppearanceDefinition || !eyeAppearanceState || !onEyeAppearanceChange) return []
    return EYE_APPEARANCE_SCLERA_FIT_CONTROL_IDS.map((id) =>
      eyeAppearanceDefinition.controls.find((control) => control.id === id)
    ).filter((control): control is EyeAppearanceControlDefinition => Boolean(control))
  })
  const scleraFitControls = $derived(
    eyeAppearanceControls.filter((control) =>
      EYE_APPEARANCE_SCLERA_FIT_CONTROL_IDS.some((id) => id === control.id)
    )
  )

  function dialValue(id: string): number {
    const value = reconciled.values[id]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  function isUnlocked(dialId: string): boolean {
    return reconciled.unlockedDialIds.includes(dialId)
  }

  function isDialChanged(dial: AppearanceDialDefinition): boolean {
    if (Math.abs(dialValue(dial.id) - dial.default) > 1e-6) return true
    if (isUnlocked(dial.id)) return true
    if (dial.symmetry?.mode !== 'linked-with-offsets') return false
    return (
      Math.abs(dialValue(dial.symmetry.left.id)) > 1e-6 ||
      Math.abs(dialValue(dial.symmetry.right.id)) > 1e-6
    )
  }

  function isEyeAppearanceControlChanged(control: EyeAppearanceControlDefinition): boolean {
    if (!eyeAppearanceState) return false
    return Math.abs(readEyeAppearanceControl(eyeAppearanceState, control.id) - control.default) > 1e-9
  }

  const eyeAppearanceChangedCount = $derived(
    eyeAppearanceControls.filter(isEyeAppearanceControlChanged).length
  )

  function surfaceChangedCount(targetSurface: AppearanceDialSurface): number {
    const appearanceCount = manifest.dials.filter((dial) => {
      const region = manifest.regions.find((candidate) => candidate.id === dial.region)
      return region?.surface === targetSurface && isDialChanged(dial)
    }).length
    return appearanceCount + (targetSurface === 'head-face' ? eyeAppearanceChangedCount : 0)
  }

  const changedCount = $derived(surfaceChangedCount(surface))

  function matchesDial(dial: AppearanceDialDefinition): boolean {
    if (tierFilter === 'core' && dial.tier !== 'core') return false
    if (!normalizedSearch) return true
    return [dial.label, dial.id, dial.description, ...dial.keywords]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedSearch)
  }

  function matchesEyeAppearanceControl(control: EyeAppearanceControlDefinition): boolean {
    if (!normalizedSearch) return true
    return [
      control.label,
      control.id,
      control.description,
      control.geometrySemantics,
      'eyes',
      'sclera fit'
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedSearch)
  }

  const visibleRegions = $derived.by(() =>
    manifest.regions
      .filter((region) => region.surface === surface)
      .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
      .map((region) => ({
        ...region,
        dials: manifest.dials
          .filter((dial) => dial.region === region.id && matchesDial(dial))
          .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label)),
        scleraControls:
          region.id === eyeRegionId
            ? scleraFitControls.filter(matchesEyeAppearanceControl)
            : [],
        hasEmbeddedContent: !normalizedSearch && regionContentIds.includes(region.id)
      }))
      .filter(
        (region) =>
          region.dials.length > 0 ||
          region.scleraControls.length > 0 ||
          region.hasEmbeddedContent
      )
  )

  $effect(() => {
    if (openRegionId && !visibleRegions.some((region) => region.id === openRegionId)) {
      openRegionId = null
    }
  })

  function emitValues(values: Record<string, number>, unlockedDialIds: string[]) {
    onChange({
      ...reconciled.state,
      values,
      unlockedDialIds: [...new Set(unlockedDialIds)].sort()
    })
  }

  function normalizeSliderValue(value: number | number[]): number {
    return typeof value === 'number' ? value : value[0] ?? 0
  }

  function updateValue(id: string, value: number, step: number) {
    if (Math.abs(dialValue(id) - value) < step / 2) return
    emitValues({ ...reconciled.values, [id]: value }, reconciled.unlockedDialIds)
  }

  function resetDial(dial: AppearanceDialDefinition) {
    const values = { ...reconciled.values, [dial.id]: dial.default }
    if (dial.symmetry?.mode === 'linked-with-offsets') {
      values[dial.symmetry.left.id] = 0
      values[dial.symmetry.right.id] = 0
    }
    emitValues(
      values,
      reconciled.unlockedDialIds.filter((id) => id !== dial.id)
    )
  }

  function resetDials(dials: AppearanceDialDefinition[]) {
    const values = { ...reconciled.values }
    const dialIds = new Set(dials.map((dial) => dial.id))
    for (const dial of dials) {
      values[dial.id] = dial.default
      if (dial.symmetry?.mode === 'linked-with-offsets') {
        values[dial.symmetry.left.id] = 0
        values[dial.symmetry.right.id] = 0
      }
    }
    emitValues(
      values,
      reconciled.unlockedDialIds.filter((id) => !dialIds.has(id))
    )
  }

  function resetRegion(regionId: string) {
    resetDials(manifest.dials.filter((candidate) => candidate.region === regionId))
    if (regionId === eyeRegionId) resetScleraFitControls()
  }

  function resetSurface() {
    const regionIds = new Set(
      manifest.regions.filter((region) => region.surface === surface).map((region) => region.id)
    )
    resetDials(manifest.dials.filter((dial) => regionIds.has(dial.region)))
    if (surface === 'head-face') resetScleraFitControls()
  }

  function updateEyeAppearanceValue(control: EyeAppearanceControlDefinition, value: number) {
    if (!eyeAppearanceState || !onEyeAppearanceChange) return
    if (Math.abs(readEyeAppearanceControl(eyeAppearanceState, control.id) - value) < control.step / 2) {
      return
    }
    onEyeAppearanceChange(updateEyeAppearanceControl(eyeAppearanceState, control.id, value))
  }

  function resetEyeAppearanceControl(control: EyeAppearanceControlDefinition) {
    updateEyeAppearanceValue(control, control.default)
  }

  function resetScleraFitControls() {
    if (!eyeAppearanceState || !defaultEyeAppearanceState || !onEyeAppearanceChange) return
    let nextState = eyeAppearanceState
    for (const controlId of EYE_APPEARANCE_SCLERA_FIT_CONTROL_IDS) {
      nextState = updateEyeAppearanceControl(
        nextState,
        controlId,
        readEyeAppearanceControl(defaultEyeAppearanceState, controlId)
      )
    }
    if (nextState !== eyeAppearanceState) onEyeAppearanceChange(nextState)
  }

  function toggleSideUnlock(dial: AppearanceDialDefinition) {
    if (dial.symmetry?.mode !== 'linked-with-offsets') return
    if (isUnlocked(dial.id)) {
      onChange(relockAppearanceDialSides(manifest, reconciled.state, dial.id))
      return
    }
    emitValues(reconciled.values, [...reconciled.unlockedDialIds, dial.id])
  }

  function formatValue(value: number, step: number): string {
    const decimals = step >= 1 ? 0 : Math.min(6, Math.max(1, Math.ceil(-Math.log10(step))))
    return value.toFixed(decimals)
  }

  function toggleRegion(regionId: string) {
    openRegionId = openRegionId === regionId ? null : regionId
  }

  function regionChangedCount(regionId: string): number {
    const appearanceCount = manifest.dials.filter(
      (dial) => dial.region === regionId && isDialChanged(dial)
    ).length
    return appearanceCount + (regionId === eyeRegionId ? eyeAppearanceChangedCount : 0)
  }
</script>

{#snippet eyeAppearanceControlRow(control: EyeAppearanceControlDefinition)}
  {@const value = eyeAppearanceState
    ? readEyeAppearanceControl(eyeAppearanceState, control.id)
    : control.default}
  {@const controlChanged = isEyeAppearanceControlChanged(control)}
  <div class="appearance-dial-row">
    <div class="appearance-dial-label-row">
      <GoonsFieldLabel
        label={control.label}
        info={control.description}
        ariaLabel={`About ${control.label}`}
      />
      <div class="appearance-dial-actions">
        <span class="appearance-dial-value">{formatValue(value, control.step)}</span>
        {#if controlChanged}
          <button
            type="button"
            class="appearance-dials-reset-dial"
            aria-label={`Reset ${control.label}`}
            title={`Reset ${control.label}`}
            onclick={() => resetEyeAppearanceControl(control)}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        {/if}
      </div>
    </div>
    <Slider
      type="single"
      {value}
      onValueChange={(nextValue: number | number[]) =>
        updateEyeAppearanceValue(control, normalizeSliderValue(nextValue))}
      min={control.minimum}
      max={control.maximum}
      step={control.step}
      fillFrom={control.default}
      showAnchorMarker={control.minimum < control.default && control.maximum > control.default}
      aria-label={control.label}
      class="appearance-dial-slider"
    />
  </div>
{/snippet}

<div class="appearance-dials-editor">
  <div class="appearance-dials-toolbar">
    <label class="appearance-dials-search">
      <Search aria-hidden="true" />
      <Input
        type="search"
        bind:value={searchQuery}
        placeholder={`Search ${surfaceLabel.toLocaleLowerCase()} appearance`}
        aria-label={`Search ${surfaceLabel} Appearance`}
      />
    </label>
    <ToggleGroup.Root
      type="single"
      value={tierFilter}
      variant="outline"
      size="sm"
      aria-label="Dial detail level"
      onValueChange={(value: string) => {
        if (value === 'core' || value === 'all') tierFilter = value
      }}
    >
      <ToggleGroup.Item value="core" class="appearance-dials-tier-option">Core</ToggleGroup.Item>
      <ToggleGroup.Item value="all" class="appearance-dials-tier-option">All</ToggleGroup.Item>
    </ToggleGroup.Root>
    <Button variant="outline" size="sm" onclick={resetSurface} disabled={changedCount === 0}>
      <RotateCcw aria-hidden="true" />
      Reset Dials
      {#if changedCount > 0}<span>({changedCount})</span>{/if}
    </Button>
  </div>

  {#if visibleRegions.length === 0}
    <div class="appearance-dials-empty">
      No {surfaceLabel.toLocaleLowerCase()} dials match this filter.
    </div>
  {:else}
    <div class="goon-level-2-accordion-list">
      {#each visibleRegions as region (region.id)}
        {@const isOpen = openRegionId === region.id}
        {@const regionChangeCount = regionChangedCount(region.id)}
        <Collapsible.Root open={isOpen} class="goon-level-2-accordion appearance-dials-region">
          <button
            type="button"
            class="goon-level-2-accordion-header appearance-dials-region-trigger flex w-full items-center justify-between gap-2 text-left"
            aria-expanded={isOpen}
            onclick={() => toggleRegion(region.id)}
          >
            <span class="batshit-settings-form-label appearance-dials-region-title">{region.label}</span>
            <span class="appearance-dials-region-meta">
              {region.dials.length + region.scleraControls.length}
              {#if regionChangeCount > 0}
                <span class="appearance-dials-changed-label">{regionChangeCount} changed</span>
              {/if}
              <ChevronDown aria-hidden="true" class="appearance-dials-chevron" data-open={isOpen} />
            </span>
          </button>
          {#if regionChangeCount > 0}
            <button
              type="button"
              class="appearance-dials-reset-region"
              aria-label={`Reset ${region.label}`}
              title={`Reset ${region.label}`}
              onclick={() => resetRegion(region.id)}
            >
              <RotateCcw aria-hidden="true" />
            </button>
          {/if}

          <Collapsible.Content class="goon-level-2-accordion-content appearance-dials-region-content">
            {#each region.dials as dial (dial.id)}
              {@const value = dialValue(dial.id)}
              {@const dialChanged = isDialChanged(dial)}
              {@const canUnlock = dial.symmetry?.mode === 'linked-with-offsets'}
              {@const unlocked = isUnlocked(dial.id)}
              <div class="appearance-dial-row">
                <div class="appearance-dial-label-row">
                  <GoonsFieldLabel
                    label={dial.label}
                    info={dial.description || null}
                    ariaLabel={`About ${dial.label}`}
                  />
                  <div class="appearance-dial-actions">
                    {#if canUnlock}
                      <button
                        type="button"
                        class="appearance-dials-link-toggle"
                        aria-pressed={!unlocked}
                        aria-label={`${unlocked ? 'Link' : 'Adjust'} ${dial.label} sides${unlocked ? '' : ' separately'}`}
                        title={unlocked ? 'Link sides and clear offsets' : 'Adjust left and right offsets separately'}
                        onclick={() => toggleSideUnlock(dial)}
                      >
                        {#if unlocked}
                          <Unlink2 aria-hidden="true" /> Separate
                        {:else}
                          <Link2 aria-hidden="true" /> Linked
                        {/if}
                      </button>
                    {/if}
                    <span class="appearance-dial-value">{formatValue(value, dial.step)}</span>
                    {#if dialChanged}
                      <button
                        type="button"
                        class="appearance-dials-reset-dial"
                        aria-label={`Reset ${dial.label}`}
                        title={`Reset ${dial.label}`}
                        onclick={() => resetDial(dial)}
                      >
                        <RotateCcw aria-hidden="true" />
                      </button>
                    {/if}
                  </div>
                </div>

                <Slider
                  type="single"
                  value={value}
                  onValueChange={(nextValue: number | number[]) =>
                    updateValue(dial.id, normalizeSliderValue(nextValue), dial.step)}
                  min={dial.range[0]}
                  max={dial.range[1]}
                  step={dial.step}
                  fillFrom={dial.default}
                  showAnchorMarker={dial.range[0] < dial.default && dial.range[1] > dial.default}
                  aria-label={dial.label}
                  class="appearance-dial-slider"
                />

                {#if canUnlock && unlocked && dial.symmetry?.mode === 'linked-with-offsets'}
                  <div class="appearance-dial-side-grid">
                    {#each [dial.symmetry.left, dial.symmetry.right] as side (side.id)}
                      <div class="appearance-dial-side-row">
                        <div class="appearance-dial-side-label">
                          <span>{side.label}</span>
                          <span>{formatValue(dialValue(side.id), side.step)}</span>
                        </div>
                        <Slider
                          type="single"
                          value={dialValue(side.id)}
                          onValueChange={(nextValue: number | number[]) =>
                            updateValue(side.id, normalizeSliderValue(nextValue), side.step)}
                          min={side.range[0]}
                          max={side.range[1]}
                          step={side.step}
                          fillFrom={0}
                          showAnchorMarker={side.range[0] < 0 && side.range[1] > 0}
                          aria-label={`${dial.label}, ${side.label} offset`}
                          class="appearance-dial-slider"
                        />
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}

            {#if region.scleraControls.length > 0}
              <div class="appearance-dial-subgroup-heading">
                <GoonsFieldLabel
                  label="Sclera Fit"
                  info="Linked across both eyes. Zero keeps the package-fitted result."
                  ariaLabel="About Sclera Fit"
                />
              </div>
              {#each region.scleraControls as control (control.id)}
                {@render eyeAppearanceControlRow(control)}
              {/each}
            {/if}

            {#if region.hasEmbeddedContent && regionContent}
              {@render regionContent(region.id)}
            {/if}
          </Collapsible.Content>
        </Collapsible.Root>
      {/each}
    </div>
  {/if}
</div>

<style>
  .appearance-dials-editor,
  :global(.appearance-dials-region-content),
  .appearance-dial-row,
  .appearance-dial-side-row {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .appearance-dials-editor {
    gap: 10px;
  }

  .appearance-dials-toolbar,
  .appearance-dial-label-row,
  .appearance-dial-actions,
  .appearance-dial-side-label,
  .appearance-dials-region-meta,
  .appearance-dials-search,
  .appearance-dials-link-toggle {
    display: flex;
    align-items: center;
  }

  .appearance-dials-toolbar {
    flex-wrap: wrap;
    gap: 8px;
  }

  .appearance-dials-search {
    position: relative;
    min-width: 0;
    flex: 1 1 12rem;
  }

  .appearance-dials-search :global(svg) {
    position: absolute;
    left: 9px;
    z-index: 1;
    width: 13px;
    height: 13px;
    color: var(--muted-foreground);
    pointer-events: none;
  }

  .appearance-dials-search :global(input) {
    min-width: 0;
    height: 32px;
    padding-left: 28px;
    font-size: 0.6875rem;
  }

  :global(.appearance-dials-tier-option) {
    min-width: 3.75rem !important;
    padding-inline: 12px !important;
    font-size: 0.6875rem;
    font-weight: 500;
  }

  .appearance-dials-empty {
    padding: 12px;
    border: 1px dashed var(--border);
    border-radius: 7px;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    text-align: center;
  }

  :global(.appearance-dials-region) {
    position: relative;
  }

  .appearance-dials-region-trigger {
    white-space: nowrap;
    padding-right: 2.5rem;
    text-align: left;
  }

  .appearance-dials-region-title {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .appearance-dials-region-meta {
    margin-left: auto;
    flex-shrink: 0;
    gap: 7px;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-weight: 400;
    white-space: nowrap;
  }

  :global(.appearance-dials-chevron) {
    width: 14px;
    height: 14px;
    transition: transform 180ms ease-out;
  }

  :global(.appearance-dials-chevron[data-open='true']) {
    transform: rotate(180deg);
  }

  .appearance-dials-changed-label {
    color: var(--primary);
  }

  .appearance-dials-reset-region {
    position: absolute;
    top: 7px;
    right: 6px;
    z-index: 1;
    display: inline-flex;
    width: 26px;
    height: 26px;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    color: var(--muted-foreground);
  }

  .appearance-dials-reset-region:hover,
  .appearance-dials-reset-dial:hover {
    color: var(--foreground);
    background: var(--accent);
  }

  .appearance-dials-reset-region :global(svg),
  .appearance-dials-reset-dial :global(svg),
  .appearance-dials-link-toggle :global(svg) {
    width: 12px;
    height: 12px;
  }

  :global(.appearance-dials-region-content) {
    gap: 12px;
  }

  .appearance-dial-row {
    gap: 7px;
  }

  .appearance-dial-row + .appearance-dial-row {
    padding-top: 10px;
    border-top: 1px solid color-mix(in oklab, var(--border) 65%, transparent);
  }

  .appearance-dial-label-row,
  .appearance-dial-side-label {
    justify-content: space-between;
    gap: 10px;
  }

  .appearance-dial-actions {
    flex-shrink: 0;
    gap: 6px;
  }

  .appearance-dial-value,
  .appearance-dial-side-label span:last-child {
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }

  .appearance-dials-reset-dial {
    display: inline-flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    color: var(--muted-foreground);
  }

  .appearance-dials-link-toggle {
    min-height: 24px;
    gap: 4px;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--muted-foreground);
    font-size: 0.59375rem;
  }

  .appearance-dials-link-toggle:hover {
    color: var(--foreground);
    background: var(--accent);
  }

  .appearance-dial-side-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: color-mix(in oklab, var(--muted) 44%, transparent);
  }

  .appearance-dial-side-row {
    gap: 5px;
  }

  .appearance-dial-side-label {
    color: var(--foreground);
    font-size: 0.625rem;
  }

  .appearance-dial-subgroup-heading {
    padding-top: 10px;
    border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
  }

  @container (max-width: 420px) {
    .appearance-dial-side-grid {
      grid-template-columns: 1fr;
    }

    .appearance-dials-toolbar > :global(.bs-button) {
      flex: 1 1 auto;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.appearance-dials-chevron) {
      transition: none;
    }
  }
</style>
