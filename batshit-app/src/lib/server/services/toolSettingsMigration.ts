import { redis } from '$lib/server/redis'
import { isExactSavedAccessAgentId } from '$lib/utils/agentAccessIds'
import { acquireSettingsMutation, captureSettingsLifecycle } from './appActions/settings/lifecycle'
import { slashCommandRevisionKey, SLASH_COMMAND_REVISION_LUA } from './slashCommandRevisionProtocol'
import { planTypedFileToolsGrantMaterialization, RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS,
  type TypedFileToolsGlobalSnapshot, type TypedFileToolsMaterializationPlan } from '$lib/utils/toolSettingsMigration'

/** Startup/restore integration owns invocation; this module creates no marker, key or background task. */
export class ToolSettingsConversionError extends Error {
  constructor(message: string, readonly outcome: 'not_written' | 'unconfirmed') {
    super(message); this.name = 'ToolSettingsConversionError'
  }
}
const uncertainUsers = new Set<string>()
const unavailable = (message: string): never => { throw new ToolSettingsConversionError(message, 'not_written') }
function root(raw: unknown, key: string): Record<string, unknown> {
  if (typeof raw !== 'string') return unavailable(`Tool settings source ${key} is unavailable. Nothing was converted.`)
  const values: unknown = JSON.parse(raw)
  if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object' || Array.isArray(values[0])) {
    return unavailable(`Tool settings source ${key} is malformed. Nothing was converted.`)
  }
  return values[0] as Record<string, unknown>
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => !isExactSavedAccessAgentId(id)) || new Set(value).size !== value.length) {
    return unavailable('The saved tool-settings subject inventory is malformed. Nothing was converted.')
  }
  return [...value].sort()
}
interface SubjectPlan extends TypedFileToolsMaterializationPlan { id: string; kind: 'primary' | 'subagent'; raw: string }

/** All guards/types/plans are checked before the first leaf write. Alias JSON is copied RAW. */
export const MATERIALIZE_TOOL_SETTINGS_SCRIPT = `
-- batshit-tool-settings-materialize-v1
${SLASH_COMMAND_REVISION_LUA}
local function kind(key) local v = redis.call('TYPE', key); return type(v) == 'table' and v.ok or v end
local function raw_object(key, expected, allow_absent)
  local t = kind(key)
  if t == 'none' then return allow_absent and expected == '' end
  if t ~= 'ReJSON-RL' then return false end
  local shape = redis.pcall('JSON.TYPE', key, '$')
  if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return false end
  return redis.call('JSON.GET', key, '$') == expected
end
local ok, plan = pcall(cjson.decode, ARGV[3])
if not ok or type(plan) ~= 'table' or type(plan.primary) ~= 'table' or type(plan.subagents) ~= 'table' or type(plan.subjects) ~= 'table' then return {'INVALID', 0} end
if #KEYS ~= #plan.subjects + 4 or #ARGV ~= #plan.subjects + 3 then return {'INVALID', 0} end
if not raw_object(KEYS[1], ARGV[1], true) then return {'CHANGED', 0} end
if command_revision(KEYS[2]) ~= ARGV[2] then return {'CHANGED', 0} end
local function same_set(key, expected)
  local t = kind(key)
  if t ~= 'none' and t ~= 'set' then return false end
  if redis.call('SCARD', key) ~= #expected then return false end
  for _, id in ipairs(expected) do if redis.call('SISMEMBER', key, id) ~= 1 then return false end end
  return true
end
if not same_set(KEYS[3], plan.primary) or not same_set(KEYS[4], plan.subagents) then return {'CHANGED', 0} end
local writes = {}
local function add(command, key, path, value) table.insert(writes, {command, key, path, value}) end
local retired = cjson.decode('${JSON.stringify(RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS)}')
for i, subject in ipairs(plan.subjects) do
  local key = KEYS[i + 4]
  if not raw_object(key, ARGV[i + 3], false) then return {'CHANGED', 0} end
  if type(subject.artifactRuntimeEnabled) ~= 'boolean' or type(subject.value) ~= 'boolean' or type(subject.ensureProviderBag) ~= 'boolean' or type(subject.ensureNativeTools) ~= 'boolean' or type(subject.promoteAlias) ~= 'boolean' then return {'INVALID', 0} end
  local doc = cjson.decode(ARGV[i + 3])[1]
  if doc.id ~= subject.id or doc.user_id ~= plan.userId then return {'INVALID', 0} end
  if subject.ensureProviderBag then add('JSON.SET', key, '$.provider_specific_settings', '{}') end
  if subject.promoteAlias then
    local shape = redis.call('JSON.TYPE', key, '$.provider_specific_settings.batshitNativeTools')
    if shape[1] ~= 'object' then return {'CHANGED', 0} end
    local alias = redis.call('JSON.GET', key, '$.provider_specific_settings.batshitNativeTools')
    -- Strip only the JSONPath single-result wrapper, without a numeric decode/re-encode.
    add('JSON.SET', key, '$.provider_specific_settings.nativeTools', string.sub(alias, 2, -2))
  elseif subject.ensureNativeTools then add('JSON.SET', key, '$.provider_specific_settings.nativeTools', '{}') end
  add('JSON.SET', key, '$.provider_specific_settings.nativeTools.typedFileToolsEnabled', subject.value and 'true' or 'false')
  add('JSON.SET', key, '$.provider_specific_settings.nativeTools.artifactRuntimeEnabled', subject.artifactRuntimeEnabled and 'true' or 'false')
  for _, name in ipairs(retired) do
    for _, base in ipairs({'$.provider_specific_settings', '$.provider_specific_settings.nativeTools', '$.provider_specific_settings.batshitNativeTools'}) do
      add('JSON.DEL', key, base .. '.' .. name)
    end
  end
end
-- Retire inheritance LAST. Any unexpected partial command leaves its original source intact.
if ARGV[1] ~= '' then add('JSON.DEL', KEYS[1], '$.global_tool_grid_settings.typed_file_tools') end
local applied = 0
for _, write in ipairs(writes) do
  local result
  if write[1] == 'JSON.SET' then result = redis.pcall(write[1], write[2], write[3], write[4])
  else result = redis.pcall(write[1], write[2], write[3]) end
  if type(result) == 'table' and result.err then return {'PARTIAL', applied} end
  if write[1] == 'JSON.SET' and (type(result) ~= 'table' or result.ok ~= 'OK') then return {'PARTIAL', applied} end
  if write[1] == 'JSON.DEL' and type(result) ~= 'number' then return {'PARTIAL', applied} end
  applied = applied + 1
end
return {'APPLIED', applied}
`

/** One complete per-user cut. No tolerant Redis wrappers, source recapture or automatic retry. */
export async function materializeToolSettingsForUser(userId: string, options: { beforeIssue?: () => Promise<void> } = {}): Promise<{ subjects: number }> {
  const revisionKey = slashCommandRevisionKey(userId)
  if (uncertainUsers.has(userId)) throw new ToolSettingsConversionError('An earlier tool settings conversion is unconfirmed. Automatic conversion remains held.', 'unconfirmed')
  try { return await redis.execute(async client => {
    const settingsKey = `user:${userId}:settings`
    const indexKeys = [`user:${userId}:agents`, `user:${userId}:subagents`]
    const baseLifecycle = captureSettingsLifecycle([settingsKey])
    const settingsRaw = await client.sendCommand(['JSON.GET', settingsKey, '$']) as string | null
    const settings = settingsRaw === null ? null : root(settingsRaw, settingsKey)
    if (settings && settings.user_id !== userId) return unavailable('The global tool settings owner changed. Nothing was converted.')
    const global: TypedFileToolsGlobalSnapshot = settings && Object.hasOwn(settings, 'global_tool_grid_settings')
      ? { kind: 'known', value: settings.global_tool_grid_settings } : { kind: 'absent' }
    // The inherited source must be valid even when there are no subjects.
    planTypedFileToolsGrantMaterialization(null, global)
    const revision = await client.get(revisionKey)
    const primary = ids(await client.sMembers(indexKeys[0]))
    const subagents = ids(await client.sMembers(indexKeys[1]))
    const keys = [...primary.map(id => `agent:${id}`), ...subagents.map(id => `subagent:${id}`)]
    const lifecycle = captureSettingsLifecycle([settingsKey, ...keys])
    // A restore/replacement during the first capture cannot be blessed by the later inventory.
    const initialLease = acquireSettingsMutation(baseLifecycle); initialLease.settle()
    const subjects: SubjectPlan[] = []
    for (let index = 0; index < keys.length; index++) {
      const raw = await client.sendCommand(['JSON.GET', keys[index], '$']) as string | null
      const record = root(raw, keys[index])
      const id = index < primary.length ? primary[index] : subagents[index - primary.length]
      if (record.id !== id || record.user_id !== userId) return unavailable('A tool settings subject is missing or belongs to another user. Nothing was converted.')
      subjects.push({ ...planTypedFileToolsGrantMaterialization(record.provider_specific_settings, global),
        id, kind: index < primary.length ? 'primary' : 'subagent', raw: raw! })
    }
    const command = { keys: [settingsKey, revisionKey, ...indexKeys, ...keys],
      arguments: [settingsRaw ?? '', revision ?? '', JSON.stringify({ userId, primary, subagents,
        subjects: subjects.map(({ raw: _raw, ...intent }) => intent) }), ...subjects.map(subject => subject.raw)] }
    const expectedCommands = (settingsRaw === null ? 0 : 1) + subjects.reduce((count, subject) => count +
      2 + (subject.ensureProviderBag ? 1 : 0) + (subject.promoteAlias || subject.ensureNativeTools ? 1 : 0) +
      RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS.length * 3, 0)
    await options.beforeIssue?.()
    const lease = acquireSettingsMutation(lifecycle)
    let answer: unknown
    try { lease.check(); answer = await client.eval(MATERIALIZE_TOOL_SETTINGS_SCRIPT, command) }
    catch { lease.unknown(); uncertainUsers.add(userId); throw new ToolSettingsConversionError('Tool settings conversion may have reached storage. Its original source was retained where possible; no automatic retry will run.', 'unconfirmed') }
    if (Array.isArray(answer) && answer.length === 2 && answer[0] === 'APPLIED' && Number.isSafeInteger(answer[1]) && answer[1] === expectedCommands) {
      lease.settle(); return { subjects: subjects.length }
    }
    if (Array.isArray(answer) && answer.length === 2 && ['INVALID', 'CHANGED'].includes(answer[0] as string) && answer[1] === 0) {
      lease.settle(); return unavailable('Tool settings sources changed or were malformed. Nothing was converted; reload before retrying.')
    }
    lease.unknown(); uncertainUsers.add(userId)
    throw new ToolSettingsConversionError('Tool settings conversion has a partial or unknown outcome. Automatic retry remains held.', 'unconfirmed')
  }) } catch (error) {
    if (error instanceof ToolSettingsConversionError) throw error
    // Client acquisition, strict read/planning, beforeIssue and lease admission all precede EVAL.
    throw new ToolSettingsConversionError(error instanceof Error ? error.message : 'Tool settings sources are unavailable. Nothing was converted.', 'not_written')
  }
}

/** Critical startup admission. Requests/schedulers wait for every indexed account's conversion. */
export async function materializeToolSettingsAtStartup(): Promise<{ users: number; subjects: number }> {
  const users = await redis.execute(async client => {
    const kind = await client.type('users:all')
    if (kind !== 'none' && kind !== 'set') throw new ToolSettingsConversionError('The saved account inventory is malformed. Tool settings were not converted.', 'not_written')
    const members = ids(await client.sMembers('users:all'))
    for (const userId of members) {
      const account = root(await client.sendCommand(['JSON.GET', `user:${userId}:data`, '$']), `user:${userId}:data`)
      if (account.id !== userId) throw new ToolSettingsConversionError('The saved account inventory changed. Tool settings were not converted.', 'not_written')
    }
    return members
  })
  let subjects = 0
  for (const userId of users) {
    subjects += (await materializeToolSettingsForUser(userId)).subjects
    const { invalidateUserSettingsCache } = await import('$lib/services/databaseRedis.server')
    invalidateUserSettingsCache(userId)
  }
  return { users: users.length, subjects }
}
