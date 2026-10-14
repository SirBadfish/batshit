/**
 * BL-410 (2026-09-27): an Approve or Deny click in a group chat is refused before it is
 * recorded.
 *
 * The group runner never resumes an approval: its members raise no approval card
 * (`GROUP_APPROVAL_UNAVAILABLE_REASON` in `nativeTools.ts`, and the broker's DL-116-10 refusal),
 * and a click sent into the group path started a NEW round instead. That round spent the chat's
 * Clip and hold countdowns, ran every speaker again under a new id, and the resumed run then
 * threw `APPROVAL_RESUME_TURN_MISSING`; the answer was already recorded, so the card could never
 * run (BL-410), and the round counted the user's message a second time (BL-356).
 *
 * A card raised before this fix can still be on screen. Its click is refused here, before the
 * answer is recorded (`answerApprovalsOnce`), before the turn lock, and before any Clip or hold
 * countdown, so nothing is spent and the card's buttons come back beside this error.
 */

/** Is this request an approval click (`isApprovalClick`) in a group chat? */
export function refusesGroupApprovalClick(input: {
  groupSession: boolean
  approvalClick: boolean
}): boolean {
  return input.groupSession && input.approvalClick
}

/** The 409 body for a refused group approval click. */
export const GROUP_APPROVAL_CLICK_REFUSAL = {
  error: 'Approvals are not available in group chats, so this was not run.',
  code: 'approval_unavailable_in_group',
  details:
    'Run it in a one-agent chat with this agent, or add the command to the allow list in Agent Settings.',
} as const
