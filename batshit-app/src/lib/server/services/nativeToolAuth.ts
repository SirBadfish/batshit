import { timingSafeEqual } from 'crypto'
import { env } from '$env/dynamic/private'
import {
  PORTABLE_SKILL_TOKEN_HEADER,
  validatePortableSkillToken
} from '$lib/server/services/portableSkillTokens'
import type { PortableSkillTokenSummary } from '$lib/types/portableSkills'

/** The authenticated HTTP lanes; in-process turns supply their identity separately. */
export type NativeToolAuthMethod =
  | 'service'
  | 'session'
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

export async function resolveNativeToolUser(options: {
  request: Request
  localsUserId?: string | null
  claimedUserId?: string | null
  /**
   * BL-704 — pass one of the two policy constants to admit the portable lane. Omitted, a
   * presented Portable Skill Token refuses the whole request.
   */
  portableSkillPolicy?: PortableSkillRoutePolicy
}): Promise<{
  userId: string
  auth: NativeToolAuthMethod
  portableSkillToken?: PortableSkillTokenSummary
  portableSkillAllowedControlIds?: string[]
  /** BL-704: on the `portable-skill` lane, which route policy admitted the token. */
  portableSkillPolicy?: PortableSkillRoutePolicyKind
} | null> {
  // The retired run-token header remains a must-refuse marker, including when empty or
  // accompanied by a valid service token or session. Never downgrade it to another lane.
  if (options.request.headers.has('x-batshit-agent-token')) return null

  const service = await validateServiceToken(options.request, options.claimedUserId)
  if (service.valid) {
    return {
      userId: service.userId,
      auth: 'service'
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
