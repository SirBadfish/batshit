<script lang="ts">
  /**
   * SA-114 P3 (DL-114-14) — the bubble for a steer that has no message record yet.
   *
   * A steer is deliberately NOT a message: a delivered one lives inside the assistant
   * record (DL-114-04) and a promoted one becomes a real user message the server writes.
   * In between there is nothing to render, which is what this is for — and why it reads
   * from the steer store rather than the message store. A bubble that is not a message can
   * never be posted back as history, which is the mistake this shape exists to make
   * impossible rather than merely avoid.
   *
   * It disappears on its own: `delivered` bubbles are cleared when the reply finalises and
   * the inset takes over, and `promoted` ones the moment the server's user message lands.
   */
  import { Loader2, Paperclip, Ban } from '@lucide/svelte'
  import { steerBubbleStatusLabel, type SteerBubbleEntry } from '$lib/stores/steerInbox.svelte'

  let { steer }: { steer: SteerBubbleEntry } = $props()

  // F-P3-4: the sentence lives in the store beside the state that decides it, so a drop
  // that was not the user's Stop never reads "you stopped the reply".
  const statusLabel = $derived(steerBubbleStatusLabel(steer))
</script>

<div class="steer-row" data-testid="steer-bubble" data-steer-state={steer.state}>
  <div class="steer-bubble" class:is-dropped={steer.state === 'dropped'}>
    <p class="steer-text">{steer.text}</p>
    <span class="steer-status">
      {#if steer.state === 'waiting'}
        <Paperclip class="steer-status-icon" aria-hidden="true" />
      {:else if steer.state === 'dropped'}
        <Ban class="steer-status-icon" aria-hidden="true" />
      {:else}
        <Loader2 class="steer-status-icon is-spinning" aria-hidden="true" />
      {/if}
      {statusLabel}
    </span>
  </div>
</div>

<style>
  .steer-row {
    display: flex;
    justify-content: flex-end;
    width: 100%;
    min-width: 0;
  }

  /* Narrower than a real message bubble on purpose: it is an aside to the reply above it,
     not a turn of its own. Parent-Child — a pending thing reads quieter than a real one. */
  .steer-bubble {
    box-sizing: border-box;
    max-width: min(100%, 32rem);
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.85rem;
    border: 1px solid oklch(0.63 0.05 281.84 / 0.45);
    border-radius: var(--radius);
    background: oklch(from var(--message-user-background) l c h / 0.45);
    color: var(--message-user-foreground);
  }

  .steer-bubble.is-dropped {
    border-color: oklch(from var(--muted-foreground) l c h / 0.3);
    background: oklch(from var(--muted-foreground) l c h / 0.08);
    color: var(--muted-foreground);
  }

  .steer-text {
    margin: 0;
    min-width: 0;
    font-size: 0.9375rem;
    font-weight: 300;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .steer-status {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.6875rem;
    font-weight: 500;
    opacity: 0.78;
  }

  .steer-status :global(.steer-status-icon) {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
  }

  .steer-status :global(.steer-status-icon.is-spinning) {
    animation: steer-status-spin 1.2s linear infinite;
  }

  @keyframes steer-status-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
