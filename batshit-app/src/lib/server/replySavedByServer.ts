/**
 * BL-775, BL-776: the server owns an agent's reply. send-routed's finalize saves the whole reply
 * from the stream's record (and the LiveKit turn route saves a realtime voice reply), so a tab's
 * copy (shorter when its connection was down, stale when the reply was deleted meanwhile) must
 * never land. `POST /api/messages` accepts only the user's own messages from a tab (an allow-list,
 * `isUserMessageRecord`) and never replaces a stored message of another role;
 * `PUT /api/messages/[sessionId]/[messageId]` refuses to change an assistant record or make one.
 * Both answer with this refusal.
 */
import { json } from '@sveltejs/kit'
export { preserveServerSteerMetadata } from './browserMessageMutation'

export const REPLY_SAVED_BY_SERVER_CODE = 'reply_saved_by_server'
export const REPLY_SAVED_BY_SERVER_TEXT =
  "A tab can save only the user's own messages; Batshit saves every other message itself."

export function isAssistantRecord(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { role?: unknown }).role === 'assistant')
}

/**
 * The one role a tab may save: the user's own message. An allow-list, not a block-list: every
 * other role (an agent's reply, a Compact summary, a note Batshit wrote) is the server's.
 */
export function isUserMessageRecord(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { role?: unknown }).role === 'user')
}

export function replySavedByServerResponse() {
  return json({ error: REPLY_SAVED_BY_SERVER_TEXT, code: REPLY_SAVED_BY_SERVER_CODE }, { status: 403 })
}
