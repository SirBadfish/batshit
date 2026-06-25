<script lang="ts">
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import ToolGridIdentityIcon from '$lib/components/tools/ToolGridIdentityIcon.svelte'
  import {
    MAX_ZIP_THRESHOLD,
    normalizeZipBufferInputValue,
    normalizeZipThresholdInputValue
  } from '$lib/utils/zipBufferInput'
  import { Check, ChevronDown, Clock3, Infinity } from '@lucide/svelte'
  import type { IconRef } from '$lib/icons/iconTypes'
  import type {
    SharedNonMcpToolGridRowConfig,
    SharedNonMcpToolGridRowId
  } from '$lib/components/tools/toolGridConfig'

  type AutoZipValue = 'inherit' | 'enabled' | 'disabled' | 'off'

  interface OtherZipRowOverride {
    buffer_size: string
    zip_threshold: string
    auto_zip: AutoZipValue
    inherited_buffer_size: number
    inherited_zip_threshold: number
    inherited_auto_zip: boolean
    inherited_zip_disabled: boolean
    min_buffer: number
  }

  type OtherZipRowPatch = Partial<
    Pick<OtherZipRowOverride, 'buffer_size' | 'zip_threshold' | 'auto_zip'>
  >

  interface Props {
    sectionKey: string
    title: string
    description?: string
    sectionIconRef: IconRef
    typeLabel: string
    rowIds: SharedNonMcpToolGridRowId[]
    rowConfig: Record<SharedNonMcpToolGridRowId, SharedNonMcpToolGridRowConfig>
    open: boolean
    topLevelAccordionRowClass: string
    tableClass: string
    firstColumnClass: string
    otherColumnClass: string
    getRowOverride: (rowId: SharedNonMcpToolGridRowId) => OtherZipRowOverride
    onUpdateRowOverride: (rowId: SharedNonMcpToolGridRowId, patch: OtherZipRowPatch) => void
    onHeaderClick: (event: MouseEvent, sectionKey: string) => void
    onToggle: (sectionKey: string) => void
    showBulkZipApply?: boolean
    bulkZipApplyLabel?: string
    flattenSingleRow?: boolean
  }

  let {
    sectionKey,
    title,
    description,
    sectionIconRef,
    typeLabel,
    rowIds,
    rowConfig,
    open,
    topLevelAccordionRowClass,
    tableClass,
    firstColumnClass,
    otherColumnClass,
    getRowOverride,
    onUpdateRowOverride,
    onHeaderClick,
    onToggle,
    showBulkZipApply = false,
    bulkZipApplyLabel = title,
    flattenSingleRow = false
  }: Props = $props()


  let bulkZipDraft = $state({
    buffer_size: '',
    zip_threshold: ''
  })

  function getZipBehaviorIconMode(
    value: AutoZipValue,
    inheritedAutoZip: boolean,
    inheritedZipDisabled: boolean
  ): 'enabled' | 'disabled' | 'off' {
    if (value === 'off') return 'off'
    if (value === 'enabled') return 'enabled'
    if (value === 'disabled') return 'disabled'
    if (inheritedZipDisabled) return 'off'
    return inheritedAutoZip ? 'enabled' : 'disabled'
  }

  function isEffectiveAutoZipEnabled(
    value: AutoZipValue,
    inheritedAutoZip: boolean,
    inheritedZipDisabled: boolean
  ): boolean {
    if (value === 'off') return false
    if (value === 'enabled') return true
    if (value === 'disabled') return false
    if (inheritedZipDisabled) return false
    return inheritedAutoZip
  }

  function isEffectiveZipDisabled(value: AutoZipValue, inheritedZipDisabled: boolean): boolean {
    if (value === 'off') return true
    if (value === 'inherit') return inheritedZipDisabled
    return false
  }

  function getInheritedZipBehaviorLabel(autoZip: boolean, zipDisabled: boolean): string {
    if (zipDisabled) return 'Off'
    return autoZip ? 'Auto' : 'Normal'
  }

  function getZipBehaviorLabel(
    value: AutoZipValue,
    inheritedAutoZip: boolean,
    inheritedZipDisabled: boolean
  ): string {
    if (value === 'inherit') {
      return `Default (${getInheritedZipBehaviorLabel(inheritedAutoZip, inheritedZipDisabled)})`
    }
    if (value === 'enabled') return 'Auto'
    if (value === 'off') return 'Off'
    return 'Normal'
  }

  function getInheritedNumberLabel(value: number): string {
    return `${value}`
  }

  function iconToneClass(isInherited: boolean): string {
    return isInherited ? 'text-zinc-400' : 'text-white'
  }

  function inheritTriggerClass(isInherited: boolean): string {
    return isInherited ? 'is-inherited' : 'is-explicit'
  }

  function normalizeZipBufferInput(event: Event, minValue: number): string {
    const input = event.currentTarget as HTMLInputElement
    const normalized = normalizeZipBufferInputValue(input.value, minValue)
    if (input.value !== normalized) {
      input.value = normalized
    }
    return normalized
  }

  function getSectionMinBuffer(): number {
    const minValues = rowIds
      .map((rowId) => rowConfig[rowId]?.minBuffer)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return minValues.length > 0 ? Math.min(...minValues) : 2
  }

  function normalizeZipThresholdInput(event: Event): string {
    const input = event.currentTarget as HTMLInputElement
    const normalized = normalizeZipThresholdInputValue(input.value)

    if (input.value !== normalized) {
      input.value = normalized
    }
    return normalized
  }

  function updateBulkZipDraft(patch: Partial<typeof bulkZipDraft>) {
    bulkZipDraft = {
      ...bulkZipDraft,
      ...patch
    }
  }

  function getBulkZipPatch(): OtherZipRowPatch | null {
    const patch: OtherZipRowPatch = {}
    if (bulkZipDraft.buffer_size.trim()) {
      patch.buffer_size = bulkZipDraft.buffer_size
    }
    if (bulkZipDraft.zip_threshold.trim()) {
      patch.zip_threshold = bulkZipDraft.zip_threshold
    }
    return Object.keys(patch).length > 0 ? patch : null
  }

  function canApplyBulkZipDraft(): boolean {
    return getBulkZipPatch() !== null
  }

  function applyBulkZipOverrides() {
    const patch = getBulkZipPatch()
    if (!patch) return

    for (const rowId of rowIds) {
      onUpdateRowOverride(rowId, patch)
    }
  }

  function getOnlyRowId(): SharedNonMcpToolGridRowId {
    return rowIds[0] as SharedNonMcpToolGridRowId
  }
</script>

{#snippet toolRowCells(rowId: SharedNonMcpToolGridRowId, nested: boolean)}
  {@const config = rowConfig[rowId]}
  {@const rowZip = getRowOverride(rowId)}
  {@const rowAutoZipIconMode = getZipBehaviorIconMode(rowZip.auto_zip, rowZip.inherited_auto_zip, rowZip.inherited_zip_disabled)}
  {@const rowAutoZipActive = isEffectiveAutoZipEnabled(rowZip.auto_zip, rowZip.inherited_auto_zip, rowZip.inherited_zip_disabled)}
  {@const rowZipDisabled = isEffectiveZipDisabled(rowZip.auto_zip, rowZip.inherited_zip_disabled)}
  {@const rowZipInputsDisabled = rowAutoZipActive || rowZipDisabled}
  {@const rowZipBehaviorLabel = getZipBehaviorLabel(rowZip.auto_zip, rowZip.inherited_auto_zip, rowZip.inherited_zip_disabled)}
  <td class={`batshit-settings-table-cell is-strong ${nested ? 'is-nested' : ''}`}>
    <div class="batshit-settings-tool-grid-label">
      <ToolGridIdentityIcon
        ref={config.iconRef}
        {typeLabel}
        name={config.label}
      />
      <span class="batshit-settings-tool-grid-name block truncate" title={config.label}>
        {config.label}
      </span>
      {#if config.infoParagraphs?.length}
        <SettingsInfoMenu
          ariaLabel={`About ${config.label}`}
          contentClass="w-80"
        >
          {#each config.infoParagraphs as paragraph, index}
            <p class={index === 0 ? '' : 'mt-2'}>{paragraph}</p>
          {/each}
        </SettingsInfoMenu>
      {/if}
    </div>
  </td>
  <td class="batshit-settings-table-cell"></td>
  <td class="batshit-settings-table-cell"></td>
  <td class="batshit-settings-table-cell">
    <input
      type={rowZipInputsDisabled ? 'text' : 'number'}
      min={String(rowZip.min_buffer)}
      class="batshit-settings-grid-input"
      value={rowZipInputsDisabled ? '-' : rowZip.buffer_size}
      placeholder={rowZipInputsDisabled ? '-' : getInheritedNumberLabel(rowZip.inherited_buffer_size)}
      disabled={rowZipInputsDisabled}
      oninput={(event) =>
        onUpdateRowOverride(rowId, {
          buffer_size: normalizeZipBufferInput(event, rowZip.min_buffer)
        })}
    />
  </td>
  <td class="batshit-settings-table-cell">
    <input
      type={rowZipInputsDisabled ? 'text' : 'number'}
      min="0"
      class="batshit-settings-grid-input"
      value={rowZipInputsDisabled ? '-' : rowZip.zip_threshold}
      placeholder={rowZipInputsDisabled ? '-' : getInheritedNumberLabel(rowZip.inherited_zip_threshold)}
      disabled={rowZipInputsDisabled}
      oninput={(event) =>
        onUpdateRowOverride(rowId, {
          zip_threshold: (event.currentTarget as HTMLInputElement).value
        })}
    />
  </td>
  <td class="batshit-settings-table-cell">
    <Select.Root
      type="single"
      value={rowZip.auto_zip}
      onValueChange={(value) =>
        onUpdateRowOverride(rowId, {
          auto_zip: (value ?? 'inherit') as AutoZipValue
        })}
    >
      <Select.Trigger
        class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(rowZip.auto_zip === 'inherit')}`}
        size="sm"
        title={rowZipBehaviorLabel}
      >
        <span class="inline-flex h-4 w-4 items-center justify-center">
          {#if rowAutoZipIconMode === 'off'}
            <Infinity class={`h-3.5 w-3.5 ${iconToneClass(rowZip.auto_zip === 'inherit')}`} />
          {:else if rowAutoZipIconMode === 'enabled'}
            <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(rowZip.auto_zip === 'inherit')}`} />
          {:else}
            <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(rowZip.auto_zip === 'inherit')}`} />
          {/if}
        </span>
        <span class="sr-only">
          {rowZipBehaviorLabel}
        </span>
      </Select.Trigger>
      <Select.Content>
        <Select.Item
          value="inherit"
          label={getZipBehaviorLabel('inherit', rowZip.inherited_auto_zip, rowZip.inherited_zip_disabled)}
        >
          <span class="flex items-center gap-2">
            <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
              {#if rowAutoZipIconMode === 'off'}
                <Infinity class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
              {:else if rowAutoZipIconMode === 'enabled'}
                <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
              {:else}
                <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
              {/if}
            </span>
            <span>Default ({getInheritedZipBehaviorLabel(rowZip.inherited_auto_zip, rowZip.inherited_zip_disabled)})</span>
          </span>
        </Select.Item>
        <Select.Item value="disabled" label="Normal">
          <span class="flex items-center gap-2">
            <Clock3 class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
            <span>Normal</span>
          </span>
        </Select.Item>
        <Select.Item value="enabled" label="Auto">
          <span class="flex items-center gap-2">
            <BatshitIcon id="zip" class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
            <span>Auto</span>
          </span>
        </Select.Item>
        <Select.Item value="off" label="Off">
          <span class="flex items-center gap-2">
            <Infinity class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
            <span>Off</span>
          </span>
        </Select.Item>
      </Select.Content>
    </Select.Root>
  </td>
{/snippet}

{#if flattenSingleRow && rowIds.length === 1}
  <tr class="batshit-settings-table-row">
    {@render toolRowCells(getOnlyRowId(), false)}
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
      <td class="batshit-settings-table-cell"></td>
      <td class="batshit-settings-table-cell"></td>
      {#if showBulkZipApply}
        <td class="batshit-settings-table-cell">
          <input
            type="number"
            min={String(getSectionMinBuffer())}
            class="batshit-settings-grid-input batshit-settings-tool-grid-bulk-input"
            value={bulkZipDraft.buffer_size}
            placeholder="All"
            aria-label={`Zip buffer to apply to ${bulkZipApplyLabel}`}
            oninput={(event) =>
              updateBulkZipDraft({
                buffer_size: normalizeZipBufferInput(event, getSectionMinBuffer())
              })}
          />
        </td>
        <td class="batshit-settings-table-cell">
          <div class="batshit-settings-tool-grid-bulk-cell">
            <input
              type="number"
              min="0"
              max={String(MAX_ZIP_THRESHOLD)}
              class="batshit-settings-grid-input batshit-settings-tool-grid-bulk-input"
              value={bulkZipDraft.zip_threshold}
              placeholder="All"
              aria-label={`Zip threshold to apply to ${bulkZipApplyLabel}`}
              oninput={(event) =>
                updateBulkZipDraft({
                  zip_threshold: normalizeZipThresholdInput(event)
                })}
            />
            <Button
              variant="outline"
              size="icon"
              class="batshit-settings-tool-grid-bulk-apply"
              disabled={!canApplyBulkZipDraft()}
              aria-label={`Apply zip buffer and threshold to ${bulkZipApplyLabel}`}
              title={`Apply zip buffer and threshold to ${bulkZipApplyLabel}`}
              onclick={applyBulkZipOverrides}
            >
              <Check class="h-3.5 w-3.5" />
            </Button>
          </div>
        </td>
      {:else}
        <td class="batshit-settings-table-cell"></td>
        <td class="batshit-settings-table-cell"></td>
      {/if}
      <td class="batshit-settings-table-cell">
        <div class="batshit-settings-tool-grid-row-actions">
          {#if showBulkZipApply}
            <SettingsInfoMenu
              ariaLabel={`About applying zip numbers to ${bulkZipApplyLabel}`}
              side="left"
              align="end"
              class="batshit-settings-tool-grid-bulk-info"
              contentClass="w-72"
            >
              Enter a Zip Buffer, Zip Threshold, or both, then press the check to copy those
              numbers to every row in this section. Blank fields stay unchanged, and Zip Behavior
              stays unchanged.
            </SettingsInfoMenu>
          {/if}
          <Collapsible.Trigger
            class="ml-auto flex items-center justify-end"
            aria-expanded={open}
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
      <td colspan="6" class="batshit-settings-table-cell is-flush">
        <Collapsible.Content class="overflow-hidden">
          <table class={tableClass}>
            <colgroup>
              <col class={firstColumnClass} />
              <col class={otherColumnClass} />
              <col class={otherColumnClass} />
              <col class={otherColumnClass} />
              <col class={otherColumnClass} />
              <col class={otherColumnClass} />
            </colgroup>
            <tbody>
              {#each rowIds as rowId (rowId)}
                <tr class="batshit-settings-table-row">
                  {@render toolRowCells(rowId, true)}
                </tr>
              {/each}
            </tbody>
          </table>
        </Collapsible.Content>
      </td>
    </tr>
  </Collapsible.Root>
{/if}
