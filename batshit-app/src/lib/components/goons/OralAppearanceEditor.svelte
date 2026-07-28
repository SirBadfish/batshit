<script lang="ts">
  import { Slider } from '$lib/components/ui/slider'
  import GoonsFieldLabel from '$lib/components/goons/GoonsFieldLabel.svelte'
  import FacialArtworkAccordion from '$lib/components/goons/FacialArtworkAccordion.svelte'
  import {
    countChangedOralAppearanceControls,
    createDefaultOralAppearanceState,
    oralAppearanceHexToRgb,
    oralAppearanceRgbToHex,
    updateOralAppearanceColor,
    updateOralAppearanceNumber,
    type OralAppearanceColorControlDefinition,
    type OralAppearanceDefinitionV1,
    type OralAppearanceNumberControlDefinition,
    type OralAppearanceRgb,
    type OralAppearanceStateV1
  } from '$lib/goons/oralAppearance'

  type Props = {
    definition: OralAppearanceDefinitionV1
    valueState: OralAppearanceStateV1
    disabled?: boolean
    onChange: (state: OralAppearanceStateV1) => void
  }

  let { definition, valueState, disabled = false, onChange }: Props = $props()
  let open = $state(false)

  const defaults = $derived(createDefaultOralAppearanceState(definition))
  const changed = $derived(countChangedOralAppearanceControls(definition, valueState) > 0)

  function readColor(id: OralAppearanceColorControlDefinition['id']): OralAppearanceRgb {
    if (id === 'teeth_color') return valueState.teeth.color
    if (id === 'gum_color') return valueState.gums.color
    return valueState.tongue.color
  }

  function readNumber(id: OralAppearanceNumberControlDefinition['id']): number {
    return id === 'teeth_brightness' ? valueState.teeth.brightness : valueState.teeth.shine
  }

  function updateColor(id: OralAppearanceColorControlDefinition['id'], hex: string) {
    const color = oralAppearanceHexToRgb(hex)
    if (!color) return
    onChange(updateOralAppearanceColor(valueState, id, color))
  }

  function updateNumber(id: OralAppearanceNumberControlDefinition['id'], value: number | number[]) {
    const next = typeof value === 'number' ? value : value[0]
    if (typeof next !== 'number') return
    onChange(updateOralAppearanceNumber(valueState, id, next))
  }

  function formatNumber(control: OralAppearanceNumberControlDefinition, value: number) {
    return control.unit === 'multiplier' ? `${value.toFixed(2)}×` : `${Math.round(value * 100)}%`
  }
</script>

<FacialArtworkAccordion
  id="oral-appearance"
  title="Oral Appearance"
  info={[
    'Package-bound color and surface controls for the teeth, gums, and tongue.',
    'These do not alter facial identity, expressions, visemes, or the authored texture detail.'
  ]}
  {open}
  {changed}
  {disabled}
  onToggle={() => (open = !open)}
  onReset={() => onChange(structuredClone(defaults))}
>
  <div class="oral-appearance-controls">
    {#each definition.controls as control (control.id)}
      {#if control.kind === 'color'}
        {@const value = readColor(control.id)}
        <label class="oral-appearance-color-control">
          <GoonsFieldLabel
            label={control.label}
            info={control.description}
            ariaLabel={`About ${control.label}`}
          />
          <span class="oral-appearance-color-value">{oralAppearanceRgbToHex(value)}</span>
          <input
            type="color"
            value={oralAppearanceRgbToHex(value)}
            aria-label={control.label}
            {disabled}
            oninput={(event) =>
              updateColor(control.id, (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
      {:else}
        {@const value = readNumber(control.id)}
        <label class="oral-appearance-slider-control">
          <span>
            <GoonsFieldLabel
              label={control.label}
              info={control.description}
              ariaLabel={`About ${control.label}`}
            />
            <output>{formatNumber(control, value)}</output>
          </span>
          <Slider
            type="single"
            {value}
            min={control.minimum}
            max={control.maximum}
            step={control.step}
            fillFrom={control.default}
            showAnchorMarker={control.minimum < control.default && control.maximum > control.default}
            aria-label={control.label}
            {disabled}
            onValueChange={(next: number | number[]) => updateNumber(control.id, next)}
          />
        </label>
      {/if}
    {/each}
  </div>
</FacialArtworkAccordion>

<style>
  .oral-appearance-controls,
  .oral-appearance-slider-control {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .oral-appearance-controls {
    gap: 12px;
  }

  .oral-appearance-color-control,
  .oral-appearance-slider-control > span {
    display: flex;
    min-width: 0;
    align-items: center;
  }

  .oral-appearance-color-control {
    gap: 8px;
  }

  .oral-appearance-color-control :global(.batshit-goons-field-label),
  .oral-appearance-slider-control :global(.batshit-goons-field-label) {
    min-width: 0;
    flex: 1;
  }

  .oral-appearance-color-value,
  .oral-appearance-slider-control output {
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }

  .oral-appearance-color-control input[type='color'] {
    width: 30px;
    height: 24px;
    flex-shrink: 0;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--background);
    cursor: pointer;
  }

  .oral-appearance-color-control input[type='color']:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .oral-appearance-slider-control {
    gap: 7px;
  }

  .oral-appearance-slider-control > span {
    justify-content: space-between;
    gap: 8px;
  }
</style>
