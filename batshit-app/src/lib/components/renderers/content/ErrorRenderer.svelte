<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import CollapsibleContent from '../shared/CollapsibleContent.svelte'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { AlertCircle, Check, Clipboard } from '@lucide/svelte'
  
  let { 
    error,
    title = 'Error',
    stack,
    code
  } = $props<{ 
    error: string
    title?: string
    stack?: string
    code?: string | number
  }>()
  
  let showStack = $state(false)
  let copied = $state(false)
  
  // Create subtitle from error info
  const subtitle = $derived(code ? `Code: ${code}` : '')
  
  async function copyError() {
    try {
      const fullError = [
        title,
        error,
        code ? `Error Code: ${code}` : '',
        stack ? `\n\nStack Trace:\n${stack}` : ''
      ].filter(Boolean).join('\n')
      
      await copyTextToClipboard(fullError)
      copied = true
      setTimeout(() => copied = false, 2000)
    } catch (err) {
      console.error('Failed to copy error:', err)
    }
  }
</script>

<CollapsibleContent
  {title}
  icon={AlertCircle}
  {subtitle}
  collapsed={true}
  maxHeight="300px"
>
  <div class="error-content-wrapper">
    <div class="error-message">{error}</div>
    
    {#if stack}
      <div class="stack-section">
        <button 
          class="stack-toggle"
          onclick={() => showStack = !showStack}
        >
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            width="12" 
            height="12" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            stroke-width="2" 
            stroke-linecap="round" 
            stroke-linejoin="round"
            class:rotated={showStack}
          >
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          Stack trace
        </button>
        
        {#if showStack}
          <pre class="stack-trace">{stack}</pre>
        {/if}
      </div>
    {/if}
    
    <!-- Copy button overlay -->
    <Button
      variant="ghost"
      size="sm"
      onclick={copyError}
      class="copy-button"
    >
      {#if copied}
        <Check class="h-3.5 w-3.5" />
      {:else}
        <Clipboard class="h-3.5 w-3.5" />
      {/if}
    </Button>
  </div>
</CollapsibleContent>

<style>
  .error-content-wrapper {
    position: relative;
    padding: 1rem;
    background: var(--error-background, oklch(5% 0.1 15));
    border-radius: var(--radius);
    min-height: 3rem;
  }
  
  .error-message {
    color: var(--error-text, oklch(90% 0.1 15));
    line-height: 1.5;
    word-break: break-word;
    padding-right: 3rem; /* Space for copy button */
  }
  
  /* Copy button styles removed - using inline styles instead */
  
  .stack-section {
    margin-top: 1rem;
  }
  
  .stack-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    background: transparent;
    border: 1px solid var(--error-border, oklch(40% 0.2 15));
    border-radius: calc(var(--radius) - 2px);
    color: var(--error-foreground, oklch(70% 0.2 15));
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .stack-toggle:hover {
    background: var(--error-hover, oklch(15% 0.15 15));
  }
  
  .stack-toggle svg {
    transition: transform 0.2s ease;
  }
  
  .stack-toggle svg.rotated {
    transform: rotate(180deg);
  }
  
  .stack-trace {
    margin-top: 0.5rem;
    padding: 0.75rem;
    background: var(--error-stack-background, oklch(0% 0 0 / 0.3));
    border: 1px solid var(--error-border, oklch(40% 0.2 15));
    border-radius: calc(var(--radius) - 2px);
    font-family: monospace;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--error-stack-text, oklch(80% 0.05 15));
    overflow-x: auto;
    white-space: pre;
  }
</style>
