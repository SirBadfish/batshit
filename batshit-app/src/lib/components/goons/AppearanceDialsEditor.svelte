<script lang="ts">
  import { ChevronDown, Link2, RotateCcw, Search, Unlink2 } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Slider } from '$lib/components/ui/slider'
  import {
    reconcileAppearanceDialValues,
    relockAppearanceDialSides,
    type AppearanceDialDefinition,
    type AppearanceDialSurface,
    type AppearanceDialValueState,
    type AppearanceDialsManifest
  } from '$lib/goons/appearanceDials'

  type TierFilter = 'core' | 'all'

  type Props = {
    manifest: AppearanceDialsManifest
    valueState: AppearanceDialValueState
    onChange: (state: AppearanceDialValueState) => void
  }

  let { manifest, valueState, onChange }: Props = $props()

  let activeSurface = $state<AppearanceDialSurface>('body')
  let tierFilter = $state<TierFilter>('core')
  let searchQuery = $state('')
  let openRegionId = $state<string | null>(null)

  const surfaceOptions: Array<{ id: AppearanceDialSurface; label: string }> = [
    { id: 'body', label: 'Body' },
    { id: 'head-face', label: 'Head & Face' }
  ]

  const reconciled = $derived.by(() => reconcileAppearanceDialValues(manifest, valueState))
  const normalizedSearch = $derived(searchQuery.trim().toLocaleLowerCase())

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

  function surfaceChangedCount(surface: AppearanceDialSurface): number {
    return manifest.dials.filter((dial) => {
      const region = manifest.regions.find((candidate) => candidate.id === dial.region)
      return region?.surface === surface && isDialChanged(dial)
    }).length
  }

  const totalChangedCount = $derived(manifest.dials.filter(isDialChanged).length)

  function matchesDial(dial: AppearanceDialDefinition): boolean {
    if (tierFilter === 'core' && dial.tier !== 'core') return false
    if (!normalizedSearch) return true
    return [dial.label, dial.id, dial.description, ...dial.keywords]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedSearch)
  }

  const visibleRegions = $derived.by(() =>
    manifest.regions
      .filter((region) => region.surface === activeSurface)
      .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
      .map((region) => ({
        ...region,
        dials: manifest.dials
          .filter((dial) => dial.region === region.id && matchesDial(dial))
          .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
      }))
      .filter((region) => region.dials.length > 0)
  )

  const visibleDialCount = $derived(
    visibleRegions.reduce((count, region) => count + region.dials.length, 0)
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

  function resetRegion(regionId: string) {
    const values = { ...reconciled.values }
    const regionDials = manifest.dials.filter((candidate) => candidate.region === regionId)
    const regionDialIds = new Set(regionDials.map((dial) => dial.id))
    for (const dial of regionDials) {
      values[dial.id] = dial.default
      if (dial.symmetry?.mode === 'linked-with-offsets') {
        values[dial.symmetry.left.id] = 0
        values[dial.symmetry.right.id] = 0
      }
    }
    emitValues(
      values,
      reconciled.unlockedDialIds.filter((id) => !regionDialIds.has(id))
    )
  }

  function resetAll() {
    onChange(reconcileAppearanceDialValues(manifest, null).state)
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
    const decimals = step >= 1 ? 0 : Math.min(3, Math.max(1, Math.ceil(-Math.log10(step))))
    return value.toFixed(decimals)
  }

  function toggleRegion(regionId: string) {
    openRegionId = openRegionId === regionId ? null : regionId
  }

  function regionChangedCount(regionId: string): number {
    return manifest.dials.filter((dial) => dial.region === regionId && isDialChanged(dial)).length
  }
</script>

<div class="appearance-dials-editor">
  <div class="appearance-dials-toolbar">
    <div class="appearance-dials-surface-tabs" role="group" aria-label="Appearance area">
      {#each surfaceOptions as surface (surface.id)}
        {@const changedCount = surfaceChangedCount(surface.id)}
        <button
          type="button"
          aria-pressed={activeSurface === surface.id}
          class:active={activeSurface === surface.id}
          onclick={() => {
            activeSurface = surface.id
            openRegionId = null
          }}
        >
          <span>{surface.label}</span>
          {#if changedCount > 0}
            <span class="appearance-dials-count" aria-label={`${changedCount} changed`}>
              {changedCount}
            </span>
          {/if}
        </button>
      {/each}
    </div>

    <Button variant="outline" size="sm" onclick={resetAll} disabled={totalChangedCount === 0}>
      <RotateCcw aria-hidden="true" />
      Reset All
      {#if totalChangedCount > 0}<span>({totalChangedCount})</span>{/if}
    </Button>
  </div>

  <div class="appearance-dials-filters">
    <label class="appearance-dials-search">
      <Search aria-hidden="true" />
      <Input
        type="search"
        bind:value={searchQuery}
        placeholder="Search appearance dials"
        aria-label="Search appearance dials"
      />
    </label>
    <div class="appearance-dials-tier-filter" role="group" aria-label="Dial detail level">
      <button
        type="button"
        class:active={tierFilter === 'core'}
        aria-pressed={tierFilter === 'core'}
        onclick={() => (tierFilter = 'core')}
      >Core</button>
      <button
        type="button"
        class:active={tierFilter === 'all'}
        aria-pressed={tierFilter === 'all'}
        onclick={() => (tierFilter = 'all')}
      >All</button>
    </div>
  </div>

  <p class="appearance-dials-result-summary" aria-live="polite">
    {visibleDialCount} {visibleDialCount === 1 ? 'dial' : 'dials'}
    {#if tierFilter === 'core'} · Core controls{/if}
  </p>

  {#if visibleRegions.length === 0}
    <div class="appearance-dials-empty">
      No {activeSurface === 'body' ? 'body' : 'head and face'} dials match this filter.
    </div>
  {:else}
    <div class="appearance-dials-regions">
      {#each visibleRegions as region (region.id)}
        {@const isOpen = openRegionId === region.id}
        {@const changedCount = regionChangedCount(region.id)}
        <section class="appearance-dials-region" data-state={isOpen ? 'open' : 'closed'}>
          <div class="appearance-dials-region-heading">
            <button
              type="button"
              class="appearance-dials-region-trigger"
              aria-expanded={isOpen}
              onclick={() => toggleRegion(region.id)}
            >
              <span>{region.label}</span>
              <span class="appearance-dials-region-meta">
                {region.dials.length}
                {#if changedCount > 0}
                  <span class="appearance-dials-changed-label">{changedCount} changed</span>
                {/if}
                <ChevronDown aria-hidden="true" class={isOpen ? 'open' : ''} />
              </span>
            </button>
            {#if changedCount > 0}
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
          </div>

          {#if isOpen}
            <div class="appearance-dials-region-content">
              {#each region.dials as dial (dial.id)}
                {@const value = dialValue(dial.id)}
                {@const changed = isDialChanged(dial)}
                {@const canUnlock = dial.symmetry?.mode === 'linked-with-offsets'}
                {@const unlocked = isUnlocked(dial.id)}
                <div class="appearance-dial-row">
                  <div class="appearance-dial-label-row">
                    <div class="appearance-dial-copy">
                      <span class="appearance-dial-label" title={dial.id}>{dial.label}</span>
                      {#if dial.description}
                        <span class="appearance-dial-description">{dial.description}</span>
                      {/if}
                    </div>
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
                      {#if changed}
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
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .appearance-dials-editor,
  .appearance-dials-regions,
  .appearance-dials-region-content,
  .appearance-dial-row,
  .appearance-dial-copy,
  .appearance-dial-side-row {
    display: flex;
    flex-direction: column;
  }

  .appearance-dials-editor {
    gap: 10px;
    min-width: 0;
  }

  .appearance-dials-toolbar,
  .appearance-dials-filters,
  .appearance-dials-region-heading,
  .appearance-dials-region-trigger,
  .appearance-dials-region-meta,
  .appearance-dial-label-row,
  .appearance-dial-actions,
  .appearance-dial-side-label,
  .appearance-dials-surface-tabs,
  .appearance-dials-tier-filter,
  .appearance-dials-search,
  .appearance-dials-link-toggle {
    display: flex;
    align-items: center;
  }

  .appearance-dials-toolbar,
  .appearance-dials-filters,
  .appearance-dial-label-row,
  .appearance-dial-side-label {
    justify-content: space-between;
  }

  .appearance-dials-toolbar,
  .appearance-dials-filters {
    gap: 8px;
  }

  .appearance-dials-surface-tabs,
  .appearance-dials-tier-filter {
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--muted);
  }

  .appearance-dials-surface-tabs button,
  .appearance-dials-tier-filter button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 28px;
    border: 0;
    border-radius: 5px;
    padding: 0 9px;
    color: var(--muted-foreground);
    background: transparent;
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
  }

  .appearance-dials-surface-tabs button:hover,
  .appearance-dials-tier-filter button:hover {
    color: var(--foreground);
  }

  .appearance-dials-surface-tabs button.active,
  .appearance-dials-tier-filter button.active {
    color: var(--foreground);
    background: var(--background);
    box-shadow: 0 1px 2px rgb(0 0 0 / 14%);
  }

  .appearance-dials-surface-tabs button:focus-visible,
  .appearance-dials-tier-filter button:focus-visible,
  .appearance-dials-region-trigger:focus-visible,
  .appearance-dials-reset-region:focus-visible,
  .appearance-dials-reset-dial:focus-visible,
  .appearance-dials-link-toggle:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .appearance-dials-count {
    min-width: 16px;
    border-radius: 999px;
    padding: 1px 4px;
    color: var(--foreground);
    background: color-mix(in oklab, var(--primary) 18%, transparent);
    font-size: 0.5625rem;
    font-variant-numeric: tabular-nums;
  }

  .appearance-dials-search {
    position: relative;
    flex: 1;
    min-width: 140px;
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

  .appearance-dials-result-summary {
    margin: -2px 0 0;
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .appearance-dials-regions {
    gap: 6px;
  }

  .appearance-dials-region {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .appearance-dials-region-heading {
    position: relative;
  }

  .appearance-dials-region-trigger {
    width: 100%;
    min-height: 36px;
    justify-content: space-between;
    gap: 12px;
    border: 0;
    padding: 7px 38px 7px 10px;
    color: var(--foreground);
    background: color-mix(in oklab, var(--muted) 72%, transparent);
    text-align: left;
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
  }

  .appearance-dials-region-trigger:hover {
    background: var(--muted);
  }

  .appearance-dials-region-meta {
    gap: 7px;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-weight: 400;
    white-space: nowrap;
  }

  .appearance-dials-region-meta :global(svg) {
    width: 14px;
    height: 14px;
    transition: transform 0.18s ease-out;
  }

  .appearance-dials-region-meta :global(svg.open) {
    transform: rotate(180deg);
  }

  .appearance-dials-changed-label {
    color: var(--primary);
  }

  .appearance-dials-reset-region {
    position: absolute;
    top: 7px;
    right: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 5px;
    color: var(--muted-foreground);
    background: transparent;
    cursor: pointer;
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

  .appearance-dials-region-content {
    gap: 12px;
    padding: 10px;
  }

  .appearance-dial-row {
    gap: 6px;
  }

  .appearance-dial-row + .appearance-dial-row {
    padding-top: 10px;
    border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
  }

  .appearance-dial-label-row {
    gap: 12px;
  }

  .appearance-dial-copy {
    min-width: 0;
    gap: 2px;
  }

  .appearance-dial-label {
    color: var(--foreground);
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .appearance-dial-description {
    overflow: hidden;
    color: var(--muted-foreground);
    font-size: 0.59375rem;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .appearance-dial-actions {
    flex-shrink: 0;
    gap: 5px;
  }

  .appearance-dial-value,
  .appearance-dial-side-label {
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }

  .appearance-dials-reset-dial,
  .appearance-dials-link-toggle {
    border: 0;
    border-radius: 5px;
    color: var(--muted-foreground);
    background: transparent;
    cursor: pointer;
  }

  .appearance-dials-reset-dial {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
  }

  .appearance-dials-link-toggle {
    gap: 4px;
    min-height: 22px;
    padding: 0 5px;
    font-size: 0.5625rem;
  }

  .appearance-dials-link-toggle:hover {
    color: var(--foreground);
    background: var(--accent);
  }

  :global(.appearance-dial-slider) {
    width: 100%;
  }

  .appearance-dial-side-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin-top: 2px;
    padding: 8px;
    border-radius: 6px;
    background: color-mix(in oklab, var(--muted) 68%, transparent);
  }

  .appearance-dial-side-row {
    gap: 5px;
    min-width: 0;
  }

  .appearance-dials-empty {
    padding: 18px 12px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    color: var(--muted-foreground);
    text-align: center;
    font-size: 0.6875rem;
  }

  @media (max-width: 560px) {
    .appearance-dials-toolbar,
    .appearance-dials-filters {
      align-items: stretch;
      flex-direction: column;
    }

    .appearance-dials-surface-tabs,
    .appearance-dials-tier-filter {
      align-self: stretch;
    }

    .appearance-dials-surface-tabs button,
    .appearance-dials-tier-filter button {
      flex: 1;
    }

    .appearance-dial-label-row {
      align-items: flex-start;
      flex-direction: column;
      gap: 5px;
    }

    .appearance-dial-actions {
      width: 100%;
      justify-content: flex-end;
    }

    .appearance-dial-description {
      white-space: normal;
    }

    .appearance-dial-side-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .appearance-dials-region-meta :global(svg) {
      transition: none;
    }
  }
</style>
