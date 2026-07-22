<script lang="ts">
  import { ChevronDown, Link2, RotateCcw, Search, Unlink2 } from '@lucide/svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Slider } from '$lib/components/ui/slider'
  import type { GoonExpressionPreset } from '$lib/types/goons'
  import type {
    UniversalFaceControlDefinition,
    UniversalFaceControlModel,
    UniversalFaceControlSection
  } from '$lib/goons/universalFaceControls'

  type PresetOption = {
    value: GoonExpressionPreset
    label: string
    available?: boolean
    unavailableReason?: string
  }

  type Props = {
    presetOptions?: PresetOption[]
    model: UniversalFaceControlModel
    getPresetValue?: (preset: GoonExpressionPreset) => number
    onPresetChange?: (preset: GoonExpressionPreset, value: number) => void
    getControlValue: (control: UniversalFaceControlDefinition) => number
    onControlChange: (control: UniversalFaceControlDefinition, value: number) => void
    onReset: () => void
    isGroupLocked?: (groupId: string) => boolean
    onToggleGroupLock?: (groupId: string, locked: boolean) => void
  }

  let {
    presetOptions = [],
    model,
    getPresetValue = () => 0,
    onPresetChange = () => {},
    getControlValue,
    onControlChange,
    onReset,
    isGroupLocked = () => false,
    onToggleGroupLock
  }: Props = $props()

  let searchQuery = $state('')
  let openSectionId = $state<string | null>('facial-presets')

  const authoredPresets = $derived(presetOptions.filter((preset) => preset.value !== 'neutral'))
  const normalizedSearch = $derived(searchQuery.trim().toLocaleLowerCase())
  const searchTokens = $derived(normalizedSearch.split(/\s+/).filter(Boolean))
  const matchingPresets = $derived.by(() => {
    if (!normalizedSearch) return authoredPresets
    return authoredPresets.filter((preset) =>
      matchesSearch(`${preset.label} ${preset.value}`)
    )
  })
  const matchingSections = $derived.by(() => {
    if (!normalizedSearch) return model.sections
    return model.sections.flatMap((section) => {
      const sectionMatches = section.label.toLocaleLowerCase().includes(normalizedSearch)
      const controls = sectionMatches
        ? section.controls
        : section.controls.filter((control) =>
            matchesSearch(`${section.label} ${control.label} ${control.searchText}`)
          )
      return controls.length > 0 ? [{ ...section, controls }] : []
    })
  })
  const hasMatches = $derived(matchingPresets.length > 0 || matchingSections.length > 0)

  function normalizeSliderValue(value: number | number[]): number {
    return typeof value === 'number' ? value : value[0] ?? 0
  }

  function matchesSearch(value: string): boolean {
    const corpus = value.toLocaleLowerCase()
    return searchTokens.every((token) => corpus.includes(token))
  }

  function formatValue(control: UniversalFaceControlDefinition, value: number): string {
    if (!control.bipolar) return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
    const rounded = Math.round(value * 100)
    return `${rounded > 0 ? '+' : ''}${rounded}%`
  }

  function changedControlCount(section: UniversalFaceControlSection): number {
    return section.controls.filter((control) => Math.abs(getControlValue(control)) > 0.0001).length
  }

  function changedPresetCount(): number {
    return authoredPresets.filter((preset) => Math.abs(getPresetValue(preset.value)) > 0.0001).length
  }

  function isSectionOpen(sectionId: string): boolean {
    return Boolean(normalizedSearch) || openSectionId === sectionId
  }

  function toggleSection(sectionId: string) {
    if (normalizedSearch) return
    openSectionId = openSectionId === sectionId ? null : sectionId
  }

  function isFirstLockControl(
    controls: UniversalFaceControlDefinition[],
    groupId: string,
    controlId: string
  ): boolean {
    return (controls.find((control) => control.lockGroup === groupId)?.id ?? null) === controlId
  }
</script>

<div class="universal-face-editor">
  <div class="universal-face-toolbar">
    <div class="universal-face-search">
      <Search aria-hidden="true" />
      <Input type="search" bind:value={searchQuery} placeholder="Search face controls" aria-label="Search face controls" />
    </div>
    <Button type="button" variant="outline" size="sm" onclick={onReset}>
      <RotateCcw aria-hidden="true" />
      Reset Face
    </Button>
  </div>

  {#if !hasMatches}
    <div class="universal-face-empty">No face controls match “{searchQuery.trim()}”.</div>
  {:else}
    <div class="goon-level-3-accordion-list">
      {#if matchingPresets.length > 0}
        {@const presetsOpen = isSectionOpen('facial-presets')}
        <Collapsible.Root open={presetsOpen} class="goon-level-3-accordion">
          <button
            type="button"
            class="goon-level-3-accordion-header"
            aria-expanded={presetsOpen}
            onclick={() => toggleSection('facial-presets')}
          >
            <span class="goon-level-3-accordion-title">Facial Presets</span>
            <span class="universal-face-section-meta">
              {#if changedPresetCount() > 0}<span>{changedPresetCount()} active</span>{/if}
              <ChevronDown class="universal-face-chevron" data-open={presetsOpen} />
            </span>
          </button>
          <Collapsible.Content class="goon-level-3-accordion-content">
            <p class="universal-face-help">
              Five shared expressions for Standard/VRoid and Custom GLB Goons. Neutral is the authored reset state.
            </p>
            {#each matchingPresets as preset (preset.value)}
              {@const value = getPresetValue(preset.value)}
              {@const unavailable = preset.available === false}
              <div
                class="universal-face-field"
                data-unavailable={unavailable}
                title={unavailable ? preset.unavailableReason : undefined}
              >
                <div class="universal-face-row-between">
                  <span class="universal-face-label">
                    {preset.label}
                    {#if unavailable}<span class="universal-face-badge">Unavailable</span>{/if}
                  </span>
                  <span class="universal-face-value">
                    {unavailable ? (value > 0 ? `Saved ${Math.round(value * 100)}%` : 'Not mapped') : `${Math.round(value * 100)}%`}
                  </span>
                </div>
                <div class="universal-face-slider-row">
                  <span class="universal-face-range universal-face-range-left">0%</span>
                  <Slider
                    type="single"
                    value={value}
                    onValueChange={(nextValue: number | number[]) =>
                      onPresetChange(preset.value, normalizeSliderValue(nextValue))}
                    min={0}
                    max={1}
                    step={0.01}
                    disabled={unavailable}
                    aria-label={`${preset.label} expression${unavailable ? ' unavailable' : ''}`}
                    class="universal-face-slider"
                  />
                  <span class="universal-face-range">100%</span>
                </div>
                {#if unavailable && preset.unavailableReason}
                  <div class="universal-face-unavailable-detail">
                    <span>{preset.unavailableReason}</span>
                    {#if value > 0}
                      <Button type="button" variant="ghost" size="xs" onclick={() => onPresetChange(preset.value, 0)}>
                        Remove saved weight
                      </Button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </Collapsible.Content>
        </Collapsible.Root>
      {/if}

      {#each matchingSections as section (section.id)}
        {@const sectionOpen = isSectionOpen(section.id)}
        {@const activeCount = changedControlCount(section)}
        <Collapsible.Root open={sectionOpen} class="goon-level-3-accordion">
          <button
            type="button"
            class="goon-level-3-accordion-header"
            aria-expanded={sectionOpen}
            onclick={() => toggleSection(section.id)}
          >
            <span class="goon-level-3-accordion-title">{section.label}</span>
            <span class="universal-face-section-meta">
              {#if activeCount > 0}<span>{activeCount} active</span>{/if}
              <ChevronDown class="universal-face-chevron" data-open={sectionOpen} />
            </span>
          </button>
          <Collapsible.Content class="goon-level-3-accordion-content">
            {#each section.controls as control (control.id)}
              {@const value = getControlValue(control)}
              {@const lockGroup = control.lockGroup ?? ''}
              {@const showLockToggle = Boolean(lockGroup) && Boolean(onToggleGroupLock) && isFirstLockControl(section.controls, lockGroup, control.id)}
              {@const groupLocked = lockGroup ? isGroupLocked(lockGroup) : false}
              <div class="universal-face-field">
                <div class="universal-face-row-between">
                  <span class="universal-face-label">
                    {control.label}
                    {#if showLockToggle}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="universal-face-lock"
                        title={groupLocked ? 'Linked together' : 'Adjust separately'}
                        onclick={() => onToggleGroupLock?.(lockGroup, !groupLocked)}
                      >
                        {#if groupLocked}<Link2 aria-hidden="true" /> Linked{:else}<Unlink2 aria-hidden="true" /> Separate{/if}
                      </Button>
                    {/if}
                  </span>
                  <span class="universal-face-value">{formatValue(control, value)}</span>
                </div>
                <div class="universal-face-slider-row">
                  <span class="universal-face-range universal-face-range-left">{control.negativeLabel}</span>
                  <Slider
                    type="single"
                    value={value}
                    onValueChange={(nextValue: number | number[]) =>
                      onControlChange(control, normalizeSliderValue(nextValue))}
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    fillFrom={control.bipolar ? 0 : control.min}
                    showAnchorMarker={control.bipolar}
                    thumbShape={control.bipolar ? 'round' : 'bar'}
                    aria-label={control.label}
                    class="universal-face-slider"
                  />
                  <span class="universal-face-range">{control.positiveLabel}</span>
                </div>
              </div>
            {/each}
          </Collapsible.Content>
        </Collapsible.Root>
      {/each}
    </div>
  {/if}
</div>

<style>
  .universal-face-editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .universal-face-toolbar,
  .universal-face-search,
  .universal-face-row-between,
  .universal-face-slider-row,
  .universal-face-section-meta,
  .universal-face-label,
  .universal-face-unavailable-detail {
    display: flex;
    align-items: center;
  }

  .universal-face-toolbar,
  .universal-face-row-between,
  .universal-face-unavailable-detail {
    justify-content: space-between;
  }

  .universal-face-toolbar {
    gap: 8px;
  }

  .universal-face-search {
    position: relative;
    flex: 1 1 0;
  }

  .universal-face-search > :global(svg) {
    position: absolute;
    left: 10px;
    z-index: 1;
    width: 14px;
    height: 14px;
    color: var(--muted-foreground);
    pointer-events: none;
  }

  .universal-face-search :global(input) {
    padding-left: 32px;
  }

  .universal-face-section-meta {
    gap: 8px;
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  :global(.universal-face-chevron) {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    transition: transform 0.16s ease;
  }

  :global(.universal-face-chevron[data-open='true']) {
    transform: rotate(180deg);
  }

  .universal-face-help,
  .universal-face-empty,
  .universal-face-unavailable-detail {
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    line-height: 1.45;
  }

  .universal-face-help {
    margin: 0 0 4px;
  }

  .universal-face-empty {
    border: 1px dashed var(--border);
    border-radius: 6px;
    padding: 14px;
    text-align: center;
  }

  .universal-face-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .universal-face-field + .universal-face-field {
    margin-top: 8px;
  }

  .universal-face-field[data-unavailable='true'] {
    opacity: 0.72;
  }

  .universal-face-row-between,
  .universal-face-slider-row,
  .universal-face-label {
    gap: 8px;
  }

  .universal-face-label,
  .universal-face-value,
  .universal-face-range {
    color: var(--muted-foreground);
  }

  .universal-face-label {
    font-size: 0.75rem;
  }

  .universal-face-value,
  .universal-face-range,
  :global(.universal-face-lock) {
    font-size: 0.625rem;
  }

  .universal-face-value {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .universal-face-range {
    width: 3.75rem;
    flex-shrink: 0;
  }

  .universal-face-range-left {
    text-align: right;
  }

  :global(.universal-face-slider) {
    flex: 1 1 0;
  }

  .universal-face-badge {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 5px;
    font-size: 0.5625rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    line-height: 1;
    text-transform: uppercase;
  }

  .universal-face-unavailable-detail {
    gap: 8px;
    padding-left: 3rem;
  }

  :global(.universal-face-lock) {
    height: 20px;
    color: var(--muted-foreground);
  }

  :global(.universal-face-lock svg) {
    width: 12px;
    height: 12px;
  }

  @media (max-width: 640px) {
    .universal-face-toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .universal-face-range {
      width: 2.9rem;
      font-size: 0.5625rem;
    }
  }
</style>
