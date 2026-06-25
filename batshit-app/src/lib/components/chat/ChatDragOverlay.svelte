<script lang="ts">
  interface Props {
    isDragging: boolean
    dragMode: 'upload' | 'mention'
    dragMentionPath: string | null
  }

  let { isDragging, dragMode, dragMentionPath }: Props = $props()
</script>

{#if isDragging}
  <div class="chat-drag-overlay">
    <div class="chat-drag-content">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="chat-drag-icon"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      {#if dragMode === 'mention'}
        <p class="chat-drag-title">Drop to @reference{dragMentionPath ? ` ${dragMentionPath}` : ''}</p>
        <p class="chat-drag-copy">Creates a link only (no upload)</p>
      {:else}
        <p class="chat-drag-title">Drop to upload to Clip Vault</p>
        <p class="chat-drag-copy">Images, documents, and code files</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .chat-drag-overlay {
    position: absolute;
    inset: 0;
    z-index: var(--z-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px dashed var(--primary);
    border-radius: calc(var(--radius) + 4px);
    background: oklch(from var(--background) l c h / 0.9);
  }

  .chat-drag-content {
    text-align: center;
  }

  .chat-drag-icon {
    margin-inline: auto;
    margin-bottom: 0.5rem;
    color: var(--primary);
  }

  .chat-drag-title {
    font-size: 1.125rem;
    font-weight: 650;
  }

  .chat-drag-copy {
    margin-top: 0.25rem;
    color: var(--bs-app-muted-text);
    font-size: 0.875rem;
  }
</style>
