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
  type ControlApprovalGrant
} from './controlApprovals'
import { buildControlDenialRecord } from '$lib/utils/controlTags'
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
  userId: string
  agentId?: string | null
  sessionId: string
  messageId?: string | null
  approvals: ToolApprovalEntry[]
}): Promise<ToolApprovalEntry[]> {
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
        agentId: options.agentId ?? null,
        input: readEntryToolInput(entry)
      })
      if (!target) {
        resolved.push(entry)
        continue
      }

      const approvalId = deriveControlApprovalId(options.sessionId, sdkApprovalId)
      const record = await createPendingApproval({
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
          lane: record.lane
        }
      })
    } catch (error) {
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
export async function resolveApprovalResumeGrants(options: {
  userId: string
  sessionId: string
  messageId?: string | null
  responses: ToolApprovalResponse[]
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
    if (!control || !isWellFormedApprovalId(trimmed(control.approvalId))) continue
    const toolCallId = readEntryToolCallId(entry)
    if (!toolCallId) continue

    const approved = response.approved === true
    let decided = null
    try {
      decided = await decideApproval({
        userId: options.userId,
        approvalId: control.approvalId,
        approved
      })
    } catch (error) {
      console.error('[SA-116] Could not record an approval decision:', error)
      continue
    }
    // A record that is gone (swept, or expired past its 24 hours) cannot be spent. The SDK
    // still re-executes the call, and the gate raises a fresh card — which is the honest
    // outcome: the consent this click referred to no longer exists.
    if (!decided) continue

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

/* ------------------------------------------------------------------ *
 * SA-116 P3 (DL-116-08) — the CLI lanes: Approve is a RESUME TURN
 * ------------------------------------------------------------------ */

/**
 * What one click answered on a lane that cannot be resumed in place.
 *
 * The API lane resumes the very same paused SDK call. A managed Codex or Claude run cannot:
 * the helper's refusal already came back, the model already spoke about it, and the turn
 * already ended — there is nothing left to un-pause. So the click starts an ORDINARY next
 * turn carrying a message that says what the user approved, and the agent's retry finds the
 * `approved` record waiting for it.
 *
 * That also means the click works after any delay and with no tab open, which is exactly
 * what a blocking wait inside the helper could not do.
 */
export interface ControlApprovalResumePlan {
  /**
   * F-P3-2 — who owns the turn this click starts.
   *
   * `resume-turn`: nothing on the click can be resumed in place, so the click starts an
   * ordinary next turn and the spent card is cleared.
   *
   * `in-place`: the click ALSO answered a card the in-place SDK resume owns (a Bash
   * approval, a `native_skill` script run, or an `api`-lane control pause). That resume
   * must still find the card on the message, so nothing is cleared and no second turn is
   * started — the records below are decided anyway and travel to the resumed model as
   * `buildControlApprovalInPlaceAddendum`, so one click really does answer both.
   */
  mode: 'resume-turn' | 'in-place'
  /** The assistant message the card is on, so its spent entries can be cleared. */
  cardMessageId: string
  approved: Array<{ recordId: string; controlId: string; controlTitle: string }>
  denied: Array<{ recordId: string; controlId: string; controlTitle: string; decidedAt: string }>
}

/** The user-visible message a resume turn is started with, and its metadata. */
export interface ControlApprovalResumeTurn {
  content: string
  approvalIds: string[]
  cardMessageId: string
  deniedCount: number
}

function readEntryControlLane(entry: ToolApprovalEntry | null | undefined): string {
  const lane = (entry as any)?.control?.lane
  return typeof lane === 'string' ? lane.trim() : ''
}

/**
 * Is this card entry answered by a resume TURN rather than by the in-place SDK resume?
 *
 * Exactly two things make it so, and they are the same two the decision loop below already
 * required, which is why this is one function rather than a rule written twice:
 *
 *  - it names a consent record (`apr_…`). A Bash approval and a `native_skill` script run
 *    carry no `control` block at all, so there is nothing here to decide — the SDK owns
 *    them end to end.
 *  - its lane is not `api`. An `api`-lane control pause IS an SDK-paused call, and the SDK
 *    re-executes it on the resume; deciding it here as well would put it in the addendum
 *    and ask the model to run the very same call a second time.
 */
function isResumeTurnEntry(entry: ToolApprovalEntry | null | undefined): boolean {
  const recordId = trimmed((entry as any)?.control?.approvalId)
  if (!isWellFormedApprovalId(recordId)) return false
  return readEntryControlLane(entry) !== 'api'
}

/**
 * Read the persisted card entries a click answered, keeping only those that need a resume
 * turn — every `source: 'fabric'` entry whose lane is not `api`.
 *
 * Returns `null` when the click has nothing of that kind, which is the ordinary API-lane
 * case: `resolveApprovalResumeGrants` then handles it in place, unchanged.
 */
export async function planControlApprovalResumeTurn(options: {
  userId: string
  sessionId: string
  messageId?: string | null
  responses: ToolApprovalResponse[]
}): Promise<ControlApprovalResumePlan | null> {
  const responses = Array.isArray(options.responses) ? options.responses : []
  if (responses.length === 0) return null

  const targetMessageId = trimmed(options.messageId)
  let persisted: any[] = []
  try {
    persisted = await readAssistantMessagesForResume(options.sessionId, targetMessageId)
  } catch (error) {
    console.error('[SA-116] Could not read the session to plan an approval resume turn:', error)
    return null
  }
  if (!Array.isArray(persisted) || persisted.length === 0) return null

  const byApprovalId = new Map<string, { entry: ToolApprovalEntry; messageId: string }>()
  for (let i = persisted.length - 1; i >= 0; i -= 1) {
    const message = persisted[i]
    if (!message || message.role !== 'assistant') continue
    if (targetMessageId && trimmed(message.id) !== targetMessageId) continue
    const summary = message?.metadata?.toolApprovals
    const entries = Array.isArray(summary?.approvals) ? summary.approvals : []
    for (const entry of entries) {
      const id = trimmed(entry?.approvalId)
      if (id && !byApprovalId.has(id)) {
        byApprovalId.set(id, { entry: entry as ToolApprovalEntry, messageId: trimmed(message.id) })
      }
    }
    if (targetMessageId) break
  }
  if (byApprovalId.size === 0) return null

  /**
   * F-P3-2 — which resume this click belongs to.
   *
   * The browser answers EVERY pending card on a message with one click, so a message
   * carrying both kinds cannot be answered one card at a time and "refuse the mixed click"
   * would make it unanswerable. The in-place SDK resume has to win when it is present — it
   * is the only thing that can re-execute a call the SDK paused — but that is not a reason
   * to drop the rest: P3 left those records `pending` while the in-place resume's finish
   * path cleared the whole summary, so the card vanished and nothing ever ran it.
   *
   * So: decide both kinds, start no second turn, clear no card, and hand the decision to
   * the resumed model as an addendum (`buildControlApprovalInPlaceAddendum`).
   */
  const answered = responses
    .map((response) => byApprovalId.get(trimmed(response?.approvalId)))
    .filter((found): found is { entry: ToolApprovalEntry; messageId: string } => Boolean(found))
  const resumeTurnAnswered = answered.filter((found) => isResumeTurnEntry(found.entry))
  // Nothing here needs a turn of its own: the ordinary API-lane click, untouched since P2.
  if (resumeTurnAnswered.length === 0) return null
  const mode: ControlApprovalResumePlan['mode'] =
    resumeTurnAnswered.length === answered.length ? 'resume-turn' : 'in-place'
  if (mode === 'in-place') {
    console.warn(
      '[SA-116] One click answered both an in-place and a resume-turn approval card. ' +
        'Taking the in-place resume and carrying the other decision into it.',
      { sessionId: options.sessionId, messageId: targetMessageId }
    )
  }

  const plan: ControlApprovalResumePlan = {
    mode,
    cardMessageId: targetMessageId,
    approved: [],
    denied: []
  }

  for (const response of responses) {
    const entryId = trimmed(response?.approvalId)
    if (!entryId) continue
    const found = byApprovalId.get(entryId)
    if (!found) continue

    // ONE gate, and it is `isResumeTurnEntry` — the same rule that chose the mode above,
    // so the two can never disagree about which cards this function owns. A Bash approval
    // has no `control` block, so no record id; a stale or tampered entry may carry
    // something that is not an `apr_` id at all; an `api`-lane entry belongs to the SDK.
    // In every one of those cases the approval store is not even ASKED.
    if (!isResumeTurnEntry(found.entry)) continue
    const recordId = trimmed(found.entry.control?.approvalId)

    let decided = null
    try {
      decided = await decideApproval({
        userId: options.userId,
        approvalId: recordId,
        approved: response.approved === true
      })
    } catch (error) {
      console.error('[SA-116] Could not record a CLI-lane approval decision:', error)
      continue
    }
    // A record that is gone — swept with its chat, or past its 24 hours — cannot be spent.
    // Starting a resume turn for it would tell the agent to run something with no consent
    // behind it, so the click is dropped and the card is cleared: honest, and the agent can
    // ask again.
    if (!decided) continue

    if (response.approved === true && decided.status === 'approved') {
      plan.approved.push({
        recordId: decided.id,
        controlId: decided.controlId,
        controlTitle: decided.controlTitle
      })
    } else if (response.approved !== true) {
      plan.denied.push({
        recordId: decided.id,
        controlId: decided.controlId,
        controlTitle: decided.controlTitle,
        decidedAt: decided.decidedAt ?? new Date().toISOString()
      })
    }
    if (!plan.cardMessageId) plan.cardMessageId = found.messageId
  }

  if (plan.approved.length === 0 && plan.denied.length === 0) return null
  return plan
}

/**
 * The approval message a resume turn opens with.
 *
 * The `[Approval — from the user, not from the agent]` header is the same not-from-the-user
 * convention SA-113 uses for a DM body: an agent reading its own history must be able to
 * tell a real human decision from text it or another agent produced. It names the control,
 * the record, and what to do — retry the SAME ref with the SAME input, because the record is
 * matched on the input hash and a changed payload earns a new card rather than a free run.
 */
export function buildControlApprovalResumeContent(
  approved: ControlApprovalResumePlan['approved']
): string {
  const lines = approved.map(
    (item) =>
      `Approved: ${item.controlTitle} (${item.controlId}, approval ${item.recordId}).`
  )
  return [
    '[Approval — from the user, not from the agent]',
    ...lines,
    approved.length === 1
      ? 'Run it now by calling the same ref with the same input.'
      : 'Run them now by calling the same refs with the same inputs.'
  ].join('\n')
}

/**
 * F-P3-2 — the same decision, carried into a resume that is already running.
 *
 * On a mixed click there is no new turn to open with an approval message, because the SDK
 * resume re-enters the run that paused. So the decision rides in the same place a tool
 * approval timeout does: appended to the compiled request's system prompt, in the same
 * `[Approval — from the user, not from the agent]` voice `buildControlApprovalResumeContent`
 * uses, so an agent reading it can tell a real human decision from text it produced itself.
 *
 * Approved: the model retries the call, and `findApprovedMatch` spends the record once.
 * Denied: it is told plainly not to. A `resume-turn` plan gets nothing — that plan opens its
 * own message and does not need saying twice.
 */
export function buildControlApprovalInPlaceAddendum(
  plan: ControlApprovalResumePlan
): string | null {
  if (!plan || plan.mode !== 'in-place') return null
  const approved = Array.isArray(plan.approved) ? plan.approved : []
  const denied = Array.isArray(plan.denied) ? plan.denied : []
  if (approved.length === 0 && denied.length === 0) return null

  const lines = ['==== CONTROL APPROVAL ====', '[Approval — from the user, not from the agent]']
  for (const item of approved) {
    lines.push(`Approved: ${item.controlTitle} (${item.controlId}, approval ${item.recordId}).`)
  }
  if (approved.length > 0) {
    lines.push(
      approved.length === 1
        ? 'Run it now by calling the same ref with the same input.'
        : 'Run them now by calling the same refs with the same inputs.'
    )
  }
  for (const item of denied) {
    lines.push(`Denied by the user: ${item.controlTitle} (${item.controlId}) — do not retry it.`)
  }
  return lines.join('\n')
}

/**
 * Clear the spent card and, for a denial, leave the one-turn correction line behind.
 *
 * The card is cleared the same way the API lane clears its own — `toolApprovals: null`, so a
 * spent card cannot reappear on refresh. A denial then writes a `controlErrors` record onto
 * that same assistant message, which is where `buildControlErrorDcmLines` reads from, so the
 * agent is told plainly on its next turn instead of retrying into a wall.
 */
export async function settleControlApprovalCard(options: {
  userId: string
  sessionId: string
  messageId: string
  denied: ControlApprovalResumePlan['denied']
  /**
   * F-P3-2 — false on a mixed click. The in-place SDK resume has not read the card yet
   * (`resolveApprovalResumeGrants` reads the persisted message once the run starts), so
   * clearing it here would take the SDK's own approval with it. Its finish path clears the
   * whole summary at the end of that run, which is the right moment: by then both kinds
   * really are answered.
   */
  clearCard?: boolean
}): Promise<void> {
  const messageId = trimmed(options.messageId)
  if (!messageId) return
  const clearCard = options.clearCard !== false
  // Nothing to write: no card to clear and no denial to leave behind.
  if (!clearCard && options.denied.length === 0) return

  try {
    // `redis.updateMessage` spreads the update over the record, so `metadata` is REPLACED,
    // not merged. Writing `{ toolApprovals: null }` on its own would take the assistant
    // message's `zipIds`, usage, and agent metadata with it — every tool card in that turn
    // would go blank. Read, then merge.
    const existing = (await redis.execute(async (client) =>
      client.json.get(`message:${options.sessionId}:${messageId}`)
    )) as any
    if (!existing) return

    const currentMetadata =
      existing.metadata && typeof existing.metadata === 'object'
        ? (existing.metadata as Record<string, any>)
        : {}
    const existingControlErrors = Array.isArray(currentMetadata.controlErrors)
      ? currentMetadata.controlErrors
      : []
    const denialRecords = options.denied.map((item) =>
      buildControlDenialRecord(item.controlTitle, item.decidedAt)
    )

    const metadata: Record<string, any> = {
      ...currentMetadata,
      // The same clear the API lane's resume makes, for the same reason: a spent card must
      // not reappear on refresh.
      ...(clearCard ? { toolApprovals: null } : {}),
      ...(denialRecords.length > 0
        ? { controlErrors: [...existingControlErrors, ...denialRecords] }
        : {})
    }

    await redis.updateMessage(messageId, options.sessionId, { metadata }, options.userId)
  } catch (error) {
    // Never fail the click over presentation. The record is already decided, which is the
    // part that matters; a card left on screen is visible and recoverable.
    console.error('[SA-116] Could not clear a spent approval card:', error)
  }
}
