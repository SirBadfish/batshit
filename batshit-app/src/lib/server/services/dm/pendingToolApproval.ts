/**
 * SA-113 — "is this chat's last turn sitting on a tool approval?", in ONE place.
 *
 * Two callers need the same answer for different reasons: `sys.dm.agents` reports an agent
 * as `waiting_approval` rather than `running` (DL-113-16), and F-SEC-1b stamps a woken DM
 * with "needs you" when its turn ENDED in that state.
 *
 * Its own leaf module because `dmTools.ts` imports `agentWakeups.ts` statically, so the
 * wake primitive cannot import it back. A copy in each file would be exactly the drift the
 * Fragility Map warns about — F-P2-1 was already one wrong version of this read.
 *
 * F-P2-1: the RECENT five, not the first five. Reading the head reported the approval state
 * of a chat's opening exchange on every session longer than five messages — a stale
 * `waiting_approval` forever, or a live one missed entirely.
 */

import { redis } from '$lib/server/redis'

/**
 * The stored shape is `ToolApprovalSummary` — `{ mode, approvals[], source }` — NOT an
 * array. Reading it as one meant the object branch answered `Boolean(approvals)`, which is
 * true for every summary a message has ever carried: approved, denied and expired alike.
 * `send-routed` writes the summary back on expiry with each entry flipped to `'expired'`
 * (`toolApprovals: { ...summary, approvals: nextApprovals }`), so a turn that ended on a
 * lapsed approval card reported `waiting_approval` for as long as it stayed the newest
 * assistant message — a finished woken turn stamped "needs you", and an idle agent
 * advertised to its peers as blocked on a human.
 *
 * Only `pending` counts. The bare-array form is still accepted because older messages and
 * the test fixtures carry it.
 */
function countsAsPending(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const status = (entry as Record<string, any>).status
  // A summary written before `status` existed is pending by the fact of being there.
  return status === undefined || status === 'pending'
}

export async function hasPendingToolApproval(sessionId: string): Promise<boolean> {
  try {
    const messages = await redis.getRecentMessages(sessionId, 5)
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as Record<string, any>
      if (message?.role !== 'assistant') continue
      const stored = message?.metadata?.toolApprovals
      if (!stored || typeof stored !== 'object') return false
      const approvals = Array.isArray(stored) ? stored : stored.approvals
      return Array.isArray(approvals) && approvals.some(countsAsPending)
    }
  } catch {
    // Advisory: an unreadable session is reported as running, not as broken.
  }
  return false
}
