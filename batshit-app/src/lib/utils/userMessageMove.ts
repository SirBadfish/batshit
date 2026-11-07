import * as messageStore from '$lib/stores/messages.svelte'
import type { Message } from '$lib/stores/messages.svelte'

/**
 * BL-921: the server moved a saved user message to the end of its chat (one that stood beside held
 * words, behind their answer) and forwarded the moved record as `user_message` with `movedToEnd`.
 * A tab that has the message puts the server's copy at the end of its list too, so the chat reads
 * in the server's order and the tab's next send posts its history in that order (history arrives
 * from the browser). A tab without the message adds it, as for any `user_message`.
 */
export function moveUserMessageToEndOfChat(message: Message, sessionId: string | null | undefined) {
  if (!message?.id || !sessionId) return
  messageStore.deleteMessage(message.id, sessionId)
  messageStore.addMessage({ ...message, session_id: sessionId })
}
