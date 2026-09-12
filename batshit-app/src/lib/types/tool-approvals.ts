export type ToolApprovalMode = 'off' | 'all'

export type ToolApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

/**
 * SA-116 P2 (DL-116-06) — the Fabric presentation block on an approval entry.
 *
 * Present only for a risky Fabric control, artifact control, or user-authored CLI tool, and
 * written by the SERVER where the entry is persisted. `approvalId` here is the `apr_…`
 * record id; the entry's own `approvalId` is the AI SDK's `aitxt-…` id, which is what the
 * browser posts back. Keeping both is what lets send-routed resolve the click from server
 * state instead of trusting an id a client chose (F-P1-4).
 */
export interface ToolApprovalControl {
  /** The `apr_…` approval record id. */
  approvalId: string
  controlId: string
  controlTitle: string
  riskLevel: 'confirm' | 'restricted'
  /**
   * F-P2-2: the exact normalized payload the record's hash covers — the bytes that run on
   * Approve. The card shows THIS behind its "Exact input" disclosure. Absent on a lane that
   * cannot carry it, in which case the card shows `inputSummary` and says so.
   */
  input?: Record<string, any>
  /**
   * Keys plus short values (240 characters each, nested objects as key lists, 2 KB in all) —
   * the record's audit view, and the card's fallback when `input` is absent.
   */
  inputSummary?: Record<string, any>
  lane?: 'api' | 'cli' | 'service'
}

export interface ToolApprovalEntry {
  approvalId: string
  status: ToolApprovalStatus
  submitted?: boolean
  requestedAt?: string
  expiresAt?: string
  expiredAt?: string
  toolName?: string
  toolCall?: Record<string, any>
  input?: any
  source?: 'vercel' | 'claude' | 'fabric'
  /** SA-116: set only for a risky control/CLI-tool pause. */
  control?: ToolApprovalControl
}

export interface ToolApprovalSummary {
  mode: ToolApprovalMode
  approvals: ToolApprovalEntry[]
  source?: 'vercel' | 'claude' | 'fabric'
}

export interface ToolApprovalResponse {
  type: 'tool-approval-response'
  approvalId: string
  approved: boolean
  reason?: string
}
