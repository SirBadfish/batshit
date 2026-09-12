/**
 * SA-113 P1 (DL-113-05) — the wake-up primitive.
 *
 * A wake-up is a chat turn Batshit starts with nobody typing. In v1 two things ask for
 * one: a DM whose sender chose `wake` (P2), and a wake-up webhook (P3). Both land here,
 * and `SA-111b`'s "a background worker finished" wake will land here too.
 *
 * The shape is not invented. `routes/api/voice/livekit/turn/+server.ts` already runs a
 * chat turn with no browser: it saves the user message itself, re-reads history from
 * Redis, and POSTs to `/api/messages/send-routed` with the service token and a `userId`
 * in the body. This primitive does the same, and adds the four things a woken turn needs
 * that a voice turn does not: it CREATES the session, it records what started it, it is
 * bounded by caps and a hard timeout, and it is visible and stoppable while it runs.
 *
 * Going THROUGH send-routed rather than around it is the load-bearing decision. It keeps
 * the session-turn lock, the dreaming/nap interlock, failed-send persistence, the
 * context-exhaustion auto-continue, usage stamping, and Execution Viewer capture exactly
 * as they are for a turn the user typed.
 *
 * Nothing here retries and nothing queues in the dark: every refusal degrades the wake to
 * `wait` with a readable reason, which the caller records on the DM and shows in the
 * sender's tool result.
 */

import { redis } from '$lib/server/redis'
import { randomBytes } from 'node:crypto'
import { resolveCliHelperBatshitBaseUrl } from '$lib/server/services/cliHelperBaseUrl'
import {
  getConfiguredInternalToken,
  internalServiceHeaders
} from '$lib/server/services/internalRequestAuth'
import { hasPendingToolApproval } from '$lib/server/services/dm/pendingToolApproval'
import { getActiveSessionTurn } from '$lib/server/services/streamAbortRegistry'
import {
  abortWakeRun,
  clearWakeRun,
  getWakeRun,
  registerWakeRun,
  releaseWakeSlot,
  reserveWakeSlot,
  type WakeRunEndReason
} from '$lib/server/services/wakeRunRegistry'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { generateMessageId } from '$lib/utils/messageId'
import {
  MAX_WAKE_CHAIN_DEPTH,
  resolveAgentWakeEnabled,
  resolveInstanceWakeupsEnabled,
  resolveWakeTarget,
  resolveWakeTimeoutMs
} from '$lib/utils/dmControl'
import { isFixedSession, resolveFixedSessionAgentId } from '$lib/utils/fixedSession'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import {
  buildSessionOrigin,
  buildWokenSessionName,
  type SessionOrigin,
  type SessionOriginKind
} from '$lib/utils/sessionOrigin'
import type { AgentRow, ChatMessage, ChatSessionRow } from '$lib/types/database'

/* ------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------ */

export type WakeTargetInput =
  | { kind: 'new-session'; name?: string | null; subject?: string | null }
  /** A named existing session: a `result` landing where the question was asked. */
  | { kind: 'session'; sessionId: string }
  /** Let the recipient's working style decide (DL-113-15). */
  | { kind: 'auto'; subject?: string | null }

export interface WakeOriginInput {
  kind: SessionOriginKind
  /** Frozen display name: the sending agent, the hook's name, or the schedule's name. */
  fromLabel: string
  agentId?: string | null
  dmId?: string | null
  hookId?: string | null
  /** SA-115: the schedule that fired, for `kind: 'schedule'`. */
  scheduleId?: string | null
}

export interface RequestAgentWakeupInput {
  userId: string
  /** The agent being woken. */
  agentId: string
  target: WakeTargetInput
  /** The visible first message of the woken turn, header already applied by the caller. */
  content: string
  origin: WakeOriginInput
  /** Depth of the wake that CAUSED this one. A human or a webhook starts at 0. */
  chainDepth: number
  /**
   * Runs last, after every wake check passes and before anything is written. P2 uses it
   * for "one assignment at a time" so the DM store stays out of the wake primitive while
   * DL-113-05's check ORDER still lives in one place.
   */
  extraGuard?: () => Promise<{ ok: true } | { ok: false; code: string; reason: string }>
}

export type WakeRefusalCode =
  | 'wake_disabled_instance'
  | 'wake_disabled_agent'
  | 'agent_not_found'
  | 'agent_not_primary'
  | 'chain_depth_exceeded'
  | 'wake_rate_limit_agent'
  | 'wake_rate_limit_instance'
  | 'wake_running_limit_agent'
  | 'wake_running_limit_instance'
  | 'session_not_found'
  | 'session_is_group'
  | 'session_agent_mismatch'
  | 'agent_busy'
  | 'service_token_missing'
  | 'wake_setup_failed'
  | string

export type RequestAgentWakeupResult =
  | {
      ok: true
      sessionId: string
      messageId: string
      createdSession: boolean
      chainDepth: number
    }
  | { ok: false; degraded: 'wait'; code: WakeRefusalCode; reason: string }

function refuse(code: WakeRefusalCode, reason: string): RequestAgentWakeupResult {
  return { ok: false, degraded: 'wait', code, reason }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function readSessionAgentId(session: ChatSessionRow | null | undefined): string | null {
  if (!session) return null
  const metadata = (session.metadata ?? {}) as Record<string, any>
  const candidates = [
    session.agent_id,
    metadata.last_agent_id,
    metadata.lastAgentId,
    metadata.agent_id,
    metadata.agentId
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return null
}

function isGroupSession(session: ChatSessionRow | null | undefined): boolean {
  const metadata = (session?.metadata ?? {}) as Record<string, any>
  return Boolean(metadata.group_chat?.group_id)
}

/**
 * The address Batshit uses to call ITSELF for a woken turn. Server-owned, always.
 *
 * This deliberately never reads the inbound request's URL (F-P3-1). Under `adapter-node`
 * `request.url` follows the `Host` header whenever `ORIGIN` is unset, and `npm run dev`
 * always follows it — so an inbound caller could have chosen the host that receives
 * `x-batshit-service-token`. `POST /api/wake/{hookId}` is reachable from outside the
 * machine whenever a tunnel is running, which is exactly the case where that matters.
 * One rule, the same one the managed CLI helpers already use to call back into the app,
 * container lane included.
 */
function resolveOriginBase(): string {
  return resolveCliHelperBatshitBaseUrl()
}

/**
 * A collision-proof session id for a server-created session. `POST /api/sessions` builds a
 * human-readable timestamp and then read-checks it against every existing session, which
 * is not atomic; a wake-up can fire while the user is making a chat, so this appends
 * random entropy and still re-checks.
 */
async function allocateWokenSessionId(userId: string): Promise<string> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15)
  const existing = await redis.getSessions(userId, true)
  const taken = new Set(existing.map((session) => session.id))
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // Crypto randomness, not Math.random(): a session id is a security value (CodeQL
    // js/insecure-randomness), and six hex characters keep the readable shape.
    const candidate = `wake-${stamp}-${randomBytes(3).toString('hex')}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('WAKEUP_SESSION_ID_UNAVAILABLE: could not allocate a session id.')
}

/**
 * DL-113-15 "One at a time": the agent's current chat is its most recently touched
 * non-archived, non-group session. A group session is never a target because a group has
 * its own turn queue.
 */
export function selectCurrentSessionForAgent(
  sessions: ChatSessionRow[],
  agentId: string
): ChatSessionRow | null {
  const candidates = sessions.filter(
    (session) =>
      !session.archived &&
      !isGroupSession(session) &&
      readSessionAgentId(session) === agentId
  )
  if (candidates.length === 0) return null
  return candidates.reduce((newest, session) => {
    const a = Date.parse(session.last_modified_at ?? '') || 0
    const b = Date.parse(newest.last_modified_at ?? '') || 0
    return a > b ? session : newest
  })
}

/* ------------------------------------------------------------------ *
 * The primitive
 * ------------------------------------------------------------------ */

/** Holds the F-P1-3 running-slot reservation so one `finally` covers every exit. */
interface WakeSlotHolder {
  id: string | null
}

export async function requestAgentWakeup(
  input: RequestAgentWakeupInput
): Promise<RequestAgentWakeupResult> {
  const slot: WakeSlotHolder = { id: null }
  try {
    return await runAgentWakeup(input, slot)
  } finally {
    // A no-op once `registerWakeRun` has consumed the reservation; on every refusal path
    // — and on any throw between the cap check and registration — this is what gives the
    // held slot back. F-P1-3 asks for exactly one release point, not one per branch.
    releaseWakeSlot(slot.id)
  }
}

async function runAgentWakeup(
  input: RequestAgentWakeupInput,
  slot: WakeSlotHolder
): Promise<RequestAgentWakeupResult> {
  const nextChainDepth = Math.max(0, Math.floor(input.chainDepth)) + 1

  // 1) Admin master switch.
  let adminSettings: unknown = null
  try {
    const settings = await redis.getUserSettings(input.userId)
    adminSettings = (settings as any)?.admin_settings ?? null
  } catch (error) {
    console.error('[Wake-up] Failed to read admin settings:', error)
  }
  if (!resolveInstanceWakeupsEnabled(adminSettings)) {
    return refuse(
      'wake_disabled_instance',
      'Wake-ups are turned off for this Batshit (Admin -> Instance-wide defaults).'
    )
  }

  // 2) The recipient exists and may be woken.
  const agents = await redis.getAgents(input.userId)
  const agent = agents.find((candidate) => candidate.id === input.agentId) as
    | AgentRow
    | undefined
  if (!agent || agent.user_id !== input.userId) {
    return refuse('agent_not_found', 'That agent does not exist on this Batshit.')
  }
  if (!resolveAgentWakeEnabled(agent)) {
    return refuse(
      'wake_disabled_agent',
      `${agent.displayName ?? 'That agent'} has "May be woken" turned off.`
    )
  }

  // 3) The recipient is a live primary agent. Groups are not agents and never woken.
  const agentType = normalizePrimaryAgentType(agent as any)
  if (agentType !== 'api' && agentType !== 'cli') {
    return refuse(
      'agent_not_primary',
      'Only API and CLI primary agents can be woken.'
    )
  }

  // 4) Chain depth: A wakes B, B wakes C… stops at three.
  if (nextChainDepth > MAX_WAKE_CHAIN_DEPTH) {
    return refuse(
      'chain_depth_exceeded',
      `This wake-up chain is already ${input.chainDepth} deep and Batshit stops at ${MAX_WAKE_CHAIN_DEPTH}.`
    )
  }

  // 5 + 6) Hourly budgets and running caps. Checked and HELD in one synchronous step
  // (F-P1-3): everything below this line awaits Redis, so two wakes for one agent
  // arriving together would otherwise both pass the one-per-agent running cap.
  const reservation = reserveWakeSlot(input.agentId)
  if (!reservation.ok) return refuse(reservation.code, reservation.reason)
  slot.id = reservation.reservationId

  // 7) Resolve the target session, honouring the recipient's working style.
  let targetSession: ChatSessionRow | null = null
  let createSessionRequest: { name: string } | null = null

  const requestedTarget: WakeTargetInput =
    input.target.kind === 'auto'
      ? resolveWakeTarget(agent) === 'current-session'
        ? { kind: 'auto', subject: input.target.subject }
        : { kind: 'new-session', subject: input.target.subject }
      : input.target

  if (requestedTarget.kind === 'session') {
    targetSession = await redis.getSession(requestedTarget.sessionId)
    if (!targetSession || targetSession.user_id !== input.userId) {
      return refuse('session_not_found', 'That chat no longer exists.')
    }
    if (isGroupSession(targetSession)) {
      return refuse(
        'session_is_group',
        'A group chat has its own turn queue and cannot receive a wake-up.'
      )
    }
    const sessionAgentId = readSessionAgentId(targetSession)
    if (sessionAgentId && sessionAgentId !== input.agentId) {
      return refuse(
        'session_agent_mismatch',
        'That chat belongs to a different agent.'
      )
    }
    if (isFixedSession(targetSession)) {
      const fixedAgentId = resolveFixedSessionAgentId(targetSession)
      if (fixedAgentId && fixedAgentId !== input.agentId) {
        return refuse(
          'session_agent_mismatch',
          'That Infinite Session is bound to a different agent.'
        )
      }
    }
  } else if (requestedTarget.kind === 'auto') {
    // Working style "One at a time": land in the agent's current chat.
    const sessions = await redis.getSessions(input.userId, false)
    targetSession = selectCurrentSessionForAgent(sessions, input.agentId)
    if (!targetSession) {
      // No chat yet — a new session is the only honest place to put this.
      createSessionRequest = {
        name: buildWokenSessionName({
          kind: input.origin.kind,
          label: input.origin.fromLabel,
          subject: requestedTarget.subject
        })
      }
    }
  } else {
    createSessionRequest = {
      name:
        requestedTarget.name?.trim() ||
        buildWokenSessionName({
          kind: input.origin.kind,
          label: input.origin.fromLabel,
          subject: requestedTarget.subject
        })
    }
  }

  if (targetSession && getActiveSessionTurn(targetSession.id)) {
    return refuse(
      'agent_busy',
      `${agent.displayName ?? 'That agent'} is mid-task, so this is waiting in its inbox instead.`
    )
  }

  // 8) Caller-supplied last check (P2: one assignment at a time).
  if (input.extraGuard) {
    const guard = await input.extraGuard()
    if (!guard.ok) return refuse(guard.code, guard.reason)
  }

  // Fail loudly rather than sending `{}` headers and 401-ing inside send-routed with a
  // confusing message (recon 2.2).
  if (!getConfiguredInternalToken()) {
    console.error(
      '[Wake-up] WAKEUP_SERVICE_TOKEN_MISSING: BATSHIT_TOKEN is not configured, so Batshit cannot start a turn for an agent.'
    )
    return refuse(
      'service_token_missing',
      'Batshit has no service token configured, so it cannot start a turn on its own. Set BATSHIT_TOKEN and restart.'
    )
  }

  const origin: SessionOrigin = buildSessionOrigin({
    kind: input.origin.kind,
    label: input.origin.fromLabel,
    agentId: input.origin.agentId,
    dmId: input.origin.dmId,
    hookId: input.origin.hookId,
    scheduleId: input.origin.scheduleId,
    chainDepth: nextChainDepth
  })

  let createdSession = false
  try {
    if (!targetSession) {
      const sessionId = await allocateWokenSessionId(input.userId)
      const now = new Date().toISOString()
      targetSession = await redis.createSession({
        id: sessionId,
        user_id: input.userId,
        name: createSessionRequest?.name ?? 'Wake-up',
        agent_id: input.agentId,
        created_at: now,
        last_modified_at: now,
        locked: false,
        metadata: {
          agent_id: input.agentId,
          last_agent_id: input.agentId,
          origin
        }
      })
      createdSession = true
    }
  } catch (error) {
    console.error('[Wake-up] Failed to create the woken session:', error)
    return refuse(
      'wake_setup_failed',
      'Batshit could not open a chat for this wake-up, so it is waiting in the inbox instead.'
    )
  }

  const sessionId = targetSession.id
  const messageId = await generateMessageId(sessionId)
  if (!messageId) {
    return refuse(
      'wake_setup_failed',
      'Batshit could not prepare the wake-up message, so it is waiting in the inbox instead.'
    )
  }

  // F-P1-1 — the woken turn must OWN its session-turn lock.
  //
  // send-routed registers and releases the lock under the `messageId` the caller sends,
  // and `clearSessionTurn(sessionId, null)` deletes unconditionally. Posting no id meant
  // a woken turn stopped during setup could delete the lock of a live turn the user had
  // already started in the same chat — the exact case the ownership rule exists for. The
  // browser generates its assistant placeholder id up front; so does this now.
  const assistantMessageId = await generateMessageId(sessionId)
  if (!assistantMessageId) {
    return refuse(
      'wake_setup_failed',
      'Batshit could not prepare the wake-up turn, so it is waiting in the inbox instead.'
    )
  }

  const now = new Date().toISOString()
  const userMessage: ChatMessage = {
    id: messageId,
    session_id: sessionId,
    user_id: input.userId,
    agent_id: input.agentId,
    role: 'user',
    status: 'complete',
    content: input.content,
    created_at: now,
    metadata: {
      origin,
      // F-SEC-1b: `dmId` rides on `metadata.wake` and not only on `origin`, because
      // `useControl` reads THIS message to decide whether the turn is a woken one and must
      // be able to stamp the DM from the same read. Waking INTO an existing chat (the "One
      // at a time" working style) makes the session's own `origin` the FIRST wake's, so the
      // message is the only place the current DM id is correct.
      wake: {
        chainDepth: nextChainDepth,
        ...(input.origin.dmId ? { dmId: input.origin.dmId } : {})
      }
    }
  }

  try {
    await redis.saveMessage(userMessage)
  } catch (error) {
    console.error('[Wake-up] Failed to persist the wake-up message:', error)
    return refuse(
      'wake_setup_failed',
      'Batshit could not save the wake-up message, so it is waiting in the inbox instead.'
    )
  }

  const originBase = resolveOriginBase()

  // A tab already on this chat should see the incoming message right away. No top-level
  // messageId: the replay buffer is keyed on the ASSISTANT message id, and a user message
  // filed under its own id would survive that buffer's end-of-turn cleanup.
  try {
    await fetch(`${originBase}/api/sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalServiceHeaders() },
      body: JSON.stringify({
        type: 'user_message',
        sessionId,
        message: userMessage
      })
    })
  } catch (error) {
    console.warn('[Wake-up] Could not forward the wake-up user message to SSE:', error)
  }

  const timeoutMs = resolveWakeTimeoutMs(agent)
  const controller = new AbortController()
  const timer = setTimeout(() => {
    void endWokenTurn({
      sessionId,
      reason: 'timed_out',
      originBase,
      userId: input.userId
    })
  }, timeoutMs)
  // A woken turn can outlive its timer's event-loop turn without holding the process open.
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref()

  registerWakeRun(
    {
      sessionId,
      agentId: input.agentId,
      userId: input.userId,
      origin,
      startedAt: Date.now(),
      controller,
      timer
    },
    slot.id
  )

  if (createdSession) {
    await publishUserEvent(input.userId, {
      type: 'session_created',
      session: targetSession
    })
  }
  await publishUserEvent(input.userId, {
    type: 'session_run_status',
    sessionId,
    status: 'running',
    owner: 'server',
    origin
  })

  // Fire-and-forget on purpose: the caller is a tool call or a webhook that must answer
  // now, and the turn is watchable in the chat and stoppable from the sidebar.
  // F-P2-1: the RECENT 300. `getMessages` is head-first, so waking INTO an existing chat
  // (a `result`, or "One at a time") longer than 300 messages would have posted ancient
  // history and left out the DM message this turn is about.
  const history = await redis.getRecentMessages(sessionId, 300)
  const runPromise = fetch(`${originBase}/api/messages/send-routed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...internalServiceHeaders() },
    signal: controller.signal,
    body: JSON.stringify({
      content: input.content,
      sessionId,
      agentId: input.agentId,
      userId: input.userId,
      messageId: assistantMessageId,
      messages: history,
      metadata: {
        wake: {
          chainDepth: nextChainDepth,
          origin,
          ...(input.origin.dmId ? { dmId: input.origin.dmId } : {})
        }
      }
    })
  })

  void runPromise
    .then(async (response) => {
      // 499 is send-routed's "interrupted" answer, which Stop and the timeout already
      // reported. F-P1-4: a 409 is not a failure either — the user started a turn in this
      // chat between the busy check and this POST, so the wake becomes a `wait`. The
      // message is already in the chat and the DM shows on that chat's next turn.
      let reason: WakeRunEndReason = 'completed'
      if (response.status === 409) {
        reason = 'agent_busy'
      } else if (!response.ok && response.status !== 499) {
        reason = 'failed'
        const detail = await response.text().catch(() => '<unreadable>')
        console.error('[Wake-up] send-routed returned non-OK for a woken turn:', {
          sessionId,
          status: response.status,
          detail: detail.slice(0, 400)
        })
      }
      await finishWokenTurn(sessionId, reason, input.userId)
    })
    .catch(async (error) => {
      const aborted = (error as any)?.name === 'AbortError'
      if (!aborted) {
        console.error('[Wake-up] Woken turn failed:', {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      // F-P1-5 — read WHY it was aborted, do not assume a Stop.
      //
      // `endWokenTurn` aborts the controller first and only reaches its own
      // `finishWokenTurn('timed_out')` after an awaited HTTP round trip, so this handler
      // always wins the single-winner `clearWakeRun` race. Reporting a flat `'stopped'`
      // therefore recorded EVERY hard timeout as a user Stop, while the finalized assistant
      // message said "timeout" — the two records contradicted each other. `abortWakeRun`
      // puts the answer on the signal; take it from there.
      const abortReason = controller.signal.reason
      const reason: WakeRunEndReason = aborted
        ? abortReason === 'wake_timeout'
          ? 'timed_out'
          : 'stopped'
        : 'failed'
      await finishWokenTurn(sessionId, reason, input.userId)
    })

  return {
    ok: true,
    sessionId,
    messageId,
    createdSession,
    chainDepth: nextChainDepth
  }
}

/* ------------------------------------------------------------------ *
 * Ending a woken turn
 * ------------------------------------------------------------------ */

const RUN_STATUS_BY_REASON: Record<WakeRunEndReason, string> = {
  completed: 'complete',
  failed: 'failed',
  stopped: 'stopped',
  timed_out: 'stopped',
  // F-P1-4: nothing ran and nothing broke. The sidebar clears the spinner the same way a
  // finished turn does; the honest record of what happened is on the DM.
  agent_busy: 'complete'
}

/**
 * Clear the registry and tell the sidebar. Safe to call more than once: only the call
 * that actually removed the entry publishes, so `delivery.actual` is stamped once.
 */
async function finishWokenTurn(
  sessionId: string,
  reason: WakeRunEndReason,
  userId: string
): Promise<void> {
  const entry = clearWakeRun(sessionId, reason)
  if (!entry) return

  // SA-113 P2: stamp what happened onto the DM that asked for this wake. F-P1-4 lands
  // here too: a 409 from send-routed means the user started a turn in this chat first,
  // so the DM records a `wait`, not a failure. Dynamic import keeps `dmStore` off the
  // wake primitive's static graph — the DM tools import BOTH, and one direction is enough.
  if (entry.origin.dmId) {
    try {
      const {
        acknowledgeInfoDm,
        getDm,
        stampDmDelivery,
        stampDmNeedsUser,
        WAKE_DELIVERED_INFO_RESULT
      } = await import('$lib/server/services/dm/dmStore')
      await stampDmDelivery(entry.origin.dmId, {
        ...(reason === 'agent_busy'
          ? {
              actual: 'wait' as const,
              reason:
                'That agent started another turn in this chat first, so the DM is waiting there instead.'
            }
          : {}),
        outcome: reason,
        sessionId
      })

      // F-SEC-1b — the second of the two holdups only the user can clear. A woken turn that
      // stops at a Bash or MCP approval card ENDS normally, so without this the chat looks
      // like it is quietly working: the run spinner clears, the DM stays `working`, and the
      // approval sits there until somebody happens to open it.
      //
      // Only on a turn that actually finished: a stopped, timed-out, failed, or busy turn
      // has its own honest outcome, and calling those "needs you" would cry wolf.
      const parkedOnApproval =
        reason === 'completed' && (await hasPendingToolApproval(sessionId))

      if (parkedOnApproval) {
        await stampDmNeedsUser(
          entry.origin.dmId,
          'This chat is waiting for you to approve a tool before it can go on.'
        )
      } else if (reason === 'completed') {
        // SA-115 F-P1-2 — a wake DELIVERS an info note, so the note is no longer open.
        //
        // Without this, an `info` DM that woke an agent stays `new` forever: SA-113 closes
        // an info item only when the agent calls `sys.dm.read`, and an agent that was
        // handed the note as the first message of its turn has no reason to go read it
        // again. Every later turn's DCM roster then re-lists it, and a repeating schedule
        // makes that unbounded — a daily heartbeat adds one permanent open note per day,
        // and a 5-minute wake schedule fills the 50-item inbox in about four hours, after
        // which every fire fails `inbox_full`.
        //
        // Deliberately narrow:
        //   - `info` only. An `assignment` is work, not a note; it stays open until the
        //     agent claims and closes it, which is the whole point of the kind.
        //   - `completed` only. A `stopped`, `timed_out`, `failed`, or `agent_busy` turn
        //     may never have shown the agent the note at all.
        //   - not while parked on an approval. That turn is unfinished and its DM is the
        //     one thing carrying `needsUser`; closing it would throw away the only signal
        //     telling the user the chat is waiting on them.
        //   - not while the DM already carries `needsUser` at all (SA-115 F-P2-1). The
        //     approval check above sees only `metadata.toolApprovals`, and that is not the
        //     only way a turn parks on the user: F-SEC-1 refuses a risky Fabric control
        //     MID-turn and stamps `needsUser` from inside `useControl`, after which the
        //     turn ends `completed` with nothing pending. Acknowledging there would run
        //     `withoutNeedsUser` and erase the stamp, so the envelope, the drawer's
        //     "Needs you" row, and the `waiting_approval` presence would all go quiet on
        //     the most common woken kind of all — a schedule or webhook `info` wake.
        //     The holdup outlives its turn on purpose; `clearNeedsUserForHumanReply`
        //     closes the note when the human actually replies in that chat.
        // Every sender kind, because what closes it is the delivery, not who sent it.
        const originDm = await getDm(entry.origin.dmId)
        if (originDm?.kind === 'info' && !originDm.delivery?.needsUser) {
          await acknowledgeInfoDm(entry.origin.dmId, entry.agentId, WAKE_DELIVERED_INFO_RESULT)
        }
      }
    } catch (error) {
      console.warn('[Wake-up] Could not stamp the DM delivery outcome:', error)
    }
  }

  try {
    await publishUserEvent(userId, {
      type: 'session_run_status',
      sessionId,
      status: RUN_STATUS_BY_REASON[reason],
      owner: 'server',
      origin: entry.origin,
      reason
    })
  } catch (error) {
    console.warn('[Wake-up] Could not publish the woken turn status:', error)
  }
}

/**
 * AMD-113-02 — Stop and the hard timeout, in the order the spike proved is needed.
 *
 * Aborting the primitive's own request comes FIRST. During a woken turn's 3–9 second
 * setup there is no stream controller yet, so the interrupt route sees only the
 * session-turn lock, answers `stale_turn_cleared`, and lets the run finish untouched.
 * Aborting the request instead makes SvelteKit fire `request.signal` inside send-routed,
 * which is the one signal that reaches a turn still in setup. The interrupt route is then
 * called second for the case where the provider is already streaming.
 */
export async function endWokenTurn(input: {
  sessionId: string
  reason: Extract<WakeRunEndReason, 'stopped' | 'timed_out'>
  originBase: string
  userId: string
}): Promise<boolean> {
  const entry = getWakeRun(input.sessionId)
  if (!entry) return false

  abortWakeRun(input.sessionId, input.reason)

  try {
    const response = await fetch(`${input.originBase}/api/messages/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalServiceHeaders() },
      body: JSON.stringify({ sessionId: input.sessionId })
    })
    // `fetch` does not throw on 4xx/5xx, so without this an auth or routing regression on
    // that route goes back to being a silent no-op — which is exactly how the missing
    // service-token lane stayed hidden.
    if (!response.ok) {
      console.warn(
        `[Wake-up] Interrupt call answered ${response.status} after aborting a woken turn.`
      )
    }
  } catch (error) {
    console.warn('[Wake-up] Interrupt call failed after aborting a woken turn:', error)
  }

  await finishWokenTurn(input.sessionId, input.reason, input.userId)
  return true
}

/**
 * The browser Stop button reaches a woken turn through `/api/messages/interrupt` like any
 * other turn. That route calls this first so the request abort still happens ahead of the
 * lock inspection, which is what makes Stop work during the setup window.
 */
export function abortWokenTurnForInterrupt(sessionId: string): boolean {
  return abortWakeRun(sessionId, 'stopped')
}
