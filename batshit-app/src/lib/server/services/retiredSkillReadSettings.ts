import { redis } from '$lib/server/redis'

/** Delete retired rows in-place from the current document, never a stale reserialized array. */
export const REMOVE_SKILL_READ_SETTINGS_SCRIPT = `
local kind = redis.call('TYPE', KEYS[1])
if type(kind) == 'table' then kind = kind.ok end
if kind ~= 'ReJSON-RL' then return 0 end
local root = ARGV[1]
local count = 0
for _, name in ipairs({'skill_read', 'skill_reference'}) do
  for _, prefix in ipairs({'buffer_size_', 'zip_threshold_', 'auto_zip_', 'zip_disabled_'}) do
    count = count + redis.call('JSON.DEL', KEYS[1], root .. '.' .. prefix .. name)
  end
end
local custom = root .. '.custom_tool_settings'
local raw = redis.call('JSON.GET', KEYS[1], custom)
if raw then
  local matches = cjson.decode(raw)
  local rows = matches[1]
  if type(rows) == 'table' and redis.call('JSON.TYPE', KEYS[1], custom)[1] == 'array' then
    for i = #rows, 1, -1 do
      local row = rows[i]
      if type(row) == 'table' and (row.tool_name == 'skill_read' or row.tool_name == 'skill_reference') then
        count = count + redis.call('JSON.DEL', KEYS[1], custom .. '[' .. (i - 1) .. ']')
      end
    end
  end
end
return count
`

export async function removeRetiredSkillReadSettings(): Promise<{ records: number; fields: number }> {
  const keys = [
    ...(await redis.keys('agent:*')).filter((key) => /^agent:[^:]+$/.test(key)),
    ...(await redis.keys('subagent:*')).filter((key) => /^subagent:[^:]+$/.test(key)),
    ...(await redis.keys('user:*:settings')).filter((key) => /^user:[^:]+:settings$/.test(key))
  ].sort()
  let records = 0
  let fields = 0
  for (const key of keys) {
    const raw = await redis.json.get(key) as any
    const block = key.startsWith('user:') ? raw?.global_zip_settings : raw
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    const hasFields = ['skill_read', 'skill_reference'].some((name) =>
      ['buffer_size_', 'zip_threshold_', 'auto_zip_', 'zip_disabled_'].some((prefix) => Object.hasOwn(block, prefix + name)))
    const hasRows = Array.isArray(block.custom_tool_settings) && block.custom_tool_settings.some((row: any) =>
      row && typeof row === 'object' && ['skill_read', 'skill_reference'].includes(row.tool_name))
    if (!hasFields && !hasRows) continue
    const removed = Number(await redis.execute((client) => client.eval(REMOVE_SKILL_READ_SETTINGS_SCRIPT, {
      keys: [key], arguments: [key.startsWith('user:') ? '$.global_zip_settings' : '$']
    })))
    if (!Number.isSafeInteger(removed) || removed < 0) throw new Error('The retired Skill Read setting sweep returned an invalid result.')
    if (removed) { records += 1; fields += removed }
  }
  return { records, fields }
}
