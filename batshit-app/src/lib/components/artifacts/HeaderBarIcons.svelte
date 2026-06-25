<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import ArtifactSourceBadge from '$lib/components/artifacts/ArtifactSourceBadge.svelte'
  import { getArtifactIframeSandbox } from '$lib/artifacts/artifactIframeSandbox'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { DEFAULT_ARTIFACT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import { onMount } from 'svelte'
  import {
    Menu,
    ExternalLink,
    Edit3,
    RefreshCw
  } from '@lucide/svelte'
  import { dndzone, type DndEvent } from 'svelte-dnd-action'
  import {
    artifactOrderChanged,
    getArtifactHydrationKey,
    hydrateArtifactOrder,
    mergeVisibleDndItems,
    realArtifactIds
  } from '$lib/artifacts/artifactZoneOrder'

  // Props
  let {
    artifacts = [],
    onOpenOverlay = (artifact: any) => {}
  } = $props<{
    artifacts?: any[]
    onOpenOverlay?: (artifact: any) => void
  }>()

  const MAX_TRIGGER_ITEMS = 6
  let dropdownOpen = $state(false)
  let activeTriggerId = $state<string | null>(null)
  let allowDropdownClose = $state(false)
  let triggerIframeKey = $state(0)

  const mapLegacyZone = (legacy?: string | null) => {
    switch (legacy) {
      case 'header-icon':
        return 'header'
      case 'header-dropdown':
        return 'trigger'
      default:
        return null
    }
  }

  const resolveZone = (artifact: any) => artifact?.zone || mapLegacyZone(artifact?.widget_position)

  // Filter artifacts by placement type
  const headerIconArtifacts = $derived(artifacts.filter((a: any) => resolveZone(a) === 'header'))
  const dropdownArtifacts = $derived(artifacts.filter((a: any) => resolveZone(a) === 'trigger'))
  const visibleTriggerArtifacts = $derived(dropdownArtifacts.slice(0, MAX_TRIGGER_ITEMS))
  const extraTriggerCount = $derived(Math.max(dropdownArtifacts.length - MAX_TRIGGER_ITEMS, 0))
  const activeTriggerArtifact = $derived(
    dropdownArtifacts.find((a: any) => a.id === activeTriggerId) || null
  )

  $effect(() => {
    if (!dropdownOpen) {
      activeTriggerId = null
    }
  })

  function requestClose() {
    allowDropdownClose = true
    dropdownOpen = false
  }

  function getArtifactLabel(artifact: any, fallback = 'Untitled widget') {
    const raw = typeof artifact?.name === 'string' ? artifact.name.trim() : ''
    return raw || fallback
  }

  function getArtifactIconRef(artifact: any) {
    return normalizeIconRef(artifact?.icon_ref ?? artifact?.icon, DEFAULT_ARTIFACT_ICON_REF)
  }

  let headerItems = $state<any[]>([])
  let headerDragging = $state(false)

  function hydrateHeaderFromArtifacts(preferredIds?: string[]) {
    const next = hydrateArtifactOrder(headerIconArtifacts, headerItems, preferredIds)
    if (!artifactOrderChanged(headerItems, next)) return
    headerItems = next
  }

  async function loadPersistedHeaderOrder() {
    try {
      const res = await fetch('/api/artifacts/order?zone=header')
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data?.order)) {
          hydrateHeaderFromArtifacts([...data.order])
        }
      }
    } catch (err) {
      console.warn('Failed to load header order', err)
    } finally {
      hydrateHeaderFromArtifacts()
    }
  }

  async function persistHeaderOrder(next: string[]) {
    try {
      await fetch('/api/artifacts/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone: 'header', order: [...next] })
      })
    } catch (err) {
      console.warn('Failed to persist header order', err)
    }
  }

  onMount(() => {
    loadPersistedHeaderOrder()
  })

  function updateHeaderOrderFromArtifacts() {
    hydrateHeaderFromArtifacts()
  }
  $effect(() => {
    // Track display/runtime fields too, not just IDs, so Settings edits refresh without reload.
    artifacts.map(getArtifactHydrationKey).join('|')
    if (headerDragging) return
    updateHeaderOrderFromArtifacts()
  })

  const orderedHeaderIcons = $derived.by<any[]>(() => headerItems)

</script>

<!-- Header bar icons container -->
<div class="artifact-header-icons">
  <!-- Individual header icon artifacts (max 6 visible) -->
  <div
    class="artifact-header-icons-list"
    use:dndzone={{
      items: headerItems.slice(0, 6),
      flipDurationMs: 150,
      dropFromOthersDisabled: true,
      type: 'artifact-header-icons'
    }}
    onconsider={(e: CustomEvent<DndEvent>) => {
      headerDragging = true
      headerItems = mergeVisibleDndItems(headerItems, e.detail.items as any[])
    }}
    onfinalize={(e: CustomEvent<DndEvent>) => {
      headerDragging = false
      const mergedItems = mergeVisibleDndItems(headerItems, e.detail.items as any[])
      headerItems = mergedItems
      persistHeaderOrder(realArtifactIds(mergedItems))
    }}
  >
    {#each orderedHeaderIcons.slice(0, 6) as artifact (artifact.isDndShadowItem ? `${artifact.id}-shadow` : artifact.id)}
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Open header widget ${getArtifactLabel(artifact)}`}
        title={`Open header widget ${getArtifactLabel(artifact)}`}
        class={
          artifact.isDndShadowItem
            ? 'artifact-header-icon-button is-dnd-shadow'
            : artifact.mode === 'published'
              ? 'artifact-header-icon-button'
              : 'artifact-header-icon-button is-draft'
        }
        onclick={() => onOpenOverlay(artifact)}
        data-id={artifact.id}
      >
        <IconRenderer
          ref={getArtifactIconRef(artifact)}
          label={getArtifactLabel(artifact)}
          iconClass="artifact-header-icon"
        />
        <ArtifactSourceBadge artifact={artifact} class="artifact-header-icon-source-badge" />
      </Button>
    {/each}
  </div>

  <!-- Dropdown menu for trigger-zone artifacts -->
  {#if dropdownArtifacts.length > 0}
    <DropdownMenu.Root
      bind:open={dropdownOpen}
      onOpenChange={(open) => {
        // Prevent outside clicks from closing; only explicit actions may close
        if (!open && !allowDropdownClose) {
          dropdownOpen = true
          return
        }
        allowDropdownClose = false
        dropdownOpen = open
      }}
    >
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <DropdownMenu.Trigger
              {...props}
              class="artifact-widget-menu-trigger"
              aria-label="Open widget menu"
              title="Open widget menu"
              data-testid="artifact-widget-menu-button"
              data-ab-control="artifact-widget-menu"
            >
              <Menu class="artifact-header-icon" />
              <span class="artifact-header-icons-screen-reader">Open widget menu</span>
            </DropdownMenu.Trigger>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          <p>Widget Menu</p>
        </Tooltip.Content>
      </Tooltip.Root>
      
      <DropdownMenu.Content
        align="end"
        class="artifact-widget-menu-content"
      >
        <div class="artifact-widget-menu-shell">
          <div class="artifact-widget-menu-header">
            <DropdownMenu.Label>Trigger Widgets</DropdownMenu.Label>
            <Button variant="ghost" size="sm" onclick={requestClose}>
              Close
            </Button>
          </div>
          <DropdownMenu.Separator />
          <div class="artifact-widget-menu-list">
            {#each visibleTriggerArtifacts as artifact (artifact.id)}
              {@const isOpen = activeTriggerId === artifact.id}
              <!-- Accordion header bar -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class={`artifact-widget-menu-row ${isOpen ? 'is-open' : ''}`}
                onclick={() => {
                  activeTriggerId = isOpen ? null : artifact.id
                  triggerIframeKey++
                }}
              >
                <span class="artifact-widget-menu-icon-wrap">
                  <IconRenderer
                    ref={getArtifactIconRef(artifact)}
                    label={getArtifactLabel(artifact)}
                    iconClass="artifact-widget-menu-icon"
                  />
                </span>
                <span class="artifact-widget-menu-title">{artifact.name}</span>
                <ArtifactSourceBadge artifact={artifact} showLabel size="sm" />
                {#if artifact.mode !== 'published'}
                  <span class="artifact-widget-menu-draft">Draft</span>
                {/if}
                <!-- Action icons -->
                <div class="artifact-widget-menu-actions">
                  <Button
                    variant="ghost"
                    size="icon"
                    class="artifact-widget-menu-action"
                    aria-label={`Edit widget ${getArtifactLabel(artifact)} in settings`}
                    title={`Edit ${getArtifactLabel(artifact)} in Settings`}
                    onclick={(event: MouseEvent) => {
                      event.stopPropagation()
                      requestClose()
                      window.dispatchEvent(new CustomEvent('batshit:open-settings', {
                        detail: { tab: 'artifacts', artifactId: artifact.id }
                      }))
                    }}
                  >
                    <Edit3 class="artifact-widget-menu-action-icon" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="artifact-widget-menu-action"
                    aria-label={`Refresh widget ${getArtifactLabel(artifact)}`}
                    title={`Refresh ${getArtifactLabel(artifact)}`}
                    onclick={(event: MouseEvent) => {
                      event.stopPropagation()
                      if (isOpen) triggerIframeKey++
                    }}
                  >
                    <RefreshCw class="artifact-widget-menu-action-icon" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="artifact-widget-menu-action"
                    aria-label={`Open widget ${getArtifactLabel(artifact)} overlay`}
                    title={`Open overlay for ${getArtifactLabel(artifact)}`}
                    onclick={(event: MouseEvent) => {
                      event.stopPropagation()
                      requestClose()
                      onOpenOverlay(artifact)
                    }}
                  >
                    <ExternalLink class="artifact-widget-menu-action-icon" />
                  </Button>
                </div>
              </div>
              <!-- Accordion content (iframe preview) -->
              {#if isOpen}
                <div class="artifact-widget-menu-preview-pad">
                  <div class="artifact-widget-menu-preview-frame">
                    {#key triggerIframeKey}
                      <iframe
                        src={`/artifact/${encodeURIComponent(artifact.id)}?refresh=${encodeURIComponent(String(triggerIframeKey))}`}
                        title={artifact.name}
                        class="artifact-widget-menu-preview"
                        sandbox={getArtifactIframeSandbox(artifact)}
                      ></iframe>
                    {/key}
                  </div>
                </div>
              {/if}
            {/each}

            {#if extraTriggerCount > 0}
              <div class="artifact-widget-menu-extra">
                +{extraTriggerCount} more (open Settings to access all)
              </div>
            {/if}
          </div>
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
</div>

<style>
  .artifact-header-icons,
  .artifact-header-icons-list {
    display: flex;
    align-items: center;
    height: var(--app-header-height);
    gap: 0;
  }

  :global(.artifact-header-icon-button),
  :global(.artifact-widget-menu-trigger) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: var(--app-header-height);
    border-radius: 0;
  }

  :global(.artifact-header-icon-button.bs-button-size-icon) {
    width: 40px;
    height: var(--app-header-height);
    border-radius: 0;
  }

  :global(.artifact-header-icon-button.is-draft) {
    border: 1px solid color-mix(in oklab, #f59e0b 70%, transparent);
    background: color-mix(in oklab, #f59e0b 10%, transparent);
    color: #b45309;
  }

  :global(.artifact-header-icon-button.is-dnd-shadow) {
    pointer-events: none;
    opacity: 0;
  }

  :global(.artifact-widget-menu-trigger) {
    border: 0;
    background: transparent;
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 500;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  :global(.artifact-widget-menu-trigger:hover) {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  :global(.artifact-widget-menu-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px var(--ring);
  }

  :global(.artifact-header-icon),
  :global(.artifact-widget-menu-icon) {
    width: 16px;
    height: 16px;
  }

  :global(.artifact-header-icon-source-badge) {
    position: absolute;
    right: 8px;
    bottom: 8px;
  }

  .artifact-header-icons-screen-reader {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  :global(.artifact-widget-menu-content) {
    width: 420px;
    max-height: 520px;
    overflow: hidden;
  }

  .artifact-widget-menu-shell {
    padding: 0 0.25rem 0.25rem;
  }

  .artifact-widget-menu-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.5rem 0.25rem;
  }

  .artifact-widget-menu-list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    max-height: 460px;
    overflow-y: auto;
    padding: 0.25rem 0;
  }

  .artifact-widget-menu-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: background-color 150ms ease-out;
  }

  .artifact-widget-menu-row:hover {
    background: color-mix(in oklab, var(--accent) 50%, transparent);
  }

  .artifact-widget-menu-row.is-open {
    background: var(--accent);
  }

  .artifact-widget-menu-icon-wrap {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }

  :global(.artifact-widget-menu-source-badge) {
    position: absolute;
    right: -4px;
    bottom: -4px;
  }

  .artifact-widget-menu-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .artifact-widget-menu-draft {
    flex-shrink: 0;
    color: #d97706;
    font-size: 0.625rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .artifact-widget-menu-actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.125rem;
  }

  :global(.artifact-widget-menu-action) {
    width: 28px;
    height: 28px;
  }

  :global(.artifact-widget-menu-action-icon) {
    width: 14px;
    height: 14px;
  }

  .artifact-widget-menu-preview-pad {
    padding: 0 0.5rem 0.5rem;
  }

  .artifact-widget-menu-preview-frame {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--background);
  }

  .artifact-widget-menu-preview {
    width: 100%;
    height: 260px;
    border: 0;
  }

  .artifact-widget-menu-extra {
    padding: 0.5rem 0.75rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }
</style>
