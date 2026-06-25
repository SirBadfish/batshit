<script lang="ts">
  import { ChevronDown, Link2, Unlink2 } from '@lucide/svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import type { GoonExpressionPreset } from '$lib/types/goons'
  import {
    type BatshitFaceControlId,
    type FaceControlSection,
    formatFaceControlDisplayValue,
    getFaceControlBehaviorGroups,
    getFaceControlFillFrom
  } from '$lib/goons/faceControls'

  type FaceControlsEditorProps = {
    presetOptions?: Array<{ value: GoonExpressionPreset; label: string }>
    getPresetValue?: (preset: GoonExpressionPreset) => number
    onPresetChange?: (preset: GoonExpressionPreset, value: number) => void
    sections: FaceControlSection[]
    getValue: (controlId: BatshitFaceControlId) => number
    onChange: (controlId: BatshitFaceControlId, value: number) => void
    isGroupLocked?: (groupId: string) => boolean
    onToggleGroupLock?: (groupId: string, locked: boolean) => void
  }

  let {
    presetOptions = [],
    getPresetValue = () => 0,
    onPresetChange = () => {},
    sections,
    getValue,
    onChange,
    isGroupLocked = () => false,
    onToggleGroupLock
  }: FaceControlsEditorProps = $props()

  let openSectionId = $state<string | null>(null)

  function normalizeSliderValue(value: number | number[]): number {
    return typeof value === 'number' ? value : value[0] ?? 0
  }

  function normalizePresetSliderValue(value: number | number[]): number {
    const resolved = normalizeSliderValue(value)
    return Math.max(0, Math.min(1, Math.round(resolved * 100) / 100))
  }

  function formatPresetDisplayValue(value: number): string {
    return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
  }

  function isFirstSpecForLockGroup(
    specs: FaceControlSection['specs'],
    groupId: string,
    specId: BatshitFaceControlId
  ): boolean {
    return (specs.find((entry) => entry.lockGroup === groupId)?.id ?? null) === specId
  }

  function isSectionOpen(sectionId: string): boolean {
    return openSectionId === sectionId
  }

  function toggleSection(sectionId: string) {
    openSectionId = openSectionId === sectionId ? null : sectionId
  }
</script>

<div class="goon-level-3-accordion-list">
  {#if presetOptions.length > 0}
    {@const presetsOpen = isSectionOpen('facial-presets')}
    <Collapsible.Root open={presetsOpen} class="goon-level-3-accordion">
      <button
        type="button"
        class="goon-level-3-accordion-header"
        aria-expanded={presetsOpen}
        onclick={() => toggleSection('facial-presets')}
      >
        <span class="goon-level-3-accordion-title">Facial Presets</span>
        <ChevronDown class="goon-face-chevron" data-open={presetsOpen} />
      </button>
      <Collapsible.Content class="goon-level-3-accordion-content">
        {#each presetOptions as preset (preset.value)}
          {@const value = getPresetValue(preset.value)}
          <div class="goon-face-slider-field">
            <div class="goon-face-row-between">
              <span class="goon-face-label">{preset.label}</span>
              <span class="goon-face-value">
                {formatPresetDisplayValue(value)}
              </span>
            </div>
            <div class="goon-face-inline-row">
              <span class="goon-face-range-label goon-face-range-label-left goon-face-range-label-small">0%</span>
              <Slider
                type="single"
                value={value}
                onValueChange={(nextValue: number | number[]) =>
                  onPresetChange(preset.value, normalizePresetSliderValue(nextValue))}
                min={0}
                max={1}
                step={0.01}
                class="goon-face-slider"
              />
              <span class="goon-face-range-label goon-face-range-label-small">100%</span>
            </div>
          </div>
        {/each}
      </Collapsible.Content>
    </Collapsible.Root>
  {/if}

  {#each sections as section (section.id)}
    {@const sectionOpen = isSectionOpen(section.id)}
    <Collapsible.Root open={sectionOpen} class="goon-level-3-accordion">
      <button
        type="button"
        class="goon-level-3-accordion-header"
        aria-expanded={sectionOpen}
        onclick={() => toggleSection(section.id)}
      >
        <span class="goon-level-3-accordion-title">{section.label}</span>
        <ChevronDown class="goon-face-chevron" data-open={sectionOpen} />
      </button>
      <Collapsible.Content class="goon-level-3-accordion-content">
        {#each getFaceControlBehaviorGroups(section) as group, groupIndex (group.id)}
          <div class="goon-face-group" data-offset={groupIndex > 0}>
            {#each group.specs as spec (spec.id)}
              {@const value = getValue(spec.id)}
              {@const lockGroup = spec.lockGroup ?? ''}
              {@const showLockToggle =
                Boolean(lockGroup) &&
                Boolean(onToggleGroupLock) &&
                isFirstSpecForLockGroup(group.specs, lockGroup, spec.id)}
              {@const groupLocked = lockGroup ? isGroupLocked(lockGroup) : false}
              <div class="goon-face-slider-field">
                <div class="goon-face-row-between">
                  <div class="goon-face-inline-row">
                    <span class="goon-face-label">{spec.label}</span>
                    {#if showLockToggle}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="goon-face-lock-button"
                        title={groupLocked ? 'Linked together' : 'Adjust separately'}
                        onclick={() => onToggleGroupLock?.(lockGroup, !groupLocked)}
                      >
                        {#if groupLocked}
                          <Link2 class="goon-face-lock-icon" />
                          Linked
                        {:else}
                          <Unlink2 class="goon-face-lock-icon" />
                          Separate
                        {/if}
                      </Button>
                    {/if}
                  </div>
                  <span class="goon-face-value">
                    {formatFaceControlDisplayValue(spec, value)}
                  </span>
                </div>
                <div class="goon-face-inline-row">
                  {#if spec.negativeLabel}
                    <span class="goon-face-range-label goon-face-range-label-left">
                      {spec.negativeLabel}
                    </span>
                  {/if}
                  <Slider
                    type="single"
                    value={value}
                    onValueChange={(nextValue: number | number[]) =>
                      onChange(spec.id, normalizeSliderValue(nextValue))}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    fillFrom={getFaceControlFillFrom(spec)}
                    showAnchorMarker={spec.bipolar}
                    thumbShape={spec.bipolar ? 'round' : 'bar'}
                    class="goon-face-slider"
                  />
                  {#if spec.positiveLabel}
                    <span class="goon-face-range-label">
                      {spec.positiveLabel}
                    </span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/each}
      </Collapsible.Content>
    </Collapsible.Root>
  {/each}
</div>

<style>
  :global(.goon-face-chevron) {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    transition: transform 0.16s ease;
  }

  :global(.goon-face-chevron[data-open="true"]) {
    transform: rotate(180deg);
  }

  .goon-face-group,
  .goon-face-slider-field {
    display: flex;
    flex-direction: column;
  }

  .goon-face-group {
    gap: 8px;
  }

  .goon-face-group[data-offset="true"] {
    padding-top: 4px;
  }

  .goon-face-slider-field {
    gap: 4px;
  }

  .goon-face-row-between,
  .goon-face-inline-row {
    display: flex;
    align-items: center;
  }

  .goon-face-row-between {
    justify-content: space-between;
    gap: 12px;
  }

  .goon-face-inline-row {
    gap: 8px;
  }

  .goon-face-label,
  .goon-face-value,
  .goon-face-range-label,
  :global(.goon-face-lock-button) {
    color: var(--muted-foreground);
  }

  .goon-face-label {
    font-size: 0.75rem;
  }

  .goon-face-value,
  .goon-face-range-label,
  :global(.goon-face-lock-button) {
    font-size: 0.625rem;
  }

  .goon-face-value {
    font-variant-numeric: tabular-nums;
  }

  .goon-face-range-label {
    width: 3.5rem;
    flex-shrink: 0;
  }

  .goon-face-range-label-small {
    width: 2.5rem;
  }

  .goon-face-range-label-left {
    text-align: right;
  }

  :global(.goon-face-slider) {
    flex: 1 1 0;
  }

  :global(.goon-face-lock-button) {
    height: 20px;
    gap: 4px;
    padding-inline: 6px;
  }

  :global(.goon-face-lock-icon) {
    width: 12px;
    height: 12px;
  }
</style>
