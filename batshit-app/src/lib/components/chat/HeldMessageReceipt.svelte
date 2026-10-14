<script lang="ts">
  /**
   * BL-455 — the receipt under a message held for an approval card.
   *
   * The words the user typed while the agent worked became a real message when the reply stopped
   * at a card, and they wait for the click. This line says so, in the kept send's vocabulary
   * (`SteerBubble.svelte`: the same status line and the same quiet text action), with **Send now**
   * for the user who does not want to wait. It is drawn under the held message while no reply
   * follows it (`resolveHeldMessageReceipt`), so it goes away the moment a reply answers or reads
   * it; a send the chat's line kept at the same card may stand below it (BL-905).
   *
   * Send now sends THAT message by its id (`userMessageId`), so nothing is saved twice.
   */
  import { Ban, Hourglass } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import type { HeldMessageReceipt } from '$lib/utils/heldForApproval'

  let {
    receipt,
    onSendNow = null
  }: {
    receipt: HeldMessageReceipt
    onSendNow?: ((messageId: string) => void) | null
  } = $props()
</script>

<div class="held-receipt-row" data-testid="held-message-receipt" data-held-state={receipt.state}>
  <div class="held-receipt">
    <span class="held-receipt-status">
      {#if receipt.state === 'waiting'}
        <Hourglass class="held-receipt-icon" aria-hidden="true" />
      {:else}
        <Ban class="held-receipt-icon" aria-hidden="true" />
      {/if}
      {receipt.label}
    </span>
    {#if onSendNow}
      <Button
        variant="ghost"
        size="xs"
        class="held-receipt-action"
        data-testid="held-send-now"
        onclick={() => onSendNow?.(receipt.messageId)}
      >
        Send now
      </Button>
    {/if}
  </div>
</div>

<style>
  /* Right-aligned under the user's message it belongs to, like a steer's bubble. */
  .held-receipt-row {
    display: flex;
    justify-content: flex-end;
    width: 100%;
    min-width: 0;
    margin-top: -0.25rem;
  }

  .held-receipt {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem 0.5rem;
    max-width: min(100%, 32rem);
    min-width: 0;
    color: var(--muted-foreground);
  }

  /* The steer bubble's status line (`SteerBubble.svelte` `.steer-status`). */
  .held-receipt-status {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.6875rem;
    font-weight: 500;
    opacity: 0.78;
  }

  .held-receipt-status :global(.held-receipt-icon) {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
  }

  /* The kept send's quiet text action (`SteerBubble.svelte` `.steer-action-button`). */
  :global(.held-receipt-action) {
    height: 1.5rem;
    padding-inline: 0.35rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--muted-foreground);
  }

  :global(.held-receipt-action:hover) {
    color: var(--foreground);
  }
</style>
