<script lang="ts">
  import { RotateCcw } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import type { RecipeAuthorizedPreviewControl, RecipePreviewSide } from './types'

  type Props = {
    view: RecipePreviewSide
    authorizedControls?: RecipeAuthorizedPreviewControl[]
    disabled?: boolean
    onViewChange: (view: RecipePreviewSide) => void
    onControlChange: (id: string, value: number) => void
    onControlCommit?: () => void | Promise<void>
    onResetControl?: (id: string) => void
  }

  let {
    view,
    authorizedControls = [],
    disabled = false,
    onViewChange,
    onControlChange,
    onControlCommit,
    onResetControl
  }: Props = $props()

  const safeControls = $derived(
    authorizedControls.filter(
      (control) =>
        control.authorization === 'server-verified' &&
        (control.classification === 'new' || control.classification === 'reset-required')
    )
  )

  function normalizeSliderValue(value: number | number[]): number {
    return typeof value === 'number' ? value : value[0] ?? 0
  }

  function formatValue(value: number, step: number, unit?: string | null): string {
    const decimals = step >= 1 ? 0 : Math.min(6, Math.max(1, Math.ceil(-Math.log10(step))))
    const formatted = value.toFixed(decimals)
    return unit ? `${formatted} ${unit}` : formatted
  }
</script>

<section class="recipe-preview-controls space-y-3" aria-labelledby="recipe-preview-title">
  <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
    <div class="min-w-0">
      <h3 id="recipe-preview-title" class="batshit-settings-section-title">Update Preview</h3>
      <p class="batshit-settings-caption mt-1">
        Current and Updated use the same preview engine, camera, pose, lighting, animation time, and expression.
      </p>
    </div>
    <div class="recipe-preview-toggle" role="group" aria-label="Preview version">
      <Button
        size="sm"
        variant={view === 'current' ? 'secondary' : 'outline'}
        aria-pressed={view === 'current'}
        disabled={disabled}
        onclick={() => onViewChange('current')}
      >
        Current
      </Button>
      <Button
        size="sm"
        variant={view === 'updated' ? 'secondary' : 'outline'}
        aria-pressed={view === 'updated'}
        disabled={disabled}
        onclick={() => onViewChange('updated')}
      >
        Updated
      </Button>
    </div>
  </div>

  {#if view === 'current'}
    <div class="batshit-settings-empty-state min-h-0 py-5">
      Updated-side adjustments become available after you switch to Updated.
    </div>
  {:else if safeControls.length === 0}
    <div class="batshit-settings-empty-state min-h-0 py-5">
      This verified update has no new or reset controls to adjust.
    </div>
  {:else}
    <div class="recipe-preview-control-list" aria-label="Verified Updated-side adjustments">
      {#each safeControls as control (control.id)}
        {@const valueText = formatValue(control.value, control.step, control.unit)}
        <div class="recipe-preview-control">
          <div class="recipe-preview-control-heading">
            <div class="min-w-0">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span class="batshit-settings-form-label break-words">{control.label}</span>
                <Badge variant="outline" class="batshit-settings-child-label">
                  {control.classification === 'new' ? 'New' : 'Reset required'}
                </Badge>
              </div>
              {#if control.description}
                <p class="batshit-settings-caption mt-1 break-words">{control.description}</p>
              {/if}
            </div>
            <div class="recipe-preview-control-value">
              <span class="batshit-settings-code-caption">{valueText}</span>
              {#if onResetControl && Math.abs(control.value - control.neutralValue) >= control.step / 2}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Reset ${control.label} to neutral`}
                  title={`Reset ${control.label} to neutral`}
                  disabled={disabled}
                  onclick={() => onResetControl?.(control.id)}
                >
                  <RotateCcw aria-hidden="true" />
                </Button>
              {/if}
            </div>
          </div>

          <Slider
            type="single"
            value={control.value}
            min={control.minimum}
            max={control.maximum}
            step={control.step}
            fillFrom={control.neutralValue}
            showAnchorMarker={
              control.minimum < control.neutralValue && control.maximum > control.neutralValue
            }
            disabled={disabled}
            aria-label={`${control.label}, Updated preview`}
            aria-valuetext={valueText}
            onValueChange={(nextValue: number | number[]) =>
              onControlChange(control.id, normalizeSliderValue(nextValue))}
            onValueCommit={() => onControlCommit?.()}
          />
          <p class="batshit-settings-caption break-words">{control.reason}</p>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .recipe-preview-toggle {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  .recipe-preview-control-list {
    overflow: hidden;
    border: 1px solid var(--bs-settings-line);
    border-radius: var(--bs-settings-radius-lg);
    background: var(--bs-settings-inset-surface);
  }

  .recipe-preview-control {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.65rem;
    padding: 0.75rem;
  }

  .recipe-preview-control + .recipe-preview-control {
    border-top: 1px solid var(--bs-settings-inner-line);
  }

  .recipe-preview-control-heading {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .recipe-preview-control-value {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
  }

  @media (max-width: 560px) {
    .recipe-preview-toggle,
    .recipe-preview-toggle :global(.bs-button) {
      width: 100%;
    }

    .recipe-preview-toggle :global(.bs-button) {
      flex: 1 1 8rem;
    }
  }
</style>
