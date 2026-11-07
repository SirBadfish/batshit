<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { IconRef } from '$lib/icons/iconTypes'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import ToolGridIdentityIcon from '$lib/components/tools/ToolGridIdentityIcon.svelte'
  import ToolGridEnableCell, { type ToolGridEnableControl } from '$lib/components/tools/ToolGridEnableCell.svelte'
  import { ChevronDown } from '@lucide/svelte'

  let {
    title, iconRef, open, tableClass, firstColumnClass, otherColumnClass, showZipControls = true,
    enableControl = null, onHeaderClick, onToggle, children
  }: {
    title: string
    iconRef: IconRef
    open: boolean
    tableClass: string
    firstColumnClass: string
    otherColumnClass: string
    showZipControls?: boolean
    enableControl?: ToolGridEnableControl | null
    onHeaderClick: (event: MouseEvent) => void
    onToggle: () => void
    children: Snippet
  } = $props()
</script>

<Collapsible.Root {open}>
  <tr class="batshit-settings-accordion-row cursor-pointer" onclick={onHeaderClick}>
    <td class="batshit-settings-table-cell is-strong">
      <div class="batshit-settings-tool-grid-label">
        <ToolGridIdentityIcon ref={iconRef} typeLabel="Tool Group" name={title} />
        <span class="batshit-settings-tool-grid-name block truncate" title={title}>{title}</span>
      </div>
    </td>
    {#if enableControl}
      <ToolGridEnableCell control={enableControl} label={title} />
    {:else}
      <td class="batshit-settings-table-cell"></td>
    {/if}
    {#if showZipControls}
      <td class="batshit-settings-table-cell"></td>
      <td class="batshit-settings-table-cell"></td>
      <td class="batshit-settings-table-cell"></td>
    {/if}
    <td class="batshit-settings-table-cell">
      <Collapsible.Trigger class="ml-auto flex items-center justify-end" aria-label={`Toggle ${title}`} aria-expanded={open} onclick={onToggle}>
        <ChevronDown class={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </Collapsible.Trigger>
    </td>
  </tr>
  <tr class="batshit-settings-table-row is-flush">
    <td colspan={showZipControls ? 6 : 3} class="batshit-settings-table-cell is-flush">
      <Collapsible.Content class="overflow-hidden">
        <table class={tableClass}>
          <colgroup>
            <col class={firstColumnClass} />
            <col class={otherColumnClass} />
            <col class={otherColumnClass} />
            {#if showZipControls}
              <col class={otherColumnClass} />
              <col class={otherColumnClass} />
              <col class={otherColumnClass} />
            {/if}
          </colgroup>
          <tbody>{@render children()}</tbody>
        </table>
      </Collapsible.Content>
    </td>
  </tr>
</Collapsible.Root>
