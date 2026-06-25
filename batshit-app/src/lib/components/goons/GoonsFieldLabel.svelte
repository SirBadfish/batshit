<script lang="ts">
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { cn } from '$lib/utils'

  type Props = {
    label: string
    info?: string | string[] | null
    ariaLabel?: string
    class?: string
  }

  let { label, info = null, ariaLabel = `About ${label}`, class: className = '' }: Props = $props()

  const infoLines = $derived.by(() => {
    if (!info) return []
    return Array.isArray(info) ? info : [info]
  })
</script>

<div
  class={cn(
    'batshit-settings-form-label batshit-settings-form-label-line batshit-goons-field-label',
    className
  )}
>
  <span>{label}</span>
  {#if infoLines.length > 0}
    <SettingsInfoMenu ariaLabel={ariaLabel} contentClass="batshit-goons-field-label-info">
      {#each infoLines as line}
        <p>{line}</p>
      {/each}
    </SettingsInfoMenu>
  {/if}
</div>

<style>
  :global(.batshit-goons-field-label-info) {
    width: 320px;
  }
</style>
