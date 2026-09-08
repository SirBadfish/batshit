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

export async function hasPendingToolApproval(sessionId: string): Promise<boolean> {
  try {
    const messages = await redis.getRecentMessages(sessionId, 5)
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as Record<string, any>
      if (message?.role !== 'assistant') continue
      const approvals = message?.metadata?.toolApprovals
      return Array.isArray(approvals) ? approvals.length > 0 : Boolean(approvals)
    }
  } catch {
    // Advisory: an unreadable session is reported as running, not as broken.
  }
  return false
}
