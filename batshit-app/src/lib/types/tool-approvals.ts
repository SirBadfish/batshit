export type ToolApprovalMode = 'off' | 'all'

export type ToolApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

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
  source?: 'vercel' | 'claude'
}

export interface ToolApprovalSummary {
  mode: ToolApprovalMode
  approvals: ToolApprovalEntry[]
  source?: 'vercel' | 'claude'
}

export interface ToolApprovalResponse {
  type: 'tool-approval-response'
  approvalId: string
  approved: boolean
  reason?: string
}
