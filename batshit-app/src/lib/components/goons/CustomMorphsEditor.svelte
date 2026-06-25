<script lang="ts">
  import { Slider } from '$lib/components/ui/slider'
  import type { CustomMorphDefinition } from '$lib/goons/customMorphs'

  type Props = {
    definitions: CustomMorphDefinition[]
    getValue: (customMorphId: string) => number
    onChange: (customMorphId: string, value: number) => void
  }

  let { definitions, getValue, onChange }: Props = $props()
</script>

{#if definitions.length > 0}
  <details class="custom-morphs-editor">
    <summary class="custom-morphs-summary">
      Custom Morphs
    </summary>
    <div class="custom-morphs-body">
      <div class="custom-morphs-help">
        Curated for this Advanced/Blender Goon. These sliders write to the mapped raw morph targets under the hood.
      </div>
      {#each definitions as customMorph (customMorph.id)}
        <div class="custom-morphs-row">
          <div class="custom-morphs-id-field">
            <div class="custom-morphs-label">Morph</div>
            <div class="custom-morphs-id">
              {customMorph.id}
            </div>
          </div>
          <div class="custom-morphs-weight-field">
            <div class="custom-morphs-value-row">
              <span class="custom-morphs-label">Weight</span>
              <span class="custom-morphs-value">
                {getValue(customMorph.id).toFixed(2)}
              </span>
            </div>
            <Slider
              type="single"
              value={getValue(customMorph.id)}
              onValueChange={(v: number | number[]) =>
                onChange(customMorph.id, typeof v === 'number' ? v : v[0] ?? 0)}
              min={0}
              max={1}
              step={0.05}
              class="custom-morphs-slider"
            />
          </div>
        </div>
      {/each}
    </div>
  </details>
{/if}

<style>
  .custom-morphs-editor {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: oklch(from var(--muted) l c h / 0.1);
    padding: 8px;
  }

  .custom-morphs-summary {
    cursor: pointer;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .custom-morphs-body,
  .custom-morphs-id-field,
  .custom-morphs-weight-field {
    display: flex;
    flex-direction: column;
  }

  .custom-morphs-body {
    gap: 8px;
    margin-top: 8px;
  }

  .custom-morphs-help,
  .custom-morphs-label,
  .custom-morphs-value {
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .custom-morphs-row {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    align-items: end;
    gap: 8px;
  }

  .custom-morphs-id-field {
    grid-column: span 5;
    gap: 4px;
  }

  .custom-morphs-weight-field {
    grid-column: span 7;
    gap: 4px;
  }

  .custom-morphs-id {
    display: flex;
    height: 32px;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--background);
    padding-inline: 8px;
    font-size: 0.75rem;
  }

  .custom-morphs-value-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .custom-morphs-value {
    font-variant-numeric: tabular-nums;
  }

  :global(.custom-morphs-slider) {
    flex: 1 1 0;
  }
</style>
