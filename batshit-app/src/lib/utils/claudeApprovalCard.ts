/**
 * The chat page's rules for a Claude approval card's events (BL-636, BL-496).
 *
 * The permission helper (`scripts/claude-permission-mcp.cjs`) publishes, for one card:
 *   1. `tool_start` — the helper's own name and the card's id, and NO arguments;
 *   2. `tool-call`  — `args: { approvalId, toolName, toolInput, toolUseId }`, `requestedAt`,
 *      `expiresAt`: the tool Claude asked for and the card's clock;
 *   3. `tool-result` — the answer, with `approvalStatus` and, for a card nobody answered,
 *      `expiryReason`.
 *
 * BL-636: the page used to make the card from the FIRST event and then skip the second as
 * "already tracked", so a card could keep the helper's name and an empty input instead of the
 * action it asked about. Only a complete event makes a card now, and a complete event for a
 * card the page already holds completes it.
 *
 * Kept out of `+page.svelte` (8,000 lines) so a test can drive the real rule.
 */

type Entry = Record<string, any>

export interface ClaudeApprovalCardDetails {
  approvalId: string
  toolName?: string
  toolCall?: unknown
  input?: unknown
}

/** Does this approval event name the tool it asks for (the helper's `tool-call`)? */
export function hasCompleteClaudeApprovalArgs(data: unknown): boolean {
  const args = (data as Entry | null)?.args
  if (!args || typeof args !== 'object') return false
  return typeof args.toolName === 'string' && args.toolName.trim().length > 0
}

/**
 * The card list after one approval event, or null when the event changes nothing (an
 * incomplete `tool_start`).
 */
export function applyClaudeApprovalCardEvent(
  approvals: Entry[],
  data: unknown,
  details: ClaudeApprovalCardDetails,
  timestamps: { requestedAt?: string; expiresAt?: string }
): Entry[] | null {
  if (!hasCompleteClaudeApprovalArgs(data)) return null
  const fromEvent: Entry = {
    ...(timestamps.requestedAt ? { requestedAt: timestamps.requestedAt } : {}),
    ...(timestamps.expiresAt ? { expiresAt: timestamps.expiresAt } : {}),
    toolName: details.toolName,
    toolCall: details.toolCall,
    input: details.input,
    source: 'claude'
  }
  if (approvals.some((entry) => entry?.approvalId === details.approvalId)) {
    return approvals.map((entry) =>
      entry?.approvalId === details.approvalId ? { ...entry, ...fromEvent } : entry
    )
  }
  return [
    ...approvals,
    { approvalId: details.approvalId, status: 'pending', submitted: false, ...fromEvent }
  ]
}

/**
 * The card list after the helper's `tool-result`. A card nobody answered ends `expired` with
 * its reason (A6), never `denied`: a denial is a person's answer.
 */
export function settleClaudeApprovalCard(
  approvals: Entry[],
  approvalId: string,
  data: unknown,
  approved: boolean
): Entry[] {
  const event = (data ?? {}) as Entry
  const expired = event.approvalStatus === 'expired'
  const expiryReason =
    event.expiryReason === 'unanswered' || event.expiryReason === 'run_ended' || event.expiryReason === 'wait_failed'
      ? event.expiryReason
      : undefined
  return approvals.map((entry) => {
    if (entry?.approvalId !== approvalId) return entry
    if (expired) {
      return { ...entry, status: 'expired', submitted: true, ...(expiryReason ? { expiryReason } : {}) }
    }
    return { ...entry, status: approved ? 'approved' : 'denied' }
  })
}
