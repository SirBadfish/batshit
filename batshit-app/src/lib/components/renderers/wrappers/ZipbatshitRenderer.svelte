<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { formatTokenCount } from '$lib/utils/tokens'
  import { cn } from '$lib/utils'
  import { downloadBlob } from '$lib/utils/download'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import { Terminal, FileDiff, FileText } from '@lucide/svelte'
  
  let { 
    id,
    source = 'USER',
    tokens = undefined,
    name = 'Unknown',
    path = '',
    description = '',
    contentType
  } = $props<{
    id: string
    source: string
    tokens?: number
    name: string
    path: string
    description: string
    contentType?: string
  }>()
  
  let showHover = $state(false)
  
  // Determine source color
  const sourceColor = $derived.by(() => {
    switch (source) {
      case 'USER': return 'text-[var(--zip-source-user)]'
      case 'AI': return 'text-[var(--zip-source-ai)]'
      case 'SMART': return 'text-[var(--zip-source-smart)]'
      default: return 'text-[var(--zip-source-default)]'
    }
  })

  const hasTokenCount = $derived(
    typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
  )
</script>

<!-- For images, show the actual image -->
{#if contentType === 'image' || path?.includes('images/')}
  <div class="image-container">
    {#if path && path.startsWith('http')}
      <img 
        src={path} 
        alt={name}
        class="batshit-image"
        style="max-height: 400px;"
      />
    {:else}
      <div class="error-container">
        <p class="error-text">Image URL error: {path || 'No path provided'}</p>
      </div>
    {/if}
    <!-- Small info badge -->
    <div class="info-badge">
      {name}
      {#if hasTokenCount}
        {' • '}{formatTokenCount(tokens)}
      {/if}
    </div>
  </div>

<!-- For files, show a nice download button -->
{:else if contentType === 'file' || contentType === 'document' || path.includes('documents/')}
  <div class="file-container">
    <div class="file-icon"><FileText class="h-4 w-4" /></div>
    <div class="file-info">
      <div class="file-name">{name}</div>
      <div class="file-description">
        {description}
        {#if hasTokenCount}
          {' • '}{formatTokenCount(tokens)}
        {/if}
      </div>
    </div>
    <Button 
      variant="outline" 
      size="sm" 
      class="download-button"
      onclick={async () => {
        if (path.startsWith('http')) {
          try {
            const response = await fetch(path)
            if (!response.ok) throw new Error(`Download failed: ${response.status}`)
            const blob = await response.blob()
            await downloadBlob(blob, name, {
              title: 'Download File',
              mimeType: blob.type || 'application/octet-stream'
            })
          } catch {
            const a = document.createElement('a')
            a.href = path
            a.download = name
            a.click()
          }
        }
      }}
    >
      Download
    </Button>
    
  </div>

<!-- For other zipped content (terminal, errors, tools, etc.), show the zip UI -->
{:else}
  <div 
    class="batshit-zip"
    role="button"
    tabindex="0"
    onmouseenter={() => showHover = true}
    onmouseleave={() => showHover = false}
  >
    <!-- Zip icon and source -->
    <div class="zip-icon-container">
      <span class="zip-icon">
        {#if contentType === 'terminal'}<Terminal class="icon-size" />
        {:else if contentType === 'diff'}<FileDiff class="icon-size" />
        {:else}<BatshitIcon id="zip" class="icon-size" />{/if}
      </span>
      <Badge variant="outline" class={cn('source-badge', sourceColor)}>
        {source}
      </Badge>
    </div>
    
    <!-- File info -->
    <div class="zip-info">
      <div class="zip-name">{name}</div>
      <div class="zip-description">{description}</div>
    </div>
    
    <!-- Token count -->
    {#if hasTokenCount}
      <div class="token-count">
        {formatTokenCount(tokens)} tokens
      </div>
    {/if}
    
  </div>
{/if}

<style>
  /* Image styles */
  .image-container {
    position: relative;
    display: inline-block;
  }
  
  .image-container:hover .info-badge {
    opacity: 1;
  }
  
  .batshit-image {
    max-width: 100%;
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    transition: box-shadow 0.2s;
    border-radius: var(--radius);
  }
  
  .error-container {
    padding: 2rem;
    background-color: rgb(254 242 242);
    border-radius: var(--radius);
  }
  
  :global(.dark) .error-container {
    background-color: rgb(127 29 29 / 0.2);
  }
  
  .error-text {
    color: rgb(220 38 38);
  }
  
  :global(.dark) .error-text {
    color: rgb(248 113 113);
  }
  
  .info-badge {
    position: absolute;
    bottom: 0.5rem;
    left: 0.5rem;
    background-color: var(--background);
    background-color: rgb(from var(--background) r g b / 0.9);
    backdrop-filter: blur(4px);
    font-size: 0.75rem;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius);
  }
  
  /* File container styles */
  .file-container {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background-color: var(--card);
    transition: background-color 0.2s;
    border-radius: var(--radius);
  }
  
  .file-container:hover {
    background-color: var(--accent);
    opacity: 0.5;
  }
  
  .file-icon {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  
  .file-info {
    flex: 1;
  }
  
  .file-name {
    font-weight: 500;
  }
  
  .file-description {
    font-size: 0.875rem;
    color: var(--muted-foreground);
  }
  
  :global(.download-button) {
    margin-left: 0.5rem;
  }
  
  /* Zip content styles */
  .batshit-zip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    max-width: 100%;
    transition: all 0.2s;
    border-radius: var(--radius);
  }
  
  .zip-icon-container {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  
  .zip-icon {
    color: var(--muted-foreground);
  }
  
  :global(.icon-size) {
    height: 1rem;
    width: 1rem;
  }
  
  :global(.source-badge) {
    font-size: 0.75rem;
  }
  
  .zip-info {
    flex: 1;
    min-width: 0;
  }
  
  .zip-name {
    font-weight: 500;
    font-size: 0.875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .zip-description {
    font-size: 0.75rem;
    color: var(--muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .token-count {
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }
</style>
