<script lang="ts">
  import { Loader2, ArrowRight } from '@lucide/svelte'
  
  let { 
    type = 'spinner',
    text = ''
  }: {
    type?: 'spinner' | 'dots' | 'tool'
    text?: string
  } = $props()
</script>

<div class="loading-indicator">
  {#if type === 'spinner'}
    <Loader2 class="loading-spinner-icon" />
    {#if text}
      <span>{text}</span>
    {/if}
  {:else if type === 'dots'}
    <div class="loading-dots">
      <div class="dot"></div>
      <div class="dot"></div>
      <div class="dot"></div>
    </div>
    {#if text}
      <span>{text}</span>
    {/if}
  {:else if type === 'tool'}
    <Loader2 class="loading-spinner-icon" />
    <span class="loading-slide">
      <ArrowRight class="loading-arrow-icon" />
    </span>
    <span>{text || 'Calling tool...'}</span>
  {/if}
</div>

<style>
  .loading-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
    color: var(--muted-foreground);
    font-size: 0.875rem;
  }

  :global(.loading-spinner-icon) {
    width: 1rem;
    height: 1rem;
    animation: spin 1s linear infinite;
  }

  .loading-dots {
    display: flex;
    gap: 0.25rem;
  }

  :global(.loading-arrow-icon) {
    width: 0.75rem;
    height: 0.75rem;
  }
  
  .dot {
    width: 6px;
    height: 6px;
    background-color: currentColor;
    border-radius: 50%;
    animation: dots 1.4s infinite ease-in-out both;
  }
  
  .dot:nth-child(1) {
    animation-delay: -0.32s;
  }
  
  .dot:nth-child(2) {
    animation-delay: -0.16s;
  }

  .loading-slide {
    animation: slide 0.9s ease-in-out infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }

  @keyframes slide {
    0%, 100% { transform: translateX(0); opacity: 0.6; }
    50% { transform: translateX(3px); opacity: 1; }
  }
  
  @keyframes dots {
    0%, 80%, 100% {
      transform: scale(0);
      opacity: 0.5;
    }
    40% {
      transform: scale(1);
      opacity: 1;
    }
  }
</style>
