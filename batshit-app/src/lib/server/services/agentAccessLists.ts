import { redis } from '$lib/server/redis'
import type { SlashCommandRow } from '$lib/types/database'
import { isExactSavedAccessAgentId } from '$lib/utils/agentAccessIds'
import { AGENT_ID_PATTERN } from './agentIdRules'
import {
  saveSlashCommandRecord, commitSlashCommandAgentAccess,
  type CommandAccessField, type SlashCommandWriteBasis
} from './slashCommandRevision'

/**
 * BL-544: the per-agent access lists, a skill's `enabled_agent_ids` and an artifact's
 * `agent_allowlist`, have several writers. Settings > Agents > Access turns ONE agent on or off;
 * Settings > Skills & Prompts and Settings > Artifacts save the record's other settings; agent and
 * Subagent deletes take their own id out; the skill GET routes refresh a skill's metadata from its
 * files. Each used to write a whole list (or a whole record) from a copy read earlier, so one
 * writer silently undid another's change: an agent turned on in Access lost the skill again at
 * the next Skills & Prompts save, and revoked access came back the same way.
 *
 * Now Access adds or removes one id against the list as stored at that moment
 * (`setSlashCommandAgentAccess` here, `ArtifactsService.setAgentAccess` for artifacts), and a skill
 * route that rewrites the whole command record keeps the list as stored at the moment of its write
 * (`writeSlashCommandRecord` with `keepAgentAccess`), unless the request itself sends a list.
 * Both are one Lua step inside Redis. The artifact side goes through the artifact write lock and
 * its check-and-set write instead (BL-547).
 */

/**
 * Add or remove one agent id on a skill command's `enabled_agent_ids`, from the list as stored now.
 * KEYS[1]: the command. ARGV[1]: the agent id. ARGV[2]: `add` or `remove`. ARGV[3]: `updated_at`
 * as JSON. ARGV[4]: the user's agent and Subagent ids as JSON, used only for a record with no list.
 * Answers `MISSING` (no command), `UNCHANGED` (already on, or already off: nothing is written), or
 * `OK`. `can_be_attached_to_agents` follows the new list, as every command writer derives it;
 * `enabled_for_all_agents` and every other agent's entry stay as stored.
 *
 * A record with NO list at all is on for every agent (the runtime rule, `commandEnabledForAgent`;
 * `JSON.GET` answers `[]` for the missing path). Turning an agent on there changes nothing, and
 * turning one off writes every OTHER id of ARGV[4] as an explicit list, in this same step, so the
 * others keep the skill. An empty list is different: on for nobody.
 */
export { SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT } from './slashCommandRevision'

export function slashCommandKey(userId: string, commandId: string) {
  return `slash_command:${userId}:${commandId}`
}

/** Stored IDs are identities, not display-name slugs (BL1614). */
export function normalizeAccessAgentId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  return AGENT_ID_PATTERN.test(id) ? id : ''
}

/** Validate an explicitly supplied list. Never apply this as a stored-ID migration. */
export function parseAccessAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw Object.assign(new Error('Send a list of agent IDs.'), { status: 400 })
  const ids = value.map(normalizeAccessAgentId)
  if (ids.some(id => !id)) throw Object.assign(new Error('Each agent ID must use only letters, digits, "_" and "-".'), { status: 400 })
  return [...new Set(ids)]
}

/** Saved identities must already be exact. Absence retains legacy universal meaning. */
export function readSavedAccessAgentIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(id => !isExactSavedAccessAgentId(id))) {
    throw Object.assign(new Error('The saved agent access list is unreadable. No access change was made.'), { status: 409 })
  }
  return [...value]
}

export type AgentAccessChange = { agentId: string; enabled: boolean }

/** The body of an Access toggle: `{ agentId: string, enabled: boolean }`. */
export function parseAgentAccessChange(body: unknown): AgentAccessChange | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send { agentId, enabled }: the agent to turn on or off, and whether it is on.' }
  }
  const raw = body as Record<string, unknown>
  const agentId = raw.enabled === false
    ? isExactSavedAccessAgentId(raw.agentId) ? raw.agentId : ''
    : normalizeAccessAgentId(raw.agentId)
  if (!agentId) return { error: 'agentId must name an agent or Subagent.' }
  if (typeof raw.enabled !== 'boolean') return { error: 'enabled must be true or false.' }
  return { agentId, enabled: raw.enabled }
}

/**
 * Whether `agentId` is one of the user's Primary Agents or Subagents. An Access toggle may only
 * turn access ON for one of them (a list entry names an id with no kind, so an unknown id would
 * wait there for the next agent made with that name, BL-187); turning an id OFF is always allowed,
 * so a stale entry can be taken out.
 */
export async function isOwnAgentOrSubagent(userId: string, agentId: string): Promise<boolean> {
  for (const key of [`agent:${agentId}`, `subagent:${agentId}`]) {
    const record = (await redis.json.get(key)) as { user_id?: unknown } | null
    if (record && typeof record === 'object' && record.user_id === userId) return true
  }
  return false
}

export type SlashCommandAccessAnswer = 'OK' | 'UNCHANGED' | 'MISSING'

/**
 * The user's Primary Agent and Subagent ids (`user:{userId}:agents`, `user:{userId}:subagents`):
 * who a skill with no list reaches in Access. A Worker made for one call has a fresh id and is not
 * listed, so once a list is written it keeps such a skill only through Enable For All Agents.
 */
export function setSlashCommandAgentAccess(userId: string, commandId: string, agentId: string, enabled: boolean, basis: SlashCommandWriteBasis) {
  return commitSlashCommandAgentAccess(userId, commandId, agentId, enabled, basis, false)
}

/** Deletion removes only named entries; it never converts universal legacy access. */
export function removeExplicitSlashCommandAgentAccess(userId: string, commandId: string, agentId: string, basis: SlashCommandWriteBasis) {
  return commitSlashCommandAgentAccess(userId, commandId, agentId, false, basis, true)
}

/**
 * Write a whole skill command record through the revision owner. With `keepAgentAccess`
 * the stored per-agent list stays as it is at the moment of the write. Answers the record as
 * stored, or `null` when the command was deleted meanwhile (nothing is written then).
 */
export async function writeSlashCommandRecord(
  key: string,
  record: SlashCommandRow,
  options: { keepAgentAccess: boolean; preserveAccess?: readonly CommandAccessField[] },
  basis: SlashCommandWriteBasis
): Promise<SlashCommandRow | null> {
  if (key !== slashCommandKey(record.user_id, record.id)) throw new Error('Command identity changed.')
  return saveSlashCommandRecord(record.user_id, { record, mode: 'update', preserveAccess: [...new Set<CommandAccessField>([
    ...(options.keepAgentAccess ? ['enabled_agent_ids' as const] : []), ...(options.preserveAccess ?? [])
  ])] }, basis)
}
