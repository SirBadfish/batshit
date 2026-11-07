import { randomUUID } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { isExactSavedAccessAgentId } from '$lib/utils/agentAccessIds'
import type { SlashCommandRow } from '$lib/types/database'
import type { AgentPluginDescriptor, AgentPluginSkillDescriptor } from '$lib/types/agentPlugins'
export type { AgentPluginDescriptor } from '$lib/types/agentPlugins'
import { captureSettingsLifecycle, acquireSettingsMutation, acquireSettingsReplacementMutation, assertSettingsLifecycle, type SettingsLifecycleSnapshot } from './appActions/settings/lifecycle'
import { APP_ACTIONS_COMMAND_ID, APP_ACTIONS_SKILL_ID, isCanonicalAppActionsCommand, isCanonicalAppActionsSkill, LEGACY_BUILTIN_PLUGIN_SKILLS, BUILTIN_PLUGIN_SKILLS, BUNDLED_BATSHIT_PLUGIN_ID, BUNDLED_BATSHIT_PLUGIN_VERSION } from './systemPluginPackage'

export type AgentPluginSkill = AgentPluginSkillDescriptor
export interface AgentPluginRecord {
  id: string
  user_id: string
  name: string
  description: string
  builtIn: boolean
  version: string
  skills: AgentPluginSkill[]
  enabled_for_all_agents: boolean
  enabled_agent_ids: string[]
  revision: string
  removing?: boolean
  installing?: boolean
  created_at: string
  updated_at: string
}
export class AgentPluginError extends Error {
  constructor(public code: string, message: string, public status = 409, public outcome: 'not_written' | 'unknown' = 'not_written') { super(message) }
}
const validPluginId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(id) && !id.includes('--') && !id.includes('..')
// An issued ambiguous migration is not retried by the next ordinary catalogue read.
// This is process-local mutation custody, not saved metadata or an access grant.
const uncertainBuiltinInventories = new Set<string>()
export const agentPluginKey = (userId: string, pluginId: string) => `agent_plugin:${userId}:${pluginId}`
const unavailable = () => new AgentPluginError('PLUGIN_UNAVAILABLE', 'Plugin access is unreadable. No default access was assumed.')
export function builtinPluginSkill(value: unknown) {
  if (typeof value !== 'string') return undefined
  const raw = value.replace(/^\//, '').replace(/^batshit:/, '')
  return BUILTIN_PLUGIN_SKILLS.find(skill => skill.skillId === raw || skill.commandId === raw || skill.legacyDirectory === raw)
}
export function isBuiltinPluginMember(command: Pick<SlashCommandRow, 'id' | 'skill_id'> & Partial<Pick<SlashCommandRow, 'plugin_id'>>) {
  const member = builtinPluginSkill(command.id) || builtinPluginSkill(command.skill_id)
  return Boolean(member && (member.skillId !== APP_ACTIONS_SKILL_ID || command.plugin_id === BUNDLED_BATSHIT_PLUGIN_ID))
}
const matchesBuiltinInventory = (skills: AgentPluginSkill[], inventory: readonly { commandId: string; skillId: string }[]) =>
  skills.length === inventory.length && inventory.every(skill => skills.some(entry => entry.commandId === skill.commandId && entry.skillId === skill.skillId))
export function validateAgentPluginRecord(value: unknown, userId: string, id?: string): AgentPluginRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  const row = value as AgentPluginRecord
  if (!validPluginId(row.id) || id !== undefined && row.id !== id || row.user_id !== userId ||
      typeof row.name !== 'string' || !row.name.trim() || typeof row.description !== 'string' ||
      typeof row.version !== 'string' || typeof row.builtIn !== 'boolean' || row.builtIn !== (row.id === BUNDLED_BATSHIT_PLUGIN_ID) ||
      row.removing !== undefined && row.removing !== true || row.installing !== undefined && row.installing !== true ||
      (row.removing === true || row.installing === true) && (row.enabled_for_all_agents !== false || !Array.isArray(row.enabled_agent_ids) || row.enabled_agent_ids.length !== 0) ||
      typeof row.enabled_for_all_agents !== 'boolean' || !Array.isArray(row.enabled_agent_ids) ||
      row.enabled_agent_ids.some(id => !isExactSavedAccessAgentId(id)) || new Set(row.enabled_agent_ids).size !== row.enabled_agent_ids.length ||
      typeof row.revision !== 'string' || !row.revision || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string' ||
      !Array.isArray(row.skills) || !row.skills.length || row.skills.length > 128) throw unavailable()
  const commands = new Set<string>(), skills = new Set<string>()
  for (const skill of row.skills) {
    if (!skill || !(/^[a-zA-Z0-9_-]{1,128}$/.test(skill.commandId)) || !/^[a-z0-9_]{1,128}$/.test(skill.skillId) || typeof skill.name !== 'string' ||
        typeof skill.invocation !== 'string' || !skill.invocation.startsWith(`/${row.id}:`) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.invocation.slice(row.id.length + 2)) || commands.has(skill.commandId) || skills.has(skill.skillId)) throw unavailable()
    commands.add(skill.commandId); skills.add(skill.skillId)
  }
  if (row.builtIn && !matchesBuiltinInventory(row.skills, BUILTIN_PLUGIN_SKILLS) && !matchesBuiltinInventory(row.skills, LEGACY_BUILTIN_PLUGIN_SKILLS)) throw unavailable()
  return row
}
export function pluginDescriptor(record: AgentPluginRecord): AgentPluginDescriptor {
  const { user_id: _owner, created_at: _created, updated_at: _updated, ...descriptor } = record
  return descriptor
}
export function pluginEnabledForAgent(record: Pick<AgentPluginRecord, 'enabled_for_all_agents' | 'enabled_agent_ids' | 'removing' | 'installing'>, agentId: string) {
  return record.removing !== true && record.installing !== true && (record.enabled_for_all_agents || record.enabled_agent_ids.includes(agentId))
}

// One write after every legacy row has been read and strictly checked. Existing rows remain untouched.
export const MIGRATE_BUILTIN_PLUGIN_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('JSON.GET', KEYS[1]) end
local next = cjson.decode(ARGV[1])
local legacy = cjson.decode(ARGV[2])
local collision = cjson.decode(ARGV[4])
for index = 1, 2 do
  if (redis.call('JSON.GET', KEYS[#legacy + 1 + index], '$') or '') ~= collision[index] then return 'LEGACY_CHANGED' end
end
local present, global, selected = false, false, {}
for index = 2, #legacy + 1 do
  if (redis.call('JSON.GET', KEYS[index]) or '') ~= cjson.decode(ARGV[3])[index - 1] then return 'LEGACY_CHANGED' end
  local kind = redis.call('TYPE', KEYS[index]).ok
  if kind ~= 'none' then
    if redis.call('JSON.TYPE', KEYS[index], '$')[1] ~= 'object' then return 'INVALID_LEGACY' end
    local row = cjson.decode(redis.call('JSON.GET', KEYS[index]))
    local expected = legacy[index - 1]
    if row.id ~= expected.commandId or row.user_id ~= next.user_id or row.type ~= 'skill' or row.skill_id ~= expected.skillId then return 'INVALID_LEGACY' end
    for _, field in ipairs({'is_active', 'can_be_invoked_in_chat', 'enabled_for_all_agents'}) do
      if row[field] ~= nil and type(row[field]) ~= 'boolean' then return 'INVALID_LEGACY' end
    end
    local listType = redis.call('JSON.TYPE', KEYS[index], '$.enabled_agent_ids')
    if #listType > 0 and listType[1] ~= 'array' then return 'INVALID_LEGACY' end
    if #listType > 0 then
      for _, id in ipairs(row.enabled_agent_ids) do
        if type(id) ~= 'string' or #id == 0 or string.find(id, '^%s') or string.find(id, '%s$') then return 'INVALID_LEGACY' end
      end
    end
    present = true
    if row.is_active ~= false and row.can_be_invoked_in_chat ~= false then
      if row.enabled_for_all_agents == true or #listType == 0 then global = true end
      for _, id in ipairs(row.enabled_agent_ids or {}) do selected[id] = true end
    end
  end
end
next.enabled_for_all_agents = global or not present
local ids = {}
for id, _ in pairs(selected) do ids[#ids + 1] = id end
table.sort(ids)
next.enabled_agent_ids = nil
local encoded = cjson.encode(next)
-- cjson encodes empty Lua tables as objects; access lists must always be JSON arrays.
encoded = string.sub(encoded, 1, -2) .. ',"enabled_agent_ids":' .. (#ids > 0 and cjson.encode(ids) or '[]') .. '}'
redis.call('JSON.SET', KEYS[1], '$', encoded)
return redis.call('JSON.GET', KEYS[1])
`
const collision = () => new AgentPluginError('BUILTIN_SKILL_ID_COLLISION', 'The App Actions command or skill ID is already owned by another saved item. Its content and access were preserved; resolve that ID collision before installing the new built-in skill.')
function rootRecord(raw: string | null): Record<string, any> | null {
  if (raw === null) return null
  const values: unknown = JSON.parse(raw)
  if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object' || Array.isArray(values[0])) throw unavailable()
  return values[0] as Record<string, any>
}
async function appActionsCollisionSources(userId: string): Promise<string[]> {
  const keys = [`slash_command:${userId}:${APP_ACTIONS_COMMAND_ID}`, `skill:${userId}:${APP_ACTIONS_SKILL_ID}`]
  const raw = await Promise.all(keys.map(key => redis.json.getRaw(key, '$')))
  const command = rootRecord(raw[0]), skill = rootRecord(raw[1])
  if (command && !isCanonicalAppActionsCommand(command, userId)) throw collision()
  if (skill && !isCanonicalAppActionsSkill(skill, userId)) throw collision()
  return raw.map(value => value ?? '')
}

/** Append one member and update only owned leaves: old descriptor/root extensions stay raw. */
export const UPGRADE_BUILTIN_PLUGIN_SCRIPT = `
if redis.call('TYPE', KEYS[1]).ok ~= 'ReJSON-RL' then return {'CHANGED'} end
if redis.call('JSON.GET', KEYS[1], '$') ~= ARGV[1] then return {'CHANGED'} end
local expected = cjson.decode(ARGV[6])
for index = 2, 3 do
  local kind = redis.call('TYPE', KEYS[index]).ok
  if kind ~= 'none' and kind ~= 'ReJSON-RL' then return {'CHANGED'} end
  if (redis.call('JSON.GET', KEYS[index], '$') or '') ~= expected[index - 1] then return {'CHANGED'} end
end
local types = redis.call('JSON.TYPE', KEYS[1], '$.skills')
if #types ~= 1 or types[1] ~= 'array' or redis.call('JSON.ARRLEN', KEYS[1], '$.skills')[1] ~= 7 then return {'INVALID'} end
for _, path in ipairs({'$.version', '$.revision', '$.updated_at', '$.description'}) do
  local fields = redis.call('JSON.TYPE', KEYS[1], path)
  if #fields ~= 1 or fields[1] ~= 'string' then return {'INVALID'} end
end
for index = 2, 5 do local ok = pcall(cjson.decode, ARGV[index]); if not ok then return {'INVALID'} end end
if not pcall(cjson.decode, ARGV[7]) then return {'INVALID'} end
local appended = redis.pcall('JSON.ARRAPPEND', KEYS[1], '$.skills', ARGV[2])
if type(appended) ~= 'table' or appended.err or #appended ~= 1 or appended[1] ~= 8 then return {'PARTIAL', '0'} end
local confirmed = 1
for _, write in ipairs({{'$.version', ARGV[3]}, {'$.revision', ARGV[4]}, {'$.updated_at', ARGV[5]}, {'$.description', ARGV[7]}}) do
  local result = redis.pcall('JSON.SET', KEYS[1], write[1], write[2])
  if type(result) ~= 'table' or result.ok ~= 'OK' then return {'PARTIAL', tostring(confirmed)} end
  confirmed = confirmed + 1
end
return {'UPGRADED'}
`
async function upgradeBuiltinInventory(userId: string, lifecycle: SettingsLifecycleSnapshot): Promise<AgentPluginRecord> {
  const groupKey = agentPluginKey(userId, BUNDLED_BATSHIT_PLUGIN_ID)
  if (uncertainBuiltinInventories.has(groupKey)) throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'An earlier built-in inventory write is still unconfirmed. It will not be repeated in this running app.', 503, 'unknown')
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await redis.json.getRaw(groupKey, '$')
    const current = validateAgentPluginRecord(rootRecord(raw), userId, BUNDLED_BATSHIT_PLUGIN_ID)
    const sources = await appActionsCollisionSources(userId)
    if (matchesBuiltinInventory(current.skills, BUILTIN_PLUGIN_SKILLS)) return current
    const member = BUILTIN_PLUGIN_SKILLS.find(skill => skill.skillId === APP_ACTIONS_SKILL_ID)!
    const descriptor: AgentPluginSkill = { commandId: member.commandId, skillId: member.skillId, name: member.displayName, invocation: `/batshit:${member.commandId}` }
    const revision = randomUUID(), updatedAt = new Date().toISOString()
    const description = 'Skills for using and extending Batshit.'
    let lease: ReturnType<typeof acquireSettingsMutation> | undefined, issued = false
    let answer: unknown
    try {
      answer = await redis.execute(client => {
        lease = acquireSettingsMutation(lifecycle); lease.check(); issued = true
        return client.eval(UPGRADE_BUILTIN_PLUGIN_SCRIPT, { keys: [groupKey, `slash_command:${userId}:${APP_ACTIONS_COMMAND_ID}`, `skill:${userId}:${APP_ACTIONS_SKILL_ID}`],
          arguments: [raw!, JSON.stringify(descriptor), JSON.stringify(BUNDLED_BATSHIT_PLUGIN_VERSION), JSON.stringify(revision), JSON.stringify(updatedAt), JSON.stringify(sources), JSON.stringify(description)] })
      })
    } catch (error) {
      if (issued) { uncertainBuiltinInventories.add(groupKey); lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'The built-in plugin inventory upgrade is unconfirmed. Access was not changed; do not repeat the write.', 503, 'unknown') }
      lease?.settle(); throw error
    }
    if (Array.isArray(answer) && answer.length === 1 && answer[0] === 'UPGRADED') {
      lease?.settle()
      return validateAgentPluginRecord({ ...current, description, skills: [...current.skills, descriptor], version: BUNDLED_BATSHIT_PLUGIN_VERSION, revision, updated_at: updatedAt }, userId, current.id)
    }
    if (Array.isArray(answer) && answer.length === 1 && (answer[0] === 'CHANGED' || answer[0] === 'INVALID')) {
      lease?.settle()
      if (answer[0] === 'CHANGED') continue
      throw unavailable()
    }
    uncertainBuiltinInventories.add(groupKey); lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'The built-in plugin inventory upgrade may be partly applied. Access was not changed; do not repeat the write.', 503, 'unknown')
  }
  throw new AgentPluginError('PLUGIN_ACCESS_CHANGED', 'Plugin metadata changed while upgrading its inventory. Reload before trying again.')
}
export async function ensureBuiltinAgentPlugin(userId: string): Promise<AgentPluginRecord> {
  const lifecycle = captureSettingsLifecycle([])
  const existing = await redis.json.get(agentPluginKey(userId, BUNDLED_BATSHIT_PLUGIN_ID))
  if (existing !== null) {
    const current = validateAgentPluginRecord(existing, userId, BUNDLED_BATSHIT_PLUGIN_ID)
    if (!matchesBuiltinInventory(current.skills, BUILTIN_PLUGIN_SKILLS)) return upgradeBuiltinInventory(userId, lifecycle)
    await appActionsCollisionSources(userId)
    return current
  }
  if (uncertainBuiltinInventories.has(agentPluginKey(userId, BUNDLED_BATSHIT_PLUGIN_ID))) throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'An earlier built-in inventory write is still unconfirmed. It will not be repeated in this running app.', 503, 'unknown')
  const appActionsSources = await appActionsCollisionSources(userId)
  const now = new Date().toISOString()
  const initial: AgentPluginRecord = { id: BUNDLED_BATSHIT_PLUGIN_ID, user_id: userId, name: 'Batshit',
    description: 'Skills for using and extending Batshit.', builtIn: true, version: BUNDLED_BATSHIT_PLUGIN_VERSION,
    skills: BUILTIN_PLUGIN_SKILLS.map(skill => ({ commandId: skill.commandId, skillId: skill.skillId, name: skill.displayName, invocation: `/batshit:${skill.commandId}` })),
    enabled_for_all_agents: true, enabled_agent_ids: [], revision: randomUUID(), created_at: now, updated_at: now }
  const legacy = LEGACY_BUILTIN_PLUGIN_SKILLS.filter(skill => skill.commandId !== 'goon-guide')
  const raw = await redis.execute(async client => {
    const snapshots: string[] = []
    for (const skill of legacy) {
      const text = await client.sendCommand(['JSON.GET', `slash_command:${userId}:${skill.commandId}`]) as string | null
      if (text !== null) {
        let row: Record<string, unknown>
        try { row = JSON.parse(text) } catch { throw unavailable() }
        if (!row || typeof row !== 'object' || Array.isArray(row) || row.id !== skill.commandId || row.user_id !== userId || row.type !== 'skill' || row.skill_id !== skill.skillId ||
          ['is_active', 'can_be_invoked_in_chat', 'enabled_for_all_agents'].some(field => row[field] !== undefined && typeof row[field] !== 'boolean') ||
          Object.hasOwn(row, 'enabled_agent_ids') && (!Array.isArray(row.enabled_agent_ids) || row.enabled_agent_ids.some(id => !isExactSavedAccessAgentId(id)))) throw unavailable()
      }
      snapshots.push(text ?? '')
    }
    return snapshots
  })
  let lease: ReturnType<typeof acquireSettingsMutation> | undefined, issued = false
  let answer: unknown
  try { answer = await redis.execute(client => {
    lease = acquireSettingsMutation(lifecycle)
    issued = true
    return client.eval(MIGRATE_BUILTIN_PLUGIN_SCRIPT, {
      keys: [agentPluginKey(userId, initial.id), ...legacy.map(skill => `slash_command:${userId}:${skill.commandId}`), `slash_command:${userId}:${APP_ACTIONS_COMMAND_ID}`, `skill:${userId}:${APP_ACTIONS_SKILL_ID}`],
      arguments: [JSON.stringify(initial), JSON.stringify(legacy), JSON.stringify(raw), JSON.stringify(appActionsSources)]
    })
  }) } catch (error) {
    if (issued) { uncertainBuiltinInventories.add(agentPluginKey(userId, initial.id)); lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin migration could not be confirmed. Do not repeat the write.', 503, 'unknown') }
    lease?.settle(); throw error
  }
  if (typeof answer !== 'string') { uncertainBuiltinInventories.add(agentPluginKey(userId, initial.id)); lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin migration could not be confirmed.', 503, 'unknown') }
  if (answer === 'INVALID_LEGACY' || answer === 'LEGACY_CHANGED') { lease?.settle(); throw unavailable() }
  try {
    const record = validateAgentPluginRecord(JSON.parse(answer), userId, initial.id)
    lease?.settle(); return record
  } catch {
    uncertainBuiltinInventories.add(agentPluginKey(userId, initial.id)); lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin migration readback could not be confirmed. Do not repeat the write.', 503, 'unknown')
  }
}
export async function getAgentPlugin(userId: string, pluginId: string): Promise<AgentPluginRecord | null> {
  if (!validPluginId(pluginId)) throw new AgentPluginError('PLUGIN_ID_INVALID', 'Invalid plugin ID.', 400)
  if (pluginId === BUNDLED_BATSHIT_PLUGIN_ID) return ensureBuiltinAgentPlugin(userId)
  const raw = await redis.json.get(agentPluginKey(userId, pluginId))
  return raw === null ? null : validateAgentPluginRecord(raw, userId, pluginId)
}
export async function listAgentPlugins(userId: string, options: { readOnly?: boolean; read?: (key: string) => Promise<unknown> } = {}): Promise<AgentPluginRecord[]> {
  if (!options.readOnly) await ensureBuiltinAgentPlugin(userId)
  return redis.execute(async client => {
    const result: AgentPluginRecord[] = []
    for (const key of await client.keys(`agent_plugin:${userId}:*`)) {
      const row = validateAgentPluginRecord(await (options.read ? options.read(key) : client.json.get(key)), userId)
      if (key !== agentPluginKey(userId, row.id)) throw unavailable()
      result.push(row)
    }
    return result.sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name))
  })
}
export async function pluginForCommand(userId: string, command: Pick<SlashCommandRow, 'id' | 'skill_id' | 'plugin_id'>, plugins?: AgentPluginRecord[]) {
  const records = plugins ?? await listAgentPlugins(userId)
  if (command.plugin_id !== undefined) {
    const owner = records.find(plugin => plugin.id === command.plugin_id)
    if (!owner || !owner.skills.some(skill => skill.commandId === command.id && skill.skillId === command.skill_id)) throw unavailable()
    return owner
  }
  if (command.id === APP_ACTIONS_COMMAND_ID || command.skill_id === APP_ACTIONS_SKILL_ID) return null
  return records.find(plugin => plugin.skills.some(skill => skill.skillId === command.skill_id || plugin.builtIn && skill.commandId === command.id)) ?? null
}
export async function projectPluginCommand(userId: string, command: SlashCommandRow, plugins?: AgentPluginRecord[]): Promise<SlashCommandRow> {
  const plugin = await pluginForCommand(userId, command, plugins)
  if (!plugin) return command
  const member = plugin.skills.find(skill => skill.commandId === command.id || skill.skillId === command.skill_id)!
  return { ...command, plugin_id: plugin.id, invocation_pattern: member.invocation, is_active: plugin.removing !== true && plugin.installing !== true, can_be_invoked_in_chat: plugin.removing !== true && plugin.installing !== true,
    enabled_for_all_agents: plugin.enabled_for_all_agents, enabled_agent_ids: [...plugin.enabled_agent_ids],
    can_be_attached_to_agents: plugin.enabled_for_all_agents || plugin.enabled_agent_ids.length > 0 }
}
export async function refusePluginMemberWrite(userId: string, command: Pick<SlashCommandRow, 'id' | 'skill_id' | 'plugin_id'>): Promise<void> {
  if (command.plugin_id !== undefined || isBuiltinPluginMember(command) || await pluginForCommand(userId, command)) {
    throw new AgentPluginError('PLUGIN_MEMBER_USER_MANAGED', 'Manage access for this skill through its plugin in Settings → Plugins & shit → Plugins.')
  }
}

const MUTATE_PLUGIN_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID'} end
if redis.call('JSON.GET', KEYS[1]) ~= ARGV[6] then return {'CHANGED'} end
local row = cjson.decode(redis.call('JSON.GET', KEYS[1]))
if row.user_id ~= ARGV[1] or type(row.enabled_for_all_agents) ~= 'boolean' or redis.call('JSON.TYPE', KEYS[1], '$.enabled_agent_ids')[1] ~= 'array' then return {'INVALID'} end
for _, id in ipairs(row.enabled_agent_ids) do if type(id) ~= 'string' or #id == 0 then return {'INVALID'} end end
if row.removing == true then return {'REMOVING'} end
if row.installing == true then return {'INSTALLING'} end
local op, value = ARGV[2], ARGV[3]
if op == 'global' then
  local enabled = value == 'true'
  if row.enabled_for_all_agents == enabled then return {'UNCHANGED', redis.call('JSON.GET', KEYS[1])} end
  row.enabled_for_all_agents = enabled
else
  if op ~= 'remove' and row.enabled_for_all_agents then return {'GLOBAL'} end
  if op == 'enable' then
    local owned = false
    for index = 2, #KEYS do
      if redis.call('EXISTS', KEYS[index]) == 1 then
        if redis.call('JSON.TYPE', KEYS[index], '$')[1] ~= 'object' then return {'INVALID'} end
        local agent = cjson.decode(redis.call('JSON.GET', KEYS[index]))
        if agent.user_id == ARGV[1] and agent.id == value then owned = true end
      end
    end
    if not owned then return {'SUBJECT_MISSING'} end
  end
  local list, found = {}, false
  for _, id in ipairs(row.enabled_agent_ids) do
    if id == value then found = true end
    if id ~= value or op == 'enable' then list[#list + 1] = id end
  end
  if op == 'enable' and not found then list[#list + 1] = value end
  if (op == 'enable') == found then return {'UNCHANGED', redis.call('JSON.GET', KEYS[1])} end
  row.enabled_agent_ids = nil
  local encoded = cjson.encode(row)
  row = cjson.decode(string.sub(encoded, 1, -2) .. ',"enabled_agent_ids":' .. (#list > 0 and cjson.encode(list) or '[]') .. '}')
end
row.revision, row.updated_at = ARGV[4], ARGV[5]
-- Preserve the array shape through cjson's empty-table encoding.
local list = row.enabled_agent_ids
row.enabled_agent_ids = nil
local encoded = cjson.encode(row)
encoded = string.sub(encoded, 1, -2) .. ',"enabled_agent_ids":' .. (#list > 0 and cjson.encode(list) or '[]') .. '}'
redis.call('JSON.SET', KEYS[1], '$', encoded)
return {'OK', redis.call('JSON.GET', KEYS[1])}
`
async function mutate(userId: string, pluginId: string, op: 'global' | 'enable' | 'disable' | 'remove', value: string, replacement?: 'primary' | 'subagent') {
  const lifecycle = replacement ? null : captureSettingsLifecycle(op === 'enable' ? [`agent:${value}`, `subagent:${value}`] : [])
  const before = await getAgentPlugin(userId, pluginId)
  if (!before) throw new AgentPluginError('PLUGIN_NOT_FOUND', 'Plugin not found.', 404)
  for (let attempt = 0; attempt < 3; attempt++) {
    let lease: ReturnType<typeof acquireSettingsMutation> | undefined, issued = false
    let answer: unknown
    try { answer = await redis.execute(async client => {
      const raw = await client.sendCommand(['JSON.GET', agentPluginKey(userId, pluginId)]) as string | null
      if (raw === null) throw new AgentPluginError('PLUGIN_NOT_FOUND', 'Plugin not found.', 404)
      validateAgentPluginRecord(JSON.parse(raw), userId, pluginId)
      lease = replacement ? acquireSettingsReplacementMutation(`${replacement === 'primary' ? 'agent' : 'subagent'}:${value}`) : acquireSettingsMutation(lifecycle!)
      issued = true
      return client.eval(MUTATE_PLUGIN_SCRIPT, {
        keys: [agentPluginKey(userId, pluginId), ...(op === 'enable' ? [`agent:${value}`, `subagent:${value}`] : [])],
        arguments: [userId, op, value, randomUUID(), new Date().toISOString(), raw]
      })
    }) } catch (error) {
      if (issued) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'The plugin save outcome is unknown. Reload plugin access before trying again.', 503, 'unknown') }
      lease?.settle(); throw error
    }
    if (!Array.isArray(answer) || !['OK', 'UNCHANGED', 'MISSING', 'GLOBAL', 'SUBJECT_MISSING', 'INVALID', 'CHANGED', 'REMOVING', 'INSTALLING'].includes(answer[0] as string)) {
      lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'The plugin save outcome is unknown. Reload plugin access before trying again.', 503, 'unknown')
    }
    if (answer[0] === 'OK' || answer[0] === 'UNCHANGED') {
      try {
        const plugin = pluginDescriptor(validateAgentPluginRecord(JSON.parse(answer[1]), userId, pluginId))
        lease?.settle(); return { plugin, changed: answer[0] === 'OK' }
      } catch {
        lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin access readback could not be confirmed. Reload before trying again.', 503, 'unknown')
      }
    }
    lease?.settle()
    if (answer[0] === 'CHANGED') continue
    if (answer[0] === 'REMOVING') throw new AgentPluginError('PLUGIN_REMOVING', 'This plugin is being removed. Finish removing it before installing it again.')
    if (answer[0] === 'INSTALLING') throw new AgentPluginError('PLUGIN_INSTALLING', 'This plugin import is incomplete. Remove it before installing it again.')
    if (answer[0] === 'MISSING') throw new AgentPluginError('PLUGIN_NOT_FOUND', 'Plugin not found.', 404)
    if (answer[0] === 'GLOBAL') throw new AgentPluginError('PLUGIN_GLOBAL_ACCESS', 'Turn off Enable For All Agents before changing individual plugin access.')
    if (answer[0] === 'SUBJECT_MISSING') throw new AgentPluginError('PLUGIN_SUBJECT_MISSING', 'The selected agent no longer exists.', 404)
    throw unavailable()

  }
  throw new AgentPluginError('PLUGIN_ACCESS_CHANGED', 'Plugin access changed while saving. Reload before trying again.')
}

export const setAgentPluginGlobalAccess = (userId: string, pluginId: string, enabled: boolean) => mutate(userId, pluginId, 'global', String(enabled))
export const setAgentPluginAgentAccess = (userId: string, pluginId: string, agentId: string, enabled: boolean) => {
  if (!isExactSavedAccessAgentId(agentId)) throw new AgentPluginError('PLUGIN_SUBJECT_INVALID', 'Invalid agent ID.', 400)
  return mutate(userId, pluginId, enabled ? 'enable' : 'disable', agentId)
}
export async function removeAgentPluginAgentReferences(userId: string, agentId: string, kind: 'primary' | 'subagent') {
  // Caller holds the existing subject-deletion lease and has checked cross-kind ID sharing.
  for (const key of await redis.execute(client => client.keys(`agent_plugin:${userId}:*`))) {
    const plugin = validateAgentPluginRecord(await redis.json.get(key), userId, key.slice(`agent_plugin:${userId}:`.length))
    if (key !== agentPluginKey(userId, plugin.id)) throw unavailable()
    if (!plugin.removing && !plugin.installing) await mutate(userId, plugin.id, 'remove', agentId, kind)
  }
}
export async function registerAgentPlugin(userId: string, input: Omit<AgentPluginRecord, 'user_id' | 'revision' | 'created_at' | 'updated_at'>,
  lifecycle: SettingsLifecycleSnapshot = captureSettingsLifecycle([])) {
  const now = new Date().toISOString()
  if (input.id === BUNDLED_BATSHIT_PLUGIN_ID || input.builtIn) throw new AgentPluginError('PLUGIN_BUILTIN_PROTECTED', 'The built-in Batshit plugin cannot be replaced.')
  const record = validateAgentPluginRecord({ ...input, user_id: userId, revision: randomUUID(), created_at: now, updated_at: now }, userId)
  let lease: ReturnType<typeof acquireSettingsMutation> | undefined, issued = false
  let result: unknown
  try { result = await redis.execute(client => {
    lease = acquireSettingsMutation(lifecycle)
    issued = true
    // Raw Redis command takes JSON wire text; the object was strictly validated above.
    return client.sendCommand(['JSON.SET', agentPluginKey(userId, input.id), '$', JSON.stringify(record), 'NX'])
  }) } catch (error) {
    if (issued) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin installation could not be confirmed. Reload before trying again.', 503, 'unknown') }
    lease?.settle(); throw error
  }
  if (result !== 'OK' && result !== null) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin installation could not be confirmed.', 503, 'unknown') }
  lease?.settle()
  if (result !== 'OK') throw new AgentPluginError('PLUGIN_ALREADY_EXISTS', 'A plugin with this ID is already installed.')
  return record
}
/** Publish a fully staged import without changing its access-off intent. */
export async function finishAgentPluginImport(userId: string, pluginId: string, expectedRevision: string,
  lifecycle = captureSettingsLifecycle([])): Promise<AgentPluginRecord> {
  if (!validPluginId(pluginId) || !expectedRevision || pluginId === BUNDLED_BATSHIT_PLUGIN_ID) throw new AgentPluginError('PLUGIN_ID_INVALID', 'Invalid plugin import identity.', 400)
  let lease: ReturnType<typeof acquireSettingsMutation> | undefined, issued = false, answer: unknown
  let ready: AgentPluginRecord | null = null
  try { answer = await redis.execute(async client => {
    const raw = await client.sendCommand(['JSON.GET', agentPluginKey(userId, pluginId)]) as string | null
    assertSettingsLifecycle(lifecycle)
    if (raw === null) return 'MISSING'
    const current = validateAgentPluginRecord(JSON.parse(raw), userId, pluginId)
    if (current.removing || !current.installing || current.revision !== expectedRevision) return 'CHANGED'
    ready = { ...current, revision: randomUUID(), updated_at: new Date().toISOString() }
    delete ready.installing
    validateAgentPluginRecord(ready, userId, pluginId)
    lease = acquireSettingsMutation(lifecycle)
    issued = true
    return client.eval(`
      if redis.call('EXISTS', KEYS[1]) == 0 then return 'CHANGED' end
      if redis.call('JSON.GET', KEYS[1]) ~= ARGV[1] then return 'CHANGED' end
      redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
      return 'OK'
    `, { keys: [agentPluginKey(userId, pluginId)], arguments: [raw, JSON.stringify(ready)] })
  }) } catch (error) {
    if (issued) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin import completion could not be confirmed. Reload before trying again.', 503, 'unknown') }
    lease?.settle(); throw error
  }
  if (!['OK', 'CHANGED', 'MISSING'].includes(answer as string)) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin import completion could not be confirmed.', 503, 'unknown') }
  lease?.settle()
  if (answer !== 'OK' || !ready) throw new AgentPluginError('PLUGIN_ACCESS_CHANGED', 'The saved import identity changed. No plugin was enabled.')
  return ready
}

/** Revoke the group in one durable write, retaining exact cleanup inventory until finish. */
export async function removeAgentPlugin(userId: string, pluginId: string, lifecycle = captureSettingsLifecycle([]), expectedRevision?: string) {
  if (!validPluginId(pluginId)) throw new AgentPluginError('PLUGIN_ID_INVALID', 'Invalid plugin ID.', 400)
  if (pluginId === BUNDLED_BATSHIT_PLUGIN_ID) throw new AgentPluginError('PLUGIN_BUILTIN_PROTECTED', 'The built-in Batshit plugin cannot be removed.')
  let lease: ReturnType<typeof acquireSettingsMutation> | undefined, issued = false
  let plugin: AgentPluginRecord | null = null, answer: unknown
  try { answer = await redis.execute(async client => {
    const raw = await client.sendCommand(['JSON.GET', agentPluginKey(userId, pluginId)]) as string | null
    assertSettingsLifecycle(lifecycle)
    if (raw === null) return 'MISSING'
    const current = validateAgentPluginRecord(JSON.parse(raw), userId, pluginId)
    if (expectedRevision !== undefined && current.revision !== expectedRevision) return 'CHANGED'
    if (current.removing) { plugin = current; return 'UNCHANGED' }
    plugin = validateAgentPluginRecord({ ...current, removing: true, enabled_for_all_agents: false,
      enabled_agent_ids: [], revision: randomUUID(), updated_at: new Date().toISOString() }, userId, pluginId)
    lease = acquireSettingsMutation(lifecycle)
    issued = true
    return client.eval(`
      if redis.call('EXISTS', KEYS[1]) == 0 then return 'CHANGED' end
      if redis.call('JSON.GET', KEYS[1]) ~= ARGV[1] then return 'CHANGED' end
      redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
      return 'OK'
    `, { keys: [agentPluginKey(userId, pluginId)], arguments: [raw, JSON.stringify(plugin)] })
  }) } catch (error) {
    if (issued) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin removal could not be confirmed. Reload before trying again.', 503, 'unknown') }
    lease?.settle(); throw error
  }
  if (!['OK', 'UNCHANGED', 'CHANGED', 'MISSING'].includes(answer as string)) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Plugin removal could not be confirmed.', 503, 'unknown') }
  lease?.settle()
  if (answer === 'CHANGED') throw new AgentPluginError('PLUGIN_ACCESS_CHANGED', 'Plugin access changed during removal. Reload before trying again.')
  return plugin as AgentPluginRecord | null
}

/** The importer calls this only after owned metadata and files have all been cleaned. */
export async function finishRemoveAgentPlugin(userId: string, pluginId: string, expectedRevision: string,
  lifecycle = captureSettingsLifecycle([])): Promise<boolean> {
  if (!validPluginId(pluginId) || !expectedRevision) throw new AgentPluginError('PLUGIN_ID_INVALID', 'Invalid plugin removal identity.', 400)
  if (pluginId === BUNDLED_BATSHIT_PLUGIN_ID) throw new AgentPluginError('PLUGIN_BUILTIN_PROTECTED', 'The built-in Batshit plugin cannot be removed.')
  let lease: ReturnType<typeof acquireSettingsMutation> | undefined, issued = false, answer: unknown
  try { answer = await redis.execute(async client => {
    const raw = await client.sendCommand(['JSON.GET', agentPluginKey(userId, pluginId)]) as string | null
    assertSettingsLifecycle(lifecycle)
    if (raw === null) return 'MISSING'
    const plugin = validateAgentPluginRecord(JSON.parse(raw), userId, pluginId)
    if (!plugin.removing || plugin.revision !== expectedRevision) return 'CHANGED'
    lease = acquireSettingsMutation(lifecycle)
    issued = true
    return client.eval(`
      if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
      if redis.call('JSON.GET', KEYS[1]) ~= ARGV[1] then return 'CHANGED' end
      redis.call('DEL', KEYS[1])
      return 'OK'
    `, { keys: [agentPluginKey(userId, pluginId)], arguments: [raw] })
  }) } catch (error) {
    if (issued) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Finishing plugin removal could not be confirmed. Reload before trying again.', 503, 'unknown') }
    lease?.settle(); throw error
  }
  if (!['OK', 'CHANGED', 'MISSING'].includes(answer as string)) { lease?.unknown(); throw new AgentPluginError('PLUGIN_SAVE_UNKNOWN', 'Finishing plugin removal could not be confirmed.', 503, 'unknown') }
  lease?.settle()
  if (answer === 'CHANGED') throw new AgentPluginError('PLUGIN_ACCESS_CHANGED', 'The saved removal identity changed. The plugin was retained.')
  return answer === 'OK'
}
