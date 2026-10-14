import { sanitizeId } from '$lib/utils/idSanitizer'

/**
 * BL-283 / BL-285 (2026-09-27): the ids a new Primary Agent or Subagent may have.
 *
 * Creation took any `body.id`. An id outside `[A-Za-z0-9_-]+` could never be deleted
 * (`redis.deleteAgent` and the avatar owner sweep refuse such ids, because the id goes
 * unescaped into Redis MATCH patterns and picture names) and could have no avatar picture
 * (the upload refuses it since BL-143). A display name with no letter or digit gave the
 * empty id, stored as `agent:` or `subagent:`, and a non-text `id` crashed the route (500).
 *
 * A Primary Agent's managed CLI profile folder is `batshit_agent_<id lowercased>`, and every
 * CLI Subagent's and Worker's folder is `batshit_agent_subagent_cli…`, so a Primary Agent id
 * starting with `subagent_cli` would share a Subagent's or Worker's folder (and its per-run
 * runtime id would name a real agent, SA-117 F-P2-1). That prefix is kept for them.
 */

/** The owner id rule `redis.deleteAgent`, the avatar upload, and its owner sweep enforce. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** Lowercased, as `buildAgentProfileId` lowercases a Primary Agent's id into its folder name. */
const CLI_DELEGATED_RUNTIME_PREFIX = 'subagent_cli'

export type NewAgentIdKind = 'agent' | 'subagent'

export type NewAgentIdResult =
  | { ok: true; id: string }
  | { ok: false; error: string; code: 'agent_id_invalid' | 'agent_id_reserved' }

const KIND_LABELS: Record<NewAgentIdKind, string> = {
  agent: 'agent',
  subagent: 'Subagent'
}

/**
 * The id a create request asks for: its `id` when one is given (trimmed), otherwise the
 * slug of its display name, checked against the rules above.
 */
export function resolveNewAgentId(
  kind: NewAgentIdKind,
  requestedId: unknown,
  displayName: unknown
): NewAgentIdResult {
  const label = KIND_LABELS[kind]
  if (requestedId !== undefined && requestedId !== null && typeof requestedId !== 'string') {
    return { ok: false, code: 'agent_id_invalid', error: `The ${label} id must be text.` }
  }
  const id =
    (typeof requestedId === 'string' ? requestedId.trim() : '') ||
    (typeof displayName === 'string' ? sanitizeId(displayName) : '')
  if (!id) {
    return {
      ok: false,
      code: 'agent_id_invalid',
      error: `This ${label} needs an id: give it a name with at least one letter or digit.`
    }
  }
  if (!AGENT_ID_PATTERN.test(id)) {
    return {
      ok: false,
      code: 'agent_id_invalid',
      error: `The ${label} id '${id}' may use only letters, digits, "_" and "-". Batshit finds and deletes a ${label}'s data by its id and refuses any other character, so it could never be deleted.`
    }
  }
  if (kind === 'agent' && id.toLowerCase().startsWith(CLI_DELEGATED_RUNTIME_PREFIX)) {
    return {
      ok: false,
      code: 'agent_id_reserved',
      error: `Agent ids starting with '${CLI_DELEGATED_RUNTIME_PREFIX}' are kept for CLI Subagent and Worker runs, whose managed CLI profile folders use that name. Give this agent another name.`
    }
  }
  return { ok: true, id }
}
