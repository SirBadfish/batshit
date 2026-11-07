import { SLASH_COMMAND_REVISION_LUA } from './services/slashCommandRevisionProtocol'

/** All checks precede the first write. No episode or long-term Memory ownership. */
export const WRITE_WHITEBOARD_SCRIPT = `
-- BATSHIT_WHITEBOARD_WRITE_V1
local agentJson = redis.call('JSON.GET', KEYS[2])
local sessionJson = redis.call('JSON.GET', KEYS[3])
if not agentJson or not sessionJson then return 'MISSING_OWNER' end
local agent = cjson.decode(agentJson)
local session = cjson.decode(sessionJson)
if agent.user_id ~= ARGV[1] or session.user_id ~= ARGV[1] then return 'WRONG_OWNER' end
if agent.id ~= ARGV[3] or session.id ~= ARGV[2] then return 'WRONG_OWNER' end
if type(session.metadata) == 'table' and session.metadata.group_chat and session.metadata.group_chat ~= cjson.null then return 'GROUP_SESSION' end
local paths = {'$.api_reasoning_retention', '$.whiteboard_budget_tokens', '$.agentType'}
for i, path in ipairs(paths) do
  local current = redis.call('JSON.GET', KEYS[2], path) or ''
  if current ~= ARGV[7 + i] then return 'SETTINGS_CHANGED' end
end
-- Same two-key toggle resolution as resolveBrokerToolToggles: nested wins over flat,
-- with the legacy nested block used only when nativeTools is not an object.
local settings = type(agent.provider_specific_settings) == 'table' and agent.provider_specific_settings or {}
local native = type(settings.nativeTools) == 'table' and settings.nativeTools or settings.batshitNativeTools
if type(native) ~= 'table' then native = {} end
local function toggle(value)
  if type(value) == 'boolean' then return value end
  if type(value) ~= 'string' then return nil end
  local normalized = string.lower(string.match(value, '^%s*(.-)%s*$'))
  if normalized == 'true' or normalized == '1' or normalized == 'yes' or normalized == 'on' or normalized == 'enabled' then return true end
  if normalized == 'false' or normalized == '0' or normalized == 'no' or normalized == 'off' or normalized == 'disabled' then return false end
  return nil
end
local toolsEnabled = nil
for _, name in ipairs({'batshitToolsEnabled', 'nativeBatshitToolsEnabled'}) do
  local parsed = toggle(native[name])
  if parsed == nil then parsed = toggle(settings[name]) end
  if parsed ~= nil then toolsEnabled = parsed; break end
end
if toolsEnabled == false then return 'TOOLS_DISABLED' end
local expected = tonumber(ARGV[4])
local content = cjson.decode(ARGV[5])
local limit = tonumber(ARGV[6])
if not expected or expected < 0 or expected % 1 ~= 0 or not limit or limit < 250 or limit > 16000 then return redis.error_reply('Invalid whiteboard write') end
if content ~= cjson.null and type(content) ~= 'string' then return redis.error_reply('Invalid whiteboard content') end
-- Count UTF-16 code units like the shared JS estimator, rather than UTF-8 bytes.
local units = 0
if type(content) == 'string' then
  for i = 1, #content do
    local byte = string.byte(content, i)
    if byte < 128 or byte >= 192 then units = units + (byte >= 240 and 2 or 1) end
  end
end
if math.ceil(units / 4) > limit then return 'OVER_BUDGET' end
local oldJson = redis.call('JSON.GET', KEYS[1])
local version = 0
if oldJson then
  local old = cjson.decode(oldJson)
  if old.schema_version ~= 1 or old.user_id ~= ARGV[1] or old.session_id ~= ARGV[2] or old.agent_id ~= ARGV[3]
    or type(old.version) ~= 'number' or old.version < 1 or old.version % 1 ~= 0
    or (old.content ~= cjson.null and type(old.content) ~= 'string') or type(old.updated_at) ~= 'string' then
    return redis.error_reply('Invalid saved whiteboard')
  end
  version = old.version
end
if version ~= expected then return 'CONFLICT:' .. (oldJson or 'null') end
local next = {schema_version=1,user_id=ARGV[1],session_id=ARGV[2],agent_id=ARGV[3],content=content,version=version+1,updated_at=ARGV[7]}
local encoded = cjson.encode(next)
redis.call('JSON.SET', KEYS[1], '$', encoded)
return encoded
`

/** Owner stays retryable if any collection/validation/deletion fails before the final DEL. */
export const DELETE_AGENT_WITH_WHITEBOARDS_SCRIPT = `
${SLASH_COMMAND_REVISION_LUA}
-- BATSHIT_AGENT_WHITEBOARD_DELETE_V1
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return 'INVALID_RECORD' end
local agent = cjson.decode(redis.call('JSON.GET', KEYS[1]))
if agent.id ~= ARGV[1] or agent.user_id ~= ARGV[2] then return 'FORBIDDEN' end
if not KEYS[3] or not KEYS[4] then return 'INVALID_REVISION' end
local revision = command_revision(KEYS[4])
if revision == nil or not valid_command_nonce(ARGV[4]) then return 'INVALID_REVISION' end
if revision ~= ARGV[5] then return 'CONFLICT' end
local indexType = redis.call('TYPE', KEYS[3]).ok
if indexType ~= 'none' and indexType ~= 'set' then return 'INVALID_INDEX' end
local boards = redis.call('KEYS', ARGV[3])
for _, key in ipairs(boards) do
  local shape = redis.pcall('JSON.TYPE', key, '$')
  if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return 'INVALID_WHITEBOARD' end
  local board = cjson.decode(redis.call('JSON.GET', key))
  if board.schema_version ~= 1 or board.agent_id ~= ARGV[1] or board.user_id ~= ARGV[2]
    or type(board.session_id) ~= 'string' or key ~= 'whiteboard:' .. board.session_id .. ':' .. ARGV[1] then
    return 'INVALID_WHITEBOARD'
  end
end
-- Mutation boundary: board owners, exact index and nonce are fully preflighted.
redis.call('SET', KEYS[4], ARGV[4])
for _, key in ipairs(boards) do
  if redis.pcall('DEL', key) ~= 1 then return 'PARTIAL' end
end
if type(redis.pcall('SREM', KEYS[3], ARGV[1])) ~= 'number' then return 'PARTIAL' end
local removed = redis.pcall('DEL', KEYS[1], KEYS[2])
if type(removed) ~= 'number' or removed < 1 then return 'PARTIAL' end
return 'DELETED'
`
