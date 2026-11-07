import { withP5PendingWriteObservation, type P5PendingApprovalWrite as ApiPendingWrite, type P5ApprovalDecisionWrite as ApiDecisionWrite } from './controlApprovals'
import type { P5ApiOriginalRun } from './appActions/mcp/originalTask'
/**
 * SA-116 P2 (DL-116-05, DL-116-06, AMD-116-01, F-P1-4) — the two ends of an API-lane
 * approval, in one place.
 *
 * The API lane rides the Bash approval machinery unchanged: the AI SDK pauses the broker
 * tool before it runs, send-routed persists a card entry on the assistant message, the user
 * clicks, and the SDK re-executes the very same call. This module owns the two server-side
 * halves that machinery does not already have:
 *
 *  1. `attachControlApprovalRecords` — where the card entry is persisted, create the ONE
 *     pending `control_approval` record it names. AMD-116-01 measured why it cannot live in
 *     the `toolApproval` policy: the SDK asks the policy AGAIN on the approval resume, for
 *     the same call id, so a policy that wrote would write twice for one call.
 *
 *  2. `resolveApprovalResumeGrants` — turn the click into the grant the run spends, read
 *     from the PERSISTED assistant message rather than from the POST body.
 *
 * ## The two ids, and why both exist
 *
 * The AI SDK mints approval ids like `aitxt-…`. An approval RECORD id is `apr_` + random,
 * and `isWellFormedApprovalId` rightly refuses anything else — a record id is ours, and
 * nothing a model or a browser sends may become one. So the card entry carries both: its
 * own `approvalId` is the SDK's (that is what the browser posts back in
 * `metadata.toolApprovalResponse`), and `entry.control.approvalId` is the record's.
 *
 * The resume reads the mapping off the PERSISTED message, never off the POST. The browser
 * is told the SDK id; if it could also name the `apr_` record to spend, the click would stop
 * being the thing that decides which consent gets used.
 *
 * ## Why the record id is derived, not random
 *
 * `apr_` + the first 22 base64url characters of sha256(`{sessionId}:{sdkApprovalId}`).
 * Deriving it makes "one record per approval id" a property of the id itself rather than a
 * rule every caller has to remember, and `createPendingApproval` already returns the
 * existing record untouched for a supplied id it has seen (under the per-approval lock,
 * F-P1-4). An `apr_` id is not a capability: no route accepts one from a client, and
 * `decideApproval` additionally checks the record's `userId` against the session's.
 */

import { createHash } from 'node:crypto'
import { redis } from '$lib/server/redis'
import {
  createPendingApproval,
  decideApproval,
  isWellFormedApprovalId,
  readP5PendingApprovalWrite,
  observeP5ApprovalDecisionWrite,
  type ControlApprovalGrant
} from './controlApprovals'
import { nativeToolService } from './nativeTools'
import type { ToolApprovalEntry, ToolApprovalResponse } from '$lib/types/tool-approvals'

/** The one broker tool the SDK can pause for a risky control. */
export const BROKER_APPROVAL_TOOL_NAME = 'native_batshit_tool_use'

export interface ResolvedApprovalResumeGrants {
  /** SDK `toolCallId` -> the record to spend. */
  approved: Record<string, ControlApprovalGrant>
  /** SDK `toolCallId` -> what the user said no to, for the model-facing refusal. */
  denied: Record<string, { controlTitle?: string | null }>
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function deriveControlApprovalId(sessionId: string, sdkApprovalId: string): string {
  const digest = createHash('sha256')
    .update(`${trimmed(sessionId)}:${trimmed(sdkApprovalId)}`)
    .digest('base64url')
  return `apr_${digest.slice(0, 22)}`
}

/** The model's raw broker input for an approval entry, wherever the SDK put it. */
function readEntryToolInput(entry: ToolApprovalEntry): unknown {
  const toolCall = entry.toolCall as Record<string, any> | undefined
  return (
    toolCall?.input ??
    toolCall?.args ??
    toolCall?.parameters ??
    entry.input ??
    null
  )
}

function readEntryToolCallId(entry: ToolApprovalEntry): string {
  const toolCall = entry.toolCall as Record<string, any> | undefined
  return (
    trimmed(toolCall?.toolCallId) ||
    trimmed(toolCall?.tool_call_id) ||
    trimmed((entry as any).toolCallId)
  )
}

/**
 * Create the pending record for every broker approval entry, and hand back the entries with
 * their `control` presentation block attached (DL-116-06).
 *
 * Entries that are not broker calls — Bash, `native_skill` script runs — pass through
 * untouched: those are the Bash approval flow, which has no server-side consent record and
 * does not need one.
 *
 * A failure to create one record must never lose the card: the entry is returned as it was,
 * with a loud log. The user still sees an approval they cannot spend, which is visible and
 * recoverable; swallowing the entry would hide a paused turn entirely.
 */
export async function attachControlApprovalRecords(options: {
  p5ApiRun?: P5ApiOriginalRun
  abortSignal?: AbortSignal
  userId: string
  agentId?: string | null
  sessionId: string
  messageId?: string | null
  approvals: ToolApprovalEntry[]
}): Promise<ToolApprovalEntry[]> {
  const apiOwner = options.p5ApiRun ? await import('./appActions/mcp/originalTask') : undefined
  const entries = Array.isArray(options.approvals) ? options.approvals : []
  if (entries.length === 0) return entries

  const resolved: ToolApprovalEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (trimmed(entry.toolName) !== BROKER_APPROVAL_TOOL_NAME || entry.control) {
      resolved.push(entry)
      continue
    }

    const sdkApprovalId = trimmed(entry.approvalId)
    if (!sdkApprovalId) {
      resolved.push(entry)
      continue
    }

    try {
      const target = await nativeToolService.resolveBrokerRiskApprovalTarget({
        userId: options.userId,
        sessionId: options.sessionId,
        agentId: options.agentId ?? null,
        input: readEntryToolInput(entry),
        p5ApiRun: options.p5ApiRun, abortSignal: options.abortSignal, messageId: options.messageId
      })
      if (!target) {
        resolved.push(entry)
        continue
      }

      const approvalId = deriveControlApprovalId(options.sessionId, sdkApprovalId)
      const observation = options.p5ApiRun && target.p5ApiHeldRecipe
        ? await apiOwner!.reserveP5ApiPendingApproval(options.p5ApiRun, target.p5ApiHeldRecipe) : undefined
      const writePending = () => createPendingApproval({
        approvalId,
        userId: options.userId,
        agentId: options.agentId ?? null,
        sessionId: options.sessionId,
        messageId: options.messageId ?? null,
        controlId: target.controlId,
        controlTitle: target.controlTitle,
        riskLevel: target.riskLevel,
        lane: 'api',
        input: target.input,
        scopeKey: target.scopeKey,
        sdkApprovalId,
        toolCallId: readEntryToolCallId(entry) || null
      })
      let record: Awaited<ReturnType<typeof createPendingApproval>>
      try {
        record = observation ? await withP5PendingWriteObservation(observation, writePending) : await writePending()
      } catch (error) {
        if (observation && options.p5ApiRun) {
          try { await apiOwner!.observeP5ApiPendingApproval(options.p5ApiRun, observation) }
          catch { console.error('[ControlApprovals] The actual pending-write observation is unconfirmed; original issuance remains paused.') }
        }
        throw error
      }
      if (observation && options.p5ApiRun) await apiOwner!.observeP5ApiPendingApproval(options.p5ApiRun, observation, record)

      resolved.push({
        ...entry,
        control: {
          approvalId: record.id,
          controlId: record.controlId,
          controlTitle: record.controlTitle,
          riskLevel: record.riskLevel as 'confirm' | 'restricted',
          // F-P2-2: the exact normalized payload the record's hash covers — the bytes that
          // run on Approve. The card shows this; the summary is the record's audit view.
          input: target.input,
          inputSummary: record.inputSummary,
          ...(target.settingsPreview ? { settingsPreview: target.settingsPreview } : {}),
          lane: record.lane
        }
      })
    } catch (error) {
      const input = readEntryToolInput(entry) as { ref?: unknown } | null
      if (input?.ref === 'fabric:sys.app_settings.native.change') {
        // The SDK may have asked just before its held operation expired. Never create a
        // pending approval or fall back to an opaque unbound Settings card.
        resolved.push({ ...entry, status: 'expired', expiredAt: new Date().toISOString(), expiryReason: 'wait_failed' })
        console.error('[App Actions] Native approval refused: its trusted held preview is unavailable.')
        continue
      }
      console.error(
        '[SA-116] Could not create the approval record for a paused control; the card will render without one.',
        { sessionId: options.sessionId, approvalId: sdkApprovalId, error }
      )
      resolved.push(entry)
    }
  }

  return resolved
}

/**
 * The persisted message(s) a resume may read its card entries from.
 *
 * F-P2-1 (Faye, P2 review): `redis.getMessages(sessionId, 300)` returns the OLDEST 300
 * messages of a chat (`rPush` + `lRange 0..299`). In a chat longer than that — an Infinite
 * Session, or any long one — the assistant message carrying the card was never in the read,
 * the click resolved no grant, and the resumed call paused again with no card left to click.
 * The resume POST always names the assistant message, so read exactly that record; without
 * an id, read from the NEWEST end of the list, which is where a card that can still be
 * answered lives.
 */
const RESUME_HISTORY_WINDOW = 300

async function readAssistantMessagesForResume(
  sessionId: string,
  messageId: string
): Promise<any[]> {
  return await redis.execute(async (client) => {
    if (messageId) {
      const record = (await client.json.get(`message:${sessionId}:${messageId}`)) as any
      return record ? [record] : []
    }
    const ids = (await client.lRange(
      `messages:${sessionId}`,
      -RESUME_HISTORY_WINDOW,
      -1
    )) as string[]
    const messages: any[] = []
    for (const id of ids) {
      const record = (await client.json.get(`message:${sessionId}:${id}`)) as any
      if (record) messages.push(record)
    }
    return messages
  })
}

/**
 * Turn `metadata.toolApprovalResponse` into the grants a resumed run may spend.
 *
 * Everything that matters is read from the persisted assistant message: which SDK approval
 * belongs to which `toolCallId`, and which `apr_` record it names. The POST body supplies
 * only "which approval id, approved or not" — the same two facts the Bash flow already
 * trusts it for, and neither of them can name a different record.
 *
 * The decision is written here (`decideApproval`), which is also the only thing that seeds
 * the one scoped window DL-116-04 keeps.
 */
const p5ApiResumeGrants = new WeakMap<object, { pending: ApiPendingWrite; decision: ApiDecisionWrite }>()
export function observeP5ApiResumeGrant(result: object) { return p5ApiResumeGrants.get(result) }

export async function resolveApprovalResumeGrants(options: {
  originalApiPending?: ApiPendingWrite
  userId: string
  sessionId: string
  messageId?: string | null
  responses: ToolApprovalResponse[]
  mutate?: (write: () => Promise<void>) => Promise<void>
}): Promise<ResolvedApprovalResumeGrants> {
  const empty: ResolvedApprovalResumeGrants = { approved: {}, denied: {} }
  const responses = Array.isArray(options.responses) ? options.responses : []
  if (responses.length === 0) return empty

  const targetMessageId = trimmed(options.messageId)
  let persisted: any[] = []
  try {
    persisted = await readAssistantMessagesForResume(options.sessionId, targetMessageId)
  } catch (error) {
    console.error('[SA-116] Could not read the session to resolve an approval click:', error)
    return empty
  }
  if (!Array.isArray(persisted) || persisted.length === 0) return empty

  const byApprovalId = new Map<string, ToolApprovalEntry>()
  for (let i = persisted.length - 1; i >= 0; i -= 1) {
    const message = persisted[i]
    if (!message || message.role !== 'assistant') continue
    if (targetMessageId && trimmed(message.id) !== targetMessageId) continue
    const summary = message?.metadata?.toolApprovals
    const entries = Array.isArray(summary?.approvals) ? summary.approvals : []
    for (const entry of entries) {
      const id = trimmed(entry?.approvalId)
      if (id && !byApprovalId.has(id)) byApprovalId.set(id, entry as ToolApprovalEntry)
    }
    if (targetMessageId) break
  }
  if (byApprovalId.size === 0) return empty

  const grants: ResolvedApprovalResumeGrants = { approved: {}, denied: {} }
  for (const response of responses) {
    const sdkApprovalId = trimmed(response?.approvalId)
    if (!sdkApprovalId) continue
    const entry = byApprovalId.get(sdkApprovalId)
    if (!entry) continue
    const control = entry.control
    if (!control || control.lane !== 'api' || !isWellFormedApprovalId(trimmed(control.approvalId))) continue
    const toolCallId = readEntryToolCallId(entry)
    if (!toolCallId) continue

    const approved = response.approved === true
    let decided = null
    try {
      decided = await decideApproval({
        userId: options.userId,
        approvalId: control.approvalId,
        approved,
        mutate: options.mutate,
        ...(options.originalApiPending && readP5PendingApprovalWrite(options.originalApiPending).id === control.approvalId
          ? { originalPending: options.originalApiPending } : {})
      })
    } catch (error) {
      if (options.mutate) throw error // A fenced plan decision is a refused resume, not a missing grant.
      console.error('[SA-116] Could not record an approval decision:', error)
      continue
    }
    // A record that is gone (swept, or expired past its 24 hours) cannot be spent. The SDK
    // still re-executes the call, and the gate raises a fresh card — which is the honest
    // outcome: the consent this click referred to no longer exists.
    if (!decided) continue

    if (options.originalApiPending) {
      const decision = observeP5ApprovalDecisionWrite(options.originalApiPending)
      if (decision && readP5PendingApprovalWrite(options.originalApiPending).id === control.approvalId) p5ApiResumeGrants.set(grants, { pending: options.originalApiPending, decision })
    }

    if (approved && decided.status === 'approved') {
      grants.approved[toolCallId] = {
        kind: 'sdk',
        approvalId: decided.id,
        toolCallId
      }
    } else if (!approved) {
      grants.denied[toolCallId] = { controlTitle: decided.controlTitle ?? null }
    }
  }

  return grants
}
