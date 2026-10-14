import { timingSafeEqual } from 'crypto'
import { env } from '$env/dynamic/private'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  readDelegatedAllowedControlIds,
  readRunCredentialCliToolScope,
  readRunCredentialProcessOwner,
  readRunCredentialMcpGatewayScope,
  recordRunCredentialUse,
  validateRunCredential,
  type AgentRunProcessOwner
} from '$lib/server/services/agentRunCredentials'
import { validateN8nScopedCallbackRequest } from '$lib/server/services/n8nCallbackTokens'
import {
  PORTABLE_SKILL_TOKEN_HEADER,
  validatePortableSkillToken
} from '$lib/server/services/portableSkillTokens'
import type { PortableSkillTokenSummary } from '$lib/types/portableSkills'

/**
 * SA-117 P1 (DL-117-03) — `'agent'` is the lane a Batshit-minted run credential resolves to.
 *
 * Exported because `fabricRegistry.ts`'s `ControlActorType` is assigned straight from this
 * value at `/api/controls/use` (`actorType: auth.auth`), so the two unions have to agree; a
 * drift between them is a type error rather than a mislabelled audit entry.
 */
export type NativeToolAuthMethod =
  | 'agent'
  | 'service'
  | 'session'
  | 'n8n-callback'
  | 'portable-skill'

function tokenMatches(expected: string | null | undefined, actual: string): boolean {
  const normalizedExpected = expected?.trim()
  const normalizedActual = actual.trim()
  if (!normalizedExpected || !normalizedActual) return false

  try {
    const a = Buffer.from(normalizedExpected)
    const b = Buffer.from(normalizedActual)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

async function validateServiceToken(request: Request, claimedUserId?: string | null) {
  const serviceToken =
    request.headers.get('x-batshit-service-token')?.trim() ||
    request.headers.get('x-batshit-token')?.trim()
  const rawUserId = request.headers.get('x-batshit-user-id') || claimedUserId

  if (!serviceToken || !rawUserId) return { valid: false as const }

  const normalizedUserId = rawUserId.toLowerCase()

  if (tokenMatches(env.BATSHIT_TOKEN, serviceToken)) {
    return {
      valid: true as const,
      userId: normalizedUserId
    }
  }

  return { valid: false as const }
}

/**
 * BL-704 — which routes may authenticate a Portable Skill Token.
 *
 * A Portable Skill Token is scoped to the capability families its owner chose, and only the
 * control API turns those families into an allow-list (`/api/controls/find` shows only their
 * controls; `/api/controls/use` runs only their controls, with scope-as-consent and an audit
 * entry). Every other caller of this resolver does its own work directly (a saved CLI tool,
 * Bash, Dynamic MCP, an artifact proxy) and reads no family at all, so before BL-704 a token
 * holding only the Artifacts family could run a saved CLI tool as its owner.
 *
 * So admission is DEFAULT-DENY: the portable lane exists only for a caller that passes one of
 * these two constants. They are compared by identity, so nothing a request can carry (a body
 * flag, a query string, a JSON or spread copy) stands in for one, and the route's path is
 * never consulted. `portableSkillRouteAdmission.contract.test.ts` pins the only two call sites
 * that pass them. A new route that wants the portable lane needs its own reviewed family
 * mapping first; it does not get one by adding a constant here.
 */
const PORTABLE_SKILL_ROUTE_POLICY = Symbol('batshit.portableSkillRoutePolicy')

export type PortableSkillRoutePolicyKind = 'scoped-discovery' | 'scoped-execution'

export type PortableSkillRoutePolicy = Readonly<{
  [PORTABLE_SKILL_ROUTE_POLICY]: PortableSkillRoutePolicyKind
}>

/** `/api/controls/find` only: lists the token's family controls and nothing else. */
export const PORTABLE_SKILL_SCOPED_DISCOVERY: PortableSkillRoutePolicy = Object.freeze({
  [PORTABLE_SKILL_ROUTE_POLICY]: 'scoped-discovery'
})

/** `/api/controls/use` only: runs a control only when one of the token's families holds it. */
export const PORTABLE_SKILL_SCOPED_EXECUTION: PortableSkillRoutePolicy = Object.freeze({
  [PORTABLE_SKILL_ROUTE_POLICY]: 'scoped-execution'
})

function admittedPortableSkillPolicy(policy: unknown): PortableSkillRoutePolicyKind | null {
  if (policy === PORTABLE_SKILL_SCOPED_DISCOVERY) return 'scoped-discovery'
  if (policy === PORTABLE_SKILL_SCOPED_EXECUTION) return 'scoped-execution'
  return null
}

/**
 * SA-117 P1 (DL-117-03) — the `agent` lane, and why it is FIRST and must-validate.
 *
 * `resolveNativeToolUser`'s order is a security boundary. The deep dive (§6.1) states the rule
 * it enforces: inserting a WEAKER credential ahead of a stronger one is how those boundaries
 * break, which is why a wake-hook token authenticates its own route instead of joining this
 * chain. A run credential is the opposite case — Batshit minted it, it names one agent, one
 * session, and one user, and it dies with the run — so it goes first, ahead of the instance
 * token, which names nobody.
 *
 * **Present means must-validate.** If `x-batshit-agent-token` is on the request at all and it
 * does not validate, the whole request is refused: this returns `null` rather than continuing
 * down the chain. A failed strong credential must never become a successful weak one — without
 * that rule a caller holding the instance token could attach a junk agent header, watch the
 * agent lane fail, and be quietly served as the service lane instead, which is the precise
 * hole this story exists to close. "Present" is `headers.get(…) !== null`, so an EMPTY header
 * is present and is refused too: nothing in Batshit sends one, and the alternative is a header
 * whose value an attacker controls deciding whether the strong lane runs at all.
 *
 * Every refusal reason is logged and never returned (DL-117-02's same-403 rule); the caller
 * sees one indistinguishable `null`.
 */
async function validateAgentRunCredential(request: Request) {
  const presented = request.headers.get(AGENT_RUN_CREDENTIAL_HEADER)
  if (presented === null) return { present: false as const }

  const validation = await validateRunCredential(presented)
  if (!validation.valid) {
    console.warn(
      `[NativeToolAuth] Refused an agent run credential (reason: ${validation.reason}).`
    )
    return { present: true as const, valid: false as const }
  }

  return { present: true as const, valid: true as const, record: validation.record }
}

export async function resolveNativeToolUser(options: {
  request: Request
  localsUserId?: string | null
  claimedUserId?: string | null
  payload?: unknown
  /**
   * BL-704 — pass one of the two policy constants to admit the portable lane. Omitted, a
   * presented Portable Skill Token refuses the whole request.
   */
  portableSkillPolicy?: PortableSkillRoutePolicy
}): Promise<{
  userId: string
  auth: NativeToolAuthMethod
  /** Server-bound on the `agent` lane only. Absent on every other lane. */
  agentId?: string
  /** Server-bound on the `agent` lane only. Authoritative over any body `sessionId`. */
  sessionId?: string
  /** Assistant message bound by the run credential; never taken from request JSON. */
  messageId?: string
  /** Server-owned run scope; old credentials and non-agent lanes never grant Fetch Zip. */
  fetchZipAllowed?: boolean
  runtime?: string
  codexToolOutputTokenLimit?: number | null
  /** Server-resolved gateway selection; old agent credentials expose `[]`. */
  mcpGatewayScope?: string[]
  /** BL-686: the run's saved CLI tools; old agent credentials expose `[]`. */
  cliToolScope?: string[]
  /** The run credential this call arrived on. Named on the audit entry (DL-117-10). */
  credentialId?: string
  /**
   * SA-117 P2 (F-P2-1) — this credential belongs to a Subagent or Worker run, whose
   * `agentId` is a per-run runtime id with no stored agent behind it. The helper is real and
   * authenticated; the identity is not one that can act.
   */
  delegated?: boolean
  /** Physical command owner from the minted record, never from request JSON. */
  processOwner?: AgentRunProcessOwner
  /** Credential-bound stored primary agent governing delegated Native Bash. */
  commandParentAgentId?: string
  delegatedBashEnabled?: boolean
  /**
   * BL-75 — on the `agent` lane, the Subagent or Worker whose skill access governs a
   * delegated run (off the credential, never the body). Absent on a primary run.
   */
  scopeAgentId?: string
  /**
   * BL-81 — on the `agent` lane, what a delegated run may use through the control routes (off
   * the credential, never the body): the control ids its DCM index offered it, or `[]` for a
   * delegated credential minted before BL-81. Absent on a primary run and every other lane.
   */
  delegatedAllowedControlIds?: string[]
  projectPath?: string | null
  portableSkillToken?: PortableSkillTokenSummary
  portableSkillAllowedControlIds?: string[]
  /** BL-704: on the `portable-skill` lane, which route policy admitted the token. */
  portableSkillPolicy?: PortableSkillRoutePolicyKind
} | null> {
  const agentCredential = await validateAgentRunCredential(options.request)
  if (agentCredential.present) {
    if (!agentCredential.valid) return null
    const processOwner = readRunCredentialProcessOwner(agentCredential.record)

    // The counters are what make "this run did something" true in the Execution Viewer. They
    // are deliberately not awaited into the failure path: a bump that loses a race with a
    // Stop-driven revoke must not fail a call the server already authorized.
    void recordRunCredentialUse(agentCredential.record.id)

    return {
      userId: agentCredential.record.userId,
      auth: 'agent',
      agentId: agentCredential.record.agentId,
      sessionId: agentCredential.record.sessionId,
      ...(typeof agentCredential.record.messageId === 'string' && agentCredential.record.messageId.trim()
        ? { messageId: agentCredential.record.messageId.trim() }
        : {}),
      fetchZipAllowed: agentCredential.record.fetchZipAllowed === true,
      runtime: agentCredential.record.runtime,
      codexToolOutputTokenLimit: agentCredential.record.codexToolOutputTokenLimit ?? null,
      mcpGatewayScope: readRunCredentialMcpGatewayScope(agentCredential.record),
      cliToolScope: readRunCredentialCliToolScope(agentCredential.record),
      credentialId: agentCredential.record.id,
      delegated: agentCredential.record.delegated === true,
      ...(processOwner ? { processOwner } : {}),
      ...(typeof agentCredential.record.commandParentAgentId === 'string'
        ? { commandParentAgentId: agentCredential.record.commandParentAgentId }
        : {}),
      ...(agentCredential.record.delegated === true
        ? { delegatedBashEnabled: agentCredential.record.delegatedBashEnabled === true }
        : {}),
      ...(typeof agentCredential.record.scopeAgentId === 'string' &&
      agentCredential.record.scopeAgentId.trim()
        ? { scopeAgentId: agentCredential.record.scopeAgentId.trim() }
        : {}),
      ...(agentCredential.record.delegated === true
        ? { delegatedAllowedControlIds: readDelegatedAllowedControlIds(agentCredential.record) ?? [] }
        : {})
    }
  }

  const service = await validateServiceToken(options.request, options.claimedUserId)
  if (service.valid) {
    return {
      userId: service.userId,
      auth: 'service'
    }
  }

  const n8nCallback = await validateN8nScopedCallbackRequest(
    options.request,
    options.payload,
    options.claimedUserId
  )
  if (n8nCallback.valid) {
    return {
      userId: n8nCallback.userId,
      auth: 'n8n-callback',
      projectPath: n8nCallback.projectPath
    }
  }

  /**
   * BL-704 (D3) — a PRESENTED Portable Skill Token decides the request; it never falls through.
   *
   * "Presented" is `headers.get(…) !== null`, so an empty or blank header counts, exactly like
   * the agent header above. A token that this route does not admit, or that is unknown or
   * revoked, refuses with `null`; it is never served as the signed-in session below it, which
   * is the lane a browser (or anything that can ride its cookie) would otherwise land on. A
   * token read that throws propagates, so it can only ever refuse. With no portable header at
   * all, nothing here runs and every other lane answers exactly as before.
   */
  const presentedPortableToken = options.request.headers.get(PORTABLE_SKILL_TOKEN_HEADER)
  if (presentedPortableToken !== null) {
    const policy = admittedPortableSkillPolicy(options.portableSkillPolicy)
    if (!policy) {
      console.warn(
        '[NativeToolAuth] Refused a Portable Skill Token: this route does not admit the portable lane.'
      )
      return null
    }

    const portableSkill = await validatePortableSkillToken(presentedPortableToken)
    if (!portableSkill.valid) {
      console.warn(`[NativeToolAuth] Refused a Portable Skill Token (reason: ${portableSkill.reason}).`)
      return null
    }

    return {
      userId: portableSkill.userId,
      auth: 'portable-skill',
      portableSkillPolicy: policy,
      portableSkillToken: portableSkill.token,
      portableSkillAllowedControlIds: portableSkill.allowedControlIds
    }
  }

  if (options.localsUserId) {
    return {
      userId: options.localsUserId,
      auth: 'session'
    }
  }

  return null
}
