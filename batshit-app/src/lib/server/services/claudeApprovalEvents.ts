/**
 * BL-496 — what the server does with a Claude approval card's events.
 *
 * The permission helper (`scripts/claude-permission-mcp.cjs`) publishes three events on the
 * chat's Redis channel for one card: `tool_start` (no arguments), `tool-call` (the real tool,
 * its input, and the card's clock), and at the end `tool-result` (the answer, or an expiry
 * with its reason). The server's own Redis subscriber (`sseExternalSubscriber.ts`) hands every
 * session event here BEFORE any tab sees it, so the card is known to the server whether or
 * not a tab watches the chat:
 *
 *   - `tool-call` records the card in `claudeApprovalRegistry.ts`, and when the card belongs
 *     to a woken turn, marks that turn's DM "needs you" at once (A4);
 *   - `tool-result` settles it, and takes back the mark only if this card set it.
 *
 * The functions below also build what a tab and the saved reply read from the registry: the
 * events a joining tab replays, and the reply's `metadata.toolApprovals` summary.
 */

import type { ToolApprovalEntry, ToolApprovalSummary } from '$lib/types/tool-approvals'
import {
  endClaudeApprovalRun,
  hasWaitingClaudeApproval,
  listClaudeApprovals,
  listClaudeApprovalsForSession,
  recordClaudeApprovalCard,
  setClaudeApprovalWakeMark,
  settleClaudeApproval,
  type ClaudeApprovalExpiryReason,
  type ClaudeApprovalRecord
} from '$lib/server/services/claudeApprovalRegistry'
import { getWakeRun, isWokenTurnMessage } from '$lib/server/services/wakeRunRegistry'

/** The helper's tool name, as `+page.svelte` recognises it (`isClaudeApprovalTool`). */
export const CLAUDE_APPROVAL_TOOL_SLUG = 'batshit_permission_prompt'
/** The full name the helper publishes its events under (its `APPROVAL_TOOL_FULL_NAME`). */
export const CLAUDE_APPROVAL_EVENT_TOOL_NAME =
  'mcp__batshit_gateway_claude-approvals__batshit_permission_prompt'

type ApprovalEvent = { type: string; [key: string]: any }

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function isClaudeApprovalEvent(payload: unknown): payload is ApprovalEvent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const event = payload as ApprovalEvent
  if (event.type !== 'tool_start' && event.type !== 'tool-call' && event.type !== 'tool-result') {
    return false
  }
  return trimmed(event.toolName).toLowerCase().includes(CLAUDE_APPROVAL_TOOL_SLUG)
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** A card the tabs can show: the real tool and its input, with the card's own clock. */
function readCard(sessionId: string, event: ApprovalEvent) {
  const args = event.args && typeof event.args === 'object' ? (event.args as ApprovalEvent) : null
  const approvalId = trimmed(args?.approvalId) || trimmed(event.toolCallId)
  const messageId = trimmed(event.messageId)
  const toolName = trimmed(args?.toolName)
  if (!approvalId || !messageId || !toolName) return null
  if (!isIsoTime(event.requestedAt) || !isIsoTime(event.expiresAt)) return null
  return {
    sessionId,
    messageId,
    approvalId,
    toolName,
    input: args?.toolInput ?? {},
    toolUseId: trimmed(args?.toolUseId) || null,
    requestedAt: event.requestedAt,
    expiresAt: event.expiresAt
  }
}

/** The answer a `tool-result` carries: the helper says it in `approvalStatus`. */
function readOutcome(event: ApprovalEvent): {
  status: 'approved' | 'denied' | 'expired'
  expiryReason?: ClaudeApprovalExpiryReason
} {
  if (event.approvalStatus === 'expired') {
    const reason = event.expiryReason
    return {
      status: 'expired',
      expiryReason: reason === 'run_ended' || reason === 'wait_failed' ? reason : 'unanswered'
    }
  }
  if (event.approvalStatus === 'approved') return { status: 'approved' }
  if (event.approvalStatus === 'denied') return { status: 'denied' }
  // A helper from before BL-496 says it only in the result's behavior.
  const behavior = event.result && typeof event.result === 'object' ? event.result.behavior : null
  return { status: behavior === 'allow' ? 'approved' : 'denied' }
}

function describeTool(toolName: string) {
  return toolName.length > 80 ? `${toolName.slice(0, 77)}...` : toolName
}

/**
 * The DM stamp and its take-back run in order per card: a card answered in the moment its
 * stamp is still being written must not look for a mark that is not there yet.
 */
const wakeMarkWork = new Map<string, Promise<void>>()

function chainWakeMarkWork(sessionId: string, approvalId: string, work: () => Promise<void>) {
  const key = `${sessionId}::${approvalId}`
  const next = (wakeMarkWork.get(key) ?? Promise.resolve())
    .then(work)
    .catch((error) => {
      console.warn('[ClaudeApprovals] Could not update the woken DM for an approval card:', error)
    })
    .finally(() => {
      if (wakeMarkWork.get(key) === next) wakeMarkWork.delete(key)
    })
  wakeMarkWork.set(key, next)
  return next
}

function stampWakeForCard(record: ClaudeApprovalRecord) {
  // BL-505's rule: only the woken RUN itself, by its reply id; other runs share the chat.
  if (!isWokenTurnMessage(record.sessionId, record.messageId)) return
  const wakeRun = getWakeRun(record.sessionId)
  const dmId = trimmed(wakeRun?.origin?.dmId)
  if (!wakeRun || !dmId) return
  return chainWakeMarkWork(record.sessionId, record.approvalId, async () => {
    // Dynamic import, as `controlApprovals.ts` does: the DM store stays off this graph.
    const { stampDmNeedsUser } = await import('$lib/server/services/dm/dmStore')
    const at = await stampDmNeedsUser(
      dmId,
      `This chat is waiting for you to approve ${describeTool(record.toolName)}.`,
      { turnStartedAt: wakeRun.reservedAt ?? wakeRun.startedAt }
    )
    if (at) setClaudeApprovalWakeMark(record.sessionId, record.approvalId, { dmId, at, userId: wakeRun.userId })
  })
}

/**
 * The card ended: take back its mark, unless the chat still waits on the user. `stampDmNeedsUser`
 * keeps the FIRST mark of a turn, so a second Claude card or a risky-control pause that came
 * while this card's mark stood stamped nothing and relies on this one. A Claude card of the chat
 * that still waits takes the mark over (its own end clears it later); a pending control pause
 * keeps it (the user's click in that chat clears it, as for any control pause).
 */
function takeBackWakeMark(sessionId: string, approvalId: string, readMark: () => ClaudeApprovalRecord['wakeMark']) {
  return chainWakeMarkWork(sessionId, approvalId, async () => {
    const mark = readMark()
    if (!mark) return
    if (hasWaitingClaudeApproval(sessionId)) {
      const heir = listClaudeApprovalsForSession(sessionId).find(
        (record) => record.approvalId !== approvalId && record.status === 'pending' && record.runEndedAt === null
      )
      if (heir) {
        // An heir with its own mark keeps it: this card's mark was already cleared (a human
        // reply), and the heir stamped after that. Only an heir with no mark inherits this one.
        if (!heir.wakeMark) setClaudeApprovalWakeMark(sessionId, heir.approvalId, mark)
        return
      }
    }
    // A read that fails throws into `chainWakeMarkWork`'s catch: the mark is kept, never
    // cleared on a guess.
    const { listSessionApprovals } = await import('$lib/server/services/controlApprovals')
    const pauses = await listSessionApprovals(sessionId, mark.userId)
    if (pauses.some((pause) => pause.status === 'pending')) return
    const { clearDmNeedsUserStamp } = await import('$lib/server/services/dm/dmStore')
    await clearDmNeedsUserStamp(mark.dmId, mark.at)
  })
}

function currentWakeMark(sessionId: string, messageId: string, approvalId: string) {
  return listClaudeApprovals(sessionId, messageId).find((record) => record.approvalId === approvalId)?.wakeMark ?? null
}

/**
 * One event from the chat's Redis channel. Synchronous for the registry, so the event order
 * the subscriber sees is the order the registry sees; the DM work runs after, in its own order.
 * Returns true when the event was a Claude approval event.
 */
export function noteClaudeApprovalEvent(sessionId: string, payload: unknown): boolean {
  if (!isClaudeApprovalEvent(payload)) return false
  const event = payload as ApprovalEvent
  if (event.type === 'tool-call') {
    const card = readCard(sessionId, event)
    if (!card) return true
    const { record, created } = recordClaudeApprovalCard(card)
    if (created) void stampWakeForCard(record)
    return true
  }
  if (event.type === 'tool-result') {
    const approvalId = trimmed(event.toolCallId)
    if (!approvalId) return true
    const settled = settleClaudeApproval(sessionId, approvalId, readOutcome(event))
    if (settled) {
      void takeBackWakeMark(sessionId, approvalId, () =>
        currentWakeMark(sessionId, settled.messageId, approvalId)
      )
    }
  }
  return true
}

/**
 * The run that raised a reply's cards ended (the bridge's cleanup). A card still waiting ends
 * with it, and every mark these cards set is taken back.
 */
export async function endClaudeApprovalRunForReply(sessionId: string, messageId: string): Promise<void> {
  const ended = endClaudeApprovalRun(sessionId, messageId)
  await Promise.all(
    ended.map((record) =>
      takeBackWakeMark(sessionId, record.approvalId, () =>
        currentWakeMark(sessionId, messageId, record.approvalId)
      )
    )
  )
}

/** The card as a stored `metadata.toolApprovals` entry, in the shape the page builds. */
export function toClaudeApprovalEntry(record: ClaudeApprovalRecord): ToolApprovalEntry {
  return {
    approvalId: record.approvalId,
    status: record.status,
    submitted: record.status !== 'pending',
    requestedAt: record.requestedAt,
    expiresAt: record.expiresAt,
    ...(record.status === 'expired' && record.decidedAt ? { expiredAt: record.decidedAt } : {}),
    ...(record.expiryReason ? { expiryReason: record.expiryReason } : {}),
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    toolName: record.toolName,
    toolCall: { toolName: record.toolName, input: record.input },
    input: record.input,
    source: 'claude'
  }
}

/** The reply's Claude cards as its `metadata.toolApprovals`, or null when it raised none (A1). */
export function buildClaudeApprovalSummary(sessionId: string, messageId: string): ToolApprovalSummary | null {
  const records = listClaudeApprovals(sessionId, messageId)
  if (records.length === 0) return null
  return { mode: 'all', source: 'claude', approvals: records.map(toClaudeApprovalEntry) }
}

/**
 * A reply's cards as ONE summary (BL-496, BL-775): its other cards (SDK, Fabric) and its Claude
 * cards, joined by approval id, the server's record of a Claude card winning over an older copy
 * of the same id. send-routed's finalize writes it into the record it saves, while the registry
 * still holds the cards, so an unwatched Claude reply keeps its cards.
 */
export function joinApprovalSummaries(existing: any, claude: ToolApprovalSummary): ToolApprovalSummary {
  if (!existing || typeof existing !== 'object' || !Array.isArray(existing.approvals)) return claude
  const claudeById = new Map(claude.approvals.map((entry: any) => [entry.approvalId, entry]))
  const approvals = existing.approvals.map((entry: any) => claudeById.get(entry?.approvalId) ?? entry)
  const seen = new Set(existing.approvals.map((entry: any) => entry?.approvalId))
  for (const entry of claude.approvals) if (!seen.has((entry as any).approvalId)) approvals.push(entry)
  return { ...existing, approvals }
}

/**
 * The events a tab that joins the chat needs to draw a card the replay buffer does not hold:
 * the card, and its answer when it has one. The same shapes the helper publishes.
 */
export function buildClaudeApprovalReplayEvents(record: ClaudeApprovalRecord): ApprovalEvent[] {
  const base = {
    sessionId: record.sessionId,
    messageId: record.messageId,
    toolCallId: record.approvalId,
    toolName: CLAUDE_APPROVAL_EVENT_TOOL_NAME
  }
  const events: ApprovalEvent[] = [
    {
      type: 'tool-call',
      ...base,
      args: {
        approvalId: record.approvalId,
        toolName: record.toolName,
        toolInput: record.input,
        ...(record.toolUseId ? { toolUseId: record.toolUseId } : {})
      },
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt
    }
  ]
  if (record.status !== 'pending') {
    events.push({
      type: 'tool-result',
      ...base,
      approvalStatus: record.status,
      ...(record.expiryReason ? { expiryReason: record.expiryReason } : {}),
      result: { behavior: record.status === 'approved' ? 'allow' : 'deny' }
    })
  }
  return events
}
