/**
 * What an approval click leaves on the card once the server has answered (2026-09-18).
 *
 * A click marks its entry at once (`approved` / `denied`), so the card stops offering the
 * buttons while the answer is on its way, and on the API lane the answer goes only when
 * every entry on the card is decided. The card keeps that mark only for an answer the server
 * ACCEPTED. A refused answer, or one that never arrived, used to leave the entry marked with
 * no buttons and nothing sent: the card said "Approved" while the stored card was still
 * pending, until a reload (measured live, `_local/approval-early-click-proof/before-fix.json`).
 * Now every decision a refused answer carried goes back to pending, so the buttons come back
 * beside the error; the user decides again, since nothing they decided reached the server.
 *
 * "Accepted" is the server's 202 (it owns the turn), not the turn's success (bug sweep,
 * 2026-09-18). The server records the answer before the resumed run starts
 * (`approvalAnswerRecord.ts`) and refuses a second answer for the same approval, so a resume
 * that fails or is stopped AFTER acceptance leaves the card answered. Putting the buttons back
 * then was how a second Approve ran the same command twice. `approvalAnswerWasRecorded` is the
 * rule.
 *
 * Why a click in the first moments was refused at all, and why the server now waits instead:
 * `$lib/server/services/approvalClickWait.ts`. The rule here is deliberately not a retry: the
 * server knows who holds the chat's turn lock, and a browser that retried blindly could get in
 * after ANOTHER click on the same card had already spent it.
 */

import type { ToolApprovalEntry, ToolApprovalResponse } from '$lib/types/tool-approvals'

type ApprovalEntry = Partial<ToolApprovalEntry> & Record<string, any>

function isDecided(status: unknown): status is 'approved' | 'denied' | 'expired' {
  return status === 'approved' || status === 'denied' || status === 'expired'
}

/** The entries an answer carries: decided (approved, denied, or expired) and not sent yet. */
export function collectUnsentApprovalDecisions<T extends ApprovalEntry>(approvals: T[]): T[] {
  return approvals.filter((entry) => !entry?.submitted && isDecided(entry?.status))
}

/** The `tool-approval-response` parts send-routed reads, one per decided entry. */
export function buildToolApprovalResponses(decisions: ApprovalEntry[]): ToolApprovalResponse[] {
  return decisions.map((entry) => ({
    type: 'tool-approval-response',
    approvalId: String(entry.approvalId),
    approved: entry.status === 'approved',
    reason:
      entry.status === 'approved'
        ? 'User approved'
        : entry.status === 'expired'
          ? 'Approval expired after 3 minutes'
          : 'User denied'
  }))
}

function decisionsById(sent: ApprovalEntry[]): Map<string, ApprovalEntry['status']> {
  return new Map(
    sent
      .filter((entry) => typeof entry?.approvalId === 'string')
      .map((entry) => [entry.approvalId as string, entry.status])
  )
}

/**
 * The server ACCEPTED the answer: each entry it carried keeps the decision it carried, marked
 * sent. The decision is written from what was sent, not read off the card, because a chat
 * reload while the answer was out puts the stored copy (still pending) back on screen.
 */
export function markApprovalDecisionsSent<T extends ApprovalEntry>(approvals: T[], sent: ApprovalEntry[]): T[] {
  const sentStatus = decisionsById(sent)
  return approvals.map((entry) =>
    entry && sentStatus.has(entry.approvalId as string)
      ? { ...entry, status: sentStatus.get(entry.approvalId as string), submitted: true }
      : entry
  )
}

/**
 * The server REFUSED the answer, or it never arrived: every Approve and Deny it carried goes
 * back to pending, so the buttons come back. An expired entry stays expired; its clock ran
 * out whatever the server said. Entries this answer did not carry are left alone.
 */
export function returnRefusedApprovalDecisions<T extends ApprovalEntry>(approvals: T[], sent: ApprovalEntry[]): T[] {
  const sentStatus = decisionsById(sent)
  return approvals.map((entry) => {
    if (!entry || !sentStatus.has(entry.approvalId as string)) return entry
    return { ...entry, status: entry.status === 'expired' ? 'expired' : 'pending', submitted: false }
  })
}

/**
 * Did the server record this answer? Only then does the card keep its marks.
 *
 * - The turn succeeded: recorded.
 * - The server never accepted the send (a refusal before the turn lock, or a lost request):
 *   not recorded, the buttons come back.
 * - The server accepted it and the turn then failed, was stopped, or found the approval already
 *   answered: recorded, because the server writes the answer before the resumed run starts.
 *   The one exception is the server saying it could NOT record it (`approval_record_failed`).
 */
export function approvalAnswerWasRecorded(outcome: {
  accepted: boolean
  ok: boolean
  code?: string | null
}): boolean {
  if (outcome.ok) return true
  if (!outcome.accepted) return false
  return outcome.code !== 'approval_record_failed'
}
