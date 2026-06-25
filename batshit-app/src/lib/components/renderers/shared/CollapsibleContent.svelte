<script lang="ts">
  import type { Component } from 'svelte'
  
  let {
    title = '',
    icon = '',
    subtitle = '',
    collapsed = true,
    maxHeight = '300px',
    children
  }: {
    title: string
    icon?: string | Component
    subtitle?: string
    collapsed?: boolean
    maxHeight?: string
    children?: any
  } = $props()
  
  function toggle() {
    collapsed = !collapsed
  }
</script>

<div class="collapsible-content full-tool">
  <button 
    class="collapsible-header tool-header-button"
    onclick={toggle}
    type="button"
    aria-expanded={!collapsed}
  >
    <div class="header-content tool-header">
      {#if icon}
        <span class="icon tool-icon" aria-hidden="true">
          {#if typeof icon === 'string'}
            {icon}
          {:else}
            {@const Component = icon}
            <Component class="h-3.5 w-3.5" />
          {/if}
        </span>
      {/if}
      <div class="tool-header-text">
        <span class="title">{title}</span>
        {#if subtitle}
          <span class="separator">•</span>
          <span class="subtitle">{subtitle}</span>
        {/if}
      </div>
    </div>
  </button>
  
  {#if !collapsed}
    <div class="collapsible-body tool-content" style="max-height: {maxHeight}">
      {@render children?.()}
    </div>
  {/if}
</div>

<style>
  .collapsible-content {
    margin: 0.25rem 0;
    position: relative;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    border: 1px solid var(--bs-app-inner-line);
    border-radius: var(--radius);
    background: oklch(1 0 0 / 0.018);
  }
  
  .collapsible-header {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 0.5rem 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: all 0.2s ease;
    color: var(--muted-foreground);
    font-size: 0.875rem;
    overflow: hidden;
  }
  
  /* Rounded corners: all 4 when collapsed, only top when expanded */
  .collapsible-header[aria-expanded="false"] {
    border-radius: var(--radius);
  }
  
  .collapsible-header[aria-expanded="true"] {
    border-radius: var(--radius) var(--radius) 0 0;
    border-bottom: 1px solid var(--bs-app-inner-line);
  }
  
  .collapsible-header:hover {
    background-color: var(--bs-app-field);
    color: var(--bs-app-field-text);
  }
  
  .header-content {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex: 1;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    font-family: var(--font-mono, monospace);
    color: var(--muted-foreground);
    font-size: 0.75rem;
    line-height: 1;
  }
  
  .icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--muted-foreground);
  }
  
  .tool-header-text {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .title {
    display: block;
    flex: 0 0 auto;
    font-weight: 500;
    font-family: monospace;
    min-width: 0;
    max-width: min(14rem, 45%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title:last-child {
    flex: 1 1 auto;
    max-width: 100%;
  }
  
  .separator {
    flex: 0 0 auto;
    opacity: 0.4;
    font-family: var(--font-mono, monospace);
  }
  
  .subtitle {
    display: block;
    flex: 1 1 auto;
    opacity: 0.7;
    font-size: 0.7rem;
    color: var(--muted-foreground);
    font-family: var(--font-mono, monospace);
    margin: 0;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .collapsible-body {
    min-width: 0;
    max-width: 100%;
    padding: 0.5rem;
    background: oklch(1 0 0 / 0.04);
    border-radius: 0 0 var(--radius) var(--radius);
    font-size: 0.875rem;
    font-family: var(--font-mono, monospace);
    overflow-y: auto;
    overflow-x: auto;
  }
  
  /* Custom scrollbar for collapsed content - matching main chat area */
  .collapsible-body::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  
  .collapsible-body::-webkit-scrollbar-track {
    background: transparent;
  }
  
  .collapsible-body::-webkit-scrollbar-thumb {
    background: var(--neutral-500);
    border-radius: 9999px;
  }
  
  .collapsible-body::-webkit-scrollbar-thumb:hover {
    background: var(--neutral-400);
  }
  
  :global(.dark) .collapsible-body::-webkit-scrollbar-thumb {
    background: var(--neutral-900);
  }
  
  :global(.dark) .collapsible-body::-webkit-scrollbar-thumb:hover {
    background: var(--neutral-800);
  }
</style>
