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
 * | `in-process` | yes | The in-process callers — send-routed's broker, the artifact runtime, the automation broker — never cross a request boundary at all; their `agentId` is the turn's own, set by the server. They SAY so: every in-process caller passes `'in-process'` explicitly. |
 * | `unknown` | **no** | A caller that declared no lane. Refused, so a call site that forgets the parameter fails closed instead of being trusted by omission (PR #106 review, F-1). |
 * | `n8n-callback` | yes | A per-message token scoped to one run, and DL-117-05 keeps `context.agent_id` as it is; the DM, memory and schedule families are closed to subagents anyway. |
 * | `service` | **no** | The instance token names nobody (DL-117-05). |
 * | `portable-skill` | **no** | Scoped to a USER and a family list; it never names an agent, so it has no agent to act as. |
 * | `session` | yes | A signed-in browser IS the user, and the user is the authority over the user's own agents: `/api/dms` lists every agent's inbox and `/api/schedules` creates a schedule for any agent on this same cookie, and the dev smoke harness drives the SA-113 DM rows and the SA-115 schedule rows through `/api/controls/use` on it. Refusing it here closed nothing a cookie holder could not do one route over (F-P2-4). The audit records the lane as `session`, so "the user acted as Cooper" stays readable. |
 *
 * AMD-117-01 is why no lane here carries a legacy carve-out: Josh confirmed there are no old
 * n8n workflows presenting the instance token, so a shape whose only purpose was keeping such
 * a caller working is void rather than preserved.
 */

import type { NativeToolAuthMethod } from '$lib/server/services/nativeToolAuth'
import { isControlIdAllowedByList } from '$lib/utils/brokerAvailability'

/**
 * Lanes as `useControl` sees them: every auth method, plus `in-process` for the callers that
 * never cross a request boundary, plus `unknown` for a caller that declared nothing — which
 * is REFUSED for every control that acts as an agent. `unknown` used to be the default AND a
 * vouched lane, so any call site that forgot the parameter was silently trusted (PR #106
 * review, F-1: the dispatch route reached `sys.dm.*` that way with the instance token).
 */
export type ActingAgentLane = NativeToolAuthMethod | 'in-process' | 'unknown'

export const AGENT_MISMATCH_ERROR_CODE = 'AGENT_MISMATCH'
export const AGENT_IDENTITY_REQUIRED_ERROR_CODE = 'AGENT_IDENTITY_REQUIRED'

/** The shape every route in DL-117-04 reads: whatever `resolveNativeToolUser` returned. */
export type ActingAgentAuth = {
  auth: ActingAgentLane
  agentId?: string | null
  sessionId?: string | null
  /** The reply a run credential was minted for (BL-1321). See `boundRunCredential`. */
  messageId?: string | null
  /** A Subagent or Worker run's credential (SA-117 F-P2-1). */
  delegated?: boolean | null
  /** That run's Subagent or Worker, whose access lists govern it (BL-75). See `boundScopeAgentId`. */
  scopeAgentId?: string | null
  /** What that run may use through the control routes (BL-81). See `boundDelegatedAllowedControlIds`. */
  delegatedAllowedControlIds?: string[] | null
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
 * BL-1321 — the run a helper call belongs to, read only off the minted run credential: its chat,
 * its reply, and whether it is a Subagent or Worker run. Empty on every lane but `agent`, so no
 * body field can name a run. `getRunCredentialStopSignal` turns it into the Stop the call hears.
 */
export function boundRunCredential(auth: ActingAgentAuth | null | undefined): {
  sessionId: string
  messageId: string
  delegated: boolean
} {
  if (!auth || auth.auth !== 'agent') return { sessionId: '', messageId: '', delegated: false }
  return { sessionId: trimmed(auth.sessionId), messageId: trimmed(auth.messageId), delegated: auth.delegated === true }
}

/**
 * BL-81 — the Subagent or Worker whose artifact ALLOWLISTS apply to a delegated run's call, or
 * `''`.
 *
 * A Subagent or Worker run's credential names two ids, and they answer different questions.
 * `agentId` (`boundAgentId`) is the per-run runtime id, `subagent_cli_<slug>`: it says WHO
 * authenticated, and no agent record, inbox, allowlist or approval names it. `scopeAgentId` is
 * the Subagent's record id, a `base` Worker's base id, or a built-in Worker's `worker_…` id
 * (BL-75): the id Settings -> Agents -> Access writes into an artifact's agent allowlist, and the
 * id the run's own DCM lists its artifact tools for.
 *
 * So this is not a rebinding: only a control's agent allowlist (and the short-alias lookup that
 * applies it) reads it, on `/api/controls/use` and `/api/controls/find`. WHICH controls a
 * delegated run may use at all is a separate answer, `boundDelegatedAllowedControlIds`. The
 * identity gate, the risk gate, the handler, the audit's `agentId` and the step label keep
 * `boundAgentId`: a Subagent's id can equal a primary's (both are `sanitizeId(displayName)`,
 * checked for collisions only in their own key space), and a delegated run must never borrow
 * that primary's record, consent or inbox.
 *
 * `''` for a primary run (its own agent governs), for a delegated credential minted before
 * BL-75 (no scope: the per-run id, which no allowlist names, fails closed), and on every lane
 * but `agent`.
 */
export function boundScopeAgentId(auth: ActingAgentAuth | null | undefined): string {
  if (!auth || auth.auth !== 'agent' || auth.delegated !== true) return ''
  return trimmed(auth.scopeAgentId)
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

/**
 * BL-81 — what a delegated run may use through the control routes, or `undefined`.
 *
 * On the `agent` lane with a delegated credential: the control ids its DCM index offered it,
 * minted onto the credential by the runner, and `[]` when the credential carries none (one
 * minted before BL-81), so a delegated call can never look like a primary's here and fail open.
 * `undefined` for a primary run and on every other lane, where the caller's own settings and
 * the route's existing rules govern, unchanged.
 */
export function boundDelegatedAllowedControlIds(
  auth: ActingAgentAuth | null | undefined
): string[] | undefined {
  if (!auth || auth.auth !== 'agent' || auth.delegated !== true) return undefined
  return Array.isArray(auth.delegatedAllowedControlIds) ? auth.delegatedAllowedControlIds : []
}

export const DELEGATED_RUN_NOT_ALLOWED_ERROR_CODE = 'CONTROL_NOT_ALLOWED'

/**
 * BL-81 follow-up — a delegated run's credential on a route OUTSIDE the two control routes.
 *
 * A managed CLI Subagent or Worker run's credential sits in its child process environment
 * (`BATSHIT_AGENT_TOKEN`), so the model's own shell can present it to any route that takes a
 * run credential, not only the routes its helper calls. BL-81 held that credential to its list
 * on `/api/controls/find` and `/api/controls/use`; a route that does the same work directly has
 * to hold it to the same list, or it serves the run as the full user.
 *
 * `controlId` names the control whose work the route does (`/api/native-tools/fetch-zip` is
 * `sys.zip.fetch`): the call goes on exactly when the run's list allows that control. `null`
 * is a route whose work no delegated list holds (artifact share and complete: a delegated run
 * reaches those only through `use.artifact.*` on `/api/controls/use`, whose handler makes that
 * HTTP hop with the instance token, never with this credential), so a delegated credential is
 * refused there outright.
 *
 * Returns the refusal, or `null` to go on. Always `null` for a primary run and on every lane
 * but `agent` (an artifact runtime token included), so those callers keep their answers.
 * `auth` is whatever the route authenticated with, which on the artifact routes may be an
 * artifact runtime token's claims rather than `resolveNativeToolUser`'s answer.
 */
export function refuseDelegatedRunOutsideList(
  auth: unknown,
  controlId: string | null
): { code: typeof DELEGATED_RUN_NOT_ALLOWED_ERROR_CODE; message: string } | null {
  if (!auth || typeof auth !== 'object') return null
  const lane = auth as { auth?: unknown; delegated?: unknown; delegatedAllowedControlIds?: unknown }
  if (lane.auth !== 'agent' || lane.delegated !== true) return null
  const list = Array.isArray(lane.delegatedAllowedControlIds)
    ? lane.delegatedAllowedControlIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (controlId && isControlIdAllowedByList(controlId, list)) return null
  return {
    code: DELEGATED_RUN_NOT_ALLOWED_ERROR_CODE,
    message:
      'A Subagent or Worker run cannot use this route: it may use only the Batshit tools its ' +
      'own instructions list, through its tool helper. Ask the primary agent that started you ' +
      'to do this.'
  }
}

export const PORTABLE_SKILL_NOT_ALLOWED_ERROR_CODE = 'CONTROL_NOT_ALLOWED'

/**
 * BL-687 — a Portable Skill Token on a route that does a control's work directly.
 *
 * A Portable Skill Token is scoped to the families the user granted when minting it, and
 * `/api/controls/use` answers it only for the controls those families hold. A route that does
 * the same work as a control (`/api/mcp/tools/find` is `sys.mcp.dynamic.find`) holds the token
 * to the same list, or the token reaches that work through the side door. No family holds a
 * dynamic MCP control today, so both MCP routes refuse every Portable Skill Token until one does.
 *
 * Since BL-704 the resolver itself refuses the token on every route but the two control routes
 * (default-deny admission), so this check is no longer reachable from the MCP routes. It stays
 * as defense in depth: a route that is ever reviewed into the portable lane keeps the rule.
 *
 * Returns the refusal, or `null` to go on. Always `null` on every lane but `portable-skill`.
 */
export function refusePortableSkillOutsideList(
  auth: unknown,
  controlId: string
): { code: typeof PORTABLE_SKILL_NOT_ALLOWED_ERROR_CODE; message: string } | null {
  if (!auth || typeof auth !== 'object') return null
  const lane = auth as { auth?: unknown; portableSkillAllowedControlIds?: unknown }
  if (lane.auth !== 'portable-skill') return null
  const list = Array.isArray(lane.portableSkillAllowedControlIds)
    ? lane.portableSkillAllowedControlIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (isControlIdAllowedByList(controlId, list)) return null
  return {
    code: PORTABLE_SKILL_NOT_ALLOWED_ERROR_CODE,
    message:
      `A Portable Skill Token cannot use this route: no Portable Skill family grants "${controlId}". ` +
      'Use a Batshit agent for MCP tools, or the Batshit tools your token\'s families list.'
  }
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
  'in-process'
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
