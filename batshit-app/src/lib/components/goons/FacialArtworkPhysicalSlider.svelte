<script lang="ts">
  import { Slider } from '$lib/components/ui/slider'

  type Props = {
    id: string
    label: string
    description?: string
    value: number
    range: [number, number]
    step: number
    disabled?: boolean
    onChange: (value: number) => void
  }

  let {
    id,
    label,
    description = '',
    value,
    range,
    step,
    disabled = false,
    onChange
  }: Props = $props()

  const helpId = $derived(description ? `${id}-help` : undefined)

  function normalizeSliderValue(nextValue: number | number[]): number {
    return typeof nextValue === 'number' ? nextValue : nextValue[0] ?? 0
  }

  function formatValue(nextValue: number): string {
    const decimals = step >= 1 ? 0 : Math.min(3, Math.max(1, Math.ceil(-Math.log10(step))))
    return nextValue.toFixed(decimals)
  }
</script>

<div class="facial-artwork-physical-slider">
  <div class="facial-artwork-physical-heading">
    <div class="facial-artwork-physical-copy">
      <label for={id}>{label}</label>
      {#if description}
        <span id={helpId}>{description}</span>
      {/if}
    </div>
    <output for={id}>{formatValue(value)}</output>
  </div>
  <Slider
    {id}
    type="single"
    {value}
    min={range[0]}
    max={range[1]}
    {step}
    fillFrom={0}
    showAnchorMarker={range[0] < 0 && range[1] > 0}
    aria-label={label}
    aria-describedby={helpId}
    aria-valuetext={formatValue(value)}
    {disabled}
    onValueChange={(nextValue: number | number[]) => onChange(normalizeSliderValue(nextValue))}
  />
</div>

<style>
  .facial-artwork-physical-slider,
  .facial-artwork-physical-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .facial-artwork-physical-slider {
    gap: 6px;
  }

  .facial-artwork-physical-heading {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  .facial-artwork-physical-copy {
    gap: 2px;
  }

  .facial-artwork-physical-copy label {
    color: var(--foreground);
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .facial-artwork-physical-copy span {
    max-width: 65ch;
    color: var(--muted-foreground);
    font-size: 0.59375rem;
    line-height: 1.4;
  }

  .facial-artwork-physical-heading output {
    flex-shrink: 0;
    color: var(--muted-foreground);
    font-size: 0.65rem;
    font-variant-numeric: tabular-nums;
  }
</style>
