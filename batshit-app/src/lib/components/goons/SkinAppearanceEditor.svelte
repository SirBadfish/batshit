<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import GoonsFieldLabel from './GoonsFieldLabel.svelte'
  import {
    skinAppearanceHexToRgb,
    skinAppearanceRgbToHex,
    updateSkinAppearanceRegion,
    type SkinAppearanceDefinitionV1,
    type SkinAppearanceCheekMode,
    type SkinAppearanceRegionId,
    type SkinAppearanceStateV2
  } from '$lib/goons/skinAppearance'

  type Props = {
    definition: SkinAppearanceDefinitionV1
    valueState: SkinAppearanceStateV2
    regionId: SkinAppearanceRegionId
    disabled?: boolean
    onChange: (state: SkinAppearanceStateV2) => void
  }

  let {
    definition,
    valueState,
    regionId,
    disabled = false,
    onChange
  }: Props = $props()

  const control = $derived(
    definition.controls.find((candidate) => candidate.id === regionId)!
  )
  const region = $derived(valueState.regions[regionId])
  const modeOptions = $derived(
    control.modes.map((mode) => ({
      value: mode,
      label: mode === 'inherit' ? 'Package' : mode === 'off' ? 'Off' : 'Custom'
    }))
  )
  const modeLabel = $derived(
    modeOptions.find((option) => option.value === region.mode)?.label ?? 'Package'
  )

  function updateMode(mode: string) {
    if (!control.modes.includes(mode as SkinAppearanceCheekMode)) return
    onChange(
      updateSkinAppearanceRegion(definition, valueState, regionId, {
        mode: mode as SkinAppearanceCheekMode
      })
    )
  }

  function updateColor(hex: string) {
    const color = skinAppearanceHexToRgb(hex)
    if (!color) return
    onChange(
      updateSkinAppearanceRegion(definition, valueState, regionId, {
        mode: 'custom',
        color
      })
    )
  }
</script>

<div class="skin-appearance-control">
  <div class="skin-appearance-heading">
    <GoonsFieldLabel
      label={control.label}
      info={control.description}
      ariaLabel={`About ${control.label}`}
    />
    {#if region.mode === 'custom'}
      <span class="skin-appearance-value">{skinAppearanceRgbToHex(region.color)}</span>
    {/if}
  </div>
  <div class="skin-appearance-inputs">
    <Select.Root
      type="single"
      value={region.mode}
      items={modeOptions}
      onValueChange={updateMode}
    >
      <Select.Trigger class="skin-appearance-select" aria-label={`${control.label} mode`} {disabled}>
        {modeLabel}
      </Select.Trigger>
      <Select.Content>
        {#each modeOptions as option (option.value)}
          <Select.Item value={option.value}>{option.label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <input
      type="color"
      value={skinAppearanceRgbToHex(region.color)}
      aria-label={`${control.label} color`}
      disabled={disabled || region.mode !== 'custom'}
      oninput={(event) =>
        updateColor((event.currentTarget as HTMLInputElement).value)}
    />
  </div>
</div>

<style>
  .skin-appearance-control {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 7px;
  }

  .skin-appearance-heading,
  .skin-appearance-inputs {
    display: flex;
    min-width: 0;
    align-items: center;
  }

  .skin-appearance-heading {
    justify-content: space-between;
    gap: 8px;
  }

  .skin-appearance-heading :global(.batshit-goons-field-label) {
    min-width: 0;
    flex: 1;
  }

  .skin-appearance-value {
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
    text-transform: uppercase;
  }

  .skin-appearance-inputs {
    gap: 8px;
  }

  .skin-appearance-inputs :global(.skin-appearance-select) {
    min-width: 0;
    flex: 1;
  }

  .skin-appearance-inputs input[type='color'] {
    width: 34px;
    height: 30px;
    flex-shrink: 0;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--background);
    cursor: pointer;
  }

  .skin-appearance-inputs input[type='color']:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }
</style>
