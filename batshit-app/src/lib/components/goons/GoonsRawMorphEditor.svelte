<script lang="ts">
  import { ChevronDown, X } from '@lucide/svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import type { GoonRawMorphTarget } from '$lib/types/goons'

  type Props = {
    morphs: GoonRawMorphTarget[]
    targetNames: string[]
    getValue: (target: string) => number
    onRename: (currentTarget: string, nextTarget: string) => void
    onChange: (target: string, value: number) => void
    onRemove: (target: string) => void
    onAdd: () => void
  }

  let { morphs, targetNames, getValue, onRename, onChange, onRemove, onAdd }: Props = $props()

  let open = $state(false)

  function normalizeSliderValue(value: number | number[]): number {
    return typeof value === 'number' ? value : value[0] ?? 0
  }

  function toggleOpen() {
    open = !open
  }

  function handleTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleOpen()
    }
  }

  function stopToggle(event: MouseEvent | KeyboardEvent) {
    event.stopPropagation()
  }
</script>

<Collapsible.Root {open}>
  <div
    role="button"
    tabindex="0"
    class="batshit-goon-raw-morph-trigger"
    aria-expanded={open}
    onclick={toggleOpen}
    onkeydown={handleTriggerKeydown}
  >
    <div class="batshit-goon-raw-morph-title-row">
      <span class="batshit-goon-raw-morph-title">
        Expert Raw Morphs
      </span>
      <div role="presentation" class="batshit-goon-raw-morph-info" onclick={stopToggle} onkeydown={stopToggle}>
        <SettingsInfoMenu ariaLabel="About Expert Raw Morphs" contentClass="batshit-goon-raw-morph-info-content">
          <p>Model-specific. These sliders write directly to raw morph targets on the current avatar.</p>
        </SettingsInfoMenu>
      </div>
    </div>
    <ChevronDown class="batshit-goon-raw-morph-chevron" data-open={open} />
  </div>

  <Collapsible.Content class="batshit-goon-raw-morph-content">
    {#each morphs as rawMorph (rawMorph.target)}
      <div class="batshit-goon-raw-morph-row">
        <div class="batshit-goon-raw-morph-field">
          <div class="batshit-goon-raw-morph-label">Morph</div>
          <Select.Root
            type="single"
            value={rawMorph.target}
            items={targetNames.map((targetName) => ({ value: targetName, label: targetName }))}
            onValueChange={(value: string) => {
              if (value) onRename(rawMorph.target, value)
            }}
          >
            <Select.Trigger class="batshit-goon-raw-morph-select">
              {rawMorph.target}
            </Select.Trigger>
            <Select.Content class="batshit-goon-raw-morph-select-content">
              {#each targetNames as targetName}
                <Select.Item value={targetName}>{targetName}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        <div class="batshit-goon-raw-morph-control-row">
          <div class="batshit-goon-raw-morph-field">
            <div class="batshit-goon-raw-morph-value-row">
              <span class="batshit-goon-raw-morph-label">Weight</span>
              <span class="batshit-goon-raw-morph-value">
                {getValue(rawMorph.target).toFixed(2)}
              </span>
            </div>
            <Slider
              type="single"
              value={getValue(rawMorph.target)}
              onValueChange={(value: number | number[]) =>
                onChange(rawMorph.target, normalizeSliderValue(value))}
              min={0}
              max={1}
              step={0.05}
              class="batshit-goon-raw-morph-slider"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            class="batshit-goon-raw-morph-remove"
            aria-label={`Remove raw morph ${rawMorph.target}`}
            onclick={() => onRemove(rawMorph.target)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
    {/each}

    <div class="batshit-goon-raw-morph-footer">
      <Button variant="outline" size="sm" onclick={onAdd}>
        Add Raw Morph
      </Button>
    </div>
  </Collapsible.Content>
</Collapsible.Root>

<style>
  .batshit-goon-raw-morph-title-row,
  .batshit-goon-raw-morph-info,
  .batshit-goon-raw-morph-value-row,
  .batshit-goon-raw-morph-footer {
    display: flex;
  }

  .batshit-goon-raw-morph-title-row,
  .batshit-goon-raw-morph-value-row {
    align-items: center;
  }

  .batshit-goon-raw-morph-title-row {
    gap: 6px;
  }

  :global(.batshit-goon-raw-morph-info-content) {
    width: 320px;
  }

  .batshit-goon-raw-morph-title {
    color: var(--foreground);
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  :global(.batshit-goon-raw-morph-chevron) {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    transition: transform 0.16s ease;
  }

  :global(.batshit-goon-raw-morph-chevron[data-open="true"]) {
    transform: rotate(180deg);
  }

  :global(.batshit-goon-raw-morph-content),
  .batshit-goon-raw-morph-row,
  .batshit-goon-raw-morph-field {
    display: flex;
    flex-direction: column;
  }

  :global(.batshit-goon-raw-morph-content),
  .batshit-goon-raw-morph-row {
    gap: 8px;
  }

  .batshit-goon-raw-morph-field {
    gap: 4px;
  }

  .batshit-goon-raw-morph-label,
  .batshit-goon-raw-morph-value {
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  :global(.batshit-goon-raw-morph-select-content) {
    max-height: 240px;
  }

  .batshit-goon-raw-morph-control-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 8px;
  }

  .batshit-goon-raw-morph-value-row {
    justify-content: space-between;
    gap: 12px;
  }

  .batshit-goon-raw-morph-value {
    font-variant-numeric: tabular-nums;
  }

  :global(.batshit-goon-raw-morph-slider) {
    width: 100%;
  }

  .batshit-goon-raw-morph-footer {
    justify-content: flex-end;
  }
</style>
