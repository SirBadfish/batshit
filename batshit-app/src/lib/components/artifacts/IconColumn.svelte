<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import ArtifactSourceBadge from '$lib/components/artifacts/ArtifactSourceBadge.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { DEFAULT_ARTIFACT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import { onMount } from 'svelte'
  import { dndzone, type DndEvent } from 'svelte-dnd-action'
  import {
    artifactOrderChanged,
    getArtifactHydrationKey,
    hydrateArtifactOrder,
    realArtifactIds
  } from '$lib/artifacts/artifactZoneOrder'
  import { 
    FileText,
    Activity,
    List,
    Sparkles
  } from '@lucide/svelte'
  
  // Props
  let {
    activeArtifactId = $bindable<string | null>(null),
    panelOpen = false,
    artifacts = $bindable([]),
    systemIcons = $bindable<Array<{ id: string, title: string, icon?: string, onClick: () => void }>>([]),
    onSelect = (artifactId: string | null) => {}
  } = $props<{
    activeArtifactId?: string | null
    panelOpen?: boolean
    artifacts?: any[]
    systemIcons?: Array<{ id: string, title: string, icon?: string, onClick: () => void }>
    onSelect?: (tabId: string | null) => void
  }>()
  
  const systemIconMap: Record<string, any> = {
    'file-text': FileText,
    'activity': Activity,
    'list': List,
    'sparkles': Sparkles
  }
  
  function getArtifactIconRef(artifact: any) {
    return normalizeIconRef(artifact?.icon_ref ?? artifact?.icon, DEFAULT_ARTIFACT_ICON_REF)
  }

  function handleSelect(id: string) {
    activeArtifactId = id
    onSelect(id)
  }
  
  let items = $state<any[]>([])
  let isDragging = $state(false)

  function hydrateFromArtifacts(preferredIds?: string[]) {
    const next = hydrateArtifactOrder(artifacts, items, preferredIds)
    if (!artifactOrderChanged(items, next)) return
    items = next
  }

  async function loadPersistedOrder() {
    try {
      const res = await fetch('/api/artifacts/order?zone=panel')
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data?.order)) {
          hydrateFromArtifacts([...data.order])
          return
        }
      }
    } catch (err) {
      console.warn('Failed to load panel order', err)
    } finally {
      hydrateFromArtifacts()
    }
  }

  async function persistOrder(next: string[]) {
    try {
      await fetch('/api/artifacts/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone: 'panel', order: [...next] })
      })
    } catch (err) {
      console.warn('Failed to persist panel order', err)
    }
  }

  onMount(() => {
    loadPersistedOrder()
  })

  // keep items list in sync with available artifacts (outside of drag)
  $effect(() => {
    artifacts.map(getArtifactHydrationKey).join('|')
    if (isDragging) return
    hydrateFromArtifacts()
  })

  function getSystemIcon(icon?: string) {
    if (icon && systemIconMap[icon]) return systemIconMap[icon]
    return FileText
  }

  function getArtifactLabel(artifact: any, fallback = 'Untitled panel widget') {
    const raw = typeof artifact?.name === 'string' ? artifact.name.trim() : ''
    return raw || fallback
  }

  function isArtifactOpen(artifact: any) {
    return Boolean(panelOpen && activeArtifactId === artifact?.id)
  }
</script>

<!-- Icon Column - slim width on far right -->
<div 
  class="artifact-icon-column"
>
  <!-- System icons -->
  {#if systemIcons.length > 0}
    <div class="artifact-icon-column-system">
      {#each systemIcons as sys}
        {@const SysIcon = getSystemIcon(sys.icon)}
        <Tooltip.Root>
          <Tooltip.Trigger
            class="artifact-icon-column-system-button"
            aria-label={sys.title}
            title={sys.title}
            onclick={sys.onClick}
          >
            <SysIcon class="artifact-icon-column-button-icon" />
          </Tooltip.Trigger>
          <Tooltip.Content side="left">
            <p>{sys.title}</p>
          </Tooltip.Content>
        </Tooltip.Root>
      {/each}
    </div>
  {/if}

  <!-- Panel widgets -->
  <div class="artifact-icon-column-list">
    {#if artifacts.length === 0}
      <div class="artifact-icon-column-empty">
      </div>
    {:else}
      <div
        class="artifact-icon-column-stack"
        use:dndzone={{
          items,
          flipDurationMs: 150,
          dragDisabled: false,
          dropFromOthersDisabled: true,
          type: 'artifact-panel-icons'
        }}
        onconsider={(e: CustomEvent<DndEvent>) => {
          isDragging = true
          items = e.detail.items as any[]
        }}
        onfinalize={(e: CustomEvent<DndEvent>) => {
          const nextItems = e.detail.items as any[]
          isDragging = false
          items = nextItems
          persistOrder(realArtifactIds(nextItems))
        }}
      >
        {#each items as artifact (artifact.isDndShadowItem ? `${artifact.id}-shadow` : artifact.id)}
          {@const artifactOpen = isArtifactOpen(artifact)}
          {@const artifactLabel = getArtifactLabel(artifact)}
          <div class="artifact-icon-column-item">
            <Button
              variant={artifactOpen ? 'secondary' : 'ghost'}
              size="icon"
              aria-pressed={artifactOpen}
              aria-label={`${artifactOpen ? 'Close' : 'Open'} panel widget ${artifactLabel}`}
              title={`${artifactOpen ? 'Close' : 'Open'} panel widget ${artifactLabel}`}
              class={`artifact-icon-button ${artifactOpen ? 'is-active' : ''} ${artifact.ai_enabled ? 'is-ai-enabled' : ''} ${artifact.mode !== 'published' ? 'is-not-published' : ''} ${artifact.isDndShadowItem ? 'is-dnd-shadow' : ''}`}
              onclick={() => handleSelect(artifact.id)}
              data-id={artifact.id}
            >
              <IconRenderer
                ref={getArtifactIconRef(artifact)}
                label={artifact.name || 'Artifact'}
                iconClass="artifact-icon-renderer"
              />
              <ArtifactSourceBadge artifact={artifact} class="artifact-icon-source-badge" />
            </Button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .artifact-icon-column {
    position: fixed;
    top: 0;
    right: 0;
    z-index: var(--z-rail);
    display: flex;
    flex-direction: column;
    width: var(--sidebar-width-icon, 3rem);
    height: 100%;
    border-left: 1px solid var(--bs-app-shell-line);
    background: var(--background);
    box-shadow: -2px 0 8px 0 rgba(0, 0, 0, 0.05);
  }

  .artifact-icon-column-system {
    display: flex;
    flex-direction: column;
    margin-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  :global(.artifact-icon-column-system-button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 36px;
    border-radius: 0;
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 500;
    outline: none;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  :global(.artifact-icon-column-system-button:hover) {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  :global(.artifact-icon-column-system-button:focus-visible) {
    border-color: var(--ring);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
  }

  :global(.artifact-icon-column-button-icon),
  :global(.artifact-icon-renderer) {
    width: 16px;
    height: 16px;
  }

  .artifact-icon-column-list {
    flex: 1 1 auto;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .artifact-icon-column-empty {
    padding: 0.75rem;
  }

  .artifact-icon-column-stack {
    display: flex;
    flex-direction: column;
  }

  .artifact-icon-column-item {
    display: flex;
    width: 100%;
  }

  :global(.artifact-icon-button) {
    position: relative;
    width: 100%;
    height: 36px;
    border-radius: 0;
  }

  :global(.artifact-icon-button.bs-button-size-icon) {
    width: 100%;
    height: 36px;
    border-radius: 0;
  }

  :global(.artifact-icon-button.is-ai-enabled) {
    color: oklch(0.69 0.22 292.6);
  }

  :global(.artifact-icon-button.is-not-published) {
    border: 1px solid color-mix(in oklab, #f59e0b 70%, transparent);
    background: color-mix(in oklab, #f59e0b 10%, transparent);
    color: #b45309;
  }

  :global(.artifact-icon-button.is-active) {
    background: color-mix(in oklab, var(--bs-app-primary) 18%, var(--bs-app-inset-surface));
    color: var(--bs-app-title);
    box-shadow:
      inset 0 0 0 1px color-mix(in oklab, var(--bs-app-primary) 56%, transparent),
      0 0 12px color-mix(in oklab, var(--bs-app-primary) 18%, transparent);
  }

  :global(.artifact-icon-button.is-active:hover),
  :global(.artifact-icon-button.is-active:focus-visible) {
    background: color-mix(in oklab, var(--bs-app-primary) 24%, var(--bs-app-inset-surface-hover));
    color: var(--bs-app-title);
  }

  :global(.artifact-icon-button.is-active .artifact-icon-renderer) {
    filter: drop-shadow(0 0 5px color-mix(in oklab, var(--bs-app-primary) 50%, transparent));
  }

  :global(.artifact-icon-button.is-dnd-shadow) {
    pointer-events: none;
    opacity: 0;
  }

  :global(.artifact-icon-source-badge) {
    position: absolute;
    right: 8px;
    bottom: 5px;
  }

  /* Custom scrollbar styling */
  .artifact-icon-column-list::-webkit-scrollbar {
    width: 4px;
  }
  
  .artifact-icon-column-list::-webkit-scrollbar-track {
    background: transparent;
  }
  
  .artifact-icon-column-list::-webkit-scrollbar-thumb {
    background-color: oklch(from var(--muted-foreground) l c h / 0.2);
    border-radius: 2px;
  }
  
  .artifact-icon-column-list::-webkit-scrollbar-thumb:hover {
    background-color: oklch(from var(--muted-foreground) l c h / 0.3);
  }
</style>
