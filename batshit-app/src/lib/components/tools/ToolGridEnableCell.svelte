<script module lang="ts">
  import type { AgentDcmDisplaySettingsSave } from '$lib/utils/agentBlockFieldSettings'
  export interface ToolGridEnableControl {
    checked: boolean
    disabled: boolean
    onChange: (checked: boolean, cliGroupPatch?: AgentDcmDisplaySettingsSave) => void
    /** An explicitly held CLI pair draft has not yet changed the underlying form. */
    draftChecked?: boolean
    notice?: string | null
    onRead?: () => void
    reading?: boolean
  }
</script>
<script lang="ts">
  import * as Switch from '$lib/components/ui/switch'
  import { Button } from '$lib/components/ui/button'
  import { RefreshCcw } from '@lucide/svelte'
  let { control, label }: { control: ToolGridEnableControl; label: string } = $props()
</script>
<td class="batshit-settings-table-cell">
  <div class="flex items-center gap-2">
    <Switch.Root class="shrink-0" checked={control.checked} disabled={control.disabled} aria-label={`Enable ${label}`} data-testid={label === "Typed File Tools" ? "typed-file-tools-enable" : undefined}
      onCheckedChange={(value) => control.onChange(value === true)} />
    {#if control.notice}
      <p class="batshit-settings-caption" role="status">{control.notice}</p>
    {/if}
    {#if control.onRead}
      <Button variant="outline" size="sm" onclick={control.onRead} disabled={control.reading} aria-label={label === "Typed File Tools" ? "Use Saved Choice" : `Read saved ${label} choice`}>
        <RefreshCcw class={control.reading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        <span class="sr-only">Use Saved Choice</span>
      </Button>
    {/if}
  </div>
</td>
