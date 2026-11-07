import { redis } from '$lib/server/redis'

/**
 * SA-126 shipped defaults, step 1d (Josh chose the sweep, 2026-10-19). Until that round
 * `redis.createAgent` stamped the day's factory zip rows into every new agent record, so every
 * existing agent kept the OLD defaults as stored values and never saw the new ones (C6, with Skill
 * Read at 8). This one-time startup pass removes a stored zip row when it is exactly the old factory
 * row, on every `agent:{id}` record and in each `user:{userId}:settings` record's
 * `global_zip_settings` (the Global Tool Grid), so that row inherits again: the agent row reads the
 * global row, and the global row reads the new factory row.
 *
 * Whole rows only: a row is removed when every value it stores equals the old default for that row
 * (and it is not Off); a row with any other value is a choice and stays whole, so a hand-set buffer
 * never loses its Normal behavior to the new Auto. A custom row (Skill Read, Fetch Zip) is a
 * `custom_tool_settings` entry and goes only when it holds nothing else.
 *
 * Runs once per instance: the marker `batshit:zip_defaults_sweep:v1` (owner: this file) is written
 * after a pass that finished, and a later start skips the pass, because a later value equal to an old
 * default is the user's choice then. The marker is instance-level like
 * `batshit:memory_media_migration:v1`: never deleted by an account or agent delete, carried by backup
 * in the `settings` group, and replaced by a restore with the backup's own copy, so restoring a backup
 * made before the sweep (no marker) sweeps its records on the next start, and one made after does
 * not. A pass that failed part way writes no marker; its next start finishes it (already removed
 * rows are absent, so nothing is removed twice, and the marker then describes the finishing pass
 * only). A restore also runs it at once (`backupRestoreService.ts`), since the app does not restart.
 * The marker keeps which rows went from which record (every removed row was the old factory row by
 * definition), so a changed default can be traced; a restore cannot bring a swept row back.
 *
 * Its window: until the marker exists, a row saved equal to an old default in the first seconds
 * of a start (or by a tab open across the restart, which writes whole blocks) is swept too.
 *
 * Each record is one atomic script of RedisJSON path deletes (never a whole-record write, so no
 * sibling field moves; never node-redis `json.del(key, path)`: `.agents/memories/topics/
 * redis-client-gotchas.md`). A key that is not a JSON document is left alone.
 */

export const ZIP_DEFAULTS_SWEEP_KEY = 'batshit:zip_defaults_sweep:v1'

/** The factory rows before SA-126's shipped-defaults round: [buffer, threshold, auto]. */
export const OLD_FACTORY_FIELD_ROWS: Record<string, [number, number, boolean]> = {
  read_file: [8, 0, false],
  write_file: [2, 0, false],
  edit_file: [2, 0, false],
  execute_command: [1, 0, false],
  list_files: [1, 0, true],
  all_other_tools: [1, 0, true]
}
export const OLD_FACTORY_CUSTOM_ROWS: Record<string, [number, number, boolean]> = {
  skill_read: [10, 0, false],
  fetch_zip: [1, 0, false]
}

/**
 * KEYS[1] the record. ARGV[1] '' for an agent record (rows at the root) or the name of the object
 * that holds them (`global_zip_settings`). ARGV[2] the old rows as JSON. ARGV[3] 'apply' or 'dry'.
 * Answers JSON `{ rows: 'name,name', fields: n }` (what was, or would be, removed).
 */
export const SWEEP_OLD_ZIP_DEFAULTS_SCRIPT = `
local kind = redis.call('TYPE', KEYS[1])
if type(kind) == 'table' then kind = kind['ok'] end
if kind ~= 'ReJSON-RL' then return cjson.encode({ rows = '', fields = 0 }) end
local base = '$'
if ARGV[1] ~= '' then base = '$.' .. ARGV[1] end
local found = cjson.decode(redis.call('JSON.GET', KEYS[1], base))
local doc = found[1]
if type(doc) ~= 'table' then return cjson.encode({ rows = '', fields = 0 }) end
local old = cjson.decode(ARGV[2])
local apply = ARGV[3] == 'apply'
local function present(value) return value ~= nil and value ~= cjson.null end
local removedRows = {}
local removedFields = 0
local deletes = {}

for row, expected in pairs(old.fields) do
  local keys = { 'buffer_size_' .. row, 'zip_threshold_' .. row, 'auto_zip_' .. row }
  local stored = 0
  local same = true
  for i = 1, 3 do
    local value = doc[keys[i]]
    if present(value) then
      stored = stored + 1
      if value ~= expected[i] then same = false end
    end
  end
  local off = doc['zip_disabled_' .. row]
  if present(off) and off ~= false then same = false end
  if same and stored > 0 then
    table.insert(removedRows, row)
    for i = 1, 3 do
      if present(doc[keys[i]]) then table.insert(deletes, base .. '.' .. keys[i]) end
    end
    if present(off) then table.insert(deletes, base .. '.zip_disabled_' .. row) end
  end
end

local allowed = { tool_name = true, buffer_size = true, zip_threshold = true, auto_zip = true, zip_disabled = true }
local custom = doc.custom_tool_settings
local customIndexes = {}
if type(custom) == 'table' then
  for index, entry in ipairs(custom) do
    local expected = type(entry) == 'table' and old.custom[entry.tool_name] or nil
    if expected then
      local values = { entry.buffer_size, entry.zip_threshold, entry.auto_zip }
      local stored = 0
      local same = true
      for i = 1, 3 do
        if present(values[i]) then
          stored = stored + 1
          if values[i] ~= expected[i] then same = false end
        end
      end
      if present(entry.zip_disabled) and entry.zip_disabled ~= false then same = false end
      for key, _ in pairs(entry) do
        if not allowed[key] then same = false end
      end
      if same and stored > 0 then
        table.insert(removedRows, entry.tool_name)
        table.insert(customIndexes, index - 1)
      end
    end
  end
end

table.sort(removedRows)
if apply then
  for _, path in ipairs(deletes) do
    removedFields = removedFields + redis.call('JSON.DEL', KEYS[1], path)
  end
  for i = #customIndexes, 1, -1 do
    removedFields = removedFields + redis.call('JSON.DEL', KEYS[1], base .. '.custom_tool_settings[' .. customIndexes[i] .. ']')
  end
else
  removedFields = #deletes + #customIndexes
end
-- cjson encodes an empty table as {}, so the names travel as one comma-joined string.
return cjson.encode({ rows = table.concat(removedRows, ','), fields = removedFields })
`

export type ZipDefaultsSweepRecord = { key: string; rows: string[]; fields: number }
export type ZipDefaultsSweepResult = {
  status: 'already-complete' | 'swept' | 'dry-run'
  records: number
  rows: number
  fields: number
  changed: ZipDefaultsSweepRecord[]
}

const MARKER_RECORD_LIMIT = 500
const OLD_ROWS_ARGUMENT = JSON.stringify({ fields: OLD_FACTORY_FIELD_ROWS, custom: OLD_FACTORY_CUSTOM_ROWS })
const AGENT_RECORD_KEY = /^agent:[^:]+$/
const SETTINGS_RECORD_KEY = /^user:[^:]+:settings$/

async function sweepRecord(key: string, container: '' | 'global_zip_settings', dryRun: boolean): Promise<ZipDefaultsSweepRecord> {
  const answer = await redis.execute((client) =>
    client.eval(SWEEP_OLD_ZIP_DEFAULTS_SCRIPT, { keys: [key], arguments: [container, OLD_ROWS_ARGUMENT, dryRun ? 'dry' : 'apply'] })
  )
  const parsed = typeof answer === 'string' ? JSON.parse(answer) : null
  const rows = typeof parsed?.rows === 'string' ? parsed.rows.split(',').filter(Boolean) : null
  const fields = Number(parsed?.fields)
  if (!rows || !Number.isInteger(fields) || fields < 0) {
    throw new Error(`The old zip defaults sweep of ${key} answered ${String(answer)}.`)
  }
  return { key, rows, fields }
}

/**
 * The startup pass. `dryRun` reads and counts only (no write, no marker), for a proof against a
 * copy of real data; the startup call never passes it.
 */
export async function sweepOldZipDefaults(options: { dryRun?: boolean } = {}): Promise<ZipDefaultsSweepResult> {
  const dryRun = options.dryRun === true
  if (!dryRun && await redis.exists(ZIP_DEFAULTS_SWEEP_KEY)) {
    return { status: 'already-complete', records: 0, rows: 0, fields: 0, changed: [] }
  }
  const agentKeys = (await redis.keys('agent:*')).filter((key) => AGENT_RECORD_KEY.test(key)).sort()
  const settingsKeys = (await redis.keys('user:*:settings')).filter((key) => SETTINGS_RECORD_KEY.test(key)).sort()
  const changed: ZipDefaultsSweepRecord[] = []
  for (const [keys, container] of [[agentKeys, ''], [settingsKeys, 'global_zip_settings']] as const) {
    for (const key of keys) {
      const result = await sweepRecord(key, container, dryRun)
      if (result.rows.length > 0) changed.push(result)
    }
  }
  const rows = changed.reduce((sum, entry) => sum + entry.rows.length, 0)
  const fields = changed.reduce((sum, entry) => sum + entry.fields, 0)
  if (dryRun) return { status: 'dry-run', records: changed.length, rows, fields, changed }
  await redis.set(ZIP_DEFAULTS_SWEEP_KEY, {
    version: 1,
    completed_at: new Date().toISOString(),
    records: changed.length,
    rows,
    fields,
    // One user per instance: a handful of agents. Bounded anyway.
    changed: changed.slice(0, MARKER_RECORD_LIMIT).map((entry) => ({ key: entry.key, rows: entry.rows }))
  })
  return { status: 'swept', records: changed.length, rows, fields, changed }
}


/** One log line naming what went, by record. */
export function describeZipDefaultsSweep(result: ZipDefaultsSweepResult): string {
  const detail = result.changed.slice(0, 50).map((entry) => `${entry.key}: ${entry.rows.join(', ')}`).join('; ')
  const more = result.changed.length > 50 ? `; and ${result.changed.length - 50} more record(s)` : ''
  return `Old default zip rows removed once (SA-126): ${result.rows} row(s), ${result.fields} value(s) in ${result.records} record(s); those rows now follow the current defaults. ${detail}${more}`
}
