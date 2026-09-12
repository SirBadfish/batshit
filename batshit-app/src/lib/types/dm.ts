/**
 * SA-113 P2 (DL-113-02) — the Agent DM record, as stored.
 *
 * This is the team mailbox's envelope with the parts a single-user Redis app does not
 * need removed (Ed25519 signing, trusted hosts, receipts, offline cache, outbox,
 * quarantine — all of which exist only because two machines share an SMB folder) and the
 * two things that mailbox is missing added: an expiry, and a one-assignment-at-a-time rule
 * that is enforced in code rather than described in a README.
 *
 * Browser-safe on purpose: the P4 inbox drawer reads these shapes.
 */

/** `info` = read and acknowledge. `assignment` = do this and report back. `result` = the outcome. */
export const DM_KINDS = ['info', 'assignment', 'result'] as const
export type DmKind = (typeof DM_KINDS)[number]

export const DM_PRIORITIES = ['normal', 'urgent'] as const
export type DmPriority = (typeof DM_PRIORITIES)[number]

/**
 * `new → working → done | blocked`, with `expired` as the reaper's terminal state.
 * Terminal is terminal: no un-claim and no reopen from the agent side (the user may
 * reopen from the drawer, which is a user act, not an agent one).
 */
export const DM_STATUSES = ['new', 'working', 'done', 'blocked', 'expired'] as const
export type DmStatus = (typeof DM_STATUSES)[number]

export const DM_OPEN_STATUSES: readonly DmStatus[] = ['new', 'working']

export type DmSender =
  | { kind: 'agent'; agentId: string; name: string }
  /** P3's wake-up webhook. The name is the hook's, frozen at send time. */
  | { kind: 'webhook'; hookId: string; name: string }
  /**
   * SA-115: Batshit's own clock. The name is the schedule's, frozen at fire time, so a
   * renamed or deleted schedule still reads correctly in an old inbox row.
   */
  | { kind: 'schedule'; scheduleId: string; name: string }

/** What actually happened to a `deliver: 'wake'` request, and why if it changed. */
export interface DmDeliveryRecord {
  requested: 'wait' | 'wake'
  actual: 'wait' | 'wake'
  reason?: string
  /** The session the wake-up ran in, when one started. */
  sessionId?: string
  /** How that woken turn ended, once it did (`WakeRunEndReason`). */
  outcome?: string
  /**
   * SA-113 F-SEC-1b — this woken turn stopped on something only the USER can clear: the
   * F-SEC-1 refusal of a risky Fabric control, or a Bash/MCP approval pause. Without it a
   * stalled woken chat is indistinguishable from a working one — the agent's last message
   * explains, but nothing tells the user to go look.
   *
   * Its own field rather than `outcome`, which the P5b spec first suggested: `outcome` is
   * the run-end reason and `finishWokenTurn` writes it when the turn ends, so a
   * `needs_user` written there by `useControl` mid-turn would be overwritten seconds later
   * by `completed`. The two facts are also both wanted at once — the drawer shows how the
   * turn ended AND that it needs you.
   *
   * Cleared when the DM closes or the user replies in the chat it started.
   */
  needsUser?: { reason: string; at: string }
}

export interface DmRecord {
  id: string
  /** Shared across every recipient of one broadcast; equal to `id` for a single send. */
  messageId: string
  userId: string
  kind: DmKind
  priority: DmPriority
  from: DmSender
  /** The recipient agent id. DMs are agent-scoped, never session-scoped. */
  to: string
  subject: string
  body: string

  /** Required on an `assignment`. */
  requestedOutcome?: string
  scope?: string
  /** Agent id the result goes back to. A first-class field, not an implied reply-to. */
  reportBackTo?: string

  /** Required on a `result`: the assignment this answers. */
  relatedDmId?: string

  deliver: 'wait' | 'wake'
  /** `assignment` only: how the eventual `result` is delivered. Default `wait`. */
  resultDelivery?: 'wait' | 'wake'

  status: DmStatus
  claimedBy?: { agentId: string; sessionId: string | null }
  claimedAt?: string
  completedAt?: string
  /** Required to close: `done` and `blocked` both need a real result text. */
  result?: string

  createdAt: string
  createdTs: number
  expiresAt: string

  delivery: DmDeliveryRecord

  /** Where the send happened, so the drawer can link back. */
  senderSessionId?: string | null
  senderMessageId?: string | null

  /** P3: the wake-up webhook's one-shot result callback. */
  callbackUrl?: string
  callbackStatus?: string

  /** Set when a closing DM has already created its `result`, so a retry cannot double it. */
  resultDmId?: string
}

/** The summary shape `sys.dm.list` returns and the roster is built from. */
export interface DmSummary {
  id: string
  kind: DmKind
  priority: DmPriority
  status: DmStatus
  from: DmSender
  to: string
  subject: string
  createdAt: string
  expiresAt: string
  claimedSessionId?: string | null
  relatedDmId?: string
}

export function toDmSummary(record: DmRecord): DmSummary {
  return {
    id: record.id,
    kind: record.kind,
    priority: record.priority,
    status: record.status,
    from: record.from,
    to: record.to,
    subject: record.subject,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    claimedSessionId: record.claimedBy?.sessionId ?? null,
    ...(record.relatedDmId ? { relatedDmId: record.relatedDmId } : {})
  }
}

export function isOpenDmStatus(status: DmStatus): boolean {
  return DM_OPEN_STATUSES.includes(status)
}
