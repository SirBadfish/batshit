<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import ArtifactSourceBadge from '$lib/components/artifacts/ArtifactSourceBadge.svelte'
  import { getArtifactIframeSandbox } from '$lib/artifacts/artifactIframeSandbox'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { DEFAULT_ARTIFACT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import { X, GripHorizontal, Edit3, RefreshCw } from '@lucide/svelte'
  import { onMount } from 'svelte'
  
  // Props
  let {
    open = $bindable(false),
    artifact = $bindable(null),
    height = $bindable(66), // Default 66% height
    minHeight = 5,
    maxHeight = 90
  } = $props<{
    open?: boolean
    artifact?: any | null
    height?: number
    minHeight?: number
    maxHeight?: number
  }>()

  function getArtifactIconRef(value: any) {
    return normalizeIconRef(value?.icon_ref ?? value?.icon, DEFAULT_ARTIFACT_ICON_REF)
  }
  
  // Drag state
  let isDragging = $state(false)
  let dragStartY = $state(0)
  let dragStartHeight = $state(0)
  let containerRef = $state<HTMLDivElement | undefined>(undefined)
  let iframeLoaded = $state(false)
  let iframeKey = $state(0)
  let lastIframeSrc = $state('')
  
  // Calculate actual height in pixels
  const actualHeight = $derived(
    typeof window !== 'undefined' 
      ? (window.innerHeight * height) / 100 
      : 600
  )
  
  // Handle drag start
  function handleDragStart(e: MouseEvent) {
    isDragging = true
    dragStartY = e.clientY
    dragStartHeight = height
    
    // Add dragging class to body
    document.body.classList.add('dragging-overlay')
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
    
    e.preventDefault()
  }
  
  // Handle drag move
  function handleDragMove(e: MouseEvent) {
    if (!isDragging) return

    // For top-anchored overlay: drag DOWN = taller, drag UP = shorter
    // e.clientY increases when dragging down, so we want positive delta when going down
    const deltaY = e.clientY - dragStartY
    const deltaPercent = (deltaY / window.innerHeight) * 100
    const newHeight = dragStartHeight + deltaPercent

    // Apply constraints
    height = Math.min(Math.max(minHeight, newHeight), maxHeight)
  }
  
  // Handle drag end
  function handleDragEnd() {
    if (!isDragging) return
    
    isDragging = false
    
    // Remove dragging class from body
    document.body.classList.remove('dragging-overlay')
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    
    // Save to localStorage
    localStorage.setItem('headerOverlayHeight', height.toString())
  }
  
  // Set up global mouse event listeners for dragging
  $effect(() => {
    if (typeof window === 'undefined') return

    const handleMove = (e: MouseEvent) => handleDragMove(e)
    const handleEnd = () => handleDragEnd()
    // End drag if mouse leaves window (prevents stuck drag state)
    const handleLeave = (e: MouseEvent) => {
      // Only end if mouse actually left the document (not just moved to a child element)
      if (e.relatedTarget === null) {
        handleDragEnd()
      }
    }

    if (isDragging) {
      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleEnd)
      document.addEventListener('mouseleave', handleLeave)

      return () => {
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleEnd)
        document.removeEventListener('mouseleave', handleLeave)
      }
    }
  })
  
  // Handle close
  function handleClose() {
    open = false
    artifact = null
    iframeLoaded = false
    lastIframeSrc = ''
  }

  function getArtifactVersionKey(value: any) {
    return value?.updated_at || value?.updatedAt || value?.version || value?.mode || ''
  }

  function getArtifactIframeSrc(value: any) {
    if (!value?.id) return ''
    const params = new URLSearchParams()
    params.set('refresh', String(iframeKey))
    const versionKey = getArtifactVersionKey(value)
    if (versionKey) params.set('artifactVersion', String(versionKey))
    return `/artifact/${encodeURIComponent(value.id)}?${params.toString()}`
  }

  const artifactIframeSrc = $derived.by(() => (artifact ? getArtifactIframeSrc(artifact) : ''))
  
  // Handle double-click on drag handle to toggle between min and last height
  let lastHeight = $state(66)
  
  function handleDoubleClick() {
    if (height === minHeight) {
      height = lastHeight
    } else {
      lastHeight = height
      height = minHeight
    }
    localStorage.setItem('headerOverlayHeight', height.toString())
  }
  
  // Restore saved height on mount
  onMount(() => {
    const savedHeight = localStorage.getItem('headerOverlayHeight')
    if (savedHeight) {
      const h = parseFloat(savedHeight)
      if (!isNaN(h)) {
        height = Math.min(Math.max(minHeight, h), maxHeight)
      }
    }
  })
  
  $effect(() => {
    const nextSrc = artifactIframeSrc
    if (!nextSrc) {
      lastIframeSrc = ''
      iframeLoaded = false
      return
    }

    if (nextSrc !== lastIframeSrc) {
      lastIframeSrc = nextSrc
      iframeLoaded = false
    }
  })
</script>

{#if open && artifact}
  <!-- Overlay container -->
  <div 
    bind:this={containerRef}
    class="artifact-header-overlay"
    style="height: {actualHeight}px;"
  >
    <!-- Header bar -->
    <div class="artifact-header-overlay-bar">
      <div class="artifact-header-overlay-titlebar">
        <span class="artifact-header-overlay-icon-wrap">
          <IconRenderer
            ref={getArtifactIconRef(artifact)}
            label={artifact.name || 'Artifact'}
            iconClass="artifact-header-overlay-icon"
          />
          <ArtifactSourceBadge artifact={artifact} class="artifact-header-overlay-source-badge" />
        </span>
        <h3 class="artifact-header-overlay-title">{artifact.name}</h3>
        <ArtifactSourceBadge artifact={artifact} showLabel size="sm" />
        {#if artifact.mode !== 'published'}
          <span class="artifact-header-overlay-draft-badge">
            Draft
          </span>
        {/if}
      </div>
      <div class="artifact-header-overlay-controls">
        <Tooltip.Root>
          <Tooltip.Trigger>
            <Button
              variant="ghost"
              size="icon"
              class="artifact-header-overlay-button"
              onclick={() => {
                window.dispatchEvent(new CustomEvent('batshit:open-settings', {
                  detail: { tab: 'artifacts', artifactId: artifact.id }
                }))
              }}
              title="Edit in Settings"
              aria-label={`Edit artifact ${artifact.name} in settings`}
            >
              <Edit3 class="artifact-header-overlay-button-icon" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Edit in Settings</Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          <Tooltip.Trigger>
            <Button
              variant="ghost"
              size="icon"
              class="artifact-header-overlay-button"
              onclick={() => { iframeKey++; iframeLoaded = false }}
              title="Refresh"
              aria-label={`Refresh artifact ${artifact.name}`}
            >
              <RefreshCw class="artifact-header-overlay-button-icon" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>Refresh</Tooltip.Content>
        </Tooltip.Root>
        <Button
          variant="ghost"
          size="icon"
          class="artifact-header-overlay-button"
          onclick={handleClose}
          aria-label="Close artifact overlay"
          title="Close artifact overlay"
        >
          <X class="artifact-header-overlay-button-icon" />
        </Button>
      </div>
    </div>
    
    <!-- Iframe content area -->
    <div class="artifact-header-overlay-frame-wrap">
      {#if !iframeLoaded}
        <div class="artifact-header-overlay-loading">
          <div class="artifact-header-overlay-spinner"></div>
        </div>
      {/if}

      <!-- Drag capture overlay - prevents iframe from stealing mouse events during resize -->
      {#if isDragging}
        <div class="artifact-header-overlay-drag-blocker"></div>
      {/if}

      {#key artifactIframeSrc}
        <iframe
          src={artifactIframeSrc}
          title="{artifact.name}"
          class="artifact-header-overlay-iframe"
          sandbox={getArtifactIframeSandbox(artifact)}
          onload={() => iframeLoaded = true}
        ></iframe>
      {/key}
    </div>
    
    <!-- Drag handle at bottom -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div 
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize overlay height"
      tabindex="0"
      class="artifact-header-overlay-resize-handle"
      onmousedown={handleDragStart}
      ondblclick={handleDoubleClick}
      onkeydown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const delta = e.key === 'ArrowUp' ? -5 : 5
          height = Math.min(Math.max(minHeight, height + delta), maxHeight)
        }
      }}
    >
      <GripHorizontal class="artifact-header-overlay-grip" />
    </div>
  </div>
  
  <!-- Semi-transparent backdrop for the area below (optional) -->
  <button
    type="button"
    class="artifact-header-overlay-backdrop"
    style="top: {actualHeight}px; bottom: 0;"
    onclick={handleClose}
    onkeydown={(e) => e.key === 'Escape' && handleClose()}
    aria-label="Close overlay"
  ></button>
{/if}

<style>
  .artifact-header-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: var(--z-header);
    border-bottom: 1px solid var(--border);
    background: var(--background);
    box-shadow: 0 10px 24px color-mix(in oklab, black 25%, transparent);
    transition: height 300ms ease-out;
  }

  .artifact-header-overlay-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: color-mix(in oklab, var(--muted) 50%, transparent);
  }

  .artifact-header-overlay-titlebar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .artifact-header-overlay-icon-wrap {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }

  :global(.artifact-header-overlay-icon) {
    width: 20px;
    height: 20px;
  }

  :global(.artifact-header-overlay-source-badge) {
    position: absolute;
    right: -4px;
    bottom: -4px;
  }

  .artifact-header-overlay-title {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
    font-weight: 600;
  }

  .artifact-header-overlay-draft-badge {
    flex-shrink: 0;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    background: color-mix(in oklab, #f59e0b 10%, transparent);
    color: #b45309;
    font-size: 0.75rem;
  }

  .artifact-header-overlay-controls {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
  }

  :global(.artifact-header-overlay-button) {
    width: 32px;
    height: 32px;
  }

  :global(.artifact-header-overlay-button-icon) {
    width: 16px;
    height: 16px;
  }

  .artifact-header-overlay-frame-wrap {
    position: relative;
    height: calc(100% - 41px);
  }

  .artifact-header-overlay-loading,
  .artifact-header-overlay-drag-blocker {
    position: absolute;
    inset: 0;
  }

  .artifact-header-overlay-loading {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .artifact-header-overlay-spinner {
    width: 32px;
    height: 32px;
    border: 4px solid var(--primary);
    border-top-color: transparent;
    border-radius: 999px;
    animation: artifact-overlay-spin 1s linear infinite;
  }

  .artifact-header-overlay-drag-blocker {
    z-index: var(--z-overlay);
    cursor: row-resize;
  }

  .artifact-header-overlay-iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }

  .artifact-header-overlay-resize-handle {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 12px;
    cursor: row-resize;
    transition: background-color 150ms ease-out;
  }

  .artifact-header-overlay-resize-handle:hover,
  .artifact-header-overlay-resize-handle:focus-visible {
    background: color-mix(in oklab, var(--accent) 50%, transparent);
    outline: none;
  }

  :global(.artifact-header-overlay-grip) {
    width: 16px;
    height: 16px;
    color: var(--muted-foreground);
    transition: color 150ms ease-out;
  }

  .artifact-header-overlay-resize-handle:hover :global(.artifact-header-overlay-grip) {
    color: var(--foreground);
  }

  .artifact-header-overlay-backdrop {
    position: fixed;
    left: 0;
    right: 0;
    z-index: var(--z-controls);
    padding: 0;
    border: 0;
    background: color-mix(in oklab, var(--background) 20%, transparent);
    backdrop-filter: blur(4px);
  }

  :global(body.dragging-overlay) {
    cursor: row-resize !important;
  }
  
  :global(body.dragging-overlay *) {
    cursor: row-resize !important;
    user-select: none !important;
  }

  @keyframes artifact-overlay-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
