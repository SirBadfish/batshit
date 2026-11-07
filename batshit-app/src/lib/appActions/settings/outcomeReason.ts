/** Presentation only. Keep the server's exact reason on the outcome and receipts. */
export function formatAppActionsOutcomeReason(reason: string): string {
  switch (reason) {
    case 'api_primary_only': return 'This setting applies only to Primary Agents, not to Subagents.'
    case 'unsupported_subject_id': return 'This saved agent ID is unsupported.'
    default:
      // Only code-shaped text loses separators; existing human sentences stay literal.
      return /^[A-Za-z][A-Za-z0-9]*(?:[_-]+[A-Za-z0-9]+)+$/.test(reason)
        ? reason.replace(/[_-]+/g, ' ')
        : reason
  }
}
