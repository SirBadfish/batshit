/** Accepted terminal group completion, never a 202, error, Stop or later running reply. */
export function isAcceptedGroupNoReplyCompletion(payload: unknown, userMessageId: string): boolean {
  const value = payload as Record<string, unknown> | null
  return Boolean(value && value.success === true && value.noReplyStream === true &&
    typeof value.groupTurnId === 'string' && value.groupTurnId.length > 0 && value.userMessageId === userMessageId)
}
