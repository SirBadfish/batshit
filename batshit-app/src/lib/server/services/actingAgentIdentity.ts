/**
 * SA-117 P2 (DL-117-04, DL-117-05) — who is allowed to act AS an agent, written once.
 *
 * P1 gave the server a credential it minted itself: `resolveNativeToolUser` returns an
 * `agentId` on the `agent` lane that came off that record, not out of a request body. This
 * module is the other half — the rule every route applies to it:
 *
 *   1. **Binding (DL-117-04).** On the `agent` lane the bound id wins. A body or context
 *      agent id that DIFFERS is refused `400 AGENT_MISMATCH` rather than silently corrected,
 *      because the two disagreeing is evidence of a bug in a caller or of a forgery attempt,
 *      and neither should be swallowed. An ABSENT one is fine: the credential already said
 *      who is acting, so the field is noise on that lane. The bound `sessionId` is
 *      authoritative the same way, but a differing one is DROPPED rather than refused —
 *      `sessionId` is a target, not an identity claim, and the pre-existing owned-session
 *      rules already refuse a session the caller does not own.
 *   2. **Identity-bearing controls (DL-117-05).** A control that acts as an agent — reading
 *      that agent's DMs, closing them, recalling its memories, managing its schedules —
 *      needs an agent identity the server can vouch for. The `service` lane cannot provide
 *      one: it proves possession of the instance token and then names whoever it likes,
 *      which is the exact hole SA-117 exists to close. It is refused with
 *      `AGENT_IDENTITY_REQUIRED`.
 *
 * **Which lanes can vouch, and why each.**
 *
 * | Lane | Vouched? | Why |
 * |---|---|---|
 * | `agent` | yes | Batshit minted the credential and read the agent off it. |
 * | `unknown` | yes | The in-process callers — send-routed's broker, the automation broker — never cross a request boundary at all; their `agentId` is the turn's own, set by the server. |
 * | `n8n-callback` | yes | A per-message token scoped to one run, and DL-117-05 keeps `context.agent_id` as it is; the DM, memory and schedule families are closed to subagents anyway. |
 * | `service` | **no** | The instance token names nobody (DL-117-05). |
 * | `portable-skill` | **no** | Scoped to a USER and a family list; it never names an agent, so it has no agent to act as. |
 * | `session` | yes | A signed-in browser IS the user, and the user is the authority over the user's own agents: `/api/dms` lists every agent's inbox and `/api/schedules` creates a schedule for any agent on this same cookie, and the MegaSmoke harness drives the SA-113 DM rows and the SA-115 schedule rows through `/api/controls/use` on it. Refusing it here closed nothing a cookie holder could not do one route over (F-P2-4). The audit records the lane as `session`, so "the user acted as Cooper" stays readable. |
 *
 * AMD-117-01 is why no lane here carries a legacy carve-out: Josh confirmed there are no old
 * n8n workflows presenting the instance token, so a shape whose only purpose was keeping such
 * a caller working is void rather than preserved.
 */

import type { NativeToolAuthMethod } from '$lib/server/services/nativeToolAuth'

/** Lanes as `useControl` sees them: every auth method, plus the in-process callers. */
export type ActingAgentLane = NativeToolAuthMethod | 'unknown'

export const AGENT_MISMATCH_ERROR_CODE = 'AGENT_MISMATCH'
export const AGENT_IDENTITY_REQUIRED_ERROR_CODE = 'AGENT_IDENTITY_REQUIRED'

/** The shape every route in DL-117-04 reads: whatever `resolveNativeToolUser` returned. */
export type ActingAgentAuth = {
  auth: ActingAgentLane
  agentId?: string | null
  sessionId?: string | null
}

export type ActingAgentBinding =
  | { ok: true; agentId: string | undefined }
  | { ok: false; code: typeof AGENT_MISMATCH_ERROR_CODE; message: string }

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The server-bound agent for this call, or `''` when the lane has none. */
export function boundAgentId(auth: ActingAgentAuth | null | undefined): string {
  if (!auth || auth.auth !== 'agent') return ''
  return trimmed(auth.agentId)
}

/** The server-bound session for this call, or `''` when the lane has none. */
export function boundSessionId(auth: ActingAgentAuth | null | undefined): string {
  if (!auth || auth.auth !== 'agent') return ''
  return trimmed(auth.sessionId)
}

/**
 * DL-117-04 — resolve the acting agent for one call.
 *
 * Returns the id the route should use. On the `agent` lane that is always the bound one; a
 * claimed id that differs is the refusal, and a claimed id that MATCHES is accepted silently
 * (the managed helpers stopped sending it, but an older profile on disk still might, and a
 * caller agreeing with the server is not an error).
 *
 * On every other lane this is a pass-through of the claim, unchanged: those lanes have no
 * bound identity to compare against, and narrowing them is DL-117-05's job, not this one's.
 */
export function bindActingAgentId(
  auth: ActingAgentAuth | null | undefined,
  claimed: unknown
): ActingAgentBinding {
  const claimedId = trimmed(claimed)
  const bound = boundAgentId(auth)
  if (!bound) return { ok: true, agentId: claimedId || undefined }
  if (claimedId && claimedId !== bound) {
    return {
      ok: false,
      code: AGENT_MISMATCH_ERROR_CODE,
      message:
        `This call arrived on a run credential minted for agent "${bound}" but named agent ` +
        `"${claimedId}". Batshit uses the credential, and refuses the call rather than ` +
        'quietly correcting it. Send no agentId at all on this lane.'
    }
  }
  return { ok: true, agentId: bound }
}

/**
 * DL-117-04 — the session for one call.
 *
 * The bound session wins with no refusal: unlike an agent id, a session id is WHERE a call
 * lands rather than WHO is making it, every route already refuses a session the caller does
 * not own, and a managed run genuinely has one session. A differing claim is dropped.
 */
export function bindActingSessionId(
  auth: ActingAgentAuth | null | undefined,
  claimed: unknown
): string | undefined {
  const bound = boundSessionId(auth)
  if (bound) return bound
  return trimmed(claimed) || undefined
}

export type DispatchContextBinding =
  | { ok: true; context: unknown }
  | { ok: false; code: typeof AGENT_MISMATCH_ERROR_CODE; message: string }

/**
 * DL-117-04 — the same binding, for `/api/native-tools/dispatch`'s opaque `context`.
 *
 * `nativeTools.ts` resolves the GOVERNING agent out of this object: `context.agent_id` when
 * `actor_type` is `'primary'`, and `context.parent_agent_id` when it is `'subagent'` — and
 * then loads that agent's record and provider settings. So the governing field is the one
 * that has to be bound, not always `agent_id`: binding `agent_id` alone would leave a
 * subagent-shaped context naming any parent it liked.
 *
 * `session_id` is bound the same way `bindActingSessionId` binds a body one, and the context
 * is returned UNVALIDATED beyond that — `parseNativeAutomationContext` still owns its shape,
 * its enums, and its required fields, and a non-object context is passed straight through so
 * that parser produces its own `INVALID_CONTEXT` rather than this one inventing a second
 * spelling of the same error.
 */
export function bindDispatchContextIdentity(
  auth: ActingAgentAuth | null | undefined,
  context: unknown
): DispatchContextBinding {
  const bound = boundAgentId(auth)
  if (!bound) return { ok: true, context }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    // Nothing to bind onto, and inventing an object here would turn a malformed request into
    // an authorized one. The dispatch parser refuses it a line later.
    return { ok: true, context }
  }

  const source = context as Record<string, unknown>
  const governingField = source.actor_type === 'subagent' ? 'parent_agent_id' : 'agent_id'
  const binding = bindActingAgentId(auth, source[governingField])
  if (!binding.ok) return binding

  const next: Record<string, unknown> = { ...source, [governingField]: bound }
  const session = bindActingSessionId(auth, source.session_id)
  if (session) next.session_id = session
  return { ok: true, context: next }
}

/** Lanes whose `agentId` the server minted or owns. See the table in this file's header. */
const VOUCHED_LANES: ReadonlySet<ActingAgentLane> = new Set<ActingAgentLane>([
  'agent',
  'n8n-callback',
  'session',
  'unknown'
])

export function laneCanVouchForAgentIdentity(lane: ActingAgentLane | null | undefined): boolean {
  return Boolean(lane && VOUCHED_LANES.has(lane))
}

export type ActingAgentIdentityCheck =
  | { ok: true }
  | { ok: false; code: typeof AGENT_IDENTITY_REQUIRED_ERROR_CODE; message: string }

/**
 * DL-117-05 — the one rule, never restated inline.
 *
 * Called by `useControl` for the identity-bearing control families and by
 * `/api/memory/recall-media`, which acts as an agent without going through a control.
 */
export function requireActingAgentIdentity(
  lane: ActingAgentLane | null | undefined,
  options: { delegated?: boolean } = {}
): ActingAgentIdentityCheck {
  if (options.delegated === true) {
    // SA-117 P2 (F-P2-1). A Subagent or Worker run holds a real credential on the `agent`
    // lane, so the lane check alone would pass it — but the agent it names is a per-run
    // runtime id (`subagent_cli_…`) with no stored record, no inbox, no memories and no
    // schedules. "A delegated run has no inbox and no identity to write from" is already
    // the design (see the `sys.dm.*` family header); this is that sentence enforced rather
    // than left to which control refs the broker happened to expose.
    return {
      ok: false,
      code: AGENT_IDENTITY_REQUIRED_ERROR_CODE,
      message:
        'This control acts as an agent, and a Subagent or Worker run has no agent identity ' +
        'to act as. Ask the primary agent that spawned you to do it.'
    }
  }
  if (laneCanVouchForAgentIdentity(lane)) return { ok: true }
  return {
    ok: false,
    code: AGENT_IDENTITY_REQUIRED_ERROR_CODE,
    message:
      'This control acts as an agent. Call it from an agent lane. A service-token caller ' +
      'acts as the user and cannot act as one of the user\'s agents.'
  }
}
