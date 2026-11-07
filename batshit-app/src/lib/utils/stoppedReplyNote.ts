/**
 * BL-934: a reply the user stopped before any of it arrived is saved (and drawn by the tab's own
 * Stop) with `interrupted: true` and nothing in it: no words, no tool step, no card. A stopped reply
 * carries no label, so its bubble said nothing at all, only the agent's name over an empty dark
 * bubble, during the reply and after it. That bubble now says what happened.
 */
export const EMPTY_STOPPED_REPLY_NOTE = 'You stopped this reply before it said anything.'

type StoppedReplyCandidate = {
  role?: string | null
  status?: string | null
  content?: string | null
  intermediateSteps?: unknown
  metadata?: Record<string, unknown> | null
}

/**
 * The reply was stopped and has nothing of its own to show. What the bubble would draw besides its
 * words (a reasoning summary or a plan the agent shows) is the caller's to add: it knows whether
 * the agent shows them.
 */
export function isEmptyStoppedReply(message: StoppedReplyCandidate): boolean {
  if (message.role !== 'assistant' || message.status === 'in_progress') return false
  const metadata = message.metadata ?? {}
  if (metadata.interrupted !== true) return false
  // A failure has its own banner, which says why the reply ended.
  if (metadata.response_failed === true) return false
  if (typeof message.content === 'string' && message.content.trim().length > 0) return false
  if (Array.isArray(message.intermediateSteps) && message.intermediateSteps.length > 0) return false
  const approvals = (metadata.toolApprovals as { approvals?: unknown } | undefined)?.approvals
  if (Array.isArray(approvals) && approvals.length > 0) return false
  return true
}
