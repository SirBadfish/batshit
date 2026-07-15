<script lang="ts">
  import * as ToggleGroup from '$lib/components/ui/toggle-group'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import { Slider } from '$lib/components/ui/slider'
  import GoonsFieldLabel from '$lib/components/goons/GoonsFieldLabel.svelte'
  import { cn } from '$lib/utils'
  import { ArrowLeftRight, ArrowUpDown } from '@lucide/svelte'
  import type { EyeAppearanceControlDefinition } from '$lib/goons/eyeAppearance'
  import type {
    GoonEyeContactMode,
    ResolvedGoonEyeContactTuning
  } from '$lib/types/goons'

  type Props = {
    mode: GoonEyeContactMode
    tuning: ResolvedGoonEyeContactTuning
    showMode?: boolean
    modeInfo?: string | string[] | null
    coordinationInfo?: string | string[] | null
    eyeConvergenceControl?: EyeAppearanceControlDefinition | null
    eyeConvergenceValue?: number | null
    class?: string
    onModeChange: (mode: GoonEyeContactMode) => void
    onTuningChange: (patch: Partial<ResolvedGoonEyeContactTuning>) => void
    onEyeConvergenceChange?: ((value: number) => void) | null
  }

  let {
    mode,
    tuning,
    showMode = true,
    modeInfo = null,
    coordinationInfo = null,
    eyeConvergenceControl = null,
    eyeConvergenceValue = null,
    class: className = '',
    onModeChange,
    onTuningChange,
    onEyeConvergenceChange = null
  }: Props = $props()

  const modeOptions: Array<{ value: GoonEyeContactMode; label: string }> = [
    { value: 'bone', label: 'Bone' },
    { value: 'expression', label: 'Expression' }
  ]
  const MULTIPLIER_MIN = 0
  const MULTIPLIER_MAX = 8
  const HEAD_START_MIN = 0
  const HEAD_START_MAX = 90
  const SPEED_MIN = 0.05
  const SPEED_MAX = 3
  const COMPENSATION_MIN = 0
  const COMPENSATION_MAX = 5

  function normalizeSingleSliderValue(value: number | number[], fallback: number) {
    const resolved = Array.isArray(value) ? (value[0] ?? fallback) : value
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : fallback
  }

  function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
  }

  function formatMultiplier(value: number) {
    return `${value.toFixed(2)}x`
  }

  function formatDegrees(value: number, step: number) {
    const digits = step < 1 ? 1 : 0
    return `${value.toFixed(digits)} deg`
  }

  function updateEyeConvergence(value: number | number[]) {
    if (!eyeConvergenceControl || eyeConvergenceValue === null || !onEyeConvergenceChange) return
    onEyeConvergenceChange(
      clamp(
        normalizeSingleSliderValue(value, eyeConvergenceValue),
        eyeConvergenceControl.minimum,
        eyeConvergenceControl.maximum
      )
    )
  }

  function updateNumber(
    key: keyof ResolvedGoonEyeContactTuning,
    value: number | number[],
    min: number,
    max: number
  ) {
    onTuningChange({
      [key]: clamp(normalizeSingleSliderValue(value, tuning[key]), min, max)
    })
  }

  function axisLabel(axis: 'horizontal' | 'vertical') {
    return axis === 'horizontal' ? 'Left/Right' : 'Up/Down'
  }
</script>

{#snippet axisToken(axis: 'horizontal' | 'vertical')}
  <Tooltip.Root>
    <Tooltip.Trigger
      type="button"
      class="goon-eye-axis-token"
      aria-label={axisLabel(axis)}
      title={axisLabel(axis)}
    >
      {#if axis === 'horizontal'}
        <ArrowLeftRight class="goon-eye-axis-icon" />
      {:else}
        <ArrowUpDown class="goon-eye-axis-icon" />
      {/if}
    </Tooltip.Trigger>
    <Tooltip.Content side="top">{axisLabel(axis)}</Tooltip.Content>
  </Tooltip.Root>
{/snippet}

<div class={cn('goon-eye-tuning-editor', className)}>
  {#if showMode}
    <div class="goon-eye-row-between">
      <GoonsFieldLabel label="Mode" info={modeInfo} ariaLabel="About Eye Contact Mode" />
      <ToggleGroup.Root
        type="single"
        value={mode}
        variant="outline"
        size="sm"
        aria-label="Eye contact mode"
        onValueChange={(value: string) => {
          if (!value) return
          onModeChange(value as GoonEyeContactMode)
        }}
      >
        {#each modeOptions as option (option.value)}
          <ToggleGroup.Item value={option.value} class="goon-eye-mode-option">
            {option.label}
          </ToggleGroup.Item>
        {/each}
      </ToggleGroup.Root>
    </div>
  {/if}

  <div class="goon-eye-section">
    <div class="goon-eye-section-title">Eyes</div>
    <div class="goon-eye-grid">
      {#if eyeConvergenceControl && eyeConvergenceValue !== null && onEyeConvergenceChange}
        <div class="goon-eye-slider-field">
          <div class="goon-eye-row-between">
            <GoonsFieldLabel
              label={eyeConvergenceControl.label}
              info={eyeConvergenceControl.description}
              ariaLabel={`About ${eyeConvergenceControl.label}`}
            />
            <span class="goon-eye-slider-value">
              {formatDegrees(eyeConvergenceValue, eyeConvergenceControl.step)}
            </span>
          </div>
          <Slider
            type="single"
            value={eyeConvergenceValue}
            onValueChange={updateEyeConvergence}
            min={eyeConvergenceControl.minimum}
            max={eyeConvergenceControl.maximum}
            step={eyeConvergenceControl.step}
            fillFrom={eyeConvergenceControl.default}
            showAnchorMarker={eyeConvergenceControl.minimum < eyeConvergenceControl.default && eyeConvergenceControl.maximum > eyeConvergenceControl.default}
            aria-label={eyeConvergenceControl.label}
          />
        </div>
      {/if}
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label goon-eye-slider-label-axis">
            Sensitivity {@render axisToken('horizontal')}
          </span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.eyeYawSensitivity)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.eyeYawSensitivity}
          onValueChange={(value: number | number[]) =>
            updateNumber('eyeYawSensitivity', value, MULTIPLIER_MIN, MULTIPLIER_MAX)}
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.05}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label goon-eye-slider-label-axis">
            Range {@render axisToken('horizontal')}
          </span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.eyeYawRange)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.eyeYawRange}
          onValueChange={(value: number | number[]) =>
            updateNumber('eyeYawRange', value, MULTIPLIER_MIN, MULTIPLIER_MAX)}
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.05}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label goon-eye-slider-label-axis">
            Sensitivity {@render axisToken('vertical')}
          </span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.eyePitchSensitivity)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.eyePitchSensitivity}
          onValueChange={(value: number | number[]) =>
            updateNumber('eyePitchSensitivity', value, MULTIPLIER_MIN, MULTIPLIER_MAX)}
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.05}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label goon-eye-slider-label-axis">
            Range {@render axisToken('vertical')}
          </span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.eyePitchRange)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.eyePitchRange}
          onValueChange={(value: number | number[]) =>
            updateNumber('eyePitchRange', value, MULTIPLIER_MIN, MULTIPLIER_MAX)}
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.05}
        />
      </div>
    </div>
  </div>

  <div class="goon-eye-section goon-eye-section-offset">
    <div class="goon-eye-section-title goon-eye-section-title-inline">
      <span>Head</span>
      {@render axisToken('horizontal')}
    </div>
    <div class="goon-eye-grid">
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Head Joins (Out)</span>
          <span class="goon-eye-slider-value">
            {Math.round(tuning.headYawStartOutDeg)} deg
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headYawStartOutDeg}
          onValueChange={(value: number | number[]) =>
            updateNumber('headYawStartOutDeg', value, HEAD_START_MIN, HEAD_START_MAX)}
          min={HEAD_START_MIN}
          max={HEAD_START_MAX}
          step={1}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Return Follow (In)</span>
          <span class="goon-eye-slider-value">
            {Math.round(tuning.headYawStartInDeg)} deg
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headYawStartInDeg}
          onValueChange={(value: number | number[]) =>
            updateNumber('headYawStartInDeg', value, HEAD_START_MIN, HEAD_START_MAX)}
          min={HEAD_START_MIN}
          max={HEAD_START_MAX}
          step={1}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Sensitivity</span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.headYawSensitivity)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headYawSensitivity}
          onValueChange={(value: number | number[]) =>
            updateNumber('headYawSensitivity', value, MULTIPLIER_MIN, MULTIPLIER_MAX)}
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.05}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Range</span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.headYawRange)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headYawRange}
          onValueChange={(value: number | number[]) =>
            updateNumber('headYawRange', value, MULTIPLIER_MIN, MULTIPLIER_MAX)}
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.05}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Response Speed</span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.headYawSpeed)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headYawSpeed}
          onValueChange={(value: number | number[]) => updateNumber('headYawSpeed', value, SPEED_MIN, SPEED_MAX)}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
        />
      </div>
    </div>
  </div>

  <div class="goon-eye-section goon-eye-section-offset">
    <div class="goon-eye-section-title goon-eye-section-title-inline">
      <span>Head</span>
      {@render axisToken('vertical')}
    </div>
    <div class="goon-eye-grid">
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Head Joins (Out)</span>
          <span class="goon-eye-slider-value">
            {Math.round(tuning.headPitchStartOutDeg)} deg
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headPitchStartOutDeg}
          onValueChange={(value: number | number[]) =>
            updateNumber('headPitchStartOutDeg', value, HEAD_START_MIN, HEAD_START_MAX)}
          min={HEAD_START_MIN}
          max={HEAD_START_MAX}
          step={1}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Return Follow (In)</span>
          <span class="goon-eye-slider-value">
            {Math.round(tuning.headPitchStartInDeg)} deg
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headPitchStartInDeg}
          onValueChange={(value: number | number[]) =>
            updateNumber('headPitchStartInDeg', value, HEAD_START_MIN, HEAD_START_MAX)}
          min={HEAD_START_MIN}
          max={HEAD_START_MAX}
          step={1}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Sensitivity</span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.headPitchSensitivity)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headPitchSensitivity}
          onValueChange={(value: number | number[]) =>
            updateNumber('headPitchSensitivity', value, MULTIPLIER_MIN, MULTIPLIER_MAX)}
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.05}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Range</span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.headPitchRange)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headPitchRange}
          onValueChange={(value: number | number[]) =>
            updateNumber('headPitchRange', value, MULTIPLIER_MIN, MULTIPLIER_MAX)}
          min={MULTIPLIER_MIN}
          max={MULTIPLIER_MAX}
          step={0.05}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label">Response Speed</span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.headPitchSpeed)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.headPitchSpeed}
          onValueChange={(value: number | number[]) =>
            updateNumber('headPitchSpeed', value, SPEED_MIN, SPEED_MAX)}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
        />
      </div>
    </div>
  </div>

  <div class="goon-eye-section goon-eye-section-offset">
    <GoonsFieldLabel
      label="Shared Target"
      info={coordinationInfo}
      ariaLabel="About Eye Contact Coordination"
    />
    <div class="goon-eye-grid">
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label goon-eye-slider-label-axis">
            Head Share {@render axisToken('horizontal')}
          </span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.eyeYawHeadCompensation)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.eyeYawHeadCompensation}
          onValueChange={(value: number | number[]) =>
            updateNumber('eyeYawHeadCompensation', value, COMPENSATION_MIN, COMPENSATION_MAX)}
          min={COMPENSATION_MIN}
          max={COMPENSATION_MAX}
          step={0.05}
        />
      </div>
      <div class="goon-eye-slider-field">
        <div class="goon-eye-row-between">
          <span class="goon-eye-slider-label goon-eye-slider-label-axis">
            Head Share {@render axisToken('vertical')}
          </span>
          <span class="goon-eye-slider-value">
            {formatMultiplier(tuning.eyePitchHeadCompensation)}
          </span>
        </div>
        <Slider
          type="single"
          value={tuning.eyePitchHeadCompensation}
          onValueChange={(value: number | number[]) =>
            updateNumber('eyePitchHeadCompensation', value, COMPENSATION_MIN, COMPENSATION_MAX)}
          min={COMPENSATION_MIN}
          max={COMPENSATION_MAX}
          step={0.05}
        />
      </div>
    </div>
  </div>
</div>

<style>
  :global(.goon-eye-axis-token) {
    display: inline-flex;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 1px solid oklch(from var(--border) l c h / 0.7);
    border-radius: 3px;
    background: oklch(from var(--muted) l c h / 0.2);
    color: var(--muted-foreground);
    transition: color 0.16s ease;
  }

  :global(.goon-eye-axis-token:hover) {
    color: var(--foreground);
  }

  :global(.goon-eye-axis-token:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 1px var(--ring);
  }

  .goon-eye-axis-icon {
    width: 12px;
    height: 12px;
  }

  .goon-eye-tuning-editor,
  .goon-eye-section,
  .goon-eye-slider-field {
    display: flex;
    flex-direction: column;
  }

  .goon-eye-tuning-editor {
    gap: 16px;
    padding: 0 12px 12px;
  }

  .goon-eye-section {
    gap: 12px;
  }

  .goon-eye-section-offset {
    padding-top: 6px;
  }

  .goon-eye-row-between,
  .goon-eye-section-title-inline,
  .goon-eye-slider-label-axis {
    display: flex;
    align-items: center;
  }

  .goon-eye-row-between {
    justify-content: space-between;
    gap: 12px;
  }

  :global(.goon-eye-mode-option) {
    flex: 0 0 auto !important;
    min-width: 6.75rem !important;
    padding-inline: 16px !important;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .goon-eye-section-title {
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .goon-eye-section-title-inline,
  .goon-eye-slider-label-axis {
    gap: 6px;
  }

  .goon-eye-grid {
    display: grid;
    column-gap: 24px;
    row-gap: 12px;
  }

  @media (min-width: 768px) {
    .goon-eye-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .goon-eye-slider-field {
    gap: 6px;
  }

  .goon-eye-slider-label,
  .goon-eye-slider-value {
    color: var(--muted-foreground);
  }

  .goon-eye-slider-label {
    font-size: 0.75rem;
  }

  .goon-eye-slider-value {
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }
</style>
