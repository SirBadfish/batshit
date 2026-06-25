<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte'
  import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { getPrimaryAgentDisplayLabel, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
  import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'

  export interface MegaAgentItem {
    id: string
    displayName: string
    agentType?: 'n8n' | 'api' | 'cli' | 'batshit' | null
    badgeLabel?: string | null
    badgeTone?: 'n8n' | 'api' | 'cli' | 'managed' | null
    avatarUrl?: string | null
    avatarIconRef?: IconRef | null
    avatarIconFit?: AvatarIconFit | null
    defaultModelProvider?: string | null
    defaultModelName?: string | null
    specialty?: string | null
    disabledReason?: string | null
  }

  export interface MegaAgentSection {
    heading: string
    items: MegaAgentItem[]
  }

  interface Props {
    label: string
    items?: MegaAgentItem[]
    sections?: MegaAgentSection[]
    selectedId?: string | null
    placeholder?: string
    emptyState?: string
    disabled?: boolean
    disableUnavailableItems?: boolean
    onSelect?: (id: string) => void
    onOpen?: () => void | Promise<void>
  }

  let {
    label,
    items = [],
    sections = [],
    selectedId = null,
    placeholder = 'Select',
    emptyState = 'No items available',
    disabled = false,
    disableUnavailableItems = true,
    onSelect = undefined,
    onOpen = undefined
  }: Props = $props()

  let open = $state(false)

  const resolvedSections = $derived(
    sections.length > 0 ? sections : [{ heading: label, items }]
  )

  const flattenedItems = $derived(
    resolvedSections.flatMap((section) => section.items)
  )

  const selectedItem = $derived(
    flattenedItems.find((item) => item.id === selectedId) ?? null
  )

  function handleSelect(id: string) {
    if (disabled) return
    const item = flattenedItems.find((candidate) => candidate.id === id)
    if (disableUnavailableItems && item?.disabledReason) return
    open = false
    onSelect?.(id)
  }

  function formatAgentType(type: MegaAgentItem['agentType']) {
    if (type === 'batshit') return 'batshit'
    return getPrimaryAgentDisplayLabel(normalizePrimaryAgentType(undefined, type))
  }

  function resolveBadgeLabel(item: MegaAgentItem): string {
    if (typeof item.badgeLabel === 'string' && item.badgeLabel.trim().length > 0) {
      return item.badgeLabel
    }
    return formatAgentType(item.agentType)
  }

  function badgeClass(item: MegaAgentItem): string {
    const tone =
      item.badgeTone ??
      (item.agentType === 'batshit'
        ? 'api'
        : normalizePrimaryAgentType(undefined, item.agentType))

    return `is-agent-type-${tone === 'managed' ? 'api' : tone}`
  }

  function ensureString(value: string | null | undefined): string {
    return value ?? ''
  }

  function formatModelLabel(item: MegaAgentItem) {
    if (!item.defaultModelName) return 'No Default Model'
    return item.defaultModelProvider
      ? `${item.defaultModelProvider}/${item.defaultModelName}`
      : item.defaultModelName
  }

  function getItemSubtext(item: MegaAgentItem) {
    return item.disabledReason ?? formatModelLabel(item)
  }

  $effect(() => {
    if (disabled && open) {
      open = false
    }
  })

  $effect(() => {
    if (!open) return
    void onOpen?.()
  })
</script>

<div class="w-full max-w-[640px]">
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger
      disabled={disabled}
      class="batshit-settings-selector-trigger flex w-full items-center justify-between gap-4 disabled:cursor-not-allowed disabled:opacity-60"
      aria-label={`Select ${label}`}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-2">
      {#if selectedItem}
        <div class="flex min-w-0 items-center gap-3">
          <EntityAvatar
            avatarUrl={selectedItem.avatarUrl ?? null}
            iconRef={selectedItem.avatarIconRef ?? null}
            iconFit={selectedItem.avatarIconFit ?? 'fill'}
            label={selectedItem.displayName}
            fallback={selectedItem.displayName || 'Agent'}
            class="batshit-settings-avatar-frame h-10 w-10"
          />
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="flex min-w-0 items-start justify-between gap-3">
              <span class="batshit-settings-action-row-title truncate">
              {selectedItem.displayName || 'Unnamed agent'}
              </span>
              <span class={`batshit-settings-agent-type-pill shrink-0 ${badgeClass(selectedItem)}`}>
                {resolveBadgeLabel(selectedItem)}
              </span>
            </div>
            <div class="batshit-settings-caption flex min-w-0 items-center gap-2">
              {#if selectedItem.defaultModelName && !selectedItem.disabledReason}
                <ModelProviderIcon
                  modelId={ensureString(selectedItem.defaultModelName)}
                  modelName={ensureString(selectedItem.defaultModelName)}
                  provider={ensureString(selectedItem.defaultModelProvider) || 'custom'}
                  size="sm"
                />
              {/if}
              <span class="truncate" class:is-unavailable={Boolean(selectedItem.disabledReason)}>
                {getItemSubtext(selectedItem)}
              </span>
            </div>
          </div>
        </div>
      {:else}
        <div class="flex flex-col gap-1">
          <span class="batshit-settings-child-label">
            {label}
          </span>
          <span class="batshit-settings-caption">{placeholder}</span>
        </div>
      {/if}
    </div>

    <ChevronDown class="h-5 w-5 shrink-0 text-muted-foreground" />
    </DropdownMenu.Trigger>

    <DropdownMenu.Content
    side="bottom"
    align="start"
    class="batshit-settings-dropdown-panel z-[var(--z-popover)] w-[640px] max-h-[80vh]"
  >
    <div class="batshit-settings-dropdown-header flex items-center justify-between">
      <div class="flex items-center gap-1.5">
        <h3 class="batshit-settings-form-label">{label}</h3>
        <SettingsInfoMenu ariaLabel="About Agent Selector">
          Select an agent to load its settings panel.
        </SettingsInfoMenu>
      </div>
    </div>

    <div class="batshit-settings-dropdown-body max-h-[calc(80vh-64px)] overflow-y-auto space-y-3">
      {#if flattenedItems.length === 0}
        <div class="batshit-settings-empty-state is-dashed">
          {emptyState}
        </div>
      {:else}
        {#each resolvedSections as section, index (section.heading)}
          {#if index > 0}
            <DropdownMenu.Separator class="mx-0 my-0" />
          {/if}
          <div class="space-y-2">
            <div class="batshit-settings-dropdown-section-label">
              {section.heading}
            </div>
            {#if section.items.length === 0}
              <div class="batshit-settings-inline-alert is-dashed">
                No {section.heading.toLowerCase()} yet.
              </div>
            {:else}
              {#each section.items as item (item.id)}
                {@const isSelected = item.id === selectedItem?.id}
                {@const isItemUnavailable = Boolean(item.disabledReason)}
                {@const isItemDisabled = disableUnavailableItems && isItemUnavailable}
                <button
                  type="button"
                  class={`batshit-settings-option-card w-full ${isSelected ? 'is-selected' : ''} ${isItemDisabled ? 'is-disabled' : ''} ${isItemUnavailable && !isItemDisabled ? 'is-unavailable-card' : ''}`}
                  onclick={() => handleSelect(item.id)}
                  disabled={isItemDisabled}
                  title={item.disabledReason ?? undefined}
                >
                  <div class="flex min-w-0 items-center gap-3">
                    <EntityAvatar
                      avatarUrl={item.avatarUrl ?? null}
                      iconRef={item.avatarIconRef ?? null}
                      iconFit={item.avatarIconFit ?? 'fill'}
                      label={item.displayName}
                      fallback={item.displayName || 'Agent'}
                      class="batshit-settings-avatar-frame h-10 w-10 shrink-0"
                    />

                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                      <div class="flex min-w-0 items-start justify-between gap-3">
                        <span class="batshit-settings-action-row-title truncate">
                          {item.displayName || 'Unnamed agent'}
                        </span>
                        <span class={`batshit-settings-agent-type-pill shrink-0 ${badgeClass(item)}`}>
                          {resolveBadgeLabel(item)}
                        </span>
                      </div>

                      <div class="flex min-w-0 items-center gap-2 text-xs text-foreground/80">
                        {#if item.defaultModelName && !item.disabledReason}
                          <ModelProviderIcon
                            modelId={ensureString(item.defaultModelName)}
                            modelName={ensureString(item.defaultModelName)}
                            provider={ensureString(item.defaultModelProvider) || 'custom'}
                            size="sm"
                          />
                        {/if}
                        <span class="truncate" class:is-unavailable={Boolean(item.disabledReason)}>
                          {getItemSubtext(item)}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        {/each}
      {/if}
    </div>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>

<style>
  :global(.batshit-settings-option-card.is-disabled) {
    cursor: not-allowed;
    opacity: 0.48;
  }

  :global(.batshit-settings-option-card.is-unavailable-card) {
    opacity: 0.58;
  }

  .is-unavailable {
    color: var(--bs-settings-muted-text);
  }
</style>
