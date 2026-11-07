import type { NativeToolAuthMethod } from '$lib/server/services/nativeToolAuth'
import { isControlIdAllowedByList } from '$lib/utils/brokerAvailability'

/** Only a signed-in user or a server-owned in-process turn can vouch for an agent. */
export type ActingAgentLane = NativeToolAuthMethod | 'in-process' | 'unknown'
export const AGENT_IDENTITY_REQUIRED_ERROR_CODE = 'AGENT_IDENTITY_REQUIRED'

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

const VOUCHED_LANES: ReadonlySet<string> = new Set(['session', 'in-process'])

/** Unknown and retired lane names fail closed even if supplied by an internal caller. */
export function laneCanVouchForAgentIdentity(lane: string | null | undefined): boolean {
  return Boolean(lane && VOUCHED_LANES.has(lane))
}

export type ActingAgentIdentityCheck =
  | { ok: true }
  | { ok: false; code: typeof AGENT_IDENTITY_REQUIRED_ERROR_CODE; message: string }

export function requireActingAgentIdentity(
  lane: string | null | undefined,
  options: { delegated?: boolean } = {}
): ActingAgentIdentityCheck {
  if (options.delegated === true) {
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
      'This control acts as an agent. A service-token caller ' +
      'acts as the user and cannot act as one of the user\'s agents.'
  }
}
