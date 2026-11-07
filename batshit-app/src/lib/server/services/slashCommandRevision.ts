import { isExactSavedAccessAgentId } from '$lib/utils/agentAccessIds'
import { redis } from '$lib/server/redis'
import type { SkillSourceRow, SlashCommandRow } from '$lib/types/database'
import { newSlashCommandRevision, slashCommandRevisionKey, SLASH_COMMAND_REVISION_LUA, SlashCommandMutationError, beginSlashCommandWrite, slashCommandPreparationState, type SlashCommandWritePreparation } from './slashCommandRevisionProtocol'
import { acquireSettingsMutation } from './appActions/settings/lifecycle'
export { beginSlashCommandWrite, currentSlashCommandWriteRevision, type SlashCommandWritePreparation, newSlashCommandRevision, slashCommandRevisionKey, SLASH_COMMAND_REVISION_LUA, SlashCommandMutationError, isSlashCommandMutationError } from './slashCommandRevisionProtocol'

export async function readSlashCommandRevision(userId: string): Promise<string | null> {
  const value = await redis.execute(client => client.get(slashCommandRevisionKey(userId)))
  if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    throw new SlashCommandMutationError('SLASH_COMMAND_INVALID', 'The command revision is unreadable. No access change was made.', 'not_written')
  }
  return value
}

const COMMAND_BASIS_PATHS = ['id', 'user_id', 'type', 'skill_id', 'created_at', 'enabled_agent_ids', 'enabled_for_all_agents', 'is_active', 'can_be_invoked_in_chat'] as const
const SOURCE_BASIS_PATHS = ['id', 'user_id', 'label', 'root_path', 'scope', 'trust_level', 'enabled', 'enabled_for_all_agents', 'enabled_agent_ids', 'project_path', 'created_at'] as const
const MAX_BASIS_BYTES = 1024 * 1024
const validId = (value: string) => /^[A-Za-z0-9_-]+$/.test(value)
const conflict = () => new SlashCommandMutationError('SLASH_COMMAND_CONFLICT', 'The saved command or source changed. Reload before another change.', 'not_written')
function validateOwnerVector(raw: string[], userId: string, id: string) {
  if (raw.every(value => value === '')) return
  try {
    const savedId = JSON.parse(raw[0]); const owner = JSON.parse(raw[1])
    if (JSON.stringify(savedId) !== JSON.stringify([id]) || JSON.stringify(owner) !== JSON.stringify([userId])) throw invalid()
  } catch { throw invalid() }
}
const invalid = () => new SlashCommandMutationError('SLASH_COMMAND_INVALID', 'The saved command or source is unreadable. Its metadata/access update was not issued.', 'not_written')
const unconfirmed = () => new SlashCommandMutationError('SLASH_COMMAND_UNCONFIRMED', 'The command or source write may have reached storage. Its outcome is unconfirmed; do not retry it.', 'unknown')
const savedUnreadable = () => new SlashCommandMutationError('SLASH_COMMAND_SAVED_READBACK_UNAVAILABLE', 'The change was saved, but its current value could not be checked. Reload before another change.', 'saved_readback_unavailable')

declare const basisBrand: unique symbol
declare const sourceBasisBrand: unique symbol
export type SlashCommandWriteBasis = Readonly<{ [basisBrand]: true }>
export type SkillSourceWriteBasis = Readonly<{ [sourceBasisBrand]: true }>
type SourceBasis = { preparation: SlashCommandWritePreparation; userId: string; id: string; raw: string[] }
type CommandBasis = { preparation: SlashCommandWritePreparation; userId: string; revision: string | null; ids: string[]; raw: string[][]; source?: SourceBasis; used: boolean }
const bases = new WeakMap<SlashCommandWriteBasis, CommandBasis>()
const sourceBases = new WeakMap<SkillSourceWriteBasis, SourceBasis>()
const BASIS_LUA = `
local function vector(key, paths)
  local values = {}
  local exists = redis.call('EXISTS', key) == 1
  for _, path in ipairs(paths) do
    local raw = ''
    if exists then
      raw = redis.pcall('JSON.GET', key, '$.' .. path)
      if type(raw) ~= 'string' then return nil end
    end
    values[#values + 1] = raw
  end
  return values
end
local function matches(key, paths, expected)
  local current = vector(key, paths)
  if not current or #current ~= #expected then return false end
  for index, raw in ipairs(current) do if raw ~= expected[index] then return false end end
  return true
end
`
const CAPTURE_BASIS_SCRIPT = `${SLASH_COMMAND_REVISION_LUA}${BASIS_LUA}
local revision = command_revision(KEYS[1])
if revision == nil then return {'INVALID_REVISION'} end
local paths = cjson.decode(ARGV[1])
local result = {'CAPTURED', revision}
for index = 2, #KEYS do
  local raw = vector(KEYS[index], paths)
  if not raw then return {'INVALID_RECORD'} end
  result[#result + 1] = cjson.encode(raw)
end
return result
`
async function captureVectors(preparation: SlashCommandWritePreparation, userId: string, keys: string[], paths: readonly string[]) {
  const state = slashCommandPreparationState(preparation, userId)
  if (state.busy) throw conflict()
  state.busy = true
  try {
    const answer = await redis.execute(client => {
      slashCommandPreparationState(preparation, userId)
      return client.eval(CAPTURE_BASIS_SCRIPT, { keys: [slashCommandRevisionKey(userId), ...keys], arguments: [JSON.stringify(paths)] })
    })
    slashCommandPreparationState(preparation, userId)
    if (!Array.isArray(answer) || answer[0] !== 'CAPTURED' || answer.length !== keys.length + 2 || typeof answer[1] !== 'string') throw invalid()
    const revision = answer[1] || null
    if (state.revision !== undefined && state.revision !== revision) throw conflict()
    const raw = answer.slice(2).map(value => {
      if (typeof value !== 'string') throw invalid()
      const parsed: unknown = JSON.parse(value)
      if (!Array.isArray(parsed) || parsed.length !== paths.length || parsed.some(item => typeof item !== 'string')) throw invalid()
      return parsed as string[]
    })
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BASIS_BYTES) throw invalid()
    state.revision = revision
    return { revision, raw }
  } finally { state.busy = false }
}
/** Capture BEFORE saved command metadata or file preparation. Never adopts a foreign nonce. */
export async function captureSlashCommandWriteBasis(preparation: SlashCommandWritePreparation, commandIds: readonly string[], sourceBasis?: SkillSourceWriteBasis): Promise<SlashCommandWriteBasis> {
  const state = slashCommandPreparationState(preparation)
  const ids = [...commandIds]
  if (ids.length > 32 || new Set(ids).size !== ids.length || ids.some(id => !validId(id))) throw invalid()
  const source = sourceBasis ? sourceBases.get(sourceBasis) : undefined
  if (sourceBasis && (!source || source.preparation !== preparation)) throw conflict()
  const captured = await captureVectors(preparation, state.userId, ids.map(id => `slash_command:${state.userId}:${id}`), COMMAND_BASIS_PATHS)
  captured.raw.forEach((raw, index) => validateOwnerVector(raw, state.userId, ids[index]))
  const handle = Object.freeze({}) as SlashCommandWriteBasis
  bases.set(handle, { preparation, userId: state.userId, ids, ...captured, source, used: false })
  return handle
}

export async function captureSkillSourceWriteBasis(preparation: SlashCommandWritePreparation, sourceId: string): Promise<SkillSourceWriteBasis> {
  const state = slashCommandPreparationState(preparation)
  if (!validId(sourceId)) throw invalid()
  const { raw } = await captureVectors(preparation, state.userId, [`skill_source:${state.userId}:${sourceId}`], SOURCE_BASIS_PATHS)
  validateOwnerVector(raw[0], state.userId, sourceId)
  const handle = Object.freeze({}) as SkillSourceWriteBasis
  sourceBases.set(handle, { preparation, userId: state.userId, id: sourceId, raw: raw[0] })
  return handle
}
function commandBasis(userId: string, ids: string[], basis: SlashCommandWriteBasis) {
  const held = bases.get(basis)
  if (!held || held.used || held.userId !== userId || JSON.stringify(ids) !== JSON.stringify(held.ids)) throw conflict()
  const state = slashCommandPreparationState(held.preparation, userId)
  if (state.busy || state.revision !== held.revision) throw conflict()
  return { held, state }
}
function checkedAnswer(answer: unknown): string {
  return Array.isArray(answer) && typeof answer[0] === 'string' ? answer[0] : typeof answer === 'string' ? answer : 'UNCONFIRMED'
}
/** Only the finite scripts below enter this private issued-command boundary. */
async function issue(held: { preparation: SlashCommandWritePreparation; userId: string }, script: string, keys: string[], args: (nonce: string) => string[]) {
  const state = slashCommandPreparationState(held.preparation, held.userId)
  if (state.busy) throw conflict()
  const nonce = newSlashCommandRevision()
  state.busy = true
  let lease: ReturnType<typeof acquireSettingsMutation> | undefined
  let issued = false
  try {
    const arguments_ = args(nonce)
    const answer = await redis.execute(client => {
      slashCommandPreparationState(held.preparation, held.userId)
      lease = acquireSettingsMutation(state.lifecycle)
      lease.check()
      issued = true
      return client.eval(script, { keys, arguments: arguments_ })
    })
    const status = checkedAnswer(answer)
    if (['OK', 'UNCHANGED', 'MISSING', 'CONFLICT', 'INVALID', 'INVALID_REVISION', 'INVALID_RECORD', 'INVALID_ACCESS', 'SAVED_READBACK_UNAVAILABLE'].includes(status)) {
      lease?.settle()
      if (status === 'OK' || status === 'SAVED_READBACK_UNAVAILABLE') state.revision = nonce
      if (status === 'CONFLICT') throw conflict()
      if (status.startsWith('INVALID')) throw invalid()
      if (status === 'SAVED_READBACK_UNAVAILABLE') throw savedUnreadable()
      return answer
    }
    throw unconfirmed()
  } catch (error) {
    if (issued && !(error instanceof SlashCommandMutationError && error.outcome !== 'unknown')) {
      state.poisoned = true
      lease?.unknown()
      throw unconfirmed()
    }
    lease?.settle()
    if (error instanceof SlashCommandMutationError) throw error
    throw new SlashCommandMutationError('SLASH_COMMAND_CONFLICT', 'The metadata/access update ended before issue. Reload before another change.', 'not_written')
  } finally { state.busy = false }
}

export const COMMAND_ACCESS_FIELDS = [
  'enabled_agent_ids', 'enabled_for_all_agents', 'is_active', 'can_be_invoked_in_chat'
] as const
export type CommandAccessField = typeof COMMAND_ACCESS_FIELDS[number]
export type SlashCommandWrite = {
  record: SlashCommandRow
  mode: 'create' | 'update' | 'upsert'
  /** Preserve exactly the currently stored fields, including absence. */
  preserveAccess?: readonly CommandAccessField[]
  /** Skill-source owner only: merge explicit assignments against the current list. */
  mergeAgentIds?: readonly string[]
  enableForAll?: boolean
}

/** All validation/preparation is before the revision and record mutation boundary.
 * Rotating BEFORE records means even a partial/uncertain command invalidates old plans.
 * This has no lock and is never wrapped in a nested catalogue replacement owner. */
export const WRITE_SLASH_COMMANDS_SCRIPT = `
${SLASH_COMMAND_REVISION_LUA}${BASIS_LUA}
local revision = command_revision(KEYS[1])
if revision == nil or not valid_command_nonce(ARGV[2]) then return {'INVALID_REVISION'} end
local payload = cjson.decode(ARGV[1])
if type(payload) ~= 'table' or type(payload.writes) ~= 'table' or type(payload.deletes) ~= 'table' then return {'INVALID'} end
if #payload.writes + #payload.deletes > 32 then return {'INVALID'} end
if revision ~= ARGV[3] then return {'CONFLICT'} end
if #payload.basis ~= #payload.writes + #payload.deletes then return {'INVALID'} end
for index, expected in ipairs(payload.basis) do
  if not matches(KEYS[index + 1], payload.paths, expected) then return {'CONFLICT'} end
end
if payload.source and not matches(KEYS[#payload.basis + 2], payload.source.paths, payload.source.raw) then return {'CONFLICT'} end
local allowed = {enabled_agent_ids=true, enabled_for_all_agents=true, is_active=true, can_be_invoked_in_chat=true}
local plans = {}
local deletes = {}
local seen = {}
for index, write in ipairs(payload.writes) do
  local key = KEYS[index + 1]
  local record = cjson.decode(write.record)
  if not key or type(record) ~= 'table' or record.id ~= write.id or record.user_id ~= payload.userId or
    (record.type ~= 'skill' and record.type ~= 'prompt') or seen[key] then return {'INVALID'} end
  seen[key] = true
  local exists = redis.call('EXISTS', key) == 1
  if write.mode ~= 'create' and write.mode ~= 'update' and write.mode ~= 'upsert' then return {'INVALID'} end
  if write.mode == 'create' and exists then return {'CONFLICT'} end
  if write.mode == 'update' and not exists then return {'MISSING'} end
  local current = nil
  if exists then
    if redis.call('JSON.TYPE', key, '$')[1] ~= 'object' then return {'INVALID_RECORD'} end
    current = cjson.decode(redis.call('JSON.GET', key, '$'))[1]
    if current.id ~= write.id or current.user_id ~= payload.userId then return {'INVALID_RECORD'} end
  end
  local fields = {}
  for _, field in ipairs(write.preserve or {}) do
    if not allowed[field] then return {'INVALID'} end
    if current then
      local raw = redis.call('JSON.GET', key, '$.' .. field)
      local encoded = false
      if raw ~= '[]' then encoded = string.sub(raw, 2, -2) end
      fields[#fields + 1] = {field, encoded}
      record[field] = current[field]
    end
  end
  if current then
    for _, field in ipairs({'usage_count', 'last_used_at'}) do
      local raw = redis.call('JSON.GET', key, '$.' .. field)
      local encoded = false
      if raw ~= '[]' then encoded = string.sub(raw, 2, -2) end
      fields[#fields + 1] = {field, encoded}
    end
  end
  if write.merge then
    local values = current and current.enabled_agent_ids or record.enabled_agent_ids
    local missing = current and redis.call('JSON.GET', key, '$.enabled_agent_ids') == '[]'
    if not missing then
      if type(values) ~= 'table' then return {'INVALID_ACCESS'} end
      local list = {}
      local ids = {}
      for _, value in ipairs(values) do
        if type(value) ~= 'string' or #value == 0 or string.find(value, '^%s') or string.find(value, '%s$') then return {'INVALID_ACCESS'} end
        if not ids[value] then ids[value] = true; list[#list + 1] = value end
      end
      for _, value in ipairs(write.merge) do
        if type(value) ~= 'string' or #value == 0 or string.find(value, '^%s') or string.find(value, '%s$') then return {'INVALID_ACCESS'} end
        if not ids[value] then ids[value] = true; list[#list + 1] = value end
      end
      record.enabled_agent_ids = list
      fields[#fields + 1] = {'enabled_agent_ids', #list > 0 and cjson.encode(list) or '[]'}
    else
      record.enabled_agent_ids = nil
      fields[#fields + 1] = {'enabled_agent_ids', false}
    end
    record.enabled_for_all_agents = (current and current.enabled_for_all_agents == true) or write.enableForAll == true
    fields[#fields + 1] = {'enabled_for_all_agents', record.enabled_for_all_agents and 'true' or 'false'}
  end
  local count = type(record.enabled_agent_ids) == 'table' and #record.enabled_agent_ids or 0
  fields[#fields + 1] = {'can_be_attached_to_agents', (record.enabled_for_all_agents == true or count > 0) and 'true' or 'false'}
  plans[#plans + 1] = {key=key, record=write.record, fields=fields}
end
for index, id in ipairs(payload.deletes) do
  local key = KEYS[#payload.writes + index + 1]
  if not key or seen[key] then return {'INVALID'} end
  seen[key] = true
  if redis.call('EXISTS', key) == 1 then
    if redis.call('JSON.TYPE', key, '$')[1] ~= 'object' then return {'INVALID_RECORD'} end
    local current = cjson.decode(redis.call('JSON.GET', key, '$'))[1]
    if current.id ~= id or current.user_id ~= payload.userId then return {'INVALID_RECORD'} end
    deletes[#deletes + 1] = key
  end
end
if #plans == 0 and #deletes == 0 then return {'UNCHANGED', '0'} end
-- Mutation boundary. Every planned path/value/container has been checked above.
redis.call('SET', KEYS[1], ARGV[2])
for _, plan in ipairs(plans) do
  local answer = redis.pcall('JSON.SET', plan.key, '$', plan.record)
  if type(answer) ~= 'table' or answer.ok ~= 'OK' then return {'PARTIAL'} end
  for _, field in ipairs(plan.fields) do
    if field[2] == false then
      answer = redis.pcall('JSON.DEL', plan.key, '$.' .. field[1])
      if type(answer) ~= 'number' then return {'PARTIAL'} end
    else
      answer = redis.pcall('JSON.SET', plan.key, '$.' .. field[1], field[2])
      if type(answer) ~= 'table' or answer.ok ~= 'OK' then return {'PARTIAL'} end
    end
  end
end
for _, key in ipairs(deletes) do
  if redis.pcall('DEL', key) ~= 1 then return {'PARTIAL'} end
end
local result = {'OK', tostring(#deletes)}
for _, plan in ipairs(plans) do
  local raw = redis.pcall('JSON.GET', plan.key, '$')
  if type(raw) ~= 'string' then return {'SAVED_READBACK_UNAVAILABLE'} end
  result[#result + 1] = raw
end
return result
`

export async function saveSlashCommandBatch(
  userId: string, writes: readonly SlashCommandWrite[], basis: SlashCommandWriteBasis,
  deleteIds: readonly string[] = []
): Promise<{ records: SlashCommandRow[]; deleted: number } | null> {
  const ids = [...writes.map(write => write.record.id), ...deleteIds]
  const { held } = commandBasis(userId, ids, basis)
  held.used = true
  const answer = await issue(held, WRITE_SLASH_COMMANDS_SCRIPT, [slashCommandRevisionKey(userId),
    ...ids.map(id => `slash_command:${userId}:${id}`), ...(held.source ? [`skill_source:${userId}:${held.source.id}`] : [])], nonce => [
    JSON.stringify({ userId, basis: held.raw, paths: COMMAND_BASIS_PATHS,
      ...(held.source ? { source: { paths: SOURCE_BASIS_PATHS, raw: held.source.raw } } : {}),
      writes: writes.map(write => ({ id: write.record.id, record: JSON.stringify(write.record),
        mode: write.mode, preserve: write.preserveAccess ?? [], ...(write.mergeAgentIds ? { merge: write.mergeAgentIds, enableForAll: write.enableForAll === true } : {}) })), deletes: deleteIds }),
    nonce, held.revision ?? ''
  ])
  if (!Array.isArray(answer)) throw unconfirmed()
  if (answer[0] === 'MISSING') return null
  if (answer[0] === 'UNCHANGED') return { deleted: 0, records: [] }
  if (answer.length !== writes.length + 2) throw savedUnreadable()
  try {
    return { deleted: Number(answer[1]), records: answer.slice(2).map(raw => {
      if (typeof raw !== 'string') throw savedUnreadable()
      return (JSON.parse(raw) as SlashCommandRow[])[0]
    }) }
  } catch { throw savedUnreadable() }
}

export async function saveSlashCommandRecord(userId: string, write: SlashCommandWrite, basis: SlashCommandWriteBasis): Promise<SlashCommandRow | null> {
  return (await saveSlashCommandBatch(userId, [write], basis))?.records[0] ?? null
}
export async function deleteSlashCommandRecord(userId: string, commandId: string, basis: SlashCommandWriteBasis): Promise<boolean> {
  return (await saveSlashCommandBatch(userId, [], basis, [commandId]))?.deleted === 1
}

export const SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT = `
${SLASH_COMMAND_REVISION_LUA}${BASIS_LUA}
local revision = command_revision(KEYS[2])
if revision == nil or not valid_command_nonce(ARGV[5]) then return 'INVALID_REVISION' end
if revision ~= ARGV[8] then return 'CONFLICT' end
local basis = cjson.decode(ARGV[7])
if not matches(KEYS[1], basis.paths, basis.raw) then return 'CONFLICT' end
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
local add = ARGV[2] == 'add'
local found = redis.call('JSON.GET', KEYS[1], '$.enabled_agent_ids')
if ARGV[6] == 'explicit' or ((not add) and found ~= '[]') then
  if found == '[]' then return 'UNCHANGED' end
  if redis.call('JSON.TYPE', KEYS[1], '$.enabled_agent_ids')[1] ~= 'array' then
    if ARGV[6] == 'explicit' then return 'UNCHANGED' else return 'INVALID_ACCESS' end
  end
  local values = cjson.decode(found)[1]
  local positions = {}
  for index, value in ipairs(values) do if value == ARGV[1] then positions[#positions + 1] = index - 1 end end
  if #positions == 0 then return 'UNCHANGED' end
  local forAll = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.enabled_for_all_agents'))[1] == true
  redis.call('SET', KEYS[2], ARGV[5])
  for index = #positions, 1, -1 do
    local removed = redis.pcall('JSON.ARRPOP', KEYS[1], '$.enabled_agent_ids', positions[index])
    if type(removed) ~= 'table' or removed.err then return 'PARTIAL' end
  end
  local attachable = (forAll or #values > #positions) and 'true' or 'false'
  local changed = redis.pcall('JSON.SET', KEYS[1], '$.can_be_attached_to_agents', attachable)
  if type(changed) ~= 'table' or changed.ok ~= 'OK' then return 'PARTIAL' end
  changed = redis.pcall('JSON.SET', KEYS[1], '$.updated_at', ARGV[3])
  if type(changed) ~= 'table' or changed.ok ~= 'OK' then return 'PARTIAL' end
  return 'OK'
end
local nextList = {}
if found == '[]' then
  if ARGV[6] == 'explicit' then return 'UNCHANGED' end
  if add then
    return 'UNCHANGED'
  end
  for _, value in ipairs(cjson.decode(ARGV[4])) do
    if value ~= ARGV[1] then
      table.insert(nextList, value)
    end
  end
else
  if redis.call('JSON.TYPE', KEYS[1], '$.enabled_agent_ids')[1] ~= 'array' then
    if ARGV[6] == 'explicit' then return 'UNCHANGED' end
    return 'INVALID_ACCESS'
  end
  local stored = cjson.decode(found)[1]
  local current = {}
  if type(stored) ~= 'table' then return 'INVALID_ACCESS' end
  current = stored
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
redis.call('SET', KEYS[2], ARGV[5])
local changed = redis.pcall('JSON.SET', KEYS[1], '$.enabled_agent_ids', encoded)
if type(changed) ~= 'table' or changed.ok ~= 'OK' then return 'PARTIAL' end
local forAll = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.enabled_for_all_agents'))[1] == true
local attachable = 'false'
if forAll or #nextList > 0 then
  attachable = 'true'
end
changed = redis.pcall('JSON.SET', KEYS[1], '$.can_be_attached_to_agents', attachable)
if type(changed) ~= 'table' or changed.ok ~= 'OK' then return 'PARTIAL' end
changed = redis.pcall('JSON.SET', KEYS[1], '$.updated_at', ARGV[3])
if type(changed) ~= 'table' or changed.ok ~= 'OK' then return 'PARTIAL' end
return 'OK'
`

export async function commitSlashCommandAgentAccess(userId: string, commandId: string, agentId: string, enabled: boolean, basis: SlashCommandWriteBasis, onlyExplicit: boolean): Promise<'OK' | 'UNCHANGED' | 'MISSING'> {
  if (onlyExplicit ? !agentId || !agentId.isWellFormed() : enabled ? !validId(agentId) : !isExactSavedAccessAgentId(agentId)) throw invalid()
  const { held } = commandBasis(userId, [commandId], basis)
  // Reads are preparation, not issued work. The original nonce also fences the population.
  const everyone = enabled || onlyExplicit ? [] : await redis.execute(async client => {
    slashCommandPreparationState(held.preparation, userId)
    const ids = [...await client.sMembers(`user:${userId}:agents`), ...await client.sMembers(`user:${userId}:subagents`)]
    if (ids.some(id => !isExactSavedAccessAgentId(id))) throw invalid()
    return [...new Set(ids)].sort()
  })
  commandBasis(userId, [commandId], basis)
  held.used = true
  const answer = await issue(held, SET_SLASH_COMMAND_AGENT_ACCESS_SCRIPT, [`slash_command:${userId}:${commandId}`, slashCommandRevisionKey(userId)], nonce => [
    agentId, enabled ? 'add' : 'remove', JSON.stringify(new Date().toISOString()), JSON.stringify(everyone), nonce,
    onlyExplicit ? 'explicit' : '', JSON.stringify({ paths: COMMAND_BASIS_PATHS, raw: held.raw[0] }), held.revision ?? ''
  ])
  return answer as 'OK' | 'UNCHANGED' | 'MISSING'
}

const SOURCE_SCAN_FIELDS = ['last_scanned_at', 'last_scan_status', 'last_scan_error', 'discovered_skill_ids', 'discovered_command_ids', 'updated_at'] as const
export type SkillSourceScanUpdate = Pick<SkillSourceRow, typeof SOURCE_SCAN_FIELDS[number]>
const WRITE_SKILL_SOURCE_SCRIPT = `${SLASH_COMMAND_REVISION_LUA}${BASIS_LUA}
local revision = command_revision(KEYS[1])
if revision == nil or not valid_command_nonce(ARGV[2]) then return {'INVALID_REVISION'} end
if revision ~= ARGV[3] then return {'CONFLICT'} end
local payload = cjson.decode(ARGV[1])
if not matches(KEYS[2], payload.paths, payload.raw) then return {'CONFLICT'} end
local exists = redis.call('EXISTS', KEYS[2]) == 1
if exists then
  local root = redis.pcall('JSON.GET', KEYS[2], '$')
  if type(root) ~= 'string' then return {'INVALID_RECORD'} end
  local current = cjson.decode(root)[1]
  if type(current) ~= 'table' or current.id ~= payload.id or current.user_id ~= payload.userId then return {'INVALID_RECORD'} end
end
local fields = {}
local positions = {}
if payload.action == 'save' then
  local row = cjson.decode(payload.record)
  if type(row) ~= 'table' or row.id ~= payload.id or row.user_id ~= payload.userId then return {'INVALID'} end
elseif payload.action == 'delete' then
  if not exists then return {'UNCHANGED'} end
elseif payload.action == 'scrub' then
  if not exists then return {'UNCHANGED'} end
  local raw = redis.call('JSON.GET', KEYS[2], '$.enabled_agent_ids')
  if raw == '[]' then return {'UNCHANGED'} end
  if redis.call('JSON.TYPE', KEYS[2], '$.enabled_agent_ids')[1] ~= 'array' then return {'UNCHANGED'} end
  for index, id in ipairs(cjson.decode(raw)[1]) do
    if id == payload.agentId then positions[#positions + 1] = index - 1 end
  end
  if #positions == 0 then return {'UNCHANGED'} end
elseif payload.action == 'bookkeeping' then
  if not exists then return {'MISSING'} end
  local allowed = {last_scanned_at=true,last_scan_status=true,last_scan_error=true,discovered_skill_ids=true,discovered_command_ids=true,updated_at=true}
  for _, field in ipairs(payload.fields) do
    if not allowed[field[1]] or (type(field[2]) ~= 'string' and field[2] ~= false) then return {'INVALID'} end
    fields[#fields + 1] = field
  end
else return {'INVALID'} end
redis.call('SET', KEYS[1], ARGV[2])
if payload.action == 'delete' then
  if redis.pcall('DEL', KEYS[2]) ~= 1 then return {'PARTIAL'} end
  return {'OK'}
elseif payload.action == 'save' then
  local result = redis.pcall('JSON.SET', KEYS[2], '$', payload.record)
  if type(result) ~= 'table' or result.ok ~= 'OK' then return {'PARTIAL'} end
elseif payload.action == 'scrub' then
  for index = #positions, 1, -1 do
    local result = redis.pcall('JSON.ARRPOP', KEYS[2], '$.enabled_agent_ids', positions[index])
    if type(result) ~= 'table' or result.err then return {'PARTIAL'} end
  end
else
  for _, field in ipairs(fields) do
    local result
    if field[2] == false then result = redis.pcall('JSON.DEL', KEYS[2], '$.' .. field[1])
      if type(result) ~= 'number' then return {'PARTIAL'} end
    else result = redis.pcall('JSON.SET', KEYS[2], '$.' .. field[1], field[2])
      if type(result) ~= 'table' or result.ok ~= 'OK' then return {'PARTIAL'} end
    end
  end
end
local raw = redis.pcall('JSON.GET', KEYS[2], '$')
if type(raw) ~= 'string' then return {'SAVED_READBACK_UNAVAILABLE'} end
return {'OK', raw}
`
async function mutateSkillSource(userId: string, sourceId: string, basis: SkillSourceWriteBasis, change: { action: 'save'; record: SkillSourceRow } | { action: 'delete' } | { action: 'scrub'; agentId: string } | { action: 'bookkeeping'; update: SkillSourceScanUpdate }): Promise<{ changed: boolean; source: SkillSourceRow | null }> {
  const held = sourceBases.get(basis)
  if (!held || held.userId !== userId || held.id !== sourceId) throw conflict()
  const state = slashCommandPreparationState(held.preparation, userId)
  const payload = { id: sourceId, userId, paths: SOURCE_BASIS_PATHS, raw: held.raw, action: change.action,
    ...(change.action === 'save' ? { record: JSON.stringify(change.record) } : {}),
    ...(change.action === 'scrub' ? { agentId: change.agentId } : {}),
    ...(change.action === 'bookkeeping' ? { fields: SOURCE_SCAN_FIELDS.filter(field => Object.hasOwn(change.update, field)).map(field => [field, change.update[field] === undefined ? false : JSON.stringify(change.update[field])]) } : {}) }
  if (change.action === 'scrub' && (!change.agentId || !change.agentId.isWellFormed())) throw invalid()
  const expectedRevision = state.revision
  if (expectedRevision === undefined) throw conflict()
  const answer = await issue(held, WRITE_SKILL_SOURCE_SCRIPT, [slashCommandRevisionKey(userId), `skill_source:${userId}:${sourceId}`], nonce => [JSON.stringify(payload), nonce, expectedRevision ?? ''])
  if (!Array.isArray(answer)) throw unconfirmed()
  if (answer[0] === 'UNCHANGED' || answer[0] === 'MISSING') return { changed: false, source: null }
  if (change.action === 'delete') return { changed: true, source: null }
  try {
    const source = (JSON.parse(String(answer[1])) as SkillSourceRow[])[0]
    if (!source || source.id !== sourceId || source.user_id !== userId) throw savedUnreadable()
    return { changed: true, source }
  } catch { throw savedUnreadable() }
}
export async function saveSkillSourceRecord(source: SkillSourceRow, basis: SkillSourceWriteBasis) {
  return (await mutateSkillSource(source.user_id, source.id, basis, { action: 'save', record: source })).source!
}
export async function deleteSkillSourceRecord(userId: string, sourceId: string, basis: SkillSourceWriteBasis) {
  return (await mutateSkillSource(userId, sourceId, basis, { action: 'delete' })).changed
}
export async function updateSkillSourceScan(userId: string, sourceId: string, update: SkillSourceScanUpdate, basis: SkillSourceWriteBasis) {
  return (await mutateSkillSource(userId, sourceId, basis, { action: 'bookkeeping', update })).source
}
export async function removeExplicitSkillSourceAgentAccess(userId: string, sourceId: string, agentId: string, basis: SkillSourceWriteBasis) {
  return (await mutateSkillSource(userId, sourceId, basis, { action: 'scrub', agentId })).changed
}
