import { redis } from '$lib/server/redis'
import type { SlashCommandRow } from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer'

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
export const SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
local add = ARGV[2] == 'add'
local found = redis.call('JSON.GET', KEYS[1], '$.enabled_agent_ids')
local nextList = {}
if found == '[]' then
  if add then
    return 'UNCHANGED'
  end
  for _, value in ipairs(cjson.decode(ARGV[4])) do
    if value ~= ARGV[1] then
      table.insert(nextList, value)
    end
  end
else
  local stored = cjson.decode(found)[1]
  local current = {}
  if type(stored) == 'table' then
    current = stored
  end
  local present = false
  for _, value in ipairs(current) do
    if value == ARGV[1] then
      present = true
    else
      table.insert(nextList, value)
    end
  end
  if (add and present) or ((not add) and (not present)) then
    return 'UNCHANGED'
  end
  if add then
    table.insert(nextList, ARGV[1])
  end
end
local encoded = '[]'
if #nextList > 0 then
  encoded = cjson.encode(nextList)
end
redis.call('JSON.SET', KEYS[1], '$.enabled_agent_ids', encoded)
local forAll = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.enabled_for_all_agents'))[1] == true
local attachable = 'false'
if forAll or #nextList > 0 then
  attachable = 'true'
end
redis.call('JSON.SET', KEYS[1], '$.can_be_attached_to_agents', attachable)
redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[3])
return 'OK'
`

/**
 * Write a whole skill command record. KEYS[1]: the command. ARGV[1]: the next record as JSON.
 * ARGV[2]: `keep` (the stored `enabled_agent_ids` stays exactly as it is at this moment, absent
 * included, whatever the record carries) or `replace` (the record's own list is written).
 * `can_be_attached_to_agents` is derived again from what was written. Answers `MISSING` when the
 * command is gone (a write never makes a deleted command again), otherwise the stored record as
 * `JSON.GET $` text.
 */
export const WRITE_SLASH_COMMAND_RECORD_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
local keep = ARGV[2] == 'keep'
local storedList = nil
if keep then
  -- JSONPath answers every match in a list: '[]' when the field is absent, '[<list>]' otherwise.
  local found = redis.call('JSON.GET', KEYS[1], '$.enabled_agent_ids')
  if found ~= '[]' then
    storedList = string.sub(found, 2, -2)
  end
end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
if keep then
  if storedList then
    redis.call('JSON.SET', KEYS[1], '$.enabled_agent_ids', storedList)
  else
    redis.call('JSON.DEL', KEYS[1], '$.enabled_agent_ids')
  end
end
local forAll = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.enabled_for_all_agents'))[1] == true
local written = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.enabled_agent_ids'))[1]
local count = 0
if type(written) == 'table' then
  count = #written
end
local attachable = 'false'
if forAll or count > 0 then
  attachable = 'true'
end
redis.call('JSON.SET', KEYS[1], '$.can_be_attached_to_agents', attachable)
return redis.call('JSON.GET', KEYS[1], '$')
`

export function slashCommandKey(userId: string, commandId: string) {
  return `slash_command:${userId}:${commandId}`
}

/** An agent id as every access-list writer stores it (the skill routes' `sanitizeAgentIds`). */
export function normalizeAccessAgentId(value: unknown): string {
  return sanitizeId(String(value ?? '').trim())
}

export type AgentAccessChange = { agentId: string; enabled: boolean }

/** The body of an Access toggle: `{ agentId: string, enabled: boolean }`. */
export function parseAgentAccessChange(body: unknown): AgentAccessChange | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send { agentId, enabled }: the agent to turn on or off, and whether it is on.' }
  }
  const raw = body as Record<string, unknown>
  const agentId = typeof raw.agentId === 'string' ? normalizeAccessAgentId(raw.agentId) : ''
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
async function listOwnAgentAndSubagentIds(
  client: { sMembers: (key: string) => Promise<string[]> },
  userId: string
): Promise<string[]> {
  const [agents, subagents] = await Promise.all([
    client.sMembers(`user:${userId}:agents`),
    client.sMembers(`user:${userId}:subagents`)
  ])
  return Array.from(new Set([...agents, ...subagents].map((id) => String(id)).filter(Boolean))).sort()
}

/** Turn one agent on or off for one skill command (`SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT`). */
export async function setSlashCommandAgentAccess(
  userId: string,
  commandId: string,
  agentId: string,
  enabled: boolean
): Promise<SlashCommandAccessAnswer> {
  const answer = await redis.execute(async (client) => {
    // Only a record with no list reads these (turning one agent off keeps every other one on).
    const everyone = enabled ? [] : await listOwnAgentAndSubagentIds(client, userId)
    return client.eval(SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT, {
      keys: [slashCommandKey(userId, commandId)],
      arguments: [
        agentId,
        enabled ? 'add' : 'remove',
        JSON.stringify(new Date().toISOString()),
        JSON.stringify(everyone)
      ]
    })
  })
  if (answer === 'OK' || answer === 'UNCHANGED' || answer === 'MISSING') return answer
  throw new Error(`The access change of skill command ${commandId} answered ${String(answer)}.`)
}

/**
 * Write a whole skill command record (`WRITE_SLASH_COMMAND_RECORD_SCRIPT`). With `keepAgentAccess`
 * the stored per-agent list stays as it is at the moment of the write. Answers the record as
 * stored, or `null` when the command was deleted meanwhile (nothing is written then).
 */
export async function writeSlashCommandRecord(
  key: string,
  record: SlashCommandRow,
  options: { keepAgentAccess: boolean }
): Promise<SlashCommandRow | null> {
  const answer = await redis.execute((client) =>
    client.eval(WRITE_SLASH_COMMAND_RECORD_SCRIPT, {
      keys: [key],
      arguments: [JSON.stringify(record), options.keepAgentAccess ? 'keep' : 'replace']
    })
  )
  if (answer === 'MISSING') return null
  if (typeof answer !== 'string') {
    throw new Error(`The write of skill command ${key} answered ${String(answer)}.`)
  }
  const [stored] = JSON.parse(answer) as SlashCommandRow[]
  return stored
}
