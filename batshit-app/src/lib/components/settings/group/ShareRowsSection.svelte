<script lang="ts">
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Switch from '$lib/components/ui/switch'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import ToolGridIdentityIcon from '$lib/components/tools/ToolGridIdentityIcon.svelte'
  import { ChevronDown } from '@lucide/svelte'
  import type { IconRef } from '$lib/icons/iconTypes'

  interface ShareRow {
    id: string
    label: string
    title?: string
    iconRef?: IconRef | null
    infoParagraphs?: string[]
  }

  interface Props {
    sectionKey: string
    title: string
    description?: string
    sectionIconRef: IconRef
    typeLabel: string
    rows: ShareRow[]
    open: boolean
    topLevelAccordionRowClass: string
    isToolShared: (toolName: string) => boolean
    setToolShared: (toolName: string, shared: boolean) => void
    setManyShared: (toolNames: string[], shared: boolean) => void
    onHeaderClick: (event: MouseEvent, sectionKey: string) => void
    onToggle: (sectionKey: string) => void
    flattenSingleRow?: boolean
  }

  let {
    sectionKey,
    title,
    description,
    sectionIconRef,
    typeLabel,
    rows,
    open,
    topLevelAccordionRowClass,
    isToolShared,
    setToolShared,
    setManyShared,
    onHeaderClick,
    onToggle,
    flattenSingleRow = false
  }: Props = $props()

  const rowIds = $derived(rows.map((row) => row.id))
  const allRowsShared = $derived(
    rowIds.length > 0 && rowIds.every((rowId) => isToolShared(rowId))
  )
</script>

{#if rows.length > 0}
  {#snippet rowLabel(row: ShareRow)}
    <div class="batshit-settings-tool-grid-label">
      {#if row.iconRef}
        <ToolGridIdentityIcon
          ref={row.iconRef}
          {typeLabel}
          name={row.label}
        />
      {/if}
      <span
        class="batshit-settings-tool-grid-name block truncate"
        title={row.title ?? row.label}
      >
        {row.label}
      </span>
      {#if row.infoParagraphs?.length}
        <SettingsInfoMenu
          ariaLabel={`About ${row.label}`}
          contentClass="w-80"
        >
          {#each row.infoParagraphs as paragraph, index}
            <p class={index === 0 ? '' : 'mt-2'}>{paragraph}</p>
          {/each}
        </SettingsInfoMenu>
      {/if}
    </div>
  {/snippet}

  {#if flattenSingleRow && rows.length === 1}
    {@const row = rows[0]}
    <tr class="batshit-settings-table-row">
      <td class="batshit-settings-table-cell is-strong">
        {@render rowLabel(row)}
      </td>
      <td class="batshit-settings-table-cell">
        <Switch.Root
          checked={isToolShared(row.id)}
          onCheckedChange={(checked) => setToolShared(row.id, checked === true)}
        />
      </td>
    </tr>
  {:else}
    <Collapsible.Root {open}>
    <tr
      class={`${topLevelAccordionRowClass} cursor-pointer`}
      onclick={(event) => onHeaderClick(event, sectionKey)}
    >
      <td class="batshit-settings-table-cell is-strong">
        <div class="batshit-settings-tool-grid-label">
          <span class="batshit-settings-tool-grid-section-icon" aria-hidden="true">
            <IconRenderer
              ref={sectionIconRef}
              label={title}
              class="batshit-settings-tool-grid-identity-icon"
              iconClass="h-3.5 w-3.5"
            />
          </span>
          <div class="min-w-0">
            <span class="batshit-settings-tool-grid-name block truncate" title={title}>{title}</span>
            {#if description}
              <span class="block whitespace-normal text-[11px] leading-snug text-zinc-400">
                {description}
              </span>
            {/if}
          </div>
        </div>
      </td>
      <td class="batshit-settings-table-cell">
        <div class="flex items-center justify-between">
          <Switch.Root
            checked={allRowsShared}
            disabled={rowIds.length === 0}
            onCheckedChange={(checked) => setManyShared(rowIds, checked === true)}
          />
          <Collapsible.Trigger
            class="ml-2 flex items-center justify-end"
            aria-expanded={open}
            aria-label={`Toggle ${title} share settings`}
            onclick={() => onToggle(sectionKey)}
          >
            <ChevronDown
              class={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </Collapsible.Trigger>
        </div>
      </td>
    </tr>
    <tr class="batshit-settings-table-row is-flush">
      <td colspan="2" class="batshit-settings-table-cell is-flush">
        <Collapsible.Content class="overflow-hidden">
          <table class="w-full min-w-[520px] table-fixed text-xs">
            <colgroup>
              <col class="w-[420px]" />
              <col class="w-[100px]" />
            </colgroup>
            <tbody>
              {#each rows as row (row.id)}
                <tr class="batshit-settings-table-row">
                  <td class="batshit-settings-table-cell is-muted is-nested">
                    {@render rowLabel(row)}
                  </td>
                  <td class="batshit-settings-table-cell">
                    <Switch.Root
                      checked={isToolShared(row.id)}
                      onCheckedChange={(checked) => setToolShared(row.id, checked === true)}
                    />
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </Collapsible.Content>
      </td>
    </tr>
    </Collapsible.Root>
  {/if}
{/if}
