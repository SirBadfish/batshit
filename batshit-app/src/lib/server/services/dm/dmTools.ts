/**
 * SA-113 P2 (DL-113-03, DL-113-16) — the `sys.dm.*` operations layer.
 *
 * One implementation behind the Fabric family, so the API lane and the managed CLI lanes
 * cannot drift. The shape follows `memoryTools.ts` deliberately: a server-side enablement
 * re-check in front of every operation (belt and suspenders under the broker allow-list),
 * summary-first results, and readable errors with a fix hint.
 *
 * Two rules are worth stating out loud because they are easy to lose in a refactor:
 *
 *   - **The recipient's settings decide, not the sender's.** A send checks the RECIPIENT's
 *     `dms_enabled`, its `dm_senders` policy, and — for a wake — its `wake_enabled` and
 *     working style. The sender only needs `dms_enabled` to hold the tools at all.
 *   - **Chain depth is read from the server, never from input.** It comes from the current
 *     session's last user message (`metadata.wake.chainDepth`), so an agent cannot talk
 *     its way past the depth-3 guard by passing a smaller number.
 */

import { redis } from '$lib/server/redis'
import { randomBytes } from 'node:crypto'
import {
  requestAgentWakeup,
  type RequestAgentWakeupResult
} from '$lib/server/services/agentWakeups'
import {
  findWakeRunForAgent,
  getWakeRun
} from '$lib/server/services/wakeRunRegistry'
import {
  getActiveStream,
  listActiveSessionTurns
} from '$lib/server/services/streamAbortRegistry'
import {
  enqueueSteer,
  flushPendingSteersToTransport,
  getSteerRun
} from '$lib/server/services/steerInboxRegistry'
import { waitForStreamRegistration } from '$lib/server/services/steerSetupWait'
import { STEER_DM_ALREADY_PENDING_REASON } from '$lib/utils/steerControl'
import {
  DM_DELIVERY_MODES,
  MAX_WAKE_CHAIN_DEPTH,
  STEER_NO_ACTIVE_TURN_REASON,
  isDeliverableNow,
  resolveAgentDmsEnabled,
  resolveAgentWakeEnabled,
  resolveDmSenderAllowed,
  resolveDmSteerFallback,
  resolveWakeTarget,
  type DmDeliveryMode,
  type DmSteerFallback
} from '$lib/utils/dmControl'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { SCHEDULE_TICK_MS, describeNextRun } from '$lib/utils/scheduleControl'
import type { ScheduleRecord } from '$lib/types/schedule'
import {
  DM_KINDS,
  isOpenDmStatus,
  toDmSummary,
  type DmKind,
  type DmPriority,
  type DmRecord,
  type DmSummary
} from '$lib/types/dm'
import {
  acknowledgeInfoDm,
  claimDm,
  closeDm,
  createDm,
  DmStoreError,
  getDm,
  linkResultDm,
  listInbox,
  selectExpiredAssignmentsNeedingResult,
  setDmCallbackStatus,
  stampDmDelivery
} from './dmStore'
import { hasPendingToolApproval } from './pendingToolApproval'
import { deliverWakeCallback, isAllowedCallbackUrl } from './wakeCallback'
import type { WakeHookRecord } from '$lib/types/wakeHook'

export interface DmToolContext {
  userId: string
  /** The ACTING agent — the sender on a send, the recipient on everything else. */
  agentId: string
  sessionId?: string | null
}

export class DmToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'DmToolError'
  }
}

function agentDisplayName(agent: Record<string, any> | null | undefined): string {
  if (!agent) return 'Unknown agent'
  return (
    (typeof agent.displayName === 'string' && agent.displayName.trim()) ||
    (typeof agent.name === 'string' && agent.name.trim()) ||
    (typeof agent.id === 'string' && agent.id) ||
    'Unknown agent'
  )
}

/**
 * Server-side enablement gate, mirroring `requireMemoryEnabledAgent`: DM operations run
 * only for an existing, user-owned, DM-enabled agent. The broker allow-list should already
 * have stopped anything else; this is the layer that makes that true rather than assumed.
 */
export async function requireDmEnabledAgent(
  userId: string,
  agentId: string | null | undefined
): Promise<Record<string, any>> {
  const normalized = typeof agentId === 'string' ? agentId.trim() : ''
  if (!normalized) {
    throw new DmToolError('DM operations need an agent context (agentId missing).')
  }
  const agent = (await redis.get(`agent:${normalized}`)) as Record<string, any> | null
  if (!agent) {
    throw new DmToolError(`Agent "${normalized}" was not found.`)
  }
  if (typeof agent.user_id === 'string' && agent.user_id !== userId) {
    throw new DmToolError(`Agent "${normalized}" does not belong to this user.`)
  }
  if (!resolveAgentDmsEnabled(agent)) {
    throw new DmToolError(
      `Agent DMs are not turned on for "${agentDisplayName(agent)}".`,
      'Turn on Agent DMs for this agent in Agent Settings first.'
    )
  }
  return agent
}

/* ------------------------------------------------------------------ *
 * The woken first message (DL-113-04c)
 * ------------------------------------------------------------------ */

/**
 * The visible first message of a woken session.
 *
 * The header is fixed and says plainly that this did not come from the user, because every
 * comparable product learned the same lesson: inbound agent text must be framed as
 * non-user and must not be able to grant consent. The guidance block says the rest — a DM
 * cannot approve a tool, change settings, or override the user's standing instructions.
 */
export function buildWokenDmContent(record: DmRecord): string {
  const urgent = record.priority === 'urgent' ? ', urgent' : ''
  // One bracket per sender kind. Each one says plainly that the text is not the user's,
  // and SA-115 added the third without disturbing the two SA-113 shipped.
  const source =
    record.from.kind === 'webhook'
      ? `Wake-up webhook "${record.from.name}" — not from the user`
      : record.from.kind === 'schedule'
        ? `Schedule "${record.from.name}" — not from the user`
        : `Agent DM — from ${record.from.name}, not from the user`
  const header = `[${source}] ${record.kind}${urgent} — ${record.subject}`

  return [header, '', record.body, '', ...dmDetailLines(record)].join('\n')
}

function dmDetailLines(record: DmRecord): string[] {
  const lines: string[] = []
  if (record.requestedOutcome) lines.push(`Requested outcome: ${record.requestedOutcome}`)
  if (record.scope) lines.push(`Scope: ${record.scope}`)
  if (record.reportBackTo) lines.push(`Report back to: ${record.reportBackTo}`)
  lines.push(`DM id: ${record.id}`)
  return lines
}

/**
 * SA-114 P4 (DL-114-13) — the same DM, as a steer.
 *
 * Deliberately missing the "not from the user" bracket `buildWokenDmContent` opens with:
 * `buildSteerInjectionText` wraps every DM steer in `[Agent DM — from <name>, not from the
 * user, delivered mid-reply]` on its way to the model, and saying it twice would be noise
 * in the middle of somebody else's reply. Everything else is identical, including the
 * `DM id:` line — a steered assignment still has to be claimable.
 */
export function buildSteeredDmContent(record: DmRecord): string {
  const urgent = record.priority === 'urgent' ? ', urgent' : ''
  const header = `${record.kind}${urgent} — ${record.subject}`
  return [header, '', record.body, '', ...dmDetailLines(record)].join('\n')
}

/* ------------------------------------------------------------------ *
 * Chain depth
 * ------------------------------------------------------------------ */

/**
 * How deep the wake chain already is, read from the acting session's last user message.
 * A user-typed turn has no `metadata.wake`, so it is depth 0 — which is exactly right: a
 * chain that starts with a person starts at zero.
 *
 * F-P2-1: this reads the RECENT end. `getMessages(sessionId, 50)` is the first fifty, so on
 * a chat longer than fifty messages the depth was resolved from an old wake message instead
 * of the user's latest typed turn — which would keep refusing wakes in a long chat that has
 * long since returned to the user.
 */
export async function resolveSessionChainDepth(
  sessionId: string | null | undefined
): Promise<number> {
  if (!sessionId) return 0
  try {
    const messages = await redis.getRecentMessages(sessionId, 50)
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as Record<string, any>
      if (message?.role !== 'user') continue
      const depth = message?.metadata?.wake?.chainDepth
      return typeof depth === 'number' && Number.isFinite(depth) ? Math.max(0, depth) : 0
    }
  } catch (error) {
    console.warn('[Agent DMs] Could not read the chain depth for a session:', error)
  }
  return 0
}

/* ------------------------------------------------------------------ *
 * Presence (DL-113-16)
 * ------------------------------------------------------------------ */

export type AgentPresenceState = 'idle' | 'running' | 'waiting_approval'

export interface AgentPresence {
  id: string
  name: string
  state: AgentPresenceState
  running_session_id?: string
  running_since?: string
  wake_enabled: boolean
  working_style: 'new-session' | 'current-session'
  open_dms: number
}

/**
 * "Is Cooper free right now?" — answered from the server's own registries, with no polling
 * and no new store: the active session turns, mapped to agents through each session's
 * `agent_id`, plus the wake registry, plus a pending tool approval on the last assistant
 * message of the running session.
 *
 * Deliberately NOT in the DCM: it would cost bytes on every send to answer a question the
 * agent only has when it is about to write to somebody. The guidance says to ask.
 */
export async function listDmAgentsOp(context: DmToolContext): Promise<{
  agents: AgentPresence[]
}> {
  await requireDmEnabledAgent(context.userId, context.agentId)

  const agents = await redis.getAgents(context.userId)
  const activeTurns = listActiveSessionTurns()

  // One session read per active turn, not per agent: there are at most a handful.
  const runningByAgent = new Map<string, { sessionId: string; startedAt: number }>()
  for (const turn of activeTurns) {
    const session = await redis.getSession(turn.sessionId)
    if (!session) continue
    const metadata = (session.metadata ?? {}) as Record<string, any>
    if (metadata.group_chat?.group_id) continue
    const agentId =
      session.agent_id || metadata.last_agent_id || metadata.agent_id || null
    if (typeof agentId !== 'string' || !agentId) continue
    if (!runningByAgent.has(agentId)) {
      runningByAgent.set(agentId, { sessionId: turn.sessionId, startedAt: turn.startedAt })
    }
  }

  const out: AgentPresence[] = []
  for (const agent of agents) {
    const record = agent as unknown as Record<string, any>
    if (!resolveAgentDmsEnabled(record)) continue
    const agentType = normalizePrimaryAgentType(record as any)
    if (agentType !== 'api' && agentType !== 'cli') continue

    const running =
      runningByAgent.get(record.id) ??
      (() => {
        const wakeRun = findWakeRunForAgent(record.id)
        return wakeRun
          ? { sessionId: wakeRun.sessionId, startedAt: wakeRun.startedAt }
          : null
      })()

    const openItems = await listInbox(record.id)
    const openDms = openItems.length

    let state: AgentPresenceState = running ? 'running' : 'idle'
    if (running && (await hasPendingToolApproval(running.sessionId))) {
      state = 'waiting_approval'
    }
    // F-SEC-1b: a holdup outlives the turn that hit it. A woken turn that ended on a tool
    // approval, or that Batshit refused a risky control in, leaves the agent NOT running —
    // so without this the honest answer "it is stuck on the user" would read as `idle` and
    // the next agent would happily hand it more work.
    if (state !== 'waiting_approval' && openItems.some((item) => item.delivery?.needsUser)) {
      state = 'waiting_approval'
    }

    out.push({
      id: record.id,
      name: agentDisplayName(record),
      state,
      ...(running
        ? {
            running_session_id: running.sessionId,
            running_since: new Date(running.startedAt).toISOString()
          }
        : {}),
      wake_enabled: resolveAgentWakeEnabled(record),
      working_style: resolveWakeTarget(record),
      open_dms: openDms
    })
  }
  return { agents: out }
}

/** One agent's presence, for the `recipient_state` every send result carries. */
async function resolveRecipientState(
  userId: string,
  recipientId: string
): Promise<AgentPresenceState> {
  const wakeRun = findWakeRunForAgent(recipientId)
  if (wakeRun) {
    return (await hasPendingToolApproval(wakeRun.sessionId)) ? 'waiting_approval' : 'running'
  }
  for (const turn of listActiveSessionTurns()) {
    const session = await redis.getSession(turn.sessionId)
    if (!session || session.user_id !== userId) continue
    const metadata = (session.metadata ?? {}) as Record<string, any>
    const agentId = session.agent_id || metadata.last_agent_id || metadata.agent_id
    if (agentId !== recipientId) continue
    return (await hasPendingToolApproval(turn.sessionId)) ? 'waiting_approval' : 'running'
  }
  // F-SEC-1b: nothing is running, but an open item stamped "needs you" means the last thing
  // this agent was asked to do is parked on a person. A sender deciding wait-or-wake should
  // see that rather than a bare `idle`.
  const openItems = await listInbox(recipientId)
  if (openItems.some((item) => item.delivery?.needsUser)) return 'waiting_approval'
  return 'idle'
}

/* ------------------------------------------------------------------ *
 * send
 * ------------------------------------------------------------------ */

export interface SendDmInput {
  to: string
  kind: DmKind
  subject: string
  body: string
  priority?: DmPriority
  requested_outcome?: string
  scope?: string
  report_back_to?: string
  deliver: DmDeliveryMode
  /** `deliver: 'steer'` only (DL-114-13): what to do if they are not mid-reply. Default wait. */
  steer_fallback?: DmSteerFallback
  result_delivery?: 'wait' | 'wake'
  related_dm_id?: string
  expires_in_hours?: number
}

export interface SendDmResult {
  dm_id: string
  delivered_as: 'wait' | 'wake' | 'steer'
  reason?: string
  /** The chat a wake started, or the chat a steer landed inside (DL-114-13). */
  session_id?: string
  expires_at: string
  recipient_state: AgentPresenceState
}

/** One recipient's line in a broadcast result (F-P2-4). */
export interface BroadcastDmDelivery {
  dm_id: string
  to: string
  to_name: string
  delivered_as: 'wait'
}

export interface BroadcastDmResult {
  broadcast: true
  message_id: string
  delivered: BroadcastDmDelivery[]
  skipped: Array<{ to: string; to_name: string; reason: string }>
  expires_at: string
}

/** The literal `to` value that means "every agent that will take a note from me". */
export const DM_BROADCAST_RECIPIENT = 'all'

export async function sendDmOp(
  context: DmToolContext,
  input: SendDmInput
): Promise<SendDmResult | BroadcastDmResult> {
  const sender = await requireDmEnabledAgent(context.userId, context.agentId)

  const kind = input.kind
  if (!DM_KINDS.includes(kind)) {
    throw new DmToolError(
      `"${kind}" is not a DM kind.`,
      'Use info (a note), assignment (do this and report back), or result (the outcome).'
    )
  }

  const deliver = input.deliver
  if (!DM_DELIVERY_MODES.includes(deliver)) {
    throw new DmToolError(
      `"${deliver}" is not a delivery mode.`,
      'Use wait (it appears in their inbox), wake (Batshit starts a turn for them now), or steer (it lands inside the reply they are writing).'
    )
  }
  // SA-114 P4 (DL-114-13): `steer` is no longer refused here. Whether it can be delivered
  // depends on something this line cannot see — whether the RECIPIENT is mid-reply on a
  // steerable transport — so `isDeliverableNow` is asked that question further down, once
  // the recipient is known, and a `false` degrades to the sender's fallback rather than
  // failing the send. Nothing is ever lost: the DM is written either way.
  const steerFallback: DmSteerFallback = resolveDmSteerFallback(input.steer_fallback)

  if (typeof input.to === 'string' && input.to.trim().toLowerCase() === DM_BROADCAST_RECIPIENT) {
    return broadcastDmOp(context, sender, input)
  }

  const recipient = await loadDmAddressableAgent(context.userId, input.to, 'to')
  if (!resolveDmSenderAllowed(recipient, sender.id)) {
    throw new DmToolError(
      `${agentDisplayName(recipient)} only accepts DMs from a chosen list of agents, and you are not on it.`,
      'Ask the user to add you under that agent\'s Agent DMs settings.'
    )
  }

  // F-P2-2: an assignment's report_back_to is checked HERE, at the moment the mistake is
  // made. `reportBack` writes to whatever id it finds two turns later, so a typo used to
  // become an orphan `result` nobody would ever read, discovered only at close time.
  if (kind === 'assignment') {
    await loadDmAddressableAgent(context.userId, input.report_back_to, 'report_back_to')
  }

  const record = await runStore(() =>
    createDm({
      userId: context.userId,
      from: { kind: 'agent', agentId: sender.id, name: agentDisplayName(sender) },
      to: recipient.id,
      kind,
      subject: input.subject,
      body: input.body,
      priority: input.priority,
      requestedOutcome: input.requested_outcome ?? null,
      scope: input.scope ?? null,
      reportBackTo: input.report_back_to ?? null,
      relatedDmId: input.related_dm_id ?? null,
      deliver,
      steerFallback: deliver === 'steer' ? steerFallback : undefined,
      resultDelivery: input.result_delivery,
      expiresInHours: input.expires_in_hours ?? null,
      senderSessionId: context.sessionId ?? null
    })
  )

  const recipientState = await resolveRecipientState(context.userId, recipient.id)

  if (deliver === 'wait') {
    return {
      dm_id: record.id,
      delivered_as: 'wait',
      expires_at: record.expiresAt,
      recipient_state: recipientState
    }
  }

  // SA-114 P4 (DL-114-13). A steer that lands is done; one that cannot degrades to whatever
  // the sender asked for, and `wake` there is a real wake — chain depth, the hourly budgets,
  // the working style, all of it — because it IS one. A steer is not: it spends no wake
  // budget, starts no session, and writes no user message. It rides a turn that is already
  // running and already paid for.
  if (deliver === 'steer') {
    const steer = await deliverBySteer(context, record, recipient)
    if (steer.ok) {
      return {
        dm_id: record.id,
        delivered_as: 'steer',
        session_id: steer.sessionId,
        expires_at: record.expiresAt,
        recipient_state: recipientState
      }
    }
    // F-P4-1 (the P4 review): `deliverBySteer` stamps `steer` BEFORE it enqueues, so that
    // a degrade can only ever come after it. A miss is therefore stamped back here, once,
    // whatever the fallback — and the chat it was aimed at is cleared with it, because a
    // steer that landed nowhere names no chat.
    await stampDmDelivery(record.id, {
      actual: 'wait',
      reason: steer.reason,
      sessionId: undefined
    })
    if (steerFallback === 'wait') {
      return {
        dm_id: record.id,
        delivered_as: 'wait',
        reason: steer.reason,
        expires_at: record.expiresAt,
        recipient_state: recipientState
      }
    }
    // The wake carries the steer's reason with it, so the record and the sender's answer
    // say the same thing: why the steer became a wake, and — if that was refused too — why.
    const wokenAfterSteer = await deliverByWake(context, record, recipient, {
      steerReason: steer.reason
    })
    return {
      dm_id: record.id,
      delivered_as: wokenAfterSteer.ok ? 'wake' : 'wait',
      ...(wokenAfterSteer.ok
        ? { session_id: wokenAfterSteer.sessionId, reason: steer.reason }
        : { reason: wokenAfterSteer.reason }),
      expires_at: record.expiresAt,
      recipient_state: recipientState
    }
  }

  const wake = await deliverByWake(context, record, recipient)
  return {
    dm_id: record.id,
    delivered_as: wake.ok ? 'wake' : 'wait',
    ...(wake.ok ? { session_id: wake.sessionId } : { reason: wake.reason }),
    expires_at: record.expiresAt,
    recipient_state: recipientState
  }
}

/**
 * SA-114 P4 (DL-114-13) — hand this DM to a reply the recipient is already writing.
 *
 * The user's own steers come in through `POST /api/messages/steer`; this is the only other
 * door, and it is deliberately not an HTTP one — a service-token holder must not be able to
 * push text into somebody's reply. It ends at the same `enqueueSteer`, so the cap, the
 * message-id pinning, and the transport push are all the ones the route already proved.
 *
 * Three differences from the route, each from the lock:
 *
 *   - **No `steer_queued` event.** The route publishes one so the tab that typed can draw
 *     its bubble. Nobody typed this, and the client renders a DM steer from
 *     `steer_delivered` instead (P3).
 *   - **One pending DM steer per recipient turn**, enforced in the registry: several agents'
 *     notes inside one reply would read as a conversation the user never saw.
 *   - **Never promoted.** If it does not land before the reply ends, send-routed degrades it
 *     to `wait` rather than turning it into the user's next message.
 */
async function deliverBySteer(
  context: DmToolContext,
  record: DmRecord,
  recipient: Record<string, any>
): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
  // Every Redis read happens in this loop, ABOVE the check-and-enqueue below (F-P1-2). A
  // reply that finishes while a session is being read must not leave an entry pinned to a
  // dead assistant id, so the verdict, the live stream and the enqueue are one synchronous
  // block once a candidate session is known.
  const candidates: Array<{ sessionId: string; lockedMessageId: string | null }> = []
  for (const turn of listActiveSessionTurns()) {
    if (turn.kind !== 'single') continue
    const session = await redis.getSession(turn.sessionId)
    if (!session || session.user_id !== context.userId) continue
    const metadata = (session.metadata ?? {}) as Record<string, any>
    if (typeof metadata.group_chat?.group_id === 'string') continue
    const agentId = session.agent_id || metadata.last_agent_id || metadata.agent_id
    if (agentId !== recipient.id) continue
    candidates.push({ sessionId: turn.sessionId, lockedMessageId: turn.messageId ?? null })
  }

  if (candidates.length === 0) {
    return { ok: false, reason: STEER_NO_ACTIVE_TURN_REASON }
  }

  const at = new Date().toISOString()
  let lastReason = STEER_NO_ACTIVE_TURN_REASON

  for (const { sessionId, lockedMessageId } of candidates) {
    // F-P4-3 (the P4 review): the lock is registered at the top of send-routed and the
    // stream 1.5–3 s later, after compile. A DM sent in that window was told "not
    // mid-reply right now" — false, and the same defect F-P3-1 fixed on the user's door.
    // The wait is the route's own; it ends the moment the stream appears or the lock goes.
    if (lockedMessageId) {
      await waitForStreamRegistration(sessionId, lockedMessageId)
    }

    // F-P4-1 (the P4 review): the "landed" stamp goes down BEFORE the enqueue. Stamped
    // after it, the stamp raced the end of the reply: the request's `finally` could take
    // the entry and stamp `wait` first, and this stamp would then overwrite it with
    // `steer` — "landed mid-reply" on a DM the model never saw. Stamped first, a degrade
    // can only ever come after it. A candidate that fails below is re-stamped `wait` by
    // the caller, which also clears this `sessionId`.
    await stampDmDelivery(record.id, { actual: 'steer', sessionId })

    // ---- synchronous from here to `enqueueSteer` ----
    const activeStream = getActiveStream(sessionId)
    const steerRun = getSteerRun(sessionId)
    if (!activeStream || !steerRun) {
      lastReason = STEER_NO_ACTIVE_TURN_REASON
      continue
    }
    if (steerRun.messageId !== activeStream.messageId) {
      lastReason = STEER_NO_ACTIVE_TURN_REASON
      continue
    }
    // The run's own verdict, not a second derivation of it — the same reason the route
    // reads it rather than re-deriving a transport-dependent answer (AMD-114-05) — asked
    // through `isDeliverableNow`, which is THE rule for "can this mode be delivered right
    // now" on both DM doors.
    const hasSteerableTurn = Boolean(steerRun.steerable && steerRun.lane)
    if (!isDeliverableNow('steer', { hasSteerableTurn })) {
      lastReason = steerRun.reason ?? STEER_NO_ACTIVE_TURN_REASON
      continue
    }

    const enqueued = enqueueSteer(sessionId, {
      steerId: record.id,
      messageId: activeStream.messageId,
      text: buildSteeredDmContent(record),
      at,
      source: 'dm',
      dmId: record.id,
      label: record.from.name
    })

    if (!enqueued.ok) {
      lastReason =
        enqueued.code === 'steer_dm_pending'
          ? STEER_DM_ALREADY_PENDING_REASON
          : enqueued.reason
      continue
    }

    // Fire-and-forget for the same reason the route does it (a `turn/steer` round trip has a
    // 120-second ceiling): the server already owns the text, and a refused write returns it
    // to the inbox where the end of the turn degrades it to `wait`.
    void flushPendingSteersToTransport(sessionId, activeStream.messageId).then((result) => {
      if (result.reason === 'refused') {
        console.warn('[SA-114] A managed CLI refused a DM steer; it will degrade to wait', {
          sessionId,
          dmId: record.id,
          error: result.error ?? null
        })
      }
    })

    return { ok: true, sessionId }
  }

  return { ok: false, reason: lastReason }
}

/**
 * F-P2-4 / DL-113-02: `to: 'all'` — one note, one `messageId`, one record per DM-enabled
 * API/CLI primary that accepts this sender, the sender excluded.
 *
 * Three deliberate limits, all from the lock:
 *
 *   - **`info` only.** An `assignment` to everybody has no single owner and would break
 *     one-assignment-at-a-time on N inboxes at once; a `result` answers one assignment.
 *   - **Never a wake.** "Tell everyone" must not start N turns; the lock says broadcast is
 *     for notes, and the per-instance hourly cap is not a design.
 *   - **Refusals are listed, not thrown.** One full inbox must not lose the note for the
 *     other five recipients, so each recipient's outcome is reported on its own line.
 */
async function broadcastDmOp(
  context: DmToolContext,
  sender: Record<string, any>,
  input: SendDmInput
): Promise<BroadcastDmResult> {
  if (input.kind !== 'info') {
    throw new DmToolError(
      `A broadcast to "all" can only be an info note, not a ${input.kind}.`,
      'Send an assignment to one agent so somebody owns it and reports back.'
    )
  }
  if (input.deliver !== 'wait') {
    // SA-114 P4 widened this from `=== 'wake'` to "anything but wait", which is the rule the
    // lock always meant: a broadcast must not start N turns, and for the same reason it must
    // not land inside N replies at once. Writing the positive rule rather than a carve-out
    // against one exception is SA-115's lesson (`sameSender`) — a carve-out breaks silently
    // the moment a third value exists, which is exactly what happened here.
    throw new DmToolError(
      `A broadcast to "all" cannot ${input.deliver} anybody.`,
      'Send it as deliver: "wait" — it appears in every inbox on their next turn — or wake or steer one agent by id.'
    )
  }

  const agents = await redis.getAgents(context.userId)
  const messageId = `dmb_${Date.now()}_${randomBytes(3).toString('hex')}`

  const delivered: BroadcastDmDelivery[] = []
  const skipped: BroadcastDmResult['skipped'] = []
  let expiresAt = ''

  for (const candidate of agents) {
    const record = candidate as unknown as Record<string, any>
    if (record.id === sender.id) continue
    if (!resolveAgentDmsEnabled(record)) continue
    const agentType = normalizePrimaryAgentType(record as any)
    if (agentType !== 'api' && agentType !== 'cli') continue
    if (!resolveDmSenderAllowed(record, sender.id)) {
      skipped.push({
        to: record.id,
        to_name: agentDisplayName(record),
        reason: 'That agent only accepts DMs from a chosen list, and you are not on it.'
      })
      continue
    }

    try {
      const created = await createDm({
        userId: context.userId,
        from: { kind: 'agent', agentId: sender.id, name: agentDisplayName(sender) },
        to: record.id,
        kind: 'info',
        subject: input.subject,
        body: input.body,
        priority: input.priority,
        deliver: 'wait',
        expiresInHours: input.expires_in_hours ?? null,
        senderSessionId: context.sessionId ?? null,
        messageId
      })
      expiresAt = created.expiresAt
      delivered.push({
        dm_id: created.id,
        to: record.id,
        to_name: agentDisplayName(record),
        delivered_as: 'wait'
      })
    } catch (error) {
      skipped.push({
        to: record.id,
        to_name: agentDisplayName(record),
        reason: error instanceof DmStoreError ? error.message : String(error)
      })
    }
  }

  if (delivered.length === 0) {
    throw new DmToolError(
      skipped.length > 0
        ? `Nobody received the broadcast: ${skipped.map((entry) => `${entry.to_name} — ${entry.reason}`).join('; ')}`
        : 'There is no other agent with Agent DMs turned on to broadcast to.',
      'Use sys.dm.agents to see who can receive DMs.'
    )
  }

  return { broadcast: true, message_id: messageId, delivered, skipped, expires_at: expiresAt }
}

/**
 * Load an agent that must be able to RECEIVE a DM: it exists, belongs to this user, is an
 * API or CLI primary, and has Agent DMs turned on.
 *
 * `field` names which input the id came from, because F-P2-2 uses this for
 * `report_back_to` as well as `to`, and a refusal that says "recipient" when the typo was
 * in `report_back_to` sends the agent looking in the wrong place.
 */
async function loadDmAddressableAgent(
  userId: string,
  value: unknown,
  field: 'to' | 'report_back_to'
): Promise<Record<string, any>> {
  const label = field === 'to' ? 'recipient' : 'report_back_to'
  const agentId = typeof value === 'string' ? value.trim() : ''
  if (!agentId) {
    throw new DmToolError(
      `A DM needs a ${label} agent id.`,
      'Use sys.dm.agents to see who can receive DMs.'
    )
  }
  const agent = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  if (!agent || (agent.user_id && agent.user_id !== userId)) {
    throw new DmToolError(
      `Agent "${agentId}" was not found (${field}).`,
      'Use sys.dm.agents to see who can receive DMs.'
    )
  }
  const agentType = normalizePrimaryAgentType(agent as any)
  if (agentType !== 'api' && agentType !== 'cli') {
    throw new DmToolError(
      `${agentDisplayName(agent)} is not an API or CLI primary agent, so it cannot receive DMs (${field}).`
    )
  }
  if (!resolveAgentDmsEnabled(agent)) {
    throw new DmToolError(
      `${agentDisplayName(agent)} does not have Agent DMs turned on (${field}).`,
      'The user turns that on per agent in Agent Settings.'
    )
  }
  return agent
}

/**
 * The wake half of a send. Every refusal degrades to `wait` with a readable reason, which
 * is written onto the DM AND returned to the sender — nothing is dropped, nothing retries,
 * nothing queues in the dark.
 */
async function deliverByWake(
  context: DmToolContext,
  record: DmRecord,
  recipient: Record<string, any>,
  options: {
    /**
     * SA-114 F-P4-1: set when this wake is a steer's fallback. A refusal's reason is
     * prefixed with it, so the record and the sender's answer never disagree about why the
     * steer became a wake and why that wake did not start.
     */
    steerReason?: string
  } = {}
): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
  const reasonPrefix = options.steerReason ? `${options.steerReason} ` : ''
  const chainDepth = await resolveSessionChainDepth(context.sessionId)
  if (chainDepth >= MAX_WAKE_CHAIN_DEPTH) {
    const reason = `${reasonPrefix}This wake-up chain is already ${chainDepth} deep and Batshit stops at ${MAX_WAKE_CHAIN_DEPTH}.`
    await stampDmDelivery(record.id, { actual: 'wait', reason })
    return { ok: false, reason }
  }

  const result: RequestAgentWakeupResult = await requestAgentWakeup({
    userId: context.userId,
    agentId: recipient.id,
    // A `result` lands where the question was asked; anything else follows the
    // recipient's working style (Parallel opens a chat, One at a time uses its current one).
    target:
      record.kind === 'result' && record.relatedDmId
        ? await resolveResultTarget(record)
        : { kind: 'auto', subject: record.subject },
    content: buildWokenDmContent(record),
    origin: {
      kind: 'dm',
      fromLabel: record.from.name,
      agentId: record.from.kind === 'agent' ? record.from.agentId : null,
      dmId: record.id
    },
    chainDepth,
    // One assignment at a time, checked as late as possible so it reflects the inbox at
    // the moment the turn would actually start.
    extraGuard:
      record.kind === 'assignment'
        ? async () => {
            const open = await listInbox(recipient.id)
            const held = open.find(
              (item) =>
                item.kind === 'assignment' &&
                item.status === 'working' &&
                item.id !== record.id
            )
            return held
              ? {
                  ok: false as const,
                  code: 'assignment_in_progress',
                  reason: `${agentDisplayName(recipient)} is already working an assignment (${held.id}), so this is waiting in its inbox.`
                }
              : { ok: true as const }
          }
        : undefined
  })

  if (!result.ok) {
    const reason = `${reasonPrefix}${result.reason}`
    await stampDmDelivery(record.id, { actual: 'wait', reason })
    return { ok: false, reason }
  }

  // A steer's reason, when there is one, is already on the record (the caller stamped the
  // miss before falling back here) and this merge keeps it: the drawer then says both that
  // the chat was woken and why the steer became a wake.
  await stampDmDelivery(record.id, { actual: 'wake', sessionId: result.sessionId })
  return { ok: true, sessionId: result.sessionId }
}

/**
 * Where a `result` wake lands: the session the assignment was sent from, so the answer
 * arrives in the chat where the question was asked. If that chat is gone, the recipient's
 * working style decides instead.
 */
async function resolveResultTarget(
  record: DmRecord
): Promise<{ kind: 'session'; sessionId: string } | { kind: 'auto'; subject: string }> {
  const related = record.relatedDmId ? await getDm(record.relatedDmId) : null
  const sessionId = related?.senderSessionId
  if (sessionId) {
    const session = await redis.getSession(sessionId)
    if (session) return { kind: 'session', sessionId }
  }
  return { kind: 'auto', subject: record.subject }
}

/* ------------------------------------------------------------------ *
 * list / read / claim / close
 * ------------------------------------------------------------------ */

export async function listDmsOp(
  context: DmToolContext,
  input?: { include_done?: boolean }
): Promise<{ open: DmSummary[]; total_open: number }> {
  await requireDmEnabledAgent(context.userId, context.agentId)
  // Settle off the FULL reaped set, then narrow for the reply.
  //
  // Reading with `includeClosed: false` filtered the just-expired items out before
  // `settleExpiredAssignments` ever saw them, so the "nobody picked this up" report only
  // fired when an agent happened to pass `include_done: true` — which is the rarer call.
  // One read either way; the filter simply moves after the settle.
  const all = await runStore(() => listInbox(context.agentId, { includeClosed: true }))
  await settleExpiredAssignments(context, all)
  const records =
    input?.include_done === true ? all : all.filter((record) => isOpenDmStatus(record.status))
  return {
    open: records.map(toDmSummary),
    total_open: records.filter((record) => record.status === 'new' || record.status === 'working')
      .length
  }
}

/** `read` is the ONLY operation that returns a body. `info` items acknowledge on read. */
export async function readDmOp(
  context: DmToolContext,
  input: { dm_id: string }
): Promise<{ dm: DmRecord }> {
  await requireDmEnabledAgent(context.userId, context.agentId)
  const record = await runStore(async () => {
    const found = await getDm(input.dm_id)
    if (!found || found.to !== context.agentId) {
      throw new DmStoreError(
        `DM "${input.dm_id}" is not in your inbox.`,
        'not_recipient',
        'Only the recipient can read a DM.'
      )
    }
    return found.kind === 'info'
      ? acknowledgeInfoDm(input.dm_id, context.agentId)
      : found
  })
  return { dm: record }
}

export async function claimDmOp(
  context: DmToolContext,
  input: { dm_id: string }
): Promise<{ dm: DmSummary }> {
  await requireDmEnabledAgent(context.userId, context.agentId)
  const record = await runStore(() =>
    claimDm({
      dmId: input.dm_id,
      agentId: context.agentId,
      sessionId: context.sessionId ?? null
    })
  )
  return { dm: toDmSummary(record) }
}

export async function closeDmOp(
  context: DmToolContext,
  input: { dm_id: string; result: string },
  status: 'done' | 'blocked'
): Promise<{
  dm: DmSummary
  result_dm_id?: string
  result_delivered_as?: 'wait' | 'wake'
  callback_status?: string
}> {
  const agent = await requireDmEnabledAgent(context.userId, context.agentId)
  const record = await runStore(() =>
    closeDm({
      dmId: input.dm_id,
      agentId: context.agentId,
      status,
      result: input.result
    })
  )

  // Closing an assignment CREATES its result in the same act, so the report-back the
  // mailbox README only asks for cannot be forgotten.
  const reported = await reportBack(context, agent, record)

  // P3 (DL-113-09): a webhook-sent item may carry a one-shot callback. It fires here,
  // after the close is durable, so a callback failure can never lose the agent's result.
  const callbackStatus = await fireWakeCallback(agent, record)

  return {
    dm: toDmSummary(record),
    ...(reported ?? {}),
    ...(callbackStatus ? { callback_status: callbackStatus } : {})
  }
}

/**
 * Fire the webhook result callback once, if this item has one and has not already fired.
 *
 * `callbackStatus` doubles as the "already fired" marker, which is why it is written even
 * when the attempt failed: a second close cannot happen (terminal is terminal), but a
 * retried close of a DIFFERENT item must not resend this one's.
 */
async function fireWakeCallback(
  agent: Record<string, any>,
  record: DmRecord
): Promise<string | null> {
  if (!record.callbackUrl || record.callbackStatus) return null

  const status = await deliverWakeCallback(record.callbackUrl, {
    dm_id: record.id,
    status: record.status,
    result: record.result ?? '',
    agent: { id: agent.id, name: agentDisplayName(agent) },
    completed_at: record.completedAt ?? new Date().toISOString()
  })

  try {
    await setDmCallbackStatus(record.id, status)
  } catch (error) {
    console.warn('[Agent DMs] Could not record a callback outcome:', error)
  }
  return status
}

async function reportBack(
  context: DmToolContext,
  agent: Record<string, any>,
  record: DmRecord
): Promise<{ result_dm_id: string; result_delivered_as: 'wait' | 'wake' } | null> {
  if (record.kind !== 'assignment' || !record.reportBackTo || record.resultDmId) return null

  const deliver = record.resultDelivery ?? 'wait'
  let resultRecord: DmRecord
  try {
    resultRecord = await createDm({
      userId: context.userId,
      from: { kind: 'agent', agentId: agent.id, name: agentDisplayName(agent) },
      to: record.reportBackTo,
      kind: 'result',
      subject: `Result: ${record.subject}`,
      body: record.result ?? '(no result text)',
      priority: record.priority,
      relatedDmId: record.id,
      deliver,
      senderSessionId: context.sessionId ?? null
    })
  } catch (error) {
    // The assignment IS closed; failing to deliver its result must be visible, not silent.
    console.error('[Agent DMs] Could not create the result DM for a closed assignment:', {
      dmId: record.id,
      reportBackTo: record.reportBackTo,
      error: error instanceof Error ? error.message : String(error)
    })
    throw new DmToolError(
      `The item was closed, but the result DM to "${record.reportBackTo}" could not be created: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'Tell the user; the closed item still holds your result text.'
    )
  }

  await linkResultDm(record.id, resultRecord.id)

  let deliveredAs: 'wait' | 'wake' = 'wait'
  if (deliver === 'wake') {
    const recipient = (await redis.get(`agent:${record.reportBackTo}`)) as Record<
      string,
      any
    > | null
    if (recipient && resolveAgentDmsEnabled(recipient)) {
      const wake = await deliverByWake(context, resultRecord, recipient)
      deliveredAs = wake.ok ? 'wake' : 'wait'
    }
  }

  return { result_dm_id: resultRecord.id, result_delivered_as: deliveredAs }
}

/**
 * An assignment that expired with nobody claiming it owes its sender a result, so nobody
 * is left guessing whether it was ever picked up. Best-effort by design: this runs off a
 * read, and a failure here must never make a `list` fail.
 *
 * The report is sent FROM the inbox it expired in, exactly as `reportBack` sends a real
 * close from the closing agent. Sending it from `record.from` — the original sender —
 * addressed the DM back to that same agent in the normal case, because `report_back_to` is
 * almost always the sender itself; `createDm`'s self-send guard then threw, the `catch`
 * below swallowed it as a warning, `resultDmId` was never linked, and every later `list`
 * retried the same failing write. The sender was never told, which is the one thing this
 * function exists to do.
 */
async function settleExpiredAssignments(
  context: DmToolContext,
  records: DmRecord[]
): Promise<void> {
  const owing = selectExpiredAssignmentsNeedingResult(records)
  if (owing.length === 0) return

  const inboxAgent = (await redis.get(`agent:${context.agentId}`)) as Record<string, any> | null

  for (const record of owing) {
    // `report_back_to` may name the very agent whose inbox this is (an agent assigning to
    // itself is impossible, but a third party can name the recipient as the reporter). That
    // would be a self-send again, so leave it: there is nobody to tell.
    if (record.reportBackTo === record.to) continue
    try {
      const created = await createDm({
        userId: context.userId,
        from: {
          kind: 'agent',
          agentId: record.to,
          name: inboxAgent ? agentDisplayName(inboxAgent) : record.to
        },
        to: record.reportBackTo as string,
        kind: 'result',
        subject: `Result: ${record.subject}`,
        body: `This assignment expired unclaimed on ${record.expiresAt}. Nobody picked it up.`,
        relatedDmId: record.id,
        deliver: 'wait'
      })
      await linkResultDm(record.id, created.id)
    } catch (error) {
      console.warn('[Agent DMs] Could not report an expired unclaimed assignment:', {
        dmId: record.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

/* ------------------------------------------------------------------ *
 * Wake-up webhooks (DL-113-09)
 * ------------------------------------------------------------------ */

export interface WebhookDmInput {
  message: string
  subject?: string
  kind?: 'info' | 'assignment'
  deliver?: 'wait' | 'wake'
  priority?: DmPriority
  callback_url?: string
  expires_in_hours?: number
  requested_outcome?: string
  scope?: string
}

export interface WebhookDmResult {
  dm_id: string
  delivered_as: 'wait' | 'wake'
  reason?: string
  session_id?: string
  expires_at: string
  agent: { id: string; name: string }
}

/**
 * Turn one authenticated hook call into a DM, then deliver it exactly the way an agent's
 * own DM is delivered.
 *
 * **A webhook's recipient needs Agent DMs ON, not just "May be woken".** DL-113-09 does not
 * say so, so this is recorded as AMD-113-05, and the reason is that a webhook call writes a
 * DM record: an agent with DMs off has no roster to see it in and no `sys.dm.*` tools to
 * close it with, so a `wait` call would land in a black hole and a `wake` call could never
 * fire its callback. Refusing at the route, with the switch named, is the honest version.
 *
 * A hook may only write `info` or `assignment`. A `result` answers an assignment somebody
 * else made, and a program has no assignment to answer.
 */
export async function deliverWebhookDm(options: {
  hook: WakeHookRecord
  input: WebhookDmInput
}): Promise<WebhookDmResult> {
  const { hook, input } = options

  const recipient = (await redis.get(`agent:${hook.agentId}`)) as Record<string, any> | null
  if (!recipient || (recipient.user_id && recipient.user_id !== hook.userId)) {
    throw new DmToolError(
      `The agent this webhook writes to (${hook.agentId}) no longer exists.`,
      'Delete this webhook, or create a new one pointing at an agent that exists.'
    )
  }
  const agentType = normalizePrimaryAgentType(recipient as any)
  if (agentType !== 'api' && agentType !== 'cli') {
    throw new DmToolError(
      `${agentDisplayName(recipient)} is not an API or CLI primary agent, so a webhook cannot write to it.`
    )
  }
  if (!resolveAgentDmsEnabled(recipient)) {
    throw new DmToolError(
      `${agentDisplayName(recipient)} does not have Agent DMs turned on, so it would never see this.`,
      'Turn on Agent DMs for that agent in Agent Settings.'
    )
  }

  const kind: DmKind = input.kind === 'assignment' ? 'assignment' : 'info'
  const deliver: 'wait' | 'wake' =
    input.deliver === 'wait' || input.deliver === 'wake' ? input.deliver : hook.deliverDefault

  if (input.callback_url !== undefined && !isAllowedCallbackUrl(input.callback_url)) {
    throw new DmToolError(
      'callback_url must be an http or https URL.',
      'Point it at the address that should receive the result, for example an n8n webhook.'
    )
  }
  if (input.callback_url && kind !== 'assignment') {
    throw new DmToolError(
      'Only an assignment can have a callback_url, because only an assignment is closed with a result.',
      'Send kind: "assignment" with requested_outcome and scope.'
    )
  }

  const subject = (input.subject ?? '').trim() || defaultWebhookSubject(hook, input.message)

  const record = await runStore(() =>
    createDm({
      userId: hook.userId,
      from: { kind: 'webhook', hookId: hook.id, name: hook.name },
      to: recipient.id,
      kind,
      subject,
      body: input.message,
      priority: input.priority,
      // A program has no inbox, so a webhook assignment has NO `reportBackTo` — its report
      // back is the one-shot `callbackUrl`. The two other assignment fields still have to
      // say something, and a stated default the agent can read in its own first message is
      // better than refusing every caller that did not know to send them.
      ...(kind === 'assignment'
        ? {
            requestedOutcome:
              input.requested_outcome?.trim() || 'Do what the message asks and say what happened.',
            scope: input.scope?.trim() || 'Only what this message asks for.'
          }
        : {}),
      deliver,
      expiresInHours: input.expires_in_hours ?? null,
      ...(input.callback_url ? { callbackUrl: input.callback_url } : {})
    })
  )

  const agent = { id: recipient.id, name: agentDisplayName(recipient) }

  if (deliver !== 'wake') {
    return {
      dm_id: record.id,
      delivered_as: 'wait',
      expires_at: record.expiresAt,
      agent
    }
  }

  const result = await requestAgentWakeup({
    userId: hook.userId,
    agentId: recipient.id,
    target: { kind: 'auto', subject: record.subject },
    content: buildWokenDmContent(record),
    origin: { kind: 'webhook', fromLabel: hook.name, hookId: hook.id, dmId: record.id },
    // A program starts a chain, it does not continue one. Depth 0 always.
    chainDepth: 0
  })

  if (!result.ok) {
    await stampDmDelivery(record.id, { actual: 'wait', reason: result.reason })
    return {
      dm_id: record.id,
      delivered_as: 'wait',
      reason: result.reason,
      expires_at: record.expiresAt,
      agent
    }
  }

  await stampDmDelivery(record.id, { actual: 'wake', sessionId: result.sessionId })
  return {
    dm_id: record.id,
    delivered_as: 'wake',
    session_id: result.sessionId,
    expires_at: record.expiresAt,
    agent
  }
}

/**
 * A subject is required on every DM, and a program often has only a message. The first
 * line, trimmed, is a far better inbox row than the hook's name repeated forever.
 */
function defaultWebhookSubject(hook: WakeHookRecord, message: string): string {
  const firstLine = (message ?? '').split('\n').find((line) => line.trim())?.trim() ?? ''
  if (!firstLine) return hook.name
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
}

/* ------------------------------------------------------------------ *
 * Scheduled wake-ups (SA-115, DL-115-05)
 * ------------------------------------------------------------------ */

export interface ScheduledDmResult {
  dmId: string
  deliveredAs: 'wait' | 'wake'
  reason?: string
  sessionId?: string
  /** The sentence the schedule's `lastOutcome` stores and the Admin card shows. */
  outcome: string
}

/**
 * Fire one schedule: write its DM, then deliver it exactly the way an agent's own DM and
 * a webhook's DM are delivered.
 *
 * **This goes through the DM record on purpose.** Doing so buys the drawer row, the header
 * badge, the DCM roster line, claim/done, the delivery outcome, `needsUser` when a woken
 * turn parks on a tool approval, and the `agent_busy` degrade — all for free, and all
 * identical to the other two wake sources. A fire that talked to the wake primitive
 * directly would have to re-earn every one of them.
 *
 * The recipient checks are `deliverWebhookDm`'s, including **Agent DMs ON** rather than
 * just "May be woken" (AMD-113-05): a fire writes a DM, and an agent with DMs off has no
 * roster to see it in and no `sys.dm.*` tools to close it with.
 *
 * `chainDepth: 0` always. A clock starts a chain; it never continues one.
 */
export async function deliverScheduledDm(
  schedule: ScheduleRecord,
  options: { trigger: 'tick' | 'run-now'; dueAt?: Date | null; now?: Date }
): Promise<ScheduledDmResult> {
  const recipient = (await redis.get(`agent:${schedule.agentId}`)) as Record<string, any> | null
  if (!recipient || (recipient.user_id && recipient.user_id !== schedule.userId)) {
    throw new DmToolError(
      `The agent this schedule writes to (${schedule.agentId}) no longer exists.`,
      'Delete this schedule, or point it at an agent that exists.'
    )
  }
  const agentType = normalizePrimaryAgentType(recipient as any)
  if (agentType !== 'api' && agentType !== 'cli') {
    throw new DmToolError(
      `${agentDisplayName(recipient)} is not an API or CLI primary agent, so a schedule cannot write to it.`
    )
  }
  if (!resolveAgentDmsEnabled(recipient)) {
    throw new DmToolError(
      `${agentDisplayName(recipient)} does not have Agent DMs turned on, so it would never see this.`,
      'Turn on Agent DMs for that agent in Agent Settings.'
    )
  }

  const now = options.now ?? new Date()
  const record = await runStore(() =>
    createDm({
      userId: schedule.userId,
      from: { kind: 'schedule', scheduleId: schedule.id, name: schedule.name },
      to: recipient.id,
      kind: schedule.kind,
      subject: schedule.name,
      body: buildScheduledDmBody(schedule, options.dueAt ?? null, now),
      // A schedule has no inbox, so like a webhook its assignment has NO `reportBackTo`.
      // Its outcome is visible on the schedule's own card and in the DM drawer instead.
      ...(schedule.kind === 'assignment'
        ? {
            requestedOutcome: 'Do what the message asks and say what happened.',
            scope: 'Only what this message asks for.'
          }
        : {}),
      deliver: schedule.deliver
    })
  )

  if (schedule.deliver !== 'wake') {
    return {
      dmId: record.id,
      deliveredAs: 'wait',
      outcome: 'waiting in inbox'
    }
  }

  const result = await requestAgentWakeup({
    userId: schedule.userId,
    agentId: recipient.id,
    target: { kind: 'auto', subject: record.subject },
    content: buildWokenDmContent(record),
    origin: {
      kind: 'schedule',
      fromLabel: schedule.name,
      scheduleId: schedule.id,
      dmId: record.id
    },
    chainDepth: 0
  })

  if (!result.ok) {
    await stampDmDelivery(record.id, { actual: 'wait', reason: result.reason })
    return {
      dmId: record.id,
      deliveredAs: 'wait',
      reason: result.reason,
      outcome: `waited: ${result.reason}`
    }
  }

  await stampDmDelivery(record.id, { actual: 'wake', sessionId: result.sessionId })
  return {
    dmId: record.id,
    deliveredAs: 'wake',
    sessionId: result.sessionId,
    outcome: `woke: ${result.sessionId}`
  }
}

/**
 * The DM body: the schedule's message, plus one line naming the slot when this run is
 * genuinely late.
 *
 * DL-115-08 requires a late fire to say when it was due, so an agent reading "run the
 * morning check" at 09:07 knows it is the 09:00 run. Anything inside one tick is the
 * ticker's own granularity rather than lateness, so it says nothing.
 */
function buildScheduledDmBody(
  schedule: ScheduleRecord,
  dueAt: Date | null,
  now: Date
): string {
  if (!dueAt || !Number.isFinite(dueAt.getTime())) return schedule.message
  if (now.getTime() - dueAt.getTime() <= SCHEDULE_TICK_MS) return schedule.message
  return [
    schedule.message,
    '',
    `(This run was due ${describeNextRun(dueAt, schedule.timeZone)} and is running late.)`
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * Error translation
 * ------------------------------------------------------------------ */

async function runStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DmStoreError) {
      throw new DmToolError(error.message, error.hint)
    }
    throw error
  }
}

/** Exposed for the wake registry's tests and the P4 drawer's live badge. */
export function isAgentMidWokenTurn(agentId: string): boolean {
  return Boolean(findWakeRunForAgent(agentId))
}

/** Exposed for the interrupt route so a drawer Stop can target the right run. */
export function getWokenRunForSession(sessionId: string) {
  return getWakeRun(sessionId)
}
