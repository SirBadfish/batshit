/**
 * SA-116 F-P2-3 — the server's view of the approval cards a chat is carrying.
 *
 * Lifted out of `send-routed/+server.ts` unchanged except for the lane rule below, because
 * a `+server.ts` may only export HTTP handlers: there was no way to test the stale sweep
 * where it lived, and it is the one place that can silently retire a card the user is still
 * looking at.
 *
 * ## The lane rule (F-P2-3)
 *
 * A Bash approval and an API-lane control approval both live inside a paused SDK stream.
 * That stream cannot wait forever, so the card gets three minutes and the sweep marks
 * anything older `expired`.
 *
 * A CLI-lane control approval is not inside anything. The managed agent's refusal already
 * came back, the turn already finished, and the card is answered by a *later* turn
 * (DL-116-08) — so its record deliberately lives 24 hours. P2 taught the CLIENT that rule
 * (`resolveApprovalExpiryMs` returns null for a non-`api` lane, and the card says "Waits for
 * you") but not the server, so the first send three minutes after a CLI pause would have
 * marked the entry AND retired its record while the card still said it was waiting.
 *
 * `control.lane` is written by the server where the entry is persisted and is never read
 * from a client, so skipping on it cannot be used to make a card immortal: an entry with no
 * `control` block at all — every Bash approval — keeps the three-minute clock exactly as
 * before.
 */

import type { ToolApprovalEntry } from '$lib/types/tool-approvals'
import type { ControlApprovalRequest } from './controlApprovals'

export const TOOL_APPROVAL_TIMEOUT_MS = 180_000
export const TOOL_APPROVAL_TIMEOUT_SECONDS = TOOL_APPROVAL_TIMEOUT_MS / 1000

export type ApprovalHistoryMessage = {
  id?: string
  created_at?: string
  timestamp?: string
  metadata?: Record<string, any> | null
}

export type ApprovalStateRecord = {
  approvalId: string
  status: ToolApprovalEntry['status']
  toolName?: string
  expiresAt?: string
  expiresAtMs: number | null
  messageId?: string
}

export type ApprovalStateSnapshot = {
  byId: Map<string, ApprovalStateRecord>
  newlyExpired: Array<{
    approvalId: string
    toolName?: string
    expiredAt: string
    timeoutSeconds: number
    /** SA-116: the `apr_…` record behind a Fabric card, so the sweep can retire it too. */
    controlApprovalId?: string
  }>
  updates: Array<{
    messageId: string
    metadata: Record<string, any>
  }>
}

export function parseApprovalTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeApprovalStatus(value: unknown): ToolApprovalEntry['status'] {
  if (value === 'approved' || value === 'denied' || value === 'expired') return value
  return 'pending'
}

export function extractApprovalToolName(entry: Record<string, any>): string | undefined {
  const direct = typeof entry.toolName === 'string' ? entry.toolName.trim() : ''
  if (direct) return direct

  const toolCall = entry.toolCall
  if (toolCall && typeof toolCall === 'object') {
    const nestedName =
      typeof (toolCall as any).toolName === 'string'
        ? (toolCall as any).toolName.trim()
        : typeof (toolCall as any).tool_name === 'string'
          ? (toolCall as any).tool_name.trim()
          : ''
    if (nestedName) return nestedName
  }

  return undefined
}

/**
 * F-P2-3 — does this entry's card run on a three-minute clock?
 *
 * Only a control pause carries `control.lane`; a Bash approval has no `control` block and
 * therefore keeps the clock. `api` is the paused-SDK lane and keeps it too.
 */
export function approvalEntryExpires(entry: Record<string, any> | null | undefined): boolean {
  const lane = (entry as any)?.control?.lane
  if (typeof lane !== 'string' || lane.trim().length === 0) return true
  return lane.trim() === 'api'
}

/**
 * F-P3-1 (Faye, P3 review) — may a pause that arrived as a tool RESULT become a card?
 *
 * Only off the API lane. On that lane a card is answered by the in-place SDK resume, which
 * re-executes the SDK call it paused — and a tool-result pause is not one of those: the
 * call already ran, so no `tool-approval-request` part exists for it, and a
 * `tool-approval-response` naming its `apr_` id makes `ai@7.0.77` throw
 * `InvalidToolApprovalError` for the whole click (a real SDK card answered at the same time
 * fails with it). `useControl` and `executeCliTool` answer `lane: 'api'` for a mode3 call,
 * so this is exactly the case where the SDK policy let a risky call through and the gate
 * then paused it (a transient read failure in the resolver, an artifact alias only the gate
 * could settle). That pause stays what P2 shipped: a tool-result hint the model relays; the
 * next attempt pauses at the policy and earns a card the SDK can answer.
 *
 * A `cli` or `service` card is answered by a resume TURN, which needs no SDK part at all.
 */
export function toolResultApprovalRendersCard(request: ControlApprovalRequest): boolean {
  return request.lane !== 'api'
}

export function buildApprovalHistoryMessages(
  requestMessages: unknown,
  persistedMessages: unknown,
): ApprovalHistoryMessage[] {
  const byId = new Map<string, ApprovalHistoryMessage>()
  const insertionOrder: string[] = []
  const idless: ApprovalHistoryMessage[] = []

  const register = (raw: unknown, preferExisting = false) => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, any>
    const messageId = typeof message.id === 'string' ? message.id : ''
    const normalized: ApprovalHistoryMessage = {
      ...(messageId ? { id: messageId } : {}),
      ...(typeof message.created_at === 'string'
        ? { created_at: message.created_at }
        : {}),
      ...(typeof message.timestamp === 'string'
        ? { timestamp: message.timestamp }
        : {}),
      metadata:
        message.metadata && typeof message.metadata === 'object'
          ? (message.metadata as Record<string, any>)
          : undefined,
    }

    if (!messageId) {
      idless.push(normalized)
      return
    }

    const existing = byId.get(messageId)
    if (!existing) {
      byId.set(messageId, normalized)
      insertionOrder.push(messageId)
      return
    }

    if (preferExisting) {
      const existingApprovalCount = countApprovalEntries(existing.metadata)
      const incomingApprovalCount = countApprovalEntries(normalized.metadata)
      if (existingApprovalCount > 0 || incomingApprovalCount === 0) {
        return
      }
    }

    byId.set(messageId, {
      ...existing,
      ...normalized,
      metadata: normalized.metadata ?? existing.metadata,
    })
  }

  if (Array.isArray(persistedMessages)) {
    for (const message of persistedMessages) {
      register(message)
    }
  }

  if (Array.isArray(requestMessages)) {
    for (const message of requestMessages) {
      register(message, true)
    }
  }

  const combined = [
    ...insertionOrder.map((id) => byId.get(id)).filter(Boolean),
    ...idless,
  ] as ApprovalHistoryMessage[]

  combined.sort((a, b) => {
    const aMs = parseApprovalTimestampMs(a.created_at ?? a.timestamp)
    const bMs = parseApprovalTimestampMs(b.created_at ?? b.timestamp)
    if (aMs === null && bMs === null) return 0
    if (aMs === null) return 1
    if (bMs === null) return -1
    return aMs - bMs
  })

  return combined
}

function countApprovalEntries(metadata: unknown): number {
  if (!metadata || typeof metadata !== 'object') return 0
  const summary = (metadata as Record<string, any>).toolApprovals
  if (!summary || typeof summary !== 'object') return 0
  const approvals = (summary as Record<string, any>).approvals
  return Array.isArray(approvals) ? approvals.length : 0
}

export function analyzeApprovalState(
  messages: ApprovalHistoryMessage[],
  nowMs = Date.now(),
): ApprovalStateSnapshot {
  const byId = new Map<string, ApprovalStateRecord>()
  const newlyExpired: ApprovalStateSnapshot['newlyExpired'] = []
  const updates: ApprovalStateSnapshot['updates'] = []
  const nowIso = new Date(nowMs).toISOString()

  for (const message of messages) {
    const metadata =
      message.metadata && typeof message.metadata === 'object'
        ? (message.metadata as Record<string, any>)
        : null
    const summary =
      metadata?.toolApprovals && typeof metadata.toolApprovals === 'object'
        ? (metadata.toolApprovals as Record<string, any>)
        : null
    if (!summary) continue

    const approvals = Array.isArray(summary.approvals) ? summary.approvals : []
    if (approvals.length === 0) continue

    const messageCreatedAtMs = parseApprovalTimestampMs(
      message.created_at ?? message.timestamp,
    )
    let nextApprovals: any[] | null = null

    for (let idx = 0; idx < approvals.length; idx += 1) {
      const rawEntry = approvals[idx]
      if (!rawEntry || typeof rawEntry !== 'object') continue

      const entry = rawEntry as Record<string, any>
      const approvalId =
        typeof entry.approvalId === 'string' ? entry.approvalId.trim() : ''
      if (!approvalId) continue

      const expires = approvalEntryExpires(entry)
      const requestedAtMs = parseApprovalTimestampMs(entry.requestedAt)
      const fallbackRequestedAtMs = requestedAtMs ?? messageCreatedAtMs
      const explicitExpiresAtMs = parseApprovalTimestampMs(entry.expiresAt)
      const expiresAtMs = !expires
        ? null
        : (explicitExpiresAtMs ??
          (fallbackRequestedAtMs !== null
            ? fallbackRequestedAtMs + TOOL_APPROVAL_TIMEOUT_MS
            : null))

      const requestedAt =
        requestedAtMs !== null
          ? new Date(requestedAtMs).toISOString()
          : fallbackRequestedAtMs !== null
            ? new Date(fallbackRequestedAtMs).toISOString()
            : undefined
      const expiresAt =
        expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : undefined

      let status = normalizeApprovalStatus(entry.status)
      let expiredAt =
        parseApprovalTimestampMs(entry.expiredAt) !== null
          ? new Date(parseApprovalTimestampMs(entry.expiredAt) as number).toISOString()
          : undefined
      let changed = false

      if (status === 'pending' && expiresAtMs !== null && nowMs >= expiresAtMs) {
        status = 'expired'
        expiredAt = nowIso
        changed = true
        newlyExpired.push({
          approvalId,
          toolName: extractApprovalToolName(entry),
          expiredAt: nowIso,
          timeoutSeconds: TOOL_APPROVAL_TIMEOUT_SECONDS,
          ...(typeof entry.control?.approvalId === 'string' &&
          entry.control.approvalId.trim().length > 0
            ? { controlApprovalId: entry.control.approvalId.trim() }
            : {}),
        })
      }

      if (!entry.requestedAt && requestedAt) changed = true
      if (!entry.expiresAt && expiresAt) changed = true
      if (entry.status !== status) changed = true
      if (status === 'expired' && !entry.expiredAt && expiredAt) changed = true

      const normalizedEntry = changed
        ? {
            ...entry,
            status,
            ...(status === 'expired' ? { submitted: false } : {}),
            ...(requestedAt ? { requestedAt } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            ...(status === 'expired' && expiredAt ? { expiredAt } : {}),
          }
        : entry

      if (changed) {
        if (!nextApprovals) {
          nextApprovals = [...approvals]
        }
        nextApprovals[idx] = normalizedEntry
      }

      byId.set(approvalId, {
        approvalId,
        status,
        toolName: extractApprovalToolName(normalizedEntry),
        expiresAt,
        expiresAtMs,
        messageId: typeof message.id === 'string' ? message.id : undefined,
      })
    }

    if (
      nextApprovals &&
      typeof message.id === 'string' &&
      message.id.trim().length > 0
    ) {
      updates.push({
        messageId: message.id.trim(),
        metadata: {
          ...(metadata ?? {}),
          toolApprovals: {
            ...summary,
            approvals: nextApprovals,
          },
        },
      })
    }
  }

  return { byId, newlyExpired, updates }
}

/* ------------------------------------------------------------------ *
 * SA-116 DL-116-07 — a pause that arrives as a tool RESULT
 * ------------------------------------------------------------------ */

/**
 * The card block a paused control puts in its refusal, if this tool result carries one.
 *
 * On the API lane the AI SDK pauses the broker tool BEFORE it runs, so the card comes from
 * a `tool-approval-request` part. On the managed CLI lanes nothing can pause a helper call
 * that has already been made: the gate refuses it, and the refusal comes back as an ordinary
 * tool RESULT. This reads that refusal so send-routed's one `case 'tool-result'` loop — the
 * one every lane feeds — can persist the same card entry, with no tab open.
 *
 * Two shapes, both from the same server:
 *   - `/api/controls/use` lifts the block to the top level of its 403 body;
 *   - `executeCliTool` returns it on the result object for a `cli:` ref.
 * `error.details.approvalRequest` is read as well, because that is where `useControl` puts
 * it and a future caller may forward the error verbatim.
 *
 * Shape-validated rather than trusted: a tool result is model-adjacent text on some lanes,
 * and a card is a request for the user's consent. An id that is not `apr_…` is refused
 * outright, so nothing here can invent a record.
 */
export function readControlApprovalRequestFromToolResult(
  payload: unknown
): ControlApprovalRequest | null {
  const candidates: unknown[] = []
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return
    const record = value as Record<string, any>
    if (record.approvalRequest) candidates.push(record.approvalRequest)
    visit(record.error, depth + 1)
    visit(record.details, depth + 1)
    visit(record.result, depth + 1)
    // A managed CLI helper's answer arrives as the raw MCP envelope — measured on BSMS:
    // `{ content: [{ type: 'text', text: '<the json>' }], structured_content, input }`.
    // `normalizeToolResult` only unwraps that shape when the envelope IS the array, so on
    // this lane the body is still a STRING inside `content[]` when the capture runs.
    visit(record.structured_content, depth + 1)
    visit(record.structuredContent, depth + 1)
    if (Array.isArray(record.content)) {
      for (const part of record.content.slice(0, 8)) {
        if (!part || typeof part !== 'object') continue
        const text = (part as Record<string, any>).text
        // The substring test keeps this off the hot path: every ordinary tool result on
        // every CLI turn passes through here, and only a pause carries the block.
        if (typeof text !== 'string' || !text.includes('"approvalRequest"')) continue
        try {
          visit(JSON.parse(text), depth + 1)
        } catch {
          // Not JSON, or truncated. A card we cannot read is a card that does not render,
          // which the route's own "no card can render" log already covers.
        }
      }
    }
  }
  visit(payload, 0)

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const block = candidate as Record<string, any>
    const approvalId = typeof block.approvalId === 'string' ? block.approvalId.trim() : ''
    const controlId = typeof block.controlId === 'string' ? block.controlId.trim() : ''
    const riskLevel = block.riskLevel
    // `apr_` + base64url, the same rule `isWellFormedApprovalId` enforces. Restated as a
    // literal here rather than imported, because this module must stay free of the Redis
    // edge `controlApprovals.ts` carries — `controlApprovals.test.ts` pins them equal.
    if (!/^apr_[A-Za-z0-9_-]{1,64}$/.test(approvalId)) continue
    if (!controlId) continue
    if (riskLevel !== 'confirm' && riskLevel !== 'restricted') continue

    const controlTitle =
      typeof block.controlTitle === 'string' && block.controlTitle.trim().length > 0
        ? block.controlTitle.trim()
        : controlId
    const lane =
      block.lane === 'api' || block.lane === 'cli' || block.lane === 'service'
        ? block.lane
        : 'cli'

    return {
      approvalId,
      controlId,
      controlTitle,
      riskLevel,
      ...(block.input && typeof block.input === 'object' && !Array.isArray(block.input)
        ? { input: block.input as Record<string, any> }
        : {}),
      inputSummary:
        block.inputSummary && typeof block.inputSummary === 'object' && !Array.isArray(block.inputSummary)
          ? (block.inputSummary as Record<string, any>)
          : {},
      lane,
      requestedAt:
        typeof block.requestedAt === 'string' && block.requestedAt.trim().length > 0
          ? block.requestedAt.trim()
          : new Date().toISOString(),
      ...(typeof block.toolCallId === 'string' && block.toolCallId.trim().length > 0
        ? { toolCallId: block.toolCallId.trim() }
        : {})
    }
  }

  return null
}

/**
 * The card entry a CLI-lane (or service-lane) pause persists, built from its request block.
 *
 * The API lane's entry is keyed on the SDK's `aitxt-…` id with the record's `apr_…` id in
 * `control.approvalId`. This lane has no SDK id, so the entry id IS the record id — and
 * that is still safe for the same reason it is there: the resume never lets a POSTed id
 * name a record, it looks the ENTRY up on the persisted assistant message and reads
 * `control.approvalId` off that.
 *
 * No `expiresAt`: this card is answered by a later turn, so it does not run on the
 * three-minute clock (F-P2-3, and `approvalEntryExpires` above is the server half).
 */
export function buildControlApprovalEntry(options: {
  request: ControlApprovalRequest
  toolCallId?: string | null
  toolName?: string | null
}): ToolApprovalEntry {
  const request = options.request
  const toolCallId =
    (typeof options.toolCallId === 'string' ? options.toolCallId.trim() : '') ||
    (typeof request.toolCallId === 'string' ? request.toolCallId.trim() : '')
  const toolName =
    typeof options.toolName === 'string' && options.toolName.trim().length > 0
      ? options.toolName.trim()
      : 'native_batshit_tool_use'

  return {
    approvalId: request.approvalId,
    status: 'pending',
    requestedAt: request.requestedAt,
    toolName,
    ...(toolCallId ? { toolCall: { type: 'tool-call', toolCallId, toolName } } : {}),
    source: 'fabric',
    control: {
      approvalId: request.approvalId,
      controlId: request.controlId,
      controlTitle: request.controlTitle,
      // `readControlApprovalRequestFromToolResult` refuses anything but these two, and a
      // `safe` control never reaches the gate — the narrowing is a fact, not a cast of hope.
      riskLevel: request.riskLevel as 'confirm' | 'restricted',
      ...(request.input ? { input: request.input } : {}),
      inputSummary: request.inputSummary,
      lane: request.lane
    }
  }
}

/**
 * The one coarse `source` label a whole message's approval summary carries.
 *
 * It is a FALLBACK for entries that do not name their own source; the click routes on the
 * entry first (`ChatMessage.svelte`). Derived rather than hard-coded so a turn whose only
 * cards are control pauses does not describe itself as an SDK pause.
 */
export function resolveApprovalSummarySource(
  entries: ToolApprovalEntry[]
): 'vercel' | 'fabric' {
  if (entries.length === 0) return 'vercel'
  return entries.every((entry) => entry?.source === 'fabric') ? 'fabric' : 'vercel'
}
