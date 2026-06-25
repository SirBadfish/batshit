<script lang="ts">
  import { Copy, Play, Square, Trash2 } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'

  interface Props {
    isAI: boolean
    isSpeaking: boolean
    tokens?: number | string | null
    onPlayPause: () => void
    onCopyMarkdown: () => void
    onDelete: () => void
  }

  let {
    isAI,
    isSpeaking,
    tokens = null,
    onPlayPause,
    onCopyMarkdown,
    onDelete
  }: Props = $props()
</script>

<div class="message-actions-row {isAI ? 'is-ai' : 'is-user'}">
  {#if isAI}
    <Button
      variant="ghost"
      size="icon"
      class="message-action-button"
      onclick={onPlayPause}
      aria-label={isSpeaking ? 'Stop audio playback' : 'Play audio playback'}
      title={isSpeaking ? 'Stop' : 'Play'}
    >
      {#if isSpeaking}
        <Square class="message-action-icon is-stop" />
      {:else}
        <Play class="message-action-icon" />
      {/if}
    </Button>
  {/if}

  <Button
    variant="ghost"
    size="icon"
    class="message-action-button"
    onclick={onCopyMarkdown}
    aria-label="Copy message as Markdown"
    title="Copy Markdown"
  >
    <Copy class="message-action-icon" />
  </Button>

  <Button
    variant="ghost"
    size="icon"
    class="message-action-button is-danger"
    onclick={onDelete}
    aria-label="Delete message"
    title="Delete"
  >
    <Trash2 class="message-action-icon" />
  </Button>

  {#if tokens}
    <span class="message-token-count">
      {tokens} tokens
    </span>
  {/if}
</div>

<style>
  .message-actions-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.25rem;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  }

  .message-actions-row.is-ai {
    justify-content: flex-start;
  }

  .message-actions-row.is-user {
    justify-content: flex-end;
  }

  :global(.message-row:hover) .message-actions-row,
  :global(.message-row:focus-within) .message-actions-row {
    opacity: 1;
    pointer-events: auto;
  }

  :global(.message-action-button) {
    width: 1.5rem;
    height: 1.5rem;
    color: var(--muted-foreground);
  }

  :global(.message-action-button:hover) {
    color: var(--foreground);
  }

  :global(.message-action-button.is-danger:hover) {
    color: var(--destructive);
  }

  :global(.message-action-icon) {
    width: 0.75rem;
    height: 0.75rem;
  }

  :global(.message-action-icon.is-stop) {
    fill: currentColor;
    stroke-width: 0;
  }

  .message-token-count {
    margin-left: auto;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }
</style>
