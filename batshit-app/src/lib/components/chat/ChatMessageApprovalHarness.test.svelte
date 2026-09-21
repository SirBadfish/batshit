<script lang="ts">
  /**
   * Test harness: renders the REAL `ChatMessage` from the REAL message store, the way the chat
   * page does, so a card the component writes back to the store re-renders as it would in the
   * app. Used by `ChatMessageApprovalSubmit.test.ts`.
   */
  import ChatMessage from './ChatMessage.svelte'
  import * as messageStore from '$lib/stores/messages.svelte'

  let { messageId, sessionId }: { messageId: string; sessionId: string } = $props()

  const messages = $derived(messageStore.getMessages(sessionId))
</script>

{#each messages as message, index (message.id)}
  {#if message.id === messageId}
    <ChatMessage {message} {sessionId} messageIndex={index} totalMessages={messages.length} />
  {/if}
{/each}
