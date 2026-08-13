<script lang="ts">
  /**
   * The two Tool Grid cells a broker family owns: Discoverable and Display Detail.
   *
   * SA-096. Rendered by `BrokerFamilyToolGridRow` on the discoverability-only surfaces
   * and by `NonMcpZipRowsSection` on the `Fabric Controls` / `Artifact Tools` rows inside
   * the `Batshit Tools` accordion. Keeping the markup here is what makes the two
   * placements behave identically instead of drifting into two lookalike controls.
   *
   * Renders exactly two `<td>` elements and must be used inside a `<tr>`.
   */
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import { Signal, SignalMedium, Zap } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import type { BrokerFamilyRowControls } from './brokerFamilyRowControls'

  interface Props {
    controls: BrokerFamilyRowControls
    /** Rendered at the end of the Display Detail cell; used for the row info menu. */
    trailing?: Snippet
    /** Layout of the Display Detail cell. `spread` pushes `trailing` to the far edge. */
    detailLayout?: 'compact' | 'spread'
  }

  let { controls, trailing, detailLayout = 'compact' }: Props = $props()

  const toneClass = $derived(controls.toneClass ?? (() => 'text-white'))
  const triggerClass = $derived(controls.triggerClass ?? (() => ''))
</script>

<td class="batshit-settings-table-cell">
  <Switch.Root
    checked={controls.visible}
    disabled={controls.disabled}
    aria-label={`${controls.label} discoverable`}
    onCheckedChange={(checked) => controls.onVisibleChange(checked === true)}
  />
</td>
<td class="batshit-settings-table-cell">
  <div class={`flex items-center gap-2 ${detailLayout === 'spread' ? 'justify-between' : ''}`}>
    {#if controls.visible}
      <Select.Root
        type="single"
        value={controls.value}
        disabled={controls.disabled}
        onValueChange={(next) => next && controls.onModeChange(next)}
      >
        <Select.Trigger
          class={`batshit-settings-grid-select-trigger ${triggerClass(controls.value)}`}
          size="sm"
          title={controls.modeLabel(controls.value)}
          aria-label={`${controls.label} display detail`}
        >
          <span class="inline-flex h-4 w-4 items-center justify-center">
            {#if controls.iconMode === 'group-only'}
              <Zap class={`h-3.5 w-3.5 ${toneClass(controls.value)}`} />
            {:else if controls.iconMode === 'group+tools+names'}
              <SignalMedium class={`h-3.5 w-3.5 ${toneClass(controls.value)}`} />
            {:else}
              <Signal class={`h-3.5 w-3.5 ${toneClass(controls.value)}`} />
            {/if}
          </span>
          <span class="sr-only">{controls.modeLabel(controls.value)}</span>
        </Select.Trigger>
        <Select.Content>
          {#each controls.options as option (option.value)}
            {@const mode = controls.optionIconMode(option.value)}
            <Select.Item value={option.value} label={option.label}>
              <span class="flex items-center gap-2">
                <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                  {#if mode === 'group-only'}
                    <Zap class={`h-3.5 w-3.5 ${toneClass(option.value)}`} />
                  {:else if mode === 'group+tools+names'}
                    <SignalMedium class={`h-3.5 w-3.5 ${toneClass(option.value)}`} />
                  {:else}
                    <Signal class={`h-3.5 w-3.5 ${toneClass(option.value)}`} />
                  {/if}
                </span>
                <span>{option.label}</span>
              </span>
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
    {#if trailing}
      {@render trailing()}
    {/if}
  </div>
</td>
