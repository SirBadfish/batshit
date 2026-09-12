import { timingSafeEqual } from 'crypto'
import { env } from '$env/dynamic/private'
import {
  AGENT_RUN_CREDENTIAL_HEADER,
  recordRunCredentialUse,
  validateRunCredential
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
}): Promise<{
  userId: string
  auth: NativeToolAuthMethod
  /** Server-bound on the `agent` lane only. Absent on every other lane. */
  agentId?: string
  /** Server-bound on the `agent` lane only. Authoritative over any body `sessionId`. */
  sessionId?: string
  /** The run credential this call arrived on. Named on the audit entry (DL-117-10). */
  credentialId?: string
  /**
   * SA-117 P2 (F-P2-1) — this credential belongs to a Subagent or Worker run, whose
   * `agentId` is a per-run runtime id with no stored agent behind it. The helper is real and
   * authenticated; the identity is not one that can act.
   */
  delegated?: boolean
  projectPath?: string | null
  portableSkillToken?: PortableSkillTokenSummary
  portableSkillAllowedControlIds?: string[]
} | null> {
  const agentCredential = await validateAgentRunCredential(options.request)
  if (agentCredential.present) {
    if (!agentCredential.valid) return null

    // The counters are what make "this run did something" true in the Execution Viewer. They
    // are deliberately not awaited into the failure path: a bump that loses a race with a
    // Stop-driven revoke must not fail a call the server already authorized.
    void recordRunCredentialUse(agentCredential.record.id)

    return {
      userId: agentCredential.record.userId,
      auth: 'agent',
      agentId: agentCredential.record.agentId,
      sessionId: agentCredential.record.sessionId,
      credentialId: agentCredential.record.id,
      delegated: agentCredential.record.delegated === true
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

  const portableSkill = await validatePortableSkillToken(
    options.request.headers.get(PORTABLE_SKILL_TOKEN_HEADER)
  )
  if (portableSkill.valid) {
    return {
      userId: portableSkill.userId,
      auth: 'portable-skill',
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
