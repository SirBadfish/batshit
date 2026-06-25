<script lang="ts">
  import { AlertCircle, Check, Loader2 } from '@lucide/svelte'

  export type SettingsSaveStatusState = 'idle' | 'saving' | 'saved' | 'error'

  interface Props {
    state?: SettingsSaveStatusState
    error?: string | null
    savingLabel?: string
    savedLabel?: string
    sticky?: boolean
    className?: string
  }

  let {
    state = 'idle',
    error = null,
    savingLabel = 'Saving...',
    savedLabel = 'Saved',
    sticky = true,
    className = ''
  }: Props = $props()

  const visible = $derived(state === 'saving' || state === 'saved' || Boolean(error) || state === 'error')
  const isError = $derived(Boolean(error) || state === 'error')
</script>

{#if visible}
  <div
    class={`batshit-settings-save-status inline-flex max-w-full items-center gap-1.5 self-start ${sticky ? 'sticky top-2 z-[2]' : ''} ${isError ? 'is-error' : state === 'saved' ? 'is-saved' : ''} ${className}`}
  >
    {#if isError}
      <AlertCircle class="h-3.5 w-3.5 shrink-0" />
      <span class="truncate">{error ?? 'Save failed'}</span>
    {:else if state === 'saving'}
      <Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span class="truncate">{savingLabel}</span>
    {:else if state === 'saved'}
      <Check class="h-3.5 w-3.5 shrink-0" />
      <span class="truncate">{savedLabel}</span>
    {/if}
  </div>
{/if}
