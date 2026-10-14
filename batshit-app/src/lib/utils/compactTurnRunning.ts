/**
 * BL-622 (rule C3): how the chat page answers a Compact the server refused because a reply is
 * running in the chat (409 `turn_running`, "A reply is running in this chat. Compact runs after
 * it.").
 *
 * The page counts a chat idle once a reply's `end` arrives, while the server still holds the chat
 * for the reply's after-reply work, and a reply from another tab is not this tab's to wait for. So
 * Auto Compact can meet that refusal right at a reply's end. It is not an error: Auto Compact stays
 * quiet and runs again after the reply (the page clears its once-per-state key after
 * `COMPACT_TURN_RUNNING_RETRY_MS`, never at once: its trigger reads that key, and clearing it at
 * once would ask the server again in a loop). A Compact the user pressed is told, in the server's
 * words.
 */

export const COMPACT_TURN_RUNNING_RETRY_MS = 5_000

export type CompactTurnRunningHandling = 'retry_quietly' | 'tell_user'

/** A waiting approval (BL-711) uses the same bounded quiet retry as a running turn. */
export function resolveCompactTurnRunning(
  mode: 'auto' | 'manual',
  status: number,
  payload: unknown
): CompactTurnRunningHandling | null {
  if (status !== 409) return null
  const code = (payload as { code?: unknown } | null)?.code
  if (code !== 'turn_running' && code !== 'approval_pending') return null
  return mode === 'auto' ? 'retry_quietly' : 'tell_user'
}
